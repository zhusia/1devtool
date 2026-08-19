"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTasksManager = getTasksManager;
exports.startTaskRunMapper = startTaskRunMapper;
exports.registerTaskIpcHandlers = registerTaskIpcHandlers;
exports.disposeTaskIpc = disposeTaskIpc;
const electron_1 = require("electron");
const path = __importStar(require("path"));
const tasks_1 = require("../../shared/tasks");
const manager_1 = require("../tasks/manager");
const dispatch_1 = require("../tasks/dispatch");
const runMapper_1 = require("../tasks/runMapper");
const hostPrincipal_1 = require("../tasks/hostPrincipal");
const attention_1 = require("../../shared/orchestration/attention");
const decompose_1 = require("../tasks/decompose");
const decomposeInTerminal_1 = require("../tasks/decomposeInTerminal");
const decomposeRuns_1 = require("../tasks/decomposeRuns");
const rendererGuards_1 = require("./rendererGuards");
const dispatchGrant_1 = require("../tasks/dispatchGrant");
let manager = null;
let dispatcher = null;
let runMapper = null;
let decomposeRuns = null;
function getTasksManager() {
    return manager;
}
/**
 * Start mirroring run outcomes onto task state, and register the fallback
 * policy hook. Deferred until the controller exists — the Tasks IPC layer is
 * registered before it.
 */
function startTaskRunMapper() {
    runMapper?.start();
}
function registerTaskIpcHandlers(deps) {
    const { isMainRenderer, hasMainRendererGesture } = (0, rendererGuards_1.createRendererGuards)(deps.getMainWindow);
    manager = new manager_1.TasksManager({
        baseDir: deps.baseDir,
        ...(deps.resolveWorkspaceProjectIds
            ? { resolveWorkspaceProjectIds: deps.resolveWorkspaceProjectIds }
            : {}),
        onChanged: (projectIds) => deps.sendToRenderer('tasks:changed', { projectIds }),
        isPolicyApproved: async (projectId) => (await deps.getProjectSettingsManager?.()?.isDomainApproved(projectId, 'tasks')) ?? false,
        onPolicyWritten: async (projectId) => {
            await deps.getProjectSettingsManager?.()?.recordDomainApproval(projectId, 'tasks');
        },
        /**
         * Verdict delivery, all three legs (§5.2). Leg 1 (the polling agent) is
         * the registry's own business; these are legs 2 and 3.
         */
        onGateResolved: (taskId, gate) => {
            // Leg 3, and the one that cannot fail: the verdict is already in the
            // record by the time this runs, so it is waiting for the next
            // `tasks_get` even if nothing below reaches anyone.
            deps.sendToRenderer('tasks:gate-resolved', { taskId, gate });
            void pushGateSummary();
            // Leg 2: the agent's turn is usually over for a done gate, so nudge the
            // terminal the task is bound to. Best-effort by design.
            void dispatcher?.nudgeVerdict(taskId, gate).catch(() => { });
        },
        /**
         * A merged-away task's agent is still working an id that no longer names
         * anything. Tell it which task survived — through the member channel, not
         * a raw write (§4.6).
         */
        onTaskMerged: (mergedId, survivorId) => {
            deps.sendToRenderer('tasks:changed', { projectIds: [] });
            void dispatcher?.nudgeMerged(mergedId, survivorId).catch(() => { });
        },
        onGateOpened: (taskId, gate) => {
            deps.sendToRenderer('tasks:gate-opened', { taskId, gate });
            void pushGateSummary();
            void emitGateAttention(taskId, gate);
        },
        isRunAlive: (runId) => {
            const controller = deps.getAgentTeamController?.();
            if (!controller)
                return true; // no knowledge is not evidence of death
            const [run] = controller.runsByIds([runId]);
            // A run the controller no longer knows about is NOT alive — but that
            // alone never stales a gate: `stalenessOf` applies the kind-specific
            // rule, so a done gate opened by normal completion survives its run's
            // disappearance (recovery, compaction) exactly as §5.2 requires.
            if (!run)
                return false;
            return !['done', 'error', 'timed-out', 'cancelled', 'interrupted', 'submission-interrupted', 'discarded']
                .includes(run.state);
        },
    });
    /** Badge count, pushed on every gate transition (§5.3). */
    const pushGateSummary = async () => {
        try {
            const open = await manager.openGates();
            deps.sendToRenderer('tasks:gate-summary', { openGateCount: open.length });
        }
        catch { /* the badge is advisory */ }
    };
    /**
     * The attention feed leg (§5.3). Advisory UI: the card routes the human to
     * the review queue and never resolves anything itself.
     */
    const emitGateAttention = async (taskId, gate) => {
        try {
            const found = await manager.get(taskId);
            if (!found)
                return;
            const assignee = found.task.assignee;
            deps.sendToRenderer('app:attention-event', {
                id: `task-gate-${gate.id}`,
                kind: 'task-gate',
                // Names the agent that asked when there is one; otherwise the task
                // itself, so the card stays addressable rather than being dropped.
                terminalId: assignee?.id ?? taskId,
                terminalName: assignee?.label ?? found.task.title,
                projectId: found.task.projectId,
                projectName: '',
                ...(assignee?.agentType ? { agentType: assignee.agentType } : {}),
                detail: `${gate.kind} approval needed — ${found.task.title}`.slice(0, attention_1.ATTENTION_DETAIL_MAX_CHARS),
                ...(gate.options?.length ? { options: gate.options } : {}),
                timestamp: gate.requestedAt,
            });
        }
        catch { /* advisory */ }
    };
    // One principal for the process, shared by dispatch and by decomposition's
    // live-terminal path — both borrow terminals under the same app-owned host,
    // and a second principal would make the same app look like two owners.
    const hostPrincipal = new hostPrincipal_1.TasksHostPrincipal(deps.baseDir);
    decomposeRuns = new decomposeRuns_1.DecomposeRunManager({
        storePath: path.join(deps.baseDir, 'decompose-runs.json'),
        onChanged: (payload) => {
            deps.sendToRenderer('tasks:decompose-changed', payload);
        },
        execute: async ({ projectId, goal, target, signal, onLog }) => (0, decompose_1.decomposeGoal)({
            runInTerminal: async ({ terminalId, prompt, timeoutSeconds, signal: runSignal }) => (0, decomposeInTerminal_1.runDecomposeInTerminal)({
                getController: () => deps.getAgentTeamController?.() ?? null,
                hostPrincipal,
            }, {
                terminalId,
                projectId,
                prompt,
                ...(timeoutSeconds ? { timeoutSeconds } : {}),
                ...(runSignal ? { signal: runSignal } : {}),
            }),
        }, { goal, target, signal, onLog }),
    });
    dispatcher = new dispatch_1.TaskDispatcher({
        manager,
        getController: () => deps.getAgentTeamController?.() ?? null,
        hostPrincipal,
        ...(deps.getTerminalName ? { getTerminalName: deps.getTerminalName } : {}),
        ...(deps.sharedWorkspaceFor ? { sharedWorkspaceFor: deps.sharedWorkspaceFor } : {}),
        onRunBound: (runId) => runMapper?.noteBoundRun(runId),
    });
    runMapper = new runMapper_1.TaskRunMapper({
        manager,
        getController: () => deps.getAgentTeamController?.() ?? null,
    });
    const guarded = (handler) => {
        return async (event, args) => {
            if (!isMainRenderer(event))
                return { ok: false, error: 'untrusted renderer origin' };
            return handler(args);
        };
    };
    electron_1.ipcMain.handle('tasks:mint-action-grant', async (event, args = {}) => {
        if (!isMainRenderer(event))
            return { ok: false, error: 'untrusted renderer origin' };
        if (!(await hasMainRendererGesture(event)))
            return { ok: false, error: 'requires a user gesture' };
        const action = args.action;
        if (!action ||
            typeof action !== 'object' ||
            !['delete', 'config-set', 'assign', 'unassign', 'decompose', 'merge', 'resolve-gate']
                .includes(action.action)) {
            return { ok: false, error: 'invalid Tasks action' };
        }
        try {
            return { ok: true, grant: (0, dispatchGrant_1.mintTaskActionGrant)(action) };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle('tasks:list', guarded(async (args) => manager.list(args)));
    electron_1.ipcMain.handle('tasks:errors', guarded(async (args) => manager.errors(args.projectId)));
    electron_1.ipcMain.handle('tasks:get', guarded(async (args) => manager.get(args.id)));
    electron_1.ipcMain.handle('tasks:create', guarded(async (args) => manager.create(args)));
    electron_1.ipcMain.handle('tasks:update', guarded(async (args) => manager.update(args)));
    // The board's drag gesture (§7.2). Separate from `tasks:update` because it is
    // the only status write that is checked against holds, open gates and the
    // file's proposal before it lands — see `TasksManager.moveStatus`.
    electron_1.ipcMain.handle('tasks:move-status', guarded(async (args) => manager.moveStatus(args)));
    electron_1.ipcMain.handle('tasks:link', guarded(async (args) => manager.link(args)));
    electron_1.ipcMain.handle('tasks:delete', async (event, args) => {
        if (!isMainRenderer(event))
            return { ok: false, error: 'untrusted renderer origin' };
        const granted = (0, dispatchGrant_1.consumeTaskActionGrant)(args.grant ?? '', { action: 'delete', id: args.id });
        if (!granted.ok)
            return { ok: false, error: granted.error };
        const result = await manager.delete(args.id);
        if (result.ok)
            void pushGateSummary();
        return result;
    });
    electron_1.ipcMain.handle('tasks:config-get', guarded(async (args) => manager.getConfig(args.repoRoot)));
    electron_1.ipcMain.handle('tasks:policy-get', guarded(async (args) => manager.effectivePolicy(args.projectId, args.repoRoot)));
    electron_1.ipcMain.handle('tasks:config-set', async (event, args) => {
        if (!isMainRenderer(event))
            return { ok: false, error: 'untrusted renderer origin' };
        const granted = (0, dispatchGrant_1.consumeTaskActionGrant)(args.grant ?? '', {
            action: 'config-set',
            projectId: args.projectId,
            repoRoot: args.repoRoot,
            patch: args.patch,
        });
        if (!granted.ok)
            return { ok: false, error: granted.error };
        return manager.setConfig(args.repoRoot, args.patch, args.projectId);
    });
    // --- dispatch (§4.7, §7.3) -------------------------------------------------
    /**
     * The exact prompt `tasks:assign` would build, plus the grant that binds this
     * review to that dispatch. Writes nothing — but it is still `isMainRenderer`,
     * because every tasks channel is.
     */
    electron_1.ipcMain.handle('tasks:preview-dispatch', guarded(async (args) => dispatcher.preview(args)));
    electron_1.ipcMain.handle('tasks:assign', async (event, args) => {
        if (!isMainRenderer(event))
            return { ok: false, error: 'untrusted renderer origin' };
        // The grant is bound to the reviewed prompt fingerprint. NOTE: no `prompt`
        // field — main rebuilds it and fails closed on drift.
        return dispatcher.assign(args);
    });
    electron_1.ipcMain.handle('tasks:unassign', async (event, args) => {
        if (!isMainRenderer(event))
            return { ok: false, error: 'untrusted renderer origin' };
        const granted = (0, dispatchGrant_1.consumeTaskActionGrant)(args.grant ?? '', { action: 'unassign', taskId: args.taskId });
        if (!granted.ok)
            return { ok: false, error: granted.error };
        return dispatcher.unassign(args.taskId);
    });
    /**
     * Decomposition (§4.5a). Read-shaped — it writes nothing — but it TAKES A
     * TERMINAL'S TURN, so it is gesture-gated like every other channel that does.
     * The proposal comes back for review; nothing
     * reaches `.1devtool/tasks/` until the human accepts it through the ordinary
     * create path.
     *
     * The target is part of the grant tuple, not an argument beside it: a token
     * minted for one terminal must not be replayable against another.
     *
     * This handler ACKs after main creates the durable run record. It does not
     * await the agent. The first cut's long IPC promise made the dialog the only
     * owner of the eventual proposal and logs, so closing it created an
     * unobservable child that could finish successfully with nowhere to report.
     */
    electron_1.ipcMain.handle('tasks:decompose', async (event, args) => {
        if (!isMainRenderer(event))
            return { ok: false, error: 'untrusted renderer origin' };
        if (!(0, tasks_1.isTaskDecomposeTarget)(args.target)) {
            return { ok: false, error: 'Decompose a goal requires a live AI terminal' };
        }
        const granted = (0, dispatchGrant_1.consumeTaskActionGrant)(args.grant ?? '', {
            action: 'decompose',
            goal: args.goal,
            repoRoot: args.repoRoot,
            target: args.target,
        });
        if (!granted.ok)
            return { ok: false, error: granted.error };
        if (!args.projectId)
            return { ok: false, error: 'a decomposition needs a project' };
        return decomposeRuns.start({
            projectId: args.projectId,
            repoRoot: args.repoRoot,
            goal: args.goal,
            target: args.target,
        });
    });
    electron_1.ipcMain.handle('tasks:decompose-runs', guarded(async (args) => decomposeRuns.list(args.projectId, args.limit)));
    electron_1.ipcMain.handle('tasks:decompose-run', guarded(async (args) => decomposeRuns.get(args.runId)));
    electron_1.ipcMain.handle('tasks:decompose-accepted', guarded(async (args) => {
        const run = await decomposeRuns.markAccepted(args.runId);
        return run ? { ok: true, run } : { ok: false, error: 'proposal is not ready' };
    }));
    /**
     * Merge (§4.6). Destroys the identity of every task but the survivor, so it
     * is gesture-bound like every destructive channel — and it is deliberately
     * NOT an MCP tool: agents producing duplicates is the problem, and handing
     * agents the merge verb does not fix it.
     */
    electron_1.ipcMain.handle('tasks:merge', async (event, args) => {
        if (!isMainRenderer(event))
            return { ok: false, error: 'untrusted renderer origin' };
        const granted = (0, dispatchGrant_1.consumeTaskActionGrant)(args.grant ?? '', {
            action: 'merge',
            ids: args.ids,
            survivorId: args.survivorId,
            ...(args.title ? { title: args.title } : {}),
        });
        if (!granted.ok)
            return { ok: false, error: granted.error };
        return manager.merge(args);
    });
    electron_1.ipcMain.handle('tasks:gates', guarded(async () => manager.openGates()));
    electron_1.ipcMain.handle('tasks:resolve-gate', async (event, args) => {
        if (!isMainRenderer(event))
            return { ok: false, error: 'untrusted renderer origin' };
        // THE decision channel. An agent that could reach this would be approving
        // its own work, which is the one thing gates exist to prevent (§5.2) — so
        // it is renderer-only, action-capability-bound, and there is no MCP tool
        // anywhere that resolves a gate.
        if (args.verdict !== 'approved' && args.verdict !== 'changes-requested' && args.verdict !== 'declined') {
            return { ok: false, error: 'invalid verdict' };
        }
        const granted = (0, dispatchGrant_1.consumeTaskActionGrant)(args.grant ?? '', {
            action: 'resolve-gate',
            gateId: args.gateId,
            verdict: args.verdict,
            ...(args.response ? { response: args.response } : {}),
        });
        if (!granted.ok)
            return { ok: false, error: granted.error };
        return manager.resolveGate(args.gateId, {
            verdict: args.verdict,
            ...(args.response ? { response: args.response } : {}),
            resolvedBy: { kind: 'human', id: 'me', label: 'me' },
        });
    });
    electron_1.ipcMain.handle('tasks:index-refresh', guarded(async (args) => manager.refresh(args.projectId, args.repoRoot, args.force ?? false).then(() => ({ ok: true }))));
    electron_1.ipcMain.handle('tasks:boot-summary', guarded(async () => manager_1.TasksManager.readBootSummary(deps.baseDir)));
}
async function disposeTaskIpc() {
    runMapper?.stop();
    runMapper = null;
    dispatcher = null;
    const runs = decomposeRuns;
    decomposeRuns = null;
    await runs?.dispose();
    await manager?.dispose();
    manager = null;
}
