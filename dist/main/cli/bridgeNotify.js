"use strict";
/**
 * Best-effort delegation-lifecycle notifications from the standalone
 * `1devtool-agent` CLI to running 1DevTool app instances.
 *
 * Why: host TUIs (Codex especially) collapse multi-line commands in their
 * transcript (`• Ran TASK=$(cat <<'EOF'` + `… +N lines`), so the app's
 * transcript-scanning SubAgentBadge can never see the `--to=<agent>` line.
 * The CLI is the one place that reliably knows a delegation is running, so it
 * reports start/end itself.
 *
 * Design constraints:
 *  - Never fail or delay the delegation: single attempt per bridge, short
 *    hard timeout, all errors swallowed.
 *  - Notify EVERY alive bridge instance (dev + installed app commonly run
 *    side by side); each app badges only terminals it owns, others ignore.
 *  - No retries/backoff (unlike bridgeClient.ts, which serves long-lived MCP
 *    servers) — a dead bridge must cost ~nothing.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestInteractiveDelegation = requestInteractiveDelegation;
exports.requestPeerAuthenticatedOrchestration = requestPeerAuthenticatedOrchestration;
exports.requestReplyTokenThroughMailboxes = requestReplyTokenThroughMailboxes;
exports.requestSandboxCompatibleAgentOrchestration = requestSandboxCompatibleAgentOrchestration;
exports.requestAgentOrchestration = requestAgentOrchestration;
exports.createDelegationNotifier = createDelegationNotifier;
const node_fs_1 = __importDefault(require("node:fs"));
const node_http_1 = __importDefault(require("node:http"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_child_process_1 = require("node:child_process");
const orchestrationReplyMailbox_1 = require("../shared/orchestrationReplyMailbox");
const REQUEST_TIMEOUT_MS = 400;
const INTERACTIVE_REQUEST_TIMEOUT_MS = 20_000;
const ORCHESTRATION_REQUEST_TIMEOUT_MS = 10 * 60_000;
function isPidAlive(pid) {
    if (!pid || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === 'EPERM';
    }
}
/** All alive bridge instances (deduped by port), newest first. */
function discoverBridges() {
    const records = [];
    const seenPorts = new Set();
    try {
        const dir = node_path_1.default.join(node_os_1.default.homedir(), '.1devtool', 'bridges');
        for (const file of node_fs_1.default.readdirSync(dir)) {
            if (!file.endsWith('.json'))
                continue;
            try {
                const record = JSON.parse(node_fs_1.default.readFileSync(node_path_1.default.join(dir, file), 'utf-8'));
                if (typeof record.port !== 'number' || typeof record.pid !== 'number')
                    continue;
                if (!isPidAlive(record.pid) || seenPorts.has(record.port))
                    continue;
                seenPorts.add(record.port);
                records.push(record);
            }
            catch { /* skip unreadable record */ }
        }
    }
    catch { /* no bridges dir — no app running */ }
    return records.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}
function peerAuthRecord(record) {
    const endpoint = record.peerAuth;
    if (process.platform !== 'darwin' ||
        endpoint?.transport !== 'mach' ||
        endpoint.protocolVersion !== 1 ||
        typeof endpoint.serviceName !== 'string' ||
        !/^com\.stoicsoft\.1devtool\.peer\.[A-Za-z0-9.-]+$/.test(endpoint.serviceName) ||
        typeof endpoint.helperPath !== 'string' ||
        !node_path_1.default.isAbsolute(endpoint.helperPath) ||
        node_path_1.default.basename(endpoint.helperPath) !== '1devtool-peer-auth') {
        return null;
    }
    try {
        const stat = node_fs_1.default.statSync(endpoint.helperPath);
        if (!stat.isFile())
            return null;
    }
    catch {
        return null;
    }
    return {
        serviceName: endpoint.serviceName,
        helperPath: endpoint.helperPath,
    };
}
function replyMailboxRecord(record) {
    if (!(0, orchestrationReplyMailbox_1.isLinkReplyMailboxEndpoint)(record.replyMailbox, record.instanceId))
        return null;
    // Re-derive the path instead of trusting arbitrary filesystem targets from
    // the discovery JSON. The instance id and per-user temp root define the
    // only directory this CLI may write through this transport.
    return { endpoint: (0, orchestrationReplyMailbox_1.createLinkReplyMailboxEndpoint)(record.instanceId) };
}
function callPeerAuth(endpoint, body, timeoutMs) {
    return new Promise((resolve) => {
        const child = (0, node_child_process_1.spawn)(endpoint.helperPath, ['client', endpoint.serviceName], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let settled = false;
        let stdout = '';
        let stderr = '';
        const finish = (value) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            resolve(value);
        };
        const timeout = setTimeout(() => {
            try {
                child.kill();
            }
            catch { /* best-effort */ }
            finish({ ok: false, error: 'Timed out waiting for peer-authenticated orchestration' });
        }, timeoutMs);
        timeout.unref?.();
        child.stdout.on('data', (chunk) => {
            if (Buffer.byteLength(stdout) >= 256 * 1024)
                return;
            stdout += chunk.toString('utf8');
            if (Buffer.byteLength(stdout) > 256 * 1024)
                stdout = stdout.slice(0, 256 * 1024);
        });
        child.stderr.on('data', (chunk) => {
            // Always drain; diagnostics are bounded and returned only on failure.
            stderr = `${stderr}${chunk.toString('utf8')}`.slice(-16 * 1024);
        });
        child.once('error', (error) => {
            finish({ ok: false, error: `Could not start the peer-auth helper: ${error.message}` });
        });
        child.once('exit', (code) => {
            if (settled)
                return;
            if (code !== 0) {
                finish({
                    ok: false,
                    error: stderr.trim() || `Peer-auth helper exited with code ${code ?? 'unknown'}`,
                });
                return;
            }
            try {
                const parsed = JSON.parse(stdout || '{}');
                finish(isRecord(parsed) ? parsed : { ok: false, error: 'Peer-auth helper returned invalid JSON' });
            }
            catch {
                finish({ ok: false, error: 'Peer-auth helper returned invalid JSON' });
            }
        });
        child.stdin.end(JSON.stringify(body));
    });
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function postJson(record, urlPath, body) {
    return new Promise((resolve) => {
        const payload = JSON.stringify(body);
        const req = node_http_1.default.request({
            host: record.host || '127.0.0.1',
            port: record.port,
            path: urlPath,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            timeout: REQUEST_TIMEOUT_MS,
        }, (res) => {
            res.resume();
            res.on('end', resolve);
            res.on('error', () => resolve());
        });
        req.on('timeout', () => req.destroy());
        req.on('error', () => resolve());
        req.on('close', resolve);
        req.end(payload);
    });
}
function postJsonForResult(record, urlPath, body, timeoutMs) {
    return new Promise((resolve) => {
        const payload = JSON.stringify(body);
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            resolve(result);
        };
        const req = node_http_1.default.request({
            host: record.host || '127.0.0.1',
            port: record.port,
            path: urlPath,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            timeout: timeoutMs,
        }, (res) => {
            let responseBody = '';
            res.setEncoding('utf-8');
            res.on('data', (chunk) => {
                if (responseBody.length < 64_000)
                    responseBody += chunk;
            });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(responseBody || '{}');
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300 && parsed.ok === true && typeof parsed.terminalId === 'string') {
                        finish({ ok: true, terminalId: parsed.terminalId, ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}) });
                        return;
                    }
                    finish({
                        ok: false,
                        error: typeof parsed.error === 'string'
                            ? parsed.error
                            : `1DevTool bridge returned HTTP ${res.statusCode ?? 500}`,
                    });
                }
                catch {
                    finish({ ok: false, error: '1DevTool bridge returned an invalid response' });
                }
            });
            res.on('error', () => finish({ ok: false, error: '1DevTool bridge response failed' }));
        });
        req.on('timeout', () => {
            req.destroy();
            finish({ ok: false, error: 'Timed out waiting for 1DevTool to open the interactive terminal' });
        });
        req.on('error', () => finish({ ok: false, error: 'Could not reach this 1DevTool bridge instance' }));
        req.end(payload);
    });
}
/**
 * Ask the live 1DevTool instance that owns the calling terminal to open a
 * visible delegate terminal. All local bridge records are probed in parallel;
 * only the instance that can attribute the CLI PID to one of its PTYs accepts
 * the request, preventing a dev + packaged-app pair from double-spawning.
 */
function requestInteractiveDelegation(args) {
    const bridges = discoverBridges();
    if (bridges.length === 0) {
        return Promise.resolve({
            ok: false,
            error: 'No running 1DevTool instance was found. Interactive delegation must be launched from a live 1DevTool terminal.',
        });
    }
    const payload = {
        ...args,
        terminalId: process.env.ONEDEVTOOL_TERMINAL_ID || undefined,
        sourcePid: process.pid,
        sourcePpid: process.ppid,
    };
    return new Promise((resolve) => {
        let remaining = bridges.length;
        const errors = [];
        for (const bridge of bridges) {
            void postJsonForResult(bridge, '/subagent/interactive', payload, INTERACTIVE_REQUEST_TIMEOUT_MS).then((result) => {
                if (result.ok) {
                    resolve(result);
                    return;
                }
                errors.push(result.error);
                remaining -= 1;
                if (remaining === 0) {
                    resolve({
                        ok: false,
                        error: errors.find((error) => !error.includes('does not own'))
                            ?? errors[0]
                            ?? 'No 1DevTool instance accepted the interactive delegation.',
                    });
                }
            });
        }
    });
}
function postJsonForEnvelope(record, urlPath, body, timeoutMs) {
    return new Promise((resolve) => {
        const payload = JSON.stringify(body);
        const req = node_http_1.default.request({
            host: record.host || '127.0.0.1',
            port: record.port,
            path: urlPath,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            timeout: timeoutMs,
        }, (res) => {
            let text = '';
            res.setEncoding('utf-8');
            res.on('data', (chunk) => { if (text.length < 2 * 1024 * 1024)
                text += chunk; });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(text || '{}');
                    resolve({ status: res.statusCode ?? 500, body: parsed && typeof parsed === 'object' ? parsed : {} });
                }
                catch {
                    resolve({ status: res.statusCode ?? 500, body: { ok: false, error: '1DevTool bridge returned invalid JSON' } });
                }
            });
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: 504, body: { ok: false, error: 'Timed out waiting for Agent Orchestration' } }); });
        req.on('error', () => resolve({ status: 503, body: { ok: false, error: 'Could not reach this 1DevTool bridge instance' } }));
        req.end(payload);
    });
}
/**
 * V3-P0/V4-5 request. The Mach helper, not this DTO, supplies the caller
 * principal. There is deliberately no HTTP fallback: platforms or app
 * instances without a connection-bound principal may not serve pull reads.
 */
function requestPeerAuthenticatedOrchestration(action, payload, timeoutMs = 110_000) {
    if ('terminalId' in payload ||
        'sourcePid' in payload ||
        'sourcePpid' in payload ||
        'fromMemberId' in payload) {
        return Promise.resolve({ ok: false, error: 'Caller identity is not accepted on the peer-authenticated wire' });
    }
    const endpoints = discoverBridges()
        .map(peerAuthRecord)
        .filter((endpoint) => endpoint !== null);
    if (endpoints.length === 0) {
        return Promise.resolve({
            ok: false,
            error: process.platform === 'darwin'
                ? 'No running 1DevTool instance exposes the peer-authenticated orchestration transport'
                : 'Pull context reads (link read / screen / peers) are not available on this OS. ' +
                    'Only macOS has the connection-bound peer-auth transport today; Windows and Linux can still ' +
                    'use link send/ask when the target is ready. Granting full read permissions in the UI does ' +
                    'not enable pull reads here — that is a platform limit, not a missing consent grant.',
        });
    }
    return new Promise((resolve) => {
        let remaining = endpoints.length;
        const errors = [];
        for (const endpoint of endpoints) {
            void callPeerAuth(endpoint, { action, payload }, timeoutMs).then((result) => {
                const error = typeof result.error === 'string' ? result.error : '';
                const ownershipMiss = error.includes('does not own the calling terminal');
                // A packaged app and a development app may advertise different
                // peer-auth generations at the same time. An older instance not
                // knowing a new action is a capability miss, not the request result.
                const unsupportedAction = error.includes('Unsupported peer-auth orchestration action');
                const transientFailure = error.includes('peer-auth helper') ||
                    error.includes('transport stopped') ||
                    error.includes('Timed out');
                if (!ownershipMiss && !unsupportedAction && !transientFailure) {
                    resolve(result);
                    return;
                }
                if (error && !ownershipMiss && !unsupportedAction)
                    errors.push(error);
                remaining -= 1;
                if (remaining === 0) {
                    resolve({
                        ok: false,
                        error: errors[0] ?? 'No peer-authenticated 1DevTool instance owns the calling terminal',
                    });
                }
            });
        }
    });
}
function isDefinitivePeerAuthMiss(error) {
    return error.includes('No running 1DevTool instance exposes the peer-authenticated orchestration transport') ||
        error.includes('No peer-authenticated 1DevTool instance owns the calling terminal');
}
function replyMailboxOwnershipMiss(result) {
    return (typeof result.error === 'string' && result.error.includes('does not own the calling terminal')) || (
    // Compatibility with an app that predates the normalized ownership-miss
    // response. A process that knows the federated message but not its paired
    // admission cannot own this reply capability, so another live mailbox must
    // still get a chance to answer.
    result.error === 'no-link' && result.detail === 'federated admission is missing');
}
/**
 * A mailbox that REJECTED the request file (parse refusal, internal throw)
 * has said nothing about the token — it is a transport miss, not the verdict.
 * With a packaged app and a dev checkout running side by side, the non-owner
 * often answers first and fastest; letting its rejection win the race made
 * the CLI print `Invalid 1DevTool reply-mailbox request` while the owning
 * instance was mid-delivery of the very same reply (pipeline field failure).
 * Only surface it after every mailbox has answered and none was definitive.
 */
function replyMailboxProcessingRejection(result) {
    return typeof result.error === 'string' &&
        result.error.includes('Invalid 1DevTool reply-mailbox request');
}
function unlinkBestEffort(filePath) {
    try {
        node_fs_1.default.unlinkSync(filePath);
    }
    catch { /* already consumed or absent */ }
}
/**
 * Deliver one token-attributed reply through app-owned temp directories.
 * `null` means no request file was published, so another transport is safe.
 * Once any request is published, timeout is uncertain and must not downgrade.
 */
async function requestReplyTokenThroughMailboxes(payload, timeoutMs) {
    const replyToken = typeof payload.replyToken === 'string' ? payload.replyToken.trim() : '';
    const body = typeof payload.body === 'string' ? payload.body : '';
    const waitMs = typeof payload.waitMs === 'number' ? payload.waitMs : undefined;
    const gateDecision = payload.gateDecision === 'accept' || payload.gateDecision === 'reject'
        ? payload.gateDecision
        : undefined;
    if (!/^[0-9a-f]{24}$/i.test(replyToken) || !body || body.length > 64_000) {
        return { ok: false, error: 'Invalid token-attributed link reply' };
    }
    if (waitMs !== undefined && (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 120_000)) {
        return { ok: false, error: 'Invalid token-attributed link reply wait time' };
    }
    const mailboxes = discoverBridges()
        .map(replyMailboxRecord)
        .filter((record) => record !== null);
    if (mailboxes.length === 0)
        return null;
    const requestId = node_crypto_1.default.randomUUID();
    const request = {
        protocolVersion: orchestrationReplyMailbox_1.LINK_REPLY_MAILBOX_PROTOCOL_VERSION,
        requestId,
        action: 'link-send-by-token',
        replyToken,
        body,
        createdAt: Date.now(),
        ...(waitMs !== undefined ? { waitMs } : {}),
        ...(gateDecision ? { gateDecision } : {}),
    };
    const serialized = JSON.stringify(request);
    const published = [];
    for (const { endpoint } of mailboxes) {
        const requestPath = node_path_1.default.join(endpoint.requestDir, `${requestId}.json`);
        const responsePath = node_path_1.default.join(endpoint.responseDir, `${requestId}.json`);
        const tempPath = `${requestPath}.${process.pid}.tmp`;
        try {
            await node_fs_1.default.promises.writeFile(tempPath, serialized, { mode: 0o600, flag: 'wx' });
            await node_fs_1.default.promises.rename(tempPath, requestPath);
            published.push({ requestPath, responsePath });
        }
        catch {
            unlinkBestEffort(tempPath);
        }
    }
    if (published.length === 0)
        return null;
    const deadline = Date.now() + Math.max(1, Math.min(timeoutMs, 135_000));
    const completed = new Set();
    let rejection = null;
    try {
        while (Date.now() < deadline) {
            for (const entry of published) {
                if (completed.has(entry.responsePath))
                    continue;
                try {
                    const stat = await node_fs_1.default.promises.stat(entry.responsePath);
                    if (!stat.isFile() || stat.size <= 0 || stat.size > orchestrationReplyMailbox_1.LINK_REPLY_MAILBOX_MAX_RESPONSE_BYTES) {
                        return { ok: false, error: '1DevTool reply mailbox returned an invalid response' };
                    }
                    const parsed = JSON.parse(await node_fs_1.default.promises.readFile(entry.responsePath, 'utf8'));
                    const result = isRecord(parsed)
                        ? parsed
                        : { ok: false, error: '1DevTool reply mailbox returned an invalid response' };
                    completed.add(entry.responsePath);
                    if (replyMailboxProcessingRejection(result)) {
                        rejection = result;
                        continue;
                    }
                    if (!replyMailboxOwnershipMiss(result))
                        return result;
                }
                catch (error) {
                    if (error.code !== 'ENOENT') {
                        return { ok: false, error: 'Could not read the 1DevTool reply-mailbox response' };
                    }
                }
            }
            if (completed.size === published.length) {
                return rejection ?? { ok: false, error: 'No running 1DevTool instance owns this reply token' };
            }
            await new Promise((resolve) => setTimeout(resolve, 40));
        }
        return {
            ok: false,
            error: 'Timed out waiting for the 1DevTool reply mailbox; delivery status is uncertain',
        };
    }
    finally {
        for (const entry of published) {
            unlinkBestEffort(entry.requestPath);
            unlinkBestEffort(entry.responsePath);
        }
    }
}
/**
 * Link writes issued by Codex cannot rely on the loopback HTTP bridge. A
 * reply token first uses the capability-scoped temp-file mailbox because the
 * sandbox can deny both TCP and Mach lookup. PTY-attributed macOS writes then
 * prefer Mach. HTTP remains the compatibility path only before any mutation
 * has been published; an uncertain write never crosses a second transport.
 */
async function requestSandboxCompatibleAgentOrchestration(action, urlPath, payload, timeoutMs = ORCHESTRATION_REQUEST_TIMEOUT_MS) {
    if (action === 'link-send-by-token') {
        const mailboxResult = await requestReplyTokenThroughMailboxes(payload, timeoutMs);
        if (mailboxResult)
            return mailboxResult;
    }
    if (process.platform !== 'darwin') {
        return requestAgentOrchestration(urlPath, payload, timeoutMs);
    }
    const peerResult = await requestPeerAuthenticatedOrchestration(action, payload, timeoutMs);
    if (peerResult.ok === true)
        return peerResult;
    const error = typeof peerResult.error === 'string' ? peerResult.error : '';
    if (!isDefinitivePeerAuthMiss(error))
        return peerResult;
    return requestAgentOrchestration(urlPath, payload, timeoutMs);
}
/** Authenticated Team/Swarm request. The desktop instance proves the CLI's
 * PTY ancestry; probing all local bridges cannot double-mutate because only
 * the owning instance accepts the request and all starts/sends are durably
 * idempotent. */
function requestAgentOrchestration(urlPath, payload, timeoutMs = ORCHESTRATION_REQUEST_TIMEOUT_MS) {
    const bridges = discoverBridges();
    if (bridges.length === 0) {
        return Promise.resolve({ ok: false, error: 'No running 1DevTool instance was found' });
    }
    const body = {
        ...payload,
        terminalId: process.env.ONEDEVTOOL_TERMINAL_ID || undefined,
        sourcePid: process.pid,
        sourcePpid: process.ppid,
    };
    return new Promise((resolve) => {
        let remaining = bridges.length;
        const errors = [];
        for (const bridge of bridges) {
            void postJsonForEnvelope(bridge, urlPath, body, timeoutMs).then((result) => {
                const error = typeof result.body.error === 'string' ? result.body.error : '';
                const ownershipMiss = error.includes('does not own the calling terminal');
                // A packaged app and a development app commonly run together. An
                // older bridge answers a new orchestration route with HTTP 404 before
                // the owning/newer bridge finishes. That is a capability miss, not the
                // result of the request, so never let it win the response race.
                const unsupportedRoute = result.status === 404 || error.trim().toLowerCase() === 'not found';
                const transientFailure = result.status >= 500;
                if (!ownershipMiss && !unsupportedRoute && !transientFailure) {
                    resolve(result.body);
                    return;
                }
                if (error && !ownershipMiss && !unsupportedRoute)
                    errors.push(error);
                remaining -= 1;
                if (remaining === 0) {
                    resolve({
                        ok: false,
                        error: errors[0]
                            ?? 'No compatible 1DevTool instance owns the calling terminal',
                    });
                }
            });
        }
    });
}
/**
 * Build a notifier for one delegation run. Discovery happens once, up front;
 * `start`/`end` each resolve within ~REQUEST_TIMEOUT_MS worst case, instantly
 * when no app is running.
 */
function createDelegationNotifier(args) {
    const bridges = discoverBridges();
    const base = {
        callId: args.callId,
        terminalId: process.env.ONEDEVTOOL_TERMINAL_ID || undefined,
        sourcePid: process.pid,
        sourcePpid: process.ppid,
    };
    return {
        start: async () => {
            if (bridges.length === 0)
                return;
            await Promise.all(bridges.map((b) => postJson(b, '/subagent/start', {
                ...base,
                target: args.target,
                command: args.command,
                startedAt: Date.now(),
                timeoutSeconds: args.timeoutSeconds,
            })));
        },
        end: async (status, exitCode) => {
            if (bridges.length === 0)
                return;
            await Promise.all(bridges.map((b) => postJson(b, '/subagent/end', {
                callId: args.callId,
                status,
                endedAt: Date.now(),
                exitCode,
            })));
        },
    };
}
