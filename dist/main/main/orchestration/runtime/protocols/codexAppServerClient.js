"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodexAppServerClient = void 0;
const node_child_process_1 = require("node:child_process");
const node_readline_1 = __importDefault(require("node:readline"));
const env_1 = require("../../../utils/env");
const spawnSpec_1 = require("../../../utils/spawnSpec");
const processStreamErrors_1 = require("../../../processStreamErrors");
/** Typed JSONL/JSON-RPC transport for the resident `codex app-server`. */
class CodexAppServerClient {
    options;
    child = null;
    nextId = 1;
    pending = new Map();
    notificationListeners = new Set();
    exitListeners = new Set();
    serverRequestHandler = null;
    initialized = false;
    stderr = '';
    constructor(options) {
        this.options = options;
    }
    async start() {
        if (this.child)
            return;
        // npm-installed codex is a .cmd shim on Windows — a direct spawn throws
        // EINVAL; route through the shared spec builder. Enriched env matches
        // terminal/tool spawns so the shim can find its node runtime.
        const spec = (0, spawnSpec_1.buildSpawnSpec)(this.options.binaryPath, this.options.args ?? ['app-server']);
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
            const cap = this.options.stderrCapChars ?? 64_000;
            this.stderr = (this.stderr + chunk).slice(-cap);
        });
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
            this.failPending(new Error(`Codex app-server exited${code === null ? '' : ` with code ${code}`}`));
            for (const listener of this.exitListeners)
                listener({ code, signal, stderr: this.stderr });
        });
    }
    async initialize() {
        if (this.initialized)
            return undefined;
        await this.start();
        const result = await this.request('initialize', {
            clientInfo: this.options.clientInfo ?? { name: '1devtool', title: '1DevTool', version: '1' },
            capabilities: { experimentalApi: true },
        });
        this.notify('initialized', {});
        this.initialized = true;
        return result;
    }
    async request(method, params, timeoutMs) {
        await this.start();
        const id = this.nextId++;
        const child = this.child;
        if (!child?.stdin.writable)
            throw new Error('Codex app-server stdin is unavailable');
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Codex app-server request timed out: ${method}`));
            }, timeoutMs ?? this.options.requestTimeoutMs ?? 60_000);
            this.pending.set(id, { resolve: (value) => resolve(value), reject, timer });
            child.stdin.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`, 'utf-8', (error) => {
                if (!error)
                    return;
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            });
        });
    }
    notify(method, params) {
        const child = this.child;
        if (!child?.stdin.writable)
            throw new Error('Codex app-server stdin is unavailable');
        child.stdin.write(`${JSON.stringify({ method, ...(params === undefined ? {} : { params }) })}\n`);
    }
    setServerRequestHandler(handler) {
        this.serverRequestHandler = handler;
    }
    onNotification(listener) {
        this.notificationListeners.add(listener);
        return () => this.notificationListeners.delete(listener);
    }
    onExit(listener) {
        this.exitListeners.add(listener);
        return () => this.exitListeners.delete(listener);
    }
    async startThread(params) {
        await this.initialize();
        return this.request('thread/start', params);
    }
    async resumeThread(threadId, params = {}) {
        await this.initialize();
        return this.request('thread/resume', { threadId, ...params });
    }
    async startTurn(threadId, input, params = {}) {
        await this.initialize();
        return this.request('turn/start', { threadId, input, ...params });
    }
    async interruptTurn(threadId, turnId) {
        return this.request('turn/interrupt', { threadId, turnId });
    }
    async close() {
        const child = this.child;
        this.child = null;
        this.initialized = false;
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
            if (response.error)
                pending.reject(new Error(response.error.message ?? `Codex app-server error ${response.error.code ?? ''}`.trim()));
            else
                pending.resolve(response.result);
            return;
        }
        if (typeof payload.method !== 'string')
            return;
        if ('id' in payload) {
            void this.handleServerRequest(payload);
            return;
        }
        const notification = { method: payload.method, ...('params' in payload ? { params: payload.params } : {}) };
        for (const listener of this.notificationListeners)
            listener(notification);
    }
    async handleServerRequest(request) {
        try {
            if (!this.serverRequestHandler)
                throw new Error(`Unsupported Codex server request: ${request.method}`);
            const result = await this.serverRequestHandler(request);
            this.writeResponse({ id: request.id, result });
        }
        catch (error) {
            this.writeResponse({
                id: request.id,
                error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
            });
        }
    }
    writeResponse(response) {
        if (this.child?.stdin.writable)
            this.child.stdin.write(`${JSON.stringify(response)}\n`);
    }
    failPending(error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }
}
exports.CodexAppServerClient = CodexAppServerClient;
