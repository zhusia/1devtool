"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeOrchestrationRuntimeConfig = normalizeOrchestrationRuntimeConfig;
exports.readOrchestrationRuntimeConfig = readOrchestrationRuntimeConfig;
exports.writeOrchestrationRuntimeConfig = writeOrchestrationRuntimeConfig;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const runtimePolicy_1 = require("../../../shared/orchestration/runtimePolicy");
const runtimeTypes_1 = require("../../../shared/orchestration/runtimeTypes");
const orchestrationRuns_1 = require("../../../shared/orchestrationRuns");
function normalizeOrchestrationRuntimeConfig(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const flags = value.flags && typeof value.flags === 'object' ? value.flags : {};
    const browser = (value.browser && typeof value.browser === 'object' ? value.browser : {});
    return {
        preferredMode: runtimePolicy_1.AGENT_RUNTIME_PREFERENCES.includes(value.preferredMode)
            ? value.preferredMode
            : runtimeTypes_1.DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.preferredMode,
        teamPresentation: value.teamPresentation === 'mixed' ? 'mixed' : 'terminal-workspace',
        flags: Object.fromEntries(Object.entries(runtimeTypes_1.DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.flags).map(([key, fallback]) => [
            key,
            flags[key] === true ? true
                : flags[key] === false ? false
                    : fallback,
        ])),
        browser: {
            provider: 'playwright',
            retentionHours: typeof browser.retentionHours === 'number' && Number.isFinite(browser.retentionHours)
                ? Math.min(Math.max(Math.floor(browser.retentionHours), 1), 720)
                : runtimeTypes_1.DEFAULT_ORCHESTRATION_RUNTIME_CONFIG.browser.retentionHours,
            // Reserved for a future provider. Persisting true is refused until the
            // explicit real-profile consent flow exists.
            realBrowserAttachment: false,
        },
    };
}
function readOrchestrationRuntimeConfig(homeDir) {
    try {
        return normalizeOrchestrationRuntimeConfig(JSON.parse(node_fs_1.default.readFileSync(node_path_1.default.join((0, orchestrationRuns_1.getOrchestrationRootDir)(homeDir), 'runtime-config.json'), 'utf-8')));
    }
    catch {
        return normalizeOrchestrationRuntimeConfig(undefined);
    }
}
function writeOrchestrationRuntimeConfig(config, homeDir) {
    const normalized = normalizeOrchestrationRuntimeConfig(config);
    const filePath = node_path_1.default.join((0, orchestrationRuns_1.getOrchestrationRootDir)(homeDir), 'runtime-config.json');
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.tmp`;
    node_fs_1.default.writeFileSync(tmp, JSON.stringify(normalized, null, 2), { encoding: 'utf-8', mode: 0o600 });
    node_fs_1.default.renameSync(tmp, filePath);
    return normalized;
}
