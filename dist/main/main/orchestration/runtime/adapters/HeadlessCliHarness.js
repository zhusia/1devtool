"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HeadlessCliHarness = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const runHeadlessAgent_1 = require("../../runHeadlessAgent");
const structuredHeadlessOutput_1 = require("../../structuredHeadlessOutput");
class HeadlessCliHarness {
    deps;
    id;
    agentId;
    // '2': Windows-safe .cmd spawn routing — invalidates cached EINVAL probes.
    adapterVersion = '2';
    declaredCapabilities;
    listeners = new Set();
    sessions = new Map();
    turns = new Map();
    constructor(deps) {
        this.deps = deps;
        this.agentId = deps.agentId;
        this.id = `${deps.agentId}:${deps.structured === false ? 'plain-cli' : 'structured-cli'}`;
        this.declaredCapabilities = {
            transport: deps.structured === false ? 'plain-cli' : 'structured-cli',
            auth: 'vendor-owned',
            streaming: 'none',
            reasoning: false,
            toolEvents: false,
            approvals: 'none',
            questions: false,
            interrupt: true,
            steering: false,
            liveQueue: false,
            resume: 'cold',
            multipleSessionsPerProcess: false,
            images: false,
            compaction: false,
            usage: deps.structured === false ? 'none' : 'final',
            dynamicTools: 'none',
            nativeTui: false,
        };
    }
    async detect(_ctx) {
        const resolved = await this.deps.binaryPath();
        return resolved && node_fs_1.default.existsSync(resolved.path)
            ? { available: true, binaryPath: resolved.path, version: resolved.version }
            : { available: false, reason: `${this.agentId} executable was not detected` };
    }
    async probe() {
        const detected = await this.detect({ agentId: this.agentId });
        const fp = node_crypto_1.default.createHash('sha256').update(JSON.stringify({
            id: this.id,
            path: detected.binaryPath,
            version: detected.version,
            adapterVersion: this.adapterVersion,
        })).digest('hex');
        return {
            state: detected.available ? 'verified' : 'failed',
            capabilities: detected.available ? this.declaredCapabilities : {},
            checkedAt: Date.now(),
            binaryPath: detected.binaryPath,
            binaryVersion: detected.version,
            adapterVersion: this.adapterVersion,
            fingerprint: fp,
            reason: detected.reason,
        };
    }
    async createSession(input) {
        const existing = this.sessions.get(input.sessionId);
        if (existing && existing.clientRequestId !== input.clientRequestId)
            throw new Error('Headless session id was already used');
        this.sessions.set(input.sessionId, input);
        return { sessionId: input.sessionId };
    }
    async loadSession(input) {
        this.sessions.set(input.sessionId, input);
        return { sessionId: input.sessionId, nativeSessionId: input.nativeSessionId };
    }
    async sendTurn(input) {
        const session = this.sessions.get(input.sessionId);
        if (!session)
            throw new Error('Headless session is not loaded');
        if (this.turns.has(input.sessionId))
            throw new Error('Headless session already has an active turn');
        const detected = await this.detect({ agentId: this.agentId });
        if (!detected.available || !detected.binaryPath)
            throw new Error(detected.reason ?? 'Agent executable is unavailable');
        const abort = new AbortController();
        this.turns.set(input.sessionId, abort);
        this.emit(input.sessionId, input.turnId, { type: 'turn-started' });
        void (0, runHeadlessAgent_1.runHeadlessAgent)({
            agentId: this.agentId,
            prompt: input.prompt.text,
            flags: this.deps.structured === false ? [] : (0, structuredHeadlessOutput_1.structuredCaptureFlags)(this.agentId),
            defaultFlags: this.deps.defaultFlags,
            timeoutSeconds: this.deps.timeoutSeconds,
            cwd: session.workspacePath,
            binaryPath: detected.binaryPath,
            signal: abort.signal,
        }).then((result) => {
            const parsed = this.deps.structured === false
                ? { output: result.output }
                : (0, structuredHeadlessOutput_1.parseStructuredHeadlessOutput)(this.agentId, result.output);
            if (parsed.sessionId) {
                this.emit(input.sessionId, input.turnId, { type: 'session-loaded', nativeSessionId: parsed.sessionId }, parsed.sessionId);
            }
            if (parsed.usage)
                this.emit(input.sessionId, input.turnId, { type: 'usage-updated', usage: parsed.usage }, parsed.sessionId);
            if (result.exitCode === 0)
                this.emit(input.sessionId, input.turnId, { type: 'turn-completed', output: parsed.output }, parsed.sessionId);
            else if (abort.signal.aborted)
                this.emit(input.sessionId, input.turnId, { type: 'turn-cancelled', reason: 'Cancelled' }, parsed.sessionId);
            else
                this.emit(input.sessionId, input.turnId, { type: 'turn-failed', error: result.stderr ?? `Exited with code ${result.exitCode}` }, parsed.sessionId);
        }).catch((error) => {
            this.emit(input.sessionId, input.turnId, abort.signal.aborted
                ? { type: 'turn-cancelled', reason: 'Cancelled', uncertain: true }
                : { type: 'turn-failed', error: error instanceof Error ? error.message : String(error) });
        }).finally(() => {
            this.turns.delete(input.sessionId);
        });
        return { sessionId: input.sessionId, turnId: input.turnId };
    }
    async cancelTurn(input) {
        this.turns.get(input.sessionId)?.abort(input.reason);
    }
    async resolveInteraction(_input) {
        throw new Error('Headless CLI harness has no attributed interaction channel');
    }
    async closeSession(input) {
        this.turns.get(input.sessionId)?.abort(input.reason);
        this.turns.delete(input.sessionId);
        this.sessions.delete(input.sessionId);
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    emit(sessionId, turnId, event, nativeSessionId) {
        const envelope = {
            harnessId: this.id,
            sessionId,
            nativeSessionId,
            turnId,
            event,
        };
        for (const listener of this.listeners)
            listener(envelope);
    }
}
exports.HeadlessCliHarness = HeadlessCliHarness;
