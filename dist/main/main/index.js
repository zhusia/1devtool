"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const Sentry = __importStar(require("@sentry/electron/main"));
const processStreamErrors_1 = require("./processStreamErrors");
// Initialize Sentry for error tracking (must be before other imports)
Sentry.init({
    dsn: process.env.SENTRY_DSN,
    enabled: process.env.NODE_ENV === 'production' || !!process.env.SENTRY_DSN,
});
const electron_1 = require("electron");
const windowsAppIdentity_1 = require("./windowsAppIdentity");
// electron-builder registers this same AUMID on the NSIS Start Menu shortcut.
// Apply it before creating windows or notifications so Windows resolves the
// friendly product name and the packaged 1DevTool icon instead of exposing
// Electron's fallback `electron.app.1DevTool` identity.
(0, windowsAppIdentity_1.configureWindowsAppIdentity)(process.platform, (appId) => electron_1.app.setAppUserModelId(appId));
// Hardening: a broken stdout/stderr pipe must never crash the main process.
// When the app is spawned with piped stdio (every dev launcher — `npm run dev`,
// `dev:onboarding`, CI), the parent runner can close the read end while the main
// process is still logging. Node delivers that as an 'error' on the stream; with
// no listener it's rethrown as an uncaught exception → Electron's "A JavaScript
// error occurred in the main process" dialog → the app quits. A `console.log`
// must never be able to do that. Expected closed-transport errors are swallowed
// silently; anything unexpected on the log streams is reported, not thrown.
(0, processStreamErrors_1.installProcessStreamErrorGuards)({
    onUnexpected: (error) => {
        try {
            Sentry.captureException(error);
        }
        catch { /* the logger itself is broken; give up quietly */ }
    },
});
// Last-resort safety boundary for a pipe owner missed by a local listener.
// This consumes only teardown-shaped transport codes; every other uncaught
// exception is rethrown through Electron's normal fatal path.
(0, processStreamErrors_1.installExpectedClosedPipeExceptionGuard)();
const path_1 = __importDefault(require("path"));
const environment_1 = require("./pty-backend/environment");
const tmuxService_1 = require("./pty-backend/tmuxService");
const utility_1 = require("./pty-backend/utility");
const TerminalConnectionService_1 = require("./terminal-connection/TerminalConnectionService");
const LocalTerminalAttachServer_1 = require("./terminal-connection/LocalTerminalAttachServer");
const featureFlags_1 = require("./terminal-connection/featureFlags");
const store_1 = require("./store");
const fileSystem_1 = require("./fileSystem");
const rustServiceBridge_1 = require("./rustServiceBridge");
const rustSidecar_1 = require("./rustSidecar");
const aiDiff_1 = require("./aiDiff");
const http_1 = require("./http");
const git_1 = require("./git");
const gitStateWatcher_1 = require("./gitStateWatcher");
const index_1 = require("./database/index");
const manager_1 = require("./simulator/manager");
const updater_1 = require("./updater");
const license_1 = require("./license");
const ports_1 = require("./ports");
const cron_1 = require("./cron");
const env_1 = require("./utils/env");
const cliRegistry_1 = require("./cliRegistry");
const types_1 = require("../shared/types");
const orchestrationPolicy_1 = require("../shared/orchestrationPolicy");
const promptHistory_1 = require("./promptHistory");
const notes_1 = require("./notes");
const resumeManager_1 = require("./resumeManager");
const memoryManager_1 = require("./memoryManager");
const agentPaths_1 = require("./agentPaths");
const claudeSettings_1 = require("./claudeSettings");
const runtime_1 = require("./aiAccounts/runtime");
const aiUsage_1 = require("./aiUsage");
const skills_1 = require("./skills");
const gstack_1 = require("./gstack");
const templates_1 = require("./templates");
const tasks_1 = require("./ipc/tasks");
const deploy_1 = require("./deploy");
const manager_2 = require("./projectSettings/manager");
const LicenseService_1 = require("./services/LicenseService");
const OpenCodeRunFailureWatcher_1 = require("./services/OpenCodeRunFailureWatcher");
const serverCompass_1 = require("./serverCompass");
const ssh_1 = require("./ssh");
const shimInstall_1 = require("./orchestration/shimInstall");
const install_1 = require("./orchestration/install");
const nativeHookInstall_1 = require("./orchestration/nativeHookInstall");
const skillContent_1 = require("./orchestration/skillContent");
const runTracker_1 = require("./orchestration/runTracker");
const setup_1 = require("./mcp-servers/_shared/setup");
const terminal_1 = require("./remote/handlers/terminal");
const host_1 = require("./lsp/host");
const AppConfigTransferService_1 = require("./services/AppConfigTransferService");
const AppQuitService_1 = require("./services/AppQuitService");
const analytics_1 = require("./analytics");
const tray_1 = require("./tray");
const fileSystem_2 = require("./ipc/fileSystem");
const aiDiff_2 = require("./ipc/aiDiff");
const lsp_1 = require("./ipc/lsp");
const docker_1 = require("./ipc/docker");
const storage_1 = require("./ipc/storage");
const workspace_1 = require("./ipc/workspace");
const WorkspaceService_1 = require("./workspace/WorkspaceService");
const WorkspaceOperations_1 = require("./workspace/WorkspaceOperations");
const promptsAndNotes_1 = require("./ipc/promptsAndNotes");
const aiSettings_1 = require("./ipc/aiSettings");
const memory_1 = require("./ipc/memory");
const skills_2 = require("./ipc/skills");
const gstack_2 = require("./ipc/gstack");
const draw_1 = require("./ipc/draw");
const git_2 = require("./ipc/git");
const dataTools_1 = require("./ipc/dataTools");
const simulator_1 = require("./ipc/simulator");
const systemPath_1 = require("./ipc/systemPath");
const appWindows_1 = require("./ipc/appWindows");
const resume_1 = require("./ipc/resume");
const orchestration_1 = require("./ipc/orchestration");
const contextFooterTracker_1 = require("./orchestration/contextFooterTracker");
const design_1 = require("./ipc/design");
const mcp_1 = require("./ipc/mcp");
const remote_1 = require("./ipc/remote");
const device_1 = require("./ipc/device");
const systemMetrics_1 = require("./ipc/systemMetrics");
const terminal_2 = require("./ipc/terminal");
const terminalNotifications_1 = require("./terminalNotifications");
const terminalSizePolicy_1 = require("./remote/terminalSizePolicy");
const applicationMenu_1 = require("./applicationMenu");
const deepLinks_1 = require("./deepLinks");
const terminalSessionLifecycle_1 = require("./terminalSessionLifecycle");
const mcpBridgeRuntime_1 = require("./mcpBridgeRuntime");
const mcpActivityLog_1 = require("./mcpActivityLog");
const BrowserPanelAutomationService_1 = require("./browserPanelAutomation/BrowserPanelAutomationService");
const AgentTeamController_1 = require("./orchestration/AgentTeamController");
const LinkRegistry_1 = require("./orchestration/LinkRegistry");
const HierarchyActivations_1 = require("./orchestration/HierarchyActivations");
const aiPreviewState_1 = require("./aiPreviewState");
const terminalAgentReadiness_1 = require("./terminalAgentReadiness");
const contracts_1 = require("../shared/terminal/contracts");
const bootstrap_1 = require("./orchestration/runtime/bootstrap");
const orchestrationRuns_1 = require("../shared/orchestrationRuns");
const mainWindow_1 = require("./mainWindow");
let mainWindow = null;
const entitlementState = {
    shadow: null,
    stopShadow: null,
    gate: null,
};
// The PtyBackend seam: all fd-adjacent terminal calls go through one
// UtilityPtyBackend. Its Electron utility process owns every native PTY;
// env building + tmux detection remain main-only policy services.
let ptyBackend = null;
let utilityPtyBackend = null;
let terminalConnectionService = null;
let localTerminalAttachServer = null;
// Setup gate: pty/pipe IPC awaits this so no create/write can run before
// setupIpcHandlers assigns the backend.
let ptyBackendReady = Promise.resolve();
let terminalEnvService = null;
let tmuxService = null;
let storeManager = null;
let fsManager = null;
let rustSidecarManager = null;
let rustServiceBridge = null;
let aiDiffManager = null;
let httpClient = null;
let gitManager = null;
let gitStateWatcher = null;
let databaseManager = null;
let simulatorManager = null;
let portManager = null;
let cronManager = null;
let promptHistoryManager = null;
let notesManager = null;
let deviceIpc = null;
let skillsManager = null;
let orchestrationRunTracker = null;
let agentTeamController = null;
let linkRegistry = null;
let hierarchyActivations = null;
let orchestrationRuntimeFoundation = null;
let gstackManager = null;
let cliRegistry = null;
let templateManager = null;
let deployManager = null;
let projectSettingsManager = null;
let serverCompassService = null;
let resumeManager = null;
let memoryManager = null;
let aiUsageService = null;
let aiAccountsRuntime = null;
let remoteServer = null;
let lspHost = null;
let browserPanelAutomation = null;
let mcpActivityLog = null;
let appConfigTransferService = null;
let workspaceService = null;
let workspaceOperations = null;
let trayManager = null;
let openCodeRunFailureWatcher = null;
let isWindowFocused = true;
// True once the main window's <App> has (re-)attached its remote IPC listeners
// AND hydrated projectStore (`remote:renderer-ready` ping). Reset on every
// window (re)create, reload, or crash below.
let remoteRendererReady = false;
const terminalNotifications = (0, terminalNotifications_1.createTerminalNotificationRuntime)({
    getMainWindow: () => mainWindow,
    getStoreManager: () => storeManager,
    getPtyBackend: () => ptyBackend,
    getRemoteServer: () => remoteServer,
    isWindowFocused: () => isWindowFocused,
    sendToRenderer,
});
const isDev = process.env.NODE_ENV === 'development' || !electron_1.app.isPackaged;
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5188';
const isMac = process.platform === 'darwin';
const applicationMenu = (0, applicationMenu_1.createApplicationMenuController)({
    getMainWindow: () => mainWindow,
    sendToRenderer,
    isDev,
    isMac,
});
const deepLinkRouter = (0, deepLinks_1.createDeepLinkRouter)({
    getMainWindow: () => mainWindow,
    sendToRenderer,
});
const mcpBridgeRuntime = (0, mcpBridgeRuntime_1.createMcpBridgeRuntime)({
    getPtyBackend: () => ptyBackend,
    getStoreManager: () => storeManager,
    getDatabaseManager: () => databaseManager,
    getHttpClient: () => httpClient,
    getOrchestrationRunTracker: () => orchestrationRunTracker,
    getCliRegistry: () => cliRegistry,
    getAgentTeamController: () => agentTeamController,
    getLinkRegistry: () => linkRegistry,
    getHierarchyActivations: () => hierarchyActivations,
    getResumeManager: () => resumeManager,
    getBrowserPanelAutomation: () => browserPanelAutomation,
    // Lazy by necessity: the bridge starts before registerTaskIpcHandlers runs.
    getTasksManager: () => (0, tasks_1.getTasksManager)(),
    getMcpActivityLog: () => mcpActivityLog,
    getWorkspaceOperations: () => workspaceOperations,
    sendToRenderer,
});
const terminalSessionLifecycle = (0, terminalSessionLifecycle_1.createTerminalSessionLifecycle)({
    get mainWindow() { return mainWindow; },
    get storeManager() { return storeManager; },
    get ptyBackend() { return ptyBackend; },
    get resumeManager() { return resumeManager; },
    get simulatorManager() { return simulatorManager; },
    get fsManager() { return fsManager; },
    get rustServiceBridge() { return rustServiceBridge; },
    get rustSidecarManager() { return rustSidecarManager; },
    get remoteServer() { return remoteServer; },
    get promptHistoryManager() { return promptHistoryManager; },
    get notesManager() { return notesManager; },
    get openCodeRunFailureWatcher() { return openCodeRunFailureWatcher; },
    get skillsManager() { return skillsManager; },
    get mcpBridge() { return mcpBridgeRuntime.getBridge(); },
    get lspHost() { return lspHost; },
    get trayManager() { return trayManager; },
}, sendToRenderer);
const E2E_USER_DATA_DIR = process.env.E2E_USER_DATA_DIR;
// Plain `npm run dev` shares the production userData dir, so it MUST hold
// the single-instance lock to stop the installed app from racing in and
// corrupting electron-store/SQLite. Only an isolated E2E profile or tests
// may skip it. See docs/common-errors/dev/packaged-dev-profile-conflict.md.
const shouldEnforceSingleInstance = !E2E_USER_DATA_DIR && process.env.NODE_ENV !== 'test';
if (E2E_USER_DATA_DIR) {
    electron_1.app.setPath('userData', E2E_USER_DATA_DIR);
}
// Aptabase SDK refuses to initialize after `app.isReady()`, so this must
// run at module load time — before any `app.whenReady()` resolves below.
(0, analytics_1.initAnalytics)();
const hasSingleInstanceLock = shouldEnforceSingleInstance ? electron_1.app.requestSingleInstanceLock() : true;
if (!hasSingleInstanceLock) {
    electron_1.app.quit();
}
function sendToRenderer(channel, payload) {
    const windowToSend = mainWindow;
    if (!windowToSend || windowToSend.isDestroyed()) {
        return false;
    }
    const { webContents } = windowToSend;
    // `did-start-loading` can fire for navigations we don't want to treat as the renderer being unusable.
    // Rely on `webContents.send` + try/catch instead of gating on a separate readiness flag.
    if (webContents.isDestroyed()) {
        return false;
    }
    try {
        if (payload === undefined) {
            webContents.send(channel);
        }
        else {
            webContents.send(channel, payload);
        }
        return true;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('Render frame was disposed') ||
            message.includes('Object has been destroyed') ||
            message.includes('WebContents was destroyed')) {
            return false;
        }
        console.error(`Failed to send "${channel}" to renderer`, error);
        return false;
    }
}
// The main window's <App> pings this once its remote IPC listener is attached
// and projectStore hydration has completed.
electron_1.ipcMain.on('remote:renderer-ready', () => {
    remoteRendererReady = true;
});
/**
 * Resolve the main-window BrowserWindow that hosts <App> — the ONLY renderer
 * that registers the remote create/spawn/close terminal listeners (popout and
 * sub-agent windows render different roots). Re-creates the window if it was
 * closed while the app stayed alive (macOS keeps running with `mainWindow=null`
 * after `window-all-closed`), and waits until the renderer has re-attached its
 * listeners (`remoteRendererReady`) so a dispatched request can't be dropped.
 * Returns null only if a window genuinely can't be brought up in time.
 */
function ensureMainRendererReady(timeoutMs = 8000) {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
    }
    const win = mainWindow;
    if (!win || win.isDestroyed())
        return Promise.resolve(null);
    if (remoteRendererReady && !win.webContents.isLoading()) {
        return Promise.resolve(win);
    }
    return new Promise((resolve) => {
        const start = Date.now();
        const probe = (candidate) => {
            if (!candidate || candidate.isDestroyed() || candidate.webContents.isLoading())
                return;
            try {
                candidate.webContents.send('remote:renderer-ready-probe');
            }
            catch {
                // The polling loop handles a destroyed/reloading renderer on its next tick.
            }
        };
        probe(win);
        const timer = setInterval(() => {
            const live = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
            if (remoteRendererReady && live && !live.webContents.isLoading()) {
                clearInterval(timer);
                resolve(live);
            }
            else if (Date.now() - start > timeoutMs) {
                clearInterval(timer);
                // Do not dispatch into an unhydrated renderer: that would either race
                // projects=[] or add the IPC ack timeout serially to this wait.
                resolve(null);
            }
            else {
                probe(live);
            }
        }, 100);
    });
}
// Pending HTTP Basic/Digest auth challenges raised by Browser-panel <webview>
// guests, keyed by requestId. Electron's `login` callback may be invoked only
// once, so we route the prompt through a single global renderer dialog and answer
// it here when the user submits or cancels.
const pendingWebviewAuth = new Map();
function createWindow() {
    // Closing the last macOS window suspends app services without quitting.
    // Reattach the Rust event listeners before the replacement renderer starts
    // registering file watches.
    rustServiceBridge?.resume();
    const window = (0, mainWindow_1.createMainWindow)({
        isDev,
        devServerUrl: DEV_SERVER_URL,
        pendingWebviewAuth,
        entitlementState,
        sendToRenderer,
        setRemoteRendererReady: (ready) => { remoteRendererReady = ready; },
        setWindowFocused: (focused) => { isWindowFocused = focused; },
        getStoreManager: () => storeManager,
        getLspHost: () => lspHost,
        getOrchestrationRunTracker: () => orchestrationRunTracker,
        shouldConfirmTerminalSessionQuit: terminalSessionLifecycle.shouldConfirmTerminalSessionQuit,
        confirmTerminalSessionQuit: terminalSessionLifecycle.confirmTerminalSessionQuit,
        createApplicationMenu: applicationMenu.createApplicationMenu,
        onClosed: () => { mainWindow = null; },
    });
    mainWindow = window;
    const hostWebContentsId = window.webContents.id;
    window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace)
            browserPanelAutomation?.disposeHost(hostWebContentsId);
    });
    window.webContents.on('render-process-gone', () => {
        browserPanelAutomation?.disposeHost(hostWebContentsId);
    });
    window.webContents.once('destroyed', () => {
        browserPanelAutomation?.disposeHost(hostWebContentsId);
    });
    return window;
}
/** Shared wiring for the orchestration install coordinator (§5) — boot, the
 *  Settings Reinstall button, and dashboard Apply all pass through here. */
function orchestrationInstallDeps() {
    return {
        resolveNodeBin: () => (0, setup_1.resolveNodeCommand)(),
        installSkills: (shimPath, policy, targets) => skillsManager.installOrchestrationSkillGlobally(shimPath, policy, targets),
        installTasksSkills: (targets) => skillsManager.installTasksSkillGlobally(targets),
        installNativeHooks: (shimPath, nodeBinaryPath) => (0, nativeHookInstall_1.ensureCodexOrchestrationNotify)(shimPath, nodeBinaryPath),
    };
}
function logClaudeScrollSettingsResults(results) {
    for (const res of results) {
        if (res.status === 'patched' || res.status === 'created') {
            console.log(`[claude-settings] ${res.status} scroll fix (tui=default, verbose=true) in ${res.path}`);
        }
        else if (res.status === 'error') {
            console.warn(`[claude-settings] failed to apply scroll fix in ${res.path}:`, res.error);
        }
        else if (res.error) {
            // A skip with an error means we found a file we refuse to touch
            // (malformed/unreadable). Surface it — this was previously invisible,
            // which made "the patch never lands" undiagnosable.
            console.warn(`[claude-settings] cannot patch ${res.path}: ${res.error}`);
        }
    }
}
function setupIpcHandlers() {
    terminalNotifications.resetE2ENotificationState();
    storeManager = new store_1.StoreManager();
    mcpActivityLog = new mcpActivityLog_1.McpActivityLog({
        filePath: path_1.default.join(electron_1.app.getPath('userData'), 'mcp-activity.json'),
        onChanged: (sequence) => sendToRenderer('mcp:activity-changed', { sequence }),
    });
    browserPanelAutomation = new BrowserPanelAutomationService_1.BrowserPanelAutomationService({
        getStoreManager: () => storeManager,
        ensureRendererWindow: ensureMainRendererReady,
    });
    electron_1.ipcMain.handle('browser-automation:register-guest', (event, request) => {
        if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) {
            return { ok: false, error: 'Only the main 1DevTool renderer may register browser guests' };
        }
        return browserPanelAutomation.registerGuest(event.sender, request);
    });
    electron_1.ipcMain.on('browser-automation:unregister-guest', (event, request) => {
        if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id)
            return;
        browserPanelAutomation?.unregisterGuest(request);
    });
    electron_1.ipcMain.on('browser-automation:ui-response', (event, response) => {
        if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id)
            return;
        browserPanelAutomation?.handleUiResponse(response);
    });
    (0, env_1.registerUserExtraPathsProvider)(() => storeManager?.getPreferences().system?.extraPathEntries ?? []);
    terminalEnvService = new environment_1.TerminalEnvironmentService();
    tmuxService = new tmuxService_1.TmuxDependencyService(terminalEnvService);
    // One child-scoped host owns all node-pty instances. This is intentionally
    // not the removed detached daemon: it shares the Electron app lifetime and
    // provides isolation/multiplexing without adoption or update survival.
    utilityPtyBackend = new utility_1.UtilityPtyBackend(tmuxService);
    ptyBackend = utilityPtyBackend;
    ptyBackendReady = utilityPtyBackend.ready;
    terminalConnectionService = new TerminalConnectionService_1.TerminalConnectionService({
        backend: ptyBackend,
        applyRequestedSize: (principal, terminalId, requested) => {
            if (principal.origin === 'desktop') {
                ptyBackend.recordDesktopSize(terminalId, requested.cols, requested.rows);
                if (terminalSizePolicy_1.remoteSizeAuthority.hasAuthority(terminalId))
                    return;
            }
            ptyBackend.resize(terminalId, requested.cols, requested.rows);
        },
    });
    localTerminalAttachServer = new LocalTerminalAttachServer_1.LocalTerminalAttachServer({
        service: terminalConnectionService,
        backend: ptyBackend,
        storeManager,
        claimInput: (terminalId) => agentTeamController?.inputSerializer.noteNonTeamInput(terminalId).forward ?? true,
    });
    // The CLI socket serves v2 frames only — the v2 rollback flag must silence
    // it just like it silences renderer attach (see ipc/terminal.ts).
    void localTerminalAttachServer
        .setEnabled((0, featureFlags_1.terminalConnectionV2Enabled)() &&
        storeManager.getPreferences().terminal.localTerminalAttachCli === true)
        .catch((error) => console.warn('[terminal-cli] failed to apply local attach preference:', error));
    // One-time reaper for daemons left behind by builds that shipped the
    // feature (1.45–1.47): a surviving daemon would otherwise hold orphaned
    // shells forever with nothing left that can talk to it.
    terminalSessionLifecycle.cleanupLegacyPtyDaemons();
    // Warm the login-shell env + tmux detection caches concurrently with window
    // boot so the first pty:create doesn't pay the 200ms–3s probe synchronously.
    // Must come after registerUserExtraPathsProvider: the prewarmed env snapshots
    // the enriched PATH at call time. tmux detection reuses the cached shell env,
    // so it runs after the env prewarm resolves (same order as before the split).
    void terminalEnvService.prewarm().then(() => tmuxService?.prewarm());
    (0, setup_1.registerMcpNodePathProvider)(() => storeManager?.getPreferences().system?.mcpNodePath ?? '');
    (0, analytics_1.attachAnalyticsStore)(storeManager);
    appConfigTransferService = new AppConfigTransferService_1.AppConfigTransferService(storeManager);
    workspaceService = new WorkspaceService_1.WorkspaceService({
        store: storeManager,
        sendToRenderer: (channel, payload) => { sendToRenderer(channel, payload); },
        // The Pro gate for multi-project workspaces. The E2E override needs BOTH
        // the isolated-profile switch and its own flag: the license store lives
        // outside E2E_USER_DATA_DIR, so a licensed profile cannot be seeded on
        // disk (same constraint as add-project-duplicate.spec.ts) — and a plain
        // env flag alone must not become a production bypass.
        isMultiProjectAllowed: () => (Boolean(E2E_USER_DATA_DIR) && process.env.ONEDEVTOOL_E2E_PRO_WORKSPACES === '1') ||
            LicenseService_1.licenseService.getLicenseInfo().isLicensed,
    });
    workspaceService.primeResolveBaselines();
    workspaceOperations = new WorkspaceOperations_1.WorkspaceOperations({
        service: workspaceService,
        getProjects: () => storeManager?.getProjects() ?? [],
        getLinkRegistry: () => linkRegistry,
        getTeamController: () => agentTeamController,
        operationsFilePath: path_1.default.join((0, orchestrationRuns_1.getOrchestrationRootDir)(), 'control', 'workspace-operations.json'),
    });
    fsManager = new fileSystem_1.FileSystemManager();
    rustSidecarManager = new rustSidecar_1.RustSidecarManager();
    rustServiceBridge = new rustServiceBridge_1.RustServiceBridge(rustSidecarManager, fsManager);
    aiDiffManager = new aiDiff_1.AiDiffSessionManager((snapshot) => {
        sendToRenderer('ai-diff:changed', snapshot);
    });
    httpClient = new http_1.HttpClient();
    gitManager = new git_1.GitManager();
    gitStateWatcher = new gitStateWatcher_1.GitStateWatcher(gitManager);
    databaseManager = new index_1.DatabaseManager();
    simulatorManager = new manager_1.SimulatorManager();
    portManager = new ports_1.PortManager();
    cronManager = new cron_1.CronManager();
    promptHistoryManager = new promptHistory_1.PromptHistoryManager();
    notesManager = new notes_1.NotesManager();
    skillsManager = new skills_1.SkillsManager(() => storeManager.getPreferences().aiAgentPaths || {});
    const browserMcpSkillInstall = skillsManager.installBrowserMcpSkillForCodex();
    if (browserMcpSkillInstall.status === 'wrote') {
        console.log(`[browser-mcp] installed Codex routing skill: ${browserMcpSkillInstall.path}`);
    }
    else if (browserMcpSkillInstall.status === 'error') {
        console.warn('[browser-mcp] failed to install Codex routing skill:', browserMcpSkillInstall.error);
    }
    // Orchestration run index (docs/features/orchestration/dashboard.md §4.3). The CLI
    // owns the run dirs; this tracker only reads, serves, and prunes.
    orchestrationRunTracker = new runTracker_1.OrchestrationRunTracker({
        cachePath: path_1.default.join(electron_1.app.getPath('userData'), 'orchestration-runs-cache.json'),
        logPath: path_1.default.join(electron_1.app.getPath('userData'), 'logs', 'orchestration.log'),
        onRunsChanged: () => sendToRenderer('orchestration:runs-changed'),
    });
    // Boot-time retention prune (main-owned only; skips running records).
    setTimeout(() => {
        try {
            orchestrationRunTracker?.prune();
        }
        catch { /* best-effort */ }
    }, 5000).unref?.();
    gstackManager = new gstack_1.GstackManager(() => storeManager.getPreferences().aiAgentPaths || {});
    cliRegistry = new cliRegistry_1.CliRegistry();
    void cliRegistry.init().then(() => {
        // Auto-rescan in the background on boot; consumers can use cached findings
        // before this resolves. Errors are swallowed; the UI surfaces partial state.
        void cliRegistry.rescan({ force: true }).catch(() => { });
    });
    cliRegistry.on('progress', (p) => sendToRenderer('cli-registry:event', { kind: 'progress', payload: p }));
    cliRegistry.on('scanComplete', (regs) => {
        sendToRenderer('cli-registry:event', { kind: 'scanComplete', payload: regs });
        // Mirror the registry to disk so the standalone 1devtool-agent CLI (which
        // can't import Electron) can read fresh detection state. Best-effort.
        try {
            (0, shimInstall_1.writeCliRegistryCache)({
                knownClis: cliRegistry.knownClis(),
                registrations: regs,
            });
        }
        catch { /* noop */ }
    });
    cliRegistry.on('change', (reg) => sendToRenderer('cli-registry:event', { kind: 'change', payload: reg }));
    // Install the 1devtool-agent shim + orchestration skill in detected agent
    // dirs via the shared coordinator (docs/features/orchestration/dashboard.md §5) —
    // shim first, skill writes gated on shim success, `skipped-dev-preserve` a
    // complete no-op (shim-stale-path.md: a preserved older shim + rewritten
    // newer skill is exactly the `--model` skew that already shipped once).
    // Boot compiles the APPLIED policy only — never the draft.
    void (async () => {
        try {
            const appliedPolicy = storeManager.getPreferences().orchestration?.applied ?? null;
            const outcome = await (0, install_1.runOrchestrationInstall)(orchestrationInstallDeps(), {
                policy: appliedPolicy,
                force: false,
            });
            if (outcome.shim.status === 'error') {
                console.warn('[orchestration] shim install failed:', outcome.shim.error);
            }
            else if (outcome.skillsSkipped === 'dev-preserve') {
                console.log('[orchestration] dev build kept the existing 1devtool-agent shim (owned by the installed app or another tree) — skipping skill rewrite so skill docs match that CLI. Set ONEDEVTOOL_DEV_OWN_SHIM=1 or use Settings → AI → Orchestration → Reinstall to repoint both at this dev build.');
                return;
            }
            if (outcome.nativeHook?.status === 'error' || outcome.nativeHook?.status === 'skipped-unsafe') {
                console.warn('[orchestration] Codex notify hook was not installed:', outcome.nativeHook.error);
            }
            const errors = outcome.skills.filter((r) => r.status === 'error');
            if (errors.length > 0) {
                console.warn('[orchestration] skill install errors:', errors);
            }
            const wrote = outcome.skills.filter((r) => r.status === 'wrote').map((r) => r.tool);
            if (wrote.length > 0) {
                console.log(`[orchestration] installed skill in: ${wrote.join(', ')}`);
            }
        }
        catch (error) {
            console.warn('[orchestration] boot install failed:', error);
        }
    })();
    templateManager = new templates_1.TemplateManager();
    deployManager = (0, deploy_1.createDeployManager)(storeManager, (event) => {
        sendToRenderer('deploy:log', event);
    });
    // Per-project `.1devtool/` settings folder. Fresh DeployStore/DeploySecretStore
    // instances are stateless electron-store wrappers over the same 1devtool.json,
    // so they read/write consistently with the deploy feature's own instances.
    projectSettingsManager = new manager_2.ProjectSettingsManager({
        storeManager,
        deployStore: new deploy_1.DeployStore(),
        deploySecretStore: new deploy_1.DeploySecretStore(),
        skillsManager: {
            installSkill: (projectPath, skill, tool) => skillsManager.installSkill(projectPath, skill, tool),
        },
        sendToRenderer: (channel, payload) => { sendToRenderer(channel, payload); },
        isLicensed: () => LicenseService_1.licenseService.getLicenseInfo().isLicensed,
    });
    const getAiAgentPathOverrides = () => storeManager.getPreferences().aiAgentPaths || {};
    // Ensure Claude Code's global settings use the classic (main-screen) TUI
    // instead of the fullscreen alt-screen renderer, which leaves Claude
    // unscrollable inside 1DevTool's embedded terminals. Idempotent +
    // non-destructive: skips when already correct, never clobbers an unreadable
    // settings file. Also re-asserted on every Claude launch in pty:create with
    // the PTY's enriched env, which is where CLAUDE_CONFIG_DIR redirects become
    // visible. See ./claudeSettings.ts.
    void (0, claudeSettings_1.ensureClaudeScrollSettings)(getAiAgentPathOverrides(), { installOrchestrationHook: true })
        .then(logClaudeScrollSettingsResults)
        .catch((err) => console.warn('[claude-settings] scroll fix boot install failed:', err));
    resumeManager = new resumeManager_1.ResumeManager(getAiAgentPathOverrides);
    // Durable orchestration reconciliation may need to idempotently re-spawn a
    // renderer-owned terminal record, so wire the main-window rendezvous before
    // the controller begins replaying its journal.
    (0, terminal_1.configureRendererTerminalRequestWindow)(ensureMainRendererReady);
    orchestrationRuntimeFoundation = (0, bootstrap_1.createOrchestrationRuntimeFoundation)(cliRegistry);
    agentTeamController = new AgentTeamController_1.AgentTeamController({
        getPtyBackend: () => ptyBackend,
        getTerminalConnectionService: () => terminalConnectionService,
        getStoreManager: () => storeManager,
        getCliRegistry: () => cliRegistry,
        getResumeManager: () => resumeManager,
        getLinkRegistry: () => linkRegistry,
        getAgentRuntimeManager: () => orchestrationRuntimeFoundation?.manager ?? null,
        getHarnessRegistry: () => orchestrationRuntimeFoundation?.registry ?? null,
        getFederatedTeamRuntime: () => deviceIpc ? {
            validateMember: (input) => deviceIpc.validatePeerTeamMember(input),
            startMember: (input) => deviceIpc.startPeerTeamMember(input),
            sendMember: (input) => deviceIpc.sendPeerTeamMember(input),
            collectRun: (input) => deviceIpc.collectPeerTeamRun(input),
            stopTeam: (input) => deviceIpc.stopPeerTeam(input),
        } : null,
        createTerminal: terminal_1.requestRendererCreateTerminal,
        sendToRenderer,
        getConcurrencyLimit: () => (0, orchestrationRuns_1.readOrchestrationConfig)().scheduling.maxConcurrentAgents,
        // Workspace-scoped team admission (workspace_control D2/D4): membership
        // resolves once here; archived workspaces and non-member callers refuse.
        resolveWorkspaceAdmission: (workspaceId, callerProjectId) => {
            if (!workspaceService)
                return { ok: false, error: 'Workspace service is unavailable' };
            try {
                const resolve = workspaceService.authorizeAction(workspaceId, callerProjectId);
                return {
                    ok: true,
                    resolvedProjectIds: resolve.resolvedProjectIds,
                    membershipGeneration: resolve.membershipGeneration,
                };
            }
            catch (error) {
                return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
        },
    });
    void agentTeamController.initialize().catch((error) => {
        console.warn('[agent-teams] reconciliation failed:', error);
    });
    // Hierarchy activations (orchestration v5). Durable beside the link store;
    // the enforcement facade is consulted by LinkRegistry on agent sends.
    hierarchyActivations = new HierarchyActivations_1.HierarchyActivations({
        storagePath: path_1.default.join((0, orchestrationRuns_1.getOrchestrationRootDir)(), 'control', 'hierarchy.json'),
        getTerminalGeneration: (terminalId) => ptyBackend?.getSessionGeneration(terminalId) ?? undefined,
        getTerminalIdentity: (terminalId) => {
            const location = storeManager?.findTerminalLocation(terminalId);
            if (!location)
                return null;
            const { project, terminal } = location;
            return {
                projectId: project.id,
                effectiveAgentKind: (0, aiPreviewState_1.resolveEffectivePreviewAgentType)(terminalId, terminal.agentType, terminal.startupCommand, terminal.forceAiAgent) ??
                    terminal.agentType,
            };
        },
        getShimPath: () => (0, shimInstall_1.getOrchestratorShimPath)(),
        log: (line) => console.warn('[hierarchy]', line),
    });
    // Terminal Links (orchestration v4 L1/L4). Borrows the controller's
    // serializer — one lease owner per terminal, never a second instance.
    linkRegistry = new LinkRegistry_1.LinkRegistry({
        storagePath: path_1.default.join((0, orchestrationRuns_1.getOrchestrationRootDir)(), 'control', 'terminal-links.json'),
        hierarchy: () => hierarchyActivations,
        getTerminalInfo: (terminalId) => {
            const location = storeManager?.findTerminalLocation(terminalId);
            if (!location)
                return null;
            const { project, terminal } = location;
            const declaredKind = (0, contracts_1.getDeclaredAgentKind)(terminal.agentType, terminal.startupCommand);
            return {
                projectId: project.id,
                name: terminal.name || terminal.agentType,
                worktreePath: terminal.worktreePath || project.rootPath,
                promptTarget: {
                    agentType: terminal.agentType,
                    startupCommand: terminal.startupCommand,
                    forceAiAgent: terminal.forceAiAgent,
                },
                effectiveAgentKind: (0, aiPreviewState_1.resolveEffectivePreviewAgentType)(terminalId, terminal.agentType, terminal.startupCommand, terminal.forceAiAgent) ??
                    terminal.agentType,
                nativeSessionId: terminal.lastSessionId,
                resumeAgentType: terminal.lastSessionAgentType ??
                    (0, contracts_1.mapToResumeAgentType)(terminal.agentType, terminal.startupCommand) ??
                    undefined,
                isNativeTui: (0, contracts_1.isNativeTuiAgentKind)(declaredKind),
                isInteractiveAgent: (0, aiPreviewState_1.resolveEffectivePreviewAgentType)(terminalId, terminal.agentType, terminal.startupCommand, terminal.forceAiAgent) !== undefined,
            };
        },
        getTerminalGeneration: (terminalId) => ptyBackend?.getSessionGeneration(terminalId) ?? undefined,
        prepareTarget: async (terminalId, target, attempt = 0, options = {}) => {
            const backend = ptyBackend;
            if (!backend) {
                return {
                    ok: false,
                    reason: 'failed',
                    error: 'The terminal backend is unavailable.',
                };
            }
            return (0, terminalAgentReadiness_1.waitForBackendAgentReady)({
                backend,
                connectionService: terminalConnectionService ?? undefined,
                terminalId,
                kind: (0, contracts_1.getDeclaredAgentKind)(target.agentType, target.startupCommand),
                allowActiveTurnComposer: options.allowActiveTurnComposer === true,
                // Redelivery retries use a short window: another retry is already
                // scheduled with backoff, and a busy peer would otherwise keep a full
                // 30 s VT observer parsing its output most of the time (R23).
                ...(attempt > 0 ? { deadlineMs: 12_000 } : {}),
            });
        },
        createSubmissionProbe: async (terminalId, target, options) => {
            const backend = ptyBackend;
            if (!backend)
                throw new Error('The terminal backend is unavailable.');
            // Capture an already-bound native session before injection. A later
            // replacement must not acknowledge a prompt addressed to this seat.
            const initialLocation = storeManager?.findTerminalLocation(terminalId);
            const initialSessionId = initialLocation?.terminal.lastSessionId;
            const initialAgentType = initialLocation?.terminal.lastSessionAgentType ??
                (0, contracts_1.mapToResumeAgentType)(target.agentType, target.startupCommand) ??
                undefined;
            return (0, terminalAgentReadiness_1.createBackendAgentSubmissionProbe)({
                backend,
                connectionService: terminalConnectionService ?? undefined,
                terminalId,
                kind: (0, contracts_1.getDeclaredAgentKind)(target.agentType, target.startupCommand),
                requireReady: !options.allowUnready,
                ...(options.correlationMarker
                    ? {
                        correlationMarker: options.correlationMarker,
                        correlationCheck: async () => {
                            const current = storeManager?.findTerminalLocation(terminalId);
                            const sessionId = current?.terminal.lastSessionId;
                            if (!current || !sessionId || !resumeManager)
                                return false;
                            if (initialSessionId && sessionId !== initialSessionId)
                                return false;
                            const agentType = initialSessionId
                                ? initialAgentType
                                : current.terminal.lastSessionAgentType ??
                                    (0, contracts_1.mapToResumeAgentType)(current.terminal.agentType, current.terminal.startupCommand) ??
                                    undefined;
                            if (!agentType)
                                return false;
                            const detail = await resumeManager.getSessionDetail(agentType, sessionId);
                            return detail?.messages.some((entry) => entry.role === 'user' &&
                                entry.content.includes(options.correlationMarker)) ?? false;
                        },
                    }
                    : {}),
            });
        },
        getSerializer: () => agentTeamController?.inputSerializer ?? null,
        // Embedded in every delivered message so the peer can answer without
        // guessing a command or assuming ~/.1devtool/bin is on PATH.
        getShimPath: () => (0, shimInstall_1.getOrchestratorShimPath)(),
        sendFederatedReply: async (input) => {
            if (!deviceIpc) {
                return { ok: false, error: 'delivery-failed', detail: 'Device federation is unavailable.' };
            }
            return deviceIpc.sendFederatedReply(input);
        },
        onLinkActivity: (event) => { sendToRenderer('links:activity', event); },
        onMessageState: (event) => { sendToRenderer('links:message-state', event); },
        onDeliveryFailed: ({ link, error }) => {
            const from = storeManager?.findTerminalLocation(link.from.terminalId);
            const to = storeManager?.findTerminalLocation(link.to.terminalId);
            sendToRenderer('app:attention-event', {
                id: `linkfail-${link.linkId}-${Date.now()}`,
                kind: 'link-failed',
                terminalId: link.from.terminalId,
                projectId: link.projectId,
                projectName: from?.project.name ?? '',
                terminalName: from?.terminal.name ?? link.from.terminalId,
                agentType: from?.terminal.agentType,
                detail: `Delivery to "${to?.terminal.name ?? link.to.terminalId}" failed: ${error}`,
                timestamp: Date.now(),
            });
        },
        log: (line) => console.warn('[terminal-links]', line),
    });
    (0, terminal_1.configureRemoteTerminalInputObserver)((terminalId) => agentTeamController?.inputSerializer.noteNonTeamInput(terminalId).forward ?? true);
    // Protect persisted terminal↔session bindings from being reassigned by this
    // session's detection passes (claims start empty on every boot).
    terminalSessionLifecycle.seedSessionClaimsFromStore();
    openCodeRunFailureWatcher = new OpenCodeRunFailureWatcher_1.OpenCodeRunFailureWatcher(path_1.default.join((0, agentPaths_1.getAgentRoot)('opencode', getAiAgentPathOverrides()), 'log', 'opencode.log'), (event) => {
        if (!storeManager || !ptyBackend)
            return false;
        // Session id is the ownership key. Missing or ambiguous attribution is
        // intentionally ignored (terminal INDEX rule A4), then retried briefly
        // while first-prompt session detection persists a fresh binding.
        const terminalId = (0, OpenCodeRunFailureWatcher_1.resolveOpenCodeFailureTerminalId)(storeManager.getProjects(), event.sessionId);
        if (!terminalId || !ptyBackend.markRunEnded(terminalId, event.endedAt))
            return false;
        const payload = {
            terminalId,
            endedAt: event.endedAt,
            reason: event.reason,
            agentType: 'opencode',
            sessionId: event.sessionId,
        };
        return sendToRenderer('pty:run-ended', payload);
    });
    void openCodeRunFailureWatcher.start().catch((error) => {
        console.warn('[opencode-run] failed to start structured failure watcher:', error);
    });
    memoryManager = new memoryManager_1.MemoryManager(getAiAgentPathOverrides);
    aiUsageService = new aiUsage_1.AiUsageService();
    lspHost = new host_1.LSPHost();
    // Start unified MCP Bridge
    mcpBridgeRuntime.startMcpBridge();
    // Tasks v2 (docs/tasks_v2.md). v1 code-tasks was deleted in §10 once these
    // surfaces existed; there is one task system now.
    (0, tasks_1.registerTaskIpcHandlers)({
        getMainWindow: () => mainWindow,
        sendToRenderer,
        baseDir: path_1.default.join(electron_1.app.getPath('userData'), 'tasks'),
        getProjectSettingsManager: () => projectSettingsManager,
        getAgentTeamController: () => agentTeamController,
        getTerminalName: (terminalId) => storeManager?.findTerminalLocation(terminalId)?.terminal.name,
        // `scope: workspace` reads filter by the live resolve; display purpose so
        // archived workspaces can still show their historical board.
        resolveWorkspaceProjectIds: (workspaceId) => {
            try {
                return workspaceService?.resolve(workspaceId, 'display').resolvedProjectIds ?? null;
            }
            catch {
                return null;
            }
        },
        // Cross-project dispatch gate (05 §5): both projects must sit in one
        // NON-ARCHIVED workspace's live resolve. forProject already refuses
        // archived; the controller re-validates at admission.
        sharedWorkspaceFor: (projectAId, projectBId) => {
            const shared = workspaceService?.forProject(projectAId).find((workspace) => {
                try {
                    return workspaceService?.resolve(workspace.id, 'action')
                        .resolvedProjectIds.includes(projectBId) ?? false;
                }
                catch {
                    return false;
                }
            });
            return shared ? { workspaceId: shared.id } : null;
        },
    });
    // Mirror run outcomes onto task state and register the fallback policy hook.
    // After the controller exists, and after the Tasks IPC layer built the mapper.
    (0, tasks_1.startTaskRunMapper)();
    (0, deploy_1.registerDeployIpcHandlers)(deployManager);
    serverCompassService = (0, serverCompass_1.createServerCompassService)(storeManager);
    (0, serverCompass_1.registerServerCompassIpcHandlers)(serverCompassService);
    (0, ssh_1.registerSshIpcHandlers)();
    // Live "% context left" capture (gemini/qwen/codex). One instance shared by
    // the terminal IPC (attach/detach on create/exit) and the orchestration IPC
    // (context-usage snapshots).
    const contextFooterTracker = new contextFooterTracker_1.ContextFooterTracker(() => ptyBackend);
    (0, terminal_2.registerTerminalIpcHandlers)({
        ptyBackend: ptyBackend,
        ptyBackendReady,
        terminalEnvService: terminalEnvService,
        tmuxService: tmuxService,
        storeManager: storeManager,
        promptHistoryManager: promptHistoryManager,
        sendToRenderer,
        sendToPopoutWindows: appWindows_1.sendToPopoutWindows,
        showCommandCompletionNotification: terminalNotifications.showCommandCompletionNotification,
        showAgentIdleNotification: terminalNotifications.showAgentIdleNotification,
        emitActivityTerminalEvent: terminalNotifications.emitActivityTerminalEvent,
        maybeFinalizePendingAiLogin: (terminalId, source) => aiAccountsRuntime?.maybeFinalizePendingAiLogin(terminalId, source) ?? Promise.resolve(),
        logClaudeScrollSettingsResults,
        contextFooterTracker,
        noteNonTeamInput: (terminalId, _data, origin) => agentTeamController?.inputSerializer.noteNonTeamInput(terminalId, origin).forward ?? true,
        ptyOutputFlow: utilityPtyBackend,
        terminalConnectionService: terminalConnectionService,
    });
    (0, fileSystem_2.registerFileSystemIpcHandlers)({
        fsManager: fsManager,
        rustServiceBridge: rustServiceBridge,
        rustSidecarManager: rustSidecarManager,
        aiDiffManager: aiDiffManager,
        projectSettingsManager: projectSettingsManager,
        getMainWindow: () => mainWindow,
        sendToRenderer,
    });
    (0, aiDiff_2.registerAiDiffIpcHandlers)(aiDiffManager);
    (0, lsp_1.registerLspIpcHandlers)({ storeManager: storeManager, lspHost });
    (0, git_2.registerGitIpcHandlers)({
        gitManager: gitManager,
        gitStateWatcher: gitStateWatcher,
        templateManager: templateManager,
        sendToRenderer,
        getCliRegistry: () => cliRegistry,
    });
    (0, draw_1.registerDrawIpcHandlers)({ getCliRegistry: () => cliRegistry });
    (0, dataTools_1.registerDataToolsIpcHandlers)({
        httpClient: httpClient,
        databaseManager: databaseManager,
        portManager: portManager,
        cronManager: cronManager,
        storeManager: storeManager,
        getMainWindow: () => mainWindow,
        sendToRenderer,
        isDev,
        devServerUrl: DEV_SERVER_URL,
    });
    (0, simulator_1.registerSimulatorIpcHandlers)({
        simulatorManager: simulatorManager,
        sendToRenderer,
    });
    (0, systemPath_1.registerSystemPathIpcHandlers)(cliRegistry);
    (0, docker_1.registerDockerIpcHandlers)();
    (0, storage_1.registerStorageIpcHandlers)({
        storeManager: storeManager,
        projectSettingsManager: projectSettingsManager,
        appConfigTransferService: appConfigTransferService,
        getMainWindow: () => mainWindow,
        // Live workspaces track sidebar group membership; the group save/delete
        // funnel is the only place groups mutate (workspace_control D3).
        onProjectGroupMutated: (groupId) => workspaceService?.onProjectGroupMutated(groupId),
        onAppConfigImported: () => {
            // Import replaced store state wholesale — the diff baselines are stale.
            workspaceService?.primeResolveBaselines();
            sendToRenderer('workspace:changed', { workspaceIds: [], reason: 'meta' });
        },
        onPreferencesChanged: (preferences) => {
            void localTerminalAttachServer
                ?.setEnabled((0, featureFlags_1.terminalConnectionV2Enabled)() &&
                preferences.terminal.localTerminalAttachCli === true)
                .catch((error) => console.warn('[terminal-cli] failed to apply local attach preference:', error));
        },
    });
    (0, workspace_1.registerWorkspaceIpcHandlers)({
        workspaceService: workspaceService,
        getMainWindow: () => mainWindow,
    });
    // App handlers
    electron_1.ipcMain.handle('app:get-platform', () => {
        return process.platform;
    });
    // Answer a pending Browser-panel <webview> HTTP auth challenge (see the
    // `login` handler in did-attach-webview).
    electron_1.ipcMain.on('webview-http-auth-response', (_event, payload) => {
        const callback = pendingWebviewAuth.get(payload?.requestId);
        if (!callback)
            return;
        pendingWebviewAuth.delete(payload.requestId);
        if (payload.cancel || typeof payload.username !== 'string') {
            callback(); // cancel → server returns 401, same as before the prompt existed
        }
        else {
            callback(payload.username, payload.password ?? '');
        }
    });
    // Ack + answer for the renderer quit-confirm dialog (see
    // confirmTerminalSessionQuit / promptQuitConfirmInRenderer).
    electron_1.ipcMain.on('app:quit-confirm-ack', (_event, requestId) => {
        terminalSessionLifecycle.acknowledgeQuitConfirmation(requestId);
    });
    electron_1.ipcMain.on('app:quit-confirm-response', (_event, payload) => {
        terminalSessionLifecycle.answerQuitConfirmation(payload?.requestId, payload?.choice);
    });
    electron_1.ipcMain.handle('app:consume-pending-deeplink', () => {
        return deepLinkRouter.consumePendingDeepLink();
    });
    electron_1.ipcMain.handle('app:consume-pending-open-files', () => {
        return deepLinkRouter.consumePendingOpenFiles();
    });
    if (isDev) {
        electron_1.ipcMain.handle('app:debug-route-deeplink', (_event, url) => {
            deepLinkRouter.routeDeepLink(url);
            return { routed: deepLinkRouter.parseDeepLink(url) !== null };
        });
    }
    (0, appWindows_1.registerAppWindowsIpcHandlers)({
        getMainWindow: () => mainWindow,
        storeManager: storeManager,
        sendToRenderer,
        isDev,
        devServerUrl: DEV_SERVER_URL,
    });
    // Updater handlers
    (0, updater_1.setupUpdaterIpcHandlers)({
        prepareForInstall: terminalSessionLifecycle.saveTerminalSessionsBeforeUpdateInstall,
    });
    (0, promptsAndNotes_1.registerPromptsAndNotesIpcHandlers)({
        promptHistoryManager: promptHistoryManager,
        notesManager: notesManager,
        resumeManager: resumeManager,
    });
    (0, resume_1.registerResumeIpcHandlers)({
        resumeManager: resumeManager,
        ptyBackend: ptyBackend,
        storeManager: storeManager,
    });
    (0, aiSettings_1.registerAiSettingsIpcHandlers)({
        storeManager: storeManager,
        aiUsageService: aiUsageService,
    });
    aiAccountsRuntime = (0, runtime_1.createAiAccountsRuntime)({
        storeManager: storeManager,
        getMainWindow: () => mainWindow,
        sendToRenderer,
        sendToPopoutWindows: appWindows_1.sendToPopoutWindows,
        isTerminalAlive: (terminalId) => {
            try {
                return ptyBackend?.getAllStatuses()?.[terminalId]?.isAlive === true;
            }
            catch {
                return false;
            }
        },
    });
    aiAccountsRuntime.registerIpcHandlers();
    (0, memory_1.registerMemoryIpcHandlers)({
        memoryManager: memoryManager,
        storeManager: storeManager,
        getMainWindow: () => mainWindow,
    });
    (0, skills_2.registerSkillsIpcHandlers)(skillsManager);
    (0, orchestration_1.registerOrchestrationIpcHandlers)({
        storeManager: storeManager,
        skillsManager: skillsManager,
        orchestrationRunTracker,
        agentTeamController,
        harnessRegistry: orchestrationRuntimeFoundation.registry,
        cliRegistry,
        getLinkRegistry: () => linkRegistry,
        getHierarchyActivations: () => hierarchyActivations,
        getMainWindow: () => mainWindow,
        getInstallDependencies: orchestrationInstallDeps,
        sendToRenderer,
        getWorkspaceOperations: () => workspaceOperations,
        contextFooterTracker,
        getPtyBackend: () => ptyBackend,
    });
    (0, gstack_2.registerGstackIpcHandlers)(gstackManager, sendToRenderer);
    (0, design_1.registerDesignIpcHandlers)({
        getMcpBridgePort: () => mcpBridgeRuntime.getBridge()?.getPort() ?? null,
        getMainWindow: () => mainWindow,
        sendToRenderer,
    });
    (0, mcp_1.registerMcpIpcHandlers)({
        storeManager: storeManager,
        getMcpBridge: mcpBridgeRuntime.getBridge,
        mcpActivityLog: mcpActivityLog,
        restartMcpBridge: mcpBridgeRuntime.startMcpBridge,
    });
    remoteServer = (0, remote_1.createRemoteServerAndRegisterIpc)({
        getPtyBackend: () => ptyBackend,
        ptyBackendReady,
        storeManager: storeManager,
        gitManager: gitManager,
        fsManager: fsManager,
        skillsManager: skillsManager,
        resumeManager,
        httpClient: httpClient,
        databaseManager: databaseManager,
        promptHistoryManager,
        notesManager,
        getAgentTeamController: () => agentTeamController,
        getLinkRegistry: () => linkRegistry,
        getHierarchyActivations: () => hierarchyActivations,
        getRunTracker: () => orchestrationRunTracker,
        getDeviceHostProxy: () => deviceIpc,
        ensureRendererWindow: ensureMainRendererReady,
        sendToRenderer,
        terminalConnectionService: terminalConnectionService,
    });
    (0, systemMetrics_1.registerSystemMetricsIpcHandlers)({
        getPtyBackend: () => ptyBackend,
        ptyBackendReady,
        sendToRenderer,
        shouldStopPollingOnBeforeQuit: () => (0, AppQuitService_1.isQuitAllowed)() || !terminalSessionLifecycle.shouldConfirmTerminalSessionQuit(),
    });
    // Multi-Control Device (peer desktop federation). Lazy by contract: at zero
    // paired peers this registers channels only — no server, no stores, no
    // identity (docs/multi_control_device.md §4.1).
    deviceIpc = (0, device_1.registerDeviceIpcHandlers)({
        getCatalogSources: () => ({
            getProjects: () => (storeManager?.getProjects() ?? []).map((project) => ({
                ...project,
                terminals: project.terminals.map((terminal) => ({
                    ...terminal,
                    // Decided here, where startupCommand/forceAiAgent/preview state are
                    // known — the peer must never re-derive it from agentType alone.
                    isInteractiveAgent: (0, aiPreviewState_1.resolveEffectivePreviewAgentType)(terminal.id, terminal.agentType, terminal.startupCommand, terminal.forceAiAgent) !== undefined,
                })),
            })),
            getPtyStatuses: () => {
                try {
                    return ptyBackend?.getAllStatuses() ?? {};
                }
                catch {
                    return {};
                }
            },
            getTerminalGeneration: (terminalId) => ptyBackend?.getSessionGeneration(terminalId) ?? undefined,
            listClis: () => cliRegistry?.list() ?? [],
        }),
        sendToRenderer,
        getMainWindow: () => mainWindow,
        terminalConnectionService: terminalConnectionService,
        isProEntitled: () => LicenseService_1.licenseService.getLicenseInfo().isLicensed,
        resolveLocalTerminal: (terminalId) => {
            const record = storeManager?.findTerminalLocation(terminalId);
            if (!record)
                return null;
            const { terminal, project } = record;
            return {
                projectId: project.id,
                terminalGeneration: ptyBackend?.getSessionGeneration(terminalId) ?? undefined,
                name: terminal.name || terminal.agentType,
                agentType: (0, aiPreviewState_1.resolveEffectivePreviewAgentType)(terminalId, terminal.agentType, terminal.startupCommand, terminal.forceAiAgent) ??
                    terminal.agentType,
                // Same predicate the link endpoints use — a staged submit into a shell
                // would execute as a command.
                isInteractiveAgent: (0, aiPreviewState_1.resolveEffectivePreviewAgentType)(terminalId, terminal.agentType, terminal.startupCommand, terminal.forceAiAgent) !== undefined,
                running: ptyBackend?.hasLiveInstance(terminalId) === true,
            };
        },
        searchLocalMemory: async (params) => {
            if (!memoryManager)
                return { entries: [], total: 0 };
            return memoryManager.scanEntries(params);
        },
        readLocalMemoryEntry: async (filePath) => (await memoryManager?.readEntry(filePath)) ?? null,
        writeLocalMemoryEntry: async (filePath, content) => (await memoryManager?.writeEntry(filePath, content)) ?? false,
        getLocalTerminalBuffer: async (terminalId) => (await ptyBackend?.getBuffer(terminalId)) ?? '',
        subscribeLocalTerminalOutput: (terminalId, onData) => {
            // No live PTY ⇒ onOutput returns a no-op unsubscribe that would deafen
            // this terminal permanently if cached (see remote handlers/terminal.ts).
            if (!ptyBackend?.hasLiveInstance(terminalId))
                return () => { };
            return ptyBackend.onOutput(terminalId, (data) => onData(data));
        },
        getLinkRegistry: () => linkRegistry,
        getTeamController: () => agentTeamController,
        scanLocalResumeSessions: async () => (await resumeManager?.scanSessions({ limit: 500, offset: 0 }))?.sessions ?? [],
        resumeLocalSession: async (session, projectId, operationId) => {
            if (!resumeManager)
                return { ok: false, error: 'Resume manager is unavailable.' };
            const command = resumeManager.getResumeCommand(session.agentType, session.id)?.trim();
            if (!command)
                return { ok: false, error: 'This agent does not support session resume.' };
            return (0, terminal_1.requestRendererCreateTerminal)({
                projectId,
                agentType: session.agentType,
                name: (session.sessionName || `${session.agentType} resume`).slice(0, 200),
                command,
                terminalId: `device-${operationId}`.slice(0, 96),
                lastSessionId: session.id,
                lastSessionAgentType: session.agentType,
            });
        },
        applyLocalSkillPolicy: async ({ targets: rawTargets, policy }) => {
            const { normalized, errors } = (0, orchestrationPolicy_1.normalizePolicyDraft)(policy);
            if (errors.length > 0) {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: `The shared policy was invalid: ${errors.join('; ')}` } };
            }
            const targets = rawTargets
                ?.filter((target) => skillContent_1.ORCHESTRATION_SKILL_TARGETS.includes(target));
            if (rawTargets?.length && targets?.length !== rawTargets.length) {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'The request contained an unknown orchestration skill target.' } };
            }
            const outcome = await (0, install_1.runOrchestrationInstall)(orchestrationInstallDeps(), {
                policy: normalized,
                force: true,
                targets,
            });
            if (outcome.shim.status === 'error') {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: `Owner shim install failed: ${outcome.shim.error ?? 'unknown error'}` } };
            }
            const now = Date.now();
            const rows = outcome.skills.map((row) => ({
                target: row.tool,
                status: row.status,
                ...(row.error ? { error: row.error } : {}),
                at: now,
            }));
            const prefs = storeManager.getPreferences();
            const state = (0, orchestrationPolicy_1.normalizeOrchestrationPolicyState)(prefs.orchestration);
            const kept = targets
                ? (state.lastInstallResults ?? []).filter((row) => !targets.includes(row.target))
                : [];
            storeManager.setPreferences({
                ...prefs,
                orchestration: {
                    ...state,
                    applied: normalized,
                    appliedAt: now,
                    appliedPolicyHash: (0, orchestrationPolicy_1.canonicalPolicyHash)(normalized),
                    lastInstallResults: [...kept, ...rows],
                },
            });
            return { ok: true, results: rows };
        },
        createLocalTerminalForPeer: ({ projectId, agentType, name, operationId }) => {
            if (!(agentType in types_1.AGENT_CONFIG))
                return Promise.resolve({ ok: false, error: 'Unknown AI agent type.' });
            return (0, terminal_1.requestRendererCreateTerminal)({
                projectId,
                agentType: agentType,
                name: (name || types_1.AGENT_CONFIG[agentType].name).slice(0, 200),
                terminalId: `device-${operationId}`.slice(0, 96),
            });
        },
    });
    // License handlers — pass broadcaster so the renderer is push-updated when
    // messages are sent or activation/deactivation changes the limits, instead
    // of the License tab polling on a 2s interval.
    (0, license_1.registerLicenseHandlers)((channel, payload) => {
        sendToRenderer(channel, payload);
    });
    // Entitlement diagnostics: last exchange verdict + log path, the gate decision
    // (P2 phase 2 — now authoritative), plus a manual re-run for testing.
    electron_1.ipcMain.handle('entitlement:shadow-status', () => {
        if (!entitlementState.shadow)
            return null;
        return { ...entitlementState.shadow.getStatus(), gate: entitlementState.gate?.getStatus() ?? null };
    });
    electron_1.ipcMain.handle('entitlement:shadow-run', async () => {
        if (!entitlementState.shadow)
            return null;
        return await entitlementState.shadow.run('manual');
    });
}
if (hasSingleInstanceLock) {
    electron_1.app.on('will-quit', () => {
        // Aborts main-owned background decompositions synchronously before their
        // CLI children can outlive Electron; persistence/watcher cleanup finishes
        // best-effort while the remaining quit handlers run.
        void (0, tasks_1.disposeTaskIpc)();
        void deviceIpc?.disposeDeviceService();
        browserPanelAutomation?.dispose();
        browserPanelAutomation = null;
        mcpActivityLog?.dispose();
        mcpActivityLog = null;
        void localTerminalAttachServer?.stop();
        localTerminalAttachServer = null;
    });
    electron_1.app.on('second-instance', (_event, argv) => {
        if (!mainWindow) {
            createWindow();
        }
        else {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.show();
            mainWindow.focus();
        }
        const incomingDeepLink = argv.find(deepLinkRouter.isDeepLinkUrl);
        if (incomingDeepLink) {
            deepLinkRouter.routeDeepLink(incomingDeepLink);
        }
        deepLinkRouter.routeOpenFiles(deepLinkRouter.extractOpenFilesFromArgv(argv));
    });
    electron_1.app.whenReady().then(() => {
        setupIpcHandlers();
        createWindow();
        (0, analytics_1.trackEvent)('app_started', {
            version: electron_1.app.getVersion(),
            platform: process.platform,
            arch: process.arch,
        });
        // Clean up orphaned tmux sessions from previous runs + start the tray —
        // both need the resolved backend (daemon selection is async, §5.1).
        void ptyBackendReady.then(() => {
            if (!ptyBackend || !storeManager)
                return;
            const cleanupBackend = ptyBackend;
            const knownTerminalIds = new Set();
            for (const project of storeManager.getProjects()) {
                for (const terminal of project.terminals) {
                    knownTerminalIds.add(terminal.id);
                }
            }
            void (async () => {
                for (const sessionId of await cleanupBackend.listTmuxSessions()) {
                    if (!knownTerminalIds.has(sessionId)) {
                        await cleanupBackend.killTmuxSession(sessionId);
                    }
                }
            })().catch(() => { });
            trayManager = new tray_1.TrayManager({
                ptyBackend: cleanupBackend,
                storeManager,
                focusMainWindow: applicationMenu.focusMainWindow,
                sendMenuCommand: applicationMenu.sendMenuCommand,
            });
            trayManager.start();
        });
        electron_1.app.on('activate', () => {
            if (electron_1.BrowserWindow.getAllWindows().length === 0) {
                // Clear session claims for fresh restore cycle, then re-protect the
                // bindings we already know so detection can't reassign them.
                resumeManager?.clearClaims();
                terminalSessionLifecycle.seedSessionClaimsFromStore();
                createWindow();
            }
        });
    });
}
