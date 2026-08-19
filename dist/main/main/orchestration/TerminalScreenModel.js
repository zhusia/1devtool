"use strict";
/**
 * Small main-process VT screen used only for positive Agent Team readiness.
 *
 * Terminal safety rules: docs/common-errors/terminals/INDEX.md (A5, A6, B1,
 * B17, C5, C9). In particular, composer text is styled state: muted text painted
 * after the cursor is a TUI hint, not a user draft.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalScreenModel = exports.GROK_RESPONDING_TITLE_GRACE_MS = void 0;
exports.showsGrokTurnRunning = showsGrokTurnRunning;
exports.hasKnownReadyMarker = hasKnownReadyMarker;
const agentReadiness_1 = require("../../shared/terminal/agentReadiness");
const DEFAULT_ROWS = 30;
const DEFAULT_COLS = 160;
const GROK_ACTIVE_SPINNER_RE = /(?:^|\n)\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?:\s|$)/u;
const GROK_SPINNER_CHARS = new Set(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);
// Grok 1.0 can leave its OSC `Responding` title behind after the completed
// turn repaint restores an idle composer. The title exists to close the short
// pre-spinner admission race; after this grace, only live screen state may
// keep Windows readiness blocked.
exports.GROK_RESPONDING_TITLE_GRACE_MS = 5_000;
function showsGrokTurnRunning(screen, title = '') {
    return /\bResponding\b/i.test(title) || GROK_ACTIVE_SPINNER_RE.test(screen);
}
// `requesting permission` / `do you want to proceed` are agy's (Antigravity
// CLI) tool-permission dialog, transcribed from a field screenshot where the
// delegate sat on it invisibly — the title keywords before this addition all
// assumed the keyword STARTS the line.
const NEEDS_INPUT_TITLE_RE = /(?:^|\n)\s*(?:approve|confirm|allow|permission|requesting permission|do you want to proceed|are you sure|bash command|yes\s*\/\s*no)\b/i;
const NEEDS_INPUT_ACTION_RE = /(?:^|\n).*?(?:[>❯▶]\s*(?:\d+\.\s*)?(?:yes|allow|approve)|(?:enter|return)\s+(?:to\s+)?(?:confirm|approve|continue)|esc\s+(?:to\s+)?cancel)/i;
class ScreenCell {
    chars;
    style;
    paintOrdinal;
    constructor(chars, style, 
    /** Monotonic paint order, used to distinguish a live cursor-painted
     * status cell from an older cell still visible elsewhere in the frame. */
    paintOrdinal) {
        this.chars = chars;
        this.style = style;
        this.paintOrdinal = paintOrdinal;
    }
    getChars() { return this.chars; }
    getWidth() { return 1; }
    isDim() { return this.style.dim; }
    isFgPalette() { return this.style.foregroundMode === 'palette'; }
    isFgRGB() { return this.style.foregroundMode === 'rgb'; }
    getFgColor() { return this.style.foreground; }
}
class TerminalScreenModel {
    height;
    width;
    platform;
    rows;
    row = 0;
    col = 0;
    savedRow = 0;
    savedCol = 0;
    scrollTop = 0;
    scrollBottom;
    carry = '';
    title = '';
    titleUpdatedAt = 0;
    paintOrdinal = 0;
    semanticTail = '';
    grokRespondingOrdinal = 0;
    grokCompletedOrdinal = 0;
    _generation = 0;
    _lastUpdatedAt = Date.now();
    style = this.defaultStyle();
    constructor(height = DEFAULT_ROWS, width = DEFAULT_COLS, platform = process.platform) {
        this.height = height;
        this.width = width;
        this.platform = platform;
        this.height = Math.max(2, Math.floor(height));
        this.width = Math.max(2, Math.floor(width));
        this.rows = this.emptyRows(this.height);
        this.scrollBottom = this.height - 1;
    }
    get generation() { return this._generation; }
    get lastUpdatedAt() { return this._lastUpdatedAt; }
    /** A PTY resize invalidates cursor-painted coordinates. Fail closed until
     * the application repaints at the new dimensions. */
    resize(height, width) {
        const nextHeight = Math.max(2, Math.floor(height));
        const nextWidth = Math.max(2, Math.floor(width));
        if (nextHeight === this.height && nextWidth === this.width)
            return;
        this.height = nextHeight;
        this.width = nextWidth;
        this.rows = this.emptyRows(nextHeight);
        this.row = 0;
        this.col = 0;
        this.savedRow = 0;
        this.savedCol = 0;
        this.scrollTop = 0;
        this.scrollBottom = nextHeight - 1;
        this.carry = '';
        this.title = '';
        this.titleUpdatedAt = 0;
        this.paintOrdinal = 0;
        this.semanticTail = '';
        this.grokRespondingOrdinal = 0;
        this.grokCompletedOrdinal = 0;
        this.style = this.defaultStyle();
        this.touch();
    }
    reset() {
        this.rows = this.emptyRows(this.height);
        this.row = 0;
        this.col = 0;
        this.savedRow = 0;
        this.savedCol = 0;
        this.scrollTop = 0;
        this.scrollBottom = this.height - 1;
        this.carry = '';
        this.title = '';
        this.titleUpdatedAt = 0;
        this.paintOrdinal = 0;
        this.semanticTail = '';
        this.grokRespondingOrdinal = 0;
        this.grokCompletedOrdinal = 0;
        this.style = this.defaultStyle();
        this.touch();
    }
    feed(chunk) {
        if (!chunk)
            return;
        this.touch();
        const input = this.carry + chunk;
        this.carry = '';
        let i = 0;
        while (i < input.length) {
            const ch = input[i];
            if (ch !== '\x1b') {
                this.put(ch);
                i += 1;
                continue;
            }
            if (i + 1 >= input.length) {
                this.carry = input.slice(i);
                break;
            }
            const next = input[i + 1];
            if (next === '[') {
                let end = i + 2;
                while (end < input.length && !/[\x40-\x7e]/.test(input[end]))
                    end += 1;
                if (end >= input.length) {
                    this.carry = input.slice(i);
                    break;
                }
                this.applyCsi(input.slice(i + 2, end), input[end]);
                i = end + 1;
                continue;
            }
            if (next === ']') {
                let end = i + 2;
                let payloadEnd = -1;
                let complete = false;
                while (end < input.length) {
                    if (input[end] === '\x07') {
                        payloadEnd = end;
                        end += 1;
                        complete = true;
                        break;
                    }
                    if (input[end] === '\x1b' && input[end + 1] === '\\') {
                        payloadEnd = end;
                        end += 2;
                        complete = true;
                        break;
                    }
                    end += 1;
                }
                if (!complete) {
                    this.carry = input.slice(i);
                    break;
                }
                this.applyOsc(input.slice(i + 2, payloadEnd));
                i = end;
                continue;
            }
            if (next === '7') {
                this.savedRow = this.row;
                this.savedCol = this.col;
            }
            else if (next === '8') {
                this.row = this.savedRow;
                this.col = this.savedCol;
            }
            else if (next === 'D')
                this.index();
            else if (next === 'E') {
                this.col = 0;
                this.index();
            }
            else if (next === 'M')
                this.reverseIndex();
            else if (next === 'c')
                this.reset();
            // Character-set designators are ESC + introducer + one byte. Consuming
            // only two bytes would paint the designator itself into the screen.
            if ('()*+-.\/#%'.includes(next)) {
                if (i + 2 >= input.length) {
                    this.carry = input.slice(i);
                    break;
                }
                i += 3;
            }
            else {
                i += 2;
            }
        }
        if (this.carry.length > 1024)
            this.carry = '';
    }
    render() {
        return this.rows
            .map((line) => this.renderLine(line))
            .join('\n')
            .replace(/^\n+|\n+$/g, '');
    }
    /**
     * The live VT cursor, converted to the one-based coordinates used by SGR
     * mouse input. Callers may use this only after a positive readiness proof:
     * on Cursor and other cursorless TUIs the VT cursor is not the composer.
     */
    cursorPosition() {
        return { column: this.col + 1, row: this.row + 1 };
    }
    readiness(kind) {
        const screen = this.render();
        const line = this.rows[this.row];
        const contentEnd = this.lastDefinedCell(line) + 1;
        const cursorAfter = line
            .slice(this.col, contentEnd)
            .filter((cell) => Boolean(cell));
        const readiness = (0, agentReadiness_1.evaluateAgentComposerReadiness)(kind, {
            screen,
            cursorBefore: this.renderCells(line, 0, this.col),
            cursorAfter,
            screenRows: this.rows.map((row) => ({
                text: this.renderLine(row),
                cells: row,
            })),
        });
        // Grok keeps its empty composer mounted while a turn is running on
        // Windows. The live status spinner is current-screen process state; if it
        // is present, accepting the empty composer would inject into a busy TUI.
        // Keep this ConPTY-specific because macOS/Linux use a different TTY path.
        if (this.platform === 'win32' && kind === 'grok' && this.grokTurnRunning(screen)) {
            return {
                ...readiness,
                ready: false,
                generation: this._generation,
                screen,
            };
        }
        return {
            ...readiness,
            generation: this._generation,
            screen,
        };
    }
    grokTurnRunning(screen = this.render()) {
        // Grok's target-owned completion paint retires the preceding Responding
        // lifecycle even when Ink performs a late spinner cleanup write. A new
        // turn emits a newer Responding OSC title and becomes busy again.
        if (this.grokCompletedOrdinal > this.grokRespondingOrdinal)
            return false;
        const recentTitle = Date.now() - this.titleUpdatedAt <= exports.GROK_RESPONDING_TITLE_GRACE_MS
            ? this.title
            : '';
        if (/\bResponding\b/i.test(recentTitle))
            return true;
        // Grok/Ink cursor-paints a spinner while leaving both its empty composer
        // and older status rows mounted. Looking for any spinner anywhere in the
        // reconstructed viewport therefore mistakes history (including
        // `Starting session…`) for current process state. A live turn repaints the
        // spinner after the composer; an idle/remounted composer is painted after
        // the stale spinner. Compare paint ownership instead of transcript text.
        let newestSpinnerPaint = 0;
        for (const row of this.rows) {
            for (const cell of row) {
                if (cell && GROK_SPINNER_CHARS.has(cell.chars)) {
                    newestSpinnerPaint = Math.max(newestSpinnerPaint, cell.paintOrdinal);
                }
            }
        }
        if (newestSpinnerPaint === 0)
            return false;
        const composerPaint = this.rows[this.row].reduce((latest, cell) => Math.max(latest, cell?.paintOrdinal ?? 0), 0);
        let completedTurnPaint = 0;
        for (const row of this.rows) {
            // Match Grok's adjacent stop control as well as the duration. The
            // phrase by itself can occur in user/model transcript text and is not
            // authoritative process state.
            if (!/\bWorked for\s+\d+(?:\.\d+)?s\s*stop\b/i.test(this.renderLine(row)))
                continue;
            completedTurnPaint = Math.max(completedTurnPaint, row.reduce((latest, cell) => Math.max(latest, cell?.paintOrdinal ?? 0), 0));
        }
        return newestSpinnerPaint > Math.max(composerPaint, completedTurnPaint);
    }
    /** High-confidence, UI-only approval/choice detection. */
    needsInput(kind) {
        if (!kind)
            return false;
        const screen = this.render();
        return NEEDS_INPUT_TITLE_RE.test(screen) && NEEDS_INPUT_ACTION_RE.test(screen);
    }
    put(ch) {
        if (ch === '\r') {
            this.col = 0;
            return;
        }
        if (ch === '\n') {
            this.col = 0;
            this.index();
            return;
        }
        if (ch === '\b') {
            this.col = Math.max(0, this.col - 1);
            return;
        }
        if (ch === '\t') {
            this.col = Math.min(this.width - 1, (Math.floor(this.col / 8) + 1) * 8);
            return;
        }
        if (ch < ' ' || ch === '\x7f')
            return;
        if (this.col >= this.width) {
            this.col = 0;
            this.index();
        }
        // Cells share the current style object — applySgr copies-on-write, so a
        // per-cell clone here would only double allocations on the multi-MB
        // snapshot feeds (adopted-terminal attach, readiness probes).
        this.rows[this.row][this.col] = new ScreenCell(ch, this.style, ++this.paintOrdinal);
        this.col += 1;
        this.semanticTail = `${this.semanticTail}${ch}`.slice(-96);
        // Require Grok's adjacent stop control, not the phrase alone: model/user
        // transcript text may legitimately say "Worked for 3s" and must never
        // manufacture process state.
        if (/Worked for\s+\d+(?:\.\d+)?s\s*stop$/i.test(this.semanticTail)) {
            this.grokCompletedOrdinal = this.paintOrdinal;
        }
    }
    index() {
        if (this.row === this.scrollBottom) {
            this.scrollUp(this.scrollTop, this.scrollBottom, 1);
            return;
        }
        this.row = Math.min(this.height - 1, this.row + 1);
    }
    reverseIndex() {
        if (this.row === this.scrollTop) {
            this.scrollDown(this.scrollTop, this.scrollBottom, 1);
            return;
        }
        this.row = Math.max(0, this.row - 1);
    }
    applyCsi(rawParams, final) {
        const normalized = rawParams.replace(/^[?>!]/, '').replace(/:/g, ';');
        const params = normalized.split(';').map((value) => Number(value || 0));
        const n = params[0] || 1;
        switch (final) {
            case 'A':
                this.row = Math.max(0, this.row - n);
                break;
            case 'B':
            case 'e':
                this.row = Math.min(this.height - 1, this.row + n);
                break;
            case 'C':
            case 'a':
                this.col = Math.min(this.width - 1, this.col + n);
                break;
            case 'D':
                this.col = Math.max(0, this.col - n);
                break;
            case 'E':
                this.row = Math.min(this.height - 1, this.row + n);
                this.col = 0;
                break;
            case 'F':
                this.row = Math.max(0, this.row - n);
                this.col = 0;
                break;
            case 'G':
            case '`':
                this.col = this.clampCol(n - 1);
                break;
            case 'd':
                this.row = this.clampRow(n - 1);
                break;
            case 'H':
            case 'f':
                this.row = this.clampRow((params[0] || 1) - 1);
                this.col = this.clampCol((params[1] || 1) - 1);
                break;
            case 'J':
                this.eraseDisplay(params[0] || 0);
                break;
            case 'K':
                this.eraseLine(params[0] || 0);
                break;
            case '@':
                this.insertChars(n);
                break;
            case 'P':
                this.deleteChars(n);
                break;
            case 'X':
                this.eraseChars(n);
                break;
            case 'L':
                this.insertLines(n);
                break;
            case 'M':
                this.deleteLines(n);
                break;
            case 'S':
                this.scrollUp(this.scrollTop, this.scrollBottom, n);
                break;
            case 'T':
                this.scrollDown(this.scrollTop, this.scrollBottom, n);
                break;
            case 'r': {
                const top = this.clampRow((params[0] || 1) - 1);
                const bottom = this.clampRow((params[1] || this.height) - 1);
                if (top < bottom) {
                    this.scrollTop = top;
                    this.scrollBottom = bottom;
                    this.row = 0;
                    this.col = 0;
                }
                break;
            }
            case 'm':
                this.applySgr(params);
                break;
            case 's':
                this.savedRow = this.row;
                this.savedCol = this.col;
                break;
            case 'u':
                this.row = this.savedRow;
                this.col = this.savedCol;
                break;
            default: break;
        }
    }
    applyOsc(payload) {
        const separator = payload.indexOf(';');
        if (separator < 0)
            return;
        const command = payload.slice(0, separator);
        if (command !== '0' && command !== '2')
            return;
        this.title = payload.slice(separator + 1);
        this.titleUpdatedAt = Date.now();
        if (/\bResponding\b/i.test(this.title)) {
            this.grokRespondingOrdinal = ++this.paintOrdinal;
        }
    }
    applySgr(params) {
        const values = params.length > 0 ? params : [0];
        // Copy-on-write: stored cells share the style object (see put()), so SGR
        // must replace it, never mutate it in place — one allocation per SGR
        // sequence instead of one clone per printed cell.
        let style = this.style;
        let owned = false;
        const mutable = () => {
            if (!owned) {
                style = { ...style };
                owned = true;
            }
            return style;
        };
        for (let i = 0; i < values.length; i++) {
            const value = values[i];
            if (value === 0) {
                style = this.defaultStyle();
                owned = true;
            }
            else if (value === 2)
                mutable().dim = true;
            else if (value === 22)
                mutable().dim = false;
            else if (value >= 30 && value <= 37) {
                const s = mutable();
                s.foregroundMode = 'palette';
                s.foreground = value - 30;
            }
            else if (value >= 90 && value <= 97) {
                const s = mutable();
                s.foregroundMode = 'palette';
                s.foreground = value - 90 + 8;
            }
            else if (value === 39) {
                const s = mutable();
                s.foregroundMode = 'default';
                s.foreground = -1;
            }
            else if (value === 38 && values[i + 1] === 5 && Number.isFinite(values[i + 2])) {
                const s = mutable();
                s.foregroundMode = 'palette';
                s.foreground = values[i + 2];
                i += 2;
            }
            else if (value === 38 && values[i + 1] === 2 && values.slice(i + 2, i + 5).every(Number.isFinite)) {
                const [r, g, b] = values.slice(i + 2, i + 5).map((channel) => Math.max(0, Math.min(255, channel)));
                const s = mutable();
                s.foregroundMode = 'rgb';
                s.foreground = (r << 16) | (g << 8) | b;
                i += 4;
            }
        }
        this.style = style;
    }
    eraseDisplay(mode) {
        if (mode === 2 || mode === 3) {
            this.rows = this.emptyRows(this.height);
            return;
        }
        if (mode === 0) {
            this.rows[this.row].splice(this.col);
            for (let r = this.row + 1; r < this.height; r++)
                this.rows[r] = [];
            return;
        }
        if (mode === 1) {
            for (let r = 0; r < this.row; r++)
                this.rows[r] = [];
            for (let c = 0; c <= this.col; c++)
                this.rows[this.row][c] = undefined;
        }
    }
    eraseLine(mode) {
        if (mode === 0)
            this.rows[this.row].splice(this.col);
        else if (mode === 1) {
            for (let c = 0; c <= this.col; c++)
                this.rows[this.row][c] = undefined;
        }
        else if (mode === 2)
            this.rows[this.row] = [];
    }
    insertChars(count) {
        this.rows[this.row].splice(this.col, 0, ...Array.from({ length: count }, () => undefined));
        this.rows[this.row].length = Math.min(this.rows[this.row].length, this.width);
    }
    deleteChars(count) {
        this.rows[this.row].splice(this.col, count);
    }
    eraseChars(count) {
        for (let c = this.col; c < Math.min(this.width, this.col + count); c++)
            this.rows[this.row][c] = undefined;
    }
    insertLines(count) {
        if (this.row < this.scrollTop || this.row > this.scrollBottom)
            return;
        for (let i = 0; i < count; i++) {
            this.rows.splice(this.row, 0, []);
            this.rows.splice(this.scrollBottom + 1, 1);
        }
    }
    deleteLines(count) {
        if (this.row < this.scrollTop || this.row > this.scrollBottom)
            return;
        for (let i = 0; i < count; i++) {
            this.rows.splice(this.row, 1);
            this.rows.splice(this.scrollBottom, 0, []);
        }
    }
    scrollUp(top, bottom, count) {
        const amount = Math.min(Math.max(1, count), bottom - top + 1);
        for (let i = 0; i < amount; i++) {
            this.rows.splice(top, 1);
            this.rows.splice(bottom, 0, []);
        }
    }
    scrollDown(top, bottom, count) {
        const amount = Math.min(Math.max(1, count), bottom - top + 1);
        for (let i = 0; i < amount; i++) {
            this.rows.splice(bottom, 1);
            this.rows.splice(top, 0, []);
        }
    }
    renderLine(line) {
        return this.renderCells(line, 0, this.lastDefinedCell(line) + 1).replace(/\s+$/u, '');
    }
    renderCells(line, start, end) {
        let result = '';
        for (let index = start; index < end; index++)
            result += line[index]?.chars ?? ' ';
        return result;
    }
    lastDefinedCell(line) {
        for (let index = Math.min(line.length, this.width) - 1; index >= 0; index--) {
            if (line[index])
                return index;
        }
        return -1;
    }
    emptyRows(count) {
        return Array.from({ length: count }, () => []);
    }
    defaultStyle() {
        return { dim: false, foregroundMode: 'default', foreground: -1 };
    }
    clampRow(value) { return Math.max(0, Math.min(this.height - 1, value)); }
    clampCol(value) { return Math.max(0, Math.min(this.width - 1, value)); }
    touch() {
        this._generation += 1;
        this._lastUpdatedAt = Date.now();
    }
}
exports.TerminalScreenModel = TerminalScreenModel;
function hasKnownReadyMarker(kind) {
    return (0, agentReadiness_1.hasKnownReadyMarker)(kind);
}
