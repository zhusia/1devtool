"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.listLocalTerminals = listLocalTerminals;
exports.submitLocalTerminalPrompt = submitLocalTerminalPrompt;
exports.attachLocalTerminal = attachLocalTerminal;
/** Client for the default-off app-lifetime `onedevtool terminal` socket. */
const node_fs_1 = __importDefault(require("node:fs"));
const node_net_1 = __importDefault(require("node:net"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const localAttachProtocol_1 = require("../shared/terminal/localAttachProtocol");
const CONNECT_TIMEOUT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;
function descriptorPath() {
    return node_path_1.default.join(node_os_1.default.homedir(), '.1devtool', 'state', localAttachProtocol_1.LOCAL_TERMINAL_ATTACH_DESCRIPTOR_FILE);
}
function readDescriptor() {
    const filePath = descriptorPath();
    let stat;
    let parsed;
    try {
        stat = node_fs_1.default.statSync(filePath);
        parsed = JSON.parse(node_fs_1.default.readFileSync(filePath, 'utf8'));
    }
    catch {
        throw new Error('Local terminal attach is disabled or 1DevTool is not running. Enable it in Settings → Terminal → Advance.');
    }
    if (process.platform !== 'win32') {
        if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
            throw new Error('Local terminal descriptor is owned by another OS user');
        }
        if ((stat.mode & 0o077) !== 0)
            throw new Error('Local terminal descriptor permissions are unsafe');
    }
    if (parsed.protocolVersion !== localAttachProtocol_1.LOCAL_TERMINAL_ATTACH_PROTOCOL_VERSION ||
        !parsed.socketPath || !parsed.token) {
        throw new Error('Local terminal descriptor uses an unsupported protocol');
    }
    return parsed;
}
class LocalTerminalClient {
    socket;
    token;
    pending = new Map();
    nextId = 1;
    buffer = '';
    closed = false;
    onEvent;
    onDisconnect;
    constructor(socket, token) {
        this.socket = socket;
        this.token = token;
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('error', (error) => this.fail(error));
        socket.on('close', () => this.fail(new Error('Local terminal socket closed')));
    }
    static async connect() {
        const descriptor = readDescriptor();
        const socket = node_net_1.default.createConnection(descriptor.socketPath);
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error('Timed out connecting to the local terminal socket'));
            }, CONNECT_TIMEOUT_MS);
            socket.once('connect', () => { clearTimeout(timer); resolve(); });
            socket.once('error', (error) => { clearTimeout(timer); reject(error); });
        });
        return new LocalTerminalClient(socket, descriptor.token);
    }
    request(method, payload = {}) {
        if (this.closed)
            return Promise.reject(new Error('Local terminal socket is closed'));
        const id = String(this.nextId++);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Local terminal ${method} request timed out`));
            }, REQUEST_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            this.socket.write(`${JSON.stringify({ id, token: this.token, method, ...payload })}\n`);
        }).then((response) => {
            if (!response.ok)
                throw new Error(response.error?.message || 'Local terminal request failed');
            return response;
        });
    }
    notify(method, payload = {}) {
        if (this.closed)
            return;
        const id = `notify-${this.nextId++}`;
        this.socket.write(`${JSON.stringify({ id, token: this.token, method, ...payload })}\n`);
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.socket.end();
    }
    onData(chunk) {
        this.buffer += chunk;
        while (true) {
            const newline = this.buffer.indexOf('\n');
            if (newline < 0)
                return;
            const line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            if (!line)
                continue;
            let value;
            try {
                value = JSON.parse(line);
            }
            catch {
                this.socket.destroy();
                this.fail(new Error('Local terminal socket returned invalid JSON'));
                return;
            }
            if ('id' in value) {
                const waiter = this.pending.get(value.id);
                if (waiter) {
                    this.pending.delete(value.id);
                    clearTimeout(waiter.timer);
                    waiter.resolve(value);
                }
            }
            else {
                this.onEvent?.(value);
            }
        }
    }
    fail(error) {
        if (this.closed)
            return;
        this.closed = true;
        for (const waiter of this.pending.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
        }
        this.pending.clear();
        this.onDisconnect?.(error);
    }
}
function rawAttachContent(result) {
    if (result.payload.kind !== 'raw')
        return '';
    return result.payload.rawFallback.content + result.payload.rawFallback.unbufferedOverlap
        .sort((left, right) => left.cursor.streamSeq - right.cursor.streamSeq)
        .map((fragment) => fragment.data)
        .join('');
}
function writeStdout(data) {
    if (!data || process.stdout.write(data))
        return Promise.resolve();
    return new Promise((resolve) => process.stdout.once('drain', resolve));
}
function ackFrame(client, frame) {
    client.notify('ack', {
        connectionId: frame.connectionId,
        syncGeneration: frame.syncGeneration,
        frameId: frame.frameId,
    });
}
async function listLocalTerminals(json = false) {
    const client = await LocalTerminalClient.connect();
    try {
        const response = await client.request('list');
        const rows = (response.result ?? []);
        if (json) {
            process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
            return;
        }
        if (rows.length === 0) {
            process.stdout.write('No terminals.\n');
            return;
        }
        for (const row of rows) {
            process.stdout.write(`${row.live ? 'live ' : 'idle '} ${row.id}  ${row.projectName} / ${row.name}  (${row.agentType})\n`);
        }
    }
    finally {
        client.close();
    }
}
async function submitLocalTerminalPrompt(terminalId, prompt) {
    const client = await LocalTerminalClient.connect();
    try {
        await client.request('submit', { terminalId, prompt });
    }
    finally {
        client.close();
    }
}
async function attachLocalTerminal(terminalId) {
    const client = await LocalTerminalClient.connect();
    let connectionId = '';
    let applyTail = Promise.resolve();
    let finished = false;
    let resolveFinished;
    const done = new Promise((resolve) => { resolveFinished = resolve; });
    const finish = () => {
        if (finished)
            return;
        finished = true;
        resolveFinished();
    };
    const applyAttach = async (attach) => {
        connectionId = attach.connectionId;
        await writeStdout(rawAttachContent(attach));
        client.notify('ack', {
            connectionId: attach.connectionId,
            syncGeneration: attach.syncGeneration,
            frameId: attach.attachFrameId,
        });
    };
    client.onEvent = (event) => {
        if (event.type === 'closed') {
            process.stderr.write(`\nterminal viewer closed: ${event.reason}\n`);
            finish();
            return;
        }
        const frame = event.frame;
        applyTail = applyTail.then(async () => {
            if (frame.event.type === 'output') {
                await writeStdout(frame.event.data);
                ackFrame(client, frame);
            }
            else if (frame.event.type === 'resync-required') {
                const response = await client.request('resync', { connectionId: frame.connectionId });
                const attach = response.result.attach;
                await writeStdout('\x1bc');
                await applyAttach(attach);
            }
            else {
                ackFrame(client, frame);
                if (frame.event.type === 'exit' || frame.event.type === 'engine-closed')
                    finish();
            }
        }).catch((error) => {
            process.stderr.write(`\nterminal viewer error: ${error instanceof Error ? error.message : String(error)}\n`);
            finish();
        });
    };
    client.onDisconnect = (error) => {
        if (!finished)
            process.stderr.write(`\nterminal viewer disconnected: ${error.message}\n`);
        finish();
    };
    const interrupt = () => finish();
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    try {
        const response = await client.request('attach', {
            terminalId,
            clientRequestId: `onedevtool-${process.pid}-${Date.now()}`,
        });
        await applyAttach(response.result.attach);
        await done;
        await applyTail;
    }
    finally {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', interrupt);
        if (connectionId)
            client.notify('detach', { connectionId });
        client.close();
    }
}
