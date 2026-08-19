"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_SCHEDULE_AHEAD_MS = void 0;
exports.configureScheduledPrompts = configureScheduledPrompts;
exports.scheduleRemotePrompt = scheduleRemotePrompt;
exports.cancelRemoteScheduledPrompt = cancelRemoteScheduledPrompt;
exports.getRemoteScheduledPrompt = getRemoteScheduledPrompt;
exports.resetScheduledPromptsForTest = resetScheduledPromptsForTest;
/**
 * Server-side scheduled prompt queue for Remote UI phones.
 *
 * The desktop renderer schedules its own prompts in scheduledPromptStore (a
 * timer inside the always-running renderer is fine there), but a phone
 * browser is suspended the moment it locks or backgrounds — a client-side
 * timer would silently never fire. So the phone only *describes* the schedule
 * (timer / wall-clock alarm / after AI quota reset) and this module owns the
 * clock in the desktop main process: one pending job per terminal, fired
 * through the same agent-kind-aware submitAgentPrompt path as terminal:submit.
 *
 * Mirrors src/renderer/stores/scheduledPromptStore.ts semantics: scheduling a
 * terminal that already has a pending job replaces it, and a low-frequency
 * sweep catches jobs whose setTimeout was suspended across machine sleep.
 * Jobs are in-memory only — an app restart drops them (same as the desktop
 * store).
 */
const crypto_1 = __importDefault(require("crypto"));
/** Furthest-out fire time accepted — generously covers the 99h timer cap and
 *  weekly quota resets while rejecting nonsense timestamps. */
exports.MAX_SCHEDULE_AHEAD_MS = 14 * 24 * 60 * 60 * 1000;
/** Sleep/wake catch-up: setTimeout stalls while the machine sleeps, so a
 *  low-frequency sweep fires anything overdue as soon as we notice. Runs only
 *  while at least one job is pending. */
const SWEEP_INTERVAL_MS = 5_000;
/** Node fires timeouts above 2^31-1 ms immediately; clamp and let the sweep
 *  (or a replaced timer) cover the tail. Our 14-day cap sits under this
 *  anyway — belt and braces. */
const MAX_TIMEOUT_MS = 0x7fffffff;
const jobs = new Map();
const timers = new Map();
let sweepTimer = null;
let fireFn = async () => { };
let broadcastFn = () => { };
/** Wire the fire/broadcast sinks. Called from registerTerminalHandlers, which
 *  owns the socket.io server and PTY manager; re-configuring (remote server
 *  restart) keeps pending jobs and just points them at the fresh sinks. */
function configureScheduledPrompts(options) {
    fireFn = options.fire;
    broadcastFn = options.broadcast;
}
function clearJobTimer(terminalId) {
    const timer = timers.get(terminalId);
    if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(terminalId);
    }
}
function stopSweepIfIdle() {
    if (jobs.size === 0 && sweepTimer !== null) {
        clearInterval(sweepTimer);
        sweepTimer = null;
    }
}
function ensureSweep() {
    if (sweepTimer !== null)
        return;
    sweepTimer = setInterval(() => {
        const now = Date.now();
        for (const job of Array.from(jobs.values())) {
            if (job.status === 'pending' && now >= job.runAt)
                void fireJob(job.terminalId);
        }
    }, SWEEP_INTERVAL_MS);
    // Never keep the process alive just for a pending prompt.
    sweepTimer.unref?.();
}
async function fireJob(terminalId) {
    const job = jobs.get(terminalId);
    if (!job || job.status !== 'pending')
        return;
    clearJobTimer(terminalId);
    job.status = 'submitting';
    job.failureMessage = undefined;
    broadcastFn(terminalId, job);
    try {
        await fireFn(job);
        if (jobs.get(terminalId)?.id !== job.id)
            return;
        jobs.delete(terminalId);
        stopSweepIfIdle();
        broadcastFn(terminalId, null);
    }
    catch (err) {
        console.warn('[remote-schedule] Failed to submit scheduled prompt:', err);
        if (jobs.get(terminalId)?.id !== job.id)
            return;
        job.status = 'failed';
        job.failureMessage = err instanceof Error ? err.message : 'Scheduled prompt delivery failed.';
        broadcastFn(terminalId, job);
    }
}
function scheduleRemotePrompt(options) {
    const { terminalId, text, displayText, attachmentCount, mode, modeDetail, delayMs, runAt } = options;
    clearJobTimer(terminalId);
    const now = Date.now();
    const fireAt = Math.max(now, runAt ?? now + Math.max(0, delayMs ?? 0));
    const job = {
        id: crypto_1.default.randomUUID(),
        terminalId,
        text,
        displayText: (displayText ?? '').trim() || text,
        attachmentCount: Math.max(0, attachmentCount ?? 0),
        mode: mode ?? 'timer',
        modeDetail,
        scheduledAt: now,
        runAt: fireAt,
        status: 'pending',
    };
    jobs.set(terminalId, job);
    ensureSweep();
    const timer = setTimeout(() => void fireJob(terminalId), Math.min(fireAt - now, MAX_TIMEOUT_MS));
    timer.unref?.();
    timers.set(terminalId, timer);
    broadcastFn(terminalId, job);
    return job;
}
function cancelRemoteScheduledPrompt(terminalId) {
    if (jobs.get(terminalId)?.status === 'submitting')
        return false;
    clearJobTimer(terminalId);
    const existed = jobs.delete(terminalId);
    stopSweepIfIdle();
    if (existed)
        broadcastFn(terminalId, null);
    return existed;
}
function getRemoteScheduledPrompt(terminalId) {
    return jobs.get(terminalId) ?? null;
}
/** Unit-test hook: drop all jobs/timers without firing or broadcasting. */
function resetScheduledPromptsForTest() {
    for (const terminalId of Array.from(timers.keys()))
        clearJobTimer(terminalId);
    jobs.clear();
    stopSweepIfIdle();
    fireFn = async () => { };
    broadcastFn = () => { };
}
