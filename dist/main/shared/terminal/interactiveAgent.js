"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CSI_CLEAR_SCROLLBACK = exports.CSI_ERASE_DISPLAY = void 0;
exports.splitTrailingIncompleteEscapeSequence = splitTrailingIncompleteEscapeSequence;
exports.tokenizeInteractiveAgentOutput = tokenizeInteractiveAgentOutput;
/*
 * Interactive-agent (AI TUI) write tokenizer — docs/common-errors/terminals/INDEX.md rule C1:
 * the 'soft-clear' token must resolve to a HARD clear (\x1b[H\x1b[J). The old line-feed
 * "scroll into scrollback" soft clear stamped Claude's empty prompt frame into history on
 * every redraw (soft-clear-prompt-pollution.md). Incomplete trailing escape sequences must
 * carry to the next write — a split CSI/OSC reaching xterm garbles the parse.
 */
exports.CSI_ERASE_DISPLAY = '\x1b[2J';
exports.CSI_CLEAR_SCROLLBACK = '\x1b[3J';
/**
 * Split a trailing, incomplete ANSI escape sequence off the batch so it can be
 * prepended to the next write. This prevents partial CSI/OSC sequences from
 * reaching xterm across animation frames.
 */
function findCsiTerminator(data, startIndex) {
    for (let index = startIndex; index < data.length; index += 1) {
        const code = data.charCodeAt(index);
        if (code >= 0x40 && code <= 0x7e) {
            return index + 1;
        }
    }
    return -1;
}
function findStringTerminator(data, startIndex) {
    for (let index = startIndex; index < data.length; index += 1) {
        const code = data.charCodeAt(index);
        if (code === 0x07) {
            return index + 1;
        }
        if (code === 0x1b && index + 1 < data.length && data.charCodeAt(index + 1) === 0x5c) {
            return index + 2;
        }
    }
    return -1;
}
function splitTrailingIncompleteEscapeSequence(data) {
    for (let index = 0; index < data.length; index += 1) {
        const code = data.charCodeAt(index);
        if (code === 0x9b) {
            const terminatorIndex = findCsiTerminator(data, index + 1);
            if (terminatorIndex === -1) {
                return { complete: data.slice(0, index), pending: data.slice(index) };
            }
            index = terminatorIndex - 1;
            continue;
        }
        if (code !== 0x1b) {
            continue;
        }
        if (index === data.length - 1) {
            return { complete: data.slice(0, index), pending: data.slice(index) };
        }
        const marker = data[index + 1];
        if (marker === '[') {
            const terminatorIndex = findCsiTerminator(data, index + 2);
            if (terminatorIndex === -1) {
                return { complete: data.slice(0, index), pending: data.slice(index) };
            }
            index = terminatorIndex - 1;
            continue;
        }
        if (marker === ']' || marker === 'P' || marker === '^' || marker === '_') {
            const terminatorIndex = findStringTerminator(data, index + 2);
            if (terminatorIndex === -1) {
                return { complete: data.slice(0, index), pending: data.slice(index) };
            }
            index = terminatorIndex - 1;
            continue;
        }
        index += 1;
    }
    return { complete: data, pending: '' };
}
/**
 * Tokenize clear-screen control sequences so the renderer can replace CSI 2 J
 * with a custom soft-clear implementation and drop CSI 3 J entirely.
 */
function tokenizeInteractiveAgentOutput(data) {
    const tokens = [];
    let cursor = 0;
    while (cursor < data.length) {
        const eraseDisplayIndex = data.indexOf(exports.CSI_ERASE_DISPLAY, cursor);
        const clearScrollbackIndex = data.indexOf(exports.CSI_CLEAR_SCROLLBACK, cursor);
        const nextIndex = [eraseDisplayIndex, clearScrollbackIndex]
            .filter((index) => index >= 0)
            .reduce((smallest, index) => Math.min(smallest, index), Number.POSITIVE_INFINITY);
        if (!Number.isFinite(nextIndex)) {
            if (cursor < data.length) {
                tokens.push({ type: 'text', value: data.slice(cursor) });
            }
            break;
        }
        if (nextIndex > cursor) {
            tokens.push({ type: 'text', value: data.slice(cursor, nextIndex) });
        }
        if (nextIndex === eraseDisplayIndex) {
            tokens.push({ type: 'soft-clear' });
            cursor = nextIndex + exports.CSI_ERASE_DISPLAY.length;
            continue;
        }
        tokens.push({ type: 'drop-scrollback-clear' });
        cursor = nextIndex + exports.CSI_CLEAR_SCROLLBACK.length;
    }
    return tokens;
}
