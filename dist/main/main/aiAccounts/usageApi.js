"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isUnauthorized = isUnauthorized;
exports.isRateLimited = isRateLimited;
exports.rateLimitRetryMs = rateLimitRetryMs;
exports.parseClaudeAccessToken = parseClaudeAccessToken;
exports.parseCodexAccessToken = parseCodexAccessToken;
exports.jwtExpiry = jwtExpiry;
exports.prettyPlan = prettyPlan;
exports.parseClaudeUsage = parseClaudeUsage;
exports.fetchClaudeUsage = fetchClaudeUsage;
exports.parseCodexUsage = parseCodexUsage;
exports.fetchCodexUsage = fetchCodexUsage;
exports.parseCodexResetCredits = parseCodexResetCredits;
exports.fetchCodexResetCredits = fetchCodexResetCredits;
exports.parseGeminiUsage = parseGeminiUsage;
exports.fetchGeminiProject = fetchGeminiProject;
exports.fetchGeminiUsage = fetchGeminiUsage;
exports.parseGrokUsage = parseGrokUsage;
exports.parseAntigravityUsage = parseAntigravityUsage;
exports.fetchAntigravityUsage = fetchAntigravityUsage;
exports.parseGeminiAccessToken = parseGeminiAccessToken;
exports.parseAmpUsage = parseAmpUsage;
exports.parseCursorAbout = parseCursorAbout;
const replay_1 = require("../../shared/terminal/replay");
const REQUEST_TIMEOUT_MS = 20_000;
class HttpStatusError extends Error {
    status;
    retryAfterMs;
    constructor(status, 
    /** `Retry-After` window in ms-from-now, when the provider supplied one (429s). */
    retryAfterMs) {
        super(`HTTP ${status}`);
        this.status = status;
        this.retryAfterMs = retryAfterMs;
        this.name = 'HttpStatusError';
    }
}
function isUnauthorized(err) {
    return err instanceof HttpStatusError && (err.status === 401 || err.status === 403);
}
/** True when the provider throttled us (HTTP 429). Drives the rate-limit gate. */
function isRateLimited(err) {
    return err instanceof HttpStatusError && err.status === 429;
}
/** The `Retry-After` window (ms from now) the provider asked us to wait, if any. */
function rateLimitRetryMs(err) {
    return err instanceof HttpStatusError ? err.retryAfterMs : undefined;
}
/** Parse an HTTP `Retry-After` header (delta-seconds or HTTP-date) to ms-from-now. */
function parseRetryAfter(header) {
    if (!header)
        return undefined;
    const seconds = Number(header);
    if (Number.isFinite(seconds))
        return Math.max(0, seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date))
        return Math.max(0, date - Date.now());
    return undefined;
}
async function fetchJson(url, init = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(url, { ...init, signal: controller.signal });
        if (!res.ok) {
            const retryAfterMs = res.status === 429 ? parseRetryAfter(res.headers.get('retry-after')) : undefined;
            throw new HttpStatusError(res.status, retryAfterMs);
        }
        return await res.json();
    }
    finally {
        clearTimeout(timeout);
    }
}
// ── token extraction ────────────────────────────────────────────────────────
/** Read `claudeAiOauth.accessToken` from a Claude credentials blob (keychain or file). */
function parseClaudeAccessToken(blob) {
    try {
        const value = JSON.parse(blob);
        const token = value.claudeAiOauth?.accessToken;
        return typeof token === 'string' && token ? token : null;
    }
    catch {
        return null;
    }
}
/** Read `tokens.access_token` from a Codex `auth.json` string. */
function parseCodexAccessToken(authJson) {
    try {
        const value = JSON.parse(authJson);
        const token = value.tokens?.access_token;
        return typeof token === 'string' && token ? token : null;
    }
    catch {
        return null;
    }
}
/** Seconds-since-epoch `exp` from a JWT payload, or null when unparseable. */
function jwtExpiry(token) {
    const payload = token.split('.')[1];
    if (!payload)
        return null;
    try {
        const json = Buffer.from(payload, 'base64url').toString('utf8');
        const exp = JSON.parse(json).exp;
        return typeof exp === 'number' ? exp : null;
    }
    catch {
        return null;
    }
}
// ── plan labels ──────────────────────────────────────────────────────────────
/**
 * Normalise a raw plan string into a short display label.
 * e.g. "plus" → "Plus", "chatgpt_pro" → "Pro", "claude_max_20x" → "Max".
 * Returns null for free/unknown/empty.
 */
function prettyPlan(raw) {
    if (typeof raw !== 'string')
        return undefined;
    const cleaned = raw.trim().toLowerCase();
    if (!cleaned || cleaned === 'free' || cleaned === 'unknown')
        return undefined;
    for (const tier of ['max', 'pro', 'plus', 'team', 'enterprise', 'edu', 'business']) {
        if (cleaned.includes(tier))
            return tier.charAt(0).toUpperCase() + tier.slice(1);
    }
    const token = cleaned.split(/[_\- ]/).pop() || cleaned;
    return token.charAt(0).toUpperCase() + token.slice(1);
}
function planFromKeys(value, keys) {
    for (const key of keys) {
        const plan = prettyPlan(value[key]);
        if (plan)
            return plan;
    }
    return undefined;
}
// ── Claude: GET https://api.anthropic.com/api/oauth/usage ─────────────────────
/** Parse Claude's `/api/oauth/usage` body into a UsageResult. */
function parseClaudeUsage(body) {
    if (!body || typeof body !== 'object')
        return null;
    const value = body;
    const primary = claudeWindow(value.five_hour, 300);
    const secondary = claudeWindow(value.seven_day, 10_080);
    if (primary.usedPercent == null && secondary.usedPercent == null)
        return null;
    return {
        primary,
        secondary,
        plan: planFromKeys(value, ['subscription_type', 'plan', 'plan_type', 'tier', 'account_type']),
    };
}
function claudeWindow(raw, windowMinutes) {
    const w = (raw && typeof raw === 'object' ? raw : {});
    return {
        usedPercent: typeof w.utilization === 'number' ? w.utilization : null,
        windowMinutes,
        resetsAt: isoToMs(w.resets_at),
    };
}
async function fetchClaudeUsage(accessToken, claudeVersion = '2.0.0') {
    const body = await fetchJson('https://api.anthropic.com/api/oauth/usage', {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'anthropic-beta': 'oauth-2025-04-20',
            // Omitting a claude-code User-Agent triggers repeated 429s (see quota.rs:42).
            'User-Agent': `claude-code/${claudeVersion}`,
            Accept: 'application/json',
        },
    });
    return parseClaudeUsage(body);
}
// ── Codex: GET https://chatgpt.com/backend-api/wham/usage ─────────────────────
/** Parse Codex's `wham/usage` body into a UsageResult. */
function parseCodexUsage(body) {
    if (!body || typeof body !== 'object')
        return null;
    const value = body;
    const rateLimit = value.rate_limit;
    if (!rateLimit || typeof rateLimit !== 'object')
        return null;
    const rl = rateLimit;
    let primary;
    let secondary;
    for (const key of ['primary_window', 'secondary_window']) {
        const win = rl[key];
        if (!win || typeof win !== 'object')
            continue;
        const w = win;
        const seconds = typeof w.limit_window_seconds === 'number' ? w.limit_window_seconds : 0;
        const window = {
            usedPercent: typeof w.used_percent === 'number' ? w.used_percent : null,
            windowMinutes: seconds ? Math.round(seconds / 60) : null,
            resetsAt: unixToMs(w.reset_at),
        };
        // ≥ 1 day ⇒ weekly, otherwise the 5-hour window.
        if (seconds >= 86_400)
            secondary = window;
        else
            primary = window;
    }
    if (primary?.usedPercent == null && secondary?.usedPercent == null)
        return null;
    return { primary, secondary, plan: prettyPlan(value.plan_type) };
}
async function fetchCodexUsage(accessToken) {
    const body = await fetchJson('https://chatgpt.com/backend-api/wham/usage', {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    return parseCodexUsage(body);
}
// ── Codex reset credits: GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits ──
/** Parse Codex's reset-credit body: `{ available_count, credits: [{ expires_at }] }`. */
function parseCodexResetCredits(body) {
    if (!body || typeof body !== 'object')
        return null;
    const value = body;
    const availableCount = typeof value.available_count === 'number'
        ? value.available_count
        : typeof value.availableCount === 'number'
            ? value.availableCount
            : null;
    const credits = [];
    const seen = new Set();
    const rawCredits = Array.isArray(value.credits) ? value.credits : [];
    for (const raw of rawCredits) {
        if (!raw || typeof raw !== 'object')
            continue;
        const credit = raw;
        const expiresAt = epochOrIsoToMs(credit.expires_at ?? credit.expiresAt);
        if (expiresAt == null || seen.has(expiresAt))
            continue;
        seen.add(expiresAt);
        credits.push({ expiresAt });
    }
    credits.sort((a, b) => a.expiresAt - b.expiresAt);
    return availableCount == null && credits.length === 0 ? null : { availableCount, credits };
}
async function fetchCodexResetCredits(accessToken) {
    const body = await fetchJson('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits', {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    return parseCodexResetCredits(body);
}
// ── Gemini: POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota ─
// Response: { buckets: [{ modelId, remainingFraction, resetTime }] }. We group by
// model (lowest remaining wins), then map a Pro model → primary and a Flash model
// → secondary. Quotas reset daily, so windowMinutes = 1440. Shapes ported from
// codexbar's GeminiStatusProbe. Best-effort: unknown shapes return null (pill hides).
const GEMINI_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
const GEMINI_LOAD_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist';
function parseGeminiUsage(body) {
    const buckets = body?.buckets;
    if (!Array.isArray(buckets))
        return null;
    // Keep the lowest remaining fraction per model (input tokens usually).
    const byModel = new Map();
    for (const raw of buckets) {
        const modelId = typeof raw?.modelId === 'string' ? raw.modelId : null;
        const fraction = typeof raw?.remainingFraction === 'number' ? raw.remainingFraction : null;
        if (modelId == null || fraction == null)
            continue;
        const reset = typeof raw.resetTime === 'string' ? raw.resetTime : undefined;
        const existing = byModel.get(modelId);
        if (!existing || fraction < existing.fraction)
            byModel.set(modelId, { fraction, reset });
    }
    if (byModel.size === 0)
        return null;
    const models = [...byModel.entries()].map(([id, v]) => ({
        id: id.toLowerCase(),
        usedPercent: Math.max(0, Math.min(100, (1 - v.fraction) * 100)),
        reset: v.reset,
    }));
    const mostConstrained = (list) => list.slice().sort((a, b) => b.usedPercent - a.usedPercent)[0];
    const toWindow = (m) => m ? { usedPercent: m.usedPercent, windowMinutes: 1440, resetsAt: isoToMs(m.reset) } : undefined;
    const isLite = (id) => id.includes('flash-lite') || id.includes('flash_lite');
    const pro = mostConstrained(models.filter((m) => m.id.includes('pro')));
    const flash = mostConstrained(models.filter((m) => m.id.includes('flash') && !isLite(m.id)));
    // Primary = Pro model; if there's no Pro, fall back to the single most-constrained model.
    let primary = toWindow(pro);
    const secondary = toWindow(flash);
    if (!primary)
        primary = toWindow(mostConstrained(models));
    if (primary?.usedPercent == null && secondary?.usedPercent == null)
        return null;
    return { primary, secondary };
}
/** Best-effort: resolve the Gemini Cloud Code project id via loadCodeAssist. */
async function fetchGeminiProject(accessToken) {
    try {
        const body = await fetchJson(GEMINI_LOAD_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify({ metadata: { pluginType: 'GEMINI' } }),
        });
        const v = body;
        const proj = v?.cloudaicompanionProject;
        if (typeof proj === 'string')
            return proj;
        if (proj && typeof proj === 'object') {
            const p = proj;
            if (typeof p.id === 'string')
                return p.id;
            if (typeof p.projectId === 'string')
                return p.projectId;
        }
    }
    catch {
        /* fall through — quota call also works without a project for some accounts */
    }
    return undefined;
}
async function fetchGeminiUsage(accessToken, projectId) {
    const body = await fetchJson(GEMINI_QUOTA_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify(projectId ? { project: projectId } : {}),
    });
    return parseGeminiUsage(body);
}
// ── Grok: interactive `/usage show` screen ───────────────────────────────────
const GROK_RESET_MONTHS = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
};
function pacificOffsetMinutes(atMs) {
    try {
        const part = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Los_Angeles',
            timeZoneName: 'longOffset',
        }).formatToParts(atMs).find((value) => value.type === 'timeZoneName')?.value;
        const match = part?.match(/^GMT([+-])(\d{2}):(\d{2})$/);
        if (!match)
            return -8 * 60;
        const minutes = Number(match[2]) * 60 + Number(match[3]);
        return match[1] === '+' ? minutes : -minutes;
    }
    catch {
        return -8 * 60;
    }
}
function grokResetOffsetMinutes(label, approximateUtcMs) {
    switch (label.toUpperCase()) {
        case 'PDT': return -7 * 60;
        case 'PST': return -8 * 60;
        case 'PT': return pacificOffsetMinutes(approximateUtcMs);
        case 'UTC':
        case 'GMT': return 0;
        default: return pacificOffsetMinutes(approximateUtcMs);
    }
}
function parseGrokResetTime(monthName, dayText, hourText, minuteText, timeZoneLabel, now) {
    const month = GROK_RESET_MONTHS[monthName.toLowerCase()];
    const day = Number(dayText);
    const hour = Number(hourText);
    const minute = Number(minuteText);
    if (month == null
        || !Number.isInteger(day) || day < 1 || day > 31
        || !Number.isInteger(hour) || hour < 0 || hour > 23
        || !Number.isInteger(minute) || minute < 0 || minute > 59) {
        return null;
    }
    const candidateForYear = (year) => {
        const approximateUtcMs = Date.UTC(year, month, day, hour, minute);
        let offsetMinutes = grokResetOffsetMinutes(timeZoneLabel, approximateUtcMs);
        let candidate = approximateUtcMs - offsetMinutes * 60_000;
        // PT crosses DST. Re-evaluate the offset at the resolved instant so dates
        // close to the transition use the correct side of the boundary.
        if (timeZoneLabel.toUpperCase() === 'PT') {
            offsetMinutes = grokResetOffsetMinutes(timeZoneLabel, candidate);
            candidate = approximateUtcMs - offsetMinutes * 60_000;
        }
        return candidate;
    };
    const currentYear = new Date(now).getUTCFullYear();
    const thisYear = candidateForYear(currentYear);
    // Grok omits the year. A weekly reset is always in the future, so a date
    // already behind us belongs to the next calendar year (the Dec → Jan case).
    return thisYear >= now - 60_000 ? thisYear : candidateForYear(currentYear + 1);
}
/**
 * Parse Grok's interactive `/usage show` result:
 *
 *   Weekly limit: 52%
 *   Next reset: July 15, 08:14 PT
 *
 * Grok paints each word with absolute cursor positioning, so phrase matching
 * must preserve that layout before treating whitespace-separated tokens as a
 * line. See terminal rule A5 / model-chip-ink-cursor-paint.md.
 */
function parseGrokUsage(text, now = Date.now()) {
    const clean = (0, replay_1.stripAnsiPreservingLayout)(text).replace(/\r/g, '\n');
    const percentMatch = clean.match(/Weekly(?:\s+SuperGrok)?\s+limit:?\s*(\d+(?:\.\d+)?)\s*%/i);
    if (!percentMatch)
        return null;
    const usedPercent = Number(percentMatch[1]);
    if (!Number.isFinite(usedPercent))
        return null;
    const resetMatch = clean.match(/Next\s+reset:\s*([A-Za-z]+)\s+(\d{1,2}),\s+(\d{1,2}):(\d{2})\s+([A-Za-z]{2,5})/i);
    const resetsAt = resetMatch
        ? parseGrokResetTime(resetMatch[1], resetMatch[2], resetMatch[3], resetMatch[4], resetMatch[5], now)
        : null;
    return {
        primary: {
            usedPercent: Math.max(0, Math.min(100, usedPercent)),
            windowMinutes: 10_080,
            resetsAt,
        },
    };
}
// ── Antigravity: `/usage` text + daily Cloud Code quota fallback ─────────────
const ANTIGRAVITY_QUOTA_URL = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota';
/**
 * Parse Antigravity's interactive `/usage` screen.
 *
 * The screen reports remaining quota by weekly model group:
 *   GEMINI MODELS          → primary
 *   CLAUDE AND GPT MODELS  → secondary
 *
 * The rest of 1DevTool stores usage as "used percent", so this parser converts
 * Antigravity's remaining percentage to `100 - remaining`.
 */
function parseAntigravityUsage(text) {
    const clean = (0, replay_1.stripAnsi)(text).replace(/\r/g, '\n');
    const primary = parseAntigravitySection(clean, 'GEMINI MODELS');
    const secondary = parseAntigravitySection(clean, 'CLAUDE AND GPT MODELS')
        ?? parseAntigravitySection(clean, 'CLAUDE/GPT MODELS')
        ?? parseAntigravitySection(clean, 'CLAUDE MODELS');
    if (primary?.usedPercent == null && secondary?.usedPercent == null)
        return null;
    return { primary, secondary };
}
async function fetchAntigravityUsage(accessToken) {
    const body = await fetchJson(ANTIGRAVITY_QUOTA_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify({}),
    });
    // Current observed daily endpoint shapes match Gemini Code Assist buckets for
    // at least the Gemini group. Keep the text parser first in case the endpoint
    // starts returning `/usage`-style strings inside a JSON field.
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return parseAntigravityUsage(text) ?? parseGeminiUsage(body);
}
/** Read the Gemini OAuth access token from `~/.gemini/oauth_creds.json`. */
function parseGeminiAccessToken(blob) {
    try {
        const v = JSON.parse(blob);
        return typeof v.access_token === 'string' && v.access_token ? v.access_token : null;
    }
    catch {
        return null;
    }
}
// ── Amp: `amp usage --no-color` (text). Lines like ──────────────────────────────
//   "Amp Free: $17.59/$20 remaining (...)"  → percentage window
//   "Individual credits: $0 remaining"      → balance-only (skipped; no %)
// Parser ported from claudebar's AmpUsageParser.
function parseAmpUsage(text) {
    const windows = [];
    for (const line of text.split(/\r?\n/)) {
        const m = line
            .trim()
            .match(/^.+?:\s*\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*\$([0-9]+(?:\.[0-9]+)?)\s+remaining/i);
        if (!m)
            continue;
        const remaining = parseFloat(m[1]);
        const total = parseFloat(m[2]);
        if (!(total > 0))
            continue;
        windows.push({
            usedPercent: Math.max(0, Math.min(100, ((total - remaining) / total) * 100)),
            windowMinutes: null,
            resetsAt: null,
        });
    }
    if (windows.length === 0)
        return null;
    return { primary: windows[0], secondary: windows[1] };
}
/**
 * `about --format json` reports identity + subscription tier but no usage
 * numbers — Cursor keeps those server-side (cursor.com/dashboard). Null means
 * signed out or unparseable output.
 */
function parseCursorAbout(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start)
        return null;
    let value;
    try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        if (typeof parsed !== 'object' || parsed === null)
            return null;
        value = parsed;
    }
    catch {
        return null;
    }
    const email = typeof value.userEmail === 'string' && value.userEmail.trim() ? value.userEmail.trim() : undefined;
    const tier = typeof value.subscriptionTier === 'string' && value.subscriptionTier.trim()
        ? value.subscriptionTier.trim()
        : undefined;
    if (!email && !tier)
        return null;
    return { plan: prettyPlan(tier), tier, email };
}
// ── shared helpers ────────────────────────────────────────────────────────────
function parseAntigravitySection(text, heading) {
    const headingRegex = new RegExp(`^\\s*${escapeRegExp(heading)}\\s*$`, 'im');
    const match = headingRegex.exec(text);
    if (!match)
        return undefined;
    const start = match.index;
    const afterHeading = start + match[0].length;
    const nextHeading = text.slice(afterHeading).search(/^\s*[A-Z][A-Z /&]+ MODELS\s*$/im);
    const end = nextHeading >= 0 ? afterHeading + nextHeading : text.length;
    const section = text.slice(start, end);
    const barRemaining = firstNumber(section.match(/\]\s*([0-9]+(?:\.[0-9]+)?)\s*%/));
    const textRemaining = firstNumber(section.match(/\b([0-9]+(?:\.[0-9]+)?)\s*%\s+remaining\b/i));
    const remaining = barRemaining ?? textRemaining ?? (/^\s*Quota available\s*$/im.test(section) ? 100 : null);
    if (remaining == null)
        return undefined;
    const resetMatch = section.match(/\bRefreshes?\s+in\s+([^\n]+)/i);
    const resetsAt = resetMatch ? durationFromNowMs(resetMatch[1]) : null;
    return {
        usedPercent: Math.max(0, Math.min(100, 100 - remaining)),
        windowMinutes: 10_080,
        resetsAt,
    };
}
function firstNumber(match) {
    if (!match)
        return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
}
function durationFromNowMs(raw) {
    let ms = 0;
    for (const match of raw.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*(w|week|weeks|d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/gi)) {
        const value = Number(match[1]);
        if (!Number.isFinite(value))
            continue;
        const unit = match[2].toLowerCase();
        if (unit.startsWith('w'))
            ms += value * 7 * 86_400_000;
        else if (unit.startsWith('d'))
            ms += value * 86_400_000;
        else if (unit === 'h' || unit.startsWith('hr') || unit.startsWith('hour'))
            ms += value * 3_600_000;
        else if (unit === 'm' || unit.startsWith('min') || unit.startsWith('minute'))
            ms += value * 60_000;
        else
            ms += value * 1000;
    }
    return ms > 0 ? Date.now() + ms : null;
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function isoToMs(raw) {
    if (typeof raw !== 'string')
        return null;
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? null : ms;
}
function unixToMs(raw) {
    return typeof raw === 'number' && Number.isFinite(raw) ? raw * 1000 : null;
}
function epochOrIsoToMs(raw) {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
        return raw > 1_000_000_000_000 ? raw : raw * 1000;
    }
    if (typeof raw !== 'string')
        return null;
    const ms = Date.parse(raw);
    return Number.isNaN(ms) ? null : ms;
}
