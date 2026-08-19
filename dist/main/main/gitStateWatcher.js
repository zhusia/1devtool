"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitStateWatcher = void 0;
const chokidar_1 = __importDefault(require("chokidar"));
const path_1 = __importDefault(require("path"));
const git_1 = require("./git");
/**
 * GitStateWatcher — watches the git common directory of each project for
 * external git mutations (commits, branch creation, fetch, rebase, worktree
 * add/remove from another tool, etc.) and notifies the renderer so it can
 * refresh worktree/graph state.
 *
 * Why a dedicated watcher (not the FileSystemManager project watcher):
 *   - FileSystemManager intentionally ignores `**\/.git/**` (we don't want git
 *     metadata churn polluting the file tree).
 *   - Different paths matter (refs, HEAD, index, packed-refs, worktrees).
 *
 * Watched paths inside common dir (the dir from `git rev-parse --git-common-dir`):
 *   - refs/heads/         (branch creation, deletion, HEAD moves)
 *   - refs/tags/          (tag creation/deletion)
 *   - refs/remotes/       (fetch, push results)
 *   - worktrees/          (worktree add/remove + per-worktree HEAD/index)
 *   - HEAD                (main worktree checkout, rebase, merge)
 *   - index               (main worktree staging changes — affects isDirty)
 *   - packed-refs         (git gc repacks loose refs)
 *
 * Lifecycle:
 *   - One watcher per repo. Ref-counted across renderer subscribers.
 *   - Started when the renderer subscribes via `git:watch-state`.
 *   - Stopped when the last subscriber unsubscribes via `git:unwatch-state`.
 *
 * Coalescing:
 *   - Multiple rapid filesystem events (e.g. rebase touches dozens of refs)
 *     debounce into a single `git:state-changed` notification per 500ms.
 */
class GitStateWatcher {
    gitManager;
    watchers = new Map();
    constructor(gitManager) {
        this.gitManager = gitManager;
    }
    async watch(repoPath, sender) {
        const key = (0, git_1.canonicalWorktreePath)(repoPath);
        const existing = this.watchers.get(key);
        if (existing) {
            existing.subscribers.add(sender);
            sender.once('destroyed', () => this.unwatch(repoPath, sender));
            return;
        }
        // Resolve the git common directory. For linked worktrees, .git is a file
        // pointing into the main repo's git dir; rev-parse normalizes that.
        let commonDir;
        try {
            const result = await this.gitManager.run(repoPath, 'rev-parse', { $nullOnError: true, $timeoutMs: 5_000 }, '--git-common-dir');
            const raw = result?.stdout.trim();
            if (!raw) {
                // Not a git repo — skip silently. Renderer can still call again later.
                return;
            }
            // rev-parse may return a relative path (e.g. ".git" if cwd is the repo).
            commonDir = path_1.default.isAbsolute(raw) ? raw : path_1.default.resolve(key, raw);
        }
        catch {
            return;
        }
        // Watch the directories and files that signal git state changes.
        const watchTargets = [
            path_1.default.join(commonDir, 'refs', 'heads'),
            path_1.default.join(commonDir, 'refs', 'tags'),
            path_1.default.join(commonDir, 'refs', 'remotes'),
            path_1.default.join(commonDir, 'worktrees'),
            path_1.default.join(commonDir, 'HEAD'),
            path_1.default.join(commonDir, 'index'),
            path_1.default.join(commonDir, 'packed-refs'),
        ];
        const watcher = chokidar_1.default.watch(watchTargets, {
            persistent: true,
            ignoreInitial: true,
            // Recursive watch on directories (refs/heads has subdirs for nested branches).
            // No depth limit — branches can nest arbitrarily deep (e.g. user/feat/sub).
            awaitWriteFinish: {
                stabilityThreshold: 200,
                pollInterval: 100,
            },
        });
        const entry = {
            watcher,
            subscribers: new Set([sender]),
            debounceTimer: null,
            commonDir,
        };
        this.watchers.set(key, entry);
        const fireDebouncedNotify = () => {
            if (entry.debounceTimer)
                clearTimeout(entry.debounceTimer);
            entry.debounceTimer = setTimeout(() => {
                entry.debounceTimer = null;
                for (const sub of entry.subscribers) {
                    if (!sub.isDestroyed()) {
                        sub.send('git:state-changed', { repoPath: key });
                    }
                }
            }, 500);
        };
        watcher.on('add', fireDebouncedNotify);
        watcher.on('change', fireDebouncedNotify);
        watcher.on('unlink', fireDebouncedNotify);
        watcher.on('addDir', fireDebouncedNotify);
        watcher.on('unlinkDir', fireDebouncedNotify);
        watcher.on('error', (err) => {
            console.warn(`[gitStateWatcher] error for ${key}:`, err);
        });
        sender.once('destroyed', () => this.unwatch(repoPath, sender));
    }
    unwatch(repoPath, sender) {
        const key = (0, git_1.canonicalWorktreePath)(repoPath);
        const entry = this.watchers.get(key);
        if (!entry)
            return;
        entry.subscribers.delete(sender);
        if (entry.subscribers.size === 0) {
            if (entry.debounceTimer) {
                clearTimeout(entry.debounceTimer);
                entry.debounceTimer = null;
            }
            void entry.watcher.close();
            this.watchers.delete(key);
        }
    }
    closeAll() {
        for (const entry of this.watchers.values()) {
            if (entry.debounceTimer)
                clearTimeout(entry.debounceTimer);
            void entry.watcher.close();
        }
        this.watchers.clear();
    }
}
exports.GitStateWatcher = GitStateWatcher;
