"use strict";
/** Per-terminal handoff file used by native agent completion hooks. */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeHookCapability = writeHookCapability;
exports.readHookCapability = readHookCapability;
exports.clearHookCapability = clearHookCapability;
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const orchestrationRuns_1 = require("../../shared/orchestrationRuns");
function capabilityPath(homeDir, terminalId) {
    const key = node_crypto_1.default.createHash('sha256').update(terminalId).digest('hex');
    return node_path_1.default.join((0, orchestrationRuns_1.getOrchestrationRootDir)(homeDir), 'control', 'hooks', `${key}.json`);
}
function writeHookCapability(homeDir, record) {
    const target = capabilityPath(homeDir, record.terminalId);
    (0, orchestrationRuns_1.ensureDir)(node_path_1.default.dirname(target), 0o700);
    const tmp = `${target}.${process.pid}.tmp`;
    node_fs_1.default.writeFileSync(tmp, JSON.stringify(record), { encoding: 'utf-8', mode: 0o600 });
    node_fs_1.default.renameSync(tmp, target);
}
function readHookCapability(homeDir, terminalId) {
    try {
        const value = JSON.parse(node_fs_1.default.readFileSync(capabilityPath(homeDir, terminalId), 'utf-8'));
        if (value.terminalId !== terminalId || typeof value.runId !== 'string' ||
            typeof value.capabilityToken !== 'string' || typeof value.expiresAt !== 'number' ||
            value.expiresAt < Date.now())
            return null;
        return value;
    }
    catch {
        return null;
    }
}
function clearHookCapability(homeDir, terminalId, runId) {
    const target = capabilityPath(homeDir, terminalId);
    try {
        const current = JSON.parse(node_fs_1.default.readFileSync(target, 'utf-8'));
        if (current.runId === runId)
            node_fs_1.default.unlinkSync(target);
    }
    catch { /* absent, replaced, or unreadable */ }
}
