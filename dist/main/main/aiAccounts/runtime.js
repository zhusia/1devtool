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
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAiAccountsRuntime = createAiAccountsRuntime;
const electron_1 = require("electron");
const types_1 = require("../../shared/types");
const aiAccounts = __importStar(require("../aiAccounts"));
const registry_1 = require("./registry");
const history_1 = require("../aiPool/history");
const forecast_1 = require("../aiPool/forecast");
const aiPool = __importStar(require("../aiPool"));
const guards_1 = require("../aiPool/guards");
const journal_1 = require("../aiPool/journal");
function createAiAccountsRuntime({ storeManager, getMainWindow, sendToRenderer, sendToPopoutWindows, isTerminalAlive, }) {
    const liveQuotaNotifications = new Set();
    // BUG-82: refuse global credential swaps while a live terminal of that
    // agent would see rewritten auth.json. Fail open when isTerminalAlive is
    // missing (never refuse every switch). Terminals already leased to the
    // target account are exempt — they already run on those credentials.
    (0, guards_1.setLiveAgentTerminalProbe)((agent, targetAccountId) => {
        if (!isTerminalAlive)
            return false;
        for (const project of storeManager.getProjects()) {
            for (const terminal of project.terminals) {
                if (terminal.peerDeviceId)
                    continue;
                const pathAgent = aiPool.poolAgentForTerminal(terminal.agentType, terminal.startupCommand);
                if (pathAgent !== agent)
                    continue;
                // Mirror of durable pool assignment (display-only on the terminal).
                if (terminal.poolAccountId === targetAccountId)
                    continue;
                if (isTerminalAlive(terminal.id))
                    return true;
            }
        }
        return false;
    });
    const pendingAiAccountLogins = new Map();
    function emitAiAccountsChanged(payload) {
        sendToRenderer('ai-accounts:changed', payload);
        sendToPopoutWindows('ai-accounts:changed', payload);
    }
    /**
     * Run opt-in auto-switch (Claude/Codex). Reads last-known statuses, so callers
     * should refresh statuses first. Emits a changed event + an OS notification for
     * each switch — the destructive swap means the user must restart that terminal.
     */
    async function runAiAccountAutoSwitch(overrides, agent) {
        const results = await aiAccounts.evaluateAutoSwitch(overrides, agent).catch((err) => {
            console.warn('[ai-accounts] auto-switch evaluation failed:', err);
            return [];
        });
        for (const result of results) {
            emitAiAccountsChanged({ agentType: result.agent, reason: 'auto-switch', toLabel: result.toLabel });
            try {
                if (electron_1.Notification.isSupported()) {
                    new electron_1.Notification({
                        title: 'AI account auto-switched',
                        body: `${result.agent} reached its usage limit — switched to ${result.toLabel}. Restart that terminal to apply.`,
                    }).show();
                }
            }
            catch {
                /* notifications are best-effort */
            }
        }
    }
    // Background auto-switch poll — runs only while at least one tool has it enabled.
    let autoSwitchPollTimer = null;
    const AUTO_SWITCH_POLL_MS = 5 * 60_000;
    async function syncAutoSwitchPoll() {
        const enabled = await aiAccounts.isAnyAutoSwitchEnabled().catch(() => false);
        if (enabled && !autoSwitchPollTimer) {
            autoSwitchPollTimer = setInterval(() => {
                if (!storeManager)
                    return;
                const overrides = storeManager.getPreferences().aiAgentPaths || {};
                void aiAccounts
                    .refreshSavedAccountStatuses(undefined, overrides)
                    .then(() => runAiAccountAutoSwitch(overrides))
                    .catch((err) => console.warn('[ai-accounts] auto-switch poll failed:', err));
            }, AUTO_SWITCH_POLL_MS);
            autoSwitchPollTimer.unref?.();
        }
        else if (!enabled && autoSwitchPollTimer) {
            clearInterval(autoSwitchPollTimer);
            autoSwitchPollTimer = null;
        }
    }
    // ── Quota alerts (per-agent "warn me at N%") ────────────────────────────────────
    function emitQuotaAlert(payload) {
        sendToRenderer('ai-accounts:quota-alert', payload);
        sendToPopoutWindows('ai-accounts:quota-alert', payload);
    }
    function formatQuotaWindowLabel(windowMinutes) {
        if (windowMinutes === 300)
            return '5-hour limit';
        if (windowMinutes === 10_080)
            return 'weekly limit';
        if (windowMinutes && windowMinutes % 1_440 === 0)
            return `${windowMinutes / 1_440}-day limit`;
        if (windowMinutes && windowMinutes % 60 === 0)
            return `${windowMinutes / 60}-hour limit`;
        return 'quota';
    }
    // QuotaAgentType → AGENT_CONFIG key (Antigravity's config lives under 'agy').
    function quotaAgentConfigKey(agent) {
        return agent === 'antigravity' ? 'agy' : agent;
    }
    /**
     * Read each enabled agent's live quota; for every threshold crossing, push the
     * in-app alert modal (renderer event) and fire an OS notification. Fires once per
     * quota window (dedup lives in aiAccounts' in-memory arm state).
     */
    async function runQuotaAlertEvaluation(overrides, agent, opts) {
        const alerts = await aiAccounts.evaluateQuotaAlerts(overrides, agent, opts).catch((err) => {
            console.warn('[ai-accounts] quota-alert evaluation failed:', err);
            return [];
        });
        for (const alert of alerts) {
            emitQuotaAlert(alert);
            try {
                if (!electron_1.Notification.isSupported())
                    continue;
                const agentName = types_1.AGENT_CONFIG[quotaAgentConfigKey(alert.agent)]?.name ?? alert.agent;
                // Antigravity's two weekly groups share windowMinutes, so prefer the
                // group label ("Gemini" / "Claude & GPT") when the payload carries one.
                const windowLabel = alert.windowLabel
                    ? `${alert.windowLabel} quota`
                    : formatQuotaWindowLabel(alert.windowMinutes);
                const notification = new electron_1.Notification({
                    title: 'AI quota alert',
                    body: `${agentName} has reached ${alert.usedPercent}% of its ${windowLabel}.`,
                });
                // Retain until the OS resolves it, else the click handler is GC'd (see liveQuotaNotifications).
                const release = () => liveQuotaNotifications.delete(notification);
                notification.on('click', () => {
                    getMainWindow()?.show();
                    getMainWindow()?.focus();
                });
                notification.on('click', release);
                notification.on('close', release);
                notification.on('failed', release);
                liveQuotaNotifications.add(notification);
                notification.show();
            }
            catch {
                /* notifications are best-effort */
            }
        }
    }
    // Bounded quota-history sampler (quota-center §7, Phase 1). Every tick rides
    // buildState(), whose 60s status cache and provider-wide 429 gate bound the
    // real probe pressure; samples land via the persistFreshLiveStatuses hook.
    // Skips entirely while no account is saved, so non-users pay nothing.
    let quotaHistorySampleTimer = null;
    const QUOTA_HISTORY_SAMPLE_MS = 10 * 60_000;
    /** True while any app window is on screen (not closed, hidden, or minimized). */
    function hasVisibleAppWindow() {
        return electron_1.BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.isVisible() && !win.isMinimized());
    }
    function startQuotaHistorySampler() {
        if (quotaHistorySampleTimer)
            return;
        quotaHistorySampleTimer = setInterval(() => {
            void (async () => {
                // Window-presence gate: a 10-min tick always misses the 60s status
                // cache, so with the app minimized/closed-to-dock this was real
                // provider traffic forever, feeding a forecast nobody can see. The
                // forecast needs only ≥4 samples/30 min, and any foreground status
                // fetch after the window returns appends samples through the same
                // persistFreshLiveStatuses hook — so it re-warms on its own. Quota
                // ALERTS do not depend on this timer (they have their own poll).
                if (!hasVisibleAppWindow())
                    return;
                const reg = await (0, registry_1.readRegistry)().catch(() => null);
                if (!reg || Object.values(reg.accounts).every((list) => list.length === 0))
                    return;
                const overrides = storeManager.getPreferences().aiAgentPaths || {};
                await aiAccounts.buildState(overrides).catch(() => undefined);
            })();
        }, QUOTA_HISTORY_SAMPLE_MS);
        quotaHistorySampleTimer.unref?.();
    }
    // Background quota-alert poll — runs only while at least one agent has it enabled.
    let quotaAlertPollTimer = null;
    const QUOTA_ALERT_POLL_MS = 2 * 60_000;
    async function syncQuotaAlertPoll() {
        const enabled = await aiAccounts.isAnyQuotaAlertEnabled().catch(() => false);
        if (enabled && !quotaAlertPollTimer) {
            quotaAlertPollTimer = setInterval(() => {
                if (!storeManager)
                    return;
                const overrides = storeManager.getPreferences().aiAgentPaths || {};
                // background: CLI-probe providers (amp exec, interactive agy PTY) may
                // reuse a stale cache instead of re-spawning every 2-min tick.
                void runQuotaAlertEvaluation(overrides, undefined, { background: true });
            }, QUOTA_ALERT_POLL_MS);
            quotaAlertPollTimer.unref?.();
        }
        else if (!enabled && quotaAlertPollTimer) {
            clearInterval(quotaAlertPollTimer);
            quotaAlertPollTimer = null;
        }
    }
    async function maybeFinalizePendingAiLogin(terminalId, source) {
        const pending = pendingAiAccountLogins.get(terminalId);
        if (!pending || !storeManager)
            return;
        const overrides = storeManager.getPreferences().aiAgentPaths || {};
        const currentDigest = await aiAccounts.getLiveAuthDigest(pending.agentType, overrides).catch(() => null);
        if (!currentDigest || currentDigest === pending.baselineDigest) {
            if (source === 'exit' || Date.now() - pending.startedAt > 30 * 60_000) {
                pendingAiAccountLogins.delete(terminalId);
            }
            return;
        }
        const result = await aiAccounts.autoSaveCurrent(pending.agentType, overrides).catch((error) => {
            console.warn('[ai-accounts] auto-save after login failed:', error);
            return null;
        });
        pendingAiAccountLogins.delete(terminalId);
        if (!result)
            return;
        emitAiAccountsChanged({
            agentType: pending.agentType,
            reason: 'auto-save',
            action: result.action,
            terminalId,
        });
    }
    function registerIpcHandlers() {
        // AI account switching (Settings → AI tab, Accounts section) ────────────
        electron_1.ipcMain.handle('ai-accounts:state', async () => {
            const overrides = storeManager.getPreferences().aiAgentPaths || {};
            return aiAccounts.buildState(overrides);
        });
        // Per-agent quota — the pill's lazy path (only the focused agent is computed).
        electron_1.ipcMain.handle('ai-accounts:agent-status', async (_, args) => {
            const overrides = storeManager.getPreferences().aiAgentPaths || {};
            const status = await aiAccounts.buildAgentStatus(args.agentType, overrides, args.force).catch(() => null);
            // Prompt quota-alert check on focus. Gated on the poll being active so this is
            // a cheap no-op (no registry read) unless the feature is actually enabled; the
            // reused 60s status cache means no extra network. Shares arm state with the poll.
            if (quotaAlertPollTimer)
                void runQuotaAlertEvaluation(overrides, args.agentType);
            return status;
        });
        // Amp quota side channel (amp isn't an account; CLI-session only).
        electron_1.ipcMain.handle('ai-quota:amp', async () => {
            return aiAccounts.readAmpQuotaCached().catch(() => null);
        });
        // Antigravity quota side channel (`agy` exposes usage through interactive /usage).
        electron_1.ipcMain.handle('ai-quota:antigravity', async () => {
            const overrides = storeManager.getPreferences().aiAgentPaths || {};
            return aiAccounts.readAntigravityQuotaCached(overrides).catch(() => null);
        });
        // Grok quota side channel. Normal reads use the cheap local billing log
        // (folded so a post-reset percent cannot snap back to a stale 99%);
        // only an explicit desktop focus fallback / Refresh requests the hidden
        // `/usage show` probe.
        electron_1.ipcMain.handle('ai-quota:grok', async (_, args) => {
            return aiAccounts.readGrokQuotaCached(args?.probe === true).catch(() => null);
        });
        // Cursor quota side channel: identity + plan only. Cursor publishes no
        // usage numbers to the CLI (`cursor-agent about`), so the status is
        // window-less and the UI explains where usage actually lives.
        electron_1.ipcMain.handle('ai-quota:cursor', async () => {
            return aiAccounts.readCursorQuotaCached().catch(() => null);
        });
        // Quota-sample history + pure ETA forecast (quota-center §7, Phase 1).
        electron_1.ipcMain.handle('ai-pool:history', async (_, query) => {
            return (0, history_1.queryQuotaHistory)(query).catch(() => []);
        });
        electron_1.ipcMain.handle('ai-pool:forecast', async (_, args) => {
            const samples = await (0, history_1.queryQuotaHistory)({
                agent: args.agent,
                accountId: args.accountId,
                fromMs: Date.now() - 6 * 3_600_000,
            }).catch(() => []);
            const points = samples
                .map((sample) => ({
                ts: sample.ts,
                pct: Math.max(sample.primaryPct ?? -1, sample.secondaryPct ?? -1),
            }))
                .filter((point) => point.pct >= 0);
            return (0, forecast_1.forecastToPercent)(points, 100, Date.now());
        });
        // Pool engine (quota-center §11, Phase 2 — conservative Level 2).
        electron_1.ipcMain.handle('ai-pool:state', async () => aiPool.buildPoolState());
        electron_1.ipcMain.handle('ai-pool:reserve', async (_, args) => {
            return aiPool.reserve(args.selection);
        });
        electron_1.ipcMain.handle('ai-pool:cancel-reservation', async (_, args) => {
            aiPool.cancelReservation(args.reservationId);
        });
        electron_1.ipcMain.handle('ai-pool:set-policy', async (_, args) => {
            await aiPool.setPolicy(args.agent, args.policy);
            return aiPool.buildPoolState();
        });
        electron_1.ipcMain.handle('ai-pool:set-chain', async (_, args) => {
            await aiPool.setChain(args.chain);
            return aiPool.buildPoolState();
        });
        electron_1.ipcMain.handle('ai-pool:set-account-enabled', async (_, args) => {
            await aiPool.setAccountEnabled(args.agent, args.accountId, args.enabled);
            return aiPool.buildPoolState();
        });
        electron_1.ipcMain.handle('ai-pool:set-plan-price', async (_, args) => {
            await aiPool.setPlanPrice(args.agent, args.accountId, args.priceUsdMonthly);
        });
        electron_1.ipcMain.handle('ai-pool:journal', async (_, args) => {
            return (0, journal_1.readJournal)(args?.limit ?? 500, args?.kinds);
        });
        aiPool.setPoolChangedNotifier((reason) => {
            sendToRenderer('ai-pool:changed', { reason });
        });
        void aiPool.initPoolEngine();
        electron_1.ipcMain.handle('ai-accounts:save-current', async (_, args) => {
            const overrides = storeManager.getPreferences().aiAgentPaths || {};
            const summary = await aiAccounts.saveCurrent(args.agentType, args.label, overrides);
            emitAiAccountsChanged({ agentType: args.agentType, reason: 'manual-save', action: 'saved' });
            return summary;
        });
        electron_1.ipcMain.handle('ai-accounts:switch', async (_, args) => {
            const overrides = storeManager.getPreferences().aiAgentPaths || {};
            const summary = await aiAccounts.switchTo(args.agentType, args.id, overrides);
            emitAiAccountsChanged({ agentType: args.agentType, reason: 'switch' });
            return summary;
        });
        electron_1.ipcMain.handle('ai-accounts:rename', async (_, args) => {
            return aiAccounts.renameAccount(args.agentType, args.id, args.label);
        });
        electron_1.ipcMain.handle('ai-accounts:remove', async (_, args) => {
            await aiAccounts.removeSavedAccount(args.agentType, args.id);
            emitAiAccountsChanged({ agentType: args.agentType, reason: 'remove' });
        });
        electron_1.ipcMain.handle('ai-accounts:restore-previous', async (_, args) => {
            const overrides = storeManager.getPreferences().aiAgentPaths || {};
            const restored = await aiAccounts.restorePrevious(args.agentType, overrides);
            if (restored) {
                emitAiAccountsChanged({ agentType: args.agentType, reason: 'restore-previous' });
            }
            return restored;
        });
        electron_1.ipcMain.handle('ai-accounts:prepare-login', async (_, args) => {
            if (args.agentType !== 'codex')
                return;
            const overrides = storeManager.getPreferences().aiAgentPaths || {};
            // This runs before the renderer creates the `codex login` terminal, so a
            // CLI-rotated token cannot be lost when that command replaces auth.json.
            await aiAccounts.syncActiveCodexSnapshot(overrides);
        });
        electron_1.ipcMain.handle('ai-accounts:track-login-terminal', async (_, args) => {
            const overrides = storeManager.getPreferences().aiAgentPaths || {};
            const baselineDigest = await aiAccounts.getLiveAuthDigest(args.agentType, overrides).catch(() => null);
            pendingAiAccountLogins.set(args.terminalId, {
                agentType: args.agentType,
                baselineDigest,
                startedAt: Date.now(),
            });
        });
        electron_1.ipcMain.handle('ai-accounts:refresh-statuses', async (_, args) => {
            const overrides = storeManager.getPreferences().aiAgentPaths || {};
            const state = await aiAccounts.refreshSavedAccountStatuses(args.agentType, overrides);
            for (const agentType of args.agentType ? [args.agentType] : ['claude', 'codex', 'gemini', 'qwen', 'opencode']) {
                emitAiAccountsChanged({ agentType, reason: 'refresh-statuses' });
            }
            // Statuses are now fresh — evaluate opt-in auto-switch off the back of them.
            await runAiAccountAutoSwitch(overrides, args.agentType);
            return state;
        });
        electron_1.ipcMain.handle('ai-accounts:get-settings', async () => {
            return aiAccounts.getSettings();
        });
        electron_1.ipcMain.handle('ai-accounts:set-auto-switch', async (_, args) => {
            const settings = await aiAccounts.setAutoSwitch(args.agentType, args.enabled, args.threshold);
            await syncAutoSwitchPoll();
            // If just enabled, refresh + evaluate immediately so it can act without waiting for the poll.
            if (args.enabled) {
                const overrides = storeManager.getPreferences().aiAgentPaths || {};
                await aiAccounts
                    .refreshSavedAccountStatuses(args.agentType, overrides)
                    .catch(() => undefined);
                await runAiAccountAutoSwitch(overrides, args.agentType);
            }
            return settings;
        });
        electron_1.ipcMain.handle('ai-accounts:accept-auto-switch-disclaimer', async () => {
            return aiAccounts.acceptAutoSwitchDisclaimer();
        });
        electron_1.ipcMain.handle('ai-accounts:set-quota-alert', async (_, args) => {
            const settings = await aiAccounts.setQuotaAlert(args.agentType, args.enabled, args.sessionThreshold, args.weeklyThreshold);
            await syncQuotaAlertPoll();
            // If just enabled, evaluate immediately so an already-over agent alerts now.
            if (args.enabled) {
                const overrides = storeManager.getPreferences().aiAgentPaths || {};
                void runQuotaAlertEvaluation(overrides, args.agentType);
            }
            return settings;
        });
        // Resume the background polls if a previous session left them enabled.
        void syncAutoSwitchPoll();
        void syncQuotaAlertPoll();
        startQuotaHistorySampler();
    }
    return {
        registerIpcHandlers,
        maybeFinalizePendingAiLogin,
    };
}
