"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodexAppServerHarness = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const codexAppServerClient_1 = require("../protocols/codexAppServerClient");
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
function codexQuestions(value) {
    if (!Array.isArray(value))
        return [];
    return value.flatMap((candidate) => {
        const question = record(candidate);
        const id = stringField(question, 'id');
        const prompt = stringField(question, 'question');
        if (!id || !prompt)
            return [];
        const choices = Array.isArray(question.options)
            ? question.options.flatMap((candidateOption) => {
                const label = stringField(candidateOption, 'label');
                return label ? [label] : [];
            })
            : undefined;
        return [{
                id,
                question: prompt,
                ...(stringField(question, 'header') ? { header: stringField(question, 'header') } : {}),
                ...(choices?.length ? { choices } : {}),
                ...(question.isOther === true ? { isOther: true } : {}),
                ...(question.isSecret === true ? { isSecret: true } : {}),
            }];
    });
}
class CodexAppServerHarness {
    deps;
    id = 'codex:app-server';
    agentId = 'codex';
    // '3': protocol-specific approval, permission, and multi-question replies.
    adapterVersion = '3';
    declaredCapabilities = {
        transport: 'app-server', auth: 'vendor-owned', streaming: 'token', reasoning: true,
        toolEvents: true, approvals: 'protocol', questions: true, interrupt: true,
        steering: true, liveQueue: true, resume: 'native', multipleSessionsPerProcess: true,
        images: true, compaction: true, usage: 'streaming', dynamicTools: 'native', nativeTui: false,
    };
    listeners = new Set();
    sessions = new Map();
    turns = new Map();
    interactions = new Map();
    client = null;
    constructor(deps) {
        this.deps = deps;
    }
    async detect(_ctx) {
        const binary = await this.deps.binaryPath();
        return binary ? { available: true, binaryPath: binary.path, version: binary.version } : { available: false, reason: 'Codex is not installed' };
    }
    async probe() {
        const detected = await this.detect({ agentId: this.agentId });
        const fingerprint = node_crypto_1.default.createHash('sha256').update(JSON.stringify({
            id: this.id, path: detected.binaryPath, version: detected.version, adapterVersion: this.adapterVersion,
        })).digest('hex');
        if (!detected.available)
            return {
                state: 'failed', capabilities: {}, checkedAt: Date.now(), adapterVersion: this.adapterVersion,
                fingerprint, reason: detected.reason,
            };
        try {
            const client = this.makeClient(detected.binaryPath);
            await client.initialize();
            await client.close();
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
    }
    async createSession(input) {
        const client = await this.getClient();
        const tools = this.createToolPrincipal(input);
        let response;
        try {
            response = await client.startThread({
                cwd: input.workspacePath,
                ...(input.model ? { model: input.model } : {}),
                ...(tools.dynamicTools.length ? { dynamicTools: tools.dynamicTools } : {}),
                // A structured background session must not inherit a user-level
                // dangerous bypass. Explicit policy requests are narrowed further:
                // ask/deny sessions start read-only and can only expand through a
                // protocol-attributed approval.
                approvalPolicy: input.permissionPolicy?.defaultDecision === 'deny' ? 'never' : 'untrusted',
                approvalsReviewer: 'user',
                sandbox: input.permissionPolicy ? 'read-only' : 'workspace-write',
                experimentalRawEvents: false,
            });
        }
        catch (error) {
            if (tools.principalId)
                this.deps.toolGateway?.revokePrincipal(tools.principalId);
            throw error;
        }
        const nativeSessionId = stringField(response, 'threadId', 'thread_id', 'id')
            ?? stringField(record(response).thread, 'id', 'threadId');
        if (!nativeSessionId)
            throw new Error('Codex app-server did not return a thread id');
        this.sessions.set(input.sessionId, {
            nativeSessionId,
            toolPrincipalId: tools.principalId,
            toolCapabilityToken: tools.capabilityToken,
            toolPermissions: input.toolPermissions,
            projectId: input.projectId,
            workspacePath: input.workspacePath,
            orchestrationId: input.orchestrationId,
            toolNames: tools.toolNames,
        });
        return { sessionId: input.sessionId, nativeSessionId };
    }
    async loadSession(input) {
        const client = await this.getClient();
        const tools = this.createToolPrincipal(input);
        let response;
        try {
            response = await client.resumeThread(input.nativeSessionId, { cwd: input.workspacePath });
        }
        catch (error) {
            if (tools.principalId)
                this.deps.toolGateway?.revokePrincipal(tools.principalId);
            throw error;
        }
        const loaded = stringField(response, 'threadId', 'thread_id', 'id')
            ?? stringField(record(response).thread, 'id', 'threadId')
            ?? input.nativeSessionId;
        if (loaded !== input.nativeSessionId)
            throw new Error('Codex resumed a different thread');
        this.sessions.set(input.sessionId, {
            nativeSessionId: input.nativeSessionId,
            toolPrincipalId: tools.principalId,
            toolCapabilityToken: tools.capabilityToken,
            toolPermissions: input.toolPermissions,
            projectId: input.projectId,
            workspacePath: input.workspacePath,
            orchestrationId: input.orchestrationId,
            toolNames: tools.toolNames,
        });
        return { sessionId: input.sessionId, nativeSessionId: input.nativeSessionId };
    }
    async sendTurn(input) {
        const binding = this.sessions.get(input.sessionId);
        const nativeSessionId = binding?.nativeSessionId;
        if (!nativeSessionId)
            throw new Error('Codex thread is not loaded');
        if (binding.toolPermissions?.length)
            this.refreshToolPrincipal(input.sessionId, input.runId);
        const client = await this.getClient();
        const response = await client.startTurn(nativeSessionId, [
            { type: 'text', text: input.prompt.text },
            ...(input.prompt.images ?? []).map((image) => ({ type: 'localImage', path: image.path })),
        ]);
        const nativeTurnId = stringField(response, 'turnId', 'turn_id', 'id')
            ?? stringField(record(response).turn, 'id', 'turnId');
        this.turns.set(input.sessionId, { publicTurnId: input.turnId, nativeTurnId, output: '' });
        this.emit(input.sessionId, input.turnId, { type: 'turn-started' }, nativeSessionId);
        return { sessionId: input.sessionId, turnId: input.turnId };
    }
    async cancelTurn(input) {
        const nativeSessionId = this.sessions.get(input.sessionId)?.nativeSessionId;
        const turn = this.turns.get(input.sessionId);
        if (!nativeSessionId || !turn?.nativeTurnId)
            throw new Error('Codex turn identity is unavailable; cancellation outcome is uncertain');
        for (const [interactionId, pending] of this.interactions) {
            if (pending.sessionId !== input.sessionId || pending.turnId !== input.turnId)
                continue;
            this.interactions.delete(interactionId);
            pending.resolve(this.cancelledInteractionResult(pending));
        }
        await (await this.getClient()).interruptTurn(nativeSessionId, turn.nativeTurnId);
    }
    async resolveInteraction(input) {
        const pending = this.interactions.get(input.interactionId);
        if (!pending || pending.sessionId !== input.sessionId || pending.turnId !== input.turnId) {
            throw new Error('Codex interaction no longer belongs to this turn');
        }
        const expected = Buffer.from(pending.capabilityToken);
        const supplied = Buffer.from(input.capabilityToken);
        if (expected.length !== supplied.length || !node_crypto_1.default.timingSafeEqual(expected, supplied))
            throw new Error('Interaction capability is invalid');
        this.interactions.delete(input.interactionId);
        let result;
        if (pending.kind === 'question') {
            const answers = input.answers
                ? Object.fromEntries(Object.entries(input.answers).map(([id, values]) => [
                    id,
                    { answers: values },
                ]))
                : this.questionAnswers(pending, input.answer);
            result = { answers };
        }
        else if (pending.kind === 'permission-profile') {
            const allowed = input.decision === 'allow-once' || input.decision === 'allow-session';
            result = {
                permissions: allowed ? pending.requestedPermissions ?? {} : {},
                scope: input.decision === 'allow-session' ? 'session' : 'turn',
            };
        }
        else if (pending.kind === 'legacy-approval') {
            result = {
                decision: input.decision === 'allow-session' ? 'approved_for_session'
                    : input.decision === 'allow-once' ? 'approved'
                        : { denied: { rejection: 'Denied by the user in 1DevTool' } },
            };
        }
        else {
            result = {
                decision: input.decision === 'allow-session' ? 'acceptForSession'
                    : input.decision === 'allow-once' ? 'accept'
                        : 'decline',
            };
        }
        pending.resolve(result);
        this.emit(pending.sessionId, pending.turnId, pending.kind === 'question'
            ? { type: 'question-resolved', interactionId: input.interactionId }
            : {
                type: 'approval-resolved',
                interactionId: input.interactionId,
                decision: input.decision ?? 'deny',
            }, pending.nativeSessionId);
    }
    async closeSession(input) {
        const binding = this.sessions.get(input.sessionId);
        if (binding?.toolPrincipalId)
            this.deps.toolGateway?.revokePrincipal(binding.toolPrincipalId);
        this.sessions.delete(input.sessionId);
        this.turns.delete(input.sessionId);
        for (const [id, pending] of this.interactions) {
            if (pending.sessionId !== input.sessionId)
                continue;
            this.interactions.delete(id);
            pending.reject(new Error(input.reason ?? 'Codex session closed'));
        }
    }
    /** Release the resident app-server (release-lane/tests and app shutdown). */
    async shutdown() {
        for (const sessionId of [...this.sessions.keys()]) {
            await this.closeSession({ sessionId, reason: 'Harness shutdown' });
        }
        const client = this.client;
        this.client = null;
        await client?.close();
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    async getClient() {
        if (this.client)
            return this.client;
        const detected = await this.detect({ agentId: this.agentId });
        if (!detected.available || !detected.binaryPath)
            throw new Error(detected.reason ?? 'Codex is unavailable');
        const client = this.makeClient(detected.binaryPath);
        client.onNotification((event) => this.onNotification(event.method, event.params));
        client.onExit((event) => {
            for (const [sessionId, binding] of this.sessions) {
                const turnId = this.turns.get(sessionId)?.publicTurnId;
                this.revokeToolPrincipal(sessionId);
                this.emit(sessionId, turnId, { type: 'adapter-exited', code: event.code ?? undefined, signal: event.signal ?? undefined, error: event.stderr || undefined }, binding.nativeSessionId);
            }
            this.client = null;
        });
        client.setServerRequestHandler((request) => this.onServerRequest(request.method, request.params));
        await client.initialize();
        this.client = client;
        return client;
    }
    makeClient(binaryPath) {
        const options = { binaryPath, ...this.deps.clientOptions };
        return this.deps.clientFactory?.(options) ?? new codexAppServerClient_1.CodexAppServerClient(options);
    }
    onNotification(method, params) {
        const data = record(params);
        const nativeSessionId = stringField(data, 'threadId', 'thread_id') ?? stringField(data.thread, 'id');
        const sessionId = [...this.sessions].find(([, binding]) => binding.nativeSessionId === nativeSessionId)?.[0];
        if (!sessionId)
            return;
        const turn = this.turns.get(sessionId);
        const turnId = turn?.publicTurnId;
        const item = record(data.item);
        const itemId = stringField(data, 'itemId', 'item_id') ?? stringField(item, 'id');
        const text = stringField(data, 'delta', 'text') ?? stringField(item, 'text');
        if (/agentMessage.*delta|item\/agentMessage\/delta/i.test(method) && text) {
            if (turn)
                turn.output += text;
            this.emit(sessionId, turnId, { type: 'text-delta', text }, nativeSessionId, itemId);
        }
        else if (/reasoning.*delta/i.test(method) && text) {
            this.emit(sessionId, turnId, { type: 'reasoning-delta', text }, nativeSessionId, itemId);
        }
        else if (/item\/started|item\.started/i.test(method)) {
            const toolName = stringField(item, 'name', 'toolName') ?? stringField(data, 'toolName');
            if (toolName)
                this.emit(sessionId, turnId, { type: 'tool-started', toolName, input: item.input ?? data.input }, nativeSessionId, itemId);
        }
        else if (/item\/completed|item\.completed/i.test(method)) {
            const type = stringField(item, 'type');
            const itemText = stringField(item, 'text');
            if (type === 'agentMessage' && itemText && turn && !turn.output.includes(itemText))
                turn.output += itemText;
            else if (type && /tool|command/i.test(type))
                this.emit(sessionId, turnId, { type: 'tool-completed', output: item.output, error: stringField(item, 'error') }, nativeSessionId, itemId);
        }
        else if (/turn\/completed|turn\.completed/i.test(method)) {
            const turnStatus = stringField(record(data.turn), 'status') ?? stringField(data, 'status');
            const usage = record(data.usage);
            if (typeof usage.inputTokens === 'number' || typeof usage.input_tokens === 'number') {
                this.emit(sessionId, turnId, {
                    type: 'usage-updated',
                    usage: {
                        inputTokens: Number(usage.inputTokens ?? usage.input_tokens ?? 0),
                        outputTokens: Number(usage.outputTokens ?? usage.output_tokens ?? 0),
                    },
                }, nativeSessionId);
            }
            if (turnStatus && /interrupt|cancel/i.test(turnStatus)) {
                this.emit(sessionId, turnId, { type: 'turn-cancelled', reason: turnStatus }, nativeSessionId);
            }
            else if (turnStatus && /fail|error/i.test(turnStatus)) {
                this.emit(sessionId, turnId, { type: 'turn-failed', error: stringField(record(data.turn), 'error') ?? `Codex turn ended ${turnStatus}` }, nativeSessionId);
            }
            else {
                this.emit(sessionId, turnId, { type: 'turn-completed', output: turn?.output }, nativeSessionId);
            }
            this.turns.delete(sessionId);
            this.revokeToolPrincipal(sessionId);
        }
        else if (/turn\/(failed|error)|turn\.(failed|error)/i.test(method)) {
            this.emit(sessionId, turnId, { type: 'turn-failed', error: stringField(data, 'error', 'message') ?? 'Codex turn failed' }, nativeSessionId);
            this.turns.delete(sessionId);
            this.revokeToolPrincipal(sessionId);
        }
    }
    onServerRequest(method, params) {
        const data = record(params);
        const nativeSessionId = stringField(data, 'threadId', 'thread_id', 'conversationId');
        const sessionId = [...this.sessions].find(([, binding]) => binding.nativeSessionId === nativeSessionId)?.[0];
        const turn = sessionId ? this.turns.get(sessionId) : undefined;
        if (!nativeSessionId || !sessionId || !turn) {
            return Promise.reject(new Error('Codex request is missing exact session/turn attribution'));
        }
        const nativeTurnId = stringField(data, 'turnId', 'turn_id');
        if (nativeTurnId && turn.nativeTurnId && nativeTurnId !== turn.nativeTurnId) {
            return Promise.reject(new Error('Codex request belongs to a different native turn'));
        }
        if (method === 'item/tool/call')
            return this.onDynamicToolCall(sessionId, turn.publicTurnId, data);
        const questions = method === 'item/tool/requestUserInput' ? codexQuestions(data.questions) : undefined;
        const kind = method === 'item/tool/requestUserInput' ? 'question'
            : method === 'item/permissions/requestApproval' ? 'permission-profile'
                : method === 'execCommandApproval' || method === 'applyPatchApproval' ? 'legacy-approval'
                    : method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval'
                        ? 'modern-approval'
                        : (() => { throw new Error(`Unsupported Codex server request: ${method}`); })();
        if (kind === 'question' && !questions?.length) {
            return Promise.reject(new Error('Codex user-input request did not contain a valid question'));
        }
        const interactionId = node_crypto_1.default.randomUUID();
        const capabilityToken = node_crypto_1.default.randomBytes(32).toString('base64url');
        return new Promise((resolve, reject) => {
            this.interactions.set(interactionId, {
                sessionId,
                turnId: turn.publicTurnId,
                nativeSessionId,
                capabilityToken,
                kind,
                method,
                questions,
                ...(kind === 'permission-profile' ? { requestedPermissions: record(data.permissions) } : {}),
                resolve,
                reject,
            });
            this.emit(sessionId, turn.publicTurnId, kind === 'question' ? {
                type: 'question-requested', interactionId, capabilityToken,
                question: questions.length === 1
                    ? questions[0].question
                    : questions.map((question, index) => `${index + 1}. ${question.question}`).join('\n'),
                ...(questions[0].choices?.length ? { choices: questions[0].choices } : {}),
                questions,
                expiresAt: Date.now() + 10 * 60_000,
            } : {
                type: 'approval-requested', interactionId, capabilityToken,
                title: stringField(data, 'reason', 'title', 'command')
                    ?? (kind === 'permission-profile' ? 'Codex requests additional permissions' : method),
                input: data,
                risk: kind === 'permission-profile' && record(data.permissions).network ? 'network'
                    : /file|edit|write|patch/i.test(method) ? 'write'
                        : /command|exec/i.test(method) ? 'process'
                            : 'unknown',
                expiresAt: Date.now() + 10 * 60_000,
                canRemember: true,
            }, nativeSessionId);
        });
    }
    questionAnswers(pending, answer) {
        const questions = pending.questions ?? [];
        if (questions.length === 0)
            throw new Error('Codex question metadata is unavailable');
        if (typeof answer === 'string') {
            if (questions.length !== 1)
                throw new Error('Codex requested multiple answers');
            return { [questions[0].id]: { answers: [answer] } };
        }
        if (Array.isArray(answer)) {
            if (questions.length === 1)
                return { [questions[0].id]: { answers: answer } };
            if (answer.length !== questions.length)
                throw new Error('Codex answer count does not match its questions');
            return Object.fromEntries(questions.map((question, index) => [
                question.id,
                { answers: [answer[index]] },
            ]));
        }
        throw new Error('Codex question requires an answer');
    }
    cancelledInteractionResult(pending) {
        if (pending.kind === 'question')
            return { answers: {} };
        if (pending.kind === 'permission-profile')
            return { permissions: {}, scope: 'turn' };
        if (pending.kind === 'legacy-approval')
            return { decision: 'abort' };
        return { decision: 'cancel' };
    }
    createToolPrincipal(input) {
        const gateway = this.deps.toolGateway;
        const permissions = input.toolPermissions ?? [];
        if (!gateway || permissions.length === 0)
            return { dynamicTools: [] };
        const principalId = `codex:${input.sessionId}`;
        const lease = gateway.createPrincipal({
            principalId,
            projectId: input.projectId,
            workspacePath: input.workspacePath,
            sessionId: input.sessionId,
            runId: input.runId,
            teamId: input.orchestrationId,
            permissions,
        });
        const toolNames = {};
        const dynamicTools = gateway.definitions(principalId).map((tool) => {
            const alias = tool.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
            if (!alias || toolNames[alias])
                throw new Error(`Dynamic tool name collision for ${tool.name}`);
            toolNames[alias] = tool.name;
            return {
                type: 'function',
                name: alias,
                description: tool.description,
                inputSchema: tool.inputSchema,
            };
        });
        return { principalId, capabilityToken: lease.capabilityToken, dynamicTools, toolNames };
    }
    refreshToolPrincipal(sessionId, runId) {
        const binding = this.sessions.get(sessionId);
        const gateway = this.deps.toolGateway;
        if (!binding?.toolPermissions?.length || !gateway)
            return;
        const principalId = `codex:${sessionId}`;
        const lease = gateway.createPrincipal({
            principalId,
            projectId: binding.projectId,
            workspacePath: binding.workspacePath,
            sessionId,
            runId,
            teamId: binding.orchestrationId,
            permissions: binding.toolPermissions,
        });
        binding.toolPrincipalId = principalId;
        binding.toolCapabilityToken = lease.capabilityToken;
    }
    revokeToolPrincipal(sessionId) {
        const binding = this.sessions.get(sessionId);
        if (!binding?.toolPrincipalId)
            return;
        this.deps.toolGateway?.revokePrincipal(binding.toolPrincipalId);
        delete binding.toolPrincipalId;
        delete binding.toolCapabilityToken;
    }
    async onDynamicToolCall(sessionId, publicTurnId, data) {
        const binding = this.sessions.get(sessionId);
        const gateway = this.deps.toolGateway;
        const nativeTurnId = stringField(data, 'turnId', 'turn_id');
        const active = this.turns.get(sessionId);
        if (!binding?.toolPrincipalId || !binding.toolCapabilityToken || !gateway || active?.publicTurnId !== publicTurnId) {
            throw new Error('Codex dynamic tool call has no active scoped principal');
        }
        if (nativeTurnId && active.nativeTurnId && nativeTurnId !== active.nativeTurnId) {
            throw new Error('Codex dynamic tool call belongs to a different native turn');
        }
        const callId = stringField(data, 'callId', 'call_id');
        const toolName = stringField(data, 'tool');
        if (!callId || !toolName)
            throw new Error('Codex dynamic tool call is missing callId or tool');
        const result = await gateway.invoke(binding.toolPrincipalId, {
            callId,
            toolName: binding.toolNames?.[toolName] ?? toolName,
            input: data.arguments,
            capabilityToken: binding.toolCapabilityToken,
        });
        const value = result.ok ? result.output : result.error;
        const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
        return {
            contentItems: [{ type: 'inputText', text: text.slice(0, 64_000) }],
            success: result.ok,
        };
    }
    emit(sessionId, turnId, event, nativeSessionId, itemId) {
        const envelope = { harnessId: this.id, sessionId, nativeSessionId, turnId, itemId, event };
        for (const listener of this.listeners)
            listener(envelope);
    }
}
exports.CodexAppServerHarness = CodexAppServerHarness;
