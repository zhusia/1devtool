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
exports.configureRendererTerminalRequestWindow = configureRendererTerminalRequestWindow;
exports.configureRemoteTerminalInputObserver = configureRemoteTerminalInputObserver;
exports.requestRendererCreateTerminal = requestRendererCreateTerminal;
exports.registerTerminalHandlers = registerTerminalHandlers;
const electron_1 = require("electron");
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const replay_1 = require("../../../shared/terminal/replay");
const aiAccounts = __importStar(require("../../aiAccounts"));
const registry_1 = require("../../aiAccounts/registry");
const assignments_1 = require("../../aiPool/assignments");
const aiPreviewState_1 = require("../../aiPreviewState");
const types_1 = require("../../../shared/types");
const permission_1 = require("../middleware/permission");
const promptSubmit_1 = require("../promptSubmit");
const terminalSizePolicy_1 = require("../terminalSizePolicy");
const scheduledPrompts_1 = require("../scheduledPrompts");
const contracts_1 = require("../../../shared/terminal/contracts");
const replay_2 = require("../../../shared/terminal/replay");
const agentCommands_1 = require("../../../shared/terminal/agentCommands");
const modelDetect_1 = require("../../../shared/terminal/modelDetect");
const compatibilityPolicy_1 = require("../../../shared/terminal/compatibilityPolicy");
const featureFlags_1 = require("../../terminal-connection/featureFlags");
const connectionProtocol_1 = require("../../../shared/terminal/connectionProtocol");
const AI_AGENT_TYPES = new Set(['claude', 'codex', 'gemini', 'kimi', 'agy', 'amp', 'opencode', 'cline', 'qoder', 'qwen', 'grok', 'hermes', 'cursor', 'pi', 'custom']);
const ALLOWED_AGENT_TYPES = new Set([
    'claude', 'codex', 'gemini', 'kimi', 'agy', 'amp', 'opencode', 'cline', 'qoder', 'qwen',
    'bash', 'zsh', 'powershell', 'custom',
]);
const pendingTerminalCreates = new Map();
const recentRemoteTerminalCreates = new Map();
const REMOTE_TERMINAL_CREATE_TTL_MS = 2 * 60_000;
const MAX_RECENT_REMOTE_TERMINAL_CREATES = 128;
const recentRemoteWarmStarts = new Map();
function pruneRecentRemoteTerminalCreates(now = Date.now()) {
    for (const [key, entry] of recentRemoteTerminalCreates) {
        if (entry.expiresAt <= now)
            recentRemoteTerminalCreates.delete(key);
    }
}
function getOrCreateRemoteTerminalRequest(socket, clientRequestId, create) {
    if (!clientRequestId)
        return create();
    pruneRecentRemoteTerminalCreates();
    const owner = typeof socket.data.deviceId === 'string' && socket.data.deviceId
        ? socket.data.deviceId
        : socket.id;
    const key = `${owner}:${clientRequestId}`;
    const existing = recentRemoteTerminalCreates.get(key);
    if (existing)
        return existing.promise;
    while (recentRemoteTerminalCreates.size >= MAX_RECENT_REMOTE_TERMINAL_CREATES) {
        const oldestKey = recentRemoteTerminalCreates.keys().next().value;
        if (!oldestKey)
            break;
        recentRemoteTerminalCreates.delete(oldestKey);
    }
    const promise = create();
    recentRemoteTerminalCreates.set(key, {
        promise,
        expiresAt: Date.now() + REMOTE_TERMINAL_CREATE_TTL_MS,
    });
    return promise;
}
/**
 * Resolves (re-creating if needed) the main window that hosts <App> — the only
 * renderer that registers the `remote:create-terminal-request` listener. The
 * resolver waits for that renderer's project store to hydrate too. Set by
 * `registerTerminalHandlers` from a main-process accessor. Module-level because
 * there is a single remote server per process (like `pendingTerminalCreates`
 * and the global response listener below). Falls back to the first live window
 * only if never wired.
 */
let ensureRendererWindow = null;
let remoteTerminalInputObserver = null;
function configureRendererTerminalRequestWindow(resolver) {
    ensureRendererWindow = resolver;
}
/** Main-owned Agent Teams lease hook. Every Remote/phone/scheduled input path
 * below funnels through this guard before it reaches the PTY. */
function configureRemoteTerminalInputObserver(observer) {
    remoteTerminalInputObserver = observer;
}
function writeRemoteTerminalInput(ptyBackend, terminalId, data) {
    if (!ptyBackend.hasLiveInstance(terminalId))
        return false;
    // The phone-mirror xterm auto-replies to OSC color queries like the desktop
    // emulator does. Main is the sole responder (ipc/terminal.ts answers at the
    // PTY edge), so emulator reports are dropped here too — a late duplicate is
    // what corrupts Hermes's composer (osc-color-report-late-delivery.md).
    // Human typing never contains ESC-led report sequences.
    const cleaned = (0, replay_1.stripOscColorReports)(data);
    if (cleaned.length === 0 && data.length > 0)
        return true;
    if (remoteTerminalInputObserver && !remoteTerminalInputObserver(terminalId, cleaned))
        return false;
    ptyBackend.write(terminalId, cleaned);
    return true;
}
/**
 * Per-terminal AI model detection, shared across every socket subscribed to the
 * terminal's room (the output listener is one-per-terminal, not per-socket).
 *   - `terminalModelScanStates` carries the bounded raw PTY tail across chunk
 *     boundaries (see modelDetect.ts) for the live `/model`-switch scan.
 *   - `terminalModels` caches the last detected RAW model id so a change can be
 *     diffed before broadcasting, and a fresh subscribe can fall back to it when
 *     the buffer tail no longer holds the anchor line. The display label sent to
 *     the phone is always `formatModelLabel(raw)` — matching the desktop chip.
 */
const terminalModelScanStates = new Map();
const terminalModels = new Map();
// Single global IPC listener — set up once, dispatches by requestId.
electron_1.ipcMain.on('remote:create-terminal-response', (_e, payload) => {
    if (!payload?.requestId)
        return;
    const pending = pendingTerminalCreates.get(payload.requestId);
    if (!pending)
        return;
    clearTimeout(pending.timer);
    pendingTerminalCreates.delete(payload.requestId);
    pending.resolve({
        ok: payload.ok,
        terminalId: payload.terminalId,
        worktreePath: payload.worktreePath,
        error: payload.error,
    });
});
function requestRendererCreateTerminal(payload) {
    return new Promise((resolve) => {
        // Dispatch into a specific window's <App>. Must be the MAIN window — popout
        // and sub-agent windows render different roots and never register the
        // `remote:create-terminal-request` listener, so a request sent there would
        // silently hang until the ack timeout.
        const dispatch = (win, unavailableError = 'No active window') => {
            if (!win || win.isDestroyed()) {
                resolve({ ok: false, error: unavailableError });
                return;
            }
            if (payload.focusWindow) {
                if (win.isMinimized())
                    win.restore();
                win.show();
                win.focus();
            }
            const requestId = crypto_1.default.randomUUID();
            const timer = setTimeout(() => {
                pendingTerminalCreates.delete(requestId);
                resolve({ ok: false, error: 'Timed out waiting for desktop to create terminal' });
            }, payload.worktreeOnly ? 30_000 : 8_000);
            pendingTerminalCreates.set(requestId, { resolve, timer });
            try {
                win.webContents.send('remote:create-terminal-request', { requestId, ...payload });
            }
            catch (err) {
                clearTimeout(timer);
                pendingTerminalCreates.delete(requestId);
                resolve({ ok: false, error: err instanceof Error ? err.message : 'IPC send failed' });
            }
        };
        if (ensureRendererWindow) {
            // Resolves the main window, re-creating and awaiting it if the user closed
            // it while the app stayed alive (macOS dock-only remote-control usage).
            ensureRendererWindow()
                .then((win) => dispatch(win, 'Desktop window did not become ready'))
                .catch(() => dispatch(null, 'Desktop window did not become ready'));
        }
        else {
            // Not wired (shouldn't happen in the packaged app) — best-effort fallback
            // to any live window so behavior never regresses below the old path.
            dispatch(electron_1.BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null);
        }
    });
}
/**
 * Ask the renderer to spawn the PTY for an EXISTING terminal record (no new
 * record). Used when the phone opens a terminal whose process is not running:
 * created remotely while the project wasn't open on the desktop, or the
 * desktop app restarted. Routed through the renderer + the standard
 * pty:create IPC so the spawn gets identical wiring (output sniffer, renderer
 * forwarding, resume command) to a desktop pane mount.
 */
function requestRendererSpawnTerminal(terminalId) {
    return requestRendererCreateTerminal({ spawnOnly: true, terminalId });
}
function requestRendererCloseTerminal(terminalId) {
    return requestRendererCreateTerminal({ closeOnly: true, terminalId });
}
/**
 * Find a terminal record across all projects so we can read its declared
 * agent kind. The store is the authoritative source — the phone never sends
 * agentType, so prompt sequencing can't be spoofed.
 */
function findTerminalRecord(storeManager, terminalId) {
    if (!storeManager)
        return null;
    try {
        const projects = storeManager.getProjects();
        for (const project of projects) {
            const found = (project.terminals || []).find((t) => t.id === terminalId);
            if (found)
                return found;
        }
    }
    catch {
        // ignore — fall back to plain-shell sequencing
    }
    return null;
}
function resolveAgentTarget(storeManager, terminalId) {
    const record = findTerminalRecord(storeManager, terminalId);
    if (!record)
        return {};
    return {
        agentType: record.agentType,
        startupCommand: record.startupCommand,
        forceAiAgent: record.forceAiAgent,
    };
}
/**
 * Resolve the agent kind for slash-command purposes. Mirrors the renderer's
 * resolveAgentForCommands (forceAiAgent custom wrappers default to claude).
 */
function resolveCommandKind(record) {
    if (!record)
        return null;
    const kind = (0, contracts_1.getDeclaredAgentKind)(record.agentType, record.startupCommand);
    if (kind)
        return kind;
    const effective = (0, aiPreviewState_1.resolveEffectivePreviewAgentType)(record.id, record.agentType, record.startupCommand, record.forceAiAgent);
    switch (effective) {
        case 'claude': return 'claude-command';
        case 'codex': return 'codex';
        case 'gemini': return 'gemini';
        case 'kimi': return 'kimi';
        case 'agy': return 'antigravity';
        case 'amp': return 'amp';
        case 'opencode': return 'opencode';
        case 'cline': return 'cline';
        case 'grok': return 'grok';
        case 'qoder': return 'qoder';
        case 'qwen': return 'qwen';
        case 'hermes': return 'hermes';
        case 'cursor': return 'cursor';
    }
    if (record.forceAiAgent)
        return 'claude-command';
    return null;
}
const KIND_TO_QUOTA_AGENT = {
    'claude-command': 'claude',
    codex: 'codex',
    gemini: 'gemini',
    qwen: 'qwen',
    opencode: 'opencode',
    amp: 'amp',
    antigravity: 'antigravity',
    grok: 'grok',
    cline: 'cline',
};
function resolveQuotaAgent(record, terminalBuffer) {
    const commandKind = resolveCommandKind(record);
    if (commandKind && KIND_TO_QUOTA_AGENT[commandKind]) {
        return KIND_TO_QUOTA_AGENT[commandKind] || null;
    }
    const kind = (0, contracts_1.inferAgentKind)(record?.agentType, record?.startupCommand, terminalBuffer ? (0, replay_2.stripAnsi)(terminalBuffer) : undefined);
    return (kind && KIND_TO_QUOTA_AGENT[kind]) || null;
}
/** Map a terminal's declared agent to the SkillFile.tool it should see. */
function agentTypeToSkillTool(agentType) {
    switch (agentType) {
        case 'claude': return 'claude';
        case 'codex': return 'codex';
        case 'gemini': return 'gemini';
        case 'kimi': return 'kimi';
        case 'amp': return 'amp';
        case 'opencode': return 'opencode';
        default: return null;
    }
}
function resolveSkillTool(record) {
    if (!record)
        return null;
    const effective = (0, aiPreviewState_1.resolveEffectivePreviewAgentType)(record.id, record.agentType, record.startupCommand, record.forceAiAgent);
    return agentTypeToSkillTool(effective ?? record.agentType);
}
/**
 * Cache of tool-filtered skill lists keyed by `${projectRoot}|${tool}`.
 * `skillsManager.scanAll()` reads every SKILL.md from disk on each call, so
 * without this the `$` typeahead would re-scan the filesystem on every
 * debounced keystroke. A short TTL covers a typing burst while still picking up
 * newly-added skills within a few seconds. Content is dropped at cache time.
 */
const SKILL_LIST_TTL_MS = 5000;
const skillListCache = new Map();
function getAgentSkillList(skillsManager, projectRoot, tool) {
    const key = `${projectRoot || ''}|${tool || ''}`;
    const cached = skillListCache.get(key);
    if (cached && Date.now() - cached.at < SKILL_LIST_TTL_MS) {
        return cached.items;
    }
    const items = skillsManager.scanAll(projectRoot)
        // Tool filter mirrors getSlashCommandsForAgent: keep skills for this agent,
        // plus tool-agnostic ('other'/undefined) skills.
        .filter((s) => !tool || !s.tool || s.tool === 'other' || s.tool === tool)
        .map((s) => ({ name: s.name, description: s.description, category: s.category }));
    skillListCache.set(key, { at: Date.now(), items });
    return items;
}
const REMOTE_IMAGE_MIME_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
};
/**
 * Decode a base64 image data URL and save it to a temp dir, returning the
 * absolute path. The filename is timestamp-based and space-free so the
 * resulting `@<path>` attachment reference needs no shell escaping.
 */
function saveRemoteImage(imageData) {
    const match = /^data:(image\/[\w.+-]+);base64,/.exec(imageData);
    if (!match)
        return null;
    const ext = REMOTE_IMAGE_MIME_EXT[match[1].toLowerCase()] || 'png';
    const imgDir = path_1.default.join(os_1.default.tmpdir(), '1devtool-ai-images', 'remote');
    fs_1.default.mkdirSync(imgDir, { recursive: true });
    const base64Data = imageData.slice(match[0].length);
    // Same decoded-size cap as saveRemoteFile so an oversized image can't blow
    // past the socket buffer (see REMOTE_UPLOAD_MAX_BYTES note).
    const byteLength = Math.floor((base64Data.length * 3) / 4);
    if (byteLength > REMOTE_UPLOAD_MAX_BYTES)
        return null;
    const filePath = path_1.default.join(imgDir, `${Date.now()}-${crypto_1.default.randomBytes(4).toString('hex')}.${ext}`);
    fs_1.default.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
    return filePath;
}
/**
 * Hard cap on a single uploaded file/image (DECODED bytes, 25 MB). Generous for
 * phone attachments (photos, PDFs, docs) yet small enough that the base64 wire
 * payload (~33 MB) stays well under the socket.io maxHttpBufferSize (48 MB) in
 * server.ts — if an upload exceeds the buffer, engine.io/ws closes the whole
 * connection and BOTH the upload AND the next prompt send fail. Keep these two
 * numbers in sync: maxHttpBufferSize must stay > REMOTE_UPLOAD_MAX_BYTES × 4/3.
 */
const REMOTE_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
/**
 * Decode a generic base64 data URL and save it under a tmp dir, preserving the
 * user-supplied basename's extension when safe. Same shell-safe naming as
 * `saveRemoteImage` so the returned path drops into a prompt without escaping.
 * Returns `null` if the payload is malformed or oversized.
 */
function saveRemoteFile(fileData, fileName) {
    const match = /^data:([\w.+-]+\/[\w.+-]+);base64,/.exec(fileData);
    if (!match)
        return null;
    const base64Data = fileData.slice(match[0].length);
    const byteLength = Math.floor((base64Data.length * 3) / 4);
    if (byteLength > REMOTE_UPLOAD_MAX_BYTES)
        return null;
    // Extract extension from the user-supplied name; reject anything with path
    // separators / non-printable junk to keep the resulting filename benign.
    const baseName = path_1.default.basename(fileName || '').replace(/[^\w.\- ]+/g, '_').slice(0, 80);
    const ext = (path_1.default.extname(baseName) || '').slice(1);
    const safeExt = /^[a-zA-Z0-9]{1,8}$/.test(ext) ? ext.toLowerCase() : 'bin';
    const stem = path_1.default.basename(baseName, path_1.default.extname(baseName)).replace(/\s+/g, '_') || 'file';
    const fileDir = path_1.default.join(os_1.default.tmpdir(), '1devtool-remote-files');
    fs_1.default.mkdirSync(fileDir, { recursive: true });
    const filePath = path_1.default.join(fileDir, `${Date.now()}-${crypto_1.default.randomBytes(4).toString('hex')}-${stem}.${safeExt}`);
    fs_1.default.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
    return filePath;
}
/**
 * Batching window in milliseconds for terminal output.
 * Output is accumulated and flushed to the room on this interval.
 */
const OUTPUT_BATCH_MS = 50;
/**
 * Trailing debounce for terminal:size broadcasts. A desktop drag-resize fires
 * a burst of pty:resize calls; only the settled dims matter to a phone mirror,
 * and re-locking its xterm per intermediate step would reflow scrollback
 * repeatedly for nothing.
 */
const RESIZE_BROADCAST_DEBOUNCE_MS = 150;
/**
 * Maximum number of characters to send for initial buffer on subscribe.
 * Approximately 5000 lines of 80-column terminal output.
 */
const MAX_INITIAL_BUFFER_CHARS = 400_000;
/**
 * Register terminal streaming and input event handlers.
 *
 * - terminal:subscribe   -> join socket room, receive current buffer + live output
 * - terminal:unsubscribe -> leave socket room
 * - terminal:input       -> write to PTY (requires operator permission)
 * - terminal:resize      -> resize PTY (requires operator permission)
 */
function registerTerminalHandlers(io, managers) {
    const { ptyBackend, storeManager, skillsManager, getDeviceHostProxy } = managers;
    const terminalConnectionService = managers.terminalConnectionService;
    // Wire the main-window resolver so create/spawn/close dispatch to the window
    // that actually owns the renderer handler (see requestRendererCreateTerminal).
    if (managers.ensureRendererWindow)
        configureRendererTerminalRequestWindow(managers.ensureRendererWindow);
    // Map of terminalId -> active output listener unsubscribe function
    // Shared across all sockets: we register one listener per terminal,
    // and broadcast to the room
    const activeListeners = new Map();
    const outputBatches = new Map();
    const promptSubmitter = new promptSubmit_1.RemotePromptSubmitCoordinator({
        backend: ptyBackend,
        claimInput: (terminalId, text) => remoteTerminalInputObserver?.(terminalId, text) ?? true,
    });
    // Scheduled prompts fire in the MAIN process (a locked phone can't run a
    // timer), through the exact write path terminal:submit uses. State changes
    // are pushed to the terminal's room so every subscribed phone stays in sync.
    (0, scheduledPrompts_1.configureScheduledPrompts)({
        broadcast: (terminalId, job) => {
            io.to(`terminal:${terminalId}`).emit('terminal:scheduled-prompt', { terminalId, job });
        },
        fire: async (job) => {
            if (!ptyBackend.hasLiveInstance(job.terminalId)) {
                throw new Error(`Terminal ${job.terminalId} has no live process. The scheduled prompt was kept.`);
            }
            const target = resolveAgentTarget(storeManager, job.terminalId);
            await promptSubmitter.submit({
                terminalId: job.terminalId,
                text: job.text,
                target,
            });
        },
    });
    io.on('connection', (socket) => {
        // Track which terminals this socket is subscribed to (for cleanup)
        const subscribedTerminals = new Set();
        const v2Connections = new Map();
        const peerSubscriptions = new Map();
        const selectedPeerId = () => {
            const hostId = typeof socket.data.remoteHostId === 'string' ? socket.data.remoteHostId : 'local';
            return hostId !== 'local' ? hostId : null;
        };
        const rejectWhenPeerSelected = (ack, operation) => {
            if (!selectedPeerId())
                return false;
            if (typeof ack === 'function') {
                ack({
                    ok: false,
                    error: `${operation} is not available through a peer host. Switch to This Mac to use it.`,
                });
            }
            return true;
        };
        const clearHostTerminalSubscriptions = () => {
            const proxy = getDeviceHostProxy?.();
            for (const [terminalId, subscription] of peerSubscriptions) {
                proxy?.unsubscribePeerTerminal(subscription.deviceId, terminalId, subscription.onData);
            }
            peerSubscriptions.clear();
            for (const terminalId of subscribedTerminals) {
                socket.leave(`terminal:${terminalId}`);
                if (terminalSizePolicy_1.remoteSizeAuthority.release(terminalId, socket.id)) {
                    healPtyToDesktopSize(ptyBackend, terminalId);
                }
                cleanupListenerIfEmpty(io, activeListeners, outputBatches, terminalId);
            }
            subscribedTerminals.clear();
            for (const [connectionId, connection] of v2Connections) {
                terminalConnectionService.detach(connectionId);
                connection.disposeResize();
            }
            v2Connections.clear();
            terminalConnectionService.detachSubject('remote-ui', String(socket.data.deviceId || socket.id));
        };
        // The dashboard host picker calls this before changing host identity. It
        // prevents an old primary-host room (or peer mirror) from continuing to
        // stream into the newly selected host when terminal ids happen to match.
        socket.data.prepareRemoteHostSwitch = clearHostTerminalSubscriptions;
        socket.on('remote:ping', (_payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack === 'function') {
                ack({ ok: true });
            }
        });
        const remotePrincipal = () => ({
            origin: 'remote-ui',
            subjectId: String(socket.data.deviceId || socket.id),
            permissions: new Set((0, permission_1.hasPermission)(socket, 'operator')
                ? ['read', 'input', 'resize']
                : ['read']),
        });
        const releaseV2Connection = (connectionId) => {
            const connection = v2Connections.get(connectionId);
            if (!connection)
                return;
            v2Connections.delete(connectionId);
            connection.disposeResize();
            terminalConnectionService.detach(connectionId, remotePrincipal());
            const stillViewing = [...v2Connections.values()]
                .some((candidate) => candidate.terminalId === connection.terminalId);
            if (!stillViewing && terminalSizePolicy_1.remoteSizeAuthority.release(connection.terminalId, socket.id)) {
                healPtyToDesktopSize(ptyBackend, connection.terminalId);
            }
        };
        const requireTerminalReload = (terminalId, reason) => {
            socket.emit('terminal:reload-required', { terminalId, reason });
            // Let Socket.IO enqueue the typed recovery event before closing this
            // viewer. A reconnect performs a fresh authenticated attach.
            setImmediate(() => socket.disconnect(true));
        };
        socket.on('terminal:warm-start', async (payload, ack) => {
            if (!socket.data.authenticated || typeof ack !== 'function')
                return;
            if (!(0, featureFlags_1.remoteTerminalAckResyncEnabled)()) {
                ack({ ok: false, error: { code: 'unsupported-version', message: 'Terminal v2 is disabled for rollback' } });
                return;
            }
            const { terminalId, clientRequestId } = payload || {};
            if (!(0, permission_1.hasPermission)(socket, 'operator')) {
                ack({ ok: false, error: { code: 'forbidden', message: 'Operator permission is required' } });
                return;
            }
            if (selectedPeerId()) {
                ack({ ok: false, error: { code: 'forbidden', message: 'Peer terminals must already be live' } });
                return;
            }
            if (!terminalId || !clientRequestId || !findTerminalRecord(storeManager, terminalId)) {
                ack({ ok: false, error: { code: 'forbidden', message: 'Terminal not found' } });
                return;
            }
            const owner = String(socket.data.deviceId || socket.id);
            const key = `${owner}:${clientRequestId}`;
            const existing = recentRemoteWarmStarts.get(key);
            if (existing && existing.expiresAt > Date.now()) {
                if (existing.terminalId !== terminalId) {
                    ack({ ok: false, error: { code: 'request-id-conflict', message: 'Warm-start request ID was reused' } });
                    return;
                }
                ack(await existing.promise);
                return;
            }
            for (const [cacheKey, entry] of recentRemoteWarmStarts) {
                if (entry.expiresAt <= Date.now())
                    recentRemoteWarmStarts.delete(cacheKey);
            }
            const promise = (async () => {
                if (!ptyBackend.hasLiveInstance(terminalId)) {
                    const spawn = await requestRendererSpawnTerminal(terminalId).catch((error) => ({
                        ok: false,
                        error: error instanceof Error ? error.message : 'Failed to start terminal',
                    }));
                    if (!spawn.ok && !ptyBackend.hasLiveInstance(terminalId)) {
                        return { ok: false, error: { code: 'warm-start-failed', message: spawn.error || 'Failed to start terminal' } };
                    }
                }
                const identity = ptyBackend.getOwnerIdentity(terminalId);
                return identity
                    ? { ok: true, identity }
                    : { ok: false, error: { code: 'terminal-not-live', message: 'Terminal owner did not become ready' } };
            })();
            recentRemoteWarmStarts.set(key, {
                terminalId,
                promise,
                expiresAt: Date.now() + REMOTE_TERMINAL_CREATE_TTL_MS,
            });
            ack(await promise);
        });
        socket.on('terminal:attach-v2', async (request, ack) => {
            if (!socket.data.authenticated || typeof ack !== 'function')
                return;
            if (!(0, featureFlags_1.remoteTerminalAckResyncEnabled)()) {
                ack({ ok: false, error: { code: 'unsupported-version', message: 'Terminal v2 is disabled for rollback' } });
                return;
            }
            const peerDeviceId = selectedPeerId();
            if (peerDeviceId) {
                if (!(0, permission_1.hasPermission)(socket, 'operator')) {
                    ack({ ok: false, error: { code: 'forbidden', message: 'Operator permission is required for peer terminals' } });
                    return;
                }
                const terminalGeneration = Number(request?.terminalGeneration);
                const proxy = getDeviceHostProxy?.();
                if (!request?.terminalId || !proxy || !Number.isSafeInteger(terminalGeneration) || terminalGeneration <= 0) {
                    ack({ ok: false, error: { code: 'owner-changed', message: 'Refresh the peer terminal before opening it' } });
                    return;
                }
                const previous = peerSubscriptions.get(request.terminalId);
                if (previous)
                    proxy.unsubscribePeerTerminal(previous.deviceId, request.terminalId, previous.onData);
                const onData = (delivery) => {
                    if (delivery.kind === 'frame') {
                        socket.emit('terminal:frame-v2', delivery.frame);
                        return;
                    }
                    const current = peerSubscriptions.get(request.terminalId);
                    if (current)
                        current.connectionId = delivery.attach.connectionId;
                    socket.emit('terminal:peer-attach-v2', delivery.attach);
                };
                const result = await proxy.subscribePeerTerminal(peerDeviceId, request.terminalId, terminalGeneration, onData);
                if (!result.ok) {
                    ack({ ok: false, error: { code: 'peer-attach-failed', message: result.error.message } });
                    return;
                }
                peerSubscriptions.set(request.terminalId, {
                    deviceId: peerDeviceId,
                    terminalGeneration,
                    connectionId: result.attach.connectionId,
                    onData,
                });
                ack({
                    ok: true,
                    result: result.attach,
                    cols: result.attach.session.size?.cols,
                    rows: result.attach.session.size?.rows,
                    desktopAttached: true,
                    model: null,
                });
                return;
            }
            if (!request?.terminalId || !findTerminalRecord(storeManager, request.terminalId)) {
                ack({ ok: false, error: { code: 'forbidden', message: 'Terminal not found' } });
                return;
            }
            const operator = (0, permission_1.hasPermission)(socket, 'operator');
            if (operator) {
                terminalSizePolicy_1.remoteSizeAuthority.claim(request.terminalId, socket.id, typeof socket.data.deviceName === 'string' ? socket.data.deviceName : null);
            }
            try {
                const result = await terminalConnectionService.attach({
                    ...request,
                    maxSnapshotChars: MAX_INITIAL_BUFFER_CHARS,
                    capabilities: request.capabilities?.length ? request.capabilities : [...connectionProtocol_1.RAW_V2_CAPABILITIES],
                }, remotePrincipal(), (frame) => socket.emit('terminal:frame-v2', frame), (reason) => requireTerminalReload(request.terminalId, reason));
                const sizeDecision = (0, terminalSizePolicy_1.decideMirrorSize)({
                    desktopAttached: ptyBackend.hasDesktopAttachment(request.terminalId),
                    desktopSize: ptyBackend.getDesktopSize(request.terminalId),
                    liveSize: ptyBackend.getSize(request.terminalId),
                    remoteAuthority: terminalSizePolicy_1.remoteSizeAuthority.hasAuthority(request.terminalId),
                });
                const sizeBroadcaster = (0, terminalSizePolicy_1.createTerminalSizeBroadcaster)({
                    debounceMs: RESIZE_BROADCAST_DEBOUNCE_MS,
                    readDecision: () => (0, terminalSizePolicy_1.decideMirrorSize)({
                        desktopAttached: ptyBackend.hasDesktopAttachment(request.terminalId),
                        desktopSize: ptyBackend.getDesktopSize(request.terminalId),
                        liveSize: ptyBackend.getSize(request.terminalId),
                        remoteAuthority: terminalSizePolicy_1.remoteSizeAuthority.hasAuthority(request.terminalId),
                    }),
                    flushPendingOutput: () => { },
                    emit: ({ cols, rows, desktopAttached }) => {
                        socket.emit('terminal:size', { terminalId: request.terminalId, cols, rows, desktopAttached });
                    },
                });
                const unsubscribeResize = ptyBackend.onResize(request.terminalId, sizeBroadcaster.schedule);
                v2Connections.set(result.connectionId, {
                    terminalId: request.terminalId,
                    disposeResize: () => {
                        sizeBroadcaster.dispose();
                        unsubscribeResize();
                    },
                });
                const modelKind = resolveCommandKind(findTerminalRecord(storeManager, request.terminalId));
                const rawModel = modelKind && result.payload.kind === 'raw'
                    ? (0, modelDetect_1.extractModelFromReplayBuffer)(result.payload.rawFallback.content, modelKind)
                    : null;
                ack({
                    ok: true,
                    result,
                    cols: sizeDecision.size?.cols,
                    rows: sizeDecision.size?.rows,
                    desktopAttached: sizeDecision.locked,
                    model: rawModel ? (0, modelDetect_1.formatModelLabel)(rawModel) : null,
                });
            }
            catch (error) {
                if (operator && terminalSizePolicy_1.remoteSizeAuthority.release(request.terminalId, socket.id)) {
                    healPtyToDesktopSize(ptyBackend, request.terminalId);
                }
                const code = error instanceof connectionProtocol_1.TerminalConnectionError ? error.code : 'attach-failed';
                ack({
                    ok: false,
                    error: {
                        code,
                        message: error instanceof Error ? error.message : 'Terminal attach failed',
                    },
                });
                if (code === 'client-processing-window-unavailable') {
                    requireTerminalReload(request.terminalId, code);
                }
            }
        });
        socket.on('terminal:ack-v2', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            const peer = [...peerSubscriptions.values()]
                .find((subscription) => subscription.connectionId === payload.connectionId);
            if (peer) {
                void getDeviceHostProxy?.()?.acknowledgePeerTerminalFrame(peer.deviceId, payload.connectionId, payload.syncGeneration, payload.frameId).then((result) => ack?.({ ok: result.ok }));
                return;
            }
            try {
                const ok = terminalConnectionService.ack(payload.connectionId, payload.syncGeneration, payload.frameId, remotePrincipal());
                ack?.({ ok });
            }
            catch {
                ack?.({ ok: false });
            }
        });
        socket.on('terminal:resync-v2', async (payload, ack) => {
            if (!socket.data.authenticated || typeof ack !== 'function')
                return;
            const peerEntry = [...peerSubscriptions.entries()]
                .find(([, subscription]) => subscription.connectionId === payload.connectionId);
            if (peerEntry) {
                const [terminalId, peer] = peerEntry;
                const result = await getDeviceHostProxy?.()?.resyncPeerTerminal(peer.deviceId, payload.connectionId);
                if (result?.ok && result.attach) {
                    ack({ ok: true, result: result.attach });
                }
                else {
                    const code = result?.error?.code ?? 'peer-resync-failed';
                    ack({
                        ok: false,
                        error: {
                            code,
                            message: result?.error?.message ?? 'Peer terminal resync failed',
                        },
                    });
                    requireTerminalReload(terminalId, code);
                }
                return;
            }
            try {
                ack({ ok: true, result: await terminalConnectionService.resync(payload.connectionId, remotePrincipal()) });
            }
            catch (error) {
                const code = error instanceof connectionProtocol_1.TerminalConnectionError ? error.code : 'resync-failed';
                ack({
                    ok: false,
                    error: {
                        code,
                        message: error instanceof Error ? error.message : 'Terminal resync failed',
                    },
                });
                // Reload/disconnect is reserved for recovery this viewer cannot trust;
                // escalating a benign race tore down the whole socket (every terminal
                // plus the dashboard) instead of one clean re-attach.
                if ((0, connectionProtocol_1.isBenignTerminalResyncFailure)(code))
                    return;
                const connection = v2Connections.get(payload.connectionId);
                requireTerminalReload(connection?.terminalId ?? '', code);
            }
        });
        socket.on('terminal:detach-v2', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            const peerEntry = [...peerSubscriptions.entries()]
                .find(([, subscription]) => subscription.connectionId === payload.connectionId);
            if (peerEntry) {
                const [terminalId, peer] = peerEntry;
                getDeviceHostProxy?.()?.unsubscribePeerTerminal(peer.deviceId, terminalId, peer.onData);
                peerSubscriptions.delete(terminalId);
                ack?.({ ok: true });
                return;
            }
            releaseV2Connection(payload.connectionId);
            ack?.({ ok: true });
        });
        socket.on('terminal:visibility-v2', async (payload, ack) => {
            if (!socket.data.authenticated) {
                ack?.({ ok: false });
                return;
            }
            const peerEntry = [...peerSubscriptions.entries()]
                .find(([, subscription]) => subscription.connectionId === payload.connectionId);
            if (peerEntry) {
                const [, peer] = peerEntry;
                const result = await getDeviceHostProxy?.()?.setPeerTerminalVisibility(peer.deviceId, payload.connectionId, payload.visible === true);
                ack?.({ ok: result?.ok === true, resyncRequired: result?.resyncRequired });
                return;
            }
            try {
                const state = terminalConnectionService.setVisibility(payload.connectionId, payload.visible === true, remotePrincipal());
                ack?.({ ok: true, resyncRequired: state.resyncRequired });
            }
            catch {
                ack?.({ ok: false });
            }
        });
        socket.on('terminal:ai-quota', async (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (rejectWhenPeerSelected(ack, 'AI quota'))
                return;
            const { terminalId, force, grokProbeTrigger } = payload || {};
            if (!terminalId) {
                ack({ ok: false, error: 'Missing terminalId' });
                return;
            }
            if (!storeManager) {
                ack({ ok: false, error: 'Store unavailable' });
                return;
            }
            const record = findTerminalRecord(storeManager, terminalId);
            const agent = resolveQuotaAgent(record, await ptyBackend.getBuffer(terminalId));
            if (!agent) {
                ack({ ok: true, agent: null, status: null });
                return;
            }
            try {
                const overrides = storeManager.getPreferences().aiAgentPaths || {};
                const status = agent === 'cline'
                    ? null
                    : agent === 'amp'
                        ? await aiAccounts.readAmpQuotaCached().catch(() => null)
                        : agent === 'antigravity'
                            ? await aiAccounts.readAntigravityQuotaCached(overrides).catch(() => null)
                            : agent === 'grok'
                                // Perf guardrail: generic force/poll requests never spawn Grok.
                                // Only the component's one-shot terminal-open fallback and its
                                // explicit Refresh button may run `/usage` → `show`.
                                ? await aiAccounts.readGrokQuotaCached(grokProbeTrigger === 'terminal-open' || grokProbeTrigger === 'manual').catch(() => null)
                                : await aiAccounts
                                    .buildAgentStatus(agent, overrides, force === true)
                                    .catch(() => null);
                // Which account is this terminal on? Durable pool assignment first
                // (quota-center §10); global active account otherwise.
                let accountLabel;
                if (['claude', 'codex', 'gemini', 'qwen', 'opencode'].includes(agent)) {
                    const reg = await (0, registry_1.readRegistry)().catch(() => null);
                    if (reg) {
                        const pathAgent = agent;
                        const leases = await (0, assignments_1.readLeases)().catch(() => []);
                        const leased = leases.find((l) => l.terminalId === terminalId);
                        const accountId = leased?.accountId ?? reg.active[pathAgent];
                        accountLabel = reg.accounts[pathAgent].find((a) => a.id === accountId)?.label;
                    }
                }
                ack({ ok: true, agent, status, accountLabel });
            }
            catch (err) {
                ack({ ok: false, agent, error: err instanceof Error ? err.message : 'Failed to load quota' });
            }
        });
        // Compact pool overview for the phone dashboard (quota-center §10,
        // Phase 5). Reads persisted snapshot statuses + pool files only — no
        // probes, so a phone poll can never pressure provider endpoints.
        socket.on('quota:center-summary', async (_payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            try {
                const reg = await (0, registry_1.readRegistry)();
                const poolState = await (0, assignments_1.readPoolState)().catch(() => ({}));
                const leases = await (0, assignments_1.readLeases)().catch(() => []);
                const pathAgents = ['claude', 'codex', 'gemini', 'qwen', 'opencode'];
                const clamp = (v) => v == null || !Number.isFinite(v) ? null : Math.max(0, Math.min(100, Math.round(v)));
                const providers = pathAgents.map((agent) => {
                    const accounts = reg.accounts[agent].map((account) => {
                        const primaryPct = clamp(account.status?.primary?.usedPercent);
                        const secondaryPct = clamp(account.status?.secondary?.usedPercent);
                        return {
                            label: account.label,
                            active: reg.active[agent] === account.id,
                            enabled: account.enabled !== false,
                            cooling: poolState[agent]?.[account.id] != null,
                            primaryPct,
                            secondaryPct,
                            resetsAt: account.status?.primary?.resetsAt ?? account.status?.secondary?.resetsAt ?? null,
                        };
                    });
                    const used = accounts
                        .map((a) => Math.max(a.primaryPct ?? -1, a.secondaryPct ?? -1))
                        .filter((v) => v >= 0);
                    return {
                        agent: agent,
                        accounts,
                        bestUsedPct: used.length ? Math.min(...used) : null,
                        leaseCount: leases.filter((l) => l.agent === agent).length,
                    };
                });
                ack({ ok: true, providers });
            }
            catch (err) {
                ack({ ok: false, error: err instanceof Error ? err.message : 'Failed to load pool summary' });
            }
        });
        socket.on('terminal:subscribe', async (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (!(0, compatibilityPolicy_1.rawV1RemoteCompatibilityActive)(electron_1.app.getVersion())) {
                ack?.({ ok: false, error: 'upgrade-required' });
                requireTerminalReload(payload?.terminalId || '', 'raw-v1-compatibility-ended');
                return;
            }
            const { terminalId } = payload || {};
            if (!terminalId) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Missing terminalId' });
                return;
            }
            const peerDeviceId = selectedPeerId();
            if (peerDeviceId) {
                // A paired desktop's terminal grant must not be silently delegated to
                // a viewer-only phone whose identity the owning peer cannot audit.
                if (!(0, permission_1.hasPermission)(socket, 'operator')) {
                    ack?.({ ok: false, error: 'Operator permission is required to stream a peer device terminal.' });
                    return;
                }
                ack?.({
                    ok: false,
                    error: 'This peer requires the current encrypted terminal viewer. Reload Remote Control.',
                });
                return;
            }
            const roomName = `terminal:${terminalId}`;
            // Join the socket.io room
            socket.join(roomName);
            subscribedTerminals.add(terminalId);
            // Lazy spawn: the terminal record can exist without a live PTY. The
            // desktop only spawns on pane mount, which never happened if the
            // terminal was created from the phone while its project wasn't open
            // on the laptop (or the desktop restarted; detached tmux sessions also
            // have no instance until reattach). Bring it to life like a desktop
            // mount would. Operator+ only: viewers must not start processes.
            // The renderer validates the terminalId against projectStore records.
            if (!ptyBackend.hasLiveInstance(terminalId) && (0, permission_1.hasPermission)(socket, 'operator')) {
                const spawnResult = await requestRendererSpawnTerminal(terminalId)
                    .catch((error) => ({
                    ok: false,
                    error: error instanceof Error ? error.message : 'Failed to start terminal',
                }));
                if (!spawnResult.ok && !ptyBackend.hasLiveInstance(terminalId)) {
                    if (typeof ack === 'function') {
                        ack({ ok: false, error: spawnResult.error || 'Failed to start terminal' });
                    }
                    return;
                }
            }
            // Detect the terminal's agent kind up front — the output listener scans
            // live chunks for model changes and needs it at registration time.
            const modelKind = resolveCommandKind(findTerminalRecord(storeManager, terminalId));
            // Register the room's output listener BEFORE snapshotting the buffer: a
            // chunk landing between snapshot and registration used to be lost for
            // the first subscriber. The overlap this ordering creates (chunk both in
            // the snapshot and delivered live) is dropped client-side by seq — the
            // ack carries the snapshot's pipe-buffer seq and every output event
            // carries its chunks' seq spans (see
            // docs/common-errors/remote/remote-subscribe-replay-duplication.md).
            ensureOutputListener(io, ptyBackend, activeListeners, outputBatches, terminalId, modelKind);
            // Get current buffer (truncated)
            const snapshot = await ptyBackend.getBufferSnapshot(terminalId);
            const fullBuffer = snapshot.content;
            const buffer = truncateBuffer(fullBuffer, MAX_INITIAL_BUFFER_CHARS);
            // Operator phones take size authority for as long as they view this
            // terminal (tmux-style smallest-wins; the PTY heals back to desktop
            // dims on the last detach). Claim BEFORE deciding so the ack reports
            // an unlocked mirror and desktop pty:resize is gated from now on.
            // Viewer-permission phones stay read-only locked mirrors. The device
            // name feeds the desktop's "Sized for phone" badge.
            if ((0, permission_1.hasPermission)(socket, 'operator')) {
                terminalSizePolicy_1.remoteSizeAuthority.claim(terminalId, socket.id, typeof socket.data.deviceName === 'string' ? socket.data.deviceName : null);
            }
            // Desktop-owned terminals lock a read-only mirror even while no desktop
            // pane is mounted; the lazy respawn above starts at the spawn default,
            // so heal the PTY back to the owned desktop dims before reporting them.
            const sizeDecision = (0, terminalSizePolicy_1.decideMirrorSize)({
                desktopAttached: ptyBackend.hasDesktopAttachment(terminalId),
                desktopSize: ptyBackend.getDesktopSize(terminalId),
                liveSize: ptyBackend.getSize(terminalId),
                remoteAuthority: terminalSizePolicy_1.remoteSizeAuthority.hasAuthority(terminalId),
            });
            if (sizeDecision.healTo) {
                ptyBackend.resize(terminalId, sizeDecision.healTo.cols, sizeDecision.healTo.rows);
            }
            const size = sizeDecision.size;
            const desktopAttached = sizeDecision.locked;
            // Detect the current AI model for the terminal-detail header chip. Only
            // real declared agents (or forced-AI wrappers) get scanned — a plain
            // shell's `null` kind is skipped so ordinary output never false-matches.
            // The untruncated buffer's tail is authoritative; the per-terminal cache
            // seeds only when the tail no longer holds the model anchor line.
            let rawModel = null;
            if (modelKind) {
                rawModel = (0, modelDetect_1.extractModelFromReplayBuffer)(fullBuffer, modelKind) || terminalModels.get(terminalId) || null;
                if (rawModel)
                    terminalModels.set(terminalId, rawModel);
            }
            const model = rawModel ? (0, modelDetect_1.formatModelLabel)(rawModel) : null;
            if (typeof ack === 'function') {
                ack({ ok: true, buffer, bufferSeq: snapshot.seq, cols: size?.cols, rows: size?.rows, desktopAttached, model });
            }
            else {
                socket.emit('terminal:buffer', { terminalId, buffer, bufferSeq: snapshot.seq, cols: size?.cols, rows: size?.rows, desktopAttached, model });
            }
        });
        socket.on('terminal:unsubscribe', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            const { terminalId } = payload || {};
            if (!terminalId) {
                if (typeof ack === 'function')
                    ack({ ok: false });
                return;
            }
            const peerSubscription = peerSubscriptions.get(terminalId);
            if (peerSubscription) {
                getDeviceHostProxy?.()?.unsubscribePeerTerminal(peerSubscription.deviceId, terminalId, peerSubscription.onData);
                peerSubscriptions.delete(terminalId);
                ack?.({ ok: true });
                return;
            }
            const roomName = `terminal:${terminalId}`;
            socket.leave(roomName);
            subscribedTerminals.delete(terminalId);
            // Last phone viewer gone → hand size authority back to the desktop.
            if (terminalSizePolicy_1.remoteSizeAuthority.release(terminalId, socket.id)) {
                healPtyToDesktopSize(ptyBackend, terminalId);
            }
            // If no more sockets in the room, clean up the listener
            cleanupListenerIfEmpty(io, activeListeners, outputBatches, terminalId);
            if (typeof ack === 'function')
                ack({ ok: true });
        });
        socket.on('terminal:input', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (!(0, permission_1.hasPermission)(socket, 'operator')) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Insufficient permissions' });
                return;
            }
            const { terminalId, data } = payload || {};
            if (!terminalId || data === undefined || data === null) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Missing terminalId or data' });
                return;
            }
            if (selectedPeerId()) {
                ack?.({ ok: false, error: 'Peer hosts accept complete AI prompts; raw terminal keystrokes are not proxied.' });
                return;
            }
            try {
                if (!writeRemoteTerminalInput(ptyBackend, terminalId, data)) {
                    if (typeof ack === 'function') {
                        ack({ ok: false, error: 'Terminal input was not delivered. Refresh the terminal and try again.' });
                    }
                    return;
                }
                if (typeof ack === 'function')
                    ack({ ok: true });
            }
            catch (err) {
                if (typeof ack === 'function') {
                    ack({ ok: false, error: err instanceof Error ? err.message : 'Write failed' });
                }
            }
        });
        // terminal:submit — submit a full prompt line. Unlike terminal:input (raw
        // keystrokes), this sequences the trailing Enter for the terminal's agent
        // kind so slash commands work on AI TUIs (see agentPromptWrite.ts). The
        // phone must NOT append its own '\r'.
        socket.on('terminal:submit', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (!(0, permission_1.hasPermission)(socket, 'operator')) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Insufficient permissions' });
                return;
            }
            const { terminalId, text } = payload || {};
            if (!terminalId || typeof text !== 'string') {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Missing terminalId or text' });
                return;
            }
            const peerDeviceId = selectedPeerId();
            if (peerDeviceId) {
                const terminalGeneration = Number(payload.terminalGeneration);
                const proxy = getDeviceHostProxy?.();
                if (!proxy || !Number.isSafeInteger(terminalGeneration) || terminalGeneration <= 0) {
                    ack?.({ ok: false, error: 'Refresh the peer terminal before sending.' });
                    return;
                }
                void proxy.submitPeerPrompt(peerDeviceId, terminalId, terminalGeneration, text)
                    .then((result) => ack?.(result.ok ? { ok: true } : { ok: false, error: result.error.message }))
                    .catch((err) => ack?.({ ok: false, error: err instanceof Error ? err.message : 'Peer submit failed' }));
                return;
            }
            const target = resolveAgentTarget(storeManager, terminalId);
            void promptSubmitter.submit({ terminalId, text, target })
                .then(() => ack?.({ ok: true }))
                .catch((err) => {
                ack?.({ ok: false, error: err instanceof Error ? err.message : 'Submit failed' });
            });
        });
        // terminal:schedule-prompt — queue a prompt to auto-submit later (timer /
        // wall-clock alarm / after AI quota reset). The phone describes WHEN; the
        // desktop owns the clock so a locked phone still fires. One pending job
        // per terminal — re-scheduling replaces it, mirroring the desktop store.
        socket.on('terminal:schedule-prompt', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (rejectWhenPeerSelected(ack, 'Scheduled prompts'))
                return;
            if (!(0, permission_1.hasPermission)(socket, 'operator')) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Insufficient permissions' });
                return;
            }
            const { terminalId, text, displayText, attachmentCount, mode, modeDetail, delayMs, runAt } = payload || {};
            if (!terminalId || typeof text !== 'string' || !text.trim()) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Missing terminalId or text' });
                return;
            }
            if (mode !== undefined && mode !== 'timer' && mode !== 'alarm' && mode !== 'quota-reset') {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Invalid schedule mode' });
                return;
            }
            const hasRunAt = typeof runAt === 'number' && Number.isFinite(runAt);
            const hasDelay = typeof delayMs === 'number' && Number.isFinite(delayMs) && delayMs > 0;
            if (!hasRunAt && !hasDelay) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Missing delayMs or runAt' });
                return;
            }
            const now = Date.now();
            const fireAt = hasRunAt ? runAt : now + delayMs;
            if (fireAt - now > scheduledPrompts_1.MAX_SCHEDULE_AHEAD_MS) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Schedule is too far in the future' });
                return;
            }
            const job = (0, scheduledPrompts_1.scheduleRemotePrompt)({
                terminalId,
                text,
                displayText: typeof displayText === 'string' ? displayText : undefined,
                attachmentCount: typeof attachmentCount === 'number' ? attachmentCount : 0,
                mode,
                modeDetail: typeof modeDetail === 'string' ? modeDetail.slice(0, 120) : undefined,
                delayMs: hasDelay ? delayMs : undefined,
                runAt: hasRunAt ? runAt : undefined,
            });
            if (typeof ack === 'function')
                ack({ ok: true, job });
        });
        // terminal:cancel-scheduled-prompt — drop the pending job (if any). The
        // phone restores the prompt text into its composer from its own copy.
        socket.on('terminal:cancel-scheduled-prompt', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (rejectWhenPeerSelected(ack, 'Scheduled prompts'))
                return;
            if (!(0, permission_1.hasPermission)(socket, 'operator')) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Insufficient permissions' });
                return;
            }
            const { terminalId } = payload || {};
            if (!terminalId) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Missing terminalId' });
                return;
            }
            (0, scheduledPrompts_1.cancelRemoteScheduledPrompt)(terminalId);
            if (typeof ack === 'function')
                ack({ ok: true });
        });
        // terminal:scheduled-prompt-state — read the pending job on screen mount.
        // Read-only, so plain authenticated (viewer) access is enough.
        socket.on('terminal:scheduled-prompt-state', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (rejectWhenPeerSelected(ack, 'Scheduled prompts'))
                return;
            const { terminalId } = payload || {};
            if (!terminalId) {
                ack({ ok: false, error: 'Missing terminalId' });
                return;
            }
            ack({ ok: true, job: (0, scheduledPrompts_1.getRemoteScheduledPrompt)(terminalId) });
        });
        // terminal:upload-image — persist a base64 image from the phone to a temp
        // file and return its absolute path. The phone inserts that path as an
        // `@<path>` attachment so the AI agent can read the image on submit.
        socket.on('terminal:upload-image', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (rejectWhenPeerSelected(ack, 'Image attachments'))
                return;
            if (!(0, permission_1.hasPermission)(socket, 'operator')) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Insufficient permissions' });
                return;
            }
            const { imageData } = payload || {};
            if (!imageData || !imageData.startsWith('data:image/')) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Invalid image data' });
                return;
            }
            try {
                const imagePath = saveRemoteImage(imageData);
                if (!imagePath) {
                    if (typeof ack === 'function')
                        ack({ ok: false, error: 'Unsupported image format' });
                    return;
                }
                if (typeof ack === 'function')
                    ack({ ok: true, path: imagePath });
            }
            catch (err) {
                if (typeof ack === 'function') {
                    ack({ ok: false, error: err instanceof Error ? err.message : 'Image save failed' });
                }
            }
        });
        // terminal:upload-file — persist a base64 file from the phone to a temp
        // file and return its absolute path. Generalises terminal:upload-image to
        // any file type so the phone can attach PDFs, docs, archives, etc. The
        // phone inserts the returned path as a chip; on submit it rides ahead of
        // the prompt (AI agents read `@<path>`; shells get the bare path).
        socket.on('terminal:upload-file', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (rejectWhenPeerSelected(ack, 'File attachments'))
                return;
            if (!(0, permission_1.hasPermission)(socket, 'operator')) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Insufficient permissions' });
                return;
            }
            const { fileData, fileName } = payload || {};
            if (!fileData || !/^data:[\w.+-]+\/[\w.+-]+;base64,/.test(fileData)) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Invalid file data' });
                return;
            }
            try {
                const filePath = saveRemoteFile(fileData, fileName || 'file');
                if (!filePath) {
                    if (typeof ack === 'function')
                        ack({ ok: false, error: 'File too large or unsupported' });
                    return;
                }
                if (typeof ack === 'function')
                    ack({ ok: true, path: filePath });
            }
            catch (err) {
                if (typeof ack === 'function') {
                    ack({ ok: false, error: err instanceof Error ? err.message : 'File save failed' });
                }
            }
        });
        // terminal:resolve-project-file — resolve a project-relative path to its
        // absolute path on disk. Used by the phone's "attach project file" action:
        // AI agents understand the relative `@<path>` form, but shells need the
        // absolute path. Server-resolved so the phone never sends absolute paths.
        socket.on('terminal:resolve-project-file', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (rejectWhenPeerSelected(ack, 'Project file attachments'))
                return;
            const { projectId, relPath } = payload || {};
            if (!projectId || typeof relPath !== 'string') {
                ack({ ok: false, error: 'Missing projectId or relPath' });
                return;
            }
            try {
                if (!storeManager) {
                    ack({ ok: false, error: 'Store unavailable' });
                    return;
                }
                const project = storeManager.getProjects().find((p) => p.id === projectId);
                if (!project?.rootPath) {
                    ack({ ok: false, error: 'Project not found' });
                    return;
                }
                // Same path-traversal guard as files.ts safeResolve — reject anything
                // escaping the project root.
                const segments = relPath.split(/[\\/]/).filter((s) => s && s !== '.');
                const resolved = path_1.default.resolve(project.rootPath, ...segments);
                const rel = path_1.default.relative(project.rootPath, resolved);
                if (rel.startsWith('..') || path_1.default.isAbsolute(rel)) {
                    ack({ ok: false, error: 'Invalid path' });
                    return;
                }
                ack({ ok: true, absPath: resolved });
            }
            catch (err) {
                ack({ ok: false, error: err instanceof Error ? err.message : 'Resolve failed' });
            }
        });
        // terminal:skills — list the skills available to a terminal's agent, for
        // the phone's `$` skills picker (Codex). The agent's TUI menu can't render
        // in the phone's decoupled input box, so the phone browses skills here and
        // inserts `$<name>`; the agent resolves it on submit. Heavy `content` is
        // stripped — only what the picker shows is sent.
        socket.on('terminal:skills', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (rejectWhenPeerSelected(ack, 'Skill discovery'))
                return;
            if (!skillsManager) {
                ack({ ok: true, skills: [] });
                return;
            }
            const { terminalId, query } = payload || {};
            if (!terminalId) {
                ack({ ok: false, error: 'Missing terminalId' });
                return;
            }
            try {
                const record = findTerminalRecord(storeManager, terminalId);
                const tool = resolveSkillTool(record);
                // Resolve the terminal's project root so project-local skills are seen.
                let projectRoot;
                if (record?.projectId && storeManager) {
                    const project = storeManager.getProjects().find((p) => p.id === record.projectId);
                    projectRoot = project?.rootPath;
                }
                const list = getAgentSkillList(skillsManager, projectRoot, tool);
                const q = (query || '').trim().toLowerCase();
                const skills = (q
                    ? list.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
                    : list).slice(0, 50);
                ack({ ok: true, skills });
            }
            catch (err) {
                ack({ ok: false, error: err instanceof Error ? err.message : 'Failed to list skills' });
            }
        });
        // terminal:slash-commands — list the `/` commands for a terminal's agent,
        // for the phone's slash-command picker. Returns the agent's built-in
        // commands; for agents whose skills live under `/` (everyone except Codex,
        // which uses `$`) the user's skills are merged in too. The full list is
        // returned once and filtered client-side (it's small + static).
        socket.on('terminal:slash-commands', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (rejectWhenPeerSelected(ack, 'Slash-command discovery'))
                return;
            const { terminalId } = payload || {};
            if (!terminalId) {
                ack({ ok: false, error: 'Missing terminalId' });
                return;
            }
            try {
                const record = findTerminalRecord(storeManager, terminalId);
                const kind = resolveCommandKind(record);
                const commands = (0, agentCommands_1.getBuiltinAgentCommands)(kind).map((c) => ({ command: c.command, description: c.description, category: c.category }));
                const seen = new Set(commands.map((c) => c.command));
                // Merge skills into `/` for agents that trigger skills with `/`. Codex
                // uses `$` (its own picker), so its skills stay out of the `/` list.
                // Kimi namespaces skill invocations as `/skill:<name>`.
                if (skillsManager && record && kind !== 'codex') {
                    const tool = resolveSkillTool(record);
                    let projectRoot;
                    if (record.projectId && storeManager) {
                        projectRoot = storeManager.getProjects().find((p) => p.id === record.projectId)?.rootPath;
                    }
                    for (const skill of getAgentSkillList(skillsManager, projectRoot, tool)) {
                        const command = kind === 'kimi' ? `skill:${skill.name}` : skill.name;
                        if (seen.has(command))
                            continue;
                        seen.add(command);
                        commands.push({ command, description: skill.description, category: skill.category });
                    }
                }
                ack({ ok: true, commands: commands.slice(0, 200) });
            }
            catch (err) {
                ack({ ok: false, error: err instanceof Error ? err.message : 'Failed to list commands' });
            }
        });
        // Create a new terminal in a project. Operator+ permission required.
        // The desktop is the source of truth — we delegate to the renderer's
        // projectStore.addTerminal via the IPC bridge above.
        socket.on('terminal:create', (payload, ack) => {
            if (!socket.data.authenticated) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Authentication expired' });
                return;
            }
            if (rejectWhenPeerSelected(ack, 'Terminal creation'))
                return;
            if (!(0, permission_1.hasPermission)(socket, 'operator')) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Insufficient permissions' });
                return;
            }
            const { projectId, agentType, name, command, forceAiAgent, clientRequestId } = payload || {};
            if (!projectId || !agentType) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Missing projectId or agentType' });
                return;
            }
            if (!ALLOWED_AGENT_TYPES.has(agentType)) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: `Unknown agentType: ${agentType}` });
                return;
            }
            // Validate optional fields — phones can't be trusted with raw shell.
            const safeName = typeof name === 'string' ? name.slice(0, 200).trim() || undefined : undefined;
            const safeCommand = typeof command === 'string' ? command.slice(0, 2000).trim() || undefined : undefined;
            const safeForceAi = forceAiAgent === true;
            // Custom shell terminals MUST be named — the desktop's projectStore
            // doesn't auto-name them.
            if (agentType === 'custom' && !safeName) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Custom terminals require a name' });
                return;
            }
            const safeClientRequestId = typeof clientRequestId === 'string'
                ? clientRequestId.slice(0, 128).trim()
                : undefined;
            if (clientRequestId !== undefined && !safeClientRequestId) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Invalid terminal create request id' });
                return;
            }
            getOrCreateRemoteTerminalRequest(socket, safeClientRequestId, () => requestRendererCreateTerminal({
                projectId,
                agentType,
                name: safeName,
                command: safeCommand,
                forceAiAgent: safeForceAi,
            })).then((result) => {
                if (typeof ack === 'function')
                    ack(result);
            });
        });
        // Close an existing terminal. Operator+ permission required. The actual
        // removal is routed through the renderer store so desktop UI state and
        // persisted project data stay in sync with the phone.
        socket.on('terminal:close', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (rejectWhenPeerSelected(ack, 'Terminal close'))
                return;
            if (!(0, permission_1.hasPermission)(socket, 'operator')) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Insufficient permissions' });
                return;
            }
            const { terminalId } = payload || {};
            if (!terminalId) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Missing terminalId' });
                return;
            }
            requestRendererCloseTerminal(terminalId).then((result) => {
                if (typeof ack === 'function')
                    ack(result);
            });
        });
        // Startup command presets for the phone's Add Terminal sheet — the same
        // catalog the desktop AddTerminalDialog shows: the user's saved custom
        // commands plus the visible built-in presets. Operator+ only (the data
        // only matters for creating terminals, and commands can be sensitive).
        socket.on('terminal:presets', (_payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (rejectWhenPeerSelected(ack, 'Terminal presets'))
                return;
            if (!(0, permission_1.hasPermission)(socket, 'operator')) {
                ack({ ok: false, error: 'Insufficient permissions' });
                return;
            }
            if (!storeManager) {
                ack({ ok: true, presets: [], hiddenAgents: [] });
                return;
            }
            try {
                const startupCommands = storeManager.getPreferences().startupCommands;
                const hiddenDefaultIds = new Set(startupCommands?.hiddenDefaultPresetIds || []);
                const customPresets = (startupCommands?.customPresets || []).filter((p) => !p.hidden);
                const defaultPresets = types_1.DEFAULT_STARTUP_COMMAND_PRESETS.filter((p) => !hiddenDefaultIds.has(p.id));
                const toWire = (preset, isCustom) => ({
                    id: preset.id,
                    name: preset.name,
                    command: preset.command,
                    category: preset.category,
                    icon: preset.icon,
                    isAiAgent: preset.isAiAgent || undefined,
                    isCustom: isCustom || undefined,
                });
                ack({
                    ok: true,
                    presets: [
                        ...customPresets.map((p) => toWire(p, true)),
                        ...defaultPresets.map((p) => toWire(p, false)),
                    ],
                    hiddenAgents: startupCommands?.hiddenAgents || [],
                });
            }
            catch (err) {
                ack({ ok: false, error: err instanceof Error ? err.message : 'Failed to load presets' });
            }
        });
        socket.on('terminal:resize', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (!(0, permission_1.hasPermission)(socket, 'operator')) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Insufficient permissions' });
                return;
            }
            const { terminalId, cols, rows } = payload || {};
            if (!terminalId || !cols || !rows) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Missing terminalId, cols, or rows' });
                return;
            }
            if (selectedPeerId()) {
                ack?.({ ok: true, applied: false, desktopAttached: true });
                return;
            }
            // Size authority is tied to actively VIEWING the terminal. A resize
            // racing ahead of subscribe (the mirror fits on mount) or landing after
            // unsubscribe must not create an orphan claim that gates the desktop
            // forever — reject it; the client re-fits right after subscribe settles.
            const subscribedV2 = [...v2Connections.values()]
                .some((connection) => connection.terminalId === terminalId);
            if (!subscribedTerminals.has(terminalId) && !subscribedV2) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Not subscribed' });
                return;
            }
            try {
                // An operator phone actively viewing a terminal owns its PTY dims —
                // the desktop grid is unreadable on a phone (pan to read every line,
                // tail rows clipped under the composer), so the mirror fits the phone
                // and the shared PTY follows, tmux-style. Multiple phone viewers
                // resolve smallest-wins; the recorded desktop size is only the heal
                // target for when the last viewer detaches
                // (docs/common-errors/remote/remote-phone-size-authority.md).
                terminalSizePolicy_1.remoteSizeAuthority.setViewerSize(terminalId, socket.id, { cols, rows });
                const effective = (0, terminalSizePolicy_1.resolveEffectiveSize)(terminalSizePolicy_1.remoteSizeAuthority.viewerSizes(terminalId));
                if (!effective) {
                    // Defensive: setViewerSize above guarantees at least one size.
                    if (typeof ack === 'function')
                        ack({ ok: false, error: 'Resize failed' });
                    return;
                }
                ptyBackend.resize(terminalId, effective.cols, effective.rows);
                if (typeof ack === 'function') {
                    ack({ ok: true, applied: true, cols: effective.cols, rows: effective.rows, desktopAttached: false });
                }
            }
            catch (err) {
                if (typeof ack === 'function') {
                    ack({ ok: false, error: err instanceof Error ? err.message : 'Resize failed' });
                }
            }
        });
        // --- AI terminal helpers ---
        // ai:terminals — list AI terminals for a project (for "Send to AI" on phone)
        socket.on('ai:terminals', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (rejectWhenPeerSelected(ack, 'AI terminal discovery'))
                return;
            if (!storeManager) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Store not available' });
                return;
            }
            const { projectId } = payload || {};
            if (!projectId) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Missing projectId' });
                return;
            }
            const projects = storeManager.getProjects();
            const project = projects.find((p) => p.id === projectId);
            if (!project) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Project not found' });
                return;
            }
            const allStatuses = ptyBackend.getAllStatuses();
            const aiTerminals = (project.terminals || [])
                .filter((t) => AI_AGENT_TYPES.has(t.agentType))
                .map((t) => ({
                id: t.id,
                name: t.name,
                agentType: t.agentType,
                isAlive: allStatuses[t.id]?.isAlive ?? false,
            }));
            if (typeof ack === 'function')
                ack({ ok: true, terminals: aiTerminals });
        });
        // browser:screenshot — load a localhost URL in a hidden window and capture it
        socket.on('browser:screenshot', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (rejectWhenPeerSelected(ack, 'Browser screenshots'))
                return;
            const { url, scrollY = 0, viewport } = payload || {};
            if (!url) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Missing url' });
                return;
            }
            // Security: only allow localhost URLs
            const parsed = (() => { try {
                return new URL(url);
            }
            catch {
                return null;
            } })();
            if (!parsed || !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Only localhost URLs allowed' });
                return;
            }
            // Create a hidden offscreen window to load and capture the page
            // Mobile viewport: use phone's dimensions; Desktop: 1280x800
            const w = viewport?.width || 1280;
            const h = viewport?.height || 800;
            const offscreen = new electron_1.BrowserWindow({
                width: w,
                height: h,
                show: false,
                webPreferences: { offscreen: true },
            });
            let responded = false;
            const timeout = setTimeout(() => {
                if (!responded) {
                    responded = true;
                    offscreen.destroy();
                    if (typeof ack === 'function')
                        ack({ ok: false, error: 'Capture timeout' });
                }
            }, 15000);
            offscreen.webContents.on('did-finish-load', () => {
                // Scroll to the phone's viewport position, then capture
                const scrollScript = scrollY > 0
                    ? `window.scrollTo(0, ${Math.round(scrollY)})`
                    : '';
                const doCapture = () => {
                    if (responded)
                        return;
                    offscreen.webContents.capturePage().then((image) => {
                        if (responded)
                            return;
                        responded = true;
                        clearTimeout(timeout);
                        const dataUrl = image.toDataURL();
                        offscreen.destroy();
                        if (typeof ack === 'function')
                            ack({ ok: true, imageData: dataUrl });
                    }).catch((err) => {
                        if (responded)
                            return;
                        responded = true;
                        clearTimeout(timeout);
                        offscreen.destroy();
                        if (typeof ack === 'function')
                            ack({ ok: false, error: err instanceof Error ? err.message : 'Capture failed' });
                    });
                };
                // Scroll to position (if needed) and wait for paint, then capture
                const scrollAndWait = scrollY > 0
                    ? `window.scrollTo(0, ${Math.round(scrollY)}); new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`
                    : `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`;
                offscreen.webContents.executeJavaScript(scrollAndWait).then(() => {
                    setTimeout(doCapture, 300);
                }).catch(() => {
                    setTimeout(doCapture, 300);
                });
            });
            offscreen.webContents.on('did-fail-load', (_e, code, desc) => {
                if (responded)
                    return;
                responded = true;
                clearTimeout(timeout);
                offscreen.destroy();
                if (typeof ack === 'function')
                    ack({ ok: false, error: `Page load failed: ${desc} (${code})` });
            });
            offscreen.loadURL(url).catch((err) => {
                if (responded)
                    return;
                responded = true;
                clearTimeout(timeout);
                offscreen.destroy();
                if (typeof ack === 'function')
                    ack({ ok: false, error: err instanceof Error ? err.message : 'Load failed' });
            });
        });
        // ai:send — send a prompt + context + optional image to an AI terminal
        socket.on('ai:send', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (rejectWhenPeerSelected(ack, 'Context-rich AI send'))
                return;
            if (!(0, permission_1.hasPermission)(socket, 'operator')) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Insufficient permissions' });
                return;
            }
            const { terminalId, prompt, context, imageData } = payload || {};
            if (!terminalId || !prompt) {
                if (typeof ack === 'function')
                    ack({ ok: false, error: 'Missing terminalId or prompt' });
                return;
            }
            try {
                // Save image to disk if provided
                let imagePath = null;
                if (imageData && imageData.startsWith('data:image/')) {
                    imagePath = saveRemoteImage(imageData);
                }
                // Build the message. Images are passed as `@<path>` attachments (NOT
                // `![](path)` markdown) — a leading '!' is interpreted by Claude Code
                // as a shell command prefix. (See docs feedback_image_attachment_format.)
                let message = '';
                if (imagePath) {
                    message += `@${imagePath} `;
                }
                message += prompt;
                if (context?.url || context?.userAgent) {
                    message += '\n\nContext:';
                    if (context.url)
                        message += `\n- URL: ${context.url}`;
                    if (context.userAgent)
                        message += `\n- Sent from: ${context.userAgent}`;
                }
                const target = resolveAgentTarget(storeManager, terminalId);
                void promptSubmitter.submit({ terminalId, text: message, target })
                    .then(() => ack?.({ ok: true }))
                    .catch((err) => {
                    ack?.({ ok: false, error: err instanceof Error ? err.message : 'Send failed' });
                });
            }
            catch (err) {
                if (typeof ack === 'function') {
                    ack({ ok: false, error: err instanceof Error ? err.message : 'Send failed' });
                }
            }
        });
        // Clean up all subscriptions on disconnect
        socket.on('disconnect', () => {
            clearHostTerminalSubscriptions();
            delete socket.data.prepareRemoteHostSwitch;
            subscribedTerminals.clear();
            // Phone gone (screen lock, app close, network drop): any terminal that
            // just lost its last size-authority claim heals back to desktop dims.
            for (const terminalId of terminalSizePolicy_1.remoteSizeAuthority.releaseViewer(socket.id)) {
                healPtyToDesktopSize(ptyBackend, terminalId);
            }
        });
    });
}
/**
 * Restore the desktop's recorded PTY dims after the last phone viewer
 * releases size authority. The desktop pane kept its own xterm grid the whole
 * time (its `pty:resize` requests were recorded but gated), so healing the
 * PTY back re-syncs the two and the SIGWINCH makes a live TUI repaint at the
 * owned width. No-op for remote-only terminals or a dead PTY.
 */
function healPtyToDesktopSize(ptyBackend, terminalId) {
    const desktopSize = ptyBackend.getDesktopSize(terminalId);
    if (!desktopSize)
        return;
    const live = ptyBackend.getSize(terminalId);
    if (!live || (live.cols === desktopSize.cols && live.rows === desktopSize.rows))
        return;
    try {
        ptyBackend.resize(terminalId, desktopSize.cols, desktopSize.rows);
    }
    catch {
        // Best-effort: the desktop pane's next fit re-asserts its dims anyway.
    }
}
/**
 * Ensure an output listener is registered for a terminal.
 * Only one listener per terminal — it broadcasts to the socket.io room.
 * Output is batched into OUTPUT_BATCH_MS windows to reduce network overhead.
 */
function ensureOutputListener(io, ptyBackend, activeListeners, outputBatches, terminalId, modelKind = null) {
    if (activeListeners.has(terminalId)) {
        return;
    }
    // Without a live PTY, ptyBackend.onOutput() returns a no-op unsubscribe.
    // Caching that would permanently deafen this terminal's room (the has()
    // short-circuit above skips re-registration even after the PTY spawns).
    // Skip; the next subscribe retries once the PTY exists.
    if (!ptyBackend.hasLiveInstance(terminalId)) {
        return;
    }
    const batch = { chunks: [], timer: null };
    outputBatches.set(terminalId, batch);
    // Live model scan: only for real agents (null kind = plain shell → skip so
    // ordinary output can't false-match a model name). scanChunkForModel is
    // cheaply gated (a few substring checks) before it pays for strip + regex.
    const modelScanState = modelKind ? (0, modelDetect_1.createModelScanState)() : null;
    if (modelScanState)
        terminalModelScanStates.set(terminalId, modelScanState);
    const flushBatch = () => {
        if (batch.chunks.length === 0)
            return;
        let combined = '';
        let seqsComplete = true;
        const parts = [];
        for (const chunk of batch.chunks) {
            combined += chunk.data;
            if (chunk.seq === undefined)
                seqsComplete = false;
            else
                parts.push({ seq: chunk.seq, len: chunk.data.length });
        }
        batch.chunks = [];
        batch.timer = null;
        // Omit parts unless every chunk carried a seq — a partial map could make
        // the client drop content the snapshot doesn't contain (fail open).
        const payload = {
            terminalId,
            data: combined,
            ...(seqsComplete && parts.length > 0 ? { parts } : {}),
        };
        // Raw-v1 compatibility only: never let Socket.IO retain an unbounded ANSI
        // queue for a suspended tab. V2 has its own per-connection ACK window.
        const room = io.sockets.adapter.rooms.get(`terminal:${terminalId}`);
        for (const socketId of room ?? []) {
            const client = io.sockets.sockets.get(socketId);
            if (!client)
                continue;
            const engine = client.conn;
            const queuedBytes = (engine.writeBuffer ?? []).reduce((total, packet) => {
                if (typeof packet.data === 'string')
                    return total + Buffer.byteLength(packet.data);
                return total + Buffer.byteLength(JSON.stringify(packet.data ?? null));
            }, Buffer.byteLength(combined));
            if (queuedBytes > 1024 * 1024) {
                client.emit('terminal:reload-required', {
                    terminalId,
                    reason: 'raw-v1-queue-exceeded',
                });
                client.disconnect(true);
                continue;
            }
            client.emit('terminal:output', payload);
        }
    };
    const unsubscribeOutput = ptyBackend.onOutput(terminalId, (data, seq) => {
        batch.chunks.push({ data, seq });
        // Start a flush timer if one isn't already pending
        if (!batch.timer) {
            batch.timer = setTimeout(flushBatch, OUTPUT_BATCH_MS);
        }
        // Broadcast a model change (e.g. a `/model` switch inside the TUI) to the
        // room so every subscribed phone updates its header chip live.
        if (modelScanState && modelKind) {
            const detected = (0, modelDetect_1.scanChunkForModel)(modelScanState, data, modelKind);
            if (detected && detected !== terminalModels.get(terminalId)) {
                terminalModels.set(terminalId, detected);
                io.to(`terminal:${terminalId}`).emit('terminal:model', {
                    terminalId,
                    model: (0, modelDetect_1.formatModelLabel)(detected),
                });
            }
        }
    });
    // Push dims changes (desktop pane refit, heal, another device's fit) to the
    // room. The subscribe/resize acks carry dims exactly once; without this a
    // phone locked to desktop dims kept painting on a stale grid after any
    // desktop refit — the TUI's relative-cursor redraws then land offset and
    // overlap old rows (docs/common-errors/remote/remote-mirror-stale-size-ghosting.md).
    const sizeBroadcaster = (0, terminalSizePolicy_1.createTerminalSizeBroadcaster)({
        debounceMs: RESIZE_BROADCAST_DEBOUNCE_MS,
        readDecision: () => (0, terminalSizePolicy_1.decideMirrorSize)({
            desktopAttached: ptyBackend.hasDesktopAttachment(terminalId),
            desktopSize: ptyBackend.getDesktopSize(terminalId),
            liveSize: ptyBackend.getSize(terminalId),
            remoteAuthority: terminalSizePolicy_1.remoteSizeAuthority.hasAuthority(terminalId),
        }),
        flushPendingOutput: flushBatch,
        emit: ({ cols, rows, desktopAttached }) => {
            io.to(`terminal:${terminalId}`).emit('terminal:size', { terminalId, cols, rows, desktopAttached });
        },
    });
    const unsubscribeResize = ptyBackend.onResize(terminalId, sizeBroadcaster.schedule);
    activeListeners.set(terminalId, () => {
        sizeBroadcaster.dispose();
        unsubscribeResize();
        unsubscribeOutput();
    });
}
/**
 * Clean up the output listener for a terminal if no sockets remain in its room.
 */
function cleanupListenerIfEmpty(io, activeListeners, outputBatches, terminalId) {
    const roomName = `terminal:${terminalId}`;
    const room = io.sockets.adapter.rooms.get(roomName);
    // Room is empty or doesn't exist
    if (!room || room.size === 0) {
        const unsubscribe = activeListeners.get(terminalId);
        if (unsubscribe) {
            unsubscribe();
            activeListeners.delete(terminalId);
        }
        const batch = outputBatches.get(terminalId);
        if (batch) {
            if (batch.timer)
                clearTimeout(batch.timer);
            outputBatches.delete(terminalId);
        }
        // Drop the cross-chunk scan carry (the last-detected model stays cached in
        // `terminalModels` so a re-subscribe seeds instantly before its buffer scan).
        terminalModelScanStates.delete(terminalId);
    }
}
/**
 * Truncate buffer to approximately the last maxChars characters,
 * breaking at a newline boundary to avoid partial lines.
 */
function truncateBuffer(buffer, maxChars) {
    if (buffer.length <= maxChars) {
        return buffer;
    }
    // Take the tail
    const tail = buffer.slice(-maxChars);
    // Find the first newline to avoid a partial line at the start
    const firstNewline = tail.indexOf('\n');
    if (firstNewline !== -1 && firstNewline < 200) {
        return tail.slice(firstNewline + 1);
    }
    return tail;
}
