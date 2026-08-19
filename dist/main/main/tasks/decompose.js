"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPrompt = buildPrompt;
exports.parseProposal = parseProposal;
exports.decomposeGoal = decomposeGoal;
const MAX_PROPOSED = 20;
function buildPrompt(goal) {
    return [
        'You are helping plan work in a software repository. Break the goal below into a small set of',
        'independent, individually assignable tasks. Prefer FEWER, larger tasks over many trivial ones;',
        'a task should be a meaningful unit a single agent can finish and a human can review.',
        '',
        'Reply with ONLY a JSON array, no prose and no code fence. Each element:',
        '{"title": string, "body": string, "priority": "p0"|"p1"|"p2"|"p3",',
        ' "acceptanceCriteria": string[], "labels": string[], "blockedByIndexes": number[]}',
        '',
        '- title: one imperative line.',
        '- body: what to do and why, in markdown.',
        '- acceptanceCriteria: what must be TRUE for this to be done. Specific and checkable.',
        '- blockedByIndexes: 1-based positions in this array that must land first. Usually empty.',
        // An interactive agent very likely has Tasks tools and would otherwise
        // create the work while being asked merely to propose it.
        '',
        'This is a PROPOSAL only. Do not create tasks, do not call any task tool, and do not write',
        'or edit any file. Read whatever you need to, then answer with the JSON array and nothing',
        'else — a human reviews it and decides what gets created.',
        '',
        'The goal:',
        goal,
    ].join('\n');
}
/**
 * Pull the JSON array out of an agent's reply. Agents wrap JSON in prose and
 * fences no matter how firmly the prompt asks them not to, so the parser is
 * tolerant by design — and returns a visible error rather than a silent empty
 * set when it truly cannot find one.
 */
function parseProposal(output) {
    const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced?.[1] ?? output;
    const start = candidate.indexOf('[');
    const end = candidate.lastIndexOf(']');
    if (start === -1 || end <= start) {
        return { ok: false, tasks: [], error: 'the agent did not return a task list', raw: output.slice(0, 4000) };
    }
    let parsed;
    try {
        parsed = JSON.parse(candidate.slice(start, end + 1));
    }
    catch {
        return { ok: false, tasks: [], error: 'the agent\'s task list was not valid JSON', raw: output.slice(0, 4000) };
    }
    if (!Array.isArray(parsed)) {
        return { ok: false, tasks: [], error: 'the agent returned something that was not a list', raw: output.slice(0, 4000) };
    }
    const asStrings = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
    const tasks = parsed
        .filter((item) => Boolean(item) && typeof item === 'object')
        .map((item) => ({
        title: typeof item.title === 'string' ? item.title.trim().slice(0, 200) : '',
        ...(typeof item.body === 'string' ? { body: item.body } : {}),
        ...(['p0', 'p1', 'p2', 'p3'].includes(item.priority)
            ? { priority: item.priority }
            : {}),
        acceptanceCriteria: asStrings(item.acceptanceCriteria),
        labels: asStrings(item.labels),
        blockedByIndexes: Array.isArray(item.blockedByIndexes)
            ? item.blockedByIndexes.filter((n) => typeof n === 'number' && n > 0)
            : [],
    }))
        .filter((task) => task.title.length > 0)
        .slice(0, MAX_PROPOSED);
    return tasks.length
        ? { ok: true, tasks, raw: output.slice(0, 4000) }
        : { ok: false, tasks: [], error: 'the agent proposed no tasks', raw: output.slice(0, 4000) };
}
async function decomposeGoal(deps, input) {
    const goal = input.goal.trim();
    if (!goal)
        return { ok: false, tasks: [], error: 'describe what you want built' };
    input.onLog?.({
        stream: 'note',
        text: `live terminal ${input.target.terminalId} · output stays in the terminal`,
    });
    return decomposeInTerminal(deps, input.target, goal, input.timeoutSeconds, input.signal);
}
/**
 * The live-terminal path. Whatever the terminal refuses — gone, busy, claimed,
 * not an AI terminal — surfaces as that refusal's own words, because "the agent
 * did not return a task list" would be a lie about a run that never started.
 */
async function decomposeInTerminal(deps, target, goal, timeoutSeconds, signal) {
    if (!deps.runInTerminal) {
        return { ok: false, tasks: [], error: 'the orchestration control plane is unavailable' };
    }
    try {
        const result = await deps.runInTerminal({
            terminalId: target.terminalId,
            prompt: buildPrompt(goal),
            ...(timeoutSeconds ? { timeoutSeconds } : {}),
            ...(signal ? { signal } : {}),
        });
        if (!result.ok || !result.output?.trim()) {
            return { ok: false, tasks: [], error: result.error || 'that terminal produced no reply' };
        }
        return parseProposal(result.output);
    }
    catch (error) {
        return { ok: false, tasks: [], error: error instanceof Error ? error.message : 'decomposition failed' };
    }
}
