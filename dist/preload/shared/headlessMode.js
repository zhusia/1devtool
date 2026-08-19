"use strict";
/**
 * Headless mode specifications for known AI coding CLIs.
 *
 * Each spec defines how to convert a user prompt + CLI flags into a
 * non-interactive (headless) command that runs a single prompt and exits.
 *
 * Sources:
 *   claude  — https://code.claude.com/docs/en/headless
 *   codex   — https://developers.openai.com/codex/noninteractive
 *   gemini  — https://google-gemini.github.io/gemini-cli/docs/cli/headless.html
 *   kimi    — https://moonshotai.github.io/kimi-code/en/reference/kimi-command
 *   agy     — `agy --print "<prompt>"` (argv; stdin `-` is treated as the prompt text)
 *   cline   — https://docs.cline.bot/usage/cli-overview
 *   amp     — https://ampcode.com/manual  (-x / --execute)
 *   opencode— https://opencode.ai/docs/cli/
 *   qwen    — https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/
 *   grok    — `grok -p "<prompt>"` (--single): prints the response to stdout and exits
 *   hermes  — `hermes -z "<prompt>"` (--oneshot): prints only the final response
 *   cursor  — `cursor-agent -p <flags> "<prompt>"`: --print is non-interactive.
 *             https://cursor.com/docs/cli/overview documents the command as
 *             `agent`; `cursor-agent` is the executable's own name and the
 *             alias every install (old and new) still ships.
 *   pi      — `pi -p <flags> "<prompt>"`: --print is non-interactive. The
 *             prompt is POSITIONAL (`pi [options] [@files...] [messages...]`).
 *   aider   — https://aider.chat/docs/scripting.html
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HEADLESS_SPECS = void 0;
exports.buildHeadlessCommand = buildHeadlessCommand;
exports.buildHeadlessInvocation = buildHeadlessInvocation;
exports.parseCliCommand = parseCliCommand;
exports.HEADLESS_SPECS = {
    claude: { cliId: 'claude', headlessFlag: '-p', promptPosition: 'after-flag' },
    codex: { cliId: 'codex', headlessFlag: 'exec', promptPosition: 'end', promptDelivery: 'stdin', stdinPromptArg: '-', defaultFlags: ['--dangerously-bypass-approvals-and-sandbox', '--ephemeral', '--skip-git-repo-check'] },
    gemini: { cliId: 'gemini', headlessFlag: '-p', promptPosition: 'after-flag' },
    // `kimi -p` is already non-interactive and uses its automatic approval
    // policy; the CLI rejects combining --prompt with --yolo/--auto/--plan.
    kimi: { cliId: 'kimi', headlessFlag: '-p', promptPosition: 'after-flag', defaultFlags: [] },
    // Field evidence (Windows 1.59.0 logs): `agy --print -` with the prompt on
    // stdin treats the argv `-` as the user message ("empty or a placeholder
    // (`-`)") and never reads stdin. Deliver the prompt as an argv value, same
    // as claude/gemini. Long prompts stay under Windows' CreateProcess limit in
    // practice for headless orchestration; app-owned spawn quoting (buildSpawnSpec)
    // keeps metacharacters out of a shell.
    agy: { cliId: 'agy', headlessFlag: '--print', promptPosition: 'after-flag' },
    // cline takes the prompt as a positional argv (`cline [options] [prompt]`).
    // Do NOT switch it to stdin delivery: cline sniffs stdin to pick its mode,
    // and under execFile (pipe stdin, data written post-spawn) that sniff races
    // and it exits with "interactive mode requires a TTY". Argv via execFile is
    // shell-free, so the no-prompt-in-shell-args contract still holds.
    cline: { cliId: 'cline', promptPosition: 'end', defaultFlags: ['--auto-approve', 'true'] },
    amp: { cliId: 'amp', headlessFlag: '-x', promptPosition: 'after-flag' },
    // `opencode run` rejects permission requests when no interactive UI can
    // answer them. `--auto` is the documented single-run approval mode.
    opencode: { cliId: 'opencode', headlessFlag: 'run', promptPosition: 'after-flag', defaultFlags: ['--auto'] },
    qwen: { cliId: 'qwen', headlessFlag: '-p', promptPosition: 'after-flag' },
    // `grok -p` (alias --single): single-turn, prints to stdout and exits.
    grok: { cliId: 'grok', headlessFlag: '-p', promptPosition: 'after-flag', defaultFlags: ['--always-approve'] },
    hermes: { cliId: 'hermes', headlessFlag: '-z', promptPosition: 'after-flag', defaultFlags: [] },
    // Cursor takes the prompt as a positional argv (`agent [options] [prompt...]`),
    // so the prompt must come last — a trailing flag would be swallowed as more
    // prompt words. `--trust` only works alongside --print and is what keeps a
    // headless run from blocking on the workspace-trust prompt. `cliId` is the
    // binary (`cursor-agent`), NOT the key: `cursor` is the editor launcher.
    cursor: { cliId: 'cursor-agent', headlessFlag: '-p', promptPosition: 'end', defaultFlags: ['--force', '--trust'] },
    // Pi takes its prompt as positional argv, so it must come last or a
    // trailing flag is swallowed as prompt words. No approval flag exists to
    // add: pi has no permission prompts, and its project-trust selector is
    // skipped outright in non-interactive mode (dist/cli/project-trust.js
    // returns undefined when mode !== 'interactive'), so a headless run in an
    // untrusted project proceeds with project-local resources simply unloaded
    // rather than blocking. `--approve` is deliberately NOT a default: it
    // would silently trust project-local extensions/skills that can execute
    // code.
    pi: { cliId: 'pi', headlessFlag: '-p', promptPosition: 'end', defaultFlags: [] },
    aider: { cliId: 'aider', headlessFlag: '--message', promptPosition: 'after-flag' },
};
/**
 * Build a headless CLI command string.
 *
 * @param agentId    HEADLESS_SPECS key / `--to=` target (e.g. 'claude', 'cursor')
 * @param prompt     User's prompt text
 * @param extraFlags Additional CLI flags from the command preset
 * @returns Formatted headless command, or null if no spec for this CLI
 *
 * @example
 *   buildHeadlessCommand('claude', 'write jokes', ['--dangerously-skip-permissions', '--model', 'claude-opus-4-7'])
 *   // → "claude -p 'write jokes' --dangerously-skip-permissions --model claude-opus-4-7"
 *
 *   buildHeadlessCommand('codex', 'write jokes', ['--dangerously-bypass-approvals-and-sandbox', '--ephemeral'])
 *   // → "printf '%s' 'write jokes' | codex exec --dangerously-bypass-approvals-and-sandbox --ephemeral -"
 *
 *   buildHeadlessCommand('gemini', 'list languages', ['-y'])
 *   // → "gemini -p 'list languages' -y"
 *
 *   buildHeadlessCommand('agy', 'list languages', [])
 *   // → "agy --print 'list languages'"
 *
 *   buildHeadlessCommand('cline', 'run tests', ['--auto-approve', 'true'])
 *   // → "cline --auto-approve true 'run tests'"
 *
 *   buildHeadlessCommand('cursor', 'review this', ['--force', '--trust'])
 *   // → "cursor-agent -p --force --trust 'review this'"
 */
function buildHeadlessCommand(agentId, prompt, extraFlags) {
    const spec = exports.HEADLESS_SPECS[agentId];
    const invocation = buildHeadlessInvocation(agentId, prompt, extraFlags);
    if (!spec || !invocation)
        return null;
    // The BINARY is spec.cliId, never the agent id — they differ for Cursor,
    // where the id `cursor` names the editor launcher rather than the CLI.
    const command = [spec.cliId, ...invocation.args].map(shellQuote).join(' ');
    if (invocation.stdin !== undefined) {
        return `printf '%s' ${shellQuote(invocation.stdin)} | ${command}`;
    }
    return command;
}
function buildHeadlessInvocation(cliId, prompt, extraFlags) {
    const spec = exports.HEADLESS_SPECS[cliId];
    if (!spec)
        return null;
    const headlessArgs = spec.headlessFlag ? [spec.headlessFlag] : [];
    const promptArgs = spec.promptDelivery === 'stdin'
        ? spec.stdinPromptArg !== undefined ? [spec.stdinPromptArg] : []
        : [prompt];
    if (spec.promptPosition === 'after-flag') {
        const args = [...headlessArgs, ...promptArgs, ...extraFlags];
        return spec.promptDelivery === 'stdin' ? { args, stdin: prompt } : { args };
    }
    const args = [...headlessArgs, ...extraFlags, ...promptArgs];
    return spec.promptDelivery === 'stdin' ? { args, stdin: prompt } : { args };
}
/**
 * Parse a CLI command string into its binary and flags.
 * e.g. 'claude --dangerously-skip-permissions --model claude-opus-4-7'
 *   → { binary: 'claude', flags: ['--dangerously-skip-permissions', '--model', 'claude-opus-4-7'] }
 */
function parseCliCommand(command) {
    const parts = command.trim().split(/\s+/);
    return { binary: parts[0], flags: parts.slice(1) };
}
function shellQuote(value) {
    if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value))
        return value;
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
