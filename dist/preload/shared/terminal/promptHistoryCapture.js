"use strict";
/**
 * Terminal prompt-history capture hotspot. Read
 * docs/common-errors/terminals/INDEX.md (rules B4, B10, B12) before changing
 * how a submitted prompt is recognised in the input stream.
 *
 * Turns the raw keystroke stream an AI terminal receives into the prompts the
 * user actually sent. Pure and synchronous so the semantics can be unit-tested
 * without a PTY.
 *
 * The hard part is that `\r` is a *claimed* submit, not a proven one (B10):
 * Claude's and codex's `@` file-search popups confirm the highlighted entry on
 * Enter while the composer keeps its text, and a bracketed paste carries
 * interior carriage returns that are literal content. Committing on every `\r`
 * shredded one typed prompt into several history rows.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMPTY_PROMPT_CAPTURE = void 0;
exports.hasOpenPickerToken = hasOpenPickerToken;
exports.feedPromptCapture = feedPromptCapture;
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
/** Ceiling on one in-flight prompt. Real prompts never approach it; a runaway
 *  programmatic writer must not grow this buffer without bound. */
const MAX_PENDING_CHARS = 64 * 1024;
exports.EMPTY_PROMPT_CAPTURE = {
    pending: '',
    inBracketedPaste: false,
    nextEnterSubmits: false,
};
/**
 * A token a file/skill picker is completing right now: `@path`, codex `$skill`.
 * Both TUIs open the popup on the trigger character and keep it open while the
 * token is typed, so the Enter that follows confirms the highlighted entry
 * instead of submitting the prompt.
 *
 * The trigger must START a token, so ordinary prose (`ping foo@bar.com`) and
 * text the user already closed with a space are not mistaken for an open
 * picker. Slash commands are deliberately excluded: agents run an exactly
 * typed `/command` on the first Enter, and swallowing it would glue the
 * command onto whatever the user typed next.
 */
const OPEN_PICKER_TOKEN_RE = /(?:^|\s)[@$][^\s]*$/;
function hasOpenPickerToken(pending) {
    return OPEN_PICKER_TOKEN_RE.test(pending);
}
/**
 * Advance past an escape sequence, returning the index of its final byte so the
 * caller's `for` loop lands on the next character. Bracketed-paste markers are
 * handled by the caller before this runs.
 */
function skipEscapeSequence(data, start) {
    const next = data[start + 1];
    if (next === '[') {
        // CSI: parameter bytes 0x20–0x3f, then a final byte.
        let i = start + 2;
        while (i < data.length) {
            const code = data.charCodeAt(i);
            if (code < 0x20 || code > 0x3f)
                break;
            i++;
        }
        return i;
    }
    if (next === ']') {
        // OSC: BEL or ST terminated.
        let i = start + 2;
        while (i < data.length) {
            if (data[i] === '\x07')
                return i;
            if (data[i] === '\x1b' && data[i + 1] === '\\')
                return i + 1;
            i++;
        }
        return i;
    }
    // Bare ESC (picker dismiss) or a two-byte escape like ESC = / ESC >.
    return next === undefined ? start : start + 1;
}
/**
 * Feed one chunk of terminal input and return the updated state plus any
 * prompts the chunk actually submitted.
 */
function feedPromptCapture(state, data) {
    let pending = state.pending;
    let inBracketedPaste = state.inBracketedPaste;
    let nextEnterSubmits = state.nextEnterSubmits;
    const prompts = [];
    const append = (text) => {
        if (pending.length >= MAX_PENDING_CHARS)
            return;
        pending = (pending + text).slice(0, MAX_PENDING_CHARS);
    };
    for (let i = 0; i < data.length; i++) {
        const ch = data[i];
        if (ch === '\x1b') {
            if (data.startsWith(BRACKETED_PASTE_START, i)) {
                inBracketedPaste = true;
                nextEnterSubmits = false;
                i += BRACKETED_PASTE_START.length - 1;
                continue;
            }
            if (data.startsWith(BRACKETED_PASTE_END, i)) {
                inBracketedPaste = false;
                i += BRACKETED_PASTE_END.length - 1;
                continue;
            }
            // A lone ESC is the Escape key — it dismisses an open picker, so the
            // Enter after it really does submit. Anything with a payload after the
            // ESC is a key/protocol sequence and says nothing about the popup.
            const isEscapeKey = i === data.length - 1;
            i = skipEscapeSequence(data, i);
            if (isEscapeKey && pending)
                nextEnterSubmits = true;
            continue;
        }
        if (ch === '\r') {
            // Inside a paste the CR is a line break in the pasted body (B4: the
            // submitting CR is always written outside the markers).
            if (inBracketedPaste) {
                append('\n');
                continue;
            }
            if (pending.trim() && !nextEnterSubmits && hasOpenPickerToken(pending)) {
                // The picker ate this Enter and the composer kept its text. Keep
                // accumulating so the rest of the prompt joins this same record.
                nextEnterSubmits = true;
                continue;
            }
            const promptText = pending.trim();
            if (promptText)
                prompts.push(promptText);
            pending = '';
            nextEnterSubmits = false;
            continue;
        }
        if (ch === '\n') {
            append('\n');
            nextEnterSubmits = false;
            continue;
        }
        if (ch === '\t') {
            // Tab accepts the highlighted completion and closes the popup (codex's
            // `$skill`, Claude's file search), so the Enter after it is a submit.
            // The tab itself was never prompt text — it stays out of `pending`.
            if (pending)
                nextEnterSubmits = true;
            continue;
        }
        if (ch === '\x7f' || ch === '\b') {
            pending = pending.slice(0, -1);
            nextEnterSubmits = false;
            continue;
        }
        if (ch === '\x15' || ch === '\x03') {
            pending = '';
            nextEnterSubmits = false;
            continue;
        }
        if (ch >= ' ') {
            append(ch);
            nextEnterSubmits = false;
        }
    }
    return {
        state: { pending, inBracketedPaste, nextEnterSubmits },
        prompts,
    };
}
