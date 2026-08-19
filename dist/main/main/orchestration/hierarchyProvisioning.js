"use strict";
/**
 * Hierarchy seat provisioning (orchestration v5 §5) — the edge-minting,
 * role-nudge, rebind, and promote flows shared by the desktop IPC handlers,
 * resume-orchestration repair, and the phone's approver Rebind.
 *
 * One implementation on purpose: rebind semantics ("re-mint the seat's edges
 * to the new endpoint and re-inject the role nudge") must be identical no
 * matter which surface asked, or a phone repair and a desktop repair would
 * leave different orgs behind.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SPAWNED_SEAT_ENDPOINT_TIMEOUT_MS = exports.PROMPT_PIPELINE_CHART_ID = void 0;
exports.waitForSpawnedSeatEndpoint = waitForSpawnedSeatEndpoint;
exports.promptPipelineActivationMatches = promptPipelineActivationMatches;
exports.composeSeatNudge = composeSeatNudge;
exports.injectSeatNudge = injectSeatNudge;
exports.mintHierarchyEdge = mintHierarchyEdge;
exports.seatEdgePairs = seatEdgePairs;
exports.rebindHierarchySeat = rebindHierarchySeat;
exports.promoteHierarchySeat = promoteHierarchySeat;
const hierarchy_1 = require("../../shared/orchestration/hierarchy");
const linkNudge_1 = require("./linkNudge");
const pipeline_1 = require("../../shared/orchestration/pipeline");
exports.PROMPT_PIPELINE_CHART_ID = 'prompt-pipeline';
/** How long a seat main just spawned may take to own a live PTY (§5.1). */
exports.SPAWNED_SEAT_ENDPOINT_TIMEOUT_MS = 15_000;
/**
 * Endpoint of a terminal main just asked the renderer to create.
 *
 * The create ack lands as soon as the DURABLE terminal record exists — the
 * renderer starts `pty.create` but answers before awaiting it (App.tsx), so
 * for the first beats after a spawn there is no session generation and no
 * persisted project record to resolve, and `resolveEndpoint` answers null.
 * Activation must wait for the process instead of reporting the terminal it
 * just opened as "not a running AI terminal".
 */
async function waitForSpawnedSeatEndpoint(activations, terminalId, options = {}) {
    const timeoutMs = options.timeoutMs ?? exports.SPAWNED_SEAT_ENDPOINT_TIMEOUT_MS;
    const pollMs = Math.max(1, options.pollMs ?? 100);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const endpoint = activations.resolveEndpoint(terminalId);
        if (endpoint)
            return endpoint;
        if (Date.now() >= deadline)
            return null;
        await new Promise((resolve) => { setTimeout(resolve, pollMs); });
    }
}
/** Reuse only the exact semantic chart and exact live generation-bound seats. */
function promptPipelineActivationMatches(existing, chart, seats) {
    const existingStages = (0, pipeline_1.pipelineStages)(existing.chart);
    const requestedStages = (0, pipeline_1.pipelineStages)(chart);
    return existing.chart.chartId === exports.PROMPT_PIPELINE_CHART_ID
        && JSON.stringify((0, hierarchy_1.canonicalHierarchyProjection)(existing.chart))
            === JSON.stringify((0, hierarchy_1.canonicalHierarchyProjection)(chart))
        && existingStages.length === requestedStages.length
        && existingStages.every((stage, index) => {
            const existingSeat = existing.seats.find((seat) => seat.nodeId === stage.nodeId);
            const requestedSeat = seats[index];
            return existingSeat?.state === 'active'
                && requestedSeat?.nodeId === requestedStages[index]?.nodeId
                && existingSeat.endpoint.terminalId === requestedSeat?.endpoint.terminalId
                && existingSeat.endpoint.terminalGeneration === requestedSeat?.endpoint.terminalGeneration;
        });
}
/** Role card for one seat, from the FROZEN chart + live seat endpoints. */
function composeSeatNudge(chart, node, seats, shimPath) {
    const seatRef = (nodeId) => {
        const seatNode = chart.nodes.find((n) => n.nodeId === nodeId);
        const seat = seats.find((row) => row.nodeId === nodeId);
        return {
            label: seatNode?.label ?? nodeId,
            terminalId: seat?.endpoint.terminalId ?? `<${nodeId}>`,
        };
    };
    const seat = seats.find((row) => row.nodeId === node.nodeId);
    if ((0, pipeline_1.isPipelineChart)(chart)) {
        const stages = (0, pipeline_1.pipelineStages)(chart);
        const stageIndex = stages.findIndex((stage) => stage.nodeId === node.nodeId);
        const previous = stageIndex > 0 ? stages[stageIndex - 1] : undefined;
        const next = stageIndex >= 0 ? stages[stageIndex + 1] : undefined;
        return (0, linkNudge_1.composePipelineRoleNudge)({
            nodeLabel: node.label,
            stageIndex: stageIndex + 1,
            stageCount: stages.length,
            ...(node.brief ? { brief: node.brief } : {}),
            ...(previous ? { previous: seatRef(previous.nodeId), incomingQualityGate: previous.qualityGate } : {}),
            ...(next ? { next: seatRef(next.nodeId), outgoingQualityGate: node.qualityGate } : {}),
            maxGateRounds: chart.maxGateRounds ?? 2,
            shimPath,
            recipientAgentKind: seat?.endpoint.effectiveAgentKind ?? node.selector.agentKind,
        });
    }
    const plainManages = (0, hierarchy_1.hierarchyDirectSubordinates)(chart, node.nodeId).map(seatRef);
    // A manager must see when a report leads seats of its own: a director that
    // cannot see the subtree writes briefs like "do not delegate" straight at
    // it and the whole branch idles for the run (the pi field failure — codex
    // never knew claude managed anyone).
    const decoratedManages = plainManages.map((ref, index) => {
        const subordinateId = (0, hierarchy_1.hierarchyDirectSubordinates)(chart, node.nodeId)[index];
        const leads = (0, hierarchy_1.hierarchyDirectSubordinates)(chart, subordinateId);
        if (leads.length === 0)
            return ref;
        const shown = leads.slice(0, 2).map((id) => chart.nodes.find((n) => n.nodeId === id)?.label ?? id);
        const rest = leads.length - shown.length;
        return { ...ref, label: `${ref.label} — leads ${shown.join(', ')}${rest > 0 ? ` +${rest}` : ''}` };
    });
    const compose = (manages) => (0, linkNudge_1.composeHierarchyRoleNudge)({
        nodeLabel: node.label,
        role: (0, hierarchy_1.hierarchyNodeRole)(chart, node.nodeId),
        ...(node.brief ? { brief: node.brief } : {}),
        ...(node.reportsTo ? { reportsTo: seatRef(node.reportsTo) } : {}),
        takesTasksFrom: (0, hierarchy_1.hierarchyTaskSourceIds)(chart, node.nodeId).map(seatRef),
        manages,
        skipLevelTargets: (0, hierarchy_1.hierarchySkipLevelTargets)(chart, node.nodeId).map(seatRef),
        chainDepthLimit: chart.maxChainDepth,
        shimPath,
        recipientAgentKind: seat?.endpoint.effectiveAgentKind ?? node.selector.agentKind,
        ...(node.suppressReport ? { suppressReport: true } : {}),
    });
    try {
        return compose(decoratedManages);
    }
    catch {
        // A max-fanout chart with maxed labels can push the decorated roster past
        // the role-card byte cap. The decoration is a teaching aid, never worth a
        // failed delivery — fall back to the undecorated roster, which the cap
        // test pins as always bounded.
        return compose(plainManages);
    }
}
/** Deliver a seat's role card over any activation link pointing AT it —
 *  one notice per seat, never per edge (the resume-orchestration rule). */
function injectSeatNudge(registry, chart, node, seats, activationId, shimPath, log) {
    const seat = seats.find((row) => row.nodeId === node.nodeId);
    if (!seat || seat.state !== 'active')
        return Promise.resolve(false);
    const inbound = registry
        .linksForTerminal(seat.endpoint.terminalId)
        .inbound.find((link) => link.state === 'active');
    if (!inbound) {
        log?.(`no inbound link to nudge seat ${node.nodeId} — role card skipped`);
        return Promise.resolve(false);
    }
    const nudge = composeSeatNudge(chart, node, seats, shimPath);
    return registry.deliverNotice(inbound, `hierarchy-role-${activationId}-${node.nodeId}`, nudge);
}
/** Mint one directed hierarchy edge; pre-existing ACTIVE links are reused
 *  untouched (D7 — deactivation must never remove a user's ad-hoc link). */
function mintHierarchyEdge(registry, fromTerminalId, toTerminalId, mintedLinkIds) {
    const existing = registry
        .linksForTerminal(fromTerminalId)
        .outbound.find((link) => link.state === 'active' &&
        link.to.terminalId === toTerminalId &&
        link.permissions.includes('send'));
    if (existing)
        return { ok: true };
    const result = registry.ensureLink({
        fromTerminalId,
        toTerminalId,
        createdBy: 'hierarchy',
        permissions: ['send'],
        delivery: 'auto',
    });
    if (!result.ok)
        return result;
    if (result.created)
        mintedLinkIds.push(result.link.linkId);
    return { ok: true };
}
/** Every directed edge a seat participates in, per the chart (§5.2):
 *  down + up along manages; down + reverse along skip-level. */
function seatEdgePairs(chart, nodeId) {
    const pairs = [];
    for (const edge of chart.edges) {
        if (nodeId && edge.from !== nodeId && edge.to !== nodeId)
            continue;
        pairs.push({ fromNodeId: edge.from, toNodeId: edge.to });
        // Up/reverse edge: reports and replies need it; the guard, not edge
        // absence, is what stops a subordinate from INITIATING traffic up.
        pairs.push({ fromNodeId: edge.to, toNodeId: edge.from });
    }
    return pairs;
}
/**
 * Repair a vacant seat (§5.4): validate the terminal, re-mint the seat's
 * edges to the new endpoint (skipping vacant counterparts — their own rebind
 * re-mints later), update the durable record, re-inject the role nudge.
 *
 * `allowSelectorMismatch` is the promote-into-vacant-seat override (§10
 * stretch): the user explicitly seats a different agent kind, so the
 * selector check is skipped for exactly that call — never for plain rebinds.
 */
function rebindHierarchySeat(deps, input) {
    const { activations, registry, shimPath } = deps;
    const activation = activations.activeForProject(input.projectId);
    if (!activation)
        return { ok: false, error: 'no active hierarchy for this project' };
    const chart = activation.chart;
    const node = chart.nodes.find((row) => row.nodeId === input.nodeId);
    if (!node)
        return { ok: false, error: `unknown seat "${input.nodeId}"` };
    if (activation.seats.some((seat) => seat.state === 'active' && seat.endpoint.terminalId === input.terminalId)) {
        return { ok: false, error: 'that terminal already holds a seat' };
    }
    const endpoint = activations.resolveEndpoint(input.terminalId);
    if (!endpoint)
        return { ok: false, error: 'the terminal is not a running AI terminal' };
    if (endpoint.projectId !== input.projectId) {
        return { ok: false, error: 'the terminal is not in this project' };
    }
    if (!input.allowSelectorMismatch &&
        (0, hierarchy_1.headlessAgentKindForEffectiveKind)(endpoint.effectiveAgentKind) !== node.selector.agentKind) {
        return { ok: false, error: `seat "${node.nodeId}" needs a ${node.selector.agentKind} terminal` };
    }
    const nextSeats = activation.seats.map((seat) => seat.nodeId === node.nodeId
        ? { ...seat, endpoint, state: 'active', vacantReason: undefined }
        : seat);
    const mintedLinkIds = [];
    for (const pair of seatEdgePairs(chart, node.nodeId)) {
        const fromSeat = nextSeats.find((row) => row.nodeId === pair.fromNodeId);
        const toSeat = nextSeats.find((row) => row.nodeId === pair.toNodeId);
        if (!fromSeat || !toSeat)
            continue;
        // A vacant counterpart cannot be linked; its own rebind re-mints later.
        if (fromSeat.state !== 'active' || toSeat.state !== 'active')
            continue;
        const minted = mintHierarchyEdge(registry, fromSeat.endpoint.terminalId, toSeat.endpoint.terminalId, mintedLinkIds);
        if (!minted.ok) {
            for (const linkId of mintedLinkIds)
                registry.unlink(linkId);
            return { ok: false, error: `could not link ${pair.fromNodeId} → ${pair.toNodeId}: ${minted.error}` };
        }
    }
    const rebound = activations.rebindSeat(activation.activationId, node.nodeId, endpoint, mintedLinkIds);
    if (!rebound.ok) {
        for (const linkId of mintedLinkIds)
            registry.unlink(linkId);
        return rebound;
    }
    if (!input.skipNudge) {
        void injectSeatNudge(registry, chart, node, rebound.activation.seats, activation.activationId, shimPath, deps.log);
    }
    return { ok: true, activation: rebound.activation };
}
/**
 * Promote a subordinate into a vacant seat (§5.4 stretch, the swarm
 * promote-worker precedent). The subordinate's TERMINAL moves up: its own
 * seat is vacated (`promoted`) and the vacant seat rebinds to that terminal
 * with the selector check waived — an explicitly chosen stand-in manager is
 * allowed to be a different agent kind. Its role nudge re-teaches it the new
 * seat; the old seat repairs later via Rebind like any other vacancy.
 */
function promoteHierarchySeat(deps, input) {
    const { activations } = deps;
    const activation = activations.activeForProject(input.projectId);
    if (!activation)
        return { ok: false, error: 'no active hierarchy for this project' };
    const chart = activation.chart;
    if ((0, pipeline_1.isPipelineChart)(chart)) {
        return { ok: false, error: 'Pipeline seats cannot be promoted; rebind the exact frozen stage instead.' };
    }
    const target = activation.seats.find((row) => row.nodeId === input.nodeId);
    if (!target)
        return { ok: false, error: `unknown seat "${input.nodeId}"` };
    if (target.state !== 'vacant') {
        return { ok: false, error: `seat "${input.nodeId}" is not vacant — promotion fills vacancies only` };
    }
    if (!(0, hierarchy_1.hierarchyDirectSubordinates)(chart, input.nodeId).includes(input.fromNodeId)) {
        return { ok: false, error: `"${input.fromNodeId}" is not a direct subordinate of "${input.nodeId}"` };
    }
    const source = activation.seats.find((row) => row.nodeId === input.fromNodeId);
    if (!source || source.state !== 'active') {
        return { ok: false, error: `seat "${input.fromNodeId}" has no live terminal to promote` };
    }
    const terminalId = source.endpoint.terminalId;
    const vacated = activations.vacateSeat(activation.activationId, input.fromNodeId, 'promoted');
    if (!vacated.ok)
        return vacated;
    const rebound = rebindHierarchySeat(deps, {
        projectId: input.projectId,
        nodeId: input.nodeId,
        terminalId,
        allowSelectorMismatch: true,
    });
    if (!rebound.ok) {
        // Undo the vacate so a failed promotion leaves the org exactly as found.
        activations.rebindSeat(activation.activationId, input.fromNodeId, source.endpoint, []);
        return rebound;
    }
    return rebound;
}
