"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.tunnelManager = exports.TunnelManager = void 0;
const child_process_1 = require("child_process");
const events_1 = require("events");
const https_1 = __importDefault(require("https"));
const paths_1 = require("./paths");
const download_1 = require("./download");
const URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
// Wait only for the URL banner before declaring the tunnel "running" — cloudflared
// prints it within a few seconds and it's the final URL. Reachability is then
// confirmed by a NON-BLOCKING background probe of the unauthenticated /api/health
// endpoint (Error 1033 returns HTTP 530, a 2xx means edge → cloudflared → origin
// all work). Gating URL *display* on the probe is wrong: on warm-up/slow networks
// the probe can lag for many seconds, leaving the UI stuck on "Generating public
// URL…". So we show the URL immediately and surface reachability separately.
const DEFAULT_PROBE_PATH = '/api/health';
const PROBE_INTERVAL_MS = 1500;
const PROBE_REQUEST_TIMEOUT_MS = 5000;
// How long to keep probing for reachability after the URL appears, before giving
// up silently (the URL is still shown; cloudflare may warm up later). On
// UDP-blocked networks the forced-http2 path can take ~60-75s to register its
// edge connection — cloudflared's failed UDP feature/DNS lookups and protocol
// prechecks each time out first — so the window must comfortably exceed that or
// the UI would never flip from "warming up" to "reachable" even once the tunnel
// is live.
const PROBE_MAX_MS = 150_000;
// If cloudflared never even prints a URL, fail the start within this window.
const URL_TIMEOUT_MS = 20_000;
class TunnelManager extends events_1.EventEmitter {
    probePath;
    child = null;
    url = null;
    reachable = false;
    startedAt = null;
    stderrTail = [];
    probeTimer = null;
    constructor(probePath = DEFAULT_PROBE_PATH) {
        super();
        this.probePath = probePath;
    }
    isRunning() {
        return this.child !== null;
    }
    getStatus() {
        if (!this.child)
            return { running: false };
        return {
            running: true,
            url: this.url || undefined,
            reachable: this.reachable,
            startedAt: this.startedAt || undefined,
        };
    }
    clearProbeTimer() {
        if (this.probeTimer) {
            clearTimeout(this.probeTimer);
            this.probeTimer = null;
        }
    }
    /**
     * Resolve true when GET {url}{PROBE_PATH} returns a 2xx. Any non-2xx
     * (incl. Cloudflare's 530 for Error 1033) or transport error resolves false.
     */
    probeReady(url) {
        return new Promise((resolve) => {
            const req = https_1.default.get(`${url}${this.probePath}`, { timeout: PROBE_REQUEST_TIMEOUT_MS }, (res) => {
                const ok = res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300;
                res.resume(); // drain so the socket can be freed
                resolve(ok);
            });
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.on('error', () => resolve(false));
        });
    }
    /**
     * Background reachability probe — runs AFTER the URL is shown. Emits a single
     * 'reachable' event on the first 2xx, then stops. Never blocks URL display and
     * never errors the start; if reachability is never confirmed within
     * PROBE_MAX_MS it simply stops (URL stays usable).
     */
    beginReachabilityProbe(child, url) {
        const deadline = Date.now() + PROBE_MAX_MS;
        const tick = async () => {
            if (this.child !== child || this.reachable)
                return;
            const ready = await this.probeReady(url);
            if (this.child !== child || this.reachable)
                return;
            if (ready) {
                this.reachable = true;
                this.clearProbeTimer();
                this.emit('event', { type: 'reachable', url });
                return;
            }
            if (Date.now() < deadline) {
                this.probeTimer = setTimeout(tick, PROBE_INTERVAL_MS);
            }
            else {
                this.clearProbeTimer();
            }
        };
        void tick();
    }
    /**
     * Spawn cloudflared and wait for the public URL. Resolves once URL is parsed
     * from stderr, or rejects on 15s timeout / spawn error / early exit.
     */
    async start(localPort) {
        if (this.child) {
            return { ok: false, error: 'Tunnel is already running.' };
        }
        if (!(0, download_1.isInstalled)()) {
            return { ok: false, error: 'cloudflared is not installed yet.' };
        }
        this.emit('event', { type: 'starting' });
        const binPath = (0, paths_1.getBinaryPath)();
        const args = [
            'tunnel',
            '--url', `http://127.0.0.1:${localPort}`,
            '--no-autoupdate',
            // Force the HTTP/2 edge transport instead of cloudflared's default QUIC.
            // QUIC needs outbound UDP/7844; many residential ISPs (Spectrum, etc.) and
            // corporate/hotel/captive networks drop outbound UDP. On those networks
            // QUIC connects only after long retries (or not at all), so the public URL
            // can return Cloudflare "Error 1033" (no tunnel connections) for a long
            // time while the UI sits on "warming up". HTTP/2 runs over TCP and is the
            // most broadly reachable transport (cloudflared's own precheck literally
            // recommends "use HTTP2" when UDP is blocked). On a network where UDP works
            // both protocols connect in ~5s, so forcing http2 costs nothing there; on a
            // UDP-degraded network it's the difference between connecting and 1033.
            '--protocol', 'http2',
            // Skip cloudflared's startup connectivity pre-checks. On a UDP-blocked
            // network the precheck spends time probing UDP/QUIC + TCP to the edge and
            // logs an alarming "Environment has critical failures / hard_fail=true"
            // even though the http2 connection then succeeds anyway. The probes run
            // roughly in parallel with the real connection so they don't gate wall
            // clock, but skipping them removes redundant UDP work and the misleading
            // log. NOTE: the dominant warm-up cost on a UDP-blocked network is NOT the
            // precheck — it's cloudflared's hardcoded UDP DNS lookups to 8.8.8.8/8.8.4.4
            // for *.argotunnel.com (feature flags + protocol percentage), which each
            // hit their full ~10-20s timeout. There is no flag to point those at the
            // system/TCP resolver, so that ~30s is irreducible while outbound UDP/53 is
            // blocked. The real fix for instant warm-up is unblocking outbound UDP.
            '--no-prechecks',
        ];
        const child = (0, child_process_1.spawn)(binPath, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            // detached: false ensures child dies with the parent on signals.
            detached: false,
        });
        this.child = child;
        this.startedAt = Date.now();
        this.url = null;
        this.reachable = false;
        this.stderrTail = [];
        return new Promise((resolve) => {
            let settled = false;
            let reportedRunning = false;
            const settle = (result) => {
                if (settled)
                    return;
                settled = true;
                resolve(result);
            };
            // Only fails the start if cloudflared never even prints a URL. Once the
            // URL appears we settle immediately, so this timer is moot after that.
            const timeout = setTimeout(() => {
                if (!settled) {
                    this.clearProbeTimer();
                    const tail = this.stderrTail.slice(-5).join(' | ');
                    settle({
                        ok: false,
                        error: `Cloudflare didn't return a tunnel URL in time.${tail ? ` Last log: ${tail}` : ''}`,
                    });
                    this.killChildSync();
                }
            }, URL_TIMEOUT_MS);
            // CRITICAL: drain stdout *and* stderr for the child's whole life.
            // If we stop reading, the pipe buffer fills and cloudflared blocks.
            // We parse stderr for the trycloudflare URL but never detach the listener.
            child.stdout?.on('data', () => { });
            child.stderr?.on('data', (chunk) => {
                const text = chunk.toString();
                // Keep a small ring of recent stderr for diagnostic surfacing.
                for (const line of text.split('\n')) {
                    if (line.trim().length === 0)
                        continue;
                    this.stderrTail.push(line);
                    if (this.stderrTail.length > 50)
                        this.stderrTail.shift();
                }
                // The banner carries the final URL. Show it right away — don't make the
                // user wait on reachability — then verify reachability in the background.
                if (!this.url) {
                    const match = text.match(URL_REGEX);
                    if (match) {
                        this.url = match[0];
                        clearTimeout(timeout);
                        reportedRunning = true;
                        this.emit('event', { type: 'running', url: this.url });
                        settle({ ok: true, url: this.url });
                        this.beginReachabilityProbe(child, this.url);
                    }
                }
            });
            child.on('error', (err) => {
                clearTimeout(timeout);
                this.clearProbeTimer();
                const message = `Failed to spawn cloudflared: ${err.message}`;
                this.emit('event', { type: 'error', message });
                this.child = null;
                this.url = null;
                this.reachable = false;
                this.startedAt = null;
                settle({ ok: false, error: message });
            });
            child.on('exit', (code, signal) => {
                clearTimeout(timeout);
                this.clearProbeTimer();
                const wasRunning = this.child === child;
                this.child = null;
                this.url = null;
                this.reachable = false;
                this.startedAt = null;
                if (!settled) {
                    const tail = this.stderrTail.slice(-5).join(' | ');
                    settle({
                        ok: false,
                        error: `cloudflared exited (code=${code}, signal=${signal}). ${tail ? `Last log: ${tail}` : ''}`.trim(),
                    });
                }
                else if (wasRunning && reportedRunning) {
                    // Unexpected death after we'd reported "running" → surface as error.
                    this.emit('event', {
                        type: 'error',
                        message: `Tunnel ended unexpectedly (code=${code}, signal=${signal}).`,
                    });
                }
                this.emit('event', { type: 'stopped' });
            });
        });
    }
    /**
     * User-initiated stop. SIGTERM, then SIGKILL after a short grace period.
     * Returns once the child has exited (or grace expires).
     */
    async stop() {
        const child = this.child;
        if (!child)
            return;
        this.clearProbeTimer();
        return new Promise((resolve) => {
            const onExit = () => {
                clearTimeout(killTimer);
                resolve();
            };
            child.once('exit', onExit);
            try {
                if (process.platform === 'win32') {
                    // taskkill is the only reliable way to nuke a Windows process tree.
                    (0, child_process_1.spawn)('taskkill', ['/pid', String(child.pid), '/f', '/t']).on('error', () => { });
                }
                else {
                    child.kill('SIGTERM');
                }
            }
            catch { /* ignore */ }
            const killTimer = setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                }
                catch { /* ignore */ }
                resolve();
            }, 3000);
        });
    }
    /**
     * App-quit fast path. Synchronous SIGKILL — no grace, no awaiting. We're
     * tearing down; an orphaned cloudflared keeping the URL alive is much worse
     * than a slow quit. Must complete in well under 100ms.
     */
    killChildSync() {
        const child = this.child;
        if (!child)
            return;
        this.clearProbeTimer();
        this.child = null;
        this.url = null;
        this.reachable = false;
        this.startedAt = null;
        try {
            if (process.platform === 'win32') {
                // Fire-and-forget; we don't await on quit.
                (0, child_process_1.spawn)('taskkill', ['/pid', String(child.pid), '/f', '/t']).on('error', () => { });
            }
            else {
                child.kill('SIGKILL');
            }
        }
        catch { /* ignore */ }
    }
}
exports.TunnelManager = TunnelManager;
exports.tunnelManager = new TunnelManager();
