"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTerminalNotificationRuntime = createTerminalNotificationRuntime;
const electron_1 = require("electron");
const types_1 = require("../shared/types");
const contracts_1 = require("../shared/terminal/contracts");
const aiPreviewState_1 = require("./aiPreviewState");
const windowsAppIdentity_1 = require("./windowsAppIdentity");
function createTerminalNotificationRuntime({ getMainWindow, getStoreManager, getPtyBackend, getRemoteServer, isWindowFocused, sendToRenderer, }) {
    function getE2ENotificationState() {
        if (process.env.NODE_ENV !== 'test') {
            return null;
        }
        if (!globalThis.__E2E_NOTIFICATION_STATE__) {
            globalThis.__E2E_NOTIFICATION_STATE__ = {
                notifications: [],
                triggerLastClick: null,
                windowFocusedOverride: null,
            };
        }
        return globalThis.__E2E_NOTIFICATION_STATE__;
    }
    function resetE2ENotificationState() {
        const state = getE2ENotificationState();
        if (!state) {
            return;
        }
        state.notifications = [];
        state.triggerLastClick = null;
        state.windowFocusedOverride = null;
    }
    function getTerminalRecord(terminalId) {
        return getStoreManager()?.findTerminalLocation(terminalId) ?? null;
    }
    // Notification icons render around 20-30px on macOS and 48px on Windows. 128px
    // covers retina without sending megabyte-sized data URLs to Notification Center.
    const NOTIFICATION_ICON_PX = 128;
    const notificationIconCache = new Map();
    // Keep every shown Notification referenced until the OS resolves it. macOS keeps
    // the banner in Notification Center long after showTerminalNotification() returns;
    // without a retained reference the JS object (and its 'click' listener) gets
    // garbage-collected, so a later click only triggers the OS default (focus app)
    // and never runs our handler — the app opens but never navigates to the terminal.
    const liveNotifications = new Set();
    function compressNotificationIcon(dataUrl) {
        if (!dataUrl?.startsWith('data:'))
            return undefined;
        const cached = notificationIconCache.get(dataUrl);
        if (cached)
            return cached;
        try {
            const source = electron_1.nativeImage.createFromDataURL(dataUrl);
            if (source.isEmpty())
                return undefined;
            const { width, height } = source.getSize();
            const longest = Math.max(width, height);
            const resized = longest > NOTIFICATION_ICON_PX
                ? source.resize({ width: NOTIFICATION_ICON_PX, height: NOTIFICATION_ICON_PX, quality: 'best' })
                : source;
            if (notificationIconCache.size > 32)
                notificationIconCache.clear();
            notificationIconCache.set(dataUrl, resized);
            return resized;
        }
        catch {
            return undefined;
        }
    }
    function showTerminalNotification(terminalId, elapsedMs, payload) {
        const mainWindow = getMainWindow();
        const e2eState = getE2ENotificationState();
        const windowIsFocused = e2eState?.windowFocusedOverride ?? isWindowFocused();
        if (windowIsFocused || !mainWindow) {
            return;
        }
        const prefs = getStoreManager()?.getPreferences();
        if (prefs?.behavior.playNotificationSound) {
            try {
                electron_1.shell.beep();
            }
            catch {
                // Ignore missing desktop sound support.
            }
        }
        const notificationEvent = e2eState
            ? {
                title: payload.title,
                subtitle: payload.subtitle ?? null,
                body: payload.body,
                terminalId,
                elapsedMs,
                kind: payload.kind,
                clicked: false,
            }
            : null;
        if (notificationEvent) {
            e2eState.notifications.push(notificationEvent);
        }
        const icon = (0, windowsAppIdentity_1.shouldUseCustomNotificationIcon)(process.platform)
            ? compressNotificationIcon(payload.iconDataUrl)
            : undefined;
        const notification = new electron_1.Notification({
            title: payload.title,
            ...(payload.subtitle ? { subtitle: payload.subtitle } : {}),
            body: payload.body,
            silent: false,
            ...(icon ? { icon } : {}),
        });
        notification.on('click', () => {
            if (notificationEvent) {
                notificationEvent.clicked = true;
            }
            if (e2eState) {
                e2eState.windowFocusedOverride = true;
            }
            mainWindow?.show();
            mainWindow?.focus();
            // Navigate renderer to the specific terminal
            const record = getTerminalRecord(terminalId);
            if (record && mainWindow) {
                sendToRenderer('app:navigate-to-terminal', {
                    terminalId,
                    projectId: record.project.id,
                });
            }
        });
        // Release the retained reference once the OS is done with the notification, so
        // the set can't grow unbounded across a long session.
        const release = () => {
            liveNotifications.delete(notification);
        };
        notification.on('click', release);
        notification.on('close', release);
        notification.on('failed', release);
        liveNotifications.add(notification);
        if (notificationEvent) {
            e2eState.triggerLastClick = () => {
                notificationEvent.clicked = true;
                e2eState.windowFocusedOverride = true;
                mainWindow?.show();
                mainWindow?.focus();
                const record = getTerminalRecord(terminalId);
                if (record && mainWindow) {
                    sendToRenderer('app:navigate-to-terminal', {
                        terminalId,
                        projectId: record.project.id,
                    });
                }
            };
        }
        notification.show();
    }
    function truncateForNotification(value, max) {
        return value.length > max ? `${value.slice(0, max - 1)}…` : value;
    }
    function formatElapsedDuration(elapsedMs) {
        const totalSeconds = Math.round(elapsedMs / 1000);
        if (totalSeconds < 60)
            return `${totalSeconds}s`;
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
    }
    function buildTerminalNotificationTitle(projectName, terminalName) {
        return `${truncateForNotification(projectName, 32)} · ${truncateForNotification(terminalName, 24)}`;
    }
    const NOTIFICATION_PREVIEW_CHARS = 280;
    async function getTerminalPreviewForNotification(terminalId) {
        const record = getTerminalRecord(terminalId);
        // Use the effective AI agentType (covers sniffer-promoted bash terminals
        // and command-launched AI agents) so prompt-box chrome gets stripped.
        const effectiveAgentType = (0, aiPreviewState_1.resolveEffectivePreviewAgentType)(terminalId, record?.terminal.agentType, record?.terminal.startupCommand, record?.terminal.forceAiAgent);
        const raw = await getPtyBackend()?.getBufferPreview(terminalId, NOTIFICATION_PREVIEW_CHARS, effectiveAgentType ?? record?.terminal.agentType);
        if (!raw)
            return null;
        // Collapse runs of blank lines and trim — notification body has tight vertical space.
        const cleaned = raw
            .split(/\r?\n/)
            .map((line) => line.replace(/\s+$/, ''))
            .filter((line, idx, arr) => !(line === '' && arr[idx - 1] === ''))
            .join('\n')
            .trim();
        return cleaned || null;
    }
    async function showCommandCompletionNotification(terminalId, elapsedMs) {
        const prefs = getStoreManager()?.getPreferences();
        if (!prefs?.behavior.notifyOnCommandFinish) {
            return;
        }
        const thresholdMs = (prefs.behavior.notifyOnCommandFinishAfter || 10) * 1000;
        if (elapsedMs < thresholdMs) {
            return;
        }
        const record = getTerminalRecord(terminalId);
        const projectName = record?.project.name || 'Project';
        const terminalName = record?.terminal.name || 'Terminal';
        const preview = await getTerminalPreviewForNotification(terminalId);
        const duration = formatElapsedDuration(elapsedMs);
        showTerminalNotification(terminalId, elapsedMs, {
            title: buildTerminalNotificationTitle(projectName, terminalName),
            subtitle: `Done in ${duration}`,
            body: preview ?? `Command completed after ${duration}`,
            kind: 'command-finished',
            iconDataUrl: record?.project.avatar,
        });
    }
    async function showAgentIdleNotification(terminalId, elapsedMs) {
        const prefs = getStoreManager()?.getPreferences();
        if (!prefs?.behavior.notifyOnAgentIdle) {
            return;
        }
        const terminalRecord = getTerminalRecord(terminalId);
        if (!terminalRecord) {
            return;
        }
        const { project, terminal } = terminalRecord;
        if (!(0, contracts_1.isInteractiveAgentTerminal)(terminal.agentType, terminal.startupCommand, terminal.forceAiAgent)) {
            return;
        }
        const thresholdMs = (prefs.behavior.notifyOnAgentIdleAfter || 15) * 1000;
        if (elapsedMs < thresholdMs) {
            return;
        }
        const terminalName = terminal.name || types_1.AGENT_CONFIG[terminal.agentType].name;
        const preview = await getTerminalPreviewForNotification(terminalId);
        const duration = formatElapsedDuration(elapsedMs);
        showTerminalNotification(terminalId, elapsedMs, {
            title: buildTerminalNotificationTitle(project.name, terminalName),
            subtitle: `Idle ${duration}`,
            body: preview ?? `No new output after ${duration} of activity`,
            kind: 'agent-idle',
            iconDataUrl: project.avatar,
        });
    }
    // Activity log: emit terminal events to renderer for in-app popup
    // Dedupe: collapse near-simultaneous command-finished + agent-idle for the same run
    const recentActivityEvents = new Map();
    function emitActivityTerminalEvent(terminalId, elapsedMs, kind) {
        const prefs = getStoreManager()?.getPreferences();
        // Gate on activityLogEnabled preference
        if (!(prefs?.terminal?.activityLogEnabled ?? true))
            return;
        const record = getTerminalRecord(terminalId);
        if (!record)
            return;
        const { project, terminal } = record;
        // This popup is "AI Activity" — only emit for AI terminals
        if (!(0, contracts_1.isInteractiveAgentTerminal)(terminal.agentType, terminal.startupCommand, terminal.forceAiAgent))
            return;
        // Apply duration thresholds to filter trivial idle blips
        if (kind === 'command-finished') {
            const thresholdMs = (prefs?.behavior.notifyOnCommandFinishAfter || 10) * 1000;
            if (elapsedMs < thresholdMs)
                return;
        }
        else {
            const thresholdMs = (prefs?.behavior.notifyOnAgentIdleAfter || 15) * 1000;
            if (elapsedMs < thresholdMs)
                return;
        }
        // Dedupe: if the same terminal emitted within 5s with a similar elapsedMs,
        // treat it as a duplicate signal for the same run (e.g. command-finished
        // followed by agent-idle). Otherwise it's a new run — allow it through.
        const now = Date.now();
        const prev = recentActivityEvents.get(terminalId);
        if (prev && now - prev.timestamp < 5000) {
            const elapsedDiff = Math.abs(elapsedMs - prev.elapsedMs);
            if (elapsedDiff < 3000)
                return; // same run, skip duplicate
        }
        recentActivityEvents.set(terminalId, { timestamp: now, elapsedMs });
        // Clean up old entries periodically
        if (recentActivityEvents.size > 100) {
            for (const [id, entry] of recentActivityEvents) {
                if (now - entry.timestamp > 30000)
                    recentActivityEvents.delete(id);
            }
        }
        sendToRenderer('app:activity-terminal-event', {
            type: kind,
            projectId: project.id,
            projectName: project.name,
            projectColor: project.color,
            terminalId,
            terminalName: terminal.name,
            agentType: terminal.agentType,
            elapsedMs,
            timestamp: now,
        });
        // Bridge the same event to any connected phones so the remote UI can show an
        // in-app banner + a native notification. Reuses all the gating/dedupe above.
        getRemoteServer()?.broadcastActivity({
            type: kind,
            projectId: project.id,
            projectName: project.name,
            terminalId,
            terminalName: terminal.name || 'Terminal',
            title: `${project.name} · ${terminal.name || 'Terminal'}`,
            body: kind === 'agent-idle'
                ? 'Agent is idle — waiting for you'
                : `Command finished in ${formatElapsedDuration(elapsedMs)}`,
            timestamp: now,
        });
    }
    return {
        resetE2ENotificationState,
        showCommandCompletionNotification,
        showAgentIdleNotification,
        emitActivityTerminalEvent,
    };
}
