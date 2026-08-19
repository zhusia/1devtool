"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserPanelAutomationService = void 0;
const crypto_1 = require("crypto");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const browserMcp_1 = require("../../shared/browserMcp");
const BrowserGuestRegistry_1 = require("./BrowserGuestRegistry");
const browserPolicy_1 = require("./browserPolicy");
const browserSnapshot_1 = require("./browserSnapshot");
const ISOLATED_WORLD_ID = 1_000_001;
const UI_TIMEOUT_MS = 10_000;
const POST_ACTION_SETTLE_MS = 150;
/** Magic-byte sniff for paste_image — never trust caller mimeType alone. */
function sniffImageMime(bytes) {
    if (bytes.length >= 8
        && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
        && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
        return 'image/png';
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'image/jpeg';
    }
    if (bytes.length >= 6) {
        const gif = bytes.toString('ascii', 0, 6);
        if (gif === 'GIF87a' || gif === 'GIF89a')
            return 'image/gif';
    }
    if (bytes.length >= 12
        && bytes.toString('ascii', 0, 4) === 'RIFF'
        && bytes.toString('ascii', 8, 12) === 'WEBP') {
        return 'image/webp';
    }
    // AVIF / HEIF: ftyp....avif / heic
    if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
        const brand = bytes.toString('ascii', 8, 12);
        if (brand === 'avif' || brand === 'avis')
            return 'image/avif';
    }
    return null;
}
function keyFor(projectId, tabId) {
    return `${projectId}\u0000${tabId}`;
}
function asNonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function numberInRange(value, fallback, min, max) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(min, Math.min(max, Math.floor(value)))
        : fallback;
}
class BrowserPanelAutomationService {
    deps;
    registry;
    pendingUiRequests = new Map();
    queueTails = new Map();
    snapshotEpochs = new Map();
    disposed = false;
    constructor(deps) {
        this.deps = deps;
        this.registry = new BrowserGuestRegistry_1.BrowserGuestRegistry(deps.getStoreManager);
    }
    registerGuest(host, request) {
        if (this.disposed)
            return { ok: false, error: 'Browser automation is shutting down' };
        return this.registry.register(host, request);
    }
    unregisterGuest(request) {
        this.registry.unregister(request);
        this.snapshotEpochs.delete(keyFor(request.projectId, request.tabId));
    }
    disposeHost(hostWebContentsId) {
        this.registry.disposeHost(hostWebContentsId);
        for (const [key, epoch] of this.snapshotEpochs) {
            const entry = this.registry.get(...key.split('\u0000'));
            if (!entry || entry.registrationId !== epoch.registrationId)
                this.snapshotEpochs.delete(key);
        }
        this.rejectPendingUiRequests(new browserPolicy_1.BrowserAutomationError('renderer_unavailable', 'The 1DevTool renderer was reloaded or closed', { retryable: true }));
    }
    handleUiResponse(response) {
        if (!response?.requestId)
            return;
        const pending = this.pendingUiRequests.get(response.requestId);
        if (!pending)
            return;
        this.pendingUiRequests.delete(response.requestId);
        clearTimeout(pending.timer);
        pending.signal.removeEventListener('abort', pending.onAbort);
        pending.resolve(response);
    }
    async listTabs(args, ctx) {
        const projectId = this.resolveProjectId(args, ctx);
        return { projectId, tabs: this.registry.listProject(projectId) };
    }
    async openTab(args, ctx, signal) {
        const projectId = this.resolveProjectId(args, ctx);
        const requestedUrl = args.url == null ? undefined : (0, browserPolicy_1.validateBrowserNavigationUrl)(args.url);
        const response = await this.requestUi({
            kind: 'open-tab',
            projectId,
            ...(requestedUrl ? { url: requestedUrl } : {}),
            focus: args.focus !== false,
            newTab: args.newTab === true,
        }, signal);
        if (!response.tabId) {
            throw new browserPolicy_1.BrowserAutomationError('renderer_unavailable', 'Renderer did not return the opened browser tab');
        }
        const tabId = response.tabId;
        return this.withTabQueue(projectId, tabId, signal, async () => {
            const entry = await this.registry.waitForReady(projectId, tabId, signal);
            if (requestedUrl) {
                let current = '';
                try {
                    current = entry.guest.getURL();
                }
                catch { /* navigate below */ }
                if (current !== requestedUrl) {
                    await this.navigateEntry(entry, requestedUrl, signal);
                }
            }
            return {
                ...this.requireTabDescriptor(projectId, tabId),
                reused: response.reused === true,
            };
        });
    }
    async selectTab(args, ctx, signal) {
        const { projectId, tabId } = this.resolveTab(args, ctx);
        await this.requestUi({
            kind: 'select-tab',
            projectId,
            tabId,
            focusPanel: args.focusPanel !== false,
        }, signal);
        await this.registry.waitForReady(projectId, tabId, signal);
        return this.requireTabDescriptor(projectId, tabId);
    }
    async closeTab(args, ctx, signal) {
        const { projectId, tabId } = this.resolveTab(args, ctx);
        await this.requestUi({ kind: 'close-tab', projectId, tabId }, signal);
        this.snapshotEpochs.delete(keyFor(projectId, tabId));
        return { projectId, closedTabId: tabId, tabs: this.registry.listProject(projectId) };
    }
    async snapshot(args, ctx, signal) {
        const target = this.resolveTab(args, ctx);
        return this.withTabQueue(target.projectId, target.tabId, signal, async () => {
            const entry = await this.ensureGuest(target.projectId, target.tabId, signal, false);
            return this.snapshotEntry(entry, signal);
        });
    }
    async navigate(args, ctx, signal) {
        const target = this.resolveTab(args, ctx);
        const url = (0, browserPolicy_1.validateBrowserNavigationUrl)(args.url);
        return this.withTabQueue(target.projectId, target.tabId, signal, async () => {
            const entry = await this.ensureGuest(target.projectId, target.tabId, signal, true);
            const ready = await this.navigateEntry(entry, url, signal);
            return this.snapshotEntry(ready, signal);
        });
    }
    async history(direction, args, ctx, signal) {
        const target = this.resolveTab(args, ctx);
        return this.withTabQueue(target.projectId, target.tabId, signal, async () => {
            const entry = await this.ensureGuest(target.projectId, target.tabId, signal, true);
            const previousGeneration = entry.documentGeneration;
            (0, browserPolicy_1.throwIfBrowserAutomationAborted)(signal);
            try {
                if (direction === 'back') {
                    if (!entry.guest.navigationHistory.canGoBack()) {
                        throw new browserPolicy_1.BrowserAutomationError('navigation_failed', 'The browser tab has no back history');
                    }
                    entry.guest.navigationHistory.goBack();
                }
                else if (direction === 'forward') {
                    if (!entry.guest.navigationHistory.canGoForward()) {
                        throw new browserPolicy_1.BrowserAutomationError('navigation_failed', 'The browser tab has no forward history');
                    }
                    entry.guest.navigationHistory.goForward();
                }
                else {
                    entry.guest.reload();
                }
            }
            catch (error) {
                if (error instanceof browserPolicy_1.BrowserAutomationError)
                    throw error;
                throw new browserPolicy_1.BrowserAutomationError('navigation_failed', error instanceof Error ? error.message : String(error));
            }
            const ready = await this.waitForNextDocument(target.projectId, target.tabId, previousGeneration, signal);
            if (ready.loadError)
                throw new browserPolicy_1.BrowserAutomationError('navigation_failed', ready.loadError);
            return this.snapshotEntry(ready, signal);
        });
    }
    async click(args, ctx, signal) {
        const target = this.resolveActionTarget(args, ctx);
        return this.withTabQueue(target.projectId, target.tabId, signal, async () => {
            const entry = await this.ensureGuest(target.projectId, target.tabId, signal, true);
            this.assertSnapshotEpoch(entry, target.snapshotId);
            const resolved = await this.resolveRef(entry, target.snapshotId, target.ref, {}, signal);
            (0, browserPolicy_1.throwIfBrowserAutomationAborted)(signal);
            entry.guest.focus();
            entry.guest.sendInputEvent({ type: 'mouseMove', x: resolved.point.x, y: resolved.point.y });
            entry.guest.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: resolved.point.x, y: resolved.point.y });
            entry.guest.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: resolved.point.x, y: resolved.point.y });
            const settled = await this.settleAfterAction(target.projectId, target.tabId, signal);
            return this.snapshotEntry(settled, signal);
        });
    }
    async type(args, ctx, signal) {
        const target = this.resolveActionTarget(args, ctx);
        const text = typeof args.text === 'string' ? args.text : null;
        if (text == null)
            throw new browserPolicy_1.BrowserAutomationError('action_blocked', 'text is required');
        if (text.length > 20_000)
            throw new browserPolicy_1.BrowserAutomationError('action_blocked', 'Typed text exceeds the 20,000 character limit');
        return this.withTabQueue(target.projectId, target.tabId, signal, async () => {
            const entry = await this.ensureGuest(target.projectId, target.tabId, signal, true);
            this.assertSnapshotEpoch(entry, target.snapshotId);
            const resolved = await this.resolveRef(entry, target.snapshotId, target.ref, { focus: true, requireEditable: true }, signal);
            if (resolved.isPassword || resolved.isFile) {
                throw new browserPolicy_1.BrowserAutomationError('action_blocked', resolved.isPassword
                    ? 'Typing into password fields is blocked by Browser MCP policy'
                    : 'File inputs are blocked by Browser MCP policy');
            }
            (0, browserPolicy_1.throwIfBrowserAutomationAborted)(signal);
            entry.guest.focus();
            await entry.guest.insertText(text);
            if (args.submit === true)
                this.sendKey(entry.guest, (0, browserPolicy_1.parseBrowserKeyChord)('Enter'));
            const settled = await this.settleAfterAction(target.projectId, target.tabId, signal);
            return { ...(await this.snapshotEntry(settled, signal)), typedCharacters: text.length };
        });
    }
    async selectOption(args, ctx, signal) {
        const target = this.resolveActionTarget(args, ctx);
        const rawValues = Array.isArray(args.values) ? args.values : [args.value];
        const values = rawValues.filter((value) => typeof value === 'string' && value.length > 0);
        if (!values.length)
            throw new browserPolicy_1.BrowserAutomationError('action_blocked', 'value or values is required');
        return this.withTabQueue(target.projectId, target.tabId, signal, async () => {
            const entry = await this.ensureGuest(target.projectId, target.tabId, signal, true);
            this.assertSnapshotEpoch(entry, target.snapshotId);
            const result = await this.executeIsolated(entry, (0, browserSnapshot_1.buildBrowserSelectOptionScript)(target.snapshotId, target.ref, values), signal);
            if (!result?.ok)
                this.throwRefResult(result);
            const settled = await this.settleAfterAction(target.projectId, target.tabId, signal);
            return { ...(await this.snapshotEntry(settled, signal)), selected: result.selected ?? [] };
        });
    }
    async pressKey(args, ctx, signal) {
        const target = this.resolveTab(args, ctx);
        const chord = (0, browserPolicy_1.parseBrowserKeyChord)(args.key);
        return this.withTabQueue(target.projectId, target.tabId, signal, async () => {
            const entry = await this.ensureGuest(target.projectId, target.tabId, signal, true);
            const ref = asNonEmptyString(args.ref);
            if (ref) {
                const snapshotId = asNonEmptyString(args.snapshotId);
                if (!snapshotId)
                    throw new browserPolicy_1.BrowserAutomationError('stale_snapshot', 'snapshotId is required when ref is supplied');
                this.assertSnapshotEpoch(entry, snapshotId);
                await this.resolveRef(entry, snapshotId, ref, { focus: true }, signal);
            }
            (0, browserPolicy_1.throwIfBrowserAutomationAborted)(signal);
            entry.guest.focus();
            this.sendKey(entry.guest, chord);
            const settled = await this.settleAfterAction(target.projectId, target.tabId, signal);
            return this.snapshotEntry(settled, signal);
        });
    }
    /**
     * BUG-78: paste/attach an image into the focused (or ref) element with a
     * definitive acknowledgement. Prefer a synthetic ClipboardEvent with a File
     * payload; fall back to setting files on a file input. Returns status so
     * agents do not have to guess whether a Control+V key chord landed.
     */
    async pasteImage(args, ctx, signal) {
        const target = this.resolveActionTarget(args, ctx);
        const filePath = asNonEmptyString(args.filePath);
        const base64 = asNonEmptyString(args.base64);
        if (!filePath && !base64) {
            throw new browserPolicy_1.BrowserAutomationError('action_blocked', 'filePath or base64 is required for browser.paste_image');
        }
        let bytes;
        let fileName;
        if (filePath) {
            if (!path_1.default.isAbsolute(filePath)) {
                throw new browserPolicy_1.BrowserAutomationError('action_blocked', 'filePath must be an absolute path');
            }
            // Confine disk→web reads to the owning project root (or explicit allowOutsideProject).
            const storeManager = this.deps.getStoreManager();
            const project = storeManager?.getProjects().find((p) => p.id === target.projectId);
            const projectRoot = project?.rootPath ? path_1.default.resolve(project.rootPath) : null;
            const resolvedPath = path_1.default.resolve(filePath);
            const allowOutside = args.allowOutsideProject === true;
            if (projectRoot) {
                const rootWithSep = projectRoot.endsWith(path_1.default.sep) ? projectRoot : projectRoot + path_1.default.sep;
                const inside = resolvedPath === projectRoot || resolvedPath.startsWith(rootWithSep);
                if (!inside && !allowOutside) {
                    throw new browserPolicy_1.BrowserAutomationError('action_blocked', `filePath must be inside the project root (${projectRoot}). Pass allowOutsideProject: true only with explicit user consent.`);
                }
            }
            else if (!allowOutside) {
                throw new browserPolicy_1.BrowserAutomationError('action_blocked', 'Project root is unknown; pass allowOutsideProject: true only with explicit user consent.');
            }
            try {
                const stats = fs_1.default.statSync(resolvedPath);
                if (!stats.isFile())
                    throw new browserPolicy_1.BrowserAutomationError('action_blocked', 'filePath is not a file');
                if (stats.size > 2 * 1024 * 1024) {
                    throw new browserPolicy_1.BrowserAutomationError('action_blocked', 'Image exceeds the 2 MB paste limit');
                }
                bytes = fs_1.default.readFileSync(resolvedPath);
                fileName = asNonEmptyString(args.fileName) || path_1.default.basename(resolvedPath);
            }
            catch (error) {
                if (error instanceof browserPolicy_1.BrowserAutomationError)
                    throw error;
                throw new browserPolicy_1.BrowserAutomationError('action_blocked', `Could not read image file: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        else {
            try {
                bytes = Buffer.from(base64, 'base64');
            }
            catch {
                throw new browserPolicy_1.BrowserAutomationError('action_blocked', 'base64 is not valid base64');
            }
            if (bytes.length === 0)
                throw new browserPolicy_1.BrowserAutomationError('action_blocked', 'base64 decoded to an empty buffer');
            if (bytes.length > 2 * 1024 * 1024) {
                throw new browserPolicy_1.BrowserAutomationError('action_blocked', 'Image exceeds the 2 MB paste limit');
            }
            fileName = asNonEmptyString(args.fileName) || `paste-${Date.now()}.png`;
        }
        // Sniff real image magic — never trust caller mimeType alone (disk→web exfil).
        const sniffed = sniffImageMime(bytes);
        if (!sniffed) {
            throw new browserPolicy_1.BrowserAutomationError('action_blocked', 'Bytes are not a recognized image (png/jpeg/gif/webp/avif). Refusing non-image paste.');
        }
        const mimeType = sniffed;
        const b64Payload = bytes.toString('base64');
        return this.withTabQueue(target.projectId, target.tabId, signal, async () => {
            const entry = await this.ensureGuest(target.projectId, target.tabId, signal, true);
            this.assertSnapshotEpoch(entry, target.snapshotId);
            await this.resolveRef(entry, target.snapshotId, target.ref, { focus: true }, signal);
            (0, browserPolicy_1.throwIfBrowserAutomationAborted)(signal);
            entry.guest.focus();
            const script = (0, browserSnapshot_1.buildBrowserPasteImageScript)({
                snapshotId: target.snapshotId,
                ref: target.ref,
                fileName,
                mimeType,
                base64: b64Payload,
            });
            const result = await this.executeIsolated(entry, script, signal);
            if (!result?.ok) {
                throw new browserPolicy_1.BrowserAutomationError('action_blocked', result?.reason || 'Image paste failed in the browser guest');
            }
            const settled = await this.settleAfterAction(target.projectId, target.tabId, signal);
            const snapshot = await this.snapshotEntry(settled, signal);
            return {
                ...snapshot,
                pasteStatus: result.pasteStatus ?? 'dispatched',
                method: result.method ?? 'paste-event',
                fileName,
                byteSize: bytes.length,
                attachmentDelta: typeof result.attachmentDelta === 'number' ? result.attachmentDelta : 0,
                detail: result.detail
                    ?? 'Paste event dispatched with image File; inspect snapshot for attachment UI.',
            };
        });
    }
    async wait(args, ctx, signal) {
        const target = this.resolveTab(args, ctx);
        const condition = {
            ...(asNonEmptyString(args.text) ? { text: asNonEmptyString(args.text) } : {}),
            ...(asNonEmptyString(args.textGone) ? { textGone: asNonEmptyString(args.textGone) } : {}),
            ...(asNonEmptyString(args.urlContains) ? { urlContains: asNonEmptyString(args.urlContains) } : {}),
            ...(args.loadState === 'complete' || args.loadState === 'domcontentloaded' ? { loadState: args.loadState } : {}),
        };
        if (!condition.text && !condition.textGone && !condition.urlContains && !condition.loadState) {
            throw new browserPolicy_1.BrowserAutomationError('action_blocked', 'At least one wait condition is required');
        }
        const timeoutMs = numberInRange(args.timeoutMs, 10_000, 100, 30_000);
        return this.withTabQueue(target.projectId, target.tabId, signal, async () => {
            const deadline = Date.now() + timeoutMs;
            let entry = await this.ensureGuest(target.projectId, target.tabId, signal, false);
            while (Date.now() <= deadline) {
                (0, browserPolicy_1.throwIfBrowserAutomationAborted)(signal);
                const current = this.registry.get(target.projectId, target.tabId);
                if (!current) {
                    throw new browserPolicy_1.BrowserAutomationError('guest_destroyed', 'Browser tab closed while waiting', { retryable: true });
                }
                entry = current;
                let matchesUrl = true;
                if (condition.urlContains) {
                    try {
                        matchesUrl = entry.guest.getURL().includes(condition.urlContains);
                    }
                    catch {
                        matchesUrl = false;
                    }
                }
                let matchesDocument = true;
                if (condition.text || condition.textGone || condition.loadState) {
                    try {
                        matchesDocument = Boolean(await this.executeIsolated(entry, (0, browserSnapshot_1.buildBrowserWaitConditionScript)(condition), signal));
                    }
                    catch (error) {
                        if (error instanceof browserPolicy_1.BrowserAutomationError && error.code === 'guest_destroyed')
                            throw error;
                        matchesDocument = false;
                    }
                }
                if (matchesUrl && matchesDocument)
                    return this.snapshotEntry(entry, signal);
                await (0, browserPolicy_1.waitForBrowserDelay)(100, signal);
            }
            throw new browserPolicy_1.BrowserAutomationError('timeout', 'Timed out waiting for the browser condition', { retryable: true });
        });
    }
    async screenshot(args, ctx, signal) {
        const target = this.resolveTab(args, ctx);
        return this.withTabQueue(target.projectId, target.tabId, signal, async () => {
            const entry = await this.ensureGuest(target.projectId, target.tabId, signal, false);
            (0, browserPolicy_1.throwIfBrowserAutomationAborted)(signal);
            let image;
            try {
                image = await entry.guest.capturePage();
            }
            catch (error) {
                throw new browserPolicy_1.BrowserAutomationError('guest_destroyed', error instanceof Error ? error.message : String(error), { retryable: true });
            }
            const data = image.toPNG();
            if (data.byteLength > browserMcp_1.BROWSER_MCP_MAX_SCREENSHOT_BYTES) {
                throw new browserPolicy_1.BrowserAutomationError('action_blocked', 'Browser screenshot exceeds the 12 MB response limit');
            }
            const size = image.getSize();
            return {
                projectId: target.projectId,
                tabId: target.tabId,
                url: this.safeGuestUrl(entry),
                mimeType: 'image/png',
                data: data.toString('base64'),
                width: size.width,
                height: size.height,
                fullPage: false,
            };
        });
    }
    async consoleLogs(args, ctx, signal) {
        const target = this.resolveTab(args, ctx);
        const entry = await this.ensureGuest(target.projectId, target.tabId, signal, false);
        const limit = numberInRange(args.limit, 100, 1, 500);
        return {
            projectId: target.projectId,
            tabId: target.tabId,
            url: this.safeGuestUrl(entry),
            entries: entry.consoleEntries.slice(-limit),
            dropped: entry.droppedConsoleEntries,
        };
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.registry.dispose();
        this.snapshotEpochs.clear();
        this.rejectPendingUiRequests(new browserPolicy_1.BrowserAutomationError('renderer_unavailable', 'Browser automation is shutting down'));
    }
    resolveProjectId(args, ctx) {
        const storeManager = this.deps.getStoreManager();
        if (!storeManager)
            throw new browserPolicy_1.BrowserAutomationError('project_not_found', '1DevTool project store is unavailable');
        const requestedId = asNonEmptyString(args.projectId);
        const terminalLocation = ctx.terminalId ? storeManager.findTerminalLocation(ctx.terminalId) : null;
        if (terminalLocation) {
            if (requestedId && requestedId !== terminalLocation.project.id) {
                throw new browserPolicy_1.BrowserAutomationError('project_mismatch', 'The calling terminal cannot operate a browser tab from another project');
            }
            return terminalLocation.project.id;
        }
        if (!requestedId) {
            throw new browserPolicy_1.BrowserAutomationError('project_required', 'projectId is required because this MCP call is not attributable to a live 1DevTool terminal');
        }
        if (!storeManager.getProjects().some((project) => project.id === requestedId)) {
            throw new browserPolicy_1.BrowserAutomationError('project_not_found', `Project not found: ${requestedId}`);
        }
        return requestedId;
    }
    resolveTab(args, ctx) {
        const projectId = this.resolveProjectId(args, ctx);
        const tabId = asNonEmptyString(args.tabId);
        if (!tabId)
            throw new browserPolicy_1.BrowserAutomationError('tab_not_found', 'tabId is required');
        const project = this.deps.getStoreManager()?.getProjects().find((candidate) => candidate.id === projectId);
        if (!project || !(0, browserMcp_1.getPersistedBrowserTabs)(project).some((tab) => tab.id === tabId)) {
            throw new browserPolicy_1.BrowserAutomationError('tab_not_found', `Browser tab not found: ${tabId}`);
        }
        return { projectId, tabId };
    }
    resolveActionTarget(args, ctx) {
        const target = this.resolveTab(args, ctx);
        const snapshotId = asNonEmptyString(args.snapshotId);
        const ref = asNonEmptyString(args.ref);
        if (!snapshotId)
            throw new browserPolicy_1.BrowserAutomationError('stale_snapshot', 'snapshotId is required; take a fresh snapshot first');
        if (!ref)
            throw new browserPolicy_1.BrowserAutomationError('element_detached', 'ref is required; choose an element from the latest snapshot');
        return { ...target, snapshotId, ref };
    }
    async ensureGuest(projectId, tabId, signal, 
    /** Align the visible tab selection with the action when the user is
     *  already looking at this project. Never focuses the panel, the OS
     *  window, or another project — those are the user's to move. */
    followForAction) {
        const current = this.registry.get(projectId, tabId);
        if (current?.ready) {
            if (followForAction) {
                await this.requestUi({ kind: 'select-tab', projectId, tabId, focusPanel: false }, signal);
            }
            return current;
        }
        // Missing/not-ready guest: select-tab makes the renderer host it — in
        // the visible panel when the project is active, in the offscreen
        // keep-alive layer otherwise.
        await this.requestUi({ kind: 'select-tab', projectId, tabId, focusPanel: false }, signal);
        return this.registry.waitForReady(projectId, tabId, signal);
    }
    async navigateEntry(entry, url, signal) {
        (0, browserPolicy_1.throwIfBrowserAutomationAborted)(signal);
        try {
            await entry.guest.loadURL(url);
        }
        catch (error) {
            if (signal.aborted)
                throw new browserPolicy_1.BrowserAutomationError('cancelled', 'Browser navigation was cancelled');
            throw new browserPolicy_1.BrowserAutomationError('navigation_failed', error instanceof Error ? error.message : String(error), {
                details: { url },
            });
        }
        const ready = await this.registry.waitForReady(entry.projectId, entry.tabId, signal);
        if (ready.loadError)
            throw new browserPolicy_1.BrowserAutomationError('navigation_failed', ready.loadError, { details: { url } });
        return ready;
    }
    async snapshotEntry(entry, signal) {
        (0, browserPolicy_1.throwIfBrowserAutomationAborted)(signal);
        if (!entry.ready || entry.guest.isDestroyed()) {
            throw new browserPolicy_1.BrowserAutomationError('guest_not_ready', 'Browser guest is not ready for a snapshot', { retryable: true });
        }
        const generation = entry.documentGeneration;
        const snapshotId = (0, crypto_1.randomUUID)();
        const result = await this.executeIsolated(entry, (0, browserSnapshot_1.buildBrowserSnapshotScript)(snapshotId), signal);
        if (entry.documentGeneration !== generation) {
            throw new browserPolicy_1.BrowserAutomationError('stale_snapshot', 'The page navigated while its snapshot was being captured', { retryable: true });
        }
        this.snapshotEpochs.set(keyFor(entry.projectId, entry.tabId), {
            registrationId: entry.registrationId,
            documentGeneration: generation,
            snapshotId,
        });
        return {
            projectId: entry.projectId,
            tabId: entry.tabId,
            url: this.safeGuestUrl(entry),
            title: this.safeGuestTitle(entry),
            documentGeneration: generation,
            snapshotId,
            tree: typeof result?.tree === 'string' ? result.tree : '- document «snapshot unavailable»',
            truncated: result?.truncated === true,
            nodeCount: typeof result?.nodeCount === 'number' ? result.nodeCount : 0,
            capabilities: browserMcp_1.BROWSER_PANEL_CAPABILITIES,
        };
    }
    assertSnapshotEpoch(entry, snapshotId) {
        const epoch = this.snapshotEpochs.get(keyFor(entry.projectId, entry.tabId));
        if (!epoch
            || epoch.snapshotId !== snapshotId
            || epoch.registrationId !== entry.registrationId
            || epoch.documentGeneration !== entry.documentGeneration) {
            throw new browserPolicy_1.BrowserAutomationError('stale_snapshot', 'The snapshot is stale; take a fresh browser_snapshot', {
                retryable: true,
                details: {
                    projectId: entry.projectId,
                    tabId: entry.tabId,
                    actualGeneration: entry.documentGeneration,
                },
            });
        }
    }
    async resolveRef(entry, snapshotId, ref, options, signal) {
        const result = await this.executeIsolated(entry, (0, browserSnapshot_1.buildBrowserResolveRefScript)(snapshotId, ref, options), signal);
        if (!result?.ok || !result.point)
            this.throwRefResult(result);
        return result;
    }
    throwRefResult(result) {
        if (result?.code === 'stale_snapshot') {
            throw new browserPolicy_1.BrowserAutomationError('stale_snapshot', 'The snapshot is stale; take a fresh browser_snapshot', { retryable: true });
        }
        if (result?.code === 'element_detached') {
            throw new browserPolicy_1.BrowserAutomationError('element_detached', 'The referenced element is no longer attached', { retryable: true });
        }
        if (result?.code === 'unsupported_frame') {
            throw new browserPolicy_1.BrowserAutomationError('unsupported_frame', result.reason || 'The referenced frame is unsupported');
        }
        throw new browserPolicy_1.BrowserAutomationError('element_not_actionable', result?.reason || 'The referenced element is not actionable');
    }
    async executeIsolated(entry, code, signal) {
        (0, browserPolicy_1.throwIfBrowserAutomationAborted)(signal);
        try {
            const result = await entry.guest.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code }], false);
            (0, browserPolicy_1.throwIfBrowserAutomationAborted)(signal);
            return result;
        }
        catch (error) {
            if (error instanceof browserPolicy_1.BrowserAutomationError)
                throw error;
            if (signal.aborted)
                throw new browserPolicy_1.BrowserAutomationError('cancelled', 'Browser automation request was cancelled');
            throw new browserPolicy_1.BrowserAutomationError(entry.guest.isDestroyed() ? 'guest_destroyed' : 'guest_not_ready', error instanceof Error ? error.message : String(error), { retryable: true });
        }
    }
    async settleAfterAction(projectId, tabId, signal) {
        await (0, browserPolicy_1.waitForBrowserDelay)(POST_ACTION_SETTLE_MS, signal);
        const entry = this.registry.get(projectId, tabId);
        if (!entry)
            throw new browserPolicy_1.BrowserAutomationError('guest_destroyed', 'Browser tab closed during the action', { retryable: true });
        if (!entry.ready || entry.loading)
            return this.registry.waitForReady(projectId, tabId, signal);
        return entry;
    }
    async waitForNextDocument(projectId, tabId, previousGeneration, signal, timeoutMs = 10_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() <= deadline) {
            (0, browserPolicy_1.throwIfBrowserAutomationAborted)(signal);
            const entry = this.registry.get(projectId, tabId);
            if (!entry) {
                throw new browserPolicy_1.BrowserAutomationError('guest_destroyed', 'Browser tab closed during navigation', { retryable: true });
            }
            if (entry.documentGeneration > previousGeneration && entry.ready && !entry.loading)
                return entry;
            if (entry.loadError)
                throw new browserPolicy_1.BrowserAutomationError('navigation_failed', entry.loadError);
            await (0, browserPolicy_1.waitForBrowserDelay)(50, signal);
        }
        throw new browserPolicy_1.BrowserAutomationError('timeout', 'Timed out waiting for browser navigation', { retryable: true });
    }
    rejectPendingUiRequests(error) {
        for (const [requestId, pending] of this.pendingUiRequests) {
            clearTimeout(pending.timer);
            pending.signal.removeEventListener('abort', pending.onAbort);
            pending.reject(error);
            this.pendingUiRequests.delete(requestId);
        }
    }
    sendKey(guest, chord) {
        const modifiers = [];
        if (chord.altKey)
            modifiers.push('alt');
        if (chord.ctrlKey)
            modifiers.push('control');
        if (chord.metaKey)
            modifiers.push('meta');
        if (chord.shiftKey)
            modifiers.push('shift');
        guest.sendInputEvent({ type: 'keyDown', keyCode: chord.keyCode, modifiers });
        guest.sendInputEvent({ type: 'keyUp', keyCode: chord.keyCode, modifiers });
    }
    requireTabDescriptor(projectId, tabId) {
        const descriptor = this.registry.listProject(projectId).find((tab) => tab.tabId === tabId);
        if (!descriptor)
            throw new browserPolicy_1.BrowserAutomationError('tab_not_found', `Browser tab not found: ${tabId}`);
        return descriptor;
    }
    safeGuestUrl(entry) {
        try {
            return entry.guest.getURL();
        }
        catch {
            return '';
        }
    }
    safeGuestTitle(entry) {
        try {
            return entry.guest.getTitle();
        }
        catch {
            return '';
        }
    }
    async requestUi(request, signal) {
        (0, browserPolicy_1.throwIfBrowserAutomationAborted)(signal);
        const win = await this.deps.ensureRendererWindow(UI_TIMEOUT_MS);
        if (!win || win.isDestroyed() || win.webContents.isDestroyed()) {
            throw new browserPolicy_1.BrowserAutomationError('renderer_unavailable', 'The 1DevTool renderer is unavailable', { retryable: true });
        }
        // Never win.show()/win.focus() here: automation runs against hidden
        // guests (background tabs, the keep-alive host) and an agent action must
        // not steal the OS window or the user's workspace
        // (docs/common-errors/browser/automation-steals-workspace-focus.md).
        const requestId = (0, crypto_1.randomUUID)();
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                const pending = this.pendingUiRequests.get(requestId);
                if (!pending)
                    return;
                clearTimeout(pending.timer);
                this.pendingUiRequests.delete(requestId);
                reject(new browserPolicy_1.BrowserAutomationError('cancelled', 'Browser UI request was cancelled'));
            };
            const timer = setTimeout(() => {
                this.pendingUiRequests.delete(requestId);
                signal.removeEventListener('abort', onAbort);
                reject(new browserPolicy_1.BrowserAutomationError('renderer_unavailable', 'Timed out waiting for the browser UI', { retryable: true }));
            }, UI_TIMEOUT_MS);
            this.pendingUiRequests.set(requestId, { resolve, reject, timer, signal, onAbort });
            signal.addEventListener('abort', onAbort, { once: true });
            try {
                win.webContents.send('browser-automation:ui-request', { ...request, requestId });
            }
            catch (error) {
                clearTimeout(timer);
                this.pendingUiRequests.delete(requestId);
                signal.removeEventListener('abort', onAbort);
                reject(new browserPolicy_1.BrowserAutomationError('renderer_unavailable', error instanceof Error ? error.message : 'Failed to send browser UI request', { retryable: true }));
            }
        }).then((response) => {
            if (!response.ok) {
                throw new browserPolicy_1.BrowserAutomationError(response.code ?? 'renderer_unavailable', response.error ?? 'Browser UI request failed', { retryable: response.code === 'renderer_unavailable' || response.code === 'panel_not_mounted' });
            }
            return response;
        });
    }
    async withTabQueue(projectId, tabId, signal, operation) {
        const key = keyFor(projectId, tabId);
        const previous = this.queueTails.get(key) ?? Promise.resolve();
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const tail = previous.catch(() => { }).then(() => gate);
        this.queueTails.set(key, tail);
        try {
            await this.waitForQueue(previous, signal);
            (0, browserPolicy_1.throwIfBrowserAutomationAborted)(signal);
            return await operation();
        }
        finally {
            release();
            if (this.queueTails.get(key) === tail) {
                void tail.finally(() => {
                    if (this.queueTails.get(key) === tail)
                        this.queueTails.delete(key);
                });
            }
        }
    }
    waitForQueue(previous, signal) {
        (0, browserPolicy_1.throwIfBrowserAutomationAborted)(signal);
        return new Promise((resolve, reject) => {
            const onAbort = () => {
                signal.removeEventListener('abort', onAbort);
                reject(new browserPolicy_1.BrowserAutomationError('cancelled', 'Browser automation request was cancelled while queued'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
            previous.catch(() => { }).then(() => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            });
        });
    }
}
exports.BrowserPanelAutomationService = BrowserPanelAutomationService;
