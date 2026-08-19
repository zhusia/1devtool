"use strict";
/**
 * One-shot human-gesture grants (orchestration v4 — invariant 21).
 *
 * "The user typed it" must be a fact main can verify, never matched text. The
 * renderer mints a grant at a real Agent Input submit gesture; the grant is
 * bound to the focused terminal, project, and exact draft hash, expires in
 * seconds, and is consumed exactly once by the edge-creating call. Bridge,
 * CLI, and Remote UI callers have no path to this module — they can only
 * REQUEST a link (confirm dialog), never mint durable authority.
 *
 * In-memory only: a grant that does not survive a restart is correct — the
 * gesture it proves did not survive either.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.mintHumanGesture = mintHumanGesture;
exports.consumeHumanGesture = consumeHumanGesture;
exports.resetHumanGestureGrants = resetHumanGestureGrants;
const crypto_1 = require("crypto");
const terminalLinks_1 = require("../../shared/orchestration/terminalLinks");
const grants = new Map();
const MAX_ACTIVE_GRANTS = 256;
function prune(now) {
    for (const [token, grant] of grants) {
        if (now - grant.issuedAt > terminalLinks_1.HUMAN_GESTURE_TOKEN_TTL_MS)
            grants.delete(token);
    }
}
function mintHumanGesture(input) {
    const now = Date.now();
    prune(now);
    const grant = {
        token: `hg-${(0, crypto_1.randomUUID)()}`,
        focusedTerminalId: input.focusedTerminalId,
        projectId: input.projectId,
        draftHash: input.draftHash,
        issuedAt: now,
    };
    grants.set(grant.token, grant);
    while (grants.size > MAX_ACTIVE_GRANTS) {
        const oldest = grants.keys().next().value;
        if (!oldest)
            break;
        grants.delete(oldest);
    }
    return grant.token;
}
/** Single-use: a valid grant is deleted on consumption, matched or not. */
function consumeHumanGesture(token, expect) {
    const now = Date.now();
    prune(now);
    const grant = grants.get(token);
    if (!grant)
        return false;
    grants.delete(token);
    return (grant.focusedTerminalId === expect.focusedTerminalId &&
        grant.projectId === expect.projectId &&
        grant.draftHash === expect.draftHash &&
        now - grant.issuedAt <= terminalLinks_1.HUMAN_GESTURE_TOKEN_TTL_MS);
}
/** Test seam. */
function resetHumanGestureGrants() {
    grants.clear();
}
