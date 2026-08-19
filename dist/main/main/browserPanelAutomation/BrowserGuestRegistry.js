"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserGuestRegistry = void 0;
const electron_1 = require("electron");
const browserMcp_1 = require("../../shared/browserMcp");
const browserPolicy_1 = require("./browserPolicy");
const CONSOLE_LIMIT = 500;
function targetKey(projectId, tabId) {
    return `${projectId}\u0000${tabId}`;
}
class BrowserGuestRegistry {
    getStoreManager;
    entries = new Map();
    keyByWebContentsId = new Map();
    constructor(getStoreManager) {
        this.getStoreManager = getStoreManager;
    }
    register(host, request) {
        if (!request || typeof request.projectId !== 'string' || typeof request.tabId !== 'string') {
            return { ok: false, error: 'projectId and tabId are required' };
        }
        if (!Number.isInteger(request.webContentsId) || request.webContentsId <= 0 || !request.registrationId) {
            return { ok: false, error: 'A valid webContentsId and registrationId are required' };
        }
        const storeManager = this.getStoreManager();
        const project = storeManager?.getProjects().find((candidate) => candidate.id === request.projectId);
        if (!project)
            return { ok: false, error: 'Project not found' };
        if (!(0, browserMcp_1.getPersistedBrowserTabs)(project).some((tab) => tab.id === request.tabId)) {
            return { ok: false, error: 'Browser tab is not persisted yet' };
        }
        const guest = electron_1.webContents.fromId(request.webContentsId);
        if (!guest || guest.isDestroyed())
            return { ok: false, error: 'Browser guest is unavailable' };
        try {
            if (guest.getType() !== 'webview' || guest.hostWebContents?.id !== host.id) {
                return { ok: false, error: 'Browser guest does not belong to this renderer' };
            }
        }
        catch {
            return { ok: false, error: 'Browser guest ownership could not be verified' };
        }
        const key = targetKey(request.projectId, request.tabId);
        const claimedKey = this.keyByWebContentsId.get(request.webContentsId);
        if (claimedKey && claimedKey !== key) {
            return { ok: false, error: 'Browser guest is already registered to another tab' };
        }
        const existing = this.entries.get(key);
        if (existing
            && existing.registrationId === request.registrationId
            && existing.webContentsId === request.webContentsId
            && !existing.guest.isDestroyed()) {
            existing.ready = true;
            existing.loading = false;
            existing.loadError = undefined;
            return { ok: true, documentGeneration: existing.documentGeneration };
        }
        const nextGeneration = (existing?.documentGeneration ?? 0) + 1;
        if (existing)
            this.removeEntry(existing);
        const entry = {
            projectId: request.projectId,
            tabId: request.tabId,
            registrationId: request.registrationId,
            webContentsId: request.webContentsId,
            hostWebContentsId: host.id,
            guest,
            documentGeneration: nextGeneration,
            ready: true,
            loading: guest.isLoading(),
            consoleEntries: [],
            droppedConsoleEntries: 0,
            cleanup: () => { },
        };
        const invalidateDocument = () => {
            if (this.entries.get(key) !== entry)
                return;
            entry.documentGeneration += 1;
            entry.ready = false;
            entry.loadError = undefined;
        };
        const onStartNavigation = (_event, _url, _isInPlace, isMainFrame) => {
            if (isMainFrame)
                invalidateDocument();
        };
        const onNavigateInPage = (_event, _url, isMainFrame) => {
            if (isMainFrame) {
                entry.documentGeneration += 1;
                entry.ready = true;
            }
        };
        const onDomReady = () => {
            entry.ready = true;
            entry.loadError = undefined;
        };
        const onStartLoading = () => {
            entry.loading = true;
        };
        const onStopLoading = () => {
            entry.loading = false;
        };
        const onFailLoad = (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
            if (!isMainFrame || errorCode === -3)
                return;
            entry.loading = false;
            entry.loadError = errorDescription || `Navigation failed (${errorCode})`;
        };
        const onConsoleMessage = (_event, level, message, line, sourceId) => {
            entry.consoleEntries.push({
                level,
                message: String(message).slice(0, 4_000),
                source: String(sourceId || '').slice(0, 1_000),
                line,
                timestamp: Date.now(),
            });
            if (entry.consoleEntries.length > CONSOLE_LIMIT) {
                const dropped = entry.consoleEntries.length - CONSOLE_LIMIT;
                entry.consoleEntries.splice(0, dropped);
                entry.droppedConsoleEntries += dropped;
            }
        };
        const onDestroyed = () => this.removeEntry(entry);
        const onRenderProcessGone = () => this.removeEntry(entry);
        guest.on('did-start-navigation', onStartNavigation);
        guest.on('did-navigate-in-page', onNavigateInPage);
        guest.on('dom-ready', onDomReady);
        guest.on('did-start-loading', onStartLoading);
        guest.on('did-stop-loading', onStopLoading);
        guest.on('did-fail-load', onFailLoad);
        guest.on('console-message', onConsoleMessage);
        guest.on('destroyed', onDestroyed);
        guest.on('render-process-gone', onRenderProcessGone);
        entry.cleanup = () => {
            if (guest.isDestroyed())
                return;
            try {
                guest.removeListener('did-start-navigation', onStartNavigation);
                guest.removeListener('did-navigate-in-page', onNavigateInPage);
                guest.removeListener('dom-ready', onDomReady);
                guest.removeListener('did-start-loading', onStartLoading);
                guest.removeListener('did-stop-loading', onStopLoading);
                guest.removeListener('did-fail-load', onFailLoad);
                guest.removeListener('console-message', onConsoleMessage);
                guest.removeListener('destroyed', onDestroyed);
                guest.removeListener('render-process-gone', onRenderProcessGone);
            }
            catch {
                // The guest can disappear between isDestroyed() and removeListener().
            }
        };
        this.entries.set(key, entry);
        this.keyByWebContentsId.set(request.webContentsId, key);
        return { ok: true, documentGeneration: entry.documentGeneration };
    }
    unregister(request) {
        const entry = this.entries.get(targetKey(request.projectId, request.tabId));
        if (!entry || entry.registrationId !== request.registrationId)
            return;
        this.removeEntry(entry);
    }
    get(projectId, tabId) {
        const entry = this.entries.get(targetKey(projectId, tabId)) ?? null;
        if (!entry || entry.guest.isDestroyed()) {
            if (entry)
                this.removeEntry(entry);
            return null;
        }
        return entry;
    }
    async waitForReady(projectId, tabId, signal, timeoutMs = 10_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() <= deadline) {
            (0, browserPolicy_1.throwIfBrowserAutomationAborted)(signal);
            const entry = this.get(projectId, tabId);
            if (entry?.ready && !entry.guest.isDestroyed())
                return entry;
            await (0, browserPolicy_1.waitForBrowserDelay)(50, signal);
        }
        throw new browserPolicy_1.BrowserAutomationError('guest_not_ready', 'Timed out waiting for the in-app browser tab to become ready', { retryable: true, details: { projectId, tabId } });
    }
    listProject(projectId) {
        const storeManager = this.getStoreManager();
        const project = storeManager?.getProjects().find((candidate) => candidate.id === projectId);
        if (!project)
            return [];
        const activeTabId = (0, browserMcp_1.getPersistedActiveBrowserTabId)(project);
        const automationTabId = project.outputPanel.browser.automationTabId;
        return (0, browserMcp_1.getPersistedBrowserTabs)(project).map((tab) => {
            const entry = this.get(projectId, tab.id);
            let url = tab.url;
            let title = tab.title;
            if (entry) {
                try {
                    url = entry.guest.getURL() || url;
                }
                catch { /* guest raced teardown */ }
                try {
                    title = entry.guest.getTitle() || title;
                }
                catch { /* guest raced teardown */ }
            }
            return {
                projectId,
                tabId: tab.id,
                url,
                title,
                active: tab.id === activeTabId,
                automation: tab.id === automationTabId,
                mounted: Boolean(entry),
                ready: Boolean(entry?.ready),
                loading: Boolean(entry?.loading),
                documentGeneration: entry?.documentGeneration,
                loadError: entry?.loadError,
                capabilities: browserMcp_1.BROWSER_PANEL_CAPABILITIES,
            };
        });
    }
    disposeHost(hostWebContentsId) {
        for (const entry of [...this.entries.values()]) {
            if (entry.hostWebContentsId === hostWebContentsId)
                this.removeEntry(entry);
        }
    }
    dispose() {
        for (const entry of [...this.entries.values()])
            this.removeEntry(entry);
    }
    removeEntry(entry) {
        const key = targetKey(entry.projectId, entry.tabId);
        if (this.entries.get(key) !== entry)
            return;
        this.entries.delete(key);
        if (this.keyByWebContentsId.get(entry.webContentsId) === key) {
            this.keyByWebContentsId.delete(entry.webContentsId);
        }
        entry.cleanup();
    }
}
exports.BrowserGuestRegistry = BrowserGuestRegistry;
