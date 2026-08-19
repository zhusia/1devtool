"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseStatusJson = parseStatusJson;
exports.findTailscaleInterfaceIp = findTailscaleInterfaceIp;
exports.cliEnv = cliEnv;
exports.cliCandidates = cliCandidates;
exports.isGuiLaunchOutput = isGuiLaunchOutput;
exports.detectTailscale = detectTailscale;
/**
 * Tailscale detection for the Remote "Tailscale / VPN" connection mode.
 *
 * Detect-and-advertise only: the user installs and runs the official Tailscale
 * app; we never download, launch, or stop anything. Detection is CLI-first
 * (`tailscale status --json` gives IP + MagicDNS name + backend state) with an
 * interface scan of the CGNAT range as fallback for a wedged or missing CLI.
 *
 * All OS access is injectable so the decision logic is unit-tested without
 * sockets, child processes, or a real tailnet
 * (tests/unit/tailscale-detect.test.mjs).
 */
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const util_1 = require("util");
const endpoints_1 = require("../device/endpoints");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const CLI_TIMEOUT_MS = 5000;
// `status --json` includes every peer; large tailnets produce large payloads.
const CLI_MAX_BUFFER = 4 * 1024 * 1024;
/**
 * Parse `tailscale status --json` output. Every field is optional and schema
 * drift must never throw — an unrecognizable payload returns null and the
 * caller falls back to the interface scan.
 */
function parseStatusJson(raw) {
    let data;
    try {
        data = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (!data || typeof data !== 'object')
        return null;
    const root = data;
    const parsed = {};
    if (typeof root.BackendState === 'string') {
        parsed.backendState = root.BackendState;
    }
    const self = root.Self;
    if (self && typeof self === 'object') {
        const s = self;
        if (Array.isArray(s.TailscaleIPs)) {
            // IPs arrive as ['100.x.y.z', 'fd7a:…'] — advertise the first IPv4 in
            // the CGNAT block (an IPv6-only tailnet yields no ip; see plan §6 E5).
            const ipv4 = s.TailscaleIPs.find((addr) => typeof addr === 'string' && (0, endpoints_1.classifyHost)(addr) === 'tailscale');
            if (ipv4)
                parsed.ip = ipv4;
        }
        if (typeof s.DNSName === 'string' && s.DNSName.length > 0) {
            parsed.magicDnsName = s.DNSName.replace(/\.$/, '');
        }
        if (typeof s.ID === 'string' && s.ID.length > 0) {
            parsed.nodeId = s.ID;
        }
        if (typeof s.HostName === 'string' && s.HostName.length > 0) {
            parsed.hostname = s.HostName;
        }
    }
    const tailnet = root.CurrentTailnet;
    if (tailnet && typeof tailnet === 'object') {
        const t = tailnet;
        if (typeof t.Name === 'string' && t.Name.length > 0) {
            parsed.tailnet = t.Name;
        }
        if (typeof t.MagicDNSEnabled === 'boolean') {
            parsed.magicDnsEnabled = t.MagicDNSEnabled;
        }
    }
    if (parsed.backendState === undefined && parsed.ip === undefined)
        return null;
    return parsed;
}
/**
 * First non-internal IPv4 in Tailscale's CGNAT range (100.64.0.0/10) across
 * all interfaces. Matched by ADDRESS, not interface name — the interface is
 * `utunN` on macOS, `tailscale0` on Linux, and `Tailscale` on Windows.
 */
function findTailscaleInterfaceIp(interfaces = os_1.default.networkInterfaces()) {
    for (const iface of Object.values(interfaces)) {
        if (!iface)
            continue;
        for (const info of iface) {
            if (info.family !== 'IPv4' || info.internal)
                continue;
            if ((0, endpoints_1.classifyHost)(info.address) === 'tailscale')
                return info.address;
        }
    }
    return null;
}
/**
 * Environment for every Tailscale CLI spawn.
 *
 * On macOS the CLI and the GUI are the SAME binary
 * (`/Applications/Tailscale.app/Contents/MacOS/Tailscale`). It picks CLI mode
 * only when its environment looks like a shell — any of `TERM`, `TERM_PROGRAM`
 * or `SHLVL` present and non-empty. With none of them it assumes it was
 * double-clicked, tries to launch the GUI, and prints
 * `The Tailscale GUI failed to start: … (Tailscale.CLIError error 3.)` to
 * **stdout with exit code 0** — no JSON, no error for us to catch.
 *
 * `npm run dev` inherits the terminal's TERM so this never reproduces in dev;
 * a packaged app launched from Finder/Dock gets launchd's environment (no
 * TERM, no SHLVL) and every CLI call silently degrades to the interface scan —
 * tailnet IP but no MagicDNS name, so Serve/HTTPS can never be configured.
 * See docs/common-errors/remote/tailscale-cli-gui-mode-no-term.md.
 */
function cliEnv(env = process.env) {
    if (env.TERM)
        return env;
    // `dumb` is a valid terminal that also tells the CLI not to emit ANSI color,
    // which keeps the output we parse clean.
    return { ...env, TERM: 'dumb' };
}
/** Known install locations, most specific first; bare name last (PATH lookup). */
function cliCandidates(platform = process.platform) {
    if (platform === 'darwin') {
        return [
            '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
            '/opt/homebrew/bin/tailscale',
            '/usr/local/bin/tailscale',
            'tailscale',
        ];
    }
    if (platform === 'win32') {
        return ['C:\\Program Files\\Tailscale\\tailscale.exe', 'tailscale'];
    }
    return ['/usr/bin/tailscale', '/usr/sbin/tailscale', 'tailscale'];
}
function defaultRunCli(file, args) {
    return execFileAsync(file, args, {
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: CLI_MAX_BUFFER,
        env: cliEnv(),
    });
}
/**
 * True when the macOS app binary answered in GUI mode instead of CLI mode
 * (see cliEnv). It exits 0 with this on stdout, so without this check the only
 * symptom is a status with an IP and no MagicDNS name.
 */
function isGuiLaunchOutput(text) {
    return /Tailscale GUI failed to start|Tailscale\.CLIError/i.test(text);
}
/**
 * Full detection pass. Never throws.
 *
 * CLI resolution: first candidate that exists on disk, else the bare name via
 * PATH. A CLI error with parseable stdout still counts (`status --json` exits
 * non-zero for NeedsLogin/Stopped but prints the state JSON); ENOENT means not
 * installed; a hang/timeout falls back to the interface scan (plan §6 E4).
 */
async function detectTailscale(deps = {}) {
    const runCli = deps.runCli ?? defaultRunCli;
    const existsSync = deps.existsSync ?? fs_1.default.existsSync;
    const interfaces = deps.interfaces ?? os_1.default.networkInterfaces;
    const platform = deps.platform ?? process.platform;
    const candidates = cliCandidates(platform);
    const absolute = candidates.filter((c) => c !== 'tailscale' && existsSync(c));
    const cliPath = absolute[0] ?? 'tailscale';
    const cliKnownInstalled = absolute.length > 0;
    let cliError = null;
    try {
        const { stdout } = await runCli(cliPath, ['status', '--json']);
        const parsed = parseStatusJson(stdout);
        if (parsed)
            return statusFromCli(parsed);
        if (isGuiLaunchOutput(stdout)) {
            // Should be unreachable now that cliEnv() forces TERM; if Tailscale
            // changes the discriminator again this is the only trace of why HTTPS
            // setup silently stops working in the packaged app.
            console.warn('[tailscale] CLI answered in GUI mode; MagicDNS metadata unavailable');
        }
    }
    catch (err) {
        cliError = err;
        // Non-zero exit still carries the state JSON on stdout for
        // NeedsLogin/Stopped — parse it before falling back.
        const stdout = cliError.stdout;
        if (typeof stdout === 'string' && stdout.length > 0) {
            const parsed = parseStatusJson(stdout);
            if (parsed)
                return statusFromCli(parsed);
        }
    }
    // CLI missing, hung, or unparseable — the interface scan still proves a
    // live tailnet (GUI installs without a PATH CLI land here).
    const interfaceIp = findTailscaleInterfaceIp(interfaces());
    if (interfaceIp) {
        return { installed: true, running: true, ip: interfaceIp, detection: 'interface' };
    }
    const cliMissing = !cliKnownInstalled && cliError?.code === 'ENOENT';
    if (cliMissing) {
        return { installed: false, running: false, detection: 'none' };
    }
    // CLI exists but reported nothing usable (daemon down, wedged, timeout).
    return { installed: true, running: false, detection: 'cli' };
}
function statusFromCli(parsed) {
    return {
        installed: true,
        running: parsed.backendState === 'Running',
        backendState: parsed.backendState,
        ip: parsed.ip,
        magicDnsName: parsed.magicDnsName,
        magicDnsEnabled: parsed.magicDnsEnabled,
        nodeId: parsed.nodeId,
        hostname: parsed.hostname,
        tailnet: parsed.tailnet,
        detection: 'cli',
    };
}
