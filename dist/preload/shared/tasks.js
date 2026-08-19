"use strict";
/**
 * Tasks v2 — shared model (docs/tasks_v2.md rev 11, §4.1).
 *
 * The logical model. Physically it is PARTITIONED (§6.2 threat model):
 *
 * - **App-owned authority state** (app data, never writable from the
 *   workspace): `assignee`, open `gates`, `runs`, the redirect map, and the
 *   applied policy. These decide what agents may do, so they must not live in
 *   files an agent can edit with a text tool.
 * - **File-owned content** (`.1devtool/tasks/<id>-<slug>.md`): title, body,
 *   status (effective lifecycle is still gated by app-owned holds — a file
 *   edit that crosses an approval boundary is a proposal, §6.2), priority,
 *   labels, criteria, plan, deps, ref — plus an audit projection of resolved
 *   authority history. The projection is evidence, not authority: editing it
 *   changes what the file claims, never what the app enforces.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TASKS_HOST_PRINCIPAL_PREFIX = exports.TASKS_CONFIG_DEFAULTS = exports.TASK_BODY_MAX_BYTES = exports.TASK_GATES_CAP = exports.TASK_RUNS_CAP = exports.TASK_ACTIVITY_CAP = exports.TASK_STATUSES = void 0;
exports.isTasksHostPrincipalId = isTasksHostPrincipalId;
exports.isTaskDecomposeTarget = isTaskDecomposeTarget;
exports.TASK_STATUSES = [
    'backlog', 'ready', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled',
];
/** Bounds for the audit projections kept in the working file (§4.6). */
exports.TASK_ACTIVITY_CAP = 100;
exports.TASK_RUNS_CAP = 20;
exports.TASK_GATES_CAP = 20;
/** Body cap for any write path — renderer caps are UX; main enforces (§4.5b). */
exports.TASK_BODY_MAX_BYTES = 8 * 1024;
exports.TASKS_CONFIG_DEFAULTS = {
    version: 1,
    gates: { spec: false, plan: true, done: true },
    gateTimeoutMs: 30 * 60 * 1000,
    onTimeout: 'block',
    definitionOfDone: [],
    crossProjectWrites: false,
    gitTracked: true,
};
// ---------------------------------------------------------------------------
// Dispatch (§4.7) — assignment IS dispatch: a task is assigned to a terminal
// and the orchestration stack runs it.
// ---------------------------------------------------------------------------
/**
 * Id-space prefix for the main-owned host principal that owns Tasks-spawned
 * singleton Teams (§4.7).
 *
 * `startTeam()` demands a host `terminalId` and persists it as the team's
 * `hostTerminalId`, but a Tasks dispatch has no delegating terminal — the
 * dispatch often CREATES the first one. Reusing some existing terminal as host
 * would hand that agent host authority over the team's controller operations,
 * quietly undercutting the human-only boundary this design exists to defend.
 *
 * The prefix is a colon-namespaced string; terminal ids are UUIDs, so PID
 * ancestry can never resolve to one of these and no bridge caller can claim it.
 *
 * RENDERER RULE, and the reason this constant is shared: a sentinel is not a
 * terminal. Never look it up in a terminal map, never render it as a member,
 * and — the rule that turns a display bug into an ownership lie — **never
 * substitute a member as the authority when the host id does not resolve.**
 */
exports.TASKS_HOST_PRINCIPAL_PREFIX = 'app-host:tasks:';
function isTasksHostPrincipalId(id) {
    return typeof id === 'string' && id.startsWith(exports.TASKS_HOST_PRINCIPAL_PREFIX);
}
/** Runtime validation at IPC and persistence boundaries. */
function isTaskDecomposeTarget(value) {
    if (!value || typeof value !== 'object')
        return false;
    const target = value;
    return target.kind === 'existing-terminal'
        && typeof target.terminalId === 'string'
        && Boolean(target.terminalId.trim());
}
