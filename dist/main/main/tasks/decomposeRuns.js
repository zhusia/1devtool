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
exports.DecomposeRunManager = void 0;
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path = __importStar(require("path"));
const tasks_1 = require("../../shared/tasks");
const decomposeLogStream_1 = require("./decomposeLogStream");
/**
 * Main-process owner for goal-decomposition runs.
 *
 * The renderer is an observer. Closing/remounting its dialog must not cancel a
 * terminal turn, discard the proposal, or create a second run while the first one is
 * still alive. Completed records are persisted in app data so their logs stay
 * inspectable after a relaunch; a persisted `running` record is served as
 * `interrupted`, because no borrowed claim survives app teardown under this owner.
 */
const STORE_VERSION = 1;
const MAX_RUNS = 20;
const MAX_LOG_EVENTS = 1_000;
const MAX_RETAINED_LOG_CHARS = 220_000;
const SAVE_DEBOUNCE_MS = 350;
const RAW_REPLY_MAX_CHARS = 4_000;
function cloneRun(run) {
    // Every field is JSON-shaped by contract. Cloning prevents a renderer/test
    // consumer from mutating the main-owned authoritative record by reference.
    return JSON.parse(JSON.stringify(run));
}
function sanitizeTask(value) {
    if (!value || typeof value !== 'object')
        return null;
    const task = value;
    if (typeof task.title !== 'string' || !task.title.trim())
        return null;
    const strings = (items) => Array.isArray(items) ? items.filter((item) => typeof item === 'string') : undefined;
    return {
        title: task.title.slice(0, 200),
        ...(typeof task.body === 'string' ? { body: task.body } : {}),
        ...(['p0', 'p1', 'p2', 'p3'].includes(task.priority ?? '')
            ? { priority: task.priority }
            : {}),
        ...(strings(task.acceptanceCriteria)
            ? { acceptanceCriteria: strings(task.acceptanceCriteria) }
            : {}),
        ...(strings(task.labels) ? { labels: strings(task.labels) } : {}),
        ...(Array.isArray(task.blockedByIndexes)
            ? {
                blockedByIndexes: task.blockedByIndexes
                    .filter((item) => typeof item === 'number' && Number.isFinite(item) && item > 0),
            }
            : {}),
    };
}
function sanitizeResult(value) {
    if (!value || typeof value !== 'object')
        return undefined;
    const result = value;
    if (typeof result.ok !== 'boolean' || !Array.isArray(result.tasks))
        return undefined;
    return {
        ok: result.ok,
        tasks: result.tasks.map(sanitizeTask).filter((task) => Boolean(task)),
        ...(typeof result.error === 'string' ? { error: result.error.slice(0, 2_000) } : {}),
        ...(typeof result.raw === 'string' ? { raw: result.raw.slice(0, RAW_REPLY_MAX_CHARS) } : {}),
    };
}
function capLogs(events) {
    const sanitized = events
        .filter((event) => Boolean(event)
        && (event.stream === 'stdout' || event.stream === 'stderr' || event.stream === 'note')
        && typeof event.text === 'string')
        .map((event) => ({ stream: event.stream, text: event.text.slice(0, 8_001) }))
        .slice(-MAX_LOG_EVENTS);
    let chars = sanitized.reduce((total, event) => total + event.text.length, 0);
    let removed = false;
    while (sanitized.length > 1 && chars > MAX_RETAINED_LOG_CHARS) {
        const [first] = sanitized.splice(0, 1);
        chars -= first.text.length;
        removed = true;
    }
    if (removed && sanitized[0]?.text !== '… earlier stored output was pruned') {
        sanitized.unshift({ stream: 'note', text: '… earlier stored output was pruned' });
    }
    return sanitized;
}
function restoreRun(value) {
    if (!value || typeof value !== 'object')
        return null;
    const run = value;
    const statuses = ['running', 'done', 'error', 'interrupted'];
    if (typeof run.id !== 'string'
        || !run.id
        || typeof run.projectId !== 'string'
        || !run.projectId
        || typeof run.repoRoot !== 'string'
        || typeof run.goal !== 'string'
        || !(0, tasks_1.isTaskDecomposeTarget)(run.target)
        || !statuses.includes(run.status)
        || typeof run.startedAt !== 'number'
        || !Number.isFinite(run.startedAt)) {
        return null;
    }
    const updatedAt = typeof run.updatedAt === 'number' && Number.isFinite(run.updatedAt)
        ? run.updatedAt
        : run.startedAt;
    const revision = typeof run.revision === 'number' && Number.isFinite(run.revision)
        ? Math.max(1, Math.floor(run.revision))
        : 1;
    const result = sanitizeResult(run.result);
    return {
        id: run.id,
        projectId: run.projectId,
        repoRoot: run.repoRoot,
        goal: run.goal,
        target: run.target,
        status: run.status,
        startedAt: run.startedAt,
        updatedAt,
        ...(typeof run.endedAt === 'number' && Number.isFinite(run.endedAt)
            ? { endedAt: run.endedAt }
            : {}),
        ...(typeof run.acceptedAt === 'number' && Number.isFinite(run.acceptedAt)
            ? { acceptedAt: run.acceptedAt }
            : {}),
        revision,
        logs: capLogs(Array.isArray(run.logs) ? run.logs : []),
        ...(result ? { result } : {}),
    };
}
class DecomposeRunManager {
    deps;
    runs = new Map();
    controllers = new Map();
    streams = new Map();
    now;
    createId;
    loadPromise = null;
    saveTimer = null;
    saveChain = Promise.resolve();
    saveSequence = 0;
    disposed = false;
    constructor(deps) {
        this.deps = deps;
        this.now = deps.now ?? Date.now;
        this.createId = deps.createId ?? crypto_1.randomUUID;
    }
    async start(input) {
        await this.ensureLoaded();
        if (this.disposed)
            return { ok: false, error: 'decomposition service is shutting down' };
        const goal = input.goal.trim();
        if (!goal)
            return { ok: false, error: 'describe what you want built' };
        if (!input.projectId || !input.repoRoot || !(0, tasks_1.isTaskDecomposeTarget)(input.target)) {
            return { ok: false, error: 'invalid decomposition target' };
        }
        const existing = this.latestRunning(input.projectId);
        if (existing) {
            return { ok: true, started: false, run: cloneRun(existing) };
        }
        const now = this.now();
        const run = {
            id: this.createId(),
            projectId: input.projectId,
            repoRoot: input.repoRoot,
            goal,
            target: input.target,
            status: 'running',
            startedAt: now,
            updatedAt: now,
            revision: 1,
            logs: [],
        };
        this.runs.set(run.id, run);
        this.prune();
        const controller = new AbortController();
        this.controllers.set(run.id, controller);
        this.changed(run);
        this.scheduleSave();
        this.execute(run.id, controller);
        return { ok: true, started: true, run: cloneRun(run) };
    }
    async get(runId) {
        await this.ensureLoaded();
        const run = this.runs.get(runId);
        return run ? cloneRun(run) : null;
    }
    async list(projectId, limit = 10) {
        await this.ensureLoaded();
        const bounded = Math.min(Math.max(Math.floor(limit), 1), MAX_RUNS);
        return [...this.runs.values()]
            .filter((run) => run.projectId === projectId)
            .sort((a, b) => b.startedAt - a.startedAt)
            .slice(0, bounded)
            .map(cloneRun);
    }
    async markAccepted(runId) {
        await this.ensureLoaded();
        const run = this.runs.get(runId);
        if (!run || run.status !== 'done' || !run.result?.ok)
            return null;
        if (!run.acceptedAt) {
            run.acceptedAt = this.now();
            this.touch(run);
            this.changed(run);
            await this.persistNow();
        }
        return cloneRun(run);
    }
    async dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        // Abort before the first await. Electron does not wait for an async
        // `will-quit` listener, so deferring this until after state hydration could
        // leave a borrowed terminal claimed after its owner disappeared.
        for (const controller of this.controllers.values())
            controller.abort();
        for (const stream of this.streams.values())
            stream.close();
        this.controllers.clear();
        this.streams.clear();
        await this.ensureLoaded();
        const now = this.now();
        for (const run of this.runs.values()) {
            if (run.status !== 'running')
                continue;
            run.status = 'interrupted';
            run.endedAt = now;
            run.result = {
                ok: false,
                tasks: [],
                error: 'the app closed before the decomposition finished',
            };
            run.logs = capLogs([
                ...run.logs,
                { stream: 'note', text: 'app closed; decomposition interrupted' },
            ]);
            this.touch(run, now);
            this.changed(run);
        }
        await this.persistNow();
    }
    latestRunning(projectId) {
        return [...this.runs.values()]
            .filter((run) => run.projectId === projectId && run.status === 'running')
            .sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
    }
    execute(runId, controller) {
        const run = this.runs.get(runId);
        if (!run)
            return;
        const stream = (0, decomposeLogStream_1.createDecomposeLogStream)((events) => this.appendLogs(runId, events));
        this.streams.set(runId, stream);
        void this.deps.execute({
            projectId: run.projectId,
            goal: run.goal,
            target: run.target,
            signal: controller.signal,
            onLog: stream.push,
        }).then((result) => {
            const current = this.runs.get(runId);
            if (this.disposed || !current || current.status !== 'running')
                return;
            stream.push({
                stream: 'note',
                text: result.ok
                    ? `proposal ready · ${result.tasks.length} task${result.tasks.length === 1 ? '' : 's'}`
                    : (result.error ?? 'decomposition failed'),
            });
            stream.close();
            current.result = sanitizeResult(result) ?? {
                ok: false,
                tasks: [],
                error: 'decomposition returned an invalid result',
            };
            current.status = result.ok ? 'done' : 'error';
            current.endedAt = this.now();
            this.touch(current);
            this.changed(current);
            void this.persistNow();
        }, (error) => {
            const current = this.runs.get(runId);
            if (this.disposed || !current || current.status !== 'running')
                return;
            const message = error instanceof Error ? error.message : 'decomposition failed';
            stream.push({ stream: 'note', text: message });
            stream.close();
            current.result = { ok: false, tasks: [], error: message };
            current.status = 'error';
            current.endedAt = this.now();
            this.touch(current);
            this.changed(current);
            void this.persistNow();
        }).finally(() => {
            this.controllers.delete(runId);
            this.streams.delete(runId);
        });
    }
    appendLogs(runId, events) {
        const run = this.runs.get(runId);
        if (!run || run.status !== 'running' || events.length === 0)
            return;
        run.logs = capLogs([...run.logs, ...events]);
        this.touch(run);
        this.changed(run);
        this.scheduleSave();
    }
    touch(run, at = this.now()) {
        run.updatedAt = at;
        run.revision += 1;
    }
    changed(run) {
        try {
            this.deps.onChanged?.({
                runId: run.id,
                projectId: run.projectId,
                revision: run.revision,
            });
        }
        catch {
            // Renderer notification is a wake hint. The snapshot remains readable.
        }
    }
    async ensureLoaded() {
        if (!this.loadPromise)
            this.loadPromise = this.load();
        await this.loadPromise;
    }
    async load() {
        let parsed = null;
        try {
            const raw = JSON.parse(await fs_1.promises.readFile(this.deps.storePath, 'utf8'));
            if (raw.version === STORE_VERSION && Array.isArray(raw.runs)) {
                parsed = { version: STORE_VERSION, runs: raw.runs };
            }
        }
        catch {
            // Missing/corrupt state is a cold store, never an app-start failure.
        }
        for (const raw of parsed?.runs ?? []) {
            const run = restoreRun(raw);
            if (run)
                this.runs.set(run.id, run);
        }
        this.prune();
        let repaired = false;
        const now = this.now();
        for (const run of this.runs.values()) {
            if (run.status !== 'running')
                continue;
            repaired = true;
            run.status = 'interrupted';
            run.endedAt = now;
            run.result = {
                ok: false,
                tasks: [],
                error: 'the app closed before the decomposition finished',
            };
            run.logs = capLogs([
                ...run.logs,
                { stream: 'note', text: 'previous app session ended before this run finished' },
            ]);
            this.touch(run, now);
        }
        if (repaired)
            await this.enqueueSave();
    }
    prune() {
        const kept = [...this.runs.values()]
            .sort((a, b) => b.startedAt - a.startedAt)
            .slice(0, MAX_RUNS);
        const keepIds = new Set(kept.map((run) => run.id));
        for (const id of this.runs.keys()) {
            if (!keepIds.has(id))
                this.runs.delete(id);
        }
    }
    scheduleSave() {
        if (this.saveTimer || this.disposed)
            return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void this.enqueueSave();
        }, SAVE_DEBOUNCE_MS);
        this.saveTimer.unref?.();
    }
    async persistNow() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        await this.enqueueSave();
    }
    enqueueSave() {
        this.prune();
        const payload = {
            version: STORE_VERSION,
            runs: [...this.runs.values()]
                .sort((a, b) => b.startedAt - a.startedAt)
                .map(cloneRun),
        };
        const serialized = JSON.stringify(payload);
        const sequence = ++this.saveSequence;
        this.saveChain = this.saveChain
            .catch(() => { })
            .then(async () => {
            const target = this.deps.storePath;
            const tmp = `${target}.${process.pid}.${sequence}.tmp`;
            await fs_1.promises.mkdir(path.dirname(target), { recursive: true });
            try {
                await fs_1.promises.writeFile(tmp, serialized, { encoding: 'utf8', mode: 0o600 });
                await fs_1.promises.rename(tmp, target);
            }
            catch (error) {
                await fs_1.promises.rm(tmp, { force: true }).catch(() => { });
                throw error;
            }
        })
            // Persistence is diagnostic/history durability, never permission to kill
            // a live run. A later save retries from the current authoritative state.
            .catch(() => { });
        return this.saveChain;
    }
}
exports.DecomposeRunManager = DecomposeRunManager;
