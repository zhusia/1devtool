"use strict";
// Windows-only PTY write pacing (docs/common-errors/terminals/windows-paste-truncation.md).
//
// ConPTY re-chunks and can silently drop large single writes to its input
// pipe: conhost converts the byte burst into console input events and a slow
// reader (an Ink/React agent TUI draining stdin on event-loop ticks) lets the
// buffer overflow, truncating pasted prompts at ~1KB (~10 terminal lines).
// VS Code shipped the same workaround for years (50 chars every 5ms) before
// node-pty 1.2 fixed the *Unix* fd path — the Windows pipe path has no
// equivalent protection in node-pty, so the pacing must live in the caller.
//
// Pure helpers only — consumed by src/main/pty.ts, unit-tested directly.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PTY_WRITE_CHUNK_INTERVAL_MS = exports.PTY_WRITE_CHUNK_SIZE = void 0;
exports.splitPtyWriteForConpty = splitPtyWriteForConpty;
exports.PTY_WRITE_CHUNK_SIZE = 50;
exports.PTY_WRITE_CHUNK_INTERVAL_MS = 5;
/** Longest escape sequence we will keep intact. Covers CSI/SGR forms actually
 *  written toward a PTY (`ESC[C`, `ESC[<65;120;40M`, `ESC[200~`). Beyond this
 *  an ESC is treated as ordinary data so an unterminated one cannot swallow a
 *  whole paste into a single chunk. */
const MAX_ESCAPE_SEQUENCE_LEN = 24;
const ESC = '\u001b';
const BEL = '\u0007';
/** End index (exclusive) of the escape sequence starting at `start`, or -1 if
 *  it does not terminate within `MAX_ESCAPE_SEQUENCE_LEN`. */
function escapeSequenceEnd(data, start) {
    if (data[start] !== ESC)
        return -1;
    const limit = Math.min(data.length, start + MAX_ESCAPE_SEQUENCE_LEN);
    const second = data[start + 1];
    if (second === undefined)
        return -1;
    if (second === '[') {
        // CSI: parameters/intermediates, then a final byte in 0x40-0x7E.
        for (let i = start + 2; i < limit; i++) {
            const code = data.charCodeAt(i);
            if (code >= 0x40 && code <= 0x7e)
                return i + 1;
        }
        return -1;
    }
    if (second === ']' || second === 'P' || second === 'X' || second === '^' || second === '_') {
        // OSC/DCS/SOS/PM/APC terminate at BEL or ST — usually app→host, not here.
        for (let i = start + 2; i < limit; i++) {
            if (data[i] === BEL)
                return i + 1;
            if (data[i] === ESC && data[i + 1] === '\\')
                return i + 2;
        }
        return -1;
    }
    // Two-character escape (ESC c, ESC =, …).
    return start + 2;
}
/** Split a PTY write into ConPTY-safe chunks. Never splits a UTF-16
 *  surrogate pair — node-pty encodes each chunk to UTF-8 separately, so a
 *  split pair would reach the terminal as two invalid characters.
 *
 *  Never splits an escape sequence either. Chunks are delivered 5 ms apart, so
 *  a chunk ending in a bare `ESC[` leaves the agent's parser holding an
 *  incomplete sequence; it times out and renders the tail (`C`, `<65;64;12M`)
 *  as literal composer text. Measured on real Windows with both the paced
 *  jump-to-bottom burst and `cursorRight(n >= 17)` from the Agent Input
 *  incremental write path.
 *  See docs/common-errors/terminals/windows-native-tui-normal-buffer.md */
function splitPtyWriteForConpty(data, maxChunkSize = exports.PTY_WRITE_CHUNK_SIZE) {
    if (data.length === 0)
        return [];
    if (data.length <= maxChunkSize)
        return [data];
    const chunks = [];
    let index = 0;
    while (index < data.length) {
        let end = Math.min(index + maxChunkSize, data.length);
        if (end < data.length) {
            // Walk this chunk's escape sequences; if the boundary lands inside one,
            // cut before it instead (or, when that would empty the chunk, after it).
            let scan = index;
            while (scan < end) {
                if (data[scan] !== ESC) {
                    scan++;
                    continue;
                }
                const seqEnd = escapeSequenceEnd(data, scan);
                if (seqEnd < 0) {
                    // Unterminated within the cap — treat the ESC as ordinary data.
                    scan++;
                    continue;
                }
                if (seqEnd > end) {
                    end = scan > index ? scan : seqEnd;
                    break;
                }
                scan = seqEnd;
            }
        }
        if (end < data.length) {
            const code = data.charCodeAt(end - 1);
            // High surrogate at the boundary — pull its low half into this chunk.
            if (code >= 0xd800 && code <= 0xdbff)
                end += 1;
        }
        chunks.push(data.slice(index, end));
        index = end;
    }
    return chunks;
}
