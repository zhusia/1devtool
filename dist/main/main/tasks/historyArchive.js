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
exports.TaskHistoryArchive = exports.TASK_HISTORY_ARCHIVE_FILE = void 0;
exports.compactTaskHistory = compactTaskHistory;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const path = __importStar(require("node:path"));
const tasks_1 = require("../../shared/tasks");
/**
 * Append-only overflow ledger for Tasks history (§4.6).
 *
 * Working markdown records stay bounded. Before an overflowing write lands,
 * every displaced entry is appended here as JSONL; a deterministic batch id
 * makes a CAS retry idempotent in-process and lets recovery readers dedupe a
 * batch if a crash happened between the archive append and task-file rename.
 */
exports.TASK_HISTORY_ARCHIVE_FILE = 'history.archive.jsonl';
const APP_ACTOR = { kind: 'human', id: '1devtool', label: '1DevTool' };
function batchId(taskId, field, entries) {
    return (0, node_crypto_1.createHash)('sha256')
        .update(JSON.stringify({ taskId, field, entries }))
        .digest('hex')
        .slice(0, 32);
}
function archiveRecord(taskId, field, entries) {
    return {
        version: 1,
        batchId: batchId(taskId, field, entries),
        taskId,
        field,
        archivedAt: Date.now(),
        entries,
    };
}
function summary(at, text) {
    return { at, actor: APP_ACTOR, kind: 'edit', text };
}
/**
 * Pure compaction. The caller must append every returned archive record before
 * serializing `task`; otherwise it must abort the working-file write.
 */
function compactTaskHistory(input) {
    const archive = [];
    const activity = [...input.activity];
    let runs = [...input.runs];
    let gates = [...input.gates];
    if (runs.length > tasks_1.TASK_RUNS_CAP) {
        const overflow = runs.slice(0, runs.length - tasks_1.TASK_RUNS_CAP);
        archive.push(archiveRecord(input.id, 'runs', overflow));
        runs = runs.slice(-tasks_1.TASK_RUNS_CAP);
        activity.push(summary(overflow.at(-1)?.endedAt ?? overflow.at(-1)?.startedAt ?? Date.now(), `Archived ${overflow.length} older run record${overflow.length === 1 ? '' : 's'} to ${exports.TASK_HISTORY_ARCHIVE_FILE}.`));
    }
    if (gates.length > tasks_1.TASK_GATES_CAP) {
        const overflow = gates.slice(0, gates.length - tasks_1.TASK_GATES_CAP);
        archive.push(archiveRecord(input.id, 'gates', overflow));
        gates = gates.slice(-tasks_1.TASK_GATES_CAP);
        activity.push(summary(overflow.at(-1)?.resolvedAt ?? overflow.at(-1)?.requestedAt ?? Date.now(), `Archived ${overflow.length} older gate record${overflow.length === 1 ? '' : 's'} to ${exports.TASK_HISTORY_ARCHIVE_FILE}.`));
    }
    let boundedActivity = activity;
    if (activity.length > tasks_1.TASK_ACTIVITY_CAP) {
        // Reserve one working slot for the compaction marker itself.
        const overflowCount = activity.length - (tasks_1.TASK_ACTIVITY_CAP - 1);
        const overflow = activity.slice(0, overflowCount);
        archive.push(archiveRecord(input.id, 'activity', overflow));
        boundedActivity = [
            summary(overflow.at(-1)?.at ?? Date.now(), `Archived ${overflow.length} older activity entr${overflow.length === 1 ? 'y' : 'ies'} to ${exports.TASK_HISTORY_ARCHIVE_FILE}.`),
            ...activity.slice(overflowCount),
        ];
    }
    return {
        task: { ...input, activity: boundedActivity, runs, gates },
        archive,
    };
}
class TaskHistoryArchive {
    chains = new Map();
    seenByFile = new Map();
    async seen(filePath) {
        const cached = this.seenByFile.get(filePath);
        if (cached)
            return cached;
        const seen = new Set();
        try {
            const raw = await node_fs_1.promises.readFile(filePath, 'utf8');
            for (const line of raw.split(/\r?\n/)) {
                if (!line.trim())
                    continue;
                try {
                    const parsed = JSON.parse(line);
                    if (typeof parsed.batchId === 'string')
                        seen.add(parsed.batchId);
                }
                catch {
                    // A corrupt historical line remains visible to recovery tooling; it
                    // does not stop new, valid ledger entries from being appended.
                }
            }
        }
        catch {
            // Missing archive is the normal first-write case.
        }
        this.seenByFile.set(filePath, seen);
        return seen;
    }
    async append(taskDirectory, records) {
        if (records.length === 0)
            return;
        const filePath = path.join(taskDirectory, exports.TASK_HISTORY_ARCHIVE_FILE);
        const previous = this.chains.get(filePath) ?? Promise.resolve();
        const operation = previous.catch(() => { }).then(async () => {
            const seen = await this.seen(filePath);
            const fresh = records.filter((record) => !seen.has(record.batchId));
            if (fresh.length === 0)
                return;
            await node_fs_1.promises.mkdir(taskDirectory, { recursive: true });
            await node_fs_1.promises.appendFile(filePath, `${fresh.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
            for (const record of fresh)
                seen.add(record.batchId);
        });
        const tail = operation.then(() => undefined, () => undefined);
        this.chains.set(filePath, tail);
        try {
            await operation;
        }
        finally {
            if (this.chains.get(filePath) === tail)
                this.chains.delete(filePath);
        }
    }
}
exports.TaskHistoryArchive = TaskHistoryArchive;
