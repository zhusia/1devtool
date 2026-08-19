"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerUserExtraPathsProvider = registerUserExtraPathsProvider;
exports.getEnrichedPath = getEnrichedPath;
exports.getEnrichedEnv = getEnrichedEnv;
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
let userExtraPathsProvider = () => [];
/**
 * Registered at app boot by the main process so every `getEnrichedPath()` call
 * — including the dozens we don't thread `extraPaths` through — automatically
 * picks up the user's Settings → General → System → Extra PATH entries.
 */
function registerUserExtraPathsProvider(provider) {
    userExtraPathsProvider = provider;
}
function dedupeSegments(values) {
    const seen = new Set();
    const output = [];
    for (const value of values) {
        for (const segment of (value || '').split(path_1.default.delimiter)) {
            const key = process.platform === 'win32' ? segment.toLowerCase() : segment;
            if (!segment || seen.has(key)) {
                continue;
            }
            seen.add(key);
            output.push(segment);
        }
    }
    return output;
}
function getEnrichedPath(extraPaths = [], baseEnv = process.env) {
    const home = baseEnv.HOME || baseEnv.USERPROFILE || os_1.default.homedir();
    const basePath = baseEnv.PATH || baseEnv.Path;
    const appData = baseEnv.APPDATA || (home ? path_1.default.join(home, 'AppData', 'Roaming') : '');
    const programFiles = baseEnv.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = baseEnv['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = baseEnv.LOCALAPPDATA || (home ? path_1.default.join(home, 'AppData', 'Local') : '');
    const programData = baseEnv.ProgramData || 'C:\\ProgramData';
    const chocolatey = baseEnv.ChocolateyInstall || path_1.default.join(programData, 'chocolatey');
    const defaults = process.platform === 'win32'
        ? [
            basePath,
            baseEnv.PNPM_HOME,
            baseEnv.NVM_SYMLINK,
            appData ? path_1.default.join(appData, 'npm') : '',
            path_1.default.join(programFiles, 'nodejs'),
            path_1.default.join(programFilesX86, 'nodejs'),
            path_1.default.join(programFiles, 'dotnet'),
            path_1.default.join(programFilesX86, 'dotnet'),
            home ? path_1.default.join(home, '.local', 'bin') : '',
            home ? path_1.default.join(home, '.dotnet', 'tools') : '',
            home ? path_1.default.join(home, '.bun', 'bin') : '',
            home ? path_1.default.join(home, '.opencode', 'bin') : '',
            home ? path_1.default.join(home, '.claude', 'bin') : '',
            home ? path_1.default.join(home, '.codex', 'bin') : '',
            localAppData ? path_1.default.join(localAppData, 'pnpm') : '',
            home ? path_1.default.join(home, 'scoop', 'shims') : '',
            path_1.default.join(programData, 'scoop', 'shims'),
            path_1.default.join(chocolatey, 'bin'),
            localAppData ? path_1.default.join(localAppData, 'Microsoft', 'WinGet', 'Links') : '',
            localAppData ? path_1.default.join(localAppData, 'Volta', 'bin') : '',
            localAppData ? path_1.default.join(localAppData, 'mise', 'shims') : '',
            localAppData ? path_1.default.join(localAppData, 'Yarn', 'bin') : '',
            localAppData ? path_1.default.join(localAppData, 'Yarn', 'Data', 'global', 'node_modules', '.bin') : '',
            localAppData ? path_1.default.join(localAppData, 'Microsoft', 'WindowsApps') : '',
            // Docker Desktop v29+ layout — docker.exe sometimes lands here, plugins live one level up
            path_1.default.join(programFiles, 'Docker'),
            path_1.default.join(programFiles, 'Docker', 'cli-plugins'),
            path_1.default.join(programData, 'Docker', 'cli-plugins'),
            // Classic Docker Desktop layout (v20–v28)
            path_1.default.join(programFiles, 'Docker', 'Docker', 'resources', 'bin'),
            path_1.default.join(programFiles, 'Docker', 'Docker', 'resources', 'cli-plugins'),
            localAppData ? path_1.default.join(localAppData, 'Programs', 'Docker', 'Docker', 'resources', 'bin') : '',
            path_1.default.join(programFilesX86, 'Docker', 'Docker', 'resources', 'bin'),
            // SSHFS-Win (WinFsp) — not always on PATH after MSI install
            path_1.default.join(programFiles, 'SSHFS-Win', 'bin'),
            path_1.default.join(programFilesX86, 'SSHFS-Win', 'bin'),
            path_1.default.join(programFilesX86, 'WinFsp', 'bin'),
            path_1.default.join(programFiles, 'WinFsp', 'bin'),
        ]
        : [
            basePath,
            '/opt/homebrew/bin',
            '/opt/homebrew/sbin',
            '/usr/local/bin',
            '/usr/local/sbin',
            '/usr/local/share/dotnet',
            '/usr/share/dotnet',
            '/usr/bin',
            '/bin',
            '/usr/sbin',
            '/sbin',
            home ? path_1.default.join(home, 'bin') : '',
            home ? path_1.default.join(home, '.local/bin') : '',
            home ? path_1.default.join(home, '.dotnet') : '',
            home ? path_1.default.join(home, '.dotnet/tools') : '',
            home ? path_1.default.join(home, '.npm-global/bin') : '',
            home ? path_1.default.join(home, '.yarn/bin') : '',
            home ? path_1.default.join(home, '.config/yarn/global/node_modules/.bin') : '',
            home ? path_1.default.join(home, '.pnpm') : '',
            home && process.platform === 'darwin' ? path_1.default.join(home, 'Library/pnpm') : '',
            home ? path_1.default.join(home, '.local/share/pnpm') : '',
            home ? path_1.default.join(home, '.bun/bin') : '',
            home ? path_1.default.join(home, '.volta/bin') : '',
            home ? path_1.default.join(home, '.cargo/bin') : '',
            home ? path_1.default.join(home, 'go/bin') : '',
            home ? path_1.default.join(home, '.opencode/bin') : '',
            home ? path_1.default.join(home, '.claude/bin') : '',
            home ? path_1.default.join(home, '.codex/bin') : '',
            home ? path_1.default.join(home, '.rbenv/shims') : '',
            home ? path_1.default.join(home, '.pyenv/shims') : '',
        ];
    let userExtras = [];
    try {
        userExtras = userExtraPathsProvider().filter(p => typeof p === 'string' && p.trim().length > 0);
    }
    catch {
        userExtras = [];
    }
    return dedupeSegments([...userExtras, ...extraPaths, ...defaults]).join(path_1.default.delimiter);
}
function getEnrichedEnv(extra = {}, options = {}) {
    const baseEnv = options.baseEnv ?? process.env;
    return {
        ...baseEnv,
        ...extra,
        PATH: getEnrichedPath(options.extraPaths ?? [], { ...baseEnv, ...extra }),
    };
}
