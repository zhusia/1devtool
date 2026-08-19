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
exports.contentHash = exports.TasksManager = void 0;
const fs_1 = require("fs");
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const tasks_1 = require("../../shared/tasks");
const taskTransition_1 = require("../../shared/taskTransition");
const gateRegistry_1 = require("./gateRegistry");
const merge_1 = require("./merge");
const authorityStore_1 = require("./authorityStore");
const frontmatter_1 = require("./frontmatter");
Object.defineProperty(exports, "contentHash", { enumerable: true, get: function () { return frontmatter_1.contentHash; } });
const ids_1 = require("./ids");
const taskIndex_1 = require("./taskIndex");
const migration_1 = require("./migration");
const watcher_1 = require("./watcher");
const writeQueue_1 = require("./writeQueue");
const historyArchive_1 = require("./historyArchive");
/**
 * Tasks v2 main-process coordinator (P0 surface). Owns the indexer, the
 * app-owned authority store, the write queue and the per-root watchers; the
 * IPC layer stays thin and adds only the renderer guards.
 *
 * Config note (§5.1): the full projectSettings trust-domain integration lands
 * with the first phase that CONSUMES a policy key (P2 identity hardening /
 * P4 gates). P0 reads and writes only display/migration keys
 * (`migratedFromV1`, `defaultSwimlane`, `labelVocabulary`) and never acts on
 * `gates` / `onTimeout` / `crossProjectWrites`, so no untrusted policy can
 * have an effect yet. Do not add a policy-key consumer without the trust
 * integration — that ordering is the §5.1 contract.
 */
/**
 * Where a verdict leaves the task (§5.1's gate table).
 *
 * `declined` is the human saying "not this, and not a revision of this" — it
 * cancels. `changes-requested` always returns the task to the agent's court,
 * which for a done gate means back to `in_progress`: the review found something
 * and the work is not finished.
 */
function nextStatusAfterGate(current, kind, verdict) {
    if (verdict === 'declined')
        return 'cancelled';
    // Silence is never consent: an unanswered gate blocks rather than proceeds.
    if (verdict === 'timeout')
        return 'blocked';
    if (kind === 'done')
        return verdict === 'approved' ? 'done' : 'in_progress';
    if (kind === 'plan')
        return verdict === 'approved' ? 'in_progress' : current;
    if (kind === 'spec')
        return verdict === 'approved' ? 'ready' : current;
    return current; // question: an answer informs the agent, it does not move the task
}
class TasksManager {
    deps;
    authority;
    historyArchive = new historyArchive_1.TaskHistoryArchive();
    queue = new writeQueue_1.TaskWriteQueue();
    indexer;
    watchers = new Map();
    /**
     * Output hashes for app writes that have entered commitWrite but have not
     * finished their authoritative reconcile. A watcher can observe our atomic
     * rename during that window; matching bytes are not an "external edit".
     * Arrays retain multiplicity when two identical queued writes overlap.
     */
    pendingWrites = new Map();
    knownRoots = new Map();
    /** repoRoot → active storage directory (tracked or stealth mode). */
    rootTaskDirs = new Map();
    gates;
    constructor(deps) {
        this.deps = deps;
        this.authority = new authorityStore_1.TaskAuthorityStore(deps.baseDir);
        this.indexer = new taskIndex_1.TaskIndexer({
            indexPath: path.join(deps.baseDir, 'tasks-index.json'),
            isWritePending: (taskId, observedHash) => {
                const appOutputs = this.pendingWrites.get(taskId);
                return Boolean(appOutputs?.length) && !appOutputs.includes(observedHash);
            },
            authorityView: () => this.authority.view(),
            tasksDirFor: (repoRoot) => this.rootTaskDirs.get(repoRoot) ?? (0, taskIndex_1.defaultTasksDir)(repoRoot),
        });
        this.gates = new gateRegistry_1.TaskGateRegistry({
            authority: this.authority,
            onResolved: (taskId, gate) => this.applyGateResolution(taskId, gate),
            ...(deps.isRunAlive ? { isRunAlive: deps.isRunAlive } : {}),
        });
    }
    static readBootSummary(baseDir) {
        return authorityStore_1.TaskAuthorityStore.readBootSummary(baseDir);
    }
    // --- config ---------------------------------------------------------------
    configPath(repoRoot) {
        return path.join(repoRoot, '.1devtool', 'tasks.config.json');
    }
    async getConfig(repoRoot) {
        try {
            const raw = JSON.parse(await fs_1.promises.readFile(this.configPath(repoRoot), 'utf8'));
            return { ...tasks_1.TASKS_CONFIG_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
        }
        catch {
            return { ...tasks_1.TASKS_CONFIG_DEFAULTS };
        }
    }
    async setConfig(repoRoot, patch, projectId) {
        const current = await this.getConfig(repoRoot);
        const merged = { ...current, ...patch };
        const file = this.configPath(repoRoot);
        const storageChanged = Boolean(projectId) && current.gitTracked !== merged.gitTracked;
        const oldDir = projectId ? this.tasksDir(projectId, repoRoot, current) : null;
        const nextDir = projectId ? this.tasksDir(projectId, repoRoot, merged) : null;
        if (storageChanged && oldDir && nextDir) {
            await this.relocateTasksDirectory(oldDir, nextDir);
        }
        await fs_1.promises.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        try {
            await fs_1.promises.writeFile(tmp, JSON.stringify(merged, null, 2), 'utf8');
            await fs_1.promises.rename(tmp, file);
        }
        catch (error) {
            if (storageChanged && oldDir && nextDir) {
                await this.relocateTasksDirectory(nextDir, oldDir).catch(() => { });
            }
            throw error;
        }
        // An app-originated write is trusted by construction — record approval at
        // the new hash, or the user's own policy edit would come straight back as
        // untrusted input and stop applying.
        if (projectId)
            await this.deps.onPolicyWritten?.(projectId, repoRoot);
        if (storageChanged && projectId && nextDir) {
            const key = `${projectId}\n${repoRoot}`;
            await this.watchers.get(key)?.close();
            this.watchers.delete(key);
            this.rootTaskDirs.set(repoRoot, nextDir);
            await this.ensureRoot(projectId, repoRoot);
        }
        return merged;
    }
    /**
     * The policy that actually applies (§5.1). Policy keys come from the file
     * only once the user has approved it at its current hash in the review
     * sheet; until then they are the safe defaults — gates plan+done ON,
     * `onTimeout: 'block'`, `crossProjectWrites: false`. Display-only keys
     * (`definitionOfDone`, vocabulary, swimlane) ride the file either way: they
     * cannot widen what an agent may do.
     *
     * Every consumer of a policy key must read THIS, never `getConfig`.
     */
    async effectivePolicy(projectId, repoRoot) {
        const onFile = await this.getConfig(repoRoot);
        const approved = this.deps.isPolicyApproved
            ? await this.deps.isPolicyApproved(projectId, repoRoot)
            : false;
        if (approved)
            return onFile;
        return {
            ...onFile,
            gates: { ...tasks_1.TASKS_CONFIG_DEFAULTS.gates },
            gateTimeoutMs: tasks_1.TASKS_CONFIG_DEFAULTS.gateTimeoutMs,
            onTimeout: tasks_1.TASKS_CONFIG_DEFAULTS.onTimeout,
            crossProjectWrites: tasks_1.TASKS_CONFIG_DEFAULTS.crossProjectWrites,
        };
    }
    // --- roots, reconcile, watching ------------------------------------------
    /**
     * Register a root (idempotent), run first-run migration behind the §10
     * guard, reconcile, and start the scoped watcher. This is the
     * `tasks:index-refresh` entry point.
     */
    async ensureRoot(projectId, repoRoot) {
        const key = `${projectId}\n${repoRoot}`;
        const first = !this.knownRoots.has(key);
        this.knownRoots.set(key, { projectId, repoRoot });
        const config = await this.getConfig(repoRoot);
        const tasksDir = this.tasksDir(projectId, repoRoot, config);
        this.rootTaskDirs.set(repoRoot, tasksDir);
        if (first) {
            const migration = await (0, migration_1.migrateRepoRoot)({ projectId, repoRoot, config, tasksDir });
            if (!migration.skipped)
                await this.setConfig(repoRoot, migration.configPatch);
        }
        await this.reconcileAndSeed(projectId, repoRoot);
        if (!this.watchers.has(key)) {
            this.watchers.set(key, (0, watcher_1.watchTasksDir)(tasksDir, () => {
                void this.reconcileAndSeed(projectId, repoRoot)
                    .then((changed) => changed && this.deps.onChanged?.([projectId]));
            }));
        }
    }
    /**
     * Index this root if it has never been seen, then rely on its watcher.
     *
     * `ensureRoot` re-reconciles on every call, which is right for an explicit
     * refresh and wrong for the MCP read path: `tasks_next` has a ≤10 ms budget
     * (§9) and a readdir+stat sweep per tool call would spend it on work the
     * running watcher already does.
     */
    async ensureIndexed(projectId, repoRoot) {
        const key = `${projectId}\n${repoRoot}`;
        if (this.knownRoots.has(key) && this.watchers.has(key))
            return;
        await this.ensureRoot(projectId, repoRoot);
    }
    async refresh(projectId, repoRoot, force = false) {
        await this.ensureRoot(projectId, repoRoot);
        // ensureRoot already reconciled; only a forced refresh needs the second,
        // fingerprint-ignoring pass.
        if (force)
            await this.reconcileAndSeed(projectId, repoRoot, force);
    }
    async dispose() {
        await Promise.all([...this.watchers.values()].map((w) => w.close()));
        this.watchers.clear();
    }
    // --- reads ----------------------------------------------------------------
    /** Map a request scope onto the index's project|all reads. Workspace scope
     *  becomes an `all` read filtered by live membership of the HOME project. */
    async rowsForScope(scope) {
        if (scope.kind !== 'workspace')
            return this.indexer.rows(scope);
        const memberIds = this.deps.resolveWorkspaceProjectIds?.(scope.workspaceId) ?? null;
        if (!memberIds)
            return [];
        const members = new Set(memberIds);
        const rows = await this.indexer.rows({ kind: 'all' });
        return rows.filter((row) => members.has(row.projectId));
    }
    async list(request) {
        let rows = await this.rowsForScope(request.scope);
        rows = rows.filter((r) => !r.mergedInto); // tombstones never reach a board (§4.6)
        const f = request.filters;
        if (f?.status?.length)
            rows = rows.filter((r) => f.status.includes(r.status));
        if (f?.priority?.length)
            rows = rows.filter((r) => f.priority.includes(r.priority));
        if (f?.label)
            rows = rows.filter((r) => r.labels.includes(f.label));
        if (f?.assigneeId)
            rows = rows.filter((r) => r.assignee?.id === f.assigneeId);
        if (f?.blocked !== undefined)
            rows = rows.filter((r) => Boolean(r.blockedBy.length) === f.blocked);
        return rows.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    async errors(projectId) {
        return this.indexer.errors(projectId);
    }
    /**
     * The next task assigned to `assigneeId` (§6.1 `tasks_next`).
     *
     * Ordering encodes the working loop: an `in_progress` task comes back FIRST,
     * because a fresh session that lost its context must resume what it was
     * already doing rather than start something new; then `ready` by priority,
     * oldest first. `backlog` is deliberately not eligible — it is unrefined —
     * and `in_review` is waiting on a human, not on the agent.
     *
     * Skipped: an unsatisfied blocker, an app-owned spec hold. An empty answer is
     * a real answer meaning STOP, never "go find something else" — nothing here
     * ever widens the query to unassigned work (§4.7).
     */
    async next(assigneeId, scope) {
        const all = await this.indexer.rows({ kind: 'all' });
        const statusById = new Map(all.map((r) => [r.id, r.status]));
        const workspaceMembers = scope.kind === 'workspace'
            ? new Set(this.deps.resolveWorkspaceProjectIds?.(scope.workspaceId) ?? [])
            : null;
        const inScope = (row) => scope.kind === 'all' ||
            (scope.kind === 'workspace' ? workspaceMembers.has(row.projectId) : row.projectId === scope.projectId);
        const mine = all.filter((r) => !r.mergedInto && r.assignee?.id === assigneeId && inScope(r));
        const eligible = [];
        let blockedSkipped = 0;
        for (const row of mine) {
            if (row.status !== 'ready' && row.status !== 'in_progress')
                continue;
            if (row.holds?.includes('spec')) {
                blockedSkipped += 1;
                continue;
            }
            const blocked = row.blockedBy.some((id) => {
                const status = statusById.get(id);
                // An unknown blocker id is treated as unsatisfied: a dependency we
                // cannot see is not a dependency we can declare met.
                return status !== 'done' && status !== 'cancelled';
            });
            if (blocked) {
                blockedSkipped += 1;
                continue;
            }
            eligible.push(row);
        }
        const priorityRank = { p0: 0, p1: 1, p2: 2, p3: 3 };
        eligible.sort((a, b) => {
            if (a.status !== b.status)
                return a.status === 'in_progress' ? -1 : 1;
            const rank = priorityRank[a.priority] - priorityRank[b.priority];
            return rank !== 0 ? rank : a.updatedAt - b.updatedAt;
        });
        return { row: eligible[0] ?? null, blockedSkipped };
    }
    async get(id) {
        const resolved = await this.authority.resolveId(id);
        if (resolved.error)
            return null;
        const hit = await this.indexer.locate(resolved.id);
        if (!hit)
            return null;
        let text;
        try {
            text = await fs_1.promises.readFile(hit.absPath, 'utf8');
        }
        catch {
            return null;
        }
        const parsed = (0, frontmatter_1.parseTask)(text, { projectId: hit.row.projectId, repoRoot: hit.row.repoRoot });
        if (!parsed.ok)
            return null;
        const task = {
            ...parsed.task,
            // The containing index row owns identity. Frontmatter is workspace-
            // writable, so its project/root fields must never steer policy reads,
            // reconciliation, notifications, or later app writes.
            id: hit.row.id,
            projectId: hit.row.projectId,
            repoRoot: hit.row.repoRoot,
        };
        // The file's `assignee:` is a projection the workspace can rewrite; the
        // app-owned record is the answer (§6.2). Overlaying here also means the
        // next app write re-projects authority back into the file, so a forged
        // line is corrected rather than argued with.
        const authority = await this.authority.get(task.id);
        const effectiveStatus = authority.status ?? task.status;
        return {
            task: {
                ...task,
                status: effectiveStatus,
                assignee: authority.assignee,
                // Run bindings are app-owned authority. Overlay them for live UI and
                // let the next app write repair a forged/stale file projection.
                runs: authority.runs.length > 0 ? authority.runs : task.runs,
            },
            hash: parsed.hash,
            ...(authority.status && authority.status !== task.status
                ? { proposedStatus: task.status }
                : {}),
            ...(resolved.redirectedFrom ? { redirectedFrom: resolved.redirectedFrom } : {}),
        };
    }
    /** App-owned authority for a task — assignment, holds, open gates (§4.1). */
    async authorityOf(taskId) {
        return this.authority.get(taskId);
    }
    /**
     * Assign a task, or clear its assignment. **Not reachable from MCP** — the
     * only callers are human-gestured (`tasks:assign`, P3) and the test/fixture
     * seeding path. There is deliberately no agent-facing verb for this (§4.7).
     */
    async setAssignee(taskId, assignee) {
        await this.authority.update(taskId, (record) => ({ ...record, assignee }));
        const hit = await this.indexer.locate(taskId);
        if (hit)
            this.deps.onChanged?.([hit.row.projectId]);
    }
    /**
     * Set the app-owned lifecycle holds (§5.1). A held task is excluded from
     * assignment and from `tasks_next` — this is the enforced half of the gate
     * story, as opposed to a `status:` line in a file, which is a proposal. The
     * flow that OPENS a spec hold is P2; the authority setter lives here because
     * the hold is authority state, not gate machinery.
     */
    async setHolds(taskId, holds) {
        await this.authority.update(taskId, (record) => ({ ...record, holds }));
        const hit = await this.indexer.locate(taskId);
        if (hit)
            this.deps.onChanged?.([hit.row.projectId]);
    }
    /**
     * Install the dispatch's plan hold before orchestration can submit the first
     * prompt. The prompt telling an agent to plan first is cooperative; this hold
     * is the task-level enforcement that prevents `tasks_complete` from racing
     * ahead before the agent opens its plan gate.
     *
     * Returns the previous state so a dispatch that fails before creating a run
     * can restore it without weakening an older hold.
     */
    async prepareDispatchPlanHold(taskId, required) {
        await this.gates.retireStaleForRedispatch(taskId);
        const remainingGate = (await this.authority.get(taskId)).openGates[0];
        if (remainingGate) {
            throw new Error(`this task already has an open ${remainingGate.kind} approval — resolve it before dispatching again`);
        }
        let previouslyHeld = false;
        await this.authority.update(taskId, (record) => {
            previouslyHeld = record.holds.includes('plan');
            const holds = required
                ? [...new Set([...record.holds, 'plan'])]
                : record.holds.filter((hold) => hold !== 'plan');
            return { ...record, holds };
        });
        return previouslyHeld;
    }
    async restoreDispatchPlanHold(taskId, previouslyHeld) {
        await this.authority.update(taskId, (record) => ({
            ...record,
            holds: previouslyHeld
                ? [...new Set([...record.holds, 'plan'])]
                : record.holds.filter((hold) => hold !== 'plan'),
        }));
    }
    /** A live approval blocks preview; a stale one is retired only by assign. */
    async dispatchGateBlock(taskId) {
        const gate = (await this.authority.get(taskId)).openGates[0];
        if (!gate)
            return null;
        const status = await this.gates.status(gate.id);
        return status.status === 'open'
            ? `this task already has an open ${gate.kind} approval — resolve it before dispatching again`
            : null;
    }
    // --- writes (all through the queue + CAS) ---------------------------------
    async create(input, actor = { kind: 'human', id: 'me', label: 'me' }) {
        const now = Date.now();
        const id = (0, ids_1.newTaskId)();
        const config = await this.getConfig(input.repoRoot);
        const task = {
            id,
            projectId: input.projectId,
            repoRoot: input.repoRoot,
            title: input.title.trim().slice(0, 200) || 'Untitled task',
            body: (0, frontmatter_1.capBody)(input.body ?? ''),
            status: 'backlog',
            priority: input.priority ?? 'p2',
            origin: input.origin,
            labels: input.labels ?? [],
            assignee: null,
            acceptanceCriteria: (input.acceptanceCriteria ?? []).map((text, i) => ({
                id: `ac${i + 1}`,
                text,
                done: false,
            })),
            definitionOfDone: config.definitionOfDone.map((text, i) => ({ id: `dod${i + 1}`, text, done: false })),
            plan: null,
            deps: { blockedBy: [], parent: input.parent ?? null, relatesTo: [] },
            ref: input.ref ?? null,
            gates: [],
            runs: [],
            activity: [
                {
                    at: now,
                    actor,
                    kind: 'created',
                    text: `created (${input.origin})`,
                },
            ],
            createdAt: now,
            updatedAt: now,
            closedAt: null,
        };
        const dir = this.tasksDir(input.projectId, input.repoRoot, config);
        this.rootTaskDirs.set(input.repoRoot, dir);
        const absPath = path.join(dir, (0, ids_1.taskFileName)(id, task.title));
        return this.commitWrite(task, absPath, null);
    }
    /**
     * Create, then apply the spec gate if policy requires one (§5.1).
     *
     * The hold is app-owned state, not a status: `backlog` never was a hold,
     * because status lives in a file a workspace writer can edit. A spec-held
     * task is excluded from `tasks_next` and from assignment until a human
     * resolves the gate.
     */
    async createWithPolicy(input, requestedBy) {
        const created = await this.create(input, requestedBy);
        if (!created.ok)
            return created;
        const policy = await this.effectivePolicy(input.projectId, input.repoRoot);
        if (!policy.gates.spec)
            return created;
        await this.addHold(created.row.id, 'spec');
        const gate = await this.requestApproval({
            taskId: created.row.id,
            kind: 'spec',
            requestedBy,
            payload: [input.title, '', input.body ?? ''].join('\n').trim(),
        });
        return gate.ok ? { ...created, gateId: gate.gateId } : created;
    }
    async update(input) {
        const existing = await this.get(input.id);
        if (!existing)
            return { ok: false, error: `task not found: ${input.id}` };
        const hit = await this.indexer.locate(existing.task.id);
        if (!hit)
            return { ok: false, error: `task file not found: ${input.id}` };
        // Allowlisted patch (§6.2): authority fields (assignee, gates, runs) and
        // identity fields (id, projectId, repoRoot, origin) are not patchable
        // here by construction — only the fields below exist.
        const effectiveTask = {
            ...existing.task,
            ...(input.title !== undefined ? { title: input.title.trim().slice(0, 200) } : {}),
            ...(input.body !== undefined ? { body: (0, frontmatter_1.capBody)(input.body) } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
            ...(input.labels !== undefined ? { labels: input.labels } : {}),
            ...(input.plan !== undefined ? { plan: input.plan } : {}),
            ...(input.acceptanceCriteria !== undefined ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
            updatedAt: Date.now(),
        };
        const fileTask = input.status === undefined && existing.proposedStatus
            ? { ...effectiveTask, status: existing.proposedStatus }
            : effectiveTask;
        return this.commitWrite(fileTask, hit.absPath, input.baseHash, effectiveTask.status);
    }
    /**
     * A card dragged across status columns (§7.2).
     *
     * The board evaluates the same policy to decide what to highlight, but that
     * copy is an affordance and this one is the check: holds and open gates are
     * app-owned authority, and a renderer that has been open for ten minutes is
     * arguing from a stale snapshot. Everything below is re-read here.
     *
     * `confirmed` only unlocks the `confirm` verdicts (an open dependency, or
     * accepting what the file has been claiming). A `refuse` stays refused and a
     * `gate` stays a gate no matter what the caller passes — otherwise the flag
     * would be a way to route around the verdict flow, which is the one thing
     * this path exists to prevent.
     */
    async moveStatus(input) {
        const existing = await this.get(input.id);
        if (!existing)
            return { ok: false, error: `task not found: ${input.id}` };
        // The board dragged this card out of a column it may no longer be in.
        if (existing.task.status !== input.expectedFrom) {
            return {
                ok: false,
                error: `This task moved to ${existing.task.status.replace('_', ' ')} while the board was open.`,
            };
        }
        const authority = await this.authority.get(existing.task.id);
        const verdict = (0, taskTransition_1.evaluateTaskDrop)({
            from: existing.task.status,
            to: input.status,
            openGateKind: authority.openGates[0]?.kind ?? null,
            holds: authority.holds,
            blockedBy: existing.task.deps.blockedBy,
            ...(existing.proposedStatus ? { proposedStatus: existing.proposedStatus } : {}),
        });
        if (verdict.kind === 'noop') {
            const hit = await this.indexer.locate(existing.task.id);
            return hit
                ? { ok: true, row: hit.row, hash: existing.hash }
                : { ok: false, error: `task file not found: ${input.id}` };
        }
        if (verdict.kind === 'refuse' || verdict.kind === 'gate') {
            return { ok: false, error: verdict.reason, verdict };
        }
        if (verdict.kind === 'confirm' && !input.confirmed) {
            return { ok: false, error: verdict.reason, verdict };
        }
        return this.update({ id: existing.task.id, baseHash: existing.hash, status: input.status });
    }
    async link(input) {
        const existing = await this.get(input.id);
        if (!existing)
            return { ok: false, error: `task not found: ${input.id}` };
        const hit = await this.indexer.locate(existing.task.id);
        if (!hit)
            return { ok: false, error: `task file not found: ${input.id}` };
        const deps = { ...existing.task.deps };
        if (input.add?.blockedBy)
            deps.blockedBy = [...new Set([...deps.blockedBy, ...input.add.blockedBy])];
        if (input.add?.relatesTo)
            deps.relatesTo = [...new Set([...deps.relatesTo, ...input.add.relatesTo])];
        if (input.add?.parent !== undefined)
            deps.parent = input.add.parent;
        if (input.remove?.blockedBy)
            deps.blockedBy = deps.blockedBy.filter((d) => !input.remove.blockedBy.includes(d));
        if (input.remove?.relatesTo)
            deps.relatesTo = deps.relatesTo.filter((d) => !input.remove.relatesTo.includes(d));
        if (await this.wouldCycle(existing.task.id, deps.blockedBy)) {
            return { ok: false, error: 'dependency cycle rejected' };
        }
        const effectiveTask = { ...existing.task, deps, updatedAt: Date.now() };
        const fileTask = existing.proposedStatus
            ? { ...effectiveTask, status: existing.proposedStatus }
            : effectiveTask;
        return this.commitWrite(fileTask, hit.absPath, input.baseHash, effectiveTask.status);
    }
    async delete(id) {
        const existing = await this.get(id);
        if (!existing)
            return { ok: false, error: `task not found: ${id}` };
        const hit = await this.indexer.locate(existing.task.id);
        if (!hit)
            return { ok: false, error: `task file not found: ${id}` };
        const outcome = await this.queue.delete(existing.task.id, hit.absPath, existing.hash);
        if (!outcome.ok)
            return outcome.conflict ? outcome : { ok: false, error: outcome.error };
        await this.authority.delete(existing.task.id);
        await this.reconcileAndSeed(hit.row.projectId, hit.row.repoRoot);
        this.deps.onChanged?.([hit.row.projectId]);
        return { ok: true, row: hit.row, hash: '' };
    }
    // --- merge (§4.6) ----------------------------------------------------------
    /**
     * Merge a set of duplicates into one survivor.
     *
     * Human-only by construction: there is no MCP tool for this (§6.1's cap is a
     * design constraint, not a target), and the IPC channel is gesture-bound. An
     * agent that spots a duplicate records it with `tasks_link`/`tasks_comment`
     * and leaves the merge to a person.
     *
     * The losers become tombstones rather than disappearing, and the redirect is
     * recorded in app-owned authority, because an agent may still be holding an
     * old id in a prompt it already sent.
     */
    async merge(input) {
        const loaded = await Promise.all(input.ids.map((id) => this.get(id)));
        const tasks = loaded.filter((found) => Boolean(found));
        if (tasks.length !== input.ids.length) {
            return { ok: false, error: 'one of those tasks could not be read' };
        }
        // Which of them have someone waiting on an approval right now.
        const openGateTaskIds = [];
        for (const { task } of tasks) {
            const record = await this.authority.get(task.id);
            if (record.openGates.length)
                openGateTaskIds.push(task.id);
        }
        const mergedBy = input.mergedBy ?? { kind: 'human', id: 'me', label: 'me' };
        const resolution = (0, merge_1.resolveMerge)({
            tasks: tasks.map((entry) => entry.task),
            survivorId: input.survivorId,
            ...(input.title ? { title: input.title } : {}),
            mergedBy,
            openGateTaskIds,
            now: Date.now(),
        });
        if ('ok' in resolution && resolution.ok === false) {
            return {
                ok: false,
                error: resolution.error,
                reason: resolution.reason,
                ...('taskIds' in resolution ? { taskIds: resolution.taskIds } : {}),
            };
        }
        const merge = resolution;
        const survivorEntry = tasks.find((entry) => entry.task.id === input.survivorId);
        const survivorHit = await this.indexer.locate(input.survivorId);
        if (!survivorHit)
            return { ok: false, error: 'the survivor task file could not be located' };
        // Cycle detection re-runs on the merged edge set: a union of two acyclic
        // graphs is not necessarily acyclic.
        if (await this.wouldCycle(merge.task.id, merge.task.deps.blockedBy)) {
            return { ok: false, error: 'merging these would create a dependency cycle' };
        }
        const written = await this.commitWrite(merge.task, survivorHit.absPath, survivorEntry.hash);
        if (!written.ok) {
            return { ok: false, error: 'error' in written ? written.error : 'the survivor write conflicted' };
        }
        const now = Date.now();
        for (const id of merge.tombstoned) {
            const entry = tasks.find((candidate) => candidate.task.id === id);
            const hit = await this.indexer.locate(id);
            if (!entry || !hit)
                continue;
            await this.commitWrite((0, merge_1.tombstoneOf)(entry.task, input.survivorId, now), hit.absPath, entry.hash, 'cancelled');
            // Authority first: the app-owned map is what makes the merge canonical,
            // and it must not depend on a file a workspace writer can edit.
            await this.authority.addRedirect(id, input.survivorId);
            // Then the git projection, for the ledger and for other tools to READ.
            // The reconcile ingests unknown projection entries as proposals, never
            // as authority — otherwise a cloned repo could fabricate a merge.
            await this.writeRedirectProjection(merge.task.repoRoot);
            this.deps.onTaskMerged?.(id, input.survivorId);
        }
        this.notifyChanged(merge.task.projectId);
        return { ok: true, survivorId: input.survivorId, tombstoned: merge.tombstoned, notes: merge.notes };
    }
    /**
     * Write `redirects.json` beside the tasks. A PROJECTION: readable by git and
     * other tools, never the authority resolution consults (§4.6).
     */
    async writeRedirectProjection(repoRoot) {
        try {
            const redirects = await this.authority.allRedirects();
            const dir = this.rootTaskDirs.get(repoRoot) ?? (0, taskIndex_1.defaultTasksDir)(repoRoot);
            await fs_1.promises.mkdir(dir, { recursive: true });
            const file = path.join(dir, 'redirects.json');
            const tmp = `${file}.${process.pid}.tmp`;
            await fs_1.promises.writeFile(tmp, JSON.stringify({ version: 1, redirects }, null, 2), 'utf8');
            await fs_1.promises.rename(tmp, file);
        }
        catch {
            // The projection is a convenience for git and other readers; failing to
            // write it must never fail a merge whose authority already landed.
        }
    }
    // --- activity, gates, completion (§5) -------------------------------------
    /**
     * Append to the activity log. The agent's channel for "I tried X, it failed
     * because Y" — and the one write allowed against a task assigned to someone
     * else, because a finding on work you do not own is exactly what a shared
     * ledger is for (§6.2).
     */
    async comment(taskId, actor, text, kind = 'comment') {
        return this.mutate(taskId, (task) => ({
            ...task,
            activity: [...task.activity, { at: Date.now(), actor, kind, text: text.slice(0, 2000) }],
            updatedAt: Date.now(),
        }));
    }
    /**
     * Open a gate and return its id IMMEDIATELY (§5.2 open→poll). The agent then
     * polls `tasks_wait`; nothing about the human's answer is attached to the
     * call that opened it.
     */
    async requestApproval(input) {
        const found = await this.get(input.taskId);
        if (!found)
            return { ok: false, error: `task not found: ${input.taskId}` };
        const policy = await this.effectivePolicy(found.task.projectId, found.task.repoRoot);
        const authority = await this.authority.get(found.task.id);
        const correlatedRunId = input.runId ?? (input.requestedBy.kind === 'agent'
            ? [...authority.runs]
                .reverse()
                .find((run) => !run.endedAt && run.terminalId === input.requestedBy.id)
                ?.runId
            : undefined);
        const opened = await this.gates.open({
            taskId: found.task.id,
            kind: input.kind,
            requestedBy: input.requestedBy,
            payload: input.payload.slice(0, 8000),
            ...(input.options?.length ? { options: input.options.slice(0, 10) } : {}),
            ...(correlatedRunId ? { runId: correlatedRunId } : {}),
            ...(input.openedBy ? { openedBy: input.openedBy } : {}),
            timeoutMs: policy.gateTimeoutMs,
            onTimeout: policy.onTimeout,
        });
        if (!opened.existing) {
            const gate = (await this.gates.find(opened.gateId))?.gate;
            if (gate)
                this.deps.onGateOpened?.(found.task.id, gate);
            // The plan gate's hold is what makes a cooperative gate enforceable at
            // the task even though it is not enforceable at the filesystem (§5.1).
            if (input.kind === 'plan')
                await this.addHold(found.task.id, 'plan');
            await this.comment(found.task.id, input.requestedBy, `requested ${input.kind} approval`, 'gate');
        }
        this.notifyChanged(found.task.projectId);
        return { ok: true, gateId: opened.gateId, existing: opened.existing };
    }
    /**
     * Mark the task complete: either close it, or open the done gate when policy
     * says a human reviews first. Refused while a plan hold stands — that is the
     * enforced half of the cooperative plan gate (§5.1).
     */
    async complete(input) {
        const found = await this.get(input.taskId);
        if (!found)
            return { ok: false, error: `task not found: ${input.taskId}` };
        const record = await this.authority.get(found.task.id);
        if (record.holds.includes('plan')) {
            return {
                ok: false,
                error: 'the plan gate for this task has not been approved — the task cannot be completed yet',
            };
        }
        if (record.holds.includes('spec')) {
            return { ok: false, error: 'this task is on a spec hold and has not been approved to start' };
        }
        const policy = await this.effectivePolicy(found.task.projectId, found.task.repoRoot);
        if (!policy.gates.done) {
            const now = Date.now();
            const completed = await this.mutate(found.task.id, (task) => ({
                ...task,
                status: 'done',
                closedAt: now,
                acceptanceCriteria: task.acceptanceCriteria.map((c) => ({ ...c, done: true })),
                activity: [...task.activity, { at: now, actor: input.actor, kind: 'status', text: `completed: ${input.summary.slice(0, 500)}` }],
                updatedAt: now,
            }));
            if (!completed.ok) {
                return { ok: false, error: 'error' in completed ? completed.error : 'write conflict while completing task' };
            }
            return { ok: true, closed: true };
        }
        const movedToReview = await this.mutate(found.task.id, (task) => ({
            ...task,
            status: 'in_review',
            acceptanceCriteria: task.acceptanceCriteria.map((c) => ({ ...c, done: true })),
            updatedAt: Date.now(),
        }));
        if (!movedToReview.ok) {
            return { ok: false, error: 'error' in movedToReview ? movedToReview.error : 'write conflict while opening review' };
        }
        // Idempotent by construction: the registry returns the already-open gate,
        // so tasks_complete and the P3 snapshot's success transition cannot open
        // two cards for the same finish, in whichever order they arrive (§5.2).
        const opened = await this.requestApproval({
            taskId: found.task.id,
            kind: 'done',
            requestedBy: input.actor,
            payload: input.summary,
            ...(input.runId ? { runId: input.runId } : {}),
            openedBy: 'normal-completion',
        });
        if (!opened.ok)
            return opened;
        return { ok: true, closed: false, gateId: opened.gateId };
    }
    // --- dispatch bindings (§4.7) ---------------------------------------------
    /**
     * Bind a run to this task. App-owned and explicit: snapshots carry no
     * `taskId`, so a run belongs to a task only because a human-gestured
     * dispatch put it here. Idempotent on runId — the outcome mapper replays.
     */
    async recordRun(taskId, run) {
        let projectedRuns = [];
        await this.authority.update(taskId, (record) => {
            projectedRuns = record.runs.some((r) => r.runId === run.runId)
                ? record.runs.map((r) => (r.runId === run.runId ? { ...r, ...run } : r))
                : [...record.runs, run];
            return { ...record, runs: projectedRuns.slice(-tasks_1.TASK_RUNS_CAP) };
        });
        // Audit projection. `commitWrite` archives any overflow before bounding
        // the markdown record; authority already landed, so a transient projection
        // conflict cannot erase the binding that controls lifecycle.
        await this.mutate(taskId, (task) => ({
            ...task,
            runs: projectedRuns,
            updatedAt: Date.now(),
        }));
    }
    /** Is this run bound to a task? The fallback policy hook's whole question. */
    async taskForRun(runId) {
        return this.authority.findTaskByRunId(runId);
    }
    /**
     * Record an authorized continuation (fallback `retry`). Continuity comes from
     * the controller's own old→new linkage, never from diffing snapshots — "the
     * unit's next run" may be unrelated work nobody bound to this task.
     */
    async recordContinuation(taskId, oldRunId, replacement) {
        let projectedRuns = [];
        await this.authority.update(taskId, (record) => {
            const previous = record.runs.find((r) => r.runId === oldRunId);
            const continuation = {
                ...replacement,
                ...(previous?.orchestrationId ? { orchestrationId: previous.orchestrationId } : {}),
                ...(previous?.memberId ? { memberId: previous.memberId } : {}),
            };
            projectedRuns = record.runs.some((r) => r.runId === continuation.runId)
                ? record.runs.map((r) => (r.runId === continuation.runId ? { ...r, ...continuation } : r))
                : [...record.runs, continuation];
            return { ...record, runs: projectedRuns.slice(-tasks_1.TASK_RUNS_CAP) };
        });
        await this.mutate(taskId, (task) => ({
            ...task,
            runs: projectedRuns,
            updatedAt: Date.now(),
        }));
    }
    /** Every task→run binding, for the outcome mapper's pass. */
    async allRunBindings() {
        return this.authority.listRuns();
    }
    /**
     * A bound run succeeded. Per §4.7 this is where the done gate opens — or the
     * task closes when the gate is off. Routed through `complete()` so there is
     * ONE done-gate opener: this and `tasks_complete` can arrive in either order,
     * and the second one gets the first one's gate rather than a second card.
     */
    async onRunSucceeded(taskId, runId, actor) {
        await this.finishRunRecord(taskId, runId, 'done');
        const found = await this.get(taskId);
        if (!found || found.task.status === 'done' || found.task.status === 'cancelled')
            return;
        // A plan hold means the agent finished a planning run, not the work.
        const authority = await this.authority.get(taskId);
        if (authority.holds.length)
            return;
        await this.complete({ taskId, actor, summary: 'the dispatched run finished successfully', runId });
    }
    /**
     * A bound run failed. `uncertain` is surfaced as needing a look, never
     * auto-closed — the one thing worse than a stuck task is a task the app
     * decided was fine.
     */
    async onRunFailed(taskId, runId, actor, state, error) {
        await this.finishRunRecord(taskId, runId, 'error');
        const now = Date.now();
        const result = await this.mutate(taskId, (task) => ({
            ...task,
            status: task.status === 'done' || task.status === 'cancelled' ? task.status : 'blocked',
            activity: [
                ...task.activity,
                {
                    at: now,
                    actor,
                    kind: 'status',
                    text: state === 'uncertain'
                        ? `run ended uncertain — needs a look${error ? `: ${error.slice(0, 300)}` : ''}`
                        : `run ${state}${error ? `: ${error.slice(0, 300)}` : ''}`,
                },
            ],
            updatedAt: now,
        }));
        if (result.ok)
            this.notifyChanged(result.row.projectId);
    }
    /**
     * A bound run was cancelled with no authorized continuation: the task goes
     * back to `ready` and the assignee is cleared, because nobody is working it.
     * A continuation (fallback retry) records its replacement first, so this only
     * fires for a genuinely abandoned run.
     */
    async onRunCancelled(taskId, runId, actor) {
        await this.finishRunRecord(taskId, runId, 'cancelled');
        const record = await this.authority.get(taskId);
        const hasLiveContinuation = record.runs.some((run) => run.runId !== runId && !run.endedAt);
        if (hasLiveContinuation)
            return;
        const now = Date.now();
        const result = await this.mutate(taskId, (task) => ({
            ...task,
            status: task.status === 'done' || task.status === 'cancelled' ? task.status : 'ready',
            activity: [
                ...task.activity,
                { at: now, actor, kind: 'status', text: 'run cancelled — back to ready, unassigned' },
            ],
            updatedAt: now,
        }));
        await this.setAssignee(taskId, null);
        if (result.ok)
            this.notifyChanged(result.row.projectId);
    }
    async finishRunRecord(taskId, runId, outcome) {
        const record = await this.authority.get(taskId);
        const run = record.runs.find((r) => r.runId === runId);
        if (!run || run.endedAt)
            return;
        await this.recordRun(taskId, { ...run, endedAt: Date.now(), outcome });
    }
    /** Flip to in_progress and log the dispatch. */
    async markDispatched(taskId, label) {
        const now = Date.now();
        const result = await this.mutate(taskId, (task) => ({
            ...task,
            status: 'in_progress',
            activity: [
                ...task.activity,
                { at: now, actor: { kind: 'human', id: 'me', label: 'me' }, kind: 'claimed', text: `dispatched to ${label}` },
            ],
            updatedAt: now,
        }));
        return result;
    }
    /** The human's answer. Renderer-only and gesture-gated at the IPC layer. */
    async resolveGate(gateId, resolution) {
        const status = await this.gates.status(gateId);
        if (status.status === 'stale') {
            return { ok: false, error: status.detail ?? 'this gate is stale and cannot be resolved' };
        }
        const resolved = await this.gates.resolve(gateId, resolution);
        return resolved ? { ok: true } : { ok: false, error: 'no open gate with that id' };
    }
    async openGates() {
        const open = await this.gates.openGates();
        return Promise.all(open.map(async (item) => {
            const status = await this.gates.status(item.gate.id);
            return status.status === 'stale'
                ? { ...item, stale: status.detail ?? 'the requesting run is no longer available' }
                : item;
        }));
    }
    /**
     * The task-side consequences of a verdict. The registry owns gate state; this
     * owns what the task does about it — status, holds, and the projection of the
     * resolved gate into the file as audit.
     */
    async applyGateResolution(taskId, gate) {
        const verdict = gate.verdict ?? 'timeout';
        const now = Date.now();
        if (gate.kind === 'spec' && verdict === 'approved')
            await this.removeHold(taskId, 'spec');
        if (gate.kind === 'plan' && verdict === 'approved')
            await this.removeHold(taskId, 'plan');
        const result = await this.mutate(taskId, (task) => {
            const status = nextStatusAfterGate(task.status, gate.kind, verdict);
            return {
                ...task,
                status,
                ...(status === 'done' ? { closedAt: now } : {}),
                gates: [...task.gates, gate],
                activity: [
                    ...task.activity,
                    {
                        at: now,
                        actor: gate.resolvedBy ?? { kind: 'human', id: 'me', label: 'me' },
                        kind: 'gate',
                        text: `${gate.kind} gate ${verdict}${gate.response ? `: ${gate.response.slice(0, 500)}` : ''}`,
                    },
                ],
                updatedAt: now,
            };
        });
        if (result.ok)
            this.notifyChanged(result.row.projectId);
        // Leg 2 of verdict delivery (§5.2): the agent's turn is usually over by
        // now, so the answer is nudged to the assigned terminal. Leg 3 — the
        // verdict sitting in the record for the next tasks_get — already happened
        // above, which is why a failed nudge loses nothing.
        this.deps.onGateResolved?.(taskId, gate);
    }
    async addHold(taskId, hold) {
        await this.authority.update(taskId, (record) => ({
            ...record,
            holds: record.holds.includes(hold) ? record.holds : [...record.holds, hold],
        }));
    }
    async removeHold(taskId, hold) {
        await this.authority.update(taskId, (record) => ({
            ...record,
            holds: record.holds.filter((item) => item !== hold),
        }));
    }
    notifyChanged(projectId) {
        this.deps.onChanged?.([projectId]);
    }
    /**
     * Read → transform → write with the hash we just read. One retry on a CAS
     * conflict, because the loser of a race against another app writer should
     * re-apply rather than surface an error the caller cannot act on; a second
     * conflict is real contention and is returned.
     */
    async mutate(taskId, apply) {
        for (let attempt = 0; attempt < 2; attempt++) {
            const found = await this.get(taskId);
            if (!found)
                return { ok: false, error: `task not found: ${taskId}` };
            const hit = await this.indexer.locate(found.task.id);
            if (!hit)
                return { ok: false, error: `task file not found: ${taskId}` };
            const effectiveTask = apply(found.task);
            const fileTask = effectiveTask.status === found.task.status && found.proposedStatus
                ? { ...effectiveTask, status: found.proposedStatus }
                : effectiveTask;
            const result = await this.commitWrite(fileTask, hit.absPath, found.hash, effectiveTask.status);
            if (result.ok || !('conflict' in result))
                return result;
        }
        return { ok: false, error: 'write conflict — the file changed underneath twice' };
    }
    /** Multi-level blocker cycle check against the index (§13). */
    async wouldCycle(fromId, blockedBy) {
        const rows = await this.indexer.rows({ kind: 'all' });
        const edges = new Map(rows.map((r) => [r.id, r.blockedBy]));
        edges.set(fromId, blockedBy);
        const visiting = new Set();
        const done = new Set();
        const visit = (node) => {
            if (done.has(node))
                return false;
            if (visiting.has(node))
                return true;
            visiting.add(node);
            for (const dep of edges.get(node) ?? [])
                if (visit(dep))
                    return true;
            visiting.delete(node);
            done.add(node);
            return false;
        };
        return visit(fromId);
    }
    async commitWrite(task, absPath, baseHash, effectiveStatus = task.status) {
        let pendingHash = null;
        try {
            const compacted = (0, historyArchive_1.compactTaskHistory)(task);
            // Archive first. A later CAS conflict may cause a retry, but deterministic
            // batch ids make that append idempotent; the inverse ordering could lose
            // history permanently if the process died after the bounded file write.
            await this.historyArchive.append(path.dirname(absPath), compacted.archive);
            const taskToWrite = compacted.task;
            const serialized = (0, frontmatter_1.serializeTask)(taskToWrite);
            pendingHash = (0, frontmatter_1.contentHash)(serialized);
            this.pendingWrites.set(task.id, [...(this.pendingWrites.get(task.id) ?? []), pendingHash]);
            const outcome = await this.queue.write(task.id, absPath, serialized, baseHash);
            if (!outcome.ok)
                return outcome.conflict ? outcome : { ok: false, error: outcome.error };
            await this.authority.update(taskToWrite.id, (record) => ({ ...record, status: effectiveStatus }));
            await this.reconcileAndSeed(taskToWrite.projectId, taskToWrite.repoRoot);
            this.deps.onChanged?.([taskToWrite.projectId]);
            const row = (await this.indexer.rows({ kind: 'project', projectId: taskToWrite.projectId })).find((r) => r.id === taskToWrite.id);
            if (!row)
                return { ok: false, error: 'write landed but the row did not — check index errors' };
            return { ok: true, row, hash: outcome.hash };
        }
        finally {
            if (pendingHash) {
                const appOutputs = this.pendingWrites.get(task.id) ?? [];
                const index = appOutputs.indexOf(pendingHash);
                if (index >= 0)
                    appOutputs.splice(index, 1);
                if (appOutputs.length)
                    this.pendingWrites.set(task.id, appOutputs);
                else
                    this.pendingWrites.delete(task.id);
            }
        }
    }
    /**
     * Reconcile file content, then establish authority only for task ids this app
     * has never observed. Later file status edits remain visible as proposals.
     */
    async reconcileAndSeed(projectId, repoRoot, force = false) {
        const tasksDir = this.rootTaskDirs.get(repoRoot) ?? (0, taskIndex_1.defaultTasksDir)(repoRoot);
        const changed = await this.indexer.reconcileRoot({ projectId, repoRoot, tasksDir }, { force });
        // A task id is first observed exactly when the reconcile reports a change,
        // so an unchanged pass has nothing to seed.
        if (changed) {
            await this.authority.seedStatuses(await this.indexer.fileStatuses(projectId, repoRoot));
        }
        return changed;
    }
    tasksDir(projectId, repoRoot, config) {
        if (config.gitTracked)
            return (0, taskIndex_1.defaultTasksDir)(repoRoot);
        const root = this.deps.untrackedTasksRoot
            ?? path.join(os.homedir(), '.1devtool', 'tasks');
        return path.join(root, encodeURIComponent(projectId));
    }
    /**
     * Move exactly one known task directory. A non-empty destination is refused
     * so switching storage modes can never merge two ledgers silently.
     */
    async relocateTasksDirectory(from, to) {
        if (from === to)
            return;
        let sourceExists = true;
        try {
            await fs_1.promises.access(from);
        }
        catch {
            sourceExists = false;
        }
        if (!sourceExists)
            return;
        try {
            const destinationEntries = await fs_1.promises.readdir(to);
            if (destinationEntries.length) {
                throw new Error(`cannot relocate Tasks: destination is not empty (${to})`);
            }
            await fs_1.promises.rmdir(to);
        }
        catch (error) {
            if (error instanceof Error
                && !('code' in error && error.code === 'ENOENT')) {
                throw error;
            }
        }
        await fs_1.promises.mkdir(path.dirname(to), { recursive: true });
        try {
            await fs_1.promises.rename(from, to);
        }
        catch (error) {
            if (!(error instanceof Error)
                || !('code' in error)
                || error.code !== 'EXDEV') {
                throw error;
            }
            await fs_1.promises.cp(from, to, { recursive: true, errorOnExist: true, force: false });
            await fs_1.promises.rm(from, { recursive: true });
        }
    }
}
exports.TasksManager = TasksManager;
