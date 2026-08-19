"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultSurvivor = defaultSurvivor;
exports.resolveMerge = resolveMerge;
exports.tombstoneOf = tombstoneOf;
const tasks_1 = require("../../shared/tasks");
const normalizeCriterion = (text) => text.trim().toLowerCase().replace(/[.!?;:,]+$/, '');
/** Union of checklists, de-duplicated on normalized text, tick state OR'd. */
function unionCriteria(lists) {
    const byText = new Map();
    for (const list of lists) {
        for (const item of list) {
            const key = normalizeCriterion(item.text);
            const existing = byText.get(key);
            if (existing) {
                if (item.done)
                    existing.done = true;
                continue;
            }
            byText.set(key, { ...item });
        }
    }
    return [...byText.values()].map((item, index) => ({ ...item, id: `ac${index + 1}` }));
}
const PRIORITY_RANK = { p0: 0, p1: 1, p2: 2, p3: 3 };
/**
 * Pick the survivor: the claimed one, else the oldest. Always overridable in
 * the dialog — this is only the default.
 */
function defaultSurvivor(tasks) {
    if (!tasks.length)
        return null;
    const claimed = tasks.filter((task) => task.assignee);
    const pool = claimed.length ? claimed : [...tasks];
    return [...pool].sort((a, b) => a.createdAt - b.createdAt)[0] ?? null;
}
function resolveMerge(input) {
    const { tasks, survivorId, now } = input;
    if (tasks.length < 2) {
        return { ok: false, reason: 'too-few', error: 'select at least two tasks to merge' };
    }
    // Tasks are files under a repoRoot; merging across projects would move a git
    // artifact between repos. Link them with relatesTo instead.
    const projects = new Set(tasks.map((task) => task.projectId));
    const roots = new Set(tasks.map((task) => task.repoRoot));
    if (projects.size > 1 || roots.size > 1) {
        return {
            ok: false,
            reason: 'cross-project',
            error: 'these tasks live in different projects — link them with relatesTo instead of merging',
        };
    }
    // A live blocking tool call re-pointed at a different task id is a class of
    // bug not worth inviting. Refusing is honest and the fix is one click.
    const gated = tasks.filter((task) => input.openGateTaskIds?.includes(task.id)).map((task) => task.id);
    if (gated.length) {
        return {
            ok: false,
            reason: 'open-gate',
            error: 'resolve the open approval on these first — a merge cannot re-point a gate someone is waiting on',
            taskIds: gated,
        };
    }
    const survivor = tasks.find((task) => task.id === survivorId);
    if (!survivor) {
        return { ok: false, reason: 'unknown-survivor', error: 'the chosen survivor is not in the set' };
    }
    const losers = tasks.filter((task) => task.id !== survivorId);
    const mergedIds = new Set(losers.map((task) => task.id));
    const notes = [];
    // Body: survivor's, then every merged body under its own heading. A merge
    // that drops the sentence explaining the bug is worse than two tasks.
    const bodyParts = [survivor.body.trim()];
    for (const loser of losers) {
        const section = [`## Merged from ${loser.id}`, ''];
        if (loser.title !== survivor.title)
            section.push(`**${loser.title}**`, '');
        if (loser.body.trim())
            section.push(loser.body.trim(), '');
        if (loser.ref)
            section.push(`_Captured from ${loser.ref.kind}: ${loser.ref.label}_`, '');
        bodyParts.push(section.join('\n').trimEnd());
    }
    const priority = tasks
        .map((task) => task.priority)
        .sort((a, b) => PRIORITY_RANK[a] - PRIORITY_RANK[b])[0];
    if (priority !== survivor.priority) {
        notes.push(`priority becomes ${priority} — the highest in the set, never the survivor's alone`);
    }
    const assignee = survivor.assignee
        ?? losers.find((task) => task.assignee)?.assignee
        ?? null;
    if (!survivor.assignee && assignee) {
        notes.push(`assignee carries over from a merged task (${assignee.label})`);
    }
    // Edges pointing INTO the merge set would become self-edges. Drop them.
    const dedupeEdges = (edges) => [...new Set(edges)].filter((id) => id !== survivorId && !mergedIds.has(id));
    const blockedBy = dedupeEdges(tasks.flatMap((task) => task.deps.blockedBy));
    const relatesTo = dedupeEdges(tasks.flatMap((task) => task.deps.relatesTo));
    const parents = new Set(tasks.map((task) => task.deps.parent).filter(Boolean));
    const parent = survivor.deps.parent ?? (parents.size === 1 ? [...parents][0] : null);
    const criteria = unionCriteria(tasks.map((task) => task.acceptanceCriteria));
    const revived = criteria.filter((item) => item.done).length -
        survivor.acceptanceCriteria.filter((item) => item.done).length;
    if (revived > 0)
        notes.push(`${revived} acceptance criterion/criteria stay ticked from a merged task`);
    // Provenance: runs are the record of what actually ran and must survive.
    const runs = [...tasks.flatMap((task) => task.runs)]
        .sort((a, b) => a.startedAt - b.startedAt)
        .slice(-tasks_1.TASK_RUNS_CAP);
    const activity = [
        ...survivor.activity,
        ...losers.flatMap((loser) => loser.activity.map((entry) => ({ ...entry, text: `${entry.text} (from ${loser.id})` }))),
        {
            at: now,
            actor: input.mergedBy,
            kind: 'edit',
            text: `merged ${losers.map((task) => task.id).join(', ')} into this task`,
        },
    ]
        .sort((a, b) => a.at - b.at)
        .slice(-tasks_1.TASK_ACTIVITY_CAP);
    return {
        task: {
            ...survivor,
            title: (input.title ?? survivor.title).trim().slice(0, 200) || survivor.title,
            body: bodyParts.filter(Boolean).join('\n\n'),
            priority,
            assignee,
            labels: [...new Set(tasks.flatMap((task) => task.labels))],
            acceptanceCriteria: criteria,
            // Snapshotted from project policy at create time — a union would widen it.
            definitionOfDone: survivor.definitionOfDone,
            deps: { blockedBy, parent, relatesTo },
            runs,
            activity,
            updatedAt: now,
        },
        tombstoned: losers.map((task) => task.id),
        notes,
    };
}
/**
 * The frontmatter-only file a merged-away task leaves behind.
 *
 * This is correctness, not tidiness: an agent may be holding the old id in a
 * prompt it already sent, a plan it wrote, or a message to another terminal.
 * `tasks_get(<old id>)` must resolve to the survivor rather than 404 and send
 * that agent down a "the task disappeared" path.
 */
function tombstoneOf(task, survivorId, now) {
    return {
        ...task,
        status: 'cancelled',
        body: '',
        acceptanceCriteria: [],
        definitionOfDone: [],
        plan: null,
        deps: { blockedBy: [], parent: null, relatesTo: [] },
        gates: [],
        runs: [],
        activity: [],
        mergedInto: survivorId,
        closedAt: now,
        updatedAt: now,
    };
}
