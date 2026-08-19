"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalEnvironmentService = void 0;
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const env_1 = require("../utils/env");
const SHELL_ENV_MARKER = '__1DEVTOOL_SHELL_ENV__';
const HOST_TERMINAL_ENV_KEYS = new Set([
    '__CFBundleIdentifier',
    'ALACRITTY_LOG',
    'GNOME_TERMINAL_SCREEN',
    'GNOME_TERMINAL_SERVICE',
    'ITERM_PROFILE',
    'ITERM_PROFILE_NAME',
    'KONSOLE_VERSION',
    'LC_TERMINAL',
    'LC_TERMINAL_VERSION',
    'MSYSTEM',
    'SESSIONNAME',
    'SSH_CLIENT',
    'SSH_CONNECTION',
    'SSH_TTY',
    'STY',
    'TERM_PROGRAM',
    'TERM_PROGRAM_VERSION',
    'TERM_SESSION_ID',
    'TERMINAL_EMULATOR',
    'TERMINATOR_UUID',
    'TILIX_ID',
    'TMUX',
    'TMUX_PANE',
    'VTE_VERSION',
    'WT_SESSION',
    'XTERM_VERSION',
]);
const HOST_TERMINAL_ENV_PREFIXES = [
    'CONEMU',
    'CURSOR_',
    'ITERM2_',
    'ITERM_',
    'KITTY_',
    'VSCODE_',
    'WEZTERM_',
];
class TerminalEnvironmentService {
    shellEnvCache = new Map();
    // In-flight async shell-env prewarms, keyed by shell path. Lets boot warm
    // the cache without racing a sync load from an early pty:create.
    shellEnvPrewarms = new Map();
    /**
     * Warm the expensive lazy caches off the first-terminal critical path.
     * The login-shell env probe (`zsh -ilc env`) takes 200ms–3s with a heavy
     * rc file and otherwise runs synchronously inside the first pty:create,
     * freezing the main process while the user watches a blank terminal.
     */
    async prewarm() {
        if (os_1.default.platform() === 'win32') {
            return;
        }
        await this.prewarmShellEnv(this.getShellCandidates(undefined)[0]);
    }
    prewarmShellEnv(shellPath) {
        if (!shellPath || os_1.default.platform() === 'win32' || this.shellEnvCache.has(shellPath)) {
            return Promise.resolve();
        }
        const existing = this.shellEnvPrewarms.get(shellPath);
        if (existing) {
            return existing;
        }
        const promise = this.loadShellEnvAsync(shellPath)
            .then((env) => {
            if (!this.shellEnvCache.has(shellPath)) {
                this.shellEnvCache.set(shellPath, env);
            }
        })
            .catch(() => {
            // Cache stays cold; the sync path loads it on first use.
        })
            .finally(() => {
            this.shellEnvPrewarms.delete(shellPath);
        });
        this.shellEnvPrewarms.set(shellPath, promise);
        return promise;
    }
    /**
     * Non-blocking peek at the environment a terminal launched with `shell`
     * will inherit: the prewarmed login-shell env when cached, else the app's
     * own process env. Never triggers the synchronous login-shell probe.
     */
    peekTerminalEnv(shell) {
        const shellPath = this.getShellCandidates(shell)[0];
        const cached = shellPath ? this.shellEnvCache.get(shellPath) : undefined;
        if (cached) {
            return { ...cached };
        }
        return { ...process.env };
    }
    getShellEnv(shellPath) {
        const cached = this.shellEnvCache.get(shellPath);
        if (cached) {
            return { ...cached };
        }
        const fallback = this.getBaseEnv(shellPath);
        const env = os_1.default.platform() === 'win32'
            ? fallback
            : this.loadShellEnv(shellPath, fallback);
        this.shellEnvCache.set(shellPath, env);
        return { ...env };
    }
    getShellCandidates(shell) {
        if (os_1.default.platform() === 'win32') {
            return this.dedupe([
                shell,
                process.env.ComSpec,
                'powershell.exe',
                'pwsh.exe',
                'cmd.exe',
            ]);
        }
        return this.dedupe([
            shell,
            process.env.SHELL,
            '/bin/zsh',
            '/bin/bash',
            '/bin/sh',
        ]);
    }
    getShellArgs(shellPath) {
        if (os_1.default.platform() === 'win32') {
            return [];
        }
        const shellName = path_1.default.basename(shellPath);
        if (shellName === 'zsh' || shellName === 'bash' || shellName === 'fish') {
            return ['-l'];
        }
        return [];
    }
    getBaseEnv(shellPath) {
        const env = Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === 'string'));
        for (const key of Object.keys(env)) {
            if (key === 'CLAUDECODE' || key.startsWith('CLAUDECODE_')) {
                delete env[key];
            }
        }
        const home = env.HOME || os_1.default.homedir();
        const enriched = (0, env_1.getEnrichedEnv)(env, {
            extraPaths: [
                home ? path_1.default.join(home, '.npm-global/bin') : '',
                home ? path_1.default.join(home, '.yarn/bin') : '',
                home ? path_1.default.join(home, '.config/yarn/global/node_modules/.bin') : '',
                home ? path_1.default.join(home, '.pnpm') : '',
                home ? path_1.default.join(home, '.local/share/pnpm') : '',
                home ? path_1.default.join(home, '.bun/bin') : '',
            ],
            baseEnv: env,
        });
        env.HOME = home;
        env.PATH = enriched.PATH || env.PATH;
        this.stripHostTerminalEnv(env);
        env.SHELL = shellPath;
        env.TERM = 'xterm-256color';
        env.COLORTERM = 'truecolor';
        env.TERM_PROGRAM = '1DevTool';
        env.LANG = env.LANG || 'en_US.UTF-8';
        return env;
    }
    loadShellEnv(shellPath, fallback) {
        const shellName = path_1.default.basename(shellPath);
        if (shellName !== 'bash' && shellName !== 'zsh') {
            return fallback;
        }
        try {
            const output = (0, child_process_1.execFileSync)(shellPath, ['-ilc', `printf '${SHELL_ENV_MARKER}\\0'; env -0`], {
                cwd: fallback.HOME || os_1.default.homedir(),
                env: fallback,
                encoding: 'buffer',
                maxBuffer: 1024 * 1024,
                timeout: 3000,
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            return this.parseShellEnvOutput(output, fallback, shellPath);
        }
        catch {
            return fallback;
        }
    }
    // Async twin of loadShellEnv for the boot-time prewarm: same probe, but via
    // spawn so a slow rc file never blocks the main event loop.
    loadShellEnvAsync(shellPath) {
        const fallback = this.getBaseEnv(shellPath);
        const shellName = path_1.default.basename(shellPath);
        if (shellName !== 'bash' && shellName !== 'zsh') {
            return Promise.resolve(fallback);
        }
        return new Promise((resolve) => {
            let child;
            try {
                child = (0, child_process_1.spawn)(shellPath, ['-ilc', `printf '${SHELL_ENV_MARKER}\\0'; env -0`], {
                    cwd: fallback.HOME || os_1.default.homedir(),
                    env: fallback,
                    stdio: ['ignore', 'pipe', 'ignore'],
                    timeout: 3000,
                });
            }
            catch {
                resolve(fallback);
                return;
            }
            const chunks = [];
            child.stdout?.on('data', (chunk) => {
                chunks.push(chunk);
            });
            child.on('error', () => resolve(fallback));
            child.on('close', () => {
                try {
                    resolve(this.parseShellEnvOutput(Buffer.concat(chunks), fallback, shellPath));
                }
                catch {
                    resolve(fallback);
                }
            });
        });
    }
    parseShellEnvOutput(output, fallback, shellPath) {
        const marker = Buffer.from(`${SHELL_ENV_MARKER}\0`);
        const markerIndex = output.indexOf(marker);
        if (markerIndex === -1) {
            return fallback;
        }
        const envBuffer = output.subarray(markerIndex + marker.length);
        const shellEnv = { ...fallback };
        for (const entry of envBuffer.toString('utf-8').split('\0')) {
            if (!entry) {
                continue;
            }
            const separatorIndex = entry.indexOf('=');
            if (separatorIndex === -1) {
                continue;
            }
            const key = entry.slice(0, separatorIndex);
            const value = entry.slice(separatorIndex + 1);
            shellEnv[key] = value;
        }
        shellEnv.SHELL = shellPath;
        this.stripHostTerminalEnv(shellEnv);
        shellEnv.TERM = 'xterm-256color';
        shellEnv.COLORTERM = 'truecolor';
        shellEnv.TERM_PROGRAM = '1DevTool';
        shellEnv.PATH = shellEnv.PATH || fallback.PATH;
        return shellEnv;
    }
    dedupe(entries) {
        const uniqueEntries = new Set();
        for (const entry of entries) {
            const normalized = entry?.trim();
            if (!normalized) {
                continue;
            }
            uniqueEntries.add(normalized);
        }
        return [...uniqueEntries];
    }
    stripHostTerminalEnv(env) {
        for (const key of Object.keys(env)) {
            if (HOST_TERMINAL_ENV_KEYS.has(key) || HOST_TERMINAL_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
                delete env[key];
            }
        }
    }
}
exports.TerminalEnvironmentService = TerminalEnvironmentService;
