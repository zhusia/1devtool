"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveCliPath = resolveCliPath;
exports.parseServeEnableUrl = parseServeEnableUrl;
exports.serveEnableUrlForNode = serveEnableUrlForNode;
exports.httpsUrlForMagicDns = httpsUrlForMagicDns;
exports.isServeNotEnabledOutput = isServeNotEnabledOutput;
exports.enableHttpsProxy = enableHttpsProxy;
exports.disableHttpsProxy = disableHttpsProxy;
/**
 * Tailscale Serve HTTPS reverse-proxy for the phone Remote UI.
 *
 * Plain `http://100.x.y.z:1834` is fine for the QR-scanner in-app browser, but
 * iOS/macOS Safari still treats the CGNAT 100.64/10 range as a private-network
 * destination and tears down sustained Socket.IO sessions over insecure HTTP
 * (same class of failure as LAN mode — see
 * docs/common-errors/remote/pairing-in-app-browser-handoff.md and the
 * remote-ios-safari-lan memory note).
 *
 * `tailscale serve` terminates TLS with a tailnet-issued cert on the node's
 * MagicDNS name (`https://<host>.ts.net`) and reverse-proxies to the local
 * remote server. That trusted HTTPS origin is what Safari needs.
 *
 * Serve requires a one-time admin enable ("HTTPS certificates" / Serve) on the
 * tailnet. When it isn't enabled the CLI prints a consent URL and waits — we
 * must never hang the app on that prompt.
 */
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const util_1 = require("util");
const detect_1 = require("./detect");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
/** Keep short: when Serve isn't enabled the CLI prints a URL then waits forever. */
const CLI_TIMEOUT_MS = 6000;
const CLI_MAX_BUFFER = 1024 * 1024;
function defaultRunCli(file, args) {
    return execFileAsync(file, args, {
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: CLI_MAX_BUFFER,
        // Combined so a killed-on-timeout process still yields the enable URL.
        encoding: 'utf8',
        // Without TERM the macOS binary runs as the GUI, not the CLI — see cliEnv.
        env: (0, detect_1.cliEnv)(),
    }).then((r) => ({
        stdout: typeof r.stdout === 'string' ? r.stdout : String(r.stdout ?? ''),
        stderr: typeof r.stderr === 'string' ? r.stderr : String(r.stderr ?? ''),
    }));
}
/** Resolve the first absolute CLI candidate, else bare `tailscale` on PATH. */
function resolveCliPath(platform = process.platform, existsSync = fs_1.default.existsSync) {
    const candidates = (0, detect_1.cliCandidates)(platform);
    for (const c of candidates) {
        if (c !== 'tailscale' && existsSync(c))
            return c;
    }
    return 'tailscale';
}
/**
 * Parse the "Serve is not enabled… visit: <url>" message the CLI prints when
 * HTTPS certificates / Serve aren't turned on for the tailnet.
 */
function parseServeEnableUrl(text) {
    if (!text)
        return null;
    // Prefer the explicit serve consent page.
    const serveMatch = text.match(/https:\/\/login\.tailscale\.com\/f\/serve\?[^\s"'<>]+/i);
    if (serveMatch)
        return serveMatch[0].replace(/[.,;]+$/, '');
    // Broader fallback for other consent URLs Tailscale may print.
    const anyLogin = text.match(/https:\/\/login\.tailscale\.com\/[^\s"'<>]+/i);
    if (anyLogin && /serve|https|cert/i.test(text)) {
        return anyLogin[0].replace(/[.,;]+$/, '');
    }
    return null;
}
/**
 * Build the admin consent URL from the node id when the CLI hung without a
 * parseable message (or before we run serve). Same shape the CLI prints.
 */
function serveEnableUrlForNode(nodeId) {
    if (!nodeId || typeof nodeId !== 'string')
        return null;
    const id = nodeId.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(id))
        return null;
    return `https://login.tailscale.com/f/serve?node=${id}`;
}
/**
 * Public HTTPS origin for a MagicDNS name. Serve defaults to port 443, so no
 * port is appended. Strips a trailing DNS dot if present.
 */
function httpsUrlForMagicDns(magicDnsName) {
    const host = magicDnsName.replace(/\.$/, '').trim();
    return `https://${host}`;
}
/**
 * Whether combined CLI output indicates Serve/HTTPS isn't enabled yet.
 * Checked even on success paths — some CLI versions exit 0 after printing the
 * consent URL in foreground mode.
 */
function isServeNotEnabledOutput(text) {
    return /serve is not enabled|does not support getting TLS certs|HTTPS certificates/i.test(text);
}
/**
 * Enable a background HTTPS reverse proxy to the local remote port.
 *
 * Uses `tailscale serve --bg --yes http://127.0.0.1:<port>` so WebSocket
 * upgrades (Socket.IO) flow through the same origin as the static UI.
 *
 * @param localPort - port the remote HTTP server is already listening on
 * @param magicDnsName - Self.DNSName (no scheme); required for the public URL
 * @param nodeId - optional Self.ID used to build the enable-HTTPS consent URL
 */
async function enableHttpsProxy(localPort, magicDnsName, nodeId, deps = {}) {
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
        return { ok: false, error: 'Invalid local port for Tailscale Serve.' };
    }
    if (!magicDnsName || !magicDnsName.trim()) {
        return {
            ok: false,
            error: 'Tailscale has no MagicDNS name on this machine. Enable MagicDNS in the Tailscale admin console, or use Cloudflare Tunnel for Safari.',
        };
    }
    const runCli = deps.runCli ?? defaultRunCli;
    const existsSync = deps.existsSync ?? fs_1.default.existsSync;
    const platform = deps.platform ?? process.platform;
    const cli = resolveCliPath(platform, existsSync);
    const target = `http://127.0.0.1:${localPort}`;
    const fallbackEnableUrl = serveEnableUrlForNode(nodeId);
    let combined = '';
    try {
        // Default mode is HTTPS on 443 → https://<magicdns>/
        const { stdout, stderr } = await runCli(cli, ['serve', '--bg', '--yes', target]);
        combined = `${stdout}\n${stderr}`;
    }
    catch (err) {
        const e = err;
        combined = `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`;
        if (e.code === 'ENOENT') {
            return { ok: false, error: 'Tailscale CLI not found. Is Tailscale installed?' };
        }
        const enableUrl = parseServeEnableUrl(combined) ?? fallbackEnableUrl;
        if (enableUrl || isServeNotEnabledOutput(combined)) {
            return {
                ok: false,
                enableUrl: enableUrl ?? undefined,
                error: 'Tailscale HTTPS (Serve) is not enabled on your tailnet yet. Open the enable link once, then try again — Safari needs HTTPS.',
            };
        }
        // Timeout while waiting for interactive consent — same recovery path.
        if (e.killed || e.message?.includes('TIMEOUT') || /ETIMEDOUT|timed out/i.test(e.message ?? '')) {
            return {
                ok: false,
                enableUrl: enableUrl ?? fallbackEnableUrl ?? undefined,
                error: 'Timed out configuring Tailscale Serve. If HTTPS certificates are not enabled on your tailnet, open the enable link, then try again.',
            };
        }
        return {
            ok: false,
            enableUrl: enableUrl ?? undefined,
            error: `Failed to configure Tailscale Serve: ${(e.message || 'unknown error').slice(0, 200)}`,
        };
    }
    if (isServeNotEnabledOutput(combined)) {
        const enableUrl = parseServeEnableUrl(combined) ?? fallbackEnableUrl;
        return {
            ok: false,
            enableUrl: enableUrl ?? undefined,
            error: 'Tailscale HTTPS (Serve) is not enabled on your tailnet yet. Open the enable link once, then try again — Safari needs HTTPS.',
        };
    }
    // Confirm the serve config is live when possible; still trust the MagicDNS
    // URL if status is empty (some CLI builds print human status only).
    try {
        const { stdout, stderr } = await runCli(cli, ['serve', 'status', '--json']);
        const statusText = `${stdout}\n${stderr}`;
        // If status clearly has no handlers and CLI printed nothing useful, still
        // return the MagicDNS HTTPS URL — enable succeeded above.
        void statusText;
    }
    catch {
        // Status probe is best-effort; --bg succeed means config was applied.
    }
    return { ok: true, url: httpsUrlForMagicDns(magicDnsName) };
}
/**
 * Remove the HTTPS reverse proxy we configured. Prefer turning off only the
 * default HTTPS handler rather than `serve reset` (which wipes the user's
 * other Serve handlers on this node).
 */
async function disableHttpsProxy(localPort, deps = {}) {
    const runCli = deps.runCli ?? defaultRunCli;
    const existsSync = deps.existsSync ?? fs_1.default.existsSync;
    const platform = deps.platform ?? process.platform;
    const cli = resolveCliPath(platform, existsSync);
    const target = `http://127.0.0.1:${localPort}`;
    // Mirror of the enable command with trailing `off` — removes that handler.
    try {
        await runCli(cli, ['serve', '--bg', '--yes', target, 'off']);
        return { ok: true };
    }
    catch (err) {
        const e = err;
        const combined = `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`;
        // Already off / no config is success for our purposes.
        if (/no serve config|not (currently )?serving|nothing to|unknown/i.test(combined)) {
            return { ok: true };
        }
        // Fallback: try default https=443 root off (older CLI shapes).
        try {
            await runCli(cli, ['serve', '--https=443', '--yes', 'off']);
            return { ok: true };
        }
        catch (err2) {
            const e2 = err2;
            return { ok: false, error: (e2.message || 'failed to disable Tailscale Serve').slice(0, 200) };
        }
    }
}
