"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTerminalIpcHandlers = registerTerminalIpcHandlers;
/**
 * Terminal IPC hotspot. Read docs/common-errors/terminals/INDEX.md before
 * changing PTY creation, forwarding, prompt capture, replay, or tmux behavior.
 */
const electron_1 = require("electron");
const themes_1 = require("../../shared/themes");
const replay_1 = require("../../shared/terminal/replay");
const connectionProtocol_1 = require("../../shared/terminal/connectionProtocol");
const featureFlags_1 = require("../terminal-connection/featureFlags");
const agentIdentity_1 = require("../../shared/agentIdentity");
const contracts_1 = require("../../shared/terminal/contracts");
const promptHistoryCapture_1 = require("../../shared/terminal/promptHistoryCapture");
const aiAgentSignatures_1 = require("../aiAgentSignatures");
const aiPool_1 = require("../aiPool");
const terminalSizePolicy_1 = require("../remote/terminalSizePolicy");
const aiPreviewState_1 = require("../aiPreviewState");
const claudeSettings_1 = require("../claudeSettings");
const idb_1 = require("../simulator/idb");
const ssh_1 = require("../ssh");
const spawnSpec_1 = require("../pty-backend/spawnSpec");
const terminalAgentReadiness_1 = require("../terminalAgentReadiness");
function registerTerminalIpcHandlers({ ptyBackend, ptyBackendReady, terminalEnvService, tmuxService, storeManager, promptHistoryManager, sendToRenderer, sendToPopoutWindows, showCommandCompletionNotification, showAgentIdleNotification, emitActivityTerminalEvent, maybeFinalizePendingAiLogin, logClaudeScrollSettingsResults, contextFooterTracker, noteNonTeamInput, ptyOutputFlow, terminalConnectionService, }) {
    const pendingPromptInput = new Map();
    const readinessRequests = new Map();
    const getAiAgentPathOverrides = () => storeManager.getPreferences().aiAgentPaths || {};
    const getTerminalRecord = (terminalId) => storeManager.findTerminalLocation(terminalId) ?? null;
    // Set up command completion notification callback. In daemon mode the
    // backend materializes asynchronously — register once selection resolves.
    void ptyBackendReady.then(() => {
        ptyBackend.onCommandCompletion((terminalId, elapsedMs) => {
            void showCommandCompletionNotification(terminalId, elapsedMs);
            emitActivityTerminalEvent(terminalId, elapsedMs, 'command-finished');
        });
        ptyBackend.onTerminalOutputIdle((terminalId, elapsedMs) => {
            void showAgentIdleNotification(terminalId, elapsedMs);
            emitActivityTerminalEvent(terminalId, elapsedMs, 'agent-idle');
            void maybeFinalizePendingAiLogin(terminalId, 'idle');
            // NOTE: Do NOT call aiDiffManager.endRunningSessionForTerminal here.
            // The auto-session model (TerminalView.tsx) wants the AI Diff session
            // to stay 'running' for the entire terminal lifetime so subsequent
            // prompts keep getting tracked. Flipping to 'idle' here makes
            // handleFsEvent skip every file change after the first prompt
            // (src/main/aiDiff.ts:237-240 only reconciles status === 'running'
            // sessions). Sessions are sealed explicitly via the ai-diff:end-session
            // IPC, never via the idle heuristic.
        });
    });
    const outputSubscribers = new Map();
    const watchedWebContents = new Set();
    const watchedConnectionWebContents = new Set();
    const pendingRendererAcks = new Map();
    const pendingDetachTimers = new Map();
    function subscriberCount(terminalId) {
        let count = 0;
        for (const subscriber of outputSubscribers.get(terminalId)?.values() ?? []) {
            count += subscriber.count;
        }
        return count;
    }
    function settleBatchIfComplete(batchId) {
        const pending = pendingRendererAcks.get(batchId);
        if (!pending || pending.waitingFor.size > 0)
            return;
        pendingRendererAcks.delete(batchId);
        ptyOutputFlow?.acknowledgeOutputBatch(pending.terminalId, batchId);
    }
    function releaseSubscriber(webContentsId, terminalId) {
        for (const [batchId, pending] of pendingRendererAcks) {
            if (terminalId && pending.terminalId !== terminalId)
                continue;
            pending.waitingFor.delete(webContentsId);
            settleBatchIfComplete(batchId);
        }
    }
    function removeAllSubscriptionsFor(contentsId) {
        for (const [terminalId, subscribers] of outputSubscribers) {
            if (!subscribers.delete(contentsId))
                continue;
            if (subscribers.size === 0)
                outputSubscribers.delete(terminalId);
            ptyBackend.setDesktopAttachmentCount(terminalId, subscriberCount(terminalId));
            releaseSubscriber(contentsId, terminalId);
        }
        watchedWebContents.delete(contentsId);
    }
    function forwardOutputBatch(batch) {
        const subscribers = outputSubscribers.get(batch.terminalId);
        const waitingFor = new Set();
        if (subscribers) {
            for (const [contentsId, subscriber] of subscribers) {
                if (subscriber.contents.isDestroyed())
                    continue;
                try {
                    subscriber.contents.send('pty:output', batch);
                    waitingFor.add(contentsId);
                }
                catch {
                    // A closing popout is released below just like an unsubscribe.
                }
            }
        }
        pendingRendererAcks.set(batch.batchId, { terminalId: batch.terminalId, waitingFor });
        settleBatchIfComplete(batch.batchId);
    }
    ptyOutputFlow?.onOutputBatch(forwardOutputBatch);
    electron_1.ipcMain.handle('pty:subscribe-output', async (event, args) => {
        await ptyBackendReady;
        const { terminalId } = args;
        let subscribers = outputSubscribers.get(terminalId);
        if (!subscribers) {
            subscribers = new Map();
            outputSubscribers.set(terminalId, subscribers);
        }
        const contentsId = event.sender.id;
        const subscriber = subscribers.get(contentsId);
        subscribers.set(contentsId, {
            contents: event.sender,
            count: (subscriber?.count ?? 0) + 1,
        });
        ptyBackend.setDesktopAttachmentCount(terminalId, subscriberCount(terminalId));
        if (!watchedWebContents.has(contentsId)) {
            watchedWebContents.add(contentsId);
            event.sender.once('destroyed', () => removeAllSubscriptionsFor(contentsId));
        }
        // Cancel any pending auto-detach for this terminal
        const timer = pendingDetachTimers.get(terminalId);
        if (timer) {
            clearTimeout(timer);
            pendingDetachTimers.delete(terminalId);
        }
    });
    electron_1.ipcMain.handle('pty:unsubscribe-output', async (event, args) => {
        await ptyBackendReady;
        const { terminalId } = args;
        const subscribers = outputSubscribers.get(terminalId);
        const subscriber = subscribers?.get(event.sender.id);
        if (subscriber && subscriber.count > 1) {
            subscriber.count -= 1;
        }
        else {
            subscribers?.delete(event.sender.id);
            releaseSubscriber(event.sender.id, terminalId);
        }
        if (subscribers?.size === 0)
            outputSubscribers.delete(terminalId);
        const count = subscriberCount(terminalId);
        ptyBackend.setDesktopAttachmentCount(terminalId, count);
        if (count === 0) {
            // Schedule auto-detach for unobserved tmux terminals (Fix 6R)
            if (ptyBackend.usesTmux(terminalId)) {
                const detachTimer = setTimeout(() => {
                    pendingDetachTimers.delete(terminalId);
                    // Mark as auto-detaching so the exit event is suppressed
                    autoDetachingTerminals.add(terminalId);
                    void ptyBackend.detach(terminalId);
                }, 5000);
                pendingDetachTimers.set(terminalId, detachTimer);
            }
        }
    });
    electron_1.ipcMain.on('pty:ack-output', (event, args) => {
        const { terminalId, batchId } = args;
        const pending = pendingRendererAcks.get(batchId);
        if (!pending || pending.terminalId !== terminalId)
            return;
        pending.waitingFor.delete(event.sender.id);
        settleBatchIfComplete(batchId);
    });
    const desktopPrincipal = (contents) => ({
        origin: 'desktop',
        subjectId: String(contents.id),
        permissions: new Set(['read', 'input', 'resize']),
    });
    electron_1.ipcMain.handle('terminal-connection:attach', async (event, args) => {
        await ptyBackendReady;
        if (!(0, featureFlags_1.terminalConnectionV2Enabled)()) {
            throw new connectionProtocol_1.TerminalConnectionError('unsupported-version', 'Terminal Connection v2 is disabled for rollback');
        }
        const request = args.request;
        const location = getTerminalRecord(request?.terminalId);
        if (!request || !location) {
            throw new connectionProtocol_1.TerminalConnectionError('forbidden', 'The terminal is not available to this renderer');
        }
        if (request.historyMode === 'native-resume-live-only' &&
            (!location.terminal.lastSessionId || !(0, contracts_1.isInteractiveAgentTerminal)(location.terminal.agentType, location.terminal.startupCommand))) {
            throw new connectionProtocol_1.TerminalConnectionError('forbidden', 'Live-only hydration is reserved for a native agent resume');
        }
        const principal = desktopPrincipal(event.sender);
        if (!watchedConnectionWebContents.has(event.sender.id)) {
            watchedConnectionWebContents.add(event.sender.id);
            event.sender.once('destroyed', () => {
                watchedConnectionWebContents.delete(event.sender.id);
                terminalConnectionService.detachSubject('desktop', String(event.sender.id));
            });
        }
        // Desktop uses v2 only for atomic hydration today; live output continues
        // through the established renderer batch channel. Supplying a frame
        // callback here duplicated every live chunk over IPC and created an ACK
        // window no renderer consumed before its immediate post-hydration detach.
        return terminalConnectionService.attach(request, principal);
    });
    electron_1.ipcMain.handle('terminal-connection:ack', async (event, args) => {
        const { connectionId, syncGeneration, frameId } = args;
        return terminalConnectionService.ack(connectionId, syncGeneration, frameId, desktopPrincipal(event.sender));
    });
    electron_1.ipcMain.handle('terminal-connection:resync', async (event, args) => {
        const { connectionId } = args;
        return terminalConnectionService.resync(connectionId, desktopPrincipal(event.sender));
    });
    electron_1.ipcMain.handle('terminal-connection:detach', async (event, args) => {
        const { connectionId } = args;
        terminalConnectionService.detach(connectionId, desktopPrincipal(event.sender));
    });
    electron_1.ipcMain.handle('terminal-connection:owner', async (_event, args) => {
        await ptyBackendReady;
        const { terminalId } = args;
        if (!getTerminalRecord(terminalId))
            return null;
        return ptyBackend.getOwnerIdentity(terminalId);
    });
    electron_1.ipcMain.handle('terminal-connection:write-fenced', async (_event, args) => {
        await ptyBackendReady;
        const part = args.part;
        if (!part || !getTerminalRecord(part.terminalId)) {
            throw new connectionProtocol_1.TerminalConnectionError('forbidden', 'The terminal is not available to this renderer');
        }
        return ptyBackend.writeFenced(part);
    });
    electron_1.ipcMain.handle('terminal-connection:flush-fenced', async (_event, args) => {
        await ptyBackendReady;
        const part = args.part;
        if (!part || !getTerminalRecord(part.terminalId)) {
            throw new connectionProtocol_1.TerminalConnectionError('forbidden', 'The terminal is not available to this renderer');
        }
        return ptyBackend.flushFenced(part);
    });
    // Terminals being auto-detached should not send exit events to the renderer
    const autoDetachingTerminals = new Set();
    // Sniffer state stays local; the shared `dynamicAiTerminals` map lives in
    // `aiPreviewState.ts` so notification + dashboard preview resolvers can read it.
    const agentSniffers = new Map();
    // Per-terminal shell-line buffer used by the input-side launch detector
    // to catch `claude`/`codex`/etc. typed at a bash prompt before the
    // output sniffer sees the agent's banner.
    const pendingShellLine = new Map();
    // Shared stream wiring for every created terminal: sniffer, renderer
    // forwarding, exit fan-out.
    // OSC 10/11/12 color queries are answered HERE, at the PTY edge — not by
    // the renderer emulator. Hermes consumes the report only within a <100 ms
    // startup window; the renderer round trip (pty-host batch → main IPC →
    // renderer write chain → xterm parse → reply IPC back) misses that window
    // under load, and the late reply lands in its composer as typed
    // `]11;rgb:…` text, which then fails Agent Team readiness ("positively
    // empty composer"). Emulator replies are dropped in pty:input and the
    // Remote input path so every query is answered exactly once
    // (docs/common-errors/terminals/osc-color-report-late-delivery.md).
    const colorQueryCarry = new Map();
    const resolveActiveTerminalTheme = () => {
        const preferences = storeManager?.getPreferences();
        return (0, themes_1.resolveTheme)(preferences?.appearance.theme ?? 'system', storeManager?.getCustomThemes() ?? [], () => (electron_1.nativeTheme.shouldUseDarkColors ? 'dark' : 'light')) ?? (0, themes_1.getDefaultDarkTheme)();
    };
    const answerColorQueries = (terminalId, data) => {
        const carry = colorQueryCarry.get(terminalId) ?? '';
        // Hot path: one indexOf before any regex work.
        if (!carry && !data.includes('\x1b]1'))
            return;
        const scan = (0, replay_1.scanOscColorQueries)(carry, data);
        if (scan.carry)
            colorQueryCarry.set(terminalId, scan.carry);
        else
            colorQueryCarry.delete(terminalId);
        if (scan.queries.length === 0)
            return;
        // One theme resolve per scan — getPreferences() re-normalizes the whole
        // preferences object, so it must not run once per matched query.
        const theme = resolveActiveTerminalTheme();
        for (const query of scan.queries) {
            const color = query.code === '10'
                ? theme.terminal.foreground
                : query.code === '12'
                    ? theme.terminal.cursor
                    : theme.terminal.background;
            ptyBackend?.write(terminalId, (0, replay_1.formatOscColorReport)(query.code, color, query.terminator));
        }
    };
    function wireTerminalStreamHandlers(terminalId) {
        return {
            onData: (data, seq) => {
                answerColorQueries(terminalId, data);
                const sniffer = agentSniffers.get(terminalId);
                if (sniffer) {
                    const detected = sniffer.feed(data);
                    if (detected) {
                        aiPreviewState_1.dynamicAiTerminals.set(terminalId, detected);
                        agentSniffers.delete(terminalId);
                    }
                    else if (sniffer.isDone()) {
                        agentSniffers.delete(terminalId);
                    }
                }
                if (!ptyOutputFlow && subscriberCount(terminalId) > 0) {
                    // seq = pipe-buffer sequence of this chunk; lets a remounting view
                    // drop chunks its replay snapshot already contains
                    // (docs/common-errors/terminals/remount-replay-duplication.md).
                    sendToRenderer('pty:output', { terminalId, data, seq });
                    sendToPopoutWindows('pty:output', { terminalId, data, seq });
                }
            },
            onExit: (code) => {
                colorQueryCarry.delete(terminalId);
                contextFooterTracker?.detach(terminalId);
                void maybeFinalizePendingAiLogin(terminalId, 'exit');
                // Pool occupancy ends with the real child exit; the durable
                // assignment survives for restart / native resume (§11.4).
                void (0, aiPool_1.releaseOccupancy)(terminalId, `process exited (code ${code})`);
                // Suppress exit event for auto-detached tmux terminals
                if (autoDetachingTerminals.has(terminalId)) {
                    autoDetachingTerminals.delete(terminalId);
                    return;
                }
                sendToRenderer('pty:exit', { terminalId, code });
                sendToPopoutWindows('pty:exit', { terminalId, code });
            },
        };
    }
    // PTY handlers
    electron_1.ipcMain.handle('pty:create', async (_, args) => {
        await ptyBackendReady;
        const { terminalId, cwd, shell, command, agentType, forceAiAgent, poolReservationId } = args;
        // Hot switch-back short circuit: a live PTY instance means this create is
        // a renderer remount, not a launch. Return the same `exists` outcome the
        // backend would, before paying Claude settings reads, sniffer resets, or
        // spawn-spec/env policy that belong only to a true spawn. Deliberately
        // stricter than dashboard `isAlive`: a detached tmux session has no live
        // instance and must continue through the normal create/reattach path.
        // Stream handlers need no re-wire — they are stateless closures keyed by
        // terminalId, and the backend kept the originals from the true create.
        if (ptyBackend.hasLiveInstance(terminalId)) {
            return { ok: false, created: false, reattached: false, status: 'exists' };
        }
        const tmuxMouseBehavior = args.tmuxMouseBehavior ?? storeManager?.getPreferences().terminal.tmuxMouseBehavior ?? 'native-selection';
        // Pool integration (quota-center §11): BEFORE any pre-spawn ensure step,
        // consume the launch reservation or restore this terminal's durable
        // assignment — aligning global credentials under the cross-instance lock,
        // or refusing the spawn while a conflicting account holds a live lease.
        // The `exists` remount short-circuit above never reaches here (C3), so a
        // lease is acquired only for true spawns. No-op for unpooled terminals.
        const poolHandle = await (0, aiPool_1.prepareSpawn)({
            terminalId,
            agentType,
            command,
            poolReservationId,
            overrides: getAiAgentPathOverrides(),
        }).catch(() => null);
        if (poolHandle?.blocked) {
            return { ok: false, error: poolHandle.blocked, status: 'error' };
        }
        try {
            // Re-assert the scroll-fix settings right before every Claude launch:
            // the boot-time pass can be undone mid-session (claude's own /config
            // rewrites settings.json) or miss entirely (claude installed after
            // boot). The PTY's enriched env is what the spawned claude actually
            // inherits, so a CLAUDE_CONFIG_DIR exported in the user's rc file
            // resolves here even though the app's process.env never sees it.
            // Idempotent: when already correct this costs one small file read.
            if ((0, contracts_1.getDeclaredAgentKind)(agentType, command) === 'claude-command') {
                await (0, claudeSettings_1.ensureClaudeScrollSettings)(getAiAgentPathOverrides(), {
                    env: terminalEnvService.peekTerminalEnv(shell),
                    installOrchestrationHook: true,
                })
                    .then(logClaudeScrollSettingsResults)
                    .catch(() => { }); // never block a launch on settings hygiene
            }
            // Only sniff non-declared-AI terminals — declared AI ones already
            // flow through the accumulator. Sniffer self-stops after 8 KB / 2 s.
            const shouldSniff = !(0, contracts_1.isInteractiveAgentTerminal)(agentType, command, forceAiAgent);
            if (shouldSniff) {
                agentSniffers.set(terminalId, new aiAgentSignatures_1.AgentOutputSniffer());
            }
            // Policy resolves here: cwd, shell candidates with lazy per-candidate
            // env, tmux decision. The backend only executes the spec.
            const spec = (0, spawnSpec_1.buildSpawnSpec)({ terminalId, cwd, shell, command, agentType, forceAiAgent, tmuxMouseBehavior }, terminalEnvService, tmuxService);
            const handlers = wireTerminalStreamHandlers(terminalId);
            const outcome = await ptyBackend.create(spec, handlers.onData, handlers.onExit);
            if (outcome.status === 'exists') {
                // Lost a concurrent-create race — this call spawned nothing, so its
                // freshly acquired lease must not shadow the winner's.
                await poolHandle?.rollback();
                return { ok: false, created: false, reattached: false, status: 'exists' };
            }
            poolHandle?.commit();
            // Live footer capture for kinds that self-report "% context left".
            // Declared kind only (A1/A3) — sniffed/custom terminals never attach.
            // After create so onOutput binds to a live instance.
            contextFooterTracker?.attach(terminalId, (0, contracts_1.getDeclaredAgentKind)(agentType, command));
            return {
                ok: true,
                created: true,
                reattached: outcome.status === 'reattached-tmux',
                status: outcome.status,
                poolAccount: poolHandle?.account ?? undefined,
            };
        }
        catch (error) {
            await poolHandle?.rollback();
            return {
                ok: false,
                error: error instanceof Error ? error.message : 'Failed to start terminal',
                status: 'error',
            };
        }
    });
    electron_1.ipcMain.on('pty:input', (_, args) => {
        const { terminalId, data: rawData, origin = 'user' } = args;
        // The renderer emulator's own OSC color replies are dropped: main already
        // answered the query at the PTY edge (answerColorQueries above), and a
        // second, late reply is exactly the byte sequence that lands in Hermes's
        // composer as typed text (osc-color-report-late-delivery.md).
        const data = origin === 'terminal-response' ? (0, replay_1.stripOscColorReports)(rawData) : rawData;
        if (data.length === 0 && rawData.length > 0)
            return;
        if (noteNonTeamInput && !noteNonTeamInput(terminalId, data, origin))
            return;
        ptyBackend?.write(terminalId, data);
        // Accumulate input for AI terminal prompt history. Opens for declared
        // AI terminals AND for bash/custom terminals the sniffer promoted when
        // the user ran an agent CLI inside them.
        const record = getTerminalRecord(terminalId);
        if (!record)
            return;
        // Protocol replies the TUI asked for (cursor/DA reports) are not typing —
        // they must neither promote a terminal to "an agent is running here" nor
        // land in prompt history (B12).
        if (origin === 'terminal-response')
            return;
        const isDeclaredAi = (0, contracts_1.isInteractiveAgentTerminal)(record.terminal.agentType, record.terminal.startupCommand, record.terminal.forceAiAgent);
        // Input-side launch detection: before the output sniffer sees a banner,
        // watch for a shell prompt submission of `claude`/`codex`/etc. on a
        // non-AI terminal. On match, promote immediately so the very next
        // prompt the user sends to the agent counts.
        if (!isDeclaredAi && !aiPreviewState_1.dynamicAiTerminals.has(terminalId)) {
            let shellBuf = pendingShellLine.get(terminalId) || '';
            for (let i = 0; i < data.length; i++) {
                const ch = data[i];
                if (ch === '\r' || ch === '\n') {
                    const kind = (0, aiAgentSignatures_1.detectShellLaunchCommand)(shellBuf);
                    if (kind) {
                        aiPreviewState_1.dynamicAiTerminals.set(terminalId, kind);
                        agentSniffers.delete(terminalId);
                    }
                    shellBuf = '';
                }
                else if (ch === '\x7f' || ch === '\b') {
                    shellBuf = shellBuf.slice(0, -1);
                }
                else if (ch === '\x15' || ch === '\x03') {
                    shellBuf = '';
                }
                else if (ch >= ' ') {
                    shellBuf += ch;
                    if (shellBuf.length > 256)
                        shellBuf = shellBuf.slice(-256);
                }
            }
            pendingShellLine.set(terminalId, shellBuf);
        }
        const dynamicKind = aiPreviewState_1.dynamicAiTerminals.get(terminalId);
        if (!isDeclaredAi && !dynamicKind)
            return;
        // A '\r' is a claimed submit, not a proven one: `@`/`$` pickers confirm on
        // Enter while the composer keeps its text, and a bracketed paste carries
        // interior CRs. The shared state machine owns those rules (B4/B10).
        const captured = (0, promptHistoryCapture_1.feedPromptCapture)(pendingPromptInput.get(terminalId) ?? promptHistoryCapture_1.EMPTY_PROMPT_CAPTURE, data);
        pendingPromptInput.set(terminalId, captured.state);
        if (captured.prompts.length > 0 && promptHistoryManager) {
            try {
                // Derive effective agent type. Declared AI → use its kind; dynamic
                // AI → the sniffer told us which agent is running.
                const kind = (0, contracts_1.getDeclaredAgentKind)(record.terminal.agentType, record.terminal.startupCommand);
                const effectiveAgentType = (0, agentIdentity_1.resolvePromptHistoryAgentId)({
                    declaredKind: kind,
                    inferredKind: dynamicKind,
                    startupCommand: record.terminal.startupCommand,
                    agentType: record.terminal.agentType,
                });
                for (const promptText of captured.prompts) {
                    promptHistoryManager.save({
                        projectId: record.project.id,
                        projectName: record.project.name,
                        terminalId,
                        agentType: effectiveAgentType,
                        promptText,
                    });
                }
            }
            catch (e) {
                console.error('Failed to save prompt:', e);
            }
        }
    });
    electron_1.ipcMain.on('pty:resize', (_, args) => {
        const { terminalId, cols, rows } = args;
        if (!ptyBackend)
            return;
        // Only desktop panes (TerminalView/popout fits) use this channel, so it
        // doubles as the desktop-ownership signal: once a desktop pane has sized
        // a terminal, read-only Remote Control mirrors lock to desktop dims for
        // the rest of the app session — even while no pane is mounted.
        ptyBackend.recordDesktopSize(terminalId, cols, rows);
        // While an operator phone is viewing this terminal, the phone owns PTY
        // dims (docs/common-errors/remote/remote-phone-size-authority.md). The
        // desktop desire is recorded above as the heal target, but applying it
        // here would stomp the phone's grid on every pane fit and every 5s
        // dims-desync probe — the exact ping-pong the authority registry exists
        // to prevent. This gate is the single choke point: ALL desktop-side
        // resizes (pane fit, popout, SIGWINCH nudge, reformat) go through here.
        if (terminalSizePolicy_1.remoteSizeAuthority.hasAuthority(terminalId))
            return;
        ptyBackend.resize(terminalId, cols, rows);
    });
    // Whether an operator phone currently owns this terminal's PTY dims, and
    // which device it is. The renderer's dims-desync probe consults
    // `hasAuthority` so it doesn't try to heal the (deliberate) PTY↔xterm
    // mismatch back to desktop dims every 5 seconds; the terminal pane's
    // "Sized for phone" badge uses both fields to hydrate on mount (live
    // transitions arrive via the remote:size-authority-changed push).
    electron_1.ipcMain.handle('pty:remote-size-authority', async (_, args) => {
        return {
            hasAuthority: terminalSizePolicy_1.remoteSizeAuthority.hasAuthority(args.terminalId),
            deviceLabel: terminalSizePolicy_1.remoteSizeAuthority.deviceLabel(args.terminalId),
        };
    });
    // Current node-pty dims. The renderer's desync detector compares these with
    // xterm's grid — a mismatch means the agent is painting at a different width
    // than the one on screen (broken-wrap layout) and must be resynced.
    electron_1.ipcMain.handle('pty:get-size', async (_, args) => {
        await ptyBackendReady;
        return ptyBackend.getSize(args.terminalId);
    });
    // Original spawn time of a still-running PTY (0 when never spawned this app
    // session). Remounted panes use it to re-arm session detection with the real
    // spawn anchor — createInstance reports 0 for existing PTYs, and without
    // this the detection loop died permanently on the first tab/project switch
    // (see docs/common-errors/terminals/session-detect-remount-disarm-steal.md).
    electron_1.ipcMain.handle('pty:get-spawn-time', async (_, args) => {
        await ptyBackendReady;
        return ptyBackend.getSpawnTime(args.terminalId) ?? 0;
    });
    electron_1.ipcMain.handle('pty:wait-agent-ready', async (event, args) => {
        await ptyBackendReady;
        const { terminalId, requestId } = args;
        const requestKey = `${event.sender.id}:${requestId}`;
        const record = getTerminalRecord(terminalId);
        if (!record) {
            return { ok: false, reason: 'failed', error: 'Target terminal was not found.' };
        }
        const previous = readinessRequests.get(requestKey);
        previous?.abort();
        const abort = new AbortController();
        readinessRequests.set(requestKey, abort);
        const onDestroyed = () => abort.abort();
        event.sender.once('destroyed', onDestroyed);
        try {
            return await (0, terminalAgentReadiness_1.waitForBackendAgentReady)({
                backend: ptyBackend,
                connectionService: terminalConnectionService,
                terminalId,
                kind: (0, contracts_1.getDeclaredAgentKind)(record.terminal.agentType, record.terminal.startupCommand),
                signal: abort.signal,
            });
        }
        finally {
            event.sender.removeListener('destroyed', onDestroyed);
            if (readinessRequests.get(requestKey) === abort)
                readinessRequests.delete(requestKey);
        }
    });
    electron_1.ipcMain.on('pty:cancel-wait-agent-ready', (event, args) => {
        const { requestId } = args;
        readinessRequests.get(`${event.sender.id}:${requestId}`)?.abort();
    });
    electron_1.ipcMain.handle('pty:kill', async (_, args) => {
        await ptyBackendReady;
        const { terminalId } = args;
        pendingPromptInput.delete(terminalId);
        const subscribers = outputSubscribers.get(terminalId);
        if (subscribers) {
            for (const contentsId of subscribers.keys())
                releaseSubscriber(contentsId, terminalId);
            outputSubscribers.delete(terminalId);
        }
        ptyBackend.setDesktopAttachmentCount(terminalId, 0);
        aiPreviewState_1.dynamicAiTerminals.delete(terminalId);
        agentSniffers.delete(terminalId);
        pendingShellLine.delete(terminalId);
        const detachTimer = pendingDetachTimers.get(terminalId);
        if (detachTimer) {
            clearTimeout(detachTimer);
            pendingDetachTimers.delete(terminalId);
        }
        autoDetachingTerminals.delete(terminalId);
        await ptyBackend.kill(terminalId);
        // Explicit close ends BOTH occupancy and the durable assignment (§11.4).
        await (0, aiPool_1.endAssignment)(terminalId).catch(() => undefined);
    });
    electron_1.ipcMain.handle('pty:detach', async (_, args) => {
        await ptyBackendReady;
        const { terminalId } = args;
        await ptyBackend.detach(terminalId);
    });
    electron_1.ipcMain.handle('pty:session-generation', async (_, args) => {
        await ptyBackendReady;
        return ptyBackend.getSessionGeneration(args.terminalId);
    });
    // Tmux session management
    electron_1.ipcMain.handle('pty:has-tmux', async () => {
        return tmuxService.isAvailable();
    });
    electron_1.ipcMain.handle('pty:has-session', async (_, args) => {
        await ptyBackendReady;
        const { terminalId } = args;
        return ptyBackend.hasTmuxSession(terminalId);
    });
    electron_1.ipcMain.handle('pty:list-sessions', async () => {
        await ptyBackendReady;
        return ptyBackend.listTmuxSessions();
    });
    // Dependency management
    electron_1.ipcMain.handle('deps:get-status', async () => {
        const sshfsDiag = (0, ssh_1.diagnoseSshfs)();
        const idbDiag = (0, idb_1.diagnoseIdb)();
        return {
            tmux: {
                installed: tmuxService.isAvailable(),
                installCommand: tmuxService.getTmuxInstallCommand(),
                platform: process.platform,
            },
            idb: {
                installed: idbDiag.installed,
                installCommand: (0, idb_1.getIdbInstallCommand)(),
                platform: process.platform,
            },
            sshfs: {
                installed: sshfsDiag.installed,
                installCommand: (0, ssh_1.getSshfsInstallCommand)(),
                platform: process.platform,
            },
        };
    });
    electron_1.ipcMain.handle('deps:install-tmux', async () => {
        return tmuxService.installTmux((data) => {
            sendToRenderer('deps:install-log', { data });
        });
    });
    electron_1.ipcMain.handle('deps:recheck-tmux', async () => {
        return tmuxService.diagnoseTmux();
    });
    electron_1.ipcMain.handle('deps:install-sshfs', async () => {
        return (0, ssh_1.installSshfs)((data) => {
            sendToRenderer('deps:install-log', { data });
        });
    });
    electron_1.ipcMain.handle('deps:recheck-sshfs', async () => {
        return (0, ssh_1.diagnoseSshfs)();
    });
    electron_1.ipcMain.handle('deps:install-idb', async () => {
        return (0, idb_1.installIdb)((data) => {
            sendToRenderer('deps:install-log', { data });
        });
    });
    electron_1.ipcMain.handle('deps:recheck-idb', async () => {
        return (0, idb_1.diagnoseIdb)();
    });
    // Dashboard: cross-project terminal status
    electron_1.ipcMain.handle('pty:get-all-statuses', async () => {
        await ptyBackendReady;
        return ptyBackend.getAllStatuses();
    });
    electron_1.ipcMain.handle('pty:get-buffer-preview', async (_, args) => {
        await ptyBackendReady;
        const { terminalId, maxChars } = args;
        const record = getTerminalRecord(terminalId);
        const effectiveAgentType = (0, aiPreviewState_1.resolveEffectivePreviewAgentType)(terminalId, record?.terminal.agentType, record?.terminal.startupCommand, record?.terminal.forceAiAgent);
        return ptyBackend.getBufferPreview(terminalId, maxChars, effectiveAgentType ?? record?.terminal.agentType);
    });
    electron_1.ipcMain.handle('pipe:start-capture', async (_, args) => {
        await ptyBackendReady;
        const { terminalId } = args;
        await ptyBackend.startCapture(terminalId);
    });
    electron_1.ipcMain.handle('pipe:stop-capture', async (_, args) => {
        await ptyBackendReady;
        const { terminalId } = args;
        return ptyBackend.stopCapture(terminalId);
    });
    electron_1.ipcMain.handle('pipe:get-buffer', async (_, args) => {
        await ptyBackendReady;
        const { terminalId } = args;
        return ptyBackend.getBuffer(terminalId);
    });
    // Buffer + last chunk seq, captured atomically (used by remount replay to
    // dedup against deferred live output — remount-replay-duplication.md).
    electron_1.ipcMain.handle('pipe:get-buffer-snapshot', async (_, args) => {
        await ptyBackendReady;
        const { terminalId } = args;
        return ptyBackend.getBufferSnapshot(terminalId);
    });
    electron_1.ipcMain.handle('pipe:clear-buffer', async (_, args) => {
        await ptyBackendReady;
        const { terminalId } = args;
        await ptyBackend.clearBuffer(terminalId);
    });
    electron_1.ipcMain.handle('pipe:is-idle', async (_, args) => {
        await ptyBackendReady;
        const { terminalId, thresholdMs } = args;
        return ptyBackend.isIdle(terminalId, thresholdMs);
    });
}
