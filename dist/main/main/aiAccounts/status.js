"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.clearLiveStatusCache = clearLiveStatusCache;
exports.buildLiveStatus = buildLiveStatus;
exports.buildStatusForSnapshot = buildStatusForSnapshot;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const util_1 = require("util");
const child_process_1 = require("child_process");
const jsonl_1 = require("../aiUsage/jsonl");
const paths_1 = require("./paths");
const agentPaths_1 = require("../agentPaths");
const claudeKeychain_1 = require("./claudeKeychain");
const quotaProviders_1 = require("./quotaProviders");
const usageApi_1 = require("./usageApi");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const statusCache = new Map();
// 60s matches ai-switcher; combined with the rate-limit gate below this keeps us
// well under the usage endpoints' throttle. See docs/realtime_quota.md §4.
const STATUS_TTL_MS = 60_000;
// ── Rate-limit gate ──────────────────────────────────────────────────────────
// All three reference quota apps converged on this: the provider usage endpoints
// throttle aggressively (Anthropic has been observed handing out 1-hour
// Retry-After windows). On a 429 we stop hitting that provider until the window
// passes. Keyed per agent (not per account) so it errs conservative, and we block
// BOTH background and user-initiated refreshes for the window's duration — for
// 1DevTool, never risking a ban beats a slightly fresher number.
const RATE_LIMIT_FALLBACK_MS = 5 * 60_000;
const rateLimitGate = new Map(); // agent → blockedUntil (epoch ms)
function rateLimitBlockedUntil(agent) {
    const until = rateLimitGate.get(agent);
    if (until == null)
        return null;
    if (until <= Date.now()) {
        rateLimitGate.delete(agent);
        return null;
    }
    return until;
}
function recordRateLimit(agent, retryAfterMs) {
    const wait = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : RATE_LIMIT_FALLBACK_MS;
    rateLimitGate.set(agent, Date.now() + wait);
}
function clearRateLimit(agent) {
    rateLimitGate.delete(agent);
}
function liveSourceForAgent(agent) {
    return agent === 'claude' ? 'claude-usage' : agent === 'codex' ? 'codex-usage' : 'oauth-expiry';
}
function rateLimitedStatus(agent, blockedUntil) {
    return {
        source: liveSourceForAgent(agent),
        kind: 'muted',
        summary: 'Usage temporarily rate-limited.',
        detail: `Provider asked us to wait until ${new Date(blockedUntil).toLocaleTimeString()}.`,
        checkedAt: Date.now(),
    };
}
function clearLiveStatusCache(agent) {
    if (!agent) {
        statusCache.clear();
        return;
    }
    for (const key of statusCache.keys()) {
        if (key.startsWith(`${agent}:`))
            statusCache.delete(key);
    }
}
async function buildLiveStatus(agent, overrides) {
    const cacheKey = `${agent}:${JSON.stringify((0, paths_1.resolveActiveAuth)(agent, overrides))}`;
    const cached = statusCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
    }
    // Honor a live Retry-After window: don't re-hit a throttled endpoint. Serve the
    // last known value (if any) and push its expiry to the window's end.
    const blockedUntil = rateLimitBlockedUntil(agent);
    if (blockedUntil) {
        if (cached) {
            statusCache.set(cacheKey, { expiresAt: blockedUntil, value: cached.value });
            return cached.value;
        }
        return rateLimitedStatus(agent, blockedUntil);
    }
    const value = await readLiveStatus(agent, overrides).catch(() => null);
    statusCache.set(cacheKey, { expiresAt: Date.now() + STATUS_TTL_MS, value });
    return value;
}
async function buildStatusForSnapshot(agent, payload) {
    if (agent === 'claude') {
        const value = payload?.value;
        if (typeof value !== 'string' || !value.trim())
            return null;
        const token = (0, usageApi_1.parseClaudeAccessToken)(value);
        if (!token)
            return null;
        try {
            const usage = await (0, usageApi_1.fetchClaudeUsage)(token, await detectClaudeVersion());
            return usage ? statusFromUsage('claude-usage', usage, 'From the Claude usage API.') : null;
        }
        catch (err) {
            if ((0, usageApi_1.isUnauthorized)(err)) {
                return {
                    source: 'claude-usage',
                    kind: 'muted',
                    summary: 'Saved token expired. Save this account again to refresh usage.',
                    checkedAt: Date.now(),
                };
            }
            throw err;
        }
    }
    if (agent === 'codex') {
        const authJson = payload?.authJson;
        if (typeof authJson !== 'string' || !authJson.trim())
            return null;
        const token = (0, usageApi_1.parseCodexAccessToken)(authJson);
        if (!token)
            return null;
        try {
            const usage = await (0, usageApi_1.fetchCodexUsage)(token);
            return usage
                ? statusFromUsage('codex-usage', usage, 'From the Codex usage API.')
                : {
                    source: 'codex-usage',
                    kind: 'muted',
                    summary: 'Saved account did not report usage data.',
                    checkedAt: Date.now(),
                };
        }
        catch (err) {
            if ((0, usageApi_1.isUnauthorized)(err)) {
                // A saved refresh token is a one-time credential. Never consume it from
                // a status probe; Codex will rotate it after the account is activated.
                return {
                    source: 'codex-usage',
                    kind: 'muted',
                    summary: 'Usage token expired. Switch to this account and open Codex to refresh it safely.',
                    checkedAt: Date.now(),
                };
            }
            if ((0, usageApi_1.isRateLimited)(err)) {
                recordRateLimit('codex', (0, usageApi_1.rateLimitRetryMs)(err));
                return rateLimitedStatus('codex', rateLimitGate.get('codex') ?? Date.now() + RATE_LIMIT_FALLBACK_MS);
            }
            throw err;
        }
    }
    if (agent === 'gemini' || agent === 'qwen') {
        const oauthCreds = payload?.oauthCreds;
        if (typeof oauthCreds !== 'string' || !oauthCreds.trim())
            return null;
        return readOauthExpiryStatusFromContents(oauthCreds);
    }
    return null;
}
async function readLiveStatus(agent, overrides) {
    switch (agent) {
        case 'claude':
            return readClaudeStatus(overrides);
        case 'codex':
            return readCodexStatus(overrides);
        case 'gemini':
            // Real quota (per-model daily windows); falls back to oauth-expiry when the
            // quota API is unavailable but the user is still signed in.
            return (await (0, quotaProviders_1.readGeminiQuota)(overrides)) ?? readOauthExpiryStatus(agent, overrides);
        case 'qwen':
            return readOauthExpiryStatus(agent, overrides);
        case 'opencode':
            // opencode-go (Zen) budget windows from the local DB; null for other providers.
            return (0, quotaProviders_1.readOpenCodeQuota)(overrides);
        default:
            return null;
    }
}
/**
 * Build an AiLiveAccountStatus from a parsed usage payload. `kind` thresholds
 * match the existing Codex-session logic so the UI colours stay consistent.
 */
function statusFromUsage(source, usage, detail, checkedAt = Date.now()) {
    const { primary, secondary, plan } = usage;
    const highestUsage = Math.max(primary?.usedPercent ?? 0, secondary?.usedPercent ?? 0);
    const kind = highestUsage >= 90 ? 'error' : highestUsage >= 75 ? 'warn' : 'ok';
    return {
        source,
        kind,
        summary: summarizeCodexLimits(primary, secondary),
        detail,
        checkedAt,
        primary,
        secondary,
        plan,
    };
}
async function readCodexResetCredits(token) {
    return (0, usageApi_1.fetchCodexResetCredits)(token).catch(() => null);
}
function attachCodexResetCredits(status, resetCredits) {
    if (!status || !resetCredits)
        return status;
    const next = { ...status };
    if (resetCredits.availableCount != null)
        next.codexAvailableCount = resetCredits.availableCount;
    if (resetCredits.credits.length > 0)
        next.codexResetCredits = resetCredits.credits;
    return next;
}
let claudeVersionCache = null;
/** Best-effort `claude --version` first numeric token; cached. Used in the User-Agent. */
async function detectClaudeVersion() {
    if (claudeVersionCache)
        return claudeVersionCache;
    try {
        const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 5_000 });
        claudeVersionCache = stdout.split(/\s+/).find((p) => /^\d/.test(p)) || '2.0.0';
    }
    catch {
        claudeVersionCache = '2.0.0';
    }
    return claudeVersionCache;
}
/** Read the active Claude account's OAuth access token (keychain on macOS, file elsewhere). */
async function readClaudeAccessToken(overrides) {
    const active = (0, paths_1.resolveActiveAuth)('claude', overrides);
    let blob = null;
    if (active.kind === 'keychain') {
        blob = await (0, claudeKeychain_1.readClaudeKeychain)(active.keychain.account).catch(() => null);
    }
    else {
        blob = await fs_1.promises.readFile(active.files[0], 'utf8').catch(() => null);
    }
    return blob ? (0, usageApi_1.parseClaudeAccessToken)(blob) : null;
}
/** Best-effort token refresh for the ACTIVE Claude account via the official CLI. */
async function refreshClaudeViaBinary(overrides) {
    const configDir = (0, agentPaths_1.getAgentRoot)('claude', overrides);
    await execFileAsync('claude', ['auth', 'status', '--json'], {
        timeout: 15_000,
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    }).catch(() => undefined);
}
async function readClaudeStatus(overrides) {
    const token = await readClaudeAccessToken(overrides);
    if (!token)
        return null;
    const version = await detectClaudeVersion();
    try {
        const usage = await (0, usageApi_1.fetchClaudeUsage)(token, version);
        clearRateLimit('claude');
        return usage ? statusFromUsage('claude-usage', usage, 'From the Claude usage API.') : claudeSignedInMuted();
    }
    catch (err) {
        if ((0, usageApi_1.isRateLimited)(err)) {
            recordRateLimit('claude', (0, usageApi_1.rateLimitRetryMs)(err));
            return rateLimitedStatus('claude', rateLimitGate.get('claude') ?? Date.now() + RATE_LIMIT_FALLBACK_MS);
        }
        if (!(0, usageApi_1.isUnauthorized)(err)) {
            return {
                source: 'claude-usage',
                kind: 'muted',
                summary: 'Signed in. Claude usage is temporarily unavailable.',
                checkedAt: Date.now(),
            };
        }
        // Expired token: try one official-CLI refresh, then retry once.
        await refreshClaudeViaBinary(overrides);
        const refreshed = await readClaudeAccessToken(overrides);
        if (refreshed && refreshed !== token) {
            try {
                const usage = await (0, usageApi_1.fetchClaudeUsage)(refreshed, version);
                if (usage)
                    return statusFromUsage('claude-usage', usage, 'From the Claude usage API.');
            }
            catch {
                /* fall through to muted */
            }
        }
        return {
            source: 'claude-usage',
            kind: 'muted',
            summary: 'Signed in. Sign in again to refresh Claude usage.',
            checkedAt: Date.now(),
        };
    }
}
function claudeSignedInMuted() {
    return {
        source: 'claude-usage',
        kind: 'muted',
        summary: 'Signed in. Claude did not report usage data.',
        checkedAt: Date.now(),
    };
}
/**
 * Codex live status: use the current access token without touching the one-time
 * refresh token, then fall back to rate-limit data in the local session log.
 * Only the Codex CLI owns refresh-token rotation.
 */
async function readCodexStatus(overrides) {
    const authPath = (0, paths_1.resolveActiveAuth)('codex', overrides).files[0];
    const authJson = await fs_1.promises.readFile(authPath, 'utf8').catch(() => null);
    if (authJson) {
        const token = (0, usageApi_1.parseCodexAccessToken)(authJson);
        if (token) {
            const resetCreditsPromise = readCodexResetCredits(token);
            try {
                const usage = await (0, usageApi_1.fetchCodexUsage)(token);
                if (usage) {
                    clearRateLimit('codex');
                    return attachCodexResetCredits(statusFromUsage('codex-usage', usage, 'From the Codex usage API.'), await resetCreditsPromise);
                }
            }
            catch (err) {
                if ((0, usageApi_1.isUnauthorized)(err)) {
                    return {
                        source: 'codex-usage',
                        kind: 'muted',
                        summary: 'Usage token expired. Run Codex once to refresh it safely.',
                        checkedAt: Date.now(),
                    };
                }
                // Record the throttle so we stop hitting the endpoint, then fall back to
                // the (free, on-disk) local session parse below.
                if ((0, usageApi_1.isRateLimited)(err))
                    recordRateLimit('codex', (0, usageApi_1.rateLimitRetryMs)(err));
            }
            return attachCodexResetCredits(await readCodexStatusLocal(overrides), await resetCreditsPromise);
        }
    }
    return readCodexStatusLocal(overrides);
}
async function readCodexStatusLocal(overrides) {
    const active = (0, paths_1.resolveActiveAuth)('codex', overrides);
    const newestSession = await findNewestJsonl(path_1.default.join(path_1.default.dirname(active.files[0]), 'sessions'));
    if (!newestSession) {
        const hasAuth = await fileExists(active.files[0]);
        return hasAuth
            ? {
                source: 'codex-session',
                kind: 'muted',
                summary: 'Signed in. Usage appears after a Codex session writes rate-limit data.',
                checkedAt: Date.now(),
            }
            : null;
    }
    let checkedAt = 0;
    let primary;
    let secondary;
    for await (const raw of (0, jsonl_1.streamJsonLines)(newestSession)) {
        const line = raw;
        if (line.type !== 'event_msg' || line.payload?.type !== 'token_count')
            continue;
        if (!line.payload.rate_limits)
            continue;
        checkedAt = line.timestamp ? Date.parse(line.timestamp) || checkedAt : checkedAt;
        primary = normalizeRateLimitWindow(line.payload.rate_limits.primary);
        secondary = normalizeRateLimitWindow(line.payload.rate_limits.secondary);
    }
    if (!primary && !secondary) {
        return {
            source: 'codex-session',
            kind: 'muted',
            summary: 'Signed in. Codex has not reported account limits yet.',
            checkedAt: Date.now(),
        };
    }
    const highestUsage = Math.max(primary?.usedPercent ?? 0, secondary?.usedPercent ?? 0);
    const kind = highestUsage >= 90 ? 'error' : highestUsage >= 75 ? 'warn' : 'ok';
    return {
        source: 'codex-session',
        kind,
        summary: summarizeCodexLimits(primary, secondary),
        detail: 'Parsed from Codex session rate-limit events.',
        checkedAt: checkedAt || Date.now(),
        primary,
        secondary,
    };
}
async function readOauthExpiryStatus(agent, overrides) {
    const active = (0, paths_1.resolveActiveAuth)(agent, overrides);
    const raw = await fs_1.promises.readFile(active.files[0], 'utf8').catch(() => null);
    if (!raw)
        return null;
    return readOauthExpiryStatusFromContents(raw);
}
function readOauthExpiryStatusFromContents(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    const expiresAt = normalizeEpochMs(parsed['expiry_date']);
    if (!expiresAt) {
        return {
            source: 'oauth-expiry',
            kind: 'muted',
            summary: 'Signed in. Token expiry is unavailable.',
            checkedAt: Date.now(),
        };
    }
    const remainingMs = expiresAt - Date.now();
    const expired = remainingMs <= 0;
    return {
        source: 'oauth-expiry',
        kind: expired ? 'error' : remainingMs < 3_600_000 ? 'warn' : 'ok',
        summary: expired
            ? 'OAuth token expired. Reconnect this account.'
            : `OAuth token valid for ${formatRemaining(remainingMs)}.`,
        detail: `Token expiry: ${new Date(expiresAt).toLocaleString()}`,
        checkedAt: Date.now(),
    };
}
async function fileExists(filePath) {
    try {
        await fs_1.promises.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
async function findNewestJsonl(dirPath) {
    let entries;
    try {
        entries = await fs_1.promises.readdir(dirPath, { withFileTypes: true });
    }
    catch {
        return null;
    }
    let newestPath = null;
    let newestMtime = 0;
    for (const entry of entries) {
        const fullPath = path_1.default.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            const nested = await findNewestJsonl(fullPath);
            if (!nested)
                continue;
            const nestedMtime = await fs_1.promises.stat(nested).then((s) => s.mtimeMs).catch(() => 0);
            if (nestedMtime > newestMtime) {
                newestMtime = nestedMtime;
                newestPath = nested;
            }
            continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.jsonl'))
            continue;
        const mtimeMs = await fs_1.promises.stat(fullPath).then((s) => s.mtimeMs).catch(() => 0);
        if (mtimeMs > newestMtime) {
            newestMtime = mtimeMs;
            newestPath = fullPath;
        }
    }
    return newestPath;
}
function normalizeRateLimitWindow(value) {
    if (!value)
        return undefined;
    return {
        usedPercent: typeof value.used_percent === 'number' ? value.used_percent : null,
        windowMinutes: typeof value.window_minutes === 'number' ? value.window_minutes : null,
        resetsAt: typeof value.resets_at === 'number' ? value.resets_at * 1000 : null,
    };
}
function summarizeCodexLimits(primary, secondary) {
    const parts = [];
    if (primary?.usedPercent != null) {
        parts.push(`${formatWindowLabel(primary.windowMinutes)} ${formatPercent(primary.usedPercent)} used`);
    }
    if (secondary?.usedPercent != null) {
        parts.push(`${formatWindowLabel(secondary.windowMinutes)} ${formatPercent(secondary.usedPercent)} used`);
    }
    return parts.join(' · ') || 'Codex usage data unavailable.';
}
function formatWindowLabel(windowMinutes) {
    if (windowMinutes === 300)
        return '5h';
    if (windowMinutes === 10_080)
        return 'Weekly';
    if (!windowMinutes)
        return 'Limit';
    if (windowMinutes % 1_440 === 0)
        return `${windowMinutes / 1_440}d`;
    if (windowMinutes % 60 === 0)
        return `${windowMinutes / 60}h`;
    return `${windowMinutes}m`;
}
function formatPercent(value) {
    return `${Math.round(value)}%`;
}
function normalizeEpochMs(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return null;
    return value > 1_000_000_000_000 ? value : value * 1000;
}
function formatRemaining(ms) {
    if (ms <= 0)
        return '0m';
    const totalMinutes = Math.ceil(ms / 60_000);
    if (totalMinutes < 60)
        return `${totalMinutes}m`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}
