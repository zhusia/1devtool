"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSshTerminalHost = runSshTerminalHost;
/**
 * Opt-in Node + node-pty SSH stdio host prototype.
 *
 * The helper is never installed or launched silently and never detaches from
 * stdin. A caller copies/updates it explicitly, then transports these NDJSON
 * messages over an SSH stdio channel. Output uses the same v2 owner/cursor,
 * ANSI classification and fragment-size contract as local connections.
 */
const node_crypto_1 = __importDefault(require("node:crypto"));
const connectionProtocol_1 = require("../shared/terminal/connectionProtocol");
const ptyRelease_1 = require("../main/pty-backend/ptyRelease");
const MAX_SESSIONS = 16;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 64 * 1024;
const MAX_STDOUT_QUEUE_BYTES = 256 * 1024;
const MAX_PTY_INPUT_BUFFER_BYTES = 1024 * 1024;
const MAX_GENERATION_ENTRIES = 512;
const CLOSE_ESCALATION_WINDOW_MS = 500;
function validDimension(value) {
    return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 1_000;
}
async function loadNodePty() {
    try {
        // Non-literal name keeps the native addon outside the generic CLI bundle.
        // A copied helper must ship/install the pinned node-pty package beside it.
        const moduleName = 'node-pty';
        return await Promise.resolve(`${moduleName}`).then(s => __importStar(require(s)));
    }
    catch {
        throw new Error('node-pty is unavailable on this host; install the signed Node helper package explicitly');
    }
}
async function runSshTerminalHost() {
    if (process.stdin.isTTY) {
        throw new Error('ssh-host requires an NDJSON stdin pipe; it never opens an interactive daemon');
    }
    const pty = await loadNodePty();
    const engineEpoch = node_crypto_1.default.randomUUID();
    const generations = new Map();
    const sessions = new Map();
    let outputBlocked = false;
    let hostClosing = false;
    let queuedOutputBytes = 0;
    const outputQueue = [];
    let closeInput = () => { process.stdin.destroy(); };
    const abortHost = (note) => {
        if (hostClosing)
            return;
        hostClosing = true;
        process.exitCode = 1;
        process.stderr.write(note);
        for (const hosted of sessions.values())
            hosted.process.pause();
        closeInput();
    };
    const pauseOutput = () => {
        if (outputBlocked)
            return;
        outputBlocked = true;
        for (const hosted of sessions.values())
            hosted.process.pause();
    };
    const flushOutput = () => {
        if (outputBlocked || hostClosing)
            return;
        while (outputQueue.length > 0) {
            const line = outputQueue.shift();
            queuedOutputBytes -= Buffer.byteLength(line);
            if (!process.stdout.write(line)) {
                pauseOutput();
                return;
            }
        }
    };
    const respond = (value) => {
        if (hostClosing)
            return;
        const line = `${JSON.stringify(value)}\n`;
        const bytes = Buffer.byteLength(line);
        if (queuedOutputBytes + bytes > MAX_STDOUT_QUEUE_BYTES) {
            abortHost('ssh-host stdout remained blocked; closing bounded terminal sessions\n');
            return;
        }
        outputQueue.push(line);
        queuedOutputBytes += bytes;
        flushOutput();
    };
    const resumeOutput = () => {
        if (!outputBlocked)
            return;
        outputBlocked = false;
        flushOutput();
        if (!outputBlocked && !hostClosing) {
            for (const hosted of sessions.values())
                hosted.process.resume();
        }
    };
    process.stdout.on('drain', resumeOutput);
    // A dead SSH stdout pipe is owner loss: without this handler the next flush
    // raises an unhandled EPIPE and the host crashes without releasing its PTYs.
    // Stays attached for process lifetime so a late flush cannot crash either.
    process.stdout.on('error', () => {
        abortHost('ssh-host stdout pipe failed; closing bounded terminal sessions\n');
    });
    const emitFragments = (terminalId, hosted, data) => {
        const fragments = hosted.splitter.feed(data).map((fragment) => ({
            cursor: {
                engineEpoch,
                terminalGeneration: hosted.generation,
                streamSeq: ++hosted.streamSeq,
            },
            delivery: fragment.delivery,
            data: fragment.data,
        }));
        for (const fragment of fragments)
            respond({ type: 'output', terminalId, fragment });
    };
    const closeSession = (terminalId) => {
        const hosted = sessions.get(terminalId);
        if (!hosted)
            return false;
        sessions.delete(terminalId);
        if (!hosted.released) {
            hosted.released = true;
            if (hosted.exited)
                (0, ptyRelease_1.releaseExitedPty)(hosted.process);
            else
                (0, ptyRelease_1.releasePty)(hosted.process);
        }
        return true;
    };
    const handle = async (request) => {
        // Once the host is aborting, no already-buffered NDJSON line may start new
        // work (a queued `start` could still spawn a PTY while the host is dying).
        if (hostClosing)
            return;
        const id = typeof request?.id === 'string' ? request.id : '';
        try {
            switch (request.method) {
                case 'hello':
                    respond({ id, ok: true, result: {
                            protocolVersion: connectionProtocol_1.TERMINAL_CONNECTION_PROTOCOL_VERSION,
                            capabilities: [...connectionProtocol_1.RAW_V2_CAPABILITIES],
                            engineEpoch,
                            runtime: 'node-pty-stdio',
                        } });
                    return;
                case 'list':
                    respond({ id, ok: true, result: [...sessions].map(([terminalId, hosted]) => ({
                            terminalId,
                            terminalGeneration: hosted.generation,
                            pid: hosted.process.pid,
                        })) });
                    return;
                case 'start': {
                    if (!request.terminalId || !request.file || !request.cwd ||
                        !validDimension(request.cols) || !validDimension(request.rows)) {
                        throw new Error('start requires terminalId, file, cwd, cols and rows');
                    }
                    const terminalId = request.terminalId;
                    if (sessions.has(terminalId))
                        throw new Error('terminalId is already live');
                    if (sessions.size >= MAX_SESSIONS)
                        throw new Error(`session limit is ${MAX_SESSIONS}`);
                    const generation = (generations.get(terminalId) ?? 0) + 1;
                    // Delete-then-set keeps insertion order = recency, so the bound below
                    // prunes the longest-idle terminal ids first and never a live one.
                    generations.delete(terminalId);
                    generations.set(terminalId, generation);
                    if (generations.size > MAX_GENERATION_ENTRIES) {
                        for (const knownId of generations.keys()) {
                            if (generations.size <= MAX_GENERATION_ENTRIES)
                                break;
                            if (!sessions.has(knownId))
                                generations.delete(knownId);
                        }
                    }
                    const environment = Object.fromEntries(Object.entries({ ...process.env, ...(request.env ?? {}) })
                        .filter((entry) => typeof entry[1] === 'string'));
                    const child = pty.spawn(request.file, request.args ?? [], {
                        cwd: request.cwd,
                        cols: request.cols,
                        rows: request.rows,
                        name: 'xterm-256color',
                        env: environment,
                    });
                    const hosted = {
                        process: child,
                        generation,
                        streamSeq: 0,
                        splitter: new connectionProtocol_1.TerminalV2AnsiSplitter(),
                        exited: false,
                        released: false,
                    };
                    sessions.set(terminalId, hosted);
                    if (outputBlocked)
                        child.pause();
                    child.onData((data) => emitFragments(terminalId, hosted, data));
                    child.onExit(({ exitCode }) => {
                        hosted.exited = true;
                        for (const fragment of hosted.splitter.finish()) {
                            respond({
                                type: 'output',
                                terminalId,
                                fragment: {
                                    cursor: { engineEpoch, terminalGeneration: generation, streamSeq: ++hosted.streamSeq },
                                    delivery: fragment.delivery,
                                    data: fragment.data,
                                },
                            });
                        }
                        // A late exit can race a close+restart of the same terminalId; only
                        // drop the map entry while it still points at this exact session,
                        // or the restarted PTY would become untracked.
                        if (sessions.get(terminalId) === hosted)
                            sessions.delete(terminalId);
                        if (!hosted.released) {
                            hosted.released = true;
                            (0, ptyRelease_1.releaseExitedPty)(child);
                        }
                        respond({ type: 'exit', terminalId, terminalGeneration: generation, code: exitCode });
                    });
                    respond({ id, ok: true, result: { engineEpoch, terminalGeneration: generation, pid: child.pid } });
                    return;
                }
                case 'write': {
                    const hosted = request.terminalId ? sessions.get(request.terminalId) : undefined;
                    if (!hosted || typeof request.data !== 'string' || Buffer.byteLength(request.data) > MAX_WRITE_BYTES) {
                        throw new Error('write requires a live terminal and at most 64 KiB');
                    }
                    // node-pty buffers writes in userspace without bound; consult its
                    // private socket (best-effort — absent on some builds) so a wedged
                    // child plus a streaming client cannot grow the buffer forever.
                    const inputSocket = hosted.process._socket;
                    const bufferedInput = inputSocket?.writableLength;
                    if (typeof bufferedInput === 'number' && bufferedInput > MAX_PTY_INPUT_BUFFER_BYTES) {
                        respond({ id, ok: false, error: { code: 'write-backpressure', message: 'terminal input buffer is full; write dropped' } });
                        return;
                    }
                    hosted.process.write(request.data);
                    respond({ id, ok: true });
                    return;
                }
                case 'resize': {
                    const hosted = request.terminalId ? sessions.get(request.terminalId) : undefined;
                    if (!hosted || !validDimension(request.cols) || !validDimension(request.rows)) {
                        throw new Error('resize requires a live terminal and valid cols/rows');
                    }
                    hosted.process.resize(request.cols, request.rows);
                    respond({ id, ok: true });
                    return;
                }
                case 'close':
                    respond({ id, ok: closeSession(request.terminalId ?? '') });
                    return;
                default:
                    throw new Error('unknown ssh-host method');
            }
        }
        catch (error) {
            respond({ id, ok: false, error: { code: 'request-failed', message: error instanceof Error ? error.message : String(error) } });
        }
    };
    process.stdin.setEncoding('utf8');
    let inputBuffer = '';
    try {
        input: for await (const chunk of process.stdin) {
            inputBuffer += typeof chunk === 'string' ? chunk : String(chunk);
            while (true) {
                if (hostClosing)
                    break input;
                const newline = inputBuffer.indexOf('\n');
                if (newline < 0) {
                    if (Buffer.byteLength(inputBuffer) > MAX_REQUEST_BYTES) {
                        respond({ id: '', ok: false, error: { code: 'request-too-large', message: 'NDJSON request exceeds 1 MiB' } });
                        process.exitCode = 1;
                        break input;
                    }
                    break;
                }
                const line = inputBuffer.slice(0, newline).replace(/\r$/, '');
                inputBuffer = inputBuffer.slice(newline + 1);
                if (!line.trim())
                    continue;
                if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) {
                    respond({ id: '', ok: false, error: { code: 'request-too-large', message: 'NDJSON request exceeds 1 MiB' } });
                    process.exitCode = 1;
                    break input;
                }
                try {
                    await handle(JSON.parse(line));
                }
                catch {
                    respond({ id: '', ok: false, error: { code: 'invalid-json', message: 'Invalid NDJSON request' } });
                }
            }
        }
    }
    catch (error) {
        // closeInput() destroys stdin mid-iteration, which rejects the async
        // iterator with ERR_STREAM_PREMATURE_CLOSE; that is the expected abort
        // signal, not a failure to surface. Teardown still runs below.
        const code = error?.code;
        if (!hostClosing && code !== 'ERR_STREAM_PREMATURE_CLOSE')
            throw error;
    }
    finally {
        const closing = [...sessions.values()];
        for (const terminalId of [...sessions.keys()])
            closeSession(terminalId);
        // releasePty only signals SIGHUP, which agent CLIs trap; give children a
        // bounded window to exit, then force-kill any survivor so none outlive
        // their stdio owner as a remote orphan.
        const deadline = Date.now() + CLOSE_ESCALATION_WINDOW_MS;
        while (closing.some((hosted) => !hosted.exited) && Date.now() < deadline) {
            await new Promise((resolve) => { setTimeout(resolve, 25); });
        }
        if (process.platform !== 'win32') {
            for (const hosted of closing) {
                if (hosted.exited)
                    continue;
                try {
                    process.kill(hosted.process.pid, 'SIGKILL');
                }
                catch { /* already reaped */ }
            }
        }
        process.stdout.off('drain', resumeOutput);
    }
}
