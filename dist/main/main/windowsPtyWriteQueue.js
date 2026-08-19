"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WindowsPtyWriteQueue = exports.WINDOWS_PTY_WRITE_COMPLETION_ALLOWANCE_MS = exports.WINDOWS_PTY_WRITE_MAX_TIMEOUT_MS = exports.WINDOWS_PTY_WRITE_MIN_TIMEOUT_MS = exports.WINDOWS_PTY_WRITE_COMPLETION_CAPABILITY = void 0;
/*
 * ⚠ Terminal minefield — read docs/common-errors/terminals/INDEX.md and
 * docs/common-errors/windows/improve_nodepty_relieable.md before editing.
 *
 * Windows input has one ordered writer per live PTY owner. A logical write is
 * complete only after node-pty's ConPTY input-socket callback has completed
 * every paced chunk. Queue admission, Socket.write()'s boolean return, drain,
 * and generic terminal output are not completion evidence.
 */
const node_crypto_1 = require("node:crypto");
const ptyWriteChunks_1 = require("../shared/terminal/ptyWriteChunks");
exports.WINDOWS_PTY_WRITE_COMPLETION_CAPABILITY = '1devtool-node-pty-write-completion-v1';
exports.WINDOWS_PTY_WRITE_MIN_TIMEOUT_MS = 5_000;
exports.WINDOWS_PTY_WRITE_MAX_TIMEOUT_MS = 20_000;
exports.WINDOWS_PTY_WRITE_COMPLETION_ALLOWANCE_MS = 4_000;
function byteLength(data) {
    return Buffer.byteLength(data, 'utf8');
}
function boundedTimeout(chunkCount) {
    const pacedMs = Math.max(0, chunkCount - 1) * ptyWriteChunks_1.PTY_WRITE_CHUNK_INTERVAL_MS;
    return Math.min(exports.WINDOWS_PTY_WRITE_MAX_TIMEOUT_MS, Math.max(exports.WINDOWS_PTY_WRITE_MIN_TIMEOUT_MS, pacedMs + exports.WINDOWS_PTY_WRITE_COMPLETION_ALLOWANCE_MS));
}
function metrics(request, status, reason) {
    return {
        status,
        logicalWriteId: request.logicalWriteId,
        bytesAttempted: request.bytesAttempted,
        bytesCompleted: request.bytesCompleted,
        chunksAttempted: request.chunksAttempted,
        chunksCompleted: request.chunksCompleted,
        enterAttempted: request.enterAttempted,
        enterPipeCompleted: request.enterPipeCompleted,
        ...(reason ? { reason } : {}),
    };
}
/**
 * One callback-driven queue for one terminal ID. Every request captures the
 * concrete PTY object that owned the ID at admission, preventing delayed
 * chunks or Enter from crossing into a same-ID replacement.
 */
class WindowsPtyWriteQueue {
    pending = [];
    active = null;
    paceTimer = null;
    disposed = false;
    poisonedReason = null;
    terminalId;
    getCurrentTarget;
    onTrace;
    onIdle;
    schedule;
    cancel;
    now;
    constructor(options) {
        this.terminalId = options.terminalId;
        this.getCurrentTarget = options.getCurrentTarget;
        this.onTrace = options.onTrace;
        this.onIdle = options.onIdle;
        this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
        this.cancel = options.cancel ?? ((timer) => clearTimeout(timer));
        this.now = options.now ?? Date.now;
    }
    enqueue(data, options) {
        const target = this.getCurrentTarget();
        const chunks = (0, ptyWriteChunks_1.splitPtyWriteForConpty)(data);
        const logicalWriteId = (0, node_crypto_1.randomUUID)();
        let resolve;
        const promise = new Promise((settle) => { resolve = settle; });
        const request = {
            logicalWriteId,
            target: target ?? { token: {}, generation: -1, pty: { write() { } } },
            chunks,
            chunkBytes: chunks.map(byteLength),
            chunkIndex: 0,
            bytesAttempted: 0,
            bytesCompleted: 0,
            chunksAttempted: 0,
            chunksCompleted: 0,
            enterAttempted: false,
            enterPipeCompleted: false,
            requireCompletion: options.requireCompletion,
            expectedGeneration: options.expectedGeneration,
            fenceId: options.fenceId,
            partNumber: options.partNumber,
            partKind: options.partKind,
            deadlineAt: this.now() + Math.max(1, options.timeoutMs ?? boundedTimeout(chunks.length)),
            callbackTimer: null,
            settled: false,
            legacyFallback: false,
            promise,
            resolve,
        };
        if (this.disposed || !target || (options.expectedGeneration !== undefined && options.expectedGeneration !== target.generation)) {
            request.resolve(metrics(request, 'owner-changed', this.disposed ? 'queue-disposed' : 'owner-mismatch'));
            return promise;
        }
        if (this.poisonedReason) {
            request.resolve(metrics(request, 'transport-uncertain', `prior-write-uncertain:${this.poisonedReason}`));
            return promise;
        }
        this.pending.push(request);
        this.trace(request, 'queue-enqueued');
        this.drain();
        return promise;
    }
    /** Wait only for the requests present at the barrier, never later input. */
    async flush() {
        const requests = [this.active, ...this.pending].filter((row) => Boolean(row));
        if (requests.length === 0)
            return;
        await Promise.all(requests.map((request) => request.promise));
        const last = requests[requests.length - 1];
        this.trace(last, 'queue-barrier');
    }
    /** Teardown cannot retract a dispatched OS write, so only queued work is a clean rejection. */
    discard(reason = 'owner-disposed') {
        if (this.disposed)
            return;
        this.disposed = true;
        if (this.paceTimer) {
            this.cancel(this.paceTimer);
            this.paceTimer = null;
        }
        if (this.active) {
            const active = this.active;
            this.active = null;
            this.settle(active, metrics(active, active.chunksAttempted > 0 ? 'owner-lost-uncertain' : 'owner-changed', reason), false);
        }
        for (const request of this.pending.splice(0)) {
            this.settle(request, metrics(request, 'owner-changed', reason), false);
        }
    }
    drain() {
        if (this.disposed || this.active || this.paceTimer)
            return;
        const request = this.pending.shift();
        if (!request) {
            this.onIdle?.();
            return;
        }
        this.active = request;
        this.dispatchNext(request);
    }
    dispatchNext(request) {
        if (request.settled || this.active !== request)
            return;
        const current = this.getCurrentTarget();
        if (!current || current.token !== request.target.token || current.generation !== request.target.generation) {
            this.trace(request, 'owner-change');
            this.finish(request, metrics(request, request.chunksAttempted > 0 ? 'owner-lost-uncertain' : 'owner-changed', 'owner-mismatch'));
            return;
        }
        const chunk = request.chunks[request.chunkIndex];
        if (chunk === undefined) {
            this.finish(request, metrics(request, request.legacyFallback ? 'capability-unavailable' : 'pipe-completed', request.legacyFallback ? 'legacy-write-fallback' : undefined));
            return;
        }
        const hasCompletion = typeof current.pty.writeWithCompletion === 'function' &&
            current.pty._1devtoolWriteCompletionCapability === exports.WINDOWS_PTY_WRITE_COMPLETION_CAPABILITY;
        if (!hasCompletion && request.requireCompletion) {
            this.finish(request, metrics(request, 'capability-unavailable', 'node-pty-patch-missing'));
            return;
        }
        request.chunksAttempted += 1;
        request.bytesAttempted += request.chunkBytes[request.chunkIndex] ?? 0;
        request.enterAttempted ||= request.partKind === 'submit-enter';
        this.trace(request, 'node-pty-dispatched', request.chunkIndex);
        if (!hasCompletion) {
            // Ordinary human input remains usable in a development tree whose patch
            // is missing. It is never promoted to reliable programmatic evidence.
            request.legacyFallback = true;
            try {
                current.pty.write(chunk);
            }
            catch {
                this.failUncertain(request, 'legacy-write-threw');
                return;
            }
            request.chunkIndex += 1;
            this.pace(request);
            return;
        }
        let callbackSettled = false;
        const complete = (error) => {
            if (callbackSettled || request.settled || this.active !== request)
                return;
            callbackSettled = true;
            if (request.callbackTimer) {
                this.cancel(request.callbackTimer);
                request.callbackTimer = null;
            }
            if (error) {
                this.trace(request, 'socket-error', request.chunkIndex, error.message);
                this.failUncertain(request, error.message || 'socket-callback-error');
                return;
            }
            request.chunksCompleted += 1;
            request.bytesCompleted += request.chunkBytes[request.chunkIndex] ?? 0;
            request.enterPipeCompleted ||= request.partKind === 'submit-enter';
            this.trace(request, 'socket-callback', request.chunkIndex);
            request.chunkIndex += 1;
            this.pace(request);
        };
        const remainingMs = Math.max(1, request.deadlineAt - this.now());
        request.callbackTimer = this.schedule(() => {
            if (callbackSettled || request.settled || this.active !== request)
                return;
            callbackSettled = true;
            request.callbackTimer = null;
            this.trace(request, 'write-timeout', request.chunkIndex);
            this.failUncertain(request, 'socket-callback-timeout');
        }, remainingMs);
        try {
            // Socket.write() returning false means backpressure, not completion.
            current.pty.writeWithCompletion(chunk, complete);
        }
        catch (error) {
            complete(error instanceof Error ? error : new Error(String(error)));
        }
    }
    pace(request) {
        if (request.settled || this.active !== request)
            return;
        if (request.chunkIndex >= request.chunks.length) {
            this.dispatchNext(request);
            return;
        }
        this.paceTimer = this.schedule(() => {
            this.paceTimer = null;
            this.dispatchNext(request);
        }, ptyWriteChunks_1.PTY_WRITE_CHUNK_INTERVAL_MS);
    }
    failUncertain(request, reason) {
        this.poisonedReason = reason;
        this.finish(request, metrics(request, 'transport-uncertain', reason), false);
        for (const queued of this.pending.splice(0)) {
            this.settle(queued, metrics(queued, 'transport-uncertain', `prior-write-uncertain:${reason}`), false);
        }
    }
    finish(request, result, continueQueue = true) {
        if (this.active === request)
            this.active = null;
        this.settle(request, result, false);
        if (!continueQueue || this.disposed || this.poisonedReason)
            return;
        if (this.pending.length === 0) {
            this.onIdle?.();
            return;
        }
        this.paceTimer = this.schedule(() => {
            this.paceTimer = null;
            this.drain();
        }, ptyWriteChunks_1.PTY_WRITE_CHUNK_INTERVAL_MS);
    }
    settle(request, result, _continueQueue) {
        if (request.settled)
            return;
        request.settled = true;
        if (request.callbackTimer) {
            this.cancel(request.callbackTimer);
            request.callbackTimer = null;
        }
        this.trace(request, 'write-settled', undefined, result.reason, result.status);
        request.resolve(result);
    }
    trace(request, event, chunkIndex, reason, status) {
        this.onTrace?.({
            at: this.now(),
            terminalId: this.terminalId,
            logicalWriteId: request.logicalWriteId,
            event,
            ...(chunkIndex === undefined ? {} : { chunkIndex }),
            chunkCount: request.chunks.length,
            bytesAttempted: request.bytesAttempted,
            bytesCompleted: request.bytesCompleted,
            ...(status ? { status } : {}),
            ...(reason ? { reason } : {}),
            ...(request.fenceId ? { fenceId: request.fenceId } : {}),
            ...(request.partNumber === undefined ? {} : { partNumber: request.partNumber }),
            ...(request.partKind ? { partKind: request.partKind } : {}),
        });
    }
}
exports.WindowsPtyWriteQueue = WindowsPtyWriteQueue;
