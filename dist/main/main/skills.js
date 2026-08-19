"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SkillsManager = void 0;
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const child_process_1 = require("child_process");
const skillsControlPlane_1 = require("./skillsControlPlane");
const skillContent_1 = require("./orchestration/skillContent");
const hermesPaths_1 = require("./hermesPaths");
const kimiPaths_1 = require("./kimiPaths");
const browserSkillContent_1 = require("./mcp-servers/browserSkillContent");
const skillContent_2 = require("./tasks/skillContent");
const ORCHESTRATION_TARGET_GLOBAL_DIRS = {
    claude: '.claude',
    codex: '.codex',
    gemini: '.gemini',
    kimi: '.kimi-code',
    agy: '.gemini/antigravity',
    opencode: '.config/opencode',
    'github-copilot': '.copilot',
    roo: '.roo',
    qoder: '.qoder',
    trae: '.trae',
    droid: '.factory',
    kilocode: '.kilo',
    warp: '.warp',
    augment: '.augment',
    cline: '.cline',
    grok: '.grok',
    hermes: '.hermes',
    cursor: '.cursor',
    // Pi loads global skills from ~/.pi/agent/skills/ (docs/skills.md).
    pi: '.pi/agent',
};
// ---------------------------------------------------------------------------
// Prompt injection & risk detection
// ---------------------------------------------------------------------------
const INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?previous\s+instructions/i,
    /disregard\s+(all\s+)?prior\s+(instructions|context)/i,
    /forget\s+(everything|all)\s+(you|that)/i,
    /you\s+are\s+now\s+(a|an)\s+/i,
    /pretend\s+(to\s+be|you\s+are)/i,
    /act\s+as\s+(if|though)\s+you/i,
    /reveal\s+(your|the)\s+(system\s+)?prompt/i,
    /show\s+(me\s+)?(your|the)\s+(system\s+)?instructions/i,
    /what\s+(are|is)\s+your\s+(system\s+)?(prompt|instructions)/i,
    /send\s+(this|the|all)\s+(data|info|content)\s+to/i,
    /forward\s+(everything|all|this)\s+to/i,
    /curl\s+.*\|\s*sh/i,
    /wget\s+.*\|\s*bash/i,
    /\[SYSTEM\]/i,
    /\[ADMIN\]/i,
    /<<\s*OVERRIDE\s*>>/i,
    /base64\s*(-d|--decode)\s*.*\|\s*(sh|bash|exec)/i,
    /echo\s+\$[A-Z_]*KEY/i,
    /echo\s+\$[A-Z_]*SECRET/i,
    /echo\s+\$[A-Z_]*TOKEN/i,
    /echo\s+\$[A-Z_]*PASSWORD/i,
    /cat\s+~?\/?\.ssh\//i,
    /cat\s+~?\/?\.env/i,
    /cat\s+~?\/?\.aws\//i,
    /eval\s*\(\s*fetch\s*\(/i,
    /import\s*\(\s*['"]https?:/i,
];
const RISK_PATTERNS = [
    { pattern: /rm\s+-rf\s+[\/~]/i, level: 'critical', detail: 'Destructive file deletion command' },
    { pattern: /curl\s+.*\|\s*(sh|bash)/i, level: 'critical', detail: 'Remote code execution via curl pipe' },
    { pattern: /wget\s+.*\|\s*(sh|bash)/i, level: 'critical', detail: 'Remote code execution via wget pipe' },
    { pattern: /eval\s*\(/i, level: 'high', detail: 'Dynamic code evaluation' },
    { pattern: /exec\s*\(/i, level: 'medium', detail: 'Process execution' },
    { pattern: /sudo\s+/i, level: 'high', detail: 'Elevated privilege command' },
    { pattern: /chmod\s+777/i, level: 'high', detail: 'Overly permissive file permissions' },
    { pattern: /\.ssh\//i, level: 'high', detail: 'SSH directory access' },
    { pattern: /\.env/i, level: 'medium', detail: 'Environment file access' },
    { pattern: /password|secret|token|api[_-]?key/i, level: 'medium', detail: 'Potential credential reference' },
    { pattern: /https?:\/\/[^\s"')\]]+/i, level: 'low', detail: 'External URL reference' },
];
function parseFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match)
        return { frontmatter: {}, body: content };
    const raw = match[1];
    const body = match[2];
    const frontmatter = {};
    for (const line of raw.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1)
            continue;
        const key = line.slice(0, colonIdx).trim();
        let value = line.slice(colonIdx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key === 'name')
            frontmatter.name = value;
        else if (key === 'description')
            frontmatter.description = value;
        else if (key === 'tool')
            frontmatter.tool = value;
        else if (key === 'category')
            frontmatter.category = value;
        else if (key === 'user_invocable')
            frontmatter.user_invocable = value === 'true';
        else {
            if (!frontmatter.metadata)
                frontmatter.metadata = {};
            frontmatter.metadata[key] = value;
        }
    }
    return { frontmatter, body };
}
// ---------------------------------------------------------------------------
// Risk assessment
// ---------------------------------------------------------------------------
function assessRisk(content) {
    const details = [];
    let maxLevel = 'safe';
    const levelOrder = ['safe', 'low', 'medium', 'high', 'critical'];
    for (const pattern of INJECTION_PATTERNS) {
        if (pattern.test(content)) {
            details.push('Potential prompt injection detected');
            if (levelOrder.indexOf('high') > levelOrder.indexOf(maxLevel))
                maxLevel = 'high';
            break;
        }
    }
    for (const { pattern, level, detail } of RISK_PATTERNS) {
        if (pattern.test(content)) {
            details.push(detail);
            if (levelOrder.indexOf(level) > levelOrder.indexOf(maxLevel))
                maxLevel = level;
        }
    }
    return { level: maxLevel, details: [...new Set(details)] };
}
const AGENT_PATHS = [
    // Primary agents (most common)
    { agent: 'Claude Code', tool: 'claude', projectDir: '.claude', globalDir: '.claude' },
    { agent: 'Cursor', tool: 'cursor', projectDir: '.agents', globalDir: '.cursor' },
    { agent: 'Codex', tool: 'codex', projectDir: '.agents', globalDir: '.codex' },
    { agent: 'Gemini CLI', tool: 'gemini', projectDir: '.agents', globalDir: '.gemini' },
    { agent: 'Kimi Code', tool: 'kimi', projectDir: '.kimi-code', globalDir: '.kimi-code' },
    { agent: 'Amp', tool: 'amp', projectDir: '.agents', globalDir: '.config/agents' },
    // Extended agents
    { agent: 'GitHub Copilot', tool: 'other', projectDir: '.github', globalDir: '.copilot' },
    { agent: 'Windsurf', tool: 'other', projectDir: '.windsurf', globalDir: '.codeium/windsurf' },
    { agent: 'Roo Code', tool: 'other', projectDir: '.roo', globalDir: '.roo' },
    { agent: 'Continue', tool: 'other', projectDir: '.continue', globalDir: '.continue' },
    { agent: 'Cline', tool: 'other', projectDir: '.cline', globalDir: '.cline' },
    { agent: 'OpenCode', tool: 'opencode', projectDir: '.agents', globalDir: '.config/opencode' },
    { agent: 'Kilo Code', tool: 'other', projectDir: '.kilo', globalDir: '.kilo' },
    { agent: 'Warp', tool: 'other', projectDir: '.warp', globalDir: '.warp' },
    { agent: 'Goose', tool: 'other', projectDir: '.goose', globalDir: '.config/goose' },
    { agent: 'Augment', tool: 'other', projectDir: '.augment', globalDir: '.augment' },
    { agent: 'Trae', tool: 'other', projectDir: '.trae', globalDir: '.trae' },
    { agent: 'Junie', tool: 'other', projectDir: '.junie', globalDir: '.junie' },
    { agent: 'Droid', tool: 'other', projectDir: '.factory', globalDir: '.factory' },
    { agent: 'OpenHands', tool: 'other', projectDir: '.openhands', globalDir: '.openhands' },
    { agent: 'Qoder', tool: 'other', projectDir: '.qoder', globalDir: '.qoder' },
    { agent: 'Mux', tool: 'other', projectDir: '.mux', globalDir: '.mux' },
    { agent: 'Kode', tool: 'other', projectDir: '.kode', globalDir: '.kode' },
    { agent: 'Zencoder', tool: 'other', projectDir: '.zencoder', globalDir: '.zencoder' },
    { agent: 'Pi', tool: 'other', projectDir: '.pi', globalDir: '.pi/agent' },
    { agent: 'Qwen Code', tool: 'other', projectDir: '.qwen', globalDir: '.qwen' },
    { agent: 'Grok', tool: 'other', projectDir: '.grok', globalDir: '.grok' },
    { agent: 'Crush', tool: 'other', projectDir: '.crush', globalDir: '.config/crush' },
    { agent: 'Command Code', tool: 'other', projectDir: '.commandcode', globalDir: '.commandcode' },
    { agent: 'Deep Agents', tool: 'other', projectDir: '.agents', globalDir: '.deepagents/agent' },
    { agent: 'Mistral Vibe', tool: 'other', projectDir: '.vibe', globalDir: '.vibe' },
    { agent: 'CodeBuddy', tool: 'other', projectDir: '.codebuddy', globalDir: '.codebuddy' },
    { agent: 'Cortex Code', tool: 'other', projectDir: '.cortex', globalDir: '.snowflake/cortex' },
    { agent: 'iFlow CLI', tool: 'other', projectDir: '.iflow', globalDir: '.iflow' },
    { agent: 'Kiro CLI', tool: 'other', projectDir: '.kiro', globalDir: '.kiro' },
    { agent: 'MCPJam', tool: 'other', projectDir: '.mcpjam', globalDir: '.mcpjam' },
    { agent: 'Neovate', tool: 'other', projectDir: '.neovate', globalDir: '.neovate' },
    { agent: 'Pochi', tool: 'other', projectDir: '.pochi', globalDir: '.pochi' },
    { agent: 'AdaL', tool: 'other', projectDir: '.adal', globalDir: '.adal' },
    { agent: 'Antigravity', tool: 'other', projectDir: '.agents', globalDir: '.gemini/antigravity' },
    { agent: 'OpenClaw', tool: 'other', projectDir: 'skills', globalDir: '.openclaw' },
];
/**
 * Map a `globalDir` from AGENT_PATHS to an AI-settings-controlled override
 * agent type, when one applies. Only agents whose `globalDir` exactly matches
 * their configurable root are overridable; everything else just uses `~/<globalDir>`.
 */
function overridableAgentForGlobalDir(globalDir) {
    switch (globalDir) {
        case '.claude': return 'claude';
        case '.codex': return 'codex';
        case '.gemini': return 'gemini';
        case '.qwen': return 'qwen';
        default: return null;
    }
}
/** All global roots where skills may live — deduplicated. */
function getGlobalRoots(overrides = {}) {
    const home = electron_1.app.getPath('home');
    const seen = new Set();
    const roots = [];
    for (const a of AGENT_PATHS) {
        const overridable = overridableAgentForGlobalDir(a.globalDir);
        const overrideRoot = overridable ? overrides[overridable]?.trim() : undefined;
        const dir = a.tool === 'kimi'
            ? (0, kimiPaths_1.getKimiHome)()
            : overrideRoot
                ? overrideRoot.replace(/[\\/]+$/, '')
                : path_1.default.join(home, a.globalDir);
        if (seen.has(dir))
            continue;
        seen.add(dir);
        roots.push({ dir, tool: a.tool });
    }
    const hermesDir = (0, hermesPaths_1.getHermesHome)();
    if (!seen.has(hermesDir)) {
        roots.push({ dir: hermesDir, tool: 'hermes' });
    }
    return roots;
}
/** All project-level roots — deduplicated. */
function getProjectRoots(projectPath) {
    const seen = new Set();
    const roots = [];
    for (const a of AGENT_PATHS) {
        const dir = path_1.default.join(projectPath, a.projectDir);
        if (seen.has(dir))
            continue;
        seen.add(dir);
        roots.push({ dir, tool: a.tool });
    }
    return roots;
}
// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------
/**
 * Scan a root directory for skills in the standard layout:
 *   <root>/skills/<name>/SKILL.md       — nested skill directories
 *   <root>/commands/<name>.md            — flat slash commands
 *   <root>/plugins/<plugin>/skills/…     — plugin-embedded skills
 */
function scanRoot(rootDir, tool, source) {
    const results = [];
    // 1) <root>/skills/*/SKILL.md
    const skillsDir = path_1.default.join(rootDir, 'skills');
    if (fs_1.default.existsSync(skillsDir)) {
        try {
            for (const entry of fs_1.default.readdirSync(skillsDir, { withFileTypes: true })) {
                const entryPath = path_1.default.join(skillsDir, entry.name);
                // Control-plane installs are symlinked dirs; dirents report those as
                // symlinks, not directories, so resolve through stat (dangling → skip).
                let isDir = entry.isDirectory();
                let isLink = false;
                if (!isDir && entry.isSymbolicLink()) {
                    try {
                        isDir = fs_1.default.statSync(entryPath).isDirectory();
                        isLink = isDir;
                    }
                    catch {
                        continue;
                    }
                }
                if (!isDir)
                    continue;
                const skillMd = path_1.default.join(entryPath, 'SKILL.md');
                const parsed = readSkillFile(skillMd, tool, source);
                if (parsed) {
                    if (isLink) {
                        parsed.linked = true;
                        try {
                            const real = fs_1.default.realpathSync(entryPath);
                            const storeRoot = fs_1.default.realpathSync((0, skillsControlPlane_1.defaultSkillStoreRoot)());
                            const rel = path_1.default.relative(storeRoot, real);
                            if (rel && !rel.startsWith('..') && !path_1.default.isAbsolute(rel)) {
                                const m = /[\\/]v(\d+)$/.exec(real);
                                if (m)
                                    parsed.linkVersion = Number(m[1]);
                            }
                        }
                        catch { /* store absent or unreadable */ }
                    }
                    results.push(parsed);
                }
            }
        }
        catch { /* unreadable */ }
    }
    // 2) <root>/commands/*.md  (flat slash commands)
    const commandsDir = path_1.default.join(rootDir, 'commands');
    if (fs_1.default.existsSync(commandsDir)) {
        try {
            for (const entry of fs_1.default.readdirSync(commandsDir, { withFileTypes: true })) {
                if (!entry.isFile())
                    continue;
                if (path_1.default.extname(entry.name).toLowerCase() !== '.md')
                    continue;
                const filePath = path_1.default.join(commandsDir, entry.name);
                const parsed = readSkillFile(filePath, tool, source);
                if (parsed)
                    results.push(parsed);
            }
        }
        catch { /* unreadable */ }
    }
    // 3) <root>/plugins/*/skills/*/SKILL.md  (plugin-embedded skills — global only)
    if (source === 'local-global') {
        const pluginsDir = path_1.default.join(rootDir, 'plugins');
        if (fs_1.default.existsSync(pluginsDir)) {
            try {
                scanPluginsDir(pluginsDir, tool, source, results);
            }
            catch { /* unreadable */ }
        }
    }
    return results;
}
/** Recursively scan plugins directory for skills */
function scanPluginsDir(dir, tool, source, results, depth = 0) {
    if (depth > 5)
        return; // avoid runaway recursion
    try {
        for (const entry of fs_1.default.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory())
                continue;
            const entryPath = path_1.default.join(dir, entry.name);
            if (entry.name === 'skills') {
                // Found a skills/ folder inside a plugin — scan it
                try {
                    for (const skillEntry of fs_1.default.readdirSync(entryPath, { withFileTypes: true })) {
                        if (!skillEntry.isDirectory())
                            continue;
                        const skillMd = path_1.default.join(entryPath, skillEntry.name, 'SKILL.md');
                        const parsed = readSkillFile(skillMd, tool, source);
                        if (parsed)
                            results.push(parsed);
                    }
                }
                catch { /* unreadable */ }
            }
            else {
                // Recurse deeper
                scanPluginsDir(entryPath, tool, source, results, depth + 1);
            }
        }
    }
    catch { /* unreadable */ }
}
/** Read and parse a single skill/command file into a SkillFile. */
function readSkillFile(filePath, tool, source) {
    if (!fs_1.default.existsSync(filePath))
        return null;
    try {
        const stat = fs_1.default.statSync(filePath);
        const content = fs_1.default.readFileSync(filePath, 'utf-8');
        const { frontmatter } = parseFrontmatter(content);
        const risk = assessRisk(content);
        const ext = path_1.default.extname(filePath);
        const name = frontmatter.name || path_1.default.basename(path_1.default.dirname(filePath) === '.' ? filePath : path_1.default.dirname(filePath));
        // If it's a flat file like commands/foo.md, use the filename
        const finalName = name === 'SKILL' ? path_1.default.basename(path_1.default.dirname(filePath)) : (name === '.' ? path_1.default.basename(filePath, ext) : name);
        return {
            id: `${source}:${filePath}`,
            name: finalName,
            description: frontmatter.description || extractFirstLine(content),
            content,
            filePath,
            source,
            tool,
            category: frontmatter.category || guessCategory(finalName, content),
            metadata: {
                ...frontmatter.metadata,
                ...(frontmatter.user_invocable != null ? { user_invocable: frontmatter.user_invocable } : {}),
            },
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            risk: risk.level,
            riskDetails: risk.details,
        };
    }
    catch {
        return null;
    }
}
/** Recursively copy a directory and all its contents */
function copyDirRecursive(src, dest) {
    if (!fs_1.default.existsSync(dest))
        fs_1.default.mkdirSync(dest, { recursive: true });
    for (const entry of fs_1.default.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path_1.default.join(src, entry.name);
        const destPath = path_1.default.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        }
        else {
            fs_1.default.copyFileSync(srcPath, destPath);
        }
    }
}
function extractFirstLine(content) {
    let text = content;
    if (text.startsWith('---')) {
        const endIdx = text.indexOf('---', 3);
        if (endIdx !== -1)
            text = text.slice(endIdx + 3).trim();
    }
    const firstLine = text.split('\n').find(l => l.trim() && !l.startsWith('#'));
    return firstLine?.trim().slice(0, 200) || '';
}
function guessCategory(name, content) {
    const text = (name + ' ' + content).toLowerCase();
    if (/audit|security|vulnerab|pentest|owasp/i.test(text))
        return 'audit';
    if (/seo|search\s+engine|meta\s+tag|sitemap/i.test(text))
        return 'seo';
    if (/market|campaign|email|social\s+media|copywrite|content\s+strateg/i.test(text))
        return 'marketing';
    if (/design|ui|ux|figma|css|tailwind|layout/i.test(text))
        return 'design';
    if (/deploy|docker|ci|cd|kubernetes|terraform|infra/i.test(text))
        return 'devops';
    if (/test|spec|jest|vitest|playwright|cypress/i.test(text))
        return 'testing';
    if (/code|develop|program|api|function|component|refactor/i.test(text))
        return 'dev';
    return 'other';
}
/** Extract the initialSkills array from skills.sh HTML.
 *
 * skills.sh uses React Server Components streaming.  The skill data is
 * embedded in the HTML as a JSON array with *escaped* double-quotes because
 * it lives inside a larger JSON string in the RSC payload.  The pattern in
 * the raw HTML looks like:
 *
 *   [{"source":"vercel-labs/skills","skillId":"find-skills","name":"find-skills","installs":610914},…]
 *
 * but with the quotes escaped as  \"  when the array is inside an RSC chunk.
 */
function extractSkillsFromHtml(html) {
    // Strategy 1: Look for the escaped-JSON array that the RSC payload uses.
    // Match a run of  {\"source\":\"...\",\"skillId\":\"...\",\"name\":\"...\",\"installs\":NNN}
    // and extract the whole [...] array surrounding it.
    const escapedArrayMatch = html.match(/\[\{\\?"source\\?":\s*\\?"[^"]+\\?",\s*\\?"skillId\\?":\s*\\?"[^"]+\\?"[\s\S]*?\}\]/);
    if (escapedArrayMatch) {
        try {
            // Un-escape the JSON: replace \" with "
            const raw = escapedArrayMatch[0].replace(/\\"/g, '"');
            const arr = JSON.parse(raw);
            if (arr.length > 0 && arr[0]?.source && arr[0]?.skillId) {
                return arr;
            }
        }
        catch { /* parse failed */ }
    }
    // Strategy 2: Extract individual entries via repeated regex matching
    // This is a robust fallback that doesn't require finding array boundaries.
    const entryPattern = /\{\\?"source\\?":\s*\\?"([^"\\]+)\\?"\s*,\s*\\?"skillId\\?":\s*\\?"([^"\\]+)\\?"\s*,\s*\\?"name\\?":\s*\\?"([^"\\]+)\\?"\s*,\s*\\?"installs\\?":\s*(\d+)\s*\}/g;
    const entries = [];
    let m;
    while ((m = entryPattern.exec(html)) !== null) {
        entries.push({
            source: m[1],
            skillId: m[2],
            name: m[3],
            installs: parseInt(m[4], 10),
        });
    }
    if (entries.length > 0)
        return entries;
    // Strategy 3: __NEXT_DATA__ script tag (older Next.js pages)
    const nextMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextMatch) {
        try {
            const data = JSON.parse(nextMatch[1]);
            const found = findSkillsArray(data);
            if (found.length > 0)
                return found;
        }
        catch { /* parse failed */ }
    }
    return [];
}
/** Recursively search a nested object for an array of skill entries */
function findSkillsArray(obj, depth = 0) {
    if (depth > 8 || !obj || typeof obj !== 'object')
        return [];
    if (Array.isArray(obj)) {
        if (obj.length > 3 && obj[0]?.source && obj[0]?.skillId) {
            return obj;
        }
        for (const item of obj) {
            const r = findSkillsArray(item, depth + 1);
            if (r.length > 0)
                return r;
        }
    }
    else {
        for (const val of Object.values(obj)) {
            const r = findSkillsArray(val, depth + 1);
            if (r.length > 0)
                return r;
        }
    }
    return [];
}
/** Extract skill content from a skills.sh detail page.
 *
 * The page is a Next.js RSC app. The skill content is embedded as rendered
 * HTML inside a `dangerouslySetInnerHTML.__html` value in the RSC payload.
 * We extract the longest such HTML string (the skill body, not small UI bits)
 * and convert it to markdown-like plain text so it can be displayed and
 * installed just like a raw SKILL.md. */
function extractSkillContentFromDetailPage(html) {
    // Find all __html values in the RSC payload
    // Pattern: "__html":"<content>"  — the content uses escaped quotes inside
    const matches = [];
    const pattern = /"__html":"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = pattern.exec(html)) !== null) {
        try {
            // Unescape JSON string escapes
            const unescaped = JSON.parse(`"${m[1]}"`);
            if (unescaped.length > 100) {
                matches.push(unescaped);
            }
        }
        catch { /* skip malformed */ }
    }
    if (matches.length === 0)
        return null;
    // Take the longest match — that's the main skill content
    const contentHtml = matches.reduce((a, b) => a.length > b.length ? a : b);
    // Convert HTML to markdown-ish plain text for display and install
    const markdown = htmlToMarkdown(contentHtml);
    return markdown || null;
}
/** Simple HTML → Markdown converter for skill content extracted from skills.sh */
function htmlToMarkdown(html) {
    let md = html
        // Headings
        .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, c) => `# ${stripTags(c)}\n\n`)
        .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, c) => `## ${stripTags(c)}\n\n`)
        .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, c) => `### ${stripTags(c)}\n\n`)
        .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, c) => `#### ${stripTags(c)}\n\n`)
        .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_, c) => `##### ${stripTags(c)}\n\n`)
        .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_, c) => `###### ${stripTags(c)}\n\n`)
        // Code blocks
        .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, c) => `\`\`\`\n${decodeHtmlEntities(stripTags(c))}\n\`\`\`\n\n`)
        .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => `\`\`\`\n${decodeHtmlEntities(stripTags(c))}\n\`\`\`\n\n`)
        // Inline code
        .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => `\`${stripTags(c)}\``)
        // Bold / italic
        .replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, c) => `**${stripTags(c)}**`)
        .replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t, c) => `*${stripTags(c)}*`)
        // Links
        .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, c) => `[${stripTags(c)}](${href})`)
        // List items
        .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, c) => `- ${stripTags(c).trim()}\n`)
        // Paragraphs and divs
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<p[^>]*>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        // Tables — simplified
        .replace(/<thead[^>]*>([\s\S]*?)<\/thead>/gi, (_, c) => {
        const headers = extractTableCells(c, 'th');
        if (headers.length === 0)
            return c;
        return `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n`;
    })
        .replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, c) => {
        const cells = extractTableCells(c, 'td');
        return cells.length > 0 ? `| ${cells.join(' | ')} |\n` : '';
    })
        // Remove remaining tags
        .replace(/<\/?[^>]+(>|$)/g, '')
        // Decode entities
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        // Clean up whitespace
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return md;
}
function stripTags(html) {
    return html.replace(/<\/?[^>]+(>|$)/g, '');
}
function decodeHtmlEntities(str) {
    return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function extractTableCells(rowHtml, tag) {
    const cells = [];
    const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    let m;
    while ((m = pattern.exec(rowHtml)) !== null) {
        cells.push(stripTags(m[1]).trim());
    }
    return cells;
}
function remoteEntryToSkillFile(entry) {
    const installs = entry.installs;
    let installStr = '';
    if (installs >= 1000000)
        installStr = `${(installs / 1000000).toFixed(1)}M`;
    else if (installs >= 1000)
        installStr = `${(installs / 1000).toFixed(1)}K`;
    else if (installs > 0)
        installStr = String(installs);
    return {
        id: `remote:${entry.source}/${entry.skillId}`,
        name: entry.name || entry.skillId,
        description: installStr ? `From ${entry.source} · ${installStr} installs` : `From ${entry.source}`,
        content: '', // fetched on demand
        filePath: '',
        source: 'remote',
        tool: 'claude',
        category: guessCategory(entry.name || entry.skillId, ''),
        size: 0,
        modifiedAt: new Date().toISOString(),
        risk: 'safe',
        riskDetails: [],
        remoteSource: entry.source,
        weeklyInstalls: installStr,
    };
}
// ---------------------------------------------------------------------------
// SkillsManager
// ---------------------------------------------------------------------------
class SkillsManager {
    watchers = new Map();
    onChangeCallback = null;
    starsCache = new Map(); // repo → stars count
    getOverrides;
    constructor(getOverrides = () => ({})) {
        this.getOverrides = getOverrides;
    }
    /** Scan all global skill directories */
    scanGlobal() {
        return getGlobalRoots(this.getOverrides()).flatMap(({ dir, tool }) => scanRoot(dir, tool, 'local-global'));
    }
    /** Scan project-specific skill directories */
    scanProject(projectPath) {
        return getProjectRoots(projectPath).flatMap(({ dir, tool }) => scanRoot(dir, tool, 'local-project'));
    }
    /** Scan all skills (global + project) */
    scanAll(projectPath) {
        const global = this.scanGlobal();
        const project = projectPath ? this.scanProject(projectPath) : [];
        return [...global, ...project];
    }
    /** Watch skill directories for changes (recursive) */
    watch(projectPath, onChange) {
        this.onChangeCallback = onChange || null;
        this.unwatchAll();
        const roots = [
            ...getGlobalRoots(this.getOverrides()).map(r => r.dir),
            ...(projectPath ? getProjectRoots(projectPath).map(r => r.dir) : []),
        ];
        for (const root of roots) {
            // Watch <root>/skills/ and <root>/commands/
            for (const sub of ['skills', 'commands']) {
                const dir = path_1.default.join(root, sub);
                if (!fs_1.default.existsSync(dir))
                    continue;
                try {
                    const watcher = fs_1.default.watch(dir, { persistent: false, recursive: true }, () => {
                        this.onChangeCallback?.();
                    });
                    this.watchers.set(dir, watcher);
                }
                catch { /* can't watch */ }
            }
        }
    }
    unwatchAll() {
        for (const watcher of this.watchers.values()) {
            watcher.close();
        }
        this.watchers.clear();
    }
    /** Read a single skill file */
    readSkill(filePath) {
        if (!fs_1.default.existsSync(filePath))
            return null;
        const home = electron_1.app.getPath('home');
        const isGlobal = filePath.startsWith(home + path_1.default.sep + '.');
        const tool = filePath.startsWith((0, kimiPaths_1.getKimiHome)() + path_1.default.sep) || filePath.includes(`${path_1.default.sep}.kimi-code${path_1.default.sep}`) ? 'kimi'
            : filePath.includes('.claude') ? 'claude'
                : filePath.includes('.cursor') ? 'cursor'
                    : filePath.includes('.codex') ? 'codex'
                        : filePath.includes('.gemini') ? 'gemini'
                            : 'other';
        return readSkillFile(filePath, tool, isGlobal ? 'local-global' : 'local-project');
    }
    /** Write/update a skill file */
    writeSkill(filePath, content) {
        const dir = path_1.default.dirname(filePath);
        // A control-plane-linked skill dir is a symlink into the versioned store;
        // writing through it would silently mutate an immutable store version.
        try {
            if (fs_1.default.lstatSync(dir).isSymbolicLink()) {
                throw new Error('This skill is linked from the control-plane store. Add a new store version instead of editing the link.');
            }
        }
        catch (err) {
            if (err.code !== 'ENOENT')
                throw err;
        }
        if (!fs_1.default.existsSync(dir))
            fs_1.default.mkdirSync(dir, { recursive: true });
        fs_1.default.writeFileSync(filePath, content, 'utf-8');
    }
    /** Create a new skill with category-specific template */
    createSkill(dir, name, _tool, category) {
        const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
        const skillDir = path_1.default.join(dir, 'skills', slug);
        if (!fs_1.default.existsSync(skillDir))
            fs_1.default.mkdirSync(skillDir, { recursive: true });
        const filePath = path_1.default.join(skillDir, 'SKILL.md');
        const boilerplate = getCategoryTemplate(slug, name, category);
        fs_1.default.writeFileSync(filePath, boilerplate, 'utf-8');
        return filePath;
    }
    /** Check if a skill already exists at the target path */
    skillExists(projectPath, skillName, tool = 'claude') {
        let rootDir;
        switch (tool) {
            case 'cursor':
                rootDir = path_1.default.join(projectPath, '.cursor');
                break;
            case 'codex':
                rootDir = path_1.default.join(projectPath, '.codex');
                break;
            case 'kimi':
                rootDir = path_1.default.join(projectPath, '.kimi-code');
                break;
            default:
                rootDir = path_1.default.join(projectPath, '.claude');
                break;
        }
        const slug = skillName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
        const filePath = path_1.default.join(rootDir, 'skills', slug, 'SKILL.md');
        if (fs_1.default.existsSync(filePath)) {
            return { exists: true, filePath, content: fs_1.default.readFileSync(filePath, 'utf-8') };
        }
        return { exists: false, filePath };
    }
    /** Check if a local skill has an update available on GitHub.
     *  Compares local content hash against the remote SKILL.md. */
    async checkForUpdate(skill) {
        if (!skill.remoteSource || skill.source === 'remote')
            return { hasUpdate: false };
        const slug = skill.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
        const fetched = await this.fetchRemoteSkill(`${skill.remoteSource}/${slug}`);
        if (!fetched?.content)
            return { hasUpdate: false };
        // Compare by trimmed content (ignore whitespace diffs)
        const localTrimmed = skill.content.trim();
        const remoteTrimmed = fetched.content.trim();
        return {
            hasUpdate: localTrimmed !== remoteTrimmed,
            remoteContent: fetched.content,
        };
    }
    /** Extract skill references from content (npx skills add ... patterns and /skill-name patterns) */
    static extractReferences(content) {
        const installRefs = [];
        const slashRefs = [];
        // Match: npx skills add owner/repo@skill or npx skills add owner/repo
        const installPattern = /npx\s+skills?\s+add\s+([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+(?:@[a-zA-Z0-9._-]+)?)/g;
        let m;
        while ((m = installPattern.exec(content)) !== null) {
            if (!installRefs.includes(m[1]))
                installRefs.push(m[1]);
        }
        // Match: /skill-name at start of line or after backtick
        const slashPattern = /(?:^|`|\s)\/([a-z][a-z0-9_-]{1,50})(?:\s|`|$)/gm;
        while ((m = slashPattern.exec(content)) !== null) {
            if (!slashRefs.includes(m[1]))
                slashRefs.push(m[1]);
        }
        return { installRefs, slashRefs };
    }
    /** Parse which skills are referenced in CLAUDE.md or .cursorrules */
    getActiveSkills(projectPath) {
        const active = new Set();
        const filesToCheck = [
            path_1.default.join(projectPath, 'CLAUDE.md'),
            path_1.default.join(projectPath, '.claude', 'CLAUDE.md'),
            path_1.default.join(projectPath, '.cursorrules'),
            path_1.default.join(projectPath, '.cursor', 'rules', '.cursorrules'),
        ];
        for (const f of filesToCheck) {
            if (!fs_1.default.existsSync(f))
                continue;
            try {
                const content = fs_1.default.readFileSync(f, 'utf-8');
                const lower = content.toLowerCase();
                // Check for skill name mentions (slash commands or direct name references)
                const skillPattern = /\/([a-z][a-z0-9_-]{1,50})/g;
                let m;
                while ((m = skillPattern.exec(lower)) !== null) {
                    active.add(m[1]);
                }
                // Also check for skill file path references
                const pathPattern = /\.claude\/skills\/([a-z][a-z0-9_-]+)/g;
                while ((m = pathPattern.exec(lower)) !== null) {
                    active.add(m[1]);
                }
            }
            catch { /* unreadable */ }
        }
        return active;
    }
    /** Install a skill into a project's .claude/skills/<name>/SKILL.md.
     *  If the skill has no content (remote listing), fetches it from GitHub first. */
    async installSkill(projectPath, skill, tool = 'claude') {
        let rootDir;
        switch (tool) {
            case 'cursor':
                rootDir = path_1.default.join(projectPath, '.cursor');
                break;
            case 'codex':
                rootDir = path_1.default.join(projectPath, '.codex');
                break;
            case 'kimi':
                rootDir = path_1.default.join(projectPath, '.kimi-code');
                break;
            default:
                rootDir = path_1.default.join(projectPath, '.claude');
                break;
        }
        const slug = skill.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
        const targetSkillDir = path_1.default.join(rootDir, 'skills', slug);
        // --- Local skill: copy the entire skill directory (SKILL.md + references/) ---
        if (skill.filePath && skill.source !== 'remote') {
            const sourceSkillDir = path_1.default.dirname(skill.filePath);
            if (fs_1.default.existsSync(sourceSkillDir)) {
                copyDirRecursive(sourceSkillDir, targetSkillDir);
                return path_1.default.join(targetSkillDir, 'SKILL.md');
            }
        }
        // --- Remote skill: fetch content from GitHub ---
        let content = skill.content;
        if (!content && skill.remoteSource) {
            const fetched = await this.fetchRemoteSkill(`${skill.remoteSource}/${slug}`);
            if (fetched?.content) {
                content = fetched.content;
            }
        }
        // Fallback: read from disk if filePath exists
        if (!content && skill.filePath && fs_1.default.existsSync(skill.filePath)) {
            content = fs_1.default.readFileSync(skill.filePath, 'utf-8');
        }
        if (!content) {
            throw new Error(`Cannot install skill "${skill.name}": no content available`);
        }
        if (!fs_1.default.existsSync(targetSkillDir))
            fs_1.default.mkdirSync(targetSkillDir, { recursive: true });
        const filePath = path_1.default.join(targetSkillDir, 'SKILL.md');
        fs_1.default.writeFileSync(filePath, content, 'utf-8');
        return filePath;
    }
    // -------------------------------------------------------------------------
    // Control-plane store: install once centrally, per-project manifest picks
    // skill + version, apply symlinks them into the project (skillsControlPlane).
    // -------------------------------------------------------------------------
    storeList() {
        return (0, skillsControlPlane_1.listStore)((0, skillsControlPlane_1.defaultSkillStoreRoot)());
    }
    /** Add a skill (local dir, flat command file, or remote listing) to the store. */
    async storeAdd(skill) {
        const storeRoot = (0, skillsControlPlane_1.defaultSkillStoreRoot)();
        const slug = (0, skillsControlPlane_1.slugifySkillName)(skill.name);
        if (skill.filePath && skill.source !== 'remote' && fs_1.default.existsSync(skill.filePath)) {
            if (path_1.default.basename(skill.filePath) === 'SKILL.md') {
                return (0, skillsControlPlane_1.addDirToStore)(storeRoot, slug, path_1.default.dirname(skill.filePath));
            }
            // Flat command file (commands/foo.md) — store its content as SKILL.md.
            return (0, skillsControlPlane_1.addContentToStore)(storeRoot, slug, fs_1.default.readFileSync(skill.filePath, 'utf-8'));
        }
        let content = skill.content;
        if (!content && skill.remoteSource) {
            const fetched = await this.fetchRemoteSkill(`${skill.remoteSource}/${slug}`);
            if (fetched?.content)
                content = fetched.content;
        }
        if (!content)
            throw new Error(`Cannot add "${skill.name}" to the store: no content available`);
        return (0, skillsControlPlane_1.addContentToStore)(storeRoot, slug, content);
    }
    storeRemove(name, version) {
        return (0, skillsControlPlane_1.removeFromStore)((0, skillsControlPlane_1.defaultSkillStoreRoot)(), name, version);
    }
    storeRead(name, version) {
        return (0, skillsControlPlane_1.readStoreSkill)((0, skillsControlPlane_1.defaultSkillStoreRoot)(), name, version);
    }
    manifestGet(projectPath) {
        return (0, skillsControlPlane_1.readManifest)(projectPath);
    }
    manifestSet(projectPath, manifest) {
        (0, skillsControlPlane_1.writeManifest)(projectPath, manifest);
    }
    manifestPlan(projectPath) {
        const manifest = (0, skillsControlPlane_1.readManifest)(projectPath) ?? { version: 1, skills: [] };
        return (0, skillsControlPlane_1.computePlan)((0, skillsControlPlane_1.defaultSkillStoreRoot)(), projectPath, manifest);
    }
    manifestApply(projectPath, options) {
        const manifest = (0, skillsControlPlane_1.readManifest)(projectPath) ?? { version: 1, skills: [] };
        return (0, skillsControlPlane_1.applyManifest)((0, skillsControlPlane_1.defaultSkillStoreRoot)(), projectPath, manifest, options);
    }
    /**
     * Install the auto-managed 1DevTool orchestration skill into every installed
     * agent's canonical skills dir. Canonical-only — never writes to
     * `~/.agents/skills/`. See `using_skills_plan.md` Phase 2.3.
     *
     * Idempotent: skips writes when both the version and content hash match
     * (and the shim path hasn't changed). Returns one entry per target so the
     * caller can surface install status.
     */
    installOrchestrationSkillGlobally(shimPath, policy, targets) {
        const results = [];
        const canonicalDir = this.orchestrationCanonicalDir();
        for (const target of skillContent_1.ORCHESTRATION_SKILL_TARGETS) {
            if (targets && !targets.includes(target))
                continue;
            try {
                const agentHome = canonicalDir(target);
                if (!fs_1.default.existsSync(agentHome)) {
                    results.push({ tool: target, path: null, status: 'skipped-no-agent-dir' });
                    continue;
                }
                // Remove copies installed under a previous skill name — a stale
                // `devtool-orchestrator` advertising an outdated delegate list keeps
                // activating alongside the current skill. Only delete files we own
                // (frontmatter `source: 1devtool`).
                for (const legacyName of skillContent_1.LEGACY_SKILL_NAMES) {
                    const legacyDir = path_1.default.join(agentHome, 'skills', legacyName);
                    const legacyFile = path_1.default.join(legacyDir, 'SKILL.md');
                    try {
                        if (!fs_1.default.existsSync(legacyFile))
                            continue;
                        const legacyContent = fs_1.default.readFileSync(legacyFile, 'utf-8');
                        if (!/^\s*source:\s*1devtool\s*$/m.test(legacyContent))
                            continue;
                        fs_1.default.rmSync(legacyDir, { recursive: true, force: true });
                    }
                    catch { /* best-effort */ }
                }
                const skillDir = path_1.default.join(agentHome, 'skills', skillContent_1.SKILL_NAME);
                const skillFile = path_1.default.join(skillDir, 'SKILL.md');
                const newContent = (0, skillContent_1.buildOrchestratorSkill)(target, { shimPath, policy });
                const newHash = (0, skillContent_1.skillContentHash)(newContent);
                if (fs_1.default.existsSync(skillFile)) {
                    try {
                        const existing = fs_1.default.readFileSync(skillFile, 'utf-8');
                        const existingHash = (0, skillContent_1.skillContentHash)(existing);
                        // Also re-check the shim path — a moved-app upgrade changes the
                        // shim path without changing the hash (we normalise it out of the
                        // hash precisely so this comparison stays meaningful).
                        const existingShim = existing.match(/^\s*shim:\s*(.+)$/m)?.[1]?.trim();
                        if (existingHash === newHash && existingShim === shimPath) {
                            results.push({ tool: target, path: skillFile, status: 'skipped-unchanged' });
                            continue;
                        }
                    }
                    catch { /* fall through to write */ }
                }
                fs_1.default.mkdirSync(skillDir, { recursive: true });
                fs_1.default.writeFileSync(skillFile, newContent, 'utf-8');
                results.push({ tool: target, path: skillFile, status: 'wrote' });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                results.push({ tool: target, path: null, status: 'error', error: message });
            }
        }
        return results;
    }
    /**
     * Install the auto-managed 1DevTool Tasks skill into every installed agent's
     * canonical skills dir (docs/tasks_v2.md §6.3).
     *
     * Same targets, same idempotence and the same status surface as the
     * orchestration skill — but deliberately NOT the same shim gate: this skill
     * documents the onedevtool MCP task tools, which are live whenever the app
     * is, and never mentions the 1devtool-agent CLI. Gating it on the shim would
     * mean a dev build with a preserved shim ships the tools with nothing
     * teaching them (the same reasoning as the Codex Browser MCP skill).
     */
    installTasksSkillGlobally(targets) {
        const results = [];
        const canonicalDir = this.orchestrationCanonicalDir();
        for (const target of skillContent_1.ORCHESTRATION_SKILL_TARGETS) {
            if (targets && !targets.includes(target))
                continue;
            try {
                const agentHome = canonicalDir(target);
                if (!fs_1.default.existsSync(agentHome)) {
                    results.push({ tool: target, path: null, status: 'skipped-no-agent-dir' });
                    continue;
                }
                const skillDir = path_1.default.join(agentHome, 'skills', skillContent_2.TASKS_SKILL_NAME);
                const skillFile = path_1.default.join(skillDir, 'SKILL.md');
                const content = (0, skillContent_2.buildTasksSkill)(target);
                if (fs_1.default.existsSync(skillFile) && fs_1.default.readFileSync(skillFile, 'utf-8') === content) {
                    results.push({ tool: target, path: skillFile, status: 'skipped-unchanged' });
                    continue;
                }
                fs_1.default.mkdirSync(skillDir, { recursive: true });
                fs_1.default.writeFileSync(skillFile, content, 'utf-8');
                results.push({ tool: target, path: skillFile, status: 'wrote' });
            }
            catch (error) {
                results.push({
                    tool: target,
                    path: null,
                    status: 'error',
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        return results;
    }
    /** Installed Tasks SKILL.md version per target — Tasks staleness for §5's status surface. */
    readTasksSkillStates() {
        const canonicalDir = this.orchestrationCanonicalDir();
        return skillContent_1.ORCHESTRATION_SKILL_TARGETS.map((target) => {
            try {
                const agentHome = canonicalDir(target);
                const agentDirExists = fs_1.default.existsSync(agentHome);
                const skillFile = path_1.default.join(agentHome, 'skills', skillContent_2.TASKS_SKILL_NAME, 'SKILL.md');
                if (!agentDirExists || !fs_1.default.existsSync(skillFile)) {
                    return { tool: target, path: agentDirExists ? skillFile : null, exists: false, agentDirExists, version: null };
                }
                const version = fs_1.default.readFileSync(skillFile, 'utf-8').match(/^\s*version:\s*(\d+)\s*$/m)?.[1];
                return {
                    tool: target,
                    path: skillFile,
                    exists: true,
                    agentDirExists,
                    version: version ? Number(version) : null,
                };
            }
            catch {
                return { tool: target, path: null, exists: false, agentDirExists: false, version: null };
            }
        });
    }
    /**
     * Install the Codex-only, shim-independent Browser MCP routing skill. This
     * must not share orchestration's dev-preserve gate: the skill calls the
     * onedevtool MCP directly and never advertises 1devtool-agent CLI flags.
     */
    installBrowserMcpSkillForCodex() {
        try {
            const codexHome = this.orchestrationCanonicalDir()('codex');
            if (!fs_1.default.existsSync(codexHome)) {
                return { tool: 'codex-browser-mcp', path: null, status: 'skipped-no-agent-dir' };
            }
            const skillDir = path_1.default.join(codexHome, 'skills', browserSkillContent_1.BROWSER_MCP_SKILL_NAME);
            const skillFile = path_1.default.join(skillDir, 'SKILL.md');
            const content = (0, browserSkillContent_1.buildBrowserMcpSkill)();
            if (fs_1.default.existsSync(skillFile) && fs_1.default.readFileSync(skillFile, 'utf-8') === content) {
                return { tool: 'codex-browser-mcp', path: skillFile, status: 'skipped-unchanged' };
            }
            fs_1.default.mkdirSync(skillDir, { recursive: true });
            fs_1.default.writeFileSync(skillFile, content, 'utf-8');
            return { tool: 'codex-browser-mcp', path: skillFile, status: 'wrote' };
        }
        catch (error) {
            return {
                tool: 'codex-browser-mcp',
                path: null,
                status: 'error',
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
    /** Canonical agent home dir per AGENT_PATHS. Keeps AI-settings overrides
     *  for roots the app already lets users customize. os.homedir() (honors
     *  $HOME) — not app.getPath('home') — so it always agrees with the
     *  standalone CLI's path resolution and e2e temp-HOME sandboxes work. */
    orchestrationCanonicalDir() {
        const home = os_1.default.homedir();
        const overrides = this.getOverrides();
        return (target) => {
            const overridable = target === 'claude' ? 'claude'
                : target === 'codex' ? 'codex'
                    : target === 'gemini' ? 'gemini'
                        : target === 'opencode' ? 'opencode'
                            : null;
            const overrideRoot = overridable ? overrides[overridable]?.trim() : undefined;
            if (overrideRoot)
                return overrideRoot.replace(/[\\/]+$/, '');
            if (target === 'agy') {
                const geminiRoot = overrides.gemini?.trim();
                if (geminiRoot)
                    return path_1.default.join(geminiRoot.replace(/[\\/]+$/, ''), 'antigravity');
            }
            if (target === 'hermes')
                return (0, hermesPaths_1.getHermesHome)();
            if (target === 'kimi')
                return (0, kimiPaths_1.getKimiHome)();
            return path_1.default.join(home, ORCHESTRATION_TARGET_GLOBAL_DIRS[target]);
        };
    }
    /**
     * Read the installed orchestration SKILL.md frontmatter per target — the
     * dashboard's `orchestration:skill-status` source (§5). Read-only; parses
     * the same fields the installer's idempotence check uses.
     */
    readOrchestrationSkillStates() {
        const canonicalDir = this.orchestrationCanonicalDir();
        return skillContent_1.ORCHESTRATION_SKILL_TARGETS.map((target) => {
            try {
                const agentHome = canonicalDir(target);
                const agentDirExists = fs_1.default.existsSync(agentHome);
                const skillFile = path_1.default.join(agentHome, 'skills', skillContent_1.SKILL_NAME, 'SKILL.md');
                if (!agentDirExists || !fs_1.default.existsSync(skillFile)) {
                    return { tool: target, path: agentDirExists ? skillFile : null, exists: false, agentDirExists, version: null, shim: null, policyHash: null };
                }
                const content = fs_1.default.readFileSync(skillFile, 'utf-8');
                const version = content.match(/^\s*version:\s*(\d+)\s*$/m)?.[1];
                const shim = content.match(/^\s*shim:\s*(.+)$/m)?.[1]?.trim();
                const policyHash = content.match(/^\s*policyHash:\s*([0-9a-f]+)\s*$/m)?.[1];
                return {
                    tool: target,
                    path: skillFile,
                    exists: true,
                    agentDirExists,
                    version: version ? Number(version) : null,
                    shim: shim ?? null,
                    policyHash: policyHash ?? null,
                };
            }
            catch {
                return { tool: target, path: null, exists: false, agentDirExists: false, version: null, shim: null, policyHash: null };
            }
        });
    }
    /** Read one installed orchestration SKILL.md verbatim (Skill tab per-target
     *  view). Returns null when absent. */
    readOrchestrationSkillFile(target) {
        try {
            const agentHome = this.orchestrationCanonicalDir()(target);
            const skillFile = path_1.default.join(agentHome, 'skills', skillContent_1.SKILL_NAME, 'SKILL.md');
            if (!fs_1.default.existsSync(skillFile))
                return null;
            return { path: skillFile, content: fs_1.default.readFileSync(skillFile, 'utf-8') };
        }
        catch {
            return null;
        }
    }
    /** Delete a skill file */
    deleteSkill(filePath) {
        try {
            // Deleting a control-plane-linked skill must remove the symlink, not
            // reach through it and delete the store version's SKILL.md.
            const parentDir = path_1.default.dirname(filePath);
            try {
                if (fs_1.default.lstatSync(parentDir).isSymbolicLink()) {
                    (0, skillsControlPlane_1.removeLink)(parentDir);
                    return true;
                }
            }
            catch { /* parent absent — fall through */ }
            if (!fs_1.default.existsSync(filePath))
                return false;
            fs_1.default.unlinkSync(filePath);
            // Clean up empty parent dir if it was a SKILL.md inside a skill folder
            try {
                const remaining = fs_1.default.readdirSync(parentDir);
                if (remaining.length === 0)
                    fs_1.default.rmdirSync(parentDir);
            }
            catch { /* ignore */ }
            return true;
        }
        catch {
            return false;
        }
    }
    /** Full-text search across all skills */
    search(skills, query) {
        if (!query.trim())
            return skills;
        const lower = query.toLowerCase();
        return skills.filter(s => s.name.toLowerCase().includes(lower) ||
            s.description.toLowerCase().includes(lower) ||
            s.content.toLowerCase().includes(lower));
    }
    // -------------------------------------------------------------------------
    // Remote: skills.sh leaderboard
    // -------------------------------------------------------------------------
    /** Fetch the skills.sh leaderboard by scraping HTML */
    async fetchRemoteSkills(query) {
        try {
            const url = query
                ? `https://skills.sh/?q=${encodeURIComponent(query)}`
                : 'https://skills.sh/';
            const response = await fetch(url, {
                signal: AbortSignal.timeout(15000),
            });
            if (!response.ok)
                return [];
            const html = await response.text();
            let entries = extractSkillsFromHtml(html);
            // Client-side filter if query was provided (the site may not support server-side search)
            if (query && entries.length > 0) {
                const q = query.toLowerCase();
                entries = entries.filter(e => e.name.toLowerCase().includes(q) ||
                    e.skillId.toLowerCase().includes(q) ||
                    e.source.toLowerCase().includes(q));
            }
            const skills = entries.slice(0, 200).map(remoteEntryToSkillFile);
            // Enrich with GitHub stars (batch by unique source repo)
            const uniqueRepos = [...new Set(entries.slice(0, 200).map(e => e.source))];
            await Promise.allSettled(uniqueRepos.map(async (repo) => {
                if (this.starsCache.has(repo))
                    return;
                try {
                    const resp = await fetch(`https://api.github.com/repos/${repo}`, {
                        signal: AbortSignal.timeout(5000),
                        headers: { 'Accept': 'application/vnd.github.v3+json' },
                        redirect: 'follow',
                    });
                    if (resp.ok) {
                        const data = await resp.json();
                        if (typeof data.stargazers_count === 'number') {
                            this.starsCache.set(repo, data.stargazers_count);
                        }
                    }
                }
                catch { /* skip */ }
            }));
            // Apply cached stars
            for (const s of skills) {
                if (s.remoteSource && this.starsCache.has(s.remoteSource)) {
                    const count = this.starsCache.get(s.remoteSource);
                    if (count >= 1000)
                        s.stars = `${(count / 1000).toFixed(1)}K`;
                    else
                        s.stars = String(count);
                }
            }
            return skills;
        }
        catch {
            return [];
        }
    }
    /** Fetch a single skill's content from its skills.sh detail page. */
    async fetchRemoteSkill(skillPath) {
        const parts = skillPath.split('/');
        if (parts.length < 3)
            return null;
        const source = `${parts[0]}/${parts[1]}`;
        const skillId = parts.slice(2).join('/');
        try {
            const url = `https://skills.sh/${source}/${skillId}`;
            const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
            if (response.ok) {
                const html = await response.text();
                const content = extractSkillContentFromDetailPage(html);
                if (content) {
                    return this.parseRemoteSkillResponse(content, source, skillId);
                }
            }
        }
        catch { /* failed */ }
        return null;
    }
    parseRemoteSkillResponse(content, source, skillId) {
        const { frontmatter } = parseFrontmatter(content);
        const risk = assessRisk(content);
        const name = frontmatter.name || skillId;
        return {
            id: `remote:${source}/${skillId}`,
            name,
            description: frontmatter.description || extractFirstLine(content),
            content,
            filePath: '',
            source: 'remote',
            tool: 'claude',
            category: frontmatter.category || guessCategory(name, content),
            metadata: frontmatter.metadata,
            size: content.length,
            modifiedAt: new Date().toISOString(),
            risk: risk.level,
            riskDetails: risk.details,
            remoteSource: source,
        };
    }
    /** Fetch audited skills list from skills.sh/audits */
    async fetchAuditedSkills() {
        try {
            const response = await fetch('https://skills.sh/audits', {
                signal: AbortSignal.timeout(15000),
            });
            if (!response.ok)
                return [];
            const html = await response.text();
            // Audits page uses double-escaped JSON in RSC payload: \\\"key\\\":\\\"value\\\"
            // Unescape first, then extract with a simple regex
            const unescaped = html.replace(/\\\\"/g, '"').replace(/\\"/g, '"');
            const entryPattern = /\{"rank":\d+,"source":"([^"]+)","skillId":"([^"]+)","name":"([^"]+)"/g;
            const seen = new Set();
            const entries = [];
            let m;
            while ((m = entryPattern.exec(unescaped)) !== null) {
                const key = `${m[1]}/${m[2]}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                entries.push({ source: m[1], skillId: m[2], name: m[3], installs: 0 });
            }
            return entries.slice(0, 100).map(e => ({
                ...remoteEntryToSkillFile(e),
                description: `From ${e.source} · Audited`,
                audited: true,
            }));
        }
        catch {
            return [];
        }
    }
    /**
     * Install a skill via `npx skills add <source>@<skillId> --copy -y`.
     * This uses the official CLI which handles symlinks, updates, and edge cases.
     * Returns { ok, output, error }.
     */
    async installViaCli(source, skillId, projectPath, global = false) {
        const skillRef = `${source}@${skillId}`;
        const args = ['skills', 'add', skillRef, '--copy', '-y'];
        if (global)
            args.push('-g');
        return new Promise((resolve) => {
            const child = (0, child_process_1.execFile)('npx', args, {
                cwd: projectPath,
                timeout: 60000,
                env: { ...process.env, npm_config_yes: 'true' },
                shell: true,
            }, (error, stdout, stderr) => {
                if (error) {
                    resolve({
                        ok: false,
                        output: stdout || '',
                        error: stderr || error.message,
                    });
                }
                else {
                    resolve({
                        ok: true,
                        output: stdout || '',
                    });
                }
            });
            // Safety: kill if still running after timeout
            setTimeout(() => {
                try {
                    child.kill();
                }
                catch { /* already dead */ }
            }, 62000);
        });
    }
    dispose() {
        this.unwatchAll();
    }
}
exports.SkillsManager = SkillsManager;
// ---------------------------------------------------------------------------
// Category-specific templates
// ---------------------------------------------------------------------------
function getCategoryTemplate(slug, name, category) {
    switch (category) {
        case 'audit':
            return `---
name: ${slug}
description: "Security audit skill — checks for vulnerabilities and compliance issues"
---

# ${name}

## Purpose
Perform security audits on the codebase to identify vulnerabilities and compliance gaps.

## Checklist

### OWASP Top 10
- [ ] A01: Broken Access Control
- [ ] A02: Cryptographic Failures
- [ ] A03: Injection (SQL, XSS, Command)
- [ ] A04: Insecure Design
- [ ] A05: Security Misconfiguration
- [ ] A06: Vulnerable and Outdated Components
- [ ] A07: Identification and Authentication Failures
- [ ] A08: Software and Data Integrity Failures
- [ ] A09: Security Logging and Monitoring Failures
- [ ] A10: Server-Side Request Forgery (SSRF)

### Additional Checks
- [ ] Sensitive data exposure in logs or responses
- [ ] API authentication and rate limiting
- [ ] Input validation and sanitization
- [ ] Dependency vulnerabilities (npm audit / snyk)

## Output Format
For each finding, report:
1. **Severity**: Critical / High / Medium / Low
2. **Location**: File path and line number
3. **Description**: What the issue is
4. **Recommendation**: How to fix it
`;
        case 'seo':
            return `---
name: ${slug}
description: "SEO optimization skill — analyzes and improves search engine visibility"
---

# ${name}

## Purpose
Analyze and improve the project's SEO to boost search engine rankings.

## Checklist

### Technical SEO
- [ ] Meta titles (50-60 chars, unique per page)
- [ ] Meta descriptions (150-160 chars, compelling)
- [ ] Canonical URLs on all pages
- [ ] Open Graph tags (og:title, og:description, og:image)
- [ ] Twitter Card meta tags
- [ ] Structured data / JSON-LD schema markup
- [ ] Sitemap.xml exists and is valid
- [ ] Robots.txt properly configured

### Performance
- [ ] Core Web Vitals (LCP < 2.5s, FID < 100ms, CLS < 0.1)
- [ ] Images have alt text and are optimized (WebP/AVIF)
- [ ] Lazy loading for below-the-fold content

### Content
- [ ] H1 tag on every page (exactly one)
- [ ] Heading hierarchy (H1 > H2 > H3, no skips)
- [ ] Internal linking structure
- [ ] 404 page exists with helpful navigation

## Output
Provide a prioritized list of SEO improvements with estimated impact.
`;
        case 'marketing':
            return `---
name: ${slug}
description: "Marketing skill — helps create campaigns, copy, and growth strategies"
---

# ${name}

## Purpose
Assist with marketing tasks including copywriting, campaign planning, and content strategy.

## Capabilities

### Copywriting
- Landing page headlines and CTAs
- Email subject lines and body copy (A/B variants)
- Social media posts (Twitter, LinkedIn, Instagram)
- Ad copy (Google Ads, Facebook Ads)

### Content Strategy
- Blog post outlines and drafts
- Content calendar planning
- Keyword research integration
- Competitor content analysis

### Campaign Planning
- Target audience definition
- Channel selection and budget allocation
- KPI definition and tracking plan
- Launch timeline and milestones

## Guidelines
- Always write for the target audience's pain points
- Include clear calls-to-action
- Use data-driven language when possible
- Maintain brand voice consistency
`;
        case 'testing':
            return `---
name: ${slug}
description: "Testing skill — generates and maintains test suites"
---

# ${name}

## Purpose
Generate comprehensive tests for the codebase.

## Test Types

### Unit Tests
- Test individual functions in isolation
- Mock external dependencies
- Cover edge cases and error paths
- Aim for >80% code coverage on critical paths

### Integration Tests
- Test module interactions
- Use real databases where possible (not mocks)
- Test API endpoints end-to-end
- Verify error handling across boundaries

### E2E Tests
- Test critical user flows
- Use Playwright / Cypress patterns
- Include visual regression checks
- Test on multiple viewports

## Conventions
- Test file naming: \`*.test.ts\` or \`*.spec.ts\`
- Use \`describe\` / \`it\` blocks with clear descriptions
- One assertion per test when possible
- Setup/teardown in beforeEach/afterEach
`;
        case 'design':
            return `---
name: ${slug}
description: "Design skill — UI/UX guidelines and component patterns"
---

# ${name}

## Purpose
Provide design guidance for building consistent, accessible UI components.

## Design Tokens
- Use the project's design system / CSS variables
- Respect light/dark theme tokens
- Follow 4px/8px spacing grid

## Component Guidelines
- Mobile-first responsive design
- Touch targets minimum 44x44px
- Focus states for keyboard navigation
- ARIA labels for accessibility

## Typography
- Hierarchy: heading > subheading > body > caption
- Maximum line length: 65-75 characters
- Consistent font weights and sizes

## Color
- Semantic colors: success, warning, error, info
- Sufficient contrast ratio (WCAG AA: 4.5:1 for text)
- Don't rely on color alone to convey meaning
`;
        case 'devops':
            return `---
name: ${slug}
description: "DevOps skill — deployment, CI/CD, and infrastructure automation"
---

# ${name}

## Purpose
Automate deployment, CI/CD pipelines, and infrastructure management.

## Areas

### CI/CD Pipeline
- Build, test, lint stages
- Automated version bumping
- Release artifact creation
- Deployment triggers (staging → production)

### Docker
- Multi-stage builds for minimal images
- Health checks in Dockerfiles
- Docker Compose for local development
- Image scanning for vulnerabilities

### Infrastructure
- Infrastructure as Code (Terraform / Pulumi)
- Environment variable management
- Secret rotation procedures
- Monitoring and alerting setup

## Safety
- Never commit secrets to version control
- Use environment-specific configurations
- Implement rollback procedures
- Blue/green or canary deployments for zero-downtime
`;
        default:
            return `---
name: ${slug}
description: "Describe what this skill does"
---

# ${name}

Describe the skill's purpose and when it should be triggered.

## Instructions

1. Step one
2. Step two

## Examples

Provide usage examples here.
`;
    }
}
