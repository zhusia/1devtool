"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileSystemManager = exports.DirectoryNotAFileError = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const ssh_1 = require("./ssh");
const env_1 = require("./utils/env");
const fileSearchService_1 = require("./fileSearchService");
const fileWatcherOptions_1 = require("./fileWatcherOptions");
/** Typed error when readFile is given a directory / alias-to-folder (not message-regex control flow). */
class DirectoryNotAFileError extends Error {
    code = 'DIRECTORY_NOT_A_FILE';
    kind;
    resolvedPath;
    constructor(filePath, kind, resolvedPath) {
        const base = path_1.default.basename(filePath);
        const detail = kind === 'alias-folder'
            ? `“${base}” is a macOS alias to a folder${resolvedPath ? ` (${resolvedPath})` : ''}. Expand it in the file tree instead of opening it as a file.`
            : kind === 'symlink-folder'
                ? `“${base}” is a symbolic link to a folder. Expand it in the file tree instead of opening it as a file.`
                : `“${base}” is a folder and cannot be opened as a file.`;
        super(detail);
        this.name = 'DirectoryNotAFileError';
        this.kind = kind;
        this.resolvedPath = resolvedPath;
    }
}
exports.DirectoryNotAFileError = DirectoryNotAFileError;
function withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}
function execFileText(command, args, options) {
    return new Promise((resolve, reject) => {
        (0, child_process_1.execFile)(command, args, {
            cwd: options.cwd,
            encoding: 'utf-8',
            timeout: options.timeout,
            maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
            env: options.env,
            windowsHide: true,
        }, (error, stdout) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout);
        });
    });
}
class FileSystemManager {
    watchers = new Map();
    //codex fix: multiple renderer features can watch the same root, so
    // only tear the chokidar instance down after the last subscriber leaves.
    watcherRefCounts = new Map();
    gitignoreCache = new Map();
    gitignoreLoadPromises = new Map();
    gitignoreCacheEpoch = 0;
    workspaceSearchService = new fileSearchService_1.WorkspaceFileSearchService({
        getIgnoredPaths: (rootPath) => this.getIgnoredPathsAsync(rootPath),
        isIgnoredPath: (filePath, ignoredPaths) => this.isIgnored(filePath, ignoredPaths),
    });
    static ALWAYS_VISIBLE_ENV_FILE = /^\.env(?:\..+)?$/;
    async readDirectory(dirPath, respectGitignore = true, showHidden = false) {
        try {
            // If *this* path is itself a symlink/alias folder, readdir the target.
            // Children still use path.join(dirPath, name) so node.path stays under
            // the caller's identity (expandedPaths / watchers / startsWith invariant).
            const listPath = await this.resolveListableDirectoryAsync(dirPath);
            // sshfs mounts can become unresponsive when the remote VPS is
            // unreachable; a sync readdir in that state freezes the main process
            // and the whole Electron UI. Use async readdir (runs on libuv threadpool)
            // and bound it with a timeout so a stuck mount can't stall IPC.
            const entries = (0, ssh_1.isSshfsPath)(listPath)
                ? await withTimeout(fs_1.default.promises.readdir(listPath, { withFileTypes: true }), 8000, `Timed out reading remote directory: ${listPath}`)
                : await fs_1.default.promises.readdir(listPath, { withFileTypes: true });
            const ignoredPaths = respectGitignore ? this.getIgnoredPaths(listPath) : new Set();
            // Header-only alias detection is cheap (~0.02 ms/file) but must stay off
            // sshfs — sync/async open on a stalled mount freezes main the same way
            // the readdir timeout above exists to prevent.
            const allowAliasHeaderProbe = process.platform === 'darwin' && !(0, ssh_1.isSshfsPath)(listPath);
            const nodes = [];
            for (const entry of entries) {
                // Skip hidden files unless explicitly shown
                if (this.shouldHideExplorerEntry(entry.name, showHidden)) {
                    continue;
                }
                // Always key children under the requested dirPath, not the resolved
                // listPath — otherwise a symlinked project root breaks path prefixes.
                const fullPath = path_1.default.join(dirPath, entry.name);
                // Ignore checks need the real on-disk path when dirPath is a link.
                const ignorePath = listPath === dirPath ? fullPath : path_1.default.join(listPath, entry.name);
                // Skip gitignored paths
                if (respectGitignore && this.isIgnored(ignorePath, ignoredPaths) && !this.isAlwaysVisibleEnvFile(entry.name)) {
                    continue;
                }
                let isDirectory = entry.isDirectory();
                // POSIX symlinks to folders must expand in the tree (Dirent may report
                // the link itself as a file depending on the platform/API).
                if (!isDirectory && entry.isSymbolicLink()) {
                    try {
                        isDirectory = (await fs_1.default.promises.stat(ignorePath)).isDirectory();
                    }
                    catch {
                        // Dangling link — keep as a file so the user can see it.
                    }
                }
                // macOS Finder aliases readdir as plain files. Header is a *candidate
                // filter* only (file aliases share the same book/mark magic). Confirm
                // the target is a folder before setting isDirectory — otherwise a file
                // alias becomes a chevron that expands to ENOTDIR → empty [] (BUG-81).
                // osascript runs only for header matches (usually 0 in source trees),
                // and is cached by path+mtime.
                if (!isDirectory
                    && allowAliasHeaderProbe
                    && !entry.isSymbolicLink()
                    && (await this.looksLikeMacAliasHeaderAsync(ignorePath))) {
                    const target = await this.resolveMacAliasAsync(ignorePath);
                    if (target) {
                        try {
                            isDirectory = (await fs_1.default.promises.stat(target)).isDirectory();
                        }
                        catch {
                            // Unreadable target — leave as a file entry.
                        }
                    }
                }
                const node = {
                    name: entry.name,
                    path: fullPath,
                    isDirectory,
                };
                nodes.push(node);
            }
            // Sort: directories first, then alphabetically
            nodes.sort((a, b) => {
                if (a.isDirectory && !b.isDirectory)
                    return -1;
                if (!a.isDirectory && b.isDirectory)
                    return 1;
                return a.name.localeCompare(b.name);
            });
            return nodes;
        }
        catch (error) {
            console.error('Error reading directory:', error);
            return [];
        }
    }
    async listFiles(dirPath, respectGitignore = true, showHidden = false, limit = 5000) {
        try {
            return await this.listFilesWithRipgrep(dirPath, respectGitignore, showHidden, limit);
        }
        catch {
            return this.listFilesRecursive(dirPath, respectGitignore, showHidden, limit);
        }
    }
    async searchPaths(dirPath, query, respectGitignore = true, showHidden = false, limit = 200) {
        const trimmedQuery = query.trim();
        if (!trimmedQuery)
            return [];
        try {
            const output = await this.listFilesWithRipgrep(dirPath, respectGitignore, showHidden);
            return this.filterFilePaths(output, dirPath, trimmedQuery, limit);
        }
        catch {
            const output = await this.listFilesRecursive(dirPath, respectGitignore, showHidden);
            return this.filterFilePaths(output, dirPath, trimmedQuery, limit);
        }
    }
    searchWorkspace(request) {
        return this.workspaceSearchService.search(request);
    }
    cancelWorkspaceSearch(scopeId, requestId) {
        this.workspaceSearchService.cancel(scopeId, requestId);
    }
    static IMAGE_EXTENSIONS = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.ico': 'image/x-icon',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.avif': 'image/avif',
    };
    static MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
    getImageMimeType(filePath) {
        const ext = path_1.default.extname(filePath).toLowerCase();
        return FileSystemManager.IMAGE_EXTENSIONS[ext] || null;
    }
    readFile(filePath, maxBytes = 1024 * 1024) {
        // Prefer lstat so a dangling symlink does not throw before we can
        // classify the path. Real directories must never reach readFileSync —
        // Node throws EISDIR/EPERM, which the editor surfaces as a raw IPC error.
        const lstats = fs_1.default.lstatSync(filePath);
        if (lstats.isDirectory()) {
            throw new DirectoryNotAFileError(filePath, 'directory');
        }
        if (lstats.isSymbolicLink()) {
            let targetStats;
            try {
                targetStats = fs_1.default.statSync(filePath);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(`Cannot read symlink “${path_1.default.basename(filePath)}”: ${message}`);
            }
            if (targetStats.isDirectory()) {
                throw new DirectoryNotAFileError(filePath, 'symlink-folder');
            }
            return this.readResolvedFile(filePath, maxBytes, targetStats);
        }
        // macOS Finder alias: only the classic book/mark header (no xattr scan —
        // that freezes main and false-positives ordinary files). If resolution
        // fails, fall through to a normal file read so real content is never
        // blocked by a bad heuristic.
        if (process.platform === 'darwin' && this.looksLikeMacAlias(filePath, lstats)) {
            const resolved = this.resolveMacAliasSync(filePath, lstats.mtimeMs);
            if (resolved) {
                try {
                    const resolvedStats = fs_1.default.statSync(resolved);
                    if (resolvedStats.isDirectory()) {
                        throw new DirectoryNotAFileError(filePath, 'alias-folder', resolved);
                    }
                    // One hop only — do not recurse into chained aliases.
                    return this.readResolvedFile(resolved, maxBytes, resolvedStats);
                }
                catch (error) {
                    if (error instanceof DirectoryNotAFileError)
                        throw error;
                    // Unreadable target — try the alias file bytes themselves.
                }
            }
        }
        return this.readResolvedFile(filePath, maxBytes, lstats);
    }
    readResolvedFile(filePath, maxBytes, stats = fs_1.default.statSync(filePath)) {
        if (stats.isDirectory()) {
            throw new DirectoryNotAFileError(filePath, 'directory');
        }
        const mimeType = this.getImageMimeType(filePath);
        // Handle image files
        if (mimeType) {
            if (stats.size > FileSystemManager.MAX_IMAGE_BYTES) {
                return {
                    content: '',
                    isBinary: false,
                    isTooLarge: true,
                    isImage: true,
                    dataUrl: null,
                    size: stats.size,
                };
            }
            const buffer = fs_1.default.readFileSync(filePath);
            // SVG is text-based — use raw content for data URL
            if (mimeType === 'image/svg+xml') {
                const svgContent = buffer.toString('utf-8');
                return {
                    content: svgContent,
                    isBinary: false,
                    isTooLarge: false,
                    isImage: true,
                    dataUrl: `data:${mimeType};utf8,${encodeURIComponent(svgContent)}`,
                    size: stats.size,
                };
            }
            const base64 = buffer.toString('base64');
            return {
                content: '',
                isBinary: true,
                isTooLarge: false,
                isImage: true,
                dataUrl: `data:${mimeType};base64,${base64}`,
                size: stats.size,
            };
        }
        if (stats.size > maxBytes) {
            return {
                content: '',
                isBinary: false,
                isTooLarge: true,
                isImage: false,
                dataUrl: null,
                size: stats.size,
            };
        }
        const buffer = fs_1.default.readFileSync(filePath);
        if (this.isBinary(buffer)) {
            return {
                content: '',
                isBinary: true,
                isTooLarge: false,
                isImage: false,
                dataUrl: null,
                size: stats.size,
            };
        }
        return {
            content: buffer.toString('utf-8'),
            isBinary: false,
            isTooLarge: false,
            isImage: false,
            dataUrl: null,
            size: stats.size,
        };
    }
    async statFiles(filePaths) {
        const uniquePaths = Array.from(new Set(filePaths));
        const entries = await Promise.all(uniquePaths.map(async (filePath) => {
            try {
                const stats = await fs_1.default.promises.stat(filePath);
                return [filePath, {
                        mtimeMs: stats.mtimeMs,
                        ctimeMs: stats.ctimeMs,
                        size: stats.size,
                    }];
            }
            catch {
                return [filePath, null];
            }
        }));
        return Object.fromEntries(entries);
    }
    writeFile(filePath, content) {
        fs_1.default.writeFileSync(filePath, content, 'utf-8');
        this.invalidateGitignoreCacheForPath(filePath);
    }
    getIgnoredPaths(dirPath) {
        // Find git root
        let gitRoot = dirPath;
        while (gitRoot !== path_1.default.dirname(gitRoot)) {
            if (fs_1.default.existsSync(path_1.default.join(gitRoot, '.git'))) {
                break;
            }
            gitRoot = path_1.default.dirname(gitRoot);
        }
        if (!fs_1.default.existsSync(path_1.default.join(gitRoot, '.git'))) {
            return new Set();
        }
        // Check cache
        if (this.gitignoreCache.has(gitRoot)) {
            return this.gitignoreCache.get(gitRoot);
        }
        // Use git to get ignored files
        try {
            const result = (0, child_process_1.execSync)('git ls-files --others --ignored --exclude-standard --directory', {
                cwd: gitRoot,
                encoding: 'utf-8',
                timeout: 5000,
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            const ignoredPaths = new Set(result
                .split('\n')
                .filter(Boolean)
                .map((p) => path_1.default.join(gitRoot, p.replace(/\/$/, ''))));
            this.gitignoreCache.set(gitRoot, ignoredPaths);
            return ignoredPaths;
        }
        catch {
            return new Set();
        }
    }
    async getIgnoredPathsAsync(dirPath) {
        // Find git root
        let gitRoot = dirPath;
        while (gitRoot !== path_1.default.dirname(gitRoot)) {
            try {
                await fs_1.default.promises.access(path_1.default.join(gitRoot, '.git'));
                break;
            }
            catch {
                gitRoot = path_1.default.dirname(gitRoot);
            }
        }
        try {
            await fs_1.default.promises.access(path_1.default.join(gitRoot, '.git'));
        }
        catch {
            return new Set();
        }
        if (this.gitignoreCache.has(gitRoot)) {
            return this.gitignoreCache.get(gitRoot);
        }
        const existingLoad = this.gitignoreLoadPromises.get(gitRoot);
        if (existingLoad)
            return existingLoad;
        const cacheEpoch = this.gitignoreCacheEpoch;
        const loadPromise = (async () => {
            try {
                const result = await execFileText('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], {
                    cwd: gitRoot,
                    timeout: 5000,
                    env: { ...process.env, PATH: (0, env_1.getEnrichedPath)() },
                });
                const ignoredPaths = new Set(result
                    .split('\n')
                    .filter(Boolean)
                    .map((p) => path_1.default.join(gitRoot, p.replace(/\/$/, ''))));
                if (this.gitignoreCacheEpoch === cacheEpoch) {
                    this.gitignoreCache.set(gitRoot, ignoredPaths);
                }
                return ignoredPaths;
            }
            catch {
                return new Set();
            }
        })();
        this.gitignoreLoadPromises.set(gitRoot, loadPromise);
        try {
            return await loadPromise;
        }
        finally {
            if (this.gitignoreLoadPromises.get(gitRoot) === loadPromise) {
                this.gitignoreLoadPromises.delete(gitRoot);
            }
        }
    }
    async listFilesWithRipgrep(dirPath, respectGitignore, showHidden, limit) {
        const args = ['--files'];
        if (!respectGitignore) {
            args.push('--no-ignore', '--no-ignore-parent');
        }
        if (showHidden) {
            args.push('--hidden');
        }
        const output = await execFileText('rg', args, {
            cwd: dirPath,
            timeout: 5000,
            maxBuffer: 10 * 1024 * 1024,
        });
        return output
            .split('\n')
            .filter(Boolean)
            .map((relativePath) => path_1.default.join(dirPath, relativePath))
            .slice(0, limit ?? Number.MAX_SAFE_INTEGER);
    }
    async listFilesRecursive(dirPath, respectGitignore, showHidden, limit) {
        const ignoredPaths = respectGitignore ? await this.getIgnoredPathsAsync(dirPath) : new Set();
        const results = [];
        const queue = [dirPath];
        const maxResults = limit ?? Number.MAX_SAFE_INTEGER;
        while (queue.length > 0 && results.length < maxResults) {
            const currentPath = queue.shift();
            if (!currentPath) {
                continue;
            }
            let entries;
            try {
                entries = await fs_1.default.promises.readdir(currentPath, { withFileTypes: true });
            }
            catch {
                continue;
            }
            for (const entry of entries) {
                if (this.shouldHideExplorerEntry(entry.name, showHidden)) {
                    continue;
                }
                const fullPath = path_1.default.join(currentPath, entry.name);
                if (respectGitignore && this.isIgnored(fullPath, ignoredPaths) && !this.isAlwaysVisibleEnvFile(entry.name)) {
                    continue;
                }
                if (entry.isDirectory()) {
                    queue.push(fullPath);
                    continue;
                }
                results.push(fullPath);
                if (results.length >= maxResults) {
                    break;
                }
            }
        }
        return results;
    }
    isIgnored(filePath, ignoredPaths) {
        // Check if the path or any parent path is ignored
        let current = filePath;
        while (current !== path_1.default.dirname(current)) {
            if (ignoredPaths.has(current)) {
                return true;
            }
            current = path_1.default.dirname(current);
        }
        return false;
    }
    watch(dirPath, callback, options = {}) {
        const profile = this.normalizeWatchProfile(options.profile);
        const counts = { ...(this.watcherRefCounts.get(dirPath) ?? {}) };
        counts[profile] = (counts[profile] ?? 0) + 1;
        this.watcherRefCounts.set(dirPath, counts);
        const desiredProfile = this.getEffectiveWatchProfile(counts);
        const existing = this.watchers.get(dirPath);
        if (existing) {
            existing.callback = callback;
            if (existing.profile !== desiredProfile) {
                this.replaceWatcher(dirPath, callback, desiredProfile);
            }
            return;
        }
        this.watchers.set(dirPath, this.createWatcher(dirPath, callback, desiredProfile));
    }
    unwatch(dirPath, options = {}) {
        const profile = this.normalizeWatchProfile(options.profile);
        const counts = { ...(this.watcherRefCounts.get(dirPath) ?? {}) };
        const nextCount = (counts[profile] ?? 0) - 1;
        if (nextCount > 0) {
            counts[profile] = nextCount;
        }
        else {
            delete counts[profile];
        }
        if (this.getTotalWatchRefCount(counts) <= 0) {
            this.watcherRefCounts.delete(dirPath);
            const entry = this.watchers.get(dirPath);
            if (entry) {
                void entry.watcher.close();
                this.watchers.delete(dirPath);
            }
            return;
        }
        this.watcherRefCounts.set(dirPath, counts);
        const desiredProfile = this.getEffectiveWatchProfile(counts);
        const existing = this.watchers.get(dirPath);
        if (existing && existing.profile !== desiredProfile) {
            this.replaceWatcher(dirPath, existing.callback, desiredProfile);
        }
    }
    unwatchAll() {
        for (const entry of this.watchers.values()) {
            void entry.watcher.close();
        }
        this.watchers.clear();
        this.watcherRefCounts.clear();
    }
    normalizeWatchProfile(profile) {
        return profile === 'file-tree' ? 'file-tree' : 'default';
    }
    getEffectiveWatchProfile(counts) {
        return (counts['file-tree'] ?? 0) > 0 ? 'file-tree' : 'default';
    }
    getTotalWatchRefCount(counts) {
        return (counts.default ?? 0) + (counts['file-tree'] ?? 0);
    }
    replaceWatcher(dirPath, callback, profile) {
        const existing = this.watchers.get(dirPath);
        if (existing) {
            void existing.watcher.close();
        }
        this.watchers.set(dirPath, this.createWatcher(dirPath, callback, profile));
    }
    createWatcher(dirPath, callback, profile) {
        const isWindows = process.platform === 'win32';
        const isRemote = (0, ssh_1.isSshfsPath)(dirPath);
        // Remote (sshfs) mounts: chokidar over SFTP is expensive. The initial
        // depth-5 stat scan saturates the SSH connection and blocks the main
        // process (via subsequent sync fs calls) long enough to make terminal
        // typing visibly lag. FUSE generally doesn't forward inotify, so native
        // events are silent on sshfs anyway — a slow stat-poll at the top level
        // is the best tradeoff we can offer without giving up external-change
        // detection entirely.
        const watcherOptions = { isRemote, isWindows };
        const watchPath = (0, fileWatcherOptions_1.resolveFileWatcherPath)(dirPath, watcherOptions);
        const watcher = (0, fileWatcherOptions_1.createFileWatcher)(watchPath, profile, watcherOptions);
        const toRequestedPath = (changedPath) => ((0, fileWatcherOptions_1.mapFileWatcherEventPath)(changedPath, dirPath, watchPath, isWindows));
        watcher.on('add', (changedPath) => {
            const callbackPath = toRequestedPath(changedPath);
            this.invalidateGitignoreCacheForPath(callbackPath);
            callback('add', callbackPath);
        });
        watcher.on('change', (changedPath) => {
            const callbackPath = toRequestedPath(changedPath);
            this.invalidateGitignoreCacheForPath(callbackPath);
            callback('change', callbackPath);
        });
        watcher.on('unlink', (changedPath) => {
            const callbackPath = toRequestedPath(changedPath);
            this.invalidateGitignoreCacheForPath(callbackPath);
            callback('unlink', callbackPath);
        });
        watcher.on('addDir', (changedPath) => {
            const callbackPath = toRequestedPath(changedPath);
            this.invalidateGitignoreCacheForPath(callbackPath);
            callback('addDir', callbackPath);
        });
        watcher.on('unlinkDir', (changedPath) => {
            const callbackPath = toRequestedPath(changedPath);
            this.invalidateGitignoreCacheForPath(callbackPath);
            callback('unlinkDir', callbackPath);
        });
        // Chokidar surfaces permission and transient mount failures through the
        // EventEmitter `error` channel. Without a listener, Node promotes that
        // event to an uncaught exception and Electron shows a fatal main-process
        // popup. Remote Windows mounts can legitimately return EPERM for an
        // individual stat while the rest of the drive remains usable.
        watcher.on('error', (error) => {
            console.warn(`[fileSystem] watcher error for ${dirPath}:`, error);
        });
        return { watcher, profile, callback };
    }
    resolveEditorCommand(command) {
        if (!command)
            return null;
        if (path_1.default.isAbsolute(command)) {
            return fs_1.default.existsSync(command) ? command : null;
        }
        const enrichedPath = (0, env_1.getEnrichedPath)();
        const exts = process.platform === 'win32'
            ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
            : [''];
        for (const dir of enrichedPath.split(path_1.default.delimiter)) {
            if (!dir)
                continue;
            for (const ext of exts) {
                const candidate = path_1.default.join(dir, command + ext);
                try {
                    if (fs_1.default.existsSync(candidate))
                        return candidate;
                }
                catch { /* ignore */ }
            }
        }
        try {
            const probe = process.platform === 'win32' ? 'where' : 'which';
            return (0, child_process_1.execFileSync)(probe, [command], {
                env: { ...process.env, PATH: enrichedPath },
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 2000,
            }).toString().trim().split(/\r?\n/)[0] || null;
        }
        catch {
            return null;
        }
    }
    async openInEditor(filePath, editor) {
        if (!editor || !editor.trim()) {
            return { ok: false, reason: 'no-command' };
        }
        const resolved = this.resolveEditorCommand(editor);
        if (!resolved) {
            return { ok: false, reason: 'not-found', command: editor };
        }
        const env = { ...process.env, PATH: (0, env_1.getEnrichedPath)() };
        // On Windows, .cmd / .bat shims (e.g. VS Code's `code.cmd`) only execute
        // via the shell — direct spawn fails with EINVAL. Use shell:true so the
        // OS resolves the right interpreter, and quote the path defensively.
        const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
        // macOS .app bundles are directories, not executables — spawning them
        // directly fails with EACCES. Route through `open -a "Bundle.app" <file>`
        // so launchd resolves the inner Mach-O binary.
        const isMacAppBundle = process.platform === 'darwin' && /\.app\/?$/i.test(resolved);
        const spawnCmd = isMacAppBundle ? 'open' : resolved;
        const spawnArgs = isMacAppBundle ? ['-a', resolved, filePath] : [filePath];
        return new Promise((resolve) => {
            try {
                const child = (0, child_process_1.spawn)(spawnCmd, spawnArgs, {
                    detached: true,
                    stdio: 'ignore',
                    env,
                    shell: useShell,
                });
                let settled = false;
                const finishOk = () => {
                    if (settled)
                        return;
                    settled = true;
                    resolve({ ok: true, command: resolved });
                };
                child.on('error', (err) => {
                    if (settled)
                        return;
                    settled = true;
                    resolve({
                        ok: false,
                        reason: 'spawn-failed',
                        command: resolved,
                        message: err instanceof Error ? err.message : String(err),
                    });
                });
                child.unref();
                // Spawn errors fire asynchronously; give Node a tick to surface them,
                // then resolve as success. The launched editor process runs detached
                // regardless of our resolution.
                setTimeout(finishOk, 50);
            }
            catch (err) {
                resolve({
                    ok: false,
                    reason: 'spawn-failed',
                    command: resolved,
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        });
    }
    getGitBranch(dirPath) {
        try {
            const branch = (0, child_process_1.execSync)('git symbolic-ref --short HEAD', {
                cwd: dirPath,
                encoding: 'utf-8',
                timeout: 5000,
                stdio: ['ignore', 'pipe', 'ignore'],
            }).trim();
            return branch;
        }
        catch {
            try {
                const branch = (0, child_process_1.execSync)('git rev-parse --abbrev-ref HEAD', {
                    cwd: dirPath,
                    encoding: 'utf-8',
                    timeout: 5000,
                    stdio: ['ignore', 'pipe', 'ignore'],
                }).trim();
                return branch === 'HEAD' ? null : branch;
            }
            catch {
                return null;
            }
        }
    }
    createFile(filePath) {
        // Ensure parent directory exists
        const parentDir = path_1.default.dirname(filePath);
        if (!fs_1.default.existsSync(parentDir)) {
            fs_1.default.mkdirSync(parentDir, { recursive: true });
        }
        fs_1.default.writeFileSync(filePath, '', 'utf-8');
        this.invalidateGitignoreCacheForPath(filePath);
    }
    createDirectory(dirPath) {
        fs_1.default.mkdirSync(dirPath, { recursive: true });
        this.invalidateGitignoreCacheForPath(dirPath);
    }
    deleteItem(itemPath) {
        const stats = fs_1.default.statSync(itemPath);
        if (stats.isDirectory()) {
            fs_1.default.rmSync(itemPath, { recursive: true, force: true });
        }
        else {
            fs_1.default.unlinkSync(itemPath);
        }
        this.invalidateGitignoreCacheForPath(itemPath);
    }
    renameItem(oldPath, newPath) {
        fs_1.default.renameSync(oldPath, newPath);
        this.invalidateGitignoreCacheForPath(oldPath);
        this.invalidateGitignoreCacheForPath(newPath);
    }
    copyItem(srcPath, destPath) {
        const stats = fs_1.default.statSync(srcPath);
        if (stats.isDirectory()) {
            fs_1.default.cpSync(srcPath, destPath, { recursive: true });
        }
        else {
            const parentDir = path_1.default.dirname(destPath);
            if (!fs_1.default.existsSync(parentDir)) {
                fs_1.default.mkdirSync(parentDir, { recursive: true });
            }
            fs_1.default.copyFileSync(srcPath, destPath);
        }
        this.invalidateGitignoreCacheForPath(srcPath);
        this.invalidateGitignoreCacheForPath(destPath);
    }
    exists(itemPath) {
        return fs_1.default.existsSync(itemPath);
    }
    searchContent(dirPath, query, respectGitignore = true, showHidden = false, limit = 200) {
        if (!query.trim())
            return [];
        // Try ripgrep first, fall back to JS-based search
        const rgResults = this.searchContentWithRipgrep(dirPath, query, respectGitignore, showHidden, limit);
        if (rgResults.length > 0)
            return rgResults;
        return this.searchContentWithJs(dirPath, query, respectGitignore, showHidden, limit);
    }
    searchContentWithRipgrep(dirPath, query, respectGitignore, showHidden, limit) {
        try {
            const args = [
                '--json',
                '--line-number',
                '--max-count', '5', // max matches per file
                '--smart-case',
            ];
            if (!respectGitignore) {
                args.push('--no-ignore', '--no-ignore-parent');
            }
            if (showHidden) {
                args.push('--hidden');
            }
            // When query contains spaces, treat them as flexible separators
            // so "Control 1DevTool" matches "Control_1DevTool", "Control-1DevTool", etc.
            const hasSpaces = /\s/.test(query);
            if (hasSpaces) {
                const tokens = query.split(/\s+/).filter(Boolean);
                const pattern = tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s_\\-]+');
                args.push('--', pattern, '.');
            }
            else {
                args.push('--fixed-strings', '--', query, '.');
            }
            const output = (0, child_process_1.execFileSync)('rg', args, {
                cwd: dirPath,
                encoding: 'utf-8',
                timeout: 10000,
                stdio: ['ignore', 'pipe', 'ignore'],
                maxBuffer: 10 * 1024 * 1024,
            });
            const results = [];
            const lines = output.split('\n').filter(Boolean);
            for (const line of lines) {
                if (results.length >= limit)
                    break;
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.type === 'match') {
                        const data = parsed.data;
                        const filePath = path_1.default.join(dirPath, data.path.text);
                        const lineContent = data.lines.text.replace(/\n$/, '');
                        // ripgrep returns byte offsets — convert to character offsets
                        const lineBuffer = Buffer.from(lineContent, 'utf-8');
                        for (const sub of data.submatches) {
                            const matchStart = lineBuffer.subarray(0, sub.start).toString('utf-8').length;
                            const matchEnd = lineBuffer.subarray(0, sub.end).toString('utf-8').length;
                            results.push({
                                filePath,
                                lineNumber: data.line_number,
                                lineContent,
                                matchStart,
                                matchEnd,
                            });
                            if (results.length >= limit)
                                break;
                        }
                    }
                }
                catch {
                    // skip malformed JSON lines
                }
            }
            return results;
        }
        catch {
            return [];
        }
    }
    static SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.cache', '.turbo', 'coverage', '__pycache__']);
    static BINARY_EXTENSIONS = new Set([
        '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.bmp', '.avif',
        '.woff', '.woff2', '.ttf', '.eot', '.otf',
        '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.avi', '.mov',
        '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
        '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
        '.exe', '.dll', '.so', '.dylib', '.o', '.a',
        '.sqlite', '.db', '.lock',
        '.wasm', '.node',
    ]);
    searchContentWithJs(dirPath, query, respectGitignore, showHidden, limit) {
        const smartCase = /[A-Z]/.test(query);
        const hasSpaces = /\s/.test(query);
        const maxFileSize = 256 * 1024;
        let searchRegex;
        if (hasSpaces) {
            const tokens = query.split(/\s+/).filter(Boolean);
            const pattern = tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s_\\-]+');
            searchRegex = new RegExp(pattern, smartCase ? 'g' : 'gi');
        }
        else {
            const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            searchRegex = new RegExp(escaped, smartCase ? 'g' : 'gi');
        }
        const ignoredPaths = respectGitignore ? this.getIgnoredPaths(dirPath) : new Set();
        const results = [];
        const queue = [dirPath];
        while (queue.length > 0 && results.length < limit) {
            const currentPath = queue.shift();
            let entries;
            try {
                entries = fs_1.default.readdirSync(currentPath, { withFileTypes: true });
            }
            catch {
                continue;
            }
            for (const entry of entries) {
                if (results.length >= limit)
                    break;
                // Skip hidden files unless explicitly shown
                if (!showHidden && entry.name.startsWith('.'))
                    continue;
                // Skip known non-text directories
                if (entry.isDirectory() && FileSystemManager.SEARCH_SKIP_DIRS.has(entry.name))
                    continue;
                const fullPath = path_1.default.join(currentPath, entry.name);
                if (respectGitignore && this.isIgnored(fullPath, ignoredPaths))
                    continue;
                if (entry.isDirectory()) {
                    queue.push(fullPath);
                    continue;
                }
                // Skip known binary extensions
                const ext = path_1.default.extname(entry.name).toLowerCase();
                if (FileSystemManager.BINARY_EXTENSIONS.has(ext))
                    continue;
                try {
                    const stat = fs_1.default.statSync(fullPath);
                    if (stat.size > maxFileSize || stat.size === 0)
                        continue;
                    const buffer = fs_1.default.readFileSync(fullPath);
                    if (this.isBinary(buffer))
                        continue;
                    const content = buffer.toString('utf-8');
                    const lines = content.split(/\r?\n/);
                    let matchesInFile = 0;
                    for (let i = 0; i < lines.length && results.length < limit && matchesInFile < 5; i++) {
                        const line = lines[i];
                        searchRegex.lastIndex = 0;
                        let match;
                        while (matchesInFile < 5 && (match = searchRegex.exec(line)) !== null) {
                            results.push({
                                filePath: fullPath,
                                lineNumber: i + 1,
                                lineContent: line,
                                matchStart: match.index,
                                matchEnd: match.index + match[0].length,
                            });
                            matchesInFile++;
                            if (results.length >= limit)
                                break;
                        }
                    }
                }
                catch {
                    // Skip unreadable files
                }
            }
        }
        return results;
    }
    /**
     * Finder aliases are regular files (not POSIX symlinks). Real alias files
     * start with the bookmark magic:
     *   bytes 0..4 = "book", 8..12 = "mark"
     * Never use xattr/FinderInfo heuristics — ordinary files carry those and
     * would become "unopenable aliases" (BUG-81 audit).
     */
    looksLikeMacAlias(filePath, lstats) {
        if (!lstats.isFile() || lstats.size < 16 || lstats.size > 2 * 1024 * 1024)
            return false;
        try {
            const fd = fs_1.default.openSync(filePath, 'r');
            try {
                const header = Buffer.alloc(16);
                const bytesRead = fs_1.default.readSync(fd, header, 0, 16, 0);
                if (bytesRead < 12)
                    return false;
                return FileSystemManager.isMacAliasHeader(header);
            }
            finally {
                fs_1.default.closeSync(fd);
            }
        }
        catch {
            return false;
        }
    }
    /**
     * Async header-only alias probe for readDirectory (libuv threadpool).
     * This is a *candidate filter* only — do not set isDirectory from this alone.
     */
    async looksLikeMacAliasHeaderAsync(filePath) {
        try {
            const handle = await fs_1.default.promises.open(filePath, 'r');
            try {
                const stat = await handle.stat();
                if (!stat.isFile() || stat.size < 16 || stat.size > 2 * 1024 * 1024)
                    return false;
                const header = Buffer.alloc(16);
                const { bytesRead } = await handle.read(header, 0, 16, 0);
                if (bytesRead < 12)
                    return false;
                return FileSystemManager.isMacAliasHeader(header);
            }
            finally {
                await handle.close();
            }
        }
        catch {
            return false;
        }
    }
    /** Exported for unit tests — same header rule as looksLikeMacAlias. */
    static isMacAliasHeader(header) {
        if (header.length < 12)
            return false;
        return (header.toString('ascii', 0, 4) === 'book'
            && header.toString('ascii', 8, 12) === 'mark');
    }
    /** path → { mtimeMs, resolved } — avoid re-spawning osascript on re-list. */
    macAliasResolveCache = new Map();
    static MAC_ALIAS_RESOLVE_SCRIPT = [
        'on run argv',
        '  set p to item 1 of argv',
        '  try',
        '    tell application "Finder"',
        '      set f to (POSIX file p) as alias',
        '      if class of item f is alias file then',
        '        return POSIX path of (original item of f as alias)',
        '      end if',
        '    end tell',
        '  end try',
        '  return ""',
        'end run',
    ].join('\n');
    parseMacAliasResolveOutput(out) {
        const trimmed = out.trim();
        if (!trimmed)
            return null;
        // Finder returns directories with a trailing slash.
        const resolved = trimmed.replace(/\/+$/, '') || '/';
        if (!path_1.default.isAbsolute(resolved))
            return null;
        return resolved;
    }
    getCachedMacAlias(filePath, mtimeMs) {
        const hit = this.macAliasResolveCache.get(filePath);
        if (!hit)
            return undefined;
        if (hit.mtimeMs !== mtimeMs) {
            this.macAliasResolveCache.delete(filePath);
            return undefined;
        }
        return hit.resolved;
    }
    putCachedMacAlias(filePath, mtimeMs, resolved) {
        this.macAliasResolveCache.set(filePath, { mtimeMs, resolved });
        // Bound cache growth in long sessions.
        if (this.macAliasResolveCache.size > 512) {
            const first = this.macAliasResolveCache.keys().next().value;
            if (first !== undefined)
                this.macAliasResolveCache.delete(first);
        }
        return resolved;
    }
    /** Async Finder alias resolve (listing candidates). Uses path+mtime cache. */
    async resolveMacAliasAsync(filePath) {
        let mtimeMs = 0;
        try {
            mtimeMs = (await fs_1.default.promises.stat(filePath)).mtimeMs;
        }
        catch {
            return null;
        }
        const cached = this.getCachedMacAlias(filePath, mtimeMs);
        if (cached !== undefined)
            return cached;
        try {
            const out = await new Promise((resolve, reject) => {
                (0, child_process_1.execFile)('osascript', ['-e', FileSystemManager.MAC_ALIAS_RESOLVE_SCRIPT, filePath], { encoding: 'utf-8', timeout: 3000, windowsHide: true }, (error, stdout) => {
                    if (error)
                        reject(error);
                    else
                        resolve(typeof stdout === 'string' ? stdout : '');
                });
            });
            return this.putCachedMacAlias(filePath, mtimeMs, this.parseMacAliasResolveOutput(out));
        }
        catch {
            return this.putCachedMacAlias(filePath, mtimeMs, null);
        }
    }
    /** Sync resolve for readFile (single open). Shares the path+mtime cache. */
    resolveMacAliasSync(filePath, mtimeMs) {
        const cached = this.getCachedMacAlias(filePath, mtimeMs);
        if (cached !== undefined)
            return cached;
        try {
            const out = (0, child_process_1.execFileSync)('osascript', ['-e', FileSystemManager.MAC_ALIAS_RESOLVE_SCRIPT, filePath], {
                encoding: 'utf-8',
                timeout: 3000,
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            return this.putCachedMacAlias(filePath, mtimeMs, this.parseMacAliasResolveOutput(out));
        }
        catch {
            return this.putCachedMacAlias(filePath, mtimeMs, null);
        }
    }
    /** If `dirPath` is a Finder alias (or symlink) to a folder, return the real path to list. */
    async resolveListableDirectoryAsync(dirPath) {
        try {
            const lstats = await fs_1.default.promises.lstat(dirPath);
            if (lstats.isSymbolicLink()) {
                const target = await fs_1.default.promises.stat(dirPath);
                if (target.isDirectory())
                    return await fs_1.default.promises.realpath(dirPath);
            }
            if (process.platform === 'darwin' && this.looksLikeMacAlias(dirPath, lstats)) {
                const resolved = await this.resolveMacAliasAsync(dirPath);
                if (resolved) {
                    try {
                        if ((await fs_1.default.promises.stat(resolved)).isDirectory())
                            return resolved;
                    }
                    catch {
                        // Fall through.
                    }
                }
            }
        }
        catch {
            // Fall through to the original path.
        }
        return dirPath;
    }
    isBinary(buffer) {
        const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
        for (const byte of sample) {
            if (byte === 0) {
                return true;
            }
        }
        return false;
    }
    filterFilePaths(filePaths, rootPath, query, limit) {
        const smartCase = /[A-Z]/.test(query);
        const hasSpaces = /\s/.test(query);
        const matches = [];
        if (hasSpaces) {
            const tokens = query.split(/\s+/).filter(Boolean);
            const pattern = tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s_\\-./\\\\]+');
            const flags = smartCase ? '' : 'i';
            const regex = new RegExp(pattern, flags);
            for (const filePath of filePaths) {
                const relativePath = filePath.startsWith(rootPath)
                    ? filePath.slice(rootPath.length + 1)
                    : filePath;
                if (regex.test(relativePath)) {
                    matches.push(filePath);
                    if (matches.length >= limit)
                        break;
                }
            }
        }
        else {
            const needle = smartCase ? query : query.toLowerCase();
            for (const filePath of filePaths) {
                const relativePath = filePath.startsWith(rootPath)
                    ? filePath.slice(rootPath.length + 1)
                    : filePath;
                const haystack = smartCase ? relativePath : relativePath.toLowerCase();
                if (haystack.includes(needle)) {
                    matches.push(filePath);
                    if (matches.length >= limit)
                        break;
                }
            }
        }
        return matches;
    }
    isAlwaysVisibleEnvFile(entryName) {
        return FileSystemManager.ALWAYS_VISIBLE_ENV_FILE.test(entryName);
    }
    shouldHideExplorerEntry(entryName, showHidden) {
        return !showHidden && entryName.startsWith('.') && !this.isAlwaysVisibleEnvFile(entryName);
    }
    // Rust-backed watcher events still need to invalidate Electron's gitignore
    // cache before they fan out to main-process and renderer consumers.
    invalidateGitignoreCacheForPath(filePath) {
        const normalizedPath = filePath.replace(/\\/g, '/');
        if (path_1.default.basename(filePath) === '.gitignore' ||
            normalizedPath.endsWith('/.git/info/exclude') ||
            this.isAlwaysVisibleEnvFile(path_1.default.basename(filePath))) {
            // Don't nuke cache entries for sshfs mounts — re-running `git ls-files`
            // over SFTP is expensive and the user can refresh manually.
            if ((0, ssh_1.isSshfsPath)(filePath))
                return;
            this.gitignoreCacheEpoch += 1;
            this.gitignoreCache.clear();
            this.gitignoreLoadPromises.clear();
        }
    }
}
exports.FileSystemManager = FileSystemManager;
