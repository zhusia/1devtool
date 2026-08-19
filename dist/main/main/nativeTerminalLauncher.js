"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NativeTerminalLauncher = void 0;
exports.nativeTerminalPathExists = nativeTerminalPathExists;
exports.prepareNativeTerminalResumeCommand = prepareNativeTerminalResumeCommand;
exports.discoverNativeTerminals = discoverNativeTerminals;
exports.buildNativeTerminalLaunchSpec = buildNativeTerminalLaunchSpec;
exports.renderUnixResumeWrapper = renderUnixResumeWrapper;
exports.renderWindowsCmdResumeWrapper = renderWindowsCmdResumeWrapper;
exports.renderPowerShellResumeWrapper = renderPowerShellResumeWrapper;
exports.getNativeTerminalLauncher = getNativeTerminalLauncher;
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const promises_1 = require("fs/promises");
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const env_1 = require("./utils/env");
const STALE_WRAPPER_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * Path existence check that still finds Windows App Execution Aliases
 * (e.g. `%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe`). Those reparse points
 * fail `existsSync`/`stat` with EACCES while remaining launchable via PATH or
 * CreateProcess; `access(F_OK)` and `lstat` succeed.
 */
function nativeTerminalPathExists(candidate) {
    try {
        if ((0, fs_1.existsSync)(candidate))
            return true;
    }
    catch {
        // fall through
    }
    try {
        (0, fs_1.accessSync)(candidate, fs_1.constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
/** Embedded Codex uses inline mode for xterm scrollback; native emulators do not need it. */
function prepareNativeTerminalResumeCommand(agentType, resumeCommand) {
    if (agentType !== 'codex')
        return resumeCommand.trim();
    return resumeCommand.replace(/(^|\s)--no-alt-screen(?=\s|$)/, '$1').replace(/\s+/g, ' ').trim();
}
function targetPathApi(platform) {
    return platform === 'win32' ? path_1.default.win32 : path_1.default.posix;
}
function firstExisting(candidates, exists) {
    return candidates.find((candidate) => {
        try {
            return exists(candidate);
        }
        catch {
            return false;
        }
    }) ?? null;
}
function resolveExecutable(names, absoluteCandidates, options) {
    const absolute = firstExisting(absoluteCandidates, options.exists);
    if (absolute)
        return absolute;
    const pathApi = targetPathApi(options.platform);
    const delimiter = options.platform === 'win32' ? ';' : ':';
    const extensions = options.platform === 'win32'
        ? (options.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
        : [''];
    for (const directory of options.pathValue.split(delimiter).filter(Boolean)) {
        for (const name of names) {
            const nameHasExtension = options.platform === 'win32' && /\.[a-z0-9]+$/i.test(name);
            for (const extension of nameHasExtension ? [''] : extensions) {
                const candidate = pathApi.join(directory, name + extension);
                if (options.exists(candidate))
                    return candidate;
            }
        }
    }
    return null;
}
function dedupeDetected(terminals, platform) {
    const seenIds = new Set();
    const seenCommands = new Set();
    return terminals.filter((terminal) => {
        const commandKey = platform === 'win32' ? terminal.command.toLowerCase() : terminal.command;
        if (seenIds.has(terminal.id) || seenCommands.has(commandKey))
            return false;
        seenIds.add(terminal.id);
        seenCommands.add(commandKey);
        return true;
    });
}
/**
 * Discover installed terminal applications that have a deterministic way to
 * execute a wrapper script. Editors and terminal-like apps without a supported
 * command entry point are intentionally excluded: every returned row must be
 * launchable, not merely installed.
 */
function discoverNativeTerminals(discoveryOptions = {}) {
    const platform = discoveryOptions.platform ?? process.platform;
    const homeDir = discoveryOptions.homeDir ?? os_1.default.homedir();
    const env = discoveryOptions.env ?? process.env;
    // Prefer the Windows-alias-aware checker so Store-installed apps like
    // Windows Terminal appear in the Machine Terminal list.
    const exists = discoveryOptions.exists ?? nativeTerminalPathExists;
    const pathValue = discoveryOptions.pathValue
        ?? (platform === process.platform ? (0, env_1.getEnrichedPath)([], env) : (env.PATH || env.Path || ''));
    const resolveOptions = { platform, env, pathValue, exists };
    const pathApi = targetPathApi(platform);
    const terminals = [];
    const addResolved = (id, name, launchKind, commandNames, absoluteCandidates = []) => {
        const command = resolveExecutable(commandNames, absoluteCandidates, resolveOptions);
        if (command)
            terminals.push({ id, name, launchKind, command });
    };
    if (platform === 'darwin') {
        const userApplications = pathApi.join(homeDir, 'Applications');
        const macScriptApps = [
            {
                id: 'apple-terminal',
                name: 'Terminal',
                candidates: [
                    '/System/Applications/Utilities/Terminal.app',
                    '/Applications/Utilities/Terminal.app',
                ],
            },
            {
                id: 'ghostty',
                name: 'Ghostty',
                candidates: [
                    '/Applications/Ghostty.app',
                    pathApi.join(userApplications, 'Ghostty.app'),
                ],
            },
            {
                id: 'iterm',
                name: 'iTerm',
                candidates: [
                    '/Applications/iTerm.app',
                    '/Applications/iTerm2.app',
                    pathApi.join(userApplications, 'iTerm.app'),
                    pathApi.join(userApplications, 'iTerm2.app'),
                ],
            },
        ];
        for (const app of macScriptApps) {
            const command = firstExisting(app.candidates, exists);
            if (command)
                terminals.push({ id: app.id, name: app.name, launchKind: 'mac-script-app', command });
        }
        addResolved('wezterm', 'WezTerm', 'wezterm', ['wezterm'], [
            '/Applications/WezTerm.app/Contents/MacOS/wezterm',
            pathApi.join(userApplications, 'WezTerm.app/Contents/MacOS/wezterm'),
        ]);
        addResolved('kitty', 'kitty', 'kitty', ['kitty'], [
            '/Applications/kitty.app/Contents/MacOS/kitty',
            pathApi.join(userApplications, 'kitty.app/Contents/MacOS/kitty'),
        ]);
        addResolved('alacritty', 'Alacritty', 'alacritty', ['alacritty'], [
            '/Applications/Alacritty.app/Contents/MacOS/alacritty',
            pathApi.join(userApplications, 'Alacritty.app/Contents/MacOS/alacritty'),
        ]);
        addResolved('rio', 'Rio', 'rio', ['rio'], [
            '/Applications/Rio.app/Contents/MacOS/rio',
            pathApi.join(userApplications, 'Rio.app/Contents/MacOS/rio'),
        ]);
    }
    else if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') {
        addResolved('ghostty', 'Ghostty', 'ghostty', ['ghostty']);
        addResolved('gnome-terminal', 'GNOME Terminal', 'gnome-terminal', ['gnome-terminal']);
        addResolved('konsole', 'Konsole', 'konsole', ['konsole']);
        addResolved('wezterm', 'WezTerm', 'wezterm', ['wezterm']);
        addResolved('kitty', 'kitty', 'kitty', ['kitty']);
        addResolved('alacritty', 'Alacritty', 'alacritty', ['alacritty']);
        addResolved('xfce-terminal', 'Xfce Terminal', 'xfce-terminal', ['xfce4-terminal']);
        addResolved('tilix', 'Tilix', 'tilix', ['tilix']);
        addResolved('terminator', 'Terminator', 'terminator', ['terminator']);
        addResolved('foot', 'foot', 'foot', ['foot']);
        addResolved('rio', 'Rio', 'rio', ['rio']);
        addResolved('xterm', 'XTerm', 'xterm', ['xterm']);
        if (terminals.length === 0) {
            addResolved('system-terminal', 'System Terminal', 'generic-unix', ['x-terminal-emulator']);
        }
    }
    else if (platform === 'win32') {
        const systemRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows';
        const localAppData = env.LOCALAPPDATA || pathApi.join(homeDir, 'AppData', 'Local');
        addResolved('windows-terminal', 'Windows Terminal', 'windows-terminal', ['wt.exe', 'wt'], [
            pathApi.join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe'),
        ]);
        addResolved('powershell-7', 'PowerShell 7', 'windows-powershell', ['pwsh.exe', 'pwsh']);
        addResolved('windows-powershell', 'Windows PowerShell', 'windows-powershell', ['powershell.exe', 'powershell'], [
            pathApi.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ]);
        addResolved('command-prompt', 'Command Prompt', 'windows-command-prompt', ['cmd.exe', 'cmd'], [
            pathApi.join(systemRoot, 'System32', 'cmd.exe'),
        ]);
        addResolved('wezterm', 'WezTerm', 'wezterm', ['wezterm.exe', 'wezterm']);
        addResolved('alacritty', 'Alacritty', 'alacritty', ['alacritty.exe', 'alacritty']);
    }
    return dedupeDetected(terminals, platform)
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
function buildNativeTerminalLaunchSpec(terminal, wrapperPath, cwd, env = process.env, platform = process.platform) {
    const commandPrompt = env.ComSpec || env.COMSPEC || 'cmd.exe';
    switch (terminal.launchKind) {
        case 'mac-script-app':
            return { command: '/usr/bin/open', args: ['-a', terminal.command, wrapperPath] };
        case 'ghostty':
            return { command: terminal.command, args: [`--working-directory=${cwd}`, '-e', wrapperPath] };
        case 'wezterm':
            return platform === 'win32'
                ? { command: terminal.command, args: ['start', '--cwd', cwd, '--', commandPrompt, '/d', '/k', wrapperPath] }
                : { command: terminal.command, args: ['start', '--cwd', cwd, '--', wrapperPath] };
        case 'kitty':
            return { command: terminal.command, args: ['--directory', cwd, wrapperPath] };
        case 'alacritty':
            return platform === 'win32'
                ? { command: terminal.command, args: ['--working-directory', cwd, '-e', commandPrompt, '/d', '/k', wrapperPath] }
                : { command: terminal.command, args: ['--working-directory', cwd, '-e', wrapperPath] };
        case 'gnome-terminal':
            return { command: terminal.command, args: [`--working-directory=${cwd}`, '--', wrapperPath] };
        case 'konsole':
            return { command: terminal.command, args: ['--workdir', cwd, '-e', wrapperPath] };
        case 'xfce-terminal':
            return { command: terminal.command, args: ['--working-directory', cwd, '--command', wrapperPath] };
        case 'tilix':
            return { command: terminal.command, args: [`--working-directory=${cwd}`, '-e', wrapperPath] };
        case 'terminator':
            return { command: terminal.command, args: ['--working-directory', cwd, '-x', wrapperPath] };
        case 'foot':
            return { command: terminal.command, args: [`--working-directory=${cwd}`, wrapperPath] };
        case 'rio':
            return { command: terminal.command, args: ['-e', wrapperPath] };
        case 'xterm':
        case 'generic-unix':
            return { command: terminal.command, args: ['-e', wrapperPath] };
        case 'windows-terminal':
            return { command: terminal.command, args: ['new-tab', '-d', cwd, commandPrompt, '/d', '/k', wrapperPath] };
        case 'windows-command-prompt':
            return { command: terminal.command, args: ['/d', '/k', wrapperPath] };
        case 'windows-powershell':
            return { command: terminal.command, args: ['-NoExit', '-ExecutionPolicy', 'Bypass', '-File', wrapperPath] };
    }
}
function quotePosix(value) {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function quotePowerShell(value) {
    return `'${value.replace(/'/g, "''")}'`;
}
function renderUnixResumeWrapper(args) {
    return [
        '#!/bin/sh',
        'script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
        'rm -f -- "$0"',
        'rmdir -- "$script_dir" 2>/dev/null || true',
        `export PATH=${quotePosix(args.pathValue)}`,
        `cd -- ${quotePosix(args.cwd)} || exit 1`,
        ...(args.resumeCommand ? [`${quotePosix(args.shell)} -ilc ${quotePosix(args.resumeCommand)}`] : []),
        `exec ${quotePosix(args.shell)} -il`,
        '',
    ].join('\n');
}
function renderWindowsCmdResumeWrapper(args) {
    const pathValue = args.pathValue.replace(/%/g, '%%').replace(/"/g, '""');
    const cwd = args.cwd.replace(/"/g, '""');
    return [
        '@echo off',
        `set "PATH=${pathValue}"`,
        `cd /d "${cwd}"`,
        ...(args.resumeCommand ? [args.resumeCommand] : []),
        'del "%~f0" >nul 2>&1',
        '',
    ].join('\r\n');
}
function renderPowerShellResumeWrapper(args) {
    return [
        `$env:PATH = ${quotePowerShell(args.pathValue)}`,
        `Set-Location -LiteralPath ${quotePowerShell(args.cwd)}`,
        ...(args.resumeCommand ? [args.resumeCommand] : []),
        'Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue',
        '',
    ].join('\r\n');
}
class NativeTerminalLauncher {
    async list() {
        return discoverNativeTerminals().map(({ id, name }) => ({ id, name }));
    }
    async open(terminalId, cwd) {
        return this.launch(terminalId, { cwd });
    }
    async launch(terminalId, request) {
        const terminal = discoverNativeTerminals().find((candidate) => candidate.id === terminalId);
        if (!terminal)
            return { ok: false, error: 'That terminal application is no longer installed.' };
        const hasResumeCommand = request.resumeCommand !== undefined;
        const resumeCommand = request.resumeCommand?.trim() ?? '';
        if (hasResumeCommand && (!resumeCommand || /[\r\n\0]/.test(resumeCommand))) {
            return { ok: false, error: 'The AI agent did not provide a safe resume command.' };
        }
        const cwd = request.cwd.trim() || os_1.default.homedir();
        if (!path_1.default.isAbsolute(cwd))
            return { ok: false, error: 'The terminal working directory is not absolute.' };
        try {
            if (!(await (0, promises_1.stat)(cwd)).isDirectory()) {
                return { ok: false, error: 'The terminal working directory no longer exists.' };
            }
        }
        catch {
            return { ok: false, error: 'The terminal working directory no longer exists.' };
        }
        const wrapperDir = await this.createWrapperDirectory();
        const pathValue = (0, env_1.getEnrichedPath)();
        const shell = this.resolveUnixShell();
        const isPowerShell = terminal.launchKind === 'windows-powershell';
        const extension = process.platform === 'win32' ? (isPowerShell ? '.ps1' : '.cmd') : '.command';
        const wrapperPath = path_1.default.join(wrapperDir, `${hasResumeCommand ? 'resume' : 'shell'}${extension}`);
        const content = process.platform === 'win32'
            ? isPowerShell
                ? renderPowerShellResumeWrapper({ cwd, resumeCommand, pathValue })
                : renderWindowsCmdResumeWrapper({ cwd, resumeCommand, pathValue })
            : renderUnixResumeWrapper({ cwd, resumeCommand, shell, pathValue });
        try {
            await (0, promises_1.writeFile)(wrapperPath, content, process.platform === 'win32'
                ? { encoding: 'utf8' }
                : { encoding: 'utf8', mode: 0o700 });
            const spec = buildNativeTerminalLaunchSpec(terminal, wrapperPath, cwd);
            const result = await this.spawnDetached(spec);
            if (!result.ok)
                await (0, promises_1.rm)(wrapperDir, { recursive: true, force: true }).catch(() => { });
            return result;
        }
        catch (error) {
            await (0, promises_1.rm)(wrapperDir, { recursive: true, force: true }).catch(() => { });
            return {
                ok: false,
                error: error instanceof Error ? error.message : 'Failed to open the terminal application.',
            };
        }
    }
    resolveUnixShell() {
        const configured = process.env.SHELL;
        if (configured && path_1.default.isAbsolute(configured) && (0, fs_1.existsSync)(configured))
            return configured;
        if (process.platform === 'darwin' && (0, fs_1.existsSync)('/bin/zsh'))
            return '/bin/zsh';
        if ((0, fs_1.existsSync)('/bin/bash'))
            return '/bin/bash';
        return '/bin/sh';
    }
    async createWrapperDirectory() {
        const root = path_1.default.join(os_1.default.tmpdir(), '1devtool-native-terminal');
        await (0, promises_1.mkdir)(root, { recursive: true });
        await this.cleanupStaleWrappers(root);
        return (0, promises_1.mkdtemp)(path_1.default.join(root, 'resume-'));
    }
    async cleanupStaleWrappers(root) {
        const now = Date.now();
        const entries = await (0, promises_1.readdir)(root, { withFileTypes: true }).catch(() => []);
        await Promise.all(entries
            .filter((entry) => entry.isDirectory() && entry.name.startsWith('resume-'))
            .map(async (entry) => {
            const target = path_1.default.join(root, entry.name);
            const info = await (0, promises_1.stat)(target).catch(() => null);
            if (info && now - info.mtimeMs > STALE_WRAPPER_AGE_MS) {
                await (0, promises_1.rm)(target, { recursive: true, force: true }).catch(() => { });
            }
        }));
    }
    spawnDetached(spec) {
        return new Promise((resolve) => {
            try {
                const { command, args, options } = this.toSpawnInvocation(spec);
                const child = (0, child_process_1.spawn)(command, args, options);
                let settled = false;
                child.once('error', (error) => {
                    if (settled)
                        return;
                    settled = true;
                    resolve({ ok: false, error: error.message });
                });
                child.once('spawn', () => {
                    if (settled)
                        return;
                    settled = true;
                    child.unref();
                    resolve({ ok: true });
                });
            }
            catch (error) {
                resolve({
                    ok: false,
                    error: error instanceof Error ? error.message : 'Failed to open the terminal application.',
                });
            }
        });
    }
    /**
     * On Windows, open the terminal through `cmd /c start` so a new visible
     * window is created independent of the Electron GUI parent. Direct
     * CreateProcess of console subsystems (cmd/powershell) from Electron can
     * spawn successfully while never showing a window. Matches the pattern in
     * `openWindowsTerminal` (ssh.ts).
     */
    toSpawnInvocation(spec) {
        // Explicit ProcessEnv: spreading process.env alone can collapse to a
        // narrow object type once PATH is overwritten, which then rejects ComSpec.
        const env = { ...process.env, PATH: (0, env_1.getEnrichedPath)() };
        if (process.platform !== 'win32') {
            return {
                command: spec.command,
                args: spec.args,
                options: {
                    detached: true,
                    stdio: 'ignore',
                    env,
                    windowsHide: false,
                },
            };
        }
        const comspec = env.ComSpec || env.COMSPEC || 'cmd.exe';
        // `start`'s first quoted argument is the window title — keep it non-empty
        // so a path-like first real argument is never mistaken for the title.
        return {
            command: comspec,
            args: ['/c', 'start', '"1DevTool"', spec.command, ...spec.args],
            options: {
                detached: true,
                stdio: 'ignore',
                env,
                // Hide the transient cmd that only runs `start`; the real terminal is
                // the new process group created by start.
                windowsHide: true,
            },
        };
    }
}
exports.NativeTerminalLauncher = NativeTerminalLauncher;
let singleton = null;
function getNativeTerminalLauncher() {
    if (!singleton)
        singleton = new NativeTerminalLauncher();
    return singleton;
}
