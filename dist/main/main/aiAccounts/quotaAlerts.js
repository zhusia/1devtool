"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.maxUsedPercent = maxUsedPercent;
exports.pickTrippedWindow = pickTrippedWindow;
exports.evaluateQuotaCrossing = evaluateQuotaCrossing;
/**
 * Pure quota-alert logic — no Electron imports so `tests/unit/ai-quota-alerts.test.mjs`
 * can import it directly. Kept separate from `index.ts` (which imports `safeStorage`).
 */
/** max(session%, weekly%) for a status, or null when usage is unknown / errored. */
function maxUsedPercent(status) {
    if (!status || status.kind === 'error')
        return null;
    const values = [status.primary?.usedPercent, status.secondary?.usedPercent].filter((v) => typeof v === 'number');
    return values.length ? Math.max(...values) : null;
}
/**
 * The window (primary=session/5h or secondary=weekly, per the app convention)
 * with the higher used%. This is what drove `maxUsedPercent`, so its
 * windowMinutes/resetsAt label the alert. Null when no window has a usedPercent.
 */
function pickTrippedWindow(status) {
    const windows = [status?.primary, status?.secondary].filter((w) => !!w && typeof w.usedPercent === 'number');
    if (!windows.length)
        return null;
    return windows.reduce((best, w) => ((w.usedPercent ?? -1) > (best.usedPercent ?? -1) ? w : best));
}
/**
 * Minimum forward jump in `resetsAt` that counts as a genuine new quota window
 * rather than jitter. Some providers derive `resetsAt` from a relative
 * "Refreshes in X" countdown as `Date.now() + remaining` (see antigravity's
 * `durationFromNowMs`). Coarse countdown precision makes that value drift/jitter
 * by up to ~a minute on every re-read (antigravity re-reads on a 60s cache), so a
 * bare `resetsAt > lastResetsAt` test re-armed the alert on nearly every poll and
 * re-fired it forever — the modal then re-queued faster than the user could
 * dismiss it. A real window reset flips the countdown back up by at least a full
 * window (the smallest is the 5h/session window), so a 2h gate cleanly separates
 * "jitter" from "reset".
 */
const WINDOW_RESET_MIN_ADVANCE_MS = 2 * 60 * 60 * 1000;
/**
 * Decide whether a quota crossing should fire an alert, with once-per-window dedup.
 *
 * - Re-arms when the quota window genuinely resets (`resetsAt` jumps forward by at
 *   least a full window; see `WINDOW_RESET_MIN_ADVANCE_MS`) OR when usage falls
 *   back below the threshold.
 * - Fires when `pct >= threshold` and currently armed; firing disarms until re-armed.
 * - First evaluation (no prior state) starts armed, so enabling mid-window while already
 *   over threshold fires immediately.
 */
function evaluateQuotaCrossing(prev, pct, threshold, resetsAt) {
    let armed = prev ? prev.armed : true;
    const lastResetsAt = prev ? prev.lastResetsAt : null;
    // New quota window (reset jumped forward by ≥ a full window) → re-arm. A small
    // forward drift is countdown jitter, not a reset, and must NOT re-arm.
    if (resetsAt != null &&
        lastResetsAt != null &&
        resetsAt - lastResetsAt > WINDOW_RESET_MIN_ADVANCE_MS) {
        armed = true;
    }
    // Usage dropped back below the threshold → re-arm.
    if (pct < threshold) {
        armed = true;
    }
    const fire = pct >= threshold && armed;
    if (fire)
        armed = false;
    return { fire, next: { armed, lastResetsAt: resetsAt } };
}
