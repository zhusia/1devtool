"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.onEvent = onEvent;
exports.getStatus = getStatus;
exports.enableServeHttps = enableServeHttps;
exports.disableServeHttps = disableServeHttps;
exports.isServeActive = isServeActive;
exports.startAdvertisePoll = startAdvertisePoll;
exports.stopAdvertisePoll = stopAdvertisePoll;
/**
 * Tailscale facade for the Remote "Tailscale / VPN" connection mode.
 *
 * Detect-and-advertise + optional Serve HTTPS reverse-proxy:
 *   - User installs/runs the official Tailscale app (we never download it).
 *   - We detect the tailnet address and MagicDNS name.
 *   - For Safari/mobile we configure `tailscale serve` so the QR encodes a
 *     trusted `https://*.ts.net` URL (plain `http://100.x` is torn down by
 *     Safari the same way LAN plain-HTTP is).
 *   - A loss-watch poll reverts advertising if Tailscale disappears.
 *
 * See src/main/tailscale/serve.ts and docs/remote_settings_tailscale.md.
 */
const events_1 = require("events");
const detect_1 = require("./detect");
const serve_1 = require("./serve");
/** Absorbs UI re-fetch bursts without re-running the CLI. */
const STATUS_CACHE_MS = 3000;
/** Interface-scan cadence while a tailnet URL is advertised. */
const POLL_INTERVAL_MS = 10_000;
const events = new events_1.EventEmitter();
let cached = null;
let inflight = null;
let pollTimer = null;
/** Local port we last pointed Serve at — used to tear the handler down cleanly. */
let serveLocalPort = null;
function onEvent(cb) {
    events.on('event', cb);
    return () => events.off('event', cb);
}
/**
 * Current Tailscale status. Detection runs on demand (CLI + interface scan)
 * with a short memo; `force` bypasses the memo for explicit user re-checks.
 * Concurrent callers share one in-flight detection.
 */
async function getStatus(force = false) {
    if (!force && cached && Date.now() - cached.at < STATUS_CACHE_MS) {
        return cached.status;
    }
    if (!inflight) {
        inflight = (0, detect_1.detectTailscale)()
            .then((status) => {
            cached = { status, at: Date.now() };
            return status;
        })
            .finally(() => {
            inflight = null;
        });
    }
    return inflight;
}
/**
 * Configure Tailscale Serve as an HTTPS reverse proxy to the local remote
 * port and return the public `https://*.ts.net` URL to advertise.
 */
async function enableServeHttps(localPort, status) {
    const ts = status ?? (await getStatus(true));
    const result = await (0, serve_1.enableHttpsProxy)(localPort, ts.magicDnsName, ts.nodeId);
    if (result.ok) {
        serveLocalPort = localPort;
    }
    return { ...result, status: ts };
}
/**
 * Tear down the Serve handler we configured (if any). Safe to call when we
 * never enabled Serve — no-ops against a missing config.
 */
async function disableServeHttps() {
    const port = serveLocalPort;
    serveLocalPort = null;
    if (port == null)
        return;
    try {
        await (0, serve_1.disableHttpsProxy)(port);
    }
    catch {
        // Best-effort; a leftover handler is less bad than blocking stop/disable.
    }
}
/** True when we currently own a Serve reverse-proxy for the remote port. */
function isServeActive() {
    return serveLocalPort != null;
}
/**
 * Start watching for Tailscale loss while advertised. Each tick is a cheap
 * interface scan; the CLI is consulted only when the interface disappears, to
 * distinguish "Tailscale off" from a flaky read. On confirmed loss the poll
 * stops itself and emits a single 'stopped' event — the IPC layer clears the
 * URL override and notifies the renderer.
 */
function startAdvertisePoll() {
    if (pollTimer)
        return;
    schedulePollTick();
}
function stopAdvertisePoll() {
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
}
function schedulePollTick() {
    pollTimer = setTimeout(() => {
        void pollTick();
    }, POLL_INTERVAL_MS);
    // Never keep the app alive for this.
    pollTimer.unref();
}
async function pollTick() {
    if (!pollTimer)
        return;
    if ((0, detect_1.findTailscaleInterfaceIp)()) {
        schedulePollTick();
        return;
    }
    const status = await getStatus(true);
    if (!pollTimer)
        return; // stopped while detection ran
    if (status.running && status.ip) {
        schedulePollTick();
        return;
    }
    stopAdvertisePoll();
    // Tailscale is gone — Serve config is orphaned until next enable; clear our
    // ownership marker so a later enable re-runs serve instead of assuming it.
    serveLocalPort = null;
    events.emit('event', { type: 'stopped', status });
}
