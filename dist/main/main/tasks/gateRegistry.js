"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskGateRegistry = exports.TASK_GATE_POLL_MAX_MS = void 0;
const crypto_1 = require("crypto");
/**
 * The one gate registry (docs/tasks_v2.md §5.2). Main-owned, every substrate.
 *
 * Rev 3 tried to host gate waits on orchestration's runtime interactions; that
 * was proven unimplementable (interactions are adapter-owned and cannot be
 * minted from outside an active turn), so every gate — plan, spec, done,
 * question — waits HERE, and orchestration contributes exactly one thing:
 * lifecycle correlation through `runId`.
 *
 * The shape is **open → poll**, not one long block, because a tool call that
 * blocks for the human's 30-minute policy is racing every CLI's own MCP
 * timeout: a human answering after ten minutes would be answering a call the
 * client already killed. `open()` returns immediately; `wait()` blocks for a
 * bounded poll window and returns `open` so the agent can call again. The gate
 * is never attached to any live call, so a killed client, a client timeout or
 * a dead terminal leaves it answerable in the review queue.
 *
 * Open gates live in the app-owned authority store, deliberately NOT in the
 * git-tracked file: a gate an agent could edit is not a gate. Resolved gates
 * are projected into the file as audit by the caller's `onResolved` hook.
 */
/**
 * Bound on ONE `tasks_wait` block. Implementation-owned and deliberately
 * separate from `gateTimeoutMs` (the human's 30-minute policy — the wrong
 * timeout for a poll).
 *
 * 20 s is a HYPOTHESIS, not a measurement: the per-CLI cancellation/re-entry
 * matrix in §11's P2/P4 gates is what sets this number. It lives here, and
 * never in the installed skill, because transport timeouts and client defaults
 * drift and the skill cannot be updated per client.
 */
exports.TASK_GATE_POLL_MAX_MS = 20_000;
/** How often a blocked `wait()` re-checks. Resolution also signals directly. */
const POLL_INTERVAL_MS = 250;
const TIMEOUT_DETAIL = 'Nobody answered in time. Do not proceed — silence is not approval. The task is blocked until a human picks it up.';
class TaskGateRegistry {
    deps;
    /** gateId → waiters to wake the moment a verdict lands (poll is the fallback). */
    waiters = new Map();
    /**
     * Gate open/resolve/timeout is authority mutation. Serialize the complete
     * decision so two clicks, or a click racing the lazy timeout sweep, cannot
     * both resolve the same gate with different verdicts.
     */
    mutationTail = Promise.resolve();
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * Open a gate, or return the one already open for this task.
     *
     * At most one open gate per task (§5.2): a second request returns the
     * existing id rather than queueing a second card for the human. This is also
     * what makes the done-gate opener idempotent — `tasks_complete` and the
     * snapshot's success transition both land here, in whichever order, and the
     * second caller gets the first one's gateId.
     */
    async open(input) {
        return this.serializeMutation(async () => {
            await this.sweepUnlocked(input.taskId);
            const record = await this.deps.authority.get(input.taskId);
            const existing = record.openGates[0];
            if (existing)
                return { gateId: existing.id, existing: true };
            const now = Date.now();
            const gate = {
                id: `g-${(0, crypto_1.randomUUID)()}`,
                kind: input.kind,
                wait: {
                    gateId: '',
                    ...(input.runId ? { runId: input.runId } : {}),
                    openedAt: now,
                    expiresAt: now + input.timeoutMs,
                    onTimeout: input.onTimeout ?? 'block',
                },
                requestedAt: now,
                requestedBy: input.requestedBy,
                payload: input.payload,
                ...(input.options?.length ? { options: input.options } : {}),
                openedBy: input.openedBy ?? 'request',
            };
            gate.wait.gateId = gate.id;
            await this.deps.authority.update(input.taskId, (current) => ({
                ...current,
                openGates: current.openGates.length ? current.openGates : [gate],
            }));
            const current = await this.deps.authority.get(input.taskId);
            const winner = current.openGates[0];
            if (!winner) {
                throw new Error('gate authority update did not persist an open gate');
            }
            return winner.id === gate.id
                ? { gateId: gate.id, existing: false }
                : { gateId: winner.id, existing: true };
        });
    }
    /** Find an open gate by id across tasks. Null once resolved (or never opened). */
    async find(gateId) {
        return this.deps.authority.findOpenGate(gateId);
    }
    /**
     * Resolve a gate. The human's path — never reachable from MCP, because an
     * agent that can answer its own gate has no gate (§5.2, §6.2).
     */
    async resolve(gateId, resolution) {
        return this.serializeMutation(async () => {
            const found = await this.find(gateId);
            if (!found || this.stalenessOf(found.gate))
                return null;
            return this.closeUnlocked(found.taskId, found.gate, {
                resolvedAt: Date.now(),
                resolvedBy: resolution.resolvedBy,
                verdict: resolution.verdict,
                ...(resolution.response ? { response: resolution.response } : {}),
            });
        });
    }
    /**
     * Status of a gate right now, applying the timeout and staleness rules.
     * Cheap enough to call on every poll; sweeps lazily so no timer is needed.
     */
    async status(gateId) {
        const found = await this.deps.authority.findGate(gateId);
        if (!found)
            return { gateId, status: 'unknown' };
        // Already answered — including by the timeout sweep. An agent that polls a
        // second late must still learn the verdict; "not open" is not an answer.
        if (!found.open)
            return this.answered(gateId, found.gate);
        const swept = await this.sweep(found.taskId);
        if (swept.has(gateId)) {
            const after = await this.deps.authority.findGate(gateId);
            return after ? this.answered(gateId, after.gate) : {
                gateId,
                status: 'timeout',
                kind: found.gate.kind,
                verdict: 'timeout',
                detail: TIMEOUT_DETAIL,
            };
        }
        const stale = this.stalenessOf(found.gate);
        if (stale) {
            return { gateId, status: 'stale', kind: found.gate.kind, detail: stale };
        }
        return { gateId, status: 'open', kind: found.gate.kind };
    }
    /** Shape an answered gate for the poll path — timeout is its own status. */
    answered(gateId, gate) {
        const timedOut = gate.verdict === 'timeout';
        return {
            gateId,
            status: timedOut ? 'timeout' : 'resolved',
            kind: gate.kind,
            ...(gate.verdict ? { verdict: gate.verdict } : {}),
            ...(gate.response ? { response: gate.response } : {}),
            ...(timedOut ? { detail: TIMEOUT_DETAIL } : {}),
        };
    }
    /**
     * Block until this gate is answered, for at most `pollMaxMs`. Returns `open`
     * on expiry so the agent polls again; an agent that stops polling costs
     * nothing, because the gate is not attached to this call.
     */
    async wait(gateId, options = {}) {
        const budget = options.pollMaxMs ?? exports.TASK_GATE_POLL_MAX_MS;
        const deadline = Date.now() + budget;
        for (;;) {
            const status = await this.status(gateId);
            if (status.status !== 'open')
                return status;
            if (options.signal?.aborted)
                return { ...status, detail: 'poll cancelled by the client' };
            if (Date.now() >= deadline)
                return status;
            await this.sleepUntilSignalled(gateId, Math.min(POLL_INTERVAL_MS, deadline - Date.now()), options.signal);
        }
    }
    /** Open gates across every task — the review queue's source (P4 renders it). */
    async openGates() {
        const before = await this.deps.authority.listOpenGates();
        for (const taskId of new Set(before.map((item) => item.taskId))) {
            await this.sweep(taskId);
        }
        return this.deps.authority.listOpenGates();
    }
    /**
     * A stale gate cannot be answered, but a human-gestured redispatch is the
     * documented way to supersede it. Retire only stale gates; a live approval
     * continues to block dispatch.
     */
    async retireStaleForRedispatch(taskId) {
        return this.serializeMutation(async () => {
            const record = await this.deps.authority.get(taskId);
            let retired = 0;
            for (const gate of record.openGates) {
                const stale = this.stalenessOf(gate);
                if (!stale)
                    continue;
                const closed = await this.closeUnlocked(taskId, gate, {
                    resolvedAt: Date.now(),
                    verdict: 'changes-requested',
                    response: `Superseded by a human redispatch: ${stale}`,
                    resolvedBy: { kind: 'human', id: 'me', label: 'me (redispatch)' },
                });
                if (closed)
                    retired += 1;
            }
            return retired;
        });
    }
    // --- internals ------------------------------------------------------------
    /**
     * Kind- and reason-specific staleness (§5.2). A blanket "dead run → stale
     * gate" would have staled every done gate the instant it opened, since a done
     * gate opens AT completion. So: plan/question gates stale when their run is
     * gone (the asker is not there to receive an answer); a done gate opened by
     * normal completion is post-run review and stays resolvable indefinitely;
     * only a done gate opened abnormally, before completion, is stale.
     */
    stalenessOf(gate) {
        const runId = gate.wait.runId;
        if (!runId || !this.deps.isRunAlive)
            return null;
        if (this.deps.isRunAlive(runId))
            return null;
        if (gate.kind === 'done') {
            return gate.openedBy === 'normal-completion'
                ? null
                : 'the run ended abnormally before completing — this gate cannot be approved, only reopened by a fresh dispatch';
        }
        return 'the run that asked is gone — an answer would reach nobody; redispatch instead';
    }
    /** Expire any gate past `expiresAt`. Returns the ids expired in this pass. */
    async sweep(taskId) {
        return this.serializeMutation(() => this.sweepUnlocked(taskId));
    }
    async sweepUnlocked(taskId) {
        const record = await this.deps.authority.get(taskId);
        const now = Date.now();
        const expired = record.openGates.filter((gate) => gate.wait.expiresAt <= now);
        const ids = new Set(expired.map((gate) => gate.id));
        for (const gate of expired) {
            // 'approve' is not an option anywhere in this system. Decline cancels;
            // the safe default blocks. Silence can never advance work (§5.1).
            const decline = gate.wait.onTimeout === 'decline';
            await this.closeUnlocked(taskId, gate, {
                resolvedAt: now,
                verdict: decline ? 'declined' : 'timeout',
                resolvedBy: { kind: 'human', id: 'me', label: 'nobody (timed out)' },
                ...(decline ? { response: 'No answer arrived before the approval deadline.' } : {}),
            });
        }
        return ids;
    }
    async closeUnlocked(taskId, gate, patch) {
        const resolved = { ...gate, ...patch };
        let closed = false;
        await this.deps.authority.update(taskId, (record) => {
            if (!record.openGates.some((item) => item.id === gate.id))
                return record;
            closed = true;
            return {
                ...record,
                openGates: record.openGates.filter((item) => item.id !== gate.id),
                // Answered gates stay queryable for a short tail so an agent polling a
                // beat late gets its verdict rather than "not open" (§5.2).
                resolvedGates: [...(record.resolvedGates ?? []), resolved],
            };
        });
        if (!closed)
            return null;
        await this.deps.onResolved?.(taskId, resolved);
        this.wake(gate.id);
        return resolved;
    }
    serializeMutation(mutate) {
        const operation = this.mutationTail.then(mutate, mutate);
        this.mutationTail = operation.then(() => undefined, () => undefined);
        return operation;
    }
    wake(gateId) {
        const set = this.waiters.get(gateId);
        if (!set)
            return;
        for (const fn of set)
            fn();
        this.waiters.delete(gateId);
    }
    sleepUntilSignalled(gateId, ms, signal) {
        if (ms <= 0)
            return Promise.resolve();
        return new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                this.waiters.get(gateId)?.delete(finish);
                signal?.removeEventListener('abort', finish);
                resolve();
            };
            const timer = setTimeout(finish, ms);
            if (!this.waiters.has(gateId))
                this.waiters.set(gateId, new Set());
            this.waiters.get(gateId).add(finish);
            signal?.addEventListener('abort', finish, { once: true });
        });
    }
}
exports.TaskGateRegistry = TaskGateRegistry;
