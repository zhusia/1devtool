"use strict";
// Shared cell-level detection for TUI placeholder / argument-hint text.
//
// Agent TUIs paint text the user did not type after the cursor using SGR dim
// or muted gray foregrounds. Keep this module process-neutral so both xterm
// reads in the renderer and the main-owned Agent Team screen model apply the
// exact same rule (terminal INDEX A6).
Object.defineProperty(exports, "__esModule", { value: true });
exports.isMutedGhostCell = isMutedGhostCell;
exports.stripTrailingGhostText = stripTrailingGhostText;
const BRIGHT_BLACK = 8;
const GRAYSCALE_RAMP_START = 232;
// Pure grays inside the 6x6x6 color cube (r==g==b), extremes excluded.
const COLOR_CUBE_GRAYS = new Set([59, 102, 145, 188]);
/** Whether a cell carries the styling agent TUIs use for ghost text. */
function isMutedGhostCell(cell) {
    if (cell.isDim())
        return true;
    if (cell.isFgPalette()) {
        const color = cell.getFgColor();
        return (color === BRIGHT_BLACK ||
            color >= GRAYSCALE_RAMP_START ||
            COLOR_CUBE_GRAYS.has(color));
    }
    if (cell.isFgRGB()) {
        const rgb = cell.getFgColor();
        const r = (rgb >> 16) & 0xff;
        const g = (rgb >> 8) & 0xff;
        const b = rgb & 0xff;
        const hi = Math.max(r, g, b);
        const lo = Math.min(r, g, b);
        return hi - lo <= 16 && hi >= 0x40 && hi <= 0xc8;
    }
    return false;
}
/**
 * Strip the longest whitespace-or-muted suffix at/after the cursor. The cell
 * walk must reproduce `raw` exactly or the function fails open.
 */
function stripTrailingGhostText(raw, cursorOffset, lines) {
    if (!raw)
        return raw;
    let maskText = '';
    const muted = [];
    for (const line of lines) {
        let rowText = '';
        const rowMuted = [];
        let contentEnd = 0;
        for (let x = 0; x < line.length; x++) {
            const cell = line.getCell(x);
            if (!cell)
                break;
            if (cell.getWidth() === 0)
                continue;
            const chars = cell.getChars();
            const rendered = chars || ' ';
            const cellMuted = isMutedGhostCell(cell);
            for (let i = 0; i < rendered.length; i++)
                rowMuted.push(cellMuted);
            rowText += rendered;
            if (chars)
                contentEnd = rowText.length;
        }
        maskText += rowText.slice(0, contentEnd);
        for (let i = 0; i < contentEnd; i++)
            muted.push(rowMuted[i]);
    }
    if (maskText !== raw)
        return raw;
    const floor = Math.max(0, Math.min(cursorOffset, raw.length));
    let i = raw.length - 1;
    while (i >= floor && (muted[i] || /\s/.test(raw[i])))
        i--;
    const suffixStart = i + 1;
    for (let j = suffixStart; j < raw.length; j++) {
        if (muted[j] && !/\s/.test(raw[j]))
            return raw.slice(0, j);
    }
    return raw;
}
