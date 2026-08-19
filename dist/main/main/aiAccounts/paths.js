"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAccountsRoot = getAccountsRoot;
exports.getRegistryPath = getRegistryPath;
exports.agentAccountsDir = agentAccountsDir;
exports.snapshotFilePath = snapshotFilePath;
exports.previousSnapshotPath = previousSnapshotPath;
exports.resolveActiveAuth = resolveActiveAuth;
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const agentPaths_1 = require("../agentPaths");
// Tests set ONEDEVTOOL_AI_ACCOUNTS_ROOT_OVERRIDE so the registry + snapshots
// land in a tempdir instead of ~/.1devtool/ai-accounts. Read lazily every call
// so test setup can swap the env var between cases without reloading modules.
function getAccountsRoot() {
    return (process.env.ONEDEVTOOL_AI_ACCOUNTS_ROOT_OVERRIDE ||
        path_1.default.join(os_1.default.homedir(), '.1devtool', 'ai-accounts'));
}
function getRegistryPath() {
    return path_1.default.join(getAccountsRoot(), 'registry.json');
}
function agentAccountsDir(agent) {
    return path_1.default.join(getAccountsRoot(), agent);
}
function snapshotFilePath(agent, id) {
    return path_1.default.join(agentAccountsDir(agent), `${id}.enc`);
}
function previousSnapshotPath(agent) {
    return path_1.default.join(agentAccountsDir(agent), '__previous__.enc');
}
/**
 * Where each agent stores the currently active credentials. Honors the user's
 * aiAgentPaths overrides so custom roots still work. Claude on macOS lives in
 * the login Keychain; everywhere else it's a plain file.
 */
function resolveActiveAuth(agent, overrides) {
    const root = (0, agentPaths_1.getAgentRoot)(agent, overrides);
    switch (agent) {
        case 'claude':
            if (process.platform === 'darwin') {
                return {
                    kind: 'keychain',
                    files: [],
                    keychain: { service: 'Claude Code-credentials', account: os_1.default.userInfo().username },
                };
            }
            return { kind: 'file', files: [path_1.default.join(root, '.credentials.json')] };
        case 'codex':
            return { kind: 'file', files: [path_1.default.join(root, 'auth.json')] };
        case 'gemini':
            return {
                kind: 'file',
                files: [path_1.default.join(root, 'oauth_creds.json'), path_1.default.join(root, 'google_accounts.json')],
            };
        case 'qwen':
            return { kind: 'file', files: [path_1.default.join(root, 'oauth_creds.json')] };
        case 'opencode':
            return { kind: 'file', files: [path_1.default.join(root, 'auth.json')] };
    }
}
