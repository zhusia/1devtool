"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseWindowsProcessSnapshot = parseWindowsProcessSnapshot;
exports.prewarmProcessAncestry = prewarmProcessAncestry;
exports.getParentPid = getParentPid;
exports.findTerminalByParentMap = findTerminalByParentMap;
exports.awaitProcessAttributionRefresh = awaitProcessAttributionRefresh;
exports.findTerminalByAncestry = findTerminalByAncestry;
/*
 * Process-ancestry walk shared by both PtyBackends (docs/architecture/pty-daemon.md §3.2,
 * D4): maps an arbitrary PID to the terminal owning its root PTY process by
 * walking parent links. The embedded backend feeds it live `instance.pty.pid`s;
 * the remote backend feeds a main-side map built from daemon session events so
 * `McpBridge.resolveTerminalId` stays synchronous.
 *
 * ⚠ Electron-free (bundled into the daemon's dependency closure via pty.ts).
 */
const child_process_1 = require("child_process");
/*
 * POSIX parent-pid memo: the MCP bridge walks ancestry on every tool call that
 * arrives without ONEDEVTOOL_TERMINAL_ID, and each hop is a synchronous `ps`
 * spawn — a multi-hop walk freezes the main thread for tens of ms per call.
 * Windows uses the async whole-tree snapshot below. Ancestry is stable for a
 * live chain, but PIDs get reused and this feeds terminal ATTRIBUTION (a stale
 * hit could badge the wrong terminal — see mcp-tool-badge-wrong-terminal.md:
 * leave unattributed calls unbadged rather than guess), so the 5 s TTL bounds
 * any misattribution window. Null results are cached too: a dead pid is just
 * as expensive to rediscover.
 */
const PARENT_PID_TTL_MS = 5000;
const PARENT_PID_SWEEP_THRESHOLD = 256;
const parentPidCache = new Map();
/*
 * Windows process ancestry must not shell out synchronously. The old path ran
 * one `wmic` process per parent hop, so a single unattributed MCP call could
 * freeze Electron's main thread several times in a row. Modern Windows also
 * makes WMIC optional. Keep a short-lived whole-process snapshot instead:
 * refresh it asynchronously (WMIC when present, PowerShell/CIM otherwise),
 * then keep the synchronous attribution API as Map-only work.
 *
 * A missing/stale snapshot returns no attribution while a refresh runs. That
 * preserves the terminal rule: an absent badge is preferable to a badge based
 * on stale or guessed ownership.
 */
const WINDOWS_PROCESS_SNAPSHOT_TTL_MS = 5000;
const WINDOWS_PROCESS_REFRESH_RETRY_MS = 1000;
const WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 5000;
const WINDOWS_PROCESS_QUERY_MAX_BYTES = 8 * 1024 * 1024;
let windowsProcessSnapshot = null;
let windowsProcessSnapshotRefresh = null;
let windowsProcessSnapshotLastAttemptAt = 0;
let windowsProcessSnapshotPreferredCommand = null;
const WINDOWS_PROCESS_SNAPSHOT_COMMANDS = [
    {
        file: 'wmic.exe',
        args: ['process', 'get', 'ParentProcessId,ProcessId', '/format:csv'],
    },
    {
        file: 'powershell.exe',
        args: [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            "Get-CimInstance Win32_Process | ForEach-Object { '{0}={1}' -f $_.ProcessId, $_.ParentProcessId }",
        ],
    },
];
/** Parse either WMIC CSV (`host,parent,pid`) or the PowerShell fallback
 * (`pid=parent`) into a process-id -> parent-process-id snapshot. */
function parseWindowsProcessSnapshot(output) {
    const parents = new Map();
    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line)
            continue;
        const powershellMatch = line.match(/^(\d+)\s*=\s*(\d+)$/);
        if (powershellMatch) {
            const pid = Number.parseInt(powershellMatch[1], 10);
            const parentPid = Number.parseInt(powershellMatch[2], 10);
            if (pid > 0 && parentPid >= 0)
                parents.set(pid, parentPid);
            continue;
        }
        const columns = line.split(',').map((column) => column.trim());
        if (columns.length < 3)
            continue;
        const parentPid = Number.parseInt(columns.at(-2) ?? '', 10);
        const pid = Number.parseInt(columns.at(-1) ?? '', 10);
        if (pid > 0 && parentPid >= 0)
            parents.set(pid, parentPid);
    }
    return parents;
}
function collectProcessSnapshot(command) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let stdout = '';
        let stdoutBytes = 0;
        const child = (0, child_process_1.spawn)(command.file, command.args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const settle = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            if (error)
                reject(error);
            else
                resolve(stdout);
        };
        const timeout = setTimeout(() => {
            try {
                child.kill();
            }
            catch { /* best-effort */ }
            settle(new Error(`${command.file} process snapshot timed out`));
        }, WINDOWS_PROCESS_QUERY_TIMEOUT_MS);
        timeout.unref?.();
        child.stdout?.on('data', (chunk) => {
            if (settled)
                return;
            stdout += chunk.toString();
            stdoutBytes += chunk.length;
            if (stdoutBytes > WINDOWS_PROCESS_QUERY_MAX_BYTES) {
                try {
                    child.kill();
                }
                catch { /* best-effort */ }
                settle(new Error(`${command.file} process snapshot exceeded the output limit`));
            }
        });
        child.once('error', (error) => settle(error));
        child.once('close', (code) => {
            if (code === 0)
                settle();
            else
                settle(new Error(`${command.file} process snapshot exited with code ${code ?? 'unknown'}`));
        });
    });
}
async function loadWindowsProcessSnapshot() {
    const commandIndexes = windowsProcessSnapshotPreferredCommand === null
        ? WINDOWS_PROCESS_SNAPSHOT_COMMANDS.map((_, index) => index)
        : [
            windowsProcessSnapshotPreferredCommand,
            ...WINDOWS_PROCESS_SNAPSHOT_COMMANDS
                .map((_, index) => index)
                .filter((index) => index !== windowsProcessSnapshotPreferredCommand),
        ];
    for (const commandIndex of commandIndexes) {
        const command = WINDOWS_PROCESS_SNAPSHOT_COMMANDS[commandIndex];
        try {
            const parents = parseWindowsProcessSnapshot(await collectProcessSnapshot(command));
            if (parents.size > 0) {
                // Do not retry a missing WMIC executable on every refresh. If the
                // preferred provider later fails, the loop still falls back and flips.
                windowsProcessSnapshotPreferredCommand = commandIndex;
                return parents;
            }
        }
        catch {
            // WMIC is absent on many current Windows installs; try PowerShell/CIM.
        }
    }
    throw new Error('Unable to read the Windows process tree');
}
function requestWindowsProcessSnapshotRefresh(now = Date.now()) {
    if (process.platform !== 'win32')
        return Promise.resolve();
    if (windowsProcessSnapshotRefresh)
        return windowsProcessSnapshotRefresh;
    if (now - windowsProcessSnapshotLastAttemptAt < WINDOWS_PROCESS_REFRESH_RETRY_MS) {
        return Promise.resolve();
    }
    windowsProcessSnapshotLastAttemptAt = now;
    const refresh = loadWindowsProcessSnapshot()
        .then((parents) => {
        windowsProcessSnapshot = { parents, at: Date.now() };
    })
        .catch(() => {
        // Attribution is advisory. Leave calls unbadged until a later refresh.
    })
        .finally(() => {
        if (windowsProcessSnapshotRefresh === refresh) {
            windowsProcessSnapshotRefresh = null;
        }
    });
    windowsProcessSnapshotRefresh = refresh;
    return refresh;
}
/** Warm the Windows snapshot during PTY-manager construction without blocking
 * app startup. Other platforms have no work to do. */
function prewarmProcessAncestry() {
    if (process.platform === 'win32'
        && windowsProcessSnapshot
        && Date.now() - windowsProcessSnapshot.at < WINDOWS_PROCESS_SNAPSHOT_TTL_MS) {
        return Promise.resolve();
    }
    return requestWindowsProcessSnapshotRefresh();
}
function getFreshWindowsProcessSnapshot(seedPid) {
    const now = Date.now();
    const snapshot = windowsProcessSnapshot;
    const isFresh = snapshot && now - snapshot.at < WINDOWS_PROCESS_SNAPSHOT_TTL_MS;
    if (isFresh && (seedPid === undefined || snapshot.parents.has(seedPid))) {
        return snapshot.parents;
    }
    void requestWindowsProcessSnapshotRefresh(now);
    return null;
}
function getParentPid(pid) {
    if (process.platform === 'win32') {
        return getFreshWindowsProcessSnapshot(pid)?.get(pid) ?? null;
    }
    const now = Date.now();
    const cached = parentPidCache.get(pid);
    if (cached && now - cached.at < PARENT_PID_TTL_MS)
        return cached.ppid;
    const ppid = queryParentPid(pid);
    if (parentPidCache.size >= PARENT_PID_SWEEP_THRESHOLD) {
        for (const [key, entry] of parentPidCache) {
            if (now - entry.at >= PARENT_PID_TTL_MS)
                parentPidCache.delete(key);
        }
    }
    parentPidCache.set(pid, { ppid, at: now });
    return ppid;
}
function queryParentPid(pid) {
    try {
        const output = (0, child_process_1.execFileSync)('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 });
        const parentPid = Number.parseInt(output.trim(), 10);
        return Number.isFinite(parentPid) && parentPid > 0 ? parentPid : null;
    }
    catch {
        return null;
    }
}
function walkTerminalAncestry(pid, terminalByRootPid, getParent) {
    let currentPid = pid;
    const seen = new Set();
    for (let depth = 0; depth < 32 && currentPid > 1 && !seen.has(currentPid); depth++) {
        const terminalId = terminalByRootPid.get(currentPid);
        if (terminalId)
            return terminalId;
        seen.add(currentPid);
        const parentPid = getParent(currentPid);
        if (!parentPid || parentPid === currentPid)
            break;
        currentPid = parentPid;
    }
    return null;
}
/** Pure Windows snapshot walk, exported for cross-platform regression tests. */
function findTerminalByParentMap(pid, terminalByRootPid, parents) {
    if (!Number.isInteger(pid) || !pid || pid <= 0)
        return null;
    return walkTerminalAncestry(pid, terminalByRootPid, (currentPid) => parents.get(currentPid) ?? null);
}
/**
 * Force one attribution refresh and wait for it — the AUTHORIZATION
 * companion to the advisory sync lookups above.
 *
 * On Windows the ancestry answer comes from a 5s-TTL whole-process snapshot,
 * and a synchronous miss while that snapshot is stale is a timing artifact,
 * not an ownership verdict: without this, the first orchestration verb after
 * any idle gap 403s ("does not own the calling terminal") even though the
 * caller IS a PTY descendant. Bypasses the passive retry throttle — an
 * authorization decision is actively waiting — but never stacks refreshes:
 * an in-flight one is awaited instead. On POSIX the per-hop `ps` walk is
 * live; only memoized NULLs (transient `ps` failures) can go stale, so the
 * memo is dropped and the caller's re-walk re-queries.
 */
function awaitProcessAttributionRefresh() {
    if (process.platform === 'win32') {
        if (windowsProcessSnapshotRefresh)
            return windowsProcessSnapshotRefresh;
        windowsProcessSnapshotLastAttemptAt = 0;
        return requestWindowsProcessSnapshotRefresh();
    }
    parentPidCache.clear();
    return Promise.resolve();
}
function findTerminalByAncestry(pid, terminalByRootPid) {
    if (!Number.isInteger(pid) || !pid || pid <= 0)
        return null;
    // Direct roots never need a process-table lookup.
    const directTerminalId = terminalByRootPid.get(pid);
    if (directTerminalId)
        return directTerminalId;
    if (process.platform === 'win32') {
        const parents = getFreshWindowsProcessSnapshot(pid);
        return parents ? findTerminalByParentMap(pid, terminalByRootPid, parents) : null;
    }
    return walkTerminalAncestry(pid, terminalByRootPid, getParentPid);
}
