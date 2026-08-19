"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerOrchestrationHandlers = registerOrchestrationHandlers;
const fs_1 = __importDefault(require("fs"));
const linkNudge_1 = require("../../orchestration/linkNudge");
const hierarchyProvisioning_1 = require("../../orchestration/hierarchyProvisioning");
const shimInstall_1 = require("../../orchestration/shimInstall");
const pipeline_1 = require("../../../shared/orchestration/pipeline");
/** Tail served to a phone. Half the desktop cap — a relay connection should
 *  not stream a quarter megabyte per refresh. */
const REMOTE_LOG_TAIL_CAP = 128 * 1024;
const REMOTE_LOG_TAIL_DEFAULT = 64 * 1024;
const REMOTE_RUNS_CAP = 200;
const REMOTE_RUN_ERROR_CAP = 300;
/**
 * Orchestration v4 phone parity.
 *
 * Reads (`viewer`): snapshot, run index, run content tails, orchestration.log
 * tail — all id-based, main derives every path, and message bodies / native
 * session ids / capability tokens never cross the phone boundary.
 *
 * Decisions (`approver`, enforced in middleware/permission.ts): resolving a
 * pending link request and releasing/rejecting a queued message. Same
 * authority substitute as tasks:resolve-gate — the desktop proves a human via
 * a live renderer gesture; here the proof is a device the user paired and
 * granted `approver`. Graph-widening stays desktop-only: read-consent grants
 * require the desktop's disclosure preview, so approving a read-* request
 * from the phone fails closed with the registry's own error.
 */
function registerOrchestrationHandlers(io, deps) {
    const terminalIndex = () => new Map(deps.storeManager.getProjects().flatMap((project) => project.terminals.map((terminal) => [
        terminal.id,
        {
            name: terminal.name || terminal.agentType || terminal.id,
            pipelineName: terminal.name || terminal.agentType || '',
            ...(terminal.agentType ? { agentType: terminal.agentType } : {}),
        },
    ])));
    // Same notice the desktop injects on request approval: without it the
    // requesting agent never learns its link exists and the approval is inert.
    const injectInboundNudge = (link) => {
        const registry = deps.getLinkRegistry?.() ?? null;
        const from = deps.storeManager.findTerminalLocation(link.from.terminalId);
        const to = deps.storeManager.findTerminalLocation(link.to.terminalId);
        if (!registry || !from || !to)
            return;
        const nudge = (0, linkNudge_1.composeInboundLinkNudge)({
            link,
            fromTitle: from.terminal.name || from.terminal.agentType,
            toTitle: to.terminal.name || to.terminal.agentType,
            shimPath: (0, shimInstall_1.getOrchestratorShimPath)(),
        });
        void registry.deliverNotice(link, `link-nudge-${link.linkId}`, nudge);
    };
    io.on('connection', (socket) => {
        socket.on('orchestration:snapshot', async (_payload, ack) => {
            try {
                const controller = deps.getAgentTeamController?.() ?? null;
                const registry = deps.getLinkRegistry?.() ?? null;
                await controller?.initialize();
                const projects = deps.storeManager.getProjects();
                const projectNames = new Map(projects.map((project) => [project.id, project.name]));
                const terminals = terminalIndex();
                const nameOf = (terminalId) => terminals.get(terminalId)?.name ?? terminalId;
                const orchestrations = (controller?.listForRenderer() ?? []).map((item) => {
                    const units = item.topology === 'team' ? item.members : item.workers;
                    const host = terminals.get(item.hostTerminalId);
                    return {
                        id: item.topology === 'team' ? item.teamId : item.swarmId,
                        topology: item.topology,
                        projectId: item.projectId,
                        projectName: projectNames.get(item.projectId) ?? '',
                        state: item.state,
                        updatedAt: item.updatedAt,
                        hostTerminalId: item.hostTerminalId,
                        hostTerminalName: nameOf(item.hostTerminalId),
                        ...(host?.agentType ? { hostAgentType: host.agentType } : {}),
                        members: units.map((unit) => ({
                            id: unit.id,
                            ...(unit.role ? { role: unit.role } : {}),
                            target: unit.target,
                            ...(unit.terminalId ? { terminalId: unit.terminalId } : {}),
                            ...(unit.terminalId && terminals.has(unit.terminalId)
                                ? { terminalName: terminals.get(unit.terminalId).name }
                                : {}),
                            state: unit.state,
                            needsInput: unit.needsInput === true,
                            needsAttention: unit.needsAttention === true,
                        })),
                    };
                });
                const links = (registry?.listLinks() ?? []).map((link) => ({
                    linkId: link.linkId,
                    projectId: link.projectId,
                    projectName: projectNames.get(link.projectId) ?? '',
                    fromTerminalId: link.from.terminalId,
                    fromName: nameOf(link.from.terminalId),
                    ...(terminals.get(link.from.terminalId)?.agentType
                        ? { fromAgent: terminals.get(link.from.terminalId).agentType }
                        : {}),
                    toTerminalId: link.to.terminalId,
                    toName: nameOf(link.to.terminalId),
                    ...(terminals.get(link.to.terminalId)?.agentType
                        ? { toAgent: terminals.get(link.to.terminalId).agentType }
                        : {}),
                    permissions: link.permissions,
                    delivery: link.delivery,
                    state: link.state,
                    ...(link.quarantineReason ? { quarantineReason: link.quarantineReason } : {}),
                }));
                const messages = (registry?.listMessageSummaries(undefined, 200) ?? []).map((message) => ({
                    messageId: message.messageId,
                    linkId: message.linkId,
                    projectId: message.projectId,
                    fromTerminalId: message.fromTerminalId,
                    fromName: nameOf(message.fromTerminalId),
                    toTerminalId: message.toTerminalId,
                    toName: nameOf(message.toTerminalId),
                    state: message.state,
                    ...(message.queuedReason ? { queuedReason: message.queuedReason } : {}),
                    createdAt: message.createdAt,
                    ...(message.deliveredAt ? { deliveredAt: message.deliveredAt } : {}),
                    ...(message.answeredAt ? { answeredAt: message.answeredAt } : {}),
                    ...(message.closedAt ? { closedAt: message.closedAt } : {}),
                }));
                const requests = (registry?.listLinkRequests() ?? [])
                    .filter((request) => request.state === 'pending')
                    .map((request) => ({
                    requestId: request.requestId,
                    projectId: request.projectId,
                    fromTerminalId: request.from.terminalId,
                    fromName: nameOf(request.from.terminalId),
                    toTerminalId: request.to.terminalId,
                    toName: nameOf(request.to.terminalId),
                    permissions: request.permissions,
                    delivery: request.delivery,
                    createdAt: request.createdAt,
                }));
                // Hierarchy inspect parity (v5 §8): seats, vacancies, orphaned
                // subtrees, and refusal/escalation counters. Bodies and route text
                // stay on the desktop — the phone gets states and counts.
                const activations = deps.getHierarchyActivations?.() ?? null;
                const hierarchies = activations
                    ? projects.flatMap((project) => {
                        const status = activations.status(project.id);
                        const activation = status.activation;
                        if (!activation || activation.state !== 'active')
                            return [];
                        const pipeline = (0, pipeline_1.isPipelineChart)(activation.chart);
                        const stages = pipeline ? (0, pipeline_1.pipelineStages)(activation.chart) : [];
                        const activePipelineRun = pipeline
                            ? registry?.pipelineRunStatus(activation.activationId, activation.chart) ?? null
                            : null;
                        return [{
                                activationId: activation.activationId,
                                projectId: project.id,
                                projectName: project.name,
                                maxChainDepth: activation.chart.maxChainDepth,
                                ...(pipeline ? { topology: 'pipeline' } : {}),
                                ...(activePipelineRun
                                    ? {
                                        activePipelineRun: {
                                            currentStageIndex: activePipelineRun.currentStageIndex,
                                            stageCount: activePipelineRun.stageCount,
                                            state: activePipelineRun.state,
                                            gateRound: activePipelineRun.gateRound,
                                            maxGateRounds: activePipelineRun.maxGateRounds,
                                            createdAt: activePipelineRun.createdAt,
                                            updatedAt: activePipelineRun.updatedAt,
                                        },
                                    }
                                    : {}),
                                seats: activation.chart.nodes.map((node) => {
                                    const seat = activation.seats.find((row) => row.nodeId === node.nodeId);
                                    const stageIndex = stages.findIndex((stage) => stage.nodeId === node.nodeId);
                                    return {
                                        ...(!pipeline ? { nodeId: node.nodeId } : {}),
                                        label: node.label,
                                        agentKind: node.selector.agentKind,
                                        tier: pipeline && stageIndex >= 0 ? stageIndex : status.tiers[node.nodeId] ?? 0,
                                        ...(!pipeline ? { terminalId: seat?.endpoint.terminalId ?? '' } : {}),
                                        terminalName: seat
                                            ? pipeline
                                                ? terminals.get(seat.endpoint.terminalId)?.pipelineName || node.label
                                                : nameOf(seat.endpoint.terminalId)
                                            : '',
                                        state: seat?.state ?? 'vacant',
                                        ...(seat?.vacantReason ? { vacantReason: seat.vacantReason } : {}),
                                        orphaned: pipeline ? false : status.orphanedNodeIds.includes(node.nodeId),
                                        ...(pipeline && stageIndex >= 0
                                            ? {
                                                stageIndex: stageIndex + 1,
                                                stageCount: stages.length,
                                                blocked: status.pipelineBlockedNodeIds?.includes(node.nodeId) === true,
                                                starved: status.pipelineStarvedNodeIds?.includes(node.nodeId) === true,
                                            }
                                            : {}),
                                    };
                                }),
                                violationCount: status.violationCount,
                                escalationCount: status.escalations.length,
                            }];
                    })
                    : [];
                ack?.({
                    ok: true,
                    snapshot: {
                        generatedAt: Date.now(),
                        orchestrations,
                        links,
                        messages,
                        requests,
                        ...(hierarchies.length > 0 ? { hierarchies } : {}),
                    },
                });
            }
            catch (error) {
                ack?.({
                    ok: false,
                    error: error instanceof Error ? error.message : 'Failed to inspect orchestration',
                });
            }
        });
        /**
         * Rebind a vacant hierarchy seat (`approver`, orchestration v5 §8).
         *
         * Same authority substitute as resolve-link-request: the desktop proves a
         * human via a live renderer gesture; here the proof is a paired device
         * the user granted `approver`. The flow is the SHARED provisioning
         * implementation, so a phone repair and a desktop repair leave identical
         * orgs. `terminalId` defaults to the seat's original terminal — the
         * common repair is "the same terminal relaunched"; seating a different
         * terminal stays a desktop action (the phone has no candidate picker).
         */
        socket.on('orchestration:rebind-seat', (payload, ack) => {
            const registry = deps.getLinkRegistry?.() ?? null;
            const activations = deps.getHierarchyActivations?.() ?? null;
            if (!registry || !activations) {
                ack?.({ ok: false, error: 'Hierarchy activation is unavailable' });
                return;
            }
            const { projectId, nodeId } = payload ?? {};
            if (typeof projectId !== 'string' || !projectId || typeof nodeId !== 'string' || !nodeId) {
                ack?.({ ok: false, error: 'invalid rebind request' });
                return;
            }
            try {
                const activation = activations.activeForProject(projectId);
                const seat = activation?.seats.find((row) => row.nodeId === nodeId);
                const terminalId = typeof payload?.terminalId === 'string' && payload.terminalId
                    ? payload.terminalId
                    : seat?.endpoint.terminalId;
                if (!terminalId) {
                    ack?.({ ok: false, error: 'no terminal to rebind to' });
                    return;
                }
                const result = (0, hierarchyProvisioning_1.rebindHierarchySeat)({
                    activations,
                    registry,
                    shimPath: (0, shimInstall_1.getOrchestratorShimPath)(),
                    log: (line) => console.warn('[hierarchy]', line),
                }, { projectId, nodeId, terminalId });
                ack?.({ ok: result.ok, ...(result.ok ? {} : { error: result.error }) });
            }
            catch (error) {
                ack?.({ ok: false, error: error instanceof Error ? error.message : 'Failed to rebind the seat' });
            }
        });
        /** Approve or deny a pending agent link request (`approver`). */
        socket.on('orchestration:resolve-link-request', (payload, ack) => {
            const registry = deps.getLinkRegistry?.() ?? null;
            if (!registry) {
                ack?.({ ok: false, error: 'Terminal links are unavailable' });
                return;
            }
            const { requestId, approve } = payload ?? {};
            if (typeof requestId !== 'string' || !requestId || typeof approve !== 'boolean') {
                ack?.({ ok: false, error: 'invalid link-request decision' });
                return;
            }
            try {
                // No read-consent grant exists on this transport: a request carrying
                // read-* permissions fails inside the registry ('read consent
                // required') and the desktop's disclosure flow stays the only path.
                const result = registry.resolveLinkRequest(requestId, approve);
                if (result.ok && result.link)
                    injectInboundNudge(result.link);
                ack?.({ ok: result.ok, ...(result.ok ? {} : { error: result.error }) });
            }
            catch (error) {
                ack?.({ ok: false, error: error instanceof Error ? error.message : 'Failed to resolve the request' });
            }
        });
        /** Release or reject a queued (confirm-gated) link message (`approver`). */
        socket.on('orchestration:resolve-link-message', async (payload, ack) => {
            const registry = deps.getLinkRegistry?.() ?? null;
            if (!registry) {
                ack?.({ ok: false, error: 'Terminal links are unavailable' });
                return;
            }
            const { messageId, approve } = payload ?? {};
            if (typeof messageId !== 'string' || !messageId || typeof approve !== 'boolean') {
                ack?.({ ok: false, error: 'invalid queued-message decision' });
                return;
            }
            try {
                const result = approve
                    ? await registry.approveQueuedMessage(messageId)
                    : registry.rejectQueuedMessage(messageId);
                ack?.({
                    ok: result.ok,
                    ...(result.ok ? {} : { error: result.detail ?? result.error ?? 'Failed to resolve the message' }),
                });
            }
            catch (error) {
                ack?.({ ok: false, error: error instanceof Error ? error.message : 'Failed to resolve the message' });
            }
        });
        /** Delegation run index (`viewer`) — the Logs source list of the phone's
         *  team detail view. */
        socket.on('orchestration:runs', (payload, ack) => {
            const tracker = deps.getRunTracker?.() ?? null;
            if (!tracker) {
                ack?.({ ok: true, runs: [] });
                return;
            }
            try {
                const limit = Math.min(Math.max(typeof payload?.limit === 'number' ? Math.floor(payload.limit) : 60, 1), REMOTE_RUNS_CAP);
                const projects = deps.storeManager.getProjects();
                const projectNames = new Map(projects.map((project) => [project.id, project.name]));
                const terminals = terminalIndex();
                const runs = tracker.list({ limit }).map((run) => ({
                    callId: run.callId,
                    target: run.target,
                    ...(run.category ? { category: run.category } : {}),
                    status: run.status,
                    startedAt: run.startedAt,
                    ...(typeof run.durationSeconds === 'number' ? { durationSeconds: run.durationSeconds } : {}),
                    contentCaptured: run.contentCaptured,
                    ...(run.error ? { error: run.error.slice(0, REMOTE_RUN_ERROR_CAP) } : {}),
                    ...(run.teamId ? { teamId: run.teamId } : {}),
                    ...(run.swarmId ? { swarmId: run.swarmId } : {}),
                    ...(run.hostTerminalId ? { hostTerminalId: run.hostTerminalId } : {}),
                    ...(run.hostTerminalId && terminals.has(run.hostTerminalId)
                        ? { hostTerminalName: terminals.get(run.hostTerminalId).name }
                        : {}),
                    ...(run.projectId ? { projectId: run.projectId } : {}),
                    ...(run.projectId && projectNames.has(run.projectId)
                        ? { projectName: projectNames.get(run.projectId) }
                        : {}),
                }));
                ack?.({ ok: true, runs });
            }
            catch (error) {
                ack?.({ ok: false, error: error instanceof Error ? error.message : 'Failed to list runs' });
            }
        });
        /** One captured run file (`viewer`). Id-based like the desktop channel:
         *  the phone supplies a callId + enum, main derives and validates paths. */
        socket.on('orchestration:run-file', (payload, ack) => {
            const tracker = deps.getRunTracker?.() ?? null;
            const file = payload?.file;
            if (!tracker) {
                ack?.({ ok: false, error: 'Run logs are unavailable' });
                return;
            }
            if (typeof payload?.callId !== 'string' || (file !== 'prompt' && file !== 'output' && file !== 'stderr')) {
                ack?.({ ok: false, error: 'invalid run file' });
                return;
            }
            try {
                const content = tracker.readRunFile(payload.callId, file);
                if (!content) {
                    ack?.({ ok: false, error: 'This file was not captured' });
                    return;
                }
                const sliced = content.text.length > REMOTE_LOG_TAIL_CAP;
                ack?.({
                    ok: true,
                    text: sliced ? content.text.slice(-REMOTE_LOG_TAIL_CAP) : content.text,
                    truncated: content.truncated || sliced,
                });
            }
            catch (error) {
                ack?.({ ok: false, error: error instanceof Error ? error.message : 'Failed to read the run file' });
            }
        });
        /** Tail of logs/orchestration.log (`viewer`) — apply results,
         *  reconciliation, prunes. Same fixed-id contract as the desktop channel. */
        socket.on('orchestration:app-log', (payload, ack) => {
            const logPath = deps.getRunTracker?.()?.getLogPath();
            if (!logPath) {
                ack?.({ ok: true, text: '', truncated: false });
                return;
            }
            const maxBytes = Math.min(Math.max(typeof payload?.maxBytes === 'number' ? payload.maxBytes : REMOTE_LOG_TAIL_DEFAULT, 1024), REMOTE_LOG_TAIL_CAP);
            try {
                const { size } = fs_1.default.statSync(logPath);
                const readBytes = Math.min(size, maxBytes);
                const fd = fs_1.default.openSync(logPath, 'r');
                try {
                    const buf = Buffer.alloc(readBytes);
                    fs_1.default.readSync(fd, buf, 0, readBytes, size - readBytes);
                    ack?.({ ok: true, text: buf.toString('utf-8'), truncated: size > readBytes });
                }
                finally {
                    fs_1.default.closeSync(fd);
                }
            }
            catch {
                ack?.({ ok: true, text: '', truncated: false });
            }
        });
    });
}
