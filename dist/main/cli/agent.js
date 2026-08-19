#!/usr/bin/env node
"use strict";
/**
 * 1devtool-agent — standalone CLI that delegates a prompt to another installed
 * AI coding CLI (Claude, Codex, Gemini, Antigravity, Cline, OpenCode, Amp, Qwen, Aider).
 *
 * Pure Node. No Electron imports. Reads `~/.1devtool/state/cli-registry.json`
 * for detected-CLI state; falls back to a slim `which` scan when the cache
 * is missing/stale.
 *
 * Security contract (Phase 1 of using_skills_plan.md):
 * - Prompt input is stdin-only (`--prompt-stdin`) or a file (`--prompt-file <path>`).
 * - There is no `--prompt=<text>` argv flag — shell substitution happens before
 *   argv parsing, so accepting prompt text via argv would let a calling agent
 *   leak credentials through `$()`/backtick interpolation.
 * - Spawn is `execFile`, never a shell, so user prompt content never reaches
 *   a shell interpreter.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_util_1 = require("node:util");
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_child_process_1 = require("node:child_process");
const runHeadlessAgent_1 = require("../main/orchestration/runHeadlessAgent");
const headlessMode_1 = require("../shared/headlessMode");
const agentModels_1 = require("../shared/agentModels");
const bridgeNotify_1 = require("./bridgeNotify");
const orchestrationRuns_1 = require("../shared/orchestrationRuns");
const orchestrationShim_1 = require("../shared/orchestrationShim");
const linkGuard_1 = require("./linkGuard");
const runLog_1 = require("./runLog");
const interactiveDelegation_1 = require("../shared/interactiveDelegation");
const hookCapability_1 = require("../main/orchestration/hookCapability");
const terminalAttachClient_1 = require("./terminalAttachClient");
const sshTerminalHost_1 = require("./sshTerminalHost");
const KNOWN_AGENT_IDS = Object.keys(headlessMode_1.HEADLESS_SPECS);
const CACHE_PATH = node_path_1.default.join(node_os_1.default.homedir(), '.1devtool', 'state', 'cli-registry.json');
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
function readCache() {
    try {
        if (!node_fs_1.default.existsSync(CACHE_PATH))
            return null;
        const raw = node_fs_1.default.readFileSync(CACHE_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Date.now() - parsed.writtenAt > CACHE_MAX_AGE_MS)
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
function slimResolveBinary(agentId, cache) {
    const spec = headlessMode_1.HEADLESS_SPECS[agentId];
    if (!spec)
        return null;
    // Prefer the registry's own binary list (it knows every spelling — Cursor
    // answers to both `agent` and `cursor-agent`), and fall back to the spec's
    // binary alone. The agent ID is deliberately NOT a candidate: for Cursor it
    // is `cursor`, which names the editor launcher, so guessing it would spawn
    // the wrong program on a machine this slim path is already struggling with.
    const known = cache?.knownClis.find((c) => c.id === agentId);
    const candidates = (known?.binaries?.length ? known.binaries : [spec.cliId])
        .filter((v, i, a) => a.indexOf(v) === i);
    const isWin = process.platform === 'win32';
    for (const bin of candidates) {
        try {
            const which = isWin
                ? (0, node_child_process_1.execFileSync)('cmd.exe', ['/c', 'where', bin], { encoding: 'utf-8', timeout: 5000, windowsHide: true })
                : (0, node_child_process_1.execFileSync)(process.env.SHELL || '/bin/sh', ['-lc', `command -v ${bin}`], { encoding: 'utf-8', timeout: 5000 });
            // On Windows, `where` lists the extension-less npm POSIX script first.
            // Prefer a real CreateProcess target (.cmd/.exe/.bat) so headless spawn
            // does not die with EINVAL (docs/common-errors/cli/windows-npm-shim-unverified.md).
            const lines = which.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            const ranked = isWin
                ? [...lines].sort((a, b) => windowsBinaryRank(a) - windowsBinaryRank(b))
                : lines;
            for (const line of ranked) {
                if (node_fs_1.default.existsSync(line)) {
                    return { path: line, version: null };
                }
            }
        }
        catch { /* try next candidate */ }
    }
    return null;
}
/** Lower rank = better CreateProcess target. Extension-less npm shims last. */
function windowsBinaryRank(filePath) {
    const ext = node_path_1.default.extname(filePath).toLowerCase();
    if (ext === '.exe' || ext === '.com')
        return 0;
    if (ext === '.cmd' || ext === '.bat')
        return 1;
    if (ext === '.ps1')
        return 2;
    return 3;
}
function resolveBinaryPath(agentId) {
    const cache = readCache();
    if (cache) {
        const reg = cache.registrations.find((r) => r.cliId === agentId);
        if (reg && (reg.state === 'detected' || reg.state === 'override') && reg.selectedPath) {
            return { path: reg.selectedPath, version: reg.version };
        }
    }
    return slimResolveBinary(agentId, cache);
}
function listAgents(jsonOut) {
    const cache = readCache();
    const rows = [];
    if (cache) {
        for (const reg of cache.registrations) {
            const known = cache.knownClis.find((c) => c.id === reg.cliId);
            if (known?.category && known.category !== 'ai-agent')
                continue;
            rows.push({ id: reg.cliId, status: reg.state, version: reg.version, path: reg.selectedPath });
        }
    }
    else {
        // No cache — probe each known agent.
        for (const id of KNOWN_AGENT_IDS) {
            const resolved = slimResolveBinary(id, cache);
            rows.push({
                id,
                status: resolved ? 'detected' : 'not-found',
                version: resolved?.version ?? null,
                path: resolved?.path ?? null,
            });
        }
    }
    if (jsonOut) {
        process.stdout.write(JSON.stringify({ agents: rows }, null, 2) + '\n');
        return;
    }
    for (const row of rows) {
        const ver = row.version ? `  v${row.version}` : '';
        const where = row.path ? `  ${row.path}` : '';
        process.stdout.write(`${row.status.padEnd(10)}  ${row.id}${ver}${where}\n`);
    }
}
function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', (chunk) => { data += chunk; });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
    });
}
function isAbsolutePath(p) {
    if (!p)
        return false;
    return p.startsWith('/') || /^[A-Z]:[\\/]/i.test(p);
}
async function readPromptFile(filePath) {
    // Refuse symlinks; refuse files outside cwd / $TMPDIR (mitigates SSRF-via-file).
    const resolved = node_path_1.default.resolve(filePath);
    const lstat = node_fs_1.default.lstatSync(resolved);
    if (lstat.isSymbolicLink()) {
        throw new Error('--prompt-file refuses symlinks');
    }
    const cwd = node_path_1.default.resolve(process.cwd());
    const tmp = node_path_1.default.resolve(node_os_1.default.tmpdir());
    if (!resolved.startsWith(cwd) && !resolved.startsWith(tmp)) {
        throw new Error('--prompt-file must be inside cwd or $TMPDIR');
    }
    return node_fs_1.default.readFileSync(resolved, 'utf-8');
}
async function runAgentCommand(opts) {
    const to = opts.to;
    if (!to || !KNOWN_AGENT_IDS.includes(to)) {
        process.stderr.write(`error: --to must be one of: ${KNOWN_AGENT_IDS.join(', ')}\n`);
        process.exit(2);
    }
    if (!opts.promptStdin && !opts.promptFile) {
        process.stderr.write('error: prompt input is required\n' +
            '  use --prompt-stdin to pipe the prompt:  printf \'%s\' "$TASK" | 1devtool-agent run --to=' + to + ' --prompt-stdin\n' +
            '  or --prompt-file=<path> to read from a file (must be in cwd or $TMPDIR; symlinks rejected)\n' +
            '\n' +
            '  there is no --prompt=<text> flag — argv prompts are unsafe because\n' +
            '  shell substitution happens before this CLI sees them.\n');
        process.exit(2);
    }
    if (opts.promptStdin && opts.promptFile) {
        process.stderr.write('error: pass either --prompt-stdin or --prompt-file, not both\n');
        process.exit(2);
    }
    const prompt = opts.promptStdin ? await readStdin() : await readPromptFile(opts.promptFile);
    if (!prompt.trim()) {
        process.stderr.write('error: prompt is empty\n');
        process.exit(2);
    }
    // --model maps to the target CLI's own model flag (always argv via execFile,
    // never a shell). Reject unsupported agents / malformed ids up front so the
    // error is actionable instead of a cryptic target-CLI failure.
    let modelFlags = [];
    if (opts.model) {
        if (!agentModels_1.AGENT_MODEL_SPECS[to]) {
            process.stderr.write(`error: agent "${to}" does not support --model\n`);
            process.exit(2);
        }
        if (!(0, agentModels_1.isValidModelId)(opts.model)) {
            process.stderr.write(`error: --model value "${opts.model}" is not a valid model id\n`);
            process.exit(2);
        }
        modelFlags = (0, agentModels_1.buildModelFlags)(to, opts.model) ?? [];
    }
    // --category is cooperative run-attribution metadata (recorded verbatim in
    // the run record, shown as a chip in the dashboard). Emitted by the compiled
    // routing table; never inferred from prompt text.
    if (opts.category !== undefined && !(0, orchestrationRuns_1.isValidRunCategory)(opts.category)) {
        process.stderr.write('error: --category must match ^[a-z][a-z0-9-]{1,23}$\n');
        process.exit(2);
    }
    if (opts.skill && !opts.interactive && !opts.terminal) {
        process.stderr.write('error: --skill requires --terminal (or legacy --interactive)\n');
        process.exit(2);
    }
    if (opts.skill && !(0, interactiveDelegation_1.isValidInteractiveSkillCommand)(opts.skill)) {
        process.stderr.write('error: --skill must be a slash command such as /chrome\n');
        process.exit(2);
    }
    if ((opts.interactive || opts.terminal) && (opts.flag?.length ?? 0) > 0) {
        process.stderr.write('error: --flag is not accepted with --interactive; configure interactive startup flags in Terminal Settings instead\n');
        process.exit(2);
    }
    if (opts.interactive && opts.terminal) {
        process.stderr.write('error: pass either --terminal or --interactive, not both\n');
        process.exit(2);
    }
    if (opts.wait && !opts.terminal) {
        process.stderr.write('error: --wait requires --terminal\n');
        process.exit(2);
    }
    const cwd = opts.cwd && isAbsolutePath(opts.cwd) ? opts.cwd : process.cwd();
    const timeoutSeconds = opts.timeout ? Number(opts.timeout) : runHeadlessAgent_1.HEADLESS_DEFAULT_TIMEOUT_S;
    if (Number.isNaN(timeoutSeconds)) {
        process.stderr.write('error: --timeout must be a number\n');
        process.exit(2);
    }
    const normalizedTimeoutS = Math.min(Math.max(timeoutSeconds, runHeadlessAgent_1.HEADLESS_MIN_TIMEOUT_S), runHeadlessAgent_1.HEADLESS_MAX_TIMEOUT_S);
    const displayCommand = `1devtool-agent run --to=${to}` +
        (opts.model ? ` --model=${opts.model}` : '') +
        (opts.category ? ` --category=${opts.category}` : '') +
        (opts.interactive ? ' --interactive' : '') +
        (opts.terminal ? ' --terminal' : '') +
        (opts.wait ? ' --wait' : '') +
        (opts.skill ? ` --skill=${opts.skill}` : '');
    // Durable run record (docs/features/orchestration/dashboard.md §4.2). Minted BEFORE
    // binary resolution so the not-installed exit is capturable; every write is
    // best-effort and can never fail the delegation.
    const callId = node_crypto_1.default.randomUUID();
    const runLog = (0, runLog_1.startRunLog)({
        callId,
        target: to,
        category: opts.category,
        model: opts.model,
        command: displayCommand,
        cwd,
        hostTerminalId: process.env.ONEDEVTOOL_TERMINAL_ID,
        startedAt: Date.now(),
        timeoutSeconds: normalizedTimeoutS,
        prompt,
    });
    const resolved = resolveBinaryPath(to);
    if (!resolved) {
        runLog.finalize({ status: 'not-installed', endedAt: Date.now(), exitCode: 3 });
        process.stderr.write(`error: agent "${to}" is not installed or not found on this system.\n` +
            `       run \`1devtool-agent list\` to see what's available.\n`);
        process.exit(3);
    }
    const controller = new AbortController();
    process.on('SIGTERM', () => controller.abort());
    process.on('SIGINT', () => controller.abort());
    // Run the link preflight BEFORE announcing delegation start. A guarded
    // headless attempt is not a sub-agent lifecycle; emitting start and then
    // exiting here would leave a stale/flickering SubAgentBadge.
    if (!opts.terminal &&
        !opts.interactive &&
        !opts.noLink &&
        process.env.ONEDEVTOOL_TERMINAL_ID) {
        let whoami = null;
        try {
            whoami = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/whoami', {}, 3_000);
        }
        catch { /* fail open */ }
        const linked = (0, linkGuard_1.findLinkedPeersForAgent)(whoami, to);
        if (linked.length > 0) {
            const shimPath = node_path_1.default.join(node_os_1.default.homedir(), '.1devtool', 'bin', process.platform === 'win32' ? orchestrationShim_1.ORCHESTRATOR_SHIM_NAME_WIN : orchestrationShim_1.ORCHESTRATOR_SHIM_NAME_UNIX);
            const message = (0, linkGuard_1.formatLinkGuardError)(linked, to, shimPath);
            runLog.finalize({ status: 'error', endedAt: Date.now(), exitCode: 1, stderr: message });
            if (opts.json) {
                process.stdout.write(JSON.stringify({
                    agent: to,
                    ok: false,
                    error: message,
                    linkedTerminalIds: linked.map((row) => row.peerTerminalId),
                }, null, 2) + '\n');
            }
            else {
                process.stderr.write(`error: ${message}\n`);
            }
            process.exit(1);
        }
    }
    // Report delegation start/end to running 1DevTool instances so the calling
    // terminal shows a SubAgentBadge. Best-effort: no app running → no-op; a
    // slow bridge costs at most ~400ms. This event is the ONLY reliable badge
    // signal — host TUIs collapse multi-line commands, so the app's transcript
    // scan can't see `--to=<agent>`.
    const notifier = (0, bridgeNotify_1.createDelegationNotifier)({
        callId,
        target: to,
        command: displayCommand,
        timeoutSeconds: normalizedTimeoutS,
    });
    await notifier.start();
    try {
        if (opts.terminal) {
            const activationSkill = opts.skill
                ?? (opts.category === interactiveDelegation_1.BROWSER_ROUTING_CATEGORY ? interactiveDelegation_1.DEFAULT_BROWSER_SKILL_COMMAND : undefined);
            const started = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/team/start', {
                clientRequestId: callId,
                members: [{
                        target: to,
                        prompt,
                        ...(opts.category ? { category: opts.category } : {}),
                        ...(opts.model ? { model: opts.model } : {}),
                        substrate: 'terminal',
                        ...(activationSkill ? { skill: activationSkill } : {}),
                    }],
                defaultSubstrate: 'terminal',
            });
            if (started.ok !== true) {
                const error = typeof started.error === 'string' ? started.error : '1DevTool could not start the terminal delegate';
                await notifier.end('error', 1);
                runLog.finalize({ status: 'error', endedAt: Date.now(), exitCode: 1, stderr: error });
                process.stderr.write(`error: ${error}\n`);
                process.exit(1);
            }
            const runs = Array.isArray(started.runs) ? started.runs : [];
            const runId = typeof runs[0]?.runId === 'string' ? runs[0].runId : '';
            if (!runId) {
                await notifier.end('error', 1);
                runLog.finalize({ status: 'error', endedAt: Date.now(), exitCode: 1, stderr: 'Controller returned no runId' });
                process.stderr.write('error: Agent Team controller returned no runId\n');
                process.exit(1);
            }
            if (!opts.wait) {
                const output = `Opened ${to} in Agent Team run ${runId}. Use collect --run=${runId} to retrieve the result.`;
                await notifier.end('done', 0);
                runLog.finalize({ status: 'done', endedAt: Date.now(), exitCode: 0, output });
                process.stdout.write(opts.json ? JSON.stringify({ ok: true, terminal: true, runId, output }, null, 2) + '\n' : output + '\n');
                process.exit(0);
            }
            const collected = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/collect/run', {
                runId,
                timeoutMs: normalizedTimeoutS * 1000,
            }, normalizedTimeoutS * 1000 + 5_000);
            const output = typeof collected.output === 'string'
                ? collected.output
                : collected.stillRunning === true
                    ? `Agent Team run ${runId} is still running. Re-run collect --run=${runId}.`
                    : typeof collected.error === 'string' ? collected.error : '(no output)';
            const ok = collected.ok === true || collected.stillRunning === true;
            await notifier.end(ok ? 'done' : 'error', ok ? 0 : 1);
            runLog.finalize({
                // This CLI wrapper invocation is complete even when the durable
                // controller run continues; the controller owns that run's record.
                status: ok ? 'done' : 'error',
                endedAt: Date.now(),
                exitCode: ok ? 0 : 1,
                output,
            });
            process.stdout.write(opts.json ? JSON.stringify({ ...collected, runId }, null, 2) + '\n' : output + (output.endsWith('\n') ? '' : '\n'));
            process.exit(ok ? 0 : 1);
        }
        if (opts.interactive) {
            const activationCommand = opts.skill
                ?? (opts.category === interactiveDelegation_1.BROWSER_ROUTING_CATEGORY ? interactiveDelegation_1.DEFAULT_BROWSER_SKILL_COMMAND : undefined);
            const handoff = await (0, bridgeNotify_1.requestInteractiveDelegation)({
                callId,
                target: to,
                category: opts.category,
                model: opts.model,
                prompt,
                cwd,
                activationCommand,
            });
            if (!handoff.ok) {
                await notifier.end('error', 1);
                runLog.finalize({ status: 'error', endedAt: Date.now(), exitCode: 1, stderr: handoff.error });
                if (opts.json) {
                    process.stdout.write(JSON.stringify({ agent: to, interactive: true, ...handoff }, null, 2) + '\n');
                }
                else {
                    process.stderr.write(`error: ${handoff.error}\n`);
                }
                process.exit(1);
            }
            const output = handoff.message
                ?? `Opened ${to} in interactive 1DevTool terminal ${handoff.terminalId}.`;
            await notifier.end('done', 0);
            runLog.finalize({ status: 'done', endedAt: Date.now(), exitCode: 0, output });
            if (opts.json) {
                process.stdout.write(JSON.stringify({
                    agent: to,
                    interactive: true,
                    terminalId: handoff.terminalId,
                    output,
                    exitCode: 0,
                }, null, 2) + '\n');
            }
            else {
                process.stdout.write(output + '\n');
            }
            process.exit(0);
        }
        const result = await (0, runHeadlessAgent_1.runHeadlessAgent)({
            agentId: to,
            prompt,
            flags: [...modelFlags, ...(opts.flag ?? [])],
            timeoutSeconds,
            cwd,
            binaryPath: resolved.path,
            signal: controller.signal,
            terminalId: process.env.ONEDEVTOOL_TERMINAL_ID,
        });
        await notifier.end(result.exitCode === 0 ? 'done' : 'error', result.exitCode);
        runLog.finalize({
            status: result.timedOut ? 'timeout' : result.exitCode === 0 ? 'done' : 'error',
            endedAt: Date.now(),
            exitCode: result.exitCode,
            output: result.output,
            stderr: result.rawStderr ?? result.stderr,
            truncated: result.truncated,
        });
        if (opts.json) {
            process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        }
        else {
            process.stdout.write(result.output);
            if (!result.output.endsWith('\n'))
                process.stdout.write('\n');
            if (result.exitCode !== 0 && result.stderr) {
                process.stderr.write(result.stderr + '\n');
            }
        }
        process.exit(typeof result.exitCode === 'number' ? result.exitCode : 1);
    }
    catch (error) {
        await notifier.end('error');
        const message = error instanceof Error ? error.message : String(error);
        runLog.finalize({ status: 'error', endedAt: Date.now(), stderr: message });
        process.stderr.write(`error: ${message}\n`);
        process.exit(1);
    }
}
async function readStructuredInput(opts) {
    if (Boolean(opts.manifestStdin) === Boolean(opts.manifestFile)) {
        throw new Error('pass exactly one of --manifest-stdin or --manifest-file');
    }
    const text = opts.manifestStdin ? await readStdin() : await readPromptFile(opts.manifestFile);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('manifest must be a JSON object');
    return parsed;
}
function printJson(value) {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}
async function runControlCommand(subcommand, rest) {
    if (subcommand === 'hook-event') {
        const { values, positionals } = (0, node_util_1.parseArgs)({
            args: rest,
            options: {
                event: { type: 'string' },
                'payload-stdin': { type: 'boolean' },
                'payload-argv': { type: 'boolean' },
            },
            allowPositionals: true,
            strict: true,
        });
        const event = values.event;
        if (event !== 'done' && event !== 'needs-input')
            return true;
        const terminalId = process.env.ONEDEVTOOL_TERMINAL_ID;
        if (!terminalId)
            return true;
        const capability = (0, hookCapability_1.readHookCapability)(node_os_1.default.homedir(), terminalId);
        const raw = values['payload-stdin'] === true
            ? await readStdin()
            : values['payload-argv'] === true ? positionals[positionals.length - 1] ?? '{}' : '{}';
        let payload = {};
        try {
            const parsed = JSON.parse(raw || '{}');
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
                payload = parsed;
        }
        catch {
            return true;
        }
        const notificationType = payload.type ?? payload.event;
        if (notificationType && !['agent-turn-complete', 'Stop', 'stop'].includes(String(notificationType)))
            return true;
        const sessionId = payload.session_id ?? payload['thread-id'] ?? payload.thread_id;
        const output = payload.last_assistant_message ?? payload['last-assistant-message'];
        if (!capability) {
            // Non-Team terminal (no armed capability file). The hook still carries
            // the richest turn-done data available — Codex's last-assistant-message,
            // Claude's session id — so feed the advisory attention inbox
            // (orchestration v4 L6) instead of discarding it. Fire-and-forget with
            // a short timeout: a hook must never delay the agent, and a dead bridge
            // is a silent no-op exactly like the old gate.
            if (event === 'done') {
                try {
                    await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/terminal-hook-event', {
                        event,
                        ...(typeof sessionId === 'string' ? { sessionId } : {}),
                        ...(typeof output === 'string' ? { output } : {}),
                    }, 3_000);
                }
                catch { /* advisory only */ }
            }
            return true;
        }
        await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/hook-event', {
            runId: capability.runId,
            capabilityToken: capability.capabilityToken,
            event,
            ...(typeof sessionId === 'string' ? { sessionId } : {}),
            ...(typeof output === 'string' ? { output } : {}),
        }, 5_000);
        return true;
    }
    if (subcommand === 'team' || subcommand === 'swarm') {
        const action = rest[0];
        const args = rest.slice(1);
        if (action === 'start') {
            const { values } = (0, node_util_1.parseArgs)({
                args,
                options: {
                    'manifest-stdin': { type: 'boolean' },
                    'manifest-file': { type: 'string' },
                    'client-request-id': { type: 'string' },
                },
                allowPositionals: false,
                strict: true,
            });
            const manifest = await readStructuredInput({
                manifestStdin: values['manifest-stdin'] === true,
                manifestFile: values['manifest-file'],
            });
            if (typeof manifest.clientRequestId !== 'string' || !manifest.clientRequestId) {
                manifest.clientRequestId = values['client-request-id'] ?? node_crypto_1.default.randomUUID();
            }
            const result = await (0, bridgeNotify_1.requestAgentOrchestration)(subcommand === 'team' ? '/orchestration/team/start' : '/orchestration/swarm/start', manifest);
            printJson(result);
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (action === 'status') {
            const optionName = subcommand === 'team' ? 'team' : 'swarm';
            const { values } = (0, node_util_1.parseArgs)({
                args,
                options: { [optionName]: { type: 'string' } },
                allowPositionals: false,
                strict: true,
            });
            const orchestrationId = values[optionName];
            if (!orchestrationId)
                throw new Error(`--${optionName}=<id> is required`);
            const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/status', { orchestrationId });
            printJson(result);
            process.exitCode = result.ok === true && result.orchestration ? 0 : 1;
            return true;
        }
        if (subcommand === 'swarm' && (action === 'pause' || action === 'resume')) {
            const { values } = (0, node_util_1.parseArgs)({
                args,
                options: { swarm: { type: 'string' } },
                allowPositionals: false,
                strict: true,
            });
            if (!values.swarm)
                throw new Error('--swarm=<id> is required');
            const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/swarm/pause', {
                swarmId: values.swarm,
                paused: action === 'pause',
            });
            printJson(result);
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (subcommand === 'team' && action === 'list') {
            (0, node_util_1.parseArgs)({ args, options: {}, allowPositionals: false, strict: true });
            const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/team/list', {});
            printJson(result);
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (subcommand === 'team' && action === 'peers') {
            const { values } = (0, node_util_1.parseArgs)({
                args,
                options: { team: { type: 'string' }, json: { type: 'boolean' } },
                allowPositionals: false,
                strict: true,
            });
            if (!values.team)
                throw new Error('--team=<id> is required');
            const result = await (0, bridgeNotify_1.requestPeerAuthenticatedOrchestration)('team-peers', {
                teamId: values.team,
            });
            void values.json;
            printJson(result);
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (subcommand === 'team' && action === 'read') {
            const { values } = (0, node_util_1.parseArgs)({
                args,
                options: {
                    team: { type: 'string' },
                    from: { type: 'string' },
                    lines: { type: 'string' },
                    full: { type: 'boolean' },
                    json: { type: 'boolean' },
                },
                allowPositionals: false,
                strict: true,
            });
            if (!values.team || !values.from) {
                throw new Error('--team=<id> and --from=<memberId> are required (see `1devtool-agent team peers`)');
            }
            if (values.full === true && values.lines !== undefined) {
                throw new Error('--lines cannot be combined with --full');
            }
            const maxLines = values.lines === undefined ? undefined : Number(values.lines);
            if (maxLines !== undefined && (!Number.isInteger(maxLines) || maxLines < 1)) {
                throw new Error('--lines must be a positive integer');
            }
            const result = await (0, bridgeNotify_1.requestPeerAuthenticatedOrchestration)('team-read', {
                teamId: values.team,
                targetMemberId: values.from,
                ...(maxLines !== undefined ? { maxLines } : {}),
                ...(values.full === true ? { full: true } : {}),
            });
            if (values.json === true || result.ok !== true || typeof result.body !== 'string') {
                printJson(result);
            }
            else {
                process.stdout.write(result.body + (result.body.endsWith('\n') ? '' : '\n'));
            }
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (subcommand === 'team' && action === 'screen') {
            const { values } = (0, node_util_1.parseArgs)({
                args,
                options: {
                    team: { type: 'string' },
                    from: { type: 'string' },
                    rows: { type: 'string' },
                    json: { type: 'boolean' },
                },
                allowPositionals: false,
                strict: true,
            });
            if (!values.team || !values.from) {
                throw new Error('--team=<id> and --from=<memberId> are required (see `1devtool-agent team peers`)');
            }
            const rows = values.rows === undefined ? undefined : Number(values.rows);
            if (rows !== undefined && (!Number.isInteger(rows) || rows < 1)) {
                throw new Error('--rows must be a positive integer');
            }
            const result = await (0, bridgeNotify_1.requestPeerAuthenticatedOrchestration)('team-screen', {
                teamId: values.team,
                targetMemberId: values.from,
                ...(rows !== undefined ? { rows } : {}),
            });
            if (values.json === true || result.ok !== true || typeof result.body !== 'string') {
                printJson(result);
            }
            else {
                process.stdout.write(result.body + (result.body.endsWith('\n') ? '' : '\n'));
            }
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (subcommand === 'team' && action === 'notes') {
            const { values } = (0, node_util_1.parseArgs)({
                args,
                options: {
                    team: { type: 'string' },
                    from: { type: 'string' },
                    lines: { type: 'string' },
                    json: { type: 'boolean' },
                },
                allowPositionals: false,
                strict: true,
            });
            if (!values.team || !values.from) {
                throw new Error('--team=<id> and --from=<memberId> are required (see `1devtool-agent team peers`)');
            }
            const maxLines = values.lines === undefined ? undefined : Number(values.lines);
            if (maxLines !== undefined && (!Number.isInteger(maxLines) || maxLines < 1)) {
                throw new Error('--lines must be a positive integer');
            }
            const result = await (0, bridgeNotify_1.requestPeerAuthenticatedOrchestration)('team-notes', {
                teamId: values.team,
                targetMemberId: values.from,
                ...(maxLines !== undefined ? { maxLines } : {}),
            });
            if (values.json === true || result.ok !== true || typeof result.body !== 'string') {
                printJson(result);
            }
            else {
                process.stdout.write(result.body + (result.body.endsWith('\n') ? '' : '\n'));
            }
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (subcommand === 'team' && action === 'peek') {
            const { values } = (0, node_util_1.parseArgs)({
                args,
                options: {
                    team: { type: 'string' },
                    from: { type: 'string' },
                    'changed-since': { type: 'string' },
                    json: { type: 'boolean' },
                },
                allowPositionals: false,
                strict: true,
            });
            if (!values.team || !values.from) {
                throw new Error('--team=<id> and --from=<memberId> are required (see `1devtool-agent team peers`)');
            }
            const result = await (0, bridgeNotify_1.requestPeerAuthenticatedOrchestration)('team-peek', {
                teamId: values.team,
                targetMemberId: values.from,
                ...(values['changed-since'] ? { changedSince: values['changed-since'] } : {}),
            });
            printJson(result);
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (subcommand === 'team' && (action === 'members' || action === 'connections')) {
            const { values } = (0, node_util_1.parseArgs)({
                args,
                options: { team: { type: 'string' } },
                allowPositionals: false,
                strict: true,
            });
            if (!values.team)
                throw new Error('--team=<id> is required');
            const result = await (0, bridgeNotify_1.requestAgentOrchestration)(`/orchestration/team/${action}`, { teamId: values.team });
            printJson(result);
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (subcommand === 'team' && (action === 'send' || action === 'ask')) {
            const { values } = (0, node_util_1.parseArgs)({
                args,
                options: {
                    team: { type: 'string' }, to: { type: 'string' },
                    'submission-id': { type: 'string' }, timeout: { type: 'string' },
                    'prompt-stdin': { type: 'boolean' }, 'prompt-file': { type: 'string' },
                },
                allowPositionals: false,
                strict: true,
            });
            if (!values.team || !values.to)
                throw new Error('--team=<id> and --to=<memberId> are required');
            const promptStdin = values['prompt-stdin'] === true;
            const promptFile = values['prompt-file'];
            if (promptStdin === (promptFile !== undefined))
                throw new Error('pass exactly one of --prompt-stdin or --prompt-file');
            const body = promptStdin ? await readStdin() : await readPromptFile(promptFile);
            if (!body.trim())
                throw new Error('prompt is empty');
            const timeoutS = Math.min(Math.max(Number(values.timeout ?? 0) || 0, 0), runHeadlessAgent_1.HEADLESS_MAX_TIMEOUT_S);
            const result = await (0, bridgeNotify_1.requestAgentOrchestration)(`/orchestration/team/${action}`, {
                teamId: values.team,
                toMemberId: values.to,
                clientSubmissionId: values['submission-id'] ?? node_crypto_1.default.randomUUID(),
                body,
                ...(action === 'ask' ? { timeoutMs: timeoutS * 1000 } : {}),
            }, action === 'ask' ? timeoutS * 1000 + 5_000 : undefined);
            printJson(result);
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (subcommand === 'team' && action === 'reply') {
            const { values } = (0, node_util_1.parseArgs)({
                args,
                options: {
                    message: { type: 'string' }, 'submission-id': { type: 'string' },
                    'prompt-stdin': { type: 'boolean' }, 'prompt-file': { type: 'string' },
                },
                allowPositionals: false,
                strict: true,
            });
            if (!values.message)
                throw new Error('--message=<messageId> is required');
            const promptStdin = values['prompt-stdin'] === true;
            const promptFile = values['prompt-file'];
            if (promptStdin === (promptFile !== undefined))
                throw new Error('pass exactly one of --prompt-stdin or --prompt-file');
            const body = promptStdin ? await readStdin() : await readPromptFile(promptFile);
            if (!body.trim())
                throw new Error('prompt is empty');
            const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/team/reply', {
                messageId: values.message,
                clientSubmissionId: values['submission-id'] ?? node_crypto_1.default.randomUUID(),
                body,
            });
            printJson(result);
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (subcommand === 'team' && action === 'messages') {
            const { values } = (0, node_util_1.parseArgs)({
                args,
                options: { team: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'string' } },
                allowPositionals: false,
                strict: true,
            });
            if (!values.team)
                throw new Error('--team=<id> is required');
            const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/team/messages', {
                teamId: values.team,
                cursor: Math.max(0, Number(values.cursor ?? 0) || 0),
                limit: Math.min(Math.max(Number(values.limit ?? 50) || 50, 1), 100),
            });
            printJson(result);
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        throw new Error(`${subcommand} requires "start", "status"${subcommand === 'swarm' ? ', "pause", or "resume"' : ', "peers", "read", "screen", "notes", or "peek"'}`);
    }
    if (subcommand === 'whoami') {
        (0, node_util_1.parseArgs)({ args: rest, options: {}, allowPositionals: false, strict: true });
        if (!process.env.ONEDEVTOOL_TERMINAL_ID) {
            printJson({
                ok: true,
                session: false,
                message: 'not a 1DevTool session — nothing to report',
            });
            process.exitCode = 0;
            return true;
        }
        const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/whoami', {});
        printJson(result);
        process.exitCode = result.ok === true ? 0 : 1;
        return true;
    }
    // Hierarchy report (orchestration v5 §7.1): send to the caller's
    // configured manager — main resolves the seat, so agents never need to
    // know their manager's terminal id. `--blocked` marks an escalation.
    if (subcommand === 'report' || subcommand === 'handoff') {
        const { values } = (0, node_util_1.parseArgs)({
            args: rest,
            options: {
                blocked: { type: 'boolean' },
                continue: { type: 'string' },
                complete: { type: 'boolean' },
                'prompt-stdin': { type: 'boolean' }, 'prompt-file': { type: 'string' },
                wait: { type: 'boolean' }, timeout: { type: 'string' },
            },
            allowPositionals: false,
            strict: true,
        });
        const promptStdin = values['prompt-stdin'] === true;
        const promptFile = values['prompt-file'];
        const complete = values.complete === true;
        if (complete && subcommand === 'handoff')
            throw new Error('handoff --complete is invalid because no handoff occurs');
        if (complete && (promptStdin || promptFile !== undefined || values.blocked === true || values.continue)) {
            throw new Error('--complete is mutually exclusive with prompt input, --continue, and --blocked');
        }
        if (!complete && promptStdin === (promptFile !== undefined))
            throw new Error('pass exactly one of --prompt-stdin or --prompt-file');
        const body = complete ? '' : (promptStdin ? await readStdin() : await readPromptFile(promptFile));
        const timeoutS = Math.min(Math.max(Number(values.timeout ?? 30) || 30, 0), 120);
        const waitMs = values.wait === true ? timeoutS * 1000 : 0;
        const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/report', {
            body,
            ...(values.blocked === true ? { blocked: true } : {}),
            ...(typeof values.continue === 'string' ? { continueFromMessageId: values.continue } : {}),
            ...(complete ? { complete: true } : {}),
            ...(waitMs > 0 ? { waitMs } : {}),
        }, waitMs + 15_000);
        printJson(result);
        process.exitCode = result.ok === true ? 0 : 1;
        return true;
    }
    if (subcommand === 'link') {
        const action = rest[0];
        const linkRest = rest.slice(1);
        if (action === 'peers') {
            const { values } = (0, node_util_1.parseArgs)({
                args: linkRest,
                options: { json: { type: 'boolean' } },
                allowPositionals: false,
                strict: true,
            });
            const result = await (0, bridgeNotify_1.requestPeerAuthenticatedOrchestration)('link-peers', {});
            // Discovery is a structure-only contract; JSON also prevents terminal
            // names from becoming control characters in a tabular text format.
            void values.json;
            printJson(result);
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (action === 'read') {
            const { values } = (0, node_util_1.parseArgs)({
                args: linkRest,
                options: {
                    from: { type: 'string' },
                    lines: { type: 'string' },
                    full: { type: 'boolean' },
                    json: { type: 'boolean' },
                },
                allowPositionals: false,
                strict: true,
            });
            const targetTerminalId = values.from;
            if (!targetTerminalId)
                throw new Error('--from=<terminalId> is required (see `1devtool-agent link peers`)');
            if (values.full === true && values.lines !== undefined) {
                throw new Error('--lines cannot be combined with --full');
            }
            const maxLines = values.lines === undefined ? undefined : Number(values.lines);
            if (maxLines !== undefined && (!Number.isInteger(maxLines) || maxLines < 1)) {
                throw new Error('--lines must be a positive integer');
            }
            const result = await (0, bridgeNotify_1.requestPeerAuthenticatedOrchestration)('link-read', {
                targetTerminalId,
                ...(maxLines !== undefined ? { maxLines } : {}),
                ...(values.full === true ? { full: true } : {}),
            });
            if (values.json === true || result.ok !== true || typeof result.body !== 'string') {
                printJson(result);
            }
            else {
                process.stdout.write(result.body + (result.body.endsWith('\n') ? '' : '\n'));
            }
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (action === 'screen') {
            const { values } = (0, node_util_1.parseArgs)({
                args: linkRest,
                options: {
                    from: { type: 'string' },
                    rows: { type: 'string' },
                    json: { type: 'boolean' },
                },
                allowPositionals: false,
                strict: true,
            });
            const targetTerminalId = values.from;
            if (!targetTerminalId)
                throw new Error('--from=<terminalId> is required (see `1devtool-agent link peers`)');
            const rows = values.rows === undefined ? undefined : Number(values.rows);
            if (rows !== undefined && (!Number.isInteger(rows) || rows < 1)) {
                throw new Error('--rows must be a positive integer');
            }
            const result = await (0, bridgeNotify_1.requestPeerAuthenticatedOrchestration)('link-screen', {
                targetTerminalId,
                ...(rows !== undefined ? { rows } : {}),
            });
            if (values.json === true || result.ok !== true || typeof result.body !== 'string') {
                printJson(result);
            }
            else {
                process.stdout.write(result.body + (result.body.endsWith('\n') ? '' : '\n'));
            }
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (action === 'notes') {
            const { values } = (0, node_util_1.parseArgs)({
                args: linkRest,
                options: {
                    from: { type: 'string' },
                    lines: { type: 'string' },
                    json: { type: 'boolean' },
                },
                allowPositionals: false,
                strict: true,
            });
            const targetTerminalId = values.from;
            if (!targetTerminalId)
                throw new Error('--from=<terminalId> is required (see `1devtool-agent link peers`)');
            const maxLines = values.lines === undefined ? undefined : Number(values.lines);
            if (maxLines !== undefined && (!Number.isInteger(maxLines) || maxLines < 1)) {
                throw new Error('--lines must be a positive integer');
            }
            const result = await (0, bridgeNotify_1.requestPeerAuthenticatedOrchestration)('link-notes', {
                targetTerminalId,
                ...(maxLines !== undefined ? { maxLines } : {}),
            });
            if (values.json === true || result.ok !== true || typeof result.body !== 'string') {
                printJson(result);
            }
            else {
                process.stdout.write(result.body + (result.body.endsWith('\n') ? '' : '\n'));
            }
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (action === 'peek') {
            const { values } = (0, node_util_1.parseArgs)({
                args: linkRest,
                options: {
                    from: { type: 'string' },
                    'changed-since': { type: 'string' },
                    json: { type: 'boolean' },
                },
                allowPositionals: false,
                strict: true,
            });
            const targetTerminalId = values.from;
            if (!targetTerminalId)
                throw new Error('--from=<terminalId> is required (see `1devtool-agent link peers`)');
            const result = await (0, bridgeNotify_1.requestPeerAuthenticatedOrchestration)('link-peek', {
                targetTerminalId,
                ...(typeof values['changed-since'] === 'string'
                    ? { changedSince: values['changed-since'] }
                    : {}),
            });
            if (values.json === true || result.ok !== true) {
                printJson(result);
            }
            else {
                process.stdout.write(`${result.changed === true ? 'changed' : 'unchanged'} ` +
                    `${String(result.lastActivityAt ?? 0)} ${String(result.cursor ?? '')}\n`);
            }
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (action === 'publish') {
            const { values } = (0, node_util_1.parseArgs)({
                args: linkRest,
                options: {
                    title: { type: 'string' },
                    'prompt-stdin': { type: 'boolean' },
                    'prompt-file': { type: 'string' },
                },
                allowPositionals: false,
                strict: true,
            });
            const title = values.title;
            if (!title)
                throw new Error('--title=<title> is required');
            const promptStdin = values['prompt-stdin'] === true;
            const promptFile = values['prompt-file'];
            if (promptStdin === (promptFile !== undefined)) {
                throw new Error('pass exactly one of --prompt-stdin or --prompt-file');
            }
            const body = promptStdin ? await readStdin() : await readPromptFile(promptFile);
            if (!body.trim())
                throw new Error('artifact is empty');
            const result = await (0, bridgeNotify_1.requestPeerAuthenticatedOrchestration)('link-publish-artifact', { title, body });
            printJson(result);
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (action === 'request') {
            const { values } = (0, node_util_1.parseArgs)({
                args: linkRest,
                options: {
                    to: { type: 'string' },
                    permissions: { type: 'string' },
                },
                allowPositionals: false,
                strict: true,
            });
            const toTerminalId = values.to;
            if (!toTerminalId)
                throw new Error('--to=<terminalId> is required');
            const permissions = typeof values.permissions === 'string'
                ? values.permissions.split(',').map((permission) => permission.trim()).filter(Boolean)
                : ['send', 'ask'];
            const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/link/request', {
                toTerminalId,
                permissions,
                delivery: 'confirm',
            });
            printJson(result);
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (action === 'send') {
            const { values } = (0, node_util_1.parseArgs)({
                args: linkRest,
                options: {
                    to: { type: 'string' },
                    'reply-to': { type: 'string' },
                    // Single-use reply capability from the delivered envelope. Agents
                    // whose shells are not PTY descendants (Cline's hub daemon) cannot
                    // pass the ancestry gate — the token is their only attribution.
                    'reply-token': { type: 'string' },
                    gate: { type: 'string' },
                    'prompt-stdin': { type: 'boolean' }, 'prompt-file': { type: 'string' },
                    wait: { type: 'boolean' }, timeout: { type: 'string' },
                },
                allowPositionals: false,
                strict: true,
            });
            const toTerminalId = values.to;
            if (!toTerminalId)
                throw new Error('--to=<terminalId> is required (see `1devtool-agent whoami` for your links)');
            const promptStdin = values['prompt-stdin'] === true;
            const promptFile = values['prompt-file'];
            if (promptStdin === (promptFile !== undefined))
                throw new Error('pass exactly one of --prompt-stdin or --prompt-file');
            const body = promptStdin ? await readStdin() : await readPromptFile(promptFile);
            const timeoutS = Math.min(Math.max(Number(values.timeout ?? 30) || 30, 0), 120);
            const waitMs = values.wait === true ? timeoutS * 1000 : 0;
            const replyToMessageId = values['reply-to'];
            const replyToken = values['reply-token'];
            const gateDecision = values.gate;
            if (gateDecision && gateDecision !== 'accept' && gateDecision !== 'reject') {
                throw new Error('--gate must be accept or reject');
            }
            if (gateDecision && !replyToMessageId && !replyToken) {
                throw new Error('--gate requires --reply-to or --reply-token');
            }
            const result = await (0, bridgeNotify_1.requestSandboxCompatibleAgentOrchestration)(replyToken ? 'link-send-by-token' : 'link-send', '/orchestration/link/send', {
                toTerminalId,
                body,
                ...(waitMs > 0 ? { waitMs } : {}),
                ...(replyToMessageId ? { replyToMessageId } : {}),
                ...(replyToken ? { replyToken } : {}),
                ...(gateDecision ? { gateDecision } : {}),
            }, waitMs + 15_000);
            printJson(result);
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (action === 'status') {
            const { values } = (0, node_util_1.parseArgs)({
                args: linkRest,
                options: { message: { type: 'string' } },
                allowPositionals: false,
                strict: true,
            });
            // No --message: the board of everything this terminal is waiting on and
            // everything it owes a reply to. Polling individual ids on a timer is
            // what agents did before this existed.
            const messageId = values.message;
            const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/link/status', messageId ? { messageId } : {});
            printJson(result);
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (action === 'broadcast') {
            const { values } = (0, node_util_1.parseArgs)({
                args: linkRest,
                options: {
                    'prompt-stdin': { type: 'boolean' }, 'prompt-file': { type: 'string' },
                    vote: { type: 'string' }, options: { type: 'string' }, quorum: { type: 'string' },
                },
                allowPositionals: false,
                strict: true,
            });
            const promptStdin = values['prompt-stdin'] === true;
            const promptFile = values['prompt-file'];
            if (promptStdin === (promptFile !== undefined))
                throw new Error('pass exactly one of --prompt-stdin or --prompt-file');
            const body = promptStdin ? await readStdin() : await readPromptFile(promptFile);
            const question = values.vote;
            const optionList = typeof values.options === 'string'
                ? values.options.split(',').map((option) => option.trim()).filter(Boolean)
                : undefined;
            const quorum = values.quorum !== undefined ? Number(values.quorum) : undefined;
            if (quorum !== undefined && !Number.isInteger(quorum))
                throw new Error('--quorum must be an integer');
            const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/link/broadcast', {
                body,
                ...(question
                    ? { vote: { question, ...(optionList ? { options: optionList } : {}), ...(quorum !== undefined ? { quorum } : {}) } }
                    : {}),
            }, 60_000);
            printJson(result);
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (action === 'vote') {
            const { values } = (0, node_util_1.parseArgs)({
                args: linkRest,
                options: { on: { type: 'string' }, value: { type: 'string' }, reason: { type: 'string' } },
                allowPositionals: false,
                strict: true,
            });
            const decisionId = values.on;
            const value = values.value;
            if (!decisionId)
                throw new Error('--on=<decisionId> is required (see `1devtool-agent link decisions`)');
            if (!value)
                throw new Error('--value=<option> is required');
            const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/link/vote', {
                decisionId,
                value,
                ...(typeof values.reason === 'string' ? { reason: values.reason } : {}),
            });
            printJson(result);
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (action === 'decisions') {
            const { values } = (0, node_util_1.parseArgs)({
                args: linkRest,
                options: { open: { type: 'boolean' } },
                allowPositionals: false,
                strict: true,
            });
            const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/link/decisions', {});
            if (values.open === true && Array.isArray(result.decisions)) {
                result.decisions = result.decisions.filter((row) => row.state === 'open');
            }
            printJson(result);
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        throw new Error('link supports: peers, read, screen, notes, peek, publish, request, send, status, broadcast, vote, decisions');
    }
    // Workspace Control (docs/workspace_control/06-ipc-mcp-cli.md §5).
    // Membership authorizes the roster; DELIVERY still requires an existing
    // link with send permission (D1) — these verbs never mint links. Collect
    // requires the operationId minted by send/broadcast (D7).
    if (subcommand === 'workspace') {
        const action = rest[0];
        const workspaceRest = rest.slice(1);
        if (action === 'roster') {
            const { values } = (0, node_util_1.parseArgs)({
                args: workspaceRest,
                options: { workspace: { type: 'string' }, json: { type: 'boolean' } },
                allowPositionals: false,
                strict: true,
            });
            const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/workspace/roster', {
                ...(values.workspace ? { workspaceId: values.workspace } : {}),
            });
            printJson(result);
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (action === 'send') {
            const { values } = (0, node_util_1.parseArgs)({
                args: workspaceRest,
                options: {
                    workspace: { type: 'string' }, to: { type: 'string' },
                    'prompt-stdin': { type: 'boolean' }, 'prompt-file': { type: 'string' },
                    json: { type: 'boolean' },
                },
                allowPositionals: false,
                strict: true,
            });
            const to = values.to;
            if (!to)
                throw new Error('--to=<terminalId|name|project:<id|name>> is required (see `workspace roster`)');
            const promptStdin = values['prompt-stdin'] === true;
            const promptFile = values['prompt-file'];
            if (promptStdin === (promptFile !== undefined))
                throw new Error('pass exactly one of --prompt-stdin or --prompt-file');
            const message = promptStdin ? await readStdin() : await readPromptFile(promptFile);
            const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/workspace/send', {
                to,
                message,
                ...(values.workspace ? { workspaceId: values.workspace } : {}),
            });
            printJson(result);
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (action === 'broadcast') {
            const { values } = (0, node_util_1.parseArgs)({
                args: workspaceRest,
                options: {
                    workspace: { type: 'string' },
                    'prompt-stdin': { type: 'boolean' }, 'prompt-file': { type: 'string' },
                    'include-self': { type: 'boolean' }, limit: { type: 'string' },
                    json: { type: 'boolean' },
                },
                allowPositionals: false,
                strict: true,
            });
            const promptStdin = values['prompt-stdin'] === true;
            const promptFile = values['prompt-file'];
            if (promptStdin === (promptFile !== undefined))
                throw new Error('pass exactly one of --prompt-stdin or --prompt-file');
            const message = promptStdin ? await readStdin() : await readPromptFile(promptFile);
            const limit = values.limit !== undefined ? Number(values.limit) : undefined;
            if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
                throw new Error('--limit must be a positive integer');
            const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/workspace/broadcast', {
                message,
                ...(values.workspace ? { workspaceId: values.workspace } : {}),
                ...(values['include-self'] === true ? { excludeSelf: false } : {}),
                ...(limit !== undefined ? { limit } : {}),
            });
            printJson(result);
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (action === 'collect') {
            const { values } = (0, node_util_1.parseArgs)({
                args: workspaceRest,
                options: {
                    operation: { type: 'string' }, timeout: { type: 'string' },
                    json: { type: 'boolean' },
                },
                allowPositionals: false,
                strict: true,
            });
            const operationId = values.operation;
            if (!operationId)
                throw new Error('--operation=<wop-…> is required — collect correlates strictly by the operation id printed by send/broadcast');
            const timeoutS = values.timeout !== undefined ? Number(values.timeout) : undefined;
            if (timeoutS !== undefined && (!Number.isFinite(timeoutS) || timeoutS < 0))
                throw new Error('--timeout must be seconds ≥ 0');
            const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/workspace/collect', {
                operationId,
                ...(timeoutS !== undefined ? { timeoutSeconds: timeoutS } : {}),
            }, (Math.min(timeoutS ?? 0, 300) * 1000) + 15_000);
            printJson(result);
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        if (action === 'operation') {
            const { values } = (0, node_util_1.parseArgs)({
                args: workspaceRest,
                options: { id: { type: 'string' }, json: { type: 'boolean' } },
                allowPositionals: false,
                strict: true,
            });
            const operationId = values.id;
            if (!operationId)
                throw new Error('--id=<wop-…> is required');
            const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/workspace/operation', { operationId });
            printJson(result);
            process.exitCode = result.ok === true ? 0 : 1;
            return true;
        }
        throw new Error('workspace supports: roster, send, broadcast, collect, operation');
    }
    if (subcommand === 'send') {
        const { values } = (0, node_util_1.parseArgs)({
            args: rest,
            options: {
                team: { type: 'string' }, member: { type: 'string' },
                'submission-id': { type: 'string' },
                'prompt-stdin': { type: 'boolean' }, 'prompt-file': { type: 'string' },
            },
            allowPositionals: false,
            strict: true,
        });
        const teamId = values.team;
        const memberId = values.member;
        if (!teamId || !memberId)
            throw new Error('--team and --member are required');
        const submissionId = values['submission-id'] ?? node_crypto_1.default.randomUUID();
        const promptStdin = values['prompt-stdin'] === true;
        const promptFile = values['prompt-file'];
        if (promptStdin === (promptFile !== undefined))
            throw new Error('pass exactly one of --prompt-stdin or --prompt-file');
        const prompt = promptStdin ? await readStdin() : await readPromptFile(promptFile);
        const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/send', { teamId, memberId, submissionId, prompt });
        printJson(result);
        process.exitCode = result.ok === true ? 0 : 1;
        return true;
    }
    if (subcommand === 'collect') {
        const { values } = (0, node_util_1.parseArgs)({
            args: rest,
            options: {
                run: { type: 'string' }, swarm: { type: 'string' }, timeout: { type: 'string' },
                cursor: { type: 'string' }, limit: { type: 'string' }, json: { type: 'boolean' },
            },
            allowPositionals: false,
            strict: true,
        });
        const runId = values.run;
        const swarmId = values.swarm;
        if (!!runId === !!swarmId)
            throw new Error('pass exactly one of --run or --swarm');
        const timeoutS = Math.min(Math.max(Number(values.timeout ?? 0) || 0, 0), runHeadlessAgent_1.HEADLESS_MAX_TIMEOUT_S);
        const result = runId
            ? await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/collect/run', { runId, timeoutMs: timeoutS * 1000 }, timeoutS * 1000 + 5_000)
            : await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/collect/swarm', {
                swarmId,
                cursor: Math.max(0, Number(values.cursor ?? 0) || 0),
                limit: Math.min(Math.max(Number(values.limit ?? 20) || 20, 1), 50),
            });
        if (values.json === true || swarmId || typeof result.output !== 'string')
            printJson(result);
        else
            process.stdout.write(result.output + (result.output.endsWith('\n') ? '' : '\n'));
        process.exitCode = result.ok === true ? 0 : result.stillRunning === true ? 0 : 1;
        return true;
    }
    if (subcommand === 'stop') {
        const { values } = (0, node_util_1.parseArgs)({
            args: rest,
            options: {
                team: { type: 'string' }, swarm: { type: 'string' },
                'close-terminals': { type: 'boolean' }, 'finish-running': { type: 'boolean' },
            },
            allowPositionals: false,
            strict: true,
        });
        const id = values.team ?? values.swarm;
        if (!id || (!!values.team && !!values.swarm))
            throw new Error('pass exactly one of --team or --swarm');
        if (values['finish-running'] === true && !values.swarm)
            throw new Error('--finish-running requires --swarm=<id>');
        if (values['finish-running'] === true && values['close-terminals'] === true) {
            throw new Error('choose either --finish-running or --close-terminals');
        }
        const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/stop', {
            orchestrationId: id,
            closeTerminals: values['close-terminals'] === true,
            finishRunning: values['finish-running'] === true,
        });
        printJson(result);
        process.exitCode = result.ok === true ? 0 : 1;
        return true;
    }
    if (subcommand === 'fallback') {
        const { values } = (0, node_util_1.parseArgs)({
            args: rest,
            options: { run: { type: 'string' }, action: { type: 'string' }, target: { type: 'string' } },
            allowPositionals: false,
            strict: true,
        });
        const action = String(values.action ?? '');
        if (!values.run || !['retry', 'headless', 'reassign', 'skip', 'close'].includes(action)) {
            throw new Error('--run=<id> and --action=retry|headless|reassign|skip|close are required');
        }
        if (action === 'reassign' && !values.target)
            throw new Error('--target=<agent> is required for reassign');
        const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/resolve-fallback', {
            runId: values.run,
            action,
            ...(values.target ? { target: values.target } : {}),
        });
        printJson(result);
        process.exitCode = result.ok === true ? 0 : 1;
        return true;
    }
    if (subcommand === 'promote') {
        const { values } = (0, node_util_1.parseArgs)({
            args: rest,
            options: { swarm: { type: 'string' }, worker: { type: 'string' } },
            allowPositionals: false,
            strict: true,
        });
        if (!values.swarm || !values.worker)
            throw new Error('--swarm=<id> and --worker=<id> are required');
        const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/promote-worker', {
            swarmId: values.swarm,
            workerId: values.worker,
        });
        printJson(result);
        process.exitCode = result.ok === true ? 0 : 1;
        return true;
    }
    if (subcommand === 'confirm-submit') {
        const { values } = (0, node_util_1.parseArgs)({ args: rest, options: { run: { type: 'string' } }, allowPositionals: false, strict: true });
        if (!values.run)
            throw new Error('--run=<id> is required');
        const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/confirm-submit', { runId: values.run });
        printJson(result);
        process.exitCode = result.ok === true ? 0 : 1;
        return true;
    }
    if (subcommand === 'resolve') {
        const { values } = (0, node_util_1.parseArgs)({
            args: rest,
            options: { run: { type: 'string' }, outcome: { type: 'string' } },
            allowPositionals: false,
            strict: true,
        });
        if (!values.run || !['done', 'error', 'cancelled'].includes(String(values.outcome))) {
            throw new Error('--run=<id> and --outcome=done|error|cancelled are required');
        }
        const result = await (0, bridgeNotify_1.requestAgentOrchestration)('/orchestration/resolve-confirmation', {
            runId: values.run,
            outcome: values.outcome,
        });
        printJson(result);
        process.exitCode = result.ok === true ? 0 : 1;
        return true;
    }
    return false;
}
async function runTerminalCommand(args) {
    const action = args[0];
    const rest = args.slice(1);
    if (action === 'ssh-host') {
        if (rest.length > 0)
            throw new Error('ssh-host accepts no flags; transport requests over stdin');
        await (0, sshTerminalHost_1.runSshTerminalHost)();
        return;
    }
    if (action === 'list') {
        const { values } = (0, node_util_1.parseArgs)({
            args: rest,
            options: { json: { type: 'boolean' } },
            allowPositionals: false,
            strict: true,
        });
        await (0, terminalAttachClient_1.listLocalTerminals)(values.json === true);
        return;
    }
    if (action === 'view' || action === 'attach') {
        const { values } = (0, node_util_1.parseArgs)({
            args: rest,
            options: { id: { type: 'string' } },
            allowPositionals: false,
            strict: true,
        });
        if (!values.id)
            throw new Error('terminal id is required (`--id=<terminalId>`)');
        await (0, terminalAttachClient_1.attachLocalTerminal)(values.id);
        return;
    }
    if (action === 'submit') {
        const { values } = (0, node_util_1.parseArgs)({
            args: rest,
            options: {
                id: { type: 'string' },
                'prompt-stdin': { type: 'boolean' },
            },
            allowPositionals: false,
            strict: true,
        });
        if (!values.id)
            throw new Error('terminal id is required (`--id=<terminalId>`)');
        if (values['prompt-stdin'] !== true)
            throw new Error('semantic submit requires --prompt-stdin');
        const prompt = await readStdin();
        if (!prompt)
            throw new Error('prompt stdin is empty');
        await (0, terminalAttachClient_1.submitLocalTerminalPrompt)(values.id, prompt);
        return;
    }
    throw new Error('usage: onedevtool terminal list|view|attach|submit');
}
function printHelp() {
    process.stdout.write(`1devtool-agent — delegate prompts to other AI coding CLIs

Usage:
  onedevtool terminal list [--json]
  onedevtool terminal view --id=<terminalId>
  onedevtool terminal attach --id=<terminalId>  # view-only alias
  onedevtool terminal submit --id=<terminalId> --prompt-stdin
  onedevtool terminal ssh-host  # explicit Node + node-pty NDJSON helper
  1devtool-agent list [--json]
  1devtool-agent run --to=<agent> --prompt-stdin [options]
  1devtool-agent run --to=<agent> --prompt-file=<path> [options]
  1devtool-agent team start --manifest-stdin
  1devtool-agent team status --team=<id>
  1devtool-agent team list
  1devtool-agent team members --team=<id>
  1devtool-agent team connections --team=<id>
  1devtool-agent team peers --team=<id> [--json]
  1devtool-agent team read --team=<id> --from=<memberId> [--lines=40|--full] [--json]
  1devtool-agent team screen --team=<id> --from=<memberId> [--rows=200] [--json]
  1devtool-agent team notes --team=<id> --from=<memberId> [--lines=80] [--json]
  1devtool-agent team peek --team=<id> --from=<memberId> [--changed-since=<cursor>] [--json]
  1devtool-agent team send --team=<id> --to=<memberId> --submission-id=<uuid> --prompt-stdin
  1devtool-agent team ask --team=<id> --to=<memberId> --submission-id=<uuid> --prompt-stdin [--timeout=<seconds>]
  1devtool-agent team reply --message=<id> --submission-id=<uuid> --prompt-stdin
  1devtool-agent team messages --team=<id> [--cursor=0 --limit=50]
  1devtool-agent swarm start --manifest-stdin
  1devtool-agent swarm status --swarm=<id>
  1devtool-agent swarm pause --swarm=<id>
  1devtool-agent swarm resume --swarm=<id>
  1devtool-agent send --team=<id> --member=<id> --submission-id=<uuid> --prompt-stdin
  1devtool-agent whoami
  1devtool-agent link peers [--json]
  1devtool-agent link read --from=<terminalId> [--lines=40|--full] [--json]
  1devtool-agent link screen --from=<terminalId> [--rows=200] [--json]
  1devtool-agent link notes --from=<terminalId> [--lines=80] [--json]
  1devtool-agent link peek --from=<terminalId> [--changed-since=<cursor>] [--json]
  1devtool-agent link publish --title=<title> --prompt-stdin
  1devtool-agent link request --to=<terminalId> [--permissions=send,ask]
                              (kinds: send, ask, share-artifact, read-transcript,
                               read-transcript-full, read-screen, read-artifact;
                               read-* needs the user's consent review at approval)
  1devtool-agent link send --to=<terminalId> --prompt-stdin [--reply-to=<messageId>] [--reply-token=<token>] [--gate=accept|reject] [--wait] [--timeout=<seconds>]
  1devtool-agent link status [--message=<id>]
  1devtool-agent report --prompt-stdin [--continue=<accepted-input-message-id>] [--blocked] [--wait] [--timeout=<seconds>]
  1devtool-agent handoff --prompt-stdin [--continue=<accepted-input-message-id>] [--blocked] [--wait] [--timeout=<seconds>]
  1devtool-agent report --complete
                              (hierarchy: reports upward; Pipeline: typed forward handoff,
                               bounded gate escalation, or final-stage completion)
  1devtool-agent link broadcast --prompt-stdin [--vote=<question>] [--options=a,b] [--quorum=<n>]
  1devtool-agent link vote --on=<decisionId> --value=<option> [--reason=<text>]
  1devtool-agent link decisions [--open]
  1devtool-agent workspace roster [--workspace=<id>] [--json]
  1devtool-agent workspace send --to=<terminalId|name|project:<id|name>> --prompt-stdin [--workspace=<id>]
  1devtool-agent workspace broadcast --prompt-stdin [--workspace=<id>] [--include-self] [--limit=16]
  1devtool-agent workspace collect --operation=<wop-id> [--timeout=<seconds>]
  1devtool-agent workspace operation --id=<wop-id>
  1devtool-agent collect --run=<id> [--timeout=<seconds>]
  1devtool-agent collect --swarm=<id> [--cursor=0 --limit=20]
  1devtool-agent fallback --run=<id> --action=retry|headless|reassign|skip|close
  1devtool-agent promote --swarm=<id> --worker=<id>
  1devtool-agent stop --team=<id>|--swarm=<id> [--close-terminals|--finish-running]

Agents:
  ${KNOWN_AGENT_IDS.join(', ')}

Run options:
  --to=<agent>           Target agent (required)
  --prompt-stdin         Read prompt from stdin (required, or use --prompt-file)
  --prompt-file=<path>   Read prompt from file (must be in cwd or $TMPDIR; no symlinks)
  --timeout=<seconds>    Max wait, 5..600 (default ${runHeadlessAgent_1.HEADLESS_DEFAULT_TIMEOUT_S})
  --cwd=<dir>            Working dir for the target agent (default: current cwd)
  --model=<id>           Model for the target agent (mapped to its own model
                         flag, e.g. claude: sonnet | opus; codex: gpt-5.6-sol
                         or gpt-5.6-sol:xhigh; opencode: provider/model)
  --category=<slug>      Task category for run attribution (e.g. test, plan);
                         lowercase slug, recorded in the local run history
  --interactive          Open a visible 1DevTool agent terminal and return once
                         the task is handed off instead of running headlessly
  --terminal             Run in a visible, controller-owned Agent Team terminal
  --wait                 With --terminal, wait for the correlated result
  --skill=/<name>        Slash skill invoked with the task in that terminal;
                         requires --terminal (browser routes use /chrome)
  --flag=<f>             Extra flag passed to the target CLI; repeatable
  --json                 Emit JSON envelope instead of plain text
  --no-link              Force a fresh headless run even when an active link
                         to an open terminal of the target agent exists
                         (default: run fails fast with the link send command)

Safety: there is no --prompt=<text> flag. Always pipe the prompt to stdin.
`);
}
async function main() {
    const argv = process.argv.slice(2);
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
        printHelp();
        return;
    }
    const subcommand = argv[0];
    const rest = argv.slice(1);
    // `<sub> --help` must print usage, not die in strict parseArgs. Skill-driven
    // agents probe exactly this when a flag is rejected.
    if (rest.includes('--help') || rest.includes('-h')) {
        printHelp();
        return;
    }
    if (subcommand === 'list') {
        const { values } = (0, node_util_1.parseArgs)({
            args: rest,
            options: { json: { type: 'boolean' } },
            allowPositionals: false,
            strict: true,
        });
        listAgents(values.json === true);
        return;
    }
    if (subcommand === 'terminal') {
        await runTerminalCommand(rest);
        return;
    }
    if (subcommand === 'run') {
        let values;
        try {
            ({ values } = (0, node_util_1.parseArgs)({
                args: rest,
                options: {
                    to: { type: 'string' },
                    'prompt-stdin': { type: 'boolean' },
                    'prompt-file': { type: 'string' },
                    timeout: { type: 'string' },
                    cwd: { type: 'string' },
                    model: { type: 'string' },
                    category: { type: 'string' },
                    flag: { type: 'string', multiple: true },
                    interactive: { type: 'boolean' },
                    terminal: { type: 'boolean' },
                    wait: { type: 'boolean' },
                    skill: { type: 'string' },
                    json: { type: 'boolean' },
                    'no-link': { type: 'boolean' },
                },
                allowPositionals: false,
                strict: true,
            }));
        }
        catch (error) {
            // Unknown option ≠ fatal crash: name the option, point at help, and —
            // for flags newer than this build — say how to recover. A version-skewed
            // shim (skill docs newer than the installed CLI) hits exactly this.
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`error: ${message}\n`);
            process.stderr.write('run `1devtool-agent --help` for accepted options.\n');
            if (message.includes("'--")) {
                process.stderr.write('if this option is documented but rejected, this 1devtool-agent build may be\n' +
                    'older than the orchestration skill — update 1DevTool or use Settings → AI →\n' +
                    'Orchestration → "Reinstall orchestration". Unrecognized target-CLI flags can\n' +
                    'be passed through as `--flag=<f>` (repeatable).\n');
            }
            process.exit(2);
        }
        await runAgentCommand({
            to: values.to,
            promptStdin: values['prompt-stdin'] === true,
            promptFile: values['prompt-file'],
            timeout: values.timeout,
            cwd: values.cwd,
            model: values.model,
            category: values.category,
            flag: values.flag,
            interactive: values.interactive === true,
            terminal: values.terminal === true,
            noLink: values['no-link'] === true,
            wait: values.wait === true,
            skill: values.skill,
            json: values.json === true,
        });
        return;
    }
    try {
        if (await runControlCommand(subcommand, rest))
            return;
    }
    catch (error) {
        process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 2;
        return;
    }
    process.stderr.write(`unknown subcommand: ${subcommand}\n`);
    printHelp();
    process.exit(2);
}
main().catch((error) => {
    process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
// Suppress unused-import lint; execFile is used indirectly via runHeadlessAgent
void node_child_process_1.execFile;
