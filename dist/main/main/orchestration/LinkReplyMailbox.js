"use strict";
/**
 * Sandbox-safe, capability-scoped return path for terminal links.
 *
 * Codex's command sandbox may deny both loopback TCP and Mach service lookup.
 * It can still atomically place a request in its per-user temp directory. This
 * bridge accepts only `link-send-by-token`; the single-use token resolves the
 * durable sender, recipient, and correlation record inside LinkRegistry.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LinkReplyMailbox = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const orchestrationReplyMailbox_1 = require("../../shared/orchestrationReplyMailbox");
const SCAN_INTERVAL_MS = 250;
const MAX_FILES_PER_SCAN = 64;
const STALE_FILE_MS = 10 * 60_000;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function safeResponse(value) {
    try {
        const serialized = JSON.stringify(isRecord(value) ? value : {
            ok: false,
            error: '1DevTool reply mailbox returned an invalid response',
        });
        if (Buffer.byteLength(serialized) <= orchestrationReplyMailbox_1.LINK_REPLY_MAILBOX_MAX_RESPONSE_BYTES)
            return serialized;
    }
    catch {
        // Fall through to a bounded typed error.
    }
    return JSON.stringify({ ok: false, error: '1DevTool reply mailbox response exceeds the transport limit' });
}
class LinkReplyMailbox {
    deps;
    endpoint;
    watcher = null;
    scanTimer = null;
    scanning = false;
    scanAgain = false;
    stopped = true;
    lastCleanupAt = 0;
    constructor(deps) {
        this.deps = deps;
        this.endpoint = (0, orchestrationReplyMailbox_1.createLinkReplyMailboxEndpoint)(deps.instanceId);
    }
    start() {
        if (!this.stopped)
            return this.endpoint;
        this.stopped = false;
        const root = node_path_1.default.dirname(this.endpoint.requestDir);
        node_fs_1.default.mkdirSync(this.endpoint.requestDir, { recursive: true, mode: 0o700 });
        node_fs_1.default.mkdirSync(this.endpoint.responseDir, { recursive: true, mode: 0o700 });
        for (const directory of [root, this.endpoint.requestDir, this.endpoint.responseDir]) {
            try {
                node_fs_1.default.chmodSync(directory, 0o700);
            }
            catch { /* best-effort hardening */ }
        }
        try {
            this.watcher = node_fs_1.default.watch(this.endpoint.requestDir, { persistent: false }, () => this.queueScan());
            this.watcher.on('error', (error) => {
                this.deps.log?.(`[link-reply-mailbox] watcher failed: ${error.message}`);
            });
        }
        catch (error) {
            this.deps.log?.(`[link-reply-mailbox] watcher unavailable: ${error.message}`);
        }
        // fs.watch is a latency hint, not the correctness boundary. A short
        // unref'ed scan closes dropped-event races without keeping Electron alive.
        this.scanTimer = setInterval(() => this.queueScan(), SCAN_INTERVAL_MS);
        this.scanTimer.unref?.();
        this.queueScan();
        return this.endpoint;
    }
    stop() {
        if (this.stopped)
            return;
        this.stopped = true;
        this.watcher?.close();
        this.watcher = null;
        if (this.scanTimer)
            clearInterval(this.scanTimer);
        this.scanTimer = null;
        const root = node_path_1.default.dirname(this.endpoint.requestDir);
        try {
            node_fs_1.default.rmSync(root, { recursive: true, force: true });
        }
        catch { /* temporary best-effort cleanup */ }
    }
    queueScan() {
        if (this.stopped)
            return;
        if (this.scanning) {
            this.scanAgain = true;
            return;
        }
        this.scanning = true;
        void this.scan().finally(() => {
            this.scanning = false;
            if (this.scanAgain && !this.stopped) {
                this.scanAgain = false;
                this.queueScan();
            }
        });
    }
    async scan() {
        this.cleanupStaleFiles();
        let files;
        try {
            files = node_fs_1.default.readdirSync(this.endpoint.requestDir)
                .filter((file) => orchestrationReplyMailbox_1.LINK_REPLY_MAILBOX_REQUEST_ID_RE.test(file.replace(/\.json$/, '')) && file.endsWith('.json'))
                .slice(0, MAX_FILES_PER_SCAN);
        }
        catch {
            return;
        }
        await Promise.all(files.map((file) => this.processFile(file)));
    }
    async processFile(file) {
        const requestId = file.slice(0, -'.json'.length);
        const inputPath = node_path_1.default.join(this.endpoint.requestDir, file);
        const claimedPath = node_path_1.default.join(this.endpoint.requestDir, `${requestId}.processing`);
        try {
            node_fs_1.default.renameSync(inputPath, claimedPath);
        }
        catch {
            return;
        }
        let result = { ok: false, error: 'Invalid 1DevTool reply-mailbox request' };
        try {
            const stat = node_fs_1.default.statSync(claimedPath);
            if (!stat.isFile() || stat.size <= 0 || stat.size > orchestrationReplyMailbox_1.LINK_REPLY_MAILBOX_MAX_REQUEST_BYTES) {
                throw new Error('request size is invalid');
            }
            if (typeof process.getuid === 'function' &&
                (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) {
                throw new Error('request ownership or mode is invalid');
            }
            const parsed = (0, orchestrationReplyMailbox_1.parseLinkReplyMailboxRequest)(JSON.parse(node_fs_1.default.readFileSync(claimedPath, 'utf8')));
            if (!parsed || parsed.requestId !== requestId)
                throw new Error('request shape is invalid');
            result = await this.deps.onRequest(parsed);
        }
        catch (error) {
            this.deps.log?.(`[link-reply-mailbox] rejected ${requestId}: ${error.message}`);
        }
        try {
            node_fs_1.default.unlinkSync(claimedPath);
        }
        catch { /* already consumed */ }
        if (this.stopped)
            return;
        const responsePath = node_path_1.default.join(this.endpoint.responseDir, `${requestId}.json`);
        const tempPath = `${responsePath}.${process.pid}.tmp`;
        try {
            node_fs_1.default.writeFileSync(tempPath, safeResponse(result), { mode: 0o600 });
            node_fs_1.default.renameSync(tempPath, responsePath);
        }
        catch (error) {
            try {
                node_fs_1.default.unlinkSync(tempPath);
            }
            catch { /* no partial file */ }
            this.deps.log?.(`[link-reply-mailbox] response failed for ${requestId}: ${error.message}`);
        }
    }
    cleanupStaleFiles() {
        const now = Date.now();
        if (now - this.lastCleanupAt < 60_000)
            return;
        this.lastCleanupAt = now;
        for (const directory of [this.endpoint.requestDir, this.endpoint.responseDir]) {
            let files;
            try {
                files = node_fs_1.default.readdirSync(directory);
            }
            catch {
                continue;
            }
            for (const file of files.slice(0, 256)) {
                if (!orchestrationReplyMailbox_1.LINK_REPLY_MAILBOX_REQUEST_ID_RE.test(file.replace(/\.(?:json|processing)$/, '')))
                    continue;
                const fullPath = node_path_1.default.join(directory, file);
                try {
                    if (now - node_fs_1.default.statSync(fullPath).mtimeMs > STALE_FILE_MS)
                        node_fs_1.default.unlinkSync(fullPath);
                }
                catch { /* disappeared during cleanup */ }
            }
        }
    }
}
exports.LinkReplyMailbox = LinkReplyMailbox;
