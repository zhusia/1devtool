"use strict";
/**
 * Process identity helpers for crash reconciliation. A PID alone is unsafe:
 * the OS may reuse it before 1DevTool restarts. Persist and compare the
 * platform process-start token before signalling an orphan.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readProcessStartToken = readProcessStartToken;
exports.inspectProcessIdentity = inspectProcessIdentity;
exports.reapProcessGroup = reapProcessGroup;
const node_fs_1 = __importDefault(require("node:fs"));
const node_child_process_1 = require("node:child_process");
function processExists(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === 'EPERM';
    }
}
function capture(command, args) {
    return new Promise((resolve) => {
        const child = (0, node_child_process_1.spawn)(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        let output = '';
        child.stdout.setEncoding('utf-8');
        child.stdout.on('data', (chunk) => {
            if (output.length < 4096)
                output += chunk.slice(0, 4096 - output.length);
        });
        child.once('error', () => resolve(null));
        child.once('close', (code) => resolve(code === 0 ? output.trim() : null));
    });
}
/** Returns a stable platform token, not necessarily epoch milliseconds. */
async function readProcessStartToken(pid) {
    if (!Number.isInteger(pid) || pid <= 0 || !processExists(pid))
        return null;
    if (process.platform === 'linux') {
        try {
            const stat = node_fs_1.default.readFileSync(`/proc/${pid}/stat`, 'utf-8');
            // `comm` may contain spaces and parentheses. Fields after the last `)`
            // begin at field 3 (state); starttime is field 22 => remainder index 19.
            const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
            const token = Number(fields[19]);
            return Number.isFinite(token) && token > 0 ? token : null;
        }
        catch {
            return null;
        }
    }
    if (process.platform === 'win32') {
        const value = await capture('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
        ]);
        const token = value ? Date.parse(value) : NaN;
        return Number.isFinite(token) ? token : null;
    }
    const value = await capture('ps', ['-o', 'lstart=', '-p', String(pid)]);
    const token = value ? Date.parse(value.replace(/\s+/g, ' ').trim()) : NaN;
    return Number.isFinite(token) ? token : null;
}
async function inspectProcessIdentity(pid, expectedStartToken) {
    if (!processExists(pid))
        return 'missing';
    if (!Number.isFinite(expectedStartToken) || expectedStartToken <= 0)
        return 'unknown';
    const actual = await readProcessStartToken(pid);
    if (actual === null)
        return processExists(pid) ? 'unknown' : 'missing';
    return actual === expectedStartToken ? 'match' : 'mismatch';
}
async function reapProcessGroup(pid, expectedStartToken, deadlineMs = 5_000) {
    const initial = await inspectProcessIdentity(pid, expectedStartToken);
    if (initial === 'missing')
        return 'gone';
    if (initial === 'mismatch')
        return 'identity-mismatch';
    if (initial === 'unknown')
        return 'unconfirmed';
    const signal = (kind) => {
        try {
            if (process.platform !== 'win32')
                process.kill(-pid, kind);
            else
                process.kill(pid, kind);
        }
        catch { /* confirmed below */ }
    };
    const waitUntilGone = async (until) => {
        while (Date.now() < until) {
            const state = await inspectProcessIdentity(pid, expectedStartToken);
            if (state === 'missing' || state === 'mismatch')
                return true;
            if (state === 'unknown')
                return false;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return false;
    };
    const halfDeadline = Date.now() + Math.max(100, Math.floor(deadlineMs / 2));
    signal('SIGTERM');
    if (await waitUntilGone(halfDeadline))
        return 'reaped';
    signal('SIGKILL');
    return await waitUntilGone(Date.now() + Math.max(100, Math.ceil(deadlineMs / 2)))
        ? 'reaped'
        : 'unconfirmed';
}
