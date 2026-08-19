"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readAssignments = readAssignments;
exports.getAssignment = getAssignment;
exports.putAssignment = putAssignment;
exports.removeAssignment = removeAssignment;
exports.readLeases = readLeases;
exports.putLease = putLease;
exports.removeLease = removeLease;
exports.reconcilableLeases = reconcilableLeases;
exports.reconcileLeasesAtBoot = reconcileLeasesAtBoot;
exports.readPoolState = readPoolState;
exports.writePoolState = writePoolState;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const history_1 = require("./history");
const instanceLock_1 = require("./instanceLock");
function assignmentsPath() {
    return path_1.default.join((0, history_1.getPoolRoot)(), 'assignments.json');
}
function leasesPath() {
    return path_1.default.join((0, history_1.getPoolRoot)(), 'leases.json');
}
function poolStatePath() {
    return path_1.default.join((0, history_1.getPoolRoot)(), 'pool-state.json');
}
let writeChain = Promise.resolve();
async function readJsonFile(file, fallback) {
    try {
        return JSON.parse(await fs_1.promises.readFile(file, 'utf8'));
    }
    catch {
        return fallback;
    }
}
async function writeJsonFile(file, value) {
    const run = async () => {
        await fs_1.promises.mkdir(path_1.default.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await fs_1.promises.writeFile(tmp, JSON.stringify(value, null, 2));
        await fs_1.promises.rename(tmp, file);
    };
    const pending = writeChain.then(run, run);
    writeChain = pending.catch(() => undefined);
    await pending;
}
// ── Assignments ──────────────────────────────────────────────────────────────
async function readAssignments() {
    const parsed = await readJsonFile(assignmentsPath(), []);
    return Array.isArray(parsed) ? parsed.filter((a) => typeof a?.terminalId === 'string') : [];
}
async function getAssignment(terminalId) {
    return (await readAssignments()).find((a) => a.terminalId === terminalId) ?? null;
}
async function putAssignment(assignment) {
    const all = (await readAssignments()).filter((a) => a.terminalId !== assignment.terminalId);
    all.push(assignment);
    await writeJsonFile(assignmentsPath(), all);
}
async function removeAssignment(terminalId) {
    const all = await readAssignments();
    const found = all.find((a) => a.terminalId === terminalId) ?? null;
    if (found)
        await writeJsonFile(assignmentsPath(), all.filter((a) => a.terminalId !== terminalId));
    return found;
}
// ── Leases ───────────────────────────────────────────────────────────────────
async function readLeases() {
    const parsed = await readJsonFile(leasesPath(), []);
    return Array.isArray(parsed) ? parsed.filter((l) => typeof l?.terminalId === 'string') : [];
}
async function putLease(lease) {
    const all = (await readLeases()).filter((l) => l.terminalId !== lease.terminalId);
    all.push({ ...lease, instanceId: (0, instanceLock_1.getInstanceId)() });
    await writeJsonFile(leasesPath(), all);
}
async function removeLease(terminalId) {
    const all = await readLeases();
    const found = all.find((l) => l.terminalId === terminalId) ?? null;
    if (found)
        await writeJsonFile(leasesPath(), all.filter((l) => l.terminalId !== terminalId));
    return found;
}
/** Pure: which leases may boot reconciliation reap? Only OUR OWN instance's
 * stale records, or records whose pid is provably dead. Another live
 * instance's leases are never touched (§7 cross-instance rule). */
function reconcilableLeases(leases, ownInstanceId, isPidAlive) {
    return leases.filter((lease) => {
        if (lease.instanceId === ownInstanceId)
            return true;
        if (lease.pid != null && !isPidAlive(lease.pid))
            return true;
        return false;
    });
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
/** Boot reconciliation: our previous run's leases cannot survive an app
 * restart (AI terminals never use tmux; their processes die with the app). */
async function reconcileLeasesAtBoot() {
    const all = await readLeases();
    const reap = new Set(reconcilableLeases(all, (0, instanceLock_1.getInstanceId)(), pidAlive).map((l) => l.terminalId));
    if (reap.size === 0)
        return 0;
    await writeJsonFile(leasesPath(), all.filter((l) => !reap.has(l.terminalId)));
    return reap.size;
}
async function readPoolState() {
    return readJsonFile(poolStatePath(), {});
}
async function writePoolState(state) {
    await writeJsonFile(poolStatePath(), state);
}
