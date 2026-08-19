"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryManager = void 0;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const agentPaths_1 = require("./agentPaths");
const hermesPaths_1 = require("./hermesPaths");
const PREVIEW_CHARS = 240;
const SCAN_CACHE_TTL = 30_000;
class MemoryManager {
    cache = null;
    isWindows = process.platform === 'win32';
    getOverrides;
    constructor(getOverrides = () => ({})) {
        this.getOverrides = getOverrides;
    }
    agentRoots() {
        const overrides = this.getOverrides();
        return [
            { agentType: 'claude', projectsRoot: path_1.default.join((0, agentPaths_1.getAgentRoot)('claude', overrides), 'projects') },
        ];
    }
    clearCache() {
        this.cache = null;
    }
    async scanProjects() {
        const cache = await this.ensureScan();
        return cache.projects;
    }
    async scanEntries(params) {
        const cache = await this.ensureScan();
        let entries = cache.entries;
        if (params.agentType) {
            entries = entries.filter((e) => e.agentType === params.agentType);
        }
        if (params.projectPath) {
            const target = this.normalizePath(params.projectPath);
            entries = entries.filter((e) => this.normalizePath(e.projectPath) === target);
        }
        if (params.query) {
            const q = params.query.toLowerCase();
            entries = entries.filter((e) => e.fileName.toLowerCase().includes(q) ||
                (e.name?.toLowerCase().includes(q) ?? false) ||
                (e.description?.toLowerCase().includes(q) ?? false) ||
                (e.preview?.toLowerCase().includes(q) ?? false));
        }
        entries = [...entries].sort((a, b) => b.modifiedAt - a.modifiedAt);
        return { entries, total: entries.length };
    }
    async readEntry(filePath) {
        try {
            const stat = await fs_1.promises.stat(filePath);
            if (!stat.isFile())
                return null;
            const content = await fs_1.promises.readFile(filePath, 'utf-8');
            const meta = await this.locateEntryMeta(filePath, content, stat.mtimeMs, stat.size);
            if (!meta)
                return null;
            return { ...meta, content };
        }
        catch {
            return null;
        }
    }
    async deleteEntry(filePath) {
        if (!this.isInsideAnyAgentRoot(filePath))
            return false;
        try {
            await fs_1.promises.unlink(filePath);
            this.clearCache();
            return true;
        }
        catch {
            return false;
        }
    }
    async writeEntry(filePath, content) {
        if (!this.isInsideAnyAgentRoot(filePath))
            return false;
        try {
            await fs_1.promises.mkdir(path_1.default.dirname(filePath), { recursive: true });
            await fs_1.promises.writeFile(filePath, content, 'utf-8');
            this.clearCache();
            return true;
        }
        catch {
            return false;
        }
    }
    async createEntry(args) {
        const safeName = sanitizeFileName(args.fileName);
        if (!safeName)
            return { ok: false, error: 'Invalid file name' };
        if (args.agentType === 'hermes' && !isHermesMemoryFile(safeName)) {
            return { ok: false, error: 'Hermes memory files must be named MEMORY.md or USER.md' };
        }
        const memoryDir = this.getTargetMemoryDirectory(args.agentType, args.encodedDirName);
        if (!memoryDir)
            return { ok: false, error: 'Unsupported agent type' };
        const filePath = path_1.default.join(memoryDir, safeName);
        try {
            await fs_1.promises.mkdir(memoryDir, { recursive: true });
            try {
                await fs_1.promises.access(filePath);
                return { ok: false, error: 'File already exists' };
            }
            catch {
                // file does not exist — proceed
            }
            await fs_1.promises.writeFile(filePath, args.content, 'utf-8');
            this.clearCache();
            return { ok: true, filePath };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : 'Write failed' };
        }
    }
    async copyEntry(args) {
        if (!this.isInsideAnyAgentRoot(args.sourceFilePath)) {
            return { ok: false, error: 'Source is outside agent memory roots' };
        }
        const targetDir = this.getTargetMemoryDirectory(args.targetAgentType, args.targetEncodedDirName);
        if (!targetDir)
            return { ok: false, error: 'Unsupported target agent' };
        const requestedName = args.targetAgentType === 'hermes'
            ? args.fileName ?? 'MEMORY.md'
            : args.fileName ?? path_1.default.basename(args.sourceFilePath);
        const fileName = sanitizeFileName(requestedName);
        if (!fileName)
            return { ok: false, error: 'Invalid file name' };
        if (args.targetAgentType === 'hermes' && !isHermesMemoryFile(fileName)) {
            return { ok: false, error: 'Hermes memory files must be named MEMORY.md or USER.md' };
        }
        const targetFile = path_1.default.join(targetDir, fileName);
        if (path_1.default.resolve(targetFile) === path_1.default.resolve(args.sourceFilePath)) {
            return { ok: false, error: 'Source and target are the same file' };
        }
        try {
            const content = await fs_1.promises.readFile(args.sourceFilePath, 'utf-8');
            await fs_1.promises.mkdir(targetDir, { recursive: true });
            if (!args.overwrite) {
                try {
                    await fs_1.promises.access(targetFile);
                    return { ok: false, error: 'Target already exists' };
                }
                catch {
                    // does not exist — proceed
                }
            }
            await fs_1.promises.writeFile(targetFile, content, 'utf-8');
            this.clearCache();
            return { ok: true, filePath: targetFile };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : 'Copy failed' };
        }
    }
    async appendToGlobalClaude(args) {
        const filePath = path_1.default.join((0, agentPaths_1.getAgentRoot)('claude', this.getOverrides()), 'CLAUDE.md');
        try {
            await fs_1.promises.mkdir(path_1.default.dirname(filePath), { recursive: true });
            let existing = '';
            try {
                existing = await fs_1.promises.readFile(filePath, 'utf-8');
            }
            catch {
                // file may not exist yet
            }
            const stripped = stripFrontmatter(args.content).trim();
            const block = `\n\n## ${args.title}\n\n${stripped}\n`;
            const next = existing.endsWith('\n') || existing.length === 0 ? existing + block.trimStart() : existing + block;
            await fs_1.promises.writeFile(filePath, next, 'utf-8');
            return { ok: true, filePath };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : 'Append failed' };
        }
    }
    async getGraph(projectPath) {
        const cache = await this.ensureScan();
        const filtered = projectPath
            ? cache.entries.filter((e) => this.normalizePath(e.projectPath) === this.normalizePath(projectPath))
            : cache.entries;
        const nodes = filtered.map((e) => ({
            id: e.id,
            label: e.name || e.fileName.replace(/\.md$/i, ''),
            fileName: e.fileName,
            projectName: e.projectName,
            projectPath: e.projectPath,
            type: e.type,
            isIndex: e.isIndex,
            filePath: e.filePath,
        }));
        // Build a per-project lookup: fileName.toLowerCase() → entry id
        const entryByPathAndName = new Map();
        for (const e of filtered) {
            entryByPathAndName.set(`${this.normalizePath(e.projectPath)}::${e.fileName.toLowerCase()}`, e);
        }
        const edges = [];
        const linkRegex = /\[[^\]]*\]\(([^)#?]+\.md)(?:[#?][^)]*)?\)/gi;
        for (const e of filtered) {
            const detail = await this.readEntryRaw(e.filePath);
            if (!detail)
                continue;
            const seen = new Set();
            let m;
            while ((m = linkRegex.exec(detail)) !== null) {
                const target = m[1].trim().split(/[\\/]/).pop()?.toLowerCase();
                if (!target)
                    continue;
                const key = `${this.normalizePath(e.projectPath)}::${target}`;
                const targetEntry = entryByPathAndName.get(key);
                if (!targetEntry || targetEntry.id === e.id)
                    continue;
                const edgeKey = `${e.id}->${targetEntry.id}`;
                if (seen.has(edgeKey))
                    continue;
                seen.add(edgeKey);
                edges.push({
                    source: e.id,
                    target: targetEntry.id,
                    kind: e.isIndex ? 'index' : 'reference',
                });
            }
        }
        return { nodes, edges };
    }
    getProjectMemoryDirectory(project) {
        return this.getTargetMemoryDirectory(project.agentType, project.encodedDirName);
    }
    // ─── Internals ───────────────────────────────────────────────────────
    async ensureScan() {
        if (this.cache && Date.now() - this.cache.timestamp < SCAN_CACHE_TTL) {
            return this.cache;
        }
        const projects = [];
        const entries = [];
        for (const root of this.agentRoots()) {
            let projectDirs = [];
            try {
                const dirents = await fs_1.promises.readdir(root.projectsRoot, { withFileTypes: true });
                projectDirs = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
            }
            catch {
                continue;
            }
            for (const encoded of projectDirs) {
                const memoryDir = path_1.default.join(root.projectsRoot, encoded, 'memory');
                let memDirents;
                try {
                    memDirents = await fs_1.promises.readdir(memoryDir, { withFileTypes: true });
                }
                catch {
                    continue;
                }
                const mdFiles = memDirents
                    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.md'))
                    .map((d) => d.name);
                if (mdFiles.length === 0)
                    continue;
                const projectPath = await this.decodeProjectPath(encoded);
                const projectName = this.basename(projectPath);
                let lastModifiedAt = 0;
                const projectEntries = [];
                for (const fileName of mdFiles) {
                    const filePath = path_1.default.join(memoryDir, fileName);
                    const entry = await this.readEntryShallow(root.agentType, projectPath, projectName, filePath, fileName);
                    if (!entry)
                        continue;
                    projectEntries.push(entry);
                    if (entry.modifiedAt > lastModifiedAt)
                        lastModifiedAt = entry.modifiedAt;
                }
                if (projectEntries.length === 0)
                    continue;
                entries.push(...projectEntries);
                projects.push({
                    agentType: root.agentType,
                    projectPath,
                    projectName,
                    encodedDirName: encoded,
                    entryCount: projectEntries.length,
                    lastModifiedAt,
                });
            }
        }
        await this.scanHermesMemory(projects, entries);
        projects.sort((a, b) => b.lastModifiedAt - a.lastModifiedAt);
        this.cache = { projects, entries, timestamp: Date.now() };
        return this.cache;
    }
    async readEntryShallow(agentType, projectPath, projectName, filePath, fileName) {
        let stat;
        try {
            stat = await fs_1.promises.stat(filePath);
        }
        catch {
            return null;
        }
        let content = '';
        try {
            content = await fs_1.promises.readFile(filePath, 'utf-8');
        }
        catch {
            return null;
        }
        return this.buildEntry(agentType, projectPath, projectName, filePath, fileName, content, stat.mtimeMs, stat.size);
    }
    async locateEntryMeta(filePath, content, mtimeMs, size) {
        const hermesMemoryDir = path_1.default.resolve((0, hermesPaths_1.getHermesMemoryDirectory)());
        const fileResolved = path_1.default.resolve(filePath);
        if (path_1.default.dirname(fileResolved) === hermesMemoryDir && isHermesMemoryFile(path_1.default.basename(fileResolved))) {
            return this.buildEntry('hermes', (0, hermesPaths_1.getHermesHome)(), 'Hermes Global', filePath, path_1.default.basename(fileResolved), content, mtimeMs, size);
        }
        for (const root of this.agentRoots()) {
            const rootResolved = path_1.default.resolve(root.projectsRoot);
            if (!fileResolved.startsWith(rootResolved + path_1.default.sep))
                continue;
            const rel = path_1.default.relative(rootResolved, fileResolved);
            const segments = rel.split(path_1.default.sep);
            // Expected layout: <encodedProject>/memory/<file>.md
            if (segments.length < 3 || segments[1] !== 'memory')
                continue;
            const encoded = segments[0];
            const fileName = segments[segments.length - 1];
            const projectPath = await this.decodeProjectPath(encoded);
            const projectName = this.basename(projectPath);
            return this.buildEntry(root.agentType, projectPath, projectName, filePath, fileName, content, mtimeMs, size);
        }
        return null;
    }
    buildEntry(agentType, projectPath, projectName, filePath, fileName, content, mtimeMs, size) {
        const { frontmatter, body } = parseFrontmatter(content);
        const isIndex = fileName.toUpperCase() === 'MEMORY.MD';
        const preview = body.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
        return {
            id: `${agentType}:${filePath}`,
            agentType,
            projectPath,
            projectName,
            fileName,
            filePath,
            isIndex,
            size,
            modifiedAt: Math.floor(mtimeMs),
            name: frontmatter.name,
            description: frontmatter.description,
            type: frontmatter.type,
            preview: preview || undefined,
        };
    }
    basename(p) {
        return p.split(/[\\/]/).filter(Boolean).pop() || p;
    }
    isInsideAnyAgentRoot(filePath) {
        const fileResolved = path_1.default.resolve(filePath);
        const hermesMemoryDir = path_1.default.resolve((0, hermesPaths_1.getHermesMemoryDirectory)());
        if (fileResolved.startsWith(hermesMemoryDir + path_1.default.sep))
            return true;
        return this.agentRoots().some((root) => {
            const rootResolved = path_1.default.resolve(root.projectsRoot);
            return fileResolved.startsWith(rootResolved + path_1.default.sep);
        });
    }
    async readEntryRaw(filePath) {
        try {
            return await fs_1.promises.readFile(filePath, 'utf-8');
        }
        catch {
            return null;
        }
    }
    getTargetMemoryDirectory(agentType, encodedDirName) {
        if (agentType === 'hermes')
            return (0, hermesPaths_1.getHermesMemoryDirectory)();
        const root = this.agentRoots().find((candidate) => candidate.agentType === agentType);
        return root ? path_1.default.join(root.projectsRoot, encodedDirName, 'memory') : null;
    }
    async scanHermesMemory(projects, entries) {
        const hermesHome = (0, hermesPaths_1.getHermesHome)();
        try {
            const stat = await fs_1.promises.stat(hermesHome);
            if (!stat.isDirectory())
                return;
        }
        catch {
            return;
        }
        const memoryDir = (0, hermesPaths_1.getHermesMemoryDirectory)();
        let mdFiles = [];
        try {
            const dirents = await fs_1.promises.readdir(memoryDir, { withFileTypes: true });
            mdFiles = dirents
                .filter((entry) => entry.isFile() && isHermesMemoryFile(entry.name))
                .map((entry) => entry.name);
        }
        catch {
            // Keep the synthetic project visible so the app can create MEMORY.md.
        }
        const projectEntries = [];
        let lastModifiedAt = 0;
        for (const fileName of mdFiles) {
            const entry = await this.readEntryShallow('hermes', hermesHome, 'Hermes Global', path_1.default.join(memoryDir, fileName), fileName);
            if (!entry)
                continue;
            projectEntries.push(entry);
            if (entry.modifiedAt > lastModifiedAt)
                lastModifiedAt = entry.modifiedAt;
        }
        entries.push(...projectEntries);
        projects.push({
            agentType: 'hermes',
            projectPath: hermesHome,
            projectName: 'Hermes Global',
            encodedDirName: 'global',
            entryCount: projectEntries.length,
            lastModifiedAt,
        });
    }
    normalizePath(p) {
        let n = p.replace(/[\\/]+$/, '').replace(/\\/g, '/');
        if (this.isWindows)
            n = n.toLowerCase();
        return n;
    }
    /**
     * Decode a Claude-style project directory name back to the original absolute path.
     * Mirrors ResumeManager.decodeClaudeProjectPath: tries longest segment matches
     * to handle dashes that appear inside real folder names.
     */
    async decodeProjectPath(encodedDirName) {
        const raw = encodedDirName.replace(/^-/, '');
        const segments = raw.split('-');
        let currentPath;
        let i;
        if (this.isWindows && segments.length > 1 && /^[a-zA-Z]$/.test(segments[0])) {
            currentPath = segments[0].toUpperCase() + ':\\';
            i = 1;
        }
        else {
            currentPath = '/';
            i = 0;
        }
        while (i < segments.length) {
            let matched = false;
            for (let j = segments.length; j > i; j--) {
                const candidate = segments.slice(i, j).join('-');
                const fullPath = path_1.default.join(currentPath, candidate);
                try {
                    const stat = await fs_1.promises.stat(fullPath);
                    if (j === segments.length || stat.isDirectory()) {
                        currentPath = fullPath;
                        i = j;
                        matched = true;
                        break;
                    }
                }
                catch {
                    // try shorter
                }
            }
            if (!matched) {
                currentPath = path_1.default.join(currentPath, segments[i]);
                i++;
            }
        }
        return currentPath;
    }
}
exports.MemoryManager = MemoryManager;
function stripFrontmatter(content) {
    return parseFrontmatter(content).body;
}
function sanitizeFileName(input) {
    let name = input.trim().replace(/[\\/]+/g, '-').replace(/[\u0000-\u001f<>:"|?*]/g, '');
    if (!name)
        return '';
    if (!/\.md$/i.test(name))
        name += '.md';
    return name;
}
function isHermesMemoryFile(fileName) {
    const normalized = fileName.toUpperCase();
    return normalized === 'MEMORY.MD' || normalized === 'USER.MD';
}
function parseFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match)
        return { frontmatter: {}, body: content };
    const raw = match[1];
    const body = match[2] || '';
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
        else if (key === 'type')
            frontmatter.type = value;
    }
    return { frontmatter, body };
}
