"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encodeCwdForClaudeSessionDir = encodeCwdForClaudeSessionDir;
exports.findRecentSession = findRecentSession;
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const kimiPaths_1 = require("./kimiPaths");
const HOME = os_1.default.homedir();
/** Cap full-tree scans so a runaway agent dir can't block the IPC handler. */
const MAX_TREE_DEPTH = 4;
const MAX_FILES_SCANNED = 500;
function encodeCwdForClaudeSessionDir(cwd) {
    if (process.platform === 'win32') {
        return cwd.replace(/[\\/]/g, '-').replace(/:/g, '-').replace(/^-+/, '');
    }
    return cwd.replace(/^\//, '').replace(/\//g, '-');
}
async function findRecentSession(cli, cwd) {
    try {
        switch (cli) {
            case 'codex':
                return await findRecentCodexSession();
            case 'claude':
                return await findRecentClaudeSession(cwd);
            case 'opencode':
                return await findRecentOpencodeSession();
            case 'gemini':
                return await findRecentGeminiSession();
            case 'kimi':
                return await findRecentKimiSession(cwd);
            case 'qwen':
                return await findRecentQwenSession();
            case 'aider':
                return await findRecentAiderSession(cwd);
            case 'cline':
                return await findRecentClineSession();
            case 'grok':
                return await findRecentGrokSession(cwd);
            case 'agy':
                return await findRecentAgySession(cwd);
            case 'pi':
                return await findRecentPiSession(cwd);
            case 'amp':
            case 'hermes':
            // Cursor keeps chats on its servers — there is no local session file to
            // find, so history is unavailable rather than merely unimplemented.
            case 'cursor':
                return { ok: false, reason: 'unsupported-cli' };
            default:
                return { ok: false, reason: 'unsupported-cli' };
        }
    }
    catch (err) {
        return { ok: false, reason: 'error', error: err instanceof Error ? err.message : String(err) };
    }
}
async function findRecentCodexSession() {
    const root = path_1.default.join(HOME, '.codex', 'sessions');
    if (!(await pathExists(root)))
        return { ok: false, reason: 'no-sessions-dir' };
    const today = new Date();
    const candidates = [];
    for (let i = 0; i < 3; i++) {
        const d = new Date(today.getTime() - i * 86_400_000);
        const yyyy = String(d.getUTCFullYear());
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        const dir = path_1.default.join(root, yyyy, mm, dd);
        if (!(await pathExists(dir)))
            continue;
        const entries = await promises_1.default.readdir(dir);
        for (const entry of entries) {
            if (entry.startsWith('rollout-') && entry.endsWith('.jsonl')) {
                candidates.push(path_1.default.join(dir, entry));
            }
        }
    }
    const best = await pickNewestPath(candidates);
    return best
        ? { ok: true, path: best, format: 'jsonl' }
        : { ok: false, reason: 'no-recent-session' };
}
async function findRecentClaudeSession(cwd) {
    const root = path_1.default.join(HOME, '.claude', 'projects');
    if (!(await pathExists(root)))
        return { ok: false, reason: 'no-sessions-dir' };
    const encoded = encodeCwdForClaudeSessionDir(cwd);
    const preferredDir = path_1.default.join(root, encoded);
    let dirsToScan = [];
    if (await pathExists(preferredDir)) {
        dirsToScan = [preferredDir];
    }
    else {
        const projectDirs = await promises_1.default.readdir(root, { withFileTypes: true });
        dirsToScan = projectDirs.filter(d => d.isDirectory()).map(d => path_1.default.join(root, d.name));
    }
    const candidates = [];
    for (const dir of dirsToScan) {
        let entries;
        try {
            entries = await promises_1.default.readdir(dir);
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (entry.endsWith('.jsonl'))
                candidates.push(path_1.default.join(dir, entry));
        }
    }
    const best = await pickNewestPath(candidates);
    return best
        ? { ok: true, path: best, format: 'jsonl' }
        : { ok: false, reason: 'no-recent-session' };
}
/**
 * OpenCode storage has evolved across versions:
 *   - Older: ~/.local/share/opencode/storage/session/<projectID>/<sessionID>.json
 *   - Older: ~/.local/share/opencode/storage/message/<sessionID>/<messageID>.json
 *   - Current: ~/.local/share/opencode/storage/session_diff/<sessionID>.json
 *     + ~/.local/share/opencode/opencode.db (SQLite — actual messages)
 *
 * We scan all of these in priority order (deeper first) and surface the
 * newest JSON file. SQLite isn't viewable in the current viewer; we'll point
 * users at the DB if no JSON file is present.
 */
async function findRecentOpencodeSession() {
    const storageRoot = path_1.default.join(HOME, '.local', 'share', 'opencode', 'storage');
    if (!(await pathExists(storageRoot)))
        return { ok: false, reason: 'no-sessions-dir' };
    // Try in order: session (messages), message, session_diff. session_diff
    // files on recent versions are usually empty `[]` because real data lives
    // in SQLite — but we still surface them as a last-resort signal.
    const candidates = [];
    for (const sub of ['session', 'message', 'session_diff']) {
        const dir = path_1.default.join(storageRoot, sub);
        if (!(await pathExists(dir)))
            continue;
        const found = await collectFilesRecursive(dir, '.json', MAX_FILES_SCANNED);
        candidates.push(...found);
    }
    const best = await pickNewestPath(candidates);
    if (best)
        return { ok: true, path: best, format: 'json' };
    return { ok: false, reason: 'no-recent-session' };
}
/**
 * Gemini stores auto sessions in
 *   ~/.gemini/tmp/<project_hash>/chats/<session>.json
 * and manual `/chat save` checkpoints in
 *   ~/.gemini/chats/<tag>.json
 *
 * project_hash is OS-dependent (per the docs); rather than reproduce the
 * formula we scan both trees and take the newest mtime.
 */
async function findRecentGeminiSession() {
    const tmpRoot = path_1.default.join(HOME, '.gemini', 'tmp');
    const manualRoot = path_1.default.join(HOME, '.gemini', 'chats');
    const candidates = [];
    if (await pathExists(tmpRoot)) {
        // ~/.gemini/tmp/<hash>/chats/*.json — descend 2 levels.
        const hashes = await promises_1.default.readdir(tmpRoot, { withFileTypes: true });
        for (const hash of hashes) {
            if (!hash.isDirectory())
                continue;
            const chatsDir = path_1.default.join(tmpRoot, hash.name, 'chats');
            if (!(await pathExists(chatsDir)))
                continue;
            try {
                const entries = await promises_1.default.readdir(chatsDir);
                for (const entry of entries) {
                    if (entry.endsWith('.json'))
                        candidates.push(path_1.default.join(chatsDir, entry));
                }
            }
            catch { /* skip */ }
        }
    }
    if (await pathExists(manualRoot)) {
        try {
            const entries = await promises_1.default.readdir(manualRoot);
            for (const entry of entries) {
                if (entry.endsWith('.json'))
                    candidates.push(path_1.default.join(manualRoot, entry));
            }
        }
        catch { /* skip */ }
    }
    if (candidates.length === 0 && !(await pathExists(path_1.default.join(HOME, '.gemini')))) {
        return { ok: false, reason: 'no-sessions-dir' };
    }
    const best = await pickNewestPath(candidates);
    return best
        ? { ok: true, path: best, format: 'json' }
        : { ok: false, reason: 'no-recent-session' };
}
async function findRecentKimiSession(cwd) {
    const home = (0, kimiPaths_1.getKimiHome)();
    const sessionsRoot = path_1.default.resolve(home, 'sessions');
    if (!(await pathExists(sessionsRoot)))
        return { ok: false, reason: 'no-sessions-dir' };
    const indexed = new Map();
    try {
        const content = await promises_1.default.readFile(path_1.default.join(home, 'session_index.jsonl'), 'utf8');
        for (const line of content.split(/\r?\n/)) {
            if (!line.trim())
                continue;
            try {
                const entry = JSON.parse(line);
                if (typeof entry.sessionId !== 'string')
                    continue;
                if (entry.deleted === true) {
                    indexed.delete(entry.sessionId);
                    continue;
                }
                if (typeof entry.sessionDir !== 'string' || !path_1.default.isAbsolute(entry.sessionDir))
                    continue;
                const sessionDir = path_1.default.resolve(entry.sessionDir);
                const relative = path_1.default.relative(sessionsRoot, sessionDir);
                if (!relative || relative.startsWith('..') || path_1.default.isAbsolute(relative))
                    continue;
                if (path_1.default.basename(sessionDir) !== entry.sessionId)
                    continue;
                indexed.set(entry.sessionId, {
                    sessionDir,
                    workDir: typeof entry.workDir === 'string' ? entry.workDir : '',
                });
            }
            catch {
                // Skip malformed/partial append-only index lines.
            }
        }
    }
    catch {
        return { ok: false, reason: 'no-recent-session' };
    }
    const all = [];
    const matching = [];
    for (const entry of indexed.values()) {
        const wirePath = path_1.default.join(entry.sessionDir, 'agents', 'main', 'wire.jsonl');
        if (!(await pathExists(wirePath)))
            continue;
        all.push(wirePath);
        if (sameProjectPath(entry.workDir, cwd))
            matching.push(wirePath);
    }
    const best = await pickNewestPath(matching.length > 0 ? matching : all);
    return best
        ? { ok: true, path: best, format: 'jsonl' }
        : { ok: false, reason: 'no-recent-session' };
}
/**
 * Qwen stores history at ~/.qwen/history/<project_hash>/<files>. The hash is
 * OS-dependent; we walk the tree and take the newest file.
 */
async function findRecentQwenSession() {
    const root = path_1.default.join(HOME, '.qwen', 'history');
    if (!(await pathExists(root))) {
        // Fallback: some Qwen builds use ~/.qwen/tmp/<hash>/
        const tmp = path_1.default.join(HOME, '.qwen', 'tmp');
        if (!(await pathExists(tmp)))
            return { ok: false, reason: 'no-sessions-dir' };
        const candidates = await collectFilesRecursive(tmp, null, MAX_FILES_SCANNED);
        const best = await pickNewestPath(candidates);
        return best
            ? { ok: true, path: best, format: best.endsWith('.json') ? 'json' : 'jsonl' }
            : { ok: false, reason: 'no-recent-session' };
    }
    const candidates = await collectFilesRecursive(root, null, MAX_FILES_SCANNED);
    const best = await pickNewestPath(candidates);
    if (!best)
        return { ok: false, reason: 'no-recent-session' };
    return {
        ok: true,
        path: best,
        format: best.endsWith('.json') || best.endsWith('.jsonl')
            ? (best.endsWith('.json') ? 'json' : 'jsonl')
            : 'markdown',
    };
}
/**
 * Aider keeps its chat history in <cwd>/.aider.chat.history.md (Markdown).
 * `<cwd>` here is the channel's project root — Aider writes to the cwd where
 * the user ran it. Fallback: ~/.aider.chat.history.md (the user-level repo).
 */
async function findRecentAiderSession(cwd) {
    const local = path_1.default.join(cwd, '.aider.chat.history.md');
    const global = path_1.default.join(HOME, '.aider.chat.history.md');
    if (await pathExists(local))
        return { ok: true, path: local, format: 'markdown' };
    if (await pathExists(global))
        return { ok: true, path: global, format: 'markdown' };
    return { ok: false, reason: 'no-recent-session' };
}
/**
 * Cline CLI stores each session at ~/.cline/data/sessions/<sessionId>/ with
 * `<sessionId>.json` (metadata) and `<sessionId>.messages.json` (the actual
 * conversation). Prefer the newest transcript; fall back to any newest JSON.
 */
async function findRecentClineSession() {
    const root = path_1.default.join(HOME, '.cline', 'data', 'sessions');
    if (!(await pathExists(root)))
        return { ok: false, reason: 'no-sessions-dir' };
    const all = await collectFilesRecursive(root, '.json', MAX_FILES_SCANNED);
    const transcripts = all.filter((p) => p.endsWith('.messages.json'));
    const best = await pickNewestPath(transcripts.length > 0 ? transcripts : all);
    return best
        ? { ok: true, path: best, format: 'json' }
        : { ok: false, reason: 'no-recent-session' };
}
/**
 * Grok records every TUI and headless run locally under
 *   $GROK_HOME/sessions/<url-encoded-cwd>/<session-id>/chat_history.jsonl
 * (default GROK_HOME: ~/.grok). Long cwd names use a slug/hash directory with
 * the original cwd in a sibling `.cwd` file, so project matching must cover
 * both layouts. This is session storage; it is independent from the detected
 * grok.exe path in the CLI registry.
 */
/**
 * Pi writes one append-only JSONL per session under
 *   $PI_CODING_AGENT_DIR/sessions/<encoded-cwd>/<iso-timestamp>_<uuid>.jsonl
 * (default agent dir ~/.pi/agent; PI_CODING_AGENT_SESSION_DIR replaces the
 * sessions tree wholesale). The directory name is pi's own sanitized cwd, but
 * project matching reads the `cwd` field out of each file's session HEADER
 * instead of reimplementing that encoding — the header is authoritative and
 * survives any change to how pi names directories.
 */
async function findRecentPiSession(cwd) {
    const sessionDirOverride = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
    const agentDir = process.env.PI_CODING_AGENT_DIR?.trim()
        ? path_1.default.resolve(process.env.PI_CODING_AGENT_DIR.trim())
        : path_1.default.join(HOME, '.pi', 'agent');
    const root = sessionDirOverride ? path_1.default.resolve(sessionDirOverride) : path_1.default.join(agentDir, 'sessions');
    if (!(await pathExists(root)))
        return { ok: false, reason: 'no-sessions-dir' };
    const files = await collectFilesRecursive(root, '.jsonl', MAX_FILES_SCANNED);
    if (files.length === 0)
        return { ok: false, reason: 'no-recent-session' };
    const withMtime = await Promise.all(files.map(async (file) => {
        try {
            return { file, mtimeMs: (await promises_1.default.stat(file)).mtimeMs };
        }
        catch {
            return null;
        }
    }));
    const sorted = withMtime
        .filter((entry) => entry !== null)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    // Newest file whose header cwd is this project wins. Exact matching stops an
    // unrelated concurrent pi run in another project from stealing the click.
    for (const { file } of sorted) {
        if (sameProjectPath(await readPiSessionHeaderCwd(file), cwd)) {
            return { ok: true, path: file, format: 'jsonl' };
        }
    }
    return { ok: false, reason: 'no-recent-session' };
}
/** Read only the first line of a pi session file — its `{type:'session', cwd}` header. */
async function readPiSessionHeaderCwd(file) {
    let handle;
    try {
        handle = await promises_1.default.open(file, 'r');
        const buffer = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0];
        const header = JSON.parse(firstLine);
        if (header.type !== 'session' || typeof header.cwd !== 'string')
            return '';
        return header.cwd;
    }
    catch {
        // Unreadable, truncated, or not a pi session file.
        return '';
    }
    finally {
        await handle?.close().catch(() => { });
    }
}
async function findRecentGrokSession(cwd) {
    const grokHome = process.env.GROK_HOME
        ? path_1.default.resolve(process.env.GROK_HOME)
        : path_1.default.join(os_1.default.homedir(), '.grok');
    const root = path_1.default.join(grokHome, 'sessions');
    if (!(await pathExists(root)))
        return { ok: false, reason: 'no-sessions-dir' };
    let entries;
    try {
        entries = await promises_1.default.readdir(root, { withFileTypes: true });
    }
    catch {
        return { ok: false, reason: 'no-sessions-dir' };
    }
    const projectDirs = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path_1.default.join(root, entry.name));
    const matchingProjectDirs = [];
    for (const projectDir of projectDirs) {
        const encodedName = path_1.default.basename(projectDir);
        let recordedCwd = '';
        try {
            recordedCwd = decodeURIComponent(encodedName);
        }
        catch {
            // A hashed directory name is not necessarily URL-decodable as a cwd.
        }
        if (!sameProjectPath(recordedCwd, cwd)) {
            try {
                recordedCwd = (await promises_1.default.readFile(path_1.default.join(projectDir, '.cwd'), 'utf8')).trim();
            }
            catch {
                // Normal URL-encoded directories have no .cwd file.
            }
        }
        if (sameProjectPath(recordedCwd, cwd))
            matchingProjectDirs.push(projectDir);
    }
    // Exact project matching prevents an unrelated concurrent Grok run from
    // stealing the click target. Fall back to all projects for older/variant
    // layouts whose directory name cannot be decoded.
    const dirsToScan = matchingProjectDirs.length > 0 ? matchingProjectDirs : projectDirs;
    const candidates = [];
    for (const projectDir of dirsToScan) {
        let sessionDirs;
        try {
            sessionDirs = await promises_1.default.readdir(projectDir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const sessionDir of sessionDirs) {
            if (!sessionDir.isDirectory() || !looksLikeSessionUuid(sessionDir.name))
                continue;
            const historyPath = path_1.default.join(projectDir, sessionDir.name, 'chat_history.jsonl');
            if (await pathExists(historyPath))
                candidates.push(historyPath);
        }
    }
    const best = await pickNewestPath(candidates);
    return best
        ? { ok: true, path: best, format: 'jsonl' }
        : { ok: false, reason: 'no-recent-session' };
}
/**
 * Antigravity CLI stores renderable event transcripts in its brain tree.
 * Prefer conversations mapped to the current workspace, then fall back to the
 * newest transcript across all roots for older data without the cache map.
 */
async function findRecentAgySession(cwd) {
    const roots = [...new Set([
            process.env.ANTIGRAVITY_DATA_DIR,
            process.env.AGY_DATA_DIR,
            path_1.default.join(HOME, '.gemini', 'antigravity-cli'),
            path_1.default.join(HOME, '.gemini', 'antigravity'),
        ].filter((root) => Boolean(root)).map((root) => path_1.default.resolve(root)))];
    const allCandidates = [];
    const matchingCandidates = [];
    let foundRoot = false;
    for (const root of roots) {
        const brainRoot = path_1.default.join(root, 'brain');
        if (!(await pathExists(brainRoot)))
            continue;
        foundRoot = true;
        let workspaceBySession = {};
        try {
            const byWorkspace = JSON.parse(await promises_1.default.readFile(path_1.default.join(root, 'cache', 'last_conversations.json'), 'utf8'));
            for (const [workspacePath, sessionId] of Object.entries(byWorkspace)) {
                if (typeof sessionId === 'string')
                    workspaceBySession[sessionId] = workspacePath;
            }
        }
        catch {
            // The workspace map is best-effort; transcripts are still usable.
        }
        let sessions;
        try {
            sessions = await promises_1.default.readdir(brainRoot, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const session of sessions) {
            if (!session.isDirectory())
                continue;
            const logsDir = path_1.default.join(brainRoot, session.name, '.system_generated', 'logs');
            const full = path_1.default.join(logsDir, 'transcript_full.jsonl');
            const compact = path_1.default.join(logsDir, 'transcript.jsonl');
            const transcript = await pathExists(full) ? full : await pathExists(compact) ? compact : null;
            if (!transcript)
                continue;
            allCandidates.push(transcript);
            if (sameProjectPath(workspaceBySession[session.name] || '', cwd))
                matchingCandidates.push(transcript);
        }
    }
    const best = await pickNewestPath(matchingCandidates.length > 0 ? matchingCandidates : allCandidates);
    if (best)
        return { ok: true, path: best, format: 'jsonl' };
    return { ok: false, reason: foundRoot ? 'no-recent-session' : 'no-sessions-dir' };
}
// ── helpers ──────────────────────────────────────────────────────────────
function looksLikeSessionUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
function sameProjectPath(left, right) {
    if (!left || !right)
        return false;
    const normalize = (value) => value
        .trim()
        .replace(/\\/g, '/')
        .replace(/\/+$/, '');
    const normalizedLeft = normalize(left);
    const normalizedRight = normalize(right);
    return process.platform === 'win32'
        ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
        : normalizedLeft === normalizedRight;
}
async function pathExists(p) {
    try {
        await promises_1.default.access(p);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Pick the newest path by mtime. Returns null if the candidate list is empty
 * or every candidate failed to stat.
 */
async function pickNewestPath(candidates) {
    let bestPath = null;
    let bestMtime = -Infinity;
    for (const p of candidates) {
        try {
            const stat = await promises_1.default.stat(p);
            if (stat.mtimeMs > bestMtime) {
                bestMtime = stat.mtimeMs;
                bestPath = p;
            }
        }
        catch { /* ignore */ }
    }
    return bestPath;
}
/**
 * Walk a directory tree and collect file paths matching `extension` (or any
 * file when extension is null). Capped at MAX_TREE_DEPTH depth and
 * `maxFiles` total. Used by opencode/qwen which use nested project-hash dirs.
 */
async function collectFilesRecursive(root, extension, maxFiles) {
    const out = [];
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length > 0 && out.length < maxFiles) {
        const { dir, depth } = stack.pop();
        if (depth > MAX_TREE_DEPTH)
            continue;
        let entries;
        try {
            entries = await promises_1.default.readdir(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (out.length >= maxFiles)
                break;
            const fullPath = path_1.default.join(dir, entry.name);
            if (entry.isDirectory()) {
                stack.push({ dir: fullPath, depth: depth + 1 });
            }
            else if (entry.isFile()) {
                if (!extension || entry.name.endsWith(extension)) {
                    out.push(fullPath);
                }
            }
        }
    }
    return out;
}
