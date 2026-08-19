"use strict";
/**
 * Shared bridge discovery + HTTP client for MCP servers (design, channels).
 *
 * Discovery (Pillar 2):
 *  - Prefer per-instance `~/.1devtool/bridges/<id>.json` records (PID-stamped).
 *    Pick the most recently started bridge whose PID is still alive.
 *  - Fall back to the legacy single `~/.1devtool/mcp-bridge-port` file so MCP
 *    servers from older 1DevTool versions still work after the desktop app
 *    upgrades — and so brand-new servers still work if the user is running an
 *    older desktop build that hasn't written instance records yet.
 *
 * Resilience:
 *  - Cache the resolved port for 30s.
 *  - On any HTTP failure (ECONNREFUSED / ECONNRESET / EPIPE / parse), invalidate
 *    cache, re-discover, and retry with backoff (100 / 500 / 2000 ms, max 3).
 *  - Single keep-alive Agent per process — no socket churn.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.bridgeRequestRaw = bridgeRequestRaw;
exports.bridgeText = bridgeText;
exports.bridgeJson = bridgeJson;
const fs_1 = __importDefault(require("fs"));
const http_1 = __importDefault(require("http"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const PORT_CACHE_TTL_MS = 30_000;
const RETRY_BACKOFFS_MS = [100, 500, 2_000];
const httpAgent = new http_1.default.Agent({ keepAlive: true, maxSockets: 8 });
let cachedPort = null;
let cachedAt = 0;
function bridgesDir() {
    return path_1.default.join(os_1.default.homedir(), '.1devtool', 'bridges');
}
function legacyPortFile() {
    return path_1.default.join(os_1.default.homedir(), '.1devtool', 'mcp-bridge-port');
}
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
function discoverFromInstances(excludePort) {
    const dir = bridgesDir();
    if (!fs_1.default.existsSync(dir))
        return null;
    let best = null;
    for (const file of fs_1.default.readdirSync(dir)) {
        if (!file.endsWith('.json'))
            continue;
        try {
            const record = JSON.parse(fs_1.default.readFileSync(path_1.default.join(dir, file), 'utf-8'));
            if (typeof record.port !== 'number' || typeof record.pid !== 'number')
                continue;
            // Skip a port we just failed to reach so a stale record (live PID, dead
            // listener) doesn't shadow another healthy bridge.
            if (excludePort != null && record.port === excludePort)
                continue;
            if (!isPidAlive(record.pid))
                continue;
            if (!best || record.startedAt > best.startedAt) {
                best = record;
            }
        }
        catch {
            // Skip corrupt files
        }
    }
    return best ? best.port : null;
}
function discoverFromLegacy() {
    try {
        const port = parseInt(fs_1.default.readFileSync(legacyPortFile(), 'utf-8').trim(), 10);
        return Number.isFinite(port) && port > 0 ? port : null;
    }
    catch {
        return null;
    }
}
function resolveBridgePort(forceRefresh = false, excludePort) {
    if (!forceRefresh && cachedPort != null && Date.now() - cachedAt < PORT_CACHE_TTL_MS) {
        return cachedPort;
    }
    let port = discoverFromInstances(excludePort) ?? discoverFromLegacy();
    // The legacy single-port file carries no liveness info — if it points at the
    // port that just failed, there's nothing else to fall back to.
    if (port != null && excludePort != null && port === excludePort) {
        port = null;
    }
    if (port == null) {
        throw new Error('1DevTool is not running. Open 1DevTool first, then retry.');
    }
    cachedPort = port;
    cachedAt = Date.now();
    return port;
}
function invalidatePortCache() {
    cachedPort = null;
    cachedAt = 0;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function singleRequest(endpoint, body, port) {
    const payload = body == null ? undefined : Buffer.from(JSON.stringify(body));
    const options = {
        host: '127.0.0.1',
        port,
        path: endpoint,
        method: payload ? 'POST' : 'GET',
        agent: httpAgent,
        headers: payload
            ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
            : {},
    };
    return new Promise((resolve, reject) => {
        const req = http_1.default.request(options, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                resolve({ raw: Buffer.concat(chunks).toString('utf-8'), status: res.statusCode ?? 0 });
            });
            res.on('error', reject);
        });
        req.on('error', reject);
        if (payload)
            req.write(payload);
        req.end();
    });
}
function isTransientNetworkError(err) {
    const code = err?.code;
    return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT';
}
/**
 * Perform a request against the bridge with full resilience: port re-discovery
 * on connection failures, exponential backoff between retries. Caller gets the
 * raw response string (or a thrown error after all retries are exhausted).
 */
async function bridgeRequestRaw(endpoint, body) {
    let lastErr = null;
    let excludePort;
    for (let attempt = 0; attempt <= RETRY_BACKOFFS_MS.length; attempt++) {
        let port;
        try {
            // First attempt uses the cached port; once a port has failed we force a
            // refresh that skips it, so a dead bridge falls through to the next live one.
            port = resolveBridgePort(excludePort != null, excludePort);
        }
        catch (discoveryErr) {
            // No live bridge discoverable. Prefer the earlier network error (more
            // specific) over the generic "not running" message when we have one.
            throw lastErr instanceof Error ? lastErr : discoveryErr;
        }
        try {
            const resp = await singleRequest(endpoint, body, port);
            if (resp.status >= 400) {
                // 4xx/5xx are real errors — don't retry; let caller surface to AI.
                throw new Error(`Bridge error (${resp.status}): ${resp.raw}`);
            }
            return resp;
        }
        catch (err) {
            lastErr = err;
            if (!isTransientNetworkError(err))
                throw err;
            invalidatePortCache();
            excludePort = port;
            if (attempt < RETRY_BACKOFFS_MS.length) {
                await sleep(RETRY_BACKOFFS_MS[attempt]);
                continue;
            }
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
/** Convenience: response body as raw text (no parse-then-restringify). */
async function bridgeText(endpoint, body) {
    const { raw } = await bridgeRequestRaw(endpoint, body);
    return raw;
}
/** Convenience: response body parsed as JSON. */
async function bridgeJson(endpoint, body) {
    const text = await bridgeText(endpoint, body);
    return JSON.parse(text);
}
