"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerGitHandlers = registerGitHandlers;
const path_1 = __importDefault(require("path"));
const promises_1 = require("fs/promises");
// Bound network git ops (push/pull) so a stuck transport can't hold the handler
// open forever, and force non-interactive auth so git fails fast with a clear
// error instead of blocking on a credential prompt that no one can answer.
const GIT_NET_TIMEOUT_MS = 120_000;
const NON_INTERACTIVE_ENV = { GIT_TERMINAL_PROMPT: '0' };
const MAX_UNTRACKED_DIFF_BYTES = 256 * 1024;
const EMPTY_STATUS = {
    isRepo: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    files: [],
    recentCommits: [],
};
function resolveProjectRoot(storeManager, projectId) {
    const project = storeManager.getProjects().find((p) => p.id === projectId);
    return project?.rootPath || null;
}
function errorMessage(err) {
    return err instanceof Error ? err.message : 'Git command failed';
}
async function resolveRepositoryRoot(gitManager, projectRoot) {
    const result = await gitManager.run(projectRoot, 'rev-parse', { $nullOnError: true }, '--show-toplevel');
    const root = result?.stdout.trim();
    return root || null;
}
async function isUntrackedPath(gitManager, repoRoot, relPath) {
    const result = await gitManager.run(repoRoot, 'status', { porcelain: 'v1', untrackedFiles: 'all', $nullOnError: true }, '--', relPath);
    return (result?.stdout || '')
        .split('\n')
        .some((line) => line.startsWith('?? '));
}
async function resolveSafeRepoFile(repoRoot, relPath) {
    if (!relPath || path_1.default.isAbsolute(relPath))
        return null;
    const rootPath = path_1.default.resolve(repoRoot);
    const candidatePath = path_1.default.resolve(rootPath, relPath);
    const rootRealPath = await (0, promises_1.realpath)(rootPath).catch(() => rootPath);
    const candidateRealPath = await (0, promises_1.realpath)(candidatePath).catch(() => candidatePath);
    const rootPrefix = rootRealPath.endsWith(path_1.default.sep) ? rootRealPath : `${rootRealPath}${path_1.default.sep}`;
    if (candidateRealPath !== rootRealPath && !candidateRealPath.startsWith(rootPrefix)) {
        return null;
    }
    return candidatePath;
}
function isBinaryBuffer(buffer) {
    return buffer.subarray(0, Math.min(buffer.length, 8000)).includes(0);
}
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
async function buildUntrackedFileDiff(repoRoot, relPath) {
    const filePath = await resolveSafeRepoFile(repoRoot, relPath);
    if (!filePath)
        return '';
    const info = await (0, promises_1.stat)(filePath).catch(() => null);
    if (!info?.isFile())
        return '';
    const header = [
        `diff --git a/${relPath} b/${relPath}`,
        'new file mode 100644',
        'index 0000000..0000000',
        '--- /dev/null',
        `+++ b/${relPath}`,
    ];
    if (info.size > MAX_UNTRACKED_DIFF_BYTES) {
        return [
            ...header,
            '@@ -0,0 +1 @@',
            `+[File is ${formatBytes(info.size)} and too large to preview remotely.]`,
        ].join('\n') + '\n';
    }
    const buffer = await (0, promises_1.readFile)(filePath);
    if (isBinaryBuffer(buffer)) {
        return [
            ...header,
            `Binary files /dev/null and b/${relPath} differ`,
        ].join('\n') + '\n';
    }
    const text = buffer.toString('utf8');
    if (text.length === 0) {
        return [
            ...header,
            '@@ -0,0 +0,0 @@',
        ].join('\n') + '\n';
    }
    const lines = text.endsWith('\n')
        ? text.slice(0, -1).split('\n')
        : text.split('\n');
    const diffLines = [
        ...header,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`),
    ];
    if (!text.endsWith('\n')) {
        diffLines.push('\\ No newline at end of file');
    }
    return diffLines.join('\n') + '\n';
}
/**
 * Register read + lightweight-write git operations for the remote phone UI.
 *
 * - git:status -> branch + changed-file list (viewer)
 * - git:diff   -> unified diff for one file, staged or working-tree (viewer)
 * - git:commit -> stage all + commit with a message (operator)
 * - git:push   -> push current branch (operator)
 * - git:pull   -> pull current branch (operator)
 *
 * Permission gating is enforced centrally by the permission middleware
 * (EVENT_PERMISSIONS); the desktop user's git identity / credentials are used
 * as-is (repo or global config), exactly like a `git` command typed in a shell.
 */
function registerGitHandlers(io, managers) {
    const { storeManager, gitManager } = managers;
    io.on('connection', (socket) => {
        const resolveRoot = (projectId, ack) => {
            if (!storeManager || !gitManager) {
                ack({ ok: false, error: 'Git unavailable' });
                return null;
            }
            if (!projectId) {
                ack({ ok: false, error: 'Missing projectId' });
                return null;
            }
            const root = resolveProjectRoot(storeManager, projectId);
            if (!root) {
                ack({ ok: false, error: 'Project not found' });
                return null;
            }
            return root;
        };
        socket.on('git:status', async (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            const root = resolveRoot(payload?.projectId, ack);
            if (!root)
                return;
            try {
                const summary = await gitManager.getSummary(root, { $nullOnError: true });
                if (!summary) {
                    ack({ ok: true, status: EMPTY_STATUS });
                    return;
                }
                ack({
                    ok: true,
                    status: {
                        isRepo: true,
                        branch: summary.branch,
                        upstream: summary.upstream,
                        ahead: summary.ahead,
                        behind: summary.behind,
                        stagedCount: summary.stagedCount,
                        unstagedCount: summary.unstagedCount,
                        untrackedCount: summary.untrackedCount,
                        files: summary.files.map((file) => ({
                            path: file.path,
                            stagedStatus: file.stagedStatus,
                            unstagedStatus: file.unstagedStatus,
                            isUntracked: file.isUntracked,
                            isConflicted: file.isConflicted,
                        })),
                        recentCommits: summary.recentCommits.slice(0, 15).map((commit) => ({
                            hash: commit.hash,
                            shortHash: commit.shortHash,
                            author: commit.author,
                            relativeDate: commit.relativeDate,
                            subject: commit.subject,
                        })),
                    },
                });
            }
            catch (err) {
                ack({ ok: false, error: errorMessage(err) });
            }
        });
        socket.on('git:diff', async (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            const root = resolveRoot(payload?.projectId, ack);
            if (!root)
                return;
            try {
                const relPath = payload?.relPath;
                const staged = Boolean(payload?.staged);
                let diff = await gitManager.getDiff(root, relPath, staged);
                if (!diff.trim() && relPath && !staged) {
                    const repoRoot = await resolveRepositoryRoot(gitManager, root);
                    if (repoRoot && await isUntrackedPath(gitManager, repoRoot, relPath)) {
                        diff = await buildUntrackedFileDiff(repoRoot, relPath);
                    }
                }
                ack({ ok: true, diff });
            }
            catch (err) {
                ack({ ok: false, error: errorMessage(err) });
            }
        });
        socket.on('git:commit-detail', async (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            const root = resolveRoot(payload?.projectId, ack);
            if (!root)
                return;
            const hash = (payload?.hash || '').trim();
            if (!hash) {
                ack({ ok: false, error: 'Missing commit hash' });
                return;
            }
            try {
                const detail = await gitManager.getCommitDetail(root, hash, { $timeoutMs: 10_000 });
                ack({
                    ok: true,
                    detail: {
                        hash: detail.hash,
                        parentHashes: detail.parentHashes,
                        isMerge: detail.isMerge,
                        files: detail.files.map((file) => ({
                            path: file.path,
                            status: file.status,
                            additions: file.additions,
                            deletions: file.deletions,
                        })),
                        diff: detail.diff,
                    },
                });
            }
            catch (err) {
                ack({ ok: false, error: errorMessage(err) });
            }
        });
        socket.on('git:commit', async (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            const root = resolveRoot(payload?.projectId, ack);
            if (!root)
                return;
            const message = (payload?.message || '').trim();
            if (!message) {
                ack({ ok: false, error: 'Commit message required' });
                return;
            }
            try {
                // Stage everything (tracked + untracked + deletions), then commit — the
                // intuitive "commit my work" action for a phone with no staging UI.
                await gitManager.add(root, {}, '-A');
                const result = await gitManager.commit(root, {}, message);
                ack({ ok: true, output: result?.stdout || '' });
            }
            catch (err) {
                ack({ ok: false, error: errorMessage(err) });
            }
        });
        socket.on('git:push', async (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            const root = resolveRoot(payload?.projectId, ack);
            if (!root)
                return;
            try {
                const result = await gitManager.push(root, {
                    $timeoutMs: GIT_NET_TIMEOUT_MS,
                    $env: { ...NON_INTERACTIVE_ENV },
                });
                // git writes transfer progress to stderr even on success.
                ack({ ok: true, output: `${result?.stdout || ''}${result?.stderr || ''}`.trim() });
            }
            catch (err) {
                ack({ ok: false, error: errorMessage(err) });
            }
        });
        socket.on('git:pull', async (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            const root = resolveRoot(payload?.projectId, ack);
            if (!root)
                return;
            try {
                const result = await gitManager.pull(root, {
                    $timeoutMs: GIT_NET_TIMEOUT_MS,
                    $env: { ...NON_INTERACTIVE_ENV },
                });
                ack({ ok: true, output: `${result?.stdout || ''}${result?.stderr || ''}`.trim() });
            }
            catch (err) {
                ack({ ok: false, error: errorMessage(err) });
            }
        });
    });
}
