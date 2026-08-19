"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pushDashboardToSocket = pushDashboardToSocket;
exports.registerDashboardHandlers = registerDashboardHandlers;
exports.catalogToDashboard = catalogToDashboard;
const aiPreviewState_1 = require("../../aiPreviewState");
const contracts_1 = require("../../../shared/terminal/contracts");
// A terminal counts as "running" if it produced output within this window.
// 5s poll cadence + a slightly larger window than the desktop's 5s fallback so
// a terminal mid-run isn't flagged idle between polls.
const RUNNING_ACTIVITY_WINDOW_MS = 6000;
const _terminalRunState = new Map();
/**
 * Fold a terminal's PTY liveness + activity into the kanban run-state, updating
 * the module tracker and returning the wire fields. `isAi` gates needsReview so
 * plain shells never land in the review column.
 */
function computeTerminalRuntime(terminalId, isAlive, lastActivityAt, isAi, now) {
    let status;
    if (!isAlive)
        status = 'error';
    else if (lastActivityAt > 0 && now - lastActivityAt < RUNNING_ACTIVITY_WINDOW_MS)
        status = 'running';
    else
        status = 'idle';
    const prev = _terminalRunState.get(terminalId);
    const prevStatus = prev?.prevStatus ?? null;
    let runStartedAt = prev?.runStartedAt ?? 0;
    let needsReview = prev?.needsReview ?? false;
    if (status === 'running') {
        if (prevStatus !== 'running')
            runStartedAt = now; // fresh run began
        needsReview = false;
    }
    else if (prevStatus === 'running' && isAi) {
        needsReview = true; // an AI run just finished — surface for review
    }
    _terminalRunState.set(terminalId, { prevStatus: status, runStartedAt, needsReview });
    return {
        status,
        needsReview,
        runStartedAt: status === 'running' && runStartedAt > 0 ? runStartedAt : null,
    };
}
/**
 * Register dashboard event handlers.
 *
 * On auth success, pushes a full dashboard:snapshot with project and terminal data.
 * Periodically watches for changes and pushes dashboard:delta updates.
 */
/**
 * Push the initial dashboard snapshot to a freshly-authenticated socket
 * and start polling for changes.  Called from the auth middleware's
 * onAuthSuccess callback.
 */
async function pushDashboardToSocket(socket, managers) {
    socket.data.remoteHostId ??= 'local';
    try {
        const snapshot = await buildSnapshotForSocket(socket, managers);
        socket.emit('dashboard:snapshot', snapshot);
        _lastSnapshotHash.set(socket, hashSnapshot(snapshot));
    }
    catch (err) {
        socket.emit('dashboard:error', {
            message: err instanceof Error ? err.message : 'Failed to build dashboard snapshot',
        });
        return;
    }
    // Start polling for changes every 5 seconds
    const interval = setInterval(async () => {
        if (!socket.connected || !socket.data.authenticated) {
            clearInterval(interval);
            return;
        }
        try {
            const snapshot = await buildSnapshotForSocket(socket, managers);
            const hash = hashSnapshot(snapshot);
            const prevHash = _lastSnapshotHash.get(socket);
            if (hash !== prevHash) {
                socket.emit('dashboard:snapshot', snapshot);
                _lastSnapshotHash.set(socket, hash);
            }
        }
        catch {
            // Swallow polling errors silently
        }
    }, 5000);
    _pollingIntervals.set(socket, interval);
}
// Module-level maps for polling state
const _pollingIntervals = new WeakMap();
const _lastSnapshotHash = new WeakMap();
function registerDashboardHandlers(io, managers) {
    io.on('connection', (socket) => {
        // Allow explicit snapshot requests
        socket.on('dashboard:snapshot', async (_payload, ack) => {
            if (!socket.data.authenticated)
                return;
            try {
                const snapshot = await buildSnapshotForSocket(socket, managers);
                if (typeof ack === 'function') {
                    ack({ ok: true, data: snapshot });
                }
                else {
                    socket.emit('dashboard:snapshot', snapshot);
                }
            }
            catch (err) {
                if (typeof ack === 'function') {
                    ack({ ok: false, error: err instanceof Error ? err.message : 'Unknown error' });
                }
            }
        });
        socket.on('dashboard:select-host', async (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            const hostId = payload?.hostId || 'local';
            const currentHostId = typeof socket.data.remoteHostId === 'string'
                ? socket.data.remoteHostId
                : 'local';
            if (hostId !== 'local') {
                const peer = (await managers.getDeviceHostProxy?.()?.listPeerHosts() ?? [])
                    .find((row) => row.deviceId === hostId);
                if (!peer) {
                    ack?.({ ok: false, error: 'That host is no longer paired.' });
                    return;
                }
                if (!peer.online) {
                    ack?.({ ok: false, error: `${peer.displayName} is offline.` });
                    return;
                }
            }
            if (hostId !== currentHostId) {
                const prepareHostSwitch = socket.data.prepareRemoteHostSwitch;
                if (typeof prepareHostSwitch === 'function')
                    prepareHostSwitch();
            }
            socket.data.remoteHostId = hostId;
            try {
                const snapshot = await buildSnapshotForSocket(socket, managers);
                socket.emit('dashboard:snapshot', snapshot);
                _lastSnapshotHash.set(socket, hashSnapshot(snapshot));
                ack?.({ ok: true, data: snapshot });
            }
            catch (err) {
                ack?.({ ok: false, error: err instanceof Error ? err.message : 'Could not select host.' });
            }
        });
        // Clean up polling interval on disconnect
        socket.on('disconnect', () => {
            const interval = _pollingIntervals.get(socket);
            if (interval) {
                clearInterval(interval);
            }
        });
    });
}
async function buildSnapshotForSocket(socket, managers) {
    const peers = await managers.getDeviceHostProxy?.()?.listPeerHosts() ?? [];
    const hosts = [
        { hostId: 'local', displayName: 'This Mac', kind: 'local', online: true },
        ...peers.map((peer) => ({
            hostId: peer.deviceId,
            displayName: peer.displayName,
            kind: 'peer',
            online: peer.online,
            platform: peer.platform,
            appVersion: peer.appVersion,
        })),
    ];
    const requestedHostId = typeof socket.data.remoteHostId === 'string' ? socket.data.remoteHostId : 'local';
    const selectedPeer = peers.find((peer) => peer.deviceId === requestedHostId);
    if (requestedHostId === 'local' || !selectedPeer) {
        if (!selectedPeer)
            socket.data.remoteHostId = 'local';
        return {
            ...(await buildSnapshot(managers.storeManager, managers.ptyBackend, managers.gitManager)),
            hosts,
            activeHostId: 'local',
        };
    }
    if (!selectedPeer.online) {
        return { projects: [], activeProjectId: null, timestamp: Date.now(), hosts, activeHostId: selectedPeer.deviceId, hostError: `${selectedPeer.displayName} is offline.` };
    }
    const result = await managers.getDeviceHostProxy?.()?.fetchPeerCatalog(selectedPeer.deviceId);
    if (!result?.ok) {
        return {
            projects: [],
            activeProjectId: null,
            timestamp: Date.now(),
            hosts,
            activeHostId: selectedPeer.deviceId,
            hostError: result?.error.message ?? 'The peer catalog is unavailable.',
        };
    }
    return catalogToDashboard(result.snapshot, selectedPeer, hosts);
}
function catalogToDashboard(catalog, peer, hosts) {
    const projects = catalog.projects.map((project, index) => {
        const terminals = catalog.terminals
            .filter((terminal) => terminal.projectId === project.projectId && !terminal.isHidden)
            .map((terminal) => ({
            id: terminal.terminalId,
            name: terminal.name,
            agentType: terminal.agentType,
            effectiveAgentType: terminal.isInteractiveAgent ? terminal.agentType : null,
            isAlive: terminal.running,
            lastActivityPreview: null,
            status: terminal.running ? 'idle' : 'error',
            needsReview: false,
            lastActivityAt: terminal.lastActivityAt ?? 0,
            runStartedAt: null,
            terminalGeneration: terminal.terminalGeneration,
        }));
        return {
            id: project.projectId,
            name: project.name,
            rootPath: project.rootPath,
            color: ['#6366f1', '#8b5cf6', '#06b6d4', '#10b981'][index % 4],
            terminalCount: terminals.length,
            terminals,
            git: { branch: null, dirty: false },
            browserUrl: null,
        };
    });
    return {
        projects,
        activeProjectId: null,
        timestamp: Date.now(),
        hosts,
        activeHostId: peer.deviceId,
    };
}
/**
 * Build a full dashboard snapshot with project, terminal, and git data.
 */
async function buildSnapshot(storeManager, ptyBackend, gitManager) {
    const projects = storeManager.getProjects();
    const activeProjectId = storeManager.getActiveProjectId();
    const allStatuses = ptyBackend.getAllStatuses();
    const projectSnapshots = await Promise.all(projects.map(async (project) => buildProjectSnapshot(project, allStatuses, ptyBackend, gitManager)));
    // Prune run-state for terminals that no longer exist so the tracker can't
    // grow without bound across the app's lifetime.
    const liveIds = new Set(projectSnapshots.flatMap((p) => p.terminals.map((t) => t.id)));
    for (const id of _terminalRunState.keys()) {
        if (!liveIds.has(id))
            _terminalRunState.delete(id);
    }
    return {
        projects: projectSnapshots,
        activeProjectId,
        timestamp: Date.now(),
    };
}
/**
 * Build snapshot data for a single project.
 */
async function buildProjectSnapshot(project, allStatuses, ptyBackend, gitManager) {
    // Build terminal snapshots
    const now = Date.now();
    const terminals = await Promise.all((project.terminals || [])
        .filter((t) => !t.isHidden)
        .map(async (terminal) => {
        const ptyStatus = allStatuses[terminal.id];
        const isAlive = ptyStatus?.isAlive ?? false;
        const lastActivityAt = ptyStatus?.lastActivityAt ?? 0;
        const effectiveAgentType = (0, aiPreviewState_1.resolveEffectivePreviewAgentType)(terminal.id, terminal.agentType, terminal.startupCommand, terminal.forceAiAgent);
        const isAi = terminal.forceAiAgent === true ||
            (0, contracts_1.isInteractiveAgentType)((effectiveAgentType ?? terminal.agentType));
        const runtime = computeTerminalRuntime(terminal.id, isAlive, lastActivityAt, isAi, now);
        return {
            id: terminal.id,
            name: terminal.name,
            agentType: terminal.agentType,
            effectiveAgentType: effectiveAgentType ?? null,
            lastSessionId: terminal.lastSessionId,
            lastSessionAgentType: terminal.lastSessionAgentType,
            isAlive,
            lastActivityPreview: await ptyBackend.getBufferPreview(terminal.id, 120, effectiveAgentType ?? terminal.agentType),
            status: runtime.status,
            needsReview: runtime.needsReview,
            lastActivityAt,
            runStartedAt: runtime.runStartedAt,
        };
    }));
    // Fetch git status (non-blocking, default to null on error)
    let gitBranch = null;
    let gitDirty = false;
    try {
        const gitSummary = await gitManager.getSummary(project.rootPath, { $nullOnError: true });
        if (gitSummary) {
            gitBranch = gitSummary.branch;
            gitDirty =
                gitSummary.stagedCount > 0 ||
                    gitSummary.unstagedCount > 0 ||
                    gitSummary.untrackedCount > 0;
        }
    }
    catch {
        // Git not available for this project
    }
    return {
        id: project.id,
        name: project.name,
        rootPath: project.rootPath,
        color: project.color,
        avatar: project.avatar,
        emoji: project.emoji,
        terminalCount: terminals.length,
        terminals,
        git: {
            branch: gitBranch,
            dirty: gitDirty,
        },
        browserUrl: getBrowserUrl(project),
    };
}
/**
 * Get the browser URL for a project — uses the active tab's URL if available,
 * otherwise falls back to the base browser URL.
 */
function getBrowserUrl(project) {
    const browser = project.outputPanel?.browser;
    if (!browser)
        return null;
    // If there are tabs, find the active one
    if (browser.tabs?.length > 0 && browser.activeTabId) {
        const activeTab = browser.tabs.find((t) => t.id === browser.activeTabId);
        if (activeTab?.url)
            return activeTab.url;
    }
    // Fall back to the base browser URL
    return browser.url || null;
}
/**
 * Simple hash of snapshot data for change detection.
 * Uses JSON stringification — fast enough for 5s polling intervals.
 */
function hashSnapshot(snapshot) {
    // Exclude timestamp from hash since it always changes
    const { timestamp: _, ...rest } = snapshot;
    return JSON.stringify(rest);
}
