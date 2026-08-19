"use strict";
/**
 * The per-agent `tasks` skill (docs/tasks_v2.md §6.3).
 *
 * An MCP server that agents are not taught to use does not get used — so the
 * tools and the skill that teaches them ship in the same release.
 *
 * HONESTY RULE, and the reason this file has a version of its own: the skill
 * documents exactly the tools that exist in this build and nothing further. P1
 * ships the read half (`tasks_next`, `tasks_list`, `tasks_get`), so this skill
 * teaches re-entry and reading only. When P2 lands the write tools and P4 the
 * gates, extend the body and bump `TASKS_SKILL_VERSION` in the same change —
 * a skill advertising a tool the build does not register produces "unknown
 * tool" mid-run, which is the same skew class that the orchestration
 * shim/skill lockstep exists to prevent (see orchestration/install.ts).
 *
 * Unlike the orchestration skill this one is SHIM-INDEPENDENT: it calls the
 * onedevtool MCP directly and never mentions the 1devtool-agent CLI, so it
 * carries no `shim:` frontmatter and must not inherit the shim's dev-preserve
 * gate.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TASKS_SKILL_NAME = exports.TASKS_SKILL_VERSION = void 0;
exports.buildTasksSkill = buildTasksSkill;
exports.TASKS_SKILL_VERSION = 3;
exports.TASKS_SKILL_NAME = '1devtool-tasks';
const ACTIVATION_DESCRIPTION = 'Work the task assigned to this 1DevTool terminal through the onedevtool MCP task tools. ' +
    'Activate when the user asks what you should be working on, says to continue or resume the task, ' +
    'refers to a task id like t-7k2m9qx4wp3fn, or when you start a fresh session in a terminal that ' +
    'was dispatched work and need to recover what it was. For an attributed Tasks assignment, also ' +
    'use it for required plan approval, human decisions, and completion reporting. The integration is ' +
    'optional for ordinary direct prompts: an unavailable MCP server or missing terminal attribution ' +
    'must never block work the user directly requested.';
/** How each host agent is told to reach MCP tools. */
const TOOL_MODEL = {
    claude: 'Call the tools directly — they appear as `tasks_next`, `tasks_get`, `tasks_update` and so on.',
    codex: 'Call the onedevtool MCP task tools directly (`tasks_next`, `tasks_get`, `tasks_update`, …).',
    gemini: 'Call the onedevtool MCP task tools directly (`tasks_next`, `tasks_get`, `tasks_update`, …).',
    agy: 'Call the onedevtool MCP task tools directly (`tasks_next`, `tasks_get`, `tasks_update`, …).',
    grok: 'Call the onedevtool MCP task tools directly. Grok may prefix them with the server name.',
};
const DEFAULT_TOOL_MODEL = 'Call the onedevtool MCP task tools directly (`tasks_next`, `tasks_get`, `tasks_update`, …).';
function frontmatter(target) {
    return `---
name: ${exports.TASKS_SKILL_NAME}
description: |
  ${ACTIVATION_DESCRIPTION.split('\n').join('\n  ')}
tool: ${target}
category: tasks
user_invocable: false
metadata:
  source: 1devtool
  version: ${exports.TASKS_SKILL_VERSION}
---

`;
}
function body(toolModel) {
    return `# 1DevTool Tasks

The human's task list for this project lives in 1DevTool. It is durable, it is shared with them
in real time, and it is the only list that counts.

${toolModel}

## Direct user prompts never wait on Tasks

The Tasks MCP is a synchronization layer, not permission to answer the user. If the user directly
asked for work in the current conversation, continue that work even when a Tasks call is unavailable,
disabled, returns \`no-terminal-attribution\`, or has no assigned task. Do not ask the human to
redispatch or provide a task id solely to satisfy this integration, and never describe the direct
request as blocked by the Tasks workflow.

A successfully attributed task may carry an app-owned plan, question, or done gate. Honor that real
gate. But inability to reach Tasks does not create a gate, and an empty/unattributed queue does not
cancel or postpone a direct user request. If synchronization is unavailable, use the repository's
normal workflow, finish the requested work, and mention the missing task update only if it matters.

## The one rule

**You do not pick your own work.** A task becomes yours because a human dispatched it to this
terminal — never because you found it and it looked relevant. There is deliberately no tool that
assigns a task, to you or to anyone.

When \`tasks_next\` was called to discover what is assigned to this terminal and it returns
\`queue-empty\` or \`all-remaining-blocked\`, that is a complete queue answer: **stop and report**
instead of selecting unassigned work. A \`no-terminal-attribution\` result means only that Tasks
cannot identify a queue. None of those results blocks a direct request already present in the
conversation.

## The loop

1. **Work usually arrives as your prompt.** When a human dispatches a task, its id, title and
   acceptance criteria are already in the message that started your turn. Start there.
2. **\`tasks_next\`** is for *re-entry*, not discovery: a fresh session that lost its context, or
   the moment after you finish one task and want the next one already assigned to you.
3. **\`tasks_get <id>\`** gives you the body, the acceptance criteria, the definition of done, any
   plan already written, and what this task is blocked by. Read it before you touch code. Keep the
   \`hash\` it returns — pass it back as \`baseHash\` when you update, so an edit the human made
   while you worked is caught instead of overwritten.
4. **\`tasks_update\`** to move the task to \`in_progress\` when you start, to write your plan, to
   tick acceptance criteria as you satisfy them, and to record what changed.
5. For a successfully attributed task whose dispatch/policy requires it,
   **\`tasks_request_approval(kind: 'plan')\`** before implementing anything non-trivial, then
   **\`tasks_wait\`** for the verdict. This is where a sentence of feedback is cheapest — for both
   of you. Do not manufacture this requirement for an ordinary direct prompt when Tasks is absent.
6. **\`tasks_complete\`** when the criteria are met, with a summary written against them. Depending
   on the project it either closes the task or opens a review for the human.
7. **\`tasks_list\`** shows the board — cheap, no bodies. Use it for context ("what else is in
   flight", "is this a duplicate"), not to choose work.
8. **\`tasks_comment\`** for anything worth recording that is not a status change: what you tried,
   what failed and why, a suspicion, "this looks like a duplicate of t-…". You may comment on
   tasks you are not assigned — that is the one write allowed on someone else's work.
9. **\`tasks_link\`** when you discover a real dependency — this cannot land until that one does,
   or this is a subtask of that. Say it in the graph rather than only in prose, so the board can
   show the human why something is stuck. Cycles are rejected.

## Approvals

\`tasks_request_approval\` returns a \`gateId\` **immediately**; the human's answer comes back
through \`tasks_wait\`. Call \`tasks_wait\` with that id and it returns quickly:

- **\`open\`** — nobody has answered yet. Call \`tasks_wait\` again. Do not proceed as if approved.
- **\`resolved\`** — you get a \`verdict\` and, usually, the human's own words:
  - \`approved\` — go.
  - \`changes-requested\` — read the response and revise. It is not a rejection; it is the point.
  - \`declined\` — stop. The task is cancelled.
- **\`timeout\`** — nobody answered in time. **Silence is not approval.** Stop and report; the task
  is blocked until a human picks it up.
- **\`stale\`** — the run that asked is gone. Nothing you do here helps; a human must redispatch.

You cannot answer your own gate — there is no tool for it, deliberately. If your turn ends while a
gate is open, that is fine: the verdict is recorded either way, reaches you as a message when it
lands, and is waiting in \`tasks_get\` when you come back.

## Writes you cannot make

\`assignee\`, gates, runs and holds are owned by the app, not by the task file, and the tools
reject any attempt to set them. Editing the markdown file directly does not work either: the app
re-reads authority from its own records and will overwrite what you wrote. This is not a
restriction to work around — it is what makes "a human decided this is yours" mean something.

## Reading a task

- **status** — \`backlog\` (unrefined) · \`ready\` (yours to start) · \`in_progress\` · \`blocked\` ·
  \`in_review\` (you said done, a human is checking) · \`done\` · \`cancelled\`.
- **priority** — \`p0\` highest through \`p3\`.
- **blockedBy** — each entry shows its own status. If a blocker is not \`done\`, the task is not
  startable; say so rather than working around it.
- **awaitingHuman** — the task is waiting on a person, not on you.
- **acceptanceCriteria / definitionOfDone** — the actual bar. Meeting the title is not meeting
  the task.

## Do not keep a private TODO list

Do not invent your own checklist file, scratch plan, or "tasks I noticed" note. The human is
watching this list; anything you keep elsewhere is invisible to them and goes stale the moment
they change something. Put the plan on the task with \`tasks_update\`, findings in
\`tasks_comment\`, and follow-up work in \`tasks_create\` — created unassigned, because noticing
work is not the same as being given it.

## When you finish

Call \`tasks_complete\` with a summary written against the acceptance criteria — not "done", but
what is now true that was not before. If the project reviews completions you will get a
\`gateId\`; you may poll it or simply stop, because the verdict reaches you either way. Then
report in your reply, and take the next task only if \`tasks_next\` gives you one. If Tasks cannot
be reached, still answer the user with the completed result; task-record synchronization is never
a prerequisite for delivering work they directly requested.
`;
}
function buildTasksSkill(target) {
    return frontmatter(target) + body(TOOL_MODEL[target] ?? DEFAULT_TOOL_MODEL);
}
