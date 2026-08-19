"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmbeddedPtyBackend = void 0;
const node_crypto_1 = require("node:crypto");
const connectionProtocol_1 = require("../../shared/terminal/connectionProtocol");
const MAX_EMBEDDED_FENCES = 256;
const EMBEDDED_FENCE_TTL_MS = 30_000;
class EmbeddedPtyBackend {
    engineEpoch = `embedded-${(0, node_crypto_1.randomUUID)()}`;
    v2States = new Map();
    profiles = new Map();
    fences = new Map();
    /**
     * Exposed for the call sites that need synchronous semantics (quit-path
     * buffer save + teardown). Never touch from generic backend consumers.
     */
    manager;
    constructor(manager) {
        this.manager = manager;
    }
    v2State(terminalId) {
        let state = this.v2States.get(terminalId);
        if (!state) {
            state = {
                streamSeq: 0,
                sessionVersion: 0,
                screenVersion: 0,
                splitter: new connectionProtocol_1.TerminalV2AnsiSplitter(),
                output: new Set(),
                exit: new Set(),
            };
            this.v2States.set(terminalId, state);
        }
        return state;
    }
    profileFor(spec) {
        const platform = process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux'
            ? process.platform
            : 'other';
        const outputMode = spec.preserveOpenTuiReplayModes
            ? 'native-tui-agent'
            : spec.effectiveAgentKind
                ? 'transcript-agent'
                : 'plain';
        return {
            effectiveAgentKind: spec.effectiveAgentKind,
            revision: 1,
            policyVersion: 1,
            platform,
            tmuxMouseBehavior: spec.tmuxMouseBehavior,
            outputMode,
            altBufferPolicy: outputMode === 'transcript-agent' ? 'block-47-1047-1049' : 'preserve',
            clearPolicy: outputMode === 'transcript-agent' ? 'hard-clear-with-history' : 'native',
            mouseTrackingPolicy: outputMode === 'transcript-agent' ? 'strip-on-replay' : 'preserve',
        };
    }
    emitV2(terminalId, data, bufferSeq) {
        const generation = this.manager.getSessionGeneration(terminalId);
        if (generation === null)
            return;
        const state = this.v2State(terminalId);
        for (const classified of state.splitter.feed(data, bufferSeq)) {
            const fragment = {
                cursor: {
                    engineEpoch: this.engineEpoch,
                    terminalGeneration: generation,
                    streamSeq: ++state.streamSeq,
                    ...(classified.bufferSeq === undefined ? {} : { bufferSeq: classified.bufferSeq }),
                },
                delivery: classified.delivery,
                data: classified.data,
            };
            for (const listener of state.output)
                listener(fragment);
        }
        state.screenVersion += 1;
    }
    async create(spec, onData, onExit) {
        const state = this.v2State(spec.terminalId);
        if (!this.manager.hasLiveInstance(spec.terminalId)) {
            state.streamSeq = 0;
            state.sessionVersion = 1;
            state.screenVersion = 0;
            state.splitter = new connectionProtocol_1.TerminalV2AnsiSplitter();
            this.profiles.set(spec.terminalId, this.profileFor(spec));
        }
        const outcome = this.manager.createFromSpec(spec, (data, seq) => {
            this.emitV2(spec.terminalId, data, seq);
            onData?.(data, seq);
        }, (code) => {
            const identity = this.getOwnerIdentity(spec.terminalId);
            state.sessionVersion += 1;
            if (identity) {
                for (const listener of state.exit)
                    listener({ identity, sessionVersion: state.sessionVersion, code });
            }
            onExit?.(code);
        });
        return outcome;
    }
    async kill(terminalId) {
        this.manager.kill(terminalId);
    }
    async detach(terminalId) {
        this.manager.detach(terminalId);
    }
    async killAll() {
        this.manager.killAll();
    }
    async detachAll() {
        this.manager.detachAll();
    }
    write(terminalId, data) {
        this.manager.write(terminalId, data);
        if (/\r|\n/.test(data))
            this.v2State(terminalId).sessionVersion += 1;
    }
    resize(terminalId, cols, rows) {
        this.manager.resize(terminalId, cols, rows);
        const state = this.v2State(terminalId);
        state.sessionVersion += 1;
        state.screenVersion += 1;
    }
    flush(terminalId) {
        return this.manager.flushWrites(terminalId);
    }
    async writeFenced(part) {
        const now = Date.now();
        for (const [fenceId, candidate] of this.fences) {
            if (candidate.expiresAt <= now)
                this.fences.delete(fenceId);
        }
        while (this.fences.size >= MAX_EMBEDDED_FENCES) {
            const oldest = this.fences.keys().next().value;
            if (!oldest)
                break;
            this.fences.delete(oldest);
        }
        let state = this.fences.get(part.fenceId);
        if (state && state.terminalId !== part.terminalId) {
            return this.emptyFenceResult('owner-changed', 'fence-terminal-mismatch');
        }
        if (state && !(0, connectionProtocol_1.sameTerminalOwner)(state.owner, part.expectedOwner)) {
            return this.emptyFenceResult('owner-changed', 'fence-owner-mismatch');
        }
        if (!(0, connectionProtocol_1.sameTerminalOwner)(this.getOwnerIdentity(part.terminalId), part.expectedOwner)) {
            if (!state?.completedParts)
                return this.emptyFenceResult('owner-changed', 'owner-mismatch');
            return this.fenceResult(state, 'owner-lost-uncertain', 'owner-mismatch', part);
        }
        if (!state) {
            if (part.partNumber !== 1)
                return this.emptyFenceResult('owner-changed', 'first-part-must-be-one');
            state = {
                terminalId: part.terminalId,
                owner: part.expectedOwner,
                attemptedParts: 0,
                completedParts: 0,
                bytesAttempted: 0,
                bytesCompleted: 0,
                chunksAttempted: 0,
                chunksCompleted: 0,
                enterAttempted: false,
                enterPipeCompleted: false,
                lastPartNumber: 0,
                expiresAt: now + EMBEDDED_FENCE_TTL_MS,
                finalized: false,
                results: new Map(),
            };
            this.fences.set(part.fenceId, state);
        }
        const duplicate = state.results.get(part.partNumber);
        if (duplicate)
            return duplicate;
        if (state.finalized)
            return this.fenceResult(state, 'transport-uncertain', 'fence-finalized', part);
        if (part.partNumber !== state.lastPartNumber + 1) {
            return this.fenceResult(state, 'transport-uncertain', 'non-contiguous-part', part);
        }
        const write = await this.manager.writeWithCompletion(part.terminalId, part.data, {
            expectedGeneration: part.expectedOwner.terminalGeneration,
            fenceId: part.fenceId,
            partNumber: part.partNumber,
            partKind: part.kind,
        });
        state.lastPartNumber = part.partNumber;
        state.attemptedParts = Math.max(state.attemptedParts, part.partNumber);
        state.bytesAttempted += write.bytesAttempted;
        state.bytesCompleted += write.bytesCompleted;
        state.chunksAttempted += write.chunksAttempted;
        state.chunksCompleted += write.chunksCompleted;
        state.enterAttempted ||= write.enterAttempted;
        state.enterPipeCompleted ||= write.enterPipeCompleted;
        if (write.status === 'pipe-completed')
            state.completedParts += 1;
        state.expiresAt = Date.now() + EMBEDDED_FENCE_TTL_MS;
        const status = write.status === 'owner-changed' && state.completedParts > 0
            ? 'owner-lost-uncertain'
            : write.status;
        const result = this.fenceResult(state, status, write.reason, part, write.logicalWriteId);
        state.results.set(part.partNumber, result);
        return result;
    }
    async flushFenced(part) {
        const state = this.fences.get(part.fenceId);
        if (!state)
            return this.emptyFenceResult('owner-changed', 'fence-not-found');
        if (state.terminalId !== part.terminalId) {
            return this.emptyFenceResult('owner-changed', 'fence-terminal-mismatch');
        }
        if (!(0, connectionProtocol_1.sameTerminalOwner)(state.owner, part.expectedOwner)) {
            return this.emptyFenceResult('owner-changed', 'fence-owner-mismatch');
        }
        // writeFenced awaits the exact logical request. A terminal-wide queue
        // drain here could accidentally wait for later raw input and cannot prove
        // anything more about this fence.
        const lastResult = state.results.get(state.lastPartNumber)
            ?? this.fenceResult(state, 'transport-uncertain', 'fence-has-no-completed-part', part);
        let result = lastResult;
        if (!(0, connectionProtocol_1.sameTerminalOwner)(this.getOwnerIdentity(part.terminalId), part.expectedOwner)) {
            result = state.completedParts > 0 || state.bytesAttempted > 0
                ? this.fenceResult(state, 'owner-lost-uncertain', 'owner-mismatch-after-barrier', part)
                : this.fenceResult(state, 'owner-changed', 'owner-mismatch-after-barrier', part);
        }
        if (part.finalize !== false) {
            state.finalized = true;
            state.expiresAt = Date.now() + EMBEDDED_FENCE_TTL_MS;
        }
        return result;
    }
    emptyFenceResult(status, reason) {
        return {
            status,
            attemptedParts: 0,
            completedParts: 0,
            bytesAttempted: 0,
            bytesCompleted: 0,
            chunksAttempted: 0,
            chunksCompleted: 0,
            enterAttempted: false,
            enterPipeCompleted: false,
            reason,
        };
    }
    fenceResult(state, status, reason, attemptedPart, logicalWriteId) {
        return {
            status,
            attemptedParts: Math.max(state.attemptedParts, attemptedPart?.partNumber ?? 0),
            completedParts: state.completedParts,
            bytesAttempted: state.bytesAttempted,
            bytesCompleted: state.bytesCompleted,
            chunksAttempted: state.chunksAttempted,
            chunksCompleted: state.chunksCompleted,
            // A caller presenting an Enter part is not proof that the queue reached
            // node-pty. Only writeWithCompletion() may set this transport metric.
            enterAttempted: state.enterAttempted,
            enterPipeCompleted: state.enterPipeCompleted,
            ...(logicalWriteId ? { logicalWriteId } : {}),
            ...(reason ? { reason } : {}),
        };
    }
    hasLiveInstance(terminalId) {
        return this.manager.hasLiveInstance(terminalId);
    }
    usesTmux(terminalId) {
        return this.manager.usesTmux(terminalId);
    }
    getSize(terminalId) {
        return this.manager.getSize(terminalId);
    }
    getSpawnTime(terminalId) {
        return this.manager.getSpawnTime(terminalId);
    }
    getLastSubmitTime(terminalId) {
        return this.manager.getLastSubmitTime(terminalId);
    }
    getSubmittedPrompts(terminalId) {
        return this.manager.getSubmittedPrompts(terminalId);
    }
    getSessionGeneration(terminalId) {
        return this.manager.getSessionGeneration(terminalId);
    }
    getOwnerIdentity(terminalId) {
        const terminalGeneration = this.manager.getSessionGeneration(terminalId);
        return terminalGeneration === null || !this.manager.hasLiveInstance(terminalId)
            ? null
            : { engineEpoch: this.engineEpoch, terminalGeneration };
    }
    isIdle(terminalId, thresholdMs) {
        return this.manager.isIdle(terminalId, thresholdMs);
    }
    getAllStatuses() {
        return this.manager.getAllStatuses();
    }
    markRunEnded(terminalId, endedAt) {
        return this.manager.markRunEnded(terminalId, endedAt);
    }
    findTerminalByProcessAncestor(pid) {
        return this.manager.findTerminalByProcessAncestor(pid);
    }
    getAttributionRoots() {
        return this.manager.getAttributionRoots();
    }
    onAttributionRootsChanged(callback) {
        return this.manager.onAttributionRootsChanged(callback);
    }
    setDesktopAttachmentCount(terminalId, count) {
        this.manager.setDesktopAttachmentCount(terminalId, count);
    }
    hasDesktopAttachment(terminalId) {
        return this.manager.hasDesktopAttachment(terminalId);
    }
    recordDesktopSize(terminalId, cols, rows) {
        this.manager.recordDesktopSize(terminalId, cols, rows);
    }
    getDesktopSize(terminalId) {
        return this.manager.getDesktopSize(terminalId);
    }
    async getBuffer(terminalId) {
        return this.manager.getBuffer(terminalId);
    }
    async getBufferSnapshot(terminalId) {
        // Embedded epoch is 0 for the app-process lifetime: the seq counter lives
        // and dies with this process, exactly like today (§5.3).
        return { ...this.manager.getBufferSnapshot(terminalId), epoch: 0 };
    }
    async getAttachSnapshotV2(terminalId) {
        const identity = this.getOwnerIdentity(terminalId);
        if (!identity)
            throw new Error('terminal is not live');
        const raw = this.manager.getBufferSnapshot(terminalId);
        const state = this.v2State(terminalId);
        const status = this.manager.getAllStatuses()[terminalId];
        return {
            session: {
                terminalId,
                identity,
                sessionVersion: state.sessionVersion,
                displayProfile: this.profiles.get(terminalId) ?? {
                    revision: 1,
                    policyVersion: 1,
                    platform: process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux'
                        ? process.platform
                        : 'other',
                    tmuxMouseBehavior: 'native-selection',
                    outputMode: 'plain',
                    altBufferPolicy: 'preserve',
                    clearPolicy: 'native',
                    mouseTrackingPolicy: 'preserve',
                },
                liveInstance: true,
                running: status?.isAlive ?? true,
                useTmux: this.manager.usesTmux(terminalId),
                rootPid: this.manager.getRootPid(terminalId),
                size: this.manager.getSize(terminalId),
                desktopSize: this.manager.getDesktopSize(terminalId),
                status,
            },
            content: raw.content,
            bufferSeq: raw.seq,
            snapshotCutStreamSeq: state.streamSeq,
            screenVersion: state.screenVersion,
        };
    }
    async getBufferPreview(terminalId, maxChars, agentType) {
        return this.manager.getBufferPreview(terminalId, maxChars, agentType);
    }
    async getAllBuffers() {
        return this.manager.getAllBuffers();
    }
    async clearBuffer(terminalId) {
        this.manager.clearBuffer(terminalId);
        this.v2State(terminalId).screenVersion += 1;
    }
    async clearAllBuffers() {
        return this.manager.clearAllBuffers();
    }
    async startCapture(terminalId) {
        this.manager.startCapture(terminalId);
    }
    async stopCapture(terminalId) {
        return this.manager.stopCapture(terminalId);
    }
    async hasTmuxSession(terminalId) {
        return this.manager.hasTmuxSession(terminalId);
    }
    async killTmuxSession(terminalId) {
        this.manager.killTmuxSession(terminalId);
    }
    async listTmuxSessions() {
        return this.manager.listTmuxSessions();
    }
    onOutput(terminalId, callback) {
        return this.manager.onOutput(terminalId, callback);
    }
    onV2Output(terminalId, callback) {
        const state = this.v2State(terminalId);
        state.output.add(callback);
        return () => state.output.delete(callback);
    }
    onV2Exit(terminalId, callback) {
        const state = this.v2State(terminalId);
        state.exit.add(callback);
        return () => state.exit.delete(callback);
    }
    onResize(terminalId, callback) {
        return this.manager.onResize(terminalId, callback);
    }
    onCommandCompletion(callback) {
        this.manager.onCommandCompletion(callback);
    }
    onTerminalOutputIdle(callback) {
        this.manager.onTerminalOutputIdle(callback);
    }
}
exports.EmbeddedPtyBackend = EmbeddedPtyBackend;
