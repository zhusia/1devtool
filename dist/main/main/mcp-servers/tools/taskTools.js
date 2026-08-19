"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTaskTools = registerTaskTools;
const tasks_1 = require("../../../shared/tasks");
const gateRegistry_1 = require("../../tasks/gateRegistry");
const toolRegistry_1 = require("../_shared/toolRegistry");
const MAX_LIST_ROWS = 100;
const MAX_ACTIVITY_ENTRIES = 10;
function resolveCaller(deps, ctx) {
    // PROVEN identity only (§6.2). `ctx.terminalId` is advisory — it can carry a
    // caller's own claim when PID ancestry could not answer — so reading it here
    // would reintroduce exactly the impersonation this partition removes.
    const terminalId = typeof ctx.attributedTerminalId === 'string' && ctx.attributedTerminalId.trim()
        ? ctx.attributedTerminalId.trim()
        : null;
    if (terminalId) {
        const location = deps.storeManager.findTerminalLocation(terminalId);
        if (location)
            return { terminalId, project: location.project, attributed: true };
    }
    // Unattributed: read-only against the active project, and NEVER a guessed
    // queue — `tasks_next` refuses rather than answering for someone else.
    const activeId = deps.storeManager.getActiveProjectId();
    const project = deps.storeManager.getProjects().find((p) => p.id === activeId) ?? null;
    return { terminalId, project, attributed: false };
}
function parseScope(raw, caller, deps, rawWorkspaceId) {
    if (raw === 'all')
        return { kind: 'all' };
    if (raw === 'workspace') {
        // Caller membership is the gate (workspace_control 05 §7): the attributed
        // terminal's project must be in the workspace it queries; without an
        // explicit id, a unique containing workspace is inferred.
        if (!caller.project) {
            return { error: 'no project context — scope: "workspace" needs an attributed project' };
        }
        const candidates = deps.workspacesForProject?.(caller.project.id) ?? [];
        if (typeof rawWorkspaceId === 'string' && rawWorkspaceId) {
            if (!candidates.some((w) => w.id === rawWorkspaceId)) {
                return { error: 'WORKSPACE_MEMBERSHIP: the calling project is not in that workspace' };
            }
            return { kind: 'workspace', workspaceId: rawWorkspaceId };
        }
        if (candidates.length === 1)
            return { kind: 'workspace', workspaceId: candidates[0].id };
        return {
            error: candidates.length === 0
                ? 'the calling project is in no workspace — create one in 1DevTool first'
                : `the calling project is in ${candidates.length} workspaces — pass workspaceId: one of ${candidates.map((w) => `${w.id} (${w.name})`).join(', ')}`,
        };
    }
    if (raw !== undefined && raw !== 'project') {
        return { error: `scope must be 'project', 'workspace' or 'all' (got ${JSON.stringify(raw)})` };
    }
    if (!caller.project) {
        return { error: 'no project context — open a project in 1DevTool, or pass scope: "all"' };
    }
    return { kind: 'project', projectId: caller.project.id };
}
/** Index roots the query needs, once per root; the watcher keeps them fresh. */
async function ensureIndexed(deps, manager, scope) {
    const projects = deps.storeManager.getProjects();
    const workspaceMembers = scope.kind === 'workspace'
        ? new Set(deps.resolveWorkspaceProjectIds?.(scope.workspaceId) ?? [])
        : null;
    const targets = scope.kind === 'all'
        ? projects
        : scope.kind === 'workspace'
            ? projects.filter((p) => workspaceMembers.has(p.id))
            : projects.filter((p) => p.id === scope.projectId);
    for (const project of targets) {
        if (!project.rootPath)
            continue;
        try {
            await manager.ensureIndexed(project.id, project.rootPath);
        }
        catch { /* one unreadable root must not fail the whole query */ }
    }
}
function projectNameOf(deps, projectId) {
    return deps.storeManager.getProjects().find((p) => p.id === projectId)?.name ?? null;
}
/** The compact row shape. Bodies never travel in a list (§9). */
function summarizeRow(deps, row, callerTerminalId) {
    return {
        id: row.id,
        title: row.title,
        status: row.status,
        priority: row.priority,
        labels: row.labels,
        projectId: row.projectId,
        project: projectNameOf(deps, row.projectId),
        ...(row.blockedBy.length ? { blockedBy: row.blockedBy } : {}),
        ...(row.openGateKind ? { awaitingHuman: row.openGateKind } : {}),
        ...(row.holds?.length ? { holds: row.holds } : {}),
        ...(row.assignee
            ? {
                assignee: row.assignee.label,
                assignedToYou: Boolean(callerTerminalId) && row.assignee.id === callerTerminalId,
            }
            : {}),
    };
}
function parseStringArray(raw, allowed, field) {
    if (raw === undefined)
        return null;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
        if (typeof value !== 'string' || !allowed.includes(value)) {
            throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
        }
    }
    return values;
}
/**
 * Fields no write tool may set, whatever the caller sends (§6.2). Rejected
 * loudly rather than dropped quietly: an agent that thinks it just reassigned a
 * task should be told it did not.
 */
const FORBIDDEN_WRITE_FIELDS = [
    'assignee', 'assigneeId', 'gates', 'runs', 'holds', 'actor',
    'projectId', 'repoRoot', 'origin', 'mergedInto', 'createdAt', 'closedAt',
    // Workspace overlay is app-owned (workspace_control D5): only human IPC
    // sets it. Same class as assignee.
    'workspaceId',
];
function rejectAuthorityFields(args) {
    const attempted = FORBIDDEN_WRITE_FIELDS.filter((field) => field in args);
    if (attempted.length) {
        throw new Error(`these fields are app-owned and cannot be set from a tool: ${attempted.join(', ')}. ` +
            'Assignment in particular is a human action — there is no tool that performs it.');
    }
}
function registerTaskTools(bridge, deps) {
    const registry = bridge.getToolRegistry();
    const requireManager = () => {
        const manager = deps.getTasksManager();
        if (!manager)
            throw new Error('Tasks are not available in this 1DevTool session');
        return manager;
    };
    /**
     * The write precondition (§6.2). A write needs a PROVEN identity — reads
     * degrade to the active project when attribution fails, writes never do,
     * because an unattributable write cannot be honestly recorded as anyone's.
     */
    const requireWriter = (ctx) => {
        const caller = resolveCaller(deps, ctx);
        if (!caller.attributed || !caller.terminalId) {
            throw new Error('this call could not be attributed to a 1DevTool terminal, so it cannot write to the task ledger');
        }
        const terminal = deps.storeManager.findTerminalLocation(caller.terminalId)?.terminal;
        return {
            caller,
            actor: {
                kind: 'agent',
                id: caller.terminalId,
                label: terminal?.name ?? caller.terminalId,
                ...(terminal?.agentType ? { agentType: terminal.agentType } : {}),
            },
        };
    };
    /**
     * Writes are scoped to the calling terminal's project unless the project's
     * APPROVED policy opens that up, and a task assigned to someone else is
     * off-limits — an agent rewriting another agent's instructions mid-run is
     * the failure this prevents. `tasks_comment` passes `allowForeign` because
     * leaving a finding on work you do not own is the point of a shared ledger.
     */
    const assertWritable = async (manager, caller, task, options = {}) => {
        if (caller.project && task.projectId !== caller.project.id) {
            const policy = await manager.effectivePolicy(task.projectId, task.repoRoot);
            if (!policy.crossProjectWrites) {
                throw new Error(`this task belongs to another project and crossProjectWrites is off for it — comment there, do not edit`);
            }
        }
        if (!options.allowForeign && task.assignee && task.assignee.id !== caller.terminalId) {
            throw new Error(`this task is assigned to ${task.assignee.label} — you can comment on it, but not change it`);
        }
    };
    registry.register({
        name: 'tasks.next',
        profile: 'tasks',
        description: 'The next task assigned to the calling terminal. An empty queue means do not select unassigned work; it never blocks a direct user request.',
        inputSchema: (0, toolRegistry_1.objectSchema)({
            scope: { type: 'string', enum: ['project', 'workspace', 'all'], description: "Default 'project'" },
            workspaceId: { type: 'string', description: 'With scope: "workspace" — inferred when the calling project is in exactly one workspace' },
        }),
        outputKind: 'json',
        execute: async (ctx, args) => {
            const manager = requireManager();
            const caller = resolveCaller(deps, ctx);
            if (!caller.attributed || !caller.terminalId) {
                // Never guess a queue. Same rule as MCP tool badges: no identity, no
                // attribution — and here, no answer that could be mistaken for one.
                return {
                    task: null,
                    reason: 'no-terminal-attribution',
                    detail: 'This call could not be attributed to a 1DevTool terminal, so there is no "your queue" to answer for. If the user already gave you a direct request, continue it normally; do not block or ask them to redispatch solely for Tasks.',
                };
            }
            const scope = parseScope(args.scope, caller, deps, args.workspaceId);
            if ('error' in scope)
                throw new Error(scope.error);
            await ensureIndexed(deps, manager, scope);
            const { row, blockedSkipped } = await manager.next(caller.terminalId, scope);
            if (!row) {
                return {
                    task: null,
                    reason: blockedSkipped > 0 ? 'all-remaining-blocked' : 'queue-empty',
                    ...(blockedSkipped > 0 ? { blockedCount: blockedSkipped } : {}),
                    detail: 'Nothing is assigned to this terminal that is ready to start. Do not pick up unassigned board work. A direct request already given by the user remains valid and should continue.',
                };
            }
            return {
                task: summarizeRow(deps, row, caller.terminalId),
                ...(blockedSkipped > 0 ? { alsoAssignedButBlocked: blockedSkipped } : {}),
                next: 'Call tasks_get with this id for the body, acceptance criteria and plan.',
            };
        },
    });
    registry.register({
        name: 'tasks.list',
        profile: 'tasks',
        description: 'Filtered task rows (no bodies). Cheap enough to call often.',
        inputSchema: (0, toolRegistry_1.objectSchema)({
            scope: { type: 'string', enum: ['project', 'workspace', 'all'] },
            workspaceId: { type: 'string', description: 'With scope: "workspace" — inferred when the calling project is in exactly one workspace' },
            status: { type: 'array', items: { type: 'string', enum: tasks_1.TASK_STATUSES } },
            priority: { type: 'array', items: { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'] } },
            label: { type: 'string' },
            mine: { type: 'boolean', description: 'Only tasks assigned to the calling terminal' },
            blocked: { type: 'boolean' },
            limit: { type: 'number' },
        }),
        outputKind: 'json',
        execute: async (ctx, args) => {
            const manager = requireManager();
            const caller = resolveCaller(deps, ctx);
            const scope = parseScope(args.scope, caller, deps, args.workspaceId);
            if ('error' in scope)
                throw new Error(scope.error);
            await ensureIndexed(deps, manager, scope);
            if (args.mine === true && !caller.terminalId) {
                throw new Error('mine: true requires a terminal identity — this call has none');
            }
            const status = parseStringArray(args.status, tasks_1.TASK_STATUSES, 'status');
            const priority = parseStringArray(args.priority, ['p0', 'p1', 'p2', 'p3'], 'priority');
            const rows = await manager.list({
                scope,
                filters: {
                    ...(status ? { status } : {}),
                    ...(priority ? { priority } : {}),
                    ...(typeof args.label === 'string' ? { label: args.label } : {}),
                    ...(args.mine === true && caller.terminalId ? { assigneeId: caller.terminalId } : {}),
                    ...(typeof args.blocked === 'boolean' ? { blocked: args.blocked } : {}),
                },
            });
            const limit = typeof args.limit === 'number' && args.limit > 0
                ? Math.min(args.limit, MAX_LIST_ROWS)
                : MAX_LIST_ROWS;
            return {
                count: rows.length,
                truncated: rows.length > limit,
                tasks: rows.slice(0, limit).map((row) => summarizeRow(deps, row, caller.terminalId)),
            };
        },
    });
    registry.register({
        name: 'tasks.get',
        profile: 'tasks',
        description: 'Full task: body, acceptance criteria, plan, dependencies and recent activity.',
        inputSchema: (0, toolRegistry_1.objectSchema)({ id: { type: 'string' } }, ['id']),
        outputKind: 'json',
        execute: async (ctx, args) => {
            const manager = requireManager();
            const caller = resolveCaller(deps, ctx);
            if (typeof args.id !== 'string' || !args.id.trim())
                throw new Error('id is required');
            // Reads may cross projects (§6.2), so index every root before a lookup
            // that is allowed to find a task anywhere.
            await ensureIndexed(deps, manager, { kind: 'all' });
            const found = await manager.get(args.id.trim());
            if (!found)
                return { task: null, error: `no task with id ${args.id}` };
            const task = found.task;
            const rows = await manager.list({ scope: { kind: 'all' } });
            const titleOf = (id) => rows.find((r) => r.id === id)?.title ?? '(unknown)';
            const statusOf = (id) => rows.find((r) => r.id === id)?.status ?? 'unknown';
            const authority = await manager.authorityOf(task.id);
            return {
                id: task.id,
                ...(found.redirectedFrom ? { redirectedFrom: found.redirectedFrom } : {}),
                projectId: task.projectId,
                project: projectNameOf(deps, task.projectId),
                title: task.title,
                status: task.status,
                priority: task.priority,
                labels: task.labels,
                body: task.body,
                acceptanceCriteria: task.acceptanceCriteria.map((c) => ({ text: c.text, done: c.done })),
                definitionOfDone: task.definitionOfDone.map((c) => ({ text: c.text, done: c.done })),
                plan: task.plan,
                blockedBy: task.deps.blockedBy.map((id) => ({ id, title: titleOf(id), status: statusOf(id) })),
                parent: task.deps.parent ? { id: task.deps.parent, title: titleOf(task.deps.parent) } : null,
                relatesTo: task.deps.relatesTo.map((id) => ({ id, title: titleOf(id) })),
                ref: task.ref,
                assignee: task.assignee
                    ? {
                        label: task.assignee.label,
                        assignedToYou: Boolean(caller.terminalId) && task.assignee.id === caller.terminalId,
                    }
                    : null,
                ...(authority.holds.length ? { holds: authority.holds } : {}),
                ...(authority.openGates.length
                    ? {
                        awaitingHuman: authority.openGates.map((gate) => ({
                            kind: gate.kind,
                            requestedAt: gate.requestedAt,
                        })),
                    }
                    : {}),
                recentActivity: task.activity
                    .slice(-MAX_ACTIVITY_ENTRIES)
                    .map((entry) => ({ at: entry.at, by: entry.actor.label, kind: entry.kind, text: entry.text })),
                updatedAt: task.updatedAt,
                /** CAS token: pass it back as `baseHash` when you call tasks_update. */
                hash: found.hash,
            };
        },
    });
    // --- write tools (P2) ------------------------------------------------------
    registry.register({
        name: 'tasks.create',
        profile: 'tasks',
        description: 'Create a task in the calling terminal\'s project. Created UNASSIGNED — creating work is not taking it.',
        inputSchema: (0, toolRegistry_1.objectSchema)({
            title: { type: 'string' },
            body: { type: 'string' },
            priority: { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'] },
            labels: { type: 'array', items: { type: 'string' } },
            acceptanceCriteria: { type: 'array', items: { type: 'string' } },
            parent: { type: 'string' },
        }, ['title']),
        outputKind: 'json',
        mutates: true,
        execute: async (ctx, args) => {
            const manager = requireManager();
            rejectAuthorityFields(args);
            const { caller, actor } = requireWriter(ctx);
            if (!caller.project?.rootPath)
                throw new Error('no project context for this terminal');
            if (typeof args.title !== 'string' || !args.title.trim())
                throw new Error('title is required');
            const created = await manager.createWithPolicy({
                projectId: caller.project.id,
                repoRoot: caller.project.rootPath,
                title: args.title,
                ...(typeof args.body === 'string' ? { body: args.body } : {}),
                ...(typeof args.priority === 'string' ? { priority: args.priority } : {}),
                ...(Array.isArray(args.labels) ? { labels: args.labels.filter((l) => typeof l === 'string') } : {}),
                ...(Array.isArray(args.acceptanceCriteria)
                    ? { acceptanceCriteria: args.acceptanceCriteria.filter((c) => typeof c === 'string') }
                    : {}),
                ...(typeof args.parent === 'string' ? { parent: args.parent } : {}),
                origin: 'agent',
            }, actor);
            if (!created.ok)
                throw new Error('error' in created ? created.error : 'write conflict');
            return {
                id: created.row.id,
                title: created.row.title,
                status: created.row.status,
                assignee: null,
                ...(created.gateId
                    ? {
                        gateId: created.gateId,
                        awaitingHuman: 'spec',
                        detail: 'This project reviews new tasks. The task is on hold until a human approves it — poll with tasks_wait.',
                    }
                    : {}),
                note: 'Created unassigned. A human decides who works on it.',
            };
        },
    });
    registry.register({
        name: 'tasks.update',
        profile: 'tasks',
        description: 'Update a task you are assigned: status, priority, labels, body, plan, or acceptance-criteria ticks.',
        inputSchema: (0, toolRegistry_1.objectSchema)({
            id: { type: 'string' },
            baseHash: { type: 'string', description: 'The hash from tasks_get — proves you are editing what you read' },
            title: { type: 'string' },
            body: { type: 'string' },
            status: { type: 'string', enum: tasks_1.TASK_STATUSES },
            priority: { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'] },
            labels: { type: 'array', items: { type: 'string' } },
            plan: { type: 'string' },
            criteriaDone: {
                type: 'array',
                items: { type: 'number' },
                description: '1-based indexes of acceptance criteria now satisfied',
            },
        }, ['id']),
        outputKind: 'json',
        mutates: true,
        execute: async (ctx, args) => {
            const manager = requireManager();
            rejectAuthorityFields(args);
            const { caller } = requireWriter(ctx);
            if (typeof args.id !== 'string')
                throw new Error('id is required');
            const found = await manager.get(args.id);
            if (!found)
                throw new Error(`no task with id ${args.id}`);
            await assertWritable(manager, caller, found.task);
            if (args.status === 'done' || args.status === 'in_review' || args.status === 'cancelled') {
                throw new Error('terminal task states are controlled by tasks_complete and human review; record a blocker/comment instead');
            }
            const criteria = Array.isArray(args.criteriaDone)
                ? found.task.acceptanceCriteria.map((c, i) => ({
                    ...c,
                    done: c.done || args.criteriaDone.includes(i + 1),
                }))
                : undefined;
            const result = await manager.update({
                id: found.task.id,
                // A stale baseHash is a real answer, not an inconvenience: it means the
                // human edited the task while you worked. Re-read before retrying.
                baseHash: typeof args.baseHash === 'string' ? args.baseHash : found.hash,
                ...(typeof args.title === 'string' ? { title: args.title } : {}),
                ...(typeof args.body === 'string' ? { body: args.body } : {}),
                ...(typeof args.status === 'string' ? { status: args.status } : {}),
                ...(typeof args.priority === 'string' ? { priority: args.priority } : {}),
                ...(Array.isArray(args.labels) ? { labels: args.labels.filter((l) => typeof l === 'string') } : {}),
                ...(typeof args.plan === 'string' ? { plan: args.plan } : {}),
                ...(criteria ? { acceptanceCriteria: criteria } : {}),
            });
            if (!result.ok) {
                if ('conflict' in result && result.conflict) {
                    throw new Error('this task changed since you read it — call tasks_get again and re-apply your edit');
                }
                throw new Error(result.error);
            }
            return { id: result.row.id, status: result.row.status, hash: result.hash };
        },
    });
    registry.register({
        name: 'tasks.comment',
        profile: 'tasks',
        description: 'Append a note to a task\'s activity — what you tried, what failed, what you suspect. Allowed on tasks you do not own.',
        inputSchema: (0, toolRegistry_1.objectSchema)({ id: { type: 'string' }, text: { type: 'string' } }, ['id', 'text']),
        outputKind: 'json',
        mutates: true,
        execute: async (ctx, args) => {
            const manager = requireManager();
            rejectAuthorityFields(args);
            const { caller, actor } = requireWriter(ctx);
            if (typeof args.id !== 'string' || typeof args.text !== 'string' || !args.text.trim()) {
                throw new Error('id and text are required');
            }
            const found = await manager.get(args.id);
            if (!found)
                throw new Error(`no task with id ${args.id}`);
            await assertWritable(manager, caller, found.task, { allowForeign: true });
            const result = await manager.comment(found.task.id, actor, args.text);
            if (!result.ok)
                throw new Error('error' in result ? result.error : 'write conflict');
            return { id: found.task.id, recorded: true };
        },
    });
    registry.register({
        name: 'tasks.link',
        profile: 'tasks',
        description: 'Add or remove dependency edges: blockedBy, parent, relatesTo. Cycles are rejected.',
        inputSchema: (0, toolRegistry_1.objectSchema)({
            id: { type: 'string' },
            addBlockedBy: { type: 'array', items: { type: 'string' } },
            removeBlockedBy: { type: 'array', items: { type: 'string' } },
            addRelatesTo: { type: 'array', items: { type: 'string' } },
            removeRelatesTo: { type: 'array', items: { type: 'string' } },
            parent: { type: 'string' },
        }, ['id']),
        outputKind: 'json',
        mutates: true,
        execute: async (ctx, args) => {
            const manager = requireManager();
            rejectAuthorityFields(args);
            const { caller } = requireWriter(ctx);
            if (typeof args.id !== 'string')
                throw new Error('id is required');
            const found = await manager.get(args.id);
            if (!found)
                throw new Error(`no task with id ${args.id}`);
            await assertWritable(manager, caller, found.task);
            const strings = (v) => Array.isArray(v) ? v.filter((s) => typeof s === 'string') : undefined;
            const result = await manager.link({
                id: found.task.id,
                baseHash: found.hash,
                add: {
                    ...(strings(args.addBlockedBy) ? { blockedBy: strings(args.addBlockedBy) } : {}),
                    ...(strings(args.addRelatesTo) ? { relatesTo: strings(args.addRelatesTo) } : {}),
                    ...(typeof args.parent === 'string' ? { parent: args.parent } : {}),
                },
                remove: {
                    ...(strings(args.removeBlockedBy) ? { blockedBy: strings(args.removeBlockedBy) } : {}),
                    ...(strings(args.removeRelatesTo) ? { relatesTo: strings(args.removeRelatesTo) } : {}),
                },
            });
            if (!result.ok)
                throw new Error('error' in result ? result.error : 'write conflict');
            return { id: result.row.id, blockedBy: result.row.blockedBy };
        },
    });
    registry.register({
        name: 'tasks.request_approval',
        profile: 'tasks',
        description: 'Ask the human to approve a plan, answer a question, or review something. Returns a gateId immediately — then poll tasks_wait.',
        inputSchema: (0, toolRegistry_1.objectSchema)({
            id: { type: 'string' },
            kind: { type: 'string', enum: ['plan', 'question', 'done'] },
            payload: { type: 'string', description: 'The plan, the question, or what you want reviewed' },
            options: { type: 'array', items: { type: 'string' }, description: 'Optional choices for a question' },
        }, ['id', 'kind', 'payload']),
        outputKind: 'json',
        mutates: true,
        execute: async (ctx, args) => {
            const manager = requireManager();
            rejectAuthorityFields(args);
            const { caller, actor } = requireWriter(ctx);
            if (typeof args.id !== 'string' || typeof args.payload !== 'string') {
                throw new Error('id and payload are required');
            }
            if (args.kind !== 'plan' && args.kind !== 'question' && args.kind !== 'done') {
                throw new Error("kind must be 'plan', 'question' or 'done'");
            }
            const found = await manager.get(args.id);
            if (!found)
                throw new Error(`no task with id ${args.id}`);
            await assertWritable(manager, caller, found.task);
            // A plan gate is about a plan: record it on the task first, so the human
            // reviews what the file says rather than a message that scrolls away.
            if (args.kind === 'plan') {
                const updated = await manager.update({
                    id: found.task.id,
                    baseHash: found.hash,
                    plan: args.payload,
                });
                if (!updated.ok) {
                    throw new Error('error' in updated
                        ? updated.error
                        : 'the task changed while the plan was being recorded — call tasks_get and try again');
                }
            }
            const opened = await manager.requestApproval({
                taskId: found.task.id,
                kind: args.kind,
                requestedBy: actor,
                payload: args.payload,
                ...(Array.isArray(args.options)
                    ? { options: args.options.filter((o) => typeof o === 'string') }
                    : {}),
            });
            if (!opened.ok)
                throw new Error(opened.error);
            return {
                gateId: opened.gateId,
                ...(opened.existing ? { note: 'This task already had an open gate; that is the one you are waiting on.' } : {}),
                next: 'Call tasks_wait with this gateId. It returns quickly; call it again while the status is open.',
            };
        },
    });
    registry.register({
        name: 'tasks.wait',
        profile: 'tasks',
        description: 'Wait briefly for a human verdict on a gate. Returns open (call again), resolved (with the verdict and their words), stale or timeout.',
        inputSchema: (0, toolRegistry_1.objectSchema)({ gateId: { type: 'string' } }, ['gateId']),
        outputKind: 'json',
        // The only tool that blocks at all, and only for pollMaxMs — never for the
        // human's 30-minute policy, which is not a transport timeout (§5.2).
        longRunning: true,
        timeoutMs: gateRegistry_1.TASK_GATE_POLL_MAX_MS + 10_000,
        execute: async (ctx, args, signal) => {
            const manager = requireManager();
            requireWriter(ctx);
            if (typeof args.gateId !== 'string')
                throw new Error('gateId is required');
            const result = await manager.gates.wait(args.gateId, { signal });
            if (result.status === 'unknown') {
                // Answered gates stay queryable for a tail, so 'unknown' means the id
                // is wrong or the answer has aged out — not "no verdict exists".
                return {
                    status: 'unknown',
                    detail: 'No gate with that id is open or recently answered. Call tasks_get — a recorded verdict is in the task\'s activity.',
                };
            }
            return {
                status: result.status,
                ...(result.kind ? { kind: result.kind } : {}),
                ...(result.verdict ? { verdict: result.verdict } : {}),
                ...(result.response ? { response: result.response } : {}),
                ...(result.detail ? { detail: result.detail } : {}),
                ...(result.status === 'open'
                    ? { next: 'Still waiting. Call tasks_wait again with the same gateId.' }
                    : {}),
            };
        },
    });
    registry.register({
        name: 'tasks.complete',
        profile: 'tasks',
        description: 'Report a task finished. Closes it, or opens a done gate for human review — the answer tells you which.',
        inputSchema: (0, toolRegistry_1.objectSchema)({
            id: { type: 'string' },
            summary: { type: 'string', description: 'What you did, against the acceptance criteria' },
        }, ['id', 'summary']),
        outputKind: 'json',
        mutates: true,
        execute: async (ctx, args) => {
            const manager = requireManager();
            rejectAuthorityFields(args);
            const { caller, actor } = requireWriter(ctx);
            if (typeof args.id !== 'string' || typeof args.summary !== 'string' || !args.summary.trim()) {
                throw new Error('id and summary are required');
            }
            const found = await manager.get(args.id);
            if (!found)
                throw new Error(`no task with id ${args.id}`);
            await assertWritable(manager, caller, found.task);
            const result = await manager.complete({ taskId: found.task.id, actor, summary: args.summary });
            if (!result.ok)
                throw new Error(result.error);
            return result.closed
                ? { status: 'done', detail: 'Closed. This project does not review completions.' }
                : {
                    status: 'in_review',
                    gateId: result.gateId,
                    detail: 'A human reviews this before it closes. Poll tasks_wait, or stop — the verdict reaches you either way.',
                };
        },
    });
}
