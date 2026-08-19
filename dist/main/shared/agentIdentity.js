"use strict";
/**
 * Stable, storage-facing agent identity helpers.
 *
 * Terminal runtime classification remains owned by terminal/contracts.ts.
 * This module only normalizes an already-known identifier or extracts the
 * executable from a user-configured startup command so history/filter UI does
 * not collapse every custom AI preset into the literal `custom` bucket.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeAgentId = normalizeAgentId;
exports.resolveAgentIdFromCommand = resolveAgentIdFromCommand;
exports.resolvePromptHistoryAgentId = resolvePromptHistoryAgentId;
const AGENT_ID_ALIASES = {
    'antigravity-cli': 'agy',
    antigravity: 'agy',
    agy: 'agy',
    'claude-code': 'claude',
    'claude-command': 'claude',
    // Cursor's CLI answers to both official spellings: `agent` is documented
    // and `cursor-agent` is the legacy alias. `agents` is the explicit
    // Windows-to-WSL bridge used by supported custom startup presets; it still
    // launches Cursor. Bare `cursor` is the editor launcher and stays absent.
    agent: 'cursor',
    agents: 'cursor',
    'cursor-agent': 'cursor',
    'gemini-cli': 'gemini',
    'grok-cli': 'grok',
    'hermes-agent': 'hermes',
    'kimi-code': 'kimi',
    // `npx @earendil-works/pi-coding-agent` normalizes to the package name;
    // the installed binary is plain `pi`.
    'pi-coding-agent': 'pi',
    'qwen-code': 'qwen',
};
const COMMAND_WRAPPERS = new Set(['command', 'exec']);
const PACKAGE_RUNNERS = new Set(['bunx', 'npx']);
function normalizeAgentId(rawAgentId) {
    if (!rawAgentId)
        return '';
    const normalized = normalizeExecutableToken(rawAgentId);
    const aliased = AGENT_ID_ALIASES[normalized];
    if (aliased)
        return aliased;
    // Hermes profiles install `hermes-<profile>` wrapper binaries
    // (hermes-opencode, hermes-cline, …) that exec the same TUI with another
    // backend — identity-wise they are hermes, and terminal adoption compares
    // this id against the `--to=hermes` target. Mirrors
    // terminal/contracts.ts getDeclaredAgentKind.
    if (normalized.startsWith('hermes-'))
        return 'hermes';
    return normalized;
}
/**
 * Resolve the CLI identity from the first command in a startup sequence.
 * Handles the wrappers the Startup Command form accepts most often (`env`,
 * `sudo`, `npx`/`bunx`, and `pnpm dlx`) while deliberately avoiding shell
 * evaluation. Unknown executables remain useful stable custom-agent ids.
 */
function resolveAgentIdFromCommand(rawCommand) {
    const tokens = getCommandTokens(rawCommand ?? '');
    if (tokens.length === 0)
        return null;
    let index = 0;
    if (normalizeExecutableToken(tokens[index]) === 'env')
        index += 1;
    while (tokens[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]))
        index += 1;
    if (normalizeExecutableToken(tokens[index]) === 'sudo') {
        index += 1;
        while (tokens[index]?.startsWith('-'))
            index += 1;
    }
    if (COMMAND_WRAPPERS.has(normalizeExecutableToken(tokens[index])))
        index += 1;
    let executable = tokens[index];
    const normalizedExecutable = normalizeExecutableToken(executable);
    if (PACKAGE_RUNNERS.has(normalizedExecutable)) {
        executable = tokens[index + 1];
    }
    else if (normalizedExecutable === 'pnpm' && tokens[index + 1]?.toLowerCase() === 'dlx') {
        executable = tokens[index + 2];
    }
    const agentId = normalizeAgentId(executable);
    return agentId || null;
}
function resolvePromptHistoryAgentId(input) {
    return (normalizeAgentId(input.declaredKind)
        || normalizeAgentId(input.inferredKind)
        || resolveAgentIdFromCommand(input.startupCommand)
        || normalizeAgentId(input.agentType)
        || 'custom');
}
function getCommandTokens(rawCommand) {
    const firstCommand = rawCommand.trim().split(/[;&|]/)[0]?.trim();
    if (!firstCommand)
        return [];
    return firstCommand.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
}
function normalizeExecutableToken(rawToken) {
    if (!rawToken)
        return '';
    return rawToken
        .trim()
        .replace(/^["']|["']$/g, '')
        .replace(/\\/g, '/')
        .replace(/^.*\//, '')
        .replace(/^@[^/]+\//, '')
        .replace(/^@/, '')
        .replace(/\.(?:cmd|exe)$/i, '')
        .replace(/[@#].*$/, '')
        .toLowerCase();
}
