"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setLiveAgentTerminalProbe = setLiveAgentTerminalProbe;
exports.assertNoConflictingLease = assertNoConflictingLease;
exports.isPoolManaged = isPoolManaged;
const registry_1 = require("../aiAccounts/registry");
const assignments_1 = require("./assignments");
/*
 * Small guard helpers imported by aiAccounts/index.ts. Kept separate from the
 * pool facade so aiAccounts ↔ aiPool never form an import cycle (the facade
 * imports switchTo from aiAccounts).
 */
/**
 * Live-terminal probe registered at app boot (see aiAccounts/runtime).
 * Pool leases only cover reservation/assignment-spawned terminals; a manually
 * opened Codex/Claude session has no lease but still holds the global
 * auth.json in memory — rewriting it under that process causes
 * token_invalidated / MCP 401 (BUG-82).
 *
 * Second arg is the switch target account id: terminals already leased to
 * that account do not block the switch.
 */
let liveAgentTerminalProbe = null;
function setLiveAgentTerminalProbe(probe) {
    liveAgentTerminalProbe = probe;
}
/** §13 Phase-2 exit gate: a provider's global credentials never change while
 * a DIFFERENT account holds a live lease, OR while any live terminal of that
 * agent is running (even without a formal lease). Every non-pool-managed
 * switchTo path runs through this. */
async function assertNoConflictingLease(agent, accountId) {
    const leases = await (0, assignments_1.readLeases)();
    const conflicting = leases.filter((l) => l.agent === agent && l.accountId !== accountId);
    if (conflicting.length > 0) {
        throw new Error(`A live ${agent} terminal is leased to another account. Close it (or let it finish) before switching the global default — swapping credentials under a running CLI risks credential mixing and token invalidation.`);
    }
    // Leases only cover pool-managed spawns. Ordinary (unleased) live terminals
    // still hold global auth.json in memory — never skip the live-PTY probe
    // just because some other lease for this agent exists (BUG-82 audit).
    // Terminals already leased to the *target* account are fine: they already
    // run on those credentials. The probe must still catch unleased lives.
    if (liveAgentTerminalProbe?.(agent, accountId)) {
        throw new Error(`A live ${agent} terminal is still running. Close it before switching the global default — rewriting the shared login files while the CLI is open invalidates its session token (MCP/auth will force re-login).`);
    }
}
/** True once a pool policy manages the provider (mode ≠ manual) — the legacy
 * background auto-switch poll must stand down for that agent (§13). */
async function isPoolManaged(agent) {
    const reg = await (0, registry_1.readRegistry)();
    const mode = reg.settings.policies[agent]?.mode;
    return mode != null && mode !== 'manual';
}
