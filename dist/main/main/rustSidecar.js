"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RustSidecarManager = exports.RustSidecarRequestError = void 0;
const electron_1 = require("electron");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const readline_1 = __importDefault(require("readline"));
const child_process_1 = require("child_process");
const events_1 = require("events");
const processStreamErrors_1 = require("./processStreamErrors");
const SIDECAR_SCHEMA_VERSION = 1;
const SIDECAR_JSONRPC_VERSION = '2.0';
class RustSidecarRequestError extends Error {
    code;
    fallbackAllowed;
    constructor(message, options = {}) {
        super(message);
        this.name = 'RustSidecarRequestError';
        this.code = options.code;
        this.fallbackAllowed = options.fallbackAllowed ?? true;
    }
}
exports.RustSidecarRequestError = RustSidecarRequestError;
class RustSidecarManager extends events_1.EventEmitter {
    child = null;
    stdoutReader = null;
    pending = new Map();
    nextId = 1;
    crashCount = 0;
    restartAfterMs = 0;
    disposing = false;
    constructor() {
        super();
    }
    async request(method, params, options = {}) {
        const child = this.ensureStarted();
        const timeoutMs = options.timeoutMs ?? 30_000;
        const id = String(this.nextId++);
        const request = {
            jsonrpc: SIDECAR_JSONRPC_VERSION,
            id,
            method,
            params,
            schemaVersion: SIDECAR_SCHEMA_VERSION,
            timeoutMs,
            requestStartedAt: new Date().toISOString(),
            featureFlag: options.featureFlag,
        };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                this.killSidecarAfterTimeout(method);
                reject(new RustSidecarRequestError(`Rust sidecar request timed out: ${method}`, {
                    code: 'TIMEOUT',
                    fallbackAllowed: true,
                }));
            }, timeoutMs);
            this.pending.set(id, {
                method,
                timer,
                resolve: resolve,
                reject,
            });
            child.stdin.write(`${JSON.stringify(request)}\n`);
        });
    }
    dispose() {
        this.disposing = true;
        this.rejectAllPending(new RustSidecarRequestError('Rust sidecar disposed', {
            code: 'DISPOSED',
            fallbackAllowed: true,
        }));
        this.stdoutReader?.close();
        this.stdoutReader = null;
        const child = this.child;
        this.child = null;
        if (child && !child.killed) {
            child.kill();
        }
    }
    onSidecarEvent(listener) {
        this.on('event', listener);
        return () => this.off('event', listener);
    }
    onSidecarUnavailable(listener) {
        this.on('unavailable', listener);
        return () => this.off('unavailable', listener);
    }
    getDiagnostics() {
        return {
            running: this.child !== null,
            binaryPath: resolveSidecarBinaryPath(),
            restartAfterMs: this.restartAfterMs,
            crashCount: this.crashCount,
            pendingRequestCount: this.pending.size,
        };
    }
    ensureStarted() {
        if (this.child)
            return this.child;
        const now = Date.now();
        if (now < this.restartAfterMs) {
            throw new RustSidecarRequestError('Rust sidecar restart is backing off', {
                code: 'RESTART_BACKOFF',
                fallbackAllowed: true,
            });
        }
        const binaryPath = resolveSidecarBinaryPath();
        if (!fs_1.default.existsSync(binaryPath)) {
            throw new RustSidecarRequestError(`Rust sidecar binary not found: ${binaryPath}`, {
                code: 'SIDECAR_NOT_FOUND',
                fallbackAllowed: true,
            });
        }
        const child = (0, child_process_1.spawn)(binaryPath, [], {
            stdio: 'pipe',
            windowsHide: true,
        });
        this.child = child;
        this.disposing = false;
        this.stdoutReader = readline_1.default.createInterface({ input: child.stdout });
        this.stdoutReader.on('line', (line) => this.handleLine(line));
        child.stderr.on('data', (chunk) => {
            const message = chunk.toString('utf8').trim();
            if (message) {
                console.warn('[rust-sidecar] stderr:', message);
            }
        });
        (0, processStreamErrors_1.installChildStdinErrorGuard)(child.stdin, (error) => {
            if (this.child !== child)
                return;
            this.handleChildFailure(error);
        });
        child.on('error', (error) => this.handleChildFailure(error));
        child.on('exit', (code, signal) => this.handleChildExit(code, signal));
        return child;
    }
    handleLine(line) {
        let response;
        try {
            response = JSON.parse(line);
        }
        catch (error) {
            console.warn('[rust-sidecar] Invalid JSON response:', error);
            return;
        }
        if (!('id' in response) || response.id === undefined) {
            if (isSidecarEvent(response)) {
                this.emit('event', response);
            }
            return;
        }
        const id = String(response.id);
        const pending = this.pending.get(id);
        if (!pending) {
            return;
        }
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (response.error) {
            pending.reject(new RustSidecarRequestError(response.error.message, {
                code: response.error.code,
                fallbackAllowed: response.error.fallbackAllowed,
            }));
            return;
        }
        if (response.result === undefined) {
            pending.reject(new RustSidecarRequestError(`Rust sidecar returned no result for ${pending.method}`, {
                code: 'MISSING_RESULT',
                fallbackAllowed: true,
            }));
            return;
        }
        pending.resolve(response.result);
    }
    handleChildFailure(error) {
        this.child = null;
        this.rejectAllPending(new RustSidecarRequestError(`Rust sidecar failed: ${error.message}`, {
            code: 'SIDECAR_PROCESS_ERROR',
            fallbackAllowed: true,
        }));
        this.emit('unavailable', {
            reason: 'process-error',
            message: error.message,
        });
    }
    handleChildExit(code, signal) {
        this.child = null;
        this.stdoutReader?.close();
        this.stdoutReader = null;
        if (this.disposing) {
            return;
        }
        this.crashCount += 1;
        const backoffMs = Math.min(30_000, 500 * 2 ** Math.min(this.crashCount, 6));
        this.restartAfterMs = Date.now() + backoffMs;
        this.rejectAllPending(new RustSidecarRequestError(`Rust sidecar exited (${code ?? signal ?? 'unknown'})`, {
            code: 'SIDECAR_EXITED',
            fallbackAllowed: true,
        }));
        this.emit('unavailable', {
            reason: 'exit',
            message: `Rust sidecar exited (${code ?? signal ?? 'unknown'})`,
        });
    }
    rejectAllPending(error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }
    killSidecarAfterTimeout(method) {
        console.warn(`[rust-sidecar] Request timed out; killing sidecar for recovery: ${method}`);
        const child = this.child;
        this.child = null;
        if (child && !child.killed) {
            child.kill();
        }
    }
}
exports.RustSidecarManager = RustSidecarManager;
function isSidecarEvent(value) {
    return (typeof value.streamId === 'string' &&
        typeof value.event === 'string' &&
        typeof value.sequence === 'number');
}
function resolveSidecarBinaryPath() {
    const extension = process.platform === 'win32' ? '.exe' : '';
    const overridePath = process.env.ONEDEVTOOL_RUST_SIDECAR_PATH;
    if (overridePath) {
        return overridePath;
    }
    const appPath = electron_1.app.getAppPath();
    const devCandidates = [
        path_1.default.resolve(appPath, 'native', 'file-watcher-sidecar', 'target', 'release', `one-devtool-sidecar${extension}`),
        path_1.default.resolve(appPath, '..', '1devtool-desktop-rust', 'target', 'debug', `one-devtool-sidecar${extension}`),
        path_1.default.resolve(appPath, 'target', 'debug', `one-devtool-sidecar${extension}`),
        path_1.default.resolve(appPath, 'dist', 'main', 'main', `one-devtool-sidecar${extension}`),
    ];
    const packagedCandidates = [
        path_1.default.join(process.resourcesPath, `one-devtool-sidecar${extension}`),
        path_1.default.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'main', 'main', `one-devtool-sidecar${extension}`),
    ];
    const candidates = electron_1.app.isPackaged ? [...packagedCandidates, ...devCandidates] : [...devCandidates, ...packagedCandidates];
    return candidates.find((candidate) => fs_1.default.existsSync(candidate)) ?? candidates[0];
}
