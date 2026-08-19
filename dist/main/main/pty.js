"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PtyManager = void 0;
exports.tmuxSessionNameForTerminal = tmuxSessionNameForTerminal;
exports.buildTmuxSessionOptionCommands = buildTmuxSessionOptionCommands;
exports.normalizeTmuxMouseBehavior = normalizeTmuxMouseBehavior;
exports.applyTerminalEnvDefaults = applyTerminalEnvDefaults;
/*
 * ⚠ Terminal minefield — read docs/common-errors/terminals/INDEX.md before editing.
 * Invariants owned by this file:
 * - Pipe-buffer content is sanitized through shared replay.ts only (DA/CPR/OSC-query/tmux
 *   noise); no local filter regexes (da-response-garbage.md, tmux-detach-message.md).
 * - tmux is skipped for interactive AI terminals — allowsTmux() decides (ai-scrollback-cutoff.md).
 * - tmux native-selection mode disables alt-screen and rewrites CSI 2J; reattach captures
 *   scrollback with -E -1 (tmux-copy-mode-indicator.md, normal-terminal-empty-scrollback.md).
 * - Managed tmux sessions set prefix/prefix2 to None so nested multiplexers (herdr) keep
 *   Ctrl+b; live pipe buffer keeps mouse-tracking CSI (tmux-prefix-steals-nested-multiplexer.md).
 * - Every 1DevTool-launched PTY carries ONEDEVTOOL_TERMINAL_ID for badge attribution
 *   and tmux terminals expose the pane-shell PID (not the attach-client PID) for
 *   ancestry ownership (mcp-tool-badge-wrong-terminal.md,
 *   tmux-interactive-delegation-ownership.md).
 * - win32 writes drain through one callback-driven per-owner queue; a later '\r' must never
 *   overtake callback-pending prompt text, and reliable fences fail closed without the additive
 *   node-pty completion capability (windows-paste-truncation.md,
 *   ../windows/improve_nodepty_relieable.md).
 * - win32 interactive agents get a synthetic WT_SESSION and keep their mouse tracking
 *   (windows-altscreen-agent-scroll.md).
 * - Declared Cline/Grok pipe-buffer trims retain active OpenTUI modes for remount replay;
 *   every other terminal keeps the original raw-tail trim (cline-grok-native-tui-scroll.md).
 * - Notification/dashboard previews share agent-aware chrome filtering; a native-TUI viewport
 *   is UI state, not result text (cline-completion-notification-composer-chrome.md).
 * - Session claims use submitted-prompt evidence captured per terminal; timestamps alone cannot
 *   distinguish simultaneous external CLI sessions (session-detect-external-title-collision.md).
 * - Every teardown path releases the PTY master fd through releasePty()/releaseExitedPty();
 *   a bare pty.kill() only signals the child and strands the fd (pty-master-fd-leak.md).
 */
const pty = __importStar(require("node-pty"));
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const contracts_1 = require("../shared/terminal/contracts");
const runState_1 = require("../shared/terminal/runState");
const replay_1 = require("../shared/terminal/replay");
const terminalPreview_1 = require("../shared/terminal/terminalPreview");
const submittedPromptTracker_1 = require("../shared/terminal/submittedPromptTracker");
const mcpTerminalIdentity_1 = require("../shared/mcpTerminalIdentity");
const processAncestry_1 = require("./pty-backend/processAncestry");
const ptyRelease_1 = require("./pty-backend/ptyRelease");
const types_1 = require("./pty-backend/types");
const windowsPtyWriteQueue_1 = require("./windowsPtyWriteQueue");
const TMUX_SESSION_PREFIX = '1devtool-';
/** tmux session name for a terminal (sanitized for tmux's charset). Shared
 * with the SpawnSpec builder so main and the fd owner derive identical names. */
function tmuxSessionNameForTerminal(terminalId) {
    const sanitized = terminalId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `${TMUX_SESSION_PREFIX}${sanitized}`;
}
/**
 * Safe session-local tmux options applied on create (and reattach via
 * applyTmuxSessionOptions). 1DevTool uses tmux only as a persistence layer
 * (detach/reattach); it is not a user-facing multiplexer. Leave prefix unset
 * so nested tools that share the default Ctrl+b (herdr, nested tmux, zellij)
 * receive their keybindings instead of the outer session swallowing them.
 * See docs/common-errors/terminals/tmux-prefix-steals-nested-multiplexer.md.
 */
function buildTmuxSessionOptionCommands(sessionName, tmuxMouseBehavior, historyLimit = TMUX_HISTORY_LIMIT) {
    const commands = [
        ['set-option', '-t', sessionName, 'status', 'off'],
        // Session-scoped; does not change the user's other sessions on a shared
        // tmux server. `None` disables the prefix key for this session only.
        ['set-option', '-t', sessionName, 'prefix', 'None'],
        ['set-option', '-t', sessionName, 'prefix2', 'None'],
    ];
    if (tmuxMouseBehavior !== 'respect-config') {
        commands.push(['set-option', '-t', sessionName, 'mouse', tmuxMouseBehavior === 'force-on' ? 'on' : 'off']);
    }
    commands.push(['set-option', '-w', '-t', sessionName, 'history-limit', String(historyLimit)]);
    return commands;
}
// Synthetic Windows Terminal session id advertised to interactive agents on
// Windows so their TUIs enable native wheel scrolling (see applyTerminalEnvDefaults).
const WINDOWS_TERMINAL_SESSION_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const MAX_BUFFER_SIZE = 2 * 1024 * 1024;
const TMUX_HISTORY_LIMIT = 50000;
const DEFAULT_TMUX_MOUSE_BEHAVIOR = 'native-selection';
function normalizeTmuxMouseBehavior(value) {
    if (value === 'respect-config' || value === 'force-on' || value === 'native-selection') {
        return value;
    }
    return DEFAULT_TMUX_MOUSE_BEHAVIOR;
}
function applyTerminalEnvDefaults(env, agentType, command) {
    const nextEnv = { ...env };
    const declaredKind = (0, contracts_1.getDeclaredAgentKind)(agentType, command);
    // Preserve OpenCode's native mouse behavior so fullscreen TUI sessions can
    // keep their own wheel handling inside the embedded xterm.
    if (declaredKind === 'opencode') {
        if (!Object.prototype.hasOwnProperty.call(nextEnv, 'OPENCODE_EXPERIMENTAL_MARKDOWN')) {
            nextEnv.OPENCODE_EXPERIMENTAL_MARKDOWN = '0';
        }
    }
    // On Windows, agent TUIs (Codex's Ink renderer especially) only enable
    // mouse-wheel scrolling when they believe the host forwards wheel events,
    // which they detect via WT_SESSION — present in Windows Terminal, absent in
    // legacy conhost. `stripHostTerminalEnv` removed it; our embedded xterm DOES
    // forward the wheel to the agent (see usesNativeTuiScroll in terminalStore),
    // so advertise a Windows-Terminal-style session to unlock the agent's native
    // scroll. Scoped to interactive agents; plain shells are untouched.
    // See docs/common-errors/terminals/windows-altscreen-agent-scroll.md
    if (os_1.default.platform() === 'win32' && declaredKind && !nextEnv.WT_SESSION) {
        nextEnv.WT_SESSION = WINDOWS_TERMINAL_SESSION_ID;
    }
    return nextEnv;
}
class PtyManager {
    instances = new Map();
    attributionRootListeners = new Set();
    outputBuffers = new Map();
    // Monotonic across ALL terminals and buffer re-creations — see OutputBuffer.lastSeq.
    chunkSeqCounter = 0;
    // One callback-driven ConPTY input queue per terminal owner. The bounded
    // trace intentionally stores byte counts/ids only, never prompt content.
    writeQueues = new Map();
    windowsWriteTrace = [];
    commandTrackers = new Map();
    didPrepareSpawnHelper = false;
    commandCompletionCallback = null;
    terminalOutputIdleCallback = null;
    idleThresholdMs = 500; // How long to wait before considering terminal idle
    outputIdleThresholdMs = 2000;
    /**
     * Resolved tmux runtime facts, pushed in from outside: main wires
     * TmuxDependencyService (lazy detection with the enriched PATH). Defaults to
     * "unavailable" so a bare PtyManager (unit tests) degrades to direct PTYs
     * instead of shelling out.
     */
    tmuxRuntime;
    constructor(options = {}) {
        this.tmuxRuntime = options.tmuxRuntime ?? types_1.TMUX_UNAVAILABLE_RUNTIME;
        // Windows attribution uses an async process-tree snapshot so MCP calls
        // never block the main thread on per-hop WMIC/PowerShell subprocesses.
        void (0, processAncestry_1.prewarmProcessAncestry)();
    }
    setTmuxRuntime(runtime) {
        this.tmuxRuntime = runtime;
    }
    // Epoch ms each terminal's process was freshly spawned this app session
    // (not set on tmux reattach — the process predates this run). Entries are
    // kept after kill/detach on purpose: the quit-time session-id sweep in
    // index.ts reads them during teardown. Bounded by terminals spawned per run.
    ptySpawnTimes = new Map();
    // Epoch ms of the last Enter-bearing user input per terminal (set in
    // noteTerminalInput). Consumed by session detection as ownership evidence.
    lastSubmitTimes = new Map();
    // Positive terminal↔session ownership evidence. Unlike lastSubmitTimes, the
    // prompt text distinguishes several app/external sessions started together.
    submittedPromptTracker = new submittedPromptTracker_1.SubmittedPromptTracker();
    // Novel-output tracking per terminal: repeated byte-identical chunks
    // (OpenTUI spinner loops) don't advance lastNovelOutputTimes, so run-state
    // consumers can tell "animating" from "progressing" (see
    // shared/terminal/runState.ts). Reset alongside lastSubmitTimes on fresh
    // spawns — a new process is a new stream.
    novelOutputTrackers = new Map();
    lastNovelOutputTimes = new Map();
    // Explicit, process-owned end events (currently OpenCode structured-log
    // failures). Background polling consumes this without waiting for quiet.
    runEndedTimes = new Map();
    tmuxPath = null;
    // Track detached tmux sessions so dashboard can still report them as alive
    detachedTmuxSessions = new Map();
    // Timers to expire detached buffers and sessions
    detachedBufferTimers = new Map();
    detachedSessionTimers = new Map();
    // Desktop TerminalView instances attached through the Electron renderer.
    // Remote Control mirrors can subscribe to PTY output too, but they must not
    // resize a terminal that is currently visible on the desktop.
    desktopAttachmentCounts = new Map();
    // Last dims a desktop pane (TerminalView / popout) applied via pty:resize.
    // Desktop ownership of PTY dims must OUTLIVE pane mounts: the attachment
    // count above drops to 0 on every tab/project switch, and a Remote Control
    // resize in that window reflowed AI TUIs at phone columns — those
    // narrow-wrapped frames are baked into the pipe buffer and scrollback
    // forever (docs/common-errors/remote/remote-resize-desktop-layout.md).
    desktopSizes = new Map();
    // Remote Control mirrors render at the shared PTY's dims; they subscribe
    // here so a desktop refit (window resize, pane drag, reformat) reaches the
    // phone instead of leaving it painting on a stale grid
    // (docs/common-errors/remote/remote-mirror-stale-size-ghosting.md).
    resizeListeners = new Map();
    // Track pending buffer trims to avoid blocking the event loop
    pendingBufferTrims = new Set();
    sessionGenerations = new Map();
    // Memoized notification/dashboard previews. Keyed by terminalId; invalidated
    // when `buffer.lastActivityAt` advances (i.e. new PTY output). Idle terminals
    // hit cache; active streaming terminals fall through to recompute. Bounded
    // by terminal lifetime — entries are deleted alongside outputBuffers.
    previewCache = new Map();
    /**
     * Whether tmux is usable for creates/session ops. Delegates to the injected
     * TmuxRuntime — main-side detection lives in TmuxDependencyService
     * (pty-backend/tmuxService.ts); the daemon is seeded and never detects.
     */
    isTmuxAvailable() {
        return this.tmuxRuntime.isAvailable();
    }
    get tmuxBin() {
        return this.tmuxRuntime.getPath() || 'tmux';
    }
    getTmuxSessionName(terminalId) {
        return tmuxSessionNameForTerminal(terminalId);
    }
    /**
     * Check if a tmux session exists
     */
    hasTmuxSession(terminalId) {
        if (!this.isTmuxAvailable()) {
            return false;
        }
        const sessionName = this.getTmuxSessionName(terminalId);
        try {
            (0, child_process_1.execSync)(`${this.tmuxBin} has-session -t "${sessionName}" 2>/dev/null`, { stdio: 'pipe' });
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * List all 1DevTool tmux sessions
     */
    listTmuxSessions() {
        if (!this.isTmuxAvailable()) {
            return [];
        }
        try {
            const output = (0, child_process_1.execSync)(`${this.tmuxBin} list-sessions -F "#{session_name}" 2>/dev/null`, {
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            return output
                .split('\n')
                .filter((name) => name.startsWith(TMUX_SESSION_PREFIX))
                .map((name) => name.slice(TMUX_SESSION_PREFIX.length));
        }
        catch {
            return [];
        }
    }
    /**
     * Get the scrollback buffer from a tmux session.
     * When excludeVisible=true, returns only history lines BEFORE the current visible pane;
     * used during reattach with alt-screen disabled so we don't duplicate the lines that
     * tmux is about to repaint on top.
     */
    getTmuxScrollback(terminalId, excludeVisible = false) {
        if (!this.isTmuxAvailable()) {
            return '';
        }
        const sessionName = this.getTmuxSessionName(terminalId);
        const endArg = excludeVisible ? '-E -1' : '';
        try {
            const output = (0, child_process_1.execSync)(`${this.tmuxBin} capture-pane -t "${sessionName}" -p -S -${TMUX_HISTORY_LIMIT} ${endArg} 2>/dev/null`, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
            return output;
        }
        catch {
            return '';
        }
    }
    /**
     * Spawn (or tmux-reattach) a terminal from a fully resolved SpawnSpec
     * (docs/architecture/pty-daemon.md §3.3). Policy — cwd resolution, shell candidates,
     * per-candidate env, tmux decision — was computed by the caller
     * (buildSpawnSpec in main); this executes it next to the fd.
     *
     * Returns a discriminated status; 'exists' is an explicit outcome, never
     * conflated with failure (§6.3). Throws on total spawn failure.
     */
    createFromSpec(spec, onData, onExit) {
        this.ensureSpawnHelperExecutable();
        const terminalId = spec.terminalId;
        if (this.instances.has(terminalId)) {
            return { status: 'exists' };
        }
        // Try tmux-based terminal first
        if (spec.useTmux && spec.tmux) {
            try {
                const result = this.createWithTmux(spec, onData, onExit);
                if (result.ok) {
                    if (!result.reattached) {
                        // A reused terminal id now belongs to a brand-new process. Do not
                        // let an Enter from its previous lifetime authorize startup output
                        // to create a run badge.
                        this.lastSubmitTimes.delete(terminalId);
                        this.submittedPromptTracker.reset(terminalId);
                        this.novelOutputTrackers.delete(terminalId);
                        this.lastNovelOutputTimes.delete(terminalId);
                        this.runEndedTimes.delete(terminalId);
                        this.ptySpawnTimes.set(terminalId, Date.now());
                    }
                    return { status: result.reattached ? 'reattached-tmux' : 'created' };
                }
            }
            catch (error) {
                console.warn('Failed to create tmux session, falling back to direct PTY:', error);
            }
        }
        // Fall back to direct PTY (original behavior)
        const created = this.createDirectPty(spec, onData, onExit);
        if (created) {
            // Direct PTYs are always fresh here (live instances returned above).
            this.lastSubmitTimes.delete(terminalId);
            this.submittedPromptTracker.reset(terminalId);
            this.novelOutputTrackers.delete(terminalId);
            this.lastNovelOutputTimes.delete(terminalId);
            this.runEndedTimes.delete(terminalId);
            this.ptySpawnTimes.set(terminalId, Date.now());
        }
        return { status: 'created' };
    }
    /**
     * Epoch ms this terminal's process was freshly spawned this app session.
     * Undefined for tmux reattaches and terminals never started this run.
     */
    getSpawnTime(terminalId) {
        return this.ptySpawnTimes.get(terminalId);
    }
    /**
     * Epoch ms of the last Enter-bearing input the user sent to this terminal.
     * Undefined when nothing was ever submitted this app session.
     */
    getLastSubmitTime(terminalId) {
        return this.lastSubmitTimes.get(terminalId);
    }
    /** Prompt texts submitted through this exact PTY during its current process lifetime. */
    getSubmittedPrompts(terminalId) {
        return this.submittedPromptTracker.read(terminalId);
    }
    /** Record an attributed end only when it belongs to the latest submit. */
    markRunEnded(terminalId, endedAt) {
        const lastSubmitAt = this.lastSubmitTimes.get(terminalId);
        if (!lastSubmitAt || endedAt < lastSubmitAt)
            return false;
        this.runEndedTimes.set(terminalId, Math.max(this.runEndedTimes.get(terminalId) ?? 0, endedAt));
        return true;
    }
    /**
     * Run one tmux invocation carrying several commands chained with literal
     * `;` arguments. Each subprocess spawn costs ~10-40ms of synchronous main
     * thread time, so batching is what keeps terminal creation snappy.
     * CAUTION: tmux ABORTS the remaining commands in a sequence when one fails
     * (verified on tmux 3.6a), so only chain commands that cannot fail on a
     * live server, or accept that a failure drops everything after it.
     */
    execTmux(commands, env) {
        const args = commands.flatMap((command, index) => (index === 0 ? command : [';', ...command]));
        (0, child_process_1.execFileSync)(this.tmuxBin, args, { env, stdio: 'pipe' });
    }
    /** Resolve the process at the root of a tmux pane. Commands launched in the
     * pane descend from this PID (through the shell), whereas they do not descend
     * from node-pty's `tmux attach-session` client. */
    getTmuxPaneRootPid(sessionName, env) {
        try {
            const output = (0, child_process_1.execFileSync)(this.tmuxBin, ['display-message', '-p', '-t', sessionName, '#{pane_pid}'], { env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
            const panePid = Number.parseInt(output.trim(), 10);
            return Number.isInteger(panePid) && panePid > 0 ? panePid : undefined;
        }
        catch {
            return undefined;
        }
    }
    // Options that cannot fail on a live session — safe to chain with
    // new-session in a single tmux invocation.
    tmuxSessionOptionCommands(sessionName, tmuxMouseBehavior) {
        return buildTmuxSessionOptionCommands(sessionName, tmuxMouseBehavior, TMUX_HISTORY_LIMIT);
    }
    applyTmuxSessionOptions(sessionName, env, tmuxMouseBehavior) {
        this.execTmux(this.tmuxSessionOptionCommands(sessionName, tmuxMouseBehavior), env);
        this.applyGuardedTmuxSessionOptions(sessionName, env, tmuxMouseBehavior);
    }
    // Best-effort options whose failure must never fail the create. Batched into
    // one guarded invocation; ordered so the effectively-infallible marker comes
    // first and the genuinely fragile behavior-specific command last (a sequence
    // aborts at the first failing command).
    applyGuardedTmuxSessionOptions(sessionName, env, tmuxMouseBehavior) {
        // Stamp a stable "this tmux server belongs to 1DevTool" marker into the
        // server's GLOBAL environment. Runs on every create AND reattach, so it
        // lands even on a foreign/pre-existing tmux server (e.g. the user's own
        // `tmux`) and even for sessions whose shells were spawned before this
        // marker existed — `set-environment -g` mutates the live server immediately.
        // `npm run dev` reads it back via `tmux show-environment -g ONEDEVTOOL_HOST`
        // to detect that it's running inside a 1DevTool terminal even when tmux has
        // stripped TERM_PROGRAM/ONEDEVTOOL_TERMINAL_ID from the pane's own env, so it
        // isolates its profile instead of quitting the host app that owns the terminal.
        const commands = [
            ['set-environment', '-g', 'ONEDEVTOOL_HOST', '1'],
        ];
        if (tmuxMouseBehavior === 'respect-config') {
            // Older sessions may not have a local mouse override; leave global/user config intact.
            commands.push(['set-option', '-u', '-t', sessionName, 'mouse']);
        }
        // native-selection: strip the alternate-screen capability so tmux output flows into
        // xterm's normal buffer. That lets xterm own scrollback + drag-selection directly,
        // so the user never sees tmux's copy-mode chrome (the `13:50 [70/183]` indicator at
        // top-right) when scrolling up. force-on/respect-config still want alt-screen because
        // they rely on tmux to render scrollback via copy-mode.
        //
        // terminal-overrides is a server option (not session-scoped), so this affects every
        // session on the same tmux server. Side effect is mild (no alt-screen → vim/less leave
        // content in scrollback on exit, a common preference). Older tmux may not support
        // -sa append on this option; safe to ignore.
        if (tmuxMouseBehavior === 'native-selection') {
            commands.push(['set-option', '-sa', 'terminal-overrides', ',*:smcup@:rmcup@']);
        }
        try {
            this.execTmux(commands, env);
        }
        catch {
            // Non-fatal: worst case loses the dev-launcher nested-detection hint or
            // the behavior-specific mouse/alt-screen tweak on very old tmux.
        }
    }
    createWithTmux(spec, onData, onExit) {
        const { terminalId, cwd, tmuxMouseBehavior } = spec;
        const tmuxSpec = spec.tmux;
        const sessionName = tmuxSpec.sessionName;
        const candidate = spec.candidates[0];
        if (!candidate) {
            return { ok: false, reattached: false };
        }
        const shellPath = candidate.executable;
        const env = candidate.resolveEnv();
        const sessionExists = this.hasTmuxSession(terminalId);
        // Clear detached tracking — we're reattaching (or creating fresh)
        this.detachedTmuxSessions.delete(terminalId);
        this.clearDetachTimers(terminalId);
        if (!sessionExists) {
            // Create new tmux session (detached) with status bar disabled.
            //
            // `-e ONEDEVTOOL_TERMINAL_ID=...` forces our per-terminal marker into the
            // new session's environment. Without it, when the tmux *server* already
            // exists (e.g. the user's own tmux, or a server left over from a previous
            // launch), the spawned shell inherits the server's stale/missing global
            // env instead of the value we passed via `env` below — leaving the shell
            // (and anything run in it, like `npm run dev`) with no ONEDEVTOOL_TERMINAL_ID.
            // tmux also unconditionally overrides TERM_PROGRAM=tmux inside panes, so
            // ONEDEVTOOL_TERMINAL_ID is the only reliable "inside 1DevTool" signal here.
            const envFlagArgs = tmuxSpec.supportsEnvFlag
                ? ['-e', `${mcpTerminalIdentity_1.ONEDEVTOOL_TERMINAL_ID_ENV}=${terminalId}`]
                : [];
            try {
                // Session creation and the safe options ride ONE tmux invocation —
                // batching subprocess spawns is the difference between ~7 and ~3
                // blocking execs per terminal open.
                this.execTmux([
                    ['new-session', ...envFlagArgs, '-d', '-s', sessionName, '-c', cwd, shellPath],
                    ...this.tmuxSessionOptionCommands(sessionName, tmuxMouseBehavior),
                ], env);
                this.applyGuardedTmuxSessionOptions(sessionName, env, tmuxMouseBehavior);
            }
            catch (error) {
                console.error('Failed to create tmux session:', error);
                return { ok: false, reattached: false };
            }
        }
        else {
            // Ensure settings are applied for existing sessions too
            try {
                this.applyTmuxSessionOptions(sessionName, env, tmuxMouseBehavior);
            }
            catch {
                // Ignore if session doesn't exist yet
            }
        }
        // Attach to the session via PTY
        const ptyProcess = pty.spawn(tmuxSpec.path, ['attach-session', '-t', sessionName], {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd,
            env,
        });
        const sessionGeneration = this.nextSessionGeneration(terminalId);
        const attributionRootPid = this.getTmuxPaneRootPid(sessionName, env);
        this.instances.set(terminalId, {
            pty: ptyProcess,
            terminalId,
            useTmux: true,
            tmuxSessionName: sessionName,
            attributionRootPid,
            tmuxMouseBehavior,
            preserveOpenTuiReplayModes: spec.preserveOpenTuiReplayModes,
            sessionGeneration,
        });
        this.emitAttributionRootsChanged();
        // Auto-start capture for session persistence
        this.startCapture(terminalId);
        // If reattaching, send existing scrollback to buffer.
        // In native-selection mode tmux's alt-screen is disabled, so the live tmux client
        // will repaint the visible pane into xterm's normal buffer. To avoid duplicating
        // those rows, emit only history that's ABOVE the visible viewport. The full
        // capture (including visible) still goes into outputBuffer so a later UI remount
        // can rehydrate without needing tmux.
        if (sessionExists) {
            const altScreenDisabled = tmuxMouseBehavior === 'native-selection';
            const fullScrollback = this.getTmuxScrollback(terminalId);
            const emitScrollback = altScreenDisabled
                ? this.getTmuxScrollback(terminalId, true)
                : fullScrollback;
            if (fullScrollback) {
                const filteredFull = (0, replay_1.sanitizeReplayBuffer)(fullScrollback);
                const buffer = this.outputBuffers.get(terminalId);
                if (buffer && filteredFull) {
                    buffer.content = filteredFull;
                }
            }
            if (emitScrollback) {
                const filteredEmit = (0, replay_1.sanitizeReplayBuffer)(emitScrollback);
                if (filteredEmit) {
                    onData?.(filteredEmit);
                }
            }
        }
        ptyProcess.onData((data) => {
            const seq = this.handlePtyData(terminalId, data);
            onData?.(data, seq ?? undefined);
        });
        ptyProcess.onExit(({ exitCode }) => {
            // When tmux attach exits, it means we detached — session may still be alive.
            // If the instance was already removed (by detach()), the exit is expected.
            const instance = this.instances.get(terminalId);
            if (!instance) {
                // Already cleaned up by detach() — nothing to do
                return;
            }
            if (instance.useTmux && this.hasTmuxSession(terminalId)) {
                // Session still exists, we just detached
                onExit?.(0);
            }
            else {
                onExit?.(exitCode);
            }
            this.discardWriteQueue(terminalId, 'pty-exited');
            this.instances.delete(terminalId);
            this.emitAttributionRootsChanged();
            // The attach client is gone, but node-pty's EIO path may have skipped its
            // own socket teardown — close the master before the reference is dropped.
            (0, ptyRelease_1.releaseExitedPty)(ptyProcess);
        });
        // Send startup command for new sessions
        if (!sessionExists && spec.startupWrite) {
            const startupWrite = spec.startupWrite;
            setTimeout(() => {
                if (process.platform === 'win32') {
                    void this.enqueueWindowsWrite(terminalId, startupWrite, { requireCompletion: false });
                    return;
                }
                try {
                    ptyProcess.write(startupWrite);
                }
                catch {
                    // EIO: PTY may have exited before startup command was sent
                }
            }, 150);
        }
        return { ok: true, reattached: sessionExists };
    }
    createDirectPty(spec, onData, onExit) {
        const { terminalId, cwd, tmuxMouseBehavior } = spec;
        let lastError;
        for (const candidate of spec.candidates) {
            try {
                // Env materializes lazily PER ATTEMPT — a login-shell probe costs
                // 200ms–3s, so only candidates actually tried may pay it (§3.3).
                const env = candidate.resolveEnv();
                const ptyProcess = pty.spawn(candidate.executable, candidate.args, {
                    name: 'xterm-256color',
                    cols: 80,
                    rows: 24,
                    cwd,
                    env,
                });
                const sessionGeneration = this.nextSessionGeneration(terminalId);
                this.instances.set(terminalId, {
                    pty: ptyProcess,
                    terminalId,
                    useTmux: false,
                    tmuxMouseBehavior,
                    preserveOpenTuiReplayModes: spec.preserveOpenTuiReplayModes,
                    sessionGeneration,
                });
                this.emitAttributionRootsChanged();
                // Auto-start capture for session persistence
                this.startCapture(terminalId);
                ptyProcess.onData((data) => {
                    const seq = this.handlePtyData(terminalId, data);
                    onData?.(data, seq ?? undefined);
                });
                ptyProcess.onExit(({ exitCode }) => {
                    onExit?.(exitCode);
                    this.discardWriteQueue(terminalId, 'pty-exited');
                    this.instances.delete(terminalId);
                    this.emitAttributionRootsChanged();
                    // node-pty's EIO path can emit 'close' without destroying the socket;
                    // close the master here so the fd never outlives the instance.
                    (0, ptyRelease_1.releaseExitedPty)(ptyProcess);
                });
                if (spec.startupWrite) {
                    const startupWrite = spec.startupWrite;
                    setTimeout(() => {
                        if (process.platform === 'win32') {
                            void this.enqueueWindowsWrite(terminalId, startupWrite, { requireCompletion: false });
                            return;
                        }
                        try {
                            ptyProcess.write(startupWrite);
                        }
                        catch {
                            // EIO: PTY may have exited before startup command was sent
                        }
                    }, 150);
                }
                return true;
            }
            catch (error) {
                lastError = error;
            }
        }
        const message = lastError instanceof Error ? lastError.message : 'Unknown PTY error';
        throw new Error(`Failed to start terminal in ${cwd}: ${message}`);
    }
    write(terminalId, data) {
        const instance = this.instances.get(terminalId);
        if (instance) {
            this.submittedPromptTracker.feed(terminalId, data);
            this.noteTerminalInput(terminalId, data);
            // Windows: pace writes into ConPTY. A single large write (multi-line
            // Agent Input prompt, big paste) overflows conhost's input pipeline and
            // the tail is silently dropped — the ">10 pasted lines get cut off" bug.
            // See docs/common-errors/terminals/windows-paste-truncation.md.
            if (process.platform === 'win32') {
                void this.enqueueWindowsWrite(terminalId, data, { requireCompletion: false });
                return;
            }
            try {
                instance.pty.write(data);
            }
            catch {
                // EIO: PTY process exited before write completed — ignore
            }
        }
    }
    /** Owner-fenced logical input. On Windows, success requires every private
     * node-pty input-socket callback; off Windows the existing synchronous PTY
     * write contract remains unchanged. */
    writeWithCompletion(terminalId, data, options = {}) {
        const instance = this.instances.get(terminalId);
        if (!instance || (options.expectedGeneration !== undefined && instance.sessionGeneration !== options.expectedGeneration)) {
            return Promise.resolve({
                status: 'owner-changed',
                logicalWriteId: (0, crypto_1.randomUUID)(),
                bytesAttempted: 0,
                bytesCompleted: 0,
                chunksAttempted: 0,
                chunksCompleted: 0,
                enterAttempted: false,
                enterPipeCompleted: false,
                reason: 'owner-mismatch',
            });
        }
        this.submittedPromptTracker.feed(terminalId, data);
        this.noteTerminalInput(terminalId, data);
        if (process.platform === 'win32') {
            return this.enqueueWindowsWrite(terminalId, data, {
                ...options,
                requireCompletion: true,
            });
        }
        const logicalWriteId = (0, crypto_1.randomUUID)();
        const bytes = Buffer.byteLength(data, 'utf8');
        try {
            instance.pty.write(data);
            return Promise.resolve({
                status: 'pipe-completed',
                logicalWriteId,
                bytesAttempted: bytes,
                bytesCompleted: bytes,
                chunksAttempted: data ? 1 : 0,
                chunksCompleted: data ? 1 : 0,
                enterAttempted: options.partKind === 'submit-enter',
                enterPipeCompleted: options.partKind === 'submit-enter',
            });
        }
        catch (error) {
            return Promise.resolve({
                status: 'transport-uncertain',
                logicalWriteId,
                bytesAttempted: bytes,
                bytesCompleted: 0,
                chunksAttempted: data ? 1 : 0,
                chunksCompleted: 0,
                enterAttempted: options.partKind === 'submit-enter',
                enterPipeCompleted: false,
                reason: error instanceof Error ? error.message : 'pty-write-threw',
            });
        }
    }
    enqueueWindowsWrite(terminalId, data, options) {
        let queue = this.writeQueues.get(terminalId);
        if (!queue) {
            queue = new windowsPtyWriteQueue_1.WindowsPtyWriteQueue({
                terminalId,
                getCurrentTarget: () => this.windowsWriteTarget(terminalId),
                onTrace: (event) => this.recordWindowsWriteTrace(event),
                onIdle: () => {
                    if (this.writeQueues.get(terminalId) === queue)
                        this.writeQueues.delete(terminalId);
                },
            });
            this.writeQueues.set(terminalId, queue);
        }
        return queue.enqueue(data, options);
    }
    windowsWriteTarget(terminalId) {
        const instance = this.instances.get(terminalId);
        if (!instance)
            return null;
        return {
            token: instance,
            generation: instance.sessionGeneration,
            pty: instance.pty,
        };
    }
    recordWindowsWriteTrace(event) {
        this.windowsWriteTrace.push(event);
        if (this.windowsWriteTrace.length > 2_000) {
            this.windowsWriteTrace.splice(0, this.windowsWriteTrace.length - 2_000);
        }
        if (event.status === 'transport-uncertain' ||
            event.status === 'capability-unavailable' ||
            event.status === 'owner-lost-uncertain') {
            console.warn('[conpty-input]', JSON.stringify(event));
        }
        else if (process.env.ONEDEVTOOL_CONPTY_TRACE === '1') {
            // Explicit support/test opt-in. The event contains ids, timestamps, and
            // byte counts only; prompt content is never recorded.
            console.info('[conpty-input]', JSON.stringify(event));
        }
    }
    /** Bounded, content-free support evidence. */
    getWindowsPtyWriteTrace(terminalId) {
        return this.windowsWriteTrace.filter((event) => !terminalId || event.terminalId === terminalId);
    }
    discardWriteQueue(terminalId, reason = 'owner-disposed') {
        const queue = this.writeQueues.get(terminalId);
        if (!queue)
            return;
        queue.discard(reason);
        this.writeQueues.delete(terminalId);
    }
    /**
     * Raw-input barrier. On Windows it waits for the requests present at the
     * barrier to reach a typed terminal state. Programmatic input uses per-part
     * completion and a per-fence barrier instead.
     */
    async flushWrites(terminalId) {
        const queue = this.writeQueues.get(terminalId);
        if (!queue)
            return;
        await queue.flush();
    }
    resize(terminalId, cols, rows) {
        const instance = this.instances.get(terminalId);
        if (instance) {
            const changed = Number(instance.pty.cols) !== cols || Number(instance.pty.rows) !== rows;
            try {
                instance.pty.resize(cols, rows);
            }
            catch {
                // EIO: PTY process exited before resize — ignore
                return;
            }
            if (changed) {
                const listeners = this.resizeListeners.get(terminalId);
                if (listeners) {
                    for (const listener of listeners)
                        listener({ cols, rows });
                }
            }
        }
    }
    /**
     * Pause/resume the fd read side for application-level output flow control.
     * The utility PTY host uses this when unacknowledged renderer batches cross
     * its high/low watermarks. This is intentionally separate from node-pty's
     * XON/XOFF input handling: Ctrl-S/Ctrl-Q remain ordinary terminal input.
     */
    pauseOutput(terminalId) {
        try {
            this.instances.get(terminalId)?.pty.pause();
        }
        catch {
            // The process may have exited between the lookup and pause.
        }
    }
    resumeOutput(terminalId) {
        try {
            this.instances.get(terminalId)?.pty.resume();
        }
        catch {
            // The process may have exited between the lookup and resume.
        }
    }
    getSize(terminalId) {
        const instance = this.instances.get(terminalId);
        if (!instance)
            return null;
        const cols = Number(instance.pty.cols);
        const rows = Number(instance.pty.rows);
        if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
            return null;
        }
        return { cols, rows };
    }
    setDesktopAttachmentCount(terminalId, count) {
        if (count <= 0) {
            this.desktopAttachmentCounts.delete(terminalId);
            return;
        }
        this.desktopAttachmentCounts.set(terminalId, count);
    }
    hasDesktopAttachment(terminalId) {
        return (this.desktopAttachmentCounts.get(terminalId) ?? 0) > 0;
    }
    /**
     * Remember the dims a desktop pane applied. Called from the `pty:resize`
     * IPC — the channel only desktop TerminalViews/popouts use (Remote Control
     * goes through the socket handler). Once recorded, the desktop owns this
     * terminal's layout for the rest of the app session, mounted or not.
     */
    recordDesktopSize(terminalId, cols, rows) {
        if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) {
            return;
        }
        this.desktopSizes.set(terminalId, { cols, rows });
    }
    getDesktopSize(terminalId) {
        return this.desktopSizes.get(terminalId) ?? null;
    }
    /**
     * Detach from a terminal without killing the underlying session.
     * For tmux terminals, the session continues running.
     * For direct PTY terminals, this is equivalent to kill.
     */
    detach(terminalId) {
        const instance = this.instances.get(terminalId);
        if (!instance) {
            return;
        }
        if (instance.useTmux && instance.tmuxSessionName) {
            // Track the detached session so dashboard can still report it as alive
            const buffer = this.outputBuffers.get(terminalId);
            this.detachedTmuxSessions.set(terminalId, {
                tmuxSessionName: instance.tmuxSessionName,
                lastActivityAt: buffer?.lastActivityAt ?? Date.now(),
            });
            // Send tmux detach command
            try {
                (0, child_process_1.execSync)(`${this.tmuxBin} detach-client -s "${instance.tmuxSessionName}"`, { stdio: 'pipe' });
            }
            catch {
                // Detach may fail if already detached, that's ok
            }
        }
        // Kill the PTY process (the tmux attach process, not the session) and
        // release its master fd. This is the HOT teardown path — it runs on every
        // project switch, so a stranded fd here leaks per switch, not per quit.
        this.discardWriteQueue(terminalId, 'terminal-detached');
        (0, ptyRelease_1.releasePty)(instance.pty);
        this.instances.delete(terminalId);
        this.emitAttributionRootsChanged();
        // Clean up trackers but keep buffer for potential reattach
        const tracker = this.commandTrackers.get(terminalId);
        if (tracker?.idleCheckTimer) {
            clearTimeout(tracker.idleCheckTimer);
        }
        if (tracker?.outputIdleTimer) {
            clearTimeout(tracker.outputIdleTimer);
        }
        this.commandTrackers.delete(terminalId);
        // Schedule buffer expiration (5 min) — frees memory if never reattached
        const bufferTimer = setTimeout(() => {
            this.detachedBufferTimers.delete(terminalId);
            this.outputBuffers.delete(terminalId);
            this.previewCache.delete(terminalId);
        }, 5 * 60 * 1000);
        this.detachedBufferTimers.set(terminalId, bufferTimer);
        // Schedule session expiration (30 min) — kills the tmux session itself if never reattached,
        // otherwise the tmux server keeps scrollback (~50K lines) alive forever.
        if (instance.useTmux && instance.tmuxSessionName) {
            const tmuxSessionName = instance.tmuxSessionName;
            const sessionTimer = setTimeout(() => {
                this.detachedSessionTimers.delete(terminalId);
                this.detachedTmuxSessions.delete(terminalId);
                try {
                    (0, child_process_1.execSync)(`${this.tmuxBin} kill-session -t "${tmuxSessionName}"`, { stdio: 'pipe' });
                }
                catch {
                    // Session may already be dead
                }
                // Also drop any lingering buffer (buffer timer should have fired earlier, but be safe)
                const bt = this.detachedBufferTimers.get(terminalId);
                if (bt) {
                    clearTimeout(bt);
                    this.detachedBufferTimers.delete(terminalId);
                }
                this.outputBuffers.delete(terminalId);
                this.previewCache.delete(terminalId);
            }, 30 * 60 * 1000);
            this.detachedSessionTimers.set(terminalId, sessionTimer);
        }
    }
    /**
     * Kill a terminal and its underlying session completely.
     * For tmux terminals, this kills the tmux session.
     * Use this when the user explicitly closes a terminal tab.
     */
    kill(terminalId) {
        this.discardWriteQueue(terminalId, 'terminal-killed');
        const instance = this.instances.get(terminalId);
        if (instance) {
            if (instance.useTmux && instance.tmuxSessionName) {
                // Kill the tmux session
                try {
                    (0, child_process_1.execSync)(`${this.tmuxBin} kill-session -t "${instance.tmuxSessionName}"`, { stdio: 'pipe' });
                }
                catch {
                    // Session may already be dead
                }
            }
            (0, ptyRelease_1.releasePty)(instance.pty);
            this.instances.delete(terminalId);
            this.emitAttributionRootsChanged();
        }
        else {
            // Instance not attached, but tmux session might exist
            this.killTmuxSession(terminalId);
        }
        // Clean up command tracker and buffer
        const tracker = this.commandTrackers.get(terminalId);
        if (tracker?.idleCheckTimer) {
            clearTimeout(tracker.idleCheckTimer);
        }
        if (tracker?.outputIdleTimer) {
            clearTimeout(tracker.outputIdleTimer);
        }
        this.commandTrackers.delete(terminalId);
        this.outputBuffers.delete(terminalId);
        this.previewCache.delete(terminalId);
        this.desktopSizes.delete(terminalId);
        this.runEndedTimes.delete(terminalId);
        this.detachedTmuxSessions.delete(terminalId);
        this.clearDetachTimers(terminalId);
    }
    clearDetachTimers(terminalId) {
        const bt = this.detachedBufferTimers.get(terminalId);
        if (bt) {
            clearTimeout(bt);
            this.detachedBufferTimers.delete(terminalId);
        }
        const st = this.detachedSessionTimers.get(terminalId);
        if (st) {
            clearTimeout(st);
            this.detachedSessionTimers.delete(terminalId);
        }
    }
    /**
     * Kill a tmux session by terminal ID (even if not currently attached)
     */
    killTmuxSession(terminalId) {
        if (!this.isTmuxAvailable()) {
            return;
        }
        const sessionName = this.getTmuxSessionName(terminalId);
        try {
            (0, child_process_1.execSync)(`${this.tmuxBin} kill-session -t "${sessionName}"`, { stdio: 'pipe' });
        }
        catch {
            // Session may not exist
        }
    }
    /**
     * Detach from all terminals (for app quit).
     * Tmux sessions will continue running and can be reattached.
     */
    detachAll() {
        for (const [id] of this.instances) {
            this.detach(id);
        }
    }
    /**
     * Kill all terminals and their sessions (full cleanup).
     */
    killAll() {
        for (const [id] of this.instances) {
            this.kill(id);
        }
        // Also kill any orphaned tmux sessions
        if (this.isTmuxAvailable()) {
            const sessions = this.listTmuxSessions();
            for (const sessionId of sessions) {
                this.killTmuxSession(sessionId);
            }
        }
    }
    findTerminalByProcessAncestor(pid) {
        return (0, processAncestry_1.findTerminalByAncestry)(pid, this.getRootPidMap());
    }
    getAttributionRoots() {
        const roots = [];
        for (const [terminalId, instance] of this.instances) {
            const pid = instance.attributionRootPid ?? instance.pty.pid;
            if (!Number.isInteger(pid) || pid <= 0)
                continue;
            roots.push({
                terminalId,
                pid,
                sessionGeneration: instance.sessionGeneration,
            });
        }
        return roots;
    }
    onAttributionRootsChanged(callback) {
        this.attributionRootListeners.add(callback);
        callback(this.getAttributionRoots());
        return () => this.attributionRootListeners.delete(callback);
    }
    emitAttributionRootsChanged() {
        if (this.attributionRootListeners.size === 0)
            return;
        const roots = this.getAttributionRoots();
        for (const listener of this.attributionRootListeners) {
            try {
                listener(roots);
            }
            catch {
                // Ownership observation must never break PTY lifecycle.
            }
        }
    }
    /** terminal root process PID → terminalId, for ancestry attribution (D4). */
    getRootPidMap() {
        const terminalByRootPid = new Map();
        for (const [id, instance] of this.instances) {
            const rootPid = instance.attributionRootPid ?? instance.pty.pid;
            if (Number.isInteger(rootPid) && rootPid > 0) {
                terminalByRootPid.set(rootPid, id);
            }
        }
        return terminalByRootPid;
    }
    /** Root process PID of a live terminal (tmux attach process or the shell). */
    getRootPid(terminalId) {
        const instance = this.instances.get(terminalId);
        const rootPid = instance?.attributionRootPid ?? instance?.pty.pid;
        return Number.isInteger(rootPid) && rootPid > 0 ? rootPid : null;
    }
    getStatus(terminalId) {
        const instance = this.instances.get(terminalId);
        if (!instance)
            return null;
        return 'running';
    }
    startCapture(terminalId) {
        this.outputBuffers.set(terminalId, {
            content: '',
            lastActivityAt: Date.now(),
            lastSeq: this.chunkSeqCounter,
            listeners: new Set(),
        });
        this.commandTrackers.set(terminalId, {
            commandStartAt: null,
            wasActive: false,
            idleCheckTimer: null,
            outputBurstStartAt: null,
            outputIdleTimer: null,
            sawPromptSinceStart: false,
            recentOutput: '',
        });
    }
    stopCapture(terminalId) {
        const buffer = this.outputBuffers.get(terminalId);
        this.outputBuffers.delete(terminalId);
        this.previewCache.delete(terminalId);
        const tracker = this.commandTrackers.get(terminalId);
        if (tracker?.idleCheckTimer) {
            clearTimeout(tracker.idleCheckTimer);
        }
        if (tracker?.outputIdleTimer) {
            clearTimeout(tracker.outputIdleTimer);
        }
        this.commandTrackers.delete(terminalId);
        return buffer?.content || '';
    }
    getBuffer(terminalId) {
        return this.outputBuffers.get(terminalId)?.content || '';
    }
    /**
     * Pipe-buffer content plus the seq of its last appended chunk, captured
     * atomically (single-threaded main; no await between the two reads). A
     * remounting renderer replays `content` and drops any deferred live chunk
     * with seq <= this snapshot's seq — the exact-overlap dedup that prevents
     * duplicated streaming output on remount
     * (docs/common-errors/terminals/remount-replay-duplication.md).
     */
    getBufferSnapshot(terminalId) {
        const buffer = this.outputBuffers.get(terminalId);
        return { content: buffer?.content || '', seq: buffer?.lastSeq ?? 0 };
    }
    getAllBuffers() {
        const buffers = {};
        for (const [terminalId, buffer] of this.outputBuffers) {
            if (buffer.content) {
                buffers[terminalId] = buffer.content;
            }
        }
        return buffers;
    }
    clearBuffer(terminalId) {
        const buffer = this.outputBuffers.get(terminalId);
        if (!buffer) {
            return;
        }
        buffer.content = '';
        buffer.lastActivityAt = Date.now();
    }
    clearAllBuffers() {
        let count = 0;
        for (const buffer of this.outputBuffers.values()) {
            if (buffer.content.length > 0) {
                buffer.content = '';
                count++;
            }
        }
        return count;
    }
    isIdle(terminalId, thresholdMs) {
        const buffer = this.outputBuffers.get(terminalId);
        if (!buffer) {
            return true;
        }
        return Date.now() - buffer.lastActivityAt > thresholdMs;
    }
    /** Returns lastActivityAt timestamp for the terminal's output buffer, or null if unknown. */
    getLastActivityAt(terminalId) {
        const buffer = this.outputBuffers.get(terminalId);
        return buffer ? buffer.lastActivityAt : null;
    }
    /**
     * Get the raw PTY instance metadata (for checking tmux status from outside).
     */
    getInstance(terminalId) {
        return this.instances.get(terminalId);
    }
    getSessionGeneration(terminalId) {
        return this.instances.get(terminalId)?.sessionGeneration ?? null;
    }
    nextSessionGeneration(terminalId) {
        const next = (this.sessionGenerations.get(terminalId) ?? 0) + 1;
        this.sessionGenerations.set(terminalId, next);
        return next;
    }
    /**
     * Whether a live PTY instance exists for this terminal. Note this is
     * stricter than getAllStatuses() "isAlive": detached tmux sessions are
     * reported alive there, but have no instance; write()/resize() no-op and
     * onOutput() has no channel until create() reattaches.
     */
    hasLiveInstance(terminalId) {
        return this.instances.has(terminalId);
    }
    /**
     * Whether the live instance is a tmux attach (has a persistent tmux session
     * behind it). Replaces the getInstance() fd-handle leak (docs/architecture/pty-daemon.md
     * §3.2): callers only ever needed this one bit.
     */
    usesTmux(terminalId) {
        const instance = this.instances.get(terminalId);
        return Boolean(instance?.useTmux && instance.tmuxSessionName);
    }
    /**
     * Get status info for ALL active PTY processes (cross-project).
     */
    getAllStatuses() {
        const statuses = {};
        for (const [id] of this.instances) {
            const buffer = this.outputBuffers.get(id);
            statuses[id] = {
                isAlive: true,
                lastActivityAt: buffer?.lastActivityAt ?? 0,
                lastSubmitAt: this.lastSubmitTimes.get(id) ?? 0,
                lastNovelActivityAt: this.lastNovelOutputTimes.get(id) ?? buffer?.lastActivityAt ?? 0,
                lastRunEndedAt: this.runEndedTimes.get(id),
            };
        }
        // Include detached tmux sessions so dashboard still shows them as alive
        for (const [id, meta] of this.detachedTmuxSessions) {
            if (!statuses[id]) {
                statuses[id] = {
                    isAlive: true,
                    lastActivityAt: meta.lastActivityAt,
                    lastSubmitAt: this.lastSubmitTimes.get(id) ?? 0,
                    lastNovelActivityAt: meta.lastActivityAt,
                    lastRunEndedAt: this.runEndedTimes.get(id),
                };
            }
        }
        return statuses;
    }
    /**
     * Get last N characters of output buffer for preview cards (ANSI-stripped).
     * When `agentType` is an AI agent, additionally strip TUI chrome (prompt-box
     * borders, status/footer lines, "accept edits" banner, etc.) so the preview
     * surfaces the actual response instead of empty box borders.
     *
     * Performance:
     *   - Slices the last PREVIEW_TAIL_BYTES of buffer.content BEFORE stripAnsi,
     *     so cost is O(1) regardless of session length (buffer may be hundreds
     *     of KB for long Claude sessions).
     *   - Memoizes by (terminalId, lastActivityAt, maxChars, agentType). Idle
     *     terminals — the common state when the dashboard polls — hit cache.
     */
    getBufferPreview(terminalId, maxChars = 200, agentType) {
        const buffer = this.outputBuffers.get(terminalId);
        if (!buffer) {
            // For detached tmux sessions, try capture-pane as fallback
            const detached = this.detachedTmuxSessions.get(terminalId);
            if (detached && this.isTmuxAvailable()) {
                try {
                    const paneContent = (0, child_process_1.execSync)(`${this.tmuxBin} capture-pane -t "${detached.tmuxSessionName}" -p -S -20`, { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 2000 });
                    return (0, terminalPreview_1.buildTerminalPreview)(paneContent, maxChars, agentType);
                }
                catch {
                    return null;
                }
            }
            return null;
        }
        const cached = this.previewCache.get(terminalId);
        if (cached &&
            cached.activityTs === buffer.lastActivityAt &&
            cached.maxChars === maxChars &&
            cached.agentType === agentType) {
            return cached.value;
        }
        // Only the tail can produce the trailing `maxChars` of meaningful content.
        // 8 KiB comfortably covers ~80–100 chrome-heavy lines, far more than the
        // loop will inspect before filling the maxChars budget. The first ANSI
        // sequence in the slice may be truncated, but stripAnsi tolerates that
        // and the resulting noise sits outside our window.
        const PREVIEW_TAIL_BYTES = 8192;
        const tail = buffer.content.length > PREVIEW_TAIL_BYTES
            ? buffer.content.slice(-PREVIEW_TAIL_BYTES)
            : buffer.content;
        const result = (0, terminalPreview_1.buildTerminalPreview)(tail, maxChars, agentType);
        this.previewCache.set(terminalId, {
            activityTs: buffer.lastActivityAt,
            maxChars,
            agentType,
            value: result,
        });
        return result;
    }
    onOutput(terminalId, callback) {
        const buffer = this.outputBuffers.get(terminalId);
        if (!buffer) {
            return () => { };
        }
        buffer.listeners.add(callback);
        return () => buffer.listeners.delete(callback);
    }
    onResize(terminalId, callback) {
        let listeners = this.resizeListeners.get(terminalId);
        if (!listeners) {
            listeners = new Set();
            this.resizeListeners.set(terminalId, listeners);
        }
        listeners.add(callback);
        return () => {
            listeners.delete(callback);
            if (listeners.size === 0)
                this.resizeListeners.delete(terminalId);
        };
    }
    onCommandCompletion(callback) {
        this.commandCompletionCallback = callback;
    }
    onTerminalOutputIdle(callback) {
        this.terminalOutputIdleCallback = callback;
    }
    getCommandElapsed(terminalId) {
        const tracker = this.commandTrackers.get(terminalId);
        if (!tracker || tracker.commandStartAt === null) {
            return null;
        }
        return Date.now() - tracker.commandStartAt;
    }
    /**
     * Append a live PTY chunk to the pipe buffer and fan it out to listeners.
     * Returns the pipe-buffer sequence number assigned to this chunk, or null
     * when nothing was appended (no buffer, or the chunk sanitized to empty) —
     * callers forwarding the raw chunk anyway must pass seq as undefined so the
     * renderer never drops it against a snapshot that doesn't contain it.
     */
    handlePtyData(terminalId, data) {
        const buffer = this.outputBuffers.get(terminalId);
        if (!buffer) {
            return null;
        }
        const instance = this.instances.get(terminalId);
        const altScreenDisabled = Boolean(instance && instance.useTmux && instance.tmuxMouseBehavior === 'native-selection');
        // Keep mouse-tracking CSI so nested mouse-first apps (herdr, lazygit,
        // nested tmux) can enable tracking. Soft-clear rewrite for native-selection
        // is independent. See tmux-prefix-steals-nested-multiplexer.md.
        const filteredData = (0, replay_1.sanitizeLivePtyChunk)(data, {
            stripMouseTracking: false,
            // When alt-screen is disabled, every tmux redraw / `clear` sends CSI 2 J,
            // which xterm.js implements as "push viewport into scrollback + clear".
            // Without this rewrite, normal terminals accumulate empty rows in
            // scrollback on attach and on every shell-issued clear (see
            // docs/common-errors/terminals/normal-terminal-empty-scrollback.md).
            rewriteSoftClear: altScreenDisabled,
        });
        if (!filteredData) {
            return null;
        }
        buffer.lastSeq = ++this.chunkSeqCounter;
        buffer.content += filteredData;
        // Defer expensive trim to next tick so it doesn't block event loop during heavy output
        if (buffer.content.length > MAX_BUFFER_SIZE && !this.pendingBufferTrims.has(terminalId)) {
            this.pendingBufferTrims.add(terminalId);
            setImmediate(() => {
                this.pendingBufferTrims.delete(terminalId);
                const buf = this.outputBuffers.get(terminalId);
                if (buf && buf.content.length > MAX_BUFFER_SIZE) {
                    const preserveOpenTuiReplayModes = this.instances.get(terminalId)?.preserveOpenTuiReplayModes === true;
                    buf.content = preserveOpenTuiReplayModes
                        ? (0, replay_1.trimReplayBufferPreservingModes)(buf.content, MAX_BUFFER_SIZE / 2)
                        : buf.content.slice(-(MAX_BUFFER_SIZE / 2));
                }
            });
        }
        buffer.lastActivityAt = Date.now();
        let tracker = this.novelOutputTrackers.get(terminalId);
        if (!tracker) {
            tracker = (0, runState_1.createNovelOutputTracker)();
            this.novelOutputTrackers.set(terminalId, tracker);
        }
        if (tracker.note(data)) {
            this.lastNovelOutputTimes.set(terminalId, buffer.lastActivityAt);
        }
        const seq = buffer.lastSeq;
        buffer.listeners.forEach((listener) => listener(data, seq));
        // Track command activity for completion notifications
        this.trackCommandActivity(terminalId, data);
        this.trackOutputIdle(terminalId, data);
        return seq;
    }
    trackCommandActivity(terminalId, data) {
        let tracker = this.commandTrackers.get(terminalId);
        if (!tracker) {
            tracker = {
                commandStartAt: null,
                wasActive: false,
                idleCheckTimer: null,
                outputBurstStartAt: null,
                outputIdleTimer: null,
                sawPromptSinceStart: false,
                recentOutput: '',
            };
            this.commandTrackers.set(terminalId, tracker);
        }
        // If we weren't active before, this is the start of a new command
        if (!tracker.wasActive) {
            tracker.commandStartAt = Date.now();
            tracker.wasActive = true;
            tracker.sawPromptSinceStart = false;
            tracker.recentOutput = '';
        }
        const normalizedOutput = this.normalizeOutputForPromptDetection(data);
        if (normalizedOutput) {
            tracker.recentOutput = (tracker.recentOutput + normalizedOutput).slice(-400);
            if (this.outputLooksLikePrompt(tracker.recentOutput)) {
                tracker.sawPromptSinceStart = true;
            }
        }
        // Clear any existing idle check timer
        if (tracker.idleCheckTimer) {
            clearTimeout(tracker.idleCheckTimer);
        }
        // Set up a new idle check timer
        tracker.idleCheckTimer = setTimeout(() => {
            this.checkCommandCompletion(terminalId);
        }, this.idleThresholdMs);
    }
    checkCommandCompletion(terminalId) {
        const tracker = this.commandTrackers.get(terminalId);
        if (!tracker || !tracker.wasActive || tracker.commandStartAt === null) {
            return;
        }
        if (!tracker.sawPromptSinceStart) {
            tracker.idleCheckTimer = null;
            return;
        }
        const elapsedMs = Date.now() - tracker.commandStartAt;
        // Notify about command completion
        if (this.commandCompletionCallback) {
            this.commandCompletionCallback(terminalId, elapsedMs);
        }
        // Reset tracker for next command
        tracker.commandStartAt = null;
        tracker.wasActive = false;
        tracker.idleCheckTimer = null;
        tracker.sawPromptSinceStart = false;
        tracker.recentOutput = '';
    }
    noteTerminalInput(terminalId, data) {
        if (!/[\r\n]/.test(data)) {
            return;
        }
        // Session-detection ownership signal: the user pressed Enter in THIS
        // terminal. Agent session files are born on the first prompt submit, so a
        // terminal whose last submit is nowhere near a session's start time cannot
        // be the terminal that conversation belongs to (see
        // docs/common-errors/terminals/session-detect-remount-disarm-steal.md).
        // Focus reports (\x1b[I / \x1b[O) and bare keystrokes carry no \r|\n and
        // never reach this point.
        this.lastSubmitTimes.set(terminalId, Date.now());
        this.runEndedTimes.delete(terminalId);
        let tracker = this.commandTrackers.get(terminalId);
        if (!tracker) {
            tracker = {
                commandStartAt: null,
                wasActive: false,
                idleCheckTimer: null,
                outputBurstStartAt: null,
                outputIdleTimer: null,
                sawPromptSinceStart: false,
                recentOutput: '',
            };
            this.commandTrackers.set(terminalId, tracker);
        }
        if (tracker.idleCheckTimer) {
            clearTimeout(tracker.idleCheckTimer);
        }
        if (tracker.outputIdleTimer) {
            clearTimeout(tracker.outputIdleTimer);
        }
        tracker.commandStartAt = Date.now();
        tracker.wasActive = true;
        tracker.idleCheckTimer = null;
        tracker.outputBurstStartAt = null;
        tracker.outputIdleTimer = null;
        tracker.sawPromptSinceStart = false;
        tracker.recentOutput = '';
    }
    trackOutputIdle(terminalId, data) {
        const tracker = this.commandTrackers.get(terminalId);
        if (!tracker) {
            return;
        }
        const normalizedOutput = this.normalizeOutputForPromptDetection(data).trim();
        if (!normalizedOutput) {
            return;
        }
        if (tracker.outputBurstStartAt === null) {
            tracker.outputBurstStartAt = Date.now();
        }
        if (tracker.outputIdleTimer) {
            clearTimeout(tracker.outputIdleTimer);
        }
        tracker.outputIdleTimer = setTimeout(() => {
            this.checkOutputIdle(terminalId);
        }, this.outputIdleThresholdMs);
    }
    checkOutputIdle(terminalId) {
        const tracker = this.commandTrackers.get(terminalId);
        if (!tracker || tracker.outputBurstStartAt === null) {
            return;
        }
        const elapsedMs = Date.now() - tracker.outputBurstStartAt;
        tracker.outputBurstStartAt = null;
        tracker.outputIdleTimer = null;
        if (this.terminalOutputIdleCallback) {
            this.terminalOutputIdleCallback(terminalId, elapsedMs);
        }
    }
    normalizeOutputForPromptDetection(data) {
        return data
            .replace(/\u001b\][^\u0007]*\u0007/g, '')
            .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
            .replace(/\u001b[@-_]/g, '');
    }
    outputLooksLikePrompt(output) {
        const lines = output.replace(/\r/g, '\n').split('\n').map((line) => line.trimEnd()).filter(Boolean);
        const lastLine = lines.at(-1) || '';
        return /(?:[%$#]|❯|>)$/.test(lastLine);
    }
    ensureSpawnHelperExecutable() {
        if (this.didPrepareSpawnHelper || os_1.default.platform() === 'win32') {
            return;
        }
        // Chmod EVERY existing candidate, not just the first executable one:
        // node-pty picks its helper by which pty.node loaded (build/Release vs the
        // prebuilds fallback), and packaged prebuilds have shipped without the
        // exec bit — a non-executable sibling in the dir node-pty actually uses
        // fails spawn with "posix_spawnp failed." even when another candidate is
        // fine (docs/common-errors/terminals/pty-daemon-unpacked-helper-path.md).
        let sawAnyHelper = false;
        for (const helperPath of this.getSpawnHelperCandidates()) {
            if (!fs_1.default.existsSync(helperPath)) {
                continue;
            }
            sawAnyHelper = true;
            try {
                fs_1.default.accessSync(helperPath, fs_1.default.constants.X_OK);
            }
            catch {
                try {
                    fs_1.default.chmodSync(helperPath, 0o755);
                }
                catch {
                    // Read-only install dir — nothing more we can do for this one.
                }
            }
        }
        if (sawAnyHelper) {
            this.didPrepareSpawnHelper = true;
        }
    }
    getSpawnHelperCandidates() {
        const nodePtyDir = path_1.default.dirname(require.resolve('node-pty/package.json'));
        // Guard the asar rewrites: when node-pty already resolved to an unpacked
        // path (any ELECTRON_RUN_AS_NODE child under app.asar.unpacked), the naive
        // replace fabricates a bogus `app.asar.unpacked.unpacked` root — same bug
        // class as node-pty's own helper-path rewrite
        // (pty-daemon-unpacked-helper-path.md, rule F8).
        const candidateRoots = this.dedupe([
            nodePtyDir,
            nodePtyDir.includes('app.asar.unpacked') ? undefined : nodePtyDir.replace('app.asar', 'app.asar.unpacked'),
            nodePtyDir.includes('node_modules.asar.unpacked')
                ? undefined
                : nodePtyDir.replace('node_modules.asar', 'node_modules.asar.unpacked'),
        ]);
        return this.dedupe(candidateRoots.flatMap((root) => ([
            path_1.default.join(root, 'build/Release/spawn-helper'),
            path_1.default.join(root, 'build/Debug/spawn-helper'),
            path_1.default.join(root, `prebuilds/${process.platform}-${process.arch}/spawn-helper`),
        ])));
    }
    dedupe(entries) {
        const uniqueEntries = new Set();
        for (const entry of entries) {
            const normalized = entry?.trim();
            if (!normalized) {
                continue;
            }
            uniqueEntries.add(normalized);
        }
        return [...uniqueEntries];
    }
}
exports.PtyManager = PtyManager;
