"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalConnectionService = void 0;
/**
 * One authoritative attach/reconcile/ACK implementation for terminal clients.
 * Terminal hotspot: read docs/common-errors/terminals/INDEX.md before editing.
 * Transport adapters validate their caller, mint a principal, and translate
 * frames only. This service never spawns a PTY or grants input/task authority.
 */
const node_crypto_1 = require("node:crypto");
const connectionProtocol_1 = require("../../shared/terminal/connectionProtocol");
const replay_1 = require("../../shared/terminal/replay");
const DEFAULT_ACK_TIMEOUT_MS = 10_000;
const DESKTOP_SUPPLEMENT_BYTES = 512 * 1024;
const REMOTE_SUPPLEMENT_BYTES = 256 * 1024;
const MAX_SUPPLEMENT_FRAGMENTS = 2_048;
const MAX_DIAGNOSTICS = 100;
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;
const DESKTOP_BUFFERED_OUTPUT_BYTES = 512 * 1024;
const utf8Encoder = new TextEncoder();
function byteLength(value) {
    return utf8Encoder.encode(value).byteLength;
}
function frameBytes(frame) {
    // Count the complete protocol envelope. Transport framing may add a few
    // bytes, but data-only accounting let thousands of tiny ANSI frames evade
    // the advertised 256 KiB window entirely.
    return byteLength(JSON.stringify(frame));
}
function fragmentBytes(fragment) {
    return byteLength(JSON.stringify(fragment));
}
function frameNumber(frameId, syncGeneration) {
    const [generationRaw, ordinalRaw, extra] = frameId.split(':');
    const generation = Number(generationRaw);
    const ordinal = Number(ordinalRaw);
    return extra === undefined && generation === syncGeneration && Number.isSafeInteger(ordinal) && ordinal > 0
        ? ordinal
        : null;
}
function supplementBytes(fragments) {
    return fragments.reduce((sum, fragment) => sum + byteLength(fragment.data), 0);
}
function isUnbufferedUnsafe(fragment) {
    return fragment.delivery === 'client-processing-required' && fragment.cursor.bufferSeq === undefined;
}
function assertSize(size) {
    if (!Number.isSafeInteger(size.cols) || !Number.isSafeInteger(size.rows) ||
        size.cols <= 0 || size.rows <= 0 || size.cols > 1_000 || size.rows > 1_000) {
        throw new connectionProtocol_1.TerminalConnectionError('forbidden', 'Invalid terminal size request');
    }
}
class TerminalConnectionService {
    backend;
    ackTimeoutMs;
    maxPendingBytes;
    maxPendingFrames;
    backgroundGraceMs;
    queryQuietWindowMs;
    maxQueryQuietRetries;
    desktopAttachDeadlineMs;
    remoteAttachDeadlineMs;
    now;
    mintId;
    wait;
    applyRequestedSize;
    connections = new Map();
    attachCache = new Map();
    diagnosticsLog = [];
    diagnosticsSizes = [];
    diagnosticsBytes = 0;
    constructor(options) {
        this.backend = options.backend;
        this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
        this.maxPendingBytes = options.maxPendingBytes ?? connectionProtocol_1.TERMINAL_CONNECTION_REMOTE_WINDOW_BYTES;
        this.maxPendingFrames = options.maxPendingFrames ?? connectionProtocol_1.TERMINAL_CONNECTION_MAX_PENDING_FRAMES;
        this.backgroundGraceMs = options.backgroundGraceMs ?? connectionProtocol_1.TERMINAL_CONNECTION_REMOTE_BACKGROUND_GRACE_MS;
        this.queryQuietWindowMs = options.queryQuietWindowMs ?? connectionProtocol_1.TERMINAL_CONNECTION_QUERY_QUIET_WINDOW_MS;
        this.maxQueryQuietRetries = options.maxQueryQuietRetries ?? connectionProtocol_1.TERMINAL_CONNECTION_MAX_QUERY_QUIET_RETRIES;
        this.desktopAttachDeadlineMs = options.desktopAttachDeadlineMs ?? connectionProtocol_1.TERMINAL_CONNECTION_DESKTOP_ATTACH_DEADLINE_MS;
        this.remoteAttachDeadlineMs = options.remoteAttachDeadlineMs ?? connectionProtocol_1.TERMINAL_CONNECTION_REMOTE_ATTACH_DEADLINE_MS;
        this.now = options.now ?? Date.now;
        this.mintId = options.mintId ?? node_crypto_1.randomUUID;
        this.wait = options.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
        this.applyRequestedSize = options.applyRequestedSize;
    }
    attach(request, principal, onFrame, onClose) {
        this.assertRead(principal);
        if (!request.terminalId || !request.clientRequestId) {
            return Promise.reject(new connectionProtocol_1.TerminalConnectionError('forbidden', 'terminalId and clientRequestId are required'));
        }
        const cacheKey = `${principal.origin}:${principal.subjectId}:${request.clientRequestId}`;
        const fingerprint = (0, connectionProtocol_1.terminalAttachFingerprint)(request);
        const cached = this.attachCache.get(cacheKey);
        if (cached) {
            if (cached.fingerprint !== fingerprint) {
                return Promise.reject(new connectionProtocol_1.TerminalConnectionError('request-id-conflict', 'The attach request ID was reused with different parameters'));
            }
            return cached.promise;
        }
        const connectionId = this.mintId();
        const promise = this.createConnection(connectionId, cacheKey, request, principal, onFrame, onClose)
            .catch((error) => {
            const current = this.attachCache.get(cacheKey);
            if (current?.connectionId === connectionId)
                this.attachCache.delete(cacheKey);
            this.detach(connectionId);
            throw error;
        });
        this.attachCache.set(cacheKey, { fingerprint, promise, connectionId });
        return promise;
    }
    async createConnection(connectionId, cacheKey, request, principal, onFrame, onClose) {
        const identity = this.backend.getOwnerIdentity(request.terminalId);
        if (!identity) {
            throw new connectionProtocol_1.TerminalConnectionError('terminal-not-live', 'The terminal process is not running');
        }
        const record = {
            connectionId,
            cacheKey,
            terminalId: request.terminalId,
            principal,
            request,
            onFrame,
            onClose,
            syncGeneration: 1,
            nextFrameNumber: 1,
            attachFrameId: '',
            phase: 'attaching',
            identity,
            expectedStreamSeq: 0,
            latestStreamSeq: 0,
            buffered: [],
            bufferedBytes: 0,
            bufferedOverflow: false,
            resyncAfterAttachAck: false,
            deferredResyncReason: null,
            pending: new Map(),
            ackTimer: null,
            lastAckedFrameNumber: 0,
            pendingBytes: 0,
            pendingUnsafe: 0,
            resyncUnsafe: false,
            clientProcessingRevision: 0,
            lastClientProcessingAt: 0,
            visible: true,
            backgroundTimer: null,
            pendingExit: undefined,
            unsubscribeOutput: () => { },
            unsubscribeExit: () => { },
        };
        // Subscribe before resize/snapshot. The owner flushes all fragments through
        // its cut before resolving getAttachSnapshotV2().
        record.unsubscribeOutput = this.backend.onV2Output(request.terminalId, (fragment) => {
            this.receiveOutput(record, fragment);
        });
        record.unsubscribeExit = this.backend.onV2Exit(request.terminalId, (event) => {
            if (record.phase === 'closed' || !(0, connectionProtocol_1.sameTerminalOwner)(record.identity, event.identity))
                return;
            if (record.phase === 'attaching' || record.phase === 'awaiting-attach-ack') {
                record.pendingExit = event;
                return;
            }
            this.emitFrame(record, { type: 'exit', ...event });
        });
        this.connections.set(connectionId, record);
        if (request.requestedSize) {
            assertSize(request.requestedSize);
            if (principal.permissions.has('resize')) {
                if (this.applyRequestedSize) {
                    await this.applyRequestedSize(principal, request.terminalId, request.requestedSize);
                }
                else {
                    this.backend.resize(request.terminalId, request.requestedSize.cols, request.requestedSize.rows);
                }
            }
        }
        this.assertConnectionOpen(record);
        const snapshot = await this.captureStableSnapshot(record);
        this.assertConnectionOpen(record);
        if (!(0, connectionProtocol_1.sameTerminalOwner)(identity, snapshot.session.identity) ||
            !(0, connectionProtocol_1.sameTerminalOwner)(identity, this.backend.getOwnerIdentity(request.terminalId))) {
            throw new connectionProtocol_1.TerminalConnectionError('owner-changed', 'The terminal owner changed during attach');
        }
        if (record.bufferedOverflow) {
            throw new connectionProtocol_1.TerminalConnectionError('supplement-too-large', 'Output produced during attach exceeded the bounded reconciliation window');
        }
        const result = this.buildAttachResult(record, snapshot, request.historyMode === 'native-resume-live-only');
        record.phase = 'awaiting-attach-ack';
        this.reserveAttachFrame(record, result);
        this.note(record, 'attach-ready', {
            cut: result.payload.kind === 'raw'
                ? result.payload.rawFallback.snapshotCutStreamSeq
                : result.payload.kind === 'live-only'
                    ? result.payload.liveOnly.startAfterStreamSeq
                    : result.payload.screen.revision.snapshotCutStreamSeq,
            buffered: record.buffered.length,
        });
        return result;
    }
    /**
     * Query-producing controls cannot be cut while the client-processing window
     * is still moving. Raw mode retries a small fixed number of quiet cuts and
     * then fails typed; it never spins or pauses the shared PTY.
     */
    async captureStableSnapshot(record) {
        const remote = record.principal.origin === 'remote-ui' ||
            record.principal.origin === 'peer-device' ||
            record.principal.origin === 'ssh-bridge';
        const deadlineAt = this.now() + (remote ? this.remoteAttachDeadlineMs : this.desktopAttachDeadlineMs);
        let retries = 0;
        while (true) {
            const revisionBefore = record.clientProcessingRevision;
            const snapshot = await this.backend.getAttachSnapshotV2(record.terminalId);
            const revisionAfter = record.clientProcessingRevision;
            if (revisionAfter === 0)
                return snapshot;
            const quietFor = this.now() - record.lastClientProcessingAt;
            if (revisionBefore === revisionAfter && quietFor >= this.queryQuietWindowMs)
                return snapshot;
            if (retries >= this.maxQueryQuietRetries || this.now() >= deadlineAt) {
                throw new connectionProtocol_1.TerminalConnectionError('client-processing-window-unavailable', 'Terminal query traffic did not become quiet before the attach deadline');
            }
            retries += 1;
            const remaining = deadlineAt - this.now();
            const delay = Math.min(Math.max(1, this.queryQuietWindowMs - quietFor), remaining);
            if (delay <= 0) {
                throw new connectionProtocol_1.TerminalConnectionError('client-processing-window-unavailable', 'Terminal query traffic did not become quiet before the attach deadline');
            }
            await this.wait(delay);
        }
    }
    buildAttachResult(record, snapshot, liveOnly) {
        const maxSnapshotChars = record.request.maxSnapshotChars;
        if (maxSnapshotChars !== undefined &&
            (!Number.isSafeInteger(maxSnapshotChars) || maxSnapshotChars < 16 * 1024 || maxSnapshotChars > 2 * 1024 * 1024)) {
            throw new connectionProtocol_1.TerminalConnectionError('forbidden', 'Invalid raw snapshot character limit');
        }
        const throughCut = record.buffered
            .filter((fragment) => fragment.cursor.streamSeq <= snapshot.snapshotCutStreamSeq)
            .sort((left, right) => left.cursor.streamSeq - right.cursor.streamSeq);
        const startAfterStreamSeq = throughCut.length > 0
            ? throughCut[0].cursor.streamSeq - 1
            : snapshot.snapshotCutStreamSeq;
        // Raw content proves coverage only through the snapshot's bufferSeq. A
        // pre-cut fragment appended after that read must travel as supplement or
        // its effect is silently dropped.
        const supplement = throughCut.filter((fragment) => fragment.cursor.bufferSeq === undefined || fragment.cursor.bufferSeq > snapshot.bufferSeq);
        const supplementCap = record.principal.origin === 'desktop'
            ? DESKTOP_SUPPLEMENT_BYTES
            : REMOTE_SUPPLEMENT_BYTES;
        if (!liveOnly && (supplement.length > MAX_SUPPLEMENT_FRAGMENTS || supplementBytes(supplement) > supplementCap)) {
            throw new connectionProtocol_1.TerminalConnectionError('supplement-too-large', 'The complete unbuffered attach overlap exceeded its safe bound');
        }
        const baseline = liveOnly ? startAfterStreamSeq : snapshot.snapshotCutStreamSeq;
        record.expectedStreamSeq = baseline + 1;
        record.latestStreamSeq = Math.max(record.latestStreamSeq, baseline);
        // Keep only genuinely post-baseline output for release after attach ACK.
        record.buffered = record.buffered.filter((fragment) => fragment.cursor.streamSeq > baseline);
        record.bufferedBytes = record.buffered.reduce((sum, fragment) => sum + fragmentBytes(fragment), 0);
        record.attachFrameId = this.nextFrameId(record);
        const negotiated = (0, connectionProtocol_1.negotiateTerminalCapabilities)(requestCapabilities(record), connectionProtocol_1.RAW_V2_CAPABILITIES);
        return {
            protocolVersion: connectionProtocol_1.TERMINAL_CONNECTION_PROTOCOL_VERSION,
            connectionId: record.connectionId,
            syncGeneration: record.syncGeneration,
            attachFrameId: record.attachFrameId,
            negotiatedCapabilities: negotiated,
            session: snapshot.session,
            payload: liveOnly
                ? {
                    kind: 'live-only',
                    liveOnly: { startAfterStreamSeq, screenVersion: snapshot.screenVersion },
                }
                : {
                    kind: 'raw',
                    rawFallback: {
                        content: maxSnapshotChars === undefined
                            ? snapshot.content
                            : (0, replay_1.trimReplayBufferPreservingModes)(snapshot.content, maxSnapshotChars),
                        bufferSeq: snapshot.bufferSeq,
                        snapshotCutStreamSeq: snapshot.snapshotCutStreamSeq,
                        unbufferedOverlap: supplement.map((fragment) => ({
                            cursor: fragment.cursor,
                            delivery: fragment.delivery,
                            data: fragment.data,
                        })),
                        screenVersion: snapshot.screenVersion,
                    },
                },
        };
    }
    reserveAttachFrame(record, result) {
        // Account the complete attach envelope exactly like every delta frame;
        // payload-only accounting understates what the transport retains.
        this.reservePending(record, record.attachFrameId, byteLength(JSON.stringify(result)), false, 'attach');
    }
    receiveOutput(record, fragment) {
        if (record.phase === 'closed')
            return;
        if (!(0, connectionProtocol_1.sameTerminalOwner)(record.identity, fragment.cursor)) {
            this.requireResync(record, 'owner-changed');
            return;
        }
        record.latestStreamSeq = Math.max(record.latestStreamSeq, fragment.cursor.streamSeq);
        if (fragment.delivery === 'client-processing-required') {
            record.clientProcessingRevision += 1;
            record.lastClientProcessingAt = this.now();
        }
        if (record.phase === 'attaching' || record.phase === 'awaiting-attach-ack') {
            if (record.bufferedOverflow || record.resyncAfterAttachAck) {
                // Fragments dropped after an overflow still poison raw recovery when
                // they carry an unbuffered query; forgetting that here would let the
                // follow-up resync silently skip it.
                record.resyncUnsafe = record.resyncUnsafe || isUnbufferedUnsafe(fragment);
                return;
            }
            const bytes = fragmentBytes(fragment);
            const cap = record.principal.origin === 'desktop'
                ? DESKTOP_BUFFERED_OUTPUT_BYTES
                : this.maxPendingBytes;
            if (record.buffered.length >= this.maxPendingFrames || record.bufferedBytes + bytes > cap) {
                const unsafe = isUnbufferedUnsafe(fragment) || record.buffered.some(isUnbufferedUnsafe);
                record.buffered = [];
                record.bufferedBytes = 0;
                record.resyncUnsafe ||= unsafe;
                if (record.phase === 'attaching')
                    record.bufferedOverflow = true;
                else {
                    record.resyncAfterAttachAck = true;
                    record.deferredResyncReason ??= 'byte-window-exceeded';
                }
                this.note(record, 'attach-buffer-exceeded', { cap, unsafe });
                return;
            }
            record.buffered.push(fragment);
            record.bufferedBytes += bytes;
            return;
        }
        if (record.phase !== 'live')
            return;
        if (fragment.cursor.streamSeq < record.expectedStreamSeq)
            return;
        if (fragment.cursor.streamSeq !== record.expectedStreamSeq) {
            this.requireResync(record, 'stream-gap', isUnbufferedUnsafe(fragment));
            return;
        }
        record.expectedStreamSeq += 1;
        // Desktop hydration-only callers intentionally provide no live callback;
        // do not manufacture an ACK window and IPC traffic they will immediately
        // detach without consuming.
        if (!record.onFrame)
            return;
        this.emitFrame(record, {
            type: 'output',
            cursor: fragment.cursor,
            delivery: fragment.delivery,
            data: fragment.data,
        });
    }
    nextFrameId(record) {
        return `${record.syncGeneration}:${record.nextFrameNumber++}`;
    }
    emitFrame(record, event) {
        if (record.phase === 'closed')
            return;
        const frame = {
            connectionId: record.connectionId,
            syncGeneration: record.syncGeneration,
            frameId: this.nextFrameId(record),
            event,
        };
        const bytes = frameBytes(frame);
        // A client-processing fragment that is in raw replay storage can be
        // recovered by replaying that raw cut. Only an unbuffered unsafe fragment
        // makes replacement unknowable.
        const unsafe = event.type === 'output' &&
            event.delivery === 'client-processing-required' &&
            event.cursor.bufferSeq === undefined;
        if (record.pending.size >= this.maxPendingFrames) {
            this.requireResync(record, 'frame-window-exceeded', unsafe);
            return;
        }
        if (record.pendingBytes + bytes > this.pendingByteCap(record)) {
            this.requireResync(record, 'byte-window-exceeded', unsafe);
            return;
        }
        this.reservePending(record, frame.frameId, bytes, unsafe, 'delta');
        try {
            record.onFrame?.(frame);
        }
        catch {
            try {
                record.onClose?.('transport-error');
            }
            finally {
                this.detach(record.connectionId);
            }
        }
    }
    reservePending(record, frameId, bytes, unsafe, kind) {
        record.pending.set(frameId, { bytes, unsafe, sentAt: this.now(), kind });
        record.pendingBytes += bytes;
        if (unsafe)
            record.pendingUnsafe += 1;
        this.scheduleAckTimer(record);
    }
    scheduleAckTimer(record) {
        if (record.ackTimer)
            clearTimeout(record.ackTimer);
        record.ackTimer = null;
        const oldest = record.pending.entries().next().value;
        if (!oldest || record.phase === 'closed')
            return;
        const [frameId, pending] = oldest;
        const delay = Math.max(1, pending.sentAt + this.ackTimeoutMs - this.now());
        record.ackTimer = setTimeout(() => {
            record.ackTimer = null;
            const current = record.pending.get(frameId);
            if (!current || record.phase === 'closed') {
                this.scheduleAckTimer(record);
                return;
            }
            if (current.kind === 'attach' || current.kind === 'resync-control') {
                const reason = current.kind === 'attach'
                    ? 'attach-ack-timeout'
                    : 'resync-ack-timeout';
                try {
                    record.onClose?.(reason);
                }
                finally {
                    this.detach(record.connectionId);
                }
                return;
            }
            this.requireResync(record, 'ack-timeout');
        }, delay);
    }
    ack(connectionId, syncGeneration, frameId, principal) {
        const record = this.authorizedConnection(connectionId, principal);
        if (record.syncGeneration !== syncGeneration)
            return false;
        const through = frameNumber(frameId, syncGeneration);
        if (through === null)
            return false;
        if (through <= record.lastAckedFrameNumber)
            return true;
        if (!record.pending.has(frameId))
            return false;
        let attachApplied = false;
        for (const [pendingId, pending] of record.pending) {
            const ordinal = frameNumber(pendingId, syncGeneration);
            if (ordinal === null || ordinal > through)
                continue;
            record.pending.delete(pendingId);
            record.pendingBytes = Math.max(0, record.pendingBytes - pending.bytes);
            if (pending.unsafe)
                record.pendingUnsafe = Math.max(0, record.pendingUnsafe - 1);
            if (pendingId === record.attachFrameId)
                attachApplied = true;
        }
        record.lastAckedFrameNumber = through;
        this.scheduleAckTimer(record);
        if (attachApplied && record.phase === 'awaiting-attach-ack') {
            if (record.resyncAfterAttachAck) {
                const reason = record.deferredResyncReason ?? 'byte-window-exceeded';
                record.resyncAfterAttachAck = false;
                record.deferredResyncReason = null;
                this.requireResync(record, reason, record.resyncUnsafe);
                return true;
            }
            record.phase = 'live';
            const buffered = record.buffered.sort((a, b) => a.cursor.streamSeq - b.cursor.streamSeq);
            record.buffered = [];
            record.bufferedBytes = 0;
            for (const fragment of buffered)
                this.receiveOutput(record, fragment);
            if (record.phase === 'live' && record.pendingExit) {
                const exit = record.pendingExit;
                record.pendingExit = undefined;
                this.emitFrame(record, { type: 'exit', ...exit });
            }
            this.note(record, 'live-ready');
        }
        return true;
    }
    requireResync(record, reason, currentUnsafe = false, notifyClient = true) {
        if (record.phase === 'closed' || record.phase === 'resync-required')
            return;
        const unsafe = record.pendingUnsafe > 0 || currentUnsafe;
        if (record.phase === 'attaching') {
            // Invalidating an in-flight snapshot cut would clear the reconciliation
            // buffer and silently truncate the attach supplement. Defer instead: the
            // completed attach ACK converts straight into this resync.
            record.resyncAfterAttachAck = true;
            record.deferredResyncReason ??= reason;
            record.resyncUnsafe = record.resyncUnsafe || unsafe;
            this.note(record, 'resync-deferred', { reason });
            return;
        }
        this.clearPending(record);
        // Sticky by design: an already-omitted query can never be laundered back
        // into a raw-recoverable state by a later, safer resync cause.
        record.resyncUnsafe = record.resyncUnsafe || unsafe;
        record.syncGeneration += 1;
        record.nextFrameNumber = 1;
        record.lastAckedFrameNumber = 0;
        record.buffered = [];
        record.bufferedBytes = 0;
        record.phase = 'resync-required';
        const eventReason = record.resyncUnsafe ? 'checkpoint-unavailable' : reason;
        const frame = {
            connectionId: record.connectionId,
            syncGeneration: record.syncGeneration,
            frameId: this.nextFrameId(record),
            event: { type: 'resync-required', reason: eventReason, latestStreamSeq: record.latestStreamSeq },
        };
        // A hidden client is deliberately not given a control frame/deadline: it
        // may be suspended for hours. Foreground visibility returns the state and
        // starts the one explicit replacement attach. Other resync causes notify
        // immediately and use the normal second ACK deadline.
        if (notifyClient && record.visible) {
            this.reservePending(record, frame.frameId, frameBytes(frame), false, 'resync-control');
            try {
                record.onFrame?.(frame);
            }
            catch {
                try {
                    record.onClose?.('transport-error');
                }
                finally {
                    this.detach(record.connectionId);
                }
            }
        }
        this.note(record, 'resync-required', { reason: eventReason });
    }
    async resync(connectionId, principal) {
        const record = this.authorizedConnection(connectionId, principal);
        if (record.phase !== 'resync-required') {
            throw new connectionProtocol_1.TerminalConnectionError('stale-frame', 'The connection does not require resynchronization');
        }
        if (record.resyncUnsafe) {
            throw new connectionProtocol_1.TerminalConnectionError('checkpoint-unavailable', 'A client-processing fragment cannot be replaced by raw replay');
        }
        this.clearPending(record);
        record.buffered = [];
        record.bufferedBytes = 0;
        record.bufferedOverflow = false;
        record.resyncAfterAttachAck = false;
        record.deferredResyncReason = null;
        record.pendingExit = undefined;
        record.phase = 'attaching';
        let result;
        try {
            const snapshot = await this.captureStableSnapshot(record);
            this.assertConnectionOpen(record);
            if (!(0, connectionProtocol_1.sameTerminalOwner)(record.identity, snapshot.session.identity)) {
                throw new connectionProtocol_1.TerminalConnectionError('owner-changed', 'The terminal owner changed during resync');
            }
            if (record.bufferedOverflow) {
                throw new connectionProtocol_1.TerminalConnectionError('supplement-too-large', 'Output produced during resync exceeded the bounded reconciliation window');
            }
            result = this.buildAttachResult(record, snapshot, false);
        }
        catch (error) {
            // A failed recovery must leave the connection recoverable — never wedged
            // in 'attaching', where every retry misreads as stale-frame.
            if (record.phase === 'attaching')
                record.phase = 'resync-required';
            throw error;
        }
        record.phase = 'awaiting-attach-ack';
        this.reserveAttachFrame(record, result);
        return result;
    }
    requestResync(connectionId, principal, reason = 'client-requested') {
        this.requireResync(this.authorizedConnection(connectionId, principal), reason);
    }
    /** Render health is intentionally independent from input/resize authority.
     * A backgrounded phone keeps its connection and lease, but after a short
     * grace its abandoned deltas are discarded and the next foreground must
     * recover from one fresh raw cut. */
    setVisibility(connectionId, visible, principal) {
        const record = this.authorizedConnection(connectionId, principal);
        record.visible = visible;
        if (record.backgroundTimer)
            clearTimeout(record.backgroundTimer);
        record.backgroundTimer = null;
        if (!visible && record.phase !== 'closed') {
            record.backgroundTimer = setTimeout(() => {
                record.backgroundTimer = null;
                if (record.visible || record.phase === 'closed' || record.phase === 'resync-required')
                    return;
                const awaitingAttach = record.phase === 'attaching' || record.phase === 'awaiting-attach-ack';
                this.requireResync(record, 'client-backgrounded', false, false);
                this.note(record, 'background-grace-expired', { awaitingAttach });
            }, this.backgroundGraceMs);
        }
        // Report only an actionable state. While the replacement attach is still
        // un-ACKed, resync() would throw stale-frame; the deferred resync reaches
        // the client through the attach-ACK conversion instead.
        return { resyncRequired: record.phase === 'resync-required' };
    }
    detach(connectionId, principal) {
        const record = this.connections.get(connectionId);
        if (!record)
            return;
        if (principal && !this.samePrincipal(record.principal, principal)) {
            throw new connectionProtocol_1.TerminalConnectionError('forbidden', 'Connection owner mismatch');
        }
        record.phase = 'closed';
        record.unsubscribeOutput();
        record.unsubscribeExit();
        if (record.backgroundTimer)
            clearTimeout(record.backgroundTimer);
        record.backgroundTimer = null;
        this.clearPending(record);
        record.buffered = [];
        record.bufferedBytes = 0;
        record.pendingExit = undefined;
        this.connections.delete(connectionId);
        if (this.attachCache.get(record.cacheKey)?.connectionId === connectionId) {
            this.attachCache.delete(record.cacheKey);
        }
        this.note(record, 'detached');
    }
    detachSubject(origin, subjectId) {
        for (const record of [...this.connections.values()]) {
            if (record.principal.origin === origin && record.principal.subjectId === subjectId) {
                this.detach(record.connectionId);
            }
        }
    }
    getDiagnostics(connectionId) {
        return this.diagnosticsLog.filter((row) => !connectionId || row.connectionId === connectionId);
    }
    assertConnectionOpen(record) {
        // A detach that lands between the awaits of an attach/resync must fail the
        // request; continuing would resurrect a destroyed record and arm an ACK
        // deadline no adapter is listening to.
        if (record.phase === 'closed') {
            throw new connectionProtocol_1.TerminalConnectionError('connection-not-found', 'The connection was detached during attach');
        }
    }
    /** The desktop attach buffer legally re-feeds through emitFrame after the
     * attach ACK; its window must fit that bounded re-feed plus the normal live
     * window, or a large hydration forces a pointless second attach. */
    pendingByteCap(record) {
        return record.principal.origin === 'desktop'
            ? this.maxPendingBytes + DESKTOP_BUFFERED_OUTPUT_BYTES
            : this.maxPendingBytes;
    }
    clearPending(record) {
        if (record.ackTimer)
            clearTimeout(record.ackTimer);
        record.ackTimer = null;
        record.pending.clear();
        record.pendingBytes = 0;
        record.pendingUnsafe = 0;
    }
    authorizedConnection(connectionId, principal) {
        const record = this.connections.get(connectionId);
        if (!record)
            throw new connectionProtocol_1.TerminalConnectionError('connection-not-found', 'Terminal connection was not found');
        if (!this.samePrincipal(record.principal, principal)) {
            throw new connectionProtocol_1.TerminalConnectionError('forbidden', 'Connection owner mismatch');
        }
        return record;
    }
    samePrincipal(left, right) {
        return left.origin === right.origin && left.subjectId === right.subjectId &&
            left.owningDeviceId === right.owningDeviceId;
    }
    assertRead(principal) {
        if (!principal.subjectId || !principal.permissions.has('read')) {
            throw new connectionProtocol_1.TerminalConnectionError('forbidden', 'Terminal read permission is required');
        }
    }
    note(record, event, detail) {
        const row = {
            at: this.now(),
            connectionId: record.connectionId,
            terminalId: record.terminalId,
            event,
            detail,
        };
        // Track a running byte total; re-stringifying the whole log per event put
        // an O(log size) JSON walk on the output hot path.
        const rowBytes = byteLength(JSON.stringify(row));
        this.diagnosticsLog.push(row);
        this.diagnosticsSizes.push(rowBytes);
        this.diagnosticsBytes += rowBytes;
        while (this.diagnosticsLog.length > MAX_DIAGNOSTICS || this.diagnosticsBytes > MAX_DIAGNOSTIC_BYTES) {
            this.diagnosticsLog.shift();
            this.diagnosticsBytes -= this.diagnosticsSizes.shift() ?? 0;
        }
    }
}
exports.TerminalConnectionService = TerminalConnectionService;
function requestCapabilities(record) {
    return record.request.capabilities.length > 0
        ? record.request.capabilities
        : ['raw-output-v1'];
}
