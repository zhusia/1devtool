"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiDiffSessionManager = void 0;
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const promises_1 = __importDefault(require("fs/promises"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const util_1 = require("util");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const NON_GIT_FILE_LIMIT = 5000;
const EMPTY_CONTENT_HASH = (0, crypto_1.createHash)('sha1').update('').digest('hex');
const IGNORED_DIRS = new Set([
    '.git',
    'node_modules',
    'dist',
    'build',
    '.next',
    '.nuxt',
    'coverage',
    '__pycache__',
    'target',
    'vendor',
]);
class AiDiffSessionManager {
    emitSessionUpdate;
    sessions = new Map();
    activeSessionByTerminal = new Map();
    fallbackIgnoreGitDir = null;
    constructor(emitSessionUpdate) {
        this.emitSessionUpdate = emitSessionUpdate;
    }
    async startSession(args) {
        const priorSessionId = this.activeSessionByTerminal.get(args.terminalId);
        if (priorSessionId) {
            this.endSession(priorSessionId, 'sealed');
        }
        const startedAt = Date.now();
        const session = {
            id: this.generateSessionId(),
            terminalId: args.terminalId,
            projectId: args.projectId,
            projectRoot: args.projectRoot,
            agentKind: args.agentKind,
            startedAt,
            updatedAt: startedAt,
            promptText: args.promptText.trim().slice(0, 200),
            status: 'running',
            warmingUp: true,
            pendingCount: 0,
        };
        const state = {
            session,
            baselines: new Map(),
            pendingChanges: new Map(),
            queuedPaths: new Set(),
            debounceTimers: new Map(),
            dirtyPathsAtStart: new Set(),
            isGitRepo: false,
            nonGitSnapshotComplete: true,
        };
        this.sessions.set(session.id, state);
        this.activeSessionByTerminal.set(args.terminalId, session.id);
        this.emit(state);
        void this.prepareSession(state).catch((error) => {
            console.warn('[ai-diff] Failed to prepare session baseline', error);
            state.session.warmingUp = false;
            state.session.updatedAt = Date.now();
            this.emit(state);
            void this.flushQueuedPaths(state);
        });
        return { ...session };
    }
    endSession(sessionId, status) {
        const state = this.sessions.get(sessionId);
        if (!state) {
            return null;
        }
        if (state.session.status !== status) {
            state.session.status = status;
            state.session.updatedAt = Date.now();
            this.emit(state);
        }
        if (this.activeSessionByTerminal.get(state.session.terminalId) === sessionId && status === 'sealed') {
            this.activeSessionByTerminal.delete(state.session.terminalId);
        }
        return { ...state.session };
    }
    endRunningSessionForTerminal(terminalId, status) {
        const sessionId = this.activeSessionByTerminal.get(terminalId);
        if (!sessionId) {
            return null;
        }
        const state = this.sessions.get(sessionId);
        if (!state || state.session.status !== 'running') {
            return state ? { ...state.session } : null;
        }
        return this.endSession(sessionId, status);
    }
    listSessions(projectId) {
        return [...this.sessions.values()]
            .map(({ session }) => ({ ...session }))
            .filter((session) => !projectId || session.projectId === projectId)
            .sort((a, b) => b.startedAt - a.startedAt);
    }
    listPendingChanges(sessionId) {
        const state = this.requireSession(sessionId);
        return [...state.pendingChanges.values()]
            .map((change) => ({ ...change, diffSummary: { ...change.diffSummary } }))
            .sort((a, b) => a.relPath.localeCompare(b.relPath));
    }
    async getBaselineContent(sessionId, filePath) {
        const state = this.requireSession(sessionId);
        if (await this.isPathIgnoredForSession(state, filePath)) {
            return null;
        }
        const baseline = await this.ensureBaselineLoaded(state, filePath);
        return baseline.textContent;
    }
    async getDiff(sessionId, filePath) {
        const state = this.requireSession(sessionId);
        if (await this.isPathIgnoredForSession(state, filePath)) {
            return '';
        }
        const baseline = await this.ensureBaselineLoaded(state, filePath);
        const current = await this.readCurrentFile(filePath);
        if (baseline.textContent === null && baseline.kind !== 'empty') {
            return '';
        }
        if (!current.exists || current.isBinary || current.isTooLarge || current.textContent === null) {
            if (baseline.kind === 'empty' && !current.exists) {
                return '';
            }
            return '';
        }
        return this.buildUnifiedDiff(baseline.textContent ?? '', current.textContent, baseline.relPath);
    }
    async acceptChange(sessionId, filePath) {
        const state = this.requireSession(sessionId);
        const baseline = await this.createAcceptedBaseline(state, filePath);
        state.baselines.set(filePath, baseline);
        state.pendingChanges.delete(filePath);
        this.touchSession(state);
        this.emit(state);
    }
    async revertFile(sessionId, filePath) {
        const state = this.requireSession(sessionId);
        const baseline = await this.ensureBaselineLoaded(state, filePath);
        if (!baseline.canRevert) {
            throw new Error('Baseline is unavailable for this file');
        }
        if (baseline.kind === 'git-head') {
            await this.runGit(['checkout', 'HEAD', '--', baseline.relPath], state.session.projectRoot);
        }
        else if (baseline.kind === 'empty') {
            await promises_1.default.rm(filePath, { force: true });
        }
        else if (baseline.rawContent !== null) {
            await promises_1.default.mkdir(path_1.default.dirname(filePath), { recursive: true });
            await promises_1.default.writeFile(filePath, baseline.rawContent);
        }
        else {
            throw new Error('Baseline is unavailable for this file');
        }
        state.pendingChanges.delete(filePath);
        this.touchSession(state);
        this.emit(state);
    }
    handleFsEvent(eventType, filePath) {
        if (eventType === 'addDir' || eventType === 'unlinkDir') {
            return;
        }
        for (const state of this.sessions.values()) {
            if (state.session.status !== 'running') {
                continue;
            }
            if (!this.isWithinRoot(state.session.projectRoot, filePath)) {
                continue;
            }
            const existingTimer = state.debounceTimers.get(filePath);
            if (existingTimer) {
                clearTimeout(existingTimer);
            }
            const timer = setTimeout(() => {
                state.debounceTimers.delete(filePath);
                void this.reconcilePath(state, filePath);
            }, 250);
            state.debounceTimers.set(filePath, timer);
        }
    }
    async prepareSession(state) {
        state.isGitRepo = await this.detectGitRepo(state.session.projectRoot);
        if (state.isGitRepo) {
            const dirtyPaths = await this.getDirtyPaths(state.session.projectRoot);
            state.dirtyPathsAtStart = new Set();
            for (const relPath of dirtyPaths) {
                const absPath = path_1.default.join(state.session.projectRoot, relPath);
                const snapshot = await this.readCurrentFile(absPath);
                if (this.snapshotChangedAfterSessionStart(state, snapshot)) {
                    state.queuedPaths.add(absPath);
                    continue;
                }
                state.dirtyPathsAtStart.add(relPath);
                state.baselines.set(absPath, this.snapshotToBaseline(relPath, snapshot));
            }
        }
        else {
            const { files, truncated } = await this.walkProjectFiles(state.session.projectRoot, NON_GIT_FILE_LIMIT);
            state.nonGitSnapshotComplete = !truncated;
            for (const absPath of files) {
                const relPath = this.toRelPath(state.session.projectRoot, absPath);
                const snapshot = await this.readCurrentFile(absPath);
                if (this.snapshotChangedAfterSessionStart(state, snapshot)) {
                    state.queuedPaths.add(absPath);
                    continue;
                }
                state.baselines.set(absPath, this.snapshotToBaseline(relPath, snapshot));
            }
        }
        state.session.warmingUp = false;
        this.touchSession(state);
        this.emit(state);
        await this.flushQueuedPaths(state);
    }
    async flushQueuedPaths(state) {
        if (state.queuedPaths.size === 0) {
            return;
        }
        const queued = [...state.queuedPaths];
        state.queuedPaths.clear();
        for (const filePath of queued) {
            await this.reconcilePath(state, filePath);
        }
    }
    async reconcilePath(state, filePath) {
        if (state.session.status !== 'running') {
            return;
        }
        if (state.session.warmingUp) {
            state.queuedPaths.add(filePath);
            return;
        }
        const relPath = this.toRelPath(state.session.projectRoot, filePath);
        if (await this.isPathIgnoredForSession(state, filePath, relPath)) {
            state.baselines.delete(filePath);
            if (state.pendingChanges.delete(filePath)) {
                this.touchSession(state);
                this.emit(state);
            }
            return;
        }
        const baseline = await this.ensureBaselineLoaded(state, filePath);
        const current = await this.readCurrentFile(filePath);
        if (baseline.kind === 'git-head') {
            const isDirty = await this.isGitPathDirty(state.session.projectRoot, baseline.relPath);
            if (!isDirty) {
                if (state.pendingChanges.delete(filePath)) {
                    this.touchSession(state);
                    this.emit(state);
                }
                return;
            }
        }
        else if (this.matchesBaseline(baseline, current)) {
            if (state.pendingChanges.delete(filePath)) {
                this.touchSession(state);
                this.emit(state);
            }
            return;
        }
        const change = await this.buildPendingChange(state, filePath, baseline, current);
        state.pendingChanges.set(filePath, change);
        this.touchSession(state);
        this.emit(state);
        if (this.isGitignoreFile(relPath)) {
            await this.dropIgnoredPendingChanges(state);
        }
    }
    async buildPendingChange(state, filePath, baseline, current) {
        const baselineLoaded = await this.ensureBaselineLoaded(state, filePath);
        const changeKind = this.detectChangeKind(baselineLoaded, current);
        const diffSummary = await this.summarizeDiff(baselineLoaded, current);
        return {
            sessionId: state.session.id,
            projectId: state.session.projectId,
            filePath,
            relPath: baselineLoaded.relPath,
            changeKind,
            baselineHash: baselineLoaded.sha1,
            baselineSize: baselineLoaded.size,
            currentHash: current.sha1,
            currentSize: current.size,
            diffSummary,
            reviewState: 'pending',
            detectedAt: Date.now(),
            attributedToTerminalId: state.session.terminalId,
            canRevert: baselineLoaded.canRevert,
        };
    }
    async summarizeDiff(baseline, current) {
        if (baseline.textContent === null ||
            current.textContent === null ||
            baseline.isBinary ||
            current.isBinary ||
            baseline.isTooLarge ||
            current.isTooLarge) {
            return { added: 0, removed: 0 };
        }
        return this.getDiffStat(baseline.textContent, current.textContent);
    }
    async createAcceptedBaseline(state, filePath) {
        const relPath = this.toRelPath(state.session.projectRoot, filePath);
        const current = await this.readCurrentFile(filePath);
        if (!current.exists) {
            return this.emptyBaseline(relPath);
        }
        if (current.isTooLarge) {
            return {
                kind: 'unavailable',
                relPath,
                gitContentLoaded: true,
                exists: true,
                size: current.size,
                mtimeMs: current.mtimeMs,
                birthtimeMs: current.birthtimeMs,
                sha1: current.sha1,
                textContent: null,
                rawContent: null,
                isBinary: current.isBinary,
                isTooLarge: true,
                canRevert: false,
            };
        }
        return this.snapshotToBaseline(relPath, current);
    }
    async ensureBaselineLoaded(state, filePath) {
        const existing = state.baselines.get(filePath);
        if (existing) {
            if (existing.kind === 'git-head' && !existing.gitContentLoaded) {
                const loaded = await this.loadGitBaseline(state, existing.relPath);
                state.baselines.set(filePath, loaded);
                return loaded;
            }
            return existing;
        }
        const relPath = this.toRelPath(state.session.projectRoot, filePath);
        if (state.isGitRepo) {
            if (state.dirtyPathsAtStart.has(relPath)) {
                const snapshot = await this.readCurrentFile(filePath);
                const baseline = this.snapshotToBaseline(relPath, snapshot);
                state.baselines.set(filePath, baseline);
                return baseline;
            }
            const trackedAtHead = await this.isTrackedAtHead(state.session.projectRoot, relPath);
            const baseline = trackedAtHead
                ? this.unloadedGitBaseline(relPath)
                : this.emptyBaseline(relPath);
            state.baselines.set(filePath, baseline);
            return this.ensureBaselineLoaded(state, filePath);
        }
        const baseline = state.nonGitSnapshotComplete
            ? this.emptyBaseline(relPath)
            : this.unavailableBaseline(relPath);
        state.baselines.set(filePath, baseline);
        return baseline;
    }
    unloadedGitBaseline(relPath) {
        return {
            kind: 'git-head',
            relPath,
            gitContentLoaded: false,
            exists: true,
            size: null,
            mtimeMs: null,
            birthtimeMs: null,
            sha1: null,
            textContent: null,
            rawContent: null,
            isBinary: false,
            isTooLarge: false,
            canRevert: true,
        };
    }
    emptyBaseline(relPath) {
        return {
            kind: 'empty',
            relPath,
            gitContentLoaded: true,
            exists: false,
            size: 0,
            mtimeMs: null,
            birthtimeMs: null,
            sha1: EMPTY_CONTENT_HASH,
            textContent: '',
            rawContent: Buffer.from('', 'utf8'),
            isBinary: false,
            isTooLarge: false,
            canRevert: true,
        };
    }
    unavailableBaseline(relPath) {
        return {
            kind: 'unavailable',
            relPath,
            gitContentLoaded: true,
            exists: true,
            size: null,
            mtimeMs: null,
            birthtimeMs: null,
            sha1: null,
            textContent: null,
            rawContent: null,
            isBinary: false,
            isTooLarge: true,
            canRevert: false,
        };
    }
    snapshotToBaseline(relPath, snapshot) {
        if (!snapshot.exists) {
            return this.emptyBaseline(relPath);
        }
        return {
            kind: 'snapshot',
            relPath,
            gitContentLoaded: true,
            exists: snapshot.exists,
            size: snapshot.size,
            mtimeMs: snapshot.mtimeMs,
            birthtimeMs: snapshot.birthtimeMs,
            sha1: snapshot.sha1,
            textContent: snapshot.textContent,
            rawContent: snapshot.rawContent,
            isBinary: snapshot.isBinary,
            isTooLarge: snapshot.isTooLarge,
            canRevert: snapshot.canRevert,
        };
    }
    snapshotChangedAfterSessionStart(state, snapshot) {
        if (!snapshot.exists) {
            return false;
        }
        return snapshot.mtimeMs !== null && snapshot.mtimeMs > state.session.startedAt + 1;
    }
    matchesBaseline(baseline, current) {
        if (baseline.kind === 'unavailable') {
            return false;
        }
        if (baseline.kind === 'empty') {
            return !current.exists;
        }
        return baseline.sha1 !== null && baseline.sha1 === current.sha1;
    }
    detectChangeKind(baseline, current) {
        if (!current.exists) {
            return 'deleted';
        }
        if (baseline.kind === 'empty') {
            return 'added';
        }
        if (baseline.isBinary || baseline.isTooLarge || current.isBinary || current.isTooLarge || baseline.kind === 'unavailable') {
            return 'binary';
        }
        return 'modified';
    }
    async readCurrentFile(filePath) {
        try {
            const stats = await promises_1.default.stat(filePath);
            if (!stats.isFile()) {
                return this.missingFileSnapshot();
            }
            if (stats.size > MAX_SNAPSHOT_BYTES) {
                return {
                    exists: true,
                    size: stats.size,
                    mtimeMs: stats.mtimeMs,
                    birthtimeMs: stats.birthtimeMs,
                    sha1: `large:${stats.size}:${Math.trunc(stats.mtimeMs)}`,
                    textContent: null,
                    rawContent: null,
                    isBinary: false,
                    isTooLarge: true,
                    canRevert: false,
                };
            }
            const rawContent = await promises_1.default.readFile(filePath);
            const isBinary = this.isBinaryBuffer(rawContent);
            return {
                exists: true,
                size: stats.size,
                mtimeMs: stats.mtimeMs,
                birthtimeMs: stats.birthtimeMs,
                sha1: this.sha1(rawContent),
                textContent: isBinary ? null : rawContent.toString('utf8'),
                rawContent,
                isBinary,
                isTooLarge: false,
                canRevert: true,
            };
        }
        catch (error) {
            if (this.isMissingFileError(error)) {
                return this.missingFileSnapshot();
            }
            throw error;
        }
    }
    missingFileSnapshot() {
        return {
            exists: false,
            size: null,
            mtimeMs: null,
            birthtimeMs: null,
            sha1: null,
            textContent: null,
            rawContent: null,
            isBinary: false,
            isTooLarge: false,
            canRevert: true,
        };
    }
    async loadGitBaseline(state, relPath) {
        const sizeOutput = await this.runGit(['cat-file', '-s', `HEAD:${relPath}`], state.session.projectRoot);
        const size = Number(sizeOutput.stdout.trim());
        if (!Number.isFinite(size)) {
            return this.unavailableBaseline(relPath);
        }
        if (size > MAX_SNAPSHOT_BYTES) {
            return {
                ...this.unloadedGitBaseline(relPath),
                gitContentLoaded: true,
                size,
                sha1: `git-head-large:${size}`,
                isTooLarge: true,
            };
        }
        const content = await this.runGitBuffer(['show', `HEAD:${relPath}`], state.session.projectRoot);
        const isBinary = this.isBinaryBuffer(content);
        return {
            kind: 'git-head',
            relPath,
            gitContentLoaded: true,
            exists: true,
            size: content.length,
            mtimeMs: null,
            birthtimeMs: null,
            sha1: this.sha1(content),
            textContent: isBinary ? null : content.toString('utf8'),
            rawContent: isBinary ? content : Buffer.from(content),
            isBinary,
            isTooLarge: false,
            canRevert: true,
        };
    }
    async detectGitRepo(projectRoot) {
        try {
            await this.runGit(['rev-parse', '--is-inside-work-tree'], projectRoot);
            return true;
        }
        catch {
            return false;
        }
    }
    async getDirtyPaths(projectRoot) {
        try {
            const result = await this.runGit(['-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all'], projectRoot);
            return result.stdout
                .split('\n')
                .map((line) => line.trimEnd())
                .filter(Boolean)
                .map((line) => {
                const payload = line.slice(3);
                if (payload.includes(' -> ')) {
                    return payload.split(' -> ').at(-1) ?? payload;
                }
                return payload;
            });
        }
        catch {
            return [];
        }
    }
    async isTrackedAtHead(projectRoot, relPath) {
        try {
            await this.runGit(['cat-file', '-e', `HEAD:${relPath}`], projectRoot);
            return true;
        }
        catch {
            return false;
        }
    }
    async isGitPathDirty(projectRoot, relPath) {
        try {
            await this.runGit(['diff', '--quiet', '--no-ext-diff', 'HEAD', '--', relPath], projectRoot);
            return false;
        }
        catch {
            return true;
        }
    }
    async isPathIgnoredForSession(state, filePath, relPath = this.toRelPath(state.session.projectRoot, filePath)) {
        if (!this.isReviewableRelPath(relPath)) {
            return true;
        }
        if (state.isGitRepo) {
            return this.isGitIgnoredPath(state.session.projectRoot, relPath);
        }
        if (this.isWithinFallbackIgnoredDirectory(relPath)) {
            return true;
        }
        return this.isNonGitIgnoredPath(state.session.projectRoot, relPath);
    }
    isReviewableRelPath(relPath) {
        if (!relPath || relPath === '..' || relPath.startsWith('../') || path_1.default.isAbsolute(relPath)) {
            return false;
        }
        return !relPath.split('/').includes('.git');
    }
    async isGitIgnoredPath(projectRoot, relPath) {
        try {
            await this.runGit(['check-ignore', '--quiet', '--', relPath], projectRoot);
            return true;
        }
        catch (error) {
            const code = error.code;
            if (code === 1 || code === '1') {
                return false;
            }
            return false;
        }
    }
    async isNonGitIgnoredPath(projectRoot, relPath) {
        try {
            const gitDir = await this.ensureFallbackIgnoreGitDir();
            await this.runGit(['--git-dir', gitDir, '--work-tree', projectRoot, 'check-ignore', '--no-index', '--quiet', '--', relPath], projectRoot);
            return true;
        }
        catch (error) {
            const code = error.code;
            if (code === 1 || code === '1') {
                return false;
            }
            return false;
        }
    }
    async ensureFallbackIgnoreGitDir() {
        if (!this.fallbackIgnoreGitDir) {
            this.fallbackIgnoreGitDir = this.createFallbackIgnoreGitDir();
        }
        return this.fallbackIgnoreGitDir;
    }
    async createFallbackIgnoreGitDir() {
        const gitDir = await promises_1.default.mkdtemp(path_1.default.join(os_1.default.tmpdir(), '1devtool-ai-diff-ignore-git-'));
        await this.runGit(['init', '--bare', gitDir], os_1.default.tmpdir());
        return gitDir;
    }
    isWithinFallbackIgnoredDirectory(relPath) {
        const parentSegments = relPath.split('/').slice(0, -1);
        return parentSegments.some((segment) => IGNORED_DIRS.has(segment));
    }
    isGitignoreFile(relPath) {
        return relPath.split('/').at(-1) === '.gitignore';
    }
    async dropIgnoredPendingChanges(state) {
        let removed = false;
        for (const filePath of [...state.pendingChanges.keys()]) {
            if (await this.isPathIgnoredForSession(state, filePath)) {
                state.pendingChanges.delete(filePath);
                state.baselines.delete(filePath);
                removed = true;
            }
        }
        if (removed) {
            this.touchSession(state);
            this.emit(state);
        }
    }
    async walkProjectFiles(projectRoot, limit) {
        const listed = await this.listNonGitProjectFiles(projectRoot, limit);
        if (listed) {
            return listed;
        }
        const queue = [projectRoot];
        const files = [];
        while (queue.length > 0) {
            const currentDir = queue.shift();
            if (!currentDir) {
                break;
            }
            let entries = [];
            try {
                entries = await promises_1.default.readdir(currentDir, { withFileTypes: true });
            }
            catch {
                continue;
            }
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    if (!IGNORED_DIRS.has(entry.name)) {
                        queue.push(path_1.default.join(currentDir, entry.name));
                    }
                    continue;
                }
                if (!entry.isFile()) {
                    continue;
                }
                files.push(path_1.default.join(currentDir, entry.name));
                if (files.length >= limit) {
                    return { files, truncated: true };
                }
            }
        }
        return { files, truncated: false };
    }
    async listNonGitProjectFiles(projectRoot, limit) {
        try {
            const gitDir = await this.ensureFallbackIgnoreGitDir();
            const result = await this.runGit(['--git-dir', gitDir, '--work-tree', projectRoot, 'ls-files', '--others', '--exclude-standard'], projectRoot);
            const relPaths = result.stdout
                .split('\n')
                .map((relPath) => relPath.trim())
                .filter(Boolean)
                .filter((relPath) => this.isReviewableRelPath(relPath));
            const files = relPaths
                .slice(0, limit)
                .map((relPath) => path_1.default.join(projectRoot, relPath));
            return { files, truncated: relPaths.length > limit };
        }
        catch {
            return null;
        }
    }
    async buildUnifiedDiff(baseText, currentText, relPath) {
        if (baseText === currentText) {
            return '';
        }
        const tempDir = await promises_1.default.mkdtemp(path_1.default.join(os_1.default.tmpdir(), '1devtool-ai-diff-'));
        const basePath = path_1.default.join(tempDir, 'base');
        const currentPath = path_1.default.join(tempDir, 'current');
        try {
            await Promise.all([
                promises_1.default.writeFile(basePath, baseText, 'utf8'),
                promises_1.default.writeFile(currentPath, currentText, 'utf8'),
            ]);
            const diff = await this.runGit(['diff', '--no-index', '--text', '--unified=3', '--', basePath, currentPath], tempDir, true);
            return diff.stdout
                .replace(new RegExp(basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), `a/${relPath}`)
                .replace(new RegExp(currentPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), `b/${relPath}`);
        }
        finally {
            await promises_1.default.rm(tempDir, { recursive: true, force: true });
        }
    }
    async getDiffStat(baseText, currentText) {
        if (baseText === currentText) {
            return { added: 0, removed: 0 };
        }
        const tempDir = await promises_1.default.mkdtemp(path_1.default.join(os_1.default.tmpdir(), '1devtool-ai-diff-'));
        const basePath = path_1.default.join(tempDir, 'base');
        const currentPath = path_1.default.join(tempDir, 'current');
        try {
            await Promise.all([
                promises_1.default.writeFile(basePath, baseText, 'utf8'),
                promises_1.default.writeFile(currentPath, currentText, 'utf8'),
            ]);
            const result = await this.runGit(['diff', '--no-index', '--numstat', '--text', '--', basePath, currentPath], tempDir, true);
            const [added = '0', removed = '0'] = result.stdout.trim().split('\t');
            return {
                added: Number.isFinite(Number(added)) ? Number(added) : 0,
                removed: Number.isFinite(Number(removed)) ? Number(removed) : 0,
            };
        }
        finally {
            await promises_1.default.rm(tempDir, { recursive: true, force: true });
        }
    }
    async runGit(args, cwd, allowDiffExit = false) {
        try {
            const result = await execFileAsync('git', args, {
                cwd,
                maxBuffer: 8 * 1024 * 1024,
                encoding: 'utf8',
            });
            return {
                stdout: String(result.stdout),
                stderr: String(result.stderr),
            };
        }
        catch (error) {
            const execError = error;
            if (allowDiffExit && execError.code === 1) {
                return {
                    stdout: execError.stdout === undefined ? '' : String(execError.stdout),
                    stderr: execError.stderr === undefined ? '' : String(execError.stderr),
                };
            }
            throw error;
        }
    }
    async runGitBuffer(args, cwd) {
        const result = await new Promise((resolve, reject) => {
            (0, child_process_1.execFile)('git', args, { cwd, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' }, (error, stdout) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
            });
        });
        return result;
    }
    sha1(value) {
        return (0, crypto_1.createHash)('sha1').update(value).digest('hex');
    }
    toRelPath(projectRoot, filePath) {
        return path_1.default.relative(projectRoot, filePath).replace(/\\/g, '/');
    }
    isWithinRoot(projectRoot, filePath) {
        if (filePath === projectRoot) {
            return true;
        }
        return filePath.startsWith(`${projectRoot}${path_1.default.sep}`) || filePath.startsWith(`${projectRoot}/`);
    }
    isBinaryBuffer(buffer) {
        const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
        return sample.includes(0);
    }
    isMissingFileError(error) {
        return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
    }
    requireSession(sessionId) {
        const state = this.sessions.get(sessionId);
        if (!state) {
            throw new Error(`AI diff session not found: ${sessionId}`);
        }
        return state;
    }
    touchSession(state) {
        state.session.updatedAt = Date.now();
        state.session.pendingCount = state.pendingChanges.size;
    }
    emit(state) {
        this.emitSessionUpdate({
            session: { ...state.session },
            pendingChanges: this.listPendingChanges(state.session.id),
        });
    }
    generateSessionId() {
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
}
exports.AiDiffSessionManager = AiDiffSessionManager;
