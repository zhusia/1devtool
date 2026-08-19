"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TmuxDependencyService = void 0;
/*
 * TmuxDependencyService (docs/architecture/pty-daemon.md §3.2c) — tmux *detection* and
 * install, extracted from PtyManager. MAIN-ONLY: detection needs the enriched
 * PATH + login-shell env. The resolved path / `-e`-flag capability implement
 * the TmuxRuntime interface consumed by whichever process owns the PTYs; the
 * daemon receives these values pushed at hello/create and never detects
 * (§3.1). Extraction is verbatim from src/main/pty.ts.
 */
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const env_1 = require("../utils/env");
class TmuxDependencyService {
    env;
    tmuxAvailable = null;
    tmuxPath = null;
    // Cached result of whether this tmux supports `new-session -e VAR=val`.
    tmuxEnvFlagSupported = null;
    constructor(env) {
        this.env = env;
    }
    /** Warm detection caches off the first-terminal critical path. */
    prewarm() {
        try {
            if (this.isAvailable()) {
                this.supportsEnvFlag();
            }
        }
        catch {
            // Detection re-runs lazily on first create.
        }
    }
    // --- TmuxRuntime -----------------------------------------------------------
    isAvailable() {
        if (this.tmuxAvailable !== null) {
            return this.tmuxAvailable;
        }
        this.detectTmux();
        return this.tmuxAvailable;
    }
    getPath() {
        // Detection populates tmuxPath; callers may reach here before any
        // isAvailable() call, so resolve lazily like the old tmuxBin getter did.
        if (this.tmuxAvailable === null) {
            this.detectTmux();
        }
        return this.tmuxPath;
    }
    /**
     * Whether `tmux new-session -e VAR=value` is supported (added in tmux 3.2).
     *
     * We need this because tmux does NOT honor the per-`new-session` client
     * environment for variables that aren't in `update-environment` once the
     * tmux *server* already exists — it uses the server's GLOBAL environment,
     * snapshotted when the server first started. So if the server was started by
     * a foreign/older process (e.g. the user's own `tmux`, or 1DevTool before
     * this marker existed), a freshly created session inherits a stale/missing
     * `ONEDEVTOOL_TERMINAL_ID`. The `-e` flag forces the value into the new
     * session's environment, so the spawned shell reliably sees it.
     */
    supportsEnvFlag() {
        if (this.tmuxEnvFlagSupported !== null) {
            return this.tmuxEnvFlagSupported;
        }
        try {
            const raw = (0, child_process_1.execSync)(`${this.tmuxPath || 'tmux'} -V`, { stdio: 'pipe' }).toString().trim();
            // e.g. "tmux 3.6a", "tmux next-3.4", "tmux 2.9a"
            const match = raw.match(/(\d+)\.(\d+)/);
            if (match) {
                const major = Number(match[1]);
                const minor = Number(match[2]);
                this.tmuxEnvFlagSupported = major > 3 || (major === 3 && minor >= 2);
            }
            else {
                this.tmuxEnvFlagSupported = false;
            }
        }
        catch {
            this.tmuxEnvFlagSupported = false;
        }
        return this.tmuxEnvFlagSupported;
    }
    // --- detection / install ----------------------------------------------------
    /**
     * Run tmux detection and collect diagnostic logs.
     * Always runs fresh (ignores cache).
     */
    diagnoseTmux() {
        this.tmuxAvailable = null;
        this.tmuxPath = null;
        const logs = this.detectTmux();
        return { installed: this.tmuxAvailable, path: this.tmuxPath, logs };
    }
    detectTmux() {
        const logs = [];
        if (os_1.default.platform() === 'win32') {
            logs.push('platform: win32 — skipped');
            this.tmuxAvailable = false;
            return logs;
        }
        const enrichedPath = (0, env_1.getEnrichedPath)();
        logs.push(`process.env.PATH: ${process.env.PATH || '(empty)'}`);
        logs.push(`enriched PATH: ${enrichedPath}`);
        // Try `which` with enriched PATH (covers Homebrew, macports, etc.)
        const enrichedResult = this.whichInPath('tmux', enrichedPath);
        if (enrichedResult.path) {
            logs.push(`which tmux: ${enrichedResult.path}`);
            this.tmuxPath = enrichedResult.path;
            this.tmuxAvailable = true;
            return logs;
        }
        logs.push(`which tmux: ${enrichedResult.error ? `FAILED - ${enrichedResult.error}` : 'not found'}`);
        const shellPath = this.getLoginShellPathForTools();
        if (shellPath && shellPath !== enrichedPath) {
            logs.push(`login shell PATH: ${shellPath}`);
            const shellResult = this.whichInPath('tmux', shellPath);
            if (shellResult.path) {
                logs.push(`login shell which tmux: ${shellResult.path}`);
                this.tmuxPath = shellResult.path;
                this.tmuxAvailable = true;
                return logs;
            }
            logs.push(`login shell which tmux: ${shellResult.error ? `FAILED - ${shellResult.error}` : 'not found'}`);
        }
        // Fallback: check common absolute paths directly
        const knownPaths = [
            '/opt/homebrew/bin/tmux',
            '/usr/local/bin/tmux',
            '/opt/local/bin/tmux',
            '/usr/bin/tmux',
            '/bin/tmux',
        ];
        for (const candidate of knownPaths) {
            try {
                const exists = fs_1.default.existsSync(candidate);
                if (exists) {
                    const ver = (0, child_process_1.execSync)(`"${candidate}" -V`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
                    logs.push(`${candidate}: ${ver}`);
                    this.tmuxPath = candidate;
                    this.tmuxAvailable = true;
                    return logs;
                }
                logs.push(`${candidate}: not found`);
            }
            catch (err) {
                logs.push(`${candidate}: EXISTS but failed — ${err.message}`);
            }
        }
        this.appendTmuxInstallDiagnostics(logs);
        logs.push('tmux: NOT detected');
        this.tmuxAvailable = false;
        return logs;
    }
    /**
     * Get the install command for tmux on the current platform, or null if unknown.
     */
    getTmuxInstallCommand() {
        const platform = os_1.default.platform();
        if (platform === 'win32') {
            return null;
        }
        const searchPath = this.getToolSearchPath();
        if (platform === 'darwin') {
            const brewPath = this.resolveExecutable('brew', searchPath, [
                '/opt/homebrew/bin/brew',
                '/usr/local/bin/brew',
            ]);
            return brewPath ? `${brewPath} install tmux` : null;
        }
        const packageManagers = [
            { name: 'apt-get', args: 'install -y tmux' },
            { name: 'dnf', args: 'install -y tmux' },
            { name: 'yum', args: 'install -y tmux' },
            { name: 'pacman', args: '-S --noconfirm tmux' },
            { name: 'apk', args: 'add tmux' },
            { name: 'zypper', args: 'install -y tmux' },
        ];
        for (const pm of packageManagers) {
            const pmPath = this.resolveExecutable(pm.name, searchPath);
            if (pmPath)
                return `${pmPath} ${pm.args}`;
        }
        return null;
    }
    /**
     * Install tmux using the system package manager.
     * Streams output via onData callback and returns { ok, error? }.
     */
    async installTmux(onData) {
        const cmd = this.getTmuxInstallCommand();
        if (!cmd) {
            return { ok: false, error: 'No supported package manager found. Please install tmux manually.' };
        }
        return new Promise((resolve) => {
            const parts = cmd.split(' ');
            const command = parts[0];
            const args = parts.slice(1);
            onData?.(`$ ${cmd}\n`);
            const child = (0, child_process_1.spawn)(command, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 120000,
                env: { ...process.env, PATH: this.getToolSearchPath() },
            });
            child.stdout?.on('data', (data) => {
                onData?.(data.toString());
            });
            child.stderr?.on('data', (data) => {
                onData?.(data.toString());
            });
            child.on('error', (error) => {
                onData?.(`\nError: ${error.message}\n`);
                resolve({ ok: false, error: error.message });
            });
            child.on('close', (code) => {
                if (code !== 0) {
                    onData?.(`\nProcess exited with code ${code}\n`);
                    resolve({ ok: false, error: `Installation failed with exit code ${code}` });
                    return;
                }
                // Verify installation — use recheckTmux which searches enriched PATH + known paths
                if (this.recheckTmux()) {
                    onData?.(`\ntmux installed successfully at ${this.tmuxPath}\n`);
                    resolve({ ok: true });
                }
                else {
                    onData?.(`\ntmux was installed but could not be found on PATH.\n`);
                    resolve({ ok: false, error: 'tmux was installed but could not be found on PATH.' });
                }
            });
        });
    }
    /**
     * Reset the cached tmux availability check (e.g. after install).
     */
    recheckTmux() {
        this.tmuxAvailable = null;
        this.tmuxPath = null;
        return this.isAvailable();
    }
    // --- internals ---------------------------------------------------------------
    getToolSearchPath() {
        const paths = [(0, env_1.getEnrichedPath)()];
        const loginShellPath = this.getLoginShellPathForTools();
        if (loginShellPath) {
            paths.push(loginShellPath);
        }
        return this.mergePathValues(paths);
    }
    getLoginShellPathForTools() {
        if (os_1.default.platform() === 'win32') {
            return null;
        }
        for (const shellPath of [
            process.env.SHELL,
            os_1.default.platform() === 'darwin' ? '/bin/zsh' : undefined,
            '/bin/bash',
            '/bin/sh',
        ]) {
            if (!shellPath?.trim())
                continue;
            try {
                if (!fs_1.default.existsSync(shellPath)) {
                    continue;
                }
                const env = this.env.getShellEnv(shellPath);
                return env.PATH || null;
            }
            catch {
                // Try next shell candidate.
            }
        }
        return null;
    }
    whichInPath(name, searchPath) {
        try {
            const command = os_1.default.platform() === 'win32'
                ? 'where'
                : fs_1.default.existsSync('/usr/bin/which')
                    ? '/usr/bin/which'
                    : 'which';
            const output = (0, child_process_1.execFileSync)(command, [name], {
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 3000,
                env: { ...process.env, PATH: searchPath },
            });
            const resolved = output
                .split(/\r?\n/)
                .map((line) => line.trim())
                .find(Boolean);
            return { path: resolved || null };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { path: null, error: message };
        }
    }
    resolveExecutable(name, searchPath, knownPaths = []) {
        const viaPath = this.whichInPath(name, searchPath).path;
        if (viaPath) {
            return viaPath;
        }
        for (const candidate of knownPaths) {
            try {
                if (fs_1.default.existsSync(candidate)) {
                    return candidate;
                }
            }
            catch {
                // Try next candidate.
            }
        }
        return null;
    }
    appendTmuxInstallDiagnostics(logs) {
        const platform = os_1.default.platform();
        const searchPath = this.getToolSearchPath();
        if (platform === 'darwin') {
            const brewPath = this.resolveExecutable('brew', searchPath, [
                '/opt/homebrew/bin/brew',
                '/usr/local/bin/brew',
            ]);
            logs.push(brewPath ? `brew: ${brewPath}` : 'brew: not found');
            logs.push(brewPath ? `tmux install command: ${brewPath} install tmux` : 'tmux install command: unavailable');
            return;
        }
        if (platform === 'linux') {
            for (const manager of ['apt-get', 'dnf', 'yum', 'pacman', 'apk', 'zypper']) {
                const managerPath = this.resolveExecutable(manager, searchPath);
                if (managerPath) {
                    logs.push(`package manager: ${managerPath}`);
                    logs.push(`tmux install command: ${this.getTmuxInstallCommand() || 'unavailable'}`);
                    return;
                }
            }
            logs.push('package manager: not found');
            logs.push('tmux install command: unavailable');
        }
    }
    mergePathValues(values) {
        const segments = [];
        const seen = new Set();
        for (const value of values) {
            for (const segment of value.split(path_1.default.delimiter)) {
                const trimmed = segment.trim();
                if (!trimmed || seen.has(trimmed)) {
                    continue;
                }
                seen.add(trimmed);
                segments.push(trimmed);
            }
        }
        return segments.join(path_1.default.delimiter);
    }
}
exports.TmuxDependencyService = TmuxDependencyService;
