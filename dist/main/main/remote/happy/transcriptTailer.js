"use strict";
/**
 * TranscriptTailer — follows an agent's JSONL transcript file and emits
 * HappyEnvelope batches: one snapshot on start, then deltas as the agent
 * appends new lines.
 *
 * Each poll stats the file and reads only the bytes appended since the last
 * consumed newline. Offsets only ever advance to just past a '\n' — an ASCII
 * byte that never occurs inside a UTF-8 multibyte sequence — so reads always
 * start on a character boundary. A shrunken size (truncate / rotation, e.g. a
 * new session id on `--resume`) resets to a fresh snapshot (ids reset with
 * lineIndex).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TranscriptTailer = void 0;
const fs_1 = require("fs");
const transcriptToEnvelopes_1 = require("./transcriptToEnvelopes");
const POLL_MS = 350;
class TranscriptTailer {
    filePath;
    agentType;
    timer = null;
    lineIndex = 0;
    byteOffset = 0;
    stopped = false;
    constructor(filePath, agentType) {
        this.filePath = filePath;
        this.agentType = agentType;
    }
    /**
     * @param onSnapshot called once with all envelopes parsed so far
     * @param onDelta    called on each poll with envelopes for newly-appended lines
     */
    async start(onSnapshot, onDelta) {
        const snapshot = await this.consumeNew();
        if (this.stopped)
            return;
        onSnapshot(snapshot);
        this.timer = setInterval(() => {
            if (this.stopped)
                return;
            void this.consumeNew()
                .then((delta) => {
                if (delta.length && !this.stopped)
                    onDelta(delta);
            })
                .catch(() => {
                /* transient read error — next poll retries */
            });
        }, POLL_MS);
    }
    stop() {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    /** Read appended bytes, return envelopes for any complete lines not yet emitted. */
    async consumeNew() {
        let size;
        try {
            size = (await fs_1.promises.stat(this.filePath)).size;
        }
        catch {
            return [];
        }
        // File truncated / rotated: start over so the phone rebuilds from a fresh
        // snapshot (ids reset with lineIndex).
        if (size < this.byteOffset) {
            this.byteOffset = 0;
            this.lineIndex = 0;
        }
        if (size === this.byteOffset)
            return [];
        let chunk;
        try {
            chunk = await readRange(this.filePath, this.byteOffset, size - this.byteOffset);
        }
        catch {
            return [];
        }
        // Only consume through the last complete line — a half-written tail stays
        // unconsumed for the next poll.
        const lastNewline = chunk.lastIndexOf(0x0a);
        if (lastNewline === -1)
            return [];
        const consumed = chunk.subarray(0, lastNewline + 1);
        const newLines = consumed.toString('utf8').split('\n').slice(0, -1);
        const envelopes = (0, transcriptToEnvelopes_1.mapTranscriptLines)(newLines, this.agentType, this.lineIndex);
        this.byteOffset += lastNewline + 1;
        this.lineIndex += newLines.length;
        return envelopes;
    }
}
exports.TranscriptTailer = TranscriptTailer;
/** Read `length` bytes starting at `start`; returns fewer bytes only at EOF. */
async function readRange(filePath, start, length) {
    const fh = await fs_1.promises.open(filePath, 'r');
    try {
        const buf = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
            const { bytesRead } = await fh.read(buf, read, length - read, start + read);
            if (bytesRead === 0)
                break;
            read += bytesRead;
        }
        return read === length ? buf : buf.subarray(0, read);
    }
    finally {
        await fh.close();
    }
}
