"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFileWatcherOptions = getFileWatcherOptions;
exports.createFileWatcher = createFileWatcher;
exports.resolveFileWatcherPath = resolveFileWatcherPath;
exports.mapFileWatcherEventPath = mapFileWatcherEventPath;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const chokidar_1 = __importDefault(require("chokidar"));
const DEFAULT_WATCH_IGNORES = [
    '**/.git/**',
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/.nuxt/**',
    '**/coverage/**',
    '**/__pycache__/**',
    '**/target/**',
    '**/vendor/**',
];
const FILE_TREE_WATCH_IGNORES = [
    '**/.git/**',
    '**/node_modules/**',
];
function getFileWatcherOptions(profile, options) {
    const { isRemote, isWindows } = options;
    const ignored = profile === 'file-tree' && !isRemote
        ? FILE_TREE_WATCH_IGNORES
        : DEFAULT_WATCH_IGNORES;
    // Recursive stat polling was the cause of the Windows spin-loop report:
    // seven roots produced roughly 108k stat/lstat calls per second. Local
    // Windows fallback must stay on chokidar's fs.watch/ReadDirectoryChangesW
    // backend. Polling is reserved for remote mounts that do not forward native
    // filesystem events reliably.
    return {
        ignored,
        persistent: true,
        ignoreInitial: true,
        depth: isRemote ? 1 : 5,
        usePolling: isRemote,
        interval: isRemote ? 5000 : undefined,
        binaryInterval: isRemote ? 10000 : undefined,
        ...(isRemote
            ? {
                awaitWriteFinish: {
                    stabilityThreshold: 1500,
                    pollInterval: 500,
                },
            }
            : isWindows
                ? {}
                : {
                    awaitWriteFinish: {
                        stabilityThreshold: 300,
                        pollInterval: 100,
                    },
                }),
    };
}
function createFileWatcher(dirPath, profile, options) {
    // Chokidar applies these environment variables *after* explicit options.
    // A parent shell setting CHOKIDAR_USEPOLLING=1 would otherwise recreate the
    // Windows stat storm even though this app requested native events. Remove
    // the overrides only for the synchronous watcher construction, then restore
    // the caller's environment unchanged.
    const previousUsePolling = process.env.CHOKIDAR_USEPOLLING;
    const previousInterval = process.env.CHOKIDAR_INTERVAL;
    delete process.env.CHOKIDAR_USEPOLLING;
    delete process.env.CHOKIDAR_INTERVAL;
    try {
        const watchPath = resolveFileWatcherPath(dirPath, options);
        return chokidar_1.default.watch(watchPath, getFileWatcherOptions(profile, options));
    }
    finally {
        restoreEnv('CHOKIDAR_USEPOLLING', previousUsePolling);
        restoreEnv('CHOKIDAR_INTERVAL', previousInterval);
    }
}
/**
 * Node 24's bundled libuv resolves changed children to their long Windows
 * names, then assumes the watched directory uses the same representation.
 * Watching an 8.3 root such as C:\\Users\\RUNNER~1 can therefore abort the
 * whole process inside uv__relative_path. Give the native handle the existing
 * directory's canonical long path while keeping caller identity elsewhere.
 */
function resolveFileWatcherPath(dirPath, options, nativeRealpath = fs_1.default.realpathSync.native) {
    if (!options.isWindows || options.isRemote) {
        return dirPath;
    }
    try {
        return nativeRealpath(dirPath);
    }
    catch {
        // Chokidar owns the normal missing/inaccessible-root behavior. Preserve it
        // when the path cannot be canonicalized during synchronous construction.
        return dirPath;
    }
}
/** Map canonical native-watch events back to the path identity requested by the caller. */
function mapFileWatcherEventPath(changedPath, requestedRoot, watchRoot, isWindows) {
    if (requestedRoot === watchRoot) {
        return changedPath;
    }
    const pathApi = isWindows ? path_1.default.win32 : path_1.default;
    const relativePath = pathApi.relative(watchRoot, changedPath);
    if (relativePath === '..' ||
        relativePath.startsWith(`..${pathApi.sep}`) ||
        pathApi.isAbsolute(relativePath)) {
        return changedPath;
    }
    return pathApi.join(requestedRoot, relativePath);
}
function restoreEnv(name, value) {
    if (value === undefined) {
        delete process.env[name];
    }
    else {
        process.env[name] = value;
    }
}
