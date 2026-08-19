"use strict";
/**
 * Headless worker runner with a real pre-exec gate.
 *
 * A tiny app-owned Node helper is spawned first and waits on stdin. Main can
 * durably journal its {pid,startTime}, commit the quota credit, and only then
 * release the invocation (including the brief) to the helper. Thus a crash
 * before the commit cannot let the agent see or execute the brief.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runGatedHeadlessAgent = runGatedHeadlessAgent;
const node_child_process_1 = require("node:child_process");
const headlessMode_1 = require("../../shared/headlessMode");
const orchestrationRuns_1 = require("../../shared/orchestrationRuns");
const runHeadlessAgent_1 = require("./runHeadlessAgent");
const processIdentity_1 = require("./processIdentity");
const env_1 = require("../utils/env");
const spawnSpec_1 = require("../utils/spawnSpec");
const GATE_HELPER = String.raw `
const { spawn } = require('node:child_process');
let input = '';
let child = null;
const stop = () => {
  if (!child) { process.exit(143); return; }
  try { child.kill('SIGTERM'); } catch { process.exit(143); }
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let request;
  try { request = JSON.parse(input); } catch { process.stderr.write('invalid gated worker payload'); process.exit(2); return; }
  const env = { ...process.env };
  for (const [key, value] of Object.entries(request.env || {})) {
    if (value === null) delete env[key]; else env[key] = String(value);
  }
  delete env.ELECTRON_RUN_AS_NODE;
  child = spawn(request.binary, request.args, { cwd: request.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: request.verbatim === true });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.on('error', err => { process.stderr.write(String(err && err.message || err)); process.exit(1); });
  child.on('close', code => process.exit(typeof code === 'number' ? code : 1));
  if (request.stdin !== undefined) child.stdin.end(request.stdin); else child.stdin.end();
});
`;
async function runGatedHeadlessAgent(input) {
    const spec = headlessMode_1.HEADLESS_SPECS[input.agentId];
    if (!spec)
        throw new Error(`Unknown agent "${input.agentId}"`);
    const invocation = (0, headlessMode_1.buildHeadlessInvocation)(input.agentId, input.prompt, [...(input.defaultFlags ?? spec.defaultFlags ?? []), ...(input.flags ?? [])]);
    if (!invocation)
        throw new Error(`No headless mode spec for agent "${input.agentId}"`);
    const requested = input.timeoutSeconds ?? runHeadlessAgent_1.HEADLESS_DEFAULT_TIMEOUT_S;
    const timeoutS = Math.min(Math.max(requested, runHeadlessAgent_1.HEADLESS_MIN_TIMEOUT_S), runHeadlessAgent_1.HEADLESS_MAX_TIMEOUT_S);
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        // The gate and the eventual agent child share the same resolved PATH as
        // terminal/tool spawns. The helper inherits it, then only applies the
        // bounded per-run overrides carried in the release payload.
        const env = (0, env_1.getEnrichedEnv)({ ELECTRON_RUN_AS_NODE: '1' });
        delete env.ONEDEVTOOL_TERMINAL_ID;
        env.ONEDEVTOOL_WORKER_ID = input.workerId;
        const helper = (0, node_child_process_1.spawn)(process.execPath, ['-e', GATE_HELPER], {
            cwd: input.cwd,
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            detached: process.platform !== 'win32',
        });
        let stdout = '';
        let stderr = '';
        let stderrTail = '';
        let outputTruncated = false;
        let stderrTruncated = false;
        let timedOut = false;
        let released = false;
        let settled = false;
        let gateError;
        let hardKillTimer;
        helper.stdout.setEncoding('utf-8');
        helper.stderr.setEncoding('utf-8');
        helper.stdout.on('data', (chunk) => {
            const remaining = runHeadlessAgent_1.HEADLESS_MAX_OUTPUT_CHARS - stdout.length;
            if (remaining > 0)
                stdout += chunk.slice(0, remaining);
            if (chunk.length > remaining)
                outputTruncated = true;
        });
        helper.stderr.on('data', (chunk) => {
            stderrTail = (stderrTail + chunk).slice(-2000);
            const capped = (0, orchestrationRuns_1.truncateUtf8Bytes)(stderr + chunk, orchestrationRuns_1.RUN_STDERR_CAP_BYTES);
            stderr = capped.text;
            stderrTruncated = stderrTruncated || capped.truncated;
        });
        const terminate = () => {
            try {
                if (process.platform !== 'win32' && helper.pid)
                    process.kill(-helper.pid, 'SIGTERM');
                else
                    helper.kill('SIGTERM');
            }
            catch { /* already closed */ }
            hardKillTimer ??= setTimeout(() => {
                try {
                    if (process.platform !== 'win32' && helper.pid)
                        process.kill(-helper.pid, 'SIGKILL');
                    else
                        helper.kill('SIGKILL');
                }
                catch { /* already closed */ }
            }, 2_000);
            hardKillTimer.unref?.();
        };
        const abort = () => terminate();
        const timeout = setTimeout(() => { timedOut = true; terminate(); }, timeoutS * 1000);
        timeout.unref?.();
        const finish = (code, error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            if (hardKillTimer)
                clearTimeout(hardKillTimer);
            input.signal.removeEventListener('abort', abort);
            if (error && !released) {
                reject(error);
                return;
            }
            const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
            const exitCode = timedOut ? 124 : typeof code === 'number' ? code : error ? 1 : input.signal.aborted ? 130 : 1;
            resolve({
                agent: input.agentId,
                output: stdout || stderrTail || '(no output)',
                exitCode,
                durationSeconds,
                ...(exitCode !== 0 && stderrTail ? { stderr: stderrTail } : {}),
                ...(timedOut ? { timedOut: true } : {}),
                ...(stderr ? { rawStderr: stderr } : {}),
                ...(outputTruncated || stderrTruncated
                    ? { truncated: { ...(outputTruncated ? { output: true } : {}), ...(stderrTruncated ? { stderr: true } : {}) } }
                    : {}),
            });
        };
        helper.once('error', (error) => finish(1, error));
        helper.once('close', (code) => finish(code, gateError));
        input.signal.addEventListener('abort', abort, { once: true });
        if (input.signal.aborted) {
            terminate();
            return;
        }
        void (0, processIdentity_1.readProcessStartToken)(helper.pid).then((startTime) => input.beforeRelease({
            pid: helper.pid,
            startTime: startTime ?? 0,
        })).then(() => {
            if (settled || input.signal.aborted)
                return;
            released = true;
            // Windows .cmd shims cannot be spawned directly (EINVAL) — resolve the
            // safe invocation HERE so the gate helper stays a dumb executor.
            const spec = (0, spawnSpec_1.buildSpawnSpec)(input.binaryPath, invocation.args);
            helper.stdin.end(JSON.stringify({
                binary: spec.file,
                args: spec.args,
                ...(spec.windowsVerbatimArguments ? { verbatim: true } : {}),
                ...(invocation.stdin !== undefined ? { stdin: invocation.stdin } : {}),
                cwd: input.cwd,
                env: {
                    NO_COLOR: '1',
                    FORCE_COLOR: '0',
                    ONEDEVTOOL_WORKER_ID: input.workerId,
                    ONEDEVTOOL_TERMINAL_ID: null,
                },
            }));
        }).catch((error) => {
            gateError = error instanceof Error ? error : new Error(String(error));
            terminate();
        });
    });
}
