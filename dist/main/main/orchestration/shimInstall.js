"use strict";
/**
 * Computes the absolute path to the `1devtool-agent` shim and writes it on
 * app boot. The shim is a thin shell/cmd wrapper that exec's the bundled CJS
 * CLI through a resolved Node binary (mirrors the MCP server bundle strategy
 * in `scripts/bundle-mcp-server.mjs`).
 *
 * Skill files embed this absolute path so orchestration works regardless of
 * the user's $PATH. See Phase 1.3 of using_skills_plan.md.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ORCHESTRATOR_SHIM_GENERATION = void 0;
exports.getOrchestratorShimPath = getOrchestratorShimPath;
exports.getLegacyOrchestratorShimPath = getLegacyOrchestratorShimPath;
exports.getOnedevtoolShimPath = getOnedevtoolShimPath;
exports.installOrchestratorShim = installOrchestratorShim;
exports.getCliRegistryCachePath = getCliRegistryCachePath;
exports.writeCliRegistryCache = writeCliRegistryCache;
const electron_1 = require("electron");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const orchestrationShim_1 = require("../../shared/orchestrationShim");
var orchestrationShim_2 = require("../../shared/orchestrationShim");
Object.defineProperty(exports, "ORCHESTRATOR_SHIM_GENERATION", { enumerable: true, get: function () { return orchestrationShim_2.ORCHESTRATOR_SHIM_GENERATION; } });
const SHIM_DIR_REL = path_1.default.join('.1devtool', 'bin');
/**
 * Skills and renderer-generated Team/Swarm commands must never target the
 * mutable, unversioned compatibility shim. An older packaged app can reclaim
 * that path after a newer dev build writes its skill, leaving new skill prose
 * wired to an old CLI (for example, `team start` becomes an unknown command).
 *
 * Bump this generation whenever the CLI/skill command contract changes. Old
 * apps do not know this filename, so they cannot silently retarget it.
 */
const LEGACY_SHIM_NAME_UNIX = '1devtool-agent';
const LEGACY_SHIM_NAME_WIN = '1devtool-agent.cmd';
const ONEDEVTOOL_SHIM_NAME_UNIX = 'onedevtool';
const ONEDEVTOOL_SHIM_NAME_WIN = 'onedevtool.cmd';
/** Absolute path to the generation-pinned shim embedded in skills and nudges.
 *  Pure function of homedir + platform. Uses os.homedir() (honors $HOME) — NOT
 *  app.getPath('home'), which ignores an env override on macOS: the standalone
 *  CLI resolves everything under os.homedir(), so the shim/skill writer must
 *  agree with it (and e2e tests must be able to sandbox writes via a temp HOME). */
function getOrchestratorShimPath() {
    const home = os_1.default.homedir();
    const name = process.platform === 'win32' ? orchestrationShim_1.ORCHESTRATOR_SHIM_NAME_WIN : orchestrationShim_1.ORCHESTRATOR_SHIM_NAME_UNIX;
    return path_1.default.join(home, SHIM_DIR_REL, name);
}
/** Public compatibility command for users who already put ~/.1devtool/bin on
 *  PATH. Skills intentionally do not embed this mutable cross-version path. */
function getLegacyOrchestratorShimPath() {
    const home = os_1.default.homedir();
    const name = process.platform === 'win32' ? LEGACY_SHIM_NAME_WIN : LEGACY_SHIM_NAME_UNIX;
    return path_1.default.join(home, SHIM_DIR_REL, name);
}
/** Stable power-user CLI entry point. It executes the same self-contained
 * bundle as 1devtool-agent; terminal attach remains unavailable until the
 * explicit local-attach preference starts its app-lifetime socket. */
function getOnedevtoolShimPath() {
    const name = process.platform === 'win32' ? ONEDEVTOOL_SHIM_NAME_WIN : ONEDEVTOOL_SHIM_NAME_UNIX;
    return path_1.default.join(os_1.default.homedir(), SHIM_DIR_REL, name);
}
/**
 * Absolute path to the CLI JS that the shim invokes.
 *
 * Packaged: the bundled CJS at `dist/cli/1devtool-agent.cjs` (asar-unpacked).
 * Dev:      prefer the bundled CJS if it exists (i.e. `npm run build:main` ran),
 *           otherwise fall back to the un-bundled tsc output at
 *           `dist/main/cli/agent.js`, which works in dev because the project's
 *           own `node_modules` is reachable. Without this fallback, `npm run dev`
 *           leaves the shim pointing at a path that doesn't exist until the
 *           user runs the bundle step manually.
 */
function getBundledCliPath() {
    const bundled = path_1.default.join('dist', 'cli', '1devtool-agent.cjs');
    if (electron_1.app.isPackaged) {
        return path_1.default.join(process.resourcesPath, 'app.asar.unpacked', bundled);
    }
    // `app.getAppPath()` is the repository root during a normal `electron .`
    // dev launch, but Electron's Playwright launcher executes the compiled main
    // entry directly and reports its directory (`dist/main/main`) instead. Do
    // not append another `dist/` blindly: the generated shim would point at
    // `dist/main/main/dist/...` and every interactive delegation would fail
    // before reaching the desktop bridge. Walk upward from both stable runtime
    // anchors and prefer the self-contained bundle wherever it is found.
    const relativeCandidates = [
        bundled,
        // Dev fallback: tsc compiles `src/cli/agent.ts` here when the standalone
        // bundle has not been built yet.
        path_1.default.join('dist', 'main', 'cli', 'agent.js'),
    ];
    const roots = [electron_1.app.getAppPath(), __dirname];
    for (const relativePath of relativeCandidates) {
        for (const start of roots) {
            let current = path_1.default.resolve(start);
            for (let depth = 0; depth < 8; depth++) {
                const candidate = path_1.default.join(current, relativePath);
                if (fs_1.default.existsSync(candidate))
                    return candidate;
                const parent = path_1.default.dirname(current);
                if (parent === current)
                    break;
                current = parent;
            }
        }
    }
    // Preserve a deterministic path in the error case so a broken/incomplete
    // dev build yields a useful module-not-found location in terminal output.
    return path_1.default.join(electron_1.app.getAppPath(), 'dist', 'main', 'cli', 'agent.js');
}
/**
 * Install a shim under `~/.1devtool/bin` (`.cmd` on Windows).
 * Idempotent — only rewrites when target content differs from current.
 * Failures are non-fatal: returned in the result envelope.
 *
 * Each shim path is GLOBAL across the installed app, other app instances, and
 * dev checkouts. Generation pinning separates incompatible CLI contracts, but
 * the installed (packaged) app still owns its generation and points it at the
 * stable asar-unpacked bundle. A dev build points at this project's ephemeral
 * `dist/`, so it must not clobber the same generation owned by the packaged app
 * (or another tree). Set `ONEDEVTOOL_DEV_OWN_SHIM=1` to force the dev build to
 * own the shim while actively developing orchestration.
 */
/**
 * Runtime + CLI script the shim should exec.
 *
 * Packaged installs run the CLI with the APP'S OWN binary as Node
 * (ELECTRON_RUN_AS_NODE), mirroring the MCP server runtime strategy —
 * orchestration must not depend on a user-managed Node install; a machine
 * with no `node` on PATH used to have a dead shim and therefore zero
 * agent-side verbs. Dev keeps the resolved user Node: the electron binary in
 * node_modules is per-checkout and the dev-preserve guard already reasons
 * about the CLI path, not the runtime.
 *
 * Linux AppImage additionally needs BOTH halves stable: the squashfs mount
 * (`/tmp/.mount_XXXX`) changes every launch and vanishes on quit, so a shim
 * pointing into it dies the moment the app closes — and headless
 * `run --to=<agent>` is designed to work app-less. `$APPIMAGE` is the stable
 * runtime (same trick as `getMcpRuntimeCommand`), and the CLI bundle is
 * copied to a stable per-generation home under `~/.1devtool/bin`.
 */
function resolveShimTarget(nodeBinaryPath) {
    if (!electron_1.app.isPackaged) {
        return { runtime: nodeBinaryPath, cliPath: getBundledCliPath(), runAsNode: false };
    }
    if (process.platform === 'linux' && process.env.APPIMAGE) {
        return { runtime: process.env.APPIMAGE, cliPath: ensureStableCliCopy(), runAsNode: true };
    }
    return { runtime: process.execPath, cliPath: getBundledCliPath(), runAsNode: true };
}
/** Copy the bundled CLI to a stable per-generation path (AppImage only).
 *  Byte-compared and atomically replaced; falls back to the mount path on
 *  failure, where the boot-time reinstall self-heals the next launch. */
function ensureStableCliCopy() {
    const stablePath = path_1.default.join(os_1.default.homedir(), SHIM_DIR_REL, `1devtool-agent-cli-v${orchestrationShim_1.ORCHESTRATOR_SHIM_GENERATION}.cjs`);
    try {
        const bytes = fs_1.default.readFileSync(getBundledCliPath());
        let existing = null;
        try {
            existing = fs_1.default.readFileSync(stablePath);
        }
        catch {
            existing = null;
        }
        if (!existing || !existing.equals(bytes)) {
            fs_1.default.mkdirSync(path_1.default.dirname(stablePath), { recursive: true });
            const tmp = `${stablePath}.${process.pid}.tmp`;
            fs_1.default.writeFileSync(tmp, bytes);
            fs_1.default.renameSync(tmp, stablePath);
        }
        return stablePath;
    }
    catch {
        return getBundledCliPath();
    }
}
function installShim(shimPath, target, options) {
    const content = (0, orchestrationShim_1.buildOrchestratorShimContent)(target, process.platform === 'win32');
    const cliPath = target.cliPath;
    const devOwnShim = process.env.ONEDEVTOOL_DEV_OWN_SHIM === '1';
    if (!electron_1.app.isPackaged && !devOwnShim && !options.force && fs_1.default.existsSync(shimPath)) {
        try {
            const existing = fs_1.default.readFileSync(shimPath, 'utf-8');
            // Preserve only when the shim points somewhere OTHER than this dev tree's
            // CLI (i.e. the installed app, or a different checkout). If it already
            // points here, fall through to the idempotent refresh below.
            if (!existing.includes(cliPath)) {
                return { shimPath, status: 'skipped-dev-preserve' };
            }
        }
        catch { /* unreadable — fall through and (re)write */ }
    }
    try {
        fs_1.default.mkdirSync(path_1.default.dirname(shimPath), { recursive: true });
        if (fs_1.default.existsSync(shimPath)) {
            try {
                const existing = fs_1.default.readFileSync(shimPath, 'utf-8');
                if (existing === content) {
                    // Still ensure exec bit on POSIX, even on a "skip" — file mode can drift.
                    if (process.platform !== 'win32') {
                        try {
                            fs_1.default.chmodSync(shimPath, 0o755);
                        }
                        catch { /* noop */ }
                    }
                    return { shimPath, status: 'skipped-unchanged' };
                }
            }
            catch { /* fall through to write */ }
        }
        fs_1.default.writeFileSync(shimPath, content, 'utf-8');
        if (process.platform !== 'win32') {
            try {
                fs_1.default.chmodSync(shimPath, 0o755);
            }
            catch { /* noop */ }
        }
        return { shimPath, status: 'wrote' };
    }
    catch (error) {
        return {
            shimPath,
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
function installOrchestratorShim(nodeBinaryPath, options = {}) {
    const target = resolveShimTarget(nodeBinaryPath);
    const result = installShim(getOrchestratorShimPath(), target, options);
    // Keep the original public command working for PATH users. It is
    // deliberately best-effort: the generation-pinned result above is the one
    // returned to the install coordinator and embedded in skills. In dev, the
    // existing preserve guard prevents this compatibility alias from stealing
    // ownership from the installed app.
    const legacyResult = installShim(getLegacyOrchestratorShimPath(), target, options);
    if (legacyResult.status === 'error') {
        console.warn('[orchestration] legacy CLI shim install failed:', legacyResult.error);
    }
    const onedevtoolResult = installShim(getOnedevtoolShimPath(), target, options);
    if (onedevtoolResult.status === 'error') {
        console.warn('[orchestration] onedevtool CLI shim install failed:', onedevtoolResult.error);
    }
    return result;
}
/** Path to the CLI registry cache that the standalone CLI reads. */
function getCliRegistryCachePath() {
    return path_1.default.join(os_1.default.homedir(), '.1devtool', 'state', 'cli-registry.json');
}
/**
 * Write the CliRegistry snapshot to a cache file the standalone CLI can read.
 * Idempotent + best-effort; never throws. Called whenever the registry
 * rescan completes.
 */
function writeCliRegistryCache(snapshot) {
    try {
        const cachePath = getCliRegistryCachePath();
        fs_1.default.mkdirSync(path_1.default.dirname(cachePath), { recursive: true });
        const payload = {
            writtenAt: Date.now(),
            writtenBy: '1devtool-electron',
            knownClis: snapshot.knownClis,
            registrations: snapshot.registrations,
        };
        fs_1.default.writeFileSync(cachePath, JSON.stringify(payload), 'utf-8');
    }
    catch {
        // best-effort
    }
}
