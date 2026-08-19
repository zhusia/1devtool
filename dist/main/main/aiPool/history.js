"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPoolRoot = getPoolRoot;
exports.parseHistoryLines = parseHistoryLines;
exports.pruneOldSamples = pruneOldSamples;
exports.shouldAppendSample = shouldAppendSample;
exports.sampleFromStatus = sampleFromStatus;
exports.resetQuotaHistoryRuntimeState = resetQuotaHistoryRuntimeState;
exports.appendQuotaSample = appendQuotaSample;
exports.appendQuotaSampleFromStatus = appendQuotaSampleFromStatus;
exports.queryQuotaHistory = queryQuotaHistory;
const fs_1 = require("fs");
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
/*
 * Quota-sample time series (quota-center plan §7, Phase 1).
 *
 * Every successful identity-resolved status fetch appends one line to
 * `~/.1devtool/ai-pool/history/<agent>-<accountId>.jsonl`. Appends are
 * coalesced (a sample identical to the last one except for its timestamp is
 * skipped) so 30-day files never grow merely because the UI was open, and
 * each file is pruned to 30 days on its first write of an app session.
 *
 * This module does NOT schedule fetches — it rides the existing status paths
 * (60s cache + provider-wide 429 gate) plus a slow background sampler in
 * aiAccounts/runtime.ts, per the plan's "bounded sampling" rule.
 *
 * Kimi Code is intentionally absent from this quota series. Its native
 * `usage.record` events are per-session token accounting, not an
 * identity-resolved used-percent window with a reset time. Kimi prompt and
 * transcript history is imported through ResumeManager instead of inventing
 * incompatible quota samples here.
 */
const MAX_SAMPLE_AGE_MS = 30 * 86_400_000;
// Tests set ONEDEVTOOL_AI_POOL_ROOT_OVERRIDE so history lands in a tempdir.
// Read lazily every call so test setup can swap the env var between cases.
function getPoolRoot() {
    return (process.env.ONEDEVTOOL_AI_POOL_ROOT_OVERRIDE ||
        path_1.default.join(os_1.default.homedir(), '.1devtool', 'ai-pool'));
}
function historyDir() {
    return path_1.default.join(getPoolRoot(), 'history');
}
function historyFilePath(agent, accountId) {
    // Account ids are UUIDs we mint ourselves; keep a defensive filter anyway.
    const safeId = accountId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path_1.default.join(historyDir(), `${agent}-${safeId}.jsonl`);
}
function parseHistoryLines(content) {
    const samples = [];
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed?.ts === 'number' && typeof parsed?.accountId === 'string') {
                samples.push(parsed);
            }
        }
        catch {
            /* skip torn/corrupt lines — history is best-effort telemetry */
        }
    }
    return samples;
}
function pruneOldSamples(samples, nowMs) {
    const cutoff = nowMs - MAX_SAMPLE_AGE_MS;
    return samples.filter((sample) => sample.ts >= cutoff);
}
/** Coalescing rule: append only when the observation itself changed —
 * a fresh `checkedAt` alone is not a new fact. */
function shouldAppendSample(last, next) {
    if (!last)
        return true;
    return (last.primaryPct !== next.primaryPct ||
        last.secondaryPct !== next.secondaryPct ||
        last.resetsAt !== next.resetsAt);
}
function clampPct(value) {
    if (value == null || !Number.isFinite(value))
        return null;
    return Math.max(0, Math.min(100, Math.round(value)));
}
/** Build a sample from a status; null when the status carries no quota window. */
function sampleFromStatus(agent, accountId, status) {
    const primaryPct = clampPct(status.primary?.usedPercent);
    const secondaryPct = clampPct(status.secondary?.usedPercent);
    if (primaryPct == null && secondaryPct == null)
        return null;
    return {
        ts: status.checkedAt || Date.now(),
        agent,
        accountId,
        primaryPct,
        secondaryPct,
        resetsAt: status.primary?.resetsAt ?? status.secondary?.resetsAt ?? null,
    };
}
// Per-key session state: last appended sample (for coalescing) and whether
// this session already pruned the file. Serialized through one write chain so
// concurrent status fetches cannot interleave a prune-rewrite with an append.
const lastSampleByKey = new Map();
const prunedKeys = new Set();
let writeChain = Promise.resolve();
/** Test hook: forget session state so a fresh case re-reads from disk. */
function resetQuotaHistoryRuntimeState() {
    lastSampleByKey.clear();
    prunedKeys.clear();
}
async function appendQuotaSample(sample) {
    const run = async () => {
        const key = `${sample.agent}:${sample.accountId}`;
        const filePath = historyFilePath(sample.agent, sample.accountId);
        if (!prunedKeys.has(key)) {
            prunedKeys.add(key);
            const content = await fs_1.promises.readFile(filePath, 'utf8').catch(() => '');
            const existing = parseHistoryLines(content);
            const pruned = pruneOldSamples(existing, Date.now());
            lastSampleByKey.set(key, pruned.length ? pruned[pruned.length - 1] : null);
            if (pruned.length !== existing.length) {
                await fs_1.promises.mkdir(historyDir(), { recursive: true });
                await fs_1.promises.writeFile(filePath, pruned.map((s) => JSON.stringify(s)).join('\n') + (pruned.length ? '\n' : ''));
            }
        }
        if (!shouldAppendSample(lastSampleByKey.get(key) ?? null, sample))
            return;
        lastSampleByKey.set(key, sample);
        await fs_1.promises.mkdir(historyDir(), { recursive: true });
        await fs_1.promises.appendFile(filePath, JSON.stringify(sample) + '\n');
    };
    const pending = writeChain.then(run, run);
    writeChain = pending.catch(() => {
        /* keep the chain alive after a failed write — history is best-effort */
    });
    await pending;
}
/** Convenience used by the status hooks: extract + append in one call. */
async function appendQuotaSampleFromStatus(agent, accountId, status) {
    const sample = sampleFromStatus(agent, accountId, status);
    if (!sample)
        return;
    await appendQuotaSample(sample).catch(() => undefined);
}
async function queryQuotaHistory(query) {
    const dir = historyDir();
    let files;
    if (query.accountId) {
        files = [historyFilePath(query.agent, query.accountId)];
    }
    else {
        const entries = await fs_1.promises.readdir(dir).catch(() => []);
        files = entries
            .filter((name) => name.startsWith(`${query.agent}-`) && name.endsWith('.jsonl'))
            .map((name) => path_1.default.join(dir, name));
    }
    const results = [];
    for (const filePath of files) {
        const content = await fs_1.promises.readFile(filePath, 'utf8').catch(() => '');
        for (const sample of parseHistoryLines(content)) {
            if (sample.agent !== query.agent)
                continue;
            if (query.fromMs != null && sample.ts < query.fromMs)
                continue;
            results.push(sample);
        }
    }
    return results.sort((a, b) => a.ts - b.ts);
}
