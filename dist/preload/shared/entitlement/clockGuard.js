"use strict";
// Monotonic max-seen-timestamp helper — Workstream A / roadmap #8, phase P0.
// Closes §4.4 hole #3: "Clock rollback + firewall block = permanent Pro."
// Get a valid entitlement, set the clock to 2020, block the domain → `notAfter`
// never passes. Individually survivable; combined they are a complete bypass.
//
// The defense: persist the GREATEST timestamp ever observed (each entitlement's
// `issuedAt`, each successful refresh, and `now` on every boot). Refuse to verify
// when `now` is meaningfully behind it.
//
// This module is PURE — just the max/compare logic. Persisting the max across
// launches (disk / store) is a later phase (P2); these functions take the prior
// max in and hand the new max back so the caller owns storage.
Object.defineProperty(exports, "__esModule", { value: true });
exports.advanceMaxSeen = advanceMaxSeen;
exports.isClockRolledBack = isClockRolledBack;
/**
 * Fold observed timestamps into the running maximum.
 * Ignores null/undefined and unparseable values. Accepts Date | ISO string | epoch-ms.
 */
function advanceMaxSeen(prior, ...observed) {
    let max = prior;
    for (const candidate of observed) {
        if (candidate == null)
            continue;
        const d = candidate instanceof Date ? candidate : new Date(candidate);
        const ms = d.getTime();
        if (Number.isNaN(ms))
            continue;
        if (max === null || ms > max.getTime())
            max = d;
    }
    return max;
}
/**
 * True when `now` sits more than `skewMs` behind the greatest timestamp we have
 * ever seen — i.e. the clock has plausibly been rolled back. `skewMs` absorbs
 * legitimate skew (NTP jitter, timezone quirks). With no prior max, nothing to
 * compare against → not rolled back.
 */
function isClockRolledBack(now, maxSeen, skewMs) {
    if (maxSeen === null)
        return false;
    return now.getTime() < maxSeen.getTime() - skewMs;
}
