"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getInstanceId = getInstanceId;
exports.getProcessStartedAt = getProcessStartedAt;
exports.withPoolLock = withPoolLock;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const history_1 = require("./history");
/*
 * Cross-instance lockfile for pool mutations (quota-center §7). `~/.1devtool`
 * is shared by the dev build and the packaged app, so an in-process mutex
 * cannot enforce the Level-2 exclusivity rule — every pool mutation
 * (switchTo + epoch append, assignment/lease writes) runs under this lock.
 *
 * Lock = exclusive-create of `ai-pool/lock-<scope>.json` holding
 * {pid, startedAt, instanceId}. Stale-break only when the recorded pid is
 * provably dead (bare pids recycle — a live recycled pid just makes us wait,
 * which is the conservative failure mode). Held per mutation, never long.
 */
const INSTANCE_ID = (0, crypto_1.randomUUID)();
const ACQUIRE_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 120;
/** Our own process start time (approx; stable within the process lifetime). */
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
function getInstanceId() {
    return INSTANCE_ID;
}
function getProcessStartedAt() {
    return PROCESS_STARTED_AT;
}
function lockPath(scope) {
    const safe = scope.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path_1.default.join((0, history_1.getPoolRoot)(), `lock-${safe}.json`);
}
function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
async function tryAcquire(scope) {
    const file = lockPath(scope);
    await fs_1.promises.mkdir(path_1.default.dirname(file), { recursive: true });
    try {
        const handle = await fs_1.promises.open(file, 'wx');
        try {
            await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: PROCESS_STARTED_AT, instanceId: INSTANCE_ID }));
        }
        finally {
            await handle.close();
        }
        return true;
    }
    catch (err) {
        if (err.code !== 'EEXIST')
            throw err;
        // Existing lock: stale-break only when its pid is provably dead.
        try {
            const raw = await fs_1.promises.readFile(file, 'utf8');
            const held = JSON.parse(raw);
            if (typeof held.pid === 'number' && !pidAlive(held.pid)) {
                await fs_1.promises.rm(file, { force: true });
            }
        }
        catch {
            // Torn write of the lock itself — remove and retry.
            await fs_1.promises.rm(file, { force: true }).catch(() => undefined);
        }
        return false;
    }
}
/** In-process serialization per scope so our own callers queue instead of
 * spinning against the filesystem for the cross-instance lock. */
const localChains = new Map();
async function withPoolLock(scope, fn) {
    const prev = localChains.get(scope) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    localChains.set(scope, prev.then(() => gate).catch(() => gate));
    await prev.catch(() => undefined);
    const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
    try {
        for (;;) {
            if (await tryAcquire(scope))
                break;
            if (Date.now() > deadline) {
                throw new Error(`Another 1DevTool instance is holding the ${scope} account lock. Close the other instance (dev and packaged builds share ~/.1devtool) and retry.`);
            }
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
        try {
            return await fn();
        }
        finally {
            await fs_1.promises.rm(lockPath(scope), { force: true }).catch(() => undefined);
        }
    }
    finally {
        release();
    }
}
