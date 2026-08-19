"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AcpHarness = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const acpClient_1 = require("../protocols/acpClient");
function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function stringField(value, ...keys) {
    const source = record(value);
    for (const key of keys)
        if (typeof source[key] === 'string')
            return source[key];
    return undefined;
}
function permissionOptions(value) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((candidate) => {
        const option = record(candidate);
        const optionId = stringField(option, 'optionId');
        const kind = stringField(option, 'kind');
        if (!optionId || ![
            'allow_once', 'allow_always', 'reject_once', 'reject_always',
        ].includes(kind ?? ''))
            return [];
        return [{ optionId, kind: kind }];
    });
}
/** Generic one-ACP-child-per-public-session adapter. */
class AcpHarness {
    deps;
    id;
    agentId;
    // '3': ACP nd-JSON framing + spec-shaped permission outcomes.
    adapterVersion = '3';
    declaredCapabilities = {
        transport: 'acp', auth: 'vendor-owned', streaming: 'message', reasoning: true,
        toolEvents: true, approvals: 'protocol', questions: true, interrupt: true,
        steering: false, liveQueue: false, resume: 'native', multipleSessionsPerProcess: false,
        // ACP can expose MCP tools only after we provide it with an authenticated,
        // run-scoped MCP endpoint. Keep this honest until that endpoint is wired.
        images: true, compaction: false, usage: 'final', dynamicTools: 'none', nativeTui: false,
    };
    sessions = new Map();
    interactions = new Map();
    listeners = new Set();
    constructor(deps) {
        this.deps = deps;
        this.agentId = deps.agentId;
        this.id = `${deps.agentId}:acp`;
    }
    async detect(_ctx) {
        const binary = await this.deps.binaryPath();
        return binary ? { available: true, binaryPath: binary.path, version: binary.version } : { available: false, reason: `${this.agentId} ACP executable is unavailable` };
    }
    async probe(ctx) {
        const detected = await this.detect({ agentId: this.agentId });
        const fingerprint = node_crypto_1.default.createHash('sha256').update(JSON.stringify({
            id: this.id, path: detected.binaryPath, version: detected.version, args: this.deps.args,
            adapterVersion: this.adapterVersion,
        })).digest('hex');
        if (!detected.available || !detected.binaryPath)
            return {
                state: 'failed', capabilities: {}, checkedAt: Date.now(), adapterVersion: this.adapterVersion,
                fingerprint, reason: detected.reason,
            };
        const client = this.makeClient(detected.binaryPath, process.cwd());
        try {
            await client.initialize(ctx?.timeoutMs);
            return {
                state: 'verified', capabilities: this.declaredCapabilities, checkedAt: Date.now(),
                binaryPath: detected.binaryPath, binaryVersion: detected.version,
                adapterVersion: this.adapterVersion, fingerprint,
            };
        }
        catch (error) {
            return {
                state: 'failed', capabilities: {}, checkedAt: Date.now(), binaryPath: detected.binaryPath,
                binaryVersion: detected.version, adapterVersion: this.adapterVersion, fingerprint,
                reason: error instanceof Error ? error.message : String(error),
            };
        }
        finally {
            await client.close();
        }
    }
    async createSession(input) {
        if (this.sessions.has(input.sessionId))
            return { sessionId: input.sessionId, nativeSessionId: this.sessions.get(input.sessionId).nativeSessionId };
        const client = await this.createClient(input.sessionId, input.workspacePath);
        try {
            const response = await client.newSession(input.workspacePath);
            const nativeSessionId = stringField(response, 'sessionId', 'session_id', 'id')
                ?? stringField(record(response).session, 'id', 'sessionId');
            if (!nativeSessionId) {
                throw new Error('ACP agent did not return a native session id');
            }
            this.sessions.set(input.sessionId, { client, nativeSessionId, output: '' });
            return { sessionId: input.sessionId, nativeSessionId };
        }
        catch (error) {
            // A vendor may authenticate successfully during initialize and reject
            // session/new afterward. Until a session is registered, closeSession()
            // cannot find this client; close it here so a failed release lane or
            // production create never leaves an orphan ACP daemon.
            await client.close();
            throw error;
        }
    }
    async loadSession(input) {
        const existing = this.sessions.get(input.sessionId);
        if (existing) {
            if (existing.nativeSessionId !== input.nativeSessionId)
                throw new Error('ACP public session is bound to a different native session');
            return { sessionId: input.sessionId, nativeSessionId: input.nativeSessionId };
        }
        const client = await this.createClient(input.sessionId, input.workspacePath);
        try {
            const response = await client.loadSession(input.nativeSessionId, input.workspacePath);
            const loaded = stringField(response, 'sessionId', 'session_id', 'id')
                ?? stringField(record(response).session, 'id', 'sessionId')
                ?? input.nativeSessionId;
            if (loaded !== input.nativeSessionId) {
                throw new Error('ACP agent loaded a different native session');
            }
            this.sessions.set(input.sessionId, { client, nativeSessionId: input.nativeSessionId, output: '' });
            return { sessionId: input.sessionId, nativeSessionId: input.nativeSessionId };
        }
        catch (error) {
            await client.close();
            throw error;
        }
    }
    async sendTurn(input) {
        const session = this.sessions.get(input.sessionId);
        if (!session)
            throw new Error('ACP session is not loaded');
        if (session.activeTurnId)
            throw new Error('ACP session already has an active turn');
        session.activeTurnId = input.turnId;
        session.output = '';
        const prompt = [
            { type: 'text', text: input.prompt.text },
            ...(input.prompt.images ?? []).map((image) => image.path
                ? { type: 'resource_link', uri: `file://${image.path}`, name: image.path }
                : { type: 'image', mimeType: image.mimeType, data: image.data }),
        ];
        const completion = session.client.prompt(session.nativeSessionId, prompt);
        this.emit(input.sessionId, input.turnId, { type: 'turn-started' }, session.nativeSessionId);
        void completion.then((response) => {
            const stopReason = stringField(response, 'stopReason', 'stop_reason');
            if (stopReason && /cancel/i.test(stopReason)) {
                this.emit(input.sessionId, input.turnId, { type: 'turn-cancelled', reason: stopReason }, session.nativeSessionId);
            }
            else {
                this.emit(input.sessionId, input.turnId, { type: 'turn-completed', output: session.output }, session.nativeSessionId);
            }
        }).catch((error) => {
            this.emit(input.sessionId, input.turnId, { type: 'turn-failed', error: error instanceof Error ? error.message : String(error) }, session.nativeSessionId);
        }).finally(() => {
            if (session.activeTurnId === input.turnId)
                delete session.activeTurnId;
        });
        return { sessionId: input.sessionId, turnId: input.turnId };
    }
    async cancelTurn(input) {
        const session = this.sessions.get(input.sessionId);
        if (!session || session.activeTurnId !== input.turnId)
            return;
        // ACP requires clients to settle every outstanding permission request as
        // cancelled before cancelling the prompt turn.
        for (const [interactionId, pending] of this.interactions) {
            if (pending.sessionId !== input.sessionId || pending.turnId !== input.turnId)
                continue;
            this.interactions.delete(interactionId);
            if (pending.kind === 'approval')
                pending.resolve({ outcome: { outcome: 'cancelled' } });
            else
                pending.reject(new Error(input.reason ?? 'ACP turn cancelled'));
        }
        session.client.cancel(session.nativeSessionId);
    }
    async resolveInteraction(input) {
        const pending = this.interactions.get(input.interactionId);
        if (!pending || pending.sessionId !== input.sessionId || pending.turnId !== input.turnId) {
            throw new Error('ACP interaction no longer belongs to this turn');
        }
        const expected = Buffer.from(pending.capabilityToken);
        const supplied = Buffer.from(input.capabilityToken);
        if (expected.length !== supplied.length || !node_crypto_1.default.timingSafeEqual(expected, supplied))
            throw new Error('Interaction capability is invalid');
        this.interactions.delete(input.interactionId);
        if (pending.kind === 'question') {
            pending.resolve({ answer: input.answer });
            return;
        }
        const desiredKind = input.decision === 'allow-session'
            ? 'allow_always'
            : input.decision === 'allow-once'
                ? 'allow_once'
                : 'reject_once';
        const chosen = pending.permissionOptions?.find((option) => option.kind === desiredKind)
            ?? (input.decision === 'deny'
                ? pending.permissionOptions?.find((option) => option.kind.startsWith('reject_'))
                : pending.permissionOptions?.find((option) => option.kind.startsWith('allow_')));
        pending.resolve(chosen
            ? { outcome: { outcome: 'selected', optionId: chosen.optionId } }
            : { outcome: { outcome: 'cancelled' } });
    }
    async closeSession(input) {
        const session = this.sessions.get(input.sessionId);
        if (!session)
            return;
        this.sessions.delete(input.sessionId);
        for (const [id, interaction] of this.interactions) {
            if (interaction.sessionId !== input.sessionId)
                continue;
            this.interactions.delete(id);
            interaction.reject(new Error(input.reason ?? 'ACP session closed'));
        }
        await session.client.close();
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    async createClient(sessionId, cwd) {
        const detected = await this.detect({ agentId: this.agentId });
        if (!detected.available || !detected.binaryPath)
            throw new Error(detected.reason ?? 'ACP agent is unavailable');
        const client = this.makeClient(detected.binaryPath, cwd);
        client.onNotification((event) => this.onNotification(sessionId, event.method, event.params));
        client.onExit((event) => {
            const session = this.sessions.get(sessionId);
            this.emit(sessionId, session?.activeTurnId, {
                type: 'adapter-exited', code: event.code ?? undefined, signal: event.signal ?? undefined,
                error: event.stderr || undefined,
            }, session?.nativeSessionId);
            for (const [id, interaction] of this.interactions) {
                if (interaction.sessionId !== sessionId)
                    continue;
                this.interactions.delete(id);
                interaction.reject(new Error('ACP adapter exited'));
            }
        });
        client.setRequestHandler((method, params) => this.onRequest(sessionId, method, params));
        await client.initialize();
        return client;
    }
    makeClient(binaryPath, cwd) {
        const options = {
            binaryPath,
            args: this.deps.args,
            cwd,
            ...this.deps.clientOptions,
        };
        return this.deps.clientFactory?.(options) ?? new acpClient_1.AcpClient(options);
    }
    onNotification(sessionId, method, params) {
        const session = this.sessions.get(sessionId);
        if (!session || !/session\/update|session\.update/i.test(method))
            return;
        const data = record(params);
        const update = record(data.update);
        const kind = stringField(update, 'sessionUpdate', 'type', 'kind') ?? '';
        const content = record(update.content);
        const text = stringField(content, 'text') ?? stringField(update, 'text', 'delta');
        const turnId = session.activeTurnId;
        if (/agent.*message.*chunk|message.*delta/i.test(kind) && text) {
            session.output += text;
            this.emit(sessionId, turnId, { type: 'text-delta', text }, session.nativeSessionId);
        }
        else if (/thought|reasoning/i.test(kind) && text) {
            this.emit(sessionId, turnId, { type: 'reasoning-delta', text }, session.nativeSessionId);
        }
        else if (/tool.*call$/i.test(kind)) {
            this.emit(sessionId, turnId, {
                type: 'tool-started',
                toolName: stringField(update, 'title', 'toolName', 'name') ?? 'tool',
                title: stringField(update, 'title'),
                input: update.rawInput ?? update.input,
            }, session.nativeSessionId, stringField(update, 'toolCallId', 'id'));
        }
        else if (/tool.*update|tool.*completed/i.test(kind)) {
            const status = stringField(update, 'status');
            if (status && /completed|failed/i.test(status)) {
                this.emit(sessionId, turnId, { type: 'tool-completed', output: update.rawOutput ?? update.output, error: /failed/i.test(status) ? stringField(update, 'error') ?? status : undefined }, session.nativeSessionId, stringField(update, 'toolCallId', 'id'));
            }
            else {
                this.emit(sessionId, turnId, { type: 'tool-progress', message: stringField(update, 'title', 'message') }, session.nativeSessionId, stringField(update, 'toolCallId', 'id'));
            }
        }
        else if (/usage/i.test(kind)) {
            this.emit(sessionId, turnId, {
                type: 'usage-updated',
                usage: {
                    inputTokens: Number(update.inputTokens ?? update.input_tokens ?? 0),
                    outputTokens: Number(update.outputTokens ?? update.output_tokens ?? 0),
                },
            }, session.nativeSessionId);
        }
    }
    onRequest(sessionId, method, params) {
        const session = this.sessions.get(sessionId);
        if (!session?.activeTurnId)
            return Promise.reject(new Error('ACP request has no exact active turn'));
        const interactionId = node_crypto_1.default.randomUUID();
        const capabilityToken = node_crypto_1.default.randomBytes(32).toString('base64url');
        const data = record(params);
        const question = /question|input/i.test(method);
        const options = question ? undefined : permissionOptions(data.options);
        return new Promise((resolve, reject) => {
            this.interactions.set(interactionId, {
                sessionId,
                turnId: session.activeTurnId,
                capabilityToken,
                kind: question ? 'question' : 'approval',
                permissionOptions: options,
                resolve,
                reject,
            });
            this.emit(sessionId, session.activeTurnId, question ? {
                type: 'question-requested', interactionId, capabilityToken,
                question: stringField(data, 'question', 'prompt', 'title') ?? 'Agent needs input',
                expiresAt: Date.now() + 10 * 60_000,
            } : {
                type: 'approval-requested', interactionId, capabilityToken,
                title: stringField(data, 'title', 'name')
                    ?? stringField(data.toolCall, 'title', 'name')
                    ?? method,
                input: data.toolCall ?? data,
                risk: /network/i.test(method) ? 'network'
                    : /file|edit|write/i.test(method) ? 'write'
                        : /terminal|command/i.test(method) ? 'process'
                            : 'unknown',
                expiresAt: Date.now() + 10 * 60_000,
                canRemember: Boolean(options?.some((option) => option.kind === 'allow_always')),
            }, session.nativeSessionId);
        });
    }
    emit(sessionId, turnId, event, nativeSessionId, itemId) {
        const envelope = { harnessId: this.id, sessionId, nativeSessionId, turnId, itemId, event };
        for (const listener of this.listeners)
            listener(envelope);
    }
}
exports.AcpHarness = AcpHarness;
