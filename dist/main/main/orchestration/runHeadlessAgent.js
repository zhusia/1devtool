"use strict";
/**
 * Pure-Node headless agent runner. Spawns an AI CLI in non-interactive mode,
 * pipes the prompt over stdin or argv per the agent's headless spec, and
 * returns stdout (truncated) + exit code.
 *
 * Extracted from `mcp-servers/tools/orchestratorTools.ts` so both the MCP
 * `run_agent` tool and the standalone `1devtool-agent` CLI share one
 * implementation. No Electron imports — only `node:child_process`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.UnknownAgentError = exports.HEADLESS_MAX_OUTPUT_CHARS = exports.HEADLESS_MIN_TIMEOUT_S = exports.HEADLESS_MAX_TIMEOUT_S = exports.HEADLESS_DEFAULT_TIMEOUT_S = void 0;
exports.runHeadlessAgent = runHeadlessAgent;
const child_process_1 = require("child_process");
const headlessMode_1 = require("../../shared/headlessMode");
const mcpTerminalIdentity_1 = require("../../shared/mcpTerminalIdentity");
const orchestrationRuns_1 = require("../../shared/orchestrationRuns");
const env_1 = require("../utils/env");
const spawnSpec_1 = require("../utils/spawnSpec");
exports.HEADLESS_DEFAULT_TIMEOUT_S = 120;
exports.HEADLESS_MAX_TIMEOUT_S = 600;
exports.HEADLESS_MIN_TIMEOUT_S = 5;
exports.HEADLESS_MAX_OUTPUT_CHARS = 100_000;
class UnknownAgentError extends Error {
    constructor(agentId) {
        super(`Unknown agent "${agentId}". Available: ${Object.keys(headlessMode_1.HEADLESS_SPECS).join(', ')}`);
        this.name = 'UnknownAgentError';
    }
}
exports.UnknownAgentError = UnknownAgentError;
async function runHeadlessAgent(input) {
    const { agentId, prompt, cwd, binaryPath, signal, terminalId } = input;
    if (!agentId || !prompt)
        throw new Error('agent and prompt are required');
    const spec = headlessMode_1.HEADLESS_SPECS[agentId];
    if (!spec)
        throw new UnknownAgentError(agentId);
    const defaultFlags = input.defaultFlags ?? spec.defaultFlags ?? [];
    const extraFlags = (input.flags ?? []).filter((f) => typeof f === 'string');
    const allFlags = [...defaultFlags, ...extraFlags];
    const headlessInvocation = (0, headlessMode_1.buildHeadlessInvocation)(agentId, prompt, allFlags);
    if (!headlessInvocation)
        throw new Error(`No headless mode spec for agent "${agentId}"`);
    const requested = typeof input.timeoutSeconds === 'number' ? input.timeoutSeconds : exports.HEADLESS_DEFAULT_TIMEOUT_S;
    const timeoutS = Math.min(Math.max(requested, exports.HEADLESS_MIN_TIMEOUT_S), exports.HEADLESS_MAX_TIMEOUT_S);
    const startedAt = Date.now();
    const enrichedEnv = (0, env_1.getEnrichedEnv)({ NO_COLOR: '1', FORCE_COLOR: '0' });
    const childEnv = terminalId
        ? (0, mcpTerminalIdentity_1.withOneDevToolTerminalEnv)(enrichedEnv, terminalId)
        : enrichedEnv;
    const { stdout, stderr, stderrTail, exitCode, timedOut, outputTruncated, stderrTruncated } = await new Promise((resolve) => {
        // npm-installed CLIs are .cmd shims on Windows — a direct spawn throws
        // EINVAL; route through the shared spec builder.
        const spec = (0, spawnSpec_1.buildSpawnSpec)(binaryPath, headlessInvocation.args);
        const child = (0, child_process_1.spawn)(spec.file, spec.args, {
            cwd,
            // Match terminal/tool spawns: retain the app/caller PATH and add the
            // shared Homebrew, user-toolchain, and configured extra locations.
            env: childEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        });
        let stdout = '';
        let stderr = '';
        let stderrTail = '';
        let outputTruncated = false;
        let stderrTruncated = false;
        let didTimeOut = false;
        let settled = false;
        let spawnError = null;
        let hardKillTimer;
        // An observer's failure is the observer's problem; it must never take down
        // a run the caller is waiting on.
        const tap = (stream, chunk) => {
            if (!input.onChunk)
                return;
            try {
                input.onChunk(stream, chunk);
            }
            catch { /* progress display is advisory */ }
        };
        child.stdout.setEncoding('utf-8');
        child.stderr.setEncoding('utf-8');
        child.stdout.on('data', (chunk) => {
            tap('stdout', chunk);
            // Keep draining after the cap. Stopping reads would back-pressure the
            // child and recreate the old maxBuffer failure under a different name.
            if (stdout.length < exports.HEADLESS_MAX_OUTPUT_CHARS) {
                const remaining = exports.HEADLESS_MAX_OUTPUT_CHARS - stdout.length;
                stdout += chunk.slice(0, remaining);
                if (chunk.length > remaining)
                    outputTruncated = true;
            }
            else {
                outputTruncated = true;
            }
        });
        child.stderr.on('data', (chunk) => {
            tap('stderr', chunk);
            stderrTail = (stderrTail + chunk).slice(-2000);
            if (Buffer.byteLength(stderr, 'utf-8') < orchestrationRuns_1.RUN_STDERR_CAP_BYTES) {
                const capped = (0, orchestrationRuns_1.truncateUtf8Bytes)(stderr + chunk, orchestrationRuns_1.RUN_STDERR_CAP_BYTES);
                stderr = capped.text;
                if (capped.truncated)
                    stderrTruncated = true;
            }
            else {
                stderrTruncated = true;
            }
        });
        const finish = (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            if (hardKillTimer)
                clearTimeout(hardKillTimer);
            signal.removeEventListener('abort', abort);
            resolve({
                stdout,
                stderr,
                stderrTail,
                // A process closed by a signal reports a null exit code. Never turn a
                // timeout or cancellation into a successful orchestration result.
                exitCode: didTimeOut ? 124 : typeof code === 'number' ? code : spawnError ? 1 : 130,
                timedOut: didTimeOut,
                outputTruncated,
                stderrTruncated,
            });
        };
        const abort = () => {
            try {
                child.kill('SIGTERM');
            }
            catch { /* noop */ }
            hardKillTimer ??= setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                }
                catch { /* noop */ }
            }, 2_000);
            hardKillTimer.unref?.();
        };
        const timeout = setTimeout(() => {
            didTimeOut = true;
            abort();
        }, timeoutS * 1000);
        timeout.unref?.();
        child.on('error', (error) => {
            spawnError = error;
            finish(1);
        });
        // `close`, not `exit`: output pipes are drained before the result is
        // finalized, so the final assistant bytes cannot be lost.
        child.on('close', (code) => finish(code));
        if (headlessInvocation.stdin !== undefined) {
            child.stdin?.end(headlessInvocation.stdin);
        }
        else {
            child.stdin?.end();
        }
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted)
            abort();
    });
    const durationMs = Date.now() - startedAt;
    const output = stdout;
    return {
        agent: agentId,
        output: output || stderrTail || '(no output)',
        exitCode,
        durationSeconds: Math.round(durationMs / 1000),
        ...(exitCode !== 0 && stderrTail ? { stderr: stderrTail } : {}),
        ...(timedOut ? { timedOut } : {}),
        ...(stderr ? { rawStderr: stderr } : {}),
        ...(outputTruncated || stderrTruncated
            ? {
                truncated: {
                    ...(outputTruncated ? { output: true } : {}),
                    ...(stderrTruncated ? { stderr: true } : {}),
                },
            }
            : {}),
    };
}
