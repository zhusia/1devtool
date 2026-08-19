"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setLiveAgentTerminalProbe = exports.isPoolManaged = exports.assertNoConflictingLease = void 0;
exports.poolAgentForTerminal = poolAgentForTerminal;
exports.setPoolChangedNotifier = setPoolChangedNotifier;
exports.cancelReservation = cancelReservation;
exports.reserve = reserve;
exports.prepareSpawn = prepareSpawn;
exports.releaseOccupancy = releaseOccupancy;
exports.endAssignment = endAssignment;
exports.buildPoolState = buildPoolState;
exports.setPolicy = setPolicy;
exports.setChain = setChain;
exports.setAccountEnabled = setAccountEnabled;
exports.setPlanPrice = setPlanPrice;
exports.initPoolEngine = initPoolEngine;
const crypto_1 = require("crypto");
const contracts_1 = require("../../shared/terminal/contracts");
const aiPool_1 = require("../../shared/aiPool");
const quotaAlerts_1 = require("../aiAccounts/quotaAlerts");
const registry_1 = require("../aiAccounts/registry");
const aiAccounts_1 = require("../aiAccounts");
const assignments_1 = require("./assignments");
const policy_1 = require("./policy");
const instanceLock_1 = require("./instanceLock");
const journal_1 = require("./journal");
/*
 * Pool engine facade (quota-center §5/§7/§11, Phase 2 — conservative Level 2).
 *
 * Level-2 invariants enforced here:
 *  - reserve/consume/restore all read DURABLE leases.json under the
 *    cross-instance pool lock; memory-only state never decides exclusivity;
 *  - a spawn is REFUSED (never silently switched) while a conflicting
 *    account holds a live lease for the provider;
 *  - a running terminal is never rebound: assignments are immutable while
 *    the terminal lives; cooling/benching only steer NEW leases;
 *  - every decision is journaled with its reason.
 *
 * Level 3 (isolated homes) is deliberately absent — gated on spikes S1–S6
 * per the plan's adapter-completeness review decision.
 */
const RESERVATION_TTL_MS = 60_000;
const POOL_AGENTS = ['claude', 'codex', 'gemini', 'qwen', 'opencode'];
const KIND_TO_PATH_AGENT = {
    'claude-command': 'claude',
    codex: 'codex',
    gemini: 'gemini',
    qwen: 'qwen',
    opencode: 'opencode',
};
function poolAgentForTerminal(agentType, command) {
    const kind = (0, contracts_1.getDeclaredAgentKind)(agentType, command);
    return kind ? KIND_TO_PATH_AGENT[kind] ?? null : null;
}
let notifyChanged = () => { };
function setPoolChangedNotifier(fn) {
    notifyChanged = fn;
}
const reservations = new Map();
function takeReservation(reservationId, agent) {
    if (!reservationId)
        return null;
    const record = reservations.get(reservationId);
    if (!record || record.agent !== agent || record.expiresAt < Date.now())
        return null;
    clearTimeout(record.timer);
    reservations.delete(reservationId);
    return record;
}
function cancelReservation(reservationId) {
    const record = reservations.get(reservationId);
    if (!record)
        return;
    clearTimeout(record.timer);
    reservations.delete(reservationId);
    (0, journal_1.appendJournal)({ kind: 'release', agent: record.agent, accountId: record.accountId, reason: 'reservation cancelled' });
}
// ── Cooling refresh ──────────────────────────────────────────────────────────
function policyFor(reg, agent) {
    return { ...aiPool_1.DEFAULT_POOL_POLICY, ...(reg.settings.policies[agent] ?? {}) };
}
/** Update cooling state from the freshest per-account statuses; journals
 * bench/unbench transitions. Returns the (possibly updated) state file. */
async function refreshCooling(reg) {
    const state = await (0, assignments_1.readPoolState)();
    let changed = false;
    const now = Date.now();
    for (const agent of POOL_AGENTS) {
        const policy = policyFor(reg, agent);
        const agentState = { ...(state[agent] ?? {}) };
        for (const account of reg.accounts[agent]) {
            const used = (0, quotaAlerts_1.maxUsedPercent)(account.status ?? null);
            const blocking = account.status?.primary && (account.status.primary.usedPercent ?? 0) >= (account.status?.secondary?.usedPercent ?? 0)
                ? account.status.primary
                : account.status?.secondary ?? account.status?.primary ?? null;
            const evaluated = (0, policy_1.evaluateCooling)(agentState[account.id] ?? null, { usedPercent: used, resetsAt: blocking?.resetsAt ?? null }, policy, now);
            const had = agentState[account.id] != null;
            if (evaluated.cooling && evaluated.next) {
                if (!had || agentState[account.id].trippedAt !== evaluated.next.trippedAt) {
                    agentState[account.id] = evaluated.next;
                    changed = true;
                    (0, journal_1.appendJournal)({
                        kind: 'bench',
                        agent,
                        accountId: account.id,
                        reason: `cooling: ${evaluated.next.trippedPercent}% ≥ rotate ${policy.rotateAtPercent}%${evaluated.next.windowResetsAt ? `, resets ${new Date(evaluated.next.windowResetsAt).toLocaleTimeString()}` : `, fallback ${policy.cooldownFallbackMinutes}m`}`,
                    });
                }
            }
            else if (had) {
                delete agentState[account.id];
                changed = true;
                (0, journal_1.appendJournal)({ kind: 'unbench', agent, accountId: account.id, reason: 'cooldown ended' });
            }
        }
        // Drop state for deleted accounts.
        for (const accountId of Object.keys(agentState)) {
            if (!reg.accounts[agent].some((a) => a.id === accountId)) {
                delete agentState[accountId];
                changed = true;
            }
        }
        state[agent] = agentState;
    }
    if (changed)
        await (0, assignments_1.writePoolState)(state);
    return state;
}
function leaseCounts(leases, agent) {
    const byAccount = new Map();
    const accounts = new Set();
    for (const lease of leases) {
        if (lease.agent !== agent)
            continue;
        byAccount.set(lease.accountId, (byAccount.get(lease.accountId) ?? 0) + 1);
        accounts.add(lease.accountId);
    }
    return { byAccount, accounts };
}
function accountViews(reg, state, agent, counts) {
    return reg.accounts[agent].map((account) => ({
        id: account.id,
        enabled: account.enabled !== false,
        usedPercent: (0, quotaAlerts_1.maxUsedPercent)(account.status ?? null),
        lastUsedAt: account.lastUsedAt,
        activeLeases: counts.byAccount.get(account.id) ?? 0,
        cooling: state[agent]?.[account.id] != null,
    }));
}
function soonestReset(reg, state, agent) {
    const resets = Object.values(state[agent] ?? {})
        .map((cooling) => cooling.windowResetsAt)
        .filter((value) => value != null);
    return resets.length ? Math.min(...resets) : null;
}
function selectForAgent(reg, state, leases, agent, explicitAccountId) {
    const policy = policyFor(reg, agent);
    const counts = leaseCounts(leases, agent);
    const views = accountViews(reg, state, agent, counts);
    let accountId;
    let reason;
    if (explicitAccountId) {
        const view = views.find((v) => v.id === explicitAccountId);
        if (!view)
            return { ok: false, reason: 'account-not-found' };
        accountId = explicitAccountId;
        reason = 'explicit account choice';
    }
    else {
        if (policy.mode === 'manual')
            return { ok: false, reason: 'manual-mode' };
        if (policy.mode === 'pinned-default') {
            const pinned = policy.priorityOrder?.[0];
            const view = pinned ? views.find((v) => v.id === pinned) : undefined;
            const eligible = view &&
                view.enabled &&
                !view.cooling &&
                (view.usedPercent == null || view.usedPercent < policy.rotateAtPercent) &&
                view.activeLeases < policy.maxConcurrentLeases;
            if (!eligible) {
                const fallback = (0, policy_1.selectAccount)(views, policy);
                return fallback.kind === 'none'
                    ? { ok: false, reason: fallback.reason }
                    : { ok: false, reason: 'manual-mode', detail: 'pinned account unavailable — pick explicitly' };
            }
            accountId = view.id;
            reason = 'pinned default';
        }
        else {
            const selection = (0, policy_1.selectAccount)(views, policy);
            if (selection.kind === 'none')
                return { ok: false, reason: selection.reason };
            accountId = selection.accountId;
            reason = selection.reason;
        }
    }
    // Level-2 exclusivity: refuse while a DIFFERENT account holds a live lease.
    const conflicting = [...counts.accounts].filter((id) => id !== accountId);
    if (conflicting.length > 0) {
        return {
            ok: false,
            reason: 'conflicting-live-account',
            detail: `a live ${agent} terminal is on another account — close it, use that account, or wait`,
        };
    }
    const account = reg.accounts[agent].find((a) => a.id === accountId);
    const record = {
        reservationId: `rsv-${(0, crypto_1.randomUUID)().slice(0, 8)}`,
        agent,
        accountId,
        accountLabel: account?.label ?? accountId,
        expiresAt: Date.now() + RESERVATION_TTL_MS,
        timer: setTimeout(() => {
            reservations.delete(record.reservationId);
            (0, journal_1.appendJournal)({ kind: 'release', agent, accountId, reason: 'reservation expired unused' });
        }, RESERVATION_TTL_MS),
    };
    record.timer.unref?.();
    reservations.set(record.reservationId, record);
    (0, journal_1.appendJournal)({ kind: 'reserve', agent, accountId, reason: `${reason} (${record.reservationId})` });
    const { timer: _timer, ...publicRecord } = record;
    return { ok: true, ...publicRecord };
}
async function reserve(request) {
    const reg = await (0, registry_1.readRegistry)();
    const state = await refreshCooling(reg);
    const leases = await (0, assignments_1.readLeases)();
    if (request.kind === 'agent') {
        return selectForAgent(reg, state, leases, request.agent, request.accountId);
    }
    const chain = reg.settings.chain;
    if (!chain.enabled || chain.order.length === 0)
        return { ok: false, reason: 'chain-disabled' };
    const pools = {};
    for (const agent of chain.order) {
        const attempt = selectForAgent(reg, state, leases, agent);
        if (attempt.ok) {
            // Do not keep speculative reservations for skipped/later steps.
            cancelSpeculative(attempt.reservationId);
        }
        pools[agent] = attempt.ok
            ? { leasable: true, soonestResetAt: null }
            : {
                leasable: false,
                reason: attempt.detail ?? attempt.reason,
                soonestResetAt: soonestReset(reg, state, agent),
            };
    }
    const walk = (0, policy_1.walkChain)(chain, pools);
    if (walk.kind === 'none') {
        (0, journal_1.appendJournal)({ kind: 'reserve', agent: chain.order[0], reason: `Auto: no chain step leasable`, });
        return { ok: false, reason: 'no-step-leasable', resets: walk.resets };
    }
    for (const skipped of walk.skipped) {
        (0, journal_1.appendJournal)({ kind: 'reserve', agent: skipped.agent, reason: `Auto: skipped (${skipped.reason})` });
    }
    return selectForAgent(reg, state, leases, walk.agent);
}
/** A chain probe's reservation is speculative — drop it silently (no journal
 * noise) so only the final step's reservation remains live. */
function cancelSpeculative(reservationId) {
    const record = reservations.get(reservationId);
    if (!record)
        return;
    clearTimeout(record.timer);
    reservations.delete(reservationId);
}
const NOOP_HANDLE = {
    blocked: null,
    account: null,
    commit: () => { },
    rollback: async () => { },
};
async function prepareSpawn(args) {
    const agent = poolAgentForTerminal(args.agentType, args.command);
    if (!agent)
        return NOOP_HANDLE;
    const reservation = takeReservation(args.poolReservationId, agent);
    const assignment = reservation ? null : await (0, assignments_1.getAssignment)(args.terminalId);
    if (!reservation && !assignment)
        return NOOP_HANDLE;
    const targetAccountId = reservation?.accountId ?? assignment.accountId;
    return (0, instanceLock_1.withPoolLock)(agent, async () => {
        const reg = await (0, registry_1.readRegistry)();
        const account = reg.accounts[agent].find((a) => a.id === targetAccountId);
        if (!account) {
            // Assignment references a deleted account: drop it and spawn unpooled.
            await (0, assignments_1.removeAssignment)(args.terminalId);
            (0, journal_1.appendJournal)({
                kind: 'release',
                agent,
                accountId: targetAccountId,
                terminalId: args.terminalId,
                reason: 'assignment dropped — account no longer exists',
            });
            return NOOP_HANDLE;
        }
        const leases = await (0, assignments_1.readLeases)();
        const conflicting = leases.filter((l) => l.agent === agent && l.accountId !== targetAccountId);
        if (conflicting.length > 0) {
            (0, journal_1.appendJournal)({
                kind: 'release',
                agent,
                accountId: targetAccountId,
                terminalId: args.terminalId,
                reason: `spawn refused — live ${agent} terminal on another account (L2 exclusivity)`,
            });
            return {
                blocked: `A live ${agent} terminal is using account “${reg.accounts[agent].find((a) => a.id === conflicting[0].accountId)?.label ?? conflicting[0].accountId}”. Close it first, or launch on that account — one live ${agent} account at a time until isolated homes ship.`,
                account: null,
                commit: () => { },
                rollback: async () => { },
            };
        }
        // Align global credentials with the assignment (restore is not
        // metadata-only — §11.1). switchTo skips its own lock/guard here: we hold
        // the pool lock and just proved exclusivity against durable leases.
        if (reg.active[agent] !== targetAccountId) {
            await (0, aiAccounts_1.switchTo)(agent, targetAccountId, args.overrides, { poolManaged: true });
            (0, journal_1.appendJournal)({
                kind: 'manual-switch',
                agent,
                accountId: targetAccountId,
                terminalId: args.terminalId,
                reason: reservation ? 'reservation consume — global identity aligned' : 'assignment restore — global identity aligned',
            });
        }
        const createdAssignment = reservation != null;
        if (reservation) {
            await (0, assignments_1.putAssignment)({ terminalId: args.terminalId, agent, accountId: targetAccountId, createdAt: Date.now() });
            (0, journal_1.appendJournal)({
                kind: 'assign',
                agent,
                accountId: targetAccountId,
                terminalId: args.terminalId,
                reason: `reservation ${reservation.reservationId} consumed`,
            });
        }
        await (0, assignments_1.putLease)({
            terminalId: args.terminalId,
            agent,
            accountId: targetAccountId,
            pid: null,
            processStartedAt: null,
            leasedAt: Date.now(),
        });
        (0, journal_1.appendJournal)({ kind: 'lease', agent, accountId: targetAccountId, terminalId: args.terminalId, reason: 'terminal spawn' });
        return {
            blocked: null,
            account: { agent, accountId: targetAccountId, accountLabel: account.label },
            commit: () => notifyChanged('lease'),
            rollback: async () => {
                await (0, instanceLock_1.withPoolLock)(agent, async () => {
                    await (0, assignments_1.removeLease)(args.terminalId);
                    if (createdAssignment)
                        await (0, assignments_1.removeAssignment)(args.terminalId);
                });
                (0, journal_1.appendJournal)({
                    kind: 'release',
                    agent,
                    accountId: targetAccountId,
                    terminalId: args.terminalId,
                    reason: 'spawn failed — lease rolled back',
                });
                notifyChanged('lease-rollback');
            },
        };
    });
}
/** Child process exit: occupancy ends, the durable assignment survives for
 * user-initiated restart / native resume (§11.4). */
async function releaseOccupancy(terminalId, why) {
    const lease = await (0, assignments_1.removeLease)(terminalId);
    if (!lease)
        return;
    (0, journal_1.appendJournal)({ kind: 'release', agent: lease.agent, accountId: lease.accountId, terminalId, reason: why });
    notifyChanged('release');
}
/** Explicit pty:kill: both occupancy and the assignment end (§11.4). */
async function endAssignment(terminalId) {
    const lease = await (0, assignments_1.removeLease)(terminalId);
    const assignment = await (0, assignments_1.removeAssignment)(terminalId);
    if (!lease && !assignment)
        return;
    const agent = lease?.agent ?? assignment?.agent;
    const accountId = lease?.accountId ?? assignment?.accountId;
    if (agent) {
        (0, journal_1.appendJournal)({ kind: 'release', agent, accountId, terminalId, reason: 'terminal closed — assignment ended' });
    }
    notifyChanged('release');
}
var guards_1 = require("./guards");
Object.defineProperty(exports, "assertNoConflictingLease", { enumerable: true, get: function () { return guards_1.assertNoConflictingLease; } });
Object.defineProperty(exports, "isPoolManaged", { enumerable: true, get: function () { return guards_1.isPoolManaged; } });
Object.defineProperty(exports, "setLiveAgentTerminalProbe", { enumerable: true, get: function () { return guards_1.setLiveAgentTerminalProbe; } });
// ── State / settings IPC backing ─────────────────────────────────────────────
async function buildPoolState() {
    const reg = await (0, registry_1.readRegistry)();
    const cooling = await refreshCooling(reg);
    const leases = (await (0, assignments_1.readLeases)()).map(({ instanceId: _instanceId, ...lease }) => lease);
    return {
        assignments: await (0, assignments_1.readAssignments)(),
        leases,
        policies: reg.settings.policies,
        chain: reg.settings.chain,
        cooling,
    };
}
async function setPolicy(agent, policy) {
    await (0, registry_1.mutateRegistry)((prev) => ({
        ...prev,
        settings: { ...prev.settings, policies: { ...prev.settings.policies, [agent]: policy } },
    }));
    (0, journal_1.appendJournal)({ kind: 'policy-change', agent, reason: `policy updated (mode ${policy.mode}, strategy ${policy.strategy}, rotate ${policy.rotateAtPercent}%)` });
    notifyChanged('policy');
}
async function setChain(chain) {
    await (0, registry_1.mutateRegistry)((prev) => ({ ...prev, settings: { ...prev.settings, chain } }));
    (0, journal_1.appendJournal)({
        kind: 'policy-change',
        agent: chain.order[0] ?? 'claude',
        reason: `chain ${chain.enabled ? 'enabled' : 'disabled'}: ${chain.order.join(' → ') || '(empty)'}`,
    });
    notifyChanged('chain');
}
async function setAccountEnabled(agent, accountId, enabled) {
    await (0, registry_1.mutateRegistry)((prev) => ({
        ...prev,
        accounts: {
            ...prev.accounts,
            [agent]: prev.accounts[agent].map((a) => (a.id === accountId ? { ...a, enabled } : a)),
        },
    }));
    (0, journal_1.appendJournal)({ kind: enabled ? 'unbench' : 'bench', agent, accountId, reason: enabled ? 'user re-enabled in pool' : 'user benched' });
    notifyChanged('account-enabled');
}
async function setPlanPrice(agent, accountId, priceUsdMonthly) {
    await (0, registry_1.mutateRegistry)((prev) => ({
        ...prev,
        accounts: {
            ...prev.accounts,
            [agent]: prev.accounts[agent].map((a) => (a.id === accountId ? { ...a, planPriceUsdMonthly: priceUsdMonthly } : a)),
        },
    }));
    notifyChanged('plan-price');
}
async function initPoolEngine() {
    const reaped = await (0, assignments_1.reconcileLeasesAtBoot)().catch(() => 0);
    if (reaped > 0) {
        (0, journal_1.appendJournal)({ kind: 'release', agent: 'claude', reason: `boot reconciliation reaped ${reaped} stale lease(s)` });
    }
}
