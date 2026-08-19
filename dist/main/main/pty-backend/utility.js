"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.UtilityPtyBackend = void 0;
/*
 * PtyBackend implemented by one child-scoped Electron utility process.
 * Read docs/common-errors/terminals/INDEX.md before changing input/session
 * ownership tracking or PTY lifecycle behavior.
 *
 * Main keeps only policy, callbacks, and event-fed status caches. All PTY
 * handles, buffers, native writes, tmux attachments, and output batching live
 * in the utility host. A host crash ends its terminals; the next create starts
 * one fresh host (never one process per terminal, and never an in-main PTY).
 */
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const runState_1 = require("../../shared/terminal/runState");
const submittedPromptTracker_1 = require("../../shared/terminal/submittedPromptTracker");
const connectionProtocol_1 = require("../../shared/terminal/connectionProtocol");
const processAncestry_1 = require("./processAncestry");
const HOST_READY_TIMEOUT_MS = 10_000;
const RPC_TIMEOUT_MS = 30_000;
class UtilityPtyBackend {
    tmuxRuntime;
    child = null;
    engineEpoch = null;
    compatibility = null;
    hostGeneration = 0;
    nextRequestId = 1;
    pending = new Map();
    sessions = new Map();
    attachmentCounts = new Map();
    // Remote mirrors subscribe to dims changes so a desktop refit reaches the
    // phone instead of leaving it painting on a stale grid
    // (docs/common-errors/remote/remote-mirror-stale-size-ghosting.md).
    resizeListeners = new Map();
    outputBatchCallbacks = new Set();
    commandCompletionCallback = null;
    outputIdleCallback = null;
    attributionRootListeners = new Set();
    starting = null;
    shuttingDown = false;
    // Kept in main beside the sync write facade so desktop, phone, scheduled,
    // and orchestration submissions all produce the same ownership evidence.
    submittedPromptTracker = new submittedPromptTracker_1.SubmittedPromptTracker();
    ready;
    constructor(tmuxRuntime) {
        this.tmuxRuntime = tmuxRuntime;
        this.ready = this.ensureHost();
    }
    /** Separate high-volume delivery capability, intentionally not part of the
     * fd-adjacent PtyBackend inventory. */
    onOutputBatch(callback) {
        this.outputBatchCallbacks.add(callback);
        return () => this.outputBatchCallbacks.delete(callback);
    }
    acknowledgeOutputBatch(terminalId, opaqueBatchId) {
        const [generationRaw, batchRaw] = opaqueBatchId.split(':');
        const generation = Number(generationRaw);
        const batchId = Number(batchRaw);
        if (!this.child || generation !== this.hostGeneration || !Number.isInteger(batchId))
            return;
        this.child.postMessage({ t: 'output-ack', engineEpoch: this.engineEpoch ?? undefined, terminalId, batchId });
    }
    ensureHost() {
        if (this.child)
            return Promise.resolve();
        if (this.starting)
            return this.starting;
        this.starting = this.startHost().finally(() => {
            this.starting = null;
        });
        return this.starting;
    }
    startHost() {
        this.shuttingDown = false;
        const generation = ++this.hostGeneration;
        const modulePath = path_1.default.join(__dirname, '../pty-host/utilityHost.js');
        const child = electron_1.utilityProcess.fork(modulePath, [], {
            serviceName: '1DevTool PTY Host',
            stdio: 'inherit',
        });
        this.child = child;
        return new Promise((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                if (this.child === child)
                    this.child = null;
                child.kill();
                reject(new Error('PTY utility process did not become ready'));
            }, HOST_READY_TIMEOUT_MS);
            const failStart = (error) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeout);
                if (this.child === child)
                    this.child = null;
                reject(error);
            };
            child.on('message', (message) => {
                if (generation !== this.hostGeneration)
                    return;
                if (message.t === 'booted') {
                    try {
                        if (message.compatibility.protocolVersion !== connectionProtocol_1.TERMINAL_CONNECTION_PROTOCOL_VERSION) {
                            failStart(new Error(`Unsupported PTY host protocol ${message.compatibility.protocolVersion}`));
                            return;
                        }
                        this.engineEpoch = message.engineEpoch;
                        this.compatibility = message.compatibility;
                        const available = this.tmuxRuntime.isAvailable();
                        child.postMessage({
                            t: 'init',
                            protocolVersion: connectionProtocol_1.TERMINAL_CONNECTION_PROTOCOL_VERSION,
                            capabilities: [...connectionProtocol_1.RAW_V2_CAPABILITIES],
                            tmuxRuntime: {
                                available,
                                path: available ? this.tmuxRuntime.getPath() : null,
                                supportsEnvFlag: available ? this.tmuxRuntime.supportsEnvFlag() : false,
                            },
                        });
                    }
                    catch (error) {
                        failStart(error instanceof Error ? error : new Error(String(error)));
                    }
                    return;
                }
                if (message.t === 'ready') {
                    if (message.engineEpoch !== this.engineEpoch) {
                        failStart(new Error('PTY utility process changed epoch during startup'));
                        return;
                    }
                    if (!settled) {
                        settled = true;
                        clearTimeout(timeout);
                        resolve();
                    }
                    return;
                }
                this.handleHostMessage(generation, message);
            });
            child.on('error', (_type, location) => {
                failStart(new Error(`PTY utility process failed at ${location}`));
            });
            child.on('exit', (code) => {
                if (generation !== this.hostGeneration)
                    return;
                clearTimeout(timeout);
                if (!settled)
                    failStart(new Error(`PTY utility process exited during startup (${code})`));
                this.handleHostExit(child, code);
            });
        });
    }
    handleHostExit(child, code) {
        if (this.child !== child)
            return;
        this.child = null;
        const lostEpoch = this.engineEpoch;
        this.engineEpoch = null;
        this.compatibility = null;
        const error = new Error(`PTY utility process exited (${code})`);
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        this.pending.clear();
        if (this.shuttingDown)
            return;
        for (const session of this.sessions.values()) {
            if (!session.liveInstance && !session.running)
                continue;
            session.liveInstance = false;
            session.running = false;
            if (session.status)
                session.status = { ...session.status, isAlive: false };
            if (session.identity && session.identity.engineEpoch === lostEpoch) {
                for (const listener of session.v2ExitListeners) {
                    listener({ identity: session.identity, sessionVersion: session.sessionVersion + 1, code: code || 1 });
                }
            }
            session.onExit?.(code || 1);
        }
        this.emitAttributionRootsChanged();
    }
    handleHostMessage(generation, message) {
        if (generation !== this.hostGeneration)
            return;
        if ('engineEpoch' in message && this.engineEpoch && message.engineEpoch !== this.engineEpoch)
            return;
        switch (message.t) {
            case 'res':
                this.handleResponse(message);
                return;
            case 'output-batch':
                this.handleOutputBatch(generation, message);
                return;
            case 'exit': {
                const session = this.sessions.get(message.terminalId);
                if (!session)
                    return;
                this.applySnapshot(message.snapshot, session);
                if (message.snapshot.identity) {
                    for (const listener of session.v2ExitListeners) {
                        listener({
                            identity: message.snapshot.identity,
                            sessionVersion: message.snapshot.sessionVersion,
                            code: message.code,
                        });
                    }
                }
                session.liveInstance = false;
                session.running = false;
                if (session.status)
                    session.status = { ...session.status, isAlive: false };
                session.onExit?.(message.code);
                this.emitAttributionRootsChanged();
                return;
            }
            case 'command-completion':
                this.commandCompletionCallback?.(message.terminalId, message.elapsedMs);
                return;
            case 'output-idle':
                this.outputIdleCallback?.(message.terminalId, message.elapsedMs);
                return;
            case 'booted':
            case 'ready':
                return;
        }
    }
    handleResponse(response) {
        const request = this.pending.get(response.id);
        if (!request)
            return;
        this.pending.delete(response.id);
        clearTimeout(request.timer);
        if (response.ok)
            request.resolve(response.value);
        else
            request.reject(Object.assign(new Error(response.error || 'PTY host request failed'), { code: response.code }));
    }
    handleOutputBatch(generation, message) {
        let session = this.sessions.get(message.terminalId);
        if (!session) {
            session = this.newSession(message.terminalId);
            this.sessions.set(message.terminalId, session);
        }
        this.applySnapshot(message.snapshot, session);
        for (const chunk of message.chunks) {
            session.onData?.(chunk.data, chunk.seq);
            for (const listener of session.outputListeners)
                listener(chunk.data, chunk.seq);
        }
        for (const fragment of message.v2Fragments ?? []) {
            if (!session.identity || fragment.cursor.engineEpoch !== session.identity.engineEpoch ||
                fragment.cursor.terminalGeneration !== session.identity.terminalGeneration)
                continue;
            session.streamSeq = Math.max(session.streamSeq, fragment.cursor.streamSeq);
            for (const listener of session.v2OutputListeners)
                listener(fragment);
        }
        if ((this.attachmentCounts.get(message.terminalId) ?? 0) <= 0) {
            this.child?.postMessage({ t: 'output-ack', engineEpoch: this.engineEpoch ?? undefined, terminalId: message.terminalId, batchId: message.batchId });
            return;
        }
        const batch = {
            terminalId: message.terminalId,
            batchId: `${generation}:${message.batchId}`,
            chunks: message.chunks,
            bytes: message.bytes,
        };
        if (this.outputBatchCallbacks.size === 0) {
            this.child?.postMessage({ t: 'output-ack', engineEpoch: this.engineEpoch ?? undefined, terminalId: message.terminalId, batchId: message.batchId });
            return;
        }
        for (const callback of this.outputBatchCallbacks)
            callback(batch);
    }
    newSession(terminalId) {
        return {
            terminalId,
            liveInstance: false,
            running: false,
            useTmux: false,
            rootPid: null,
            size: null,
            desktopSize: null,
            sessionGeneration: null,
            identity: null,
            sessionVersion: 0,
            screenVersion: 0,
            streamSeq: 0,
            outputListeners: new Set(),
            v2OutputListeners: new Set(),
            v2ExitListeners: new Set(),
            novelTracker: (0, runState_1.createNovelOutputTracker)(),
        };
    }
    applySnapshot(snapshot, existing) {
        const session = existing ?? this.sessions.get(snapshot.terminalId) ?? this.newSession(snapshot.terminalId);
        const previousRootKey = this.attributionRootKey(session);
        session.liveInstance = snapshot.liveInstance;
        session.running = snapshot.running;
        session.useTmux = snapshot.useTmux;
        session.rootPid = snapshot.rootPid;
        session.spawnTime = snapshot.spawnTime;
        session.lastSubmitTime = snapshot.lastSubmitTime;
        session.status = snapshot.status;
        session.size = snapshot.size;
        session.desktopSize = snapshot.desktopSize;
        session.sessionGeneration = snapshot.sessionGeneration;
        session.identity = snapshot.identity;
        session.sessionVersion = snapshot.sessionVersion;
        session.screenVersion = snapshot.screenVersion;
        session.streamSeq = snapshot.streamSeq;
        this.sessions.set(snapshot.terminalId, session);
        if (this.attributionRootKey(session) !== previousRootKey) {
            this.emitAttributionRootsChanged();
        }
        return session;
    }
    attributionRootKey(session) {
        return session.liveInstance && session.rootPid && session.sessionGeneration !== null
            ? `${session.rootPid}:${session.sessionGeneration}`
            : '';
    }
    async request(method, params = {}, timeoutMs = RPC_TIMEOUT_MS) {
        if (!this.child && this.shuttingDown) {
            throw new Error('PTY utility process has been shut down');
        }
        await this.ensureHost();
        const child = this.child;
        if (!child)
            throw new Error('PTY utility process is unavailable');
        const id = this.nextRequestId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`PTY host request timed out: ${method}`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (value) => resolve(value),
                reject,
                timer,
            });
            child.postMessage({
                t: 'req',
                id,
                protocolVersion: connectionProtocol_1.TERMINAL_CONNECTION_PROTOCOL_VERSION,
                engineEpoch: this.engineEpoch ?? undefined,
                method,
                params,
            });
        });
    }
    async create(spec, onData, onExit) {
        await this.ensureHost();
        const existing = this.sessions.get(spec.terminalId);
        if (existing?.liveInstance) {
            if (onData)
                existing.onData = onData;
            if (onExit)
                existing.onExit = onExit;
            return { status: 'exists' };
        }
        const session = existing ?? this.newSession(spec.terminalId);
        session.onData = onData;
        session.onExit = onExit;
        session.useTmux = spec.useTmux;
        this.sessions.set(spec.terminalId, session);
        let lastError;
        for (const candidate of spec.candidates) {
            let env;
            try {
                env = candidate.resolveEnv();
            }
            catch (error) {
                lastError = error;
                continue;
            }
            const wire = {
                terminalId: spec.terminalId,
                cwd: spec.cwd,
                candidate: { executable: candidate.executable, args: candidate.args, env },
                useTmux: spec.useTmux,
                tmux: spec.tmux,
                tmuxMouseBehavior: spec.tmuxMouseBehavior,
                startupWrite: spec.startupWrite,
                preserveOpenTuiReplayModes: spec.preserveOpenTuiReplayModes,
                effectiveAgentKind: spec.effectiveAgentKind,
                agentType: spec.agentType,
            };
            try {
                const result = await this.request('create', { spec: wire });
                this.applySnapshot(result.snapshot, session);
                if (result.status === 'created')
                    this.submittedPromptTracker.reset(spec.terminalId);
                return { status: result.status };
            }
            catch (error) {
                const code = error.code;
                if (code !== 'spawn-failed')
                    throw error;
                lastError = error;
            }
        }
        await this.request('kill', { terminalId: spec.terminalId }).catch(() => { });
        this.sessions.delete(spec.terminalId);
        const message = lastError instanceof Error ? lastError.message : 'Unknown PTY error';
        throw new Error(message.startsWith('Failed to start terminal') ? message : `Failed to start terminal in ${spec.cwd}: ${message}`);
    }
    async kill(terminalId) {
        await this.request('kill', { terminalId }).catch(() => { });
        this.sessions.delete(terminalId);
        this.attachmentCounts.delete(terminalId);
    }
    async detach(terminalId) {
        const value = await this.request('detach', { terminalId }).catch(() => null);
        if (value)
            this.applySnapshot(value);
    }
    async killAll() {
        await this.request('kill-all', {}, 15_000).catch(() => { });
        for (const session of this.sessions.values()) {
            session.liveInstance = false;
            session.running = false;
            if (session.status)
                session.status = { ...session.status, isAlive: false };
        }
    }
    async detachAll() {
        const values = await this.request('detach-all', {}, 15_000).catch(() => []);
        for (const value of values)
            this.applySnapshot(value);
    }
    write(terminalId, data) {
        const session = this.sessions.get(terminalId);
        if (!session?.liveInstance || !this.child)
            return;
        this.submittedPromptTracker.feed(terminalId, data);
        if (/\r|\n/.test(data)) {
            const now = Date.now();
            session.lastSubmitTime = now;
            const prior = session.status;
            session.status = {
                isAlive: true,
                lastActivityAt: prior?.lastActivityAt ?? 0,
                lastSubmitAt: now,
                lastNovelActivityAt: prior?.lastNovelActivityAt,
            };
        }
        this.child.postMessage({ t: 'write', engineEpoch: this.engineEpoch ?? undefined, terminalId, data });
    }
    resize(terminalId, cols, rows) {
        const session = this.sessions.get(terminalId);
        if (!session?.liveInstance || !this.child)
            return;
        const changed = session.size?.cols !== cols || session.size?.rows !== rows;
        session.size = { cols, rows };
        this.child.postMessage({
            t: 'resize',
            engineEpoch: this.engineEpoch ?? undefined,
            terminalId,
            terminalGeneration: session.identity?.terminalGeneration,
            cols,
            rows,
        });
        if (changed) {
            const listeners = this.resizeListeners.get(terminalId);
            if (listeners) {
                for (const listener of listeners)
                    listener({ cols, rows });
            }
        }
    }
    flush(terminalId) {
        return this.request('flush', { terminalId });
    }
    writeFenced(part) {
        return this.request('write-fenced', { terminalId: part.terminalId, part });
    }
    flushFenced(part) {
        return this.request('flush-fenced', { terminalId: part.terminalId, part });
    }
    hasLiveInstance(terminalId) {
        return this.sessions.get(terminalId)?.liveInstance ?? false;
    }
    usesTmux(terminalId) {
        const session = this.sessions.get(terminalId);
        return Boolean(session?.liveInstance && session.useTmux);
    }
    getSize(terminalId) {
        return this.sessions.get(terminalId)?.size ?? null;
    }
    getSpawnTime(terminalId) {
        return this.sessions.get(terminalId)?.spawnTime;
    }
    getLastSubmitTime(terminalId) {
        return this.sessions.get(terminalId)?.lastSubmitTime;
    }
    getSubmittedPrompts(terminalId) {
        return this.submittedPromptTracker.read(terminalId);
    }
    getSessionGeneration(terminalId) {
        return this.sessions.get(terminalId)?.sessionGeneration ?? null;
    }
    getOwnerIdentity(terminalId) {
        const session = this.sessions.get(terminalId);
        return session?.liveInstance ? session.identity : null;
    }
    isIdle(terminalId, thresholdMs) {
        const lastActivityAt = this.sessions.get(terminalId)?.status?.lastActivityAt;
        return !lastActivityAt || Date.now() - lastActivityAt > thresholdMs;
    }
    getAllStatuses() {
        const statuses = {};
        for (const [terminalId, session] of this.sessions) {
            if (!session.status && !session.running)
                continue;
            statuses[terminalId] = session.status ?? {
                isAlive: session.running,
                lastActivityAt: 0,
                lastSubmitAt: session.lastSubmitTime ?? 0,
            };
        }
        return statuses;
    }
    markRunEnded(terminalId, endedAt) {
        const session = this.sessions.get(terminalId);
        const lastSubmitAt = session?.lastSubmitTime ?? session?.status?.lastSubmitAt;
        if (!session || !lastSubmitAt || endedAt < lastSubmitAt)
            return false;
        if (session.status) {
            session.status = {
                ...session.status,
                lastRunEndedAt: Math.max(session.status.lastRunEndedAt ?? 0, endedAt),
            };
        }
        void this.request('mark-run-ended', { terminalId, endedAt }).catch(() => { });
        return true;
    }
    findTerminalByProcessAncestor(pid) {
        const roots = new Map();
        for (const [terminalId, session] of this.sessions) {
            if (session.rootPid && session.liveInstance)
                roots.set(session.rootPid, terminalId);
        }
        return (0, processAncestry_1.findTerminalByAncestry)(pid, roots);
    }
    getAttributionRoots() {
        const roots = [];
        for (const [terminalId, session] of this.sessions) {
            if (!session.liveInstance || !session.rootPid || session.sessionGeneration === null)
                continue;
            roots.push({
                terminalId,
                pid: session.rootPid,
                sessionGeneration: session.sessionGeneration,
            });
        }
        return roots;
    }
    onAttributionRootsChanged(callback) {
        this.attributionRootListeners.add(callback);
        callback(this.getAttributionRoots());
        return () => this.attributionRootListeners.delete(callback);
    }
    emitAttributionRootsChanged() {
        if (this.attributionRootListeners.size === 0)
            return;
        const roots = this.getAttributionRoots();
        for (const listener of this.attributionRootListeners) {
            try {
                listener(roots);
            }
            catch {
                // Root observation must never break utility-host lifecycle.
            }
        }
    }
    setDesktopAttachmentCount(terminalId, count) {
        if (count <= 0)
            this.attachmentCounts.delete(terminalId);
        else
            this.attachmentCounts.set(terminalId, count);
        void this.request('set-desktop-attachment-count', { terminalId, count }).catch(() => { });
    }
    hasDesktopAttachment(terminalId) {
        return (this.attachmentCounts.get(terminalId) ?? 0) > 0;
    }
    recordDesktopSize(terminalId, cols, rows) {
        const session = this.sessions.get(terminalId);
        if (session && Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
            session.desktopSize = { cols, rows };
        }
        void this.request('record-desktop-size', { terminalId, cols, rows }).catch(() => { });
    }
    getDesktopSize(terminalId) {
        return this.sessions.get(terminalId)?.desktopSize ?? null;
    }
    getBuffer(terminalId) {
        return this.request('get-buffer', { terminalId });
    }
    getBufferSnapshot(terminalId) {
        return this.request('get-buffer-snapshot', { terminalId });
    }
    getAttachSnapshotV2(terminalId) {
        return this.request('get-attach-snapshot', { terminalId });
    }
    getBufferPreview(terminalId, maxChars, agentType) {
        return this.request('get-buffer-preview', { terminalId, maxChars, agentType });
    }
    getAllBuffers() {
        return this.request('get-all-buffers');
    }
    async clearBuffer(terminalId) {
        await this.request('clear-buffer', { terminalId });
    }
    clearAllBuffers() {
        return this.request('clear-all-buffers');
    }
    async startCapture(terminalId) {
        await this.request('start-capture', { terminalId });
    }
    stopCapture(terminalId) {
        return this.request('stop-capture', { terminalId });
    }
    hasTmuxSession(terminalId) {
        return this.request('has-tmux-session', { terminalId });
    }
    async killTmuxSession(terminalId) {
        await this.request('kill-tmux-session', { terminalId });
    }
    listTmuxSessions() {
        return this.request('list-tmux-sessions');
    }
    onOutput(terminalId, callback) {
        let session = this.sessions.get(terminalId);
        if (!session) {
            session = this.newSession(terminalId);
            this.sessions.set(terminalId, session);
        }
        session.outputListeners.add(callback);
        return () => session.outputListeners.delete(callback);
    }
    onV2Output(terminalId, callback) {
        let session = this.sessions.get(terminalId);
        if (!session) {
            session = this.newSession(terminalId);
            this.sessions.set(terminalId, session);
        }
        session.v2OutputListeners.add(callback);
        return () => session.v2OutputListeners.delete(callback);
    }
    onV2Exit(terminalId, callback) {
        let session = this.sessions.get(terminalId);
        if (!session) {
            session = this.newSession(terminalId);
            this.sessions.set(terminalId, session);
        }
        session.v2ExitListeners.add(callback);
        return () => session.v2ExitListeners.delete(callback);
    }
    onResize(terminalId, callback) {
        let listeners = this.resizeListeners.get(terminalId);
        if (!listeners) {
            listeners = new Set();
            this.resizeListeners.set(terminalId, listeners);
        }
        listeners.add(callback);
        return () => {
            listeners.delete(callback);
            if (listeners.size === 0)
                this.resizeListeners.delete(terminalId);
        };
    }
    onCommandCompletion(callback) {
        this.commandCompletionCallback = callback;
    }
    onTerminalOutputIdle(callback) {
        this.outputIdleCallback = callback;
    }
    /** Best-effort host teardown used by the async quit coordinator. */
    async shutdownHost(timeoutMs = 1_500) {
        const child = this.child;
        if (!child)
            return;
        this.shuttingDown = true;
        await this.request('shutdown', {}, timeoutMs).catch(() => { });
        if (this.child === child) {
            child.kill();
            this.child = null;
        }
        for (const session of this.sessions.values()) {
            session.liveInstance = false;
        }
    }
}
exports.UtilityPtyBackend = UtilityPtyBackend;
