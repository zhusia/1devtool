"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const types_1 = require("../../shared/types");
const terminalPreview_1 = require("../../shared/terminal/terminalPreview");
const connectionProtocol_1 = require("../../shared/terminal/connectionProtocol");
const headless_1 = require("@xterm/headless");
const node_crypto_1 = require("node:crypto");
const processStreamErrors_1 = require("../processStreamErrors");
const pty_1 = require("../pty");
const types_2 = require("../pty-backend/types");
// `stdio: 'inherit'` gives this child its own pipe-backed stream objects. The
// guards installed by main do not cross the utility-process boundary, and a
// late ConPTY/teardown diagnostic can otherwise become an uncaught EPIPE.
(0, processStreamErrors_1.installProcessStreamErrorGuards)();
(0, processStreamErrors_1.installExpectedClosedPipeExceptionGuard)();
const OUTPUT_FLUSH_MS = 16;
const OUTPUT_BATCH_TARGET_BYTES = 64 * 1024;
const OUTPUT_HIGH_WATER_BYTES = 512 * 1024;
const OUTPUT_LOW_WATER_BYTES = 128 * 1024;
// Enough to walk past a chrome-heavy native-TUI viewport without turning a
// dashboard preview poll into a scan of all 5,000 headless scrollback rows.
const HEADLESS_PREVIEW_MAX_ROWS = 256;
const hostPort = process.parentPort;
const engineEpoch = (0, node_crypto_1.randomUUID)();
const compatibility = {
    protocolVersion: connectionProtocol_1.TERMINAL_CONNECTION_PROTOCOL_VERSION,
    capabilities: [...connectionProtocol_1.RAW_V2_CAPABILITIES],
    vtImplementation: '@xterm/headless',
    vtVersion: '5.5',
    unicodeVersion: 'xterm-default',
    checkpointCodecVersion: null,
};
let manager = null;
let nextBatchId = 1;
const sessions = new Map();
const pendingOutput = new Map();
const unackedBatches = new Map();
const unackedBytes = new Map();
const pausedTerminals = new Set();
const headlessTerminals = new Map();
const outputSplitters = new Map();
const pendingV2Bootstrap = new Map();
const fences = new Map();
const MAX_FENCES = 256;
const FENCE_TTL_MS = 30_000;
function post(message) {
    hostPort.postMessage(message);
}
function requireManager() {
    if (!manager)
        throw new Error('PTY host has not been initialized');
    return manager;
}
function displayProfileFor(wire) {
    const platform = process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux'
        ? process.platform
        : 'other';
    const outputMode = wire.preserveOpenTuiReplayModes
        ? 'native-tui-agent'
        : wire.effectiveAgentKind
            ? 'transcript-agent'
            : 'plain';
    return {
        effectiveAgentKind: wire.effectiveAgentKind,
        revision: 1,
        policyVersion: 1,
        platform,
        tmuxMouseBehavior: wire.tmuxMouseBehavior,
        outputMode,
        altBufferPolicy: outputMode === 'transcript-agent' ? 'block-47-1047-1049' : 'preserve',
        clearPolicy: wire.useTmux && wire.tmuxMouseBehavior === 'native-selection'
            ? 'tmux-native-selection'
            : outputMode === 'transcript-agent'
                ? 'hard-clear-with-history'
                : 'native',
        mouseTrackingPolicy: outputMode === 'transcript-agent' && wire.tmuxMouseBehavior === 'native-selection'
            ? 'strip-on-replay'
            : 'preserve',
    };
}
function snapshot(terminalId, forceRunning) {
    const active = requireManager();
    const status = active.getAllStatuses()[terminalId];
    const liveInstance = active.hasLiveInstance(terminalId);
    const meta = sessions.get(terminalId);
    const terminalGeneration = active.getSessionGeneration(terminalId);
    const screenVersion = headlessTerminals.get(terminalId)?.screenVersion ?? 0;
    return {
        terminalId,
        liveInstance,
        running: forceRunning ?? Boolean(status?.isAlive || liveInstance),
        useTmux: meta?.useTmux ?? active.usesTmux(terminalId),
        rootPid: active.getRootPid(terminalId),
        spawnTime: active.getSpawnTime(terminalId),
        lastSubmitTime: active.getLastSubmitTime(terminalId),
        status,
        size: active.getSize(terminalId),
        desktopSize: active.getDesktopSize(terminalId),
        sessionGeneration: active.getSessionGeneration(terminalId),
        identity: liveInstance && terminalGeneration !== null
            ? { engineEpoch, terminalGeneration }
            : null,
        sessionVersion: meta?.sessionVersion ?? 0,
        screenVersion,
        streamSeq: meta?.streamSeq ?? 0,
    };
}
function noteUnacked(terminalId, batchId, bytes) {
    let batches = unackedBatches.get(terminalId);
    if (!batches) {
        batches = new Map();
        unackedBatches.set(terminalId, batches);
    }
    batches.set(batchId, {
        bytes,
        headlessBarrier: headlessTerminals.get(terminalId)?.writeChain.catch(() => { }) ?? Promise.resolve(),
        acknowledged: false,
    });
    const total = (unackedBytes.get(terminalId) ?? 0) + bytes;
    unackedBytes.set(terminalId, total);
    if (total >= OUTPUT_HIGH_WATER_BYTES && !pausedTerminals.has(terminalId)) {
        pausedTerminals.add(terminalId);
        requireManager().pauseOutput(terminalId);
    }
}
function releaseAcknowledgedOutput(terminalId, batchId) {
    const batches = unackedBatches.get(terminalId);
    const batch = batches?.get(batchId);
    if (!batch?.acknowledged)
        return;
    batches.delete(batchId);
    if (batches.size === 0)
        unackedBatches.delete(terminalId);
    const remaining = Math.max(0, (unackedBytes.get(terminalId) ?? 0) - batch.bytes);
    if (remaining === 0)
        unackedBytes.delete(terminalId);
    else
        unackedBytes.set(terminalId, remaining);
    if (remaining <= OUTPUT_LOW_WATER_BYTES && pausedTerminals.delete(terminalId)) {
        requireManager().resumeOutput(terminalId);
    }
}
function acknowledgeOutput(terminalId, batchId) {
    const batch = unackedBatches.get(terminalId)?.get(batchId);
    if (!batch || batch.acknowledged)
        return;
    batch.acknowledged = true;
    void batch.headlessBarrier.finally(() => releaseAcknowledgedOutput(terminalId, batchId));
}
function sendBatch(terminalId, chunks, v2Fragments, bytes) {
    if (chunks.length === 0)
        return;
    const batchId = nextBatchId++;
    noteUnacked(terminalId, batchId, bytes);
    post({
        t: 'output-batch',
        engineEpoch,
        terminalId,
        batchId,
        chunks,
        bytes,
        snapshot: snapshot(terminalId),
        v2Fragments,
    });
}
function flushOutput(terminalId) {
    const pending = pendingOutput.get(terminalId);
    if (!pending)
        return;
    if (pending.timer)
        clearTimeout(pending.timer);
    pendingOutput.delete(terminalId);
    let chunks = [];
    let v2Fragments = [];
    let bytes = 0;
    for (const item of pending.items) {
        const chunk = item.chunk;
        const chunkBytes = Buffer.byteLength(chunk.data);
        if (chunks.length > 0 && bytes + chunkBytes > OUTPUT_BATCH_TARGET_BYTES) {
            sendBatch(terminalId, chunks, v2Fragments, bytes);
            chunks = [];
            v2Fragments = [];
            bytes = 0;
        }
        chunks.push(chunk);
        v2Fragments.push(...item.fragments);
        bytes += chunkBytes;
    }
    sendBatch(terminalId, chunks, v2Fragments, bytes);
}
function enqueueOutput(terminalId, data, seq) {
    const meta = sessions.get(terminalId);
    const splitter = outputSplitters.get(terminalId);
    if (!meta && splitter) {
        let bootstrap = pendingV2Bootstrap.get(terminalId);
        if (!bootstrap) {
            bootstrap = [];
            pendingV2Bootstrap.set(terminalId, bootstrap);
        }
        bootstrap.push(seq === undefined ? { data } : { data, seq });
    }
    const fragments = meta && splitter
        ? splitter.feed(data, seq).map((fragment) => ({
            cursor: {
                engineEpoch,
                terminalGeneration: meta.terminalGeneration,
                streamSeq: ++meta.streamSeq,
                ...(fragment.bufferSeq === undefined ? {} : { bufferSeq: fragment.bufferSeq }),
            },
            delivery: fragment.delivery,
            data: fragment.data,
        }))
        : [];
    const headless = headlessTerminals.get(terminalId);
    if (headless) {
        const nextWrite = headless.writeChain.catch(() => { }).then(() => new Promise((resolve) => {
            headless.terminal.write(data, () => {
                headless.screenVersion += 1;
                resolve();
            });
        }));
        headless.writeChain = nextWrite;
    }
    let pending = pendingOutput.get(terminalId);
    if (!pending) {
        pending = { items: [], bytes: 0, timer: null };
        pendingOutput.set(terminalId, pending);
    }
    pending.items.push({
        chunk: seq === undefined ? { data } : { data, seq },
        fragments,
    });
    pending.bytes += Buffer.byteLength(data);
    if (pending.bytes >= OUTPUT_BATCH_TARGET_BYTES) {
        flushOutput(terminalId);
        return;
    }
    if (!pending.timer) {
        pending.timer = setTimeout(() => flushOutput(terminalId), OUTPUT_FLUSH_MS);
    }
}
function createHeadlessTerminal(terminalId) {
    const existing = headlessTerminals.get(terminalId);
    if (existing)
        return existing;
    const state = {
        terminal: new headless_1.Terminal({
            allowProposedApi: true,
            cols: 80,
            rows: 24,
            scrollback: types_1.TERMINAL_SCROLLBACK_MAX_LINES,
        }),
        writeChain: Promise.resolve(),
        screenVersion: 0,
    };
    headlessTerminals.set(terminalId, state);
    return state;
}
function disposeHeadlessTerminal(terminalId) {
    const state = headlessTerminals.get(terminalId);
    if (!state)
        return;
    state.terminal.dispose();
    headlessTerminals.delete(terminalId);
    outputSplitters.delete(terminalId);
    pendingV2Bootstrap.delete(terminalId);
}
async function getHeadlessPreview(terminalId, maxChars, agentType) {
    const state = headlessTerminals.get(terminalId);
    if (!state)
        return null;
    await state.writeChain.catch(() => { });
    const buffer = state.terminal.buffer.active;
    const lines = [];
    const start = Math.max(0, buffer.length - HEADLESS_PREVIEW_MAX_ROWS);
    for (let index = start; index < buffer.length; index++) {
        lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
    }
    return (0, terminalPreview_1.buildTerminalPreviewFromLines)(lines, maxChars, agentType);
}
function fromWire(wire) {
    return {
        terminalId: wire.terminalId,
        cwd: wire.cwd,
        candidates: [{
                executable: wire.candidate.executable,
                args: wire.candidate.args,
                resolveEnv: () => wire.candidate.env,
            }],
        useTmux: wire.useTmux,
        tmux: wire.tmux,
        tmuxMouseBehavior: wire.tmuxMouseBehavior,
        startupWrite: wire.startupWrite,
        preserveOpenTuiReplayModes: wire.preserveOpenTuiReplayModes,
        effectiveAgentKind: wire.effectiveAgentKind,
        agentType: wire.agentType,
    };
}
function terminalIdFrom(request) {
    const terminalId = request.params?.terminalId;
    if (typeof terminalId !== 'string' || terminalId.length === 0) {
        throw new Error('terminalId is required');
    }
    return terminalId;
}
function currentOwner(terminalId) {
    const generation = requireManager().getSessionGeneration(terminalId);
    return generation === null || !requireManager().hasLiveInstance(terminalId)
        ? null
        : { engineEpoch, terminalGeneration: generation };
}
function pruneFences(now = Date.now()) {
    for (const [fenceId, state] of fences) {
        if (state.expiresAt <= now)
            fences.delete(fenceId);
    }
    while (fences.size >= MAX_FENCES) {
        const oldest = fences.keys().next().value;
        if (!oldest)
            break;
        fences.delete(oldest);
    }
}
function fencedResult(state) {
    return {
        status: 'pipe-completed',
        attemptedParts: state.attemptedParts,
        completedParts: state.completedParts,
        bytesAttempted: state.bytesAttempted,
        bytesCompleted: state.bytesCompleted,
        chunksAttempted: state.chunksAttempted,
        chunksCompleted: state.chunksCompleted,
        enterAttempted: state.enterAttempted,
        enterPipeCompleted: state.enterPipeCompleted,
    };
}
function ownerFailure(part, state) {
    if (!state || (state.completedParts === 0 && state.bytesAttempted === 0)) {
        return {
            status: 'owner-changed',
            attemptedParts: 0,
            completedParts: 0,
            bytesAttempted: 0,
            bytesCompleted: 0,
            chunksAttempted: 0,
            chunksCompleted: 0,
            enterAttempted: false,
            enterPipeCompleted: false,
            reason: 'owner-mismatch',
        };
    }
    return {
        status: 'owner-lost-uncertain',
        attemptedParts: Math.max(state.attemptedParts, part.partNumber),
        completedParts: state.completedParts,
        bytesAttempted: state.bytesAttempted,
        bytesCompleted: state.bytesCompleted,
        chunksAttempted: state.chunksAttempted,
        chunksCompleted: state.chunksCompleted,
        enterAttempted: state.enterAttempted,
        enterPipeCompleted: state.enterPipeCompleted,
        reason: 'owner-mismatch',
    };
}
function resultFor(state, status, reason, logicalWriteId) {
    return {
        ...fencedResult(state),
        status,
        ...(reason ? { reason } : {}),
        ...(logicalWriteId ? { logicalWriteId } : {}),
    };
}
async function writeFenced(part) {
    pruneFences();
    let state = fences.get(part.fenceId);
    if (state && state.terminalId !== part.terminalId) {
        throw Object.assign(new Error('fence terminal cannot change'), { code: 'bad-params' });
    }
    if (state && !(0, connectionProtocol_1.sameTerminalOwner)(state.expectedOwner, part.expectedOwner)) {
        throw Object.assign(new Error('fence owner cannot change'), { code: 'bad-params' });
    }
    if (!(0, connectionProtocol_1.sameTerminalOwner)(currentOwner(part.terminalId), part.expectedOwner)) {
        return ownerFailure(part, state);
    }
    if (!state) {
        if (part.partNumber !== 1) {
            throw Object.assign(new Error('first fenced part must be part 1'), { code: 'bad-params' });
        }
        state = {
            terminalId: part.terminalId,
            expectedOwner: part.expectedOwner,
            attemptedParts: 0,
            completedParts: 0,
            bytesAttempted: 0,
            bytesCompleted: 0,
            chunksAttempted: 0,
            chunksCompleted: 0,
            enterAttempted: false,
            enterPipeCompleted: false,
            lastPartNumber: 0,
            expiresAt: Date.now() + FENCE_TTL_MS,
            finalized: false,
            results: new Map(),
        };
        fences.set(part.fenceId, state);
    }
    const duplicate = state.results.get(part.partNumber);
    if (duplicate)
        return duplicate;
    if (state.finalized)
        return resultFor(state, 'transport-uncertain', 'fence-finalized');
    if (part.partNumber !== state.lastPartNumber + 1) {
        return resultFor(state, 'transport-uncertain', 'non-contiguous-part');
    }
    const write = await requireManager().writeWithCompletion(part.terminalId, part.data, {
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
    state.expiresAt = Date.now() + FENCE_TTL_MS;
    const status = write.status === 'owner-changed' && state.completedParts > 0
        ? 'owner-lost-uncertain'
        : write.status;
    const result = resultFor(state, status, write.reason, write.logicalWriteId);
    state.results.set(part.partNumber, result);
    return result;
}
async function flushFenced(part) {
    const state = fences.get(part.fenceId);
    if (!state)
        return ownerFailure(part);
    if (state.terminalId !== part.terminalId) {
        return {
            status: 'owner-changed',
            attemptedParts: 0,
            completedParts: 0,
            bytesAttempted: 0,
            bytesCompleted: 0,
            chunksAttempted: 0,
            chunksCompleted: 0,
            enterAttempted: false,
            enterPipeCompleted: false,
            reason: 'fence-terminal-mismatch',
        };
    }
    if (!(0, connectionProtocol_1.sameTerminalOwner)(state.expectedOwner, part.expectedOwner)) {
        return {
            status: 'owner-changed',
            attemptedParts: 0,
            completedParts: 0,
            bytesAttempted: 0,
            bytesCompleted: 0,
            chunksAttempted: 0,
            chunksCompleted: 0,
            enterAttempted: false,
            enterPipeCompleted: false,
            reason: 'fence-owner-mismatch',
        };
    }
    const stored = state.results.get(state.lastPartNumber)
        ?? resultFor(state, 'transport-uncertain', 'fence-has-no-completed-part');
    const result = (0, connectionProtocol_1.sameTerminalOwner)(currentOwner(part.terminalId), part.expectedOwner)
        ? stored
        : ownerFailure(part, state);
    if (part.finalize !== false) {
        state.finalized = true;
        state.expiresAt = Date.now() + FENCE_TTL_MS;
    }
    return result;
}
async function getAttachSnapshot(terminalId) {
    const active = requireManager();
    if (!active.hasLiveInstance(terminalId)) {
        throw Object.assign(new Error('terminal is not live'), { code: 'bad-params' });
    }
    // Every fragment assigned before this call must be posted before the
    // response. New output chains behind the atomic headless cut below.
    flushOutput(terminalId);
    const headless = headlessTerminals.get(terminalId);
    const meta = sessions.get(terminalId);
    if (!headless || !meta)
        throw new Error('terminal screen state is unavailable');
    let resolveSnapshot;
    let rejectSnapshot;
    const result = new Promise((resolve, reject) => {
        resolveSnapshot = resolve;
        rejectSnapshot = reject;
    });
    const operation = headless.writeChain.catch(() => { }).then(() => {
        try {
            const owner = currentOwner(terminalId);
            if (!owner || owner.terminalGeneration !== meta.terminalGeneration) {
                throw Object.assign(new Error('terminal owner changed during snapshot'), { code: 'stale-engine' });
            }
            const raw = active.getBufferSnapshot(terminalId);
            const current = snapshot(terminalId);
            resolveSnapshot({
                session: {
                    terminalId,
                    identity: owner,
                    sessionVersion: current.sessionVersion,
                    displayProfile: meta.displayProfile,
                    liveInstance: current.liveInstance,
                    running: current.running,
                    useTmux: current.useTmux,
                    rootPid: current.rootPid,
                    size: current.size,
                    desktopSize: current.desktopSize,
                    status: current.status,
                },
                content: raw.content,
                bufferSeq: raw.seq,
                snapshotCutStreamSeq: meta.streamSeq,
                screenVersion: headless.screenVersion,
            });
        }
        catch (error) {
            rejectSnapshot(error);
        }
    });
    headless.writeChain = operation.then(() => undefined, () => undefined);
    return result;
}
async function dispatch(request) {
    const active = requireManager();
    switch (request.method) {
        case 'create': {
            const wire = request.params?.spec;
            if (!wire?.terminalId || !wire.candidate?.executable)
                throw new Error('invalid spawn spec');
            if (wire.useTmux && wire.tmux) {
                active.setTmuxRuntime(new types_2.StaticTmuxRuntime(true, wire.tmux.path, wire.tmux.supportsEnvFlag));
            }
            if (!active.hasLiveInstance(wire.terminalId)) {
                disposeHeadlessTerminal(wire.terminalId);
                createHeadlessTerminal(wire.terminalId);
                outputSplitters.set(wire.terminalId, new connectionProtocol_1.TerminalV2AnsiSplitter());
            }
            const outcome = active.createFromSpec(fromWire(wire), (data, seq) => enqueueOutput(wire.terminalId, data, seq), (code) => {
                const meta = sessions.get(wire.terminalId);
                if (meta)
                    meta.sessionVersion += 1;
                const tail = outputSplitters.get(wire.terminalId)?.finish() ?? [];
                if (tail.length > 0 && meta) {
                    let pending = pendingOutput.get(wire.terminalId);
                    if (!pending) {
                        pending = { items: [], bytes: 0, timer: null };
                        pendingOutput.set(wire.terminalId, pending);
                    }
                    pending.items.push({
                        chunk: { data: '' },
                        fragments: tail.map((fragment) => ({
                            cursor: {
                                engineEpoch,
                                terminalGeneration: meta.terminalGeneration,
                                streamSeq: ++meta.streamSeq,
                                ...(fragment.bufferSeq === undefined ? {} : { bufferSeq: fragment.bufferSeq }),
                            },
                            delivery: fragment.delivery,
                            data: fragment.data,
                        })),
                    });
                }
                flushOutput(wire.terminalId);
                post({
                    t: 'exit',
                    engineEpoch,
                    terminalId: wire.terminalId,
                    code,
                    snapshot: snapshot(wire.terminalId, false),
                });
            });
            if (outcome.status !== 'exists') {
                const terminalGeneration = active.getSessionGeneration(wire.terminalId);
                if (terminalGeneration === null)
                    throw new Error('spawned terminal has no generation');
                sessions.set(wire.terminalId, {
                    useTmux: wire.useTmux,
                    terminalGeneration,
                    sessionVersion: 1,
                    streamSeq: 0,
                    displayProfile: displayProfileFor(wire),
                });
                const meta = sessions.get(wire.terminalId);
                const splitter = outputSplitters.get(wire.terminalId);
                const bootstrap = pendingV2Bootstrap.get(wire.terminalId) ?? [];
                pendingV2Bootstrap.delete(wire.terminalId);
                if (splitter && bootstrap.length > 0) {
                    let pending = pendingOutput.get(wire.terminalId);
                    if (!pending) {
                        pending = { items: [], bytes: 0, timer: null };
                        pendingOutput.set(wire.terminalId, pending);
                    }
                    for (const item of bootstrap) {
                        const fragments = splitter.feed(item.data, item.seq).map((fragment) => ({
                            cursor: {
                                engineEpoch,
                                terminalGeneration: meta.terminalGeneration,
                                streamSeq: ++meta.streamSeq,
                                ...(fragment.bufferSeq === undefined ? {} : { bufferSeq: fragment.bufferSeq }),
                            },
                            delivery: fragment.delivery,
                            data: fragment.data,
                        }));
                        pending.items.push({ chunk: { data: '' }, fragments });
                    }
                    flushOutput(wire.terminalId);
                }
            }
            return { ...outcome, snapshot: snapshot(wire.terminalId) };
        }
        case 'kill': {
            const terminalId = terminalIdFrom(request);
            active.kill(terminalId);
            sessions.delete(terminalId);
            disposeHeadlessTerminal(terminalId);
            return snapshot(terminalId, false);
        }
        case 'detach': {
            const terminalId = terminalIdFrom(request);
            active.detach(terminalId);
            return snapshot(terminalId);
        }
        case 'kill-all': {
            const terminalIds = [...sessions.keys()];
            active.killAll();
            sessions.clear();
            for (const terminalId of terminalIds)
                disposeHeadlessTerminal(terminalId);
            return terminalIds.map((terminalId) => snapshot(terminalId, false));
        }
        case 'detach-all': {
            const terminalIds = [...sessions.keys()];
            active.detachAll();
            return terminalIds.map((terminalId) => snapshot(terminalId));
        }
        case 'flush':
            await active.flushWrites(terminalIdFrom(request));
            return null;
        case 'write-fenced':
            return await writeFenced(request.params?.part);
        case 'flush-fenced':
            return flushFenced(request.params?.part);
        case 'get-buffer':
            return active.getBuffer(terminalIdFrom(request));
        case 'get-buffer-snapshot': {
            const value = active.getBufferSnapshot(terminalIdFrom(request));
            return { ...value, epoch: 0 };
        }
        case 'get-buffer-preview': {
            const terminalId = terminalIdFrom(request);
            const maxChars = typeof request.params?.maxChars === 'number' ? request.params.maxChars : 200;
            const agentType = request.params?.agentType;
            if (headlessTerminals.has(terminalId)) {
                return getHeadlessPreview(terminalId, maxChars, agentType);
            }
            return active.getBufferPreview(terminalId, maxChars, agentType);
        }
        case 'get-all-buffers':
            return active.getAllBuffers();
        case 'clear-buffer': {
            const terminalId = terminalIdFrom(request);
            active.clearBuffer(terminalId);
            const state = headlessTerminals.get(terminalId);
            if (state) {
                state.writeChain = state.writeChain.catch(() => { }).then(() => {
                    state.terminal.clear();
                    state.screenVersion += 1;
                });
                await state.writeChain;
            }
            return null;
        }
        case 'clear-all-buffers': {
            const cleared = active.clearAllBuffers();
            for (const state of headlessTerminals.values()) {
                state.writeChain = state.writeChain.catch(() => { }).then(() => {
                    state.terminal.clear();
                    state.screenVersion += 1;
                });
            }
            await Promise.all([...headlessTerminals.values()].map((state) => state.writeChain));
            return cleared;
        }
        case 'start-capture':
            active.startCapture(terminalIdFrom(request));
            return null;
        case 'stop-capture':
            return active.stopCapture(terminalIdFrom(request));
        case 'has-tmux-session':
            return active.hasTmuxSession(terminalIdFrom(request));
        case 'kill-tmux-session':
            active.killTmuxSession(terminalIdFrom(request));
            return null;
        case 'list-tmux-sessions':
            return active.listTmuxSessions();
        case 'set-desktop-attachment-count': {
            const terminalId = terminalIdFrom(request);
            active.setDesktopAttachmentCount(terminalId, Number(request.params?.count) || 0);
            return null;
        }
        case 'record-desktop-size': {
            const terminalId = terminalIdFrom(request);
            active.recordDesktopSize(terminalId, Number(request.params?.cols), Number(request.params?.rows));
            return snapshot(terminalId);
        }
        case 'mark-run-ended':
            if (sessions.get(terminalIdFrom(request)))
                sessions.get(terminalIdFrom(request)).sessionVersion += 1;
            return active.markRunEnded(terminalIdFrom(request), Number(request.params?.endedAt));
        case 'get-snapshot':
            return snapshot(terminalIdFrom(request));
        case 'get-attach-snapshot':
            return getAttachSnapshot(terminalIdFrom(request));
        case 'shutdown':
            for (const terminalId of pendingOutput.keys())
                flushOutput(terminalId);
            setImmediate(() => process.exit(0));
            return null;
        default:
            throw Object.assign(new Error(`Unknown PTY host method: ${request.method}`), { code: 'unknown-method' });
    }
}
function handleRequest(request) {
    if (request.protocolVersion !== undefined && request.protocolVersion !== connectionProtocol_1.TERMINAL_CONNECTION_PROTOCOL_VERSION) {
        post({
            t: 'res',
            engineEpoch,
            id: request.id,
            ok: false,
            error: `Unsupported terminal protocol ${request.protocolVersion}`,
            code: 'unsupported-version',
        });
        return;
    }
    if (request.engineEpoch !== undefined && request.engineEpoch !== engineEpoch) {
        post({
            t: 'res',
            engineEpoch,
            id: request.id,
            ok: false,
            error: 'PTY engine epoch changed',
            code: 'stale-engine',
        });
        return;
    }
    void dispatch(request).then((value) => post({ t: 'res', engineEpoch, id: request.id, ok: true, value }), (error) => {
        const typed = error;
        post({
            t: 'res',
            engineEpoch,
            id: request.id,
            ok: false,
            error: typed?.message || 'PTY host request failed',
            code: typed?.code === 'unknown-method'
                ? 'unknown-method'
                : typed?.code === 'bad-params'
                    ? 'bad-params'
                    : typed?.code === 'stale-engine'
                        ? 'stale-engine'
                        : request.method === 'create'
                            ? 'spawn-failed'
                            : 'internal',
        });
    });
}
hostPort.on('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object')
        return;
    if (message.t === 'init') {
        if (manager)
            return;
        if (message.protocolVersion !== connectionProtocol_1.TERMINAL_CONNECTION_PROTOCOL_VERSION) {
            return;
        }
        manager = new pty_1.PtyManager({
            tmuxRuntime: new types_2.StaticTmuxRuntime(message.tmuxRuntime.available, message.tmuxRuntime.path, message.tmuxRuntime.supportsEnvFlag),
        });
        manager.onCommandCompletion((terminalId, elapsedMs) => {
            post({ t: 'command-completion', engineEpoch, terminalId, elapsedMs });
        });
        manager.onTerminalOutputIdle((terminalId, elapsedMs) => {
            post({ t: 'output-idle', engineEpoch, terminalId, elapsedMs });
        });
        post({ t: 'ready', engineEpoch, compatibility });
        return;
    }
    if (message.t === 'req') {
        handleRequest(message);
        return;
    }
    if (!manager)
        return;
    if ('engineEpoch' in message && message.engineEpoch && message.engineEpoch !== engineEpoch)
        return;
    if (message.t === 'write') {
        manager.write(message.terminalId, message.data);
        const meta = sessions.get(message.terminalId);
        if (meta && /\r|\n/.test(message.data))
            meta.sessionVersion += 1;
    }
    else if (message.t === 'resize') {
        const meta = sessions.get(message.terminalId);
        if (message.terminalGeneration !== undefined &&
            message.terminalGeneration !== meta?.terminalGeneration)
            return;
        manager.resize(message.terminalId, message.cols, message.rows);
        if (meta)
            meta.sessionVersion += 1;
        const state = headlessTerminals.get(message.terminalId);
        if (state) {
            state.writeChain = state.writeChain.catch(() => { }).then(() => {
                try {
                    state.terminal.resize(message.cols, message.rows);
                    state.screenVersion += 1;
                }
                catch {
                    // Ignore a resize racing terminal disposal.
                }
            });
        }
    }
    else if (message.t === 'output-ack') {
        acknowledgeOutput(message.terminalId, message.batchId);
    }
});
post({ t: 'booted', engineEpoch, compatibility });
