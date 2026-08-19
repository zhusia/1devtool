"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalTerminalAttachServer = void 0;
/**
 * Default-off, same-OS-user terminal attach socket for the `onedevtool` CLI.
 * Terminal hotspot: read docs/common-errors/terminals/INDEX.md before editing.
 *
 * This server is app-lifetime only: it never owns/spawns a PTY and never
 * becomes a detached daemon. View frames route through
 * TerminalConnectionService; semantic submits route through the shared staged
 * prompt writer. Raw input is intentionally absent.
 */
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_net_1 = __importDefault(require("node:net"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const localAttachProtocol_1 = require("../../shared/terminal/localAttachProtocol");
const connectionProtocol_1 = require("../../shared/terminal/connectionProtocol");
const promptSubmit_1 = require("../remote/promptSubmit");
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_PROMPT_BYTES = 256 * 1024;
const RAW_SNAPSHOT_CHARS = 400_000;
// Spec Security §"Rate and byte limits on every request and stream".
const MAX_CONCURRENT_CLIENTS = 32;
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_REQUESTS = 120;
function send(socket, payload) {
    if (!socket.destroyed)
        socket.write(`${JSON.stringify(payload)}\n`);
}
function errorEnvelope(id, error) {
    return {
        id,
        ok: false,
        error: {
            code: error instanceof connectionProtocol_1.TerminalConnectionError ? error.code : 'request-failed',
            message: error instanceof Error ? error.message : String(error),
        },
    };
}
class LocalTerminalAttachServer {
    service;
    backend;
    storeManager;
    submitter;
    homeDir;
    platform;
    server = null;
    token = '';
    clients = new Set();
    startPromise = null;
    constructor(options) {
        this.service = options.service;
        this.backend = options.backend;
        this.storeManager = options.storeManager;
        this.homeDir = options.homeDir ?? node_os_1.default.homedir();
        this.platform = options.platform ?? process.platform;
        this.submitter = new promptSubmit_1.RemotePromptSubmitCoordinator({
            backend: options.backend,
            claimInput: options.claimInput,
        });
    }
    get descriptorPath() {
        return node_path_1.default.join(this.homeDir, '.1devtool', 'state', localAttachProtocol_1.LOCAL_TERMINAL_ATTACH_DESCRIPTOR_FILE);
    }
    get socketPath() {
        if (this.platform === 'win32')
            return `\\\\.\\pipe\\1devtool-terminal-${process.pid}`;
        return node_path_1.default.join(this.homeDir, '.1devtool', 'run', 'terminal.sock');
    }
    async setEnabled(enabled) {
        if (enabled)
            await this.start();
        else
            await this.stop();
    }
    async start() {
        if (this.server?.listening)
            return;
        if (this.startPromise)
            return this.startPromise;
        this.startPromise = this.startInternal().finally(() => { this.startPromise = null; });
        return this.startPromise;
    }
    async startInternal() {
        this.token = node_crypto_1.default.randomBytes(32).toString('base64url');
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(this.descriptorPath), { recursive: true, mode: 0o700 });
        if (this.platform !== 'win32') {
            node_fs_1.default.mkdirSync(node_path_1.default.dirname(this.socketPath), { recursive: true, mode: 0o700 });
            // mkdirSync applies the mode only on creation — always tighten a
            // pre-existing looser runtime dir so the socket never sits in a
            // group/world-accessible directory.
            node_fs_1.default.chmodSync(node_path_1.default.dirname(this.socketPath), 0o700);
            try {
                node_fs_1.default.unlinkSync(this.socketPath);
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
        }
        const server = node_net_1.default.createServer((socket) => this.accept(socket));
        this.server = server;
        try {
            await new Promise((resolve, reject) => {
                const onError = (error) => {
                    server.off('listening', onListening);
                    reject(error);
                };
                const onListening = () => {
                    server.off('error', onError);
                    resolve();
                };
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(this.socketPath);
            });
            if (this.platform !== 'win32')
                node_fs_1.default.chmodSync(this.socketPath, 0o600);
            const descriptor = {
                protocolVersion: localAttachProtocol_1.LOCAL_TERMINAL_ATTACH_PROTOCOL_VERSION,
                socketPath: this.socketPath,
                token: this.token,
                pid: process.pid,
                writtenAt: Date.now(),
            };
            const temporary = `${this.descriptorPath}.${process.pid}.tmp`;
            node_fs_1.default.writeFileSync(temporary, JSON.stringify(descriptor), { encoding: 'utf8', mode: 0o600 });
            if (this.platform !== 'win32')
                node_fs_1.default.chmodSync(temporary, 0o600);
            node_fs_1.default.renameSync(temporary, this.descriptorPath);
        }
        catch (error) {
            this.server = null;
            if (server.listening)
                await new Promise((resolve) => server.close(() => resolve()));
            if (this.platform !== 'win32') {
                try {
                    node_fs_1.default.unlinkSync(this.socketPath);
                }
                catch { /* best-effort failed-start cleanup */ }
            }
            this.token = '';
            throw error;
        }
    }
    async stop() {
        // On-disk state goes first and synchronously: will-quit fires stop()
        // un-awaited, so nothing after the first await is guaranteed to run
        // before the process exits. A surviving descriptor would hand the next
        // `onedevtool terminal list` a raw ECONNREFUSED instead of the typed
        // not-running error (spec F7).
        this.removeOnDiskState();
        if (this.startPromise)
            await this.startPromise.catch(() => { });
        const server = this.server;
        this.server = null;
        for (const client of [...this.clients])
            client.socket.destroy();
        this.clients.clear();
        if (server?.listening)
            await new Promise((resolve) => server.close(() => resolve()));
        // Sweep again: an in-flight start() awaited above may have rewritten the
        // descriptor after the first sweep.
        this.removeOnDiskState();
        this.token = '';
    }
    /** Best-effort, non-throwing: stop() may run inside a voided will-quit
     * promise where a rethrown unlink error becomes an unhandled rejection. */
    removeOnDiskState() {
        try {
            node_fs_1.default.rmSync(this.descriptorPath, { force: true });
        }
        catch (error) {
            console.warn('[terminal-cli] failed to remove attach descriptor:', error);
        }
        if (this.platform !== 'win32') {
            try {
                node_fs_1.default.rmSync(this.socketPath, { force: true });
            }
            catch (error) {
                console.warn('[terminal-cli] failed to remove attach socket:', error);
            }
        }
    }
    accept(socket) {
        socket.setNoDelay(true);
        if (this.clients.size >= MAX_CONCURRENT_CLIENTS) {
            send(socket, {
                id: '',
                ok: false,
                error: {
                    code: 'too-many-connections',
                    message: `At most ${MAX_CONCURRENT_CLIENTS} concurrent local CLI connections are allowed`,
                },
            });
            socket.end();
            return;
        }
        const subjectId = `local-cli:${node_crypto_1.default.randomUUID()}`;
        const state = {
            socket,
            subjectId,
            principal: {
                origin: 'local-cli',
                subjectId,
                // Read-only on purpose (spec Security §"Input permission separate
                // from read permission"): attach is view-only, and `submit` is the
                // separate owner-fenced semantic path through
                // RemotePromptSubmitCoordinator — nothing CLI-side consumes 'input'.
                permissions: new Set(['read']),
            },
            connections: new Set(),
            buffer: '',
            requestTimes: [],
        };
        this.clients.add(state);
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => this.onData(state, chunk));
        socket.on('error', () => { });
        socket.on('close', () => {
            for (const connectionId of state.connections)
                this.service.detach(connectionId, state.principal);
            state.connections.clear();
            this.clients.delete(state);
        });
    }
    onData(state, chunk) {
        state.buffer += chunk;
        if (Buffer.byteLength(state.buffer) > MAX_REQUEST_BYTES) {
            state.socket.destroy(new Error('Local terminal request exceeded 1 MiB'));
            return;
        }
        while (true) {
            const newline = state.buffer.indexOf('\n');
            if (newline < 0)
                return;
            const line = state.buffer.slice(0, newline);
            state.buffer = state.buffer.slice(newline + 1);
            if (!line.trim())
                continue;
            const verdict = this.noteRequest(state);
            if (verdict !== 'allowed') {
                send(state.socket, {
                    id: '',
                    ok: false,
                    error: {
                        code: 'rate-limited',
                        message: `At most ${RATE_LIMIT_MAX_REQUESTS} requests per ${RATE_LIMIT_WINDOW_MS / 1000}s are allowed`,
                    },
                });
                if (verdict === 'abusive') {
                    state.socket.destroy();
                    return;
                }
                continue;
            }
            let request;
            try {
                request = JSON.parse(line);
            }
            catch {
                send(state.socket, { id: '', ok: false, error: { code: 'invalid-json', message: 'Invalid JSON request' } });
                continue;
            }
            void this.handle(state, request);
        }
    }
    /** Sliding-window per-connection request limit. A client that keeps piling
     * past double the window budget after being told to slow down is dropped. */
    noteRequest(state) {
        const now = Date.now();
        const cutoff = now - RATE_LIMIT_WINDOW_MS;
        while (state.requestTimes.length > 0 && state.requestTimes[0] <= cutoff)
            state.requestTimes.shift();
        state.requestTimes.push(now);
        if (state.requestTimes.length <= RATE_LIMIT_MAX_REQUESTS)
            return 'allowed';
        return state.requestTimes.length > RATE_LIMIT_MAX_REQUESTS * 2 ? 'abusive' : 'limited';
    }
    async handle(state, request) {
        const id = typeof request?.id === 'string' ? request.id : '';
        if (!id || request.token !== this.token) {
            send(state.socket, { id, ok: false, error: { code: 'forbidden', message: 'Invalid local attach token' } });
            return;
        }
        try {
            switch (request.method) {
                case 'list':
                    send(state.socket, { id, ok: true, result: this.listTerminals() });
                    return;
                case 'attach': {
                    if (!request.terminalId || !request.clientRequestId)
                        throw new Error('terminalId is required');
                    let connectionId = '';
                    const attach = await this.service.attach({
                        terminalId: request.terminalId,
                        clientRequestId: request.clientRequestId,
                        capabilities: [...connectionProtocol_1.RAW_V2_CAPABILITIES],
                        maxSnapshotChars: RAW_SNAPSHOT_CHARS,
                    }, state.principal, (frame) => {
                        send(state.socket, { type: 'frame', frame });
                    }, (reason) => {
                        send(state.socket, { type: 'closed', connectionId, reason });
                    });
                    connectionId = attach.connectionId;
                    state.connections.add(attach.connectionId);
                    send(state.socket, { id, ok: true, result: { attach } });
                    return;
                }
                case 'ack':
                    send(state.socket, {
                        id,
                        ok: this.service.ack(request.connectionId, request.syncGeneration, request.frameId, state.principal),
                    });
                    return;
                case 'resync': {
                    const attach = await this.service.resync(request.connectionId, state.principal);
                    send(state.socket, { id, ok: true, result: { attach } });
                    return;
                }
                case 'detach':
                    this.service.detach(request.connectionId, state.principal);
                    state.connections.delete(request.connectionId);
                    send(state.socket, { id, ok: true });
                    return;
                case 'submit': {
                    if (!request.terminalId || !request.prompt || Buffer.byteLength(request.prompt) > MAX_PROMPT_BYTES) {
                        throw new Error('A non-empty prompt no larger than 256 KiB is required');
                    }
                    const location = this.storeManager.findTerminalLocation(request.terminalId);
                    if (!location)
                        throw new Error('Terminal not found');
                    const target = {
                        agentType: location.terminal.agentType,
                        startupCommand: location.terminal.startupCommand,
                        forceAiAgent: location.terminal.forceAiAgent,
                    };
                    await this.submitter.submit({ terminalId: request.terminalId, text: request.prompt, target });
                    send(state.socket, { id, ok: true });
                    return;
                }
                default:
                    throw new Error('Unknown local terminal request');
            }
        }
        catch (error) {
            send(state.socket, errorEnvelope(id, error));
        }
    }
    listTerminals() {
        const rows = [];
        for (const project of this.storeManager.getProjects()) {
            for (const terminal of project.terminals ?? []) {
                const owner = this.backend.getOwnerIdentity(terminal.id);
                rows.push({
                    id: terminal.id,
                    projectId: project.id,
                    projectName: project.name,
                    name: terminal.name,
                    agentType: terminal.agentType,
                    cwd: terminal.cwd,
                    live: owner !== null,
                    ...(owner ? { owner } : {}),
                });
            }
        }
        return rows;
    }
}
exports.LocalTerminalAttachServer = LocalTerminalAttachServer;
