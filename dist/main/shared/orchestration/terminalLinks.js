"use strict";
/**
 * Durable Terminal Link contracts (orchestration v4 — L1 links, L4 receipts)
 * shared by the standalone CLI, Electron main, preload, and renderer.
 *
 * A TerminalLink is a directed, permissioned edge between two live terminal
 * endpoints in one project — the ad-hoc generalization of a Team connection.
 * Endpoints are generation-bound: a relaunched terminal is a NEW endpoint, and
 * any endpoint change quarantines the link instead of silently rebinding it.
 * Main owns every state transition; the renderer and CLI only mirror.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HUMAN_GESTURE_TOKEN_TTL_MS = void 0;
exports.isLinkMessageOutstanding = isLinkMessageOutstanding;
exports.endpointsMatch = endpointsMatch;
/**
 * Is this message still owed an answer?
 *
 * The single definition of "outstanding", shared by Mission Control, the agent
 * status board, the auto-grid, the activity timeline and the remote UI. It used
 * to be spelled out as `state === 'delivered' && !answeredAt` at eight call
 * sites, which is exactly the kind of duplication that lets a new terminal
 * state (here: user-closed) be honored in six places and silently ignored in
 * two.
 */
function isLinkMessageOutstanding(row) {
    return row.expectsReply !== false && row.state === 'delivered' && !row.answeredAt && !row.closedAt;
}
exports.HUMAN_GESTURE_TOKEN_TTL_MS = 15_000;
/** Two endpoints refer to the same live terminal instance. */
function endpointsMatch(a, b) {
    return (a.terminalId === b.terminalId &&
        a.terminalGeneration === b.terminalGeneration &&
        a.projectId === b.projectId &&
        a.worktreePath === b.worktreePath &&
        a.effectiveAgentKind === b.effectiveAgentKind &&
        a.nativeSessionId === b.nativeSessionId);
}
