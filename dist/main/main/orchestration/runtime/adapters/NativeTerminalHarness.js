"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NativeTerminalHarness = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
class NativeTerminalHarness {
    deps;
    id;
    agentId;
    adapterVersion = '1';
    declaredCapabilities = {
        transport: 'pty',
        auth: 'vendor-owned',
        streaming: 'message',
        reasoning: false,
        toolEvents: false,
        approvals: 'tui',
        questions: true,
        interrupt: true,
        steering: true,
        liveQueue: true,
        resume: 'native',
        multipleSessionsPerProcess: false,
        images: true,
        compaction: true,
        usage: 'none',
        dynamicTools: 'mcp',
        nativeTui: true,
    };
    listeners = new Set();
    constructor(deps) {
        this.deps = deps;
        this.agentId = deps.agentId;
        this.id = `${deps.agentId}:native-terminal`;
    }
    detect(_ctx) {
        return this.deps.detect();
    }
    async probe() {
        const detected = await this.deps.detect();
        const fingerprint = node_crypto_1.default.createHash('sha256').update(JSON.stringify({
            id: this.id,
            path: detected.binaryPath,
            version: detected.version,
            adapterVersion: this.adapterVersion,
        })).digest('hex');
        return {
            // TUI feature behavior needs real terminal/device verification; binary
            // detection alone is deliberately not promoted to verified.
            state: detected.available ? 'unknown' : 'failed',
            capabilities: {},
            checkedAt: Date.now(),
            binaryPath: detected.binaryPath,
            binaryVersion: detected.version,
            adapterVersion: this.adapterVersion,
            fingerprint,
            reason: detected.available ? 'Native terminal conformance probe has not run' : detected.reason,
        };
    }
    createSession(input) {
        return this.deps.create(input);
    }
    loadSession(input) {
        return this.deps.load(input);
    }
    async sendTurn(input) {
        await this.deps.send(input);
        return { sessionId: input.sessionId, turnId: input.turnId };
    }
    cancelTurn(input) {
        return this.deps.cancel(input);
    }
    resolveInteraction(input) {
        if (!this.deps.resolveInteraction)
            throw new Error('Native interaction must be resolved in the vendor TUI');
        return this.deps.resolveInteraction(input);
    }
    closeSession(input) {
        return this.deps.close(input);
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    /** Accept only main-owned, already-attributed PTY/hook lifecycle events. */
    publish(event) {
        if (event.harnessId !== this.id)
            return;
        for (const listener of this.listeners)
            listener(event);
    }
}
exports.NativeTerminalHarness = NativeTerminalHarness;
