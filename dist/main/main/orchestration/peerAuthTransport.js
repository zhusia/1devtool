"use strict";
/**
 * macOS transport-authenticated orchestration bridge (V3-P0 / V4-5).
 *
 * A small app-owned Mach helper receives a kernel audit token on every
 * request, pins live PTY roots as they appear, and performs a two-pass
 * generation-aware ancestry walk before forwarding a body. It repeats the
 * proof before returning main's response. The JSON DTO therefore contains no
 * caller identity fields at all.
 *
 * Other platforms deliberately expose no endpoint. They keep the existing
 * write-only bridge behavior, but pull reads fail closed and are absent.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.peerAuthTransportInternals = exports.PeerAuthTransport = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const PEER_AUTH_PROTOCOL_VERSION = 1;
const START_TIMEOUT_MS = 5_000;
const RESTART_DELAY_MS = 1_000;
const MAX_STDOUT_BUFFER_BYTES = 512 * 1024;
const MAX_STDERR_RETAINED_BYTES = 16 * 1024;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_IN_FLIGHT = 32;
const TERMINAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,158}$/;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const FORBIDDEN_IDENTITY_FIELDS = new Set([
    'terminalId',
    'sourcePid',
    'sourcePpid',
    'fromMemberId',
]);
function containsIdentityField(value) {
    if (Array.isArray(value))
        return value.some(containsIdentityField);
    if (!isRecord(value))
        return false;
    return Object.entries(value).some(([key, nested]) => FORBIDDEN_IDENTITY_FIELDS.has(key) || containsIdentityField(nested));
}
function defaultHelperPath() {
    const sibling = path_1.default.join(__dirname, '../native/1devtool-peer-auth');
    if (sibling.includes('app.asar') && !sibling.includes('app.asar.unpacked')) {
        return sibling.replace('app.asar', 'app.asar.unpacked');
    }
    return sibling;
}
function safeJsonResponse(value) {
    try {
        const serialized = JSON.stringify(value);
        if (Buffer.byteLength(serialized) <= MAX_RESPONSE_BYTES)
            return serialized;
    }
    catch {
        // Convert unserializable handler output to one typed response below.
    }
    return JSON.stringify({ ok: false, error: 'peer-auth response exceeds the transport limit' });
}
function parseRequest(encoded) {
    if (encoded.length === 0 ||
        encoded.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        return null;
    }
    let bytes;
    try {
        bytes = Buffer.from(encoded, 'base64');
    }
    catch {
        return null;
    }
    if (bytes.length === 0 || bytes.length > MAX_REQUEST_BYTES)
        return null;
    try {
        const parsed = JSON.parse(bytes.toString('utf8'));
        if (!isRecord(parsed) ||
            typeof parsed.action !== 'string' ||
            !/^[a-z][a-z0-9-]{0,63}$/.test(parsed.action) ||
            !isRecord(parsed.payload)) {
            return null;
        }
        const keys = Object.keys(parsed);
        if (keys.some((key) => key !== 'action' && key !== 'payload'))
            return null;
        // Source identity is never representable on the authenticated wire. Target
        // selectors such as toTerminalId/targetMemberId remain valid by design.
        if (containsIdentityField(parsed.payload))
            return null;
        return { action: parsed.action, payload: parsed.payload };
    }
    catch {
        return null;
    }
}
class PeerAuthTransport {
    deps;
    child = null;
    endpoint = null;
    rootUnsubscribe = null;
    desiredRoots = new Map();
    sentRoots = new Map();
    stdoutBuffer = '';
    stderrTail = '';
    inFlight = 0;
    generation = 0;
    stopping = false;
    restartTimer = null;
    constructor(deps) {
        this.deps = deps;
    }
    getEndpoint() {
        return this.endpoint;
    }
    async start() {
        if (process.platform !== 'darwin' || this.stopping)
            return null;
        if (this.endpoint)
            return this.endpoint;
        if (this.child)
            return null;
        const helperPath = this.deps.helperPath ?? defaultHelperPath();
        try {
            fs_1.default.accessSync(helperPath, fs_1.default.constants.X_OK);
        }
        catch {
            this.deps.log?.(`[peer-auth] helper unavailable: ${helperPath}`);
            return null;
        }
        const generation = ++this.generation;
        const serviceName = `com.stoicsoft.1devtool.peer.${this.deps.instanceId}.${generation}`;
        const child = (0, child_process_1.spawn)(helperPath, ['serve', serviceName], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.child = child;
        this.stdoutBuffer = '';
        this.stderrTail = '';
        this.sentRoots.clear();
        if (!this.rootUnsubscribe) {
            this.rootUnsubscribe = this.deps.ptyBackend.onAttributionRootsChanged((roots) => {
                this.desiredRoots = new Map(roots.map((root) => [root.terminalId, root]));
                this.syncRoots();
            });
        }
        const ready = new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeout);
                resolve(value);
            };
            const timeout = setTimeout(() => {
                this.deps.log?.('[peer-auth] helper readiness timed out');
                try {
                    child.kill();
                }
                catch { /* best-effort */ }
                finish(null);
            }, START_TIMEOUT_MS);
            timeout.unref?.();
            child.stdout.on('data', (chunk) => {
                this.consumeStdout(chunk, (line) => {
                    if (line === `READY\t${serviceName}` && this.child === child && !this.stopping) {
                        const endpoint = {
                            transport: 'mach',
                            protocolVersion: PEER_AUTH_PROTOCOL_VERSION,
                            serviceName,
                            helperPath,
                        };
                        this.endpoint = endpoint;
                        this.syncRoots();
                        this.deps.onEndpointChanged?.(endpoint);
                        this.deps.log?.(`[peer-auth] listening on ${serviceName}`);
                        finish(endpoint);
                        return;
                    }
                    void this.handleLine(line);
                });
            });
            child.stderr.on('data', (chunk) => {
                // Always drain; retain only a bounded diagnostic tail.
                this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-MAX_STDERR_RETAINED_BYTES);
            });
            child.once('error', (error) => {
                this.deps.log?.(`[peer-auth] helper failed to start: ${error.message}`);
                finish(null);
            });
            child.once('exit', (code, signal) => {
                const diagnostic = this.stderrTail.trim();
                if (diagnostic)
                    this.deps.log?.(`[peer-auth] helper stderr: ${diagnostic}`);
                if (this.child === child)
                    this.child = null;
                if (this.endpoint?.serviceName === serviceName) {
                    this.endpoint = null;
                    this.deps.onEndpointChanged?.(null);
                }
                finish(null);
                if (!this.stopping) {
                    this.deps.log?.(`[peer-auth] helper exited (${code ?? signal ?? 'unknown'}); retrying`);
                    this.scheduleRestart();
                }
            });
        });
        return ready;
    }
    stop() {
        this.stopping = true;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        this.rootUnsubscribe?.();
        this.rootUnsubscribe = null;
        this.desiredRoots.clear();
        this.sentRoots.clear();
        this.endpoint = null;
        this.deps.onEndpointChanged?.(null);
        const child = this.child;
        this.child = null;
        if (!child)
            return;
        try {
            child.stdin.end();
        }
        catch { /* best-effort */ }
        const killTimer = setTimeout(() => {
            try {
                child.kill();
            }
            catch { /* best-effort */ }
        }, 500);
        killTimer.unref?.();
    }
    scheduleRestart() {
        if (this.restartTimer || this.stopping)
            return;
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            void this.start();
        }, RESTART_DELAY_MS);
        this.restartTimer.unref?.();
    }
    consumeStdout(chunk, onLine) {
        this.stdoutBuffer += chunk.toString('utf8');
        if (Buffer.byteLength(this.stdoutBuffer) > MAX_STDOUT_BUFFER_BYTES) {
            this.deps.log?.('[peer-auth] helper emitted an oversized line');
            try {
                this.child?.kill();
            }
            catch { /* best-effort */ }
            this.stdoutBuffer = '';
            return;
        }
        while (true) {
            const newline = this.stdoutBuffer.indexOf('\n');
            if (newline < 0)
                return;
            const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '');
            this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
            if (line)
                onLine(line);
        }
    }
    syncRoots() {
        const child = this.child;
        if (!child || !this.endpoint || !child.stdin.writable)
            return;
        for (const [terminalId] of this.sentRoots) {
            if (!this.desiredRoots.has(terminalId)) {
                this.writeLine(`UNROOT\t${terminalId}`);
                this.sentRoots.delete(terminalId);
            }
        }
        for (const root of this.desiredRoots.values()) {
            if (!TERMINAL_ID_RE.test(root.terminalId))
                continue;
            const sent = this.sentRoots.get(root.terminalId);
            if (sent?.pid === root.pid &&
                sent.sessionGeneration === root.sessionGeneration) {
                continue;
            }
            this.writeLine(`ROOT\t${root.terminalId}\t${root.pid}\t${root.sessionGeneration}`);
            this.sentRoots.set(root.terminalId, root);
        }
    }
    writeLine(line) {
        const stdin = this.child?.stdin;
        if (!stdin?.writable)
            return;
        try {
            stdin.write(`${line}\n`);
        }
        catch {
            // Exit/restart path will clear the endpoint.
        }
    }
    async handleLine(line) {
        if (!line.startsWith('REQUEST\t'))
            return;
        const fields = line.split('\t');
        if (fields.length !== 4)
            return;
        const [, id, terminalId, encoded] = fields;
        if (!/^[1-9]\d*$/.test(id) || !TERMINAL_ID_RE.test(terminalId))
            return;
        const request = parseRequest(encoded);
        if (!request) {
            this.respond(id, { ok: false, error: 'invalid peer-auth request DTO' });
            return;
        }
        if (this.inFlight >= MAX_IN_FLIGHT) {
            this.respond(id, { ok: false, error: 'peer-auth request limit reached' });
            return;
        }
        this.inFlight += 1;
        try {
            const result = await this.deps.onRequest(terminalId, request);
            this.respond(id, result);
        }
        catch (error) {
            this.deps.log?.(`[peer-auth] request handler failed: ${error instanceof Error ? error.message : String(error)}`);
            this.respond(id, {
                ok: false,
                error: 'peer-auth request failed',
            });
        }
        finally {
            this.inFlight -= 1;
        }
    }
    respond(id, result) {
        const encoded = Buffer.from(safeJsonResponse(result), 'utf8').toString('base64');
        this.writeLine(`RESPONSE\t${id}\t${encoded}`);
    }
}
exports.PeerAuthTransport = PeerAuthTransport;
exports.peerAuthTransportInternals = {
    defaultHelperPath,
    parseRequest,
    safeJsonResponse,
};
