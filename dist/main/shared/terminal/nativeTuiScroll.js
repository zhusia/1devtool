"use strict";
/*
 * Native-TUI scroll helpers. Read docs/common-errors/terminals/INDEX.md before
 * changing the wheel protocol or jump bounds (cline-grok-native-tui-scroll.md).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NATIVE_TUI_JUMP_CHUNK_DELAY_MS = exports.NATIVE_TUI_JUMP_CHUNK_SIZE = exports.NATIVE_TUI_SCROLLBAR_COLUMNS = void 0;
exports.getNativeTuiJumpChunkSize = getNativeTuiJumpChunkSize;
exports.updateNativeTuiScrollDepth = updateNativeTuiScrollDepth;
exports.getNativeTuiJumpReportCount = getNativeTuiJumpReportCount;
exports.isAppOwnedScrollViewport = isAppOwnedScrollViewport;
exports.isNativeTuiScrollbarColumn = isNativeTuiScrollbarColumn;
exports.buildNativeTuiScrollbarJumpToBottomSequence = buildNativeTuiScrollbarJumpToBottomSequence;
exports.buildNativeTuiWheelDownReport = buildNativeTuiWheelDownReport;
exports.buildNativeTuiJumpToBottomSequence = buildNativeTuiJumpToBottomSequence;
const WHEEL_PIXELS_PER_REPORT = 20;
const MAX_TRACKED_SCROLL_REPORTS = 4096;
/** Max SGR wheel-down reports for a single jump-to-bottom action. */
const MAX_JUMP_REPORTS = 1024;
/**
 * OpenTUI scrollbars are painted in the rightmost column. Allow a 2-cell hit
 * target so clicks near the edge still reach the app instead of the host
 * selection shim.
 */
exports.NATIVE_TUI_SCROLLBAR_COLUMNS = 2;
/** Upper bound on wheel reports per paced jump chunk. */
exports.NATIVE_TUI_JUMP_CHUNK_SIZE = 6;
/**
 * Reports per paced write, sized so ONE write never exceeds ConPTY's chunk
 * budget. `splitPtyWriteForConpty` slices blindly at `PTY_WRITE_CHUNK_SIZE`
 * and will happily cut an SGR report in half: a chunk ending in a bare `ESC[`
 * is delivered 5 ms before its tail, the agent's parser times the incomplete
 * sequence out, and the remainder (`<65;64;12M`) lands in its composer as
 * literal text. Observed on real Windows/OpenCode.
 * See docs/common-errors/terminals/windows-native-tui-normal-buffer.md
 */
function getNativeTuiJumpChunkSize(reportLength, maxWriteChars) {
    const safeReport = Math.max(1, Math.trunc(reportLength));
    const safeMax = Math.max(1, Math.trunc(maxWriteChars));
    return Math.max(1, Math.min(exports.NATIVE_TUI_JUMP_CHUNK_SIZE, Math.floor(safeMax / safeReport)));
}
/** Delay between paced jump chunks (ms). OpenTUI coalesces huge single bursts. */
exports.NATIVE_TUI_JUMP_CHUNK_DELAY_MS = 8;
function updateNativeTuiScrollDepth(currentDepth, deltaPixels) {
    const safeDepth = Math.max(0, Math.min(MAX_TRACKED_SCROLL_REPORTS, Math.trunc(currentDepth)));
    if (!Number.isFinite(deltaPixels) || deltaPixels === 0)
        return safeDepth;
    // xterm emits one SGR wheel report per browser wheel event when mouse tracking
    // is on (getLinesScrolled amount is only a zero-check). Track by event so the
    // jump budget matches what the app actually received while the user scrolled.
    const reports = Math.max(1, Math.min(8, Math.ceil(Math.abs(deltaPixels) / WHEEL_PIXELS_PER_REPORT)));
    return deltaPixels < 0
        ? Math.min(MAX_TRACKED_SCROLL_REPORTS, safeDepth + reports)
        : Math.max(0, safeDepth - reports);
}
function getNativeTuiJumpReportCount(rows, estimatedDepth) {
    const safeRows = Math.max(1, Math.trunc(rows));
    const safeDepth = Math.max(0, Math.trunc(estimatedDepth));
    // Prefer overshooting: extra wheel-downs at the tail are no-ops for the app.
    // The previous rows*4 floor only covered ~4 viewports when depth was low, so
    // long Grok/OpenTUI sessions stopped a few screens short of the live prompt.
    return Math.min(MAX_JUMP_REPORTS, Math.max(safeRows * 40, safeDepth * 4 + safeRows * 8, 256));
}
/**
 * True when the *application* owns the visible scroll position, so host-side
 * xterm viewport APIs cannot move it and scroll affordances must send input.
 *
 * Alternate screen is the classic signal, but it is NOT the only one: measured
 * on real Windows/ConPTY, OpenCode runs its full-screen TUI in the NORMAL
 * buffer while enabling mouse tracking (`?1000/1002/1003/1006h`), and Grok
 * enables neither. Gating on `bufferType === 'alternate'` alone therefore made
 * every native-TUI affordance dead code on Windows.
 * See docs/common-errors/terminals/windows-native-tui-normal-buffer.md
 */
function isAppOwnedScrollViewport(xterm) {
    if (xterm.buffer.active.type === 'alternate')
        return true;
    const mouse = xterm.modes?.mouseTrackingMode;
    return Boolean(mouse) && mouse !== 'none';
}
/** True when a 0-based cell column sits in the native-TUI scrollbar gutter. */
function isNativeTuiScrollbarColumn(col, cols) {
    const safeCols = Math.max(1, Math.trunc(cols));
    const safeCol = Math.trunc(col);
    if (!Number.isFinite(safeCol) || safeCol < 0)
        return false;
    return safeCol >= Math.max(0, safeCols - exports.NATIVE_TUI_SCROLLBAR_COLUMNS);
}
/** SGR left-click on the bottom of the app-owned scrollbar track (1-based). */
function buildNativeTuiScrollbarJumpToBottomSequence(cols, rows) {
    const safeCols = Math.max(1, Math.trunc(cols));
    const safeRows = Math.max(1, Math.trunc(rows));
    // Keep one row above the absolute bottom so footer chrome is less likely to
    // swallow the click; the rightmost column is the OpenTUI scroll track.
    const column = safeCols;
    const row = Math.max(1, safeRows - 1);
    return `\x1b[<0;${column};${row}M\x1b[<0;${column};${row}m`;
}
/** Single SGR wheel-down report aimed at the transcript body (1-based). */
function buildNativeTuiWheelDownReport(cols, rows) {
    const safeCols = Math.max(1, Math.trunc(cols));
    const safeRows = Math.max(1, Math.trunc(rows));
    // Mid-width, slightly below center — header/outline chrome often owns the top
    // third of OpenTUI layouts, so wheel reports aimed too high are ignored.
    const column = Math.max(1, Math.ceil(safeCols / 2));
    const row = Math.max(1, Math.min(safeRows, Math.floor(safeRows * 0.55)));
    return `\x1b[<65;${column};${row}M`;
}
/**
 * Build the full jump-to-bottom sequence: scrollbar track click first, then a
 * large wheel-down burst. Prefer paced writes via
 * `getNativeTuiJumpReportCount` + `buildNativeTuiWheelDownReport` when the host
 * can schedule chunks; this one-shot form remains for tests and simple callers.
 */
function buildNativeTuiJumpToBottomSequence(cols, rows, estimatedDepth) {
    const wheel = buildNativeTuiWheelDownReport(cols, rows);
    return (buildNativeTuiScrollbarJumpToBottomSequence(cols, rows) +
        wheel.repeat(getNativeTuiJumpReportCount(rows, estimatedDepth)));
}
