"use strict";
/**
 * Bounded, timeout-safe, progressive CLI scanner.
 * See docs/features/channels/cli-subprocess.md §3.6.3 and §3.6.4.
 *
 * Hard invariants:
 *   - No single --version call may exceed PER_VERSION_TIMEOUT_MS (1500ms).
 *   - No single CLI scan may exceed PER_CLI_TIMEOUT_MS (2000ms).
 *   - Bulk scan stops at GLOBAL_TIMEOUT_FIRST_MS / RESCAN_MS.
 *   - At most MAX_CONCURRENT_SPAWNS in flight at once.
 *   - One hang isolated by AbortSignal.timeout + SIGKILL fallback.
 *   - Slow PATH entries accumulate strikes (TWO_STRIKES_QUARANTINE).
 *   - Partial results are always persisted; never fail the whole scan because one CLI hung.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.VERSION_CACHE_TTL_MS = exports.MAX_CONCURRENT_SPAWNS = exports.PATH_STAT_TIMEOUT_MS = exports.PER_VERSION_TIMEOUT_MS = exports.PER_CLI_TIMEOUT_MS = exports.GLOBAL_TIMEOUT_RESCAN_MS = exports.GLOBAL_TIMEOUT_FIRST_MS = void 0;
exports.buildBinaryLookupSpecs = buildBinaryLookupSpecs;
exports.normalizeWindowsCandidates = normalizeWindowsCandidates;
exports.buildVersionSpawnSpec = buildVersionSpawnSpec;
exports.scanOneCli = scanOneCli;
exports.scanAll = scanAll;
exports.scanOneById = scanOneById;
const child_process_1 = require("child_process");
const promises_1 = __importDefault(require("fs/promises"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const util_1 = require("util");
const env_1 = require("../utils/env");
const spawnSpec_1 = require("../utils/spawnSpec");
const sleep = (0, util_1.promisify)(setTimeout);
exports.GLOBAL_TIMEOUT_FIRST_MS = 8_000;
exports.GLOBAL_TIMEOUT_RESCAN_MS = 4_000;
exports.PER_CLI_TIMEOUT_MS = 2_000;
exports.PER_VERSION_TIMEOUT_MS = 1_500;
exports.PATH_STAT_TIMEOUT_MS = 500;
exports.MAX_CONCURRENT_SPAWNS = 6;
exports.VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Normalize `--version` output to a compact label (first non-empty line, trimmed). */
function parseVersion(raw) {
    const line = raw
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s.length > 0);
    if (!line)
        return null;
    // Try to extract semver-ish if present
    const m = line.match(/\b\d+(?:\.\d+){1,3}(?:[-_+][A-Za-z0-9.]+)?\b/);
    return m ? m[0] : line.slice(0, 64);
}
function nowMs() {
    return Date.now();
}
/**
 * Resolve all binary locations for a single CLI by running `where.exe <bin>` on
 * Windows or `command -v <bin>` (via /bin/sh) on POSIX. Windows `where.exe`
 * accepts multiple patterns, so all aliases for one CLI share one process
 * instead of paying a process launch for every `.exe` / `.cmd` spelling.
 */
function buildBinaryLookupSpecs(binaries, isWin = process.platform === 'win32') {
    if (isWin) {
        return binaries.length > 0
            ? [{ file: 'where.exe', args: binaries, windowsHide: true }]
            : [];
    }
    return binaries.map((bin) => ({
        file: '/bin/sh',
        args: ['-c', `command -v ${shellEscape(bin)} 2>/dev/null`],
    }));
}
async function resolveBinaryPaths(binaries, env, signal) {
    const out = new Set();
    const lookupSpecs = buildBinaryLookupSpecs(binaries);
    for (const spec of lookupSpecs) {
        if (signal.aborted)
            break;
        try {
            const found = await new Promise((resolve) => {
                const proc = (0, child_process_1.spawn)(spec.file, spec.args, { env, windowsHide: spec.windowsHide });
                // Kill on abort or timeout.
                const t = setTimeout(() => {
                    try {
                        proc.kill('SIGKILL');
                    }
                    catch { /* noop */ }
                }, exports.PER_VERSION_TIMEOUT_MS);
                signal.addEventListener('abort', () => { try {
                    proc.kill('SIGKILL');
                }
                catch { /* noop */ } }, { once: true });
                let stdout = '';
                proc.stdout?.on('data', (d) => { stdout += d.toString(); });
                proc.on('error', () => { clearTimeout(t); resolve([]); });
                proc.on('close', () => {
                    clearTimeout(t);
                    const lines = stdout
                        .split(/\r?\n/)
                        .map((s) => s.trim())
                        .filter((s) => s.length > 0);
                    resolve(lines);
                });
            });
            for (const p of found)
                out.add(p);
        }
        catch {
            // ignore individual binary lookup failures; we still try others
        }
    }
    return Array.from(out);
}
function shellEscape(s) {
    // command -v target: only safe characters expected (binary names).
    return s.replace(/[^A-Za-z0-9._\-]/g, '');
}
/**
 * Rank a Windows candidate by how directly it can be spawned:
 * real executables, then cmd/bat shims (runnable via cmd.exe), then ps1,
 * then extension-less files (the POSIX sh scripts npm writes alongside its
 * shims — not executable on Windows at all).
 */
function windowsExecRank(p) {
    const ext = path_1.default.win32.extname(p).toLowerCase();
    if (ext === '.exe' || ext === '.com')
        return 0;
    if (ext === '.cmd' || ext === '.bat')
        return 1;
    if (ext === '.ps1')
        return 2;
    return 3;
}
/**
 * Collapse npm-style sibling shims into one candidate per install. On Windows
 * `where.exe claude` returns `claude` (sh script), `claude.cmd` and
 * `claude.ps1` from the same directory — one install, three files, of which
 * only the .cmd/.exe is actually runnable. Keying by dir + basename-sans-ext
 * keeps a single best-ranked path per install (so a lone npm install reads
 * `detected`, not `ambiguous`) while genuinely distinct installs in different
 * directories remain separate. POSIX paths pass through untouched.
 */
function normalizeWindowsCandidates(paths, isWin = process.platform === 'win32') {
    if (!isWin || paths.length <= 1)
        return paths;
    const best = new Map();
    const order = [];
    for (const p of paths) {
        const ext = path_1.default.win32.extname(p);
        const key = `${path_1.default.win32.dirname(p)}\\${path_1.default.win32.basename(p, ext)}`.toLowerCase();
        const existing = best.get(key);
        if (existing === undefined) {
            best.set(key, p);
            order.push(key);
        }
        else if (windowsExecRank(p) < windowsExecRank(existing)) {
            best.set(key, p);
        }
    }
    return order.map((k) => best.get(k));
}
/**
 * Collapse aliases of the SAME install into one candidate.
 *
 * A CLI that answers to more than one name resolves to more than one path in
 * PATH while being a single installation — Cursor ships `agent` (primary) and
 * `cursor-agent` (legacy). Left alone, `candidates.length > 1` would mark that
 * install `ambiguous`, and `getCliBinary` refuses ambiguous CLIs, so
 * orchestration would lose an agent that is perfectly installed.
 *
 * Two keys, because the aliases are not made the same way on every platform:
 *   - **realpath** — POSIX installers symlink both names onto one executable.
 *   - **directory** — the Windows installer `Copy-Item`s `cursor-agent.exe` to
 *     `agent.exe`, so realpath sees two distinct real files. Two spellings of
 *     one CLI sitting in one directory is a single install by construction;
 *     it is never the competing-installs case `ambiguous` exists to flag
 *     (different install locations still stay separate, as they should).
 *
 * The first spelling wins in both cases — registry `binaries` order decides
 * which, keeping `selectedPath` stable across upgrades.
 *
 * Returns the deduped list plus each survivor's resolved real path, which the
 * identity check below reuses instead of paying a second realpath.
 */
async function dedupeAliasedInstalls(paths) {
    const realPaths = new Map();
    if (paths.length === 0)
        return { candidates: paths, realPaths };
    const isWin = process.platform === 'win32';
    const fold = (value) => (isWin ? value.toLowerCase() : value);
    const seenReal = new Set();
    const seenDir = new Set();
    const candidates = [];
    for (const p of paths) {
        let real = p;
        try {
            real = await promises_1.default.realpath(p);
        }
        catch {
            // Broken symlink or permission error — treat the literal path as its own
            // identity rather than dropping a candidate we might still be able to run.
        }
        realPaths.set(p, real);
        // Directory of the RESOLVED file: a `~/.local/bin` symlink and a
        // `/opt/homebrew/bin` symlink onto one store entry are one install, and
        // two genuinely separate installs resolve into their own store dirs.
        const dirKey = fold(path_1.default.dirname(real));
        if (seenReal.has(fold(real)) || seenDir.has(dirKey))
            continue;
        seenReal.add(fold(real));
        seenDir.add(dirKey);
        candidates.push(p);
    }
    return { candidates, realPaths };
}
/**
 * Does this candidate carry a binary name that other vendors also ship?
 * Compared on the basename minus extension so `agent`, `agent.exe` and
 * `agent.cmd` are all the same shared spelling.
 */
function hasSharedBinaryName(candidate, sharedBinaries) {
    if (sharedBinaries.length === 0)
        return false;
    const base = path_1.default.basename(candidate).toLowerCase();
    const stem = base.replace(/\.(exe|com|cmd|bat|ps1)$/, '');
    return sharedBinaries.some((name) => {
        const shared = name.toLowerCase();
        return stem === shared || base === shared;
    });
}
/**
 * Prove that a shared-name candidate really is the CLI we think it is.
 *
 * `agent` is Cursor's documented command, but xAI's Grok CLI installs an
 * `agent` of its own — whichever PATH entry comes first wins the lookup, and
 * spawning a stranger as `--to=cursor` is far worse than reporting Cursor as
 * missing. A CLI that claims a shared name must therefore declare how to
 * recognize itself: `identityPattern` matches the `--version` output,
 * `identityPathPattern` matches the resolved real path (Cursor's `agent`
 * symlink lands in `.../cursor-agent/versions/<v>/cursor-agent`). Either
 * proof is enough; declaring neither means the CLI accepts the name blindly.
 */
function matchesDeclaredIdentity(cli, realPath, versionOutput) {
    if (!cli.identityPattern && !cli.identityPathPattern)
        return true;
    const test = (source, value) => {
        if (!source)
            return false;
        try {
            return new RegExp(source, 'i').test(value);
        }
        catch {
            // A malformed pattern must not silently accept every impostor.
            return false;
        }
    };
    return test(cli.identityPattern, versionOutput) || test(cli.identityPathPattern, realPath);
}
/**
 * Build the actual spawn invocation for a version probe. Thin alias over the
 * shared Windows-safe routing in utils/spawnSpec.ts — the same helper the
 * orchestration runtime uses, so the two can't drift.
 */
function buildVersionSpawnSpec(binPath, versionArgs, env, isWin = process.platform === 'win32') {
    return (0, spawnSpec_1.buildSpawnSpec)(binPath, versionArgs, env, isWin);
}
/**
 * Expand `~` and `%VAR%` tokens in a fallback path string. Returns null if
 * a referenced env var is undefined (e.g., %USERPROFILE% on POSIX).
 */
function expandFallbackPath(raw) {
    const isWin = process.platform === 'win32';
    let out = raw;
    if (out.startsWith('~/') || out === '~') {
        const home = os_1.default.homedir();
        if (!home)
            return null;
        out = path_1.default.join(home, out.slice(2));
    }
    // Windows-style %VAR% expansion. Resolve eagerly so we can short-circuit
    // on missing vars (skip the candidate entirely rather than probing a
    // literal `%APPDATA%\...` path).
    out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, name) => {
        const value = process.env[name];
        return value ?? ` MISSING `;
    });
    if (out.includes(' MISSING '))
        return null;
    // Normalize separators per platform — fallback paths may be written with
    // POSIX or Windows separators regardless of where we're running.
    return isWin ? out.replace(/\//g, '\\') : out.replace(/\\/g, '/');
}
/**
 * Probe well-known install locations for a CLI when PATH lookup misses.
 * Returns the absolute path of the first file that exists, or null.
 *
 * Used as a fallback after `resolveBinaryPaths` so e.g. opencode installs to
 * `~/.local/bin/opencode` still get discovered even if the user hasn't added
 * that dir to PATH yet.
 */
async function probeFallbackPaths(fallbackPaths, signal) {
    if (!fallbackPaths)
        return [];
    const candidates = process.platform === 'win32' ? fallbackPaths.win :
        process.platform === 'darwin' ? fallbackPaths.mac :
            fallbackPaths.linux;
    if (!candidates || candidates.length === 0)
        return [];
    const found = [];
    for (const raw of candidates) {
        if (signal.aborted)
            break;
        const expanded = expandFallbackPath(raw);
        if (!expanded)
            continue;
        // Windows glob support: only the `*` token (e.g. `Python*\Scripts\aider.exe`).
        if (expanded.includes('*')) {
            const matched = await resolveWindowsGlob(expanded);
            if (matched)
                found.push(matched);
            continue;
        }
        try {
            await promises_1.default.access(expanded);
            found.push(expanded);
        }
        catch {
            // Not present; try next candidate.
        }
    }
    return found;
}
/**
 * Limited glob resolver for Windows fallback paths with a single `*` segment
 * (e.g. `%LOCALAPPDATA%\Programs\Python\Python*\Scripts\aider.exe`). Iterates
 * the parent dir and returns the first match. Returns null if nothing fits.
 */
async function resolveWindowsGlob(p) {
    const starIdx = p.indexOf('*');
    if (starIdx < 0)
        return null;
    const sepBefore = Math.max(p.lastIndexOf('\\', starIdx), p.lastIndexOf('/', starIdx));
    const sepAfter = (() => {
        const b = p.indexOf('\\', starIdx);
        const f = p.indexOf('/', starIdx);
        if (b < 0)
            return f;
        if (f < 0)
            return b;
        return Math.min(b, f);
    })();
    if (sepBefore < 0 || sepAfter < 0)
        return null;
    const dir = p.slice(0, sepBefore);
    const pattern = p.slice(sepBefore + 1, sepAfter);
    const tail = p.slice(sepAfter + 1);
    const prefix = pattern.slice(0, pattern.indexOf('*'));
    const suffix = pattern.slice(pattern.indexOf('*') + 1);
    try {
        const entries = await promises_1.default.readdir(dir);
        for (const entry of entries) {
            if (entry.startsWith(prefix) && entry.endsWith(suffix)) {
                const candidate = path_1.default.join(dir, entry, tail);
                try {
                    await promises_1.default.access(candidate);
                    return candidate;
                }
                catch {
                    continue;
                }
            }
        }
    }
    catch {
        return null;
    }
    return null;
}
/**
 * Invoke `<binPath> <versionArgs...>`, kill after PER_VERSION_TIMEOUT_MS.
 * Never throws; returns null on timeout/error.
 *
 * `raw` is the untouched stdout/stderr text — `version` is the compact label
 * for display, but identity checks need the full line (a calver build id or a
 * vendor name is exactly what `parseVersion` trims away).
 */
async function runVersion(binPath, versionArgs, env, signal) {
    return new Promise((resolve) => {
        let settled = false;
        const settle = (v) => {
            if (settled)
                return;
            settled = true;
            resolve(v);
        };
        const spec = buildVersionSpawnSpec(binPath, versionArgs, env);
        let proc;
        try {
            proc = (0, child_process_1.spawn)(spec.file, spec.args, {
                env,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsVerbatimArguments: spec.windowsVerbatimArguments,
            });
        }
        catch {
            // spawn throws synchronously on Windows for non-executable file types
            // (EINVAL); treat as an unverifiable path, not a scan error.
            settle(null);
            return;
        }
        const kill = () => { try {
            proc.kill('SIGKILL');
        }
        catch { /* noop */ } };
        const killTimer = setTimeout(kill, exports.PER_VERSION_TIMEOUT_MS);
        const abortHandler = () => kill();
        signal.addEventListener('abort', abortHandler, { once: true });
        let out = '';
        let err = '';
        proc.stdout?.on('data', (d) => { out += d.toString(); });
        proc.stderr?.on('data', (d) => { err += d.toString(); });
        proc.on('error', () => {
            clearTimeout(killTimer);
            signal.removeEventListener('abort', abortHandler);
            settle(null);
        });
        proc.on('close', () => {
            clearTimeout(killTimer);
            signal.removeEventListener('abort', abortHandler);
            // Some CLIs print --version to stderr (e.g. java)
            const raw = out.trim() || err.trim();
            const version = raw ? parseVersion(raw) : null;
            settle(version === null ? null : { version, raw });
        });
    });
}
/**
 * Scan a single CLI: resolve binary, optionally use cache, run --version.
 * Hard-capped at PER_CLI_TIMEOUT_MS.
 */
async function scanOneCli(cli, opts) {
    const start = nowMs();
    const env = { ...process.env, PATH: opts.pathOverride ?? (0, env_1.getEnrichedPath)() };
    const perCliController = new AbortController();
    const perCliTimer = setTimeout(() => perCliController.abort(), exports.PER_CLI_TIMEOUT_MS);
    const upstreamAbort = opts.signal;
    const onUpstreamAbort = () => perCliController.abort();
    upstreamAbort?.addEventListener('abort', onUpstreamAbort, { once: true });
    try {
        if (perCliController.signal.aborted) {
            return { cliId: cli.id, paths: [], verifiedPath: null, version: null, state: 'timeout', scanDurationMs: 0 };
        }
        let paths = await resolveBinaryPaths(cli.binaries, env, perCliController.signal);
        if (paths.length === 0) {
            // Fallback: probe each CLI's known install locations (~/.local/bin,
            // ~/.opencode/bin, %APPDATA%\npm, etc) — covers users who haven't
            // added the install dir to PATH yet.
            paths = await probeFallbackPaths(cli.fallbackPaths, perCliController.signal);
        }
        if (paths.length === 0) {
            return {
                cliId: cli.id,
                paths: [],
                verifiedPath: null,
                version: null,
                state: 'not-found',
                scanDurationMs: nowMs() - start,
            };
        }
        // One candidate per install: best-ranked spawnable file first (Windows),
        // then alias symlinks of the same executable collapsed into one entry.
        const { candidates, realPaths } = await dedupeAliasedInstalls(normalizeWindowsCandidates(paths));
        // 24h cache: if a found path is still alive and recently verified, skip re-version.
        const cached = opts.cache?.get(cli.id);
        if (cached && nowMs() - cached.detectedAt < exports.VERSION_CACHE_TTL_MS && candidates.includes(cached.path)) {
            try {
                await promises_1.default.access(cached.path, promises_1.default.constants.X_OK).catch(() => promises_1.default.access(cached.path));
                // Mirror the fresh path's impostor policy below: a shared-name
                // candidate that is not the identity-proven cached path must not
                // resurface here as an ambiguous sibling or a pickable override —
                // otherwise the cached (common) branch reports `ambiguous`, which
                // getCliBinary refuses, and the agent flip-flops offline for up to
                // 24h. This branch is probe-free, so drop strangers rather than
                // re-verify them.
                const cacheOwnCandidates = candidates.filter((candidate) => candidate === cached.path || !hasSharedBinaryName(candidate, cli.sharedBinaries ?? []));
                return {
                    cliId: cli.id,
                    paths: cacheOwnCandidates,
                    verifiedPath: cached.path,
                    version: cached.version,
                    state: cacheOwnCandidates.length > 1 ? 'ambiguous' : 'detected',
                    scanDurationMs: nowMs() - start,
                };
            }
            catch {
                // cache stale → fall through to re-verify
            }
        }
        // Settle shared-name candidates FIRST, and every one of them — not just up
        // to the first success. An impostor left in `paths` makes a perfectly good
        // install read `ambiguous`, and getCliBinary refuses ambiguous CLIs, so a
        // stranger sitting earlier in PATH than the real binary would take the
        // agent offline. Probes are memoized for the verify loop below, so this
        // costs one extra --version per shared-name candidate and nothing else.
        const sharedBinaries = cli.sharedBinaries ?? [];
        const probed = new Map();
        const ownCandidates = [];
        for (const candidate of candidates) {
            if (!hasSharedBinaryName(candidate, sharedBinaries)) {
                ownCandidates.push(candidate);
                continue;
            }
            if (perCliController.signal.aborted)
                break;
            const probe = await runVersion(candidate, cli.versionArgs, env, perCliController.signal);
            probed.set(candidate, probe);
            // Unproven candidates are dropped from `paths` too — surfacing a
            // stranger's binary as "found but unverified" would invite the user to
            // pick it as an override.
            if (probe && matchesDeclaredIdentity(cli, realPaths.get(candidate) ?? candidate, probe.raw)) {
                ownCandidates.push(candidate);
            }
        }
        // Try --version on each remaining candidate until one verifies (broken
        // first entries fail fast via spawn error; the per-CLI abort caps total
        // time).
        let verifiedPath = null;
        let version = null;
        for (const candidate of ownCandidates) {
            if (perCliController.signal.aborted)
                break;
            const probe = probed.has(candidate)
                ? probed.get(candidate)
                : await runVersion(candidate, cli.versionArgs, env, perCliController.signal);
            if (probe === null)
                continue;
            verifiedPath = candidate;
            version = probe.version;
            break;
        }
        const duration = nowMs() - start;
        if (version === null || verifiedPath === null) {
            return {
                cliId: cli.id,
                paths: ownCandidates,
                verifiedPath: null,
                version: null,
                state: ownCandidates.length === 0 ? 'not-found' : 'unverified',
                scanDurationMs: duration,
            };
        }
        if (opts.cache) {
            opts.cache.set(cli.id, { path: verifiedPath, version, detectedAt: nowMs() });
        }
        return {
            cliId: cli.id,
            paths: ownCandidates,
            verifiedPath,
            version,
            state: ownCandidates.length > 1 ? 'ambiguous' : 'detected',
            scanDurationMs: duration,
        };
    }
    catch (e) {
        return {
            cliId: cli.id,
            paths: [],
            verifiedPath: null,
            version: null,
            state: 'error',
            error: e instanceof Error ? e.message : String(e),
            scanDurationMs: nowMs() - start,
        };
    }
    finally {
        clearTimeout(perCliTimer);
        upstreamAbort?.removeEventListener('abort', onUpstreamAbort);
    }
}
/**
 * Bulk scan with bounded concurrency and a global timeout. Partial results are
 * always returned. Aborting via opts.signal stops further launches; in-flight
 * scans finish (or hit their per-CLI cap) and contribute to the result.
 */
async function scanAll(clis, opts) {
    const globalBudgetMs = opts.rescan ? exports.GLOBAL_TIMEOUT_RESCAN_MS : exports.GLOBAL_TIMEOUT_FIRST_MS;
    const globalController = new AbortController();
    const upstream = opts.signal;
    const onUpstream = () => globalController.abort();
    upstream?.addEventListener('abort', onUpstream, { once: true });
    const globalTimer = setTimeout(() => globalController.abort(), globalBudgetMs);
    const findings = [];
    let cursor = 0;
    let completed = 0;
    const workers = [];
    for (let i = 0; i < Math.min(exports.MAX_CONCURRENT_SPAWNS, clis.length); i++) {
        workers.push((async () => {
            while (true) {
                if (globalController.signal.aborted)
                    return;
                const idx = cursor++;
                if (idx >= clis.length)
                    return;
                const cli = clis[idx];
                const finding = await scanOneCli(cli, { ...opts, signal: globalController.signal });
                findings.push(finding);
                completed++;
                opts.onProgress?.({ cliId: cli.id, finding, completed, total: clis.length });
            }
        })());
    }
    await Promise.allSettled(workers);
    clearTimeout(globalTimer);
    upstream?.removeEventListener('abort', onUpstream);
    // Any CLIs that didn't get a slot before global timeout: mark as timeout.
    const scanned = new Set(findings.map((f) => f.cliId));
    for (const cli of clis) {
        if (!scanned.has(cli.id)) {
            findings.push({
                cliId: cli.id,
                paths: [],
                verifiedPath: null,
                version: null,
                state: 'timeout',
                scanDurationMs: 0,
            });
        }
    }
    return findings;
}
/** Targeted single-CLI lookup used by getCliBinary on cache miss. */
async function scanOneById(clis, id, opts) {
    const cli = clis.find((c) => c.id === id);
    if (!cli)
        return null;
    return scanOneCli(cli, opts);
}
