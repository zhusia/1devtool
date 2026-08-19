"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AcpClient = void 0;
const node_child_process_1 = require("node:child_process");
const node_readline_1 = __importDefault(require("node:readline"));
const env_1 = require("../../../utils/env");
const spawnSpec_1 = require("../../../utils/spawnSpec");
const processStreamErrors_1 = require("../../../processStreamErrors");
class AcpClient {
    options;
    child = null;
    nextId = 1;
    pending = new Map();
    initialized = false;
    stderr = '';
    notifications = new Set();
    exits = new Set();
    requestHandler = null;
    constructor(options) {
        this.options = options;
    }
    async start() {
        if (this.child)
            return;
        // npm-installed ACP agents are .cmd shims on Windows — a direct spawn
        // throws EINVAL; route through the shared spec builder. Enriched env
        // matches terminal/tool spawns so the shim can find its node runtime.
        const spec = (0, spawnSpec_1.buildSpawnSpec)(this.options.binaryPath, this.options.args);
        const child = (0, node_child_process_1.spawn)(spec.file, spec.args, {
            cwd: this.options.cwd,
            env: this.options.env ?? (0, env_1.getEnrichedEnv)(),
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        });
        this.child = child;
        child.stderr.setEncoding('utf-8');
        child.stderr.on('data', (chunk) => {
            this.stderr = (this.stderr + chunk).slice(-(this.options.stderrCapChars ?? 64_000));
        });
        // ACP stdio is newline-delimited JSON-RPC, not LSP's Content-Length
        // framing. vscode-jsonrpc's StreamMessageReader silently waits for a
        // header that conforming ACP agents never send.
        const lines = node_readline_1.default.createInterface({ input: child.stdout, crlfDelay: Infinity });
        lines.on('line', (line) => this.receive(line));
        (0, processStreamErrors_1.installChildStdinErrorGuard)(child.stdin, (error) => {
            if (this.child === child)
                this.failPending(error);
        });
        child.on('error', (error) => this.failPending(error));
        child.on('exit', (code, signal) => {
            lines.close();
            this.child = null;
            this.initialized = false;
            this.failPending(new Error(`ACP agent exited${code === null ? '' : ` with code ${code}`}`));
            for (const listener of this.exits)
                listener({ code, signal, stderr: this.stderr });
        });
    }
    async initialize(timeoutMs) {
        if (this.initialized)
            return undefined;
        await this.start();
        const result = await this.request('initialize', {
            protocolVersion: 1,
            clientInfo: this.options.clientInfo ?? { name: '1devtool', version: '1' },
            clientCapabilities: this.options.capabilities ?? {},
        }, timeoutMs);
        this.initialized = true;
        return result;
    }
    async request(method, params, timeoutMs) {
        await this.start();
        const id = this.nextId++;
        const child = this.child;
        if (!child?.stdin.writable)
            throw new Error('ACP connection is unavailable');
        const bound = timeoutMs ?? this.options.requestTimeoutMs ?? 30_000;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`ACP request timed out: ${method}`));
            }, bound);
            this.pending.set(id, { resolve: (value) => resolve(value), reject, timer });
            this.write({
                jsonrpc: '2.0',
                id,
                method,
                ...(params === undefined ? {} : { params }),
            }, (error) => {
                if (!error)
                    return;
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            });
        });
    }
    notify(method, params) {
        if (!this.child?.stdin.writable)
            throw new Error('ACP connection is unavailable');
        this.write({
            jsonrpc: '2.0',
            method,
            ...(params === undefined ? {} : { params }),
        });
    }
    setRequestHandler(handler) {
        this.requestHandler = handler;
    }
    onNotification(listener) {
        this.notifications.add(listener);
        return () => this.notifications.delete(listener);
    }
    onExit(listener) {
        this.exits.add(listener);
        return () => this.exits.delete(listener);
    }
    async newSession(cwd) {
        await this.initialize();
        return this.request('session/new', { cwd, mcpServers: this.options.mcpServers ?? [] });
    }
    async loadSession(sessionId, cwd) {
        await this.initialize();
        return this.request('session/load', { sessionId, cwd, mcpServers: this.options.mcpServers ?? [] });
    }
    prompt(sessionId, prompt) {
        return this.request('session/prompt', { sessionId, prompt });
    }
    cancel(sessionId) {
        this.notify('session/cancel', { sessionId });
    }
    async close() {
        const child = this.child;
        this.child = null;
        this.initialized = false;
        this.failPending(new Error('ACP client closed'));
        if (!child)
            return;
        child.stdin.end();
        if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGTERM');
    }
    receive(line) {
        if (!line.trim())
            return;
        let payload;
        try {
            payload = JSON.parse(line);
        }
        catch {
            return;
        }
        if ('id' in payload && !('method' in payload)) {
            const response = payload;
            const pending = this.pending.get(response.id);
            if (!pending)
                return;
            this.pending.delete(response.id);
            clearTimeout(pending.timer);
            if (response.error) {
                pending.reject(new Error(response.error.message ?? `ACP error ${response.error.code ?? ''}`.trim()));
            }
            else {
                pending.resolve(response.result);
            }
            return;
        }
        if (typeof payload.method !== 'string')
            return;
        if ('id' in payload) {
            void this.handleRequest(payload);
            return;
        }
        for (const listener of this.notifications) {
            listener({ method: payload.method, params: payload.params });
        }
    }
    async handleRequest(request) {
        try {
            if (!this.requestHandler)
                throw new Error(`Unsupported ACP client request: ${request.method}`);
            const result = await this.requestHandler(request.method, request.params);
            this.write({ jsonrpc: '2.0', id: request.id, result });
        }
        catch (error) {
            this.write({
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code: -32000,
                    message: error instanceof Error ? error.message : String(error),
                },
            });
        }
    }
    write(message, callback) {
        const child = this.child;
        if (!child?.stdin.writable) {
            callback?.(new Error('ACP connection is unavailable'));
            return;
        }
        child.stdin.write(`${JSON.stringify(message)}\n`, 'utf-8', callback);
    }
    failPending(error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }
}
exports.AcpClient = AcpClient;
