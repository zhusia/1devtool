"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerFileHandlers = registerFileHandlers;
const path_1 = __importDefault(require("path"));
const SHOW_HIDDEN = false;
const SEARCH_LIMIT = 50;
// Cap on a single file's bytes streamed to the phone for the read-only viewer.
// Larger files return isTooLarge so a phone never downloads a multi-MB blob over
// the remote bridge; the desktop editor remains the place to open huge files.
const READ_MAX_BYTES = 2 * 1024 * 1024;
// One-level directory browsing does NOT respect .gitignore on purpose:
// FileSystemManager.getIgnoredPaths() shells out via the SYNCHRONOUS
// `execSync('git ls-files …')`, which would block the main-process event loop
// (the same loop streaming terminal output to every connected phone) on the
// first browse of each project. A single `node_modules` row in a browse list
// is a cheap price vs. a multi-second main-thread stall on a large repo.
// Mirrors the desktop FileTree, which also defaults respectGitignore=false.
const TREE_RESPECT_GITIGNORE = false;
// Search DOES respect .gitignore — ripgrep applies it natively and
// asynchronously (no execSync), so node_modules can't blow the 50-result cap.
const SEARCH_RESPECT_GITIGNORE = true;
/**
 * Resolve a phone-supplied project-relative path to an absolute path that is
 * guaranteed to stay inside the project root. Returns null on traversal
 * attempts (`..`, absolute paths) so a malicious/buggy client can't read
 * arbitrary disk locations through the remote bridge.
 */
function safeResolve(rootPath, relPath) {
    const segments = (relPath || '')
        .split(/[\\/]/)
        .filter((s) => s && s !== '.');
    const resolved = path_1.default.resolve(rootPath, ...segments);
    const rel = path_1.default.relative(rootPath, resolved);
    if (rel === '')
        return rootPath;
    if (rel.startsWith('..') || path_1.default.isAbsolute(rel))
        return null;
    return resolved;
}
/** Convert an absolute path under rootPath to a project-relative POSIX path. */
function toPosixRel(rootPath, absPath) {
    return path_1.default.relative(rootPath, absPath).split(path_1.default.sep).join('/');
}
function resolveProjectRoot(storeManager, projectId) {
    const project = storeManager.getProjects().find((p) => p.id === projectId);
    return project?.rootPath || null;
}
/**
 * Register read-only project file browsing for the remote phone UI.
 *
 * - files:tree   -> list one directory's immediate children (folder navigation)
 * - files:search -> flat name search across the project (mention typeahead)
 *
 * Both are scoped to a single project's root resolved server-side from the
 * projectId; the phone never supplies absolute paths.
 */
function registerFileHandlers(io, managers) {
    const { storeManager, fsManager } = managers;
    io.on('connection', (socket) => {
        socket.on('files:tree', async (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (!storeManager || !fsManager) {
                ack({ ok: false, error: 'File browsing unavailable' });
                return;
            }
            const { projectId, relPath } = payload || {};
            if (!projectId) {
                ack({ ok: false, error: 'Missing projectId' });
                return;
            }
            const rootPath = resolveProjectRoot(storeManager, projectId);
            if (!rootPath) {
                ack({ ok: false, error: 'Project not found' });
                return;
            }
            const dirPath = safeResolve(rootPath, relPath);
            if (!dirPath) {
                ack({ ok: false, error: 'Invalid path' });
                return;
            }
            try {
                const nodes = await fsManager.readDirectory(dirPath, TREE_RESPECT_GITIGNORE, SHOW_HIDDEN);
                const entries = nodes.map((node) => ({
                    name: node.name,
                    relPath: toPosixRel(rootPath, node.path),
                    isDirectory: node.isDirectory,
                }));
                ack({ ok: true, relPath: toPosixRel(rootPath, dirPath), entries });
            }
            catch (err) {
                ack({ ok: false, error: err instanceof Error ? err.message : 'Failed to read directory' });
            }
        });
        socket.on('files:search', async (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (!storeManager || !fsManager) {
                ack({ ok: false, error: 'File search unavailable' });
                return;
            }
            const { projectId, query } = payload || {};
            if (!projectId) {
                ack({ ok: false, error: 'Missing projectId' });
                return;
            }
            const trimmed = (query || '').trim();
            if (!trimmed) {
                ack({ ok: true, entries: [] });
                return;
            }
            const rootPath = resolveProjectRoot(storeManager, projectId);
            if (!rootPath) {
                ack({ ok: false, error: 'Project not found' });
                return;
            }
            try {
                const paths = await fsManager.searchPaths(rootPath, trimmed, SEARCH_RESPECT_GITIGNORE, SHOW_HIDDEN, SEARCH_LIMIT);
                const entries = paths.map((absPath) => ({
                    name: path_1.default.basename(absPath),
                    relPath: toPosixRel(rootPath, absPath),
                    isDirectory: false,
                }));
                ack({ ok: true, entries });
            }
            catch (err) {
                ack({ ok: false, error: err instanceof Error ? err.message : 'Search failed' });
            }
        });
        socket.on('files:read', async (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (!storeManager || !fsManager) {
                ack({ ok: false, error: 'File reading unavailable' });
                return;
            }
            const { projectId, relPath } = payload || {};
            if (!projectId) {
                ack({ ok: false, error: 'Missing projectId' });
                return;
            }
            if (!relPath) {
                ack({ ok: false, error: 'Missing path' });
                return;
            }
            const rootPath = resolveProjectRoot(storeManager, projectId);
            if (!rootPath) {
                ack({ ok: false, error: 'Project not found' });
                return;
            }
            const filePath = safeResolve(rootPath, relPath);
            if (!filePath || filePath === rootPath) {
                ack({ ok: false, error: 'Invalid path' });
                return;
            }
            try {
                const result = fsManager.readFile(filePath, READ_MAX_BYTES);
                ack({
                    ok: true,
                    file: {
                        name: path_1.default.basename(filePath),
                        relPath: toPosixRel(rootPath, filePath),
                        content: result.content,
                        isBinary: result.isBinary,
                        isTooLarge: result.isTooLarge,
                        isImage: result.isImage,
                        dataUrl: result.dataUrl,
                        size: result.size,
                    },
                });
            }
            catch (err) {
                ack({ ok: false, error: err instanceof Error ? err.message : 'Failed to read file' });
            }
        });
        socket.on('files:write', async (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (!storeManager || !fsManager) {
                ack({ ok: false, error: 'File editing unavailable' });
                return;
            }
            const { projectId, relPath, content } = payload || {};
            if (!projectId) {
                ack({ ok: false, error: 'Missing projectId' });
                return;
            }
            if (!relPath) {
                ack({ ok: false, error: 'Missing path' });
                return;
            }
            if (typeof content !== 'string') {
                ack({ ok: false, error: 'Invalid content' });
                return;
            }
            // Mirror the read cap so the phone can't push a multi-MB blob through the
            // bridge (and so anything editable here was editable on the way in).
            if (Buffer.byteLength(content, 'utf8') > READ_MAX_BYTES) {
                ack({ ok: false, error: 'File is too large to save from the remote' });
                return;
            }
            const rootPath = resolveProjectRoot(storeManager, projectId);
            if (!rootPath) {
                ack({ ok: false, error: 'Project not found' });
                return;
            }
            const filePath = safeResolve(rootPath, relPath);
            if (!filePath || filePath === rootPath) {
                ack({ ok: false, error: 'Invalid path' });
                return;
            }
            try {
                fsManager.writeFile(filePath, content);
                ack({ ok: true, size: Buffer.byteLength(content, 'utf8') });
            }
            catch (err) {
                ack({ ok: false, error: err instanceof Error ? err.message : 'Failed to save file' });
            }
        });
    });
}
