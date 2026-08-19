"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTaskPrompt = buildTaskPrompt;
function section(title, body) {
    const text = (body ?? '').trim();
    return text ? [`## ${title}`, '', text, ''] : [];
}
function buildTaskPrompt(input) {
    const { task, gates } = input;
    const lines = [
        `You have been assigned 1DevTool task ${task.id}.`,
        '',
        `# ${task.title}`,
        '',
    ];
    lines.push(...section('Task', task.body));
    if (task.acceptanceCriteria.length) {
        lines.push('## Acceptance criteria', '');
        for (const criterion of task.acceptanceCriteria) {
            lines.push(`- [${criterion.done ? 'x' : ' '}] ${criterion.text}`);
        }
        lines.push('');
    }
    if (task.definitionOfDone.length) {
        lines.push('## Definition of done (project-wide)', '');
        for (const item of task.definitionOfDone)
            lines.push(`- [${item.done ? 'x' : ' '}] ${item.text}`);
        lines.push('');
    }
    lines.push(...section('Existing plan', task.plan));
    const blockers = input.blockers?.filter((b) => b.status !== 'done' && b.status !== 'cancelled') ?? [];
    if (blockers.length) {
        lines.push('## Blocked by', '');
        for (const blocker of blockers)
            lines.push(`- ${blocker.title} (${blocker.id}, ${blocker.status})`);
        lines.push('');
    }
    // The contract, stated in the prompt as well as the skill: an agent that only
    // reads one of the two must still get this right.
    lines.push('## How to work this task', '');
    lines.push(`- Call \`tasks_get ${task.id}\` for the full record, and keep the \`hash\` it returns for your updates.`);
    if (gates.plan) {
        lines.push('- **Plan first.** Write your plan, call `tasks_request_approval` with `kind: "plan"`, then poll', '  `tasks_wait`. Do not start implementing until the verdict is `approved` — a timeout is not an approval.');
    }
    lines.push('- Record progress with `tasks_update`, and findings with `tasks_comment`.');
    lines.push(gates.done
        ? '- When the acceptance criteria are met, call `tasks_complete`. A human reviews it before it closes.'
        : '- When the acceptance criteria are met, call `tasks_complete`.');
    lines.push('- If you need a decision, ask with `tasks_request_approval` (`kind: "question"`) rather than guessing.');
    lines.push('');
    return lines.join('\n').trimEnd() + '\n';
}
