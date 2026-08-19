"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RustServiceBridge = void 0;
exports.normalizeFileWatchPath = normalizeFileWatchPath;
exports.getFileWatchPathKey = getFileWatchPathKey;
exports.isFileWatchPathWithinRoot = isFileWatchPathWithinRoot;
exports.shouldIgnoreFileWatchPath = shouldIgnoreFileWatchPath;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const rustFeatureFlags_1 = require("./rustFeatureFlags");
const ssh_1 = require("./ssh");
const METHOD_FILE_SYSTEM_LIST_DIRECTORY = 'fileSystem.listDirectory';
const METHOD_FILE_SYSTEM_LIST_FILES = 'fileSystem.listFiles';
const METHOD_FILE_SYSTEM_SEARCH_PATHS = 'fileSystem.searchPaths';
const METHOD_FILE_SYSTEM_SEARCH_CONTENT = 'fileSystem.searchContent';
const METHOD_FILE_SYSTEM_WATCH = 'fileSystem.watch';
const METHOD_FILE_SYSTEM_UNWATCH = 'fileSystem.unwatch';
const FILE_SYSTEM_WATCH_STREAM = 'fileSystem.watch';
const ALWAYS_IGNORED_WATCH_DIRS = new Set(['.git', 'node_modules']);
const DEFAULT_IGNORED_WATCH_DIRS = new Set([
    ...ALWAYS_IGNORED_WATCH_DIRS,
    'dist',
    'build',
    '.next',
    '.nuxt',
    'coverage',
    '__pycache__',
    'target',
    'vendor',
]);
const WATCH_DUPLICATE_WINDOW_MS = 120;
const WATCH_RECENT_EVENT_LIMIT = 256;
const VALID_RUST_WATCH_EVENT_KINDS = new Set([
    'add',
    'change',
    'unlink',
    'addDir',
    'unlinkDir',
    'created',
    'modified',
    'removed',
    'renamed',
]);
class RustServiceBridge {
    sidecar;
    fileSystem;
    fallbackCounts = {};
    activeWatches = new Map();
    watchOperationChains = new Map();
    removeSidecarEventListener = null;
    removeSidecarUnavailableListener = null;
    isRemotePath;
    platform;
    now;
    nextWatchSubscriberId = 1;
    disposed = false;
    constructor(sidecar, fileSystem, options = {}) {
        this.sidecar = sidecar;
        this.fileSystem = fileSystem;
        this.isRemotePath = options.isRemotePath ?? ssh_1.isSshfsPath;
        this.platform = options.platform ?? process.platform;
        this.now = options.now ?? Date.now;
        this.attachSidecarListeners();
    }
    resume() {
        if (!this.disposed)
            return;
        this.disposed = false;
        this.attachSidecarListeners();
    }
    attachSidecarListeners() {
        if (this.removeSidecarEventListener || this.removeSidecarUnavailableListener) {
            return;
        }
        this.removeSidecarEventListener = this.sidecar.onSidecarEvent((event) => this.handleSidecarEvent(event));
        this.removeSidecarUnavailableListener = this.sidecar.onSidecarUnavailable((event) => {
            this.handleSidecarUnavailable(event);
        });
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.removeSidecarEventListener?.();
        this.removeSidecarEventListener = null;
        this.removeSidecarUnavailableListener?.();
        this.removeSidecarUnavailableListener = null;
        this.unwatchAll();
    }
    unwatchAll() {
        for (const entry of this.activeWatches.values()) {
            if (entry.backend === 'chokidar') {
                this.releaseAllFallbackRegistrations(entry);
            }
            else if (entry.backend === 'rust') {
                void this.stopSidecarWatch(entry);
            }
        }
        this.activeWatches.clear();
        this.watchOperationChains.clear();
    }
    getDiagnostics() {
        let rustRootCount = 0;
        let chokidarRootCount = 0;
        let startingRootCount = 0;
        let subscriberCount = 0;
        const fallbackReasons = {};
        for (const entry of this.activeWatches.values()) {
            subscriberCount += getTotalWatchRefCount(entry.counts);
            if (entry.backend === 'rust')
                rustRootCount += 1;
            else if (entry.backend === 'chokidar')
                chokidarRootCount += 1;
            else
                startingRootCount += 1;
            if (entry.fallbackReason) {
                fallbackReasons[entry.fallbackReason] = (fallbackReasons[entry.fallbackReason] ?? 0) + 1;
            }
        }
        return {
            featureFlags: (0, rustFeatureFlags_1.getRustFeatureFlagDiagnostics)(),
            sidecar: this.sidecar.getDiagnostics(),
            fallbackCounts: { ...this.fallbackCounts },
            fileWatcher: {
                activeRootCount: this.activeWatches.size,
                rustRootCount,
                chokidarRootCount,
                startingRootCount,
                subscriberCount,
                fallbackReasons,
            },
        };
    }
    async readDirectory(dirPath, respectGitignore, showHidden) {
        if (!(0, rustFeatureFlags_1.isRustFeatureEnabled)(rustFeatureFlags_1.RUST_FILE_SYSTEM_FLAG)) {
            return this.fileSystem.readDirectory(dirPath, respectGitignore, showHidden);
        }
        try {
            const response = await this.sidecar.request(METHOD_FILE_SYSTEM_LIST_DIRECTORY, {
                path: dirPath,
                respectGitignore,
                showHiddenFiles: showHidden,
            }, {
                featureFlag: rustFeatureFlags_1.RUST_FILE_SYSTEM_FLAG,
                timeoutMs: 8000,
            });
            if (response.warnings?.length) {
                console.warn('[rust-sidecar] fileSystem.listDirectory warnings:', response.warnings);
            }
            return response.entries.map(mapRustFileNode);
        }
        catch (error) {
            this.recordFallback('fileSystem.readDirectory');
            console.warn('[rust-sidecar] Falling back to Electron fileSystem.readDirectory:', formatError(error));
            return this.fileSystem.readDirectory(dirPath, respectGitignore, showHidden);
        }
    }
    async listFiles(dirPath, respectGitignore, showHidden, limit) {
        if (!(0, rustFeatureFlags_1.isRustFeatureEnabled)(rustFeatureFlags_1.RUST_FILE_SYSTEM_FLAG)) {
            return this.fileSystem.listFiles(dirPath, respectGitignore, showHidden, limit);
        }
        try {
            const response = await this.sidecar.request(METHOD_FILE_SYSTEM_LIST_FILES, {
                path: dirPath,
                respectGitignore,
                showHidden,
                limit,
            }, {
                featureFlag: rustFeatureFlags_1.RUST_FILE_SYSTEM_FLAG,
                timeoutMs: 8000,
            });
            return response.files;
        }
        catch (error) {
            this.recordFallback('fileSystem.listFiles');
            console.warn('[rust-sidecar] Falling back to Electron fileSystem.listFiles:', formatError(error));
            return this.fileSystem.listFiles(dirPath, respectGitignore, showHidden, limit);
        }
    }
    async searchPaths(dirPath, query, respectGitignore, showHidden, limit) {
        if (!(0, rustFeatureFlags_1.isRustFeatureEnabled)(rustFeatureFlags_1.RUST_FILE_SYSTEM_FLAG)) {
            return this.fileSystem.searchPaths(dirPath, query, respectGitignore, showHidden, limit);
        }
        try {
            const response = await this.sidecar.request(METHOD_FILE_SYSTEM_SEARCH_PATHS, {
                path: dirPath,
                query,
                respectGitignore,
                showHidden,
                limit,
            }, {
                featureFlag: rustFeatureFlags_1.RUST_FILE_SYSTEM_FLAG,
                timeoutMs: 8000,
            });
            return response.paths;
        }
        catch (error) {
            this.recordFallback('fileSystem.searchPaths');
            console.warn('[rust-sidecar] Falling back to Electron fileSystem.searchPaths:', formatError(error));
            return this.fileSystem.searchPaths(dirPath, query, respectGitignore, showHidden, limit);
        }
    }
    async searchContent(dirPath, query, respectGitignore, showHidden, limit) {
        if (!(0, rustFeatureFlags_1.isRustFeatureEnabled)(rustFeatureFlags_1.RUST_FILE_SYSTEM_FLAG)) {
            return this.fileSystem.searchContent(dirPath, query, respectGitignore, showHidden, limit);
        }
        try {
            const response = await this.sidecar.request(METHOD_FILE_SYSTEM_SEARCH_CONTENT, {
                rootPath: dirPath,
                query,
                respectGitignore,
                includeHidden: showHidden,
                maxResults: limit,
            }, {
                featureFlag: rustFeatureFlags_1.RUST_FILE_SYSTEM_FLAG,
                timeoutMs: 10_000,
            });
            return response.matches;
        }
        catch (error) {
            this.recordFallback('fileSystem.searchContent');
            console.warn('[rust-sidecar] Falling back to Electron fileSystem.searchContent:', formatError(error));
            return this.fileSystem.searchContent(dirPath, query, respectGitignore, showHidden, limit);
        }
    }
    watch(dirPath, callback, options = {}) {
        const key = getFileWatchPathKey(dirPath, this.platform);
        const profile = normalizeWatchProfile(options.profile);
        return this.enqueueWatchOperation(key, async () => {
            if (this.disposed)
                return;
            const existing = this.activeWatches.get(key);
            if (existing) {
                existing.callback = callback;
                existing.counts[profile] += 1;
                if (existing.backend === 'chokidar') {
                    this.registerFallbackSubscription(existing, profile);
                }
                return;
            }
            const entry = this.createActiveWatch(key, dirPath, callback);
            entry.counts[profile] = 1;
            this.activeWatches.set(key, entry);
            try {
                await this.startWatchEntry(entry);
            }
            catch (error) {
                this.activeWatches.delete(key);
                this.releaseAllFallbackRegistrations(entry);
                throw error;
            }
        });
    }
    unwatch(dirPath, options = {}) {
        const key = getFileWatchPathKey(dirPath, this.platform);
        const profile = normalizeWatchProfile(options.profile);
        return this.enqueueWatchOperation(key, async () => {
            const entry = this.activeWatches.get(key);
            if (!entry || entry.counts[profile] <= 0) {
                return;
            }
            entry.counts[profile] -= 1;
            if (entry.backend === 'chokidar') {
                this.unregisterFallbackSubscription(entry, profile);
            }
            if (getTotalWatchRefCount(entry.counts) > 0) {
                return;
            }
            this.activeWatches.delete(key);
            if (entry.backend === 'rust') {
                await this.stopSidecarWatch(entry);
            }
            entry.recentEvents.clear();
        });
    }
    createActiveWatch(key, dirPath, callback) {
        const entry = {
            key,
            requestedPath: normalizeFileWatchPath(dirPath, this.platform),
            sidecarPath: null,
            sidecarKey: null,
            subscriberId: `electron-${process.pid}-${this.nextWatchSubscriberId++}`,
            callback,
            fallbackCallback: (() => { }),
            counts: createWatchRefCounts(),
            fallbackRegisteredCounts: createWatchRefCounts(),
            backend: 'starting',
            fallbackReason: null,
            eventContractVersion: null,
            recentEvents: new Map(),
        };
        entry.fallbackCallback = (event, filePath) => entry.callback(event, filePath);
        return entry;
    }
    async startWatchEntry(entry) {
        if (!(0, rustFeatureFlags_1.isRustFeatureEnabled)(rustFeatureFlags_1.RUST_FILE_WATCHER_FLAG)) {
            this.activateFallback(entry, 'feature-disabled', false);
            return;
        }
        if (this.isRemotePath(entry.requestedPath)) {
            this.activateFallback(entry, 'remote-mount', false);
            return;
        }
        try {
            const response = await this.sidecar.request(METHOD_FILE_SYSTEM_WATCH, {
                path: entry.requestedPath,
                subscriberId: entry.subscriberId,
            }, {
                featureFlag: rustFeatureFlags_1.RUST_FILE_WATCHER_FLAG,
                timeoutMs: 8000,
            });
            if (this.disposed || this.activeWatches.get(entry.key) !== entry) {
                await this.stopSidecarWatch(entry, response.path);
                return;
            }
            entry.sidecarPath = normalizeFileWatchPath(response.path || entry.requestedPath, this.platform);
            entry.sidecarKey = getFileWatchPathKey(entry.sidecarPath, this.platform);
            entry.eventContractVersion = response.eventContractVersion ?? null;
            entry.backend = 'rust';
            entry.fallbackReason = null;
        }
        catch (error) {
            if (this.disposed || this.activeWatches.get(entry.key) !== entry) {
                return;
            }
            console.warn('[rust-sidecar] Falling back to Chokidar file watching:', formatError(error));
            this.activateFallback(entry, 'sidecar-request-failed', true);
        }
    }
    activateFallback(entry, reason, recordFallback) {
        if (entry.backend === 'chokidar')
            return;
        entry.backend = 'chokidar';
        entry.fallbackReason = reason;
        if (recordFallback) {
            this.recordFallback('fileSystem.watch');
        }
        for (const profile of watchProfiles()) {
            while (entry.fallbackRegisteredCounts[profile] < entry.counts[profile]) {
                this.registerFallbackSubscription(entry, profile);
            }
        }
    }
    registerFallbackSubscription(entry, profile) {
        this.fileSystem.watch(entry.requestedPath, entry.fallbackCallback, { profile });
        entry.fallbackRegisteredCounts[profile] += 1;
    }
    unregisterFallbackSubscription(entry, profile) {
        if (entry.fallbackRegisteredCounts[profile] <= 0)
            return;
        this.fileSystem.unwatch(entry.requestedPath, { profile });
        entry.fallbackRegisteredCounts[profile] -= 1;
    }
    releaseAllFallbackRegistrations(entry) {
        for (const profile of watchProfiles()) {
            while (entry.fallbackRegisteredCounts[profile] > 0) {
                this.unregisterFallbackSubscription(entry, profile);
            }
        }
    }
    async stopSidecarWatch(entry, overridePath) {
        try {
            await this.sidecar.request(METHOD_FILE_SYSTEM_UNWATCH, {
                path: overridePath ?? entry.sidecarPath ?? entry.requestedPath,
                subscriberId: entry.subscriberId,
            }, {
                featureFlag: rustFeatureFlags_1.RUST_FILE_WATCHER_FLAG,
                timeoutMs: 4000,
            });
        }
        catch (error) {
            if (!this.disposed) {
                console.warn('[rust-sidecar] fileSystem.unwatch failed:', formatError(error));
            }
        }
    }
    handleSidecarUnavailable(event) {
        if (this.disposed)
            return;
        for (const [key, entry] of this.activeWatches) {
            if (entry.backend !== 'rust' && entry.backend !== 'starting')
                continue;
            void this.enqueueWatchOperation(key, async () => {
                if (this.disposed || this.activeWatches.get(key) !== entry)
                    return;
                if (entry.backend !== 'rust' && entry.backend !== 'starting')
                    return;
                console.warn(`[rust-sidecar] ${event.message}; moving ${entry.requestedPath} to Chokidar`);
                this.activateFallback(entry, 'sidecar-unavailable', true);
            });
        }
    }
    handleSidecarEvent(event) {
        if (event.streamId !== FILE_SYSTEM_WATCH_STREAM) {
            return;
        }
        const payload = parseRustWatchEventPayload(event.payload);
        if (!payload) {
            return;
        }
        const eventPath = normalizeFileWatchPath(payload.path, this.platform);
        const watchPath = payload.watchPath
            ? normalizeFileWatchPath(payload.watchPath, this.platform)
            : null;
        const watchPathKey = watchPath
            ? getFileWatchPathKey(watchPath, this.platform)
            : null;
        const mappedKind = mapRustWatchEventKind(payload.kind, eventPath);
        if (!mappedKind) {
            return;
        }
        let candidates = [...this.activeWatches.values()].filter((entry) => {
            if (entry.backend !== 'rust' && entry.backend !== 'starting')
                return false;
            if (!watchPathKey)
                return true;
            return entry.sidecarKey === watchPathKey || entry.key === watchPathKey;
        });
        // A watch can produce an event immediately before its subscription
        // response is read. During that tiny window the canonical sidecar root is
        // not known yet, so fall back to strict containment instead of dropping it.
        if (candidates.length === 0 && watchPathKey) {
            candidates = [...this.activeWatches.values()].filter((entry) => (entry.backend === 'starting' &&
                isFileWatchPathWithinRoot(eventPath, entry.requestedPath, this.platform)));
        }
        for (const entry of candidates) {
            const matchingRoot = findMatchingWatchRoot(entry, eventPath, this.platform);
            if (!matchingRoot)
                continue;
            const callbackPath = mapWatchEventToRequestedPath(entry, eventPath, matchingRoot, this.platform);
            const profile = getEffectiveWatchProfile(entry.counts);
            if (shouldIgnoreFileWatchPath(entry.requestedPath, callbackPath, profile, this.platform)) {
                continue;
            }
            if (this.isDuplicateWatchEvent(entry, mappedKind, callbackPath)) {
                continue;
            }
            this.fileSystem.invalidateGitignoreCacheForPath(callbackPath);
            try {
                entry.callback(mappedKind, callbackPath);
            }
            catch (error) {
                console.warn('[rust-sidecar] file watch callback failed:', formatError(error));
            }
        }
    }
    isDuplicateWatchEvent(entry, kind, eventPath) {
        const now = this.now();
        const signature = `${kind}\0${getFileWatchPathKey(eventPath, this.platform)}`;
        const previous = entry.recentEvents.get(signature);
        entry.recentEvents.set(signature, now);
        if (entry.recentEvents.size > WATCH_RECENT_EVENT_LIMIT) {
            for (const [key, seenAt] of entry.recentEvents) {
                if (now - seenAt > WATCH_DUPLICATE_WINDOW_MS) {
                    entry.recentEvents.delete(key);
                }
            }
        }
        return previous !== undefined && now - previous < WATCH_DUPLICATE_WINDOW_MS;
    }
    enqueueWatchOperation(key, operation) {
        const previous = this.watchOperationChains.get(key) ?? Promise.resolve();
        const next = previous.catch(() => { }).then(operation);
        this.watchOperationChains.set(key, next);
        void next.then(() => {
            if (this.watchOperationChains.get(key) === next) {
                this.watchOperationChains.delete(key);
            }
        }, () => {
            if (this.watchOperationChains.get(key) === next) {
                this.watchOperationChains.delete(key);
            }
        });
        return next;
    }
    recordFallback(method) {
        this.fallbackCounts[method] = (this.fallbackCounts[method] ?? 0) + 1;
    }
}
exports.RustServiceBridge = RustServiceBridge;
function createWatchRefCounts() {
    return {
        default: 0,
        'file-tree': 0,
    };
}
function watchProfiles() {
    return ['default', 'file-tree'];
}
function normalizeWatchProfile(profile) {
    return profile === 'file-tree' ? 'file-tree' : 'default';
}
function getTotalWatchRefCount(counts) {
    return counts.default + counts['file-tree'];
}
function getEffectiveWatchProfile(counts) {
    return counts['file-tree'] > 0 ? 'file-tree' : 'default';
}
function findMatchingWatchRoot(entry, eventPath, platform) {
    if (entry.sidecarPath &&
        isFileWatchPathWithinRoot(eventPath, entry.sidecarPath, platform)) {
        return entry.sidecarPath;
    }
    if (isFileWatchPathWithinRoot(eventPath, entry.requestedPath, platform)) {
        return entry.requestedPath;
    }
    return null;
}
function mapWatchEventToRequestedPath(entry, eventPath, matchingRoot, platform) {
    if (getFileWatchPathKey(matchingRoot, platform) ===
        getFileWatchPathKey(entry.requestedPath, platform)) {
        return eventPath;
    }
    const windowsPath = platform === 'win32' ||
        looksLikeWindowsPath(matchingRoot) ||
        looksLikeWindowsPath(entry.requestedPath);
    const pathApi = windowsPath ? path_1.default.win32 : path_1.default.posix;
    const relative = pathApi.relative(matchingRoot, eventPath);
    if (relative === '..' ||
        relative.startsWith(`..${pathApi.sep}`) ||
        pathApi.isAbsolute(relative)) {
        return eventPath;
    }
    return normalizeFileWatchPath(pathApi.join(entry.requestedPath, relative), platform);
}
function parseRustWatchEventPayload(payload) {
    if (!payload || typeof payload !== 'object')
        return null;
    const candidate = payload;
    if (typeof candidate.path !== 'string' || typeof candidate.kind !== 'string') {
        return null;
    }
    if (candidate.watchPath !== undefined &&
        typeof candidate.watchPath !== 'string') {
        return null;
    }
    if (!VALID_RUST_WATCH_EVENT_KINDS.has(candidate.kind)) {
        return null;
    }
    return candidate;
}
function mapRustWatchEventKind(kind, eventPath) {
    if (kind === 'add' ||
        kind === 'change' ||
        kind === 'unlink' ||
        kind === 'addDir' ||
        kind === 'unlinkDir') {
        return kind;
    }
    if (kind === 'modified') {
        return 'change';
    }
    if (kind === 'removed') {
        return 'unlink';
    }
    try {
        const isDirectory = fs_1.default.statSync(eventPath).isDirectory();
        return kind === 'created' || kind === 'renamed'
            ? isDirectory ? 'addDir' : 'add'
            : null;
    }
    catch {
        return kind === 'renamed' ? 'unlink' : 'add';
    }
}
function normalizeFileWatchPath(value, platform = process.platform) {
    const windowsPath = platform === 'win32' || looksLikeWindowsPath(value);
    const pathApi = windowsPath ? path_1.default.win32 : path_1.default.posix;
    const withoutVerbatimPrefix = windowsPath
        ? stripWindowsVerbatimPrefix(value)
        : value;
    return pathApi.normalize(withoutVerbatimPrefix);
}
function getFileWatchPathKey(value, platform = process.platform) {
    const normalized = normalizeFileWatchPath(value, platform);
    return platform === 'win32' || looksLikeWindowsPath(normalized)
        ? normalized.toLowerCase()
        : normalized;
}
function isFileWatchPathWithinRoot(candidatePath, rootPath, platform = process.platform) {
    const windowsPath = platform === 'win32' ||
        looksLikeWindowsPath(candidatePath) ||
        looksLikeWindowsPath(rootPath);
    const pathApi = windowsPath ? path_1.default.win32 : path_1.default.posix;
    const normalizedCandidate = normalizeFileWatchPath(candidatePath, windowsPath ? 'win32' : platform);
    const normalizedRoot = normalizeFileWatchPath(rootPath, windowsPath ? 'win32' : platform);
    const relative = pathApi.relative(normalizedRoot, normalizedCandidate);
    return (relative === '' ||
        (relative !== '..' &&
            !relative.startsWith(`..${pathApi.sep}`) &&
            !pathApi.isAbsolute(relative)));
}
function shouldIgnoreFileWatchPath(rootPath, candidatePath, profile, platform = process.platform) {
    const windowsPath = platform === 'win32' ||
        looksLikeWindowsPath(candidatePath) ||
        looksLikeWindowsPath(rootPath);
    const pathApi = windowsPath ? path_1.default.win32 : path_1.default.posix;
    const normalizedCandidate = normalizeFileWatchPath(candidatePath, windowsPath ? 'win32' : platform);
    const normalizedRoot = normalizeFileWatchPath(rootPath, windowsPath ? 'win32' : platform);
    const relative = pathApi.relative(normalizedRoot, normalizedCandidate);
    if (relative === '..' ||
        relative.startsWith(`..${pathApi.sep}`) ||
        pathApi.isAbsolute(relative)) {
        return true;
    }
    const ignored = profile === 'file-tree'
        ? ALWAYS_IGNORED_WATCH_DIRS
        : DEFAULT_IGNORED_WATCH_DIRS;
    return relative
        .split(/[\\/]+/)
        .filter(Boolean)
        .some((segment) => ignored.has(segment.toLowerCase()));
}
function looksLikeWindowsPath(value) {
    return /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value);
}
function stripWindowsVerbatimPrefix(value) {
    if (/^\\\\\?\\UNC\\/i.test(value)) {
        return value.replace(/^\\\\\?\\UNC\\/i, '\\\\');
    }
    return value.replace(/^\\\\\?\\/, '');
}
function mapRustFileNode(node) {
    const mapped = {
        name: node.name,
        path: node.path,
        isDirectory: node.isDirectory,
    };
    if (node.children?.length) {
        mapped.children = node.children.map(mapRustFileNode);
    }
    return mapped;
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
