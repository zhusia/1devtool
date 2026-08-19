"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultSettings = defaultSettings;
exports.readRegistry = readRegistry;
exports.writeRegistry = writeRegistry;
exports.mutateRegistry = mutateRegistry;
exports.findAccount = findAccount;
exports.removeAccount = removeAccount;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const aiPool_1 = require("../../shared/aiPool");
const paths_1 = require("./paths");
const KNOWN_TOP_LEVEL_KEYS = new Set(['version', 'accounts', 'active', 'settings']);
function defaultSettings() {
    return {
        autoSwitch: {},
        autoSwitchDisclaimerAcceptedAt: null,
        quotaAlerts: {},
        policies: {},
        chain: { ...aiPool_1.DEFAULT_PROVIDER_CHAIN },
    };
}
function emptyRegistry() {
    return {
        version: 2,
        accounts: { claude: [], codex: [], gemini: [], qwen: [], opencode: [] },
        active: {},
        settings: defaultSettings(),
    };
}
function normalizeChain(chain) {
    const raw = chain;
    const valid = ['claude', 'codex', 'gemini', 'qwen', 'opencode'];
    const order = Array.isArray(raw?.order)
        ? raw.order.filter((agent) => valid.includes(agent))
        : [];
    return { enabled: raw?.enabled === true, order };
}
let writeChain = Promise.resolve();
/**
 * Read + migrate in one step. v1 files (or files with no version) migrate to
 * v2 by gaining `settings.policies`/`settings.chain` defaults — idempotent,
 * and every field defaults to current behavior. Unknown top-level keys are
 * carried in `extra` and re-spread on write.
 */
async function readRegistry() {
    let raw;
    try {
        raw = await fs_1.promises.readFile((0, paths_1.getRegistryPath)(), 'utf8');
    }
    catch {
        return emptyRegistry();
    }
    try {
        const parsed = JSON.parse(raw);
        const base = emptyRegistry();
        const extra = {};
        for (const key of Object.keys(parsed)) {
            if (!KNOWN_TOP_LEVEL_KEYS.has(key))
                extra[key] = parsed[key];
        }
        const merged = {
            version: 2,
            accounts: {
                claude: parsed.accounts?.claude ?? base.accounts.claude,
                codex: parsed.accounts?.codex ?? base.accounts.codex,
                gemini: parsed.accounts?.gemini ?? base.accounts.gemini,
                qwen: parsed.accounts?.qwen ?? base.accounts.qwen,
                opencode: parsed.accounts?.opencode ?? base.accounts.opencode,
            },
            active: parsed.active ?? base.active,
            settings: {
                autoSwitch: parsed.settings?.autoSwitch ?? base.settings.autoSwitch,
                autoSwitchDisclaimerAcceptedAt: parsed.settings?.autoSwitchDisclaimerAcceptedAt ?? base.settings.autoSwitchDisclaimerAcceptedAt,
                quotaAlerts: parsed.settings?.quotaAlerts ?? base.settings.quotaAlerts,
                policies: parsed.settings?.policies ?? base.settings.policies,
                chain: parsed.settings?.chain ? normalizeChain(parsed.settings.chain) : base.settings.chain,
            },
            ...(Object.keys(extra).length > 0 ? { extra } : {}),
        };
        return merged;
    }
    catch {
        return emptyRegistry();
    }
}
/** Unknown keys first so the known schema always wins on collision. */
function serializeRegistry(next) {
    const { extra, ...known } = next;
    return JSON.stringify({ ...(extra ?? {}), ...known }, null, 2);
}
/**
 * Serialize all registry writes through a single in-process chain so parallel
 * saveCurrent / switchTo / remove calls cannot clobber each other mid-write.
 * The atomic tmp+rename handles cross-process safety; this handles intra-process.
 */
async function writeRegistry(next) {
    const run = async () => {
        const root = (0, paths_1.getAccountsRoot)();
        await fs_1.promises.mkdir(root, { recursive: true });
        const tmp = path_1.default.join(root, `registry.json.${process.pid}.${Date.now()}.tmp`);
        await fs_1.promises.writeFile(tmp, serializeRegistry(next), { mode: 0o600 });
        await fs_1.promises.rename(tmp, (0, paths_1.getRegistryPath)());
    };
    const pending = writeChain.then(run, run);
    writeChain = pending.catch(() => {
        /* swallow so the chain keeps running after a failure */
    });
    await pending;
}
async function mutateRegistry(mutator) {
    const run = async () => {
        const prev = await readRegistry();
        const next = mutator(prev);
        const root = (0, paths_1.getAccountsRoot)();
        await fs_1.promises.mkdir(root, { recursive: true });
        const tmp = path_1.default.join(root, `registry.json.${process.pid}.${Date.now()}.tmp`);
        await fs_1.promises.writeFile(tmp, serializeRegistry(next), { mode: 0o600 });
        await fs_1.promises.rename(tmp, (0, paths_1.getRegistryPath)());
        return next;
    };
    // Serialize through writeChain so reads and writes inside the mutator stay
    // consistent with parallel callers.
    const pending = writeChain.then(run, run);
    writeChain = pending.then(() => undefined, () => undefined);
    return pending;
}
function findAccount(reg, agent, id) {
    return reg.accounts[agent].find((a) => a.id === id);
}
function removeAccount(reg, agent, id) {
    const next = {
        ...reg,
        accounts: { ...reg.accounts, [agent]: reg.accounts[agent].filter((a) => a.id !== id) },
        active: { ...reg.active },
    };
    if (next.active[agent] === id) {
        delete next.active[agent];
    }
    return next;
}
