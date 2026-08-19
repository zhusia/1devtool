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
exports.createTerminalSessionLifecycle = createTerminalSessionLifecycle;
/**
 * Terminal shutdown/session hotspot. Read docs/common-errors/terminals/INDEX.md
 * before changing buffer persistence, session ownership, quit, or update handoff.
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const electron_1 = require("electron");
const contracts_1 = require("../shared/terminal/contracts");
const replay_1 = require("../shared/terminal/replay");
const analytics_1 = require("./analytics");
const cloudflared = __importStar(require("./cloudflared"));
const utility_1 = require("./pty-backend/utility");
const AppQuitService_1 = require("./services/AppQuitService");
const ssh_1 = require("./ssh");
function createTerminalSessionLifecycle(services, sendToRenderer) {
    let terminalQuitDecision = 'save';
    let terminalBuffersSavedForUpdateInstall = false;
    let quitSessionPromptOpen = false;
    let terminalTeardownInFlight = null;
    let finalShutdownInFlight = null;
    let finalShutdownComplete = false;
    let appServicesDisposed = false;
    let didTrackQuit = false;
    let pendingQuitConfirm = null;
    /**
     * Save terminal output buffers to their respective projects in the store.
     * Called on quit so plain shell scrollback survives a restart.
     *
     * AI agents (Claude/Codex/Gemini/etc. + any `forceAiAgent`) rehydrate via
     * session resume (`--resume <id>`, `codex resume <id>`) when a session id was
     * detected — their buffers are never saved (and stale ones are cleared) since
     * native resume replays a fresher transcript. AI terminals WITHOUT a session
     * id get a capped fallback buffer instead, so they reopen with a static
     * transcript rather than blank (Fix 3, docs/product/feedback/liam.md).
     */
    function saveTerminalBuffersFromMap(buffers) {
        if (!services.storeManager)
            return;
        const projects = services.storeManager.getProjects();
        for (const project of projects) {
            let updated = false;
            for (const terminal of project.terminals) {
                const buffer = buffers[terminal.id];
                if (buffer === undefined)
                    continue;
                if ((0, contracts_1.allowsSavedBufferRestore)(terminal.agentType, terminal.startupCommand, terminal.forceAiAgent)) {
                    terminal.savedBuffer = buffer;
                    updated = true;
                    continue;
                }
                if (terminal.lastSessionId) {
                    if (terminal.savedBuffer !== undefined) {
                        terminal.savedBuffer = undefined;
                        updated = true;
                    }
                    continue;
                }
                terminal.savedBuffer = (0, replay_1.composeAiFallbackSavedBuffer)(terminal.savedBuffer, buffer);
                updated = true;
            }
            if (updated) {
                services.storeManager.saveProject(project);
            }
        }
    }
    /**
     * One-time reaper for detached pty-daemons left behind by 1.45–1.47 builds of
     * the removed "Keep terminals alive across updates & restarts" feature.
     * Nothing in the app can talk to those daemons anymore; a survivor would hold
     * orphaned shell processes forever. SIGTERM triggers the old daemon's own
     * graceful shutdown (detach tmux — plain shells survive for normal reattach;
     * AI processes die and come back via session resume), then the state dir is
     * removed. Identity-checked via `ps` so a recycled pid is never signalled;
     * fully best-effort — any failure just leaves files that nothing reads.
     */
    function cleanupLegacyPtyDaemons() {
        try {
            const stateDir = path_1.default.join(electron_1.app.getPath('userData'), 'pty-daemon');
            if (!fs_1.default.existsSync(stateDir))
                return;
            if (process.platform !== 'win32') {
                const registryPath = path_1.default.join(stateDir, 'daemons.json');
                try {
                    const records = JSON.parse(fs_1.default.readFileSync(registryPath, 'utf8'));
                    for (const record of Array.isArray(records) ? records : []) {
                        const pid = record?.pid;
                        if (typeof pid !== 'number' || pid <= 0)
                            continue;
                        try {
                            const command = (0, child_process_1.execFileSync)('ps', ['-o', 'command=', '-p', String(pid)], {
                                encoding: 'utf8',
                                timeout: 2000,
                            });
                            if (command.includes('pty-daemon')) {
                                process.kill(pid, 'SIGTERM');
                            }
                        }
                        catch {
                            // Process already gone (ps exits non-zero) — nothing to reap.
                        }
                    }
                }
                catch {
                    // No/unreadable registry — still remove the dir below.
                }
            }
            // Give SIGTERM'd daemons a moment to finish their graceful shutdown
            // (which writes inside the dir), then delete the whole state dir.
            setTimeout(() => {
                try {
                    fs_1.default.rmSync(stateDir, { recursive: true, force: true });
                }
                catch {
                    // Best-effort.
                }
            }, 3000).unref?.();
        }
        catch {
            // Best-effort.
        }
    }
    async function saveTerminalBuffersAsync() {
        if (!services.ptyBackend)
            return;
        saveTerminalBuffersFromMap(await services.ptyBackend.getAllBuffers());
    }
    /**
     * Seed the resume claim registry with every terminal↔session binding already
     * persisted in the store, so a detection pass (especially the relaxed
     * mtime-based one) can never reassign a session another terminal owns.
     * Called after every clearClaims() and before the quit-time sweep.
     */
    function seedSessionClaimsFromStore() {
        if (!services.storeManager || !services.resumeManager)
            return;
        const seeds = [];
        for (const project of services.storeManager.getProjects()) {
            for (const terminal of project.terminals) {
                if (!terminal.lastSessionId)
                    continue;
                const agentType = terminal.lastSessionAgentType ?? (0, contracts_1.mapToResumeAgentType)(terminal.agentType, terminal.startupCommand);
                if (!agentType)
                    continue;
                seeds.push({ agentType, sessionId: terminal.lastSessionId, terminalId: terminal.id });
            }
        }
        services.resumeManager.seedClaims(seeds);
    }
    let sessionSweepInFlight = null;
    /**
     * Final safety net for AI-terminal session persistence: bind session ids for
     * terminals the renderer's live detection loop missed, so their conversations
     * auto-resume next launch instead of reopening blank. Detection is disk-based
     * (agent session files), so it works even after PTYs are detached/killed —
     * only the spawn-time snapshot must be taken while PtyManager still has it.
     *
     * Best-effort with a hard time budget; one shared scan (TTL-cached in
     * ResumeManager) serves all terminals, so the common case is a single
     * stat-sweep regardless of terminal count.
     */
    function sweepMissingTerminalSessionIds(budgetMs = 1500) {
        if (sessionSweepInFlight)
            return sessionSweepInFlight;
        if (!services.storeManager || !services.resumeManager || !services.ptyBackend)
            return Promise.resolve();
        // Snapshot synchronously — teardown may kill PTY state under the async work.
        const targets = [];
        for (const project of services.storeManager.getProjects()) {
            for (const terminal of project.terminals) {
                if (terminal.lastSessionId)
                    continue;
                const resumeType = (0, contracts_1.mapToResumeAgentType)(terminal.agentType, terminal.startupCommand);
                if (!resumeType)
                    continue;
                if (!(0, contracts_1.getAgentContinuityCapabilities)(terminal.agentType, terminal.startupCommand, terminal.forceAiAgent).canDetectSession)
                    continue;
                const startedAt = services.ptyBackend.getSpawnTime(terminal.id);
                if (!startedAt)
                    continue; // never spawned this app session — no detection window
                targets.push({
                    terminalId: terminal.id,
                    projectId: project.id,
                    agentType: resumeType,
                    cwd: terminal.cwd,
                    startedAt,
                    lastSubmitAt: services.ptyBackend.getLastSubmitTime(terminal.id) ?? null,
                    submittedPrompts: services.ptyBackend.getSubmittedPrompts(terminal.id),
                });
            }
        }
        if (targets.length === 0)
            return Promise.resolve();
        console.log(`[session-sweep] ${targets.length} AI terminal(s) missing a session id, sweeping (budget ${budgetMs}ms)`);
        const run = (async () => {
            const deadline = Date.now() + budgetMs;
            seedSessionClaimsFromStore();
            const hitsByProject = new Map();
            let swept = 0;
            for (const target of targets) {
                if (Date.now() >= deadline)
                    break;
                swept++;
                try {
                    const session = await services.resumeManager.detectSessionForTerminal(target.terminalId, target.agentType, target.cwd, target.startedAt, target.lastSubmitAt, target.submittedPrompts);
                    if (session) {
                        const hits = hitsByProject.get(target.projectId) ?? [];
                        hits.push({ terminalId: target.terminalId, sessionId: session.sessionId, agentType: target.agentType });
                        hitsByProject.set(target.projectId, hits);
                    }
                }
                catch {
                    // Best-effort — an unreadable session dir must not block quit.
                }
            }
            if (swept < targets.length) {
                console.log(`[session-sweep] budget exhausted, ${targets.length - swept} terminal(s) unswept`);
            }
            // Persist grouped per project, re-fetching fresh store state so concurrent
            // writes (e.g. saveTerminalBuffers) since the snapshot aren't clobbered.
            for (const [projectId, hits] of hitsByProject) {
                const project = services.storeManager.getProjects().find((p) => p.id === projectId);
                if (!project)
                    continue;
                let updated = false;
                for (const hit of hits) {
                    const terminal = project.terminals.find((t) => t.id === hit.terminalId);
                    if (!terminal || terminal.lastSessionId)
                        continue;
                    terminal.lastSessionId = hit.sessionId;
                    terminal.lastSessionAgentType = hit.agentType;
                    updated = true;
                    console.log(`[session-sweep] captured session=${hit.sessionId.slice(0, 12)} for terminal=${hit.terminalId.slice(0, 8)}`);
                }
                if (updated)
                    services.storeManager.saveProject(project);
            }
        })();
        sessionSweepInFlight = run.finally(() => {
            sessionSweepInFlight = null;
        });
        return sessionSweepInFlight;
    }
    function getPersistedTerminalSessionCount() {
        if (!services.storeManager)
            return 0;
        return services.storeManager.getProjects().reduce((count, project) => count + project.terminals.length, 0);
    }
    function shouldConfirmTerminalSessionQuit() {
        // Never block quit on an interactive dialog under headless E2E — there is no
        // user to click "Save & Quit"/"Quit Without Saving", so before-quit's
        // preventDefault would strand app.close() until the test harness force-kills
        // it (a 60s teardown timeout). Tests run against a disposable profile, so
        // just let the normal save/detach teardown run. Same NODE_ENV signal the
        // single-instance guard uses.
        if (process.env.NODE_ENV === 'test')
            return false;
        return Boolean(services.mainWindow && !services.mainWindow.isDestroyed() && getPersistedTerminalSessionCount() > 0);
    }
    function discardPersistedTerminalSessions() {
        if (!services.storeManager)
            return;
        for (const project of services.storeManager.getProjects()) {
            if (project.terminals.length === 0)
                continue;
            services.storeManager.saveProject({
                ...project,
                terminals: [],
            });
        }
    }
    // Illustrative resume commands for the quit dialog's AI-row animation, keyed
    // by declared agent kind (real syntax per services.resumeManager.getResumeCommand).
    const QUIT_RESUME_ILLUSTRATIONS = {
        'claude-command': 'claude --resume',
        codex: 'codex resume',
        gemini: 'gemini --resume',
        kimi: 'kimi --session',
        qwen: 'qwen --resume',
        grok: 'grok --resume',
        hermes: 'hermes --resume',
        cline: 'cline --id',
        amp: 'amp --resume',
        opencode: 'opencode -s',
        cursor: 'cursor-agent --resume',
    };
    function countTerminalSessionsForQuit() {
        let shellCount = 0;
        let aiCount = 0;
        const kindTallies = new Map();
        if (services.storeManager) {
            for (const project of services.storeManager.getProjects()) {
                for (const terminal of project.terminals) {
                    if ((0, contracts_1.isInteractiveAgentTerminal)(terminal.agentType, terminal.startupCommand, terminal.forceAiAgent)) {
                        aiCount += 1;
                        const kind = (0, contracts_1.getDeclaredAgentKind)(terminal.agentType, terminal.startupCommand);
                        if (kind && QUIT_RESUME_ILLUSTRATIONS[kind]) {
                            kindTallies.set(kind, (kindTallies.get(kind) ?? 0) + 1);
                        }
                    }
                    else {
                        shellCount += 1;
                    }
                }
            }
        }
        // Show the command for the user's most common agent; claude as fallback.
        let topKind = '';
        let topCount = 0;
        for (const [kind, count] of kindTallies) {
            if (count > topCount) {
                topKind = kind;
                topCount = count;
            }
        }
        const resumeCommand = QUIT_RESUME_ILLUSTRATIONS[topKind] ?? 'claude --resume';
        return { shellCount, aiCount, resumeCommand };
    }
    /**
     * Ask the renderer's animated QuitConfirmDialog for a decision. Resolves null
     * when the renderer can't be prompted (send failed, no listener acked in time,
     * or the window closed mid-prompt is settled as cancel) so the caller can fall
     * back to the native message box instead of stranding the quit.
     */
    function promptQuitConfirmInRenderer(targetWindow, counts) {
        return new Promise((resolve) => {
            const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            function settle(choice) {
                if (!pendingQuitConfirm || pendingQuitConfirm.requestId !== requestId)
                    return;
                pendingQuitConfirm = null;
                clearTimeout(ackTimer);
                targetWindow.removeListener('closed', onClosed);
                if (!targetWindow.isDestroyed()) {
                    targetWindow.webContents.removeListener('did-navigate', onRendererGone);
                    targetWindow.webContents.removeListener('render-process-gone', onRendererGone);
                }
                if (choice === null && !targetWindow.isDestroyed()) {
                    // A listener that mounts late must not show a stale dialog after we've
                    // already fallen back to the native prompt.
                    sendToRenderer('app:quit-confirm-dismiss', requestId);
                }
                resolve(choice);
            }
            const onClosed = () => settle('cancel');
            // A reload or renderer crash mid-prompt would strand the promise (and
            // quitSessionPromptOpen) forever — fall back to the native dialog instead.
            const onRendererGone = () => settle(null);
            // Preload acks on receipt only when a dialog listener is mounted; without
            // an ack the prompt would be invisible and quit silently blocked forever.
            const ackTimer = setTimeout(() => settle(null), 1500);
            pendingQuitConfirm = { requestId, settle, markAcked: () => clearTimeout(ackTimer) };
            targetWindow.once('closed', onClosed);
            targetWindow.webContents.on('did-navigate', onRendererGone);
            targetWindow.webContents.on('render-process-gone', onRendererGone);
            if (!sendToRenderer('app:quit-confirm', { requestId, ...counts })) {
                settle(null);
            }
        });
    }
    async function promptQuitConfirmNative(targetWindow, terminalCount) {
        const plural = terminalCount === 1 ? 'session' : 'sessions';
        const result = await electron_1.dialog.showMessageBox(targetWindow, {
            type: 'question',
            title: 'Quit 1DevTool?',
            message: `Save ${terminalCount} terminal ${plural} before quitting?`,
            detail: 'Saving keeps your terminal tabs, working folders, and recent output so you can pick up where you left off next time. ' +
                'Shell tabs keep running in the background (via tmux); AI agent tabs reopen with their conversation resumed, or with their last output restored. ' +
                'If you do not save, all terminal tabs in every project will be closed and any running terminal work will be stopped.',
            buttons: ['Save & Quit', 'Quit Without Saving', 'Cancel'],
            defaultId: 0,
            cancelId: 2,
            noLink: true,
        });
        if (result.response === 2)
            return 'cancel';
        return result.response === 1 ? 'discard' : 'save';
    }
    async function confirmTerminalSessionQuit() {
        const targetWindow = services.mainWindow;
        if (!targetWindow || targetWindow.isDestroyed() || quitSessionPromptOpen)
            return;
        quitSessionPromptOpen = true;
        try {
            const counts = countTerminalSessionsForQuit();
            const choice = (await promptQuitConfirmInRenderer(targetWindow, counts)) ??
                (targetWindow.isDestroyed()
                    ? 'cancel'
                    : await promptQuitConfirmNative(targetWindow, counts.shellCount + counts.aiCount));
            if (choice === 'cancel') {
                return;
            }
            terminalQuitDecision = choice;
            if (terminalQuitDecision === 'save') {
                await prepareTerminalSessionMetadataForSave();
            }
            (0, AppQuitService_1.forceAllowQuit)();
            electron_1.app.quit();
        }
        finally {
            quitSessionPromptOpen = false;
        }
    }
    /**
     * Last chance to bind session ids for AI terminals the live detection loop
     * missed, so their conversations auto-resume next launch instead of reopening
     * blank. The outer race caps a straggling scan so shutdown stays snappy.
     */
    async function prepareTerminalSessionMetadataForSave() {
        await Promise.race([
            sweepMissingTerminalSessionIds(1500),
            new Promise((resolve) => {
                setTimeout(resolve, 1800).unref();
            }),
        ]).catch(() => { });
    }
    /**
     * Persist terminal continuity before handing control to electron-updater.
     * Its hard-exit fallback can skip before-quit entirely, so relying on the
     * normal shutdown listener would lose current buffers and missed session ids.
     */
    async function saveTerminalSessionsBeforeUpdateInstall() {
        terminalQuitDecision = 'save';
        await prepareTerminalSessionMetadataForSave();
        await saveTerminalBuffersAsync();
        terminalBuffersSavedForUpdateInstall = true;
        // electron-updater has a hard-exit backstop that can bypass before-quit.
        // Drain/detach and terminate the child-scoped PTY host here so no native
        // PTY helper can race the bundle swap.
        await settleTerminalProcessesForShutdown();
        return () => {
            terminalBuffersSavedForUpdateInstall = false;
        };
    }
    async function settleTerminalProcessesForShutdown() {
        if (terminalTeardownInFlight)
            return terminalTeardownInFlight;
        const run = (async () => {
            const backend = services.ptyBackend;
            if (!backend)
                return;
            const continuityAndDetach = (async () => {
                if (terminalQuitDecision === 'discard') {
                    discardPersistedTerminalSessions();
                    await backend.killAll();
                    return;
                }
                if (!terminalBuffersSavedForUpdateInstall) {
                    await prepareTerminalSessionMetadataForSave();
                    await saveTerminalBuffersAsync();
                }
                // tmux sessions persist; direct PTYs end and reopen from their saved
                // buffer/session metadata, matching the pre-utility behavior.
                await backend.detachAll();
            })();
            const completed = await Promise.race([
                continuityAndDetach.then(() => true).catch((error) => {
                    console.warn('[terminal-shutdown] continuity/teardown failed:', error);
                    return true;
                }),
                new Promise((resolve) => {
                    setTimeout(() => resolve(false), 3500).unref?.();
                }),
            ]);
            if (!completed) {
                console.warn('[terminal-shutdown] timed out; terminating PTY utility host');
            }
            if (backend instanceof utility_1.UtilityPtyBackend) {
                await backend.shutdownHost(1_000);
            }
        })();
        terminalTeardownInFlight = run.finally(() => {
            terminalTeardownInFlight = null;
        });
        return terminalTeardownInFlight;
    }
    function disposeAppServices() {
        if (appServicesDisposed)
            return;
        appServicesDisposed = true;
        if (!didTrackQuit) {
            didTrackQuit = true;
            (0, analytics_1.trackEvent)('app_quit');
        }
        // An orphaned tunnel keeps its pairing URL alive; stop it synchronously.
        cloudflared.killTunnelSync();
        services.remoteServer?.stop().catch(() => { });
        services.simulatorManager?.dispose();
        services.fsManager?.unwatchAll();
        services.rustServiceBridge?.dispose();
        services.rustSidecarManager?.dispose();
        services.promptHistoryManager?.close();
        services.notesManager?.close();
        services.openCodeRunFailureWatcher?.stop();
        services.resumeManager?.close();
        services.skillsManager?.dispose();
        services.mcpBridge?.stop();
        services.lspHost?.shutdownAll();
        services.trayManager?.stop();
        void (0, ssh_1.unmountAllSshfs)();
    }
    function beginFinalShutdown() {
        if (finalShutdownInFlight)
            return finalShutdownInFlight;
        finalShutdownInFlight = (async () => {
            services.resumeManager?.clearClaims();
            await settleTerminalProcessesForShutdown();
            disposeAppServices();
            finalShutdownComplete = true;
            (0, AppQuitService_1.forceAllowQuit)();
            // Playwright closes Electron through its automation transport. Once
            // before-quit was prevented for async PTY teardown, re-entering app.quit
            // can leave that transport waiting forever on macOS. E2E profiles are
            // disposable and cleanup above has completed, so finish deterministically.
            if (process.env.NODE_ENV === 'test')
                electron_1.app.exit(0);
            else
                electron_1.app.quit();
        })().catch((error) => {
            // A failed persistence step must not make the app impossible to quit.
            console.warn('[terminal-shutdown] finalization failed:', error);
            disposeAppServices();
            finalShutdownComplete = true;
            (0, AppQuitService_1.forceAllowQuit)();
            if (process.env.NODE_ENV === 'test')
                electron_1.app.exit(0);
            else
                electron_1.app.quit();
        });
        return finalShutdownInFlight;
    }
    electron_1.app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') {
            electron_1.app.quit();
            return;
        }
        // macOS keeps the app resident after its last window closes. Match the
        // old behavior by saving/detaching terminals, while leaving app services
        // available for a later dock re-open; the next create restarts one host.
        services.resumeManager?.clearClaims();
        void settleTerminalProcessesForShutdown();
        services.simulatorManager?.dispose();
        services.fsManager?.unwatchAll();
        services.rustServiceBridge?.dispose();
        services.rustSidecarManager?.dispose();
    });
    electron_1.app.on('before-quit', (event) => {
        if (!(0, AppQuitService_1.isQuitAllowed)() && shouldConfirmTerminalSessionQuit()) {
            event.preventDefault();
            void confirmTerminalSessionQuit();
            return;
        }
        if (finalShutdownComplete)
            return;
        event.preventDefault();
        void beginFinalShutdown();
    });
    // Handle SIGTERM/SIGINT for graceful shutdown (e.g. systemd stop, Ctrl+C in dev)
    for (const signal of ['SIGTERM', 'SIGINT']) {
        process.on(signal, () => {
            (0, AppQuitService_1.forceAllowQuit)();
            electron_1.app.quit();
        });
    }
    function acknowledgeQuitConfirmation(requestId) {
        if (pendingQuitConfirm?.requestId === requestId) {
            pendingQuitConfirm.markAcked();
        }
    }
    function answerQuitConfirmation(requestId, choice) {
        if (!pendingQuitConfirm || pendingQuitConfirm.requestId !== requestId)
            return;
        const normalized = choice === 'save' || choice === 'discard' ? choice : 'cancel';
        pendingQuitConfirm.settle(normalized);
    }
    return {
        cleanupLegacyPtyDaemons,
        seedSessionClaimsFromStore,
        shouldConfirmTerminalSessionQuit,
        confirmTerminalSessionQuit,
        saveTerminalSessionsBeforeUpdateInstall,
        acknowledgeQuitConfirmation,
        answerQuitConfirmation,
    };
}
