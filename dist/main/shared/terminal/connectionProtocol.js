"use strict";
/**
 * Terminal Connection v2 shared data-plane contract.
 * Terminal hotspot: read docs/common-errors/terminals/INDEX.md before editing.
 *
 * Keep this module electron-, node-, DOM-, and xterm-free. Transports may use
 * different envelopes, but owner identity and sequence semantics must stay
 * identical. See docs/Terminal_Connection_v2.md.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalV2AnsiSplitter = exports.TerminalConnectionError = exports.RAW_V2_CAPABILITIES = exports.TERMINAL_CONNECTION_REMOTE_ATTACH_DEADLINE_MS = exports.TERMINAL_CONNECTION_DESKTOP_ATTACH_DEADLINE_MS = exports.TERMINAL_CONNECTION_MAX_QUERY_QUIET_RETRIES = exports.TERMINAL_CONNECTION_QUERY_QUIET_WINDOW_MS = exports.TERMINAL_CONNECTION_REMOTE_BACKGROUND_GRACE_MS = exports.TERMINAL_CONNECTION_MAX_PENDING_FRAMES = exports.TERMINAL_CONNECTION_REMOTE_WINDOW_BYTES = exports.TERMINAL_CONNECTION_MAX_FRAGMENT_BYTES = exports.TERMINAL_CONNECTION_PROTOCOL_VERSION = void 0;
exports.terminalCheckpointCacheKey = terminalCheckpointCacheKey;
exports.isBenignTerminalResyncFailure = isBenignTerminalResyncFailure;
exports.sameTerminalOwner = sameTerminalOwner;
exports.negotiateTerminalCapabilities = negotiateTerminalCapabilities;
exports.terminalAttachFingerprint = terminalAttachFingerprint;
exports.TERMINAL_CONNECTION_PROTOCOL_VERSION = 2;
exports.TERMINAL_CONNECTION_MAX_FRAGMENT_BYTES = 64 * 1024;
exports.TERMINAL_CONNECTION_REMOTE_WINDOW_BYTES = 256 * 1024;
exports.TERMINAL_CONNECTION_MAX_PENDING_FRAMES = 2_048;
exports.TERMINAL_CONNECTION_REMOTE_BACKGROUND_GRACE_MS = 2_500;
exports.TERMINAL_CONNECTION_QUERY_QUIET_WINDOW_MS = 200;
exports.TERMINAL_CONNECTION_MAX_QUERY_QUIET_RETRIES = 3;
exports.TERMINAL_CONNECTION_DESKTOP_ATTACH_DEADLINE_MS = 2_000;
exports.TERMINAL_CONNECTION_REMOTE_ATTACH_DEADLINE_MS = 5_000;
/** Raw-only is deliberate until a producer/consumer checkpoint tuple passes
 * the Phase 0 corpus. Never advertise a screen codec from package presence. */
exports.RAW_V2_CAPABILITIES = [
    'raw-output-v1',
    'frame-ack-v1',
    'resync-v1',
];
function terminalCheckpointCacheKey(key) {
    return JSON.stringify([
        key.engineEpoch,
        key.terminalGeneration,
        key.displayProfileRevision,
        key.screenVersion,
        key.cols,
        key.rows,
        key.codecVersion,
        key.historySpan,
    ]);
}
class TerminalConnectionError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'TerminalConnectionError';
    }
}
exports.TerminalConnectionError = TerminalConnectionError;
/**
 * A resync failure that only lost a race — the connection was already detached,
 * or the replacement attach is still un-ACKed. The client recovers with a fresh
 * attach and the server must NOT escalate to reload/disconnect: doing so tore
 * down the viewer's whole socket (every terminal plus the dashboard) for a
 * benign race. Untrustworthy-recovery codes are deliberately absent here.
 */
function isBenignTerminalResyncFailure(code) {
    return code === 'connection-not-found' || code === 'stale-frame';
}
function sameTerminalOwner(left, right) {
    return Boolean(left && right &&
        left.engineEpoch === right.engineEpoch &&
        left.terminalGeneration === right.terminalGeneration);
}
function negotiateTerminalCapabilities(requested, supported = exports.RAW_V2_CAPABILITIES) {
    const allowed = new Set(supported);
    return [...new Set(requested)].filter((capability) => allowed.has(capability));
}
/** Deterministic request fingerprint. Principal scope is intentionally applied
 * by TerminalConnectionService, not accepted from a transport payload. */
function terminalAttachFingerprint(request) {
    return JSON.stringify({
        terminalId: request.terminalId,
        capabilities: [...new Set(request.capabilities)].sort(),
        requestedSize: request.requestedSize ?? null,
        after: request.after ?? null,
        historyLines: request.historyLines ?? null,
        maxSnapshotChars: request.maxSnapshotChars ?? null,
        historyMode: request.historyMode ?? 'normal',
    });
}
const textEncoder = new TextEncoder();
function utf8Chunks(value, maxBytes) {
    if (!value)
        return [];
    if (textEncoder.encode(value).byteLength <= maxBytes)
        return [value];
    const chunks = [];
    let start = 0;
    let offset = 0;
    let bytes = 0;
    while (offset < value.length) {
        const point = value.codePointAt(offset);
        const codeUnits = point > 0xffff ? 2 : 1;
        const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
        if (offset > start && bytes + size > maxBytes) {
            chunks.push(value.slice(start, offset));
            start = offset;
            bytes = 0;
        }
        bytes += size;
        offset += codeUnits;
    }
    if (start < value.length)
        chunks.push(value.slice(start));
    return chunks;
}
function oscRequestsReply(sequence) {
    // Only a standalone `?` parameter requests a reply (dynamic-color, palette
    // and clipboard queries such as OSC 10;? / 4;N;? / 52;c;?). A `?` embedded
    // inside another parameter — an OSC 8 hyperlink URI query string, a window
    // title — never produces one, and classifying it as a query lets ordinary
    // link-heavy output veto attach quiet windows and poison raw resync.
    const body = sequence.endsWith('\x07')
        ? sequence.slice(2, -1)
        : sequence.endsWith('\x1b\\')
            ? sequence.slice(2, -2)
            : sequence.slice(2);
    return body.split(';').some((parameter) => parameter === '?');
}
function classifyEscape(sequence) {
    if (sequence === '\x1bZ')
        return 'client-processing-required';
    if (sequence.startsWith('\x1b[')) {
        const final = sequence.charAt(sequence.length - 1);
        // DA, DSR/CPR, window reports, DECRQSS-like mode queries, and xterm
        // extensions can produce emulator replies. Unknown CSI query forms fail
        // safe rather than being replaced by a later screen.
        if (final === 'c' || final === 'n' || final === 't' || sequence.includes('$p')) {
            return 'client-processing-required';
        }
    }
    if (sequence.startsWith('\x1b]') && oscRequestsReply(sequence)) {
        return 'client-processing-required';
    }
    if (sequence.startsWith('\x1bP') && (sequence.includes('$q') || sequence.includes('+q'))) {
        return 'client-processing-required';
    }
    return 'screen-replaceable';
}
function escapeEnd(text, start) {
    if (start + 1 >= text.length)
        return null;
    const marker = text[start + 1];
    if (marker === '[') {
        for (let index = start + 2; index < text.length; index += 1) {
            const code = text.charCodeAt(index);
            if (code >= 0x40 && code <= 0x7e)
                return index + 1;
        }
        return null;
    }
    if (marker === ']' || marker === 'P' || marker === '^' || marker === '_') {
        for (let index = start + 2; index < text.length; index += 1) {
            if (text[index] === '\x07')
                return index + 1;
            if (text[index] === '\x1b' && text[index + 1] === '\\')
                return index + 2;
        }
        return null;
    }
    // Charset designation has one additional byte; the remaining ESC forms
    // used by terminals are two-byte sequences.
    return marker === '(' || marker === ')' || marker === '*' || marker === '+'
        ? (start + 2 < text.length ? start + 3 : null)
        : start + 2;
}
/**
 * Stateful ANSI splitter for v2 only. Legacy callbacks retain their original
 * bytes and callback boundaries. Incomplete escape prefixes are held until a
 * later callback; a bounded overlong/unknown sequence is emitted as
 * client-processing-required so recovery cannot skip it.
 */
class TerminalV2AnsiSplitter {
    maxFragmentBytes;
    maxEscapeCarryBytes;
    pending = null;
    constructor(maxFragmentBytes = exports.TERMINAL_CONNECTION_MAX_FRAGMENT_BYTES, maxEscapeCarryBytes = 4 * 1024) {
        this.maxFragmentBytes = maxFragmentBytes;
        this.maxEscapeCarryBytes = maxEscapeCarryBytes;
    }
    feed(data, bufferSeq) {
        const prefix = this.pending;
        const combined = (prefix?.data ?? '') + data;
        const combinedBufferSeq = prefix
            ? prefix.bufferSeq !== undefined && bufferSeq !== undefined
                ? Math.max(prefix.bufferSeq, bufferSeq)
                : undefined
            : bufferSeq;
        this.pending = null;
        const logical = [];
        const logicalBytes = [];
        let offset = 0;
        let textStart = 0;
        const push = (value, delivery, seq = combinedBufferSeq) => {
            for (const chunk of utf8Chunks(value, this.maxFragmentBytes)) {
                const bytes = textEncoder.encode(chunk).byteLength;
                const previous = logical.at(-1);
                const previousBytes = logicalBytes.at(-1) ?? 0;
                if (previous && previous.delivery === delivery && previous.bufferSeq === seq &&
                    previousBytes + bytes <= this.maxFragmentBytes) {
                    previous.data += chunk;
                    logicalBytes[logicalBytes.length - 1] = previousBytes + bytes;
                    continue;
                }
                logical.push(seq === undefined ? { data: chunk, delivery } : { data: chunk, delivery, bufferSeq: seq });
                logicalBytes.push(bytes);
            }
        };
        while (offset < combined.length) {
            const esc = combined.indexOf('\x1b', offset);
            if (esc < 0)
                break;
            if (esc > textStart)
                push(combined.slice(textStart, esc), 'screen-replaceable');
            const end = escapeEnd(combined, esc);
            if (end === null) {
                const carry = combined.slice(esc);
                if (textEncoder.encode(carry).byteLength > this.maxEscapeCarryBytes) {
                    push(carry, 'client-processing-required', combinedBufferSeq);
                }
                else {
                    this.pending = { data: carry, bufferSeq: combinedBufferSeq };
                }
                return logical;
            }
            const sequence = combined.slice(esc, end);
            push(sequence, classifyEscape(sequence));
            offset = end;
            textStart = end;
        }
        if (textStart < combined.length)
            push(combined.slice(textStart), 'screen-replaceable');
        return logical;
    }
    /** Flush only at terminal teardown. A partial control sequence is not
     * replaceable display data. */
    finish() {
        const pending = this.pending;
        this.pending = null;
        if (!pending?.data)
            return [];
        return utf8Chunks(pending.data, this.maxFragmentBytes).map((data) => ({
            data,
            delivery: 'client-processing-required',
            ...(pending.bufferSeq === undefined ? {} : { bufferSeq: pending.bufferSeq }),
        }));
    }
}
exports.TerminalV2AnsiSplitter = TerminalV2AnsiSplitter;
