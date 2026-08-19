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
exports.TaskAuthorityStore = void 0;
const fs_1 = require("fs");
const path = __importStar(require("path"));
/**
 * How many answered gates stay queryable per task. A polling agent must be able
 * to learn the verdict it was waiting for even though the gate has left
 * `openGates` — without this tail, `tasks_wait` could only ever say "not open",
 * which is not an answer. The file keeps the full audit; this is the short
 * recent window the poll path needs.
 */
const RESOLVED_GATE_TAIL = 5;
const emptyAuthorityFile = () => ({ version: 1, tasks: {}, redirects: {} });
const emptyAuthorityRecord = () => ({
    assignee: null,
    openGates: [],
    runs: [],
    holds: [],
});
async function atomicWrite(filePath, data) {
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs_1.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs_1.promises.writeFile(tmp, data, 'utf8');
    await fs_1.promises.rename(tmp, filePath);
}
class TaskAuthorityStore {
    baseDir;
    state = null;
    /**
     * Authority writes are read-modify-write transactions, not merely serialized
     * disk flushes. Serializing only `persist()` still lets an assignee update and
     * a run/gate update read the same old record and overwrite one another.
     */
    mutationChain = Promise.resolve();
    /** Gate count of the last summary written this process — null until one lands. */
    lastSummaryGateCount = null;
    constructor(baseDir) {
        this.baseDir = baseDir;
    }
    get filePath() {
        return path.join(this.baseDir, 'tasks-authority.json');
    }
    get summaryPath() {
        return path.join(this.baseDir, 'tasks-summary.json');
    }
    async load() {
        if (this.state)
            return this.state;
        try {
            const raw = JSON.parse(await fs_1.promises.readFile(this.filePath, 'utf8'));
            this.state = raw && raw.version === 1 ? raw : emptyAuthorityFile();
        }
        catch {
            this.state = emptyAuthorityFile();
        }
        return this.state;
    }
    /**
     * Serialize one complete state mutation and its durable flush. The recovered
     * tail keeps a transient write failure from poisoning every later authority
     * update for the lifetime of the app.
     */
    serializeMutation(mutate) {
        const run = async () => {
            const state = await this.load();
            const result = await mutate(state);
            await atomicWrite(this.filePath, JSON.stringify(state));
            await this.writeSummary(state);
            return result;
        };
        const operation = this.mutationChain.then(run, run);
        this.mutationChain = operation.then(() => undefined, () => undefined);
        return operation;
    }
    /**
     * The boot summary (§9): a tiny file read at boot for the status-bar badge.
     * Boot reads THIS file and only this file — never the authority file, never
     * the full index; that parse is not a stable ≤5 ms contract at scale.
     */
    async writeSummary(state) {
        let openGateCount = 0;
        for (const record of Object.values(state.tasks))
            openGateCount += record.openGates.length;
        // Every mutation lands here and most leave the gate count alone — skip the
        // write when the file on disk already says this.
        if (openGateCount === this.lastSummaryGateCount)
            return;
        const summary = { version: 1, openGateCount, updatedAt: Date.now() };
        await atomicWrite(this.summaryPath, JSON.stringify(summary));
        this.lastSummaryGateCount = openGateCount;
    }
    static async readBootSummary(baseDir) {
        try {
            const raw = JSON.parse(await fs_1.promises.readFile(path.join(baseDir, 'tasks-summary.json'), 'utf8'));
            if (raw && raw.version === 1)
                return raw;
        }
        catch { /* fall through */ }
        return { version: 1, openGateCount: 0, updatedAt: 0 };
    }
    async get(taskId) {
        const state = await this.load();
        return state.tasks[taskId] ?? emptyAuthorityRecord();
    }
    /**
     * One-shot view for bulk overlay (index rows, `tasks_next`). Read-only by
     * contract: callers project fields out of it, never write through it.
     *
     * This exists so the indexer can overlay authority onto every row after a
     * SINGLE load instead of awaiting per task — the overlay runs on every list
     * read, so a per-row await would put file I/O on the panel-open path.
     */
    async view() {
        const state = await this.load();
        return {
            of(taskId) {
                const record = state.tasks[taskId];
                if (!record)
                    return { assignee: null, openGateKind: null, holds: [], status: null };
                return {
                    assignee: record.assignee,
                    openGateKind: record.openGates[0]?.kind ?? null,
                    holds: record.holds,
                    status: record.status ?? null,
                };
            },
        };
    }
    async set(taskId, record) {
        await this.update(taskId, () => record);
    }
    /**
     * Atomic read-modify-write for one authority record. Every caller that
     * changes only one field must use this instead of get()+set(), otherwise a
     * concurrent gate/run/assignment mutation can be silently lost.
     */
    async update(taskId, mutate) {
        return this.serializeMutation((state) => {
            const current = state.tasks[taskId] ?? emptyAuthorityRecord();
            const record = mutate({
                ...current,
                openGates: [...current.openGates],
                ...(current.resolvedGates ? { resolvedGates: [...current.resolvedGates] } : {}),
                runs: [...current.runs],
                holds: [...current.holds],
            });
            const trimmed = {
                ...record,
                ...(record.resolvedGates?.length
                    ? { resolvedGates: record.resolvedGates.slice(-RESOLVED_GATE_TAIL) }
                    : {}),
            };
            const isEmpty = !trimmed.status &&
                !trimmed.assignee &&
                !trimmed.openGates.length &&
                !trimmed.runs.length &&
                !trimmed.holds.length &&
                !trimmed.resolvedGates?.length;
            if (isEmpty)
                delete state.tasks[taskId];
            else
                state.tasks[taskId] = trimmed;
            return trimmed;
        });
    }
    /**
     * Establish authority for newly observed task files without overwriting an
     * existing effective status. That distinction turns later workspace edits
     * into proposals rather than lifecycle transitions.
     */
    async seedStatuses(rows) {
        if (!rows.length)
            return;
        // Statuses only ever gain a value here, so a peek outside the mutation
        // chain is safe: when every row is already seeded there is nothing to
        // write, and entering the chain would flush the file for a no-op.
        const current = await this.load();
        if (rows.every((row) => current.tasks[row.id]?.status))
            return;
        await this.serializeMutation((state) => {
            for (const row of rows) {
                const current = state.tasks[row.id] ?? emptyAuthorityRecord();
                if (current.status)
                    continue;
                state.tasks[row.id] = { ...current, status: row.status };
            }
        });
    }
    /** Remove live coordination when the human deletes the task. */
    async delete(taskId) {
        await this.serializeMutation((state) => {
            delete state.tasks[taskId];
        });
    }
    /** Locate an OPEN gate by id. Resolved gates leave this store by design. */
    async findOpenGate(gateId) {
        const state = await this.load();
        for (const [taskId, record] of Object.entries(state.tasks)) {
            const gate = record.openGates.find((g) => g.id === gateId);
            if (gate)
                return { taskId, gate };
        }
        return null;
    }
    /**
     * Locate a gate by id whether it is still open or recently answered. The
     * poll path needs both: "not open" and "answered five seconds ago" are very
     * different answers to give an agent.
     */
    async findGate(gateId) {
        const state = await this.load();
        for (const [taskId, record] of Object.entries(state.tasks)) {
            const open = record.openGates.find((g) => g.id === gateId);
            if (open)
                return { taskId, gate: open, open: true };
            const resolved = record.resolvedGates?.find((g) => g.id === gateId);
            if (resolved)
                return { taskId, gate: resolved, open: false };
        }
        return null;
    }
    /** Every task→run binding. The outcome mapper's working set. */
    async listRuns() {
        const state = await this.load();
        return Object.entries(state.tasks).flatMap(([taskId, record]) => record.runs.map((run) => ({ taskId, run })));
    }
    /** Which task, if any, owns this run (§4.7 — bindings are explicit). */
    async findTaskByRunId(runId) {
        const state = await this.load();
        for (const [taskId, record] of Object.entries(state.tasks)) {
            if (record.runs.some((run) => run.runId === runId))
                return taskId;
        }
        return null;
    }
    /** Every open gate — the review queue's source of truth across projects. */
    async listOpenGates() {
        const state = await this.load();
        return Object.entries(state.tasks).flatMap(([taskId, record]) => record.openGates.map((gate) => ({ taskId, gate })));
    }
    /** Resolve an id through the redirect map, following chains with a cycle guard (§4.6). */
    async resolveId(id) {
        const state = await this.load();
        let current = id;
        const seen = new Set([id]);
        while (state.redirects[current]) {
            current = state.redirects[current];
            if (seen.has(current)) {
                return { id, error: 'redirect cycle — corrupted map' };
            }
            seen.add(current);
        }
        return current === id ? { id } : { id: current, redirectedFrom: id };
    }
    /** The whole canonical map — for writing the git projection (§4.6). */
    async allRedirects() {
        return { ...(await this.load()).redirects };
    }
    async addRedirect(oldId, newId) {
        await this.serializeMutation((state) => {
            state.redirects[oldId] = newId;
        });
    }
    /** Force the summary to disk (used after batch operations and at first init). */
    async flushSummary() {
        await this.serializeMutation(() => undefined);
    }
}
exports.TaskAuthorityStore = TaskAuthorityStore;
