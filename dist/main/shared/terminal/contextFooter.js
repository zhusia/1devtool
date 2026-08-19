"use strict";
/**
 * Context-usage percentage from agent TUI footers.
 *
 * Gemini CLI / Qwen Code paint "model (NN% context left)" and Codex paints
 * "model NN% context left" in their composer footers. `modelDetect.ts` already
 * anchors model extraction on those exact strings but discards the digits —
 * this module captures them, giving agents whose transcripts carry no usable
 * window (gemini, qwen) or whose transcript may lag (codex) a context %
 * straight from the agent's own accounting.
 *
 * The number is the agent's own — exact, not an assumed-window division — but
 * it is only LIVE STATE when it came off the live chunk stream (rule A4:
 * transcript is history). Consumers must apply the freshness contract:
 * a reading counts while the terminal's PTY instance is alive AND no submit
 * happened after `reading.at`; replay-buffer extraction is display-only.
 *
 * Truncation safety: both patterns structurally require an anchor BEFORE the
 * digits (gemini/qwen the "(", codex a model-id-shaped token), so a chunk
 * boundary that beheads the digit run can never fabricate a lower/higher
 * percent — the torn paint simply misses and the next footer repaint catches
 * up. The reverse split (anchor in this chunk, "left" in the next) is joined
 * by the same bounded RAW carry `modelDetect.ts` uses; the carry must stay
 * raw so escape sequences split across chunk boundaries reassemble before
 * stripping (stripping halves separately leaks SGR params into the text).
 *
 * Hot-path contract: callers MUST gate with `mightContainContextFooter(raw)`
 * (one indexOf on the raw chunk) before paying for stripAnsi + regex. Every
 * footer repaint contains the word "context" as one contiguous run, so the
 * gate never misses a real footer. See docs "hotpath-perf": indexOf before
 * regex. No 30s armed window here (unlike model switches): footers repaint
 * continuously and every relevant chunk self-gates.
 *
 * Shared module rules apply: no renderer/main-only imports.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.mightContainContextFooter = mightContainContextFooter;
exports.extractContextPercentFromOutput = extractContextPercentFromOutput;
exports.createContextFooterScanState = createContextFooterScanState;
exports.scanChunkForContextPercent = scanChunkForContextPercent;
exports.extractContextPercentFromReplayBuffer = extractContextPercentFromReplayBuffer;
const replay_1 = require("./replay");
/** Cheap raw-chunk gate — same contract as `mightContainModelInfo`. */
function mightContainContextFooter(raw) {
    return raw.includes('context');
}
// The same anchors modelDetect.ts validates against real CLI output
// (terminal-model-detect.test.mjs — gemini/qwen/codex footer fixtures), with
// the already-matched digits now captured. Keep the two files' regexes in
// sync when a CLI rewords its footer.
const FOOTER_PATTERNS = [
    // Gemini CLI / Qwen Code: "gemini-2.5-pro (98% context left)",
    // "qwen3-coder-plus (100% context left)".
    {
        kinds: ['gemini', 'qwen'],
        re: /(\S{2,})\s+\((\d{1,3})% context left\)/g,
        validateModel: (c) => /[a-z]/i.test(c) && !c.startsWith('('),
    },
    // Codex inline footer (no parens): "gpt-5.5 71% context left". The
    // model-id-shaped token requirement keeps prose like "50% context left"
    // from capturing.
    {
        kinds: ['codex'],
        re: /\b((?:gpt-|o\d|codex)[\w.:/-]*)\s+(\d{1,3})% context left/gi,
    },
];
/**
 * Extract the latest footer percent from an ANSI-stripped chunk. Last match
 * wins (footers repaint in bulk chunks). Returns null for kinds without a
 * footer pattern — custom/unknown agents are deliberately excluded: an
 * unverifiable CLI must never feed a context %.
 */
function extractContextPercentFromOutput(stripped, kind) {
    if (!kind)
        return null;
    const text = stripped.replace(/\r/g, '\n');
    for (const pattern of FOOTER_PATTERNS) {
        if (!pattern.kinds.includes(kind))
            continue;
        pattern.re.lastIndex = 0;
        let last = null;
        let match;
        while ((match = pattern.re.exec(text)) !== null) {
            if (match.index === pattern.re.lastIndex)
                pattern.re.lastIndex++;
            const percentLeft = Number(match[2]);
            if (!Number.isFinite(percentLeft) || percentLeft > 100)
                continue;
            // The model token is best-effort display metadata; the percent is the
            // payload. Drop the model whenever it could be torn: a capture at text
            // index 0 may have lost its true start to a chunk/carry boundary, and a
            // torn escape leaks SGR params as digit/semicolon prefixes glued onto
            // the token ("161mgemini-2.5-pro"). The percent digits cannot be
            // corrupted the same way — their required anchor sits between them and
            // any tear (see the header comment).
            let model = match[1]?.trim();
            if (!model ||
                match.index === 0 ||
                /[;\x00-\x1f\x9b]/.test(model) ||
                !/^[a-z]/i.test(model) ||
                (pattern.validateModel && !pattern.validateModel(model))) {
                model = undefined;
            }
            last = { percentLeft, ...(model ? { model } : {}) };
        }
        if (last) {
            return { percentUsed: 100 - last.percentLeft, ...(last.model ? { model: last.model } : {}) };
        }
    }
    return null;
}
const FOOTER_SCAN_CARRY_CHARS = 512;
const FOOTER_SCAN_PENDING_CHUNKS = 3;
function createContextFooterScanState() {
    return { carry: '', pending: 0 };
}
/**
 * Scan one raw PTY chunk for the footer percent, carrying a bounded RAW tail
 * across chunk boundaries. Mutates `state` in place. Cost when the gate
 * misses and nothing is pending: one indexOf.
 */
function scanChunkForContextPercent(state, rawChunk, kind, now = Date.now()) {
    if (!kind)
        return null;
    const gated = mightContainContextFooter(rawChunk);
    if (!gated && state.pending === 0)
        return null;
    const combined = state.carry + rawChunk;
    const text = (0, replay_1.stripAnsiPreservingLayout)(combined);
    const extracted = extractContextPercentFromOutput(text, kind);
    if (extracted) {
        state.carry = '';
        state.pending = 0;
        return { ...extracted, at: now };
    }
    state.pending = gated ? FOOTER_SCAN_PENDING_CHUNKS : Math.max(0, state.pending - 1);
    state.carry = state.pending > 0 ? combined.slice(-FOOTER_SCAN_CARRY_CHARS) : '';
    return null;
}
/**
 * One-shot scan of a replayed/saved buffer tail (remount, app-restart
 * hydration). The result is HISTORY — callers must mark it stale and never
 * let it drive anything beyond chip display.
 */
const REPLAY_SCAN_TAIL_CHARS = 32768;
function extractContextPercentFromReplayBuffer(buffer, kind) {
    if (!buffer || !kind)
        return null;
    const tail = buffer.length > REPLAY_SCAN_TAIL_CHARS ? buffer.slice(-REPLAY_SCAN_TAIL_CHARS) : buffer;
    if (!mightContainContextFooter(tail))
        return null;
    return extractContextPercentFromOutput((0, replay_1.stripAnsiPreservingLayout)(tail), kind);
}
