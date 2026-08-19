"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GROK_STALE_HIGH_EPSILON = exports.GROK_STALE_HIGH_HOLD_MS = exports.GROK_USAGE_DROP_THRESHOLD = void 0;
exports.readGeminiQuota = readGeminiQuota;
exports.readOpenCodeQuota = readOpenCodeQuota;
exports.readAmpQuota = readAmpQuota;
exports.readAmpQuotaCached = readAmpQuotaCached;
exports.readCursorQuota = readCursorQuota;
exports.readCursorQuotaCached = readCursorQuotaCached;
exports.applyGrokQuotaObservation = applyGrokQuotaObservation;
exports.readGrokQuota = readGrokQuota;
exports.resetGrokQuotaCacheForTests = resetGrokQuotaCacheForTests;
exports.readGrokQuotaCached = readGrokQuotaCached;
exports.readAntigravityQuota = readAntigravityQuota;
exports.readAntigravityQuotaCached = readAntigravityQuotaCached;
/*
 * ⚠ Terminal quota hotspot — read docs/common-errors/terminals/INDEX.md and
 * grok-quota-pill-desktop-side-channel.md and grok-quota-stale-after-reset.md
 * before changing Grok billing-log folding or probe-cache behavior.
 */
const fs_1 = require("fs");
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const util_1 = require("util");
const child_process_1 = require("child_process");
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const pty = __importStar(require("node-pty"));
const agentPromptWrite_1 = require("../../shared/terminal/agentPromptWrite");
const replay_1 = require("../../shared/terminal/replay");
const agentPaths_1 = require("../agentPaths");
const ptyRelease_1 = require("../pty-backend/ptyRelease");
const env_1 = require("../utils/env");
const paths_1 = require("./paths");
const usageApi_1 = require("./usageApi");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
// Normal Grok polling reads the authenticated billing response from its local
// event log. A forced refresh drives the hidden `/usage show` flow once,
// matching the CLI while leaving the user's visible terminal untouched.
const GROK_BILLING_LOG_TTL_MS = 60_000;
const GROK_BILLING_LOG_MAX_BYTES = 2 * 1024 * 1024;
const GROK_USAGE_TIMEOUT_MS = 12_000;
const GROK_USAGE_SCAN_MAX_CHARS = 50_000;
/** A drop this large is a reset, not ordinary burn. */
exports.GROK_USAGE_DROP_THRESHOLD = 15;
/** Ignore later log events that snap back to the pre-reset high. */
exports.GROK_STALE_HIGH_HOLD_MS = 6 * 60 * 60_000;
exports.GROK_STALE_HIGH_EPSILON = 2;
function kindFor(primary, secondary) {
    const hi = Math.max(primary?.usedPercent ?? 0, secondary?.usedPercent ?? 0);
    return hi >= 90 ? 'error' : hi >= 75 ? 'warn' : 'ok';
}
function statusFromUsage(source, usage, summary) {
    return {
        source,
        kind: kindFor(usage.primary, usage.secondary),
        summary,
        checkedAt: Date.now(),
        primary: usage.primary,
        secondary: usage.secondary,
        plan: usage.plan,
    };
}
// ── Gemini ────────────────────────────────────────────────────────────────────
async function readGeminiQuota(overrides) {
    const credsPath = (0, paths_1.resolveActiveAuth)('gemini', overrides).files[0];
    const blob = await fs_1.promises.readFile(credsPath, 'utf8').catch(() => null);
    if (!blob)
        return null;
    const token = (0, usageApi_1.parseGeminiAccessToken)(blob);
    if (!token)
        return null;
    try {
        const projectId = await (0, usageApi_1.fetchGeminiProject)(token);
        const usage = await (0, usageApi_1.fetchGeminiUsage)(token, projectId);
        return usage
            ? statusFromUsage('gemini-usage', usage, 'From the Gemini Code Assist quota API.')
            : { source: 'gemini-usage', kind: 'muted', summary: 'Signed in. Gemini did not report quota.', checkedAt: Date.now() };
    }
    catch (err) {
        if ((0, usageApi_1.isUnauthorized)(err)) {
            return { source: 'gemini-usage', kind: 'muted', summary: 'Signed in. Open Gemini CLI to refresh.', checkedAt: Date.now() };
        }
        return { source: 'gemini-usage', kind: 'muted', summary: 'Signed in. Gemini quota is temporarily unavailable.', checkedAt: Date.now() };
    }
}
// ── OpenCode (opencode-go budget windows: 5h/$12, weekly/$30) ───────────────────
const OPENCODE_FIVE_HOUR_LIMIT = 12;
const OPENCODE_WEEKLY_LIMIT = 30;
/** Start of the current UTC week (Monday 00:00) in epoch ms. */
function startOfWeekUtcMs(now = Date.now()) {
    const d = new Date(now);
    const day = (d.getUTCDay() + 6) % 7; // 0 = Monday
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}
async function readOpenCodeQuota(overrides) {
    const dbPath = path_1.default.join((0, agentPaths_1.getAgentRoot)('opencode', overrides), 'opencode.db');
    if (!(await fs_1.promises.stat(dbPath).then(() => true).catch(() => false)))
        return null;
    let db;
    try {
        db = new better_sqlite3_1.default(dbPath, { readonly: true, fileMustExist: true });
    }
    catch {
        return null;
    }
    try {
        const now = Date.now();
        const fiveHourMs = now - 5 * 3_600_000;
        const weekStartMs = startOfWeekUtcMs(now);
        const row = db
            .prepare(`SELECT
           COUNT(*) AS n,
           COALESCE(SUM(CASE WHEN t >= @fiveHour THEN cost ELSE 0 END), 0) AS five_hour,
           COALESCE(SUM(CASE WHEN t >= @weekStart THEN cost ELSE 0 END), 0) AS weekly,
           MIN(CASE WHEN t >= @fiveHour THEN t END) AS oldest_5h
         FROM (
           SELECT
             CAST(COALESCE(json_extract(data, '$.time.created'), time_created) AS INTEGER) AS t,
             CAST(json_extract(data, '$.cost') AS REAL) AS cost
           FROM message
           WHERE json_valid(data)
             AND json_extract(data, '$.providerID') = 'opencode-go'
             AND json_extract(data, '$.role') = 'assistant'
             AND json_type(data, '$.cost') IN ('integer', 'real')
         )`)
            .get({ fiveHour: fiveHourMs, weekStart: weekStartMs });
        if (!row || row.n === 0)
            return null; // not an opencode-go (Zen) user → no budget quota
        const pct = (used, limit) => Math.max(0, Math.min(100, (used / limit) * 100));
        const primary = {
            usedPercent: pct(row.five_hour, OPENCODE_FIVE_HOUR_LIMIT),
            windowMinutes: 300,
            resetsAt: row.oldest_5h ? row.oldest_5h + 5 * 3_600_000 : now + 5 * 3_600_000,
        };
        const secondary = {
            usedPercent: pct(row.weekly, OPENCODE_WEEKLY_LIMIT),
            windowMinutes: 10_080,
            resetsAt: weekStartMs + 7 * 86_400_000,
        };
        return statusFromUsage('opencode-usage', { primary, secondary }, 'From local opencode-go usage.');
    }
    catch {
        return null;
    }
    finally {
        db.close();
    }
}
// ── Amp (`amp usage --no-color`) ────────────────────────────────────────────────
async function readAmpQuota() {
    let stdout;
    try {
        const result = await execFileAsync('amp', ['usage', '--no-color'], {
            timeout: 8_000,
            env: { ...process.env, PATH: (0, env_1.getEnrichedPath)(), NO_COLOR: '1' },
        });
        stdout = result.stdout;
    }
    catch {
        return null; // amp not installed / not signed in / timed out
    }
    const usage = (0, usageApi_1.parseAmpUsage)(stdout);
    return usage ? statusFromUsage('amp-usage', usage, 'From the Amp CLI (`amp usage`).') : null;
}
let ampCache = null;
const AMP_TTL_MS = 60_000;
/** Cached `amp usage` read (the spawn is slow) — 60s, mirrors the account TTL.
 * `maxAgeMs` lets background callers accept a staler value instead of paying
 * the spawn (the background alert poll's 2-min interval exceeds the UI TTL,
 * so without it every tick re-ran the CLI). */
async function readAmpQuotaCached(maxAgeMs = AMP_TTL_MS) {
    if (ampCache && Date.now() - ampCache.at < maxAgeMs)
        return ampCache.value;
    const value = await readAmpQuota();
    ampCache = { at: Date.now(), value };
    return value;
}
// ── Cursor (`cursor-agent about --format json`) ───────────────────────────────
/**
 * Cursor publishes no usage numbers to the CLI — `about` reports identity and
 * subscription tier only; usage lives on cursor.com/dashboard. The probe
 * returns a window-less status (plan + signed-in identity) so the Quota Center
 * shows a real Cursor row instead of a dead "quota unavailable" placeholder,
 * never borrowing another provider's percentages (rule A9). `cursor-agent` is
 * the CLI binary — bare `cursor` is the editor launcher and must never be
 * probed (see cursor-cli-agent-rename.md).
 */
async function readCursorQuota() {
    let stdout;
    try {
        const result = await execFileAsync('cursor-agent', ['about', '--format', 'json'], {
            timeout: 8_000,
            env: { ...process.env, PATH: (0, env_1.getEnrichedPath)(), NO_COLOR: '1' },
        });
        stdout = result.stdout;
    }
    catch {
        return null; // cursor-agent not installed / signed out / timed out
    }
    const about = (0, usageApi_1.parseCursorAbout)(stdout);
    if (!about)
        return null;
    return {
        source: 'cursor-about',
        kind: 'muted',
        summary: `${about.tier ? `${about.tier} plan` : 'signed in'} · no usage API`,
        detail: `Cursor doesn't publish usage numbers to the CLI${about.email ? ` (signed in as ${about.email})` : ''}. Check cursor.com/dashboard for usage.`,
        checkedAt: Date.now(),
        plan: about.plan,
    };
}
let cursorCache = null;
const CURSOR_TTL_MS = 60_000;
/** Cached `cursor-agent about` read — 60s, mirrors the Amp side channel. */
async function readCursorQuotaCached() {
    if (cursorCache && Date.now() - cursorCache.at < CURSOR_TTL_MS)
        return cursorCache.value;
    const value = await readCursorQuota();
    cursorCache = { at: Date.now(), value };
    return value;
}
function runGrokUsageProbe() {
    return new Promise((resolve) => {
        let proc;
        try {
            proc = pty.spawn('grok', ['--no-alt-screen'], {
                name: 'xterm-256color',
                cols: 120,
                rows: 40,
                cwd: os_1.default.homedir(),
                env: {
                    ...process.env,
                    PATH: (0, env_1.getEnrichedPath)(),
                    NO_COLOR: '1',
                    FORCE_COLOR: '0',
                    TERM: 'xterm-256color',
                },
            });
        }
        catch {
            resolve(null);
            return;
        }
        let output = '';
        let settled = false;
        let finishing = false;
        let usageCommandSent = false;
        let showCommandSent = false;
        const timers = [];
        const schedule = (callback, delayMs) => {
            timers.push(setTimeout(callback, delayMs));
        };
        const cleanup = () => {
            for (const timer of timers)
                clearTimeout(timer);
            try {
                proc.write('\x1b');
            }
            catch {
                // ignore
            }
            // releasePty, not proc.kill() — kill() only signals the child and leaves
            // the master fd open forever. These probes re-spawn every 60s per
            // provider, so a stranded fd here drains the machine-wide pty budget
            // faster than any terminal does (pty-master-fd-leak.md).
            (0, ptyRelease_1.releasePty)(proc);
        };
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(value);
        };
        const submit = (text) => {
            (0, agentPromptWrite_1.submitAgentPrompt)((data) => {
                if (settled)
                    return;
                try {
                    proc.write(data);
                }
                catch {
                    finish(null);
                }
            }, text, { agentType: 'grok' }, schedule, { clearExisting: false });
        };
        const maybeAdvance = () => {
            // Grok repaints frequently. Scan only the recent frame so this rare probe
            // stays bounded instead of repeatedly reprocessing the full transcript.
            const recentOutput = output.slice(-GROK_USAGE_SCAN_MAX_CHARS);
            const rendered = (0, replay_1.stripAnsiPreservingLayout)(recentOutput).replace(/\s+/g, ' ');
            if (!usageCommandSent && /(?:Shift\+Tab\s*:?\s*mode|Ctrl\+x\s*:?\s*shortcuts)/i.test(rendered)) {
                usageCommandSent = true;
                // `/usage show` is the documented one-shot. Older CLIs still paint a
                // `show | manage` menu; the fallback below covers that path.
                schedule(() => submit('/usage show'), 400);
            }
            if (usageCommandSent && !showCommandSent && /show\s+View\s+credit\s+usage/i.test(rendered)) {
                showCommandSent = true;
                schedule(() => submit('show'), 150);
            }
            const parsed = (0, usageApi_1.parseGrokUsage)(recentOutput);
            if (parsed && !finishing) {
                finishing = true;
                // Let the billing event flush to unified.jsonl so we can merge the
                // exact ISO reset and subscription tier into the parsed TUI result.
                schedule(() => finish((0, usageApi_1.parseGrokUsage)(output.slice(-GROK_USAGE_SCAN_MAX_CHARS)) ?? parsed), 250);
            }
        };
        proc.onData((chunk) => {
            if (settled)
                return;
            output += chunk;
            if (output.length > 200_000)
                output = output.slice(-200_000);
            maybeAdvance();
        });
        proc.onExit(() => finish((0, usageApi_1.parseGrokUsage)(output.slice(-GROK_USAGE_SCAN_MAX_CHARS))));
        // Fallback for CLI versions whose ready footer differs. It still uses the
        // shared staged submit helper; the second step waits for the actual menu.
        schedule(() => {
            if (usageCommandSent)
                return;
            usageCommandSent = true;
            submit('/usage show');
        }, 2_500);
        schedule(() => finish((0, usageApi_1.parseGrokUsage)(output.slice(-GROK_USAGE_SCAN_MAX_CHARS))), GROK_USAGE_TIMEOUT_MS);
    });
}
function grokHome() {
    const configured = process.env.GROK_HOME?.trim();
    return configured ? path_1.default.resolve(configured) : path_1.default.join(os_1.default.homedir(), '.grok');
}
function grokUsedPercent(status) {
    const used = status?.primary?.usedPercent;
    return typeof used === 'number' && Number.isFinite(used) ? used : null;
}
function emptyGrokLatch(eventTs = null) {
    return {
        value: null,
        eventTs,
        probed: false,
        staleHighPercent: null,
        staleHighUntil: null,
    };
}
/**
 * Fold one billing observation into the Grok quota latch.
 *
 * After a reset (usage drops by `GROK_USAGE_DROP_THRESHOLD` or more), later log
 * events that snap back to the pre-reset high are ignored. Grok keeps writing
 * the cached 99–100% response from already-running CLI processes after the
 * website shows the new 2–3% window. See grok-quota-stale-after-reset.md.
 */
function applyGrokQuotaObservation(latch, observation, now) {
    let staleHighPercent = latch?.staleHighPercent ?? null;
    let staleHighUntil = latch?.staleHighUntil ?? null;
    if (staleHighUntil != null && now >= staleHighUntil) {
        staleHighPercent = null;
        staleHighUntil = null;
    }
    const nextPercent = grokUsedPercent(observation.status);
    const prevPercent = grokUsedPercent(latch?.value);
    const isSnapBack = observation.source === 'log'
        && nextPercent != null
        && staleHighPercent != null
        && nextPercent >= staleHighPercent - exports.GROK_STALE_HIGH_EPSILON;
    if (isSnapBack) {
        return {
            value: latch?.value ?? null,
            eventTs: latch?.eventTs ?? observation.eventTs,
            probed: latch?.probed ?? false,
            staleHighPercent,
            staleHighUntil,
        };
    }
    if (!observation.status) {
        if (observation.source === 'probe') {
            return latch ?? emptyGrokLatch(observation.eventTs);
        }
        // A billing fetch with no percent is not a license to walk back to an
        // older 99%. Keep a live probe; otherwise clear the unprobed value.
        if (latch?.probed && latch.value) {
            return { ...latch, staleHighPercent, staleHighUntil };
        }
        return {
            value: null,
            eventTs: observation.eventTs,
            probed: false,
            staleHighPercent,
            staleHighUntil,
        };
    }
    if (prevPercent != null
        && nextPercent != null
        && prevPercent - nextPercent >= exports.GROK_USAGE_DROP_THRESHOLD) {
        staleHighPercent = prevPercent;
        staleHighUntil = now + exports.GROK_STALE_HIGH_HOLD_MS;
    }
    return {
        value: observation.status,
        eventTs: observation.eventTs,
        probed: observation.source === 'probe' || (latch?.probed ?? false),
        staleHighPercent,
        staleHighUntil,
    };
}
function parseGrokBillingEvent(line) {
    let event;
    try {
        event = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (event.msg !== 'billing: fetched credits config' || !event.ctx?.config)
        return null;
    const eventTs = typeof event.ts === 'string' ? Date.parse(event.ts) : Number.NaN;
    const parsedTs = Number.isFinite(eventTs) ? eventTs : null;
    const config = event.ctx.config;
    const usedPercent = typeof config.creditUsagePercent === 'number'
        ? config.creditUsagePercent
        : Number(config.creditUsagePercent);
    const start = Date.parse(String(config.billingPeriodStart ?? config.currentPeriod?.start ?? ''));
    const end = Date.parse(String(config.billingPeriodEnd ?? config.currentPeriod?.end ?? ''));
    const windowMinutes = Number.isFinite(start) && Number.isFinite(end) && end > start
        ? Math.round((end - start) / 60_000)
        : 10_080;
    const resetsAt = Number.isFinite(end) && end > Date.now() ? end : null;
    const plan = typeof config.subscriptionTier === 'string'
        ? config.subscriptionTier
        : typeof event.ctx.subscriptionTier === 'string' ? event.ctx.subscriptionTier : undefined;
    if (!Number.isFinite(usedPercent)) {
        return { eventTs: parsedTs, status: null };
    }
    return {
        eventTs: parsedTs,
        status: {
            source: 'grok-usage',
            kind: usedPercent >= 90 ? 'error' : usedPercent >= 75 ? 'warn' : 'ok',
            summary: 'From the latest Grok billing refresh.',
            checkedAt: parsedTs ?? Date.now(),
            primary: { usedPercent, windowMinutes, resetsAt },
            plan,
        },
    };
}
function foldGrokBillingEvents(lines, now = Date.now()) {
    let latch = null;
    for (const line of lines) {
        if (!line)
            continue;
        const parsed = parseGrokBillingEvent(line);
        if (!parsed || !parsed.status)
            continue;
        latch = applyGrokQuotaObservation(latch, { status: parsed.status, eventTs: parsed.eventTs, source: 'log' }, parsed.eventTs ?? now);
    }
    return latch ?? emptyGrokLatch();
}
async function readGrokBillingLog() {
    const logPath = path_1.default.join(grokHome(), 'logs', 'unified.jsonl');
    try {
        const stat = await fs_1.promises.stat(logPath);
        const start = Math.max(0, stat.size - GROK_BILLING_LOG_MAX_BYTES);
        const handle = await fs_1.promises.open(logPath, 'r');
        let content;
        try {
            const buffer = Buffer.alloc(stat.size - start);
            await handle.read(buffer, 0, buffer.length, start);
            content = buffer.toString('utf8');
        }
        finally {
            await handle.close();
        }
        return {
            latch: foldGrokBillingEvents(content.split('\n')),
            logMtimeMs: stat.mtimeMs,
            logSize: stat.size,
        };
    }
    catch {
        return { latch: emptyGrokLatch(), logMtimeMs: 0, logSize: 0 };
    }
}
async function readGrokQuota() {
    return (await readGrokBillingLog()).latch.value;
}
let grokCache = null;
let grokProbeInFlight = null;
function resetGrokQuotaCacheForTests() {
    grokCache = null;
    grokProbeInFlight = null;
}
async function refreshGrokQuotaViaUsage() {
    const usage = await runGrokUsageProbe();
    const logged = await readGrokBillingLog();
    if (!usage)
        return logged.latch.value;
    const primary = usage.primary
        ? {
            ...usage.primary,
            resetsAt: logged.latch.value?.primary?.resetsAt ?? usage.primary.resetsAt,
        }
        : undefined;
    return statusFromUsage('grok-usage', { ...usage, primary, plan: logged.latch.value?.plan ?? usage.plan }, 'From Grok CLI `/usage show`.');
}
async function readGrokQuotaCached(force = false) {
    const logged = await readGrokBillingLog();
    const now = Date.now();
    const logUnchanged = grokCache != null
        && grokCache.logMtimeMs === logged.logMtimeMs
        && grokCache.logSize === logged.logSize;
    if (!force && grokCache && logUnchanged && now - grokCache.at < GROK_BILLING_LOG_TTL_MS) {
        return grokCache.latch.value;
    }
    let latch = grokCache
        ? applyGrokQuotaObservation(grokCache.latch, { status: logged.latch.value, eventTs: logged.latch.eventTs, source: 'log' }, now)
        : logged.latch;
    if (force) {
        if (!grokProbeInFlight) {
            grokProbeInFlight = refreshGrokQuotaViaUsage().finally(() => {
                grokProbeInFlight = null;
            });
        }
        const probed = await grokProbeInFlight;
        latch = applyGrokQuotaObservation(latch, { status: probed, eventTs: Date.now(), source: 'probe' }, Date.now());
    }
    grokCache = {
        at: Date.now(),
        logMtimeMs: logged.logMtimeMs,
        logSize: logged.logSize,
        latch,
    };
    return latch.value;
}
// ── Antigravity (`agy`, interactive `/usage`) ───────────────────────────────
const ANTIGRAVITY_TTL_MS = 60_000;
const ANTIGRAVITY_USAGE_TIMEOUT_MS = 12_000;
function runAntigravityUsageProbe() {
    return new Promise((resolve) => {
        let proc;
        try {
            proc = pty.spawn('agy', [], {
                name: 'xterm-256color',
                cols: 120,
                rows: 40,
                cwd: os_1.default.homedir(),
                env: {
                    ...process.env,
                    PATH: (0, env_1.getEnrichedPath)(),
                    NO_COLOR: '1',
                    FORCE_COLOR: '0',
                    TERM: 'xterm-256color',
                },
            });
        }
        catch {
            resolve(null);
            return;
        }
        let output = '';
        let settled = false;
        const timers = [];
        const cleanup = () => {
            for (const timer of timers)
                clearTimeout(timer);
            try {
                proc.write('\x1b');
            }
            catch {
                // ignore
            }
            // releasePty, not proc.kill() — kill() only signals the child and leaves
            // the master fd open forever. These probes re-spawn every 60s per
            // provider, so a stranded fd here drains the machine-wide pty budget
            // faster than any terminal does (pty-master-fd-leak.md).
            (0, ptyRelease_1.releasePty)(proc);
        };
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(value);
        };
        const tryParse = () => {
            const parsed = (0, usageApi_1.parseAntigravityUsage)(output);
            if (!parsed)
                return null;
            if (parsed.primary && parsed.secondary)
                return parsed;
            if (/Within each group|esc\s+Close|Quota available/i.test(output))
                return parsed;
            return null;
        };
        proc.onData((chunk) => {
            output += chunk;
            if (output.length > 200_000)
                output = output.slice(-200_000);
            const parsed = tryParse();
            if (parsed) {
                timers.push(setTimeout(() => finish((0, usageApi_1.parseAntigravityUsage)(output) ?? parsed), 400));
            }
        });
        proc.onExit(() => finish((0, usageApi_1.parseAntigravityUsage)(output)));
        timers.push(setTimeout(() => {
            try {
                proc.write('/usage\r');
            }
            catch {
                // ignore
            }
        }, 700));
        timers.push(setTimeout(() => {
            if (/Models\s*&\s*Quota/i.test(output))
                return;
            try {
                proc.write('/usage\r');
            }
            catch {
                // ignore
            }
        }, 3_000));
        timers.push(setTimeout(() => finish((0, usageApi_1.parseAntigravityUsage)(output)), ANTIGRAVITY_USAGE_TIMEOUT_MS));
    });
}
async function readAntigravityQuotaFromGoogleCreds(overrides) {
    const credsPath = (0, paths_1.resolveActiveAuth)('gemini', overrides).files[0];
    const blob = await fs_1.promises.readFile(credsPath, 'utf8').catch(() => null);
    if (!blob)
        return null;
    const token = (0, usageApi_1.parseGeminiAccessToken)(blob);
    if (!token)
        return null;
    try {
        const usage = await (0, usageApi_1.fetchAntigravityUsage)(token);
        return usage
            ? statusFromUsage('antigravity-usage', usage, 'From the Antigravity quota API.')
            : null;
    }
    catch (err) {
        if ((0, usageApi_1.isUnauthorized)(err)) {
            return {
                source: 'antigravity-usage',
                kind: 'muted',
                summary: 'Signed in. Open Antigravity to refresh.',
                checkedAt: Date.now(),
            };
        }
        return null;
    }
}
async function readAntigravityQuota(overrides) {
    const cliUsage = await runAntigravityUsageProbe();
    if (cliUsage) {
        return statusFromUsage('antigravity-usage', cliUsage, 'From Antigravity CLI `/usage`.');
    }
    return readAntigravityQuotaFromGoogleCreds(overrides);
}
let antigravityCache = null;
/** `maxAgeMs` mirrors readAmpQuotaCached: this probe is a full interactive
 * `agy` PTY session (up to 12s), so background alert ticks must never re-run
 * it merely because the 60s UI TTL lapsed. */
async function readAntigravityQuotaCached(overrides, maxAgeMs = ANTIGRAVITY_TTL_MS) {
    if (antigravityCache && Date.now() - antigravityCache.at < maxAgeMs) {
        return antigravityCache.value;
    }
    const value = await readAntigravityQuota(overrides);
    antigravityCache = { at: Date.now(), value };
    return value;
}
