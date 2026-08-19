"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
// Block Chromium's built-in zoom (Cmd+/-/0 and pinch-to-zoom) so each panel
// manages its own zoom via keydown handlers. Global UI scale is applied by
// main process on did-finish-load via webContents.setZoomFactor().
electron_1.webFrame.setVisualZoomLevelLimits(1, 1);
electron_1.webFrame.setZoomFactor(1);
// LSP MessagePort relay.
//
// `MessagePort` objects do NOT survive contextBridge serialization — passing
// them through `contextBridge.exposeInMainWorld` strips their prototype, which
// breaks `port.start()` and the BrowserMessageReader/Writer wrappers
// vscode-jsonrpc relies on. The documented Electron pattern is:
//   1. Receive the port in preload via ipcRenderer.on (where port.ports works)
//   2. Re-post it via window.postMessage with a transferable list
//   3. Renderer listens via window.addEventListener('message', …)
//
// Preload and renderer share the same DOM `window` even with context
// isolation, so window.postMessage carries the port natively without going
// through contextBridge.
electron_1.ipcRenderer.on('lsp:port', (event, meta) => {
    // event.ports is the array of MessagePort transferables from main's
    // webContents.postMessage('lsp:port', meta, [port]) call.
    window.postMessage({ __lspPortRelay: true, meta }, '*', event.ports);
});
function mintTaskActionGrant(action) {
    // This first invoke happens synchronously from the renderer's click handler,
    // while Chromium still reports a live user activation. Main binds the
    // resulting one-shot capability to `action`; the second invoke may safely
    // cross an await because it carries that exact proof.
    return electron_1.ipcRenderer.invoke('tasks:mint-action-grant', { action });
}
async function invokeGrantedTask(action, channel, args) {
    const minted = await mintTaskActionGrant(action);
    if (!minted.ok)
        return minted;
    return electron_1.ipcRenderer.invoke(channel, { ...args, grant: minted.grant });
}
const api = {
    // PTY operations
    pty: {
        create: (terminalId, cwd, shell, command, agentType, forceAiAgent, tmuxMouseBehavior, poolReservationId) => electron_1.ipcRenderer.invoke('pty:create', { terminalId, cwd, shell, command, agentType, forceAiAgent, tmuxMouseBehavior, poolReservationId }),
        write: (terminalId, data, origin = 'user') => electron_1.ipcRenderer.send('pty:input', { terminalId, data, origin }),
        resize: (terminalId, cols, rows) => electron_1.ipcRenderer.send('pty:resize', { terminalId, cols, rows }),
        // Current node-pty dims (null when the PTY is gone). Used by the
        // renderer's layout-desync detector to compare against xterm's grid.
        getSize: (terminalId) => electron_1.ipcRenderer.invoke('pty:get-size', { terminalId }),
        // Remote Control size authority for a terminal: `hasAuthority` is true
        // while an operator phone viewing it owns its PTY dims (the dims-desync
        // probe must not "heal" that deliberate PTY↔xterm mismatch), and
        // `deviceLabel` names the phone for the "Sized for phone" badge.
        getRemoteSizeAuthority: (terminalId) => electron_1.ipcRenderer.invoke('pty:remote-size-authority', { terminalId }),
        // Original spawn time of the terminal's PTY this app session (0 = never
        // spawned). Lets remounted panes re-arm session detection with the real
        // spawn anchor instead of losing detection after a tab/project switch.
        getSpawnTime: (terminalId) => electron_1.ipcRenderer.invoke('pty:get-spawn-time', { terminalId }),
        waitForAgentReady: (terminalId, requestId) => electron_1.ipcRenderer.invoke('pty:wait-agent-ready', { terminalId, requestId }),
        cancelWaitForAgentReady: (requestId) => electron_1.ipcRenderer.send('pty:cancel-wait-agent-ready', { requestId }),
        kill: (terminalId) => electron_1.ipcRenderer.invoke('pty:kill', { terminalId }),
        detach: (terminalId) => electron_1.ipcRenderer.invoke('pty:detach', { terminalId }),
        onData: (callback) => {
            const handler = (_, args) => {
                if (args.chunks) {
                    for (const chunk of args.chunks)
                        callback(args.terminalId, chunk.data, chunk.seq);
                }
                else if (typeof args.data === 'string') {
                    callback(args.terminalId, args.data, args.seq);
                }
            };
            electron_1.ipcRenderer.on('pty:output', handler);
            return () => void electron_1.ipcRenderer.removeListener('pty:output', handler);
        },
        onDataBatch: (callback) => {
            const handler = (_, args) => {
                if (args.batchId && args.chunks) {
                    callback({
                        terminalId: args.terminalId,
                        batchId: args.batchId,
                        chunks: args.chunks,
                        bytes: args.bytes ?? 0,
                    });
                }
            };
            electron_1.ipcRenderer.on('pty:output', handler);
            return () => void electron_1.ipcRenderer.removeListener('pty:output', handler);
        },
        acknowledgeOutput: (terminalId, batchId) => electron_1.ipcRenderer.send('pty:ack-output', { terminalId, batchId }),
        attachV2: (request) => electron_1.ipcRenderer.invoke('terminal-connection:attach', { request }),
        acknowledgeConnectionFrame: (connectionId, syncGeneration, frameId) => electron_1.ipcRenderer.invoke('terminal-connection:ack', {
            connectionId,
            syncGeneration,
            frameId,
        }),
        resyncConnection: (connectionId) => electron_1.ipcRenderer.invoke('terminal-connection:resync', { connectionId }),
        detachConnection: (connectionId) => electron_1.ipcRenderer.invoke('terminal-connection:detach', { connectionId }),
        onConnectionFrame: (callback) => {
            const handler = (_, frame) => callback(frame);
            electron_1.ipcRenderer.on('terminal-connection:frame', handler);
            return () => void electron_1.ipcRenderer.removeListener('terminal-connection:frame', handler);
        },
        getOwnerIdentity: (terminalId) => electron_1.ipcRenderer.invoke('terminal-connection:owner', { terminalId }),
        writeFenced: (part) => electron_1.ipcRenderer.invoke('terminal-connection:write-fenced', { part }),
        flushFenced: (part) => electron_1.ipcRenderer.invoke('terminal-connection:flush-fenced', { part }),
        onExit: (callback) => {
            const handler = (_, args) => {
                callback(args.terminalId, args.code);
            };
            electron_1.ipcRenderer.on('pty:exit', handler);
            return () => void electron_1.ipcRenderer.removeListener('pty:exit', handler);
        },
        onRunEnded: (callback) => {
            const handler = (_, event) => callback(event);
            electron_1.ipcRenderer.on('pty:run-ended', handler);
            return () => void electron_1.ipcRenderer.removeListener('pty:run-ended', handler);
        },
        // Output subscription: renderer subscribes per mounted terminal view
        subscribeOutput: (terminalId) => electron_1.ipcRenderer.invoke('pty:subscribe-output', { terminalId }),
        unsubscribeOutput: (terminalId) => electron_1.ipcRenderer.invoke('pty:unsubscribe-output', { terminalId }),
        // Dashboard: cross-project statuses
        getAllStatuses: () => electron_1.ipcRenderer.invoke('pty:get-all-statuses'),
        getBufferPreview: (terminalId, maxChars = 200) => electron_1.ipcRenderer.invoke('pty:get-buffer-preview', { terminalId, maxChars }),
        // Tmux session management
        hasTmux: () => electron_1.ipcRenderer.invoke('pty:has-tmux'),
        hasSession: (terminalId) => electron_1.ipcRenderer.invoke('pty:has-session', { terminalId }),
        getSessionGeneration: (terminalId) => electron_1.ipcRenderer.invoke('pty:session-generation', { terminalId }),
        listSessions: () => electron_1.ipcRenderer.invoke('pty:list-sessions'),
    },
    // Dependency management
    deps: {
        getStatus: () => electron_1.ipcRenderer.invoke('deps:get-status'),
        installTmux: () => electron_1.ipcRenderer.invoke('deps:install-tmux'),
        recheckTmux: () => electron_1.ipcRenderer.invoke('deps:recheck-tmux'),
        installSshfs: () => electron_1.ipcRenderer.invoke('deps:install-sshfs'),
        recheckSshfs: () => electron_1.ipcRenderer.invoke('deps:recheck-sshfs'),
        installIdb: () => electron_1.ipcRenderer.invoke('deps:install-idb'),
        recheckIdb: () => electron_1.ipcRenderer.invoke('deps:recheck-idb'),
        onInstallLog: (callback) => {
            const handler = (_, args) => {
                callback(args.data);
            };
            electron_1.ipcRenderer.on('deps:install-log', handler);
            return () => void electron_1.ipcRenderer.removeListener('deps:install-log', handler);
        },
    },
    design: {
        generate: (args) => electron_1.ipcRenderer.invoke('design:generate', args),
        cancel: () => electron_1.ipcRenderer.send('design:cancel'),
        exportImage: (args) => electron_1.ipcRenderer.invoke('design:export-image', args),
        onProgress: (callback) => {
            const handler = (_, args) => {
                callback(args.message);
            };
            electron_1.ipcRenderer.on('design:progress', handler);
            return () => void electron_1.ipcRenderer.removeListener('design:progress', handler);
        },
        onStreamComponent: (callback) => {
            const handler = (_, component) => {
                callback(component);
            };
            electron_1.ipcRenderer.on('design:stream-component', handler);
            return () => void electron_1.ipcRenderer.removeListener('design:stream-component', handler);
        },
        getMcpConfig: () => electron_1.ipcRenderer.invoke('design:get-mcp-config'),
        setupMcp: () => electron_1.ipcRenderer.invoke('design:setup-mcp'),
        getBridgePort: () => electron_1.ipcRenderer.invoke('design:get-bridge-port'),
        onMcpCommand: (callback) => {
            const handler = (_, args) => {
                callback(args);
            };
            electron_1.ipcRenderer.on('design:mcp-command', handler);
            return () => void electron_1.ipcRenderer.removeListener('design:mcp-command', handler);
        },
    },
    prototype: {
        generate: (args) => electron_1.ipcRenderer.invoke('prototype:generate', args),
        cancel: () => electron_1.ipcRenderer.send('prototype:cancel'),
        onProgress: (callback) => {
            const handler = (_, args) => callback(args.message);
            electron_1.ipcRenderer.on('prototype:progress', handler);
            return () => void electron_1.ipcRenderer.removeListener('prototype:progress', handler);
        },
        onStreamSpec: (callback) => {
            const handler = (_, spec) => callback(spec);
            electron_1.ipcRenderer.on('prototype:stream-spec', handler);
            return () => void electron_1.ipcRenderer.removeListener('prototype:stream-spec', handler);
        },
        onMcpCommand: (callback) => {
            const handler = (_, args) => callback(args);
            electron_1.ipcRenderer.on('prototype:mcp-command', handler);
            return () => void electron_1.ipcRenderer.removeListener('prototype:mcp-command', handler);
        },
    },
    pipe: {
        startCapture: (terminalId) => electron_1.ipcRenderer.invoke('pipe:start-capture', { terminalId }),
        stopCapture: (terminalId) => electron_1.ipcRenderer.invoke('pipe:stop-capture', { terminalId }),
        getBuffer: (terminalId) => electron_1.ipcRenderer.invoke('pipe:get-buffer', { terminalId }),
        // Buffer + last chunk seq captured atomically in main — remount replay
        // uses the seq to drop deferred live chunks the snapshot already contains.
        getBufferSnapshot: (terminalId) => electron_1.ipcRenderer.invoke('pipe:get-buffer-snapshot', { terminalId }),
        clearBuffer: (terminalId) => electron_1.ipcRenderer.invoke('pipe:clear-buffer', { terminalId }),
        isIdle: (terminalId, thresholdMs) => electron_1.ipcRenderer.invoke('pipe:is-idle', { terminalId, thresholdMs }),
    },
    // File system operations
    fs: {
        readDir: (path, respectGitignore, showHidden) => electron_1.ipcRenderer.invoke('fs:readdir', { path, respectGitignore, showHidden }),
        listFiles: (path, respectGitignore, showHidden, limit) => electron_1.ipcRenderer.invoke('fs:list-files', { path, respectGitignore, showHidden, limit }),
        searchPaths: (path, query, respectGitignore, showHidden, limit) => electron_1.ipcRenderer.invoke('fs:search-paths', { path, query, respectGitignore, showHidden, limit }),
        searchContent: (path, query, respectGitignore, showHidden, limit) => electron_1.ipcRenderer.invoke('fs:search-content', { path, query, respectGitignore, showHidden, limit }),
        searchWorkspace: (request) => electron_1.ipcRenderer.invoke('fs:search-workspace', request),
        cancelWorkspaceSearch: (scopeId, requestId) => electron_1.ipcRenderer.invoke('fs:cancel-workspace-search', { scopeId, requestId }),
        watch: (path, options) => electron_1.ipcRenderer.invoke('fs:watch', { path, profile: options?.profile }),
        unwatch: (path, options) => electron_1.ipcRenderer.invoke('fs:unwatch', { path, profile: options?.profile }),
        statFiles: (paths) => electron_1.ipcRenderer.invoke('fs:stat-files', { paths }),
        readFile: (path, maxBytes) => electron_1.ipcRenderer.invoke('fs:read-file', { path, maxBytes }),
        writeFile: (path, content) => electron_1.ipcRenderer.invoke('fs:write-file', { path, content }),
        openInEditor: (path, editor) => electron_1.ipcRenderer.invoke('fs:open-in-editor', { path, editor }),
        detectEditors: () => electron_1.ipcRenderer.invoke('fs:detect-editors'),
        getEditorIcon: (command) => electron_1.ipcRenderer.invoke('fs:get-editor-icon', { command }),
        pickEditorBinary: () => electron_1.ipcRenderer.invoke('fs:pick-editor-binary'),
        revealInFinder: (path) => electron_1.ipcRenderer.invoke('fs:reveal-in-finder', { path }),
        getGitBranch: (path) => electron_1.ipcRenderer.invoke('fs:get-git-branch', { path }),
        copyPath: (path) => electron_1.ipcRenderer.invoke('fs:copy-path', { path }),
        onChange: (callback) => {
            const handler = (_, args) => {
                callback(args.type, args.path);
            };
            electron_1.ipcRenderer.on('fs:change', handler);
            return () => void electron_1.ipcRenderer.removeListener('fs:change', handler);
        },
        createFile: (path) => electron_1.ipcRenderer.invoke('fs:create-file', { path }),
        createDirectory: (path) => electron_1.ipcRenderer.invoke('fs:create-directory', { path }),
        delete: (path) => electron_1.ipcRenderer.invoke('fs:delete', { path }),
        rename: (oldPath, newPath) => electron_1.ipcRenderer.invoke('fs:rename', { oldPath, newPath }),
        copyItem: (srcPath, destPath) => electron_1.ipcRenderer.invoke('fs:copy-item', { srcPath, destPath }),
        exists: (path) => electron_1.ipcRenderer.invoke('fs:exists', { path }),
    },
    aiDiff: {
        startSession: (args) => electron_1.ipcRenderer.invoke('ai-diff:start-session', args),
        endSession: (sessionId, status) => electron_1.ipcRenderer.invoke('ai-diff:end-session', { sessionId, status }),
        listSessions: (projectId) => electron_1.ipcRenderer.invoke('ai-diff:list-sessions', { projectId }),
        listPending: (sessionId) => electron_1.ipcRenderer.invoke('ai-diff:list-pending', { sessionId }),
        getBaseline: (sessionId, filePath) => electron_1.ipcRenderer.invoke('ai-diff:get-baseline', { sessionId, filePath }),
        getDiff: (sessionId, filePath) => electron_1.ipcRenderer.invoke('ai-diff:get-diff', { sessionId, filePath }),
        accept: (sessionId, filePath) => electron_1.ipcRenderer.invoke('ai-diff:accept', { sessionId, filePath }),
        revert: (sessionId, filePath) => electron_1.ipcRenderer.invoke('ai-diff:revert', { sessionId, filePath }),
        onChanged: (callback) => {
            const handler = (_, snapshot) => callback(snapshot);
            electron_1.ipcRenderer.on('ai-diff:changed', handler);
            return () => void electron_1.ipcRenderer.removeListener('ai-diff:changed', handler);
        },
    },
    lsp: {
        getRegistry: () => electron_1.ipcRenderer.invoke('lsp:registry'),
        detect: (languageId) => electron_1.ipcRenderer.invoke('lsp:detect', { languageId }),
        install: (languageId) => electron_1.ipcRenderer.invoke('lsp:install', { languageId }),
        enable: (languageId) => electron_1.ipcRenderer.invoke('lsp:enable', { languageId }),
        disable: (languageId) => electron_1.ipcRenderer.invoke('lsp:disable', { languageId }),
        // Per-project LSP runtime — phase 4 plumbing for the right-click flow.
        // Detection: walk a project root and report which registry languages are
        // present + installed. Used by the "Enable language support" dialog to
        // populate its checkbox list.
        detectProjectLanguages: (projectRoot) => electron_1.ipcRenderer.invoke('lsp:detect-project-languages', { projectRoot }),
        // Spawn / shutdown servers for one project. Returns a result object with
        // per-language spawned/failed lists; partial success is normal.
        enableProject: (projectId, projectRoot, languageIds) => electron_1.ipcRenderer.invoke('lsp:enable-project', { projectId, projectRoot, languageIds }),
        disableProject: (projectId) => electron_1.ipcRenderer.invoke('lsp:disable-project', { projectId }),
        // Snapshot status for the status bar / settings tab. Pass `undefined`
        // to get all projects, a string to get one.
        projectStatus: (projectId) => electron_1.ipcRenderer.invoke('lsp:project-status', { projectId }),
        // The renderer fires this back to main once its RendererLSPClient has
        // completed the LSP `initialize` round-trip. Main flips the instance
        // status from `starting` → `ready` so the status bar shows green.
        notifyInitialized: (instanceId) => electron_1.ipcRenderer.invoke('lsp:notify-initialized', { instanceId }),
        // Note: there is no `onPort` here on purpose — MessagePort transfers do
        // not survive contextBridge serialization. The renderer listens for ports
        // directly via window.addEventListener('message', …); see the relay
        // listener at the top of this file.
        // Subscribe to child-process exit notifications (intentional or crash).
        // Renderer uses these to dispose its client, clear markers, and update
        // status pills.
        onCrashed: (handler) => {
            const listener = (_event, message) => handler(message);
            electron_1.ipcRenderer.on('lsp:crashed', listener);
            return () => void electron_1.ipcRenderer.removeListener('lsp:crashed', listener);
        },
    },
    // Git operations
    git: {
        run: (repoPath, command, options, ...args) => electron_1.ipcRenderer.invoke('git:run', { repoPath, command, options, args }),
        // Move a commit one slot toward HEAD ('up') or the root ('down') via a
        // safe, auto-aborting non-interactive rebase (see GitManager.reorderCommit).
        reorderCommit: (repoPath, hash, direction, options) => electron_1.ipcRenderer.invoke('git:reorder-commit', { repoPath, hash, direction, options }),
        status: (repoPath, options) => electron_1.ipcRenderer.invoke('git:run', { repoPath, command: 'status', options, args: [] }),
        add: (repoPath, options, ...files) => electron_1.ipcRenderer.invoke('git:run', { repoPath, command: 'add', options, args: files }),
        commit: (repoPath, options, message) => electron_1.ipcRenderer.invoke('git:run', { repoPath, command: 'commit', options, args: ['-m', message] }),
        push: (repoPath, options) => electron_1.ipcRenderer.invoke('git:run', { repoPath, command: 'push', options, args: [] }),
        pull: (repoPath, options) => electron_1.ipcRenderer.invoke('git:run', { repoPath, command: 'pull', options, args: [] }),
        checkout: (repoPath, options, ref) => electron_1.ipcRenderer.invoke('git:run', { repoPath, command: 'checkout', options, args: [ref] }),
        branch: (repoPath, options) => electron_1.ipcRenderer.invoke('git:run', { repoPath, command: 'branch', options, args: [] }),
        merge: (repoPath, options, ref) => electron_1.ipcRenderer.invoke('git:run', { repoPath, command: 'merge', options, args: [ref] }),
        log: (repoPath, options) => electron_1.ipcRenderer.invoke('git:run', { repoPath, command: 'log', options, args: [] }),
        getLogEntries: (repoPath, maxCount, skip, options) => electron_1.ipcRenderer.invoke('git:get-log-entries', { repoPath, maxCount, skip, options }),
        getSummary: (repoPath, options) => electron_1.ipcRenderer.invoke('git:get-summary', { repoPath, options }),
        getDiff: (repoPath, filePath, staged, options) => electron_1.ipcRenderer.invoke('git:get-diff', { repoPath, filePath, staged, options }),
        getFileBlob: (repoPath, ref, filePath, options) => electron_1.ipcRenderer.invoke('git:get-file-blob', { repoPath, ref, filePath, options }),
        getBranches: (repoPath, options) => electron_1.ipcRenderer.invoke('git:get-branches', { repoPath, options }),
        getGlobalIdentity: () => electron_1.ipcRenderer.invoke('git:get-global-identity'),
        applyAccountConfig: (repoPath, account) => electron_1.ipcRenderer.invoke('git:apply-account-config', { repoPath, account }),
        getPushPreview: (repoPath, options) => electron_1.ipcRenderer.invoke('git:get-push-preview', { repoPath, options }),
        getPullPreview: (repoPath, options) => electron_1.ipcRenderer.invoke('git:get-pull-preview', { repoPath, options }),
        generateCommitMessage: (repoPath, opts) => electron_1.ipcRenderer.invoke('git:generate-commit-message', {
            repoPath,
            settings: opts?.settings,
            avoidSummaries: opts?.avoidSummaries,
            gitOptions: opts?.gitOptions,
        }),
        // ── Multi-root projects ────────────────────────────────────────────────
        // Detect the primary repo + every independent repo nested under the
        // project folder (Zed-style sub-repository detection).
        listSubRepositories: (rootPath) => electron_1.ipcRenderer.invoke('git:list-sub-repos', { rootPath }),
        // Status-only multi-repo status for FileTree badges (no commit log).
        getMultiStatus: (rootPath, repoPaths) => electron_1.ipcRenderer.invoke('git:get-multi-status', { rootPath, repoPaths }),
        // ── Worktree operations ────────────────────────────────────────────────
        listWorktrees: (repoPath, options) => electron_1.ipcRenderer.invoke('git:list-worktrees', { repoPath, options }),
        addWorktree: (repoPath, worktreePath, options, gitOptions) => electron_1.ipcRenderer.invoke('git:add-worktree', { repoPath, worktreePath, options, gitOptions }),
        removeWorktree: (repoPath, worktreePath, force, gitOptions) => electron_1.ipcRenderer.invoke('git:remove-worktree', { repoPath, worktreePath, force, gitOptions }),
        pruneWorktrees: (repoPath, gitOptions) => electron_1.ipcRenderer.invoke('git:prune-worktrees', { repoPath, gitOptions }),
        lockWorktree: (repoPath, worktreePath, reason, gitOptions) => electron_1.ipcRenderer.invoke('git:lock-worktree', { repoPath, worktreePath, reason, gitOptions }),
        unlockWorktree: (repoPath, worktreePath, gitOptions) => electron_1.ipcRenderer.invoke('git:unlock-worktree', { repoPath, worktreePath, gitOptions }),
        getGraphLog: (repoPath, maxCount, skip, gitOptions) => electron_1.ipcRenderer.invoke('git:get-graph-log', { repoPath, maxCount, skip, gitOptions }),
        getCommitDetail: (repoPath, hash, gitOptions) => electron_1.ipcRenderer.invoke('git:get-commit-detail', { repoPath, hash, gitOptions }),
        // Git state watcher: subscribes to external git mutations on a repo.
        // Renderer should call onStateChanged() to listen, then watchState() to
        // start the watcher. Multiple subscribers per repo are supported.
        watchState: (repoPath) => electron_1.ipcRenderer.invoke('git:watch-state', { repoPath }),
        unwatchState: (repoPath) => electron_1.ipcRenderer.invoke('git:unwatch-state', { repoPath }),
        onStateChanged: (callback) => {
            const handler = (_, args) => callback(args.repoPath);
            electron_1.ipcRenderer.on('git:state-changed', handler);
            return () => void electron_1.ipcRenderer.removeListener('git:state-changed', handler);
        },
    },
    // Draw tool: prompt → diagram source via a headless AI CLI. The renderer
    // converts the returned mermaid/skeleton source into editable canvas
    // elements (conversion needs the DOM, so it never happens in main).
    draw: {
        generateDiagram: (args) => electron_1.ipcRenderer.invoke('draw:generate-diagram', args),
        cancelDiagram: () => electron_1.ipcRenderer.invoke('draw:cancel-diagram'),
    },
    // GitHub REST API operations. Currently only used by the Publish Repository
    // flow to create a new repo via the user's PAT, but kept as its own
    // namespace so future GitHub-specific endpoints (issues, PRs, etc.) can
    // slot in alongside.
    github: {
        createRepository: (args) => electron_1.ipcRenderer.invoke('github:create-repo', args),
        getViewer: (token) => electron_1.ipcRenderer.invoke('github:get-viewer', { token }),
        checkRepoAccess: (token, owner, repo) => electron_1.ipcRenderer.invoke('github:check-repo-access', { token, owner, repo }),
        listRepositories: (token) => electron_1.ipcRenderer.invoke('github:list-repos', { token }),
    },
    // Provider-agnostic git-hosting REST (GitHub + GitLab). The renderer's
    // utils/gitHost façade calls these for both providers; window.api.github
    // above stays as a GitHub-only convenience shim for existing call sites.
    gitHost: {
        getViewer: (args) => electron_1.ipcRenderer.invoke('gitHost:get-viewer', args),
        listRepositories: (args) => electron_1.ipcRenderer.invoke('gitHost:list-repos', args),
        createRepository: (args) => electron_1.ipcRenderer.invoke('gitHost:create-repo', args),
        checkRepoAccess: (args) => electron_1.ipcRenderer.invoke('gitHost:check-repo-access', args),
        listNamespaces: (args) => electron_1.ipcRenderer.invoke('gitHost:list-namespaces', args),
    },
    templates: {
        fetchManifest: () => electron_1.ipcRenderer.invoke('templates:fetch-manifest'),
        clone: (templateId, destinationPath) => electron_1.ipcRenderer.invoke('templates:clone', { templateId, destinationPath }),
        onCloneProgress: (callback) => {
            const handler = (_, progress) => callback(progress);
            electron_1.ipcRenderer.on('templates:clone-progress', handler);
            return () => void electron_1.ipcRenderer.removeListener('templates:clone-progress', handler);
        },
    },
    // HTTP operations
    http: {
        request: (method, url, headers, body, auth, bodyType, formBody) => electron_1.ipcRenderer.invoke('http:request', { method, url, headers, body, auth, bodyType, formBody }),
        importCollection: (format, filePath) => electron_1.ipcRenderer.invoke('http:import-collection', { format, path: filePath }),
        detectImportFile: (filePath) => electron_1.ipcRenderer.invoke('http:detect-import-file', { path: filePath }),
        importFile: (filePath) => electron_1.ipcRenderer.invoke('http:import-file', { path: filePath }),
        exportCollection: (format, tabs, collectionName, filePath) => electron_1.ipcRenderer.invoke('http:export-collection', { format, tabs, collectionName, path: filePath }),
        getGlobalTabs: () => electron_1.ipcRenderer.invoke('http:get-global-tabs'),
        setGlobalTabs: (tabs) => electron_1.ipcRenderer.invoke('http:set-global-tabs', { tabs }),
    },
    // Port manager operations
    ports: {
        list: () => electron_1.ipcRenderer.invoke('ports:list'),
        kill: (pid) => electron_1.ipcRenderer.invoke('ports:kill', { pid }),
        detail: (pid) => electron_1.ipcRenderer.invoke('ports:detail', { pid }),
    },
    // Cron job manager operations
    cron: {
        list: () => electron_1.ipcRenderer.invoke('cron:list'),
        add: (schedule, command) => electron_1.ipcRenderer.invoke('cron:add', { schedule, command }),
        update: (line, expectedRaw, schedule, command) => electron_1.ipcRenderer.invoke('cron:update', { line, expectedRaw, schedule, command }),
        remove: (line, expectedRaw) => electron_1.ipcRenderer.invoke('cron:remove', { line, expectedRaw }),
        setEnabled: (line, expectedRaw, enabled) => electron_1.ipcRenderer.invoke('cron:set-enabled', { line, expectedRaw, enabled }),
        logs: () => electron_1.ipcRenderer.invoke('cron:logs'),
        openWindow: () => electron_1.ipcRenderer.invoke('cron:open-window'),
        // True when this renderer was loaded as the detached cron window.
        isWindowMode: () => new URLSearchParams(window.location.search).has('cronWindow'),
    },
    // SSH operations
    ssh: {
        listLocalKeys: (scanPaths) => electron_1.ipcRenderer.invoke('ssh:list-local-keys', { scanPaths }),
        listConfigHosts: (scanPaths) => electron_1.ipcRenderer.invoke('ssh:list-config-hosts', { scanPaths }),
        discoverLocal: (scanPaths) => electron_1.ipcRenderer.invoke('ssh:discover-local', { scanPaths }),
        generateKey: (args) => electron_1.ipcRenderer.invoke('ssh:generate-key', args),
        checkSshfs: () => electron_1.ipcRenderer.invoke('ssh:check-sshfs'),
        testConnection: (args) => electron_1.ipcRenderer.invoke('ssh:test-connection', args),
        listRemoteDirs: (args) => electron_1.ipcRenderer.invoke('ssh:list-remote-dirs', args),
        mount: (args) => electron_1.ipcRenderer.invoke('ssh:mount', args),
        unmount: (mountPath) => electron_1.ipcRenderer.invoke('ssh:unmount', { mountPath }),
        listMounts: () => electron_1.ipcRenderer.invoke('ssh:list-mounts'),
    },
    // Docker operations
    docker: {
        isAvailable: () => electron_1.ipcRenderer.invoke('docker:available'),
        listContainers: () => electron_1.ipcRenderer.invoke('docker:containers'),
        listImages: () => electron_1.ipcRenderer.invoke('docker:images'),
        start: (containerId) => electron_1.ipcRenderer.invoke('docker:start', { containerId }),
        stop: (containerId) => electron_1.ipcRenderer.invoke('docker:stop', { containerId }),
        restart: (containerId) => electron_1.ipcRenderer.invoke('docker:restart', { containerId }),
        removeContainer: (containerId) => electron_1.ipcRenderer.invoke('docker:remove-container', { containerId }),
        removeImage: (imageId) => electron_1.ipcRenderer.invoke('docker:remove-image', { imageId }),
        inspectContainer: (containerId) => electron_1.ipcRenderer.invoke('docker:inspect-container', { containerId }),
        getContainerLogs: (containerId, tail) => electron_1.ipcRenderer.invoke('docker:container-logs', { containerId, tail }),
        getContainerStats: (containerId) => electron_1.ipcRenderer.invoke('docker:container-stats', { containerId }),
        pause: (containerId) => electron_1.ipcRenderer.invoke('docker:pause', { containerId }),
        unpause: (containerId) => electron_1.ipcRenderer.invoke('docker:unpause', { containerId }),
        inspectImage: (imageId) => electron_1.ipcRenderer.invoke('docker:inspect-image', { imageId }),
        getImageHistory: (imageId) => electron_1.ipcRenderer.invoke('docker:image-history', { imageId }),
        getImageContainers: (imageId) => electron_1.ipcRenderer.invoke('docker:image-containers', { imageId }),
        listVolumes: () => electron_1.ipcRenderer.invoke('docker:volumes'),
        inspectVolume: (name) => electron_1.ipcRenderer.invoke('docker:inspect-volume', { name }),
        removeVolume: (name) => electron_1.ipcRenderer.invoke('docker:remove-volume', { name }),
        startLogStream: (containerId) => electron_1.ipcRenderer.invoke('docker:stream-logs-start', { containerId }),
        stopLogStream: (containerId) => electron_1.ipcRenderer.invoke('docker:stream-logs-stop', { containerId }),
        onLogData: (callback) => {
            const handler = (_event, payload) => callback(payload);
            electron_1.ipcRenderer.on('docker:log-data', handler);
            return () => void electron_1.ipcRenderer.removeListener('docker:log-data', handler);
        },
    },
    db: {
        testConnection: (connection) => electron_1.ipcRenderer.invoke('db:test-connection', { connection }),
        query: (connection, sql) => electron_1.ipcRenderer.invoke('db:query', { connection, sql }),
        schema: (connection) => electron_1.ipcRenderer.invoke('db:schema', { connection }),
        previewTable: (connection, schema, table, filterOrOptions, limit) => electron_1.ipcRenderer.invoke('db:preview-table', typeof filterOrOptions === 'string'
            ? { connection, schema, table, filter: filterOrOptions, limit }
            : { connection, schema, table, options: filterOrOptions, limit }),
        updateRow: (connection, schema, table, nextRow, originalRow, primaryKeys) => electron_1.ipcRenderer.invoke('db:update-row', { connection, schema, table, nextRow, originalRow, primaryKeys }),
        exportData: (connection, schema, table, format, limit) => electron_1.ipcRenderer.invoke('db:export', { connection, schema, table, format, limit }),
        importData: (connection, schema, table, data, format) => electron_1.ipcRenderer.invoke('db:import', { connection, schema, table, data, format }),
        onExportProgress: (callback) => {
            const handler = (_, args) => callback(args.pct);
            electron_1.ipcRenderer.on('db:export-progress', handler);
            return () => void electron_1.ipcRenderer.removeListener('db:export-progress', handler);
        },
        onImportProgress: (callback) => {
            const handler = (_, args) => callback(args.pct);
            electron_1.ipcRenderer.on('db:import-progress', handler);
            return () => void electron_1.ipcRenderer.removeListener('db:import-progress', handler);
        },
        getGlobalConnections: () => electron_1.ipcRenderer.invoke('db:get-global-connections'),
        setGlobalConnections: (connections) => electron_1.ipcRenderer.invoke('db:set-global-connections', { connections }),
        onToolResult: (callback) => {
            const handler = (_, payload) => callback(payload);
            electron_1.ipcRenderer.on('db:tool-result', handler);
            return () => void electron_1.ipcRenderer.removeListener('db:tool-result', handler);
        },
    },
    // License operations
    license: {
        getInfo: () => electron_1.ipcRenderer.invoke('license:get-info'),
        // Entitlement shadow diagnostics (P2 observe-only — never gates Pro).
        getEntitlementShadowStatus: () => electron_1.ipcRenderer.invoke('entitlement:shadow-status'),
        runEntitlementShadow: () => electron_1.ipcRenderer.invoke('entitlement:shadow-run'),
        getLimits: () => electron_1.ipcRenderer.invoke('license:get-limits'),
        activate: (licenseKey, email) => electron_1.ipcRenderer.invoke('license:activate', { licenseKey, email }),
        validate: () => electron_1.ipcRenderer.invoke('license:validate'),
        deactivate: () => electron_1.ipcRenderer.invoke('license:deactivate'),
        canAddProject: (currentCount) => electron_1.ipcRenderer.invoke('license:can-add-project', { currentCount }),
        canAddTerminal: (currentCount) => electron_1.ipcRenderer.invoke('license:can-add-terminal', { currentCount }),
        canAddBrowserTab: (currentCount) => electron_1.ipcRenderer.invoke('license:can-add-browser-tab', { currentCount }),
        canAddChannel: (currentCount) => electron_1.ipcRenderer.invoke('license:can-add-channel', { currentCount }),
        canAddDbConnection: (scope, currentCount) => electron_1.ipcRenderer.invoke('license:can-add-db-connection', { scope, currentCount }),
        canSaveHttpRequest: (currentCount) => electron_1.ipcRenderer.invoke('license:can-save-http-request', { currentCount }),
        canAddGitWorktree: (currentCount) => electron_1.ipcRenderer.invoke('license:can-add-git-worktree', { currentCount }),
        canUseAiDiff: () => electron_1.ipcRenderer.invoke('license:can-use-ai-diff'),
        incrementAiDiff: () => electron_1.ipcRenderer.invoke('license:increment-ai-diff'),
        onChange: (callback) => {
            const handler = (_, snapshot) => {
                callback(snapshot);
            };
            electron_1.ipcRenderer.on('license:changed', handler);
            return () => void electron_1.ipcRenderer.removeListener('license:changed', handler);
        },
    },
    // Code Tasks (tag comment scanner)
    // Tasks v2 (docs/tasks_v2.md §8.1 — P0 surface)
    tasks: {
        list: (request) => electron_1.ipcRenderer.invoke('tasks:list', request),
        errors: (projectId) => electron_1.ipcRenderer.invoke('tasks:errors', { projectId }),
        get: (id) => electron_1.ipcRenderer.invoke('tasks:get', { id }),
        create: (input) => electron_1.ipcRenderer.invoke('tasks:create', input),
        update: (input) => electron_1.ipcRenderer.invoke('tasks:update', input),
        /**
         * The board's drag gesture (§7.2). Not `update` with a status: main
         * re-evaluates the drop against holds, open gates and the file's proposal,
         * and can refuse or redirect it to the gate flow.
         */
        moveStatus: (input) => electron_1.ipcRenderer.invoke('tasks:move-status', input),
        link: (input) => electron_1.ipcRenderer.invoke('tasks:link', input),
        delete: (id) => invokeGrantedTask({ action: 'delete', id }, 'tasks:delete', { id }),
        /** The file as written. For editing policy in the UI. */
        getConfig: (repoRoot) => electron_1.ipcRenderer.invoke('tasks:config-get', { repoRoot }),
        /**
         * The policy that ACTUALLY applies: file values only once the user has
         * approved the file in the project-settings review sheet, safe defaults
         * until then (§5.1). Display it, never `getConfig`, wherever the UI claims
         * a gate is on or off.
         */
        getPolicy: (projectId, repoRoot) => electron_1.ipcRenderer.invoke('tasks:policy-get', { projectId, repoRoot }),
        setConfig: (projectId, repoRoot, patch) => invokeGrantedTask({ action: 'config-set', projectId, repoRoot, patch }, 'tasks:config-set', { projectId, repoRoot, patch }),
        refreshIndex: (projectId, repoRoot, force) => electron_1.ipcRenderer.invoke('tasks:index-refresh', { projectId, repoRoot, force }),
        bootSummary: () => electron_1.ipcRenderer.invoke('tasks:boot-summary'),
        /**
         * The exact prompt a dispatch would send. Show it, then pass its
         * fingerprint to `assign`; that click mints the action-bound capability.
         * If the task changed in between, assign fails closed (§7.3).
         */
        previewDispatch: (taskId, target, overrides) => electron_1.ipcRenderer.invoke('tasks:preview-dispatch', { taskId, target, overrides }),
        /**
         * Assignment IS dispatch (§4.7): this spawns or messages a terminal and
         * binds the resulting run to the task. Must be called from a real click —
         * main verifies the gesture itself. There is deliberately no prompt
         * parameter; main rebuilds it from the task.
         */
        assign: (taskId, target, promptFingerprint, overrides) => invokeGrantedTask({
            action: 'assign',
            taskId,
            target,
            promptFingerprint,
            ...(overrides ? { overrides } : {}),
        }, 'tasks:assign', { taskId, target, promptFingerprint, overrides }),
        /** Clears the assignment. Does not stop a live run — that is Mission Control's. */
        unassign: (taskId) => invokeGrantedTask({ action: 'unassign', taskId }, 'tasks:unassign', { taskId }),
        /**
         * Propose a task set from a goal (§4.5a). Writes NOTHING — the caller
         * reviews the proposal and creates what it accepts. It takes a live
         * terminal's next turn, so main requires a real gesture; call it straight
         * from the click.
         *
         * Main checks that the terminal exists, is live, is an interactive agent,
         * belongs to this project, and is not already claimed.
         *
         * Main ACKs as soon as it owns the run; the promise does not
         * stay pending for the agent's whole turn. Read `decomposeRuns` /
         * `decomposeRun` after a dialog remount, and use `onDecomposeChanged` as a
         * wake hint while the dialog is open.
         */
        decompose: (goal, repoRoot, options) => invokeGrantedTask({
            action: 'decompose',
            goal,
            repoRoot,
            target: options.target,
        }, 'tasks:decompose', {
            goal,
            repoRoot,
            target: options.target,
            projectId: options.projectId,
        }),
        /**
         * Reserve the exact decomposition grant before opening a terminal.
         *
         * Terminal creation crosses awaits and therefore outlives Chromium's user
         * activation. The renderer calls this synchronously from the click with a
         * future terminal id, then persists/warms that terminal and consumes the
         * same one-shot authorization through `startPreparedDecompose`.
         */
        prepareDecompose: async (goal, repoRoot, target) => {
            const minted = await mintTaskActionGrant({
                action: 'decompose',
                goal,
                repoRoot,
                target,
            });
            return minted.ok
                ? { ok: true, authorization: minted.grant }
                : minted;
        },
        startPreparedDecompose: (goal, repoRoot, options, authorization) => electron_1.ipcRenderer.invoke('tasks:decompose', {
            goal,
            repoRoot,
            target: options.target,
            projectId: options.projectId,
            grant: authorization,
        }),
        /**
         * Durable snapshots for remount/reopen. Main retains a bounded recent list
         * and marks a run accepted only after its selected task files were created.
         */
        decomposeRuns: (projectId, limit = 10) => electron_1.ipcRenderer.invoke('tasks:decompose-runs', { projectId, limit }),
        decomposeRun: (runId) => electron_1.ipcRenderer.invoke('tasks:decompose-run', { runId }),
        markDecomposeAccepted: (runId) => electron_1.ipcRenderer.invoke('tasks:decompose-accepted', { runId }),
        /**
         * Wake hint only. Subscribe before taking a snapshot and reconcile by the
         * run's monotonic revision so a late hydration result cannot roll logs
         * backward.
         */
        onDecomposeChanged: (handler) => {
            const listener = (_event, payload) => handler(payload);
            electron_1.ipcRenderer.on('tasks:decompose-changed', listener);
            return () => void electron_1.ipcRenderer.removeListener('tasks:decompose-changed', listener);
        },
        /**
         * Merge duplicates into one survivor (§4.6). The losers become tombstones
         * whose ids still resolve, because an agent may be holding an old id.
         * Gesture-gated in main; call it straight from the click.
         */
        merge: (ids, survivorId, title) => invokeGrantedTask({ action: 'merge', ids, survivorId, ...(title ? { title } : {}) }, 'tasks:merge', { ids, survivorId, title }),
        /** Open gates across every project — the review queue's source (§5.3). */
        openGates: () => electron_1.ipcRenderer.invoke('tasks:gates'),
        /**
         * The human's verdict. Gesture-gated in main: this is the channel an agent
         * must never be able to reach, so the renderer cannot fake it either.
         */
        resolveGate: (gateId, verdict, response) => invokeGrantedTask({ action: 'resolve-gate', gateId, verdict, ...(response ? { response } : {}) }, 'tasks:resolve-gate', { gateId, verdict, response }),
        onChanged: (callback) => {
            const handler = (_, payload) => callback(payload);
            electron_1.ipcRenderer.on('tasks:changed', handler);
            return () => void electron_1.ipcRenderer.removeListener('tasks:changed', handler);
        },
        onGateResolved: (callback) => {
            const handler = (_, payload) => callback(payload);
            electron_1.ipcRenderer.on('tasks:gate-resolved', handler);
            return () => void electron_1.ipcRenderer.removeListener('tasks:gate-resolved', handler);
        },
        onGateOpened: (callback) => {
            const handler = (_, payload) => callback(payload);
            electron_1.ipcRenderer.on('tasks:gate-opened', handler);
            return () => void electron_1.ipcRenderer.removeListener('tasks:gate-opened', handler);
        },
        /** Open-gate count for the status-bar badge — pushed on every transition. */
        onGateSummary: (callback) => {
            const handler = (_, payload) => callback(payload);
            electron_1.ipcRenderer.on('tasks:gate-summary', handler);
            return () => void electron_1.ipcRenderer.removeListener('tasks:gate-summary', handler);
        },
    },
    // Deployment
    deploy: {
        getConfig: (projectId) => electron_1.ipcRenderer.invoke('deploy:getConfig', { projectId }),
        list: (projectId) => electron_1.ipcRenderer.invoke('deploy:list', { projectId }),
        setConfig: (projectId, provider, config) => electron_1.ipcRenderer.invoke('deploy:setConfig', { projectId, provider, config }),
        setToken: (provider, token) => electron_1.ipcRenderer.invoke('deploy:setToken', { provider, token }),
        testToken: (request) => electron_1.ipcRenderer.invoke('deploy:testToken', request),
        verifyToken: (request) => electron_1.ipcRenderer.invoke('deploy:verifyToken', request),
        scan: (projectId) => electron_1.ipcRenderer.invoke('deploy:scan', { projectId }),
        start: (request) => electron_1.ipcRenderer.invoke('deploy:start', request),
        cancel: (deployId) => electron_1.ipcRenderer.invoke('deploy:cancel', { deployId }),
        onLog: (callback) => {
            const handler = (_, event) => callback(event);
            electron_1.ipcRenderer.on('deploy:log', handler);
            return () => void electron_1.ipcRenderer.removeListener('deploy:log', handler);
        },
    },
    // Per-project .1devtool/ settings folder
    projectSettings: {
        getStatus: (projectId) => electron_1.ipcRenderer.invoke('projectSettings:get-status', { projectId }),
        enable: (projectId) => electron_1.ipcRenderer.invoke('projectSettings:enable', { projectId }),
        disable: (projectId) => electron_1.ipcRenderer.invoke('projectSettings:disable', { projectId }),
        approve: (projectId, files) => electron_1.ipcRenderer.invoke('projectSettings:approve', { projectId, files }),
        export: (projectId) => electron_1.ipcRenderer.invoke('projectSettings:export', { projectId }),
        reload: (projectId) => electron_1.ipcRenderer.invoke('projectSettings:reload', { projectId }),
        reveal: (projectId) => electron_1.ipcRenderer.invoke('projectSettings:reveal', { projectId }),
        setSecret: (projectId, ref, plaintext) => electron_1.ipcRenderer.invoke('projectSettings:set-secret', { projectId, ref, plaintext }),
        onChanged: (callback) => {
            const handler = (_, payload) => callback(payload);
            electron_1.ipcRenderer.on('projectSettings:changed', handler);
            return () => void electron_1.ipcRenderer.removeListener('projectSettings:changed', handler);
        },
    },
    // Server Compass bundle handoff
    serverCompass: {
        detectAssets: (projectId) => electron_1.ipcRenderer.invoke('serverCompass:detectAssets', { projectId }),
        validateLocal: (projectId) => electron_1.ipcRenderer.invoke('serverCompass:validateLocal', { projectId }),
        createBundle: (input) => electron_1.ipcRenderer.invoke('serverCompass:createBundle', input),
        openInServerCompass: (input) => electron_1.ipcRenderer.invoke('serverCompass:openInServerCompass', input),
    },
    // Prompt history
    prompts: {
        save: (params) => electron_1.ipcRenderer.invoke('prompts:save', params),
        search: (params) => electron_1.ipcRenderer.invoke('prompts:search', params),
        delete: (id) => electron_1.ipcRenderer.invoke('prompts:delete', { id }),
        getProjects: () => electron_1.ipcRenderer.invoke('prompts:projects'),
        getAgents: () => electron_1.ipcRenderer.invoke('prompts:agents'),
        syncLocalData: () => electron_1.ipcRenderer.invoke('prompts:sync-local-data'),
        getLatestByTerminals: (terminalIds) => electron_1.ipcRenderer.invoke('prompts:latest-by-terminals', { terminalIds }),
    },
    // Sticky notes
    notes: {
        create: (params) => electron_1.ipcRenderer.invoke('notes:create', params),
        update: (params) => electron_1.ipcRenderer.invoke('notes:update', params),
        delete: (id) => electron_1.ipcRenderer.invoke('notes:delete', { id }),
        listForContext: (params) => electron_1.ipcRenderer.invoke('notes:list-context', params),
        search: (params) => electron_1.ipcRenderer.invoke('notes:search', params),
        getProjects: () => electron_1.ipcRenderer.invoke('notes:projects'),
    },
    // Memory (per-project agent auto-memory files plus agent-global stores)
    memory: {
        scanProjects: () => electron_1.ipcRenderer.invoke('memory:scan-projects'),
        scanEntries: (params) => electron_1.ipcRenderer.invoke('memory:scan-entries', params),
        readEntry: (filePath) => electron_1.ipcRenderer.invoke('memory:read-entry', { filePath }),
        deleteEntry: (filePath) => electron_1.ipcRenderer.invoke('memory:delete-entry', { filePath }),
        clearCache: () => electron_1.ipcRenderer.invoke('memory:clear-cache'),
        writeEntry: (filePath, content) => electron_1.ipcRenderer.invoke('memory:write-entry', { filePath, content }),
        createEntry: (args) => electron_1.ipcRenderer.invoke('memory:create-entry', args),
        copyEntry: (args) => electron_1.ipcRenderer.invoke('memory:copy-entry', args),
        appendToGlobal: (args) => electron_1.ipcRenderer.invoke('memory:append-to-global', args),
        getGraph: (projectPath) => electron_1.ipcRenderer.invoke('memory:get-graph', { projectPath }),
        getObsidianVault: () => electron_1.ipcRenderer.invoke('memory:get-obsidian-vault'),
        setObsidianVault: (path) => electron_1.ipcRenderer.invoke('memory:set-obsidian-vault', { path }),
        pickObsidianVault: () => electron_1.ipcRenderer.invoke('memory:pick-obsidian-vault'),
        openInObsidian: (filePath) => electron_1.ipcRenderer.invoke('memory:open-in-obsidian', { filePath }),
        exportToObsidianVault: (projectPath) => electron_1.ipcRenderer.invoke('memory:export-to-obsidian-vault', { projectPath }),
    },
    // Resume management
    resume: {
        scan: (params) => electron_1.ipcRenderer.invoke('resume:scan', params),
        // Recent-first fast path: returns the most-recent N sessions without parsing
        // every local session file, so the Resume dialog can paint immediately while
        // the authoritative full `scan` runs.
        scanRecent: (params) => electron_1.ipcRenderer.invoke('resume:scan-recent', params),
        getDetail: (agentType, sessionId) => electron_1.ipcRenderer.invoke('resume:get-detail', { agentType, sessionId }),
        getCommand: (agentType, sessionId) => electron_1.ipcRenderer.invoke('resume:get-command', { agentType, sessionId }),
        renameTerminalSession: (terminalId, title) => electron_1.ipcRenderer.invoke('resume:rename-terminal-session', { terminalId, title }),
        getProjects: () => electron_1.ipcRenderer.invoke('resume:get-projects'),
        clearCache: () => electron_1.ipcRenderer.invoke('resume:clear-cache'),
        detectSessionForTerminal: (terminalId, agentType, projectPath, startedAfter) => electron_1.ipcRenderer.invoke('resume:detect-session-for-terminal', { terminalId, agentType, projectPath, startedAfter }),
        detectExternal: (options) => electron_1.ipcRenderer.invoke('resume:detect-external', options),
        terminateProcess: (pid) => electron_1.ipcRenderer.invoke('resume:terminate-process', { pid }),
        listNativeTerminals: () => electron_1.ipcRenderer.invoke('resume:list-native-terminals'),
        openNativeTerminal: (args) => electron_1.ipcRenderer.invoke('resume:open-native-terminal', args),
        openInNativeTerminal: (args) => electron_1.ipcRenderer.invoke('resume:open-in-native-terminal', args),
        onTerminalSessionBound: (callback) => {
            const handler = (_, event) => callback(event);
            electron_1.ipcRenderer.on('resume:terminal-session-bound', handler);
            return () => void electron_1.ipcRenderer.removeListener('resume:terminal-session-bound', handler);
        },
    },
    // AI agent path settings (Settings → AI tab)
    aiPaths: {
        list: () => electron_1.ipcRenderer.invoke('ai-paths:list'),
        scan: (agentType, override) => electron_1.ipcRenderer.invoke('ai-paths:scan', { agentType, override }),
        getDefault: (agentType) => electron_1.ipcRenderer.invoke('ai-paths:default', { agentType }),
    },
    // AI usage tracking (Settings → AI tab, Usage section)
    aiUsage: {
        summary: (query) => electron_1.ipcRenderer.invoke('ai-usage:summary', query),
        refresh: (query) => electron_1.ipcRenderer.invoke('ai-usage:refresh', query),
        /**
         * Per-session totals, so a surface that knows which terminal owns which
         * session (Orchestration → Usage) can report usage per agent team. Shares
         * main's scan/cache with `summary` — asking for both costs one scan.
         */
        bySession: (query) => electron_1.ipcRenderer.invoke('ai-usage:by-session', query),
    },
    // AI account switching (Settings → AI tab, Accounts section)
    aiAccounts: {
        state: () => electron_1.ipcRenderer.invoke('ai-accounts:state'),
        saveCurrent: (agentType, label) => electron_1.ipcRenderer.invoke('ai-accounts:save-current', { agentType, label }),
        switch: (agentType, id) => electron_1.ipcRenderer.invoke('ai-accounts:switch', { agentType, id }),
        rename: (agentType, id, label) => electron_1.ipcRenderer.invoke('ai-accounts:rename', { agentType, id, label }),
        remove: (agentType, id) => electron_1.ipcRenderer.invoke('ai-accounts:remove', { agentType, id }),
        restorePrevious: (agentType) => electron_1.ipcRenderer.invoke('ai-accounts:restore-previous', { agentType }),
        prepareLogin: (agentType) => electron_1.ipcRenderer.invoke('ai-accounts:prepare-login', { agentType }),
        trackLoginTerminal: (agentType, terminalId) => electron_1.ipcRenderer.invoke('ai-accounts:track-login-terminal', { agentType, terminalId }),
        refreshStatuses: (agentType) => electron_1.ipcRenderer.invoke('ai-accounts:refresh-statuses', { agentType }),
        agentStatus: (agentType, force) => electron_1.ipcRenderer.invoke('ai-accounts:agent-status', { agentType, force }),
        ampQuota: () => electron_1.ipcRenderer.invoke('ai-quota:amp'),
        antigravityQuota: () => electron_1.ipcRenderer.invoke('ai-quota:antigravity'),
        grokQuota: (probe = false) => electron_1.ipcRenderer.invoke('ai-quota:grok', { probe }),
        cursorQuota: () => electron_1.ipcRenderer.invoke('ai-quota:cursor'),
        getSettings: () => electron_1.ipcRenderer.invoke('ai-accounts:get-settings'),
        setAutoSwitch: (agentType, enabled, threshold) => electron_1.ipcRenderer.invoke('ai-accounts:set-auto-switch', { agentType, enabled, threshold }),
        acceptAutoSwitchDisclaimer: () => electron_1.ipcRenderer.invoke('ai-accounts:accept-auto-switch-disclaimer'),
        setQuotaAlert: (agentType, enabled, sessionThreshold, weeklyThreshold) => electron_1.ipcRenderer.invoke('ai-accounts:set-quota-alert', { agentType, enabled, sessionThreshold, weeklyThreshold }),
        onQuotaAlert: (callback) => {
            const handler = (_, args) => {
                callback(args);
            };
            electron_1.ipcRenderer.on('ai-accounts:quota-alert', handler);
            return () => void electron_1.ipcRenderer.removeListener('ai-accounts:quota-alert', handler);
        },
        onChanged: (callback) => {
            const handler = (_, args) => {
                callback(args);
            };
            electron_1.ipcRenderer.on('ai-accounts:changed', handler);
            return () => void electron_1.ipcRenderer.removeListener('ai-accounts:changed', handler);
        },
    },
    // AI account pool (quota-center Phase 1 telemetry + Phase 2 engine).
    aiPool: {
        history: (query) => electron_1.ipcRenderer.invoke('ai-pool:history', query),
        forecast: (args) => electron_1.ipcRenderer.invoke('ai-pool:forecast', args),
        state: () => electron_1.ipcRenderer.invoke('ai-pool:state'),
        reserve: (selection) => electron_1.ipcRenderer.invoke('ai-pool:reserve', { selection }),
        cancelReservation: (reservationId) => electron_1.ipcRenderer.invoke('ai-pool:cancel-reservation', { reservationId }),
        setPolicy: (agent, policy) => electron_1.ipcRenderer.invoke('ai-pool:set-policy', { agent, policy }),
        setChain: (chain) => electron_1.ipcRenderer.invoke('ai-pool:set-chain', { chain }),
        setAccountEnabled: (agent, accountId, enabled) => electron_1.ipcRenderer.invoke('ai-pool:set-account-enabled', { agent, accountId, enabled }),
        setPlanPrice: (agent, accountId, priceUsdMonthly) => electron_1.ipcRenderer.invoke('ai-pool:set-plan-price', { agent, accountId, priceUsdMonthly }),
        journal: (args) => electron_1.ipcRenderer.invoke('ai-pool:journal', args),
        onChanged: (callback) => {
            const handler = (_, args) => callback(args);
            electron_1.ipcRenderer.on('ai-pool:changed', handler);
            return () => void electron_1.ipcRenderer.removeListener('ai-pool:changed', handler);
        },
    },
    // Skills management
    skills: {
        scanAll: (projectPath) => electron_1.ipcRenderer.invoke('skills:scan-all', { projectPath }),
        scanGlobal: () => electron_1.ipcRenderer.invoke('skills:scan-global'),
        scanProject: (projectPath) => electron_1.ipcRenderer.invoke('skills:scan-project', { projectPath }),
        read: (filePath) => electron_1.ipcRenderer.invoke('skills:read', { filePath }),
        write: (filePath, content) => electron_1.ipcRenderer.invoke('skills:write', { filePath, content }),
        create: (dir, name, tool, category) => electron_1.ipcRenderer.invoke('skills:create', { dir, name, tool, category }),
        delete: (filePath) => electron_1.ipcRenderer.invoke('skills:delete', { filePath }),
        install: (projectPath, skill, tool) => electron_1.ipcRenderer.invoke('skills:install', { projectPath, skill, tool: tool || 'claude' }),
        installOrchestratorGlobally: () => electron_1.ipcRenderer.invoke('skills:install-orchestrator-globally'),
        installViaCli: (source, skillId, projectPath, global) => electron_1.ipcRenderer.invoke('skills:install-via-cli', { source, skillId, projectPath, global }),
        exists: (projectPath, skillName, tool) => electron_1.ipcRenderer.invoke('skills:exists', { projectPath, skillName, tool }),
        checkUpdate: (skill) => electron_1.ipcRenderer.invoke('skills:check-update', { skill }),
        getReferences: (content) => electron_1.ipcRenderer.invoke('skills:get-references', { content }),
        getActive: (projectPath) => electron_1.ipcRenderer.invoke('skills:get-active', { projectPath }),
        fetchRemote: (query) => electron_1.ipcRenderer.invoke('skills:fetch-remote', { query }),
        fetchRemoteSkill: (skillPath) => electron_1.ipcRenderer.invoke('skills:fetch-remote-skill', { skillPath }),
        fetchAudited: () => electron_1.ipcRenderer.invoke('skills:fetch-audited'),
        watch: (projectPath) => electron_1.ipcRenderer.invoke('skills:watch', { projectPath }),
        unwatch: () => electron_1.ipcRenderer.invoke('skills:unwatch'),
        onChange: (callback) => {
            const handler = () => callback();
            electron_1.ipcRenderer.on('skills:changed', handler);
            return () => void electron_1.ipcRenderer.removeListener('skills:changed', handler);
        },
        // Control-plane store + per-project manifest
        storeList: () => electron_1.ipcRenderer.invoke('skills:store-list'),
        storeAdd: (skill) => electron_1.ipcRenderer.invoke('skills:store-add', { skill }),
        storeRemove: (name, version) => electron_1.ipcRenderer.invoke('skills:store-remove', { name, version }),
        storeRead: (name, version) => electron_1.ipcRenderer.invoke('skills:store-read', { name, version }),
        manifestGet: (projectPath) => electron_1.ipcRenderer.invoke('skills:manifest-get', { projectPath }),
        manifestSet: (projectPath, manifest) => electron_1.ipcRenderer.invoke('skills:manifest-set', { projectPath, manifest }),
        manifestPlan: (projectPath) => electron_1.ipcRenderer.invoke('skills:manifest-plan', { projectPath }),
        manifestApply: (projectPath, options) => electron_1.ipcRenderer.invoke('skills:manifest-apply', { projectPath, options }),
    },
    // Orchestration. Renderer reads the shim path here at app boot, caches it,
    // and feeds it to expandSpawnBlocksForSend. The dashboard methods below
    // never accept filesystem paths — main derives every path from validated
    // ids (docs/features/orchestration/dashboard.md §7).
    orchestration: {
        getShimPath: () => electron_1.ipcRenderer.invoke('orchestration:get-shim-path'),
        getNotifyChainStatus: () => electron_1.ipcRenderer.invoke('orchestration:notify-chain-status'),
        listActive: () => electron_1.ipcRenderer.invoke('orchestration:list-active'),
        listWorkspaceRoster: (workspaceId, callerProjectId) => electron_1.ipcRenderer.invoke('orchestration:list-workspace-roster', { workspaceId, callerProjectId }),
        getRuntimeConfig: () => electron_1.ipcRenderer.invoke('orchestration:get-runtime-config'),
        setRuntimeConfig: (config) => electron_1.ipcRenderer.invoke('orchestration:set-runtime-config', { config }),
        listHarnesses: () => electron_1.ipcRenderer.invoke('orchestration:harnesses'),
        probeHarness: (harnessId, force = false) => electron_1.ipcRenderer.invoke('orchestration:probe-harness', { harnessId, force }),
        getRuntimeEvents: (runId, epoch, afterSeq = 0) => electron_1.ipcRenderer.invoke('orchestration:runtime-events', { runId, epoch, afterSeq }),
        resolveRuntimeInteraction: (args) => electron_1.ipcRenderer.invoke('orchestration:resolve-runtime-interaction', args),
        stopActive: (orchestrationId, closeTerminals = false, finishRunning = false) => electron_1.ipcRenderer.invoke('orchestration:stop-active', { orchestrationId, closeTerminals, finishRunning }),
        setSwarmPaused: (swarmId, paused) => electron_1.ipcRenderer.invoke('orchestration:set-swarm-paused', { swarmId, paused }),
        confirmSubmit: (runId) => electron_1.ipcRenderer.invoke('orchestration:confirm-submit', { runId }),
        sendToMember: (teamId, memberId, submissionId, prompt) => electron_1.ipcRenderer.invoke('orchestration:team-send', { teamId, memberId, submissionId, prompt }),
        getTeamMessages: (teamId, cursor = 0, limit = 50) => electron_1.ipcRenderer.invoke('orchestration:team-messages', { teamId, cursor, limit }),
        getTeamConnections: (teamId) => electron_1.ipcRenderer.invoke('orchestration:team-connections', { teamId }),
        setTeamConnections: (teamId, connections) => electron_1.ipcRenderer.invoke('orchestration:set-team-connections', { teamId, connections }),
        resumeTeamMember: (teamId, memberId) => electron_1.ipcRenderer.invoke('orchestration:resume-team-member', { teamId, memberId }),
        // Terminal Links (orchestration v4 L1). mintGesture must be called from a
        // real user submit gesture; ensureLink consumes the one-shot token.
        mintGesture: (terminalId, projectId, draftHash) => electron_1.ipcRenderer.invoke('orchestration:mint-gesture', { terminalId, projectId, draftHash }),
        /**
         * Creates the delegation edge AND the reply edge back. `reverse` reports
         * whether a send-capable path home actually exists — the host's send-time
         * nudge only promises "their answer arrives here" when it does.
         */
        ensureLink: (args) => electron_1.ipcRenderer.invoke('orchestration:ensure-link', args),
        listLinks: (projectId) => electron_1.ipcRenderer.invoke('orchestration:list-links', { projectId }),
        /** Session-team groups (linked-terminal orchestration) for Resume surfaces. */
        listSessionTeams: () => electron_1.ipcRenderer.invoke('orchestration:list-session-teams'),
        /** Leaderless swarm decisions for this project (read-only view). */
        listDecisions: (projectId) => electron_1.ipcRenderer.invoke('orchestration:list-decisions', { projectId }),
        /** Human escape hatch for a decision that can never reach quorum. */
        cancelDecision: (decisionId) => electron_1.ipcRenderer.invoke('orchestration:cancel-decision', { decisionId }),
        /** Body-free link message rows (states only) for awaiting-reply counts. */
        listLinkMessages: (projectId) => electron_1.ipcRenderer.invoke('orchestration:list-link-messages', { projectId }),
        listLinkRequests: (projectId) => electron_1.ipcRenderer.invoke('orchestration:list-link-requests', { projectId }),
        updateLink: (linkId, patch) => electron_1.ipcRenderer.invoke('orchestration:update-link', { linkId, ...patch }),
        previewReadConsent: (args) => electron_1.ipcRenderer.invoke('orchestration:preview-read-consent', args),
        resolveLinkRequest: (requestId, approve, readConsent) => electron_1.ipcRenderer.invoke('orchestration:resolve-link-request', { requestId, approve, readConsent }),
        resolveLinkMessage: (messageId, approve) => electron_1.ipcRenderer.invoke('orchestration:resolve-link-message', { messageId, approve }),
        ensureLinkExplicit: (fromTerminalId, toTerminalId) => electron_1.ipcRenderer.invoke('orchestration:ensure-link-explicit', { fromTerminalId, toTerminalId }),
        unlink: (linkId) => electron_1.ipcRenderer.invoke('orchestration:unlink', { linkId }),
        /** Batch unlink ("Clear all quarantined") — one gesture, one round trip. */
        unlinkMany: (linkIds) => electron_1.ipcRenderer.invoke('orchestration:unlink', { linkIds }),
        /** Revive a quarantined link by re-binding its pair to current endpoints. */
        relink: (linkId, readConsent) => electron_1.ipcRenderer.invoke('orchestration:relink', { linkId, readConsent }),
        /**
         * Un-strand a delegation delivered with no reply edge: mints the edge back
         * and tells the peer holding the finished answer how to send it.
         */
        restoreReplyLink: (messageId) => electron_1.ipcRenderer.invoke('orchestration:restore-reply-link', { messageId }),
        /**
         * Remind a peer that owes an answer (reply edge exists, peer just never
         * sent) — types the exact `--reply-to` command into it. Gesture-gated.
         */
        nudgeReply: (messageId) => electron_1.ipcRenderer.invoke('orchestration:nudge-reply', { messageId }),
        /**
         * Stop waiting on a delegation that will never be answered (its own body
         * said "do not reply", the answer was relayed by hand, the plan changed).
         * Bookkeeping only — nothing is sent to any terminal. Gesture-gated.
         */
        closeMessage: (messageId) => electron_1.ipcRenderer.invoke('orchestration:close-message', { messageId }),
        /**
         * Resume an interrupted orchestration: relink every revivable quarantined
         * link touching the project and deliver one wake-up notice per terminal
         * (reply reminders for owed answers, status-board nudge for waiting hosts).
         */
        resumeOrchestration: (projectId) => electron_1.ipcRenderer.invoke('orchestration:resume-orchestration', { projectId }),
        onLinkMessageState: (callback) => {
            const handler = (_e, args) => callback(args);
            electron_1.ipcRenderer.on('links:message-state', handler);
            return () => {
                electron_1.ipcRenderer.removeListener('links:message-state', handler);
            };
        },
        getContextUsage: (terminalId) => electron_1.ipcRenderer.invoke('orchestration:context-usage', { terminalId }),
        onLinkActivity: (callback) => {
            const handler = (_e, args) => {
                callback(args);
            };
            electron_1.ipcRenderer.on('links:activity', handler);
            return () => {
                electron_1.ipcRenderer.removeListener('links:activity', handler);
            };
        },
        onAttentionEvent: (callback) => {
            const handler = (_e, args) => callback(args);
            electron_1.ipcRenderer.on('app:attention-event', handler);
            return () => {
                electron_1.ipcRenderer.removeListener('app:attention-event', handler);
            };
        },
        resolveConfirmation: (runId, outcome) => electron_1.ipcRenderer.invoke('orchestration:resolve-confirmation', { runId, outcome }),
        resolveFallback: (runId, action, target) => electron_1.ipcRenderer.invoke('orchestration:resolve-fallback', { runId, action, target }),
        promoteWorker: (swarmId, workerId) => electron_1.ipcRenderer.invoke('orchestration:promote-worker', { swarmId, workerId }),
        onStateChanged: (callback) => {
            const handler = () => callback();
            electron_1.ipcRenderer.on('orchestration:state-changed', handler);
            return () => void electron_1.ipcRenderer.removeListener('orchestration:state-changed', handler);
        },
        // Lazy per-agent model catalog for @mention delegation; `refresh` forces
        // a re-probe of enumerable CLIs (Settings → AI → Orchestration).
        getAgentModels: (opts) => electron_1.ipcRenderer.invoke('orchestration:agent-models', opts ?? {}),
        // Routing policy (draft/apply)
        getPolicy: () => electron_1.ipcRenderer.invoke('orchestration:get-policy'),
        setPolicy: (draft) => electron_1.ipcRenderer.invoke('orchestration:set-policy', { draft }),
        applyPolicy: (args) => electron_1.ipcRenderer.invoke('orchestration:apply-policy', args ?? {}),
        skillStatus: () => electron_1.ipcRenderer.invoke('orchestration:skill-status'),
        previewSkillSection: (draft) => electron_1.ipcRenderer.invoke('orchestration:preview-skill-section', { draft }),
        readSkill: (target) => electron_1.ipcRenderer.invoke('orchestration:read-skill', { target }),
        // Hierarchy chart + activation (orchestration v5)
        getHierarchy: () => electron_1.ipcRenderer.invoke('orchestration:get-hierarchy'),
        setHierarchy: (chart) => electron_1.ipcRenderer.invoke('orchestration:set-hierarchy', { chart }),
        applyHierarchy: () => electron_1.ipcRenderer.invoke('orchestration:apply-hierarchy'),
        previewHierarchyNudges: (chart) => electron_1.ipcRenderer.invoke('orchestration:preview-hierarchy-nudges', { chart }),
        activateHierarchy: (args) => electron_1.ipcRenderer.invoke('orchestration:activate-hierarchy', args),
        /** Prompt-derived activation. Pipeline is fail-closed and accepts only
         * ordered live stage references; generations/edges/hashes stay in main. */
        activatePromptChain: (args) => electron_1.ipcRenderer.invoke('orchestration:activate-prompt-chain', args),
        deactivateHierarchy: (projectId) => electron_1.ipcRenderer.invoke('orchestration:deactivate-hierarchy', { projectId }),
        hierarchyStatus: (projectId) => electron_1.ipcRenderer.invoke('orchestration:hierarchy-status', { projectId }),
        resolvePipelineRun: (projectId) => electron_1.ipcRenderer.invoke('orchestration:resolve-pipeline-run', { projectId }),
        /** Repair a vacant seat. Without a terminalId, `spawn` launches the
         * seat's default CLI and `startupPresetId` launches that saved AI
         * command — spawn + PTY wait + rebind stay one gesture-gated call, so
         * a run whose terminals were all closed can be relaunched from the
         * seat table instead of dead-ending on an empty picker. */
        rebindSeat: (args) => electron_1.ipcRenderer.invoke('orchestration:rebind-seat', args),
        promoteSeat: (args) => electron_1.ipcRenderer.invoke('orchestration:promote-seat', args),
        // Content-capture consent + retention (config.json is the source of truth)
        getConfig: () => electron_1.ipcRenderer.invoke('orchestration:get-config'),
        setConfig: (config) => electron_1.ipcRenderer.invoke('orchestration:set-config', { config }),
        // Run records (id-based; served statuses include derived 'interrupted')
        listRuns: (query) => electron_1.ipcRenderer.invoke('orchestration:list-runs', query ?? {}),
        getRunFile: (callId, file) => electron_1.ipcRenderer.invoke('orchestration:get-run-file', { callId, file }),
        deleteRun: (callId) => electron_1.ipcRenderer.invoke('orchestration:delete-run', { callId }),
        clearRuns: () => electron_1.ipcRenderer.invoke('orchestration:clear-runs', {}),
        /** Bundle run folders (+ orchestration.log) into a shareable zip via a
         *  native save dialog. No ids = export the whole runs/ folder. */
        exportRuns: (callIds) => electron_1.ipcRenderer.invoke('orchestration:export-runs', { callIds }),
        /** Export the active Team/Swarm/link scope for one Mission Control project:
         *  relevant run records, orchestration.log, and every live participant's
         *  bounded terminal transcript. Main re-derives all terminal ids. */
        exportCurrentLogs: (projectId) => electron_1.ipcRenderer.invoke('orchestration:export-current-logs', { projectId }),
        revealRunFile: (args) => electron_1.ipcRenderer.invoke('orchestration:reveal-run-file', args),
        readAppLog: (maxBytes) => electron_1.ipcRenderer.invoke('orchestration:read-app-log', { id: 'orchestration', maxBytes }),
        onRunsChanged: (callback) => {
            const handler = () => callback();
            electron_1.ipcRenderer.on('orchestration:runs-changed', handler);
            return () => void electron_1.ipcRenderer.removeListener('orchestration:runs-changed', handler);
        },
        // Dashboard-open lifecycle: while subscribed, main polls run records
        // every 3 s (the primary refresh — see §4.3).
        subscribeRuns: () => electron_1.ipcRenderer.invoke('orchestration:subscribe-runs'),
        unsubscribeRuns: () => electron_1.ipcRenderer.invoke('orchestration:unsubscribe-runs'),
    },
    // gstack integration
    gstack: {
        getStatus: () => electron_1.ipcRenderer.invoke('gstack:get-status'),
        checkPrerequisites: () => electron_1.ipcRenderer.invoke('gstack:check-prerequisites'),
        install: () => electron_1.ipcRenderer.invoke('gstack:install'),
        update: () => electron_1.ipcRenderer.invoke('gstack:update'),
        getSkills: () => electron_1.ipcRenderer.invoke('gstack:get-skills'),
        checkForUpdate: () => electron_1.ipcRenderer.invoke('gstack:check-update'),
        onInstallLog: (callback) => {
            const handler = (_, args) => {
                callback(args.data);
            };
            electron_1.ipcRenderer.on('gstack:install-log', handler);
            return () => void electron_1.ipcRenderer.removeListener('gstack:install-log', handler);
        },
    },
    // Store operations
    store: {
        get: (key) => electron_1.ipcRenderer.invoke('store:get', { key }),
        set: (key, value) => electron_1.ipcRenderer.invoke('store:set', { key, value }),
        getProjects: () => electron_1.ipcRenderer.invoke('store:get-projects'),
        saveProject: (project) => electron_1.ipcRenderer.invoke('store:save-project', project),
        renameProject: (projectId, name, options) => electron_1.ipcRenderer.invoke('store:rename-project', {
            projectId,
            name,
            renameFolder: options?.renameFolder === true,
        }),
        setProjectHttpTabs: (projectId, tabs) => electron_1.ipcRenderer.invoke('store:set-project-http-tabs', { projectId, tabs }),
        deleteProject: (id) => electron_1.ipcRenderer.invoke('store:delete-project', { id }),
        setProjectOrder: (order) => electron_1.ipcRenderer.invoke('store:set-project-order', order),
        getProjectGroups: () => electron_1.ipcRenderer.invoke('store:get-project-groups'),
        saveProjectGroup: (group) => electron_1.ipcRenderer.invoke('store:save-project-group', group),
        deleteProjectGroup: (id) => electron_1.ipcRenderer.invoke('store:delete-project-group', { id }),
        setProjectGroupOrder: (order) => electron_1.ipcRenderer.invoke('store:set-project-group-order', order),
        getProjectRootOrder: () => electron_1.ipcRenderer.invoke('store:get-project-root-order'),
        setProjectRootOrder: (order) => electron_1.ipcRenderer.invoke('store:set-project-root-order', order),
        getPreferences: () => electron_1.ipcRenderer.invoke('store:get-preferences'),
        setPreferences: (preferences) => electron_1.ipcRenderer.invoke('store:set-preferences', preferences),
        updatePreference: (path, value) => electron_1.ipcRenderer.invoke('store:update-preference', path, value),
    },
    // Workspace Control (docs/workspace_control/06-ipc-mcp-cli.md §3) —
    // human-only CRUD over WorkspaceService; agents never enter through here.
    workspace: {
        list: (options) => electron_1.ipcRenderer.invoke('workspace:list', options),
        get: (id) => electron_1.ipcRenderer.invoke('workspace:get', { id }),
        resolve: (id, purpose) => electron_1.ipcRenderer.invoke('workspace:resolve', { id, purpose }),
        create: (input) => electron_1.ipcRenderer.invoke('workspace:create', input),
        update: (id, patch) => electron_1.ipcRenderer.invoke('workspace:update', { id, patch }),
        delete: (id) => electron_1.ipcRenderer.invoke('workspace:delete', { id }),
        setOrder: (order) => electron_1.ipcRenderer.invoke('workspace:set-order', { order }),
        setProjectPreference: (projectId, workspaceId) => electron_1.ipcRenderer.invoke('workspace:set-project-preference', { projectId, workspaceId }),
        getProjectPreference: () => electron_1.ipcRenderer.invoke('workspace:get-project-preference', {}),
        forProject: (projectId) => electron_1.ipcRenderer.invoke('workspace:for-project', { projectId }),
        onChanged: (callback) => {
            const handler = (_, payload) => callback(payload);
            electron_1.ipcRenderer.on('workspace:changed', handler);
            return () => void electron_1.ipcRenderer.removeListener('workspace:changed', handler);
        },
    },
    appConfig: {
        export: () => electron_1.ipcRenderer.invoke('app-config:export'),
        selectImportFile: () => electron_1.ipcRenderer.invoke('app-config:select-import-file'),
        previewImport: (filePath) => electron_1.ipcRenderer.invoke('app-config:preview-import', { filePath }),
        applyImport: (request) => electron_1.ipcRenderer.invoke('app-config:apply-import', request),
    },
    // Theme management
    theme: {
        getCustomThemes: () => electron_1.ipcRenderer.invoke('theme:get-custom-themes'),
        saveCustomTheme: (theme) => electron_1.ipcRenderer.invoke('theme:save-custom-theme', theme),
        deleteCustomTheme: (id) => electron_1.ipcRenderer.invoke('theme:delete-custom-theme', id),
        importVSCodeFile: () => electron_1.ipcRenderer.invoke('theme:import-vscode-file'),
    },
    // App operations
    app: {
        getPlatform: () => electron_1.ipcRenderer.invoke('app:get-platform'),
        getHomedir: () => electron_1.ipcRenderer.invoke('app:get-homedir'),
        getDefaultShell: () => electron_1.ipcRenderer.invoke('app:get-default-shell'),
        openExternal: (url) => electron_1.ipcRenderer.invoke('app:open-external', { url }),
        openPathExternal: (path) => electron_1.ipcRenderer.invoke('app:open-path-external', { path }),
        lookUpDictionary: (text) => electron_1.ipcRenderer.invoke('app:look-up-dictionary', { text }),
        getDictionaryDefinition: (text) => electron_1.ipcRenderer.invoke('app:dictionary-definition', { text }),
        setFullScreen: (isFullScreen) => electron_1.ipcRenderer.invoke('app:set-full-screen', { isFullScreen }),
        setWindowButtonsVisibility: (visible) => electron_1.ipcRenderer.invoke('app:set-window-buttons-visibility', { visible }),
        copyText: (text) => electron_1.ipcRenderer.invoke('app:copy-text', { text }),
        copyImageFromDataUrl: (dataUrl) => electron_1.ipcRenderer.invoke('app:copy-image-from-data-url', { dataUrl }),
        paste: () => electron_1.ipcRenderer.invoke('app:paste'),
        saveImageFromDataUrl: (dataUrl, projectId, suggestedName) => electron_1.ipcRenderer.invoke('app:save-image-from-data-url', { dataUrl, projectId, suggestedName }),
        exportSaveDialog: (args) => electron_1.ipcRenderer.invoke('app:export-save-dialog', args),
        relaunch: () => electron_1.ipcRenderer.invoke('app:relaunch'),
        setUiScale: (scale) => electron_1.ipcRenderer.invoke('app:set-ui-scale', { scale }),
        popoutTerminal: (terminalId, projectId) => electron_1.ipcRenderer.invoke('app:popout-terminal', { terminalId, projectId }),
        anchorTerminal: (terminalId) => electron_1.ipcRenderer.invoke('app:anchor-terminal', { terminalId }),
        getPopoutParams: () => {
            const params = new URLSearchParams(window.location.search);
            const terminalId = params.get('popout');
            const projectId = params.get('projectId');
            if (terminalId && projectId)
                return { terminalId, projectId };
            return null;
        },
        onPopoutClosed: (callback) => {
            const handler = (_, args) => callback(args.terminalId);
            electron_1.ipcRenderer.on('app:popout-closed', handler);
            return () => { electron_1.ipcRenderer.removeListener('app:popout-closed', handler); };
        },
        getTheme: () => electron_1.ipcRenderer.invoke('app:get-theme'),
        onThemeChange: (callback) => {
            const handler = (_, args) => {
                callback(args.theme);
            };
            electron_1.ipcRenderer.on('app:theme-changed', handler);
            return () => void electron_1.ipcRenderer.removeListener('app:theme-changed', handler);
        },
        onUiScaleChange: (callback) => {
            const handler = (_, args) => {
                callback(args.scale);
            };
            electron_1.ipcRenderer.on('app:ui-scale-changed', handler);
            return () => void electron_1.ipcRenderer.removeListener('app:ui-scale-changed', handler);
        },
        onWebviewZoomShortcut: (callback) => {
            const handler = (_, direction) => {
                callback(direction);
            };
            electron_1.ipcRenderer.on('app:webview-zoom-shortcut', handler);
            return () => void electron_1.ipcRenderer.removeListener('app:webview-zoom-shortcut', handler);
        },
        onWebviewShortcut: (callback) => {
            const handler = (_, action) => {
                callback(action);
            };
            electron_1.ipcRenderer.on('app:webview-shortcut', handler);
            return () => void electron_1.ipcRenderer.removeListener('app:webview-shortcut', handler);
        },
        onNavigateToTerminal: (callback) => {
            const handler = (_, args) => {
                callback(args);
            };
            electron_1.ipcRenderer.on('app:navigate-to-terminal', handler);
            return () => void electron_1.ipcRenderer.removeListener('app:navigate-to-terminal', handler);
        },
        onActivityTerminalEvent: (callback) => {
            const handler = (_, args) => {
                callback(args);
            };
            electron_1.ipcRenderer.on('app:activity-terminal-event', handler);
            return () => void electron_1.ipcRenderer.removeListener('app:activity-terminal-event', handler);
        },
        onOpenSettings: (callback) => {
            const handler = (_, payload) => {
                callback(payload);
            };
            electron_1.ipcRenderer.on('app:open-settings', handler);
            return () => void electron_1.ipcRenderer.removeListener('app:open-settings', handler);
        },
        onMenuCommand: (callback) => {
            const handler = (_, command) => {
                callback(command);
            };
            electron_1.ipcRenderer.on('app:menu-command', handler);
            return () => void electron_1.ipcRenderer.removeListener('app:menu-command', handler);
        },
        onOpenUpdates: (callback) => {
            electron_1.ipcRenderer.on('app:open-updates', callback);
            return () => void electron_1.ipcRenderer.removeListener('app:open-updates', callback);
        },
        consumePendingDeepLink: () => electron_1.ipcRenderer.invoke('app:consume-pending-deeplink'),
        onDeepLinkAvailable: (callback) => {
            electron_1.ipcRenderer.on('app:deeplink-available', callback);
            return () => void electron_1.ipcRenderer.removeListener('app:deeplink-available', callback);
        },
        consumePendingOpenFiles: () => electron_1.ipcRenderer.invoke('app:consume-pending-open-files'),
        onOpenFilesAvailable: (callback) => {
            electron_1.ipcRenderer.on('app:file-open-available', callback);
            return () => void electron_1.ipcRenderer.removeListener('app:file-open-available', callback);
        },
        debugRouteDeepLink: (url) => electron_1.ipcRenderer.invoke('app:debug-route-deeplink', url),
        captureScreen: () => electron_1.ipcRenderer.invoke('app:capture-screen'),
        capturePage: () => electron_1.ipcRenderer.invoke('app:capture-page'),
        onWebviewNewWindow: (callback) => {
            const handler = (_, url) => callback(url);
            electron_1.ipcRenderer.on('webview-new-window', handler);
            return () => void electron_1.ipcRenderer.removeListener('webview-new-window', handler);
        },
        onWebviewHttpAuth: (callback) => {
            const handler = (_, request) => callback(request);
            electron_1.ipcRenderer.on('webview-http-auth', handler);
            return () => void electron_1.ipcRenderer.removeListener('webview-http-auth', handler);
        },
        respondWebviewHttpAuth: (response) => electron_1.ipcRenderer.send('webview-http-auth-response', response),
        onQuitConfirm: (callback) => {
            const handler = (_, request) => {
                // Ack immediately so main knows a dialog will actually show; without a
                // mounted listener main falls back to the native prompt after a beat.
                electron_1.ipcRenderer.send('app:quit-confirm-ack', request.requestId);
                callback(request);
            };
            electron_1.ipcRenderer.on('app:quit-confirm', handler);
            return () => void electron_1.ipcRenderer.removeListener('app:quit-confirm', handler);
        },
        onQuitConfirmDismiss: (callback) => {
            const handler = (_, requestId) => callback(requestId);
            electron_1.ipcRenderer.on('app:quit-confirm-dismiss', handler);
            return () => void electron_1.ipcRenderer.removeListener('app:quit-confirm-dismiss', handler);
        },
        respondQuitConfirm: (response) => electron_1.ipcRenderer.send('app:quit-confirm-response', response),
    },
    // Live in-app BrowserPanel automation. The renderer only claims which
    // project/tab owns a webview id; main verifies the guest/host relationship
    // before exposing it to the unified MCP bridge.
    browserAutomation: {
        registerGuest: (request) => electron_1.ipcRenderer.invoke('browser-automation:register-guest', request),
        unregisterGuest: (request) => electron_1.ipcRenderer.send('browser-automation:unregister-guest', request),
        onUiRequest: (callback) => {
            const handler = (_event, request) => callback(request);
            electron_1.ipcRenderer.on('browser-automation:ui-request', handler);
            return () => void electron_1.ipcRenderer.removeListener('browser-automation:ui-request', handler);
        },
        respondUiRequest: (response) => electron_1.ipcRenderer.send('browser-automation:ui-response', response),
    },
    // Dialog operations
    dialog: {
        selectFolder: () => electron_1.ipcRenderer.invoke('dialog:select-folder'),
        selectFiles: () => electron_1.ipcRenderer.invoke('dialog:select-files'),
        selectDatabaseFile: () => electron_1.ipcRenderer.invoke('dialog:select-database-file'),
        selectImage: () => electron_1.ipcRenderer.invoke('dialog:select-image'),
        importFont: () => electron_1.ipcRenderer.invoke('dialog:import-font'),
        readFontFile: (fontPath) => electron_1.ipcRenderer.invoke('dialog:read-font-file', fontPath),
        deleteFont: (fontPath) => electron_1.ipcRenderer.invoke('dialog:delete-font', fontPath),
    },
    // Web utilities (File.path is unavailable with contextIsolation: true)
    webUtils: {
        getPathForFile: (file) => electron_1.webUtils.getPathForFile(file),
    },
    // Remote control operations
    remote: {
        start: () => electron_1.ipcRenderer.invoke('remote:start'),
        stop: () => electron_1.ipcRenderer.invoke('remote:stop'),
        status: () => electron_1.ipcRenderer.invoke('remote:status'),
        getQR: () => electron_1.ipcRenderer.invoke('remote:get-qr'),
        getPairingUrl: () => electron_1.ipcRenderer.invoke('remote:get-pairing-url'),
        /** Rotate to a fresh pairing secret + URL. Invalidates any previously
         *  copied/displayed URL. Used by the explicit "Refresh QR Code" button. */
        rotatePairing: () => electron_1.ipcRenderer.invoke('remote:rotate-pairing'),
        getDevices: () => electron_1.ipcRenderer.invoke('remote:get-devices'),
        /** How long idle devices stay paired: days, or 'never' (until revoked). */
        getPairingTtl: () => electron_1.ipcRenderer.invoke('remote:get-pairing-ttl'),
        /** Change the pairing TTL; re-extends every currently-paired device. */
        setPairingTtl: (setting) => electron_1.ipcRenderer.invoke('remote:set-pairing-ttl', setting),
        revokeDevice: (deviceId) => electron_1.ipcRenderer.invoke('remote:revoke-device', deviceId),
        /** Revoke every paired device at once. Resolves with the count removed. */
        revokeAllDevices: () => electron_1.ipcRenderer.invoke('remote:revoke-all-devices'),
        setPermission: (deviceId, level) => electron_1.ipcRenderer.invoke('remote:set-permission', deviceId, level),
        getAuditLog: (limit) => electron_1.ipcRenderer.invoke('remote:get-audit-log', limit),
        onStatusChange: (callback) => {
            const handler = (_, status) => callback(status);
            electron_1.ipcRenderer.on('remote:status-change', handler);
            return () => void electron_1.ipcRenderer.removeListener('remote:status-change', handler);
        },
        /** Per-terminal size-authority transitions: a phone taking or releasing
         *  PTY dims ownership. Feeds the terminal pane's "Sized for phone" badge;
         *  hydrate initial state via pty.getRemoteSizeAuthority. */
        onSizeAuthorityChanged: (callback) => {
            const handler = (_, change) => callback(change);
            electron_1.ipcRenderer.on('remote:size-authority-changed', handler);
            return () => void electron_1.ipcRenderer.removeListener('remote:size-authority-changed', handler);
        },
        // Remote phone requests a terminal create, PTY spawn, or close. Renderer
        // is the source of truth for projectStore: it adds/removes records and
        // spawns PTYs via the standard pty:create path.
        onCreateTerminalRequest: (callback) => {
            const handler = (_, req) => callback(req);
            electron_1.ipcRenderer.on('remote:create-terminal-request', handler);
            return () => void electron_1.ipcRenderer.removeListener('remote:create-terminal-request', handler);
        },
        respondCreateTerminal: (response) => electron_1.ipcRenderer.send('remote:create-terminal-response', response),
        // Signal that the main window's <App> has attached its remote IPC listener
        // AND hydrated projectStore. The main process gates remote terminal-create
        // dispatch on this so a freshly recreated window cannot race projects=[].
        notifyRendererReady: () => electron_1.ipcRenderer.send('remote:renderer-ready'),
        // Main re-probes before a create/spawn/close request. A one-shot ready
        // latch can be cleared by a later Electron loading event (notably WebKit
        // remote flows while Browser panels are alive), so App re-confirms its
        // listener + hydrated store on demand.
        onRendererReadyProbe: (callback) => {
            const handler = () => callback();
            electron_1.ipcRenderer.on('remote:renderer-ready-probe', handler);
            return () => void electron_1.ipcRenderer.removeListener('remote:renderer-ready-probe', handler);
        },
    },
    // Cloudflare Tunnel — exposes the remote server over the public internet
    // via a lazy-downloaded `cloudflared` quick tunnel. See src/main/cloudflared/.
    tunnel: {
        install: {
            status: () => electron_1.ipcRenderer.invoke('tunnel:install-status'),
            download: () => electron_1.ipcRenderer.invoke('tunnel:install'),
            cancel: () => electron_1.ipcRenderer.invoke('tunnel:install-cancel'),
            remove: () => electron_1.ipcRenderer.invoke('tunnel:remove'),
        },
        start: () => electron_1.ipcRenderer.invoke('tunnel:start'),
        stop: () => electron_1.ipcRenderer.invoke('tunnel:stop'),
        status: () => electron_1.ipcRenderer.invoke('tunnel:status'),
        onInstallProgress: (callback) => {
            const handler = (_, p) => callback(p);
            electron_1.ipcRenderer.on('tunnel:install-progress', handler);
            return () => void electron_1.ipcRenderer.removeListener('tunnel:install-progress', handler);
        },
        onEvent: (callback) => {
            const handler = (_, ev) => callback(ev);
            electron_1.ipcRenderer.on('tunnel:event', handler);
            return () => void electron_1.ipcRenderer.removeListener('tunnel:event', handler);
        },
    },
    // Tailscale / VPN connection mode — detect + Serve HTTPS reverse-proxy so
    // Safari/mobile get a trusted https://*.ts.net URL (plain http://100.x is
    // torn down by Safari). See src/main/tailscale/.
    tailscale: {
        status: (force) => electron_1.ipcRenderer.invoke('tailscale:status', force),
        enable: () => electron_1.ipcRenderer.invoke('tailscale:enable'),
        disable: () => electron_1.ipcRenderer.invoke('tailscale:disable'),
        onEvent: (callback) => {
            const handler = (_, ev) => callback(ev);
            electron_1.ipcRenderer.on('tailscale:event', handler);
            return () => void electron_1.ipcRenderer.removeListener('tailscale:event', handler);
        },
    },
    // Simulator / Mobile Emulator
    simulator: {
        detectToolchains: () => electron_1.ipcRenderer.invoke('simulator:detect-toolchains'),
        list: (platform) => electron_1.ipcRenderer.invoke('simulator:list', { platform }),
        boot: (platform, deviceId) => electron_1.ipcRenderer.invoke('simulator:boot', { platform, deviceId }),
        shutdown: (platform, deviceId) => electron_1.ipcRenderer.invoke('simulator:shutdown', { platform, deviceId }),
        install: (platform, deviceId, appPath) => electron_1.ipcRenderer.invoke('simulator:install', { platform, deviceId, appPath }),
        openUrl: (platform, deviceId, url) => electron_1.ipcRenderer.invoke('simulator:open-url', { platform, deviceId, url }),
        buildAndRunIOS: (projectRoot, deviceId, options) => electron_1.ipcRenderer.invoke('simulator:build-and-run-ios', { projectRoot, deviceId, options }),
        buildAndRunAndroid: (projectRoot, deviceId, options) => electron_1.ipcRenderer.invoke('simulator:build-and-run-android', { projectRoot, deviceId, options }),
        sendInput: (platform, deviceId, event) => electron_1.ipcRenderer.invoke('simulator:send-input', { platform, deviceId, event }),
        startStream: (platform, deviceId) => electron_1.ipcRenderer.invoke('simulator:start-stream', { platform, deviceId }),
        setDimensions: (platform, deviceId, width, height) => electron_1.ipcRenderer.invoke('simulator:set-dimensions', { platform, deviceId, width, height }),
        wdaHost: (host) => electron_1.ipcRenderer.invoke('simulator:wda-host', { host }),
        wdaCommand: (deviceId, command, args) => electron_1.ipcRenderer.invoke('simulator:wda-command', { deviceId, command, ...args }),
        androidCommand: (deviceId, command, args) => electron_1.ipcRenderer.invoke('simulator:android-command', { deviceId, command, ...args }),
        anchor: (x, y) => electron_1.ipcRenderer.invoke('simulator:anchor', { x, y }),
        reposition: (x, y) => electron_1.ipcRenderer.invoke('simulator:reposition', { x, y }),
        hideWindow: () => electron_1.ipcRenderer.invoke('simulator:hide-window'),
        showWindow: () => electron_1.ipcRenderer.invoke('simulator:show-window'),
        unfloat: () => electron_1.ipcRenderer.invoke('simulator:unfloat'),
        stopStream: (deviceId) => electron_1.ipcRenderer.invoke('simulator:stop-stream', { deviceId }),
        onStreamData: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('simulator:stream-data', handler);
            return () => void electron_1.ipcRenderer.removeListener('simulator:stream-data', handler);
        },
        onStreamError: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('simulator:stream-error', handler);
            return () => void electron_1.ipcRenderer.removeListener('simulator:stream-error', handler);
        },
        onStreamExit: (callback) => {
            const handler = (_, data) => callback(data);
            electron_1.ipcRenderer.on('simulator:stream-exit', handler);
            return () => void electron_1.ipcRenderer.removeListener('simulator:stream-exit', handler);
        },
    },
    // Updater operations
    updater: {
        checkForUpdates: () => electron_1.ipcRenderer.invoke('updater:check'),
        downloadUpdate: () => electron_1.ipcRenderer.invoke('updater:download'),
        installUpdate: () => electron_1.ipcRenderer.invoke('updater:install'),
        getVersion: () => electron_1.ipcRenderer.invoke('updater:get-version'),
        getStatus: () => electron_1.ipcRenderer.invoke('updater:get-status'),
        onStatus: (callback) => {
            const handler = (_, status) => {
                callback(status);
            };
            electron_1.ipcRenderer.on('updater:status', handler);
            return () => void electron_1.ipcRenderer.removeListener('updater:status', handler);
        },
    },
    // System metrics
    system: {
        getMetrics: () => electron_1.ipcRenderer.invoke('system:get-metrics'),
        cleanupBuffers: () => electron_1.ipcRenderer.invoke('system:cleanup-buffers'),
        getResolvedPath: () => electron_1.ipcRenderer.invoke('system:get-resolved-path'),
        findInPath: (query) => electron_1.ipcRenderer.invoke('system:find-in-path', { query }),
        onMetricsUpdate: (callback) => {
            const handler = (_, metrics) => callback(metrics);
            electron_1.ipcRenderer.on('system:metrics-update', handler);
            return () => void electron_1.ipcRenderer.removeListener('system:metrics-update', handler);
        },
    },
    // CLI Registry — see docs/features/channels/cli-subprocess.md §3.6
    cliRegistry: {
        list: () => electron_1.ipcRenderer.invoke('cli-registry:list'),
        rescan: (opts = {}) => electron_1.ipcRenderer.invoke('cli-registry:rescan', opts),
        cancelScan: () => electron_1.ipcRenderer.invoke('cli-registry:cancel-scan'),
        setOverride: (id, path) => electron_1.ipcRenderer.invoke('cli-registry:set-override', { id, path }),
        addCustom: (spec) => electron_1.ipcRenderer.invoke('cli-registry:add-custom', spec),
        removeCustom: (id) => electron_1.ipcRenderer.invoke('cli-registry:remove-custom', { id }),
        getBinary: (id) => electron_1.ipcRenderer.invoke('cli-registry:get-binary', { id }),
        clearSlowPaths: (entry) => electron_1.ipcRenderer.invoke('cli-registry:clear-slow-paths', { entry }),
        onEvent: (callback) => {
            const handler = (_, event) => callback(event);
            electron_1.ipcRenderer.on('cli-registry:event', handler);
            return () => void electron_1.ipcRenderer.removeListener('cli-registry:event', handler);
        },
    },
    // Sub-agent history (read-only viewer for spawned CLI session JSONLs)
    subAgent: {
        // Delegation lifecycle reported by the 1devtool-agent CLI via the MCP
        // bridge — authoritative source for SubAgentBadge (host TUIs collapse
        // multi-line commands, so the transcript scan can't see `--to=<agent>`).
        onDelegationStart: (callback) => {
            const handler = (_, payload) => callback(payload);
            electron_1.ipcRenderer.on('subagent:delegation-start', handler);
            return () => void electron_1.ipcRenderer.removeListener('subagent:delegation-start', handler);
        },
        onDelegationEnd: (callback) => {
            const handler = (_, payload) => callback(payload);
            electron_1.ipcRenderer.on('subagent:delegation-end', handler);
            return () => void electron_1.ipcRenderer.removeListener('subagent:delegation-end', handler);
        },
        findRecentSession: (cli, cwd) => electron_1.ipcRenderer.invoke('sub-agent:find-recent-session', { cli, cwd }),
        readJsonl: (path, offset) => electron_1.ipcRenderer.invoke('sub-agent:read-jsonl', { path, offset }),
        openHistory: (args) => electron_1.ipcRenderer.invoke('sub-agent:open-history-window', args),
        getHistoryParams: () => {
            const params = new URLSearchParams(window.location.search);
            const sessionPath = params.get('subAgentHistory');
            const cli = params.get('cli');
            if (sessionPath && cli) {
                const formatRaw = params.get('format');
                const format = formatRaw === 'json' || formatRaw === 'markdown' ? formatRaw : 'jsonl';
                return { path: sessionPath, cli, command: params.get('command'), format };
            }
            return null;
        },
    },
    rust: {
        getDiagnostics: () => electron_1.ipcRenderer.invoke('rust:get-diagnostics'),
    },
    // MCP settings
    mcp: {
        getAllServers: () => electron_1.ipcRenderer.invoke('mcp:get-all-servers'),
        removeServer: (tool, name) => electron_1.ipcRenderer.invoke('mcp:remove-server', tool, name),
        installFeature: (feature) => electron_1.ipcRenderer.invoke('mcp:install-feature', feature),
        removeFeature: (feature) => electron_1.ipcRenderer.invoke('mcp:remove-feature', feature),
        getEnabledFeatures: () => electron_1.ipcRenderer.invoke('mcp:get-enabled-features'),
        listTools: () => electron_1.ipcRenderer.invoke('mcp:list-tools'),
        setToolEnabled: (toolName, enabled) => electron_1.ipcRenderer.invoke('mcp:set-tool-enabled', toolName, enabled),
        setProfileEnabled: (profile, enabled) => electron_1.ipcRenderer.invoke('mcp:set-profile-enabled', profile, enabled),
        getBridgePort: () => electron_1.ipcRenderer.invoke('mcp:get-bridge-port'),
        getActivity: (query = {}) => electron_1.ipcRenderer.invoke('mcp:get-activity', query),
        clearActivity: () => electron_1.ipcRenderer.invoke('mcp:clear-activity'),
        health: () => electron_1.ipcRenderer.invoke('mcp:health'),
        diagnose: () => electron_1.ipcRenderer.invoke('mcp:diagnose'),
        runFixAction: (actionId) => electron_1.ipcRenderer.invoke('mcp:run-fix-action', actionId),
        getResolvedNodePath: () => electron_1.ipcRenderer.invoke('mcp:get-resolved-node-path'),
        autoDetectNodePath: () => electron_1.ipcRenderer.invoke('mcp:auto-detect-node-path'),
        setNodePath: (nodePath) => electron_1.ipcRenderer.invoke('mcp:set-node-path', nodePath),
        onToolStart: (callback) => {
            const handler = (_, payload) => callback(payload);
            electron_1.ipcRenderer.on('mcp:tool-start', handler);
            return () => void electron_1.ipcRenderer.removeListener('mcp:tool-start', handler);
        },
        onToolEnd: (callback) => {
            const handler = (_, payload) => callback(payload);
            electron_1.ipcRenderer.on('mcp:tool-end', handler);
            return () => void electron_1.ipcRenderer.removeListener('mcp:tool-end', handler);
        },
        onToolDisabled: (callback) => {
            const handler = (_, payload) => callback(payload);
            electron_1.ipcRenderer.on('mcp:tool-disabled', handler);
            return () => void electron_1.ipcRenderer.removeListener('mcp:tool-disabled', handler);
        },
        onActivityChanged: (callback) => {
            const handler = (_, payload) => callback(payload);
            electron_1.ipcRenderer.on('mcp:activity-changed', handler);
            return () => void electron_1.ipcRenderer.removeListener('mcp:activity-changed', handler);
        },
    },
    /** Multi-Control Device — peer desktop federation (docs/multi_control_device.md). */
    device: {
        getState: () => electron_1.ipcRenderer.invoke('device:get-state'),
        startPairing: () => electron_1.ipcRenderer.invoke('device:start-pairing'),
        cancelPairing: () => electron_1.ipcRenderer.invoke('device:cancel-pairing'),
        startRelay: () => electron_1.ipcRenderer.invoke('device:start-relay'),
        stopRelay: () => electron_1.ipcRenderer.invoke('device:stop-relay'),
        joinPairing: (code) => electron_1.ipcRenderer.invoke('device:join-pairing', { code }),
        confirmPeer: (deviceId) => electron_1.ipcRenderer.invoke('device:confirm-peer', { deviceId }),
        revokePeer: (deviceId) => electron_1.ipcRenderer.invoke('device:revoke-peer', { deviceId }),
        setPeerGrants: (deviceId, grants) => electron_1.ipcRenderer.invoke('device:set-peer-grants', { deviceId, grants }),
        renameSelf: (displayName) => electron_1.ipcRenderer.invoke('device:rename-self', { displayName }),
        fetchPeerCatalog: (deviceId) => electron_1.ipcRenderer.invoke('device:fetch-peer-catalog', { deviceId }),
        listPeerSessions: (deviceId) => electron_1.ipcRenderer.invoke('device:list-peer-sessions', { deviceId }),
        resumePeerSession: (deviceId, sessionId, projectId) => electron_1.ipcRenderer.invoke('device:resume-peer-session', { deviceId, sessionId, projectId }),
        applySkill: (deviceId, policy, targets) => electron_1.ipcRenderer.invoke('device:apply-skill', { deviceId, policy, targets }),
        createTerminal: (args) => electron_1.ipcRenderer.invoke('device:create-terminal', args),
        submitPrompt: (deviceId, terminalId, text, terminalGeneration) => electron_1.ipcRenderer.invoke('device:submit-prompt', { deviceId, terminalId, terminalGeneration, text }),
        ensureLink: (args) => electron_1.ipcRenderer.invoke('device:ensure-link', args),
        sendLinkMessage: (args) => electron_1.ipcRenderer.invoke('device:send-link-message', args),
        removeLink: (linkId) => electron_1.ipcRenderer.invoke('device:remove-link', { linkId }),
        searchMemory: (deviceId, params) => electron_1.ipcRenderer.invoke('device:memory-search', { deviceId, ...params }),
        readMemoryEntry: (deviceId, filePath) => electron_1.ipcRenderer.invoke('device:memory-read', { deviceId, filePath }),
        writeMemoryEntry: (deviceId, filePath, content) => electron_1.ipcRenderer.invoke('device:memory-write', { deviceId, filePath, content }),
        startMirror: (deviceId, terminalId, terminalGeneration) => electron_1.ipcRenderer.invoke('device:mirror-start', { deviceId, terminalId, terminalGeneration }),
        stopMirror: (deviceId, terminalId) => electron_1.ipcRenderer.invoke('device:mirror-stop', { deviceId, terminalId }),
        acknowledgeMirrorFrame: (deviceId, connectionId, syncGeneration, frameId) => electron_1.ipcRenderer.invoke('device:mirror-ack-v2', { deviceId, connectionId, syncGeneration, frameId }),
        resyncMirror: (deviceId, connectionId) => electron_1.ipcRenderer.invoke('device:mirror-resync-v2', { deviceId, connectionId }),
        onTerminalDelivery: (callback) => {
            const handler = (_, payload) => callback(payload);
            electron_1.ipcRenderer.on('device:terminal-delivery-v2', handler);
            return () => void electron_1.ipcRenderer.removeListener('device:terminal-delivery-v2', handler);
        },
        onStateChanged: (callback) => {
            const handler = (_, state) => callback(state);
            electron_1.ipcRenderer.on('device:state-changed', handler);
            return () => void electron_1.ipcRenderer.removeListener('device:state-changed', handler);
        },
    },
};
electron_1.contextBridge.exposeInMainWorld('api', api);
exports.default = api;
