"use strict";
/**
 * Main-process MCP/agent bridge runtime.
 *
 * Terminal safety rules: docs/common-errors/terminals/INDEX.md (B1-B4, B15).
 * Compatibility terminal handoffs must render canonical skills for the target
 * agent, then use the existing renderer-owned paced prompt submission path.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMcpBridgeRuntime = createMcpBridgeRuntime;
const electron_1 = require("electron");
const interactiveDelegation_1 = require("../shared/interactiveDelegation");
const bridge_1 = require("./mcp-servers/_shared/bridge");
const setup_1 = require("./mcp-servers/_shared/setup");
const databaseTools_1 = require("./mcp-servers/tools/databaseTools");
const httpTools_1 = require("./mcp-servers/tools/httpTools");
const browserTools_1 = require("./mcp-servers/tools/browserTools");
const taskTools_1 = require("./mcp-servers/tools/taskTools");
const attention_1 = require("../shared/orchestration/attention");
const processAncestry_1 = require("./pty-backend/processAncestry");
const terminal_1 = require("./remote/handlers/terminal");
const peerAuthTransport_1 = require("./orchestration/peerAuthTransport");
const LinkReplyMailbox_1 = require("./orchestration/LinkReplyMailbox");
const TeamReadService_1 = require("./orchestration/TeamReadService");
const contracts_1 = require("../shared/terminal/contracts");
const hierarchy_1 = require("../shared/orchestration/hierarchy");
const pipeline_1 = require("../shared/orchestration/pipeline");
const nativeSessionBinding_1 = require("../shared/terminal/nativeSessionBinding");
const PEER_AUTH_ACTIONS = new Set([
    // PTY-attributed link sends use this authenticated local boundary. The
    // reply-token form normally uses the narrower file mailbox, with Mach kept
    // as a safe fallback before any mailbox request has been published.
    'link-send',
    'link-send-by-token',
    // Pull context and explicit note publication never have an HTTP downgrade.
    'link-peers',
    'link-read',
    'link-screen',
    'link-peek',
    'link-notes',
    'link-publish-artifact',
    // Team member selectors adapt onto the same consented terminal-link graph;
    // they never authorize against TeamMessageBus alone.
    'team-peers',
    'team-read',
    'team-screen',
    'team-peek',
    'team-notes',
]);
function createMcpBridgeRuntime({ getPtyBackend, getStoreManager, getDatabaseManager, getHttpClient, getOrchestrationRunTracker, getCliRegistry, getAgentTeamController, getLinkRegistry, getHierarchyActivations, getResumeManager, getBrowserPanelAutomation, getTasksManager, getMcpActivityLog, getWorkspaceOperations, sendToRenderer, }) {
    let mcpBridge = null;
    const hookSessionBindingGenerations = new Map();
    function startMcpBridge() {
        const activePtyManager = getPtyBackend();
        const storeManager = getStoreManager();
        if (!activePtyManager || !storeManager)
            return;
        const resumeManager = getResumeManager();
        const readService = resumeManager && getLinkRegistry()
            ? new TeamReadService_1.TeamReadService({
                registry: getLinkRegistry(),
                resumeManager,
                ptyBackend: activePtyManager,
            })
            : null;
        /**
         * Native hooks run inside the actual agent process tree, so their session
         * id outranks a heuristic or persisted binding. Validation is deliberately
         * fire-and-forget: hook acknowledgements stay bounded while main rechecks
         * terminal lifetime and compare-and-set state after the disk lookup.
         */
        const scheduleHookSessionBinding = (terminalId, rawSessionId) => {
            const sessionId = rawSessionId.trim();
            const initial = storeManager.findTerminalLocation(terminalId);
            const activeResumeManager = getResumeManager();
            if (!sessionId || !initial || !activeResumeManager)
                return;
            const agentType = (0, contracts_1.mapToResumeAgentType)(initial.terminal.agentType, initial.terminal.startupCommand) ?? initial.terminal.lastSessionAgentType;
            if (!agentType)
                return;
            const previousSessionId = initial.terminal.lastSessionId ?? null;
            if (previousSessionId === sessionId &&
                initial.terminal.lastSessionAgentType === agentType) {
                return;
            }
            const generation = (hookSessionBindingGenerations.get(terminalId) ?? 0) + 1;
            hookSessionBindingGenerations.set(terminalId, generation);
            const previousAgentType = initial.terminal.lastSessionAgentType ?? agentType;
            void (async () => {
                const detail = await activeResumeManager.getSessionDetail(agentType, sessionId);
                if (!detail || detail.id !== sessionId)
                    return;
                if (hookSessionBindingGenerations.get(terminalId) !== generation)
                    return;
                const current = storeManager.findTerminalLocation(terminalId);
                if (!current)
                    return;
                const event = {
                    projectId: current.project.id,
                    terminalId,
                    agentType,
                    sessionId,
                    previousSessionId,
                };
                const updates = (0, nativeSessionBinding_1.getNativeSessionBindingUpdate)(current.terminal, event);
                if (!updates)
                    return;
                if (!activeResumeManager.replaceClaimForTerminal({
                    terminalId,
                    agentType,
                    sessionId,
                    previousAgentType,
                    ...(previousSessionId ? { previousSessionId } : {}),
                })) {
                    return;
                }
                storeManager.saveProject({
                    ...current.project,
                    terminals: current.project.terminals.map((terminal) => terminal.id === terminalId ? { ...terminal, ...updates } : terminal),
                });
                sendToRenderer('resume:terminal-session-bound', event);
            })().catch((error) => {
                console.warn('[session-bind] Native hook reconciliation failed:', error);
            }).finally(() => {
                if (hookSessionBindingGenerations.get(terminalId) === generation) {
                    hookSessionBindingGenerations.delete(terminalId);
                }
            });
        };
        mcpBridge = new bridge_1.McpBridge();
        mcpBridge.setAppVersion(electron_1.app.getVersion());
        mcpBridge.resolveTerminalId = ({ sourcePid, sourcePpid }) => activePtyManager.findTerminalByProcessAncestor(sourcePid) ??
            activePtyManager.findTerminalByProcessAncestor(sourcePpid) ??
            undefined;
        // Authorization sites (orchestration verbs, interactive delegation) may
        // await ONE attribution refresh on a miss — on Windows the sync answer
        // comes from a 5s-TTL process snapshot, and a cold snapshot must read as
        // "not yet", never as "not yours".
        mcpBridge.refreshTerminalAttribution = () => (0, processAncestry_1.awaitProcessAttributionRefresh)();
        (0, databaseTools_1.registerDatabaseTools)(mcpBridge, {
            databaseManager: getDatabaseManager(),
            storeManager,
            notifyResult: (payload) => sendToRenderer('db:tool-result', payload),
        });
        (0, httpTools_1.registerHttpTools)(mcpBridge, {
            httpClient: getHttpClient(),
            storeManager,
            notifyResult: (payload) => sendToRenderer('http:tool-result', payload),
        });
        (0, taskTools_1.registerTaskTools)(mcpBridge, {
            getTasksManager,
            storeManager,
            resolveWorkspaceProjectIds: (workspaceId) => getWorkspaceOperations?.()?.resolveMemberProjectIds(workspaceId) ?? null,
            workspacesForProject: (projectId) => getWorkspaceOperations?.()?.workspacesForProject(projectId) ?? [],
        });
        const browserAutomation = process.env.ONEDEVTOOL_DISABLE_BROWSER_MCP === '1'
            ? null
            : getBrowserPanelAutomation();
        if (browserAutomation) {
            (0, browserTools_1.registerBrowserTools)(mcpBridge, { browserAutomation });
        }
        mcpBridge.setDisabledTools(storeManager.getMcpDisabledTools());
        mcpBridge.onToolStart = (event) => {
            const { callId, toolName, profile, startedAt, terminalId } = event;
            const location = terminalId ? storeManager.findTerminalLocation(terminalId) : null;
            getMcpActivityLog()?.start(event, {
                terminalLabel: location?.terminal.name,
                projectName: location?.project.name,
                agentType: location?.terminal.agentType,
            });
            sendToRenderer('mcp:tool-start', { callId, toolName, profile, startedAt, terminalId });
        };
        mcpBridge.onToolEnd = (payload) => {
            // Never structured-clone an unbounded Browser snapshot/screenshot or DB
            // result into every terminal view. The activity owner keeps a bounded,
            // redacted preview for Settings and the short-lived badge detail.
            const entry = getMcpActivityLog()?.complete(payload);
            sendToRenderer('mcp:tool-end', {
                callId: payload.callId,
                toolName: payload.toolName,
                profile: payload.profile,
                status: payload.status,
                endedAt: payload.endedAt,
                ...(entry?.outputPreview !== undefined ? { result: entry.outputPreview } : {}),
                ...(entry?.error ? { error: entry.error } : {}),
            });
        };
        mcpBridge.onToolDisabled = ({ callId, toolName, profile, rejectedAt, terminalId }) => {
            // This is a recovery affordance, not a normal tool lifecycle event.
            // Keep it small and explicitly attributed; rejected args never cross IPC.
            sendToRenderer('mcp:tool-disabled', {
                callId,
                toolName,
                profile,
                rejectedAt,
                terminalId,
            });
        };
        mcpBridge.onSubAgentStart = ({ callId, target, command, startedAt, timeoutSeconds, terminalId }) => {
            // Wake the run tracker regardless of attribution — meta.json (written by
            // the CLI before this POST) is authoritative; the event is only a hint.
            getOrchestrationRunTracker()?.hintScan();
            // Unattributed delegations stay unbadged rather than guessing a terminal
            // (same rule as MCP tool badges — see mcp-tool-badge-wrong-terminal.md).
            if (!terminalId)
                return;
            sendToRenderer('subagent:delegation-start', { callId, target, command, startedAt, timeoutSeconds, terminalId });
        };
        mcpBridge.onSubAgentEnd = (payload) => {
            getOrchestrationRunTracker()?.hintScan();
            sendToRenderer('subagent:delegation-end', payload);
        };
        mcpBridge.onInteractiveDelegation = async (request) => {
            const source = storeManager.findTerminalLocation(request.terminalId);
            if (!source) {
                return { ok: false, error: 'The calling terminal is no longer part of a 1DevTool project' };
            }
            // Interactive terminals use the same trusted defaults advertised by the
            // CLI registry (for example Claude's skip-permissions and Codex's bypass
            // flags), then append the validated routed model. These are app-owned
            // argv values, never caller-provided shell text.
            const defaultSpawnArgs = getCliRegistry()?.knownClis()
                .find((cli) => cli.id === request.target)
                ?.defaultSpawnArgs ?? [];
            const launch = (0, interactiveDelegation_1.buildInteractiveAgentLaunchSpec)(request.target, request.model, request.category, defaultSpawnArgs, process.platform === 'win32');
            if (!launch) {
                return {
                    ok: false,
                    error: request.model
                        ? `${request.target} cannot be opened interactively with model ${request.model}`
                        : `${request.target} does not have an interactive terminal launcher`,
                };
            }
            const initialPrompt = request.activationCommand
                ? (0, interactiveDelegation_1.buildInteractiveDelegationPrompt)(request.prompt, request.target, request.activationCommand)
                : request.prompt.trim();
            const created = await (0, terminal_1.requestRendererCreateTerminal)({
                projectId: source.project.id,
                agentType: launch.agentType,
                name: launch.name,
                command: launch.command,
                forceAiAgent: launch.forceAiAgent,
                worktreePath: source.terminal.worktreePath,
                initialPrompt,
                // Agent-initiated: the pane appears in the source project's grid, but
                // a background delegation must never yank the workspace away from
                // whatever project the user is in (BUG-40). focusWindow is reserved
                // for human-origin requests (phone Remote UI, Mission Control).
                focusWindow: false,
            });
            if (!created.ok || !created.terminalId) {
                return { ok: false, error: created.error ?? '1DevTool could not create the interactive terminal' };
            }
            return {
                ok: true,
                terminalId: created.terminalId,
                message: `Opened ${launch.name} in a visible 1DevTool terminal and handed off the task${request.activationCommand ? ` through ${request.activationCommand}` : ''}.`,
            };
        };
        const handleAgentOrchestration = async (request) => {
            // Token-attributed reply BEFORE the calling-terminal lookup: there is no
            // calling terminal to look up — the sender identity comes from main's
            // durable message record, validated against the single-use token that
            // was delivered inside the recipient terminal's envelope. This is the
            // only path home for agents whose exec shells are not PTY descendants
            // (Cline's hub daemon parents to launchd).
            if (request.action === 'link-send-by-token') {
                const registry = getLinkRegistry();
                const replyToken = typeof request.payload.replyToken === 'string' ? request.payload.replyToken.trim() : '';
                if (!registry || !replyToken) {
                    return { ok: false, error: 'This 1DevTool instance does not own the calling terminal' };
                }
                const result = await registry.sendReplyByToken({
                    replyToken,
                    body: String(request.payload.body ?? ''),
                    ...(request.payload.gateDecision === 'accept' || request.payload.gateDecision === 'reject'
                        ? { gateDecision: request.payload.gateDecision }
                        : {}),
                    ...(typeof request.payload.waitMs === 'number' ? { waitMs: request.payload.waitMs } : {}),
                });
                // An unknown token, or a federated message without its admission, means
                // this process cannot authoritatively resolve the capability. The latter
                // can occur when packaged + dev instances have different in-memory
                // snapshots of the shared link journal. Answer with the ownership-miss
                // phrase so the CLI keeps racing the other bridges instead of accepting
                // a stale instance's no-link response as the final result.
                if (!result.ok && ((result.error === 'invalid-request' && result.detail === 'unknown reply token') ||
                    (result.error === 'no-link' && result.detail === 'federated admission is missing'))) {
                    return { ok: false, error: 'This 1DevTool instance does not own the calling terminal' };
                }
                return result;
            }
            const controller = getAgentTeamController();
            const source = storeManager.findTerminalLocation(request.terminalId);
            if (!controller || !source)
                return { ok: false, error: 'The calling terminal is no longer available' };
            const principal = controller.principalForTerminal(request.terminalId, source.project.id);
            if ((request.action === 'terminal-hook-event' || request.action === 'hook-event') &&
                (request.payload.event === 'done' || request.payload.event === 'needs-input') &&
                typeof request.payload.sessionId === 'string') {
                scheduleHookSessionBinding(request.terminalId, request.payload.sessionId);
            }
            switch (request.action) {
                case 'link-peers':
                    return readService
                        ? readService.read(request.terminalId, { kind: 'peers' })
                        : { ok: false, reason: 'no-transcript', detail: 'Pull context reads are unavailable' };
                case 'link-read':
                    return readService
                        ? readService.read(request.terminalId, {
                            kind: 'transcript',
                            targetTerminalId: String(request.payload.targetTerminalId ?? ''),
                            ...(typeof request.payload.maxLines === 'number'
                                ? { maxLines: request.payload.maxLines }
                                : {}),
                            ...(request.payload.full === true ? { full: true } : {}),
                        })
                        : { ok: false, reason: 'no-transcript', detail: 'Pull context reads are unavailable' };
                case 'link-screen':
                    return readService
                        ? readService.read(request.terminalId, {
                            kind: 'screen',
                            targetTerminalId: String(request.payload.targetTerminalId ?? ''),
                            ...(typeof request.payload.rows === 'number' ? { rows: request.payload.rows } : {}),
                        })
                        : { ok: false, reason: 'no-transcript', detail: 'Pull context reads are unavailable' };
                case 'link-peek':
                    return readService
                        ? readService.read(request.terminalId, {
                            kind: 'freshness',
                            targetTerminalId: String(request.payload.targetTerminalId ?? ''),
                            ...(typeof request.payload.changedSince === 'string'
                                ? { changedSince: request.payload.changedSince }
                                : {}),
                        })
                        : { ok: false, reason: 'no-transcript', detail: 'Pull context reads are unavailable' };
                case 'link-notes':
                    return readService
                        ? readService.read(request.terminalId, {
                            kind: 'artifact',
                            targetTerminalId: String(request.payload.targetTerminalId ?? ''),
                            ...(typeof request.payload.maxLines === 'number'
                                ? { maxLines: request.payload.maxLines }
                                : {}),
                        })
                        : { ok: false, reason: 'no-transcript', detail: 'Pull context reads are unavailable' };
                case 'link-publish-artifact': {
                    const registry = getLinkRegistry();
                    return registry
                        ? registry.publishArtifact(request.terminalId, {
                            title: String(request.payload.title ?? ''),
                            body: String(request.payload.body ?? ''),
                        })
                        : { ok: false, error: 'Terminal links are unavailable' };
                }
                case 'whoami': {
                    // Advisory self-identity (v4 L8): what main believes about the
                    // bridge-attributed calling terminal. Never accepted back as proof.
                    const links = getLinkRegistry()?.linksForTerminal(request.terminalId) ?? { outbound: [], inbound: [] };
                    const peerName = (terminalId) => storeManager.findTerminalLocation(terminalId)?.terminal.name ?? terminalId;
                    const linkView = (row, peerId) => ({
                        peerTerminalId: peerId,
                        peerName: peerName(peerId),
                        // Peer's effective agent kind — the CLI link guard matches
                        // `run --to=<agent>` against this to fail fast onto `link send`.
                        agent: row.to.terminalId === peerId ? row.to.effectiveAgentKind : row.from.effectiveAgentKind,
                        permissions: row.permissions,
                        state: row.state,
                        delivery: row.delivery,
                    });
                    // Hierarchy role block (v5 §7.1): advisory, from the caller's seat
                    // in its project's active org. Absent when unseated.
                    const seatInfo = getHierarchyActivations?.()?.reportTarget(request.terminalId);
                    let hierarchy;
                    if (seatInfo) {
                        const { chart, seat, reportsToSeat } = seatInfo;
                        const node = chart.nodes.find((row) => row.nodeId === seat.nodeId);
                        const seatView = (nodeId) => {
                            const seatRow = seatInfo.activation.seats.find((row) => row.nodeId === nodeId);
                            return {
                                nodeId,
                                label: chart.nodes.find((row) => row.nodeId === nodeId)?.label ?? nodeId,
                                ...(seatRow ? { terminalId: seatRow.endpoint.terminalId, state: seatRow.state } : {}),
                            };
                        };
                        const stages = (0, pipeline_1.pipelineStages)(chart);
                        const stageIndex = stages.findIndex((stage) => stage.nodeId === seat.nodeId);
                        const activeRun = getLinkRegistry()?.activePipelineRun(seatInfo.activation.activationId);
                        hierarchy = {
                            nodeId: seat.nodeId,
                            label: node?.label ?? seat.nodeId,
                            ...((0, pipeline_1.isPipelineChart)(chart)
                                ? {
                                    topology: 'pipeline',
                                    stageIndex: stageIndex + 1,
                                    stageCount: stages.length,
                                    next: stageIndex >= 0 && stageIndex < stages.length - 1
                                        ? seatView(stages[stageIndex + 1].nodeId)
                                        : 'user',
                                    gateRound: activeRun?.currentMessageId
                                        ? getLinkRegistry()?.pipelineGateRound(activeRun.currentMessageId) ?? 0
                                        : 0,
                                    gateRoundLimit: chart.maxGateRounds ?? 2,
                                    runState: activeRun?.state,
                                }
                                : {}),
                            role: (0, hierarchy_1.hierarchyNodeRole)(chart, seat.nodeId),
                            tier: (0, hierarchy_1.deriveHierarchyTiers)(chart)[seat.nodeId] ?? 0,
                            reportsTo: reportsToSeat ? seatView(reportsToSeat.nodeId) : 'user',
                            manages: (0, hierarchy_1.hierarchyDirectSubordinates)(chart, seat.nodeId).map(seatView),
                            skipLevelTargets: (0, hierarchy_1.hierarchySkipLevelTargets)(chart, seat.nodeId).map(seatView),
                            chainDepthLimit: chart.maxChainDepth,
                        };
                    }
                    return {
                        ok: true,
                        terminalId: request.terminalId,
                        projectId: source.project.id,
                        projectName: source.project.name,
                        name: source.terminal.name || source.terminal.agentType,
                        agentType: source.terminal.agentType,
                        ...(source.terminal.lastSessionId ? { sessionId: source.terminal.lastSessionId } : {}),
                        principal: principal.kind,
                        ...(hierarchy ? { hierarchy } : {}),
                        links: {
                            outbound: links.outbound.map((row) => linkView(row, row.to.terminalId)),
                            inbound: links.inbound.map((row) => linkView(row, row.from.terminalId)),
                        },
                    };
                }
                case 'workspace-roster':
                case 'workspace-send':
                case 'workspace-broadcast':
                case 'workspace-collect':
                case 'workspace-operation-get': {
                    // Caller projectId comes ONLY from the attributed terminal's store
                    // record (D6) — a projectId in the body never authorizes anything.
                    const operations = getWorkspaceOperations?.();
                    if (!operations)
                        return { ok: false, error: 'Workspace operations are unavailable' };
                    const callerProjectId = source.project.id;
                    const workspaceId = typeof request.payload.workspaceId === 'string' && request.payload.workspaceId
                        ? request.payload.workspaceId
                        : undefined;
                    try {
                        switch (request.action) {
                            case 'workspace-roster':
                                return { ok: true, roster: operations.listRoster(callerProjectId, workspaceId, request.terminalId) };
                            case 'workspace-send':
                                return await operations.send({
                                    callerTerminalId: request.terminalId,
                                    callerProjectId,
                                    workspaceId,
                                    to: String(request.payload.to ?? ''),
                                    message: String(request.payload.message ?? ''),
                                });
                            case 'workspace-broadcast':
                                return await operations.broadcast({
                                    callerTerminalId: request.terminalId,
                                    callerProjectId,
                                    workspaceId,
                                    message: String(request.payload.message ?? ''),
                                    ...(request.payload.excludeSelf === false ? { excludeSelf: false } : {}),
                                    ...(typeof request.payload.limit === 'number' ? { limit: request.payload.limit } : {}),
                                });
                            case 'workspace-collect':
                                return await operations.collect({
                                    callerTerminalId: request.terminalId,
                                    callerProjectId,
                                    operationId: String(request.payload.operationId ?? ''),
                                    ...(typeof request.payload.timeoutSeconds === 'number'
                                        ? { timeoutSeconds: request.payload.timeoutSeconds }
                                        : {}),
                                });
                            default:
                                return {
                                    ok: true,
                                    operation: operations.getOperation({
                                        callerTerminalId: request.terminalId,
                                        operationId: String(request.payload.operationId ?? ''),
                                    }),
                                };
                        }
                    }
                    catch (error) {
                        return { ok: false, error: error instanceof Error ? error.message : String(error) };
                    }
                }
                case 'link-send': {
                    const registry = getLinkRegistry();
                    if (!registry)
                        return { ok: false, error: 'Terminal links are unavailable' };
                    const input = {
                        toTerminalId: String(request.payload.toTerminalId ?? ''),
                        body: String(request.payload.body ?? ''),
                        ...(typeof request.payload.waitMs === 'number' ? { waitMs: request.payload.waitMs } : {}),
                        ...(typeof request.payload.replyToMessageId === 'string'
                            ? { replyToMessageId: request.payload.replyToMessageId }
                            : {}),
                        ...(request.payload.gateDecision === 'accept' || request.payload.gateDecision === 'reject'
                            ? { gateDecision: request.payload.gateDecision }
                            : {}),
                    };
                    return registry.sendMessage(request.terminalId, input);
                }
                case 'hierarchy-report': {
                    // v5 §7.1: resolve the caller's seat and send over its up edge —
                    // the agent never needs its manager's terminal id. Fails with the
                    // teaching error outside an activation (invariant 29).
                    const registry = getLinkRegistry();
                    const activations = getHierarchyActivations?.();
                    if (!registry || !activations)
                        return { ok: false, error: 'Terminal links are unavailable' };
                    const seatInfo = activations.reportTarget(request.terminalId);
                    if (!seatInfo) {
                        return {
                            ok: false,
                            error: 'you are not seated in a hierarchy — use `link send --to=<terminalId>` (see whoami for your links)',
                        };
                    }
                    const pipeline = (0, pipeline_1.isPipelineChart)(seatInfo.chart);
                    if (request.payload.complete === true) {
                        if (!pipeline) {
                            return { ok: false, error: 'report --complete is valid only for the final seat of an active Pipeline' };
                        }
                        return registry.completePipelineRun(request.terminalId);
                    }
                    if (typeof request.payload.continueFromMessageId === 'string' && !pipeline) {
                        return { ok: false, error: '--continue is valid only in an active Pipeline' };
                    }
                    if (pipeline && request.payload.blocked === true) {
                        return registry.blockPipelineRun(request.terminalId, String(request.payload.body ?? ''));
                    }
                    if (!seatInfo.reportsToSeat) {
                        return {
                            ok: false,
                            error: pipeline
                                ? 'you are the final Pipeline stage — write the user-facing result here, then run `report --complete`.'
                                : 'you are a root of this hierarchy — you report to the user. Write results in your own terminal; do not look for a manager to message.',
                        };
                    }
                    // "review back to <me>, do not report to me" — the chain ends here.
                    // The seat behaves like a root: results (and BLOCKED questions) are
                    // written in its own terminal, never sent up (v5.1 prompt chains).
                    const seatNode = seatInfo.chart.nodes.find((row) => row.nodeId === seatInfo.seat.nodeId);
                    if (seatNode?.suppressReport) {
                        return {
                            ok: false,
                            error: 'the user asked for the chain to end at your seat — do not report up. Write the outcome (or BLOCKED: plus your question) in your own terminal; answers to direct questions still use --reply-to.',
                        };
                    }
                    if (seatInfo.reportsToSeat.state !== 'active') {
                        return {
                            ok: false,
                            error: 'your manager\'s seat is vacant (its terminal closed or relaunched) — ask the user to rebind it in Mission Control, then report again.',
                        };
                    }
                    const body = String(request.payload.body ?? '');
                    const blocked = request.payload.blocked === true;
                    // Escalation is a report with a marker, not a new verb (§6).
                    const composed = blocked
                        ? `BLOCKED: needs a decision from you or the user.\n\n${body}`
                        : body;
                    const sent = await registry.sendMessage(request.terminalId, {
                        toTerminalId: seatInfo.reportsToSeat.endpoint.terminalId,
                        body: composed,
                        ...(pipeline ? { pipelineIntent: 'handoff' } : {}),
                        ...(typeof request.payload.continueFromMessageId === 'string'
                            ? { continueFromMessageId: request.payload.continueFromMessageId }
                            : {}),
                        ...(typeof request.payload.waitMs === 'number' ? { waitMs: request.payload.waitMs } : {}),
                    });
                    if (blocked && sent.ok !== false) {
                        activations.recordEscalation(seatInfo.activation.activationId, {
                            at: Date.now(),
                            fromTerminalId: request.terminalId,
                            fromNodeId: seatInfo.seat.nodeId,
                            toTerminalId: seatInfo.reportsToSeat.endpoint.terminalId,
                            preview: body.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 120) ?? '',
                        });
                    }
                    return sent;
                }
                case 'link-request': {
                    const registry = getLinkRegistry();
                    if (!registry)
                        return { ok: false, error: 'Terminal links are unavailable' };
                    const rawPermissions = Array.isArray(request.payload.permissions)
                        ? request.payload.permissions.map((permission) => String(permission))
                        : undefined;
                    return registry.requestLink(request.terminalId, {
                        toTerminalId: String(request.payload.toTerminalId ?? ''),
                        ...(rawPermissions
                            ? {
                                permissions: rawPermissions,
                            }
                            : {}),
                        delivery: 'confirm',
                    });
                }
                case 'link-status': {
                    const registry = getLinkRegistry();
                    if (!registry)
                        return { ok: false, error: 'Terminal links are unavailable' };
                    // No `--message` = "what am I waiting on, what do I owe". Selected by
                    // the caller's own endpoint, so it discloses nothing foreign.
                    const messageId = typeof request.payload.messageId === 'string' ? request.payload.messageId : '';
                    if (!messageId) {
                        return { ok: true, board: registry.statusBoard(request.terminalId) };
                    }
                    return registry.messageStatus(request.terminalId, messageId);
                }
                case 'link-broadcast': {
                    const registry = getLinkRegistry();
                    if (!registry)
                        return { ok: false, error: 'Terminal links are unavailable' };
                    const rawVote = request.payload.vote;
                    const vote = rawVote && typeof rawVote === 'object' && !Array.isArray(rawVote)
                        ? rawVote
                        : null;
                    return registry.broadcast(request.terminalId, {
                        body: String(request.payload.body ?? ''),
                        ...(vote
                            ? {
                                vote: {
                                    question: String(vote.question ?? ''),
                                    ...(Array.isArray(vote.options)
                                        ? { options: vote.options.map((option) => String(option)) }
                                        : {}),
                                    ...(typeof vote.quorum === 'number' ? { quorum: vote.quorum } : {}),
                                },
                            }
                            : {}),
                    });
                }
                case 'link-vote': {
                    const registry = getLinkRegistry();
                    if (!registry)
                        return { ok: false, error: 'Terminal links are unavailable' };
                    return registry.vote(request.terminalId, {
                        decisionId: String(request.payload.decisionId ?? ''),
                        value: String(request.payload.value ?? ''),
                        ...(typeof request.payload.reason === 'string' ? { reason: request.payload.reason } : {}),
                    });
                }
                case 'link-decisions': {
                    const registry = getLinkRegistry();
                    if (!registry)
                        return { ok: false, error: 'Terminal links are unavailable' };
                    // Only decisions this terminal may vote in — eligibility is the
                    // disclosure boundary, same as receipts being sender-scoped.
                    const mine = registry
                        .listDecisions(source.project.id)
                        .filter((row) => row.eligibleTerminalIds.includes(request.terminalId));
                    return { ok: true, decisions: mine };
                }
                case 'terminal-hook-event': {
                    // Advisory attention inbox (v4 L6) for NON-Team terminals: the
                    // globally-installed Stop/notify hooks fire here when no run
                    // capability is armed. Nothing here touches run state — one card,
                    // bounded detail, nothing else.
                    if (request.payload.event !== 'done')
                        return { ok: true };
                    const output = typeof request.payload.output === 'string' ? request.payload.output : undefined;
                    const sessionId = typeof request.payload.sessionId === 'string' ? request.payload.sessionId : undefined;
                    let detail = output;
                    if (!detail) {
                        // Claude's Stop payload has no assistant text — read the bound
                        // transcript tail instead (once per completed turn, best-effort).
                        const agent = (0, contracts_1.mapToResumeAgentType)(source.terminal.agentType, source.terminal.startupCommand) ?? source.terminal.lastSessionAgentType;
                        const boundSession = sessionId ?? source.terminal.lastSessionId;
                        if (agent && boundSession) {
                            try {
                                const detailResult = await getResumeManager()?.getSessionDetail(agent, boundSession);
                                const lastAssistant = detailResult?.messages
                                    ?.filter((m) => m.role === 'assistant')
                                    .at(-1);
                                detail = typeof lastAssistant?.content === 'string' ? lastAssistant.content : undefined;
                            }
                            catch { /* advisory */ }
                        }
                    }
                    const bounded = detail && detail.length > attention_1.ATTENTION_DETAIL_MAX_CHARS
                        ? `${detail.slice(0, attention_1.ATTENTION_DETAIL_MAX_CHARS - 1)}…`
                        : detail;
                    const attention = {
                        id: `done-${request.terminalId}-${Date.now()}`,
                        kind: 'agent-done',
                        terminalId: request.terminalId,
                        projectId: source.project.id,
                        projectName: source.project.name,
                        terminalName: source.terminal.name || source.terminal.agentType,
                        agentType: source.terminal.agentType,
                        ...(bounded ? { detail: bounded } : {}),
                        timestamp: Date.now(),
                    };
                    sendToRenderer('app:attention-event', attention);
                    return { ok: true };
                }
                case 'team-start':
                    return controller.startTeam(principal, request.payload);
                case 'team-list':
                    return { ok: true, teams: controller.listTeams(principal) };
                case 'team-members': {
                    const teamId = String(request.payload.teamId ?? '');
                    const members = controller.teamMembers(principal, teamId);
                    return members ? { ok: true, members } : { ok: false, error: 'Team members are unavailable' };
                }
                case 'team-connections': {
                    const teamId = String(request.payload.teamId ?? '');
                    const connections = controller.teamConnections(principal, teamId);
                    return connections ? { ok: true, connections } : { ok: false, error: 'Team connections are unavailable' };
                }
                case 'team-peers': {
                    const teamId = String(request.payload.teamId ?? '');
                    const edges = controller.teamReadPeers(principal, teamId);
                    return edges
                        ? { ok: true, kind: 'peers', producedAt: Date.now(), edges }
                        : { ok: false, reason: 'no-connection', detail: 'The calling terminal is not a member of this Team' };
                }
                case 'team-read':
                case 'team-screen':
                case 'team-peek':
                case 'team-notes': {
                    const teamId = String(request.payload.teamId ?? '');
                    const targetMemberId = String(request.payload.targetMemberId ?? '');
                    const target = controller.teamReadTarget(principal, teamId, targetMemberId);
                    if (!target) {
                        return {
                            ok: false,
                            reason: 'no-connection',
                            detail: 'The Team or selected member is unavailable to the calling terminal',
                        };
                    }
                    if (!readService) {
                        return { ok: false, reason: 'no-transcript', detail: 'Pull context reads are unavailable' };
                    }
                    if (request.action === 'team-read') {
                        return readService.read(target.callerTerminalId, {
                            kind: 'transcript',
                            targetTerminalId: target.targetTerminalId,
                            ...(typeof request.payload.maxLines === 'number'
                                ? { maxLines: request.payload.maxLines }
                                : {}),
                            ...(request.payload.full === true ? { full: true } : {}),
                        });
                    }
                    if (request.action === 'team-screen') {
                        return readService.read(target.callerTerminalId, {
                            kind: 'screen',
                            targetTerminalId: target.targetTerminalId,
                            ...(typeof request.payload.rows === 'number' ? { rows: request.payload.rows } : {}),
                        });
                    }
                    if (request.action === 'team-peek') {
                        return readService.read(target.callerTerminalId, {
                            kind: 'freshness',
                            targetTerminalId: target.targetTerminalId,
                            ...(typeof request.payload.changedSince === 'string'
                                ? { changedSince: request.payload.changedSince }
                                : {}),
                        });
                    }
                    return readService.read(target.callerTerminalId, {
                        kind: 'artifact',
                        targetTerminalId: target.targetTerminalId,
                        ...(typeof request.payload.maxLines === 'number'
                            ? { maxLines: request.payload.maxLines }
                            : {}),
                    });
                }
                case 'team-send':
                    return controller.sendTeamMessage(principal, {
                        teamId: String(request.payload.teamId ?? ''),
                        toMemberId: String(request.payload.toMemberId ?? ''),
                        clientSubmissionId: String(request.payload.clientSubmissionId ?? ''),
                        body: String(request.payload.body ?? ''),
                        kind: 'follow-up',
                    });
                case 'team-ask':
                    return controller.askTeamMember(principal, {
                        teamId: String(request.payload.teamId ?? ''),
                        toMemberId: String(request.payload.toMemberId ?? ''),
                        clientSubmissionId: String(request.payload.clientSubmissionId ?? ''),
                        body: String(request.payload.body ?? ''),
                        kind: 'question',
                    }, typeof request.payload.timeoutMs === 'number' ? request.payload.timeoutMs : 0);
                case 'team-reply':
                    return controller.replyTeamMessage(principal, String(request.payload.messageId ?? ''), String(request.payload.clientSubmissionId ?? ''), String(request.payload.body ?? ''));
                case 'team-messages': {
                    const messages = controller.teamMessages(principal, String(request.payload.teamId ?? ''), typeof request.payload.cursor === 'number' ? request.payload.cursor : 0, typeof request.payload.limit === 'number' ? request.payload.limit : 50);
                    return messages ? { ok: true, ...messages } : { ok: false, error: 'Team messages are unavailable' };
                }
                case 'swarm-start':
                    return controller.startSwarm(principal, request.payload);
                case 'send':
                    return controller.send(principal, request.payload);
                case 'status':
                    return { ok: true, orchestration: controller.status(principal, String(request.payload.orchestrationId ?? '')) };
                case 'collect-run':
                    return controller.collectRun(principal, String(request.payload.runId ?? ''), typeof request.payload.timeoutMs === 'number' ? request.payload.timeoutMs : 0);
                case 'collect-swarm':
                    return controller.collectSwarm(principal, String(request.payload.swarmId ?? ''), typeof request.payload.cursor === 'number' ? request.payload.cursor : 0, typeof request.payload.limit === 'number' ? request.payload.limit : 20);
                case 'set-swarm-paused':
                    return controller.setSwarmPaused(principal, String(request.payload.swarmId ?? ''), request.payload.paused === true);
                case 'confirm-submit':
                    return controller.confirmQueuedSubmit(principal, String(request.payload.runId ?? ''));
                case 'resolve-confirmation': {
                    const outcome = request.payload.outcome;
                    if (outcome !== 'done' && outcome !== 'error' && outcome !== 'cancelled') {
                        return { ok: false, error: 'outcome must be done, error, or cancelled' };
                    }
                    return controller.resolveConfirmation(principal, String(request.payload.runId ?? ''), outcome);
                }
                case 'resolve-fallback': {
                    const action = request.payload.action;
                    if (!['retry', 'headless', 'reassign', 'skip', 'close'].includes(action)) {
                        return { ok: false, error: 'invalid fallback action' };
                    }
                    return controller.resolveFallback(principal, {
                        runId: String(request.payload.runId ?? ''),
                        action,
                        ...(typeof request.payload.target === 'string' ? { target: request.payload.target } : {}),
                    });
                }
                case 'promote-worker':
                    return controller.promoteSwarmWorker(principal, String(request.payload.swarmId ?? ''), String(request.payload.workerId ?? ''));
                case 'hook-event': {
                    const event = request.payload.event;
                    if (event !== 'done' && event !== 'needs-input')
                        return { ok: false, error: 'invalid native event' };
                    return controller.reportNativeEvent(principal, {
                        runId: String(request.payload.runId ?? ''),
                        capabilityToken: String(request.payload.capabilityToken ?? ''),
                        event,
                        ...(typeof request.payload.sessionId === 'string' ? { sessionId: request.payload.sessionId } : {}),
                        ...(typeof request.payload.output === 'string' ? { output: request.payload.output } : {}),
                    });
                }
                case 'stop':
                    return controller.stop(principal, String(request.payload.orchestrationId ?? ''), request.payload.closeTerminals === true, request.payload.finishRunning === true);
            }
        };
        mcpBridge.onAgentOrchestration = handleAgentOrchestration;
        mcpBridge.enableFeature('database');
        mcpBridge.enableFeature('http');
        if (browserAutomation)
            mcpBridge.enableFeature('browser');
        // Gates EXECUTION only (§6): the public schemas are registered statically
        // in server.ts, so disabling this fails calls fast but does not remove
        // tools from a connected client's context. Do not describe it as a context
        // saving anywhere in the UI.
        mcpBridge.enableFeature('tasks');
        mcpBridge.enableFeature('onedevtool');
        const bridgeForPeerAuth = mcpBridge;
        const peerAuthTransport = new peerAuthTransport_1.PeerAuthTransport({
            instanceId: bridgeForPeerAuth.getInstanceId(),
            ptyBackend: activePtyManager,
            onRequest: async (terminalId, request) => {
                if (!PEER_AUTH_ACTIONS.has(request.action)) {
                    return { ok: false, error: 'Unsupported peer-auth orchestration action' };
                }
                return handleAgentOrchestration({
                    action: request.action,
                    payload: request.payload,
                    terminalId,
                });
            },
            onEndpointChanged: (endpoint) => {
                bridgeForPeerAuth.setPeerAuthEndpoint(endpoint);
            },
            log: (line) => console.log(line),
        });
        const replyMailbox = new LinkReplyMailbox_1.LinkReplyMailbox({
            instanceId: bridgeForPeerAuth.getInstanceId(),
            onRequest: (request) => handleAgentOrchestration({
                action: 'link-send-by-token',
                terminalId: '',
                payload: {
                    replyToken: request.replyToken,
                    body: request.body,
                    ...(request.waitMs !== undefined ? { waitMs: request.waitMs } : {}),
                    ...(request.gateDecision ? { gateDecision: request.gateDecision } : {}),
                },
            }),
            log: (line) => console.log(line),
        });
        bridgeForPeerAuth.setReplyMailboxEndpoint(replyMailbox.start());
        bridgeForPeerAuth.onStop = () => {
            peerAuthTransport.stop();
            replyMailbox.stop();
        };
        // Start the single bridge
        bridgeForPeerAuth.start().then(async (port) => {
            console.log(`[mcp-bridge] Started on port ${port}`);
            await peerAuthTransport.start();
            const result = await (0, setup_1.install)();
            if (!result.ok) {
                console.warn(`[mcp-bridge] Auto-setup failed: ${result.error}`);
            }
        }).catch((error) => {
            replyMailbox.stop();
            console.warn('[mcp-bridge] Start failed:', error);
        });
    }
    return {
        getBridge: () => mcpBridge,
        startMcpBridge,
    };
}
