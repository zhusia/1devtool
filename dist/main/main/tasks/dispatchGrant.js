"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fingerprintPrompt = fingerprintPrompt;
exports.mintTaskActionGrant = mintTaskActionGrant;
exports.consumeTaskActionGrant = consumeTaskActionGrant;
exports.resetTaskActionGrants = resetTaskActionGrants;
const crypto_1 = require("crypto");
/**
 * Single-use Tasks action grants (docs/tasks_v2.md §7.3 / §8.1).
 *
 * Deliberately NOT the orchestration `mintHumanGesture` grant: that one is
 * bound to a focused terminal and a draft hash, which is the wrong tuple here.
 * Tasks actions may have no focused terminal at all. This grant binds the
 * complete canonical action tuple instead.
 *
 * For assignment, the tuple contains the preview fingerprint. Main still
 * rebuilds the prompt at assign time and compares it, so an MCP edit between
 * review and click fails closed rather than sending unreviewed content.
 *
 * In-memory and short-lived: a grant that survived a restart would outlive the
 * gesture it claims to prove.
 */
const GRANT_TTL_MS = 60_000;
const MAX_ACTIVE_GRANTS = 64;
const grants = new Map();
function stable(value) {
    if (Array.isArray(value))
        return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}
function fingerprintPrompt(prompt) {
    return (0, crypto_1.createHash)('sha256').update(prompt).digest('hex').slice(0, 32);
}
function prune(now) {
    for (const [token, grant] of grants) {
        if (now - grant.issuedAt > GRANT_TTL_MS)
            grants.delete(token);
    }
}
function mintTaskActionGrant(input) {
    const now = Date.now();
    prune(now);
    const descriptor = stable(input);
    if (descriptor.length > 32_768)
        throw new Error('Tasks action is too large to authorize');
    const grant = {
        token: `ta-${(0, crypto_1.randomUUID)()}`,
        descriptor,
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
/** Single-use: the grant is deleted on consumption, matched or not. */
function consumeTaskActionGrant(token, expect) {
    const now = Date.now();
    prune(now);
    const grant = grants.get(token);
    if (!grant)
        return { ok: false, code: 'no-grant', error: 'this Tasks action was not authorized by a user gesture' };
    grants.delete(token);
    if (grant.descriptor !== stable(expect) ||
        now - grant.issuedAt > GRANT_TTL_MS) {
        return { ok: false, code: 'no-grant', error: 'this dispatch does not match the action that was authorized' };
    }
    return { ok: true };
}
/** Test seam. */
function resetTaskActionGrants() {
    grants.clear();
}
