"use strict";
/**
 * Build the shell snippet taught to host agents for invoking 1devtool-agent.
 *
 * Windows PowerShell 5 defaults `$OutputEncoding` to ASCII when piping text to
 * a native process. Without the explicit UTF-8 scope below, prompts containing
 * Vietnamese (and other non-ASCII text) reach the CLI with every unsupported
 * character already replaced by `?`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isWindowsOrchestrationShim = isWindowsOrchestrationShim;
exports.agentToolShellPrefersPosix = agentToolShellPrefersPosix;
exports.quotePosixShellArg = quotePosixShellArg;
exports.quotePowerShellArg = quotePowerShellArg;
exports.buildOrchestrationCommandSnippet = buildOrchestrationCommandSnippet;
exports.buildOrchestrationManifestSnippet = buildOrchestrationManifestSnippet;
exports.buildLinkSendCommandSnippet = buildLinkSendCommandSnippet;
exports.buildReportCommandSnippet = buildReportCommandSnippet;
exports.indentOrchestrationSnippet = indentOrchestrationSnippet;
function isWindowsOrchestrationShim(shimPath) {
    return /\.cmd$/i.test(shimPath.trim());
}
/**
 * Whether an agent's TOOL SHELL is POSIX on every platform. Claude Code's
 * Bash tool requires git-bash on Windows, so commands composed FOR it must be
 * POSIX even when the shim is a `.cmd` — the PowerShell form is unrunnable in
 * its shell. Everything else keeps the platform default (PowerShell on
 * Windows, per the UTF-8 delegation contract).
 */
function agentToolShellPrefersPosix(agentKind) {
    return agentKind === 'claude-command' || agentKind === 'claude';
}
function quotePosixShellArg(value) {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function quotePowerShellArg(value) {
    return `'${value.replace(/'/g, "''")}'`;
}
function buildOrchestrationCommandSnippet(shimPath, target, model) {
    const modelArg = model ? ` --model=${model}` : '';
    if (!isWindowsOrchestrationShim(shimPath)) {
        return `printf '%s' "$TASK" | ${quotePosixShellArg(shimPath)} run --to=${target}${modelArg} --prompt-stdin`;
    }
    const quotedShim = quotePowerShellArg(shimPath);
    return [
        '$previousOutputEncoding = $OutputEncoding',
        'try {',
        '  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
        `  $TASK | & ${quotedShim} run --to=${target}${modelArg} --prompt-stdin`,
        '} finally {',
        '  $OutputEncoding = $previousOutputEncoding',
        '}',
    ].join('\n');
}
function buildOrchestrationManifestSnippet(shimPath, topology) {
    if (!isWindowsOrchestrationShim(shimPath)) {
        return `printf '%s' "$MANIFEST" | ${quotePosixShellArg(shimPath)} ${topology} start --manifest-stdin`;
    }
    return [
        '$previousOutputEncoding = $OutputEncoding',
        'try {',
        '  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
        `  $MANIFEST | & ${quotePowerShellArg(shimPath)} ${topology} start --manifest-stdin`,
        '} finally {',
        '  $OutputEncoding = $previousOutputEncoding',
        '}',
    ].join('\n');
}
/**
 * Build the platform-correct stdin pipe for a Terminal Link delivery.
 *
 * Keep this beside the Team/Swarm command builders: link nudges, Agent Input,
 * and the CLI's fail-fast guard are three projections of the same command
 * contract and must not drift back to POSIX-only prose on Windows.
 */
function buildLinkSendCommandSnippet(shimPath, terminalId, inputVariable = '$MSG', options = {}) {
    const replyFlag = options.replyToMessageId ? ` --reply-to=${options.replyToMessageId}` : '';
    const tokenFlag = options.replyToken ? ` --reply-token=${options.replyToken}` : '';
    const gateFlag = options.gateDecision ? ` --gate=${options.gateDecision}` : '';
    if (options.posixShell === true || !isWindowsOrchestrationShim(shimPath)) {
        return `printf '%s' "${inputVariable}" | ${quotePosixShellArg(shimPath)} link send --to=${terminalId}${replyFlag}${tokenFlag}${gateFlag} --prompt-stdin --wait`;
    }
    return [
        '$previousOutputEncoding = $OutputEncoding',
        'try {',
        '  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
        `  ${inputVariable} | & ${quotePowerShellArg(shimPath)} link send --to=${terminalId}${replyFlag}${tokenFlag}${gateFlag} --prompt-stdin --wait`,
        '} finally {',
        '  $OutputEncoding = $previousOutputEncoding',
        '}',
    ].join('\n');
}
/**
 * Build the platform-correct stdin pipe for a hierarchy report (v5 §7.1).
 * The verb resolves the caller's seat in main — agents never need to know
 * their manager's terminal id.
 */
function buildReportCommandSnippet(shimPath, options = {}) {
    const blockedFlag = options.blocked ? ' --blocked' : '';
    const continueFlag = options.continueFromMessageId ? ` --continue=${options.continueFromMessageId}` : '';
    const completeFlag = options.complete ? ' --complete' : '';
    if (options.posixShell === true || !isWindowsOrchestrationShim(shimPath)) {
        if (options.complete)
            return `${quotePosixShellArg(shimPath)} report --complete`;
        return `printf '%s' "$MSG" | ${quotePosixShellArg(shimPath)} report${blockedFlag}${continueFlag} --prompt-stdin --wait`;
    }
    return [
        '$previousOutputEncoding = $OutputEncoding',
        'try {',
        '  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
        ...(options.complete
            ? [`  & ${quotePowerShellArg(shimPath)} report --complete`]
            : [`  $MSG | & ${quotePowerShellArg(shimPath)} report${blockedFlag}${continueFlag} --prompt-stdin --wait`]),
        '} finally {',
        '  $OutputEncoding = $previousOutputEncoding',
        '}',
    ].join('\n');
}
function indentOrchestrationSnippet(snippet, spaces = 4) {
    const prefix = ' '.repeat(spaces);
    return snippet.split('\n').map((line) => `${prefix}${line}`).join('\n');
}
