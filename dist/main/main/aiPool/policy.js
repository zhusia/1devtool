"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.selectAccount = selectAccount;
exports.evaluateCooling = evaluateCooling;
exports.walkChain = walkChain;
function headroomOrder(a, b) {
    const aKnown = a.usedPercent != null;
    const bKnown = b.usedPercent != null;
    if (aKnown !== bKnown)
        return aKnown ? -1 : 1;
    if (aKnown && bKnown && a.usedPercent !== b.usedPercent) {
        return a.usedPercent - b.usedPercent;
    }
    if (a.activeLeases !== b.activeLeases)
        return a.activeLeases - b.activeLeases;
    return (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0);
}
function selectAccount(accounts, policy) {
    if (accounts.length === 0)
        return { kind: 'none', reason: 'no-accounts' };
    const enabled = accounts.filter((account) => account.enabled);
    if (enabled.length === 0)
        return { kind: 'none', reason: 'all-benched' };
    const notCooling = enabled.filter((account) => !account.cooling);
    if (notCooling.length === 0)
        return { kind: 'none', reason: 'all-cooling' };
    const underRotate = notCooling.filter((account) => account.usedPercent == null || account.usedPercent < policy.rotateAtPercent);
    if (underRotate.length === 0)
        return { kind: 'none', reason: 'all-over-rotate' };
    const eligible = underRotate.filter((account) => account.activeLeases < policy.maxConcurrentLeases);
    if (eligible.length === 0)
        return { kind: 'none', reason: 'all-at-capacity' };
    if (policy.strategy === 'priority' && policy.priorityOrder?.length) {
        for (const id of policy.priorityOrder) {
            const hit = eligible.find((account) => account.id === id);
            if (hit)
                return { kind: 'account', accountId: hit.id, reason: `priority order (#${policy.priorityOrder.indexOf(id) + 1})` };
        }
        // No listed account eligible — fall through to headroom among the rest.
    }
    if (policy.strategy === 'round-robin') {
        const pick = [...eligible].sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0))[0];
        return { kind: 'account', accountId: pick.id, reason: 'round-robin (least recently used)' };
    }
    const pick = [...eligible].sort(headroomOrder)[0];
    const reason = pick.usedPercent == null
        ? 'quota unknown — leasable, ranked after known-healthy accounts'
        : `best known headroom (${100 - pick.usedPercent}%)`;
    return { kind: 'account', accountId: pick.id, reason };
}
function evaluateCooling(prev, sample, policy, nowMs) {
    const used = sample.usedPercent;
    if (prev) {
        // Hysteresis: a fresh sample well below rotate un-trips early.
        if (used != null && used < policy.rotateAtPercent - 10) {
            return { cooling: false, next: null };
        }
        const until = prev.windowResetsAt ?? prev.trippedAt + policy.cooldownFallbackMinutes * 60_000;
        if (nowMs >= until) {
            // Window reset (or fallback elapsed). Re-trip only on fresh evidence.
            if (used != null && used >= policy.rotateAtPercent) {
                return {
                    cooling: true,
                    next: { trippedAt: nowMs, trippedPercent: used, windowResetsAt: sample.resetsAt },
                };
            }
            return { cooling: false, next: null };
        }
        return { cooling: true, next: prev };
    }
    if (used != null && used >= policy.rotateAtPercent) {
        return {
            cooling: true,
            next: { trippedAt: nowMs, trippedPercent: used, windowResetsAt: sample.resetsAt },
        };
    }
    return { cooling: false, next: null };
}
function walkChain(chain, pools) {
    const skipped = [];
    for (const agent of chain.order) {
        const pool = pools[agent];
        if (!pool) {
            skipped.push({ agent, reason: 'no pool state' });
            continue;
        }
        if (pool.leasable) {
            return { kind: 'provider', agent, skipped };
        }
        skipped.push({ agent, reason: pool.reason ?? 'not leasable' });
    }
    return {
        kind: 'none',
        resets: chain.order.map((agent) => ({ agent, resetsAt: pools[agent]?.soonestResetAt ?? null })),
    };
}
