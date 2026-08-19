"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.latestEpoch = latestEpoch;
exports.appendEpoch = appendEpoch;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const history_1 = require("./history");
function ledgerPath() {
    return path_1.default.join((0, history_1.getPoolRoot)(), 'epoch-ledger.jsonl');
}
let writeChain = Promise.resolve();
const lastByAgent = new Map();
let loaded = false;
async function ensureLoaded() {
    if (loaded)
        return;
    loaded = true;
    const content = await fs_1.promises.readFile(ledgerPath(), 'utf8').catch(() => '');
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed?.agent && typeof parsed.ts === 'number')
                lastByAgent.set(parsed.agent, parsed);
        }
        catch {
            /* skip torn line */
        }
    }
}
async function latestEpoch(agent) {
    await ensureLoaded();
    return lastByAgent.get(agent) ?? null;
}
function appendEpoch(entry) {
    const full = { ts: entry.ts ?? Date.now(), ...entry };
    const run = async () => {
        await ensureLoaded();
        // Dedupe: consecutive identical identities are not new epochs.
        const last = lastByAgent.get(full.agent);
        if (last && last.accountId === full.accountId && last.authDigest === full.authDigest && last.source === full.source) {
            return;
        }
        lastByAgent.set(full.agent, full);
        await fs_1.promises.mkdir((0, history_1.getPoolRoot)(), { recursive: true });
        await fs_1.promises.appendFile(ledgerPath(), JSON.stringify(full) + '\n');
    };
    writeChain = writeChain.then(run, run).catch(() => undefined);
}
