"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitManager = void 0;
exports.canonicalWorktreePath = canonicalWorktreePath;
exports.scanForSubRepositories = scanForSubRepositories;
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const promises_1 = require("fs/promises");
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
// Default timeouts (ms) for git operations that can be expensive on large repos.
const DEFAULT_WORKTREE_TIMEOUT_MS = 10_000;
const DEFAULT_GRAPH_TIMEOUT_MS = 10_000;
const DEFAULT_COMMIT_DETAIL_TIMEOUT_MS = 10_000;
const DEFAULT_DIRTY_POLL_TIMEOUT_MS = 5_000;
const SUMMARY_RECENT_COMMITS_LIMIT = 15;
const DEFAULT_HISTORY_PAGE_SIZE = 50;
const MAX_HISTORY_PAGE_SIZE = 200;
const DEFAULT_REORDER_TIMEOUT_MS = 30_000;
// Static sequence-editor script used by reorderCommit(). Git invokes it as
// `<editor> <todoFile>`; it swaps the two `pick` lines whose commit hashes match
// ONEDEVTOOL_REORDER_A / _B (env), leaving every other line untouched. Run via
// Electron-as-node (ELECTRON_RUN_AS_NODE=1) so it works in packaged builds where
// no standalone `node` is on PATH.
const REORDER_SEQUENCE_EDITOR_SOURCE = `const fs = require('fs')
const todo = process.argv[2]
if (!todo) process.exit(0)
const a = process.env.ONEDEVTOOL_REORDER_A || ''
const b = process.env.ONEDEVTOOL_REORDER_B || ''
const pickRe = /^(?:pick|p)\\s+([0-9a-fA-F]+)(?:\\s|$)/
const lines = fs.readFileSync(todo, 'utf8').split('\\n')
const findIdx = (full) => lines.findIndex((line) => {
  const m = line.match(pickRe)
  if (!m) return false
  const short = m[1]
  return full === short || full.startsWith(short) || short.startsWith(full)
})
const ia = findIdx(a)
const ib = findIdx(b)
if (ia !== -1 && ib !== -1 && ia !== ib) {
  const tmp = lines[ia]
  lines[ia] = lines[ib]
  lines[ib] = tmp
  fs.writeFileSync(todo, lines.join('\\n'))
}
`;
/**
 * Canonicalize a worktree path so equivalent inputs (`~/foo`, symlinks,
 * `./foo/../foo`, mixed case on macOS) collapse to a single stable key.
 *
 * Two-tier strategy:
 *   1. realpathSync — when the path exists, resolves symlinks and returns
 *      on-disk casing (handles macOS case-insensitive HFS+).
 *   2. path.resolve fallback — when the path does NOT exist (new worktree
 *      target, prunable entry with deleted dir), normalizes . and .. and
 *      makes absolute, but cannot resolve symlinks or correct casing.
 *
 * Tilde expansion is explicit because Node's path.resolve and execFile
 * (no shell) do not expand `~` themselves.
 */
function canonicalWorktreePath(rawPath) {
    let expanded = rawPath;
    if (expanded === '~') {
        expanded = os_1.default.homedir();
    }
    else if (expanded.startsWith('~/')) {
        expanded = path_1.default.join(os_1.default.homedir(), expanded.slice(2));
    }
    try {
        return (0, fs_1.realpathSync)(expanded);
    }
    catch {
        return path_1.default.resolve(expanded);
    }
}
// ── Multi-root project: sub-repository detection ─────────────────────────────
// Directory names never descended into during the sub-repo scan. Conservative
// on purpose: only dirs that (a) are huge and (b) essentially never contain a
// user's own working repos. Generated-output dirs (dist, build, …) are NOT
// skipped — vendored checkouts do get placed there occasionally.
const SUB_REPO_SCAN_SKIP_DIRS = new Set(['node_modules', 'bower_components', '.pnpm-store']);
const SUB_REPO_SCAN_MAX_DEPTH = 3;
const SUB_REPO_SCAN_MAX_DIRS = 2000;
const SUB_REPO_SCAN_MAX_REPOS = 50;
/**
 * Breadth-first scan below `rootPath` for nested git repositories — dirs
 * containing a `.git` entry. `.git` may be a directory (normal clone) or a
 * file (linked worktree / submodule); both count, because a "feature
 * workspace" folder holding worktrees of several upstreams is the primary
 * multi-root use-case.
 *
 * The scan does NOT descend into a found repo (each repo is a boundary, like
 * Zed's sub-repository detection), skips hidden dirs + package stores, and is
 * bounded by depth/dir/repo caps so a giant tree can't hang the main process.
 *
 * Returns absolute (non-canonicalized) paths of repo roots, excluding
 * `rootPath` itself. Pure fs walk — no git invocations.
 */
async function scanForSubRepositories(rootPath, limits = {}) {
    const maxDepth = limits.maxDepth ?? SUB_REPO_SCAN_MAX_DEPTH;
    const maxDirs = limits.maxDirs ?? SUB_REPO_SCAN_MAX_DIRS;
    const maxRepos = limits.maxRepos ?? SUB_REPO_SCAN_MAX_REPOS;
    const found = [];
    let scanned = 0;
    // Queue of [dir, depth]; rootPath itself is depth 0 and never reported.
    const queue = [[rootPath, 0]];
    while (queue.length > 0 && scanned < maxDirs && found.length < maxRepos) {
        const [dir, depth] = queue.shift();
        scanned++;
        let entries;
        try {
            entries = await (0, promises_1.readdir)(dir, { withFileTypes: true });
        }
        catch {
            continue; // unreadable dir (permissions, vanished) — skip silently
        }
        // Repo boundary check FIRST: a dir with a `.git` entry (dir for normal
        // clones, file for linked worktrees/submodules) is recorded and never
        // descended into — each repo owns its own subtree.
        const isRepo = dir !== rootPath && entries.some((e) => e.name === '.git');
        if (isRepo) {
            found.push(dir);
            continue;
        }
        if (depth + 1 > maxDepth)
            continue;
        for (const entry of entries) {
            const name = entry.name;
            // Symlinked dirs are not followed (isDirectory() is false for symlinks
            // from readdir withFileTypes), which also prevents cycles.
            if (!entry.isDirectory())
                continue;
            if (name.startsWith('.') || SUB_REPO_SCAN_SKIP_DIRS.has(name))
                continue;
            queue.push([path_1.default.join(dir, name), depth + 1]);
        }
    }
    return found;
}
// Parse the `Co-authored-by` trailers field returned by `git log --format` with
// `%(trailers:key=Co-authored-by,valueonly,separator=%x1e,unfold)`. Each value
// is in `Name <email>` form (the standard Co-authored-by format); if the regex
// doesn't match (e.g. malformed trailer), the whole value is treated as the
// name with an empty email so the avatar group still has something to render.
function parseCoAuthorTrailers(trailersStr) {
    if (!trailersStr)
        return [];
    return trailersStr
        .split('\x1e')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => {
        const match = value.match(/^(.*?)\s*<([^>]+)>\s*$/);
        if (match) {
            return { name: match[1].trim(), email: match[2].trim() };
        }
        return { name: value, email: '' };
    });
}
class GitManager {
    // Per-repo mutex: serializes all git calls for a given repo so concurrent
    // UI actions can't race (e.g. user creates worktree while refresh runs).
    repoLocks = new Map();
    async withRepoLock(repoPath, fn) {
        const key = canonicalWorktreePath(repoPath);
        const prev = this.repoLocks.get(key) ?? Promise.resolve();
        let release = () => { };
        const next = new Promise((resolve) => {
            release = resolve;
        });
        this.repoLocks.set(key, next);
        try {
            await prev;
            return await fn();
        }
        finally {
            release();
            // Only delete if no later task chained on top of `next`
            if (this.repoLocks.get(key) === next) {
                this.repoLocks.delete(key);
            }
        }
    }
    async run(repoPath, command, options = {}, ...args) {
        const commandArgs = [...this.buildConfigArgs(options.$config), command, ...this.buildArgs(options), ...args];
        const env = {
            ...process.env,
            ...(options.$gitDir ? { GIT_DIR: options.$gitDir } : {}),
            ...(options.$workTree ? { GIT_WORK_TREE: options.$workTree } : {}),
            ...(options.$indexFile ? { GIT_INDEX_FILE: options.$indexFile } : {}),
            ...(options.$env || {}),
        };
        const cwd = options.$workTree || repoPath;
        const timeoutMs = typeof options.$timeoutMs === 'number' ? options.$timeoutMs : undefined;
        try {
            if (options.$spawn) {
                return await this.runSpawn(commandArgs, cwd, env, Boolean(options.$shell), timeoutMs);
            }
            return await this.runExecFile(commandArgs, cwd, env, Boolean(options.$shell), timeoutMs);
        }
        catch (error) {
            if (options.$nullOnError) {
                return null;
            }
            if (error && typeof error === 'object') {
                const gitError = error;
                // execFile sets killed=true and signal='SIGTERM' on timeout
                if (gitError.killed && (gitError.signal === 'SIGTERM' || gitError.signal === 'SIGKILL')) {
                    throw new Error('Git operation timed out');
                }
                if ('stdout' in gitError || 'stderr' in gitError) {
                    throw new Error(gitError.stderr || gitError.stdout || gitError.message);
                }
            }
            throw error;
        }
    }
    /**
     * Move a commit one position toward HEAD ('up') or toward the root ('down')
     * by swapping it with its adjacent commit via a non-interactive rebase.
     *
     * Safety guarantees:
     *   - Refuses if a rebase is already in progress (won't clobber the user's).
     *   - Runs with --autostash so a dirty working tree is preserved.
     *   - ALWAYS aborts a half-finished rebase on any failure, so the repo is
     *     never left mid-rebase (the dialog has no conflict-resolution UI).
     */
    async reorderCommit(repoPath, hash, direction, options = {}) {
        // 1. Resolve the branch's linear history (newest-first). --first-parent keeps
        //    the mainline so merge-commit second parents don't confuse the ordering.
        const logRes = await this.run(repoPath, 'log', options, '--first-parent', '--format=%H', '-n', '500', 'HEAD');
        const hashes = (logRes?.stdout || '').trim().split('\n').filter(Boolean);
        const idx = hashes.findIndex((h) => h === hash || h.startsWith(hash) || hash.startsWith(h));
        if (idx === -1) {
            throw new Error('This commit is not part of the current branch history.');
        }
        // 'up' moves toward HEAD (swap with the newer neighbour); 'down' toward root.
        const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
        if (swapIdx < 0) {
            throw new Error('This commit is already the newest — it cannot move up.');
        }
        if (swapIdx >= hashes.length) {
            throw new Error('This commit cannot move down any further.');
        }
        const a = hashes[idx];
        const b = hashes[swapIdx];
        const olderHash = hashes[Math.max(idx, swapIdx)];
        // 2. Rebase base = parent of the older of the two commits, or --root when it
        //    is the very first commit in the repository.
        const parentRes = await this.run(repoPath, 'rev-parse', { ...options, $nullOnError: true }, '--verify', `${olderHash}^`);
        const base = parentRes?.stdout.trim() || null;
        // 3. Refuse to run over an existing rebase/merge-in-progress.
        const gitDirRes = await this.run(repoPath, 'rev-parse', options, '--absolute-git-dir');
        const gitDir = (gitDirRes?.stdout || '').trim();
        if (gitDir &&
            ((0, fs_1.existsSync)(path_1.default.join(gitDir, 'rebase-merge')) || (0, fs_1.existsSync)(path_1.default.join(gitDir, 'rebase-apply')))) {
            throw new Error('A rebase is already in progress in this repository. Finish or abort it first.');
        }
        // 4. Write the sequence editor and run the rebase with it.
        const editorScript = path_1.default.join(os_1.default.tmpdir(), '1devtool-git-reorder-editor.cjs');
        await (0, promises_1.writeFile)(editorScript, REORDER_SEQUENCE_EDITOR_SOURCE, 'utf8');
        const reorderEnv = {
            ...(options.$env || {}),
            GIT_SEQUENCE_EDITOR: `"${process.execPath}" "${editorScript}"`,
            // Any commit-message editor step (empty commit, etc.) must never block.
            GIT_EDITOR: 'true',
            ELECTRON_RUN_AS_NODE: '1',
            ONEDEVTOOL_REORDER_A: a,
            ONEDEVTOOL_REORDER_B: b,
        };
        const rebaseArgs = base ? ['-i', '--autostash', base] : ['-i', '--autostash', '--root'];
        try {
            const result = await this.run(repoPath, 'rebase', { ...options, $env: reorderEnv, $timeoutMs: DEFAULT_REORDER_TIMEOUT_MS }, ...rebaseArgs);
            if (!result) {
                throw new Error('Reorder failed to run.');
            }
            return result;
        }
        catch (error) {
            // Never leave the repo mid-rebase — best-effort abort, ignore its result.
            await this.run(repoPath, 'rebase', { ...options, $nullOnError: true }, '--abort');
            const message = error instanceof Error ? error.message : String(error);
            if (/could not apply|conflict|patch failed|merge/i.test(message)) {
                throw new Error('Reordering these commits caused a conflict, so no changes were made. Reorder them manually if you still need to.');
            }
            throw error instanceof Error ? error : new Error(message);
        }
    }
    runExecFile(args, cwd, env, shell, timeoutMs) {
        return new Promise((resolve, reject) => {
            (0, child_process_1.execFile)('git', args, {
                cwd,
                env,
                shell,
                maxBuffer: 10 * 1024 * 1024,
                ...(timeoutMs ? { timeout: timeoutMs } : {}),
            }, (error, stdout, stderr) => {
                if (error) {
                    reject(Object.assign(error, { stdout, stderr }));
                    return;
                }
                resolve({ stdout, stderr, exitCode: 0, args });
            });
        });
    }
    /**
     * Write account identity + SSH command to repo-local git config so that
     * terminal commands (`git push` typed in any shell) use the correct account.
     * GitClientDialog already injects these per-command via -c flags, but the
     * terminal has no knowledge of 1DevTool accounts — this bridges the gap.
     */
    async applyAccountConfig(repoPath, account) {
        if (!account) {
            // Clear 1DevTool-managed config — fall back to global/system git config
            await this.gitConfigUnset(repoPath, 'user.name');
            await this.gitConfigUnset(repoPath, 'user.email');
            await this.gitConfigUnset(repoPath, 'core.sshCommand');
            return;
        }
        // Set identity
        await this.gitConfigSetLocal(repoPath, 'user.name', account.authorName);
        await this.gitConfigSetLocal(repoPath, 'user.email', account.authorEmail);
        // Set SSH command so the correct key is used for SSH remotes
        const sshCmd = account.sshCommand?.trim()
            || (account.sshKeyPath?.trim()
                ? `ssh -i "${account.sshKeyPath.replace(/"/g, '\\"')}" -o IdentitiesOnly=yes`
                : null);
        if (sshCmd) {
            await this.gitConfigSetLocal(repoPath, 'core.sshCommand', sshCmd);
        }
        else {
            await this.gitConfigUnset(repoPath, 'core.sshCommand');
        }
    }
    async gitConfigSetLocal(repoPath, key, value) {
        try {
            await this.run(repoPath, 'config', { $nullOnError: true }, '--local', key, value);
        }
        catch {
            // Ignore — repo may not exist yet
        }
    }
    async gitConfigUnset(repoPath, key) {
        try {
            await this.run(repoPath, 'config', { $nullOnError: true }, '--local', '--unset', key);
        }
        catch {
            // Ignore — key may already be unset
        }
    }
    status(repoPath, options = {}) {
        return this.run(repoPath, 'status', options);
    }
    add(repoPath, options = {}, ...files) {
        return this.run(repoPath, 'add', options, ...files);
    }
    commit(repoPath, options = {}, message) {
        return this.run(repoPath, 'commit', options, '-m', message);
    }
    push(repoPath, options = {}) {
        return this.run(repoPath, 'push', options);
    }
    pull(repoPath, options = {}) {
        return this.run(repoPath, 'pull', options);
    }
    checkout(repoPath, options = {}, ref) {
        return this.run(repoPath, 'checkout', options, ref);
    }
    branch(repoPath, options = {}) {
        return this.run(repoPath, 'branch', options);
    }
    merge(repoPath, options = {}, ref) {
        return this.run(repoPath, 'merge', options, ref);
    }
    log(repoPath, options = {}) {
        return this.run(repoPath, 'log', options);
    }
    async getSummary(repoPath, options = {}) {
        const rootPath = await this.getRepositoryRoot(repoPath, options);
        if (!rootPath) {
            return null;
        }
        // Use --untracked-files=all to show individual files instead of just directories.
        // Status and the recent-commits log are independent reads — run both at once.
        const [statusResult, recentCommits] = await Promise.all([
            this.run(rootPath, 'status', { ...options, porcelain: 'v1', branch: true, untrackedFiles: 'all' }),
            this.readLogEntries(rootPath, SUMMARY_RECENT_COMMITS_LIMIT, undefined, 0, { ...options, $nullOnError: true }),
        ]);
        const parsedStatus = this.parseStatus(statusResult?.stdout || '');
        return {
            rootPath,
            branch: parsedStatus.branch,
            upstream: parsedStatus.upstream,
            ahead: parsedStatus.ahead,
            behind: parsedStatus.behind,
            stagedCount: parsedStatus.files.filter((file) => file.stagedStatus !== ' ' && file.stagedStatus !== '?').length,
            unstagedCount: parsedStatus.files.filter((file) => file.unstagedStatus !== ' ' && file.unstagedStatus !== '?').length,
            untrackedCount: parsedStatus.files.filter((file) => file.isUntracked).length,
            files: parsedStatus.files,
            lastCommit: recentCommits[0] || null,
            recentCommits,
        };
    }
    /**
     * Read a file's raw bytes at a specific ref (commit SHA, branch, "HEAD", etc.)
     * via `git show <ref>:<path>` with buffer encoding so binary content survives
     * the IPC hop. Returns base64 + byte size; null on missing file or git error
     * (file added in a later commit, path didn't exist at ref, etc.).
     *
     * Used by the git client dialog to preview images at a specific commit and
     * to render before/after pairs for image diffs.
     */
    async getFileBlobAtRef(repoPath, ref, filePath, options = {}) {
        const rootPath = await this.getRepositoryRoot(repoPath, options);
        if (!rootPath) {
            return null;
        }
        const commandArgs = [
            ...this.buildConfigArgs(options.$config),
            'show',
            `${ref}:${filePath}`,
        ];
        return new Promise((resolve) => {
            (0, child_process_1.execFile)('git', commandArgs, {
                cwd: rootPath,
                env: process.env,
                maxBuffer: 64 * 1024 * 1024,
                encoding: 'buffer',
            }, (error, stdout) => {
                if (error) {
                    resolve(null);
                    return;
                }
                const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
                resolve({ base64: buf.toString('base64'), size: buf.length });
            });
        });
    }
    async getDiff(repoPath, filePath, staged = false, options = {}) {
        const rootPath = await this.getRepositoryRoot(repoPath, options);
        if (!rootPath) {
            return '';
        }
        const args = [];
        if (staged) {
            args.push('--cached');
        }
        if (filePath) {
            args.push('--', filePath);
        }
        const result = await this.run(rootPath, 'diff', options, ...args);
        return result?.stdout || '';
    }
    async getBranches(repoPath, options = {}) {
        const rootPath = await this.getRepositoryRoot(repoPath, options);
        if (!rootPath) {
            return [];
        }
        const result = await this.run(rootPath, 'branch', {
            ...options,
            format: '%(refname:short)\t%(upstream:short)\t%(HEAD)',
        });
        return (result?.stdout || '')
            .split('\n')
            .filter(Boolean)
            .map((line) => {
            const [name, upstream, headMarker] = line.split('\t');
            return {
                name,
                upstream: upstream || null,
                isCurrent: headMarker === '*',
            };
        });
    }
    async getGlobalIdentity() {
        const cwd = os_1.default.homedir();
        const [authorNameResult, authorEmailResult, sshCommandResult] = await Promise.all([
            this.run(cwd, 'config', { $nullOnError: true }, '--global', '--get', 'user.name'),
            this.run(cwd, 'config', { $nullOnError: true }, '--global', '--get', 'user.email'),
            this.run(cwd, 'config', { $nullOnError: true }, '--global', '--get', 'core.sshCommand'),
        ]);
        return {
            authorName: authorNameResult?.stdout.trim() || null,
            authorEmail: authorEmailResult?.stdout.trim() || null,
            sshCommand: sshCommandResult?.stdout.trim() || null,
        };
    }
    async getPushPreview(repoPath, options = {}) {
        const summary = await this.getSummary(repoPath, options);
        if (!summary) {
            return { branch: null, upstream: null, commits: [], fileStat: '' };
        }
        if (!summary.upstream) {
            return {
                branch: summary.branch,
                upstream: null,
                commits: [],
                fileStat: '',
            };
        }
        const commits = await this.readLogEntries(summary.rootPath, 25, `${summary.upstream}..HEAD`, 0, options);
        const fileStat = await this.getDiffStat(summary.rootPath, `${summary.upstream}..HEAD`, options);
        return {
            branch: summary.branch,
            upstream: summary.upstream,
            commits,
            fileStat,
        };
    }
    async getPullPreview(repoPath, options = {}) {
        const summary = await this.getSummary(repoPath, options);
        if (!summary) {
            return { branch: null, upstream: null, commits: [], fileStat: '' };
        }
        if (!summary.upstream) {
            return {
                branch: summary.branch,
                upstream: null,
                commits: [],
                fileStat: '',
            };
        }
        await this.run(summary.rootPath, 'fetch', { ...options, all: true, prune: true });
        const refreshedSummary = await this.getSummary(summary.rootPath, options);
        const upstream = refreshedSummary?.upstream || summary.upstream;
        const commits = await this.readLogEntries(summary.rootPath, 25, `HEAD..${upstream}`, 0, options);
        const fileStat = await this.getDiffStat(summary.rootPath, `HEAD..${upstream}`, options);
        return {
            branch: refreshedSummary?.branch || summary.branch,
            upstream,
            commits,
            fileStat,
        };
    }
    async getRepositoryRoot(repoPath, options = {}) {
        const result = await this.run(repoPath, 'rev-parse', { ...options, $nullOnError: true }, '--show-toplevel');
        return result?.stdout.trim() || null;
    }
    async getLogEntries(repoPath, maxCount = DEFAULT_HISTORY_PAGE_SIZE, skip = 0, options = {}) {
        const rootPath = await this.getRepositoryRoot(repoPath, options);
        if (!rootPath) {
            return [];
        }
        const safeMaxCount = Math.max(1, Math.min(MAX_HISTORY_PAGE_SIZE, Math.floor(maxCount) || DEFAULT_HISTORY_PAGE_SIZE));
        const safeSkip = Math.max(0, Math.floor(skip) || 0);
        return this.readLogEntries(rootPath, safeMaxCount, undefined, safeSkip, { ...options, $nullOnError: true });
    }
    async readLogEntries(repoPath, limit, range, skip = 0, options = {}) {
        const args = range ? [range] : [];
        const skipArgs = skip > 0 ? ['--skip', String(skip)] : [];
        // Use `-z` so commits are NUL-separated and trailer values that span
        // multiple lines (or just contain newlines from the message body) can't
        // break the per-record parser. Inside each record we use:
        //   \x1f (unit separator)   between fields
        //   \x1e (record separator) between Co-authored-by trailer values
        // Both are control bytes that essentially never appear in real git data,
        // so the parser doesn't need quoting/escaping.
        const result = await this.run(repoPath, 'log', {
            ...options,
            format: '%H%x1f%h%x1f%an%x1f%ae%x1f%ar%x1f%s%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1e,unfold)',
            maxCount: limit,
        }, '-z', ...skipArgs, ...args);
        return this.parseLogEntries(result?.stdout || '');
    }
    async getDiffStat(repoPath, range, options = {}) {
        const result = await this.run(repoPath, 'diff', { ...options, stat: true }, range);
        return result?.stdout.trim() || '';
    }
    parseStatus(output) {
        const lines = output.split('\n').filter(Boolean);
        let branch = null;
        let upstream = null;
        let ahead = 0;
        let behind = 0;
        const files = [];
        for (const line of lines) {
            if (line.startsWith('## ')) {
                const info = line.slice(3).trim();
                const noCommitsMatch = info.match(/^(?:No commits yet on|Initial commit on)\s+(.+)$/);
                if (noCommitsMatch) {
                    branch = noCommitsMatch[1]?.trim() || null;
                    upstream = null;
                    ahead = 0;
                    behind = 0;
                    continue;
                }
                const [branchPart, trackingPart] = info.split('...');
                branch = branchPart?.trim() || null;
                if (trackingPart) {
                    const trackingMatch = trackingPart.match(/^([^\s]+)(?: \[(.+)\])?$/);
                    if (trackingMatch) {
                        upstream = trackingMatch[1] || null;
                        const state = trackingMatch[2] || '';
                        for (const chunk of state.split(',').map((item) => item.trim())) {
                            if (chunk.startsWith('ahead ')) {
                                ahead = parseInt(chunk.replace('ahead ', ''), 10) || 0;
                            }
                            if (chunk.startsWith('behind ')) {
                                behind = parseInt(chunk.replace('behind ', ''), 10) || 0;
                            }
                        }
                    }
                }
                continue;
            }
            const stagedStatus = line[0];
            const unstagedStatus = line[1];
            const rawPath = line.slice(3);
            const normalizedPath = this.normalizeStatusPath(rawPath);
            files.push({
                path: normalizedPath,
                stagedStatus,
                unstagedStatus,
                isUntracked: stagedStatus === '?' && unstagedStatus === '?',
                isConflicted: [stagedStatus, unstagedStatus].some((status) => status === 'U') || ['AA', 'DD'].includes(line.slice(0, 2)),
            });
        }
        return { branch, upstream, ahead, behind, files };
    }
    parseLogEntries(output) {
        return output
            .split('\0')
            .filter(Boolean)
            .map((record) => {
            const [hash, shortHash, author, email, relativeDate, subject, trailersStr] = record.split('\x1f');
            return {
                hash,
                shortHash,
                author,
                email,
                relativeDate,
                subject,
                coAuthors: parseCoAuthorTrailers(trailersStr || ''),
            };
        });
    }
    normalizeStatusPath(filePath) {
        const renamedPath = filePath.includes(' -> ')
            ? filePath.split(' -> ').pop() || filePath
            : filePath;
        if (renamedPath.startsWith('"') && renamedPath.endsWith('"')) {
            return renamedPath.slice(1, -1).replace(/\\"/g, '"');
        }
        return renamedPath;
    }
    buildArgs(options) {
        const args = [];
        for (const [key, value] of Object.entries(options)) {
            if (key.startsWith('$') || value === undefined || value === false) {
                continue;
            }
            const flag = this.toFlag(key);
            if (Array.isArray(value)) {
                for (const item of value) {
                    this.appendFlag(args, flag, item);
                }
                continue;
            }
            if (typeof value === 'object' && value !== null) {
                continue;
            }
            this.appendFlag(args, flag, value);
        }
        return args;
    }
    buildConfigArgs(config) {
        if (!config) {
            return [];
        }
        const args = [];
        for (const [key, value] of Object.entries(config)) {
            if (value === undefined) {
                continue;
            }
            args.push('-c', `${key}=${String(value)}`);
        }
        return args;
    }
    appendFlag(args, flag, value) {
        if (value === undefined || value === false) {
            return;
        }
        if (value === true || value === null) {
            args.push(flag);
            return;
        }
        if (flag.startsWith('--')) {
            args.push(`${flag}=${String(value)}`);
            return;
        }
        args.push(flag, String(value));
    }
    toFlag(key) {
        if (key.length === 1) {
            return `-${key}`;
        }
        return `--${key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}`;
    }
    runSpawn(args, cwd, env, shell, timeoutMs) {
        return new Promise((resolve, reject) => {
            const child = (0, child_process_1.spawn)('git', args, {
                cwd,
                env,
                shell,
            });
            let stdout = '';
            let stderr = '';
            let timedOut = false;
            let timer = null;
            if (timeoutMs && timeoutMs > 0) {
                timer = setTimeout(() => {
                    timedOut = true;
                    child.kill('SIGTERM');
                    // Hard kill if still alive after 2s
                    setTimeout(() => {
                        if (!child.killed) {
                            try {
                                child.kill('SIGKILL');
                            }
                            catch {
                                /* ignore */
                            }
                        }
                    }, 2000);
                }, timeoutMs);
            }
            child.stdout.on('data', (chunk) => {
                stdout += chunk.toString();
            });
            child.stderr.on('data', (chunk) => {
                stderr += chunk.toString();
            });
            child.on('error', (err) => {
                if (timer)
                    clearTimeout(timer);
                reject(err);
            });
            child.on('close', (exitCode) => {
                if (timer)
                    clearTimeout(timer);
                if (timedOut) {
                    reject(new Error('Git operation timed out'));
                    return;
                }
                if (exitCode === 0) {
                    resolve({ stdout, stderr, exitCode: 0, args });
                    return;
                }
                reject(new Error(stderr || stdout || `git exited with code ${exitCode}`));
            });
        });
    }
    // ── Multi-root projects ─────────────────────────────────────────────────────
    /**
     * List every git repository a project folder participates in:
     *   - the "primary" repo — the repo whose working tree contains `rootPath`
     *     (resolved upward via rev-parse, so a project rooted in a subdir of a
     *     repo still reports it), when one exists;
     *   - every independent repo nested below `rootPath` (fs scan, see
     *     scanForSubRepositories).
     *
     * Primary first, then nested repos sorted by relative path. Paths are
     * canonicalized so they can be compared with worktree paths and used as
     * stable identity keys in the renderer.
     */
    async listSubRepositories(rootPath) {
        const canonicalRoot = canonicalWorktreePath(rootPath);
        const [primaryRoot, nestedRaw] = await Promise.all([
            this.getRepositoryRoot(canonicalRoot, { $nullOnError: true }),
            scanForSubRepositories(canonicalRoot),
        ]);
        const repos = [];
        const seen = new Set();
        if (primaryRoot) {
            const canonical = canonicalWorktreePath(primaryRoot);
            seen.add(canonical);
            repos.push({
                path: canonical,
                relativePath: '.',
                name: path_1.default.basename(canonical),
                isProjectRoot: true,
            });
        }
        const nested = nestedRaw
            .map((repoPath) => canonicalWorktreePath(repoPath))
            .filter((canonical) => {
            if (seen.has(canonical))
                return false;
            seen.add(canonical);
            return true;
        })
            .map((canonical) => ({
            path: canonical,
            relativePath: path_1.default.relative(canonicalRoot, canonical) || '.',
            name: path_1.default.basename(canonical),
            isProjectRoot: false,
        }))
            .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
        repos.push(...nested);
        return repos;
    }
    /**
     * Status-only git status across a workspace root + its nested repos, for
     * FileTree change badges. Deliberately cheap compared to N getSummary calls:
     * no recent-commit log, and repos are processed through a small worker pool
     * so a 50-repo workspace doesn't fork 50 git processes at once.
     *
     * Returns the canonical (realpath'd) workspace root so the renderer can
     * relativize file paths without tripping over /var vs /private/var or
     * symlinked project roots.
     */
    async getMultiStatus(rootPath, repoPaths) {
        const canonicalRoot = canonicalWorktreePath(rootPath);
        const targets = [...new Set([canonicalRoot, ...repoPaths.map((p) => canonicalWorktreePath(p))])];
        const CONCURRENCY = 4;
        const results = new Array(targets.length).fill(null);
        let nextIndex = 0;
        const workers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
            while (nextIndex < targets.length) {
                const i = nextIndex++;
                results[i] = await this.readStatusFiles(targets[i]);
            }
        });
        await Promise.all(workers);
        // Dedupe by resolved repo root — the workspace root resolves upward, so it
        // can collide with a listed repo (or two listed paths can share a repo).
        const byRoot = new Map();
        for (const result of results) {
            if (result && !byRoot.has(result.repoRoot)) {
                byRoot.set(result.repoRoot, result.files);
            }
        }
        return {
            canonicalRoot,
            repos: [...byRoot.entries()].map(([repoRoot, files]) => ({ repoRoot, files })),
        };
    }
    // Single-repo leg of getMultiStatus: resolve the repo root, run one
    // porcelain status. Null for non-repos / transient git failures.
    async readStatusFiles(repoPath) {
        const rootPath = await this.getRepositoryRoot(repoPath, { $timeoutMs: DEFAULT_DIRTY_POLL_TIMEOUT_MS });
        if (!rootPath)
            return null;
        const statusResult = await this.run(rootPath, 'status', {
            porcelain: 'v1',
            untrackedFiles: 'all',
            $nullOnError: true,
            $timeoutMs: DEFAULT_DIRTY_POLL_TIMEOUT_MS,
        });
        if (!statusResult)
            return null;
        return { repoRoot: canonicalWorktreePath(rootPath), files: this.parseStatus(statusResult.stdout).files };
    }
    // ── Worktree operations ───────────────────────────────────────────────────
    /**
     * List all worktrees attached to the repo at `repoPath`.
     *
     * Parses `git worktree list --porcelain`. For each non-prunable, non-bare
     * worktree, also runs `git status --porcelain` and an upstream rev-list to
     * compute `isDirty`, `ahead`, `behind`, and `upstreamStatus`.
     */
    async listWorktrees(repoPath, options = {}) {
        return this.withRepoLock(repoPath, async () => {
            const result = await this.run(repoPath, 'worktree', { ...options, $timeoutMs: options.$timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS, $nullOnError: true }, 'list', '--porcelain');
            if (!result) {
                return [];
            }
            const parsed = this.parseWorktreePorcelain(result.stdout);
            // Enrich each worktree with dirty status + upstream counts.
            const enriched = [];
            for (const wt of parsed) {
                const enrichedEntry = await this.enrichWorktree(repoPath, wt, options);
                enriched.push(enrichedEntry);
            }
            return enriched;
        });
    }
    /**
     * Parse `git worktree list --porcelain` output into raw entries (no
     * dirty/upstream enrichment yet — that happens in enrichWorktree).
     */
    parseWorktreePorcelain(stdout) {
        const entries = [];
        const blocks = stdout.split('\n\n');
        let isFirst = true;
        for (const block of blocks) {
            const lines = block.split('\n').filter(Boolean);
            if (lines.length === 0)
                continue;
            let path = null;
            let head = '';
            let branchRef = null;
            let bare = false;
            let detached = false;
            let locked = false;
            let lockReason = null;
            let prunable = false;
            let prunableReason = null;
            for (const line of lines) {
                if (line.startsWith('worktree ')) {
                    path = line.slice('worktree '.length);
                }
                else if (line.startsWith('HEAD ')) {
                    head = line.slice('HEAD '.length);
                }
                else if (line.startsWith('branch ')) {
                    branchRef = line.slice('branch '.length);
                }
                else if (line === 'bare') {
                    bare = true;
                }
                else if (line === 'detached') {
                    detached = true;
                }
                else if (line === 'locked' || line.startsWith('locked ')) {
                    locked = true;
                    lockReason = line === 'locked' ? null : line.slice('locked '.length);
                }
                else if (line === 'prunable' || line.startsWith('prunable ')) {
                    prunable = true;
                    prunableReason = line === 'prunable' ? null : line.slice('prunable '.length);
                }
            }
            if (!path)
                continue;
            // Strip refs/heads/ prefix from branch ref
            const branch = branchRef && branchRef.startsWith('refs/heads/')
                ? branchRef.slice('refs/heads/'.length)
                : detached
                    ? null
                    : branchRef;
            entries.push({
                path: canonicalWorktreePath(path),
                branch,
                head,
                isMain: isFirst,
                isBare: bare,
                isLocked: locked,
                lockReason,
                isDirty: false,
                ahead: 0,
                behind: 0,
                hasUpstream: false,
                upstreamStatus: 'none',
                prunable,
                prunableReason,
            });
            isFirst = false;
        }
        return entries;
    }
    /**
     * Compute isDirty + ahead/behind + upstreamStatus for a single worktree.
     * Skips checks for bare or prunable worktrees (no working tree to query).
     */
    async enrichWorktree(repoPath, wt, options) {
        if (wt.isBare || wt.prunable) {
            return wt;
        }
        let isDirty = false;
        try {
            const statusResult = await this.runExecFile(['-C', wt.path, 'status', '--porcelain'], wt.path, process.env, false, options.$timeoutMs ?? DEFAULT_DIRTY_POLL_TIMEOUT_MS);
            isDirty = statusResult.stdout.trim().length > 0;
        }
        catch {
            // If git -C status fails (e.g. transient I/O), leave isDirty false.
            isDirty = false;
        }
        let ahead = 0;
        let behind = 0;
        let hasUpstream = false;
        let upstreamStatus = 'none';
        if (wt.branch) {
            // Check upstream config: both branch.<x>.remote and branch.<x>.merge
            // must exist for the branch to track an upstream.
            const remoteResult = await this.run(repoPath, 'config', { $nullOnError: true, $timeoutMs: options.$timeoutMs ?? DEFAULT_DIRTY_POLL_TIMEOUT_MS }, '--get', `branch.${wt.branch}.remote`);
            const mergeResult = await this.run(repoPath, 'config', { $nullOnError: true, $timeoutMs: options.$timeoutMs ?? DEFAULT_DIRTY_POLL_TIMEOUT_MS }, '--get', `branch.${wt.branch}.merge`);
            if (remoteResult && mergeResult) {
                // Upstream is configured — try to get counts.
                try {
                    const revListResult = await this.runExecFile(['-C', wt.path, 'rev-list', '--left-right', '--count', `${wt.branch}...${wt.branch}@{upstream}`], wt.path, process.env, false, options.$timeoutMs ?? DEFAULT_DIRTY_POLL_TIMEOUT_MS);
                    const parts = revListResult.stdout.trim().split(/\s+/);
                    if (parts.length >= 2) {
                        ahead = parseInt(parts[0], 10) || 0;
                        behind = parseInt(parts[1], 10) || 0;
                        hasUpstream = true;
                        upstreamStatus = 'ok';
                    }
                    else {
                        hasUpstream = true;
                        upstreamStatus = 'stale';
                    }
                }
                catch (err) {
                    console.warn(`[git] rev-list failed for ${wt.branch} in ${wt.path}:`, err instanceof Error ? err.message : err);
                    hasUpstream = true;
                    upstreamStatus = 'stale';
                }
            }
        }
        return { ...wt, isDirty, ahead, behind, hasUpstream, upstreamStatus };
    }
    /**
     * Add a new worktree at `worktreePath`.
     *
     * Path handling order:
     *   1. Expand ~ + canonicalize (resolve fallback since target may not exist).
     *   2. Run git with the EXPANDED absolute path (never pass ~ to execFile).
     *   3. After git creates the directory, list worktrees again so the result
     *      uses realpathSync — symlinks and on-disk casing are now resolved.
     */
    async addWorktree(repoPath, worktreePath, addOptions = {}, options = {}) {
        return this.withRepoLock(repoPath, async () => {
            const expandedPath = canonicalWorktreePath(worktreePath);
            const args = ['add'];
            if (addOptions.force) {
                args.push('--force');
            }
            if (addOptions.track) {
                args.push('--track');
            }
            if (addOptions.newBranch) {
                // Create new branch (optionally tracking) at `expandedPath`
                args.push('-b', addOptions.newBranch, expandedPath);
                if (addOptions.startPoint) {
                    args.push(addOptions.startPoint);
                }
            }
            else if (addOptions.branch) {
                // Check out an existing branch
                args.push(expandedPath, addOptions.branch);
            }
            else {
                // Bare add: git auto-creates a branch named after the directory
                args.push(expandedPath);
            }
            await this.run(repoPath, 'worktree', { ...options, $timeoutMs: options.$timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS }, ...args);
            // Re-list and find the new worktree by canonical path. After git
            // creates the directory, realpathSync can resolve symlinks/casing.
            // CRITICAL: use the no-lock variant — we already hold the per-repo
            // mutex from withRepoLock above. Calling listWorktrees() here would
            // try to re-acquire the same lock and deadlock forever (manifests in
            // the renderer as "reply was never sent").
            const canonical = canonicalWorktreePath(expandedPath);
            const worktrees = await this.listWorktreesNoLock(repoPath, options);
            const created = worktrees.find((wt) => wt.path === canonical);
            if (!created) {
                throw new Error(`Worktree was created but not found in list: ${canonical}`);
            }
            // Copy gitignored env files from source repo into the new worktree.
            // Restrict to plain basenames so a malicious caller can't traverse out
            // of the repo or write into git-tracked subpaths.
            if (addOptions.copyEnvFiles && addOptions.copyEnvFiles.length > 0) {
                for (const name of addOptions.copyEnvFiles) {
                    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
                        continue;
                    }
                    const src = path_1.default.join(repoPath, name);
                    const dest = path_1.default.join(canonical, name);
                    try {
                        // COPYFILE_EXCL: don't overwrite if git already produced a tracked file with the same name.
                        await (0, promises_1.copyFile)(src, dest, promises_1.constants.COPYFILE_EXCL);
                    }
                    catch (err) {
                        // Source missing or destination exists — non-fatal, the worktree was created.
                        console.warn(`[git.addWorktree] copyEnvFiles skipped ${name}:`, err);
                    }
                }
            }
            return created;
        });
    }
    async removeWorktree(repoPath, worktreePath, force = false, options = {}) {
        return this.withRepoLock(repoPath, async () => {
            const expandedPath = canonicalWorktreePath(worktreePath);
            const args = ['remove'];
            if (force) {
                args.push('--force');
            }
            args.push(expandedPath);
            await this.run(repoPath, 'worktree', { ...options, $timeoutMs: options.$timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS }, ...args);
        });
    }
    async pruneWorktrees(repoPath, options = {}) {
        return this.withRepoLock(repoPath, async () => {
            await this.run(repoPath, 'worktree', { ...options, $timeoutMs: options.$timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS }, 'prune');
        });
    }
    async lockWorktree(repoPath, worktreePath, reason, options = {}) {
        return this.withRepoLock(repoPath, async () => {
            const expandedPath = canonicalWorktreePath(worktreePath);
            const args = ['lock', expandedPath];
            if (reason) {
                args.push('--reason', reason);
            }
            await this.run(repoPath, 'worktree', { ...options, $timeoutMs: options.$timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS }, ...args);
        });
    }
    async unlockWorktree(repoPath, worktreePath, options = {}) {
        return this.withRepoLock(repoPath, async () => {
            const expandedPath = canonicalWorktreePath(worktreePath);
            await this.run(repoPath, 'worktree', { ...options, $timeoutMs: options.$timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS }, 'unlock', expandedPath);
        });
    }
    // ── Graph + commit detail ─────────────────────────────────────────────────
    /**
     * Fetch a page of commits across all refs in topo order. Returns raw commit
     * data only — lane allocation happens in the renderer so it can re-layout
     * on resize/filter without re-running git.
     *
     * Uses NUL-delimited fields rather than --graph ASCII (which is brittle to
     * parse and meant for humans). Parent hashes (%P) provide the DAG.
     */
    async getGraphLog(repoPath, maxCount = 200, skip = 0, options = {}) {
        return this.withRepoLock(repoPath, async () => {
            const result = await this.run(repoPath, 'log', {
                ...options,
                $timeoutMs: options.$timeoutMs ?? DEFAULT_GRAPH_TIMEOUT_MS,
                $nullOnError: true,
            }, '--all', `--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%P%x00%D`, '--topo-order', '-n', String(maxCount), '--skip', String(skip));
            if (!result) {
                return [];
            }
            const commits = this.parseGraphLog(result.stdout);
            // Annotate commits with worktree paths whose HEAD points at them.
            // listWorktrees runs under its own withRepoLock — to avoid deadlock,
            // call the underlying logic without nesting another lock.
            const worktrees = await this.listWorktreesNoLock(repoPath, options);
            const headByCommit = new Map();
            for (const wt of worktrees) {
                if (!wt.head)
                    continue;
                const list = headByCommit.get(wt.head) ?? [];
                list.push(wt.path);
                headByCommit.set(wt.head, list);
            }
            for (const commit of commits) {
                commit.worktreePaths = headByCommit.get(commit.hash) ?? [];
                // Tag refs that match a worktree path
                for (const ref of commit.refs) {
                    for (const wt of worktrees) {
                        if (wt.branch && (ref.name === wt.branch || ref.name === `refs/heads/${wt.branch}`)) {
                            ref.worktreePath = wt.path;
                            break;
                        }
                    }
                }
            }
            return commits;
        });
    }
    // Internal: list worktrees without acquiring the per-repo lock.
    // Used by getGraphLog (which already holds the lock) to avoid deadlock.
    async listWorktreesNoLock(repoPath, options) {
        const result = await this.run(repoPath, 'worktree', { ...options, $timeoutMs: options.$timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS, $nullOnError: true }, 'list', '--porcelain');
        if (!result)
            return [];
        const parsed = this.parseWorktreePorcelain(result.stdout);
        const enriched = [];
        for (const wt of parsed) {
            enriched.push(await this.enrichWorktree(repoPath, wt, options));
        }
        return enriched;
    }
    parseGraphLog(stdout) {
        const commits = [];
        for (const line of stdout.split('\n')) {
            if (!line)
                continue;
            const parts = line.split('\x00');
            if (parts.length < 8)
                continue;
            const [hash, shortHash, author, email, dateStr, subject, parentStr, refStr] = parts;
            const parentHashes = parentStr ? parentStr.split(' ').filter(Boolean) : [];
            const refs = this.parseRefDecoration(refStr);
            commits.push({
                hash,
                shortHash,
                author,
                email,
                date: parseInt(dateStr, 10) || 0,
                subject,
                parentHashes,
                refs,
                worktreePaths: [],
            });
        }
        return commits;
    }
    parseRefDecoration(decoration) {
        if (!decoration)
            return [];
        const refs = [];
        // Decoration looks like: "HEAD -> main, origin/main, tag: v1.0.0"
        for (const raw of decoration.split(',')) {
            const trimmed = raw.trim();
            if (!trimmed)
                continue;
            // "HEAD -> main"
            if (trimmed.startsWith('HEAD -> ')) {
                const name = trimmed.slice('HEAD -> '.length);
                refs.push({ name, type: 'local', isHead: true });
                continue;
            }
            if (trimmed === 'HEAD') {
                refs.push({ name: 'HEAD', type: 'head', isHead: true });
                continue;
            }
            if (trimmed.startsWith('tag: ')) {
                refs.push({ name: trimmed.slice('tag: '.length), type: 'tag', isHead: false });
                continue;
            }
            if (trimmed.includes('/')) {
                // Heuristic: refs with a slash are remote-tracking
                refs.push({ name: trimmed, type: 'remote', isHead: false });
                continue;
            }
            refs.push({ name: trimmed, type: 'local', isHead: false });
        }
        return refs;
    }
    /**
     * Fetch the file list + diff for a single commit. Handles merge commits
     * specially: file stats are aggregated across parents (-m), and the diff
     * uses --cc (combined merge diff).
     */
    async getCommitDetail(repoPath, hash, options = {}) {
        return this.withRepoLock(repoPath, async () => {
            // Determine parent count (and the parent hashes themselves) so we can
            // pick the right command shape for merges vs non-merges.
            const parentResult = await this.run(repoPath, 'rev-list', { ...options, $timeoutMs: options.$timeoutMs ?? DEFAULT_COMMIT_DETAIL_TIMEOUT_MS }, '--parents', '-n', '1', hash);
            const parentParts = (parentResult?.stdout || '').trim().split(/\s+/);
            const parentHashes = parentParts.slice(1);
            const isMerge = parentHashes.length >= 2;
            // numstat (file stats)
            const numstatArgs = ['--format=', '--numstat'];
            if (isMerge)
                numstatArgs.push('-m');
            numstatArgs.push(hash);
            const numstatResult = await this.run(repoPath, 'show', { ...options, $timeoutMs: options.$timeoutMs ?? DEFAULT_COMMIT_DETAIL_TIMEOUT_MS }, ...numstatArgs);
            // name-status (M/A/D/R/T flags)
            const nameStatusArgs = ['--format=', '--name-status'];
            if (isMerge)
                nameStatusArgs.push('-m');
            nameStatusArgs.push(hash);
            const nameStatusResult = await this.run(repoPath, 'show', { ...options, $timeoutMs: options.$timeoutMs ?? DEFAULT_COMMIT_DETAIL_TIMEOUT_MS }, ...nameStatusArgs);
            // Diff text
            const diffArgs = ['--format='];
            if (isMerge)
                diffArgs.push('--cc');
            diffArgs.push(hash);
            const diffResult = await this.run(repoPath, 'show', { ...options, $timeoutMs: options.$timeoutMs ?? DEFAULT_COMMIT_DETAIL_TIMEOUT_MS }, ...diffArgs);
            const files = this.mergeNumstatAndStatus(numstatResult?.stdout || '', nameStatusResult?.stdout || '');
            return {
                hash,
                parentHashes,
                isMerge,
                files,
                diff: diffResult?.stdout || '',
            };
        });
    }
    /**
     * Merge `git show --numstat` and `git show --name-status` output into a
     * single per-file record. Aggregates duplicate paths (merge commits emit
     * one row per parent with -m).
     */
    mergeNumstatAndStatus(numstat, nameStatus) {
        // status precedence for collapsing duplicate path rows on merges
        const STATUS_PRECEDENCE = {
            D: 9, R: 8, M: 7, A: 6, T: 5, C: 4, U: 3, X: 2, B: 1,
        };
        // Parse numstat: "<additions>\t<deletions>\t<path>"
        const stats = new Map();
        for (const line of numstat.split('\n')) {
            if (!line.trim())
                continue;
            const parts = line.split('\t');
            if (parts.length < 3)
                continue;
            const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
            const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
            const path = parts.slice(2).join('\t');
            const existing = stats.get(path);
            if (existing) {
                existing.additions += additions;
                existing.deletions += deletions;
            }
            else {
                stats.set(path, { additions, deletions });
            }
        }
        // Parse name-status: "<status>\t<path>" or "R100\told\tnew" for renames
        const statuses = new Map();
        for (const line of nameStatus.split('\n')) {
            if (!line.trim())
                continue;
            const parts = line.split('\t');
            if (parts.length < 2)
                continue;
            let rawStatus = parts[0];
            // Normalize R100 → R, C75 → C
            const status = rawStatus.charAt(0);
            // For renames/copies, the new path is the last column
            const path = parts[parts.length - 1];
            const existing = statuses.get(path);
            if (!existing || (STATUS_PRECEDENCE[status] ?? 0) > (STATUS_PRECEDENCE[existing] ?? 0)) {
                statuses.set(path, status);
            }
        }
        // Combine
        const result = [];
        const allPaths = new Set([...stats.keys(), ...statuses.keys()]);
        for (const path of allPaths) {
            const stat = stats.get(path) ?? { additions: 0, deletions: 0 };
            const status = statuses.get(path) ?? 'M';
            result.push({ path, status, additions: stat.additions, deletions: stat.deletions });
        }
        return result;
    }
}
exports.GitManager = GitManager;
