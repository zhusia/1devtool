"use strict";
/**
 * Installs Codex's single `notify` command without discarding a user's
 * existing notifier. A small Node fan-out wrapper calls the prior command and
 * 1DevTool's capability-aware hook producer with the same JSON payload.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WRAPPER_REENTRY_ENV = void 0;
exports.ensureCodexOrchestrationNotify = ensureCodexOrchestrationNotify;
exports.diagnoseCodexNotifyChain = diagnoseCodexNotifyChain;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
/** Filename the cycle guards match on. It contains no path separator, so it
 *  survives JSON/argv escaping when a foreign wrapper embeds our command. */
const WRAPPER_BASENAME = 'codex-notify.cjs';
/** Set on the previousNotify child (and inherited by its descendants). If the
 *  wrapper starts with it already present, a chained notifier re-invoked us —
 *  the chain root already ran the shim, so re-entry exits immediately. */
exports.WRAPPER_REENTRY_ENV = 'ONEDEVTOOL_CODEX_NOTIFY_ACTIVE';
const WRAPPER_SOURCE = String.raw `#!/usr/bin/env node
if (process.env.ONEDEVTOOL_CODEX_NOTIFY_ACTIVE === '1') process.exit(0);
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');
let config;
try { config = JSON.parse(fs.readFileSync(path.join(__dirname, 'codex-notify.json'), 'utf8')); }
catch { process.exit(0); }
const payload = process.argv[2] || '{}';
function run(command, args, env) {
  if (!command) return Promise.resolve();
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, {
        stdio: 'ignore', windowsHide: true,
        ...(env ? { env } : {}),
        shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command),
      });
    } catch { resolve(); return; }
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 8000);
    child.once('error', () => { clearTimeout(timer); resolve(); });
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
}
const tasks = [];
if (Array.isArray(config.previousNotify) && config.previousNotify.length) {
  tasks.push(run(config.previousNotify[0], [...config.previousNotify.slice(1), payload],
    { ...process.env, ONEDEVTOOL_CODEX_NOTIFY_ACTIVE: '1' }));
}
tasks.push(run(config.shimPath, ['hook-event', '--event=done', '--payload-argv', payload]));
Promise.allSettled(tasks).then(() => process.exit(0));
`;
function parseNotifyArray(raw) {
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string') ? parsed : null;
    }
    catch {
        return null;
    }
}
// A top-level TOML key must appear before the first table. Restrict matching
// to a one-line string array; unfamiliar TOML is preserved untouched.
function matchNotifyLine(source) {
    const rootEnd = source.search(/^\s*\[/m);
    const root = rootEnd >= 0 ? source.slice(0, rootEnd) : source;
    return root.match(/^[ \t]*notify[ \t]*=[ \t]*(\[[^\r\n]*\])[ \t]*(?:#.*)?$/m);
}
function atomicWrite(target, content, mode) {
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    node_fs_1.default.writeFileSync(tmp, content, { encoding: 'utf-8', ...(mode !== undefined ? { mode } : {}) });
    node_fs_1.default.renameSync(tmp, target);
}
function ensureCodexOrchestrationNotify(shimPath, nodeBinaryPath, homeDir = node_os_1.default.homedir()) {
    const configPath = node_path_1.default.join(homeDir, '.codex', 'config.toml');
    const hookDir = node_path_1.default.join(homeDir, '.1devtool', 'orchestration', 'native-hooks');
    const wrapperPath = node_path_1.default.join(hookDir, 'codex-notify.cjs');
    const statePath = node_path_1.default.join(hookDir, 'codex-notify.json');
    try {
        let source = '';
        let existed = false;
        try {
            source = node_fs_1.default.readFileSync(configPath, 'utf-8');
            existed = true;
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
        const match = matchNotifyLine(source);
        const current = match ? parseNotifyArray(match[1]) : [];
        if (match && !current) {
            return { status: 'skipped-unsafe', path: configPath, error: 'Existing Codex notify is not a simple string array' };
        }
        const desired = [nodeBinaryPath, wrapperPath];
        let previousNotify = current;
        if (current && current.length === desired.length && current.every((value, index) => value === desired[index])) {
            try {
                const priorState = JSON.parse(node_fs_1.default.readFileSync(statePath, 'utf-8'));
                previousNotify = Array.isArray(priorState.previousNotify) ? priorState.previousNotify : [];
            }
            catch {
                previousNotify = [];
            }
        }
        // Cycle guard: never chain to a command that (transitively) re-invokes
        // this wrapper. Codex Computer Use bakes the prior notify argv into its
        // own `--previous-notify` argument, so re-capturing a foreign wrapper
        // that embedded us created an immortal notify→notify spawn ring
        // (docs/engineering/performance/codex-notify-chain-storm.md). Running
        // this after both branches also heals already-poisoned state files.
        if (previousNotify && previousNotify.some((value) => value.includes(WRAPPER_BASENAME))) {
            previousNotify = [];
        }
        const nextState = JSON.stringify({ version: 1, shimPath, previousNotify }, null, 2) + '\n';
        const desiredLine = `notify = ${JSON.stringify(desired)}`;
        const nextSource = match
            ? source.replace(match[0], desiredLine)
            : `${desiredLine}\n${source}`;
        const unchanged = source === nextSource &&
            node_fs_1.default.existsSync(wrapperPath) && node_fs_1.default.readFileSync(wrapperPath, 'utf-8') === WRAPPER_SOURCE &&
            node_fs_1.default.existsSync(statePath) && node_fs_1.default.readFileSync(statePath, 'utf-8') === nextState;
        if (unchanged)
            return { status: 'skipped-unchanged', path: configPath };
        node_fs_1.default.mkdirSync(hookDir, { recursive: true, mode: 0o700 });
        atomicWrite(wrapperPath, WRAPPER_SOURCE, 0o700);
        atomicWrite(statePath, nextState, 0o600);
        let writeTarget = configPath;
        let mode;
        if (existed) {
            try {
                writeTarget = node_fs_1.default.realpathSync(configPath);
            }
            catch { /* direct path */ }
            try {
                mode = node_fs_1.default.statSync(writeTarget).mode & 0o777;
            }
            catch { /* default */ }
        }
        atomicWrite(writeTarget, nextSource, mode);
        return { status: 'wrote', path: configPath };
    }
    catch (error) {
        return { status: 'error', path: configPath, error: error instanceof Error ? error.message : String(error) };
    }
}
/** Read-only view of the Codex notify chain for the Settings doctor. A
 *  `cycle` verdict means the state file predates the install-time guard —
 *  re-running the install coordinator (Settings → Reinstall) heals it. */
function diagnoseCodexNotifyChain(homeDir = node_os_1.default.homedir()) {
    const configPath = node_path_1.default.join(homeDir, '.codex', 'config.toml');
    const statePath = node_path_1.default.join(homeDir, '.1devtool', 'orchestration', 'native-hooks', 'codex-notify.json');
    try {
        let source = '';
        try {
            source = node_fs_1.default.readFileSync(configPath, 'utf-8');
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
        const match = matchNotifyLine(source);
        const notify = match ? parseNotifyArray(match[1]) : null;
        if (match && !notify)
            return { status: 'unsafe', notify: null, previousNotify: [] };
        if (!notify || notify.length === 0)
            return { status: 'not-installed', notify: null, previousNotify: [] };
        let previousNotify = [];
        try {
            const state = JSON.parse(node_fs_1.default.readFileSync(statePath, 'utf-8'));
            if (Array.isArray(state.previousNotify))
                previousNotify = state.previousNotify;
        }
        catch { /* no state — fall through with [] */ }
        const referencesWrapper = (values) => values.some((value) => value.includes(WRAPPER_BASENAME));
        if (!referencesWrapper(notify))
            return { status: 'foreign', notify, previousNotify };
        if (referencesWrapper(previousNotify))
            return { status: 'cycle', notify, previousNotify };
        return { status: previousNotify.length ? 'ok-chained' : 'ok', notify, previousNotify };
    }
    catch (error) {
        return {
            status: 'error', notify: null, previousNotify: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
