"use strict";
/**
 * Virtual Terminal Screen Renderer
 *
 * Interprets raw PTY output (including cursor positioning escape sequences)
 * and builds a 2D character grid, then serializes to plain text.
 *
 * This solves the "garbled single-character lines" problem that occurs when
 * stripAnsi removes cursor positioning without reconstructing the screen layout.
 * TUI apps (Claude Code, etc.) draw characters at specific row/col positions,
 * and we need to interpret those positions to get readable text.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderVirtualScreen = renderVirtualScreen;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 500; // max scrollback lines
const TAB_STOP = 8;
/**
 * Render raw PTY output through a virtual terminal and return plain text.
 * Handles cursor positioning, line erasing, and basic screen management.
 */
function renderVirtualScreen(raw, cols = DEFAULT_COLS) {
    const screen = [];
    let curRow = 0;
    let curCol = 0;
    let maxRow = 0;
    function ensureRow(row) {
        while (screen.length <= row) {
            screen.push(new Array(cols).fill(' '));
        }
        if (row > maxRow)
            maxRow = row;
    }
    function putChar(ch) {
        ensureRow(curRow);
        if (curCol < cols) {
            screen[curRow][curCol] = ch;
            curCol++;
        }
    }
    let i = 0;
    while (i < raw.length) {
        const ch = raw[i];
        // ESC sequence
        if (ch === '\x1b') {
            if (i + 1 < raw.length && raw[i + 1] === '[') {
                // CSI sequence: ESC [ params final
                i += 2;
                let params = '';
                while (i < raw.length && raw.charCodeAt(i) >= 0x20 && raw.charCodeAt(i) <= 0x3f) {
                    params += raw[i];
                    i++;
                }
                const final = i < raw.length ? raw[i] : '';
                i++;
                const nums = params.split(';').map(s => parseInt(s, 10) || 0);
                switch (final) {
                    case 'H': // Cursor position
                    case 'f': {
                        const row = (nums[0] || 1) - 1;
                        const col = (nums[1] || 1) - 1;
                        curRow = Math.max(0, row);
                        curCol = Math.max(0, Math.min(col, cols - 1));
                        break;
                    }
                    case 'A': // Cursor up
                        curRow = Math.max(0, curRow - (nums[0] || 1));
                        break;
                    case 'B': // Cursor down
                        curRow += (nums[0] || 1);
                        break;
                    case 'C': // Cursor forward
                        curCol = Math.min(cols - 1, curCol + (nums[0] || 1));
                        break;
                    case 'D': // Cursor back
                        curCol = Math.max(0, curCol - (nums[0] || 1));
                        break;
                    case 'G': // Cursor horizontal absolute
                        curCol = Math.max(0, Math.min((nums[0] || 1) - 1, cols - 1));
                        break;
                    case 'J': { // Erase display
                        const mode = nums[0] || 0;
                        ensureRow(curRow);
                        if (mode === 0) {
                            // Erase from cursor to end
                            for (let c = curCol; c < cols; c++)
                                screen[curRow][c] = ' ';
                            for (let r = curRow + 1; r <= maxRow; r++) {
                                ensureRow(r);
                                screen[r].fill(' ');
                            }
                        }
                        else if (mode === 1) {
                            // Erase from start to cursor
                            for (let r = 0; r < curRow; r++) {
                                ensureRow(r);
                                screen[r].fill(' ');
                            }
                            ensureRow(curRow);
                            for (let c = 0; c <= curCol; c++)
                                screen[curRow][c] = ' ';
                        }
                        else if (mode === 2 || mode === 3) {
                            // Erase entire screen
                            for (let r = 0; r <= maxRow; r++) {
                                ensureRow(r);
                                screen[r].fill(' ');
                            }
                        }
                        break;
                    }
                    case 'K': { // Erase line
                        const mode = nums[0] || 0;
                        ensureRow(curRow);
                        if (mode === 0) {
                            for (let c = curCol; c < cols; c++)
                                screen[curRow][c] = ' ';
                        }
                        else if (mode === 1) {
                            for (let c = 0; c <= curCol; c++)
                                screen[curRow][c] = ' ';
                        }
                        else if (mode === 2) {
                            screen[curRow].fill(' ');
                        }
                        break;
                    }
                    case 'S': // Scroll up
                    case 'T': // Scroll down
                    case 'L': // Insert lines
                    case 'M': // Delete lines
                    case 'm': // SGR (styling) — ignore
                    case 'h': // Set mode — ignore
                    case 'l': // Reset mode — ignore
                    case 'r': // Set scrolling region — ignore
                    case 'n': // Device status report — ignore
                    case 's': // Save cursor — ignore
                    case 'u': // Restore cursor — ignore
                    case 'c': // Device attributes — ignore
                    case 't': // Window manipulation — ignore
                    case 'X': // Erase character — ignore
                    case 'P': // Delete character — ignore
                    case '@': // Insert character — ignore
                    case 'd': // Line position absolute
                    case 'e': // Line position relative
                    case '`': // Character position absolute
                        break;
                    default:
                        break;
                }
            }
            else if (i + 1 < raw.length && raw[i + 1] === ']') {
                // OSC sequence: ESC ] ... BEL or ESC \
                i += 2;
                while (i < raw.length && raw[i] !== '\x07' && !(raw[i] === '\x1b' && raw[i + 1] === '\\')) {
                    i++;
                }
                if (i < raw.length && raw[i] === '\x07')
                    i++;
                else if (i + 1 < raw.length && raw[i] === '\x1b' && raw[i + 1] === '\\')
                    i += 2;
            }
            else {
                // Two-byte escape — skip
                i += 2;
            }
            continue;
        }
        // Control characters
        if (ch === '\n') {
            curRow++;
            curCol = 0;
            i++;
            continue;
        }
        if (ch === '\r') {
            curCol = 0;
            i++;
            continue;
        }
        if (ch === '\t') {
            curCol = Math.min(cols - 1, curCol + (TAB_STOP - (curCol % TAB_STOP)));
            i++;
            continue;
        }
        if (ch === '\x08') { // Backspace
            curCol = Math.max(0, curCol - 1);
            i++;
            continue;
        }
        if (ch === '\x07') { // Bell — ignore
            i++;
            continue;
        }
        // Skip other control chars
        const code = ch.charCodeAt(0);
        if (code < 0x20 && code !== 0x09) {
            i++;
            continue;
        }
        // Printable character
        putChar(ch);
        i++;
    }
    // Serialize screen to text
    const lines = [];
    for (let r = 0; r <= maxRow; r++) {
        if (r < screen.length) {
            lines.push(screen[r].join('').trimEnd());
        }
    }
    // Remove trailing empty lines
    while (lines.length > 0 && !lines[lines.length - 1]) {
        lines.pop();
    }
    return lines.join('\n');
}
