"use strict";
/**
 * Shared terminal replay and sanitization pipeline.
 *
 * This is the ONLY place for ANSI/control-sequence filtering and stripping.
 * Do not create ad-hoc regex copies in pty.ts, terminalStore.ts, or elsewhere.
 * Rules C1/C2 in docs/common-errors/terminals/INDEX.md: query stripping is
 * replay/persist-path-only (live apps need their reports), and never strip the
 * syntactically-identical `rgb:` SET form.
 * Bounded replay buffers must carry active screen/input modes across trims so
 * a remounted xterm can still drive a live native TUI
 * (cline-grok-native-tui-scroll.md). Historical AI saved buffers are different:
 * their alt-screen modes are linearized without changing live ownership
 * (windows-shell-history-agent-marker-scroll-hijack.md).
 *
 * No renderer-only imports (xterm, react, DOM).
 * No main-only imports (node-pty, electron, fs).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AI_FALLBACK_TRANSCRIPT_SEPARATOR = exports.AI_FALLBACK_SAVED_BUFFER_MAX_CHARS = void 0;
exports.scanOscColorQueries = scanOscColorQueries;
exports.formatOscColorReport = formatOscColorReport;
exports.stripOscColorReports = stripOscColorReports;
exports.sanitizeLivePtyChunk = sanitizeLivePtyChunk;
exports.sanitizeReplayBuffer = sanitizeReplayBuffer;
exports.sanitizeRecordingChunk = sanitizeRecordingChunk;
exports.trimReplayBufferPreservingModes = trimReplayBufferPreservingModes;
exports.joinDeferredLiveChunks = joinDeferredLiveChunks;
exports.composeAiFallbackSavedBuffer = composeAiFallbackSavedBuffer;
exports.stripAnsi = stripAnsi;
exports.stripAnsiPreservingLayout = stripAnsiPreservingLayout;
// ── Regex patterns ──────────────────────────────────────────────────────────
// Device Attributes: DA1 (ESC[?...c), DA2 (ESC[>...c), and bare variants
const DA_RESPONSE_RE = /\x1b\[[?>]?[\d;]*c/g;
// Cursor Position Report (CPR)
const CPR_RE = /\x1b\[[\d;]*R/g;
// tmux detach message
const TMUX_DETACH_RE = /\[detached \(from session [^\)]+\)\]\r?\n?/g;
// Malformed visible DA variants (show as ›...c in some terminals)
const MALFORMED_DA_RE = /›\s*[\d;]+c/g;
// OSC color QUERY: OSC 10/11/12 (fg/bg/cursor) and OSC 4/104 (palette) with a
// trailing '?'. Apps emit these to learn the terminal's colors; the query is
// part of the PTY output and lands in the saved buffer. On remount the buffer
// is replayed into a FRESH xterm, which dutifully answers by emitting a
// `\x1b]11;rgb:...` report back to the PTY (terminalStore onData → pty.write).
// If the original app has since exited (e.g. a crashed agent → shell prompt),
// the shell echoes that report as visible garbage: `]11;rgb:0d0d/1111/1717`
// (0d0d/1111/1717 == #0D1117, xterm's own background). Strip the query on
// replay so the fresh xterm has nothing to answer. NOT stripped on the live
// path: a running app legitimately needs the report for light/dark theme
// detection. Color SET commands (`]11;rgb:...`, no '?') are preserved.
const OSC_COLOR_QUERY_RE = /\x1b\](?:104|10|11|12|4);(?:[0-9]+;)?\?(?:\x07|\x1b\\)?/g;
// Mouse tracking mode enable/disable sequences (X10, Normal, Button, Any, SGR, URXVT).
// Stripped so xterm.js handles selection natively instead of forwarding to tmux.
const MOUSE_TRACKING_RE = /\x1b\[\?(?:9|1000|1002|1003|1006|1015)[hl]/g;
// DEC private modes whose state must survive a bounded pipe-buffer trim. A
// native TUI normally emits these once during startup. If that setup ages out
// while the process remains alive, replaying the raw tail into a fresh xterm
// leaves it in the normal buffer with mouse reporting off. Cline/Grok OpenTUI
// sessions then receive no wheel input after a project/tab remount.
const DEC_PRIVATE_MODE_RE = /\x1b\[\?([0-9]+(?:;[0-9]+)*)([hl])/g;
const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);
const MOUSE_PROTOCOL_MODES = new Set([9, 1000, 1002, 1003]);
const MOUSE_ENCODING_MODES = new Set([1005, 1006, 1015, 1016]);
const INDEPENDENT_REPLAY_MODES = new Set([1004, 2004]);
// Soft-clear: CSI 2 J (Erase Display All). xterm.js implements this as "scroll
// current viewport into scrollback + clear screen", which pollutes the user's
// scrollback with N empty rows every time tmux/the shell wants a redraw. Rewrite
// to CSI H + CSI J (cursor home + erase-below), which clears the viewport in
// place with NO scrollback push. Visually identical to the user, harmless in
// alt-buffer mode, and the established fix path (see interactiveAgent.ts's
// 'soft-clear' token, which does the same thing for AI terminals).
const SOFT_CLEAR_RE = /\x1b\[2J/g;
const HARD_CLEAR_REPLACEMENT = '\x1b[H\x1b[J';
// Fg/bg/cursor queries only. Palette queries (OSC 4) are NOT answered by main:
// a faithful 256-slot palette is emulator state, and no supported agent has
// needed one during its startup window.
const OSC_FG_BG_CURSOR_QUERY_RE = /\x1b\](10|11|12);\?(\x07|\x1b\\)/g;
// A reply the emulator (renderer xterm, popout, phone mirror) generated for a
// query main already answered. Matches the report form only — `rgb:` with
// channel values — never a query, and only ESC-led sequences, which no human
// input path produces.
const OSC_COLOR_REPORT_RE = /\x1b\](?:10|11|12);rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}(?:\x07|\x1b\\)/g;
// Longest suffix that is a proper prefix of an OSC 10/11/12 query (at most
// `\x1b]10;?\x1b` = 7 chars), i.e. a query split across PTY chunks.
const OSC_COLOR_QUERY_PREFIX_RE = /^\x1b(?:\](?:1(?:[012](?:;(?:\?(?:\x1b)?)?)?)?)?)?$/;
function pendingColorQueryPrefix(text) {
    const max = Math.min(7, text.length);
    for (let length = max; length > 0; length -= 1) {
        const tail = text.slice(-length);
        if (OSC_COLOR_QUERY_PREFIX_RE.test(tail))
            return tail;
    }
    return '';
}
/**
 * Find complete OSC 10/11/12 color queries in `carry + chunk`. The returned
 * carry holds a trailing partial query (if any) for the next call; a query is
 * therefore reported exactly once even when split across chunk boundaries.
 */
function scanOscColorQueries(carry, chunk) {
    const text = carry + chunk;
    const queries = [];
    OSC_FG_BG_CURSOR_QUERY_RE.lastIndex = 0;
    let match;
    while ((match = OSC_FG_BG_CURSOR_QUERY_RE.exec(text)) !== null) {
        queries.push({
            code: match[1],
            terminator: match[2],
        });
    }
    return { queries, carry: pendingColorQueryPrefix(text) };
}
/**
 * The `rgb:rrrr/gggg/bbbb` report xterm would send for a `#RRGGBB` color,
 * echoing the query's own terminator (BEL query → BEL reply, ST → ST).
 */
function formatOscColorReport(code, hexColor, terminator) {
    let hex = hexColor.replace('#', '').toLowerCase();
    if (/^[0-9a-f]{3}$/.test(hex))
        hex = hex.split('').map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}/.test(hex))
        hex = '000000';
    const channel = (index) => {
        const value = hex.slice(index * 2, index * 2 + 2);
        return value + value;
    };
    return `\x1b]${code};rgb:${channel(0)}/${channel(1)}/${channel(2)}${terminator}`;
}
/**
 * Remove emulator-generated OSC 10/11/12 color reports from an input chunk.
 * Applied on emulator-reply channels only (renderer `terminal-response`
 * origin, phone-mirror input) — never on output or typed user input.
 */
function stripOscColorReports(data) {
    return data.replace(OSC_COLOR_REPORT_RE, '');
}
// ── ANSI stripping (for plain-text extraction) ─────────────────────────────
// OSC sequences (ESC ] ... BEL or ESC ] ... ST)
const OSC_RE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
// CSI sequences (ESC [ ... final byte)
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// Two-byte escape sequences (ESC + single byte)
const TWO_BYTE_ESCAPE_RE = /\x1b[@-_]/g;
// Character set designations (ESC ( X, ESC ) X)
const CHARSET_RE = /\x1b[()][A-Z0-9]/g;
// Misc single-byte escapes (ESC =, ESC >, ESC N, etc.)
const MISC_ESCAPE_RE = /\x1b[=>NOM78HPDcn]/g;
// Control characters except tab, newline, carriage return
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
/**
 * Core sanitization: removes terminal response sequences that should never
 * be visible. This is the superset of all known problematic sequences.
 */
function sanitizeCore(data, options = {}) {
    let sanitized = data
        .replace(DA_RESPONSE_RE, '')
        .replace(CPR_RE, '')
        .replace(TMUX_DETACH_RE, '')
        .replace(MALFORMED_DA_RE, '');
    if (options.stripColorQueries) {
        sanitized = sanitized.replace(OSC_COLOR_QUERY_RE, '');
    }
    if (options.stripMouseTracking ?? true) {
        sanitized = sanitized.replace(MOUSE_TRACKING_RE, '');
    }
    const stripMouseTracking = options.stripMouseTracking ?? true;
    if (options.stripAltScreen || stripMouseTracking) {
        sanitized = sanitized.replace(DEC_PRIVATE_MODE_RE, (_match, rawModes, final) => {
            const keptModes = rawModes
                .split(';')
                .filter((mode) => {
                const value = Number(mode);
                if (options.stripAltScreen && ALT_SCREEN_MODES.has(value))
                    return false;
                if (stripMouseTracking && (MOUSE_PROTOCOL_MODES.has(value) || MOUSE_ENCODING_MODES.has(value))) {
                    return false;
                }
                return true;
            });
            return keptModes.length > 0 ? `\x1b[?${keptModes.join(';')}${final}` : '';
        });
    }
    if (options.rewriteSoftClear) {
        sanitized = sanitized.replace(SOFT_CLEAR_RE, HARD_CLEAR_REPLACEMENT);
    }
    return sanitized;
}
/**
 * Sanitize a live PTY data chunk before writing to xterm or storing in buffer.
 * Runs the full sanitization pass. This is the hot path — called on every chunk.
 */
function sanitizeLivePtyChunk(data, options) {
    return sanitizeCore(data, options);
}
/**
 * Sanitize a stored buffer before replaying into xterm (remount, reopen, tmux reattach).
 * Runs the full sanitization pass.
 */
function sanitizeReplayBuffer(data, options) {
    return sanitizeCore(data, { ...options, stripColorQueries: true });
}
/**
 * Sanitize a terminal recording chunk before persistence or playback.
 * Keep this aligned with live/replay sanitization so persisted recordings do
 * not retain terminal response sequences that would be hidden elsewhere.
 */
function sanitizeRecordingChunk(data, options) {
    return sanitizeCore(data, { ...options, stripColorQueries: true });
}
/**
 * Tail-cap a replay buffer without discarding the active native-TUI modes.
 *
 * Alternate-screen, mouse protocol/encoding, focus-reporting, and bracketed
 * paste modes are state, not transcript. The pipe buffer is the only source a
 * fresh xterm has after a renderer remount, so active modes from the discarded
 * prefix are re-emitted before the retained tail. Any later mode changes in the
 * tail are replayed afterward and therefore remain authoritative.
 */
function trimReplayBufferPreservingModes(data, maxChars) {
    if (maxChars <= 0)
        return '';
    if (data.length <= maxChars)
        return data;
    const requestedCut = data.length - maxChars;
    const nextEscape = data.indexOf('\x1b', requestedCut);
    const nextNewline = data.indexOf('\n', requestedCut);
    let cut = requestedCut;
    // Start the retained tail at a control-sequence or line boundary when one is
    // nearby. This prevents a trim from splitting the very DECSET/DECRST sequence
    // whose state we need to reconstruct.
    if (nextEscape >= 0 && (nextNewline < 0 || nextEscape <= nextNewline)) {
        cut = nextEscape;
    }
    else if (nextNewline >= 0) {
        cut = nextNewline + 1;
    }
    const discarded = data.slice(0, cut);
    const retained = data.slice(cut);
    let altScreenMode = null;
    let mouseProtocolMode = null;
    let mouseEncodingMode = null;
    const independentModes = new Set();
    DEC_PRIVATE_MODE_RE.lastIndex = 0;
    let match;
    while ((match = DEC_PRIVATE_MODE_RE.exec(discarded)) !== null) {
        const enabled = match[2] === 'h';
        for (const rawMode of match[1].split(';')) {
            const mode = Number(rawMode);
            if (ALT_SCREEN_MODES.has(mode)) {
                altScreenMode = enabled ? mode : null;
            }
            else if (MOUSE_PROTOCOL_MODES.has(mode)) {
                mouseProtocolMode = enabled ? mode : null;
            }
            else if (MOUSE_ENCODING_MODES.has(mode)) {
                mouseEncodingMode = enabled ? mode : null;
            }
            else if (INDEPENDENT_REPLAY_MODES.has(mode)) {
                if (enabled)
                    independentModes.add(mode);
                else
                    independentModes.delete(mode);
            }
        }
    }
    const replayModes = [];
    if (altScreenMode !== null)
        replayModes.push(altScreenMode);
    if (mouseProtocolMode !== null)
        replayModes.push(mouseProtocolMode);
    if (mouseEncodingMode !== null)
        replayModes.push(mouseEncodingMode);
    replayModes.push(...Array.from(independentModes).sort((a, b) => a - b));
    const modePrefix = replayModes.length > 0
        ? `\x1b[?${replayModes.join(';')}h`
        : '';
    return modePrefix + retained;
}
/**
 * Join deferred live chunks, dropping every chunk the replay snapshot already
 * contains. A remounting view subscribes to live output BEFORE snapshotting
 * the pipe buffer (so nothing is lost), which means chunks arriving in
 * between exist in BOTH streams — flushing them after the replay wrote the
 * snapshot duplicated streaming AI answers (first copy cut mid-line at the
 * snapshot boundary). The pipe-buffer seq makes the overlap exact: a deferred
 * chunk with `seq <= snapshotSeq` is already part of the snapshot.
 */
function joinDeferredLiveChunks(chunks, snapshotSeq) {
    let joined = '';
    for (const chunk of chunks) {
        if (chunk.seq !== undefined && chunk.seq <= snapshotSeq)
            continue;
        joined += chunk.data;
    }
    return joined;
}
// ── AI fallback saved buffer (Fix 3, docs/product/feedback/liam.md) ────────────
/**
 * Cap for the fallback transcript saved for AI terminals that have no
 * `lastSessionId` at quit (native resume replays a fresher transcript, so
 * terminals WITH a session id never store one). Bounds store growth: the
 * store JSON is loaded synchronously at boot.
 */
exports.AI_FALLBACK_SAVED_BUFFER_MAX_CHARS = 256 * 1024;
/**
 * Compose the persisted fallback buffer for an id-less AI terminal across
 * quit cycles. The previous saved transcript is kept ABOVE this session's
 * output — otherwise one restore-then-idle cycle would clobber a meaty
 * transcript with a bare agent splash screen. Tail-capped at a line boundary
 * so the result never starts mid-escape-sequence.
 */
function composeAiFallbackSavedBuffer(existingSaved, sessionBuffer, maxChars = exports.AI_FALLBACK_SAVED_BUFFER_MAX_CHARS) {
    const combined = existingSaved ? existingSaved + sessionBuffer : sessionBuffer;
    if (combined.length <= maxChars)
        return combined;
    const tail = combined.slice(-maxChars);
    const firstNewline = tail.indexOf('\n');
    if (firstNewline >= 0 && firstNewline < tail.length - 1) {
        return tail.slice(firstNewline + 1);
    }
    return tail;
}
/**
 * Divider written between a hydrated fallback transcript and the fresh agent
 * session that follows it. One dim LINE only — never wrap the whole restored
 * block in a color (see feedback_ai_terminal_monochrome_replay: a block-wide
 * dim wrap made the entire restored transcript look monochrome). The leading
 * SGR reset also closes any dangling attributes from the tail-capped buffer.
 */
exports.AI_FALLBACK_TRANSCRIPT_SEPARATOR = '\r\n\x1b[0m\x1b[2m── end of previous session · new agent session starts below ──\x1b[0m\r\n\r\n';
// ── ANSI strippers ──────────────────────────────────────────────────────────
/**
 * Strip all ANSI escape sequences from a string for plain-text extraction.
 * Used for: agent output detection, plain-text preview, pipe output cleaning.
 */
function stripAnsi(text) {
    return text
        .replace(OSC_RE, '')
        .replace(CSI_RE, '')
        .replace(TWO_BYTE_ESCAPE_RE, '')
        .replace(CHARSET_RE, '')
        .replace(MISC_ESCAPE_RE, '')
        .replace(CONTROL_CHARS_RE, '');
}
// Ink-style TUIs (Claude Code, Codex, Gemini CLI) paint lines by positioning
// the cursor instead of printing whitespace: "Set model to Fable 5" arrives as
// "Set\x1b[10Gmodel\x1b[16Gto\x1b[19G\x1b[1mFable 5" — every inter-word gap is
// a CHA column jump, and diff-repaints skip unchanged cells with CUF. Plain
// stripAnsi deletes those motions and glues the words ("SetmodeltoFable 5"),
// which silently defeats any anchor-phrase matching over agent output.
const CURSOR_FORWARD_RE = /\x1b\[[0-9]*C/g; // CUF — relative, always intra-line
const CURSOR_COLUMN_RE = /\x1b\[([0-9]*)[G`]/g; // CHA/HPA — absolute column
const CURSOR_VERTICAL_RE = /\x1b\[[0-9;]*[ABEFdHf]/g; // CUU/CUD/CNL/CPL/VPA/CUP
/**
 * Strip ANSI like `stripAnsi`, but first convert cursor motions into
 * whitespace so scanned text reads like the rendered screen: horizontal
 * motions become a space, vertical/absolute motions (and column-1 jumps,
 * which are line restarts like `\r`) become a newline. Use this — not bare
 * stripAnsi — whenever matching multi-word phrases against TUI output.
 */
function stripAnsiPreservingLayout(text) {
    return stripAnsi(text
        .replace(CURSOR_FORWARD_RE, ' ')
        .replace(CURSOR_COLUMN_RE, (_seq, column) => column === '' || column === '0' || column === '1' ? '\n' : ' ')
        .replace(CURSOR_VERTICAL_RE, '\n'));
}
