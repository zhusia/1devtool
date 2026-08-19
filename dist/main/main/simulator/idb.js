"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.diagnoseIdb = diagnoseIdb;
exports.getIdbInstallCommand = getIdbInstallCommand;
exports.installIdb = installIdb;
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
function getEnrichedPath() {
    const base = process.env.PATH || '';
    const extra = [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        path_1.default.join(os_1.default.homedir(), '.local', 'bin'),
        getPythonUserScriptsPath(),
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
    ].filter((p) => Boolean(p && fs_1.default.existsSync(p)));
    return [...new Set([...extra, ...base.split(':')])].join(':');
}
function getPythonUserScriptsPath() {
    try {
        const output = (0, child_process_1.execFileSync)('python3', [
            '-c',
            'import site, sysconfig; print(sysconfig.get_path("scripts", vars={"base": site.USER_BASE, "platbase": site.USER_BASE}))',
        ], {
            encoding: 'utf-8',
            timeout: 3000,
        }).trim();
        return output || null;
    }
    catch {
        return null;
    }
}
function whichBinary(name) {
    try {
        const output = (0, child_process_1.execFileSync)('which', [name], {
            encoding: 'utf-8',
            timeout: 3000,
            env: { ...process.env, PATH: getEnrichedPath() },
        });
        return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
    }
    catch {
        return null;
    }
}
function diagnoseIdb() {
    const logs = [];
    logs.push(`platform: ${process.platform}`);
    logs.push(`enriched PATH: ${getEnrichedPath()}`);
    const idbPath = whichBinary('idb');
    const companionPath = whichBinary('idb_companion');
    logs.push(idbPath ? `which idb: ${idbPath}` : 'which idb: not found');
    logs.push(companionPath ? `which idb_companion: ${companionPath}` : 'which idb_companion: not found');
    return {
        installed: Boolean(idbPath && companionPath),
        path: idbPath,
        companionPath,
        logs,
    };
}
function getIdbInstallCommand() {
    if (process.platform !== 'darwin')
        return null;
    const hasBrew = Boolean(whichBinary('brew') || fs_1.default.existsSync('/opt/homebrew/bin/brew') || fs_1.default.existsSync('/usr/local/bin/brew'));
    if (!hasBrew)
        return null;
    if (whichBinary('pipx')) {
        return 'brew tap facebook/fb && brew install idb-companion && pipx install fb-idb';
    }
    const scriptsPath = getPythonUserScriptsPath();
    const pathHint = scriptsPath ? ` && echo "idb installed to ${scriptsPath}"` : '';
    return `brew tap facebook/fb && brew install idb-companion && python3 -m pip install --user fb-idb${pathHint}`;
}
async function installIdb(onData) {
    const cmd = getIdbInstallCommand();
    if (!cmd) {
        return {
            ok: false,
            error: process.platform === 'darwin'
                ? 'Homebrew is required to install idb automatically. Install Homebrew, then try again.'
                : 'idb is only supported for iOS Simulator on macOS.',
        };
    }
    onData?.(`$ ${cmd}\n\n`);
    onData?.('Opening installation in a new Terminal window...\n');
    onData?.('When it finishes, come back here and click Recheck.\n\n');
    try {
        await openMacTerminal(cmd);
        return { ok: true, external: true };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onData?.(`\nFailed to open external terminal: ${message}\n`);
        onData?.('\nPlease copy the command above and run it manually.\n');
        return { ok: false, error: message, external: true };
    }
}
async function openMacTerminal(cmd) {
    const scriptDir = path_1.default.join(os_1.default.homedir(), '.1devtool', 'tmp');
    fs_1.default.mkdirSync(scriptDir, { recursive: true });
    const scriptPath = path_1.default.join(scriptDir, `idb-install-${Date.now()}.sh`);
    const body = [
        '#!/bin/zsh -l',
        'set -u',
        'echo "Running 1DevTool idb install..."',
        'echo ""',
        cmd,
        'status=$?',
        'echo ""',
        'if [ $status -eq 0 ]; then',
        '  echo "idb install finished. Go back to 1DevTool and click Recheck."',
        'else',
        '  echo "idb install exited with status $status. Review the output above."',
        'fi',
        'echo ""',
        'echo "Press Enter to close this window..."',
        'read _',
        '',
    ].join('\n');
    fs_1.default.writeFileSync(scriptPath, body, { mode: 0o755 });
    await new Promise((resolve, reject) => {
        const proc = (0, child_process_1.spawn)('open', ['-a', 'Terminal', scriptPath], { stdio: 'ignore' });
        proc.on('error', reject);
        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`open exited with code ${code}`))));
    });
}
