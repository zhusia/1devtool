"use strict";
/**
 * Durable hierarchy activation store + enforcement facade (orchestration v5).
 *
 * Main owns activation records the way LinkRegistry owns links: atomic
 * tmp+rename snapshots in the control directory, crash-honest load. An
 * activation survives restarts as 'active' — but every seat is generation-
 * bound, so relaunched terminals reconcile to 'vacant' instead of silently
 * rebinding (the terminal-links quarantine discipline, §5.4). The chart
 * inside each record is FROZEN at activation (invariant 30).
 *
 * The enforcement facade (checkSend/broadcastScope) is what LinkRegistry
 * consults on agent-originated sends; classification itself is the pure
 * hierarchyGuard module. Refusals are journaled here (never a silent drop)
 * and served to Mission Control via the status snapshot.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HierarchyActivations = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const hierarchyActivation_1 = require("../../shared/orchestration/hierarchyActivation");
const hierarchy_1 = require("../../shared/orchestration/hierarchy");
const pipeline_1 = require("../../shared/orchestration/pipeline");
const hierarchyGuard_1 = require("./hierarchyGuard");
const MAX_STOPPED_ACTIVATIONS = 10;
class HierarchyActivations {
    activations = [];
    violations = {};
    escalations = {};
    loaded = false;
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    load() {
        if (this.loaded)
            return;
        this.loaded = true;
        try {
            const raw = fs_1.default.readFileSync(this.deps.storagePath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed?.version === 1) {
                this.activations = Array.isArray(parsed.activations) ? parsed.activations : [];
                this.violations = parsed.violations && typeof parsed.violations === 'object' ? parsed.violations : {};
                this.escalations = parsed.escalations && typeof parsed.escalations === 'object' ? parsed.escalations : {};
            }
        }
        catch {
            this.activations = [];
            this.violations = {};
            this.escalations = {};
        }
    }
    commit() {
        const dir = path_1.default.dirname(this.deps.storagePath);
        fs_1.default.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const tmp = `${this.deps.storagePath}.${process.pid}.tmp`;
        const payload = {
            version: 1,
            activations: this.activations,
            violations: this.violations,
            escalations: this.escalations,
        };
        fs_1.default.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
        fs_1.default.renameSync(tmp, this.deps.storagePath);
        this.deps.onChanged?.();
    }
    /** Vacate seats whose terminal closed/relaunched/changed identity. Every
     *  restart relaunches terminals, so post-restart seats reconcile vacant —
     *  the crash-honest analogue of link quarantine. Never rebinds silently. */
    reconcileSeats(activation) {
        let changed = false;
        for (const seat of activation.seats) {
            if (seat.state !== 'active')
                continue;
            const reason = this.seatMismatch(seat);
            if (reason) {
                seat.state = 'vacant';
                seat.vacantReason = reason;
                changed = true;
                this.deps.log?.(`hierarchy seat ${seat.nodeId} vacated (${reason})`);
            }
        }
        return changed;
    }
    seatMismatch(seat) {
        const identity = this.deps.getTerminalIdentity(seat.endpoint.terminalId);
        if (!identity)
            return 'terminal-closed';
        const generation = this.deps.getTerminalGeneration(seat.endpoint.terminalId);
        if (generation === undefined)
            return 'terminal-closed';
        if (generation !== seat.endpoint.terminalGeneration)
            return 'terminal-relaunched';
        if (identity.projectId !== seat.endpoint.projectId)
            return 'project-removed';
        if (identity.effectiveAgentKind !== seat.endpoint.effectiveAgentKind)
            return 'agent-kind-changed';
        return null;
    }
    /** Generation-bound endpoint for a LIVE interactive terminal, or null. */
    resolveEndpoint(terminalId) {
        const identity = this.deps.getTerminalIdentity(terminalId);
        const generation = this.deps.getTerminalGeneration(terminalId);
        if (!identity || generation === undefined)
            return null;
        if (identity.isInteractiveAgent === false)
            return null;
        return {
            terminalId,
            terminalGeneration: generation,
            projectId: identity.projectId,
            ...(identity.worktreePath ? { worktreePath: identity.worktreePath } : {}),
            effectiveAgentKind: identity.effectiveAgentKind,
        };
    }
    activeForProject(projectId) {
        this.load();
        const activation = this.activations.find((row) => row.state === 'active' && row.projectId === projectId) ?? null;
        if (activation && this.reconcileSeats(activation))
            this.commit();
        return activation;
    }
    activationIsActive(activationId) {
        this.load();
        return this.activations.some((activation) => activation.activationId === activationId && activation.state === 'active');
    }
    /** The active activation holding this terminal in an ACTIVE seat. */
    activationCoveringTerminal(terminalId) {
        this.load();
        for (const activation of this.activations) {
            if (activation.state !== 'active')
                continue;
            if (this.reconcileSeats(activation))
                this.commit();
            const seated = activation.seats.some((seat) => seat.state === 'active' && seat.endpoint.terminalId === terminalId);
            if (seated)
                return activation;
        }
        return null;
    }
    create(input) {
        this.load();
        if (this.activeForProject(input.projectId)) {
            return { ok: false, error: 'stop the current hierarchy first — one activation per project' };
        }
        const activation = {
            ...input,
            activationId: `ha-${(0, crypto_1.randomUUID)()}`,
            state: 'active',
            createdAt: Date.now(),
        };
        this.activations.push(activation);
        this.pruneStopped();
        this.commit();
        return { ok: true, activation };
    }
    stop(activationId) {
        this.load();
        const activation = this.activations.find((row) => row.activationId === activationId);
        if (!activation || activation.state !== 'active')
            return null;
        activation.state = 'stopped';
        this.commit();
        return activation;
    }
    rebindSeat(activationId, nodeId, endpoint, mintedLinkIds) {
        this.load();
        const activation = this.activations.find((row) => row.activationId === activationId);
        if (!activation || activation.state !== 'active') {
            return { ok: false, error: 'no active hierarchy to rebind' };
        }
        const seat = activation.seats.find((row) => row.nodeId === nodeId);
        if (!seat)
            return { ok: false, error: `unknown seat "${nodeId}"` };
        seat.endpoint = endpoint;
        seat.state = 'active';
        delete seat.vacantReason;
        activation.linkIds = [...new Set([...activation.linkIds, ...mintedLinkIds])];
        this.commit();
        return { ok: true, activation };
    }
    /** Explicitly vacate a seat (promotion moves its terminal elsewhere). */
    vacateSeat(activationId, nodeId, reason) {
        this.load();
        const activation = this.activations.find((row) => row.activationId === activationId);
        if (!activation || activation.state !== 'active') {
            return { ok: false, error: 'no active hierarchy to update' };
        }
        const seat = activation.seats.find((row) => row.nodeId === nodeId);
        if (!seat)
            return { ok: false, error: `unknown seat "${nodeId}"` };
        seat.state = 'vacant';
        seat.vacantReason = reason;
        this.commit();
        return { ok: true };
    }
    recordViolation(activationId, entry) {
        this.load();
        const rows = this.violations[activationId] ?? [];
        rows.push(entry);
        this.violations[activationId] = rows.slice(-hierarchyActivation_1.HIERARCHY_MAX_VIOLATION_RECORDS);
        this.commit();
    }
    recordEscalation(activationId, entry) {
        this.load();
        const rows = this.escalations[activationId] ?? [];
        if (entry.kind && entry.pipelineRunId && rows.some((row) => row.kind === entry.kind
            && row.pipelineRunId === entry.pipelineRunId
            && row.triggeringMessageId === entry.triggeringMessageId)) {
            return;
        }
        rows.push(entry);
        this.escalations[activationId] = rows.slice(-hierarchyActivation_1.HIERARCHY_MAX_ESCALATION_RECORDS);
        this.commit();
    }
    status(projectId) {
        this.load();
        const activation = this.activeForProject(projectId);
        if (!activation) {
            return {
                activation: null,
                tiers: {},
                violations: [],
                violationCount: 0,
                escalations: [],
                orphanedNodeIds: [],
            };
        }
        const vacantNodeIds = activation.seats
            .filter((seat) => seat.state === 'vacant')
            .map((seat) => seat.nodeId);
        const violations = this.violations[activation.activationId] ?? [];
        if ((0, pipeline_1.isPipelineChart)(activation.chart)) {
            const stages = (0, pipeline_1.pipelineStages)(activation.chart);
            const blocked = new Set();
            const starved = new Set();
            for (const vacantNodeId of vacantNodeIds) {
                const index = stages.findIndex((stage) => stage.nodeId === vacantNodeId);
                if (index < 0)
                    continue;
                stages.slice(0, index).forEach((stage) => blocked.add(stage.nodeId));
                stages.slice(index + 1).forEach((stage) => starved.add(stage.nodeId));
            }
            return {
                activation,
                tiers: (0, hierarchy_1.deriveHierarchyTiers)(activation.chart),
                violations: violations.slice(-20),
                violationCount: violations.length,
                escalations: (this.escalations[activation.activationId] ?? []).slice(-20),
                orphanedNodeIds: [],
                pipelineBlockedNodeIds: [...blocked],
                pipelineStarvedNodeIds: [...starved],
            };
        }
        return {
            activation,
            tiers: (0, hierarchy_1.deriveHierarchyTiers)(activation.chart),
            violations: violations.slice(-20),
            violationCount: violations.length,
            escalations: (this.escalations[activation.activationId] ?? []).slice(-20),
            orphanedNodeIds: (0, hierarchyActivation_1.orphanedSubtreeNodeIds)(activation.chart, vacantNodeIds),
        };
    }
    // --- Enforcement facade (consulted by LinkRegistry) -----------------------
    /**
     * Verdict for an agent-originated send. Null when no active org covers the
     * SENDER (unseated senders keep flat v4 semantics in both directions).
     * Refusals are journaled here — never a silent drop.
     */
    checkSend(input) {
        const activation = this.activationCoveringTerminal(input.fromTerminalId);
        if (!activation)
            return null;
        const verdict = (0, hierarchyGuard_1.classifyHierarchySend)({
            chart: activation.chart,
            seats: activation.seats,
            fromTerminalId: input.fromTerminalId,
            toTerminalId: input.toTerminalId,
            isReply: input.isReply,
            ...(input.hopCount !== undefined ? { hopCount: input.hopCount } : {}),
            ...(this.deps.getShimPath ? { shimPath: this.deps.getShimPath() } : {}),
            ...(input.senderAgentKind ? { senderAgentKind: input.senderAgentKind } : {}),
            ...(input.pipelineIntent ? { pipelineIntent: input.pipelineIntent } : {}),
            ...(input.replyPipelineKind ? { replyPipelineKind: input.replyPipelineKind } : {}),
            ...(input.gateDecision ? { gateDecision: input.gateDecision } : {}),
            ...(input.pipelineContinuationMessageId
                ? { pipelineContinuationMessageId: input.pipelineContinuationMessageId }
                : {}),
            ...(input.pipelinePendingGateMessageId
                ? { pipelinePendingGateMessageId: input.pipelinePendingGateMessageId }
                : {}),
        });
        if (!verdict.allow) {
            this.deps.log?.(`hierarchy refused ${input.fromTerminalId} → ${input.toTerminalId} (${verdict.class})`);
            this.recordViolation(activation.activationId, {
                at: Date.now(),
                fromTerminalId: input.fromTerminalId,
                toTerminalId: input.toTerminalId,
                ...(verdict.fromNodeId ? { fromNodeId: verdict.fromNodeId } : {}),
                ...(verdict.toNodeId ? { toNodeId: verdict.toNodeId } : {}),
                route: verdict.detail ?? 'refused: hierarchy',
            });
        }
        return verdict;
    }
    /** Direct-subordinate fan-out scope for a seated caller; null = unconstrained. */
    broadcastScope(callerTerminalId) {
        const activation = this.activationCoveringTerminal(callerTerminalId);
        if (!activation)
            return null;
        return (0, hierarchyGuard_1.hierarchyBroadcastScope)(activation.chart, activation.seats, callerTerminalId);
    }
    /** Resolve the caller's reportsTo seat for the `report` verb (v5 §7.1). */
    reportTarget(callerTerminalId) {
        const activation = this.activationCoveringTerminal(callerTerminalId);
        if (!activation)
            return null;
        const seat = activation.seats.find((row) => row.state === 'active' && row.endpoint.terminalId === callerTerminalId);
        if (!seat)
            return null;
        const node = activation.chart.nodes.find((row) => row.nodeId === seat.nodeId);
        const reportsToSeat = node?.reportsTo
            ? activation.seats.find((row) => row.nodeId === node.reportsTo) ?? null
            : null;
        return { activation, seat, reportsToSeat, chart: activation.chart };
    }
    /** Frozen Pipeline seat/stage context used by LinkRegistry admission. */
    pipelineContext(callerTerminalId) {
        const info = this.reportTarget(callerTerminalId);
        if (!info || !(0, pipeline_1.isPipelineChart)(info.chart))
            return null;
        const stages = (0, pipeline_1.pipelineStages)(info.chart);
        const stageIndex = stages.findIndex((stage) => stage.nodeId === info.seat.nodeId);
        if (stageIndex < 0)
            return null;
        return { activation: info.activation, chart: info.chart, seat: info.seat, stages, stageIndex };
    }
    pruneStopped() {
        const stopped = this.activations.filter((row) => row.state === 'stopped');
        if (stopped.length <= MAX_STOPPED_ACTIVATIONS)
            return;
        const doomed = new Set([...stopped]
            .sort((a, b) => a.createdAt - b.createdAt)
            .slice(0, stopped.length - MAX_STOPPED_ACTIVATIONS)
            .map((row) => row.activationId));
        this.activations = this.activations.filter((row) => !doomed.has(row.activationId));
        for (const activationId of doomed) {
            delete this.violations[activationId];
            delete this.escalations[activationId];
        }
    }
}
exports.HierarchyActivations = HierarchyActivations;
