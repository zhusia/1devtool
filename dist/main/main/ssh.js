"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.windowsSshfsCommandMentionsDrive = exports.normalizeWindowsDriveSpec = void 0;
exports.isSshfsPath = isSshfsPath;
exports.checkSshfsAvailability = checkSshfsAvailability;
exports.diagnoseSshfs = diagnoseSshfs;
exports.getSshfsInstallCommand = getSshfsInstallCommand;
exports.installSshfs = installSshfs;
exports.resolveMountPath = resolveMountPath;
exports.testSshConnection = testSshConnection;
exports.listRemoteDirectories = listRemoteDirectories;
exports.isWindowsMountPointBusyError = isWindowsMountPointBusyError;
exports.describeSshfsFailure = describeSshfsFailure;
exports.isWindowsSshfsServiceStarted = isWindowsSshfsServiceStarted;
exports.isMountPathAlive = isMountPathAlive;
exports.mountSshfs = mountSshfs;
exports.unmountSshfs = unmountSshfs;
exports.unmountAllSshfs = unmountAllSshfs;
exports.listActiveMounts = listActiveMounts;
exports.getDefaultScanPath = getDefaultScanPath;
exports.resolveScanPaths = resolveScanPaths;
exports.registerSshIpcHandlers = registerSshIpcHandlers;
exports.discoverLocalSSH = discoverLocalSSH;
exports.listLocalSSHKeys = listLocalSSHKeys;
exports.generateLocalSSHKey = generateLocalSSHKey;
exports.listSSHConfigHosts = listSSHConfigHosts;
const fs_1 = __importDefault(require("fs"));
const net_1 = __importDefault(require("net"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const electron_1 = require("electron");
const env_1 = require("./utils/env");
const sshWindowsMount_1 = require("../shared/sshWindowsMount");
Object.defineProperty(exports, "normalizeWindowsDriveSpec", { enumerable: true, get: function () { return sshWindowsMount_1.normalizeWindowsDriveSpec; } });
Object.defineProperty(exports, "windowsSshfsCommandMentionsDrive", { enumerable: true, get: function () { return sshWindowsMount_1.windowsSshfsCommandMentionsDrive; } });
const MOUNT_ROOT = path_1.default.join(os_1.default.homedir(), '.1devtool', 'mounts');
const activeMounts = new Map();
// Mounts pruned as stale whose OS-level mount may still linger (e.g. a hung
// FUSE path we couldn't force-unmount). Kept here so isSshfsPath() keeps the
// fs timeout guards active for them until a mount/unmount settles their state.
const staleMountPaths = new Set();
const WINDOWS_MOUNT_DRIVE_LETTERS = 'ZYXWVUTSRQPONMLKJIHGFED'.split('');
/** How long Windows unmount waits for the drive letter to disappear after kill. */
const WINDOWS_UNMOUNT_DRAIN_MS = 5000;
/**
 * Drive letters that just failed with WinFsp ERROR_FILE_EXISTS (0x80070050) /
 * "service sshfs has failed to start". Skipped for subsequent allocate attempts
 * in this process so a ghost volume cannot pin us on the same letter forever.
 */
const windowsDriveBusySkip = new Set();
/** Max distinct drive letters to try when a Windows mount hits a busy letter. */
const WINDOWS_MOUNT_DRIVE_ATTEMPTS = 3;
function isSshfsPath(p) {
    if (!p)
        return false;
    try {
        if (isPathWithin(MOUNT_ROOT, p))
            return true;
        for (const mountPath of activeMounts.keys()) {
            if (isPathWithin(mountPath, p))
                return true;
        }
        for (const mountPath of staleMountPaths) {
            if (isPathWithin(mountPath, p))
                return true;
        }
        return false;
    }
    catch {
        return false;
    }
}
function whichBinary(name) {
    try {
        const cmd = os_1.default.platform() === 'win32' ? 'where' : 'which';
        const output = (0, child_process_1.execFileSync)(cmd, [name], {
            encoding: 'utf-8',
            timeout: 3000,
            env: { ...process.env, PATH: (0, env_1.getEnrichedPath)() },
        });
        const first = output.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
        return first || null;
    }
    catch {
        return null;
    }
}
// Single source of truth for the macOS install command: the hint text shown in
// error states and the one-click installer must never drift apart.
const DARWIN_SSHFS_INSTALL_COMMAND = 'brew tap macos-fuse-t/cask && brew install --cask macos-fuse-t/cask/fuse-t && brew install --cask macos-fuse-t/cask/fuse-t-sshfs';
const SETTINGS_INSTALL_POINTER = 'Or install from Settings → Libraries → sshfs.';
function checkSshfsAvailability() {
    const binaryPath = whichBinary('sshfs') || findKnownSshfsPath();
    if (binaryPath) {
        return { available: true, binaryPath };
    }
    const platform = os_1.default.platform();
    const installHint = platform === 'darwin'
        ? `Install fuse-t (userspace FUSE, no kernel extension): \`${DARWIN_SSHFS_INSTALL_COMMAND}\`. ${SETTINGS_INSTALL_POINTER}`
        : platform === 'linux'
            ? `Install with your package manager, e.g. \`sudo apt install sshfs\` or \`sudo dnf install fuse-sshfs\`. ${SETTINGS_INSTALL_POINTER}`
            : platform === 'win32'
                ? `Install WinFsp (https://winfsp.dev/) and SSHFS-Win (https://github.com/winfsp/sshfs-win/releases). ${SETTINGS_INSTALL_POINTER}`
                : 'Install sshfs (FUSE for SSH) for your platform.';
    return { available: false, installHint };
}
function findKnownSshfsPath() {
    const platform = os_1.default.platform();
    const candidates = platform === 'win32'
        ? [
            'C:\\Program Files\\SSHFS-Win\\bin\\sshfs.exe',
            'C:\\Program Files (x86)\\SSHFS-Win\\bin\\sshfs.exe',
        ]
        : ['/opt/homebrew/bin/sshfs', '/usr/local/bin/sshfs', '/usr/bin/sshfs', '/bin/sshfs'];
    for (const candidate of candidates) {
        try {
            if (fs_1.default.existsSync(candidate))
                return candidate;
        }
        catch {
            // ignore
        }
    }
    return null;
}
function diagnoseSshfs() {
    const logs = [];
    const platform = os_1.default.platform();
    logs.push(`platform: ${platform}`);
    const enriched = (0, env_1.getEnrichedPath)();
    logs.push(`enriched PATH: ${enriched}`);
    const viaWhich = whichBinary('sshfs');
    if (viaWhich) {
        logs.push(`which sshfs: ${viaWhich}`);
        return { installed: true, path: viaWhich, logs };
    }
    logs.push('which sshfs: not found');
    const candidates = platform === 'win32'
        ? [
            'C:\\Program Files\\SSHFS-Win\\bin\\sshfs.exe',
            'C:\\Program Files (x86)\\SSHFS-Win\\bin\\sshfs.exe',
        ]
        : ['/opt/homebrew/bin/sshfs', '/usr/local/bin/sshfs', '/usr/bin/sshfs', '/bin/sshfs'];
    for (const candidate of candidates) {
        try {
            if (fs_1.default.existsSync(candidate)) {
                logs.push(`${candidate}: found`);
                return { installed: true, path: candidate, logs };
            }
            logs.push(`${candidate}: not found`);
        }
        catch (err) {
            logs.push(`${candidate}: error — ${err.message}`);
        }
    }
    logs.push('sshfs: NOT detected');
    return { installed: false, path: null, logs };
}
function getSshfsInstallCommand() {
    const platform = os_1.default.platform();
    if (platform === 'darwin') {
        if (whichBinary('brew'))
            return DARWIN_SSHFS_INSTALL_COMMAND;
        for (const brewPath of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
            if (fs_1.default.existsSync(brewPath))
                return DARWIN_SSHFS_INSTALL_COMMAND;
        }
        return null;
    }
    if (platform === 'win32') {
        if (whichBinary('winget')) {
            // Two separate commands (newline-joined), not `&&`-chained: Windows
            // PowerShell 5.1 (the built-in default) does not support `&&`, so a
            // copy-pasted chained command fails. Separate lines run sequentially in
            // both cmd.exe and every PowerShell version.
            return [
                'winget install -e --id WinFsp.WinFsp --accept-source-agreements --accept-package-agreements',
                'winget install -e --id SSHFS-Win.SSHFS-Win --accept-source-agreements --accept-package-agreements',
            ].join('\n');
        }
        if (whichBinary('scoop')) {
            return 'scoop install winfsp sshfs-win';
        }
        if (whichBinary('choco')) {
            return 'choco install -y winfsp sshfs-win';
        }
        return null;
    }
    const packageManagers = [
        { check: 'apt-get', install: 'apt-get install -y sshfs' },
        { check: 'dnf', install: 'dnf install -y fuse-sshfs' },
        { check: 'yum', install: 'yum install -y fuse-sshfs' },
        { check: 'pacman', install: 'pacman -S --noconfirm sshfs' },
        { check: 'apk', install: 'apk add sshfs' },
        { check: 'zypper', install: 'zypper install -y sshfs' },
    ];
    for (const pm of packageManagers) {
        if (whichBinary(pm.check))
            return pm.install;
    }
    return null;
}
async function installSshfs(onData) {
    const cmd = getSshfsInstallCommand();
    if (!cmd) {
        return {
            ok: false,
            error: 'No supported package manager found. Please install sshfs manually (see platform notes).',
        };
    }
    const platform = os_1.default.platform();
    if (platform === 'darwin' || platform === 'win32') {
        return runInstallInExternalTerminal(cmd, onData, platform);
    }
    return runInstallInProcess(cmd, onData);
}
async function runInstallInExternalTerminal(cmd, onData, platform) {
    onData?.(`$ ${cmd}\n\n`);
    onData?.(`Opening installation in a new ${platform === 'darwin' ? 'Terminal' : 'Command Prompt'} window...\n`);
    onData?.(`You'll be prompted for your password there. When it finishes, come back here and click Recheck.\n\n`);
    try {
        if (platform === 'darwin') {
            await openMacTerminal(cmd);
        }
        else {
            await openWindowsTerminal(cmd);
        }
        return { ok: true, external: true };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onData?.(`\nFailed to open external terminal: ${message}\n`);
        onData?.(`\nPlease copy the command above and run it manually in your terminal.\n`);
        return { ok: false, error: message, external: true };
    }
}
async function openMacTerminal(cmd) {
    const scriptDir = path_1.default.join(os_1.default.homedir(), '.1devtool', 'tmp');
    fs_1.default.mkdirSync(scriptDir, { recursive: true });
    const scriptPath = path_1.default.join(scriptDir, `sshfs-install-${Date.now()}.sh`);
    const body = [
        '#!/bin/zsh -l',
        'set -u',
        'echo "Running 1DevTool sshfs install..."',
        'echo ""',
        cmd,
        'status=$?',
        'echo ""',
        'if [ $status -eq 0 ]; then',
        '  echo "✓ Install finished successfully. Go back to 1DevTool and click Recheck."',
        'else',
        '  echo "✗ Install exited with status $status. Review the output above."',
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
async function openWindowsTerminal(cmd) {
    const scriptDir = path_1.default.join(os_1.default.homedir(), '.1devtool', 'tmp');
    fs_1.default.mkdirSync(scriptDir, { recursive: true });
    const scriptPath = path_1.default.join(scriptDir, `sshfs-install-${Date.now()}.cmd`);
    const body = [
        '@echo off',
        'echo Running 1DevTool sshfs install...',
        'echo.',
        // `cmd` may contain multiple newline-separated commands; emit each on its
        // own line so cmd.exe runs them sequentially with CRLF endings.
        ...cmd.split(/\r?\n/),
        'set rc=%errorlevel%',
        'echo.',
        'if %rc%==0 (',
        '  echo Install finished successfully. Go back to 1DevTool and click Recheck.',
        ') else (',
        '  echo Install exited with code %rc%. Review the output above.',
        ')',
        'echo.',
        'pause',
        '',
    ].join('\r\n');
    fs_1.default.writeFileSync(scriptPath, body);
    await new Promise((resolve, reject) => {
        const proc = (0, child_process_1.spawn)('cmd', ['/c', 'start', '"1DevTool Install"', 'cmd', '/k', scriptPath], {
            stdio: 'ignore',
        });
        proc.on('error', reject);
        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`start exited with code ${code}`))));
    });
}
async function runInstallInProcess(cmd, onData) {
    return new Promise((resolve) => {
        onData?.(`$ ${cmd}\n`);
        const useShell = cmd.includes('&&');
        const child = useShell
            ? (0, child_process_1.spawn)(cmd, [], {
                shell: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, PATH: (0, env_1.getEnrichedPath)() },
            })
            : (() => {
                const parts = cmd.split(' ');
                return (0, child_process_1.spawn)(parts[0], parts.slice(1), {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: { ...process.env, PATH: (0, env_1.getEnrichedPath)() },
                });
            })();
        const timer = setTimeout(() => {
            try {
                child.kill();
            }
            catch {
                // ignore
            }
        }, 600000);
        child.stdout?.on('data', (data) => onData?.(data.toString()));
        child.stderr?.on('data', (data) => onData?.(data.toString()));
        child.on('error', (error) => {
            clearTimeout(timer);
            onData?.(`\nError: ${error.message}\n`);
            resolve({ ok: false, error: error.message });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                onData?.(`\nProcess exited with code ${code}\n`);
                onData?.(`\nHint: most Linux package managers need sudo. Copy the command above and run it with sudo in a terminal.\n`);
                resolve({ ok: false, error: `Installation failed with exit code ${code}` });
                return;
            }
            const diag = diagnoseSshfs();
            if (diag.installed) {
                onData?.(`\nsshfs installed successfully at ${diag.path}\n`);
                resolve({ ok: true });
            }
            else {
                onData?.(`\nsshfs was installed but could not be found on PATH.\n`);
                resolve({ ok: false, error: 'sshfs was installed but could not be found on PATH.' });
            }
        });
    });
}
function sanitizeSegment(value) {
    return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'mount';
}
function resolveMountPath(projectId) {
    if (os_1.default.platform() === 'win32') {
        void projectId;
        return findAvailableWindowsMountDrive();
    }
    return path_1.default.join(MOUNT_ROOT, sanitizeSegment(projectId));
}
// Fast reachability check: TCP connect with a short timeout. Avoids the
// ~120s TCP handshake wait that hangs sshfs when a VPS is down or blocked
// by a firewall. Auth is verified by the sshfs mount itself; we only need
// to prove the socket opens before we spawn sshfs.
async function testSshConnection(args) {
    const timeoutMs = Math.max(1000, Math.min(args.timeoutMs ?? 5000, 15000));
    const start = Date.now();
    const host = args.host?.trim();
    const port = Number(args.port) || 22;
    if (!host) {
        return { ok: false, tcp: false, error: 'Missing host', durationMs: 0 };
    }
    return new Promise((resolve) => {
        const socket = new net_1.default.Socket();
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            try {
                socket.destroy();
            }
            catch {
                // ignore
            }
            resolve({ ...result, durationMs: Date.now() - start });
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => {
            finish({ ok: true, tcp: true, durationMs: 0 });
        });
        socket.once('timeout', () => {
            finish({ ok: false, tcp: false, error: `Connection timed out after ${timeoutMs}ms`, durationMs: 0 });
        });
        socket.once('error', (err) => {
            finish({ ok: false, tcp: false, error: err.message, durationMs: 0 });
        });
        try {
            socket.connect(port, host);
        }
        catch (err) {
            finish({
                ok: false,
                tcp: false,
                error: err instanceof Error ? err.message : String(err),
                durationMs: 0,
            });
        }
    });
}
// Remote directory browser for the SSH connection dialog: runs a tiny POSIX
// snippet over ssh (BatchMode — requires key auth, same as the mount) that
// resolves the path and lists child directories.
async function listRemoteDirectories(args) {
    const host = args.host?.trim();
    const username = args.username?.trim();
    if (!host || !username)
        return { ok: false, error: 'Missing host or username' };
    const port = Number(args.port) || 22;
    const raw = (args.remotePath || '').trim();
    const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
    const cdExpr = !raw || raw === '~'
        ? 'cd'
        : raw.startsWith('~/')
            ? `cd -- "$HOME"/${quote(raw.slice(2))}`
            : `cd -- ${quote(raw)}`;
    const script = `${cdExpr} 2>/dev/null || exit 21; pwd; ls -1Ap 2>/dev/null | grep '/$' | head -n 500`;
    const sshArgs = [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=8',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-p', String(port),
    ];
    if (args.privateKeyPath?.trim()) {
        sshArgs.push('-i', args.privateKeyPath.trim(), '-o', 'IdentitiesOnly=yes');
    }
    sshArgs.push(`${username}@${host}`, script);
    return await new Promise((resolve) => {
        const proc = (0, child_process_1.spawn)('ssh', sshArgs, {
            env: { ...process.env, PATH: (0, env_1.getEnrichedPath)() },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => {
            try {
                proc.kill('SIGKILL');
            }
            catch {
                // ignore
            }
            finish({ ok: false, error: 'Timed out listing the remote directory' });
        }, 15000);
        proc.stdout?.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        proc.stderr?.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        proc.on('error', (err) => finish({ ok: false, error: err.message }));
        proc.on('close', (code) => {
            if (code === 21)
                return finish({ ok: false, error: 'Remote path not found' });
            // `grep` exits 1 when the directory simply has no subdirectories — the
            // pipeline's status is grep's, so treat it as an empty listing as long
            // as pwd produced output.
            if (code !== 0 && !(code === 1 && stdout.trim())) {
                const detail = stderr.trim() || `ssh exited with code ${code}`;
                const friendly = /permission denied/i.test(detail)
                    ? `SSH key authentication failed for ${username}@${host} — browsing needs key auth (run \`ssh-copy-id ${username}@${host}\` from this machine first).`
                    : detail;
                return finish({ ok: false, error: friendly });
            }
            const lines = stdout.split(/\r?\n/).filter(Boolean);
            const resolvedPath = lines.shift() || '/';
            const dirs = lines
                .map((line) => line.replace(/\/$/, ''))
                .filter(Boolean)
                .sort((a, b) => a.localeCompare(b));
            finish({ ok: true, path: resolvedPath, dirs });
        });
    });
}
const SSHFS_MOUNT_TIMEOUT_MS = 30000;
const MOUNT_PROBE_TIMEOUT_MS = 2000;
// fuse-t's sshfs does NOT exit after a failed SSH connection — it prints the
// error and idles forever (verified: fg and daemon mode, with and without
// `reconnect`). Waiting for 'close' therefore turns every auth/path error
// into a generic 30s timeout, so we watch stderr for fatal output instead.
const SSHFS_FATAL_STDERR_RE = /remote host has disconnected|permission denied|too many authentication failures|host key verification failed|identification has changed|connection refused|connection reset|connection timed out|no such file or directory|bad configuration option|cannot create winfsp-fuse file system|service sshfs has failed to start/i;
/** WinFsp ERROR_FILE_EXISTS (0x80070050) — mount point / volume prefix already taken. */
function isWindowsMountPointBusyError(detail) {
    return /80070050|error_file_exists|failed to start \(status=80070050\)|cannot create winfsp-fuse file system/i.test(detail || '');
}
// In daemon mode sshfs swallows the underlying ssh's own stderr (only a
// generic "remote host has disconnected" surfaces). `ssh -E <file>` routes
// ssh's real error ("Permission denied (publickey,…)") to a log we can read.
function sshfsErrorLogPath(projectId) {
    return path_1.default.join(os_1.default.tmpdir(), `1devtool-sshfs-${sanitizeSegment(projectId)}.log`);
}
function readSshfsErrorLog(errLogPath) {
    if (!errLogPath)
        return '';
    try {
        const lines = fs_1.default.readFileSync(errLogPath, 'utf-8').trim().split(/\r?\n/).filter(Boolean);
        return lines.slice(-3).join(' · ');
    }
    catch {
        return '';
    }
}
// Map raw sshfs/ssh output to an actionable message. The mount runs headless
// (BatchMode) — the most common failure by far is "the server wants a
// password / this machine's key isn't authorized", which users misread as a
// network problem unless we spell out the fix.
//
// "Project Settings" (Pro .1devtool config) is a different surface — SSH key
// and host fields live under Settings → SSH / Add Project / SSH Manager.
function describeSshfsFailure(args, detail) {
    const target = `${args.username}@${args.host}`;
    if (/permission denied|too many authentication failures/i.test(detail)) {
        const keyHint = /load key .*invalid format/i.test(detail)
            ? ' A listed private key has an invalid format (often a PuTTY .ppk or corrupted file) — pick a valid OpenSSH private key under Settings → SSH, or remove the bad key from the agent/ssh config so it is not tried first.'
            : '';
        const selectedKey = args.privateKeyPath?.trim()
            ? ` This project is using key "${args.privateKeyPath.trim()}".`
            : ' No project key is set, so OpenSSH is trying default keys from ~/.ssh (and the agent).';
        return `SSH key authentication failed for ${target} — the mount runs headless and cannot type a password.${selectedKey}${keyHint} Fix: run \`ssh-copy-id ${target}\` from this machine, or choose the authorized OpenSSH private key under Settings → SSH (edit the connection / recreate the SSH project), then Retry. (${detail})`;
    }
    if (/host key verification failed|identification has changed/i.test(detail)) {
        return `Host key verification failed for ${args.host}. Connect once from a terminal (\`ssh ${target}\`) to review and accept the host key, then Retry. (${detail})`;
    }
    if (/no such file or directory/i.test(detail)) {
        return `Remote path "${args.remotePath || '~'}" was not found on ${args.host}. Fix the remote path under Settings → SSH (or when creating the SSH project), then Retry. (${detail})`;
    }
    // SSHFS-Win prints this on success and keeps the process alive; if we still
    // timed out, the drive letter never became readable. Do not call
    // resolveMountPath() here — on Windows it allocates a free drive letter and
    // can disagree with the path the failed attempt actually used.
    if (/service sshfs has been started/i.test(detail) && /timed out/i.test(detail)) {
        return `SSHFS-Win reported that the service started, but the assigned drive letter never became available within ${SSHFS_MOUNT_TIMEOUT_MS / 1000}s. Check that WinFsp is running, no other process holds the drive letter, and the remote path exists, then Retry. (${detail})`;
    }
    if (isWindowsMountPointBusyError(detail)) {
        return `SSHFS-Win could not create the drive letter mount — the letter or volume is already in use (WinFsp status 0x80070050). Close other SSHFS mounts, Retry, or reboot if a ghost drive remains. (${detail})`;
    }
    return detail;
}
// True when SSHFS-Win's launcher has announced a successful service start.
// The svc process stays alive for the lifetime of the mount — it does not
// exit — so this line (not process close) is the success signal on Windows.
function isWindowsSshfsServiceStarted(output) {
    return /the service sshfs has been started/i.test(output);
}
// stat() a possibly-dead FUSE path without ever blocking the main process:
// a hung mount leaves fs.promises.stat pending forever, so race it against a
// short timeout (same defensive pattern as the 8s readdir guard in
// fileSystem.ts — see docs/common-errors/ssh/unreachable-vps-freezes-app.md).
async function statProbe(targetPath, timeoutMs = MOUNT_PROBE_TIMEOUT_MS) {
    return await Promise.race([
        fs_1.default.promises.stat(targetPath).then((stats) => ({ stats, code: null, timedOut: false }), (err) => ({ stats: null, code: err.code ?? null, timedOut: false })),
        new Promise((resolve) => setTimeout(() => resolve({ stats: null, code: null, timedOut: true }), timeoutMs)),
    ]);
}
// A mount is alive when its path stats within the probe budget AND (on POSIX)
// sits on a different device than its parent directory — a leftover empty dir
// under ~/.1devtool/mounts shares the parent's device id, a real FUSE/NFS
// mount never does. A hung or errored mount fails the stat.
async function isMountPathAlive(mountPath) {
    const probe = await statProbe(mountPath);
    if (!probe.stats)
        return false;
    if (os_1.default.platform() === 'win32')
        return true;
    const parent = path_1.default.dirname(stripTrailingPathSeparator(mountPath));
    if (!parent || parent === mountPath)
        return true;
    const parentProbe = await statProbe(parent);
    if (!parentProbe.stats)
        return false;
    return probe.stats.dev !== parentProbe.stats.dev;
}
// true = something occupies the mount point (possibly a hung dead mount),
// false = plain dir / nothing there, null = cannot tell (be conservative).
async function isMountPointPresent(mountPath) {
    const probe = await statProbe(mountPath);
    if (probe.timedOut)
        return true;
    if (!probe.stats)
        return probe.code === 'ENOENT' || probe.code === 'ENOTDIR' ? false : null;
    if (os_1.default.platform() === 'win32')
        return true;
    const parent = path_1.default.dirname(stripTrailingPathSeparator(mountPath));
    if (!parent || parent === mountPath)
        return null;
    const parentProbe = await statProbe(parent);
    if (!parentProbe.stats)
        return null;
    return probe.stats.dev !== parentProbe.stats.dev;
}
// fuse-t's sshfs delegates the filesystem to a separate `go-nfsv4` server
// process. SIGKILLing sshfs (our timeout / fatal-error path) orphans that
// server, which keeps holding one of fuse-t's fixed localhost ports
// (52100–52117) forever — after ~18 leaked servers EVERY fuse-t mount on the
// machine fails with "short read on fuse device" ("failed to find unused
// port" in ~/Library/Logs/fuse-t/fuse-t.log) until the orphans are killed.
// Reap any server whose command line references our mount path.
function killOrphanedFuseTServers(mountPath) {
    if (os_1.default.platform() !== 'darwin')
        return;
    try {
        const output = (0, child_process_1.execFileSync)('ps', ['-axo', 'pid=,command='], { encoding: 'utf-8', timeout: 3000 });
        for (const line of output.split('\n')) {
            const match = /^\s*(\d+)\s+(.+)$/.exec(line);
            if (!match)
                continue;
            const command = match[2];
            if (!command.includes('go-nfsv4') || !command.includes(mountPath))
                continue;
            try {
                process.kill(Number(match[1]), 'SIGKILL');
            }
            catch {
                // already gone
            }
        }
    }
    catch {
        // ps unavailable — best effort
    }
}
// Drop a mount whose sshfs process died out from under us (endpoint reboot,
// network drop, sleep). Bookkeeping is cleared so callers fall through to a
// fresh mount; any OS-level leftover is best-effort unmounted.
// Keep the activeMounts entry until unmountSshfs runs so Windows can still
// read windowsSvcPid and kill the correct process tree.
async function pruneStaleMount(mountPath) {
    staleMountPaths.add(mountPath);
    killOrphanedFuseTServers(mountPath);
    try {
        await unmountSshfs(mountPath);
    }
    catch {
        // Leftover is hung or already gone; force-clear bookkeeping so remount
        // can allocate the drive letter again. staleMountPaths keeps fs guards on.
        activeMounts.delete(mountPath);
    }
}
async function mountSshfs(args) {
    const check = checkSshfsAvailability();
    if (!check.available || !check.binaryPath) {
        const hint = check.installHint ? ` ${check.installHint}` : '';
        throw new Error(`sshfs is not installed.${hint}`);
    }
    // Windows only: a ghost WinFsp volume (status 0x80070050 ERROR_FILE_EXISTS)
    // blocks the first free drive letter. Free orphans and retry a few letters.
    // macOS/Linux take a single attempt — no drive-letter pool.
    if (os_1.default.platform() === 'win32') {
        let lastError = null;
        for (let attempt = 0; attempt < WINDOWS_MOUNT_DRIVE_ATTEMPTS; attempt++) {
            const mountPath = resolveMountPath(args.projectId);
            try {
                await freeWindowsSshfsDrive(mountPath);
                const result = await mountSshfsOnce(args, check.binaryPath, mountPath);
                const letter = (0, sshWindowsMount_1.normalizeWindowsDriveSpec)(mountPath).replace(/:$/, '').toUpperCase();
                windowsDriveBusySkip.delete(letter);
                return result;
            }
            catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                const detail = lastError.message;
                await freeWindowsSshfsDrive(mountPath).catch(() => undefined);
                if (isWindowsMountPointBusyError(detail) && attempt < WINDOWS_MOUNT_DRIVE_ATTEMPTS - 1) {
                    const letter = (0, sshWindowsMount_1.normalizeWindowsDriveSpec)(mountPath).replace(/:$/, '').toUpperCase();
                    if (letter)
                        windowsDriveBusySkip.add(letter);
                    continue;
                }
                throw lastError;
            }
        }
        throw lastError ?? new Error('SSHFS-Win mount failed');
    }
    const mountPath = resolveMountPath(args.projectId);
    return mountSshfsOnce(args, check.binaryPath, mountPath);
}
async function mountSshfsOnce(args, sshfsBinaryPath, mountPath) {
    if (activeMounts.has(mountPath)) {
        // Verify the bookkeeping against reality before reusing the mount: the
        // sshfs process may have died without going through unmountSshfs, and
        // returning a dead path here is what used to force an app restart.
        if (await isMountPathAlive(mountPath)) {
            return { mountPath };
        }
        await pruneStaleMount(mountPath);
    }
    if (os_1.default.platform() !== 'win32') {
        // Timeout-raced: mkdir targeting a lingering hung FUSE path must not
        // block the main process; if it fails, the mount below surfaces the error.
        await Promise.race([
            fs_1.default.promises.mkdir(mountPath, { recursive: true }).catch(() => undefined),
            new Promise((resolve) => setTimeout(resolve, MOUNT_PROBE_TIMEOUT_MS)),
        ]);
    }
    const platform = os_1.default.platform();
    const isWindows = platform === 'win32';
    const errLogPath = platform === 'darwin' ? sshfsErrorLogPath(args.projectId) : null;
    if (errLogPath) {
        try {
            fs_1.default.rmSync(errLogPath, { force: true });
        }
        catch {
            // stale log from a previous attempt; best-effort
        }
    }
    const options = buildSshfsOptions(args, platform, errLogPath);
    const { binaryPath, sshfsArgs } = buildSshfsCommand(sshfsBinaryPath, args, mountPath, options);
    // Captured on successful Windows mount so unmount can taskkill /T the svc tree.
    let windowsSvcPid;
    try {
        await new Promise((resolve, reject) => {
            const proc = (0, child_process_1.spawn)(binaryPath, sshfsArgs, {
                env: { ...process.env, PATH: (0, env_1.getEnrichedPath)() },
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
            let output = '';
            let settled = false;
            let fatalTimer = null;
            let pollTimer = null;
            const failureDetail = () => {
                const parts = [output.trim(), readSshfsErrorLog(errLogPath)].filter(Boolean);
                return parts.join(' · ');
            };
            const clearMountTimers = () => {
                clearTimeout(killTimer);
                if (fatalTimer)
                    clearTimeout(fatalTimer);
                if (pollTimer) {
                    clearInterval(pollTimer);
                    pollTimer = null;
                }
            };
            // Reject + kill: fuse-t's sshfs won't exit on its own after a fatal
            // error, and a killed sshfs can leave a half-set-up mount behind — keep
            // the fs guards on and best-effort clean the mount point.
            // On Windows, only kill when the mount did NOT succeed — sshfs-win svc
            // is the long-lived service process for a healthy mount.
            const settleReject = (err) => {
                if (settled)
                    return;
                settled = true;
                clearMountTimers();
                try {
                    proc.kill('SIGKILL');
                }
                catch {
                    // ignore
                }
                staleMountPaths.add(mountPath);
                setTimeout(() => {
                    killOrphanedFuseTServers(mountPath);
                    void unmountSshfs(mountPath).catch(() => undefined);
                }, 500);
                reject(err);
            };
            const settleResolve = () => {
                if (settled)
                    return;
                settled = true;
                clearMountTimers();
                // Do not kill the child: on Windows it is the WinFsp service process;
                // on POSIX exit-based success the child has already exited (or
                // daemonized). Killing here would tear down a just-mounted drive.
                // Remember the svc PID so Windows unmount can kill the tree later —
                // `net use /delete` alone does not release SSHFS-Win svc mounts.
                if (isWindows && typeof proc.pid === 'number' && proc.pid > 0) {
                    windowsSvcPid = proc.pid;
                }
                resolve();
            };
            // Kill sshfs if it hasn't succeeded within the budget. Without this, an
            // unreachable VPS leaves sshfs spinning for ~120s (TCP connect timeout),
            // during which a persisted mountPath can still be read by fs.readdir on
            // the renderer side — freezing the app.
            const killTimer = setTimeout(() => {
                const detail = failureDetail();
                const base = `sshfs mount timed out after ${SSHFS_MOUNT_TIMEOUT_MS / 1000}s`;
                settleReject(new Error(describeSshfsFailure(args, detail ? `${base} — ${detail}` : base)));
            }, SSHFS_MOUNT_TIMEOUT_MS);
            // Windows: sshfs-win.exe svc prints "The service sshfs has been started"
            // and keeps running for the life of the mount. Waiting for process close
            // always hits the 30s timeout and SIGKILLs a healthy mount. Treat the
            // drive letter becoming readable as success instead.
            const tryWindowsMountReady = () => {
                if (!isWindows || settled)
                    return;
                void isMountPathAlive(mountPath).then((alive) => {
                    if (alive)
                        settleResolve();
                });
            };
            if (isWindows) {
                pollTimer = setInterval(tryWindowsMountReady, 250);
                // Immediate probe in case the drive appears before the first interval.
                tryWindowsMountReady();
            }
            const onProcessOutput = (chunk) => {
                output += chunk.toString();
                if (isWindows && isWindowsSshfsServiceStarted(output)) {
                    // Service announced — poll more aggressively for the drive letter.
                    tryWindowsMountReady();
                }
                // Fail fast on fatal output instead of waiting out the 30s backstop.
                // Grace period lets the rest of stderr + the ssh error log flush so
                // the message carries the real reason, not just the first line.
                if (!fatalTimer && !settled && SSHFS_FATAL_STDERR_RE.test(output)) {
                    fatalTimer = setTimeout(() => {
                        settleReject(new Error(describeSshfsFailure(args, failureDetail() || 'sshfs failed to connect')));
                    }, 400);
                }
            };
            proc.stderr?.on('data', onProcessOutput);
            proc.stdout?.on('data', onProcessOutput);
            proc.on('error', (err) => {
                if (settled)
                    return;
                settled = true;
                clearMountTimers();
                reject(err);
            });
            proc.on('close', (code) => {
                if (settled)
                    return;
                // Windows: early exit before the drive is up is a failure; if the
                // drive is already alive, treat as success (some launcher versions
                // hand off and exit).
                if (isWindows) {
                    void isMountPathAlive(mountPath).then((alive) => {
                        if (alive)
                            settleResolve();
                        else {
                            settleReject(new Error(describeSshfsFailure(args, failureDetail() || `sshfs-win exited with code ${code} before the drive became available`)));
                        }
                    });
                    return;
                }
                // POSIX: fuse-t/sshfs daemonizes and the parent exits 0 when the
                // mount is ready (or we already failed-fast on fatal stderr).
                if (code === 0)
                    settleResolve();
                else
                    settleReject(new Error(describeSshfsFailure(args, failureDetail() || `sshfs exited with code ${code}`)));
            });
        });
    }
    finally {
        if (errLogPath) {
            try {
                fs_1.default.rmSync(errLogPath, { force: true });
            }
            catch {
                // best-effort cleanup
            }
        }
    }
    const mountInfo = {
        host: args.host,
        port: args.port,
        username: args.username,
        remotePath: args.remotePath,
    };
    if (isWindows && typeof windowsSvcPid === 'number') {
        mountInfo.windowsSvcPid = windowsSvcPid;
    }
    activeMounts.set(mountPath, mountInfo);
    staleMountPaths.delete(mountPath);
    return { mountPath };
}
function killWindowsProcessTree(pid) {
    if (!Number.isFinite(pid) || pid <= 0)
        return;
    try {
        // /T kills the full tree (sshfs-win parent + child sshfs.exe). /F is
        // required — graceful close leaves the WinFsp volume mounted.
        (0, child_process_1.execFileSync)('taskkill', ['/PID', String(pid), '/T', '/F'], {
            encoding: 'utf-8',
            timeout: 8000,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
    catch {
        // Process already gone or access denied — caller re-probes the drive.
    }
}
function listWindowsSshfsWinProcesses() {
    if (os_1.default.platform() !== 'win32')
        return [];
    try {
        // CommandLine is how we attribute an orphaned svc to a drive letter after
        // a crash (tracked PID lost). Prefer CIM over wmic (deprecated).
        const script = "Get-CimInstance Win32_Process -Filter \"Name = 'sshfs-win.exe'\" " +
            '| Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress';
        const raw = (0, child_process_1.execFileSync)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
            encoding: 'utf-8',
            timeout: 8000,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
        if (!raw)
            return [];
        const parsed = JSON.parse(raw);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        return rows
            .map((row) => ({
            pid: Number(row?.ProcessId),
            commandLine: typeof row?.CommandLine === 'string' ? row.CommandLine : '',
        }))
            .filter((row) => Number.isFinite(row.pid) && row.pid > 0);
    }
    catch {
        return [];
    }
}
/** Kill every sshfs-win svc whose command line mounts this drive letter. */
function killWindowsSshfsProcessesForDrive(driveSpec) {
    const drive = (0, sshWindowsMount_1.normalizeWindowsDriveSpec)(driveSpec);
    for (const proc of listWindowsSshfsWinProcesses()) {
        if ((0, sshWindowsMount_1.windowsSshfsCommandMentionsDrive)(proc.commandLine, drive)) {
            killWindowsProcessTree(proc.pid);
        }
    }
}
/**
 * Best-effort free a Windows drive letter before (re)mounting: kill any
 * sshfs-win tree that claims it, then net use /delete. Does not throw —
 * callers re-probe the letter. Windows only.
 */
async function freeWindowsSshfsDrive(mountPath) {
    if (os_1.default.platform() !== 'win32' || !mountPath)
        return;
    const drive = (0, sshWindowsMount_1.normalizeWindowsDriveSpec)(mountPath);
    killWindowsSshfsProcessesForDrive(drive);
    try {
        (0, child_process_1.execFileSync)('net', ['use', drive, '/delete', '/y'], {
            encoding: 'utf-8',
            timeout: 5000,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    }
    catch {
        // expected when the letter was never a net-use mapping
    }
    await waitForMountPathGone(mountPath, 2000);
}
async function waitForMountPathGone(mountPath, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!(await isMountPathAlive(mountPath)))
            return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !(await isMountPathAlive(mountPath));
}
/**
 * Windows-only unmount for SSHFS-Win `svc` mounts.
 *
 * Primary: kill the tracked `sshfs-win.exe` process tree (and any orphan
 * sshfs-win processes for the same drive letter). Secondary: best-effort
 * `net use X: /delete` (often fails with 2250 for WinFsp svc mounts — ignore).
 * Darwin/Linux never enter this function.
 */
async function unmountWindowsSshfs(mountPath) {
    const drive = (0, sshWindowsMount_1.normalizeWindowsDriveSpec)(mountPath);
    const info = activeMounts.get(mountPath);
    if (typeof info?.windowsSvcPid === 'number' && info.windowsSvcPid > 0) {
        killWindowsProcessTree(info.windowsSvcPid);
    }
    // Orphans / lost PID / launcher hand-off: match by drive letter in argv.
    killWindowsSshfsProcessesForDrive(drive);
    // Best-effort legacy cleanup. SSHFS-Win svc mounts are often NOT removable
    // this way ("The network connection could not be found" / 2250) even when
    // `net use` lists them under WinFsp.Np — process kill is the real teardown.
    try {
        await new Promise((resolve, reject) => {
            const proc = (0, child_process_1.spawn)('net', ['use', drive, '/delete', '/y'], {
                env: { ...process.env, PATH: (0, env_1.getEnrichedPath)() },
                stdio: ['ignore', 'ignore', 'pipe'],
                windowsHide: true,
            });
            let stderr = '';
            proc.stderr?.on('data', (chunk) => {
                stderr += chunk.toString();
            });
            proc.on('error', (err) => reject(err));
            proc.on('close', (code) => {
                if (code === 0)
                    resolve();
                else
                    reject(new Error(stderr.trim() || `net use exited with code ${code}`));
            });
        });
    }
    catch {
        // expected for many healthy svc mounts
    }
    const gone = await waitForMountPathGone(mountPath, WINDOWS_UNMOUNT_DRAIN_MS);
    activeMounts.delete(mountPath);
    staleMountPaths.delete(mountPath);
    if (!gone && (await isMountPointPresent(mountPath)) !== false) {
        throw new Error(`Failed to unmount Windows SSHFS drive ${drive} — sshfs-win process may still be holding the volume`);
    }
}
async function unmountSshfs(mountPath) {
    if (!mountPath)
        return;
    const platform = os_1.default.platform();
    // Windows path is intentionally separate: net use alone does not unmount
    // SSHFS-Win svc drives. Do not fold Windows into the POSIX attempts loop.
    if (platform === 'win32') {
        await unmountWindowsSshfs(mountPath);
        return;
    }
    const attempts = [];
    if (platform === 'linux') {
        attempts.push({ cmd: 'fusermount3', args: ['-u', mountPath] });
        attempts.push({ cmd: 'fusermount', args: ['-u', mountPath] });
        attempts.push({ cmd: 'umount', args: [mountPath] });
    }
    else if (platform === 'darwin') {
        attempts.push({ cmd: 'umount', args: [mountPath] });
        attempts.push({ cmd: 'diskutil', args: ['unmount', 'force', mountPath] });
    }
    let lastError = null;
    for (const attempt of attempts) {
        const binary = whichBinary(attempt.cmd);
        if (!binary)
            continue;
        try {
            await new Promise((resolve, reject) => {
                const proc = (0, child_process_1.spawn)(binary, attempt.args, {
                    env: { ...process.env, PATH: (0, env_1.getEnrichedPath)() },
                    stdio: ['ignore', 'ignore', 'pipe'],
                });
                let stderr = '';
                proc.stderr?.on('data', (chunk) => {
                    stderr += chunk.toString();
                });
                proc.on('error', (err) => reject(err));
                proc.on('close', (code) => {
                    if (code === 0)
                        resolve();
                    else
                        reject(new Error(stderr.trim() || `${attempt.cmd} exited with code ${code}`));
                });
            });
            activeMounts.delete(mountPath);
            staleMountPaths.delete(mountPath);
            try {
                fs_1.default.rmdirSync(mountPath);
            }
            catch {
                // Directory may still be busy or non-empty; leave it.
            }
            return;
        }
        catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
        }
    }
    if (lastError) {
        // If nothing actually occupies the mount point (the sshfs process already
        // died and the OS reclaimed the mount, leaving a plain dir), a failed
        // umount is not an error — settle the unmount so force-remounts proceed.
        if ((await isMountPointPresent(mountPath)) === false) {
            activeMounts.delete(mountPath);
            staleMountPaths.delete(mountPath);
            try {
                fs_1.default.rmdirSync(mountPath);
            }
            catch {
                // Directory may still be busy or non-empty; leave it.
            }
            return;
        }
        throw lastError;
    }
}
async function unmountAllSshfs() {
    const paths = [...activeMounts.keys()];
    await Promise.all(paths.map((mountPath) => unmountSshfs(mountPath).catch((err) => {
        console.error('[ssh] unmount failed:', mountPath, err);
    })));
}
// Returns only mounts that pass a liveness probe; stale entries (sshfs died
// behind our back) are pruned + best-effort unmounted so callers naturally
// fall through to a fresh mount instead of reusing a dead path.
async function listActiveMounts() {
    const entries = [...activeMounts.entries()];
    const live = [];
    await Promise.all(entries.map(async ([mountPath, info]) => {
        if (await isMountPathAlive(mountPath)) {
            // Strip Windows-only process bookkeeping from the public list shape.
            live.push({
                mountPath,
                host: info.host,
                port: info.port,
                username: info.username,
                remotePath: info.remotePath,
            });
            return;
        }
        console.warn('[ssh] pruning stale mount:', mountPath);
        await pruneStaleMount(mountPath);
    }));
    return live;
}
function buildSshfsOptions(args, platform, errLogPath) {
    const options = [
        `port=${args.port || 22}`,
        'reconnect',
        'ServerAliveInterval=15',
        'ServerAliveCountMax=3',
        'ConnectTimeout=10',
        // Headless spawn: there is no tty to type a password/passphrase into, so
        // let ssh fail immediately (clear "Permission denied" in the error log)
        // instead of silently waiting on a prompt until the kill timer fires.
        'BatchMode=yes',
        // First-time hosts: BatchMode can't answer the host-key prompt either;
        // accept-new auto-trusts unknown hosts but still hard-fails when a known
        // host's key CHANGES (the MITM case).
        'StrictHostKeyChecking=accept-new',
    ];
    if (platform !== 'win32') {
        options.push('allow_other');
    }
    // Route the underlying ssh's own stderr to a readable log — sshfs daemon
    // mode swallows it, leaving only a useless generic disconnect line. Skip if
    // the path would break option parsing (comma splits the -o list, space
    // splits sshfs's ssh_command).
    if (errLogPath && !/[,\s]/.test(errLogPath)) {
        options.push(`ssh_command=ssh -E ${errLogPath}`);
    }
    if (args.privateKeyPath?.trim()) {
        // OpenSSH's `-o IdentityFile=…` config parser treats backslashes as escape
        // characters, so a Windows path like `D:\1devtool\key\id_ed25519` collapses
        // to `D:1devtoolkeyid_ed25519` ("no such identity"). Windows OpenSSH accepts
        // forward slashes, which avoids escape processing entirely.
        const keyPath = args.privateKeyPath.trim();
        const identityFile = platform === 'win32' ? keyPath.replace(/\\/g, '/') : keyPath;
        options.push(`IdentityFile=${identityFile}`, 'IdentitiesOnly=yes');
    }
    if (platform === 'darwin' && args.volumeLabel) {
        options.push(`volname=${sanitizeSegment(args.volumeLabel)}`);
    }
    return options;
}
// SFTP has no tilde expansion — `host:~` looks for a literal "~" entry inside
// the home directory (the connection dialog stores `~` for "home"). Relative
// paths already resolve against $HOME, so strip the tilde forms.
function normalizePosixRemotePath(remotePath) {
    const raw = (remotePath || '').trim();
    if (!raw || raw === '~' || raw === '.')
        return '.';
    if (raw.startsWith('~/'))
        return raw.slice(2).trim() || '.';
    return raw;
}
function buildSshfsCommand(sshfsBinaryPath, args, mountPath, options) {
    if (os_1.default.platform() !== 'win32') {
        const remote = `${args.username}@${args.host}:${normalizePosixRemotePath(args.remotePath)}`;
        return {
            binaryPath: sshfsBinaryPath,
            sshfsArgs: [remote, mountPath, '-o', options.join(',')],
        };
    }
    const sshfsWinBinary = findWindowsSshfsWinBinary(sshfsBinaryPath);
    if (!sshfsWinBinary) {
        throw new Error('SSHFS-Win is installed, but sshfs-win.exe was not found in its bin directory.');
    }
    const servicePrefix = buildWindowsServicePrefix(args);
    const drive = stripTrailingPathSeparator(mountPath);
    const sshfsArgs = ['svc', servicePrefix, drive, getWindowsLocalUserSpec()];
    if (options.length > 0) {
        sshfsArgs.push('-o', options.join(','));
    }
    return {
        binaryPath: sshfsWinBinary,
        sshfsArgs,
    };
}
function buildWindowsServicePrefix(args) {
    const remoteHost = `${args.username.trim()}@${args.host.trim()}${Number(args.port) && Number(args.port) !== 22 ? `!${Number(args.port)}` : ''}`;
    const { prefix, remoteSegments } = normalizeWindowsRemotePath(args.remotePath);
    const base = `\\${prefix}\\${remoteHost}`;
    return remoteSegments.length > 0 ? `${base}\\${remoteSegments.join('\\')}` : base;
}
function normalizeWindowsRemotePath(remotePath) {
    const raw = remotePath.trim();
    if (!raw || raw === '.' || raw === '~') {
        return { prefix: 'sshfs', remoteSegments: [] };
    }
    let normalized = raw.replace(/\\/g, '/');
    let prefix = 'sshfs';
    if (normalized === '/') {
        return { prefix: 'sshfs.r', remoteSegments: [] };
    }
    if (normalized.startsWith('~/')) {
        normalized = normalized.slice(2);
    }
    else if (normalized.startsWith('./')) {
        normalized = normalized.slice(2);
    }
    else if (normalized.startsWith('/')) {
        prefix = 'sshfs.r';
        normalized = normalized.slice(1);
    }
    return {
        prefix,
        remoteSegments: normalized.split('/').filter(Boolean),
    };
}
function findWindowsSshfsWinBinary(sshfsBinaryPath) {
    const candidates = [
        sshfsBinaryPath ? path_1.default.join(path_1.default.dirname(sshfsBinaryPath), 'sshfs-win.exe') : null,
        whichBinary('sshfs-win'),
        'C:\\Program Files\\SSHFS-Win\\bin\\sshfs-win.exe',
        'C:\\Program Files (x86)\\SSHFS-Win\\bin\\sshfs-win.exe',
    ].filter((candidate) => Boolean(candidate));
    for (const candidate of candidates) {
        try {
            if (fs_1.default.existsSync(candidate))
                return candidate;
        }
        catch {
            // ignore
        }
    }
    return null;
}
function getWindowsLocalUserSpec() {
    const username = process.env.USERNAME || os_1.default.userInfo().username || '';
    const domain = process.env.USERDOMAIN?.trim();
    if (domain && username) {
        return `${domain}\\${username}`;
    }
    return username;
}
function findAvailableWindowsMountDrive() {
    const claimedDrives = new Set([...activeMounts.keys()]
        .map((mountPath) => {
        const match = /^([A-Za-z]):[\\/]?/.exec(path_1.default.resolve(mountPath));
        return match?.[1]?.toUpperCase() || null;
    })
        .filter((drive) => Boolean(drive)));
    for (const letter of WINDOWS_MOUNT_DRIVE_LETTERS) {
        if (claimedDrives.has(letter))
            continue;
        if (windowsDriveBusySkip.has(letter))
            continue;
        const driveRoot = `${letter}:\\`;
        try {
            if (!fs_1.default.existsSync(driveRoot)) {
                return driveRoot;
            }
        }
        catch {
            // Access errors often mean a half-dead WinFsp letter — still try after free.
            return driveRoot;
        }
    }
    throw new Error('No available drive letters remain for SSHFS-Win mounts.');
}
function isPathWithin(basePath, targetPath) {
    const base = normalizeComparablePath(basePath);
    const target = normalizeComparablePath(targetPath);
    if (base === target)
        return true;
    const relative = path_1.default.relative(base, target);
    return relative !== '' && !relative.startsWith('..') && !path_1.default.isAbsolute(relative);
}
function normalizeComparablePath(inputPath) {
    const resolved = path_1.default.resolve(inputPath);
    const root = path_1.default.parse(resolved).root;
    let normalized = resolved;
    if (resolved !== root) {
        normalized = resolved.replace(/[\\/]+$/, '');
    }
    return os_1.default.platform() === 'win32' ? normalized.toLowerCase() : normalized;
}
function stripTrailingPathSeparator(value) {
    const stripped = value.replace(/[\\/]+$/, '');
    return stripped || value;
}
const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    '.cache',
    'Library',
    'Applications',
    '.npm',
    '.Trash',
    'Music',
    'Movies',
    'Pictures',
    'Public',
    '.vscode',
    '.idea',
]);
function getDefaultScanPath() {
    return path_1.default.join(os_1.default.homedir(), '.ssh');
}
function resolveScanPaths(extraPaths = []) {
    const normalized = [getDefaultScanPath()];
    const seen = new Set(normalized.map((p) => p.toLowerCase()));
    for (const raw of extraPaths) {
        const trimmed = raw?.trim();
        if (!trimmed)
            continue;
        const resolved = path_1.default.resolve(expandHome(trimmed));
        const key = resolved.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        normalized.push(resolved);
    }
    return normalized;
}
function registerSshIpcHandlers() {
    electron_1.ipcMain.handle('ssh:list-local-keys', async (_, args) => listLocalSSHKeys(args?.scanPaths));
    electron_1.ipcMain.handle('ssh:list-config-hosts', async (_, args) => listSSHConfigHosts(args?.scanPaths));
    electron_1.ipcMain.handle('ssh:discover-local', async (_, args) => discoverLocalSSH(args?.scanPaths));
    electron_1.ipcMain.handle('ssh:generate-key', async (_, args) => generateLocalSSHKey(args));
    electron_1.ipcMain.handle('ssh:check-sshfs', async () => checkSshfsAvailability());
    electron_1.ipcMain.handle('ssh:test-connection', async (_, args) => testSshConnection(args));
    electron_1.ipcMain.handle('ssh:list-remote-dirs', async (_, args) => listRemoteDirectories(args));
    electron_1.ipcMain.handle('ssh:mount', async (_, args) => mountSshfs(args));
    electron_1.ipcMain.handle('ssh:unmount', async (_, args) => unmountSshfs(args.mountPath));
    electron_1.ipcMain.handle('ssh:list-mounts', async () => listActiveMounts());
}
function discoverLocalSSH(extraPaths = []) {
    const scanPaths = resolveScanPaths(extraPaths);
    return {
        keys: listLocalSSHKeys(extraPaths, scanPaths),
        hosts: listSSHConfigHosts(extraPaths, scanPaths),
    };
}
function listLocalSSHKeys(extraPaths = [], resolvedPaths) {
    const scanPaths = resolvedPaths ?? resolveScanPaths(extraPaths);
    const foundPaths = new Set();
    const keys = [];
    for (const scanPath of scanPaths) {
        keys.push(...scanDirectoryForKeys(scanPath, foundPaths, 3));
    }
    return keys.sort((a, b) => {
        const aTime = a.createdAt ?? 0;
        const bTime = b.createdAt ?? 0;
        if (aTime !== bTime)
            return bTime - aTime;
        return a.name.localeCompare(b.name);
    });
}
function generateLocalSSHKey(args) {
    const keyName = args.name.trim();
    const folderName = (args.folderName?.trim() || '1devtool').replace(/[^A-Za-z0-9._-]/g, '-');
    const comment = args.comment?.trim() || '1devtool';
    if (!/^[A-Za-z0-9._-]+$/.test(keyName)) {
        throw new Error('Key name can only contain letters, numbers, dots, underscores, and dashes');
    }
    const sshDir = path_1.default.join(os_1.default.homedir(), '.ssh');
    const targetDir = path_1.default.join(sshDir, folderName);
    const targetPath = path_1.default.join(targetDir, keyName);
    const resolvedSshDir = path_1.default.resolve(sshDir);
    const resolvedTarget = path_1.default.resolve(targetPath);
    if (!resolvedTarget.startsWith(`${resolvedSshDir}${path_1.default.sep}`)) {
        throw new Error('SSH key must be created under ~/.ssh');
    }
    if (fs_1.default.existsSync(targetPath) || fs_1.default.existsSync(`${targetPath}.pub`)) {
        throw new Error('An SSH key with that name already exists');
    }
    fs_1.default.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    try {
        fs_1.default.chmodSync(targetDir, 0o700);
    }
    catch {
        // chmod is best-effort on non-POSIX filesystems.
    }
    (0, child_process_1.execFileSync)('ssh-keygen', ['-t', 'ed25519', '-f', targetPath, '-N', '', '-C', comment], {
        encoding: 'utf-8',
        timeout: 15000,
    });
    const key = extractKeyInfo(keyName, targetPath);
    if (!key) {
        throw new Error('SSH key was generated but could not be read');
    }
    return key;
}
function listSSHConfigHosts(extraPaths = [], resolvedPaths) {
    const scanPaths = resolvedPaths ?? resolveScanPaths(extraPaths);
    const hosts = [];
    for (const scanPath of scanPaths) {
        const configPath = path_1.default.join(scanPath, 'config');
        let content = '';
        try {
            content = fs_1.default.readFileSync(configPath, 'utf-8');
        }
        catch {
            continue;
        }
        hosts.push(...parseSSHConfig(content));
    }
    return dedupeHosts(hosts);
}
function parseSSHConfig(content) {
    const hosts = [];
    let aliases = [];
    let options = {};
    const flush = () => {
        if (aliases.length === 0)
            return;
        for (const alias of aliases) {
            if (isWildcardHost(alias))
                continue;
            const host = options.hostname || alias;
            const port = parsePort(options.port);
            const username = options.user || os_1.default.userInfo().username || '';
            hosts.push({
                alias,
                host,
                port,
                username,
                identityFile: options.identityfile ? expandHome(options.identityfile) : undefined,
            });
        }
    };
    for (const rawLine of content.split(/\r?\n/)) {
        const line = stripSshConfigComment(rawLine).trim();
        if (!line)
            continue;
        const match = line.match(/^(\S+)\s+(.+)$/);
        if (!match)
            continue;
        const key = match[1].toLowerCase();
        const value = unquoteSshConfigValue(match[2].trim());
        if (key === 'host') {
            flush();
            aliases = value.split(/\s+/).filter(Boolean);
            options = {};
            continue;
        }
        if (aliases.length === 0)
            continue;
        if (!(key in options)) {
            options[key] = value;
        }
    }
    flush();
    return hosts;
}
function scanDirectoryForKeys(dirPath, foundPaths, maxDepth, currentDepth = 0) {
    if (currentDepth > maxDepth)
        return [];
    let entries = [];
    try {
        entries = fs_1.default.readdirSync(dirPath, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const keys = [];
    for (const entry of entries) {
        const fullPath = path_1.default.join(dirPath, entry.name);
        if (foundPaths.has(fullPath))
            continue;
        if (entry.isDirectory()) {
            if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name))
                continue;
            keys.push(...scanDirectoryForKeys(fullPath, foundPaths, maxDepth, currentDepth + 1));
            continue;
        }
        if (!entry.isFile() || !isPotentialPrivateKey(entry.name, fullPath)) {
            continue;
        }
        const key = extractKeyInfo(entry.name, fullPath);
        if (key) {
            foundPaths.add(key.path);
            keys.push(key);
        }
    }
    return keys;
}
function isPotentialPrivateKey(filename, fullPath) {
    if (filename.endsWith('.pub') ||
        filename.endsWith('.cfg') ||
        filename.endsWith('.conf') ||
        filename.endsWith('.txt') ||
        filename.endsWith('.md') ||
        filename.endsWith('.json') ||
        filename === 'known_hosts' ||
        filename === 'known_hosts.old' ||
        filename === 'config' ||
        filename === 'authorized_keys' ||
        filename.startsWith('.')) {
        return false;
    }
    try {
        const stats = fs_1.default.statSync(fullPath);
        return stats.isFile() && stats.size > 0 && stats.size <= 64 * 1024;
    }
    catch {
        return false;
    }
}
function extractKeyInfo(filename, fullPath) {
    try {
        const keyContent = fs_1.default.readFileSync(fullPath, 'utf-8');
        if (!/PRIVATE KEY/.test(keyContent))
            return null;
        let fingerprint;
        try {
            const output = (0, child_process_1.execFileSync)('ssh-keygen', ['-lf', fullPath], {
                encoding: 'utf-8',
                timeout: 3000,
            });
            fingerprint = output.trim().split(/\s+/)[1];
        }
        catch {
            // Fingerprint generation is best-effort.
        }
        let createdAt;
        try {
            createdAt = fs_1.default.statSync(fullPath).mtimeMs;
        }
        catch {
            // File stat is best-effort.
        }
        return {
            name: filename,
            path: fullPath,
            fingerprint,
            createdAt,
        };
    }
    catch {
        return null;
    }
}
function parsePort(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
        return 22;
    return parsed;
}
function expandHome(value) {
    if (value === '~')
        return os_1.default.homedir();
    if (value.startsWith('~/'))
        return path_1.default.join(os_1.default.homedir(), value.slice(2));
    return value;
}
function isWildcardHost(alias) {
    return /[*?![\]]/.test(alias);
}
function stripSshConfigComment(value) {
    let quote = null;
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if ((char === '"' || char === "'") && value[index - 1] !== '\\') {
            quote = quote === char ? null : quote || char;
        }
        if (char === '#' && !quote) {
            return value.slice(0, index);
        }
    }
    return value;
}
function unquoteSshConfigValue(value) {
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}
function dedupeHosts(hosts) {
    const seen = new Set();
    const result = [];
    for (const host of hosts) {
        const key = host.alias.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        result.push(host);
    }
    return result;
}
