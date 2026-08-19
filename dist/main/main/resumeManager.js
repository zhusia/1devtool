"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResumeManager = void 0;
/**
 * Terminal session persistence hotspot. Read
 * docs/common-errors/terminals/INDEX.md before changing discovery, parsing,
 * title, or resume-command behavior.
 */
const fs_1 = require("fs");
const crypto_1 = require("crypto");
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const contracts_1 = require("../shared/terminal/contracts");
const agentPaths_1 = require("./agentPaths");
const hermesPaths_1 = require("./hermesPaths");
const kimiPaths_1 = require("./kimiPaths");
const resumeSessionSelect_1 = require("./resumeSessionSelect");
/** Agent types whose sessions can be detected from the filesystem. */
const DETECTABLE_AGENT_TYPES = new Set([
    'claude',
    'codex',
    'gemini',
    'kimi',
    'agy',
    'qwen',
    'opencode',
    'cline',
    'grok',
    'hermes',
    'cursor',
    'pi',
]);
/**
 * How long a detection scan result may be shared across terminals. Detection
 * attempts are spaced 500ms–5min apart, so a slightly stale candidate list
 * only delays a hit to the next attempt — it can never produce a wrong match.
 */
const DETECT_SCAN_TTL_MS = 20_000;
// Recent Codex builds persist large AGENTS/environment preambles before the
// first real user message. 32KB stops inside that preamble, producing empty
// prompts and "0 turns" in the resume list.
const CODEX_ROLLOUT_HEAD_BYTES = 256 * 1024;
const KIMI_WIRE_WINDOW_BYTES = 256 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,511}$/;
const MAX_SESSION_TITLE_LENGTH = 500;
class ResumeManager {
    cache = null;
    db = null;
    CACHE_TTL = 30_000; // 30 seconds
    isWindows = process.platform === 'win32';
    getOverrides;
    // Cached "the opencode db doesn't exist" verdict — opening a non-existent
    // SQLite file otherwise costs an fs stat on every cache miss for users
    // who don't run opencode. Re-checked once per CACHE_TTL.
    opencodeDbAbsentUntil = 0;
    hermesDbAbsentUntil = 0;
    constructor(getOverrides = () => ({})) {
        this.getOverrides = getOverrides;
    }
    // Claim mechanism: prevents two terminals from binding to the same session
    // Key: "agentType:sessionId", Value: terminalId
    claimedSessionIds = new Map();
    // Detection-scan sharing: TTL cache + in-flight dedupe per agent type so
    // concurrent/lifetime detection attempts cost one sweep, not one per terminal.
    detectScanCache = new Map();
    detectScanInflight = new Map();
    /** Normalize a path for comparison: lowercase on Windows, forward slashes, strip trailing separators */
    normalizePath(p) {
        let normalized = p.replace(/[\\/]+$/, '').replace(/\\/g, '/');
        if (this.isWindows) {
            normalized = normalized.toLowerCase();
        }
        return normalized;
    }
    /** Extract the last segment (folder name) from a path, handling both / and \ separators */
    folderName(p) {
        return p.split(/[\\/]/).filter(Boolean).pop() || p;
    }
    /**
     * Clear all session claims. Called on window-all-closed and window re-creation
     * to ensure each close/reopen cycle starts fresh.
     */
    clearClaims() {
        this.claimedSessionIds.clear();
    }
    /**
     * Seed the claim registry with already-known terminal↔session bindings so a
     * later detection pass (especially the relaxed one) can't steal a session
     * that another terminal already owns. Existing claims are never overwritten.
     */
    seedClaims(entries) {
        for (const entry of entries) {
            const key = `${entry.agentType}:${entry.sessionId}`;
            if (!this.claimedSessionIds.has(key)) {
                this.claimedSessionIds.set(key, entry.terminalId);
            }
        }
    }
    /**
     * Replace one terminal's heuristic/persisted claim with a session reported
     * by that terminal's process-attributed native hook. Refuse to steal a live
     * claim owned by another terminal.
     */
    replaceClaimForTerminal(entry) {
        const nextKey = `${entry.agentType}:${entry.sessionId}`;
        const nextOwner = this.claimedSessionIds.get(nextKey);
        if (nextOwner && nextOwner !== entry.terminalId)
            return false;
        if (entry.previousAgentType && entry.previousSessionId) {
            const previousKey = `${entry.previousAgentType}:${entry.previousSessionId}`;
            if (previousKey !== nextKey &&
                this.claimedSessionIds.get(previousKey) === entry.terminalId) {
                this.claimedSessionIds.delete(previousKey);
            }
        }
        this.claimedSessionIds.set(nextKey, entry.terminalId);
        return true;
    }
    /**
     * Detect the most likely session for a specific terminal launch.
     *
     * Two passes (see resumeSessionSelect.ts): strict — a session that STARTED
     * after the PTY spawned; relaxed — an older session actively WRITTEN since
     * the PTY spawned (user resumed an old conversation inside the terminal).
     * Both only need files with mtime >= startedAfter - grace, so the scan
     * stat-gates candidates before parsing and is shared/TTL-cached across
     * concurrent attempts from multiple terminals.
     * Claims atomically; returns null if no matching unclaimed session found.
     */
    async detectSessionForTerminal(terminalId, agentType, projectPath, startedAfter, lastSubmitAt, submittedPrompts = []) {
        console.log(`[session-detect] detectSessionForTerminal: agent=${agentType}, path=${projectPath}, startedAfter=${startedAfter}, lastSubmitAt=${lastSubmitAt ?? 'none'}, submittedPrompts=${submittedPrompts.length}`);
        if (!DETECTABLE_AGENT_TYPES.has(agentType))
            return null;
        const minMtime = startedAfter - resumeSessionSelect_1.DETECT_TIME_GRACE_MS;
        let sessions = await this.scanSessionsForDetection(agentType, minMtime);
        if (agentType === 'codex') {
            // Skip history-only sessions (no cwd/projectPath) — can't attribute to a project
            sessions = sessions.filter(s => s.cwd || s.projectPath);
        }
        if (agentType === 'opencode') {
            // Skip zero-message draft rows (OpenCode can create a session row at TUI
            // launch before the user prompts — a resumed terminal must not re-bind
            // to its own empty draft) and subagent child sessions.
            sessions = sessions.filter(s => s.messageCount > 0 && !s.parentId);
        }
        console.log(`[session-detect] after scan: ${sessions.length} candidates for ${agentType} (mtime>=${minMtime})`);
        // For Gemini: resolve project name from ~/.gemini/projects.json
        const geminiName = agentType === 'gemini' && projectPath
            ? await this.resolveGeminiProjectName(projectPath.replace(/[\\/]+$/, ''))
            : null;
        const result = (0, resumeSessionSelect_1.selectSessionForTerminal)({
            terminalId,
            agentType,
            projectPath,
            startedAfter,
            sessions,
            claims: this.claimedSessionIds,
            isWindows: this.isWindows,
            geminiProjectName: geminiName,
            lastSubmitAt,
            submittedPrompts,
        });
        if (!result) {
            console.log(`[session-detect] NO match found`);
            return null;
        }
        console.log(`[session-detect] FOUND (${result.pass}): id=${result.session.id.slice(0, 12)}, prompt=${result.session.firstPrompt?.slice(0, 30)}`);
        return {
            sessionId: result.session.id,
            firstPrompt: result.session.firstPrompt || '',
            sessionName: result.session.sessionName || undefined,
        };
    }
    /**
     * Scan sessions for detection, parsing only files whose mtime is fresh
     * enough to matter (a detectable session must have been written since the
     * PTY spawned). Results are shared across terminals via a short TTL cache
     * plus in-flight dedupe, so N terminals detecting concurrently — or the
     * lifetime output-driven retries — cost one directory sweep, not N.
     */
    async scanSessionsForDetection(agentType, minMtime) {
        const cached = this.detectScanCache.get(agentType);
        if (cached && cached.minMtime <= minMtime && Date.now() - cached.scannedAt < DETECT_SCAN_TTL_MS) {
            return cached.sessions;
        }
        const inflight = this.detectScanInflight.get(agentType);
        if (inflight && inflight.minMtime <= minMtime) {
            return inflight.promise;
        }
        const promise = this.runDetectionScan(agentType, minMtime);
        this.detectScanInflight.set(agentType, { minMtime, promise });
        try {
            const sessions = await promise;
            this.detectScanCache.set(agentType, { minMtime, scannedAt: Date.now(), sessions });
            return sessions;
        }
        finally {
            if (this.detectScanInflight.get(agentType)?.promise === promise) {
                this.detectScanInflight.delete(agentType);
            }
        }
    }
    async runDetectionScan(agentType, minMtime) {
        const candidates = [];
        switch (agentType) {
            case 'claude':
                await this.collectClaudeCandidates(candidates);
                break;
            case 'codex':
                await this.collectCodexCandidates(candidates);
                break;
            case 'gemini':
                await this.collectGeminiCandidates(candidates);
                break;
            case 'kimi':
                await this.collectKimiCandidates(candidates);
                break;
            case 'agy':
                await this.collectAgyCandidates(candidates);
                break;
            case 'qwen':
                await this.collectQwenCandidates(candidates);
                break;
            case 'opencode':
                await this.collectOpencodeCandidates(candidates);
                break;
            case 'cline':
                await this.collectClineCandidates(candidates);
                break;
            case 'grok':
                await this.collectGrokCandidates(candidates);
                break;
            case 'hermes':
                await this.collectHermesCandidates(candidates);
                break;
            case 'cursor':
                await this.collectCursorCandidates(candidates);
                break;
            case 'pi':
                await this.collectPiCandidates(candidates);
                break;
            default:
                return [];
        }
        const sessions = [];
        await Promise.allSettled(candidates
            .filter((c) => c.mtimeMs >= minMtime)
            .map(async (candidate) => {
            try {
                const session = await candidate.parse();
                if (session)
                    sessions.push(session);
            }
            catch {
                // Skip unparseable files
            }
        }));
        return sessions;
    }
    /** Resolve absolute path to Gemini project name via ~/.gemini/projects.json */
    async resolveGeminiProjectName(absolutePath) {
        try {
            const mappingFile = path_1.default.join((0, agentPaths_1.getAgentRoot)('gemini', this.getOverrides()), 'projects.json');
            const content = await fs_1.promises.readFile(mappingFile, 'utf8');
            const data = JSON.parse(content);
            if (data.projects && typeof data.projects === 'object') {
                return data.projects[absolutePath] || null;
            }
        }
        catch {
            // Mapping file doesn't exist or is unparseable
        }
        return null;
    }
    async scanSessions(params) {
        let sessions = await this.getAllSessions();
        // Filter by agentType
        if (params.agentType) {
            sessions = sessions.filter((s) => s.agentType === params.agentType);
        }
        // Filter by projectPath (matches full path or folder name)
        if (params.projectPath) {
            const pp = this.normalizePath(params.projectPath);
            const ppFolder = this.folderName(params.projectPath);
            sessions = sessions.filter((s) => (s.cwd ? this.normalizePath(s.cwd) : '') === pp ||
                (s.projectPath ? this.normalizePath(s.projectPath) : '') === pp ||
                (s.cwd ? this.folderName(s.cwd) : '') === ppFolder ||
                (s.projectPath ? this.folderName(s.projectPath) : '') === ppFolder);
        }
        // Filter by query (search in sessionName, firstPrompt, and session id)
        if (params.query) {
            const q = params.query.toLowerCase();
            sessions = sessions.filter((s) => s.firstPrompt.toLowerCase().includes(q) ||
                s.id.toLowerCase().includes(q) ||
                (s.sessionName && s.sessionName.toLowerCase().includes(q)));
        }
        // Sort by most recent first
        sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
        const total = sessions.length;
        const offset = params.offset || 0;
        const limit = params.limit || 50;
        return {
            sessions: sessions.slice(offset, offset + limit),
            total,
        };
    }
    /**
     * Recent-first fast path for the Resume dialog's initial paint.
     *
     * `scanSessions`/`getAllSessions` must parse EVERY session file across all
     * agents before it can sort by recency and return the first page — with
     * hundreds of sessions that cold scan is what stalls the dialog on
     * "Scanning sessions…". This instead enumerates candidate files with a cheap
     * `fs.stat` (metadata only, no content read), orders them by mtime, and parses
     * just enough of the most-recent ones to fill `limit`. The full scan still
     * runs afterwards and replaces these results; this only fills the gap.
     *
     * When the 30s cache is already warm we serve the slice straight from it, so
     * this is never slower than a normal scan.
     */
    async getRecentSessions(limit = 12, filter = {}) {
        const pp = filter.projectPath ? this.normalizePath(filter.projectPath) : '';
        const ppFolder = filter.projectPath ? this.folderName(filter.projectPath) : '';
        const matchesFilter = (s) => {
            if (filter.agentType && s.agentType !== filter.agentType)
                return false;
            if (filter.projectPath) {
                const ok = (s.cwd ? this.normalizePath(s.cwd) : '') === pp ||
                    (s.projectPath ? this.normalizePath(s.projectPath) : '') === pp ||
                    (s.cwd ? this.folderName(s.cwd) : '') === ppFolder ||
                    (s.projectPath ? this.folderName(s.projectPath) : '') === ppFolder;
                if (!ok)
                    return false;
            }
            return true;
        };
        // Warm cache → return the recent slice directly, no filesystem walk.
        if (this.cache && Date.now() - this.cache.timestamp < this.CACHE_TTL) {
            return this.cache.sessions
                .filter(matchesFilter)
                .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
                .slice(0, limit);
        }
        // Cold: enumerate candidates cheaply (stat only), then parse the most
        // recent ones until we've filled `limit` or hit a parse budget.
        const candidates = [];
        const want = (a) => !filter.agentType || filter.agentType === a;
        await Promise.allSettled([
            want('claude') ? this.collectClaudeCandidates(candidates) : Promise.resolve(),
            want('codex') ? this.collectCodexCandidates(candidates) : Promise.resolve(),
            want('gemini') ? this.collectGeminiCandidates(candidates) : Promise.resolve(),
            want('kimi') ? this.collectKimiCandidates(candidates, filter.projectPath) : Promise.resolve(),
            want('agy') ? this.collectAgyCandidates(candidates) : Promise.resolve(),
            want('qwen') ? this.collectQwenCandidates(candidates) : Promise.resolve(),
            want('opencode') ? this.collectOpencodeCandidates(candidates) : Promise.resolve(),
            want('cline') ? this.collectClineCandidates(candidates) : Promise.resolve(),
            want('grok') ? this.collectGrokCandidates(candidates) : Promise.resolve(),
            want('hermes') ? this.collectHermesCandidates(candidates) : Promise.resolve(),
            want('cursor') ? this.collectCursorCandidates(candidates) : Promise.resolve(),
            want('pi') ? this.collectPiCandidates(candidates) : Promise.resolve(),
        ]);
        candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
        const out = [];
        const seen = new Set();
        // Bound the worst case (e.g. a project filter that excludes most recent
        // files) so a quick preview never degrades into a full scan.
        const budget = Math.max(limit * 4, 60);
        let parsed = 0;
        for (const candidate of candidates) {
            if (out.length >= limit || parsed >= budget)
                break;
            parsed++;
            let session;
            try {
                session = await candidate.parse();
            }
            catch {
                session = null;
            }
            if (!session || !matchesFilter(session))
                continue;
            const key = this.getSessionSourceKey(session.agentType, session.id);
            if (seen.has(key))
                continue;
            seen.add(key);
            out.push(session);
        }
        if (want('codex')) {
            const codexBase = (0, agentPaths_1.getAgentRoot)('codex', this.getOverrides());
            this.enrichCodexSessionsFromStateDb(codexBase, out, { addMissing: false });
            await this.enrichCodexSessionsFromIndex(codexBase, out);
        }
        out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
        return out;
    }
    async collectClaudeCandidates(out) {
        const claudeDir = path_1.default.join((0, agentPaths_1.getAgentRoot)('claude', this.getOverrides()), 'projects');
        let projectDirs;
        try {
            projectDirs = await fs_1.promises.readdir(claudeDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        await Promise.allSettled(projectDirs.filter((d) => d.isDirectory()).map(async (dir) => {
            const projectDir = path_1.default.join(claudeDir, dir.name);
            let files;
            try {
                files = await fs_1.promises.readdir(projectDir);
            }
            catch {
                return;
            }
            // Decode the (expensive, fs-walking) project path at most once per dir,
            // and only if one of its files is actually parsed.
            let decoded = null;
            const decode = async () => (decoded ??= await this.decodeClaudeProjectPath(dir.name));
            await Promise.allSettled(files.filter((f) => f.endsWith('.jsonl')).map(async (file) => {
                const filePath = path_1.default.join(projectDir, file);
                let stat;
                try {
                    stat = await fs_1.promises.stat(filePath);
                }
                catch {
                    return;
                }
                out.push({
                    mtimeMs: stat.mtimeMs,
                    parse: async () => this.parseClaudeSessionFile(filePath, await decode()),
                });
            }));
        }));
    }
    async collectCodexCandidates(out) {
        const sessionsDir = path_1.default.join((0, agentPaths_1.getAgentRoot)('codex', this.getOverrides()), 'sessions');
        const walk = async (dir) => {
            let entries;
            try {
                entries = await fs_1.promises.readdir(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            await Promise.allSettled(entries.map(async (entry) => {
                const fullPath = path_1.default.join(dir, entry.name);
                if (entry.isDirectory())
                    return walk(fullPath);
                if (!entry.name.endsWith('.jsonl'))
                    return;
                let stat;
                try {
                    stat = await fs_1.promises.stat(fullPath);
                }
                catch {
                    return;
                }
                out.push({
                    mtimeMs: stat.mtimeMs,
                    parse: async () => this.parseCodexRolloutFile(fullPath),
                });
            }));
        };
        await walk(sessionsDir);
    }
    async collectGeminiCandidates(out) {
        const tmpDir = path_1.default.join((0, agentPaths_1.getAgentRoot)('gemini', this.getOverrides()), 'tmp');
        let projectDirs;
        try {
            projectDirs = await fs_1.promises.readdir(tmpDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        await Promise.allSettled(projectDirs.filter((d) => d.isDirectory()).map(async (dir) => {
            const chatsDir = path_1.default.join(tmpDir, dir.name, 'chats');
            let files;
            try {
                files = await fs_1.promises.readdir(chatsDir);
            }
            catch {
                return;
            }
            await Promise.allSettled(files
                .filter((f) => f.startsWith('session-') && (f.endsWith('.json') || f.endsWith('.jsonl')))
                .map(async (file) => {
                const filePath = path_1.default.join(chatsDir, file);
                let stat;
                try {
                    stat = await fs_1.promises.stat(filePath);
                }
                catch {
                    return;
                }
                out.push({
                    mtimeMs: stat.mtimeMs,
                    parse: async () => this.parseGeminiSessionFile(filePath, dir.name),
                });
            }));
        }));
    }
    async collectKimiCandidates(out, projectPath) {
        const entries = await this.readKimiSessionIndex();
        await Promise.allSettled([...entries.values()].map(async (entry) => {
            // Kimi's native index already owns the launch workDir. Apply the cheap
            // project filter before the recent-preview parse budget so a busy Kimi
            // home cannot starve an older matching session from another agent.
            if (projectPath && entry.workDir) {
                const wanted = this.normalizePath(projectPath);
                const wantedFolder = this.folderName(projectPath);
                const indexed = this.normalizePath(entry.workDir);
                const indexedFolder = this.folderName(entry.workDir);
                if (indexed !== wanted && indexedFolder !== wantedFolder)
                    return;
            }
            const wirePath = path_1.default.join(entry.sessionDir, 'agents', 'main', 'wire.jsonl');
            const statePath = path_1.default.join(entry.sessionDir, 'state.json');
            try {
                const [wireStat, stateStat] = await Promise.all([fs_1.promises.stat(wirePath), fs_1.promises.stat(statePath)]);
                if (!wireStat.isFile() || !stateStat.isFile())
                    return;
                out.push({
                    mtimeMs: Math.max(wireStat.mtimeMs, stateStat.mtimeMs),
                    parse: async () => this.parseKimiSession(entry),
                });
            }
            catch {
                // An index append can become visible just before the first state/wire
                // flush. Detection will retry after the native files exist.
            }
        }));
    }
    async collectQwenCandidates(out) {
        const qwenDir = path_1.default.join((0, agentPaths_1.getAgentRoot)('qwen', this.getOverrides()), 'projects');
        let projectDirs;
        try {
            projectDirs = await fs_1.promises.readdir(qwenDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        await Promise.allSettled(projectDirs.filter((d) => d.isDirectory()).map(async (dir) => {
            const chatsDir = path_1.default.join(qwenDir, dir.name, 'chats');
            let files;
            try {
                files = await fs_1.promises.readdir(chatsDir);
            }
            catch {
                return;
            }
            let decoded = null;
            const decode = async () => (decoded ??= await this.decodeClaudeProjectPath(dir.name));
            await Promise.allSettled(files.filter((f) => f.endsWith('.jsonl')).map(async (file) => {
                const filePath = path_1.default.join(chatsDir, file);
                let stat;
                try {
                    stat = await fs_1.promises.stat(filePath);
                }
                catch {
                    return;
                }
                out.push({
                    mtimeMs: stat.mtimeMs,
                    parse: async () => this.parseQwenSessionFile(filePath, await decode()),
                });
            }));
        }));
    }
    async collectOpencodeCandidates(out) {
        // OpenCode is SQLite-backed and already returns recent-first via a single
        // indexed query, so there's nothing to lazily defer — the sessions are
        // fully built. Wrap each as an already-resolved candidate.
        const sessions = await this.scanOpencodeSessions();
        for (const session of sessions) {
            out.push({ mtimeMs: session.lastActivityAt, parse: async () => session });
        }
    }
    async collectHermesCandidates(out) {
        // Hermes is SQLite-backed. The indexed scan already returns newest first,
        // so expose each result as an already-parsed candidate like OpenCode.
        const sessions = await this.scanHermesSessions();
        for (const session of sessions) {
            out.push({ mtimeMs: session.lastActivityAt, parse: async () => session });
        }
    }
    async getSessionDetail(agentType, sessionId) {
        let detail = null;
        switch (agentType) {
            case 'claude':
                detail = await this.getClaudeSessionDetail(sessionId);
                break;
            case 'codex':
                detail = await this.getCodexSessionDetail(sessionId);
                break;
            case 'gemini':
                detail = await this.getGeminiSessionDetail(sessionId);
                break;
            case 'kimi':
                detail = await this.getKimiSessionDetail(sessionId);
                break;
            case 'agy':
                detail = await this.getAgySessionDetail(sessionId);
                break;
            case 'qwen':
                detail = await this.getQwenSessionDetail(sessionId);
                break;
            case 'opencode':
                detail = await this.getOpencodeSessionDetail(sessionId);
                break;
            case 'cline':
                detail = await this.getClineSessionDetail(sessionId);
                break;
            case 'grok':
                detail = await this.getGrokSessionDetail(sessionId);
                break;
            case 'hermes':
                detail = await this.getHermesSessionDetail(sessionId);
                break;
            case 'cursor':
                detail = await this.getCursorSessionDetail(sessionId);
                break;
            case 'pi':
                detail = await this.getPiSessionDetail(sessionId);
                break;
            default:
                return null;
        }
        return detail ?? this.getPersistedSessionDetail(agentType, sessionId);
    }
    /**
     * Persist a terminal-tab rename into the coding CLI's own session store.
     * The renderer supplies only a terminal id to IPC; main resolves the bound
     * agent/session and dispatches here so display text can never choose a file.
     */
    async renameSession(agentType, sessionId, rawTitle) {
        if (!DETECTABLE_AGENT_TYPES.has(agentType)) {
            throw new Error(`${agentType} does not expose a persistent session title.`);
        }
        if (!SESSION_ID_RE.test(sessionId)) {
            throw new Error(`The ${agentType} session id is invalid.`);
        }
        const title = rawTitle.trim();
        if (!title)
            throw new Error('The session title cannot be empty.');
        if (title.length > MAX_SESSION_TITLE_LENGTH) {
            throw new Error(`The session title must be ${MAX_SESSION_TITLE_LENGTH} characters or fewer.`);
        }
        switch (agentType) {
            case 'claude':
                await this.renameClaudeSessionFile(sessionId, title);
                break;
            case 'codex':
                await this.renameCodexSessionFile(sessionId, title);
                break;
            case 'gemini':
                await this.renameGeminiSessionFile(sessionId, title);
                break;
            case 'kimi':
                await this.renameKimiSessionFile(sessionId, title);
                break;
            case 'agy':
                await this.renameAgySessionRow(sessionId, title);
                break;
            case 'qwen':
                await this.renameQwenSessionFile(sessionId, title);
                break;
            case 'opencode':
                this.renameOpencodeSessionRow(sessionId, title);
                break;
            case 'cline':
                await this.renameClineSessionFile(sessionId, title);
                break;
            case 'grok':
                await this.renameGrokSessionFile(sessionId, title);
                break;
            case 'hermes':
                this.renameHermesSessionRow(sessionId, title);
                break;
            case 'cursor':
                await this.renameCursorSessionFile(sessionId, title);
                break;
            case 'pi':
                await this.renamePiSessionFile(sessionId, title);
                break;
            default:
                throw new Error(`${agentType} does not expose a persistent session title.`);
        }
        // Session lists and exact-PTY detection may already hold the old name.
        // The agent store is authoritative, so force every subsequent read to see
        // the persisted rename.
        this.cache = null;
        this.detectScanCache.delete(agentType);
        return { agentType, sessionId, title };
    }
    async appendJsonlRecord(filePath, record) {
        // O_APPEND plus one appendFile call prevents a live CLI writer from being
        // overwritten or having its JSON record split by this rename.
        const handle = await fs_1.promises.open(filePath, 'a+');
        try {
            const stat = await handle.stat();
            let prefix = '';
            if (stat.size > 0) {
                const lastByte = Buffer.alloc(1);
                const { bytesRead } = await handle.read(lastByte, 0, 1, stat.size - 1);
                if (bytesRead === 1 && lastByte[0] !== 0x0a)
                    prefix = '\n';
            }
            await handle.appendFile(`${prefix}${JSON.stringify(record)}\n`, 'utf8');
            await handle.sync();
        }
        finally {
            await handle.close();
        }
    }
    async readLastJsonlRecord(filePath) {
        const handle = await fs_1.promises.open(filePath, 'r');
        try {
            const stat = await handle.stat();
            const length = Math.min(stat.size, 1024 * 1024);
            if (length === 0)
                return null;
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
            const lines = buffer.toString('utf8', 0, bytesRead).split('\n');
            for (let index = lines.length - 1; index >= 0; index--) {
                if (!lines[index].trim())
                    continue;
                try {
                    const parsed = JSON.parse(lines[index]);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        return parsed;
                    }
                }
                catch {
                    // The first tail line may be a partial oversized record.
                }
            }
            return null;
        }
        finally {
            await handle.close();
        }
    }
    async updateJsonObjectFile(filePath, mutate) {
        // Gemini, Cline, Grok, and Cursor rewrite whole JSON metadata files. Write
        // a complete sibling temp file, then rename it only if the source did not
        // change while we were preparing the update. A bounded retry preserves a
        // turn that the live CLI happened to flush concurrently.
        for (let attempt = 0; attempt < 3; attempt++) {
            const before = await fs_1.promises.stat(filePath);
            const parsed = JSON.parse(await fs_1.promises.readFile(filePath, 'utf8'));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('The session metadata is not a JSON object.');
            }
            const record = parsed;
            mutate(record);
            const tempPath = path_1.default.join(path_1.default.dirname(filePath), `.${path_1.default.basename(filePath)}.${process.pid}.${process.hrtime.bigint()}.${attempt}.tmp`);
            try {
                const handle = await fs_1.promises.open(tempPath, 'wx', before.mode & 0o777);
                try {
                    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
                    await handle.sync();
                }
                finally {
                    await handle.close();
                }
                const current = await fs_1.promises.stat(filePath);
                if (current.size !== before.size || current.mtimeMs !== before.mtimeMs) {
                    await fs_1.promises.rm(tempPath, { force: true });
                    continue;
                }
                await fs_1.promises.rename(tempPath, filePath);
                return;
            }
            catch (error) {
                await fs_1.promises.rm(tempPath, { force: true }).catch(() => { });
                throw error;
            }
        }
        throw new Error('The session changed while its title was being saved. Please try again.');
    }
    async renameClaudeSessionFile(sessionId, title) {
        const filePath = await this.findClaudeSessionFile(sessionId);
        if (!filePath)
            throw new Error('The Claude session file could not be found.');
        // Exact native `/rename` record shape.
        await this.appendJsonlRecord(filePath, { type: 'custom-title', customTitle: title, sessionId });
    }
    async renameCodexSessionFile(sessionId, title) {
        const codexBase = (0, agentPaths_1.getAgentRoot)('codex', this.getOverrides());
        const knownPath = this.getCodexRolloutPathFromStateDb(codexBase, sessionId)
            ?? await this.findCodexRolloutPathBySessionId(path_1.default.join(codexBase, 'sessions'), sessionId);
        if (!knownPath) {
            const knownSession = (await this.scanCodexSessions()).some((session) => session.id === sessionId);
            if (!knownSession)
                throw new Error('The Codex session could not be found.');
        }
        // Codex `/rename` appends the user-facing name to session_index.jsonl.
        // Do not replace SQLite's generated title; current Codex treats the newest
        // index record as the explicit name and allows duplicate names.
        await this.appendJsonlRecord(path_1.default.join(codexBase, 'session_index.jsonl'), {
            id: sessionId,
            thread_name: title,
            updated_at: new Date().toISOString(),
        });
    }
    async renameGeminiSessionFile(sessionId, title) {
        const matches = (await this.scanGeminiSessions()).filter((session) => session.id === sessionId);
        if (matches.length !== 1)
            throw new Error('The Gemini session file could not be uniquely identified.');
        if (matches[0].filePath.endsWith('.jsonl')) {
            // Current Gemini's own SessionRecordingService persists metadata changes
            // as append-only $set records; `summary` is what its session browser uses
            // as the display name.
            await this.appendJsonlRecord(matches[0].filePath, { $set: { summary: title } });
            return;
        }
        await this.updateJsonObjectFile(matches[0].filePath, (record) => {
            if (record.sessionId !== sessionId)
                throw new Error('The Gemini session id no longer matches its file.');
            record.title = title;
            record.summary = title;
        });
    }
    async renameKimiSessionFile(sessionId, title) {
        const entry = (await this.readKimiSessionIndex()).get(sessionId);
        if (!entry)
            throw new Error('The Kimi session could not be found.');
        const statePath = path_1.default.join(entry.sessionDir, 'state.json');
        await this.updateJsonObjectFile(statePath, (record) => {
            if (typeof record.id === 'string' && record.id !== sessionId) {
                throw new Error('The Kimi session id no longer matches its metadata.');
            }
            record.title = title;
            record.isCustomTitle = true;
            record.updatedAt = typeof record.updatedAt === 'string'
                ? new Date().toISOString()
                : Date.now();
        });
    }
    async renameQwenSessionFile(sessionId, title) {
        const matches = (await this.scanQwenSessions()).filter((session) => session.id === sessionId);
        if (matches.length !== 1)
            throw new Error('The Qwen session file could not be uniquely identified.');
        const lastRecord = await this.readLastJsonlRecord(matches[0].filePath);
        if (!lastRecord || typeof lastRecord.uuid !== 'string' || !lastRecord.uuid) {
            throw new Error('The Qwen session does not have a resumable transcript anchor.');
        }
        // Qwen reconstructs history from the final record's uuid. Anchor the
        // metadata record to that same leaf so append-only persistence cannot make
        // resume see an empty branch. aggregateRecords ignores the title-only
        // record while 1DevTool can recover the explicit name on reopen.
        const renameRecord = {
            type: 'custom-title',
            customTitle: title,
            sessionId,
            uuid: lastRecord.uuid,
            timestamp: new Date().toISOString(),
        };
        for (const key of ['parentUuid', 'cwd', 'gitBranch', 'version']) {
            if (lastRecord[key] !== undefined)
                renameRecord[key] = lastRecord[key];
        }
        await this.appendJsonlRecord(matches[0].filePath, renameRecord);
    }
    async renameClineSessionFile(sessionId, title) {
        const metadataPath = path_1.default.join(this.clineSessionsRoot(), sessionId, `${sessionId}.json`);
        const session = await this.parseClineSessionFile(metadataPath);
        if (session?.id !== sessionId)
            throw new Error('The Cline session file could not be found.');
        await this.updateJsonObjectFile(metadataPath, (record) => {
            const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
                ? record.metadata
                : {};
            metadata.title = title;
            record.metadata = metadata;
            if ('title' in record)
                record.title = title;
        });
    }
    async renameGrokSessionFile(sessionId, title) {
        const summaryPath = await this.findGrokSummaryPath(sessionId);
        const matches = summaryPath
            ? [{ filePath: summaryPath }]
            : (await this.scanGrokSessions()).filter((session) => session.id === sessionId);
        if (matches.length !== 1)
            throw new Error('The Grok session file could not be uniquely identified.');
        await this.updateJsonObjectFile(matches[0].filePath, (record) => {
            const info = record.info;
            const storedId = info && typeof info === 'object' && !Array.isArray(info)
                ? info.id
                : undefined;
            if (storedId !== sessionId)
                throw new Error('The Grok session id no longer matches its file.');
            record.generated_title = title;
        });
    }
    renameOpencodeSessionRow(sessionId, title) {
        const dbPath = path_1.default.join((0, agentPaths_1.getAgentRoot)('opencode', this.getOverrides()), 'opencode.db');
        const db = new better_sqlite3_1.default(dbPath, { fileMustExist: true });
        try {
            db.pragma('busy_timeout = 5000');
            const result = db.prepare('UPDATE session SET title = ? WHERE id = ?').run(title, sessionId);
            if (result.changes !== 1)
                throw new Error('The OpenCode session could not be found.');
        }
        finally {
            db.close();
        }
    }
    renameHermesSessionRow(sessionId, title) {
        const db = new better_sqlite3_1.default(path_1.default.join((0, hermesPaths_1.getHermesHome)(), 'state.db'), { fileMustExist: true });
        try {
            db.pragma('busy_timeout = 5000');
            const tipId = this.resolveHermesCompressionTip(db, sessionId);
            if (!tipId)
                throw new Error('The Hermes session could not be found.');
            const result = db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, tipId);
            if (result.changes !== 1)
                throw new Error('The Hermes session could not be renamed.');
        }
        finally {
            db.close();
        }
    }
    async renameAgySessionRow(sessionId, title) {
        const matches = [];
        await Promise.all(this.agyDataRoots().map(async (root) => {
            try {
                if ((await fs_1.promises.stat(path_1.default.join(root, 'brain', sessionId))).isDirectory())
                    matches.push(root);
            }
            catch {
                // Not this Agy data root.
            }
        }));
        if (matches.length !== 1)
            throw new Error('The AGY session could not be uniquely identified.');
        const db = new better_sqlite3_1.default(path_1.default.join(matches[0], 'conversation_summaries.db'), { fileMustExist: true });
        try {
            db.pragma('busy_timeout = 5000');
            const result = db.prepare('UPDATE conversation_summaries SET title = ? WHERE conversation_id = ?').run(title, sessionId);
            if (result.changes !== 1)
                throw new Error('The AGY conversation summary could not be found.');
        }
        finally {
            db.close();
        }
    }
    /**
     * Cursor stores the user-facing chat name in meta.json (`title`). Walk the
     * md5(cwd) project dirs to the owned UUID chat folder — same layout as
     * getCursorSessionDetail — and rewrite only that field.
     */
    async renameCursorSessionFile(sessionId, title) {
        const sessionDir = await this.findCursorSessionDir(sessionId);
        if (!sessionDir)
            throw new Error('The Cursor session could not be found.');
        const metaPath = path_1.default.join(sessionDir, 'meta.json');
        const storeDbPath = path_1.default.join(sessionDir, 'store.db');
        try {
            await fs_1.promises.stat(metaPath);
        }
        catch {
            // Brand-new chats can have store.db before meta.json is flushed. Seed a
            // minimal meta so the rename still lands in the native store.
            await fs_1.promises.writeFile(metaPath, `${JSON.stringify({
                schemaVersion: 1,
                title,
                updatedAtMs: Date.now(),
                hasConversation: true,
            })}\n`, 'utf8');
            this.cursorSessionCache.delete(storeDbPath);
            return;
        }
        await this.updateJsonObjectFile(metaPath, (record) => {
            record.title = title;
            record.updatedAtMs = Date.now();
        });
        // Title-only rewrites change meta mtime; drop the scan memo so the next
        // read cannot return a pre-rename sessionName from a stale cache key race.
        this.cursorSessionCache.delete(storeDbPath);
    }
    /** Locate ~/.cursor/chats/<md5(cwd)>/<sessionId>/ by store.db presence. */
    async findCursorSessionDir(sessionId) {
        if (!this.looksLikeCursorSessionId(sessionId))
            return null;
        const chatsRoot = this.cursorChatsRoot();
        let hashDirs;
        try {
            hashDirs = (await fs_1.promises.readdir(chatsRoot, { withFileTypes: true }))
                .filter((d) => d.isDirectory())
                .map((d) => d.name);
        }
        catch {
            return null;
        }
        for (const hashDir of hashDirs) {
            const sessionDir = path_1.default.join(chatsRoot, hashDir, sessionId);
            try {
                if ((await fs_1.promises.stat(path_1.default.join(sessionDir, 'store.db'))).isFile())
                    return sessionDir;
            }
            catch {
                // Not under this project hash.
            }
        }
        return null;
    }
    async getUniqueProjects() {
        const sessions = await this.getAllSessions();
        const projects = new Set();
        for (const s of sessions) {
            const name = s.projectPath ? this.folderName(s.projectPath) : '';
            if (name)
                projects.add(name);
        }
        return [...projects].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    }
    getResumeCommand(agentType, sessionId) {
        switch (agentType) {
            case 'claude':
                return `claude --resume ${sessionId}`;
            case 'codex':
                return (0, contracts_1.ensureCodexInlineMode)(`codex resume ${sessionId}`) ?? `codex resume ${sessionId}`;
            case 'gemini':
                return `gemini --resume ${sessionId}`;
            case 'kimi':
                return `kimi --session ${sessionId}`;
            case 'agy':
                return `agy --conversation ${sessionId}`;
            case 'qwen':
                return `qwen --resume ${sessionId}`;
            case 'amp':
                return `amp --resume ${sessionId}`;
            case 'opencode':
                // OpenCode resumes via `opencode -s <session-id>`.
                return `opencode -s ${sessionId}`;
            case 'cline':
                // Cline resumes its native TUI with `--id <session-id>`.
                return `cline --id ${sessionId}`;
            case 'grok':
                // Grok owns a native OpenTUI screen and resumes via the --resume flag.
                return `grok --resume ${sessionId}`;
            case 'hermes':
                return `hermes --resume ${sessionId}`;
            case 'cursor':
                // Cursor chats live server-side, so an id is rarely known. Bare
                // `--resume` is valid and opens Cursor's own chat picker.
                return sessionId ? `cursor-agent --resume ${sessionId}` : 'cursor-agent --resume';
            case 'pi':
                // `pi --session <path|id>` accepts a full or partial session UUID and
                // resolves it against the sessions tree. Bare `pi -r` opens pi's own
                // picker when we have no id.
                return sessionId ? `pi --session ${sessionId}` : 'pi -r';
            default:
                return '';
        }
    }
    async getAllSessions() {
        // Return cache if still fresh
        if (this.cache && Date.now() - this.cache.timestamp < this.CACHE_TTL) {
            return this.cache.sessions;
        }
        const results = await Promise.allSettled([
            this.scanClaudeSessions(),
            this.scanCodexSessions(),
            this.scanGeminiSessions(),
            this.scanKimiSessions(),
            this.scanAgySessions(),
            this.scanQwenSessions(),
            this.scanOpencodeSessions(),
            this.scanClineSessions(),
            this.scanGrokSessions(),
            this.scanHermesSessions(),
            this.scanCursorSessions(),
            this.scanPiSessions(),
        ]);
        const sessionsByKey = new Map();
        for (const session of this.getPersistedSessions()) {
            sessionsByKey.set(this.getSessionSourceKey(session.agentType, session.id), session);
        }
        for (const result of results) {
            if (result.status === 'fulfilled') {
                for (const session of result.value) {
                    sessionsByKey.set(this.getSessionSourceKey(session.agentType, session.id), session);
                }
            }
        }
        const sessions = [...sessionsByKey.values()];
        this.cache = { sessions, timestamp: Date.now() };
        return sessions;
    }
    clearCache() {
        this.cache = null;
    }
    async collectLocalPromptRecords() {
        const sessions = await this.getAllSessions();
        const records = [];
        const agents = {};
        for (const session of sessions) {
            const agentStats = agents[session.agentType] ?? { sessions: 0, prompts: 0 };
            agentStats.sessions += 1;
            agents[session.agentType] = agentStats;
            this.upsertPersistedSession(session);
            let detail = null;
            try {
                detail = await this.getSessionDetailFromKnownSession(session);
            }
            catch {
                continue;
            }
            if (!detail)
                continue;
            this.upsertPersistedSessionDetail(detail);
            let userMessageIndex = 0;
            for (const message of detail.messages) {
                if (message.role !== 'user')
                    continue;
                const promptText = message.content.trim();
                if (!promptText)
                    continue;
                userMessageIndex += 1;
                agentStats.prompts += 1;
                records.push({
                    sourceKey: this.buildPromptSourceKey(session.agentType, session.id, userMessageIndex, message.timestamp),
                    projectId: this.getPromptProjectId(session),
                    projectName: this.getPromptProjectName(session),
                    terminalId: `local:${session.agentType}:${session.id}`,
                    agentType: session.agentType,
                    promptText,
                    createdAt: this.formatPromptTimestamp(message.timestamp, session.startedAt),
                });
            }
        }
        this.clearCache();
        return { records, scannedSessions: sessions.length, agents };
    }
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
    getDb() {
        if (!this.db) {
            const dbPath = path_1.default.join(electron_1.app.getPath('userData'), 'resume-sessions.db');
            this.db = new better_sqlite3_1.default(dbPath);
            this.db.pragma('journal_mode = WAL');
            this.db.exec(`
        CREATE TABLE IF NOT EXISTS resume_sessions (
          source_key TEXT PRIMARY KEY,
          id TEXT NOT NULL,
          agent_type TEXT NOT NULL,
          cwd TEXT NOT NULL,
          started_at REAL NOT NULL,
          last_activity_at REAL NOT NULL,
          first_prompt TEXT NOT NULL,
          last_assistant_preview TEXT,
          message_count INTEGER NOT NULL,
          file_path TEXT NOT NULL,
          project_path TEXT,
          git_branch TEXT,
          synced_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
            this.db.exec(`
        CREATE TABLE IF NOT EXISTS resume_messages (
          session_source_key TEXT NOT NULL,
          message_index INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp TEXT,
          PRIMARY KEY (session_source_key, message_index)
        )
      `);
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_resume_sessions_agent ON resume_sessions(agent_type)`);
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_resume_sessions_activity ON resume_sessions(last_activity_at)`);
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_resume_messages_session ON resume_messages(session_source_key)`);
            try {
                this.db.exec(`ALTER TABLE resume_sessions ADD COLUMN session_name TEXT`);
            }
            catch { /* already exists */ }
            try {
                this.db.exec(`ALTER TABLE resume_sessions ADD COLUMN model TEXT`);
            }
            catch { /* already exists */ }
        }
        return this.db;
    }
    getSessionSourceKey(agentType, sessionId) {
        return `${agentType}:${sessionId}`;
    }
    upsertPersistedSession(session) {
        const db = this.getDb();
        db.prepare(`INSERT INTO resume_sessions (
        source_key,
        id,
        agent_type,
        cwd,
        started_at,
        last_activity_at,
        first_prompt,
        last_assistant_preview,
        message_count,
        file_path,
        project_path,
        git_branch,
        session_name,
        model,
        synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(source_key) DO UPDATE SET
        cwd = excluded.cwd,
        started_at = excluded.started_at,
        last_activity_at = excluded.last_activity_at,
        first_prompt = excluded.first_prompt,
        last_assistant_preview = excluded.last_assistant_preview,
        message_count = excluded.message_count,
        file_path = excluded.file_path,
        project_path = excluded.project_path,
        git_branch = excluded.git_branch,
        session_name = excluded.session_name,
        model = excluded.model,
        synced_at = excluded.synced_at`).run(this.getSessionSourceKey(session.agentType, session.id), session.id, session.agentType, session.cwd || '', session.startedAt || Date.now(), session.lastActivityAt || session.startedAt || Date.now(), session.firstPrompt || '', session.lastAssistantPreview || null, session.messageCount || 0, session.filePath || '', session.projectPath || null, session.gitBranch || null, session.sessionName || null, session.model || null);
    }
    upsertPersistedSessionDetail(detail) {
        const db = this.getDb();
        const sourceKey = this.getSessionSourceKey(detail.agentType, detail.id);
        const replaceMessages = db.transaction((messages) => {
            db.prepare(`DELETE FROM resume_messages WHERE session_source_key = ?`).run(sourceKey);
            const insert = db.prepare(`INSERT INTO resume_messages (
          session_source_key,
          message_index,
          role,
          content,
          timestamp
        ) VALUES (?, ?, ?, ?, ?)`);
            messages.forEach((message, index) => {
                insert.run(sourceKey, index, message.role, message.content, message.timestamp || null);
            });
        });
        this.upsertPersistedSession(detail);
        replaceMessages(detail.messages);
    }
    getPersistedSessions() {
        try {
            const rows = this.getDb().prepare(`SELECT * FROM resume_sessions ORDER BY last_activity_at DESC`).all();
            return rows.map((row) => this.persistedRowToSession(row));
        }
        catch {
            return [];
        }
    }
    getPersistedSessionDetail(agentType, sessionId) {
        try {
            const db = this.getDb();
            const sourceKey = this.getSessionSourceKey(agentType, sessionId);
            const row = db.prepare(`SELECT * FROM resume_sessions WHERE source_key = ?`).get(sourceKey);
            if (!row)
                return null;
            const messages = db.prepare(`SELECT role, content, timestamp
         FROM resume_messages
         WHERE session_source_key = ?
         ORDER BY message_index ASC`).all(sourceKey);
            return {
                ...this.persistedRowToSession(row),
                messages: messages.map((message) => ({
                    role: message.role,
                    content: message.content,
                    timestamp: message.timestamp || undefined,
                })),
            };
        }
        catch {
            return null;
        }
    }
    persistedRowToSession(row) {
        return {
            id: row.id,
            agentType: row.agent_type,
            cwd: row.cwd || '',
            startedAt: row.started_at,
            lastActivityAt: row.last_activity_at,
            firstPrompt: row.first_prompt || '',
            sessionName: row.session_name || undefined,
            lastAssistantPreview: row.last_assistant_preview || undefined,
            messageCount: row.message_count,
            isActive: false,
            filePath: row.file_path || '',
            projectPath: row.project_path || undefined,
            gitBranch: row.git_branch || undefined,
            model: row.model || undefined,
        };
    }
    buildPromptSourceKey(agentType, sessionId, messageIndex, timestamp) {
        return `local:${agentType}:${sessionId}:${messageIndex}:${timestamp || ''}`;
    }
    getPromptProjectId(session) {
        return session.cwd || session.projectPath || `local:${session.agentType}`;
    }
    getPromptProjectName(session) {
        const projectPath = session.cwd || session.projectPath || '';
        if (!projectPath)
            return `${session.agentType} local data`;
        return this.folderName(projectPath);
    }
    formatPromptTimestamp(timestamp, fallbackMs) {
        const date = timestamp ? new Date(timestamp) : new Date(fallbackMs);
        const safeDate = Number.isNaN(date.getTime()) ? new Date(fallbackMs || Date.now()) : date;
        return safeDate.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
    }
    async getSessionDetailFromKnownSession(session) {
        switch (session.agentType) {
            case 'claude':
                return this.getClaudeSessionDetailFromSession(session);
            case 'codex':
                return this.getCodexSessionDetailFromSession(session);
            case 'gemini':
                return this.getGeminiSessionDetailFromSession(session);
            case 'kimi':
                return this.getKimiSessionDetailFromSession(session);
            case 'agy':
                return this.getAgySessionDetailFromSession(session);
            case 'qwen':
                return this.getQwenSessionDetailFromSession(session);
            case 'opencode':
                return this.getOpencodeSessionDetail(session.id);
            case 'cline':
                return this.getClineSessionDetailFromSession(session);
            case 'grok':
                return this.getGrokSessionDetailFromSession(session);
            case 'hermes':
                return this.getHermesSessionDetail(session.id);
            case 'cursor':
                return this.getCursorSessionDetailFromSession(session);
            case 'pi':
                return this.getPiSessionDetailFromSession(session);
            default:
                return null;
        }
    }
    // ─── Claude Code ──────────────────────────────────────────────────────
    async findClaudeSessionFile(sessionId) {
        const projectsDir = path_1.default.join((0, agentPaths_1.getAgentRoot)('claude', this.getOverrides()), 'projects');
        let projectDirs;
        try {
            projectDirs = await fs_1.promises.readdir(projectsDir, { withFileTypes: true });
        }
        catch {
            return null;
        }
        const matches = await Promise.all(projectDirs
            .filter((entry) => entry.isDirectory())
            .map(async (entry) => {
            const candidate = path_1.default.join(projectsDir, entry.name, `${sessionId}.jsonl`);
            try {
                const stat = await fs_1.promises.stat(candidate);
                return stat.isFile() ? candidate : null;
            }
            catch {
                return null;
            }
        }));
        const found = matches.filter((candidate) => candidate !== null);
        if (found.length > 1) {
            throw new Error('Multiple Claude session files matched this session id.');
        }
        return found[0] ?? null;
    }
    /**
     * Decode a Claude project directory name back to the original absolute path.
     * Claude encodes paths by replacing '/' (and '\' on Windows) with '-',
     * but directory names can also contain dashes (e.g. "1devtool-desktop").
     * We resolve ambiguity by checking which paths actually exist on the filesystem.
     *
     * Windows: drive letter is encoded as a single letter segment (e.g. "C-Users-foo"
     * from "C:\Users\foo"). We detect this and start from "C:\" instead of "/".
     */
    async decodeClaudeProjectPath(encodedDirName) {
        const raw = encodedDirName.replace(/^-/, '');
        const segments = raw.split('-');
        let currentPath;
        let i;
        // On Windows, detect drive letter: first segment is a single letter (e.g. "C")
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
            // Try longest candidate first (join segments with '-'), then progressively shorter
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
                    // Path doesn't exist, try shorter candidate
                }
            }
            if (!matched) {
                // No filesystem match — use single segment as directory name
                currentPath = path_1.default.join(currentPath, segments[i]);
                i++;
            }
        }
        return currentPath;
    }
    async scanClaudeSessions() {
        const sessions = [];
        const claudeDir = path_1.default.join((0, agentPaths_1.getAgentRoot)('claude', this.getOverrides()), 'projects');
        try {
            const projectDirs = await fs_1.promises.readdir(claudeDir, { withFileTypes: true });
            for (const dir of projectDirs) {
                if (!dir.isDirectory())
                    continue;
                const projectDir = path_1.default.join(claudeDir, dir.name);
                // Decode the project path from the directory name (filesystem-aware)
                const decodedPath = await this.decodeClaudeProjectPath(dir.name);
                try {
                    const files = await fs_1.promises.readdir(projectDir);
                    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
                    for (const file of jsonlFiles) {
                        try {
                            const filePath = path_1.default.join(projectDir, file);
                            const session = await this.parseClaudeSessionFile(filePath, decodedPath);
                            if (session) {
                                sessions.push(session);
                            }
                        }
                        catch {
                            // Skip unparseable files
                        }
                    }
                }
                catch {
                    // Skip unreadable directories
                }
            }
        }
        catch {
            // Claude directory doesn't exist
        }
        return sessions;
    }
    async parseClaudeSessionFile(filePath, projectPath) {
        const stat = await fs_1.promises.stat(filePath);
        const handle = await fs_1.promises.open(filePath, 'r');
        try {
            // Read first 16KB to extract metadata efficiently
            const buffer = Buffer.alloc(16384);
            const { bytesRead } = await handle.read(buffer, 0, 16384, 0);
            const chunk = buffer.toString('utf8', 0, bytesRead);
            const lines = chunk.split('\n').filter((l) => l.trim());
            let sessionId = '';
            let firstPrompt = '';
            let generatedTitle = '';
            let customTitle = '';
            let startedAt = 0;
            let messageCount = 0;
            let cwd = '';
            let gitBranch = '';
            let model = '';
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line);
                    // Claude stores the real launch directory in each JSONL record.
                    // Prefer it over decoding ~/.claude/projects, which is lossy on Windows
                    // when punctuation like "." in usernames is encoded as "-".
                    if (!cwd && typeof entry.cwd === 'string' && entry.cwd.trim()) {
                        cwd = entry.cwd.trim();
                    }
                    if (!gitBranch && typeof entry.gitBranch === 'string' && entry.gitBranch.trim()) {
                        gitBranch = entry.gitBranch.trim();
                    }
                    if (!model && entry.message?.model && typeof entry.message.model === 'string') {
                        model = entry.message.model;
                    }
                    if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) {
                        generatedTitle = entry.aiTitle.trim();
                    }
                    if (entry.type === 'custom-title' && typeof entry.customTitle === 'string' && entry.customTitle.trim()) {
                        customTitle = entry.customTitle.trim();
                    }
                    if (entry.type === 'summary') {
                        // Summary entries have session metadata
                        sessionId = entry.sessionId || '';
                        continue;
                    }
                    if (entry.type === 'user' || entry.role === 'user') {
                        messageCount++;
                        if (!firstPrompt) {
                            // Extract the text content
                            if (typeof entry.message === 'string') {
                                firstPrompt = entry.message;
                            }
                            else if (entry.message?.content) {
                                if (typeof entry.message.content === 'string') {
                                    firstPrompt = entry.message.content;
                                }
                                else if (Array.isArray(entry.message.content)) {
                                    const textBlock = entry.message.content.find((b) => b.type === 'text');
                                    firstPrompt = textBlock?.text || '';
                                }
                            }
                            else if (typeof entry.content === 'string') {
                                firstPrompt = entry.content;
                            }
                            else if (Array.isArray(entry.content)) {
                                const textBlock = entry.content.find((b) => b.type === 'text');
                                firstPrompt = textBlock?.text || '';
                            }
                            if (!startedAt && entry.timestamp) {
                                startedAt = new Date(entry.timestamp).getTime();
                            }
                            if (!sessionId && entry.sessionId) {
                                sessionId = entry.sessionId;
                            }
                        }
                    }
                    if (entry.type === 'assistant' || entry.role === 'assistant') {
                        messageCount++;
                    }
                }
                catch {
                    // Skip unparseable lines
                }
            }
            if (!sessionId) {
                // Use filename as session ID fallback
                sessionId = path_1.default.basename(filePath, '.jsonl');
            }
            // Allow sessions without firstPrompt for detection (session continuity)
            if (!firstPrompt && !sessionId) {
                return null; // Truly empty session
            }
            // Read last 16KB to extract last assistant message for preview
            let lastAssistantPreview;
            const tailSize = 16384;
            const fileSize = stat.size;
            if (fileSize > tailSize) {
                const tailBuffer = Buffer.alloc(tailSize);
                const { bytesRead: tailBytesRead } = await handle.read(tailBuffer, 0, tailSize, fileSize - tailSize);
                const tailChunk = tailBuffer.toString('utf8', 0, tailBytesRead);
                const tailLines = tailChunk.split('\n').filter((l) => l.trim());
                for (const tl of tailLines) {
                    try {
                        const te = JSON.parse(tl);
                        if (te.type === 'ai-title' && typeof te.aiTitle === 'string' && te.aiTitle.trim()) {
                            generatedTitle = te.aiTitle.trim();
                        }
                        if (te.type === 'custom-title' && typeof te.customTitle === 'string' && te.customTitle.trim()) {
                            customTitle = te.customTitle.trim();
                        }
                    }
                    catch { /* skip */ }
                }
                // Walk backwards to find last assistant message
                for (let i = tailLines.length - 1; i >= 0; i--) {
                    try {
                        const entry = JSON.parse(tailLines[i]);
                        if (entry.type === 'assistant' || entry.role === 'assistant') {
                            let text = '';
                            if (typeof entry.message === 'string') {
                                text = entry.message;
                            }
                            else if (entry.message?.content) {
                                if (typeof entry.message.content === 'string') {
                                    text = entry.message.content;
                                }
                                else if (Array.isArray(entry.message.content)) {
                                    text = entry.message.content
                                        .filter((b) => b.type === 'text')
                                        .map((b) => b.text || '')
                                        .join('\n');
                                }
                            }
                            else if (typeof entry.content === 'string') {
                                text = entry.content;
                            }
                            else if (Array.isArray(entry.content)) {
                                text = entry.content
                                    .filter((b) => b.type === 'text')
                                    .map((b) => b.text || '')
                                    .join('\n');
                            }
                            if (text.trim()) {
                                lastAssistantPreview = text.trim().slice(-500);
                                break;
                            }
                        }
                    }
                    catch {
                        // Skip unparseable lines
                    }
                }
            }
            const resolvedProjectPath = cwd || projectPath;
            return {
                id: sessionId,
                agentType: 'claude',
                cwd: resolvedProjectPath,
                startedAt: startedAt || stat.birthtimeMs,
                lastActivityAt: stat.mtimeMs,
                firstPrompt: firstPrompt.slice(0, 300),
                // A native `/rename` is an explicit user choice and must outrank the
                // agent-generated title even if a later `ai-title` event is present.
                sessionName: customTitle || generatedTitle || undefined,
                lastAssistantPreview,
                messageCount: Math.ceil(messageCount / 2), // Rough conversation turns
                isActive: false,
                filePath,
                projectPath: resolvedProjectPath,
                gitBranch: gitBranch || undefined,
                model: model || undefined,
            };
        }
        finally {
            await handle.close();
        }
    }
    async getClaudeSessionDetail(sessionId) {
        // Find the session file
        const sessions = await this.scanClaudeSessions();
        const session = sessions.find((s) => s.id === sessionId);
        if (!session)
            return null;
        return this.getClaudeSessionDetailFromSession(session);
    }
    async getClaudeSessionDetailFromSession(session) {
        const content = await fs_1.promises.readFile(session.filePath, 'utf8');
        const lines = content.split('\n').filter((l) => l.trim());
        const messages = [];
        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (entry.type === 'user' || entry.role === 'user') {
                    let text = '';
                    if (typeof entry.message === 'string') {
                        text = entry.message;
                    }
                    else if (entry.message?.content) {
                        if (typeof entry.message.content === 'string') {
                            text = entry.message.content;
                        }
                        else if (Array.isArray(entry.message.content)) {
                            text = entry.message.content
                                .filter((b) => b.type === 'text')
                                .map((b) => b.text)
                                .join('\n');
                        }
                    }
                    else if (typeof entry.content === 'string') {
                        text = entry.content;
                    }
                    else if (Array.isArray(entry.content)) {
                        text = entry.content
                            .filter((b) => b.type === 'text')
                            .map((b) => b.text)
                            .join('\n');
                    }
                    if (text) {
                        messages.push({ role: 'user', content: text, timestamp: entry.timestamp });
                    }
                }
                if (entry.type === 'assistant' || entry.role === 'assistant') {
                    let text = '';
                    if (typeof entry.message === 'string') {
                        text = entry.message;
                    }
                    else if (entry.message?.content) {
                        if (typeof entry.message.content === 'string') {
                            text = entry.message.content;
                        }
                        else if (Array.isArray(entry.message.content)) {
                            text = entry.message.content
                                .filter((b) => b.type === 'text')
                                .map((b) => b.text)
                                .join('\n');
                        }
                    }
                    else if (typeof entry.content === 'string') {
                        text = entry.content;
                    }
                    else if (Array.isArray(entry.content)) {
                        text = entry.content
                            .filter((b) => b.type === 'text')
                            .map((b) => b.text)
                            .join('\n');
                    }
                    if (text) {
                        messages.push({ role: 'assistant', content: text, timestamp: entry.timestamp });
                    }
                }
            }
            catch {
                // Skip unparseable lines
            }
        }
        return { ...session, messages };
    }
    // ─── Codex (OpenAI) ───────────────────────────────────────────────────
    async scanCodexSessions() {
        const sessions = [];
        const codexBase = (0, agentPaths_1.getAgentRoot)('codex', this.getOverrides());
        // 1) Scan rollout files in ~/.codex/sessions/YYYY/MM/DD/*.jsonl
        const sessionsDir = path_1.default.join(codexBase, 'sessions');
        try {
            await this.walkCodexDir(sessionsDir, sessions);
        }
        catch {
            // sessions directory doesn't exist
        }
        // 2) Scan ~/.codex/history.jsonl (flat prompt history grouped by session_id)
        const historyFile = path_1.default.join(codexBase, 'history.jsonl');
        try {
            await this.parseCodexHistoryFile(historyFile, sessions);
        }
        catch {
            // history file doesn't exist
        }
        // 3) SQLite owns generated metadata and supplies sessions that were not
        // found through the rollout compatibility paths.
        this.enrichCodexSessionsFromStateDb(codexBase, sessions);
        // 4) Codex `/rename` appends explicit names to session_index.jsonl. The
        // newest index entry must win over SQLite's generated `threads.title`.
        await this.enrichCodexSessionsFromIndex(codexBase, sessions);
        return sessions;
    }
    async enrichCodexSessionsFromIndex(codexBase, sessions) {
        try {
            const indexContent = await fs_1.promises.readFile(path_1.default.join(codexBase, 'session_index.jsonl'), 'utf8');
            const nameMap = new Map();
            for (const line of indexContent.split('\n')) {
                if (!line.trim())
                    continue;
                try {
                    const entry = JSON.parse(line);
                    if (typeof entry.id === 'string' && typeof entry.thread_name === 'string' && entry.thread_name.trim()) {
                        nameMap.set(entry.id, entry.thread_name.trim());
                    }
                }
                catch {
                    // Ignore a partial final record from a concurrently active Codex.
                }
            }
            for (const session of sessions) {
                const name = nameMap.get(session.id);
                if (name)
                    session.sessionName = name;
            }
        }
        catch {
            // Older Codex versions may not have session_index.jsonl yet.
        }
    }
    enrichCodexSessionsFromStateDb(codexBase, sessions, options = {}) {
        const dbPath = path_1.default.join(codexBase, 'state_5.sqlite');
        let db = null;
        try {
            db = new better_sqlite3_1.default(dbPath, { readonly: true, fileMustExist: true });
            const rows = db.prepare(`
        SELECT
          id,
          rollout_path,
          created_at,
          updated_at,
          model_provider,
          cwd,
          title,
          has_user_event,
          git_branch,
          first_user_message,
          model,
          created_at_ms,
          updated_at_ms,
          preview,
          recency_at,
          recency_at_ms
        FROM threads
      `).all();
            const byId = new Map();
            const byPath = new Map();
            for (const session of sessions) {
                byId.set(session.id, session);
                if (session.filePath) {
                    byPath.set(this.normalizePath(session.filePath), session);
                }
            }
            for (const row of rows) {
                if (!row.id)
                    continue;
                const rolloutPath = (row.rollout_path || '').trim();
                const session = byId.get(row.id) || (rolloutPath ? byPath.get(this.normalizePath(rolloutPath)) : undefined);
                const title = (row.title || '').trim();
                const firstPrompt = (row.first_user_message || '').trim();
                const sessionTitle = title && title !== firstPrompt ? title.slice(0, 300) : '';
                const preview = (row.preview || '').trim();
                const cwd = (row.cwd || '').trim();
                const startedAt = this.codexThreadTimeMs(row.created_at_ms, row.created_at);
                const lastActivityAt = this.codexThreadTimeMs(row.recency_at_ms, row.recency_at) ||
                    this.codexThreadTimeMs(row.updated_at_ms, row.updated_at);
                const model = (row.model || row.model_provider || '').trim();
                const hasUserEvent = row.has_user_event === 1 || firstPrompt.length > 0;
                if (session) {
                    if (sessionTitle)
                        session.sessionName = sessionTitle;
                    if (firstPrompt && !session.firstPrompt)
                        session.firstPrompt = firstPrompt.slice(0, 300);
                    if (preview)
                        session.lastAssistantPreview = preview.slice(-500);
                    if (cwd) {
                        session.cwd = cwd;
                        session.projectPath = cwd;
                    }
                    if (startedAt)
                        session.startedAt = startedAt;
                    if (lastActivityAt)
                        session.lastActivityAt = lastActivityAt;
                    if (rolloutPath)
                        session.filePath = rolloutPath;
                    if (row.git_branch)
                        session.gitBranch = row.git_branch;
                    if (model)
                        session.model = model;
                    if (hasUserEvent && session.messageCount < 1)
                        session.messageCount = 1;
                    continue;
                }
                if (options.addMissing === false || !rolloutPath)
                    continue;
                const created = startedAt || Date.now();
                const activity = lastActivityAt || created;
                const next = {
                    id: row.id,
                    agentType: 'codex',
                    cwd,
                    startedAt: created,
                    lastActivityAt: activity,
                    firstPrompt: firstPrompt.slice(0, 300),
                    sessionName: sessionTitle || undefined,
                    lastAssistantPreview: preview ? preview.slice(-500) : undefined,
                    messageCount: hasUserEvent ? 1 : 0,
                    isActive: false,
                    filePath: rolloutPath,
                    projectPath: cwd || undefined,
                    gitBranch: row.git_branch || undefined,
                    model: model || undefined,
                };
                sessions.push(next);
                byId.set(next.id, next);
                byPath.set(this.normalizePath(next.filePath), next);
            }
        }
        catch {
            // Older Codex versions don't have this DB/table; JSONL parsing remains
            // the compatibility path.
        }
        finally {
            db?.close();
        }
    }
    codexThreadTimeMs(ms, seconds) {
        if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0)
            return ms;
        if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0)
            return seconds * 1000;
        return 0;
    }
    async walkCodexDir(dir, sessions) {
        try {
            const entries = await fs_1.promises.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path_1.default.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await this.walkCodexDir(fullPath, sessions);
                }
                else if (entry.name.endsWith('.jsonl')) {
                    try {
                        const session = await this.parseCodexRolloutFile(fullPath);
                        if (session)
                            sessions.push(session);
                    }
                    catch {
                        // Skip unparseable files
                    }
                }
            }
        }
        catch {
            // Skip unreadable directories
        }
    }
    /**
     * Parse a Codex rollout file.
     * Format: each line is {timestamp, type, payload}
     *   type "session_meta" → payload: {id, cwd, timestamp, cli_version, ...}
     *   type "response_item" → payload: {type: "message", role, content: [{type: "input_text", text}]}
     */
    async parseCodexRolloutFile(filePath) {
        const stat = await fs_1.promises.stat(filePath);
        const handle = await fs_1.promises.open(filePath, 'r');
        try {
            // Read enough to get past Codex's developer/system preambles.
            const buffer = Buffer.alloc(CODEX_ROLLOUT_HEAD_BYTES);
            const { bytesRead } = await handle.read(buffer, 0, CODEX_ROLLOUT_HEAD_BYTES, 0);
            const chunk = buffer.toString('utf8', 0, bytesRead);
            const lines = chunk.split('\n').filter((l) => l.trim());
            let sessionId = '';
            let cwd = '';
            let firstPrompt = '';
            let startedAt = 0;
            let messageCount = 0;
            let gitBranch = '';
            let model = '';
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line);
                    // Session metadata: {type: "session_meta", payload: {id, cwd, timestamp}}
                    if (entry.type === 'session_meta' && entry.payload) {
                        sessionId = entry.payload.id || '';
                        cwd = entry.payload.cwd || '';
                        if (entry.payload.timestamp) {
                            startedAt = new Date(entry.payload.timestamp).getTime();
                        }
                        if (entry.payload.git?.branch) {
                            gitBranch = entry.payload.git.branch;
                        }
                        if (entry.payload.model_provider) {
                            model = entry.payload.model_provider;
                        }
                        continue;
                    }
                    // Messages: {type: "response_item", payload: {role, content: [...]}}
                    if (entry.type === 'response_item' && entry.payload) {
                        const role = entry.payload.role;
                        // Skip developer/system messages
                        if (role === 'developer')
                            continue;
                        if (role === 'user') {
                            const text = this.extractCodexText(entry.payload.content);
                            if (text && !this.isCodexPreamble(text)) {
                                messageCount++;
                                if (!firstPrompt)
                                    firstPrompt = text;
                            }
                        }
                        else if (role === 'assistant') {
                            const text = this.extractCodexText(entry.payload.content);
                            if (text)
                                messageCount++;
                        }
                    }
                }
                catch {
                    // Skip unparseable lines
                }
            }
            if (!sessionId) {
                // Extract ID from filename: rollout-2026-03-19T15-32-38-019d0539-a97f-....jsonl
                const basename = path_1.default.basename(filePath, '.jsonl');
                const match = basename.match(/rollout-[\dT-]+-(.+)/);
                sessionId = match ? match[1] : basename;
            }
            // Allow sessions without firstPrompt for detection (session continuity)
            // The resume panel still filters by firstPrompt via scanSessions
            if (!firstPrompt && !sessionId)
                return null;
            // Read last 16KB to extract last assistant message for preview
            let lastAssistantPreview;
            const tailSize = 16384;
            const fileSize = stat.size;
            if (fileSize > tailSize) {
                const tailBuffer = Buffer.alloc(tailSize);
                const { bytesRead: tailBytesRead } = await handle.read(tailBuffer, 0, tailSize, fileSize - tailSize);
                const tailChunk = tailBuffer.toString('utf8', 0, tailBytesRead);
                const tailLines = tailChunk.split('\n').filter((l) => l.trim());
                for (let i = tailLines.length - 1; i >= 0; i--) {
                    try {
                        const entry = JSON.parse(tailLines[i]);
                        if (entry.type === 'response_item' && entry.payload?.role === 'assistant') {
                            const text = this.extractCodexText(entry.payload.content);
                            if (text?.trim()) {
                                lastAssistantPreview = text.trim().slice(-500);
                                break;
                            }
                        }
                    }
                    catch {
                        // Skip
                    }
                }
            }
            return {
                id: sessionId,
                agentType: 'codex',
                cwd: cwd || '',
                startedAt: startedAt || stat.birthtimeMs,
                lastActivityAt: stat.mtimeMs,
                firstPrompt: firstPrompt.slice(0, 300),
                lastAssistantPreview,
                messageCount: Math.ceil(messageCount / 2),
                isActive: false,
                filePath,
                projectPath: cwd || undefined,
                gitBranch: gitBranch || undefined,
                model: model || undefined,
            };
        }
        finally {
            await handle.close();
        }
    }
    /**
     * Parse ~/.codex/history.jsonl — flat prompt history.
     * Format: {session_id, ts, text}
     * Groups by session_id, creates one AISession per unique session_id.
     * Skips sessions already found in rollout files.
     */
    async parseCodexHistoryFile(filePath, existingSessions) {
        const stat = await fs_1.promises.stat(filePath);
        const content = await fs_1.promises.readFile(filePath, 'utf8');
        const lines = content.split('\n').filter((l) => l.trim());
        // Group by session_id
        const sessionMap = new Map();
        const existingIds = new Set(existingSessions.map((s) => s.id));
        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (!entry.session_id || !entry.text)
                    continue;
                // Skip if already found in rollout files
                if (existingIds.has(entry.session_id))
                    continue;
                if (!sessionMap.has(entry.session_id)) {
                    sessionMap.set(entry.session_id, []);
                }
                sessionMap.get(entry.session_id).push({
                    ts: (entry.ts || 0) * 1000, // ts is in seconds
                    text: entry.text,
                });
            }
            catch {
                // Skip unparseable lines
            }
        }
        for (const [sid, prompts] of sessionMap) {
            if (prompts.length === 0)
                continue;
            prompts.sort((a, b) => a.ts - b.ts);
            existingSessions.push({
                id: sid,
                agentType: 'codex',
                cwd: '',
                startedAt: prompts[0].ts || stat.birthtimeMs,
                lastActivityAt: prompts[prompts.length - 1].ts || stat.mtimeMs,
                firstPrompt: prompts[0].text.slice(0, 300),
                messageCount: prompts.length,
                isActive: false,
                filePath,
            });
        }
    }
    /** Extract user-visible text from Codex content array or payload */
    extractCodexText(content) {
        if (!content)
            return '';
        if (typeof content === 'string')
            return content;
        if (Array.isArray(content)) {
            return content
                .filter((c) => c.type === 'input_text' || c.type === 'output_text' || c.type === 'text')
                .map((c) => c.text || '')
                .join('\n')
                .trim();
        }
        return '';
    }
    /** Detect Codex system preamble injected as "user" role (AGENTS.md, environment_context, etc.) */
    isCodexPreamble(text) {
        const t = text.slice(0, 200);
        return t.includes('# AGENTS.md instructions') ||
            t.includes('<environment_context>') ||
            t.includes('<permissions instructions>') ||
            t.includes('<collaboration_mode>') ||
            t.includes('sandbox_mode');
    }
    getCodexRolloutPathFromStateDb(codexBase, sessionId) {
        const dbPath = path_1.default.join(codexBase, 'state_5.sqlite');
        let db = null;
        try {
            db = new better_sqlite3_1.default(dbPath, { readonly: true, fileMustExist: true });
            const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ? LIMIT 1').get(sessionId);
            const rolloutPath = row?.rollout_path?.trim();
            if (!rolloutPath)
                return null;
            return path_1.default.isAbsolute(rolloutPath) ? rolloutPath : path_1.default.join(codexBase, rolloutPath);
        }
        catch {
            return null;
        }
        finally {
            db?.close();
        }
    }
    async findCodexRolloutPathBySessionId(sessionsDir, sessionId) {
        if (!sessionId || /[\\/]/.test(sessionId))
            return null;
        const expectedName = `${sessionId}.jsonl`;
        const expectedSuffix = `-${expectedName}`;
        const walk = async (dir) => {
            let entries;
            try {
                entries = await fs_1.promises.readdir(dir, { withFileTypes: true });
            }
            catch {
                return null;
            }
            for (const entry of entries) {
                if (!entry.isFile())
                    continue;
                if (entry.name === expectedName || entry.name.endsWith(expectedSuffix)) {
                    return path_1.default.join(dir, entry.name);
                }
            }
            // Codex stores rollouts under YYYY/MM/DD. Searching newest directories
            // first makes the no-SQLite compatibility path fast for active sessions.
            const directories = entries
                .filter((entry) => entry.isDirectory())
                .sort((a, b) => b.name.localeCompare(a.name));
            for (const entry of directories) {
                const match = await walk(path_1.default.join(dir, entry.name));
                if (match)
                    return match;
            }
            return null;
        };
        return walk(sessionsDir);
    }
    async getCodexSessionDetail(sessionId) {
        const codexBase = (0, agentPaths_1.getAgentRoot)('codex', this.getOverrides());
        const stateDbPath = this.getCodexRolloutPathFromStateDb(codexBase, sessionId);
        const tryDirectPath = async (directPath) => {
            if (!directPath)
                return null;
            try {
                const session = await this.parseCodexRolloutFile(directPath);
                if (session?.id === sessionId) {
                    this.enrichCodexSessionsFromStateDb(codexBase, [session], { addMissing: false });
                    await this.enrichCodexSessionsFromIndex(codexBase, [session]);
                    return this.getCodexSessionDetailFromSession(session);
                }
            }
            catch {
                // Fall through to the compatibility scan below. A stale SQLite path or
                // partially-written active rollout must not make detail lookup fail.
            }
            return null;
        };
        const stateDbDetail = await tryDirectPath(stateDbPath);
        if (stateDbDetail)
            return stateDbDetail;
        const filenamePath = await this.findCodexRolloutPathBySessionId(path_1.default.join(codexBase, 'sessions'), sessionId);
        if (filenamePath !== stateDbPath) {
            const filenameDetail = await tryDirectPath(filenamePath);
            if (filenameDetail)
                return filenameDetail;
        }
        // Compatibility for legacy/nonstandard files whose name does not carry the
        // session id. This is deliberately last: Reader Mode usually already has
        // the exact id and must not parse every Codex rollout before first paint.
        const sessions = await this.scanCodexSessions();
        const session = sessions.find((s) => s.id === sessionId);
        if (!session)
            return null;
        return this.getCodexSessionDetailFromSession(session);
    }
    async getCodexSessionDetailFromSession(session) {
        // If the session comes from history.jsonl, return prompts only (no assistant messages)
        if (session.filePath.endsWith('history.jsonl')) {
            const content = await fs_1.promises.readFile(session.filePath, 'utf8');
            const lines = content.split('\n').filter((l) => l.trim());
            const messages = [];
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line);
                    if (entry.session_id === session.id && entry.text) {
                        messages.push({
                            role: 'user',
                            content: entry.text,
                            timestamp: entry.ts ? new Date(entry.ts * 1000).toISOString() : undefined,
                        });
                    }
                }
                catch {
                    // Skip
                }
            }
            return { ...session, messages };
        }
        // Rollout file — parse response_item entries
        const content = await fs_1.promises.readFile(session.filePath, 'utf8');
        const lines = content.split('\n').filter((l) => l.trim());
        const messages = [];
        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (entry.type !== 'response_item' || !entry.payload)
                    continue;
                const role = entry.payload.role;
                if (role === 'developer')
                    continue;
                if (role === 'user') {
                    const text = this.extractCodexText(entry.payload.content);
                    if (text && !this.isCodexPreamble(text)) {
                        messages.push({ role: 'user', content: text, timestamp: entry.timestamp });
                    }
                }
                else if (role === 'assistant') {
                    const text = this.extractCodexText(entry.payload.content);
                    if (text)
                        messages.push({ role: 'assistant', content: text, timestamp: entry.timestamp });
                }
            }
            catch {
                // Skip
            }
        }
        return { ...session, messages };
    }
    // ─── Gemini CLI ────────────────────────────────────────────────────────
    // Sessions stored in ~/.gemini/tmp/<project-name>/chats/session-*.json
    // Format: {sessionId, startTime, messages: [{type: "user"|"model", content: [{text}]}]}
    // Project mapping in ~/.gemini/projects.json: {projects: {"/abs/path": "project-name"}}
    async scanGeminiSessions() {
        const sessions = [];
        const geminiBase = (0, agentPaths_1.getAgentRoot)('gemini', this.getOverrides());
        const tmpDir = path_1.default.join(geminiBase, 'tmp');
        try {
            const projectDirs = await fs_1.promises.readdir(tmpDir, { withFileTypes: true });
            for (const dir of projectDirs) {
                if (!dir.isDirectory())
                    continue;
                const chatsDir = path_1.default.join(tmpDir, dir.name, 'chats');
                try {
                    const files = await fs_1.promises.readdir(chatsDir);
                    const sessionFiles = files.filter((f) => f.startsWith('session-') && (f.endsWith('.json') || f.endsWith('.jsonl')));
                    for (const file of sessionFiles) {
                        try {
                            const filePath = path_1.default.join(chatsDir, file);
                            const session = await this.parseGeminiSessionFile(filePath, dir.name);
                            if (session)
                                sessions.push(session);
                        }
                        catch {
                            // Skip unparseable files
                        }
                    }
                }
                catch {
                    // No chats dir for this project
                }
            }
        }
        catch {
            // tmp directory doesn't exist
        }
        return sessions;
    }
    parseGeminiConversationContent(content) {
        const trimmed = content.trim();
        if (!trimmed)
            return {};
        // Legacy Gemini stored one JSON object. Current Gemini uses append-only
        // JSONL: initial metadata, message records, then {$set:{...}} metadata
        // patches. Folding the patches mirrors Gemini's own loader.
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed;
            }
        }
        catch {
            // Multiple top-level JSON values means the current append-only format.
        }
        const metadata = {};
        const messages = [];
        for (const line of content.split('\n')) {
            if (!line.trim())
                continue;
            try {
                const parsed = JSON.parse(line);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                    continue;
                const record = parsed;
                if (record.$set && typeof record.$set === 'object' && !Array.isArray(record.$set)) {
                    Object.assign(metadata, record.$set);
                }
                else if (typeof record.type === 'string') {
                    messages.push(record);
                }
                else {
                    Object.assign(metadata, record);
                }
            }
            catch {
                // Ignore a partial final line from a concurrently active Gemini.
            }
        }
        return { ...metadata, messages };
    }
    /** Parse legacy JSON and current append-only JSONL Gemini sessions. */
    async parseGeminiSessionFile(filePath, projectName) {
        const stat = await fs_1.promises.stat(filePath);
        const content = await fs_1.promises.readFile(filePath, 'utf8');
        try {
            const data = this.parseGeminiConversationContent(content);
            const sessionId = typeof data.sessionId === 'string'
                ? data.sessionId
                : path_1.default.basename(filePath).replace(/\.jsonl?$/, '');
            const messages = Array.isArray(data.messages) ? data.messages : [];
            let firstPrompt = '';
            let messageCount = 0;
            for (const msg of messages) {
                const text = this.extractGeminiText(msg.content);
                if (msg.type === 'user') {
                    messageCount++;
                    if (!firstPrompt && text)
                        firstPrompt = text;
                }
                else if (msg.type === 'model' || msg.type === 'gemini') {
                    if (text)
                        messageCount++;
                }
            }
            if (!firstPrompt)
                return null;
            // Get last assistant message for preview
            let lastAssistantPreview;
            for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].type === 'model' || messages[i].type === 'gemini') {
                    const text = this.extractGeminiText(messages[i].content);
                    if (text?.trim()) {
                        lastAssistantPreview = text.trim().slice(-500);
                        break;
                    }
                }
            }
            const startedAt = typeof data.startTime === 'string' ? new Date(data.startTime).getTime() : stat.birthtimeMs;
            const lastActivity = typeof data.lastUpdated === 'string' ? new Date(data.lastUpdated).getTime() : stat.mtimeMs;
            const explicitTitle = typeof data.summary === 'string' && data.summary.trim()
                ? data.summary.trim()
                : typeof data.title === 'string' && data.title.trim()
                    ? data.title.trim()
                    : '';
            return {
                id: sessionId,
                agentType: 'gemini',
                cwd: '',
                startedAt,
                lastActivityAt: lastActivity,
                firstPrompt: firstPrompt.slice(0, 300),
                sessionName: explicitTitle || undefined,
                lastAssistantPreview,
                messageCount: Math.ceil(messageCount / 2),
                isActive: false,
                filePath,
                projectPath: projectName,
            };
        }
        catch {
            return null;
        }
    }
    /** Extract text from Gemini content array: [{text: "..."}] */
    extractGeminiText(content) {
        if (!content)
            return '';
        if (typeof content === 'string')
            return content;
        if (Array.isArray(content)) {
            return content
                .map((c) => c.text || '')
                .join('\n')
                .trim();
        }
        return '';
    }
    async getGeminiSessionDetail(sessionId) {
        const sessions = await this.scanGeminiSessions();
        const session = sessions.find((s) => s.id === sessionId);
        if (!session)
            return null;
        return this.getGeminiSessionDetailFromSession(session);
    }
    async getGeminiSessionDetailFromSession(session) {
        const content = await fs_1.promises.readFile(session.filePath, 'utf8');
        const messages = [];
        try {
            const data = this.parseGeminiConversationContent(content);
            const storedMessages = Array.isArray(data.messages) ? data.messages : [];
            for (const msg of storedMessages) {
                const text = this.extractGeminiText(msg.content);
                if (text) {
                    messages.push({
                        role: msg.type === 'model' || msg.type === 'gemini' ? 'assistant' : 'user',
                        content: text,
                        timestamp: typeof msg.timestamp === 'string' ? msg.timestamp : undefined,
                    });
                }
            }
        }
        catch {
            // Skip unparseable
        }
        return { ...session, messages };
    }
    // ─── Kimi Code ───────────────────────────────────────────────────────
    // Current Kimi sessions are indexed by $KIMI_CODE_HOME/session_index.jsonl
    // (default ~/.kimi-code) and store the main transcript at
    // <sessionDir>/agents/main/wire.jsonl. The index is append-only and may
    // contain deletion tombstones, so the last valid record for an id wins.
    kimiHome() {
        return (0, kimiPaths_1.getKimiHome)();
    }
    async readKimiSessionIndex() {
        const home = this.kimiHome();
        const sessionsRoot = path_1.default.resolve(home, 'sessions');
        const entries = new Map();
        let content;
        try {
            content = await fs_1.promises.readFile(path_1.default.join(home, 'session_index.jsonl'), 'utf8');
        }
        catch {
            return entries;
        }
        for (const line of content.split(/\r?\n/)) {
            if (!line.trim())
                continue;
            try {
                const parsed = JSON.parse(line);
                const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : '';
                if (!SESSION_ID_RE.test(sessionId))
                    continue;
                if (parsed.deleted === true) {
                    entries.delete(sessionId);
                    continue;
                }
                if (typeof parsed.sessionDir !== 'string' || !path_1.default.isAbsolute(parsed.sessionDir))
                    continue;
                const sessionDir = path_1.default.resolve(parsed.sessionDir);
                const relative = path_1.default.relative(sessionsRoot, sessionDir);
                if (!relative || relative.startsWith('..') || path_1.default.isAbsolute(relative))
                    continue;
                if (path_1.default.basename(sessionDir) !== sessionId)
                    continue;
                entries.set(sessionId, {
                    sessionId,
                    sessionDir,
                    workDir: typeof parsed.workDir === 'string' ? parsed.workDir : '',
                });
            }
            catch {
                // Ignore a malformed or concurrently partial index line.
            }
        }
        return entries;
    }
    parseKimiTimestamp(value, fallback) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value > 0 && value < 1_000_000_000_000 ? value * 1000 : value;
        }
        if (typeof value === 'string') {
            const parsed = Date.parse(value);
            if (Number.isFinite(parsed))
                return parsed;
        }
        return fallback;
    }
    extractKimiText(content) {
        if (typeof content === 'string')
            return content.trim();
        if (!Array.isArray(content))
            return '';
        return content
            .map((part) => {
            if (!part || typeof part !== 'object' || Array.isArray(part))
                return '';
            const record = part;
            return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
        })
            .filter(Boolean)
            .join('\n')
            .trim();
    }
    parseKimiWire(content) {
        const records = [];
        for (const line of content.split(/\r?\n/)) {
            if (!line.trim())
                continue;
            try {
                const parsed = JSON.parse(line);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    records.push(parsed);
                }
            }
            catch {
                // The first/last bounded-window line or a live final line may be partial.
            }
        }
        const hasTurnPrompt = records.some((record) => record.type === 'turn.prompt');
        const hasAssistantAppend = records.some((record) => {
            if (record.type !== 'context.append_message')
                return false;
            const message = record.message;
            return Boolean(message && typeof message === 'object' && !Array.isArray(message)
                && message.role === 'assistant');
        });
        const messages = [];
        const stepTexts = new Map();
        let cwd;
        let model;
        const timestamp = (value) => {
            const millis = this.parseKimiTimestamp(value, 0);
            return millis > 0 ? new Date(millis).toISOString() : undefined;
        };
        const push = (role, text, time) => {
            const cleaned = text.trim();
            if (!cleaned)
                return;
            const previous = messages[messages.length - 1];
            if (previous?.role === role && previous.content === cleaned)
                return;
            messages.push({ role, content: cleaned, timestamp: time });
        };
        for (const record of records) {
            if (record.type === 'config.update') {
                if (typeof record.cwd === 'string' && record.cwd)
                    cwd = record.cwd;
                if (typeof record.modelAlias === 'string' && record.modelAlias)
                    model = record.modelAlias;
                else if (typeof record.model === 'string' && record.model)
                    model = record.model;
                continue;
            }
            if (record.type === 'turn.prompt') {
                const origin = record.origin;
                const originKind = origin && typeof origin === 'object' && !Array.isArray(origin)
                    ? origin.kind
                    : undefined;
                if (originKind === undefined || originKind === 'user') {
                    push('user', this.extractKimiText(record.input), timestamp(record.time));
                }
                continue;
            }
            if (record.type === 'context.append_message') {
                const rawMessage = record.message;
                if (!rawMessage || typeof rawMessage !== 'object' || Array.isArray(rawMessage))
                    continue;
                const message = rawMessage;
                if (message.role === 'user' && !hasTurnPrompt) {
                    push('user', this.extractKimiText(message.content), timestamp(record.time));
                }
                else if (message.role === 'assistant') {
                    push('assistant', this.extractKimiText(message.content), timestamp(record.time));
                }
                continue;
            }
            if (record.type !== 'context.append_loop_event' || hasAssistantAppend)
                continue;
            const rawEvent = record.event;
            if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent))
                continue;
            const event = rawEvent;
            if (event.type === 'step.begin' && typeof event.uuid === 'string') {
                stepTexts.set(event.uuid, { text: '', time: timestamp(record.time) });
            }
            else if (event.type === 'content.part') {
                const stepUuid = typeof event.stepUuid === 'string' ? event.stepUuid : '';
                const partText = this.extractKimiText([event.part]);
                if (!stepUuid || !partText)
                    continue;
                const step = stepTexts.get(stepUuid) ?? { text: '', time: timestamp(record.time) };
                step.text += partText;
                stepTexts.set(stepUuid, step);
            }
            else if (event.type === 'step.end' && typeof event.uuid === 'string') {
                const step = stepTexts.get(event.uuid);
                if (step)
                    push('assistant', step.text, step.time);
                stepTexts.delete(event.uuid);
            }
        }
        for (const step of stepTexts.values())
            push('assistant', step.text, step.time);
        return { messages, cwd, model };
    }
    async readKimiWireWindow(filePath, fromEnd) {
        const handle = await fs_1.promises.open(filePath, 'r');
        try {
            const stat = await handle.stat();
            const length = Math.min(stat.size, KIMI_WIRE_WINDOW_BYTES);
            if (length === 0)
                return '';
            const start = fromEnd ? Math.max(0, stat.size - length) : 0;
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, start);
            let text = buffer.toString('utf8', 0, bytesRead);
            if (start > 0) {
                const firstNewline = text.indexOf('\n');
                text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
            }
            else if (start + bytesRead < stat.size) {
                const lastNewline = text.lastIndexOf('\n');
                text = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : '';
            }
            return text;
        }
        finally {
            await handle.close();
        }
    }
    async parseKimiSession(entry) {
        const statePath = path_1.default.join(entry.sessionDir, 'state.json');
        const wirePath = path_1.default.join(entry.sessionDir, 'agents', 'main', 'wire.jsonl');
        const [stateContent, stateStat, wireStat, head, tail] = await Promise.all([
            fs_1.promises.readFile(statePath, 'utf8'),
            fs_1.promises.stat(statePath),
            fs_1.promises.stat(wirePath),
            this.readKimiWireWindow(wirePath, false),
            this.readKimiWireWindow(wirePath, true),
        ]);
        const state = JSON.parse(stateContent);
        if (state.archived === true)
            return null;
        const custom = state.custom;
        if (custom && typeof custom === 'object' && !Array.isArray(custom)
            && custom.imported_from_kimi_cli === true)
            return null;
        const headData = this.parseKimiWire(head);
        const tailData = head === tail ? headData : this.parseKimiWire(tail);
        const firstPrompt = headData.messages.find((message) => message.role === 'user')?.content
            || (typeof state.lastPrompt === 'string' ? state.lastPrompt.trim() : '');
        if (!firstPrompt)
            return null;
        const lastAssistantPreview = [...tailData.messages].reverse()
            .find((message) => message.role === 'assistant')?.content.trim().slice(-500);
        const stateCwd = typeof state.cwd === 'string' ? state.cwd : '';
        const cwd = stateCwd || headData.cwd || tailData.cwd || entry.workDir;
        const sessionName = typeof state.title === 'string' && state.title.trim()
            ? state.title.trim()
            : undefined;
        const startedFallback = Math.min(stateStat.birthtimeMs || stateStat.mtimeMs, wireStat.birthtimeMs || wireStat.mtimeMs);
        const activityFallback = Math.max(stateStat.mtimeMs, wireStat.mtimeMs);
        const promptKeys = new Set([...headData.messages, ...tailData.messages]
            .filter((message) => message.role === 'user')
            .map((message) => `${message.timestamp ?? ''}\u0000${message.content}`));
        return {
            id: entry.sessionId,
            agentType: 'kimi',
            cwd,
            startedAt: this.parseKimiTimestamp(state.createdAt, startedFallback),
            lastActivityAt: this.parseKimiTimestamp(state.updatedAt, activityFallback),
            firstPrompt: firstPrompt.slice(0, 300),
            sessionName,
            lastAssistantPreview,
            messageCount: Math.max(1, promptKeys.size),
            isActive: false,
            filePath: wirePath,
            projectPath: cwd || entry.workDir || undefined,
            model: headData.model || tailData.model,
        };
    }
    async scanKimiSessions() {
        const candidates = [];
        await this.collectKimiCandidates(candidates);
        const settled = await Promise.allSettled(candidates.map((candidate) => candidate.parse()));
        return settled.flatMap((result) => result.status === 'fulfilled' && result.value ? [result.value] : []);
    }
    async getKimiSessionDetail(sessionId) {
        const entry = (await this.readKimiSessionIndex()).get(sessionId);
        if (!entry)
            return null;
        const session = await this.parseKimiSession(entry);
        return session ? this.getKimiSessionDetailFromSession(session) : null;
    }
    async getKimiSessionDetailFromSession(session) {
        const wire = await fs_1.promises.readFile(session.filePath, 'utf8');
        const parsed = this.parseKimiWire(wire);
        return {
            ...session,
            messageCount: parsed.messages.filter((message) => message.role === 'user').length,
            messages: parsed.messages,
        };
    }
    // ─── Qwen Code ──────────────────────────────────────────────────────
    // Sessions stored in ~/.qwen/projects/<encoded-path>/chats/*.jsonl
    // Format: each line is JSON with {type, sessionId, timestamp, message: {role, parts: [{text}]}}
    // Uses same path encoding as Claude Code (replace '/' with '-')
    async scanQwenSessions() {
        const sessions = [];
        const qwenDir = path_1.default.join((0, agentPaths_1.getAgentRoot)('qwen', this.getOverrides()), 'projects');
        try {
            const projectDirs = await fs_1.promises.readdir(qwenDir, { withFileTypes: true });
            for (const dir of projectDirs) {
                if (!dir.isDirectory())
                    continue;
                const chatsDir = path_1.default.join(qwenDir, dir.name, 'chats');
                const decodedPath = await this.decodeClaudeProjectPath(dir.name);
                try {
                    const files = await fs_1.promises.readdir(chatsDir);
                    const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
                    for (const file of jsonlFiles) {
                        try {
                            const filePath = path_1.default.join(chatsDir, file);
                            const session = await this.parseQwenSessionFile(filePath, decodedPath);
                            if (session)
                                sessions.push(session);
                        }
                        catch {
                            // Skip unparseable files
                        }
                    }
                }
                catch {
                    // No chats dir for this project
                }
            }
        }
        catch {
            // Qwen directory doesn't exist
        }
        return sessions;
    }
    /** Extract text from Qwen parts array: [{text: "...", thought?: boolean}] */
    extractQwenText(parts) {
        if (!parts)
            return '';
        if (typeof parts === 'string')
            return parts;
        if (Array.isArray(parts)) {
            return parts
                .filter((p) => p.text && !p.thought)
                .map((p) => p.text || '')
                .join('\n')
                .trim();
        }
        return '';
    }
    async parseQwenSessionFile(filePath, projectPath) {
        const stat = await fs_1.promises.stat(filePath);
        const handle = await fs_1.promises.open(filePath, 'r');
        try {
            // Read first 16KB to extract metadata efficiently
            const buffer = Buffer.alloc(16384);
            const { bytesRead } = await handle.read(buffer, 0, 16384, 0);
            const chunk = buffer.toString('utf8', 0, bytesRead);
            const lines = chunk.split('\n').filter((l) => l.trim());
            let sessionId = '';
            let firstPrompt = '';
            let startedAt = 0;
            let messageCount = 0;
            let cwd = '';
            let customTitle = '';
            for (const line of lines) {
                try {
                    const entry = JSON.parse(line);
                    if (entry.type === 'custom-title' && typeof entry.customTitle === 'string' && entry.customTitle.trim()) {
                        customTitle = entry.customTitle.trim();
                    }
                    // Qwen also records the real launch directory per entry.
                    // Prefer it over the encoded project folder for Windows punctuation.
                    if (!cwd && typeof entry.cwd === 'string' && entry.cwd.trim()) {
                        cwd = entry.cwd.trim();
                    }
                    if (!sessionId && entry.sessionId) {
                        sessionId = entry.sessionId;
                    }
                    if (entry.type === 'user') {
                        messageCount++;
                        if (!firstPrompt) {
                            firstPrompt = this.extractQwenText(entry.message?.parts);
                            if (!startedAt && entry.timestamp) {
                                startedAt = new Date(entry.timestamp).getTime();
                            }
                        }
                    }
                    if (entry.type === 'assistant') {
                        messageCount++;
                    }
                }
                catch {
                    // Skip unparseable lines
                }
            }
            if (!sessionId) {
                sessionId = path_1.default.basename(filePath, '.jsonl');
            }
            if (!firstPrompt && !sessionId) {
                return null;
            }
            // Read last 16KB to extract last assistant message for preview
            let lastAssistantPreview;
            const tailSize = 16384;
            const fileSize = stat.size;
            if (fileSize > tailSize) {
                const tailBuffer = Buffer.alloc(tailSize);
                const { bytesRead: tailBytesRead } = await handle.read(tailBuffer, 0, tailSize, fileSize - tailSize);
                const tailChunk = tailBuffer.toString('utf8', 0, tailBytesRead);
                const tailLines = tailChunk.split('\n').filter((l) => l.trim());
                for (const line of tailLines) {
                    try {
                        const entry = JSON.parse(line);
                        if (entry.type === 'custom-title' && typeof entry.customTitle === 'string' && entry.customTitle.trim()) {
                            customTitle = entry.customTitle.trim();
                        }
                    }
                    catch {
                        // The tail can start in the middle of a JSON record.
                    }
                }
                for (let i = tailLines.length - 1; i >= 0; i--) {
                    try {
                        const entry = JSON.parse(tailLines[i]);
                        if (entry.type === 'assistant') {
                            const text = this.extractQwenText(entry.message?.parts);
                            if (text?.trim()) {
                                lastAssistantPreview = text.trim().slice(-500);
                                break;
                            }
                        }
                    }
                    catch {
                        // Skip
                    }
                }
            }
            const resolvedProjectPath = cwd || projectPath;
            return {
                id: sessionId,
                agentType: 'qwen',
                cwd: resolvedProjectPath,
                startedAt: startedAt || stat.birthtimeMs,
                lastActivityAt: stat.mtimeMs,
                firstPrompt: firstPrompt.slice(0, 300),
                sessionName: customTitle || undefined,
                lastAssistantPreview,
                messageCount: Math.ceil(messageCount / 2),
                isActive: false,
                filePath,
                projectPath: resolvedProjectPath,
            };
        }
        finally {
            await handle.close();
        }
    }
    async getQwenSessionDetail(sessionId) {
        const sessions = await this.scanQwenSessions();
        const session = sessions.find((s) => s.id === sessionId);
        if (!session)
            return null;
        return this.getQwenSessionDetailFromSession(session);
    }
    async getQwenSessionDetailFromSession(session) {
        const content = await fs_1.promises.readFile(session.filePath, 'utf8');
        const lines = content.split('\n').filter((l) => l.trim());
        const messages = [];
        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                if (entry.type === 'user') {
                    const text = this.extractQwenText(entry.message?.parts);
                    if (text) {
                        messages.push({ role: 'user', content: text, timestamp: entry.timestamp });
                    }
                }
                if (entry.type === 'assistant') {
                    const text = this.extractQwenText(entry.message?.parts);
                    if (text) {
                        messages.push({ role: 'assistant', content: text, timestamp: entry.timestamp });
                    }
                }
            }
            catch {
                // Skip unparseable lines
            }
        }
        return { ...session, messages };
    }
    // ─── Cline CLI ───────────────────────────────────────────────────────────
    // Cline stores one metadata JSON and one transcript JSON per session under
    // ~/.cline/data/sessions/<session-id>/. Its storage package also supports
    // three environment overrides; mirror that precedence so isolated/custom
    // Cline installs work on Windows, Linux, and macOS.
    clineSessionsRoot() {
        const sessionDataDir = process.env.CLINE_SESSION_DATA_DIR?.trim();
        if (sessionDataDir)
            return path_1.default.resolve(sessionDataDir);
        const dataDir = process.env.CLINE_DATA_DIR?.trim();
        if (dataDir)
            return path_1.default.join(path_1.default.resolve(dataDir), 'sessions');
        const clineDir = process.env.CLINE_DIR?.trim();
        const root = clineDir ? path_1.default.resolve(clineDir) : path_1.default.join(os_1.default.homedir(), '.cline');
        return path_1.default.join(root, 'data', 'sessions');
    }
    parseClineTime(value) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value > 0 && value < 1_000_000_000_000 ? value * 1000 : value;
        }
        if (typeof value !== 'string' || !value.trim())
            return 0;
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) {
            return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
        }
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? 0 : parsed;
    }
    clineString(...values) {
        for (const value of values) {
            if (typeof value === 'string' && value.trim())
                return value.trim();
        }
        return '';
    }
    extractClineText(content) {
        if (typeof content === 'string')
            return content.trim();
        if (!Array.isArray(content))
            return '';
        return content
            .filter((block) => (Boolean(block) &&
            typeof block === 'object' &&
            block.type === 'text' &&
            typeof block.text === 'string'))
            .map((block) => block.text)
            .join('\n')
            .trim();
    }
    /** Remove the transport wrapper Cline persists around real user prompts. */
    cleanClineUserText(value) {
        if (typeof value !== 'string')
            return '';
        const text = value.trim();
        const wrapped = text.match(/<user_input\b[^>]*>([\s\S]*?)<\/user_input>/i)
            ?? text.match(/<user_query\b[^>]*>([\s\S]*?)<\/user_query>/i);
        return (wrapped?.[1] ?? text).trim();
    }
    async readClineTranscript(messagesPath) {
        let parsed;
        try {
            parsed = JSON.parse(await fs_1.promises.readFile(messagesPath, 'utf8'));
        }
        catch {
            return { messages: [], firstPrompt: '', messageCount: 0, lastActivityAt: 0 };
        }
        const record = parsed && typeof parsed === 'object'
            ? parsed
            : {};
        const entries = Array.isArray(parsed)
            ? parsed
            : (Array.isArray(record.messages) ? record.messages : []);
        const messages = [];
        let firstPrompt = '';
        let lastAssistantPreview;
        let messageCount = 0;
        let lastActivityAt = this.parseClineTime(record.updated_at);
        for (const rawEntry of entries) {
            if (!rawEntry || typeof rawEntry !== 'object')
                continue;
            const entry = rawEntry;
            const role = entry.role === 'user' || entry.role === 'assistant' ? entry.role : null;
            if (!role)
                continue;
            const rawText = this.extractClineText(entry.content);
            const text = role === 'user' ? this.cleanClineUserText(rawText) : rawText.trim();
            if (!text)
                continue;
            const timestampMs = this.parseClineTime(entry.ts ?? entry.timestamp);
            if (timestampMs > lastActivityAt)
                lastActivityAt = timestampMs;
            const timestampDate = timestampMs > 0 ? new Date(timestampMs) : null;
            const timestamp = timestampDate && !Number.isNaN(timestampDate.getTime())
                ? timestampDate.toISOString()
                : undefined;
            messages.push({ role, content: text, timestamp });
            if (role === 'user') {
                messageCount++;
                if (!firstPrompt)
                    firstPrompt = text;
            }
            else {
                lastAssistantPreview = text.slice(-500);
            }
        }
        return { messages, firstPrompt, lastAssistantPreview, messageCount, lastActivityAt };
    }
    async collectClineCandidates(out) {
        const sessionsRoot = this.clineSessionsRoot();
        let sessionDirs;
        try {
            sessionDirs = await fs_1.promises.readdir(sessionsRoot, { withFileTypes: true });
        }
        catch {
            return;
        }
        await Promise.allSettled(sessionDirs.filter((entry) => entry.isDirectory()).map(async (entry) => {
            const metadataPath = path_1.default.join(sessionsRoot, entry.name, `${entry.name}.json`);
            const messagesPath = path_1.default.join(sessionsRoot, entry.name, `${entry.name}.messages.json`);
            let metadataStat;
            try {
                metadataStat = await fs_1.promises.stat(metadataPath);
            }
            catch {
                return;
            }
            let messagesMtime = 0;
            try {
                messagesMtime = (await fs_1.promises.stat(messagesPath)).mtimeMs;
            }
            catch {
                // Metadata-only sessions remain visible and resumable.
            }
            out.push({
                mtimeMs: Math.max(metadataStat.mtimeMs, messagesMtime),
                parse: async () => this.parseClineSessionFile(metadataPath),
            });
        }));
    }
    async parseClineSessionFile(metadataPath, knownTranscript) {
        let metadata;
        let metadataStat;
        try {
            const parsed = JSON.parse(await fs_1.promises.readFile(metadataPath, 'utf8'));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                return null;
            metadata = parsed;
            metadataStat = await fs_1.promises.stat(metadataPath);
        }
        catch {
            return null;
        }
        const sessionDir = path_1.default.dirname(metadataPath);
        const directoryId = path_1.default.basename(sessionDir);
        const id = this.clineString(metadata.session_id, directoryId);
        if (!id)
            return null;
        const nested = metadata.metadata && typeof metadata.metadata === 'object'
            ? metadata.metadata
            : {};
        const messagesPath = path_1.default.join(sessionDir, `${directoryId}.messages.json`);
        const transcript = knownTranscript ?? await this.readClineTranscript(messagesPath);
        let messagesMtime = 0;
        try {
            messagesMtime = (await fs_1.promises.stat(messagesPath)).mtimeMs;
        }
        catch {
            // The metadata still describes a resumable session.
        }
        const cwd = this.clineString(metadata.cwd, metadata.workspace_root);
        const projectPath = this.clineString(metadata.workspace_root, metadata.cwd);
        const metadataPrompt = this.cleanClineUserText(this.clineString(metadata.prompt, nested.prompt));
        const sessionName = this.cleanClineUserText(this.clineString(metadata.title, nested.title)) || undefined;
        const startedAt = this.parseClineTime(metadata.started_at) || metadataStat.birthtimeMs;
        const lastActivityAt = Math.max(metadataStat.mtimeMs, messagesMtime, transcript.lastActivityAt, this.parseClineTime(metadata.ended_at), this.parseClineTime(metadata.updated_at), this.parseClineTime(metadata.updatedAt));
        const status = this.clineString(metadata.status).toLowerCase();
        return {
            id,
            agentType: 'cline',
            cwd,
            startedAt,
            lastActivityAt,
            firstPrompt: (metadataPrompt || transcript.firstPrompt || sessionName || '').slice(0, 300),
            sessionName,
            lastAssistantPreview: transcript.lastAssistantPreview,
            messageCount: transcript.messageCount,
            isActive: status === 'running',
            filePath: metadataPath,
            projectPath: projectPath || undefined,
            model: this.clineString(metadata.model, nested.model) || undefined,
        };
    }
    async scanClineSessions() {
        const candidates = [];
        await this.collectClineCandidates(candidates);
        const sessions = [];
        await Promise.allSettled(candidates.map(async (candidate) => {
            const session = await candidate.parse();
            if (session)
                sessions.push(session);
        }));
        return sessions;
    }
    async getClineSessionDetail(sessionId) {
        if (!sessionId || sessionId === '.' || sessionId === '..' || /[\\/]/.test(sessionId))
            return null;
        const sessionDir = path_1.default.join(this.clineSessionsRoot(), sessionId);
        const transcript = await this.readClineTranscript(path_1.default.join(sessionDir, `${sessionId}.messages.json`));
        const session = await this.parseClineSessionFile(path_1.default.join(sessionDir, `${sessionId}.json`), transcript);
        return session ? { ...session, messages: transcript.messages } : null;
    }
    async getClineSessionDetailFromSession(session) {
        const messagesPath = path_1.default.join(path_1.default.dirname(session.filePath), `${path_1.default.basename(path_1.default.dirname(session.filePath))}.messages.json`);
        const transcript = await this.readClineTranscript(messagesPath);
        return { ...session, messages: transcript.messages };
    }
    // ─── Grok (xAI "grok" CLI) ────────────────────────────────────────────────
    // Grok stores sessions under ~/.grok/sessions/<percent-encoded-cwd>/<uuid>/
    // (respecting $GROK_HOME). Each <uuid>/ dir holds a `summary.json` metadata
    // file and a `chat_history.jsonl` transcript. Unlike the other agents grok
    // has no user override system, so the root is computed directly rather than
    // via getAgentRoot/getOverrides.
    /** Root directory holding grok's per-project session folders. */
    grokSessionsRoot() {
        const home = process.env.GROK_HOME
            ? path_1.default.resolve(process.env.GROK_HOME)
            : path_1.default.join(os_1.default.homedir(), '.grok');
        return path_1.default.join(home, 'sessions');
    }
    /** A grok session dir is named after its UUID; skip prompt_history.jsonl etc. */
    looksLikeGrokSessionId(name) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name);
    }
    /** Join the text parts of a grok message `content` (array of parts or a string). */
    extractGrokText(content) {
        if (!content)
            return '';
        if (typeof content === 'string')
            return content;
        if (Array.isArray(content)) {
            return content
                .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
                .map((p) => p.text || '')
                .join('\n')
                .trim();
        }
        return '';
    }
    /**
     * True when a grok "user" line is an injected preamble (environment info,
     * system-reminders, git status) rather than a real user query. Real queries
     * are wrapped in <user_query>…</user_query>; preambles never are.
     */
    isGrokPreambleUser(raw) {
        if (raw.includes('<user_query>'))
            return false;
        const head = raw.slice(0, 200);
        return (head.includes('<user_info>') ||
            head.includes('<system-reminder>') ||
            head.includes('<git_status>'));
    }
    /** Unwrap grok's <user_query> tag; strip the <user_info>/<system-reminder> preamble blocks. */
    extractGrokUserText(raw) {
        if (!raw)
            return '';
        const query = raw.match(/<user_query>([\s\S]*?)<\/user_query>/);
        if (query)
            return query[1].trim();
        return raw
            .replace(/<user_info>[\s\S]*?<\/user_info>/g, '')
            .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
            .replace(/<git_status>[\s\S]*?<\/git_status>/g, '')
            .trim();
    }
    parseGrokTime(value) {
        if (typeof value !== 'string' || !value.trim())
            return 0;
        const ms = Date.parse(value);
        return Number.isNaN(ms) ? 0 : ms;
    }
    /**
     * Read a grok chat_history.jsonl and pull out the first real user query
     * (skipping preamble user lines) and the last assistant message for preview.
     *
     * Live sessions grow to hundreds of KB / tens of MB. Detection and tab
     * rename only need the first <user_query> (near the head) and a short
     * preview (near the tail) — never the whole transcript.
     */
    async readGrokChatSummary(chatHistoryPath) {
        const HEAD_BYTES = 512 * 1024;
        const TAIL_BYTES = 64 * 1024;
        let handle;
        try {
            handle = await fs_1.promises.open(chatHistoryPath, 'r');
        }
        catch {
            return { firstPrompt: '' };
        }
        try {
            const stat = await handle.stat();
            const headSize = Math.min(stat.size, HEAD_BYTES);
            const head = Buffer.alloc(headSize);
            await handle.read(head, 0, headSize, 0);
            const headText = head.toString('utf8');
            const firstPrompt = this.extractGrokFirstPromptFromJsonl(headText);
            let lastAssistantPreview;
            if (stat.size <= HEAD_BYTES) {
                lastAssistantPreview = this.extractGrokLastAssistantFromJsonl(headText);
            }
            else {
                const tailSize = Math.min(stat.size, TAIL_BYTES);
                const tail = Buffer.alloc(tailSize);
                await handle.read(tail, 0, tailSize, stat.size - tailSize);
                const tailText = tail.toString('utf8');
                const fromFirstNewline = tailText.includes('\n')
                    ? tailText.slice(tailText.indexOf('\n') + 1)
                    : tailText;
                lastAssistantPreview = this.extractGrokLastAssistantFromJsonl(fromFirstNewline);
            }
            return { firstPrompt, lastAssistantPreview };
        }
        finally {
            await handle.close();
        }
    }
    extractGrokFirstPromptFromJsonl(content) {
        for (const line of content.split('\n')) {
            if (!line.trim())
                continue;
            let entry;
            try {
                entry = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (entry.type !== 'user')
                continue;
            const raw = this.extractGrokText(entry.content);
            if (this.isGrokPreambleUser(raw))
                continue;
            const text = this.extractGrokUserText(raw);
            if (text)
                return text;
        }
        return '';
    }
    extractGrokLastAssistantFromJsonl(content) {
        const lines = content.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i].trim())
                continue;
            let entry;
            try {
                entry = JSON.parse(lines[i]);
            }
            catch {
                continue;
            }
            if (entry.type !== 'assistant')
                continue;
            const text = (typeof entry.content === 'string' ? entry.content : this.extractGrokText(entry.content)).trim();
            if (text)
                return text.slice(-500);
        }
        return undefined;
    }
    async collectGrokCandidates(out) {
        const sessionsRoot = this.grokSessionsRoot();
        let cwdDirs;
        try {
            cwdDirs = await fs_1.promises.readdir(sessionsRoot, { withFileTypes: true });
        }
        catch {
            return;
        }
        await Promise.allSettled(
        // Each top-level entry is a percent-encoded cwd dir (skip stray files like
        // session_search.sqlite).
        cwdDirs.filter((d) => d.isDirectory()).map(async (cwdDir) => {
            const projectDir = path_1.default.join(sessionsRoot, cwdDir.name);
            let sessionDirs;
            try {
                sessionDirs = await fs_1.promises.readdir(projectDir, { withFileTypes: true });
            }
            catch {
                return;
            }
            await Promise.allSettled(
            // Session dirs are named after a UUID; a sibling prompt_history.jsonl
            // file lives here too and must be skipped.
            sessionDirs
                .filter((d) => d.isDirectory() && this.looksLikeGrokSessionId(d.name))
                .map(async (sessionDir) => {
                const summaryPath = path_1.default.join(projectDir, sessionDir.name, 'summary.json');
                let stat;
                try {
                    stat = await fs_1.promises.stat(summaryPath);
                }
                catch {
                    return;
                }
                out.push({
                    mtimeMs: stat.mtimeMs,
                    parse: async () => this.parseGrokSummary(summaryPath),
                });
            }));
        }));
    }
    /**
     * Build an AISession from a grok `summary.json`. `filePath` is stored as the
     * summary.json path; the detail path derives chat_history.jsonl as its sibling
     * (`path.join(path.dirname(filePath), 'chat_history.jsonl')`).
     */
    async parseGrokSummary(summaryPath) {
        const sessionDir = path_1.default.dirname(summaryPath);
        const encodedCwdDir = path_1.default.basename(path_1.default.dirname(sessionDir));
        let birthtimeMs = Date.now();
        let mtimeMs = Date.now();
        try {
            const stat = await fs_1.promises.stat(summaryPath);
            birthtimeMs = stat.birthtimeMs;
            mtimeMs = stat.mtimeMs;
        }
        catch {
            // Fall back to `now` for both timestamps.
        }
        let summary;
        try {
            summary = JSON.parse(await fs_1.promises.readFile(summaryPath, 'utf8'));
        }
        catch {
            return null;
        }
        const id = summary.info?.id?.trim() || path_1.default.basename(sessionDir);
        if (!id)
            return null;
        let cwd = summary.info?.cwd?.trim() || '';
        if (!cwd) {
            try {
                cwd = decodeURIComponent(encodedCwdDir);
            }
            catch {
                cwd = encodedCwdDir;
            }
        }
        const startedAt = this.parseGrokTime(summary.created_at) || birthtimeMs;
        const lastActivityAt = this.parseGrokTime(summary.updated_at ?? summary.last_active_at) || mtimeMs;
        // session_summary is an evolving transcript synopsis, not the short title
        // generated later by Grok. Treating it as sessionName makes the renderer
        // believe naming is final and prevents the generated_title upgrade.
        const sessionName = summary.generated_title?.trim() || undefined;
        // num_chat_messages is already a turn count — no /2 halving (cf. qwen).
        const messageCount = summary.num_chat_messages ?? summary.num_messages ?? 0;
        const model = summary.current_model_id?.trim() || undefined;
        const gitBranch = summary.head_branch?.trim() || undefined;
        const chatHistoryPath = path_1.default.join(sessionDir, 'chat_history.jsonl');
        const { firstPrompt, lastAssistantPreview } = await this.readGrokChatSummary(chatHistoryPath);
        // firstPrompt is ownership evidence for selectSessionForTerminal. Grok's
        // generated_title / session_summary are later summaries of the task, not
        // the submitted prompt, so they must never stand in for it — that match
        // would fail and leave the tab stuck at the preset name ("Grok Full").
        return {
            id,
            agentType: 'grok',
            cwd,
            startedAt,
            lastActivityAt,
            firstPrompt: firstPrompt.slice(0, 300),
            sessionName,
            lastAssistantPreview,
            messageCount,
            isActive: false,
            filePath: summaryPath,
            projectPath: cwd,
            gitBranch,
            model,
        };
    }
    async scanGrokSessions() {
        const candidates = [];
        await this.collectGrokCandidates(candidates);
        const sessions = [];
        await Promise.allSettled(candidates.map(async (candidate) => {
            try {
                const session = await candidate.parse();
                if (session)
                    sessions.push(session);
            }
            catch {
                // Skip unparseable sessions
            }
        }));
        return sessions;
    }
    /** Locate ~/.grok/sessions/<encoded-cwd>/<uuid>/summary.json without parsing peers. */
    async findGrokSummaryPath(sessionId) {
        if (!this.looksLikeGrokSessionId(sessionId))
            return null;
        const sessionsRoot = this.grokSessionsRoot();
        let cwdDirs;
        try {
            cwdDirs = await fs_1.promises.readdir(sessionsRoot, { withFileTypes: true });
        }
        catch {
            return null;
        }
        for (const cwdDir of cwdDirs) {
            if (!cwdDir.isDirectory())
                continue;
            const summaryPath = path_1.default.join(sessionsRoot, cwdDir.name, sessionId, 'summary.json');
            try {
                await fs_1.promises.stat(summaryPath);
                return summaryPath;
            }
            catch {
                // Try the next project folder.
            }
        }
        return null;
    }
    async getGrokSessionDetail(sessionId) {
        const summaryPath = await this.findGrokSummaryPath(sessionId);
        if (summaryPath) {
            const session = await this.parseGrokSummary(summaryPath);
            if (session?.id === sessionId)
                return this.getGrokSessionDetailFromSession(session);
        }
        // Fallback: info.id can theoretically differ from the directory name.
        const sessions = await this.scanGrokSessions();
        const session = sessions.find((s) => s.id === sessionId);
        if (!session)
            return null;
        return this.getGrokSessionDetailFromSession(session);
    }
    async getGrokSessionDetailFromSession(session) {
        // chat_history.jsonl is a sibling of the stored summary.json path.
        const chatHistoryPath = path_1.default.join(path_1.default.dirname(session.filePath), 'chat_history.jsonl');
        let content;
        try {
            content = await fs_1.promises.readFile(chatHistoryPath, 'utf8');
        }
        catch {
            return { ...session, messages: [] };
        }
        const lines = content.split('\n').filter((l) => l.trim());
        const messages = [];
        for (const line of lines) {
            let entry;
            try {
                entry = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (entry.type === 'user') {
                const raw = this.extractGrokText(entry.content);
                if (this.isGrokPreambleUser(raw))
                    continue;
                const text = this.extractGrokUserText(raw);
                if (text)
                    messages.push({ role: 'user', content: text });
            }
            else if (entry.type === 'assistant') {
                const text = (typeof entry.content === 'string' ? entry.content : this.extractGrokText(entry.content)).trim();
                if (text)
                    messages.push({ role: 'assistant', content: text });
            }
            // Ignore system / reasoning / tool_result / backend_tool_call lines.
        }
        return { ...session, messages };
    }
    // ─── Cursor (cursor-agent CLI) ────────────────────────────────────────────
    // Despite older builds keeping chats server-side, current cursor-agent
    // persists every chat locally under ~/.cursor/chats/<md5(cwd)>/<chat-uuid>/:
    //   meta.json — {title, createdAtMs, updatedAtMs, cwd, hasConversation}
    //   store.db  — SQLite (WAL): `meta` holds one hex-encoded JSON row whose
    //               latestRootBlobId points into `blobs`; the root blob is a
    //               sequence of `0x0A 0x20 <32-byte sha>` child refs (trailing
    //               protobuf fields follow — stop at the first non-ref byte),
    //               and each child blob is a plain-JSON chat message
    //               {role, content} (content = string or typed parts array).
    //               The meta's blobEncryptionKey is for sync only — local blobs
    //               are NOT encrypted.
    // Like grok there is no user override system, so the root is computed
    // directly rather than via getAgentRoot/getOverrides.
    /** Root directory holding cursor-agent's per-project chat folders. */
    cursorChatsRoot() {
        const home = process.env.CURSOR_CONFIG_DIR
            ? path_1.default.resolve(process.env.CURSOR_CONFIG_DIR)
            : path_1.default.join(os_1.default.homedir(), '.cursor');
        return path_1.default.join(home, 'chats');
    }
    /** A cursor chat dir is named after its UUID (same shape grok uses). */
    looksLikeCursorSessionId(name) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name);
    }
    /** Walk the root blob's `0x0A 0x20 <32-byte id>` records; stop at the trailer. */
    parseCursorRootBlobChildIds(root) {
        const ids = [];
        let offset = 0;
        while (offset + 34 <= root.length && root[offset] === 0x0a && root[offset + 1] === 0x20) {
            ids.push(root.subarray(offset + 2, offset + 34).toString('hex'));
            offset += 34;
            if (ids.length >= 5000)
                break; // runaway guard; no real chat has this many turns
        }
        return ids;
    }
    /** Join the text parts of a cursor message `content` (string or parts array). */
    extractCursorText(content) {
        if (!content)
            return '';
        if (typeof content === 'string')
            return content;
        if (Array.isArray(content)) {
            return content
                .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
                .map((p) => p.text || '')
                .join('\n')
                .trim();
        }
        return '';
    }
    /**
     * True when a cursor "user" message is the injected environment preamble
     * (<user_info> OS/shell block) rather than a real query. Real queries are
     * wrapped in <user_query>…</user_query>; preambles never are.
     */
    isCursorPreambleUser(raw) {
        if (raw.includes('<user_query>'))
            return false;
        return raw.slice(0, 200).includes('<user_info>');
    }
    /** Unwrap cursor's <user_query> tag; strip <timestamp>/<user_info> wrappers. */
    extractCursorUserText(raw) {
        if (!raw)
            return '';
        const query = raw.match(/<user_query>([\s\S]*?)<\/user_query>/);
        if (query)
            return query[1].trim();
        return raw
            .replace(/<user_info>[\s\S]*?<\/user_info>/g, '')
            .replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '')
            .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
            .trim();
    }
    /** Reduce a cursor store's raw messages to transcript rows (user/assistant only). */
    cursorMessagesToTranscript(rawMessages) {
        const messages = [];
        for (const entry of rawMessages) {
            if (entry.role === 'user') {
                const raw = this.extractCursorText(entry.content);
                if (this.isCursorPreambleUser(raw))
                    continue;
                const text = this.extractCursorUserText(raw);
                if (text)
                    messages.push({ role: 'user', content: text });
            }
            else if (entry.role === 'assistant') {
                const text = this.extractCursorText(entry.content).trim();
                if (text)
                    messages.push({ role: 'assistant', content: text });
            }
            // Ignore system / tool rows (reasoning and tool-call parts are dropped
            // by extractCursorText keeping only typed text parts).
        }
        return messages;
    }
    /**
     * Read one chat's messages out of its store.db. Opens readonly (the CLI may
     * be writing) and returns null when the db is missing/locked/unreadable —
     * callers fall back to meta.json-only metadata.
     */
    readCursorStoreMessages(storeDbPath) {
        let db = null;
        try {
            db = new better_sqlite3_1.default(storeDbPath, { readonly: true, fileMustExist: true });
            const metaRow = db.prepare('SELECT value FROM meta LIMIT 1').get();
            if (!metaRow?.value)
                return null;
            const storeMeta = JSON.parse(Buffer.from(metaRow.value, 'hex').toString('utf8'));
            if (!storeMeta.latestRootBlobId)
                return null;
            const rootRow = db.prepare('SELECT data FROM blobs WHERE id = ?').get(storeMeta.latestRootBlobId);
            if (!rootRow?.data)
                return null;
            const getBlob = db.prepare('SELECT data FROM blobs WHERE id = ?');
            const messages = [];
            for (const childId of this.parseCursorRootBlobChildIds(Buffer.from(rootRow.data))) {
                const row = getBlob.get(childId);
                if (!row?.data)
                    continue;
                try {
                    messages.push(JSON.parse(Buffer.from(row.data).toString('utf8')));
                }
                catch {
                    // Skip non-JSON blobs (future format additions).
                }
            }
            return messages;
        }
        catch (error) {
            console.log(`[resume] failed to read cursor store at ${storeDbPath}:`, error instanceof Error ? error.message : error);
            return null;
        }
        finally {
            db?.close();
        }
    }
    /**
     * Scan-time memo of parsed cursor sessions. Reading a store.db means opening
     * it with synchronous SQLite and parsing every message blob — hundreds of
     * chats × a 30s scan TTL made every Resume open re-pay that on the main
     * thread. Keyed by store.db path; the key includes BOTH store.db and
     * meta.json mtimes because the CLI writes the title to meta.json after the
     * conversation exists (F3 — a title-only update must still refresh).
     * Swept against live chat dirs in scanCursorSessions so deleted chats
     * don't pin entries.
     */
    cursorSessionCache = new Map();
    /**
     * Build an AISession from one chat dir. `filePath` is stored as the store.db
     * path; the detail path reuses the same transcript read via
     * buildCursorSession rather than reading the store twice.
     */
    async parseCursorSession(sessionDir) {
        const id = path_1.default.basename(sessionDir);
        if (!this.looksLikeCursorSessionId(id))
            return null;
        const storeDbPath = path_1.default.join(sessionDir, 'store.db');
        let mtimeMs;
        try {
            mtimeMs = (await fs_1.promises.stat(storeDbPath)).mtimeMs;
        }
        catch {
            this.cursorSessionCache.delete(storeDbPath);
            return null;
        }
        let metaMtimeMs = 0;
        try {
            metaMtimeMs = (await fs_1.promises.stat(path_1.default.join(sessionDir, 'meta.json'))).mtimeMs;
        }
        catch {
            // meta.json lags the store on brand-new chats.
        }
        const cacheKey = `${mtimeMs}:${metaMtimeMs}`;
        const cached = this.cursorSessionCache.get(storeDbPath);
        if (cached && cached.key === cacheKey) {
            // Shallow copy so callers that decorate the session (isActive etc.)
            // never mutate the cached object.
            return cached.session ? { ...cached.session } : null;
        }
        const transcript = this.cursorMessagesToTranscript(this.readCursorStoreMessages(storeDbPath) || []);
        const session = await this.buildCursorSession(sessionDir, storeDbPath, mtimeMs, transcript);
        this.cursorSessionCache.set(storeDbPath, { key: cacheKey, session });
        return session ? { ...session } : null;
    }
    /** The meta.json + field-derivation half of parseCursorSession (no store read). */
    async buildCursorSession(sessionDir, storeDbPath, mtimeMs, transcript) {
        const id = path_1.default.basename(sessionDir);
        let meta = {};
        try {
            meta = JSON.parse(await fs_1.promises.readFile(path_1.default.join(sessionDir, 'meta.json'), 'utf8'));
        }
        catch {
            // meta.json lags the store on brand-new chats; store data still works.
        }
        const firstPrompt = transcript.find((m) => m.role === 'user')?.content || '';
        const lastAssistantPreview = [...transcript].reverse().find((m) => m.role === 'assistant')?.content;
        // A chat dir with no readable conversation yet (draft the user never
        // prompted) must not appear in Resume or bind to a terminal.
        if (!firstPrompt && !meta.hasConversation)
            return null;
        const cwd = meta.cwd?.trim() || '';
        return {
            id,
            agentType: 'cursor',
            cwd,
            startedAt: meta.createdAtMs || mtimeMs,
            lastActivityAt: meta.updatedAtMs || mtimeMs,
            firstPrompt: firstPrompt.slice(0, 300),
            sessionName: meta.title?.trim() || undefined,
            lastAssistantPreview: lastAssistantPreview ? lastAssistantPreview.slice(-500) : undefined,
            messageCount: transcript.length,
            isActive: false,
            filePath: storeDbPath,
            projectPath: cwd,
        };
    }
    async collectCursorCandidates(out, livePaths) {
        const chatsRoot = this.cursorChatsRoot();
        let hashDirs;
        try {
            hashDirs = await fs_1.promises.readdir(chatsRoot, { withFileTypes: true });
        }
        catch {
            return;
        }
        await Promise.allSettled(
        // Each top-level entry is an md5(cwd) dir holding that project's chats.
        hashDirs.filter((d) => d.isDirectory()).map(async (hashDir) => {
            const projectDir = path_1.default.join(chatsRoot, hashDir.name);
            let sessionDirs;
            try {
                sessionDirs = await fs_1.promises.readdir(projectDir, { withFileTypes: true });
            }
            catch {
                return;
            }
            await Promise.allSettled(sessionDirs
                .filter((d) => d.isDirectory() && this.looksLikeCursorSessionId(d.name))
                .map(async (sessionDir) => {
                const dir = path_1.default.join(projectDir, sessionDir.name);
                const storeDbPath = path_1.default.join(dir, 'store.db');
                let stat;
                try {
                    stat = await fs_1.promises.stat(storeDbPath);
                }
                catch {
                    return;
                }
                livePaths?.add(storeDbPath);
                out.push({
                    mtimeMs: stat.mtimeMs,
                    parse: async () => this.parseCursorSession(dir),
                });
            }));
        }));
    }
    async scanCursorSessions() {
        const candidates = [];
        const livePaths = new Set();
        await this.collectCursorCandidates(candidates, livePaths);
        const sessions = [];
        await Promise.allSettled(candidates.map(async (candidate) => {
            try {
                const session = await candidate.parse();
                if (session)
                    sessions.push(session);
            }
            catch {
                // Skip unparseable sessions
            }
        }));
        // Sweep memo entries whose chat dir no longer exists (the memo key is the
        // store.db path). Deleted-but-cached null sessions must survive the sweep
        // while their dir exists, or every scan would re-read every draft chat.
        for (const key of this.cursorSessionCache.keys()) {
            if (!livePaths.has(key))
                this.cursorSessionCache.delete(key);
        }
        return sessions;
    }
    /**
     * Resolve a known chat id directly (readdir the hash dirs, stat the one
     * candidate) instead of parsing every session first — reader-mode C11.
     */
    async getCursorSessionDetail(sessionId) {
        if (!this.looksLikeCursorSessionId(sessionId))
            return null;
        const chatsRoot = this.cursorChatsRoot();
        let hashDirs;
        try {
            hashDirs = (await fs_1.promises.readdir(chatsRoot, { withFileTypes: true }))
                .filter((d) => d.isDirectory())
                .map((d) => d.name);
        }
        catch {
            return null;
        }
        for (const hashDir of hashDirs) {
            const sessionDir = path_1.default.join(chatsRoot, hashDir, sessionId);
            const storeDbPath = path_1.default.join(sessionDir, 'store.db');
            let mtimeMs;
            try {
                mtimeMs = (await fs_1.promises.stat(storeDbPath)).mtimeMs;
            }
            catch {
                continue;
            }
            // ONE store read serves both the session summary and the transcript.
            // This path runs on a 500ms cadence during submission correlation
            // (waitForAcceptance), so the old summary-read + detail-read double
            // synchronous SQLite pass was the dominant per-tick cost.
            const messages = this.cursorMessagesToTranscript(this.readCursorStoreMessages(storeDbPath) || []);
            const session = await this.buildCursorSession(sessionDir, storeDbPath, mtimeMs, messages);
            if (!session)
                continue;
            return { ...session, messages };
        }
        return null;
    }
    /** `filePath` on a scanned cursor session is its store.db path. */
    async getCursorSessionDetailFromSession(session) {
        const messages = this.cursorMessagesToTranscript(this.readCursorStoreMessages(session.filePath) || []);
        return { ...session, messages };
    }
    // ── Pi (@earendil-works/pi-coding-agent) ──────────────────────────────────
    // Pi writes one append-only JSONL per session under
    // ~/.pi/agent/sessions/<encoded-cwd>/<ISO-timestamp>_<uuid>.jsonl, where the
    // directory name is `--` + the absolute cwd with its leading separator
    // dropped and every `/`, `\` and `:` replaced by `-` + `--` (verbatim from
    // pi's getDefaultSessionDirPath). We deliberately do NOT reimplement that
    // encoding to find a project's sessions: every file's FIRST line is a
    // `{type:'session', id, timestamp, cwd}` header, so the real cwd is read from
    // the file itself and stays correct even if pi changes its encoding.
    // Config root override: PI_CODING_AGENT_DIR (defaults to ~/.pi/agent);
    // PI_CODING_AGENT_SESSION_DIR replaces the sessions tree wholesale.
    /** Root directory holding pi's per-project session folders. */
    piSessionsRoot() {
        const sessionDirOverride = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
        if (sessionDirOverride)
            return path_1.default.resolve(sessionDirOverride);
        const agentDir = process.env.PI_CODING_AGENT_DIR?.trim()
            ? path_1.default.resolve(process.env.PI_CODING_AGENT_DIR.trim())
            : path_1.default.join(os_1.default.homedir(), '.pi', 'agent');
        return path_1.default.join(agentDir, 'sessions');
    }
    /** Join the text blocks of a pi message `content` (typed parts or a string). */
    extractPiText(content) {
        if (!content)
            return '';
        if (typeof content === 'string')
            return content;
        if (Array.isArray(content)) {
            return content
                .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
                .map((part) => part.text || '')
                .join('\n')
                .trim();
        }
        return '';
    }
    parsePiTime(value) {
        if (typeof value === 'number' && Number.isFinite(value))
            return value;
        if (typeof value !== 'string' || !value.trim())
            return 0;
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? 0 : parsed;
    }
    /**
     * Read one pi session JSONL and pull out everything the list and the detail
     * view need. `withMessages` also materializes the transcript; the list path
     * leaves it off so a long session is scanned without retaining every turn.
     *
     * Only `user`/`assistant` roles become transcript rows — pi also stores
     * `toolResult` messages plus `model_change`, `thinking_level_change`,
     * `compaction`, `branch_summary` and extension entries, none of which are
     * conversation. Entries are read in file order: pi stores a TREE (each entry
     * carries id/parentId and `/tree` can branch), so file order is append order,
     * not necessarily the active branch. That is the right choice for a preview —
     * abandoned branches are still session history — and matches what pi's own
     * session picker shows.
     */
    async readPiSessionFile(filePath, withMessages) {
        let content;
        try {
            content = await fs_1.promises.readFile(filePath, 'utf8');
        }
        catch {
            return null;
        }
        let header = null;
        let sessionName;
        let firstPrompt = '';
        let lastAssistantPreview;
        let messageCount = 0;
        let model;
        let lastActivityAt = 0;
        const messages = [];
        for (const line of content.split('\n')) {
            if (!line.trim())
                continue;
            let entry;
            try {
                entry = JSON.parse(line);
            }
            catch {
                // pi skips malformed lines too; one bad line never voids the session.
                continue;
            }
            if (!header) {
                // A file whose first parsed entry is not a session header is not a pi
                // session (pi's own loadEntriesFromFile applies the same rule).
                if (entry.type !== 'session')
                    return null;
                header = entry;
                continue;
            }
            if (entry.type === 'session_info') {
                // Latest wins, including an explicit clear back to unnamed.
                sessionName = entry.name?.trim() || undefined;
                continue;
            }
            if (entry.type === 'model_change') {
                if (typeof entry.modelId === 'string' && entry.modelId.trim())
                    model = entry.modelId.trim();
                continue;
            }
            if (entry.type !== 'message' || !entry.message)
                continue;
            messageCount++;
            const activityAt = this.parsePiTime(entry.message.timestamp) || this.parsePiTime(entry.timestamp);
            if (activityAt > lastActivityAt)
                lastActivityAt = activityAt;
            const role = entry.message.role;
            if (role !== 'user' && role !== 'assistant')
                continue;
            if (typeof entry.message.model === 'string' && entry.message.model.trim()) {
                model = entry.message.model.trim();
            }
            const text = this.extractPiText(entry.message.content).trim();
            if (!text)
                continue;
            if (role === 'user' && !firstPrompt)
                firstPrompt = text;
            if (role === 'assistant')
                lastAssistantPreview = text.slice(-500);
            if (withMessages)
                messages.push({ role, content: text });
        }
        if (!header?.id)
            return null;
        const headerTime = this.parsePiTime(header.timestamp);
        let birthtimeMs = headerTime || Date.now();
        let mtimeMs = lastActivityAt || headerTime || Date.now();
        try {
            const stat = await fs_1.promises.stat(filePath);
            if (!headerTime)
                birthtimeMs = stat.birthtimeMs;
            if (!lastActivityAt)
                mtimeMs = stat.mtimeMs;
        }
        catch {
            // Timestamps already fell back above.
        }
        return {
            id: header.id,
            cwd: typeof header.cwd === 'string' ? header.cwd : '',
            startedAt: birthtimeMs,
            lastActivityAt: mtimeMs,
            sessionName,
            firstPrompt,
            lastAssistantPreview,
            messageCount,
            model,
            messages,
        };
    }
    async parsePiSessionFile(filePath) {
        const parsed = await this.readPiSessionFile(filePath, false);
        if (!parsed)
            return null;
        // A session file with no messages at all is a launched-then-quit shell,
        // not resumable work (same filter opencode's scanner applies to drafts).
        if (parsed.messageCount === 0)
            return null;
        return {
            id: parsed.id,
            agentType: 'pi',
            cwd: parsed.cwd,
            startedAt: parsed.startedAt,
            lastActivityAt: parsed.lastActivityAt,
            firstPrompt: (parsed.firstPrompt || parsed.sessionName || '').slice(0, 300),
            sessionName: parsed.sessionName,
            lastAssistantPreview: parsed.lastAssistantPreview,
            messageCount: parsed.messageCount,
            isActive: false,
            filePath,
            projectPath: parsed.cwd,
            model: parsed.model,
        };
    }
    async collectPiCandidates(out) {
        const sessionsRoot = this.piSessionsRoot();
        let cwdDirs;
        try {
            cwdDirs = await fs_1.promises.readdir(sessionsRoot, { withFileTypes: true });
        }
        catch {
            return;
        }
        await Promise.allSettled(cwdDirs.filter((entry) => entry.isDirectory()).map(async (cwdDir) => {
            const projectDir = path_1.default.join(sessionsRoot, cwdDir.name);
            let files;
            try {
                files = await fs_1.promises.readdir(projectDir, { withFileTypes: true });
            }
            catch {
                return;
            }
            await Promise.allSettled(files
                .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
                .map(async (entry) => {
                const filePath = path_1.default.join(projectDir, entry.name);
                let stat;
                try {
                    stat = await fs_1.promises.stat(filePath);
                }
                catch {
                    return;
                }
                out.push({
                    mtimeMs: stat.mtimeMs,
                    parse: async () => this.parsePiSessionFile(filePath),
                });
            }));
        }));
    }
    async scanPiSessions() {
        const candidates = [];
        await this.collectPiCandidates(candidates);
        const sessions = [];
        await Promise.allSettled(candidates.map(async (candidate) => {
            try {
                const session = await candidate.parse();
                if (session)
                    sessions.push(session);
            }
            catch {
                // Skip unparseable sessions
            }
        }));
        return sessions;
    }
    async getPiSessionDetail(sessionId) {
        const session = (await this.scanPiSessions()).find((candidate) => candidate.id === sessionId);
        if (!session)
            return null;
        return this.getPiSessionDetailFromSession(session);
    }
    async getPiSessionDetailFromSession(session) {
        const parsed = await this.readPiSessionFile(session.filePath, true);
        return { ...session, messages: parsed?.messages ?? [] };
    }
    /**
     * Pi's display name lives in `session_info` entries, and its own
     * `getSessionName()` takes the LAST one — so a rename is an APPEND, never a
     * rewrite. That matters: pi persists with appendFileSync once a session has
     * flushed, so rewriting the file under a live pi would lose whatever it
     * wrote in between, while an appended line is picked up on its next read and
     * is overridden by any later rename pi makes itself.
     *
     * The entry id is a full UUID rather than pi's own 8-hex form so it can
     * never collide with an id a live pi generates (pi's generateId falls back
     * to a full UUID itself, so the shape is already valid there).
     */
    async renamePiSessionFile(sessionId, title) {
        const matches = (await this.scanPiSessions()).filter((session) => session.id === sessionId);
        if (matches.length !== 1)
            throw new Error('The Pi session file could not be uniquely identified.');
        const filePath = matches[0].filePath;
        const content = await fs_1.promises.readFile(filePath, 'utf8');
        const lines = content.split('\n').filter((line) => line.trim());
        let headerId;
        let leafId;
        for (const line of lines) {
            let entry;
            try {
                entry = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (!headerId) {
                if (entry.type !== 'session')
                    throw new Error('The Pi session file has no session header.');
                headerId = entry.id;
                continue;
            }
            if (typeof entry.id === 'string' && entry.id)
                leafId = entry.id;
        }
        if (headerId !== sessionId)
            throw new Error('The Pi session id no longer matches its file.');
        const entry = {
            type: 'session_info',
            id: (0, crypto_1.randomUUID)(),
            parentId: leafId ?? null,
            timestamp: new Date().toISOString(),
            // pi sanitizes the same way in appendSessionInfo — a newline would split
            // one JSONL record into two unparseable ones.
            name: title.replace(/[\r\n]+/g, ' ').trim(),
        };
        await fs_1.promises.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    }
    // ── Antigravity CLI (`agy`) ───────────────────────────────────────────
    // Agy keeps one renderable event transcript per conversation under
    // <root>/brain/<id>/.system_generated/logs/. The workspace-to-conversation
    // map is separate, under <root>/cache/last_conversations.json.
    agyDataRoots() {
        const roots = [
            process.env.ANTIGRAVITY_DATA_DIR,
            process.env.AGY_DATA_DIR,
            path_1.default.join(os_1.default.homedir(), '.gemini', 'antigravity-cli'),
            path_1.default.join(os_1.default.homedir(), '.gemini', 'antigravity'),
        ]
            .filter((root) => Boolean(root?.trim()))
            .map((root) => path_1.default.resolve(root));
        return [...new Set(roots)];
    }
    async readAgyWorkspaceMap(root) {
        const workspaceBySession = new Map();
        try {
            const parsed = JSON.parse(await fs_1.promises.readFile(path_1.default.join(root, 'cache', 'last_conversations.json'), 'utf8'));
            for (const [workspacePath, sessionId] of Object.entries(parsed)) {
                if (typeof sessionId === 'string' && sessionId.trim()) {
                    workspaceBySession.set(sessionId, this.expandAgyWorkspacePath(workspacePath));
                }
            }
        }
        catch {
            // Older Agy data or a session created outside a workspace may have no map.
        }
        return workspaceBySession;
    }
    expandAgyWorkspacePath(workspacePath) {
        if (workspacePath === '~')
            return os_1.default.homedir();
        if (workspacePath.startsWith('~/') || workspacePath.startsWith('~\\')) {
            return path_1.default.join(os_1.default.homedir(), workspacePath.slice(2));
        }
        return workspacePath;
    }
    extractAgyText(content) {
        if (typeof content === 'string')
            return content.trim();
        if (Array.isArray(content)) {
            return content.map((part) => this.extractAgyText(part)).filter(Boolean).join('\n').trim();
        }
        if (!content || typeof content !== 'object')
            return '';
        const record = content;
        if (typeof record.text === 'string')
            return record.text.trim();
        if (typeof record.content === 'string')
            return record.content.trim();
        if (Array.isArray(record.parts))
            return this.extractAgyText(record.parts);
        if (record.content && typeof record.content === 'object')
            return this.extractAgyText(record.content);
        return '';
    }
    getAgyRole(event) {
        const source = typeof event.source === 'string' ? event.source : '';
        const type = typeof event.type === 'string' ? event.type : '';
        if (source.startsWith('USER') && type === 'USER_INPUT')
            return 'user';
        if (source === 'MODEL' && (type.endsWith('_RESPONSE') || type === 'GENERIC'))
            return 'assistant';
        return null;
    }
    parseAgyTimestamp(value) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            if (value > 10_000_000_000_000)
                return Math.floor(value / 1_000);
            return Math.floor(value > 10_000_000_000 ? value : value * 1_000);
        }
        if (typeof value !== 'string')
            return null;
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : parsed;
    }
    async collectAgyCandidates(out) {
        await Promise.allSettled(this.agyDataRoots().map(async (root) => {
            const brainRoot = path_1.default.join(root, 'brain');
            let sessionDirs;
            try {
                sessionDirs = await fs_1.promises.readdir(brainRoot, { withFileTypes: true });
            }
            catch {
                return;
            }
            const workspaceBySession = await this.readAgyWorkspaceMap(root);
            await Promise.allSettled(sessionDirs.filter((entry) => entry.isDirectory()).map(async (entry) => {
                const logsDir = path_1.default.join(brainRoot, entry.name, '.system_generated', 'logs');
                const fullPath = path_1.default.join(logsDir, 'transcript_full.jsonl');
                const compactPath = path_1.default.join(logsDir, 'transcript.jsonl');
                let transcriptPath = fullPath;
                let stat;
                try {
                    stat = await fs_1.promises.stat(fullPath);
                }
                catch {
                    transcriptPath = compactPath;
                    try {
                        stat = await fs_1.promises.stat(compactPath);
                    }
                    catch {
                        return;
                    }
                }
                const workspacePath = workspaceBySession.get(entry.name) || '';
                out.push({
                    mtimeMs: stat.mtimeMs,
                    parse: async () => this.parseAgyTranscript(transcriptPath, entry.name, workspacePath),
                });
            }));
        }));
    }
    async parseAgyTranscript(transcriptPath, sessionId, workspacePath = '') {
        let content;
        let stat;
        try {
            ;
            [content, stat] = await Promise.all([
                fs_1.promises.readFile(transcriptPath, 'utf8'),
                fs_1.promises.stat(transcriptPath),
            ]);
        }
        catch {
            return null;
        }
        const messages = [];
        let startedAt = Number.POSITIVE_INFINITY;
        let lastActivityAt = 0;
        for (const line of content.split('\n')) {
            if (!line.trim())
                continue;
            let event;
            try {
                event = JSON.parse(line);
            }
            catch {
                continue;
            }
            const role = this.getAgyRole(event);
            if (!role)
                continue;
            const text = this.extractAgyText(event.content);
            if (!text)
                continue;
            const timestampMs = this.parseAgyTimestamp(event.created_at);
            if (timestampMs !== null) {
                startedAt = Math.min(startedAt, timestampMs);
                lastActivityAt = Math.max(lastActivityAt, timestampMs);
            }
            messages.push({
                role,
                content: text,
                timestamp: timestampMs === null ? undefined : new Date(timestampMs).toISOString(),
            });
        }
        if (messages.length === 0)
            return null;
        const firstPrompt = messages.find((message) => message.role === 'user')?.content || '';
        const lastAssistantPreview = [...messages]
            .reverse()
            .find((message) => message.role === 'assistant')
            ?.content.slice(-500);
        const fallbackTime = stat.mtimeMs || Date.now();
        return {
            id: sessionId,
            agentType: 'agy',
            cwd: workspacePath,
            startedAt: Number.isFinite(startedAt) ? startedAt : fallbackTime,
            lastActivityAt: lastActivityAt || fallbackTime,
            firstPrompt: firstPrompt.slice(0, 300),
            lastAssistantPreview,
            messageCount: messages.filter((message) => message.role === 'user').length,
            isActive: false,
            filePath: transcriptPath,
            projectPath: workspacePath || undefined,
        };
    }
    async scanAgySessions() {
        const candidates = [];
        await this.collectAgyCandidates(candidates);
        const byId = new Map();
        await Promise.allSettled(candidates.map(async (candidate) => {
            const session = await candidate.parse();
            if (!session)
                return;
            const existing = byId.get(session.id);
            if (!existing || session.lastActivityAt > existing.lastActivityAt)
                byId.set(session.id, session);
        }));
        const sessions = [...byId.values()];
        for (const root of this.agyDataRoots()) {
            let db = null;
            try {
                db = new better_sqlite3_1.default(path_1.default.join(root, 'conversation_summaries.db'), { readonly: true, fileMustExist: true });
                const rows = db.prepare('SELECT conversation_id, title FROM conversation_summaries WHERE TRIM(title) <> ?').all('');
                const titles = new Map(rows.map((row) => [row.conversation_id, row.title.trim()]));
                for (const session of sessions) {
                    const title = titles.get(session.id);
                    if (title)
                        session.sessionName = title;
                }
            }
            catch {
                // Transcript parsing remains available if the optional summary DB is
                // absent, locked, or from an older Agy build.
            }
            finally {
                db?.close();
            }
        }
        return sessions;
    }
    async getAgySessionDetail(sessionId) {
        const sessions = await this.scanAgySessions();
        const session = sessions.find((candidate) => candidate.id === sessionId);
        return session ? this.getAgySessionDetailFromSession(session) : null;
    }
    async getAgySessionDetailFromSession(session) {
        const parsed = await this.parseAgyTranscript(session.filePath, session.id, session.cwd);
        if (!parsed)
            return null;
        const content = await fs_1.promises.readFile(session.filePath, 'utf8');
        const messages = [];
        for (const line of content.split('\n')) {
            if (!line.trim())
                continue;
            try {
                const event = JSON.parse(line);
                const role = this.getAgyRole(event);
                const messageContent = role ? this.extractAgyText(event.content) : '';
                if (!role || !messageContent)
                    continue;
                const timestampMs = this.parseAgyTimestamp(event.created_at);
                messages.push({
                    role,
                    content: messageContent,
                    timestamp: timestampMs === null ? undefined : new Date(timestampMs).toISOString(),
                });
            }
            catch {
                // Skip truncated or non-JSON event lines.
            }
        }
        return { ...session, ...parsed, messages };
    }
    // ── Hermes Agent (SQLite-backed) ───────────────────────────────────────
    // Hermes stores canonical sessions in $HERMES_HOME/state.db (normally
    // ~/.hermes/state.db). Compression rotates a conversation to a child
    // session, so the list projects each visible root/branch to its live tip.
    openHermesDb() {
        if (Date.now() < this.hermesDbAbsentUntil)
            return null;
        const dbPath = path_1.default.join((0, hermesPaths_1.getHermesHome)(), 'state.db');
        try {
            return new better_sqlite3_1.default(dbPath, { readonly: true, fileMustExist: true });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const isMissing = message.includes('ENOENT') || message.includes('unable to open database file');
            this.hermesDbAbsentUntil = Date.now() + (isMissing ? this.CACHE_TTL : 5_000);
            if (!isMissing) {
                console.warn(`[resume] failed to open Hermes db at ${dbPath}:`, message);
            }
            return null;
        }
    }
    async scanHermesSessions() {
        const db = this.openHermesDb();
        if (!db)
            return [];
        try {
            const messageColumns = db.prepare(`PRAGMA table_info(messages)`).all();
            const hasActive = messageColumns.some((column) => column.name === 'active');
            const hasCompacted = messageColumns.some((column) => column.name === 'compacted');
            const visibleMessageSql = hasActive && hasCompacted
                ? 'AND (m.active = 1 OR m.compacted = 1)'
                : hasActive
                    ? 'AND m.active = 1'
                    : '';
            const rows = db.prepare(`
        WITH RECURSIVE
        listable AS (
          SELECT s.id
          FROM sessions s
          WHERE COALESCE(s.archived, 0) = 0
            AND json_extract(COALESCE(s.model_config, '{}'), '$._delegate_from') IS NULL
            AND (
              s.parent_session_id IS NULL
              OR json_extract(COALESCE(s.model_config, '{}'), '$._branched_from') IS NOT NULL
              OR EXISTS (
                SELECT 1 FROM sessions branch_parent
                WHERE branch_parent.id = s.parent_session_id
                  AND branch_parent.end_reason = 'branched'
                  AND s.started_at >= branch_parent.ended_at
              )
            )
        ),
        chain(root_id, cur_id, depth) AS (
          SELECT id, id, 0 FROM listable
          UNION ALL
          SELECT chain.root_id, child.id, chain.depth + 1
          FROM chain
          JOIN sessions parent ON parent.id = chain.cur_id
          JOIN sessions child ON child.parent_session_id = parent.id
          WHERE parent.end_reason = 'compression'
            AND child.started_at >= parent.ended_at
        ),
        ranked_tips AS (
          SELECT root_id, cur_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY root_id
                   ORDER BY depth DESC,
                            (SELECT started_at FROM sessions WHERE id = cur_id) DESC,
                            cur_id DESC
                 ) AS tip_rank
          FROM chain
        )
        SELECT tip.id,
               tip.cwd,
               tip.model,
               tip.title,
               root.started_at AS root_started_at,
               COALESCE(
                 (SELECT MAX(m.timestamp)
                  FROM messages m
                  JOIN chain activity_chain ON activity_chain.cur_id = m.session_id
                  WHERE activity_chain.root_id = root.id ${visibleMessageSql}),
                 tip.started_at
               ) AS last_activity_at,
               COALESCE(
                 (SELECT m.content
                  FROM messages m
                  JOIN chain prompt_chain ON prompt_chain.cur_id = m.session_id
                  WHERE prompt_chain.root_id = root.id
                    AND m.role = 'user'
                    AND m.content IS NOT NULL
                    AND TRIM(m.content) <> '' ${visibleMessageSql}
                  ORDER BY m.timestamp ASC, m.id ASC LIMIT 1),
                 tip.title,
                 ''
               ) AS first_prompt,
               (SELECT m.content
                FROM messages m
                JOIN chain assistant_chain ON assistant_chain.cur_id = m.session_id
                WHERE assistant_chain.root_id = root.id
                  AND m.role = 'assistant'
                  AND m.content IS NOT NULL
                  AND TRIM(m.content) <> '' ${visibleMessageSql}
                ORDER BY m.timestamp DESC, m.id DESC LIMIT 1) AS last_assistant,
               (SELECT COUNT(*)
                FROM messages m
                JOIN chain count_chain ON count_chain.cur_id = m.session_id
                WHERE count_chain.root_id = root.id
                  AND m.role IN ('user', 'assistant') ${visibleMessageSql}) AS visible_message_count
        FROM ranked_tips ranked
        JOIN sessions tip ON tip.id = ranked.cur_id
        JOIN sessions root ON root.id = ranked.root_id
        WHERE ranked.tip_rank = 1
        ORDER BY last_activity_at DESC, root_started_at DESC
        LIMIT 500
      `).all();
            const dbPath = path_1.default.join((0, hermesPaths_1.getHermesHome)(), 'state.db');
            return rows.map((row) => {
                const cwd = row.cwd?.trim() || '';
                const firstPrompt = row.first_prompt?.trim() || row.title?.trim() || '';
                const lastAssistant = row.last_assistant?.trim();
                return {
                    id: row.id,
                    agentType: 'hermes',
                    cwd,
                    startedAt: row.root_started_at * 1_000,
                    lastActivityAt: row.last_activity_at * 1_000,
                    firstPrompt: firstPrompt.slice(0, 300),
                    sessionName: row.title?.trim() || undefined,
                    lastAssistantPreview: lastAssistant ? lastAssistant.slice(0, 500) : undefined,
                    messageCount: row.visible_message_count ?? 0,
                    isActive: false,
                    filePath: dbPath,
                    projectPath: cwd || undefined,
                    model: row.model?.trim() || undefined,
                };
            });
        }
        catch (error) {
            console.warn('[resume] Hermes scan failed:', error instanceof Error ? error.message : error);
            return [];
        }
        finally {
            db.close();
        }
    }
    resolveHermesCompressionTip(db, sessionId) {
        const row = db.prepare(`
      WITH RECURSIVE chain(id, depth) AS (
        SELECT id, 0 FROM sessions WHERE id = ?
        UNION ALL
        SELECT child.id, chain.depth + 1
        FROM chain
        JOIN sessions parent ON parent.id = chain.id
        JOIN sessions child ON child.parent_session_id = parent.id
        WHERE parent.end_reason = 'compression'
          AND child.started_at >= parent.ended_at
      )
      SELECT id FROM chain ORDER BY depth DESC, id DESC LIMIT 1
    `).get(sessionId);
        return row?.id ?? null;
    }
    async getHermesSessionDetail(sessionId) {
        const db = this.openHermesDb();
        if (!db)
            return null;
        try {
            const tipId = this.resolveHermesCompressionTip(db, sessionId);
            if (!tipId)
                return null;
            const sessionRow = db.prepare(`
        WITH RECURSIVE lineage(id, depth) AS (
          SELECT id, 0 FROM sessions WHERE id = ?
          UNION ALL
          SELECT parent.id, lineage.depth + 1
          FROM lineage
          JOIN sessions child ON child.id = lineage.id
          JOIN sessions parent ON parent.id = child.parent_session_id
          WHERE parent.end_reason = 'compression'
            AND child.started_at >= parent.ended_at
        )
        SELECT tip.id,
               tip.cwd,
               tip.model,
               tip.title,
               (SELECT MIN(s.started_at) FROM sessions s JOIN lineage ON lineage.id = s.id) AS started_at,
               COALESCE(
                 (SELECT MAX(m.timestamp) FROM messages m JOIN lineage ON lineage.id = m.session_id),
                 tip.started_at
               ) AS last_activity_at
        FROM sessions tip
        WHERE tip.id = ?
      `).get(tipId, tipId);
            if (!sessionRow)
                return null;
            const messageColumns = db.prepare(`PRAGMA table_info(messages)`).all();
            const hasActive = messageColumns.some((column) => column.name === 'active');
            const hasCompacted = messageColumns.some((column) => column.name === 'compacted');
            const visibleCondition = hasActive && hasCompacted
                ? 'AND (m.active = 1 OR m.compacted = 1)'
                : hasActive
                    ? 'AND m.active = 1'
                    : '';
            const rows = db.prepare(`
        WITH RECURSIVE lineage(id, depth) AS (
          SELECT id, 0 FROM sessions WHERE id = ?
          UNION ALL
          SELECT parent.id, lineage.depth + 1
          FROM lineage
          JOIN sessions child ON child.id = lineage.id
          JOIN sessions parent ON parent.id = child.parent_session_id
          WHERE parent.end_reason = 'compression'
            AND child.started_at >= parent.ended_at
        )
        SELECT m.role, m.content, m.timestamp
        FROM messages m
        JOIN lineage ON lineage.id = m.session_id
        WHERE m.role IN ('user', 'assistant')
          AND m.content IS NOT NULL
          AND TRIM(m.content) <> '' ${visibleCondition}
        ORDER BY m.timestamp ASC, m.id ASC
      `).all(tipId);
            const messages = rows.map((row) => ({
                role: row.role,
                content: row.content,
                timestamp: new Date(row.timestamp * 1_000).toISOString(),
            }));
            const firstPrompt = messages.find((message) => message.role === 'user')?.content.trim() || '';
            const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')?.content.trim();
            const cwd = sessionRow.cwd?.trim() || '';
            return {
                id: sessionRow.id,
                agentType: 'hermes',
                cwd,
                startedAt: sessionRow.started_at * 1_000,
                lastActivityAt: sessionRow.last_activity_at * 1_000,
                firstPrompt: (firstPrompt || sessionRow.title?.trim() || '').slice(0, 300),
                sessionName: sessionRow.title?.trim() || undefined,
                lastAssistantPreview: lastAssistant ? lastAssistant.slice(0, 500) : undefined,
                messageCount: messages.length,
                isActive: false,
                filePath: path_1.default.join((0, hermesPaths_1.getHermesHome)(), 'state.db'),
                projectPath: cwd || undefined,
                model: sessionRow.model?.trim() || undefined,
                messages,
            };
        }
        catch (error) {
            console.warn('[resume] Hermes detail failed:', error instanceof Error ? error.message : error);
            return null;
        }
        finally {
            db.close();
        }
    }
    // ── OpenCode (SQLite-backed) ────────────────────────────────────────────
    // OpenCode stores sessions in `~/.local/share/opencode/opencode.db`. We open
    // the DB read-only so a running opencode process keeps write access without
    // contention.
    openOpencodeDb() {
        // Skip the open attempt if a recent miss told us the file isn't there.
        // Users without opencode would otherwise pay an fs stat on every
        // getAllSessions cache miss (every 30s).
        if (Date.now() < this.opencodeDbAbsentUntil)
            return null;
        const dbPath = path_1.default.join((0, agentPaths_1.getAgentRoot)('opencode', this.getOverrides()), 'opencode.db');
        try {
            // `readonly + fileMustExist` avoids creating/recreating the file when
            // opencode hasn't been used yet. WAL files from a live opencode process
            // are tolerated because we only read.
            return new better_sqlite3_1.default(dbPath, { readonly: true, fileMustExist: true });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // ENOENT is the common case (no opencode installed); cache it so we
            // don't re-stat for the cache window. Other errors (lock, corrupt,
            // permission) get logged and cached more briefly.
            const isMissing = message.includes('ENOENT') || message.includes('unable to open database file');
            this.opencodeDbAbsentUntil = Date.now() + (isMissing ? this.CACHE_TTL : 5_000);
            if (!isMissing) {
                console.warn(`[resume] failed to open opencode db at ${dbPath}:`, message);
            }
            return null;
        }
    }
    async scanOpencodeSessions() {
        const db = this.openOpencodeDb();
        if (!db)
            return [];
        try {
            // Single query: top-N sessions joined with their message count. The
            // correlated COUNT subquery uses the existing (session_id) index on
            // message — measured ~1ms per session vs. ~1ms per session for a
            // separate prepare+execute, so we save the round-trip overhead.
            const cols = db.prepare(`PRAGMA table_info(session)`).all();
            const hasModel = cols.some((c) => c.name === 'model');
            const hasParentId = cols.some((c) => c.name === 'parent_id');
            const sessionRows = db.prepare(`
        SELECT s.id, s.directory, s.title, s.time_created, s.time_updated${hasModel ? ', s.model' : ''}${hasParentId ? ', s.parent_id' : ''},
               (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS message_count
        FROM session s
        WHERE s.time_archived IS NULL
        ORDER BY s.time_updated DESC
        LIMIT 500
      `).all();
            if (sessionRows.length === 0)
                return [];
            // Single query for first-prompt text across ALL listed sessions. The
            // first message (lowest time_created) of each opencode session is the
            // user's initial prompt, so we don't need to filter by role — pick the
            // first `type:"text"` part of that message in JS. Avoids 500 N+1
            // sub-queries.
            const placeholders = sessionRows.map(() => '?').join(',');
            const partRows = db.prepare(`
        SELECT p.session_id, p.data
        FROM part p
        WHERE p.message_id IN (
          SELECT MIN(m.id) FROM message m
          WHERE m.session_id IN (${placeholders})
          GROUP BY m.session_id
        )
        ORDER BY p.session_id, p.time_created ASC
      `).all(...sessionRows.map((r) => r.id));
            const firstPromptBySession = new Map();
            for (const row of partRows) {
                if (firstPromptBySession.has(row.session_id))
                    continue;
                try {
                    const parsed = JSON.parse(row.data);
                    if (parsed?.type === 'text' && typeof parsed.text === 'string' && parsed.text.trim()) {
                        firstPromptBySession.set(row.session_id, parsed.text.trim());
                    }
                }
                catch {
                    // Skip unparseable rows
                }
            }
            const dbFilePath = path_1.default.join((0, agentPaths_1.getAgentRoot)('opencode', this.getOverrides()), 'opencode.db');
            const sessions = [];
            for (const row of sessionRows) {
                const cwd = (row.directory || '').trim();
                if (!cwd)
                    continue;
                const firstPrompt = firstPromptBySession.get(row.id) || (row.title || '').trim();
                sessions.push({
                    id: row.id,
                    agentType: 'opencode',
                    cwd,
                    startedAt: row.time_created,
                    lastActivityAt: row.time_updated,
                    firstPrompt: firstPrompt.slice(0, 300),
                    sessionName: (row.title || '').trim() || undefined,
                    messageCount: row.message_count ?? 0,
                    isActive: false,
                    // SQLite is the canonical store — point at the DB so callers have
                    // a stable filesystem reference for display/export.
                    filePath: dbFilePath,
                    projectPath: cwd,
                    model: row.model || undefined,
                    parentId: row.parent_id || undefined,
                });
            }
            return sessions;
        }
        catch (error) {
            console.warn('[resume] opencode scan failed:', error instanceof Error ? error.message : error);
            return [];
        }
        finally {
            db.close();
        }
    }
    async getOpencodeSessionDetail(sessionId) {
        const db = this.openOpencodeDb();
        if (!db)
            return null;
        try {
            const sessionRow = db.prepare(`
        SELECT id, directory, title, time_created, time_updated
        FROM session WHERE id = ?
      `).get(sessionId);
            if (!sessionRow)
                return null;
            // Walk messages in chronological order, joining their text parts.
            const messageRows = db.prepare(`
        SELECT id, time_created, data FROM message
        WHERE session_id = ? ORDER BY time_created ASC, id ASC
      `).all(sessionId);
            const partsByMessage = new Map();
            const partRows = db.prepare(`
        SELECT message_id, data FROM part
        WHERE session_id = ? ORDER BY time_created ASC, id ASC
      `).all(sessionId);
            for (const part of partRows) {
                try {
                    const parsed = JSON.parse(part.data);
                    if (parsed?.type === 'text' && typeof parsed.text === 'string') {
                        const list = partsByMessage.get(part.message_id) ?? [];
                        list.push(parsed.text);
                        partsByMessage.set(part.message_id, list);
                    }
                }
                catch {
                    // Skip unparseable parts
                }
            }
            const messages = [];
            let firstPrompt = '';
            let lastAssistantPreview = '';
            for (const row of messageRows) {
                let role;
                try {
                    const parsed = JSON.parse(row.data);
                    if (parsed?.role === 'user')
                        role = 'user';
                    else if (parsed?.role === 'assistant')
                        role = 'assistant';
                }
                catch {
                    // Skip
                }
                if (!role)
                    continue;
                const text = (partsByMessage.get(row.id) ?? []).join('\n').trim();
                if (!text)
                    continue;
                if (role === 'user' && !firstPrompt)
                    firstPrompt = text;
                if (role === 'assistant')
                    lastAssistantPreview = text;
                messages.push({
                    role,
                    content: text,
                    timestamp: new Date(row.time_created).toISOString(),
                });
            }
            const cwd = (sessionRow.directory || '').trim();
            const session = {
                id: sessionRow.id,
                agentType: 'opencode',
                cwd,
                startedAt: sessionRow.time_created,
                lastActivityAt: sessionRow.time_updated,
                firstPrompt: (firstPrompt || sessionRow.title || '').slice(0, 300),
                lastAssistantPreview: lastAssistantPreview ? lastAssistantPreview.slice(0, 500) : undefined,
                messageCount: messages.length,
                isActive: false,
                filePath: path_1.default.join((0, agentPaths_1.getAgentRoot)('opencode', this.getOverrides()), 'opencode.db'),
                projectPath: cwd,
            };
            return { ...session, messages };
        }
        catch {
            return null;
        }
        finally {
            db.close();
        }
    }
}
exports.ResumeManager = ResumeManager;
