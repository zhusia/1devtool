"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerGitIpcHandlers = registerGitIpcHandlers;
const electron_1 = require("electron");
const gitCommitMessage_1 = require("../gitCommitMessage");
const gitHost_1 = require("../gitHost");
function registerGitIpcHandlers({ gitManager, gitStateWatcher, templateManager, sendToRenderer, getCliRegistry, }) {
    // Git handlers
    electron_1.ipcMain.handle('git:run', async (_, args) => {
        const { repoPath, command, options, args: gitArgs = [] } = args;
        return gitManager.run(repoPath, command, options, ...gitArgs);
    });
    electron_1.ipcMain.handle('git:reorder-commit', async (_, args) => {
        const { repoPath, hash, direction, options } = args;
        return gitManager.reorderCommit(repoPath, hash, direction, options);
    });
    electron_1.ipcMain.handle('git:get-summary', async (_, args) => {
        const { repoPath, options } = args;
        return gitManager.getSummary(repoPath, options);
    });
    electron_1.ipcMain.handle('git:get-log-entries', async (_, args) => {
        const { repoPath, maxCount, skip, options } = args;
        return gitManager.getLogEntries(repoPath, maxCount, skip, options);
    });
    electron_1.ipcMain.handle('git:get-diff', async (_, args) => {
        const { repoPath, filePath, staged, options } = args;
        return gitManager.getDiff(repoPath, filePath, staged, options);
    });
    electron_1.ipcMain.handle('git:get-file-blob', async (_, args) => {
        const { repoPath, ref, filePath, options } = args;
        return gitManager.getFileBlobAtRef(repoPath, ref, filePath, options);
    });
    electron_1.ipcMain.handle('git:get-branches', async (_, args) => {
        const { repoPath, options } = args;
        return gitManager.getBranches(repoPath, options);
    });
    electron_1.ipcMain.handle('git:get-global-identity', async () => {
        return gitManager.getGlobalIdentity();
    });
    electron_1.ipcMain.handle('git:apply-account-config', async (_, args) => {
        const { repoPath, account } = args;
        return gitManager.applyAccountConfig(repoPath, account);
    });
    electron_1.ipcMain.handle('git:get-push-preview', async (_, args) => {
        const { repoPath, options } = args;
        return gitManager.getPushPreview(repoPath, options);
    });
    electron_1.ipcMain.handle('git:get-pull-preview', async (_, args) => {
        const { repoPath, options } = args;
        return gitManager.getPullPreview(repoPath, options);
    });
    // Draft a Conventional Commits message from the staged diff (working-tree
    // diff when nothing is staged) via an installed headless AI CLI. Returns a
    // structured { ok } result — errors never surface as thrown IPC failures.
    electron_1.ipcMain.handle('git:generate-commit-message', async (_, args) => {
        const { repoPath, settings, avoidSummaries, gitOptions } = args;
        return (0, gitCommitMessage_1.generateCommitMessage)({ gitManager, getCliRegistry }, { repoPath, settings, avoidSummaries, gitOptions });
    });
    // ── GitHub API handlers ──────────────────────────────────────────────────
    // Create a new repository on GitHub via the REST API on behalf of the user.
    // Used by the Publish Repository flow when the active git account has a PAT
    // attached. Falls back to a friendly error if the token is missing or
    // unauthorized so the renderer can show a helpful message.
    //
    // Endpoint: POST /user/repos (personal) or POST /orgs/{org}/repos (org)
    // Auth: `Authorization: Bearer <token>` with `repo` scope
    // Returns: { sshUrl, cloneUrl, htmlUrl } so the renderer can wire the
    // remote and push without a second round-trip.
    // These delegate to the shared GitHub REST client (src/main/gitHost/github.ts)
    // — same endpoints/headers/auth/error-parsing as before, just extracted so
    // the provider registry stays symmetric. The renderer's window.api.github.*
    // bridge keeps calling these channels unchanged.
    electron_1.ipcMain.handle('github:create-repo', async (_, args) => {
        return gitHost_1.githubClient.createRepository(args.token, {
            name: args.name,
            description: args.description,
            isPrivate: args.isPrivate,
            namespaceId: args.org ?? null,
        });
    });
    electron_1.ipcMain.handle('github:get-viewer', async (_, args) => {
        const viewer = await gitHost_1.githubClient.getViewer(args.token);
        // Preserve the original (provider-less) shape this channel returned.
        return { login: viewer.login, name: viewer.name, avatarUrl: viewer.avatarUrl };
    });
    electron_1.ipcMain.handle('github:list-repos', async (_, args) => {
        const repos = await gitHost_1.githubClient.listRepositories(args.token);
        // Preserve the original (provider-less) shape this channel returned.
        return repos.map(({ provider: _provider, ...rest }) => rest);
    });
    electron_1.ipcMain.handle('github:check-repo-access', async (_, args) => {
        return gitHost_1.githubClient.checkRepoAccess(args.token, `${args.owner}/${args.repo}`);
    });
    // ── Provider-agnostic git-hosting handlers (GitHub + GitLab) ──────────────
    // The renderer's utils/gitHost façade routes every provider through these.
    // GitLab REST only ever fires when the caller passes provider: 'gitlab'.
    electron_1.ipcMain.handle('gitHost:get-viewer', async (_, args) => {
        return (0, gitHost_1.getGitHostClient)(args.provider).getViewer(args.token, args.instanceUrl);
    });
    electron_1.ipcMain.handle('gitHost:list-repos', async (_, args) => {
        return (0, gitHost_1.getGitHostClient)(args.provider).listRepositories(args.token, args.instanceUrl);
    });
    electron_1.ipcMain.handle('gitHost:create-repo', async (_, args) => {
        return (0, gitHost_1.getGitHostClient)(args.provider).createRepository(args.token, {
            name: args.name,
            description: args.description,
            isPrivate: args.isPrivate,
            namespaceId: args.namespaceId ?? null,
        }, args.instanceUrl);
    });
    electron_1.ipcMain.handle('gitHost:check-repo-access', async (_, args) => {
        return (0, gitHost_1.getGitHostClient)(args.provider).checkRepoAccess(args.token, args.fullPath, args.instanceUrl);
    });
    electron_1.ipcMain.handle('gitHost:list-namespaces', async (_, args) => {
        return (0, gitHost_1.getGitHostClient)(args.provider).listNamespaces(args.token, args.instanceUrl);
    });
    // ── App templates handlers ───────────────────────────────────────────────
    electron_1.ipcMain.handle('templates:fetch-manifest', async () => {
        return templateManager.fetchManifest();
    });
    electron_1.ipcMain.handle('templates:clone', async (_, args) => {
        const { templateId, destinationPath } = args;
        return templateManager.cloneTemplate(templateId, destinationPath, (progress) => {
            sendToRenderer('templates:clone-progress', progress);
        });
    });
    // ── Worktree handlers ────────────────────────────────────────────────────
    // Multi-root projects: list the primary repo + every independent repo
    // nested under the project folder (Zed-style sub-repository detection).
    electron_1.ipcMain.handle('git:list-sub-repos', async (_, args) => {
        const { rootPath } = args;
        return gitManager.listSubRepositories(rootPath);
    });
    // Multi-root projects: status-only summary across the workspace root + its
    // nested repos, for FileTree change badges (cheap: no log, pooled).
    electron_1.ipcMain.handle('git:get-multi-status', async (_, args) => {
        const { rootPath, repoPaths } = args;
        return gitManager.getMultiStatus(rootPath, Array.isArray(repoPaths) ? repoPaths : []);
    });
    electron_1.ipcMain.handle('git:list-worktrees', async (_, args) => {
        const { repoPath, options } = args;
        return gitManager.listWorktrees(repoPath, options);
    });
    electron_1.ipcMain.handle('git:add-worktree', async (_, args) => {
        const { repoPath, worktreePath, options, gitOptions } = args;
        return gitManager.addWorktree(repoPath, worktreePath, options, gitOptions);
    });
    electron_1.ipcMain.handle('git:remove-worktree', async (_, args) => {
        const { repoPath, worktreePath, force, gitOptions } = args;
        return gitManager.removeWorktree(repoPath, worktreePath, Boolean(force), gitOptions);
    });
    electron_1.ipcMain.handle('git:prune-worktrees', async (_, args) => {
        const { repoPath, gitOptions } = args;
        return gitManager.pruneWorktrees(repoPath, gitOptions);
    });
    electron_1.ipcMain.handle('git:lock-worktree', async (_, args) => {
        const { repoPath, worktreePath, reason, gitOptions } = args;
        return gitManager.lockWorktree(repoPath, worktreePath, reason, gitOptions);
    });
    electron_1.ipcMain.handle('git:unlock-worktree', async (_, args) => {
        const { repoPath, worktreePath, gitOptions } = args;
        return gitManager.unlockWorktree(repoPath, worktreePath, gitOptions);
    });
    electron_1.ipcMain.handle('git:get-graph-log', async (_, args) => {
        const { repoPath, maxCount, skip, gitOptions } = args;
        return gitManager.getGraphLog(repoPath, maxCount, skip, gitOptions);
    });
    electron_1.ipcMain.handle('git:get-commit-detail', async (_, args) => {
        const { repoPath, hash, gitOptions } = args;
        return gitManager.getCommitDetail(repoPath, hash, gitOptions);
    });
    electron_1.ipcMain.handle('git:watch-state', async (event, args) => {
        const { repoPath } = args;
        await gitStateWatcher.watch(repoPath, event.sender);
    });
    electron_1.ipcMain.handle('git:unwatch-state', async (event, args) => {
        const { repoPath } = args;
        gitStateWatcher.unwatch(repoPath, event.sender);
    });
}
