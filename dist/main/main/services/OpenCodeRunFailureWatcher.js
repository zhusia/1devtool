"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenCodeRunFailureWatcher = void 0;
exports.parseOpenCodeRunFailure = parseOpenCodeRunFailure;
exports.resolveOpenCodeFailureTerminalId = resolveOpenCodeFailureTerminalId;
/*
 * OpenCode run-failure side channel — read
 * docs/common-errors/terminals/INDEX.md and
 * docs/common-errors/terminals/run-timer-stuck-and-resurrected.md.
 *
 * OpenCode's OpenTUI keeps repainting a retry spinner after a terminal quota
 * failure, so PTY silence/novelty can only end the tab timer after a fallback
 * delay. Its structured log emits the failure immediately with a session id;
 * this watcher forwards only that attributable process-owned event. It never
 * scans terminal transcript text.
 */
const fs_1 = __importDefault(require("fs"));
const fs_2 = require("fs");
const contracts_1 = require("../../shared/terminal/contracts");
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_RETRY_DELAYS_MS = [250, 750, 1500, 3000, 5000];
const MAX_PARTIAL_LINE_BYTES = 64 * 1024;
const MAX_READ_BYTES = 256 * 1024;
const MAX_SEEN_RUNS = 256;
function readLogField(line, field) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = line.match(new RegExp(`(?:^|\\s)${escaped}=(?:"([^"]*)"|(\\S+))`));
    return match?.[1] ?? match?.[2] ?? null;
}
/** Parse only OpenCode's structured primary-agent usage-limit error event. */
function parseOpenCodeRunFailure(line) {
    if (!line.includes('level=ERROR') || !/\busage limit reached\b/i.test(line))
        return null;
    if (readLogField(line, 'message') !== 'stream error')
        return null;
    if (readLogField(line, 'small') === 'true')
        return null; // title/helper agent, not the submitted run
    const runId = readLogField(line, 'run');
    const sessionId = readLogField(line, 'session.id');
    const error = readLogField(line, 'error.error');
    const timestamp = readLogField(line, 'timestamp');
    if (!runId || !sessionId || !error || !/\busage limit reached\b/i.test(error))
        return null;
    const parsedTime = timestamp ? Date.parse(timestamp) : Number.NaN;
    return {
        runId,
        sessionId,
        endedAt: Number.isFinite(parsedTime) ? parsedTime : Date.now(),
        reason: 'usage-limit',
    };
}
/** Resolve only a unique persisted OpenCode session binding; never guess. */
function resolveOpenCodeFailureTerminalId(projects, sessionId) {
    const matches = projects.flatMap((project) => project.terminals.filter((terminal) => {
        if (terminal.lastSessionId !== sessionId)
            return false;
        const resumeType = terminal.lastSessionAgentType
            ?? (0, contracts_1.mapToResumeAgentType)(terminal.agentType, terminal.startupCommand);
        return resumeType === 'opencode';
    }));
    return matches.length === 1 ? matches[0].id : null;
}
/**
 * Incrementally tails opencode.log. Existing history is baselined at start,
 * so old failures can never stop a newly launched terminal run.
 */
class OpenCodeRunFailureWatcher {
    logPath;
    onFailure;
    pollIntervalMs;
    retryDelaysMs;
    offset = 0;
    partialLine = Buffer.alloc(0);
    started = false;
    draining = false;
    drainAgain = false;
    retryTimers = new Set();
    seenRunIds = new Set();
    seenRunOrder = [];
    constructor(logPath, onFailure, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, retryDelaysMs = DEFAULT_RETRY_DELAYS_MS) {
        this.logPath = logPath;
        this.onFailure = onFailure;
        this.pollIntervalMs = pollIntervalMs;
        this.retryDelaysMs = retryDelaysMs;
    }
    async start() {
        if (this.started)
            return;
        this.started = true;
        try {
            this.offset = (await fs_2.promises.stat(this.logPath)).size;
        }
        catch {
            this.offset = 0;
        }
        if (!this.started)
            return;
        fs_1.default.watchFile(this.logPath, { interval: this.pollIntervalMs, persistent: false }, () => { void this.drain(); });
    }
    stop() {
        if (!this.started)
            return;
        this.started = false;
        fs_1.default.unwatchFile(this.logPath);
        for (const timer of this.retryTimers)
            clearTimeout(timer);
        this.retryTimers.clear();
    }
    async drain() {
        if (!this.started)
            return;
        if (this.draining) {
            this.drainAgain = true;
            return;
        }
        this.draining = true;
        try {
            do {
                this.drainAgain = false;
                await this.readAvailableBytes();
            } while (this.drainAgain && this.started);
        }
        catch {
            // The log may rotate/disappear while OpenCode restarts. The next stat
            // event retries; terminal behavior must never depend on this side channel.
        }
        finally {
            this.draining = false;
        }
    }
    async readAvailableBytes() {
        let size;
        try {
            size = (await fs_2.promises.stat(this.logPath)).size;
        }
        catch {
            return;
        }
        if (size < this.offset) {
            // Rotation/truncation: the replacement file is a new stream.
            this.offset = 0;
            this.partialLine = Buffer.alloc(0);
        }
        if (size === this.offset)
            return;
        const start = this.offset;
        const length = Math.min(size - start, MAX_READ_BYTES);
        const handle = await fs_2.promises.open(this.logPath, 'r');
        try {
            const bytes = Buffer.alloc(length);
            const { bytesRead } = await handle.read(bytes, 0, length, start);
            this.offset = start + bytesRead;
            if (bytesRead > 0)
                this.consume(bytes.subarray(0, bytesRead));
            if (this.offset < size)
                this.drainAgain = true;
        }
        finally {
            await handle.close();
        }
    }
    consume(bytes) {
        const combined = this.partialLine.length > 0
            ? Buffer.concat([this.partialLine, bytes])
            : bytes;
        let lineStart = 0;
        for (let i = 0; i < combined.length; i++) {
            if (combined[i] !== 0x0a)
                continue;
            const line = combined.subarray(lineStart, i).toString('utf8').replace(/\r$/, '');
            this.consumeLine(line);
            lineStart = i + 1;
        }
        this.partialLine = combined.subarray(lineStart);
        if (this.partialLine.length > MAX_PARTIAL_LINE_BYTES) {
            this.partialLine = this.partialLine.subarray(-MAX_PARTIAL_LINE_BYTES);
        }
    }
    consumeLine(line) {
        const event = parseOpenCodeRunFailure(line);
        if (!event || this.seenRunIds.has(event.runId))
            return;
        this.seenRunIds.add(event.runId);
        this.seenRunOrder.push(event.runId);
        if (this.seenRunOrder.length > MAX_SEEN_RUNS) {
            const evicted = this.seenRunOrder.shift();
            if (evicted)
                this.seenRunIds.delete(evicted);
        }
        this.deliver(event, 0);
    }
    deliver(event, attempt) {
        if (!this.started)
            return;
        try {
            if (this.onFailure(event))
                return;
        }
        catch {
            // Treat a transient consumer failure like a missing session binding.
        }
        const delay = this.retryDelaysMs[attempt];
        if (delay == null)
            return;
        const timer = setTimeout(() => {
            this.retryTimers.delete(timer);
            this.deliver(event, attempt + 1);
        }, delay);
        timer.unref?.();
        this.retryTimers.add(timer);
    }
}
exports.OpenCodeRunFailureWatcher = OpenCodeRunFailureWatcher;
