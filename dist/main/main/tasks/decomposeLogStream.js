"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDecomposeLogStream = createDecomposeLogStream;
/**
 * Batched retention of a decomposition's main-owned lifecycle log (§4.5a).
 *
 * Lifecycle events can arrive in bursts around adoption, completion and
 * teardown. Forwarding each one into main-owned run state would put persistence
 * and a renderer wake-up on the producer's cadence — the same mistake as
 * writing to a store on every `xterm.onData` keystroke. So events accumulate
 * and flush on a timer.
 *
 * Two bounds, and they are different bounds on purpose:
 *
 * - `MAX_TOTAL_CHARS` caps what the run record retains. Past it the
 *   stream goes quiet except for `note` lines, which stay flowing because the
 *   ending — timeout, refusal, parse failure — is the part worth waiting for.
 * - `MAX_CHUNK_CHARS` caps a single oversized write so one enormous line cannot
 *   spend the whole budget before anything else is seen.
 *
 * The truncation is announced. A log that silently stops is indistinguishable
 * from a run that silently hung, which is the exact confusion this exists to
 * remove.
 */
const FLUSH_MS = 120;
const MAX_TOTAL_CHARS = 200_000;
const MAX_CHUNK_CHARS = 8_000;
function createDecomposeLogStream(onFlush) {
    let pending = [];
    let timer;
    let sentChars = 0;
    let closed = false;
    let announcedTruncation = false;
    const flush = () => {
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }
        if (pending.length === 0)
            return;
        const events = pending;
        pending = [];
        try {
            onFlush(events);
        }
        catch {
            // Logging is advisory. A persistence/UI observer must never be able to
            // kill the decomposition whose lifecycle this stream is recording.
        }
    };
    const push = (event) => {
        if (closed)
            return;
        if (event.stream === 'note') {
            pending.push(event);
        }
        else if (sentChars >= MAX_TOTAL_CHARS) {
            if (announcedTruncation)
                return;
            announcedTruncation = true;
            pending.push({ stream: 'note', text: '… output cap reached; the run continues' });
        }
        else {
            const text = event.text.length > MAX_CHUNK_CHARS
                ? `${event.text.slice(0, MAX_CHUNK_CHARS)}…`
                : event.text;
            sentChars += text.length;
            pending.push({ stream: event.stream, text });
        }
        // `unref` so a pending flush can never hold the process open at quit.
        if (!timer) {
            timer = setTimeout(flush, FLUSH_MS);
            timer.unref?.();
        }
    };
    return {
        push,
        close: () => {
            if (closed)
                return;
            closed = true;
            flush();
        },
    };
}
