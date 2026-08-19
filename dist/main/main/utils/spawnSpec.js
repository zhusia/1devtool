"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveWindowsExecutablePath = resolveWindowsExecutablePath;
exports.buildSpawnSpec = buildSpawnSpec;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/** Quote one cmd.exe argument. App-built flags are shell-safe tokens; this
 *  only defends paths/values containing whitespace or quotes. */
function quoteCmdArg(arg) {
    return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}
/**
 * Prefer a Windows-native sibling of an extension-less npm PATH hit.
 * `where.exe foo` lists the POSIX sh script first; that file is not a valid
 * CreateProcess target. Ranking mirrors the CLI scanner.
 */
function resolveWindowsExecutablePath(binPath, existsSync = fs_1.default.existsSync) {
    const ext = path_1.default.win32.extname(binPath).toLowerCase();
    if (ext)
        return binPath;
    for (const candidateExt of ['.cmd', '.exe', '.bat', '.com']) {
        const sibling = binPath + candidateExt;
        if (existsSync(sibling))
            return sibling;
    }
    return binPath;
}
function buildSpawnSpec(binPath, args, env = process.env, isWin = process.platform === 'win32', existsSync = fs_1.default.existsSync) {
    if (isWin) {
        const resolved = resolveWindowsExecutablePath(binPath, existsSync);
        const ext = path_1.default.win32.extname(resolved).toLowerCase();
        if (ext === '.cmd' || ext === '.bat') {
            return {
                file: env.ComSpec ?? 'cmd.exe',
                args: ['/d', '/s', '/c', `""${resolved}" ${args.map(quoteCmdArg).join(' ')}"`],
                windowsVerbatimArguments: true,
            };
        }
        if (ext === '.ps1') {
            return {
                file: 'powershell.exe',
                args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...args],
            };
        }
        return { file: resolved, args };
    }
    return { file: binPath, args };
}
