"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RECENT_NOVEL_OUTPUT_WINDOW_MS = exports.RECENT_RUN_ACTIVITY_WINDOW_MS = void 0;
exports.createNovelOutputTracker = createNovelOutputTracker;
exports.getBackgroundRunStartedAt = getBackgroundRunStartedAt;
exports.isStaleRunAnchor = isStaleRunAnchor;
exports.RECENT_RUN_ACTIVITY_WINDOW_MS = 5000;
// Novel-output window: OpenTUI agents (OpenCode/Grok/Cline) animate their
// spinner as a closed loop of byte-identical PTY frames (~23 chunks/s, 84
// bytes, 100% repeats after the first cycle — captured from a real OpenCode
// retry state), so the stream NEVER goes silent while the agent sits failed or
// idle-retrying. Repeated frames convey no progress: a run whose output has
// produced nothing NOVEL for this window is over. Longer than the silence
// window because a genuinely thinking agent may loop its spinner between
// status updates.
exports.RECENT_NOVEL_OUTPUT_WINDOW_MS = 12_000;
// Hash ring sizing: the observed OpenCode loop cycles < 60 distinct frames;
// 128 entries absorbs it plus occasional read-coalesced frame pairs. Chunks
// larger than the hash cap are real content (idle loops paint tiny deltas)
// and always count as novel — this also keeps heavy streaming out of the
// hash path entirely.
const NOVEL_TRACKER_MAX_ENTRIES = 128;
const NOVEL_TRACKER_MAX_HASH_LENGTH = 2048;
function createNovelOutputTracker(maxEntries = NOVEL_TRACKER_MAX_ENTRIES) {
    const seen = new Set();
    const order = [];
    return {
        note(chunk) {
            if (chunk.length === 0 || chunk.length > NOVEL_TRACKER_MAX_HASH_LENGTH)
                return true;
            let h = 0;
            for (let i = 0; i < chunk.length; i++)
                h = (h * 31 + chunk.charCodeAt(i)) | 0;
            if (seen.has(h))
                return false;
            seen.add(h);
            order.push(h);
            if (order.length > maxEntries) {
                const evicted = order.shift();
                if (evicted !== undefined)
                    seen.delete(evicted);
            }
            return true;
        },
    };
}
/**
 * Resolve the start timestamp of a background terminal's active run.
 *
 * A real Enter-bearing input is the ownership/start signal. Fresh output only
 * keeps that submitted run alive; it cannot manufacture a run from startup or
 * idle redraw output. The short submit grace covers the gap before first output.
 */
function getBackgroundRunStartedAt(status, now = Date.now(), activityWindowMs = exports.RECENT_RUN_ACTIVITY_WINDOW_MS, novelWindowMs = exports.RECENT_NOVEL_OUTPUT_WINDOW_MS) {
    if (!status?.isAlive || status.lastSubmitAt <= 0)
        return null;
    if (status.lastRunEndedAt != null && status.lastRunEndedAt >= status.lastSubmitAt)
        return null;
    const submitIsRecent = now - status.lastSubmitAt < activityWindowMs;
    const hasRecentPostSubmitOutput = status.lastActivityAt >= status.lastSubmitAt &&
        now - status.lastActivityAt < activityWindowMs;
    // Repeated-frame animation keeps lastActivityAt fresh forever without
    // conveying progress — the run is alive only while NOVEL output also flows.
    const lastNovel = status.lastNovelActivityAt ?? status.lastActivityAt;
    const hasRecentNovelOutput = lastNovel >= status.lastSubmitAt && now - lastNovel < novelWindowMs;
    return submitIsRecent || (hasRecentPostSubmitOutput && hasRecentNovelOutput)
        ? status.lastSubmitAt
        : null;
}
/**
 * True when a background-derived run anchor refers to a run that already
 * finished. Stray post-run PTY output (idle TUI repaints, retry countdowns,
 * notifications) keeps `lastActivityAt` fresh and would otherwise resurrect
 * the finished run under its old submit anchor — a phantom spinner counting
 * from the original submit that flips back to done a few seconds later. A
 * genuinely new run always carries an Enter-bearing submit NEWER than the
 * recorded end of the previous one.
 */
function isStaleRunAnchor(prev, startedAt) {
    return prev?.status === 'done' && prev.endedAt != null && startedAt <= prev.endedAt;
}
