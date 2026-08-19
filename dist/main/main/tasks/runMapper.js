"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskRunMapper = void 0;
/**
 * Run outcomes → task state (docs/tasks_v2.md §4.7).
 *
 * Tasks subscribes to the orchestration snapshot and reflects it; it never
 * second-guesses it. Two properties this file exists to guarantee:
 *
 * 1. **Bound runs only.** Snapshots carry no `taskId`, so the mapper looks up
 *    the binding and ignores everything else. A run this task never gestured
 *    for is not this task's run, however adjacent it looks in the snapshot.
 * 2. **Idempotent.** The controller emits a change on every commit and the same
 *    terminal state is seen many times; each outcome is applied once, keyed on
 *    `(runId, state)`. Replaying a snapshot must double-apply nothing.
 *
 * Rev 3 keyed this table on which resolver was called; that is not how the
 * controller works (ordinary success never touches `resolveConfirmation`, the
 * headless fallback reuses the run id). It is keyed on run state transitions.
 */
const APPLIED_CAP = 500;
class TaskRunMapper {
    deps;
    /** `runId:state` already applied — the idempotence key. */
    applied = new Set();
    dispose = null;
    pumping = null;
    pumpRequested = false;
    constructor(deps) {
        this.deps = deps;
    }
    start() {
        const controller = this.deps.getController();
        if (!controller || this.dispose)
            return;
        this.dispose = controller.addStateListener(() => this.schedule());
        controller.fallbackPolicy = (event) => this.policyFor(event);
        controller.onFallbackResolved = (event) => { void this.recordLineage(event); };
        this.schedule();
    }
    stop() {
        this.dispose?.();
        this.dispose = null;
        const controller = this.deps.getController();
        if (controller) {
            controller.fallbackPolicy = null;
            controller.onFallbackResolved = null;
        }
    }
    /**
     * Fallback policy (§4.7). Synchronous by necessity — it runs inside
     * `resolveFallback` before any state changes — so the binding set is kept
     * warm in memory and refreshed on every snapshot pass.
     */
    boundRunIds = new Set();
    /**
     * A controller commit happens before dispatch can persist the task binding,
     * so the snapshot pump that commit triggers may legitimately see no binding.
     * Warm the synchronous fallback-policy set at the moment the binding lands;
     * otherwise a fast fallback action can slip through before the next commit.
     */
    noteBoundRun(runId) {
        this.boundRunIds.add(runId);
    }
    policyFor(event) {
        if (!this.boundRunIds.has(event.runId))
            return { ok: true };
        if (event.action === 'reassign') {
            // Intercepted BEFORE the controller creates a replacement: it queues one
            // immediately, so a post-hoc refusal would leave unbound work running
            // while a fresh assignment dispatched a duplicate. Mission Control turns
            // this into the gestured Tasks assign dialog.
            return {
                ok: false,
                error: 'task-reassign-required: this run belongs to a task — reassign it from the Tasks panel so the binding moves with it',
            };
        }
        if (event.action === 'headless') {
            // Headless strips ONEDEVTOOL_TERMINAL_ID, and every part of the task
            // model — assignment, tasks_next, attribution, write authorization — is
            // terminal-identity based. The agent would go unattributed mid-task.
            return {
                ok: false,
                error: 'this run belongs to a task and cannot be downgraded to headless — it would lose the terminal identity the task tools need',
            };
        }
        return { ok: true }; // retry: same target, same work — continuity, below
    }
    async recordLineage(event) {
        if (event.action !== 'retry')
            return;
        const taskId = await this.deps.manager.taskForRun(event.oldRunId);
        if (!taskId)
            return;
        const controller = this.deps.getController();
        const [replacement] = controller?.runsByIds([event.replacementRunId]) ?? [];
        if (!replacement)
            return;
        await this.deps.manager.recordContinuation(taskId, event.oldRunId, {
            runId: replacement.runId,
            terminalId: replacement.terminalId ?? '',
            agentType: replacement.target,
            startedAt: replacement.createdAt,
        });
        this.boundRunIds.add(replacement.runId);
    }
    /** Coalesce bursts: the controller commits several times per dispatch. */
    schedule() {
        this.pumpRequested = true;
        if (this.pumping)
            return;
        this.pumping = Promise.resolve().then(async () => {
            while (this.pumpRequested) {
                this.pumpRequested = false;
                await this.pump();
            }
        })
            .catch(() => { })
            .finally(() => {
            this.pumping = null;
            if (this.pumpRequested)
                this.schedule();
        });
    }
    async pump() {
        const controller = this.deps.getController();
        if (!controller)
            return;
        const bindings = await this.deps.manager.allRunBindings();
        this.boundRunIds = new Set(bindings.map((b) => b.run.runId));
        if (!bindings.length)
            return;
        const runs = new Map(controller.runsByIds(bindings.map((b) => b.run.runId)).map((run) => [run.runId, run]));
        for (const binding of bindings) {
            const run = runs.get(binding.run.runId);
            if (!run)
                continue;
            await this.applyOutcome(binding.taskId, binding.run, run);
        }
    }
    async applyOutcome(taskId, bound, run) {
        const key = `${run.runId}:${run.state}`;
        if (this.applied.has(key))
            return;
        this.applied.add(key);
        if (this.applied.size > APPLIED_CAP) {
            // Bounded: the oldest keys belong to runs long finished, and re-applying
            // a terminal outcome is a no-op anyway (the task has already moved).
            const oldest = this.applied.values().next().value;
            if (oldest)
                this.applied.delete(oldest);
        }
        const actor = {
            kind: 'agent',
            id: run.terminalId ?? run.runId,
            label: bound.agentType || run.target,
            agentType: run.target,
        };
        // A terminal id that only appears once the run starts must reach the
        // binding, or `tasks_next` has no queue to answer for.
        if (run.terminalId && run.terminalId !== bound.terminalId) {
            await this.deps.manager.recordRun(taskId, { ...bound, terminalId: run.terminalId });
            await this.deps.manager.setAssignee(taskId, { ...actor, id: run.terminalId });
        }
        switch (run.state) {
            case 'done':
                await this.deps.manager.onRunSucceeded(taskId, run.runId, actor);
                break;
            case 'error':
            case 'timed-out':
            case 'uncertain':
                await this.deps.manager.onRunFailed(taskId, run.runId, actor, run.state, run.error);
                break;
            case 'cancelled':
            case 'interrupted':
            case 'submission-interrupted':
                await this.deps.manager.onRunCancelled(taskId, run.runId, actor);
                break;
            default:
                break; // still in flight — the task is already in_progress
        }
    }
}
exports.TaskRunMapper = TaskRunMapper;
