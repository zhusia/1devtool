"use strict";
/**
 * Generates the orchestration SKILL.md content per target agent.
 *
 * One file is written per installed agent (see Phase 2.3 of using_skills_plan.md).
 * Frontmatter `tool:` field and a small "your tool model" framing differ per
 * agent; the shared body is identical across all host agents. Absolute shim path is
 * baked in at install time so the skill works without the shim being on $PATH.
 *
 * v9 adds the user-configured routing policy (docs/features/orchestration/dashboard.md
 * §5): with an active policy the body's anti-delegation absolutes are
 * REWRITTEN policy-aware (never merely appended to — the v8 absolutes forbid
 * exactly what the routing table enables), a `## Task routing` section is
 * injected, and a user-authored `## Custom instructions` block is compiled
 * between `<!-- 1devtool:custom -->` markers.
 *
 * v11 makes routed ownership sticky across failures: a host may not reclaim a
 * category, use its own tools, or silently choose another agent when the
 * assigned delegate fails or lacks a required capability. Ownership starts only
 * after the user authorizes delegation, so the same contract is safe in both
 * direct-routing and confirm-first `suggest` modes.
 *
 * v13 makes substrate a policy axis independent from Team/Swarm topology.
 * Capability-gated work compiles to `--terminal --wait`; self-contained work
 * stays headless, and `auto` is taught through one shared decision rule.
 * v14 gives declarative Team/Swarm manifests the same quoted-path and scoped
 * PowerShell UTF-8 guarantees as direct delegation.
 * v15 makes an explicit 1DevTool/onedevtool Browser MCP request take precedence
 * over generic browser-category routing so hosts use the live BrowserPanel
 * tools instead of recursively opening a /chrome agent terminal.
 *
 * Bump `SKILL_VERSION` when content changes so existing installs re-write on
 * next app boot (see `installOrchestrationSkillGlobally` idempotence).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HIERARCHY_SECTION_MAX_BYTES = exports.CUSTOM_INSTRUCTIONS_MARKER = exports.LEGACY_SKILL_NAMES = exports.SKILL_NAME = exports.SKILL_VERSION = exports.ORCHESTRATION_SKILL_TARGETS = void 0;
exports.renderRoutingSectionMarkdown = renderRoutingSectionMarkdown;
exports.renderHierarchySectionMarkdown = renderHierarchySectionMarkdown;
exports.renderCustomInstructionsMarkdown = renderCustomInstructionsMarkdown;
exports.buildOrchestratorSkill = buildOrchestratorSkill;
exports.skillContentHash = skillContentHash;
const headlessMode_1 = require("../../shared/headlessMode");
const orchestrationCommand_1 = require("../../shared/orchestrationCommand");
const orchestrationPolicy_1 = require("../../shared/orchestrationPolicy");
const interactiveDelegation_1 = require("../../shared/interactiveDelegation");
const browserMcp_1 = require("../../shared/browserMcp");
const pipeline_1 = require("../../shared/orchestration/pipeline");
exports.ORCHESTRATION_SKILL_TARGETS = [
    'claude',
    'codex',
    'gemini',
    'kimi',
    'agy',
    'cline',
    'opencode',
    'github-copilot',
    'roo',
    'qoder',
    'trae',
    'droid',
    'kilocode',
    'warp',
    'augment',
    'grok',
    'hermes',
    'cursor',
    'pi',
];
// Delegate targets are exactly the agents `1devtool-agent run --to=<agent>`
// accepts (the CLI validates against HEADLESS_SPECS keys). Deriving instead of
// hand-listing means the skill can never advertise a target the CLI rejects —
// that skew is precisely what broke `--to=agy` / `--to=cline`.
const DELEGATE_TARGETS = Object.keys(headlessMode_1.HEADLESS_SPECS);
const DELEGATE_TARGET_LABELS = {
    claude: 'Claude',
    codex: 'Codex',
    gemini: 'Gemini',
    kimi: 'Kimi Code',
    agy: 'Antigravity',
    cline: 'Cline',
    opencode: 'OpenCode',
    amp: 'Amp',
    qwen: 'Qwen',
    grok: 'Grok',
    hermes: 'Hermes Agent',
    cursor: 'Cursor',
    pi: 'Pi',
    aider: 'Aider',
};
const DELEGATE_TARGET_LIST = DELEGATE_TARGETS.map((target) => DELEGATE_TARGET_LABELS[target] ?? target).join(', ');
const DELEGATE_TARGET_OPTIONS = DELEGATE_TARGETS.join(' | ');
exports.SKILL_VERSION = 29;
exports.SKILL_NAME = '1devtool-orchestrator';
/** Previous names this skill was installed under; the installer removes these
 *  stale copies (only when their frontmatter says `source: 1devtool`). */
exports.LEGACY_SKILL_NAMES = ['devtool-orchestrator'];
/** Markers wrapping the user-authored custom-instructions block (§6.5). The
 *  sanitizer strips HTML comments from user text, so these cannot be forged. */
exports.CUSTOM_INSTRUCTIONS_MARKER = '<!-- 1devtool:custom -->';
const ROUTING_DESCRIPTION_CLAUSE = ' A user-configured routing table in this skill maps task categories to preferred agents — ' +
    'also activate when the user asks to delegate without naming a specific agent.';
const BROWSER_MCP_ACTIVATION_EXCLUSION = ' Do not activate merely because the user asks for the 1DevTool/onedevtool Browser MCP or ' +
    'in-app BrowserPanel; unless they separately request delegation, use the onedevtool browser_* ' +
    'tools directly in the current agent.';
const ACTIVATION_DESCRIPTION = `Delegate a prompt to another installed AI coding CLI (${DELEGATE_TARGET_LIST}) by ` +
    'piping it to 1devtool-agent. Activate when the user mentions @<Agent>, asks "ask <Agent>…", ' +
    '"have <Agent> review …", wants a second opinion, or asks to fan a task out across multiple agents.';
// Gemini-family hosts read only the description until activate_skill fires, so
// it has to be self-sufficient. Embed the call pattern + safety contract inline.
const GEMINI_DESCRIPTION = (shimPath) => {
    const pattern = (0, orchestrationCommand_1.buildOrchestrationCommandSnippet)(shimPath, '<agent>')
        .replace(/\n/g, ' ');
    return `Delegate a prompt to another installed AI coding CLI (${DELEGATE_TARGET_LIST}) by piping ` +
        'the task over stdin to ' + shimPath + '. ACTIVATE when the user asks to "ask <Agent>", "have <Agent> ' +
        'review/fix/check <X>", wants a second opinion from a different model, mentions @<Agent>, or asks to run ' +
        `multiple agents in parallel. Pattern: ${pattern}. Never inline prompt text into shell args.`;
};
/**
 * Render the injected `## Task routing` section for a policy. Exported for
 * the dashboard's pure preview IPC and the 4 KB set-policy bound — it is
 * deliberately shim-independent (`... run` elides the documented command) so
 * the section is byte-identical across targets and measurable without a shim.
 * Returns '' when no assignment is enabled (an empty policy must not bloat
 * 15 skill files).
 */
function renderRoutingSectionMarkdown(policy) {
    if (!policy)
        return '';
    const rows = (0, orchestrationPolicy_1.enabledRoutingRows)(policy);
    if (rows.length === 0)
        return '';
    const preamble = policy.mode === 'suggest'
        ? 'The user configured these routing preferences in 1DevTool. When a task matches a\n' +
            'category below and the user asked to delegate without naming an agent, PROPOSE\n' +
            'delegating to the assigned agent and wait for the user\'s confirmation — do not\n' +
            'delegate before they confirm.'
        : 'The user configured these routing preferences in 1DevTool. When the user asks to\n' +
            'delegate without naming a specific agent and the task matches a category below,\n' +
            'delegate to the assigned agent. When the user names SEVERAL agents for a task\n' +
            'that spans multiple categories, this table decides the split: each part of the\n' +
            'task goes to the named agent assigned to its category (a category routed to an\n' +
            'agent the user did not name stays with the named agents). Do not do routed work\n' +
            'yourself unless its category routes to you.';
    const tableRows = rows.map((row) => {
        const label = row.label === row.id ? row.id : `${row.label} (\`${row.id}\`)`;
        const substrate = row.substrate === 'terminal'
            ? `terminal${row.skill ? ` + \`${row.skill}\`` : ''}`
            : row.substrate;
        return `| ${label} | ${row.agent} | ${row.model ?? '—'} | ${substrate} | ${row.notes ?? ''} |`;
    });
    const exampleCommands = rows.map((row) => {
        const modelFlag = row.model ? ` --model=${row.model}` : '';
        const terminalFlags = row.substrate === 'terminal'
            ? ` --terminal --wait${row.skill ? ` --skill=${row.skill}` : ''}`
            : '';
        const autoHint = row.substrate === 'auto'
            ? '  # add --terminal --wait when the capability rule selects terminal'
            : '';
        return `    ... run --to=${row.agent}${modelFlag}${terminalFlags} --category=${row.id} --prompt-stdin${autoHint}`;
    });
    const browserRule = rows.some((row) => row.id === 'browser')
        ? `\n${interactiveDelegation_1.BROWSER_INTERACTIVE_ROUTING_RULE}\n`
        : '';
    return `## Task routing (user-configured)

${preamble}

| Category | Delegate to | Model | Substrate | Notes |
|---|---|---|---|---|
${tableRows.join('\n')}

When delegating via this table, pass the category (and the assigned model, when the
row has one) so the run is attributed — \`...\` stands for the full command pattern
from "How to call it":

${exampleCommands.join('\n')}
${browserRule}

${interactiveDelegation_1.SUBSTRATE_DECISION_RULE}

${orchestrationPolicy_1.ROUTED_TASK_OWNERSHIP_RULE}

${orchestrationPolicy_1.ROUTED_TASK_FAILURE_RULE}

When the user names ONE agent for a task, use exactly that agent — a single explicit
mention is never rerouted. When the user names several agents, keep to the named agents
but use this table to decide which named agent handles which part.
`;
}
/** Compiled hierarchy section hard cap, in UTF-8 bytes (v5 §7.3 — the
 *  ROUTING_SECTION_MAX_BYTES pattern). The text is deliberately GENERIC:
 *  per-seat facts ("you report to Grok") would be wrong to bake globally, so
 *  the role nudge stays authoritative and this section only teaches the
 *  mechanism. */
exports.HIERARCHY_SECTION_MAX_BYTES = 2 * 1024;
const CHOOSING_PATTERN_SECTION = `## Choosing a pattern

Use the mode named by 1DevTool's prompt/role nudge. Follow that. Do not switch.
When no mode was named and the user asked for delegation, use this table:

| Pattern | Pick when | Flow |
|---|---|---|
| Team | Independent subtasks; you integrate | fan out, then merge |
| Swarm | One brief, unknown search space, N≥3 | bounded parallel exploration |
| Pipeline | Fixed sequence; each output feeds the next | pass forward through quality gates |
| Mesh | 3–8 linked peers iterating on one artifact | negotiate over terminal links |
| Hierarchy | Ranked org with middle managers | task down, summarize and report up |

Do not over-orchestrate: one agent with tools is usually enough. Sequence words
(\`then\`, \`→\`, \`after that\`) mean Pipeline; explicit parallel/fan-out
language means Swarm; named independent collaborators mean Team. A Pipeline is
live-terminal only. Team and Swarm may use headless or live substrate.
`;
/**
 * Render the injected `## Agent hierarchy` section. Present only while the
 * APPLIED policy carries a chart — a chart-less policy must not bloat every
 * skill file. Never names seats: the chart binds to terminals only at
 * activation, and the §5.3 role nudge each seat receives is authoritative.
 */
function renderHierarchySectionMarkdown(policy) {
    if (!policy?.hierarchy || policy.hierarchy.nodes.length === 0)
        return '';
    if ((0, pipeline_1.isPipelineChart)(policy.hierarchy)) {
        return `## Agent Pipeline (pass forward)

The user applied a fixed live-terminal Pipeline. Your role card is authoritative:
it names your stage, adjacent stages, and quality gate. Follow that. Do not switch.

- Hand off only to the next stage with \`report\` / \`handoff\`; middle stages
  include the accepted input proof with \`--continue=<message-id>\`.
- Gate-decide a handoff/rework only by replying to its exact message with
  \`link send --gate=accept|reject\`. Never hide a rejection in ordinary prose.
- Return corrected work as an ordinary reply to the exact rejection. Reject
  rounds are bounded; when main refuses the cap, stop for the user.
- Do not use raw \`link send\` for a handoff, task backward, broadcast, skip a
  stage, or initiate outside the frozen Pipeline.
- The final stage writes the user-facing result, then runs \`report --complete\`.
- \`report --blocked\` stops and escalates; it does not poison the next stage.

\`whoami\` prints your stage and current gate state. A refusal names the valid
next action; follow it instead of retrying another route.
`;
    }
    const section = `## Agent hierarchy (chain of command)

The user configured a hierarchy over terminal links: ranked seats where
managers task their subordinates and every seat reports to exactly one
manager. When your terminal is SEATED, 1DevTool types a role card into your
composer — who you are, who you may task, where you report, with exact
commands. That role card is authoritative for your routing; this section only
explains the mechanism.

Rules while seated (enforced by 1DevTool, not just etiquette):

- Task only your own subordinates (and explicit skip-level grants). Lateral
  messages and skip-level reports are refused with the correct route named.
- Send unsolicited status, results, and escalations to your ONE configured
  manager with \`... report --prompt-stdin\` (\`...\` stands for the shim
  command from "How to call it"; add \`--blocked\` when you need a decision).
  The seat is resolved for you — never guess your manager's terminal id.
- Answers are different: reply to any message you received with the
  \`--reply-to\` command embedded in its envelope, even across skip-level.
- When subordinates report in, summarize before reporting up — never forward
  raw output.
- \`whoami\` prints your seat, tier, manager, and subordinates.

A refused send names the allowed route in its error — follow it instead of
retrying. If this section conflicts with a newer role card in your
conversation, the role card wins.
`;
    if ((0, orchestrationPolicy_1.utf8ByteLength)(section) > exports.HIERARCHY_SECTION_MAX_BYTES) {
        throw new Error(`hierarchy skill section exceeds ${exports.HIERARCHY_SECTION_MAX_BYTES} bytes — shorten the template, never raise the cap silently`);
    }
    return section;
}
/** Render the user-authored custom block (already sanitized at set-policy).
 *  Returns '' when absent. */
function renderCustomInstructionsMarkdown(policy) {
    const text = policy?.customInstructions?.trim();
    if (!text)
        return '';
    return `${exports.CUSTOM_INSTRUCTIONS_MARKER}
## Custom instructions

${text}
${exports.CUSTOM_INSTRUCTIONS_MARKER}
`;
}
function sharedBody(shimPath, toolModel, policy) {
    const commandSnippet = (0, orchestrationCommand_1.indentOrchestrationSnippet)((0, orchestrationCommand_1.buildOrchestrationCommandSnippet)(shimPath, '<agent>'));
    const platformNote = (0, orchestrationCommand_1.isWindowsOrchestrationShim)(shimPath)
        ? 'On Windows, keep the complete `$OutputEncoding` scope shown below. Windows PowerShell 5 otherwise converts non-ASCII prompt text to `?` before the CLI receives it.'
        : 'On macOS/Linux, keep the prompt in the quoted `$TASK` variable and pipe it as shown.';
    const teamManifestCommand = (0, orchestrationCommand_1.indentOrchestrationSnippet)((0, orchestrationCommand_1.buildOrchestrationManifestSnippet)(shimPath, 'team'));
    const swarmManifestCommand = (0, orchestrationCommand_1.indentOrchestrationSnippet)((0, orchestrationCommand_1.buildOrchestrationManifestSnippet)(shimPath, 'swarm'));
    const routingActive = (0, orchestrationPolicy_1.hasActiveRouting)(policy);
    // With an enabled policy the two v8 anti-delegation absolutes are REPLACED,
    // not supplemented — the routing table enables exactly what they forbid
    // (§5; the no-contradiction unit test pins this).
    const noMentionRule = routingActive
        ? `If the user did not ask for any delegation, do NOT delegate — handle the task
yourself. If the user asked to delegate WITHOUT naming an agent (e.g. "get this
tested by another agent", "have someone review this"), use the routing table
below ("Task routing").`
        : `If the user did NOT mention another agent, do NOT delegate — handle the task
yourself.`;
    const modelRule = routingActive
        ? `Pass a model when the
                           user asked for one, or when the routing table
                           assigns one for the matched category; otherwise
                           omit it. If the target says the model is
                           unavailable, retry once without --model and tell
                           the user which model actually ran.`
        : `Only
                           pass a model the user asked for; if the target says
                           the model is unavailable, retry once without
                           --model and tell the user which model actually ran.`;
    const notToDoDelegationRule = routingActive
        ? `- When the user names ONE agent, use exactly that agent — the routing table
  never overrides an explicit mention. When the user names SEVERAL agents,
  keep to those agents but let the routing table decide which named agent
  handles which part of the task. When the user asks for delegation without
  naming one, pick from the routing table; never delegate a task the user
  wanted handled by you.`
        : `- Do NOT delegate to an agent the user didn't ask for. Pick exactly the
  agents the user named.`;
    const routingSection = renderRoutingSectionMarkdown(policy);
    const hierarchySection = renderHierarchySectionMarkdown(policy);
    const customSection = renderCustomInstructionsMarkdown(policy);
    const injectedSections = [routingSection, hierarchySection, customSection].filter(Boolean).join('\n');
    return `<!-- This file is auto-managed by 1DevTool — edits will be overwritten on next app boot. -->

# Orchestrate other AI coding agents

You have access to a local CLI, \`${shimPath}\`, that delegates a prompt to
another installed AI coding agent (${DELEGATE_TARGET_LIST}) and returns its
response. Use it whenever a task is better handled by —
or benefits from a second opinion from — a different agent.

## When to use

- The user says "ask <Agent> to …", "have <Agent> review …", "what does <Agent>
  think about …", or "@<Agent>" in their prompt.
- The user asks for a second opinion, a review by a different model, or a
  cross-check.
- The user asks you to fan a task out across multiple agents in parallel.
- The user is in a channel-style conversation where multiple agents collaborate.

${noMentionRule}

${CHOOSING_PATTERN_SECTION}

## In-app Browser MCP is direct tool use

${browserMcp_1.BROWSER_MCP_DIRECT_USE_RULE}

## How to call it (the only supported pattern)

Pipe the prompt over stdin. Do NOT pass the prompt as a \`--prompt=...\` flag
or any other argv — there is no \`--prompt\` flag, and inlining prompt text into
shell arguments is unsafe (shell substitution happens before argv parsing,
which can leak credentials or trigger unintended commands).

${commandSnippet}

${platformNote}

For several named collaborators, prefer one declarative Agent Team transaction
over independent calls. Put JSON in \`$MANIFEST\` (use a quoted heredoc so the
shell cannot expand task text), then pipe it over stdin:

${teamManifestCommand}

The Team manifest shape is:

    {"clientRequestId":"<uuid>","members":[
      {"role":"implementer","target":"codex","prompt":"<task>","substrate":"auto"},
      {"role":"reviewer","target":"claude","prompt":"<task>","substrate":"auto"}
    ]}

The response contains stable \`teamId\`/\`memberId\` values and one immutable
\`runId\` per prompt. Collect with \`${shimPath} collect --run=<runId>\`; a
still-running result is normal and can be collected again. Follow-ups use
\`${shimPath} send --team=<teamId> --member=<memberId> --submission-id=<uuid>
--prompt-stdin\` so retries cannot double-submit.

For flat independent exploration of ONE brief, use a bounded Swarm instead:

${swarmManifestCommand}

    {"clientRequestId":"<uuid>","brief":"<shared brief>","count":8,
     "targets":["codex"],"poolSize":4,"budget":8,"substrate":"headless",
     "sandbox":"read"}

The required task key is exactly \`brief\`; never rename it to
\`sharedBrief\`.

Headless Swarm workers run inside each CLI's enforced sandbox, so
\`targets\` must be sandbox-capable agents: codex, claude, or cursor. Any
other agent (grok, agy, gemini, …) is refused at submission — reach those
with direct \`--to=<agent>\` calls or an Agent Team instead.

Collect bounded/paginated results with \`${shimPath} collect --swarm=<swarmId>\`.
Use Swarm live (\`"substrate":"terminal"\`) only when every worker needs the
interactive harness and the requested count fits the live capacity.

Common options:

    --to=<agent>           Target agent: ${DELEGATE_TARGET_OPTIONS}
    --prompt-stdin         Read prompt from stdin (required)
    --timeout=<seconds>    Max wait, 5..600 (default 120)
    --cwd=<dir>            Working dir for the target agent (default: your cwd)
    --model=<id>           Model for the target agent, mapped to its own model
                           flag (claude: sonnet | opus | haiku; codex: e.g.
                           gpt-5.6-sol, optionally with a reasoning suffix like
                           gpt-5.6-sol:xhigh; opencode: provider/model). ${modelRule}
    --category=<slug>      Task category for run attribution (lowercase slug,
                           e.g. test, plan). Pass it when delegating via the
                           routing table; omit it otherwise.
    --terminal             Run in a visible 1DevTool agent terminal.
    --wait                 With --terminal, wait for its correlated result.
    --interactive          Legacy handoff-only alias; returns after opening.
    --skill=/<name>        Invoke a slash skill with the task in that terminal;
                           requires --terminal (browser routes use /chrome).
    --flag=<f>             Extra flag to pass to the target CLI; repeatable
    --json                 Emit a JSON result envelope instead of plain text

Headless commands and \`--terminal --wait\` both block until the target agent
finishes and print the result on stdout. Legacy \`--interactive\` returns after
1DevTool creates the visible terminal and hands off the task. Exit code 0 means
the run completed (or a legacy handoff started); non-zero means it failed.
Headless output is capped at ~100,000 characters; long responses are truncated.

## Choosing headless vs a real terminal

${interactiveDelegation_1.SUBSTRATE_DECISION_RULE}

## Listing what's installed

    ${shimPath} list --json

Returns the AI CLIs detected on this machine with status (\`detected\`,
\`not-found\`, etc.) and versions. Use this before delegating if you're unsure
whether the target agent is actually installed.

## Existing terminal links

\`${shimPath} whoami\` lists the calling terminal and its directed links. Send
over an existing link with \`${shimPath} link send --to=<terminalId>
--prompt-stdin --wait\`. \`delivered\` means the target acknowledged that exact
message, not merely that bytes reached its PTY. \`delivery-unconfirmed\` means
Enter was injected once but acceptance could not be proven; 1DevTool never
retries that uncertain submission automatically, so ask the user before
resending. If collaboration requires a link that is absent, you
may request the exact target and bounded permissions with \`${shimPath} link
request --to=<terminalId> --permissions=send,ask\`. A request grants nothing:
the user must approve it in 1DevTool, and an approved agent-requested link
starts in strict per-message confirmation mode. Never imply that requesting
created the edge.

When a link has an explicit \`read-*\` grant, discover only your readable
outbound peers with \`${shimPath} link peers --json\`. Pull bounded context on
demand with \`link read --from=<terminalId> --lines=40\`, inspect the current
screen with \`link screen --from=<terminalId>\`, or cheaply check progress with
\`link peek --from=<terminalId> [--changed-since=<opaqueCursor>]\`. Use
\`--full\` only when the edge separately grants full-transcript access. Published
notes use \`link notes --from=<terminalId>\`; publish one with \`link publish
--title=<title> --prompt-stdin\`. Reads never touch the peer's composer. They
fail closed when permission, consent, exact session/worktree scope, or a
transport-authenticated caller is unavailable; report that failure and do not
probe a weaker HTTP/PID path.

Inside an Agent Team, use the member-scoped aliases: \`team peers --team=<id>\`,
\`team read --team=<id> --from=<memberId>\`, \`team screen\`, \`team notes\`,
and \`team peek\`. These resolve the member to the same consented terminal-link
edge; Team membership alone never grants a read.

## Workspace Control

Only when the user asks to coordinate multiple projects in a workspace:

- \`${shimPath} workspace roster [--workspace=<id>] [--json]\` — member
  projects and their open AI terminals, plus your delivery path to each.
- \`${shimPath} workspace send --to=<terminalId|name|project:<id|name>> --prompt-stdin [--workspace=<id>]\`
- \`${shimPath} workspace broadcast --prompt-stdin [--workspace=<id>] [--include-self] [--limit=16]\`
- \`${shimPath} workspace collect --operation=<wop-id> [--timeout=<seconds>]\`
- \`${shimPath} workspace operation --id=<wop-id>\`

Workspace membership authorizes the roster; delivery still requires an
existing link with send permission — being in a workspace never creates a
link. Send and broadcast print an \`operationId\`; collect requires it and
returns only answers correlated to that operation's messages. An ambiguous
workspace fails with the candidate list — pass \`--workspace=\` explicitly.

## Agent Team vs Swarm

- Team is hierarchical: named members can have different prompts/roles and the
  host collects and integrates their results. Use it when the user names
  several agents or the work needs a plan/implement/review split.
- Swarm is flat: N isolated workers receive the same brief. Use it for bounded
  independent exploration, hypothesis generation, or broad review. Workers do
  not message one another and cannot start nested orchestrations.
- Topology does not choose substrate. Apply the capability rule above to each
  Team member or Swarm worker.

## Examples

User: "Ask Codex to review this for race conditions: <code>"
You: pipe the code + question to \`${shimPath} run --to=codex --prompt-stdin\`.

User: "Get a second opinion from Gemini on my approach"
You: pipe your current approach + the question to
\`${shimPath} run --to=gemini --prompt-stdin --timeout=180\`.

User: "Ask Claude Sonnet to summarize this diff"
You: pipe the diff + question to
\`${shimPath} run --to=claude --model=sonnet --prompt-stdin\`.

User: "Have Codex research this in Chrome"
You: pipe the browser task to
\`${shimPath} run --to=codex --terminal --wait --skill=/chrome --category=browser --prompt-stdin\`.

User: "@Claude what would you do here?" (from inside another agent)
You: pipe the surrounding context + question to
\`${shimPath} run --to=claude --prompt-stdin\`.

User: "Fan this out to Codex, Gemini, and Aider in parallel"
You: start one Swarm manifest with those three targets, collect the bounded
worker results, then summarize them for the user.

${injectedSections ? injectedSections + '\n' : ''}## What NOT to do

- Do NOT inline prompt text into shell arguments. There is no \`--prompt\`
  flag. Always \`--prompt-stdin\`.
${notToDoDelegationRule}
- Do NOT loop: if the target agent's response says to delegate back to you,
  treat that as a normal answer, do not re-delegate.
- Do NOT call this CLI for non-AI shell tasks; it's only for delegating to
  another AI CLI.
- Do NOT include credentials, API keys, or secrets in the piped prompt
  unless the user explicitly authorized it for this turn.

## Your tool model

${toolModel}
`;
}
const DEFAULT_TOOL_MODEL = 'Use your available shell or terminal command tool to invoke the CLI. Follow the exact ' +
    'platform-specific command in "How to call it", including its UTF-8 encoding scope on Windows.';
const TOOL_MODEL = {
    claude: 'Use your Bash/shell tool to invoke the CLI. Follow the exact platform-specific command in ' +
        '"How to call it", including its UTF-8 encoding scope on Windows.',
    codex: 'Use your shell-exec turn to invoke the CLI. Follow the exact platform-specific command in ' +
        '"How to call it", including its UTF-8 encoding scope on Windows. Codex\'s sandbox needs ' +
        'network access for the target agent\'s API; the CLI itself does not network.',
    gemini: 'Use your `run_shell_command` tool to invoke the CLI. Follow the exact platform-specific ' +
        'command in "How to call it", including its UTF-8 encoding scope on Windows.',
    opencode: 'Use your shell tool to invoke the CLI. Follow the exact platform-specific command in ' +
        '"How to call it", including its UTF-8 encoding scope on Windows.',
};
function frontmatter(target, shimPath, policy) {
    const routingActive = (0, orchestrationPolicy_1.hasActiveRouting)(policy);
    const description = (target === 'gemini' || target === 'agy'
        ? GEMINI_DESCRIPTION(shimPath)
        : ACTIVATION_DESCRIPTION) + (routingActive ? ROUTING_DESCRIPTION_CLAUSE : '') +
        BROWSER_MCP_ACTIVATION_EXCLUSION;
    const policyHashLine = policy ? `\n  policyHash: ${(0, orchestrationPolicy_1.canonicalPolicyHash)(policy)}` : '';
    return `---
name: ${exports.SKILL_NAME}
description: |
  ${description.split('\n').join('\n  ')}
tool: ${target}
category: orchestration
user_invocable: false
metadata:
  source: 1devtool
  version: ${exports.SKILL_VERSION}
  shim: ${shimPath}${policyHashLine}
---

`;
}
function buildOrchestratorSkill(target, args) {
    const { shimPath } = args;
    const policy = args.policy ?? null;
    const toolModel = TOOL_MODEL[target] ?? DEFAULT_TOOL_MODEL;
    return frontmatter(target, shimPath, policy) + sharedBody(shimPath, toolModel, policy);
}
/** Quick content-hash for idempotent re-install (FNV-1a 64-bit; collision-safe
 *  enough for "did the body change" detection). Stored in metadata.hash so the
 *  installer can skip writes when both version and hash match. */
function skillContentHash(content) {
    // Strip the frontmatter `shim:` line before hashing so a shim-path change
    // alone doesn't masquerade as a content change (the installer compares
    // `metadata.shim` separately).
    const normalised = content.replace(/^\s*shim:.*$/m, 'shim: <NORMALISED>');
    let h = BigInt('14695981039346656037');
    const prime = BigInt('1099511628211');
    const mask = (BigInt(1) << BigInt(64)) - BigInt(1);
    for (let i = 0; i < normalised.length; i++) {
        h ^= BigInt(normalised.charCodeAt(i) & 0xff);
        h = (h * prime) & mask;
    }
    return h.toString(16).padStart(16, '0');
}
