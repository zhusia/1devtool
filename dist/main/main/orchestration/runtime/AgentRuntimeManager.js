"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentRuntimeManager = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const EVENT_RING_CAP = 512;
function emptyState() {
    return { version: 1, sessions: {} };
}
function clone(value) {
    return JSON.parse(JSON.stringify(value));
}
class AgentRuntimeManager {
    registry;
    statePath;
    state = null;
    live = new Map();
    eventRings = new Map();
    listeners = new Set();
    constructor(registry, statePath) {
        this.registry = registry;
        this.statePath = statePath;
    }
    initialize() {
        if (this.state)
            return;
        try {
            const parsed = JSON.parse(node_fs_1.default.readFileSync(this.statePath, 'utf-8'));
            this.state = parsed.version === 1 && parsed.sessions && typeof parsed.sessions === 'object' ? parsed : emptyState();
        }
        catch {
            this.state = emptyState();
        }
        // Process identity is intentionally not trusted after app restart.
        for (const session of Object.values(this.state.sessions)) {
            if (session.lifecycle !== 'closed' && session.lifecycle !== 'error') {
                session.lifecycle = session.nativeSessionId ? 'offline' : 'uncertain';
                session.updatedAt = Date.now();
            }
        }
        this.commit();
    }
    listSessions() {
        this.initialize();
        return Object.values(this.state.sessions).map(({ createRequestId: _, turnRequests: __, ...session }) => clone(session));
    }
    getSession(sessionId) {
        this.initialize();
        const record = this.state.sessions[sessionId];
        if (!record)
            return null;
        const { createRequestId: _, turnRequests: __, ...session } = record;
        return clone(session);
    }
    async createSession(harnessId, input) {
        this.initialize();
        const existing = this.state.sessions[input.sessionId];
        if (existing) {
            if (existing.createRequestId !== input.clientRequestId || existing.harnessId !== harnessId) {
                throw new Error('Public session id was already used by a different create request');
            }
            return this.getSession(input.sessionId);
        }
        const duplicate = Object.values(this.state.sessions).find((session) => session.createRequestId === input.clientRequestId);
        if (duplicate)
            return this.getSession(duplicate.sessionId);
        const harness = this.requireHarness(harnessId);
        const now = Date.now();
        const record = {
            sessionId: input.sessionId,
            harnessId,
            agentId: input.agentId,
            projectId: input.projectId,
            workspacePath: input.workspacePath,
            lifecycle: 'creating',
            epoch: node_crypto_1.default.randomUUID(),
            lastSeq: 0,
            orchestrationId: input.orchestrationId,
            runId: input.runId,
            createdAt: now,
            updatedAt: now,
            createRequestId: input.clientRequestId,
            turnRequests: {},
        };
        this.state.sessions[input.sessionId] = record;
        this.commit();
        this.attach(input.sessionId, harness);
        try {
            const handle = await harness.createSession(input);
            record.nativeSessionId = handle.nativeSessionId;
            record.lifecycle = 'idle';
            record.updatedAt = Date.now();
            this.commit();
            this.emit(record, { type: 'session-created', nativeSessionId: handle.nativeSessionId });
            return this.getSession(input.sessionId);
        }
        catch (error) {
            record.lifecycle = 'error';
            record.error = error instanceof Error ? error.message : String(error);
            record.updatedAt = Date.now();
            this.commit();
            this.emit(record, { type: 'session-error', error: record.error });
            throw error;
        }
    }
    async loadSession(harnessId, input) {
        this.initialize();
        const current = this.state.sessions[input.sessionId];
        if (!current) {
            const now = Date.now();
            this.state.sessions[input.sessionId] = {
                sessionId: input.sessionId,
                harnessId,
                agentId: input.agentId,
                nativeSessionId: input.nativeSessionId,
                projectId: input.projectId,
                workspacePath: input.workspacePath,
                lifecycle: 'creating',
                epoch: node_crypto_1.default.randomUUID(),
                lastSeq: 0,
                orchestrationId: input.orchestrationId,
                runId: input.runId,
                createdAt: now,
                updatedAt: now,
                createRequestId: input.clientRequestId,
                turnRequests: {},
            };
        }
        else if (current.nativeSessionId && current.nativeSessionId !== input.nativeSessionId) {
            throw new Error('Native session binding cannot be replaced');
        }
        const record = this.state.sessions[input.sessionId];
        const harness = this.requireHarness(harnessId);
        record.epoch = node_crypto_1.default.randomUUID();
        record.lastSeq = 0;
        record.lifecycle = 'creating';
        record.updatedAt = Date.now();
        this.commit();
        this.detach(input.sessionId);
        this.attach(input.sessionId, harness);
        try {
            const handle = await harness.loadSession(input);
            if (handle.nativeSessionId && handle.nativeSessionId !== input.nativeSessionId) {
                throw new Error('Harness loaded a different native session id');
            }
            record.lifecycle = 'idle';
            record.nativeSessionId = input.nativeSessionId;
            record.updatedAt = Date.now();
            this.commit();
            this.emit(record, { type: 'session-loaded', nativeSessionId: input.nativeSessionId });
            return this.getSession(input.sessionId);
        }
        catch (error) {
            record.lifecycle = 'offline';
            record.error = error instanceof Error ? error.message : String(error);
            record.updatedAt = Date.now();
            this.commit();
            throw error;
        }
    }
    async sendTurn(input) {
        this.initialize();
        const record = this.requireSession(input.sessionId);
        const existingTurnId = record.turnRequests[input.clientRequestId];
        if (existingTurnId)
            return { sessionId: input.sessionId, turnId: existingTurnId };
        if (record.activeTurnId)
            throw new Error('Session already has an active turn');
        const live = this.live.get(input.sessionId);
        if (!live)
            throw new Error('Session runtime is offline; load it before sending a turn');
        record.turnRequests[input.clientRequestId] = input.turnId;
        record.activeTurnId = input.turnId;
        record.runId = input.runId ?? record.runId;
        record.orchestrationId = input.orchestrationId ?? record.orchestrationId;
        record.lifecycle = 'running';
        record.updatedAt = Date.now();
        this.commit();
        this.emit(record, { type: 'turn-queued' }, input.turnId);
        try {
            return await live.harness.sendTurn(input);
        }
        catch (error) {
            this.emit(record, { type: 'turn-failed', error: error instanceof Error ? error.message : String(error) }, input.turnId);
            throw error;
        }
    }
    async startRun(input) {
        const session = 'nativeSessionId' in input.session
            ? await this.loadSession(input.harnessId, input.session)
            : await this.createSession(input.harnessId, input.session);
        const turn = await this.sendTurn(input.turn);
        return { session, turnId: turn.turnId };
    }
    async cancelTurn(input) {
        const record = this.requireSession(input.sessionId);
        if (record.activeTurnId !== input.turnId)
            return;
        const live = this.live.get(input.sessionId);
        if (!live) {
            record.lifecycle = 'uncertain';
            record.error = 'Runtime was offline when cancellation was requested';
            record.updatedAt = Date.now();
            this.commit();
            return;
        }
        await live.harness.cancelTurn(input);
    }
    async resolveInteraction(input) {
        const record = this.requireSession(input.sessionId);
        const live = this.live.get(input.sessionId);
        if (!live || record.activeTurnId !== input.turnId)
            throw new Error('Interaction no longer belongs to the active runtime epoch');
        await live.harness.resolveInteraction(input);
    }
    async closeSession(input) {
        const record = this.requireSession(input.sessionId);
        const live = this.live.get(input.sessionId);
        if (live)
            await live.harness.closeSession(input);
        record.lifecycle = 'closed';
        delete record.activeTurnId;
        record.updatedAt = Date.now();
        this.commit();
        this.emit(record, { type: 'session-closed', reason: input.reason });
        this.detach(input.sessionId);
    }
    events(sessionId, epoch, afterSeq = 0) {
        const record = this.state?.sessions[sessionId];
        if (!record)
            return null;
        const ring = this.eventRings.get(sessionId) ?? [];
        if (epoch && epoch !== record.epoch)
            return { epoch: record.epoch, events: clone(ring) };
        return { epoch: record.epoch, events: clone(ring.filter((event) => event.seq > afterSeq)) };
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    attach(sessionId, harness) {
        const ring = [];
        this.eventRings.set(sessionId, ring);
        const unsubscribe = harness.subscribe((incoming) => {
            if (incoming.sessionId !== sessionId || incoming.harnessId !== harness.id)
                return;
            const record = this.state?.sessions[sessionId];
            if (!record)
                return;
            this.emit(record, incoming.event, incoming.turnId, incoming.itemId, incoming.nativeSessionId);
        });
        this.live.set(sessionId, { harness, unsubscribe });
    }
    detach(sessionId) {
        const live = this.live.get(sessionId);
        live?.unsubscribe();
        this.live.delete(sessionId);
    }
    emit(record, event, turnId, itemId, nativeSessionId) {
        record.lastSeq += 1;
        record.updatedAt = Date.now();
        if (nativeSessionId)
            record.nativeSessionId = nativeSessionId;
        if (event.type === 'turn-started')
            record.lifecycle = 'running';
        if (event.type === 'approval-requested' || event.type === 'question-requested')
            record.lifecycle = 'needs-input';
        if (event.type === 'turn-completed' || event.type === 'turn-failed' || event.type === 'turn-cancelled') {
            record.lifecycle = event.type === 'turn-cancelled' && event.uncertain ? 'uncertain' : event.type === 'turn-failed' ? 'error' : 'idle';
            delete record.activeTurnId;
        }
        if (event.type === 'usage-updated')
            record.usage = event.usage;
        if (event.type === 'adapter-exited' && record.lifecycle !== 'closed') {
            record.lifecycle = record.activeTurnId ? 'uncertain' : 'offline';
        }
        const envelope = {
            seq: record.lastSeq,
            epoch: record.epoch,
            at: Date.now(),
            harnessId: record.harnessId,
            sessionId: record.sessionId,
            nativeSessionId: record.nativeSessionId,
            orchestrationId: record.orchestrationId,
            runId: record.runId,
            turnId: turnId ?? record.activeTurnId,
            itemId,
            event,
        };
        const ring = this.eventRings.get(record.sessionId);
        if (ring) {
            ring.push(envelope);
            if (ring.length > EVENT_RING_CAP)
                ring.splice(0, ring.length - EVENT_RING_CAP);
        }
        this.commit();
        for (const listener of this.listeners)
            listener(clone(envelope));
    }
    requireHarness(harnessId) {
        const harness = this.registry.get(harnessId);
        if (!harness)
            throw new Error(`Harness ${harnessId} is not registered`);
        return harness;
    }
    requireSession(sessionId) {
        this.initialize();
        const session = this.state.sessions[sessionId];
        if (!session)
            throw new Error(`Unknown runtime session ${sessionId}`);
        return session;
    }
    commit() {
        if (!this.state)
            return;
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(this.statePath), { recursive: true, mode: 0o700 });
        const tmp = `${this.statePath}.${process.pid}.tmp`;
        node_fs_1.default.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: 'utf-8', mode: 0o600 });
        node_fs_1.default.renameSync(tmp, this.statePath);
    }
}
exports.AgentRuntimeManager = AgentRuntimeManager;
