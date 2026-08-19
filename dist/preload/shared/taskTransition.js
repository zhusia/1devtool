"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateTaskDrop = evaluateTaskDrop;
exports.isDroppable = isDroppable;
exports.isConfirmable = isConfirmable;
/**
 * What a human dragging a card across status columns is allowed to do
 * (docs/tasks_v2.md §7.2, §5.1, §6.2).
 *
 * v2 shipped without drag for a good reason: columns were "whatever you grouped
 * by", so a drop had no defined meaning, and the P5 board then crossed status
 * columns with agent swimlanes, which gave a drag two possible meanings —
 * one of them dispatch. The redesign made columns unconditionally `status` and
 * moved ownership onto the card, so a drop now has exactly one meaning and this
 * module can define it.
 *
 * Two invariants shape everything below:
 *
 * 1. **A drop is a request, not a write.** The renderer evaluates this to
 *    decide what to highlight; main evaluates it *again* against authority
 *    before writing. The renderer's copy is an affordance, never the check —
 *    holds and gates are app-owned state and the board is a renderer.
 * 2. **Drag never assigns.** Reassignment consumes a single-use grant bound to
 *    a preview the human read, and routing that through an HTML5 drag sequence
 *    is a novel path through the one check the authorization model rests on.
 *    Drag exists in the status board and does not exist in the agent roster.
 */
/**
 * Lifecycle order.
 *
 * `blocked` ranks with `in_progress` because that is where work usually stalls,
 * and because leaving it still has to count as advancing: without a rank,
 * blocked→done was not "forward", so a spec-held task could be dragged clean
 * past its own hold by way of the Blocked column. `cancelled` has no rank —
 * reviving a cancelled task is never an advance anyone needs to be stopped from.
 */
const RANK = {
    backlog: 0,
    ready: 1,
    in_progress: 2,
    blocked: 2,
    in_review: 3,
    done: 4,
};
/** Parking a task is never advancing it, whatever it is parked from. */
const PARKING = ['blocked', 'cancelled'];
function isForward(from, to) {
    if (PARKING.includes(to))
        return false;
    const a = RANK[from];
    const b = RANK[to];
    if (a === undefined || b === undefined)
        return false;
    return b > a;
}
/**
 * The status each gate kind is asking permission to reach. A drop onto that
 * status *is* the verdict, so it belongs in the gate flow — which records a
 * response and an audit trail — rather than in a silent status write.
 *
 * `question` has none: an agent asking something is not asking to advance, so
 * it never governs a move.
 */
const GATE_TARGET = {
    plan: 'in_progress',
    done: 'done',
    spec: 'ready',
    question: null,
};
const HOLD_REASON = {
    spec: 'This task is held until its spec is approved, so it cannot move forward yet.',
    plan: 'This task is held until its plan is approved, so it cannot move forward yet.',
};
/**
 * Evaluate one drop.
 *
 * Precedence is deliberate: the gate outranks the hold, because when both are
 * present the gate is the actionable one — "answer the spec gate" tells the
 * human what to do, "it is held" only tells them what they cannot do.
 */
function evaluateTaskDrop(input) {
    const { from, to } = input;
    if (from === to)
        return { kind: 'noop' };
    const forward = isForward(from, to);
    const gateKind = input.openGateKind ?? null;
    if (gateKind) {
        const target = GATE_TARGET[gateKind];
        if (target && to === target) {
            return {
                kind: 'gate',
                gateKind,
                reason: `An agent is waiting on your ${gateKind} verdict. Answering it moves the task — and records why.`,
            };
        }
        // Advancing past a pending request would silently overrule the agent that
        // is still waiting. Retreating or cancelling is a legitimate override.
        if (target && forward) {
            return {
                kind: 'refuse',
                reason: `An agent is waiting on your ${gateKind} verdict — answer that first.`,
            };
        }
    }
    const hold = input.holds?.find((entry) => entry === 'spec' || entry === 'plan');
    if (hold && forward)
        return { kind: 'refuse', reason: HOLD_REASON[hold] };
    // The file has been claiming this status all along (§6.2). The drop is an
    // *acceptance*, which is a different sentence from an independent edit, so
    // the human confirms the one they mean.
    if (input.proposedStatus && input.proposedStatus === to) {
        return {
            kind: 'confirm',
            reason: `The task file already says ${to.replace('_', ' ')}. Accepting makes it the app's record too.`,
            confirmLabel: 'Accept',
        };
    }
    if (to === 'in_progress' && (input.blockedBy?.length ?? 0) > 0) {
        const blockers = input.blockedBy ?? [];
        return {
            kind: 'confirm',
            reason: `Still blocked by ${blockers.join(', ')}. Starting it anyway is your call.`,
            confirmLabel: 'Start anyway',
        };
    }
    return { kind: 'allow' };
}
/** Can the board show this column as a live drop target? */
function isDroppable(verdict) {
    return verdict.kind === 'allow' || verdict.kind === 'confirm' || verdict.kind === 'gate';
}
/**
 * Which verdicts a confirmed re-submission may proceed on. `refuse` and `gate`
 * are never overridable — the first is a rule, the second has its own flow.
 */
function isConfirmable(verdict) {
    return verdict.kind === 'confirm';
}
