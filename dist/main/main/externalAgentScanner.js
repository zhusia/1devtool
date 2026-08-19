"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExternalAgentScanner = void 0;
exports.getExternalAgentScanner = getExternalAgentScanner;
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const util_1 = require("util");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
// ── Tunables ────────────────────────────────────────────────────────────────
const CACHE_TTL = 5_000; // liveness changes fast — short cache, deduped in-flight
const EXEC_TIMEOUT = 2_000; // every shell call is timeout-guarded (stale SSHFS, hung lsof)
const MAX_ANCESTRY_HOPS = 24; // safety bound on the parent-PID walk
const TERMINATE_POLL_MS = 150;
const TERMINATE_GRACE_MS = 3_000;
// Env var 1DevTool injects into every PTY it launches — the definitive marker
// that a process belongs to some 1DevTool instance (any window, dev or packaged).
const ONEDEVTOOL_MARKER = 'ONEDEVTOOL_TERMINAL_ID';
// ── Agent detection ───────────────────────────────────────────────────────
// Match a process to an agent by the basename of any argv token. Node-wrapped
// CLIs surface as `node …/<name>` where the bin file is named for the agent, so
// a basename match is the reliable, low-false-positive signal. Only agents with
// an on-disk session store (scannable by ResumeManager) are listed.
const AGENT_BINARY_TO_TYPE = {
    claude: 'claude',
    codex: 'codex',
    gemini: 'gemini',
    kimi: 'kimi',
    agy: 'agy',
    qwen: 'qwen',
    grok: 'grok',
    pi: 'pi',
    opencode: 'opencode',
    cline: 'cline',
    hermes: 'hermes',
};
// Shell-ish ancestors we skip while climbing toward the owning GUI app.
const SHELL_NAMES = new Set([
    'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh',
    'login', 'su', 'sudo', 'env', 'node', 'deno', 'bun', 'python', 'python3',
]);
// Friendly-name map keyed by a lowercased token (a macOS *.app folder name, a
// Linux comm basename, or a Windows image name). Extend freely.
const KNOWN_TERMINALS = [
    { id: 'ghostty', name: 'Ghostty', match: /^ghostty$/ },
    { id: 'iterm', name: 'iTerm', match: /^iterm2?$/ },
    { id: 'apple-terminal', name: 'Apple Terminal', match: /^terminal$/ },
    { id: 'wezterm', name: 'WezTerm', match: /^wezterm(-gui)?$/ },
    { id: 'kitty', name: 'kitty', match: /^kitty$/ },
    { id: 'alacritty', name: 'Alacritty', match: /^alacritty$/ },
    { id: 'warp', name: 'Warp', match: /^(warp|warp-terminal|stable)$/ },
    { id: 'hyper', name: 'Hyper', match: /^hyper$/ },
    { id: 'tabby', name: 'Tabby', match: /^tabby$/ },
    { id: 'rio', name: 'Rio', match: /^rio$/ },
    { id: 'foot', name: 'foot', match: /^foot$/ },
    { id: 'konsole', name: 'Konsole', match: /^konsole$/ },
    { id: 'gnome-terminal', name: 'GNOME Terminal', match: /^gnome-terminal(-server)?$/ },
    { id: 'xterm', name: 'XTerm', match: /^xterm$/ },
    { id: 'tilix', name: 'Tilix', match: /^tilix$/ },
    { id: 'terminator', name: 'Terminator', match: /^terminator$/ },
    { id: 'xfce4-terminal', name: 'Xfce Terminal', match: /^xfce4-terminal$/ },
    { id: 'windows-terminal', name: 'Windows Terminal', match: /^windowsterminal$/ },
    { id: 'cursor', name: 'Cursor', match: /^cursor$/ },
    { id: 'windsurf', name: 'Windsurf', match: /^windsurf$/ },
    { id: 'vscode-insiders', name: 'VS Code Insiders', match: /^(code - insiders|code-insiders)$/ },
    { id: 'vscodium', name: 'VSCodium', match: /^vscodium$/ },
    { id: 'vscode', name: 'VS Code', match: /^(visual studio code|code)$/ },
];
class ExternalAgentScanner {
    resumeManager;
    selfPid;
    cache = null;
    inFlight = null;
    constructor(resumeManager, selfPid) {
        this.resumeManager = resumeManager;
        this.selfPid = selfPid;
    }
    /** Matched (session ⨯ live process) pairs, freshest first. Cached, deduped. */
    async detect(options = {}) {
        if (options.forceRefresh) {
            this.cache = null;
            const current = this.inFlight;
            if (current) {
                await current.catch(() => []);
                this.cache = null;
            }
        }
        else if (this.cache && Date.now() - this.cache.timestamp < CACHE_TTL) {
            return this.cache.matches;
        }
        if (this.inFlight)
            return this.inFlight;
        this.inFlight = this.runDetect()
            .then((matches) => {
            this.cache = { matches, timestamp: Date.now() };
            return matches;
        })
            .catch((err) => {
            console.warn('[external-scan] detect failed:', err instanceof Error ? err.message : err);
            return [];
        })
            .finally(() => {
            this.inFlight = null;
        });
        return this.inFlight;
    }
    clearCache() {
        this.cache = null;
    }
    async runDetect() {
        // Windows owner-app detection is feasible but cwd is not resolvable without
        // native PEB tricks; deferred to a later phase. Degrade to empty, never throw.
        if (process.platform === 'win32')
            return [];
        const procs = process.platform === 'darwin'
            ? await this.listProcsMac()
            : await this.listProcsLinux();
        if (procs.length === 0)
            return [];
        const byPid = new Map();
        for (const p of procs)
            byPid.set(p.pid, p);
        // Step 2 — match AI CLIs.
        const aiProcs = procs.filter((p) => this.agentTypeFor(p.command) !== null);
        if (aiProcs.length === 0)
            return [];
        // Step 4 — exclude our own terminals (ancestry reaches the Electron main pid).
        const ownExcluded = aiProcs.filter((p) => !this.isOwnedByUs(p.pid, byPid));
        if (ownExcluded.length === 0)
            return [];
        // Step 4b — collapse to top-level launchers. An agent spawns child processes
        // sharing the same cwd (e.g. codex = `node` wrapper → vendored binary →
        // helper). Drop any proc whose ancestry contains another matched AI proc so
        // each session maps to ONE row and `terminate()` kills the parent (which
        // cascades to its children) rather than a leaf.
        const aiPids = new Set(aiProcs.map((p) => p.pid));
        const topLevel = ownExcluded.filter((p) => !this.hasAiAncestor(p.pid, aiPids, byPid));
        if (topLevel.length === 0)
            return [];
        // Step 4c — exclude sessions launched by ANY 1DevTool instance. Our own are
        // already gone via ancestry (step 4), but OTHER 1DevTool windows — and our
        // own tmux-backed terminals where the daemon breaks the ancestry chain — are
        // not. 1DevTool injects ONEDEVTOOL_TERMINAL_ID into every PTY it launches, so
        // that env marker is the definitive "owned by some 1DevTool" signal. Read env
        // only for these few candidate pids.
        const oneDevToolOwned = await this.readOneDevToolOwnedPids(topLevel.map((p) => p.pid));
        const external = topLevel.filter((p) => !oneDevToolOwned.has(p.pid));
        if (external.length === 0)
            return [];
        // Step 5 — resolve cwd for ONLY the matched AI pids (cheap: usually 1–3).
        const cwds = await this.resolveCwds(external.map((p) => p.pid));
        // Step 3 (lazy) — resolve owner app per matched pid via ancestry walk.
        const sessions = await this.resumeManager.getAllSessions();
        const claimed = new Set();
        const matches = [];
        for (const proc of external) {
            const agentType = this.agentTypeFor(proc.command);
            const cwd = cwds.get(proc.pid) ?? null;
            const { ownerApp, inTmux } = this.resolveOwnerApp(proc.pid, byPid);
            const session = this.matchSession(sessions, agentType, cwd, claimed);
            if (!session)
                continue; // Phase 1: only surface processes we can tie to a transcript
            claimed.add(`${session.agentType}:${session.id}`);
            const liveProcess = {
                pid: proc.pid,
                agentType,
                cwd,
                startedAt: proc.startedAt,
                ownerApp,
                inTmux,
            };
            matches.push({ session, liveProcess });
        }
        matches.sort((a, b) => b.session.lastActivityAt - a.session.lastActivityAt);
        return matches;
    }
    // ── Process enumeration ───────────────────────────────────────────────────
    async listProcsMac() {
        try {
            // lstart is 5 whitespace tokens; command (the rest) holds full argv.
            const { stdout } = await execAsync('ps -axww -o pid=,ppid=,lstart=,command= 2>/dev/null || true', { maxBuffer: 8 * 1024 * 1024, timeout: EXEC_TIMEOUT });
            const out = [];
            for (const line of stdout.split('\n')) {
                const t = line.trim();
                if (!t)
                    continue;
                const parts = t.split(/\s+/);
                if (parts.length < 8)
                    continue;
                const pid = Number.parseInt(parts[0], 10);
                const ppid = Number.parseInt(parts[1], 10);
                if (!Number.isFinite(pid) || !Number.isFinite(ppid))
                    continue;
                const started = Date.parse(parts.slice(2, 7).join(' '));
                out.push({
                    pid,
                    ppid,
                    startedAt: Number.isNaN(started) ? null : started,
                    command: parts.slice(7).join(' '),
                });
            }
            return out;
        }
        catch {
            return [];
        }
    }
    async listProcsLinux() {
        // Pure /proc reads — no subprocess.
        let entries;
        try {
            entries = await fs_1.promises.readdir('/proc');
        }
        catch {
            return [];
        }
        const out = [];
        await Promise.all(entries.map(async (name) => {
            if (!/^\d+$/.test(name))
                return;
            const pid = Number.parseInt(name, 10);
            try {
                // ppid lives in /proc/<pid>/stat field 4, but comm (field 2) can contain
                // spaces/parens — split after the closing ')' to stay robust.
                const stat = await fs_1.promises.readFile(`/proc/${pid}/stat`, 'utf8');
                const rparen = stat.lastIndexOf(')');
                const after = stat.slice(rparen + 2).split(' ');
                const ppid = Number.parseInt(after[1], 10); // state=after[0], ppid=after[1]
                if (!Number.isFinite(ppid))
                    return;
                const cmdline = await fs_1.promises.readFile(`/proc/${pid}/cmdline`, 'utf8');
                const command = cmdline.replace(/\0/g, ' ').trim() || (await this.linuxComm(pid));
                out.push({ pid, ppid, startedAt: null, command });
            }
            catch {
                // Process exited mid-scan or is unreadable — skip.
            }
        }));
        return out;
    }
    async linuxComm(pid) {
        try {
            return (await fs_1.promises.readFile(`/proc/${pid}/comm`, 'utf8')).trim();
        }
        catch {
            return '';
        }
    }
    // ── cwd resolution (matched pids only) ─────────────────────────────────────
    async resolveCwds(pids) {
        const result = new Map();
        if (pids.length === 0)
            return result;
        if (process.platform === 'darwin') {
            try {
                // One batched lsof for all matched pids (comma-separated). -Fpn emits
                // `p<pid>` then `n<cwd>` lines.
                const { stdout } = await execAsync(`lsof -p ${pids.join(',')} -a -d cwd -Fpn 2>/dev/null || true`, { maxBuffer: 4 * 1024 * 1024, timeout: EXEC_TIMEOUT });
                let current = NaN;
                for (const line of stdout.split('\n')) {
                    if (line.startsWith('p')) {
                        current = Number.parseInt(line.slice(1), 10);
                    }
                    else if (line.startsWith('n') && Number.isFinite(current)) {
                        const cwd = line.slice(1).trim();
                        if (cwd && !result.has(current))
                            result.set(current, cwd);
                    }
                }
            }
            catch {
                // ignore — rows without a cwd just won't match a session
            }
        }
        else {
            await Promise.all(pids.map(async (pid) => {
                try {
                    const cwd = await fs_1.promises.readlink(`/proc/${pid}/cwd`);
                    if (cwd)
                        result.set(pid, cwd);
                }
                catch {
                    // ignore
                }
            }));
        }
        return result;
    }
    /** Subset of `pids` whose env carries 1DevTool's ONEDEVTOOL_TERMINAL_ID marker. */
    async readOneDevToolOwnedPids(pids) {
        const owned = new Set();
        if (pids.length === 0)
            return owned;
        if (process.platform === 'darwin') {
            try {
                // `-E` appends the process environment to the command column.
                const { stdout } = await execAsync(`ps -E -ww -o pid=,command= -p ${pids.join(',')} 2>/dev/null || true`, { maxBuffer: 8 * 1024 * 1024, timeout: EXEC_TIMEOUT });
                for (const line of stdout.split('\n')) {
                    const t = line.trim();
                    const sp = t.indexOf(' ');
                    if (sp < 0)
                        continue;
                    const pid = Number.parseInt(t.slice(0, sp), 10);
                    if (Number.isFinite(pid) && t.includes(`${ONEDEVTOOL_MARKER}=`))
                        owned.add(pid);
                }
            }
            catch {
                // env unreadable (rare hardening) — fall back to ancestry-only exclusion
            }
        }
        else {
            await Promise.all(pids.map(async (pid) => {
                try {
                    const env = await fs_1.promises.readFile(`/proc/${pid}/environ`, 'utf8');
                    if (env.split('\0').some((e) => e.startsWith(`${ONEDEVTOOL_MARKER}=`)))
                        owned.add(pid);
                }
                catch {
                    // ignore
                }
            }));
        }
        return owned;
    }
    // ── Agent + owner-app resolution ───────────────────────────────────────────
    agentTypeFor(command) {
        if (!command)
            return null;
        for (const token of command.split(/\s+/)) {
            // Strip path + a trailing .cmd/.exe; ignore flag tokens.
            if (token.startsWith('-'))
                continue;
            const base = token.split(/[\\/]/).pop()?.replace(/\.(cmd|exe)$/i, '');
            if (base && AGENT_BINARY_TO_TYPE[base])
                return AGENT_BINARY_TO_TYPE[base];
        }
        return null;
    }
    /** True if any ancestor pid is itself a matched AI process (i.e. this is a child). */
    hasAiAncestor(pid, aiPids, byPid) {
        let cur = byPid.get(pid)?.ppid ?? -1;
        for (let i = 0; i < MAX_ANCESTRY_HOPS && cur > 1; i++) {
            if (aiPids.has(cur))
                return true;
            const node = byPid.get(cur);
            if (!node || node.ppid === cur)
                break;
            cur = node.ppid;
        }
        return false;
    }
    /** Walk pid→ppid; true if the chain reaches the Electron main process (= ours). */
    isOwnedByUs(pid, byPid) {
        let cur = pid;
        for (let i = 0; i < MAX_ANCESTRY_HOPS; i++) {
            if (cur === this.selfPid)
                return true;
            const node = byPid.get(cur);
            if (!node || node.ppid <= 1 || node.ppid === cur)
                break;
            cur = node.ppid;
        }
        return false;
    }
    /** Climb ancestors until a known terminal/editor (or the tmux daemon) is found. */
    resolveOwnerApp(pid, byPid) {
        let cur = byPid.get(pid)?.ppid ?? -1;
        let inTmux = false;
        for (let i = 0; i < MAX_ANCESTRY_HOPS && cur > 1; i++) {
            const node = byPid.get(cur);
            if (!node)
                break;
            const cmd = node.command;
            // tmux/screen break the chain — the GUI front-end isn't an ancestor.
            if (/(^|\/|\s)(tmux|screen)(:|\s|$)/.test(cmd)) {
                inTmux = true;
                return { ownerApp: { kind: 'tmux' }, inTmux };
            }
            const token = this.ownerToken(cmd);
            if (token) {
                const known = KNOWN_TERMINALS.find((t) => t.match.test(token.key));
                if (known) {
                    // Disambiguate VS Code forks by path (Cursor/Windsurf ship as "Code").
                    if (known.id === 'vscode' && /cursor/i.test(cmd)) {
                        return { ownerApp: { kind: 'known', id: 'cursor', name: 'Cursor' }, inTmux };
                    }
                    if (known.id === 'vscode' && /windsurf/i.test(cmd)) {
                        return { ownerApp: { kind: 'known', id: 'windsurf', name: 'Windsurf' }, inTmux };
                    }
                    return { ownerApp: { kind: 'known', id: known.id, name: known.name }, inTmux };
                }
                // A real *.app we don't have a friendly name for → surface its name.
                if (token.fromApp) {
                    return { ownerApp: { kind: 'app', name: token.display }, inTmux };
                }
            }
            if (node.ppid === cur)
                break;
            cur = node.ppid;
        }
        return { ownerApp: { kind: 'unknown' }, inTmux };
    }
    /**
     * Extract a candidate owner token from a process command. Prefers a macOS
     * `*.app` bundle name; otherwise the argv[0] basename. Returns null for plain
     * shells so the walk continues toward the real owner.
     */
    ownerToken(command) {
        const appMatch = command.match(/\/([^/]+)\.app\//);
        if (appMatch) {
            const display = appMatch[1];
            return { key: display.toLowerCase(), display, fromApp: true };
        }
        const argv0 = command.split(/\s+/)[0] || '';
        const base = argv0.split(/[\\/]/).pop()?.replace(/^-/, '').replace(/\.(exe)$/i, '') || '';
        if (!base || SHELL_NAMES.has(base.toLowerCase()))
            return null;
        return { key: base.toLowerCase(), display: base, fromApp: false };
    }
    // ── Session matching ───────────────────────────────────────────────────────
    matchSession(sessions, agentType, cwd, claimed) {
        if (!cwd)
            return null; // Phase 1 requires a cwd to attribute the process
        const target = this.normPath(cwd);
        const candidates = sessions
            .filter((s) => s.agentType === agentType)
            .filter((s) => {
            const sCwd = s.cwd ? this.normPath(s.cwd) : '';
            const sProject = s.projectPath ? this.normPath(s.projectPath) : '';
            return sCwd === target || sProject === target;
        })
            .filter((s) => !claimed.has(`${s.agentType}:${s.id}`))
            // Freshest transcript = the one being written by the live process now.
            .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
        return candidates[0] ?? null;
    }
    normPath(p) {
        return p.replace(/[\\/]+$/, '').replace(/\\/g, '/');
    }
    // ── Terminate ───────────────────────────────────────────────────────────────
    async terminate(pid) {
        if (!Number.isFinite(pid) || pid <= 1) {
            return { ok: false, error: 'Invalid PID' };
        }
        if (pid === this.selfPid) {
            return { ok: false, error: 'Refusing to terminate 1DevTool itself' };
        }
        // Re-verify the PID is still one of our detected external AI processes before
        // killing — guards against PID reuse between detect() and the user's click.
        const stillExternal = (this.cache?.matches ?? []).some((m) => m.liveProcess.pid === pid);
        if (!stillExternal) {
            // Cache may have expired; re-detect once to confirm.
            const fresh = await this.detect();
            if (!fresh.some((m) => m.liveProcess.pid === pid)) {
                return { ok: false, error: 'Process is no longer a tracked external session' };
            }
        }
        try {
            if (process.platform === 'win32') {
                await execAsync(`taskkill /PID ${pid} /T /F`, { timeout: EXEC_TIMEOUT });
                this.clearCache();
                return { ok: true };
            }
            process.kill(pid, 'SIGTERM');
            const deadline = Date.now() + TERMINATE_GRACE_MS;
            while (Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, TERMINATE_POLL_MS));
                if (!this.isAlive(pid)) {
                    this.clearCache();
                    return { ok: true };
                }
            }
            // Still alive after grace — force kill.
            try {
                process.kill(pid, 'SIGKILL');
            }
            catch { /* already gone */ }
            this.clearCache();
            return { ok: true };
        }
        catch (err) {
            // ESRCH = already exited → treat as success.
            if (err instanceof Error && 'code' in err && err.code === 'ESRCH') {
                this.clearCache();
                return { ok: true };
            }
            return { ok: false, error: err instanceof Error ? err.message : 'Failed to terminate process' };
        }
    }
    isAlive(pid) {
        try {
            process.kill(pid, 0);
            return true;
        }
        catch {
            return false;
        }
    }
}
exports.ExternalAgentScanner = ExternalAgentScanner;
// Lazily-instantiated singleton. The IPC layer dynamic-imports this module on the
// first external-detection call, so neither the module nor a scanner instance
// costs anything at app boot.
let singleton = null;
function getExternalAgentScanner(resumeManager) {
    if (!singleton) {
        singleton = new ExternalAgentScanner(resumeManager, process.pid);
    }
    return singleton;
}
