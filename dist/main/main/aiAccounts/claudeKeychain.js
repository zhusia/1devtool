"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readClaudeKeychain = readClaudeKeychain;
exports.writeClaudeKeychain = writeClaudeKeychain;
const child_process_1 = require("child_process");
const CLAUDE_SERVICE = 'Claude Code-credentials';
function run(args) {
    return new Promise((resolve) => {
        (0, child_process_1.execFile)('security', args, { maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
            resolve({
                stdout: stdout ?? '',
                stderr: stderr ?? '',
                code: err && typeof err.code === 'number'
                    ? Number(err.code)
                    : err
                        ? 1
                        : 0,
            });
        });
    });
}
function requireDarwin() {
    if (process.platform !== 'darwin') {
        throw new Error('Claude Keychain access is only available on macOS');
    }
}
async function readClaudeKeychain(account) {
    requireDarwin();
    const res = await run(['find-generic-password', '-s', CLAUDE_SERVICE, '-a', account, '-w']);
    if (res.code !== 0)
        return null;
    return res.stdout.replace(/\n$/, '');
}
async function writeClaudeKeychain(account, value) {
    requireDarwin();
    const res = await run([
        'add-generic-password',
        '-s',
        CLAUDE_SERVICE,
        '-a',
        account,
        '-w',
        value,
        '-U',
    ]);
    if (res.code !== 0) {
        throw new Error(`security add-generic-password failed: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
}
