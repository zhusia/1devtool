"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMainWindow = createMainWindow;
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const entitlementGate_1 = require("./entitlement/entitlementGate");
const shadow_1 = require("./entitlement/shadow");
const LicenseService_1 = require("./services/LicenseService");
const AppQuitService_1 = require("./services/AppQuitService");
const updater_1 = require("./updater");
const windowAssets_1 = require("./windowAssets");
function createMainWindow({ isDev, devServerUrl, pendingWebviewAuth, entitlementState, sendToRenderer, setRemoteRendererReady, setWindowFocused, getStoreManager, getLspHost, getOrchestrationRunTracker, shouldConfirmTerminalSessionQuit, confirmTerminalSessionQuit, createApplicationMenu, onClosed, }) {
    setRemoteRendererReady(false);
    const mainWindow = new electron_1.BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1024,
        minHeight: 600,
        backgroundColor: '#080A0E',
        icon: path_1.default.join(electron_1.app.getAppPath(), process.platform === 'win32' ? 'resources/icon.ico' : 'resources/icon.png'),
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 12, y: 12 },
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            webviewTag: true,
            preload: (0, windowAssets_1.getPreloadPath)(),
        },
    });
    if (isDev) {
        mainWindow.loadURL(devServerUrl);
        if (process.env.OPEN_DEVTOOLS === 'true') {
            mainWindow.webContents.openDevTools({ mode: 'detach' });
        }
    }
    else {
        mainWindow.loadFile((0, windowAssets_1.getRendererHtmlPath)());
    }
    // Block DevTools shortcuts (Cmd+Shift+I, Cmd+Alt+I, F12) in production
    if (!isDev) {
        mainWindow.webContents.on('before-input-event', (_event, input) => {
            const isDevToolsShortcut = (input.key === 'I' && input.shift && (input.meta || input.control)) ||
                (input.key === 'I' && input.alt && (input.meta || input.control)) ||
                input.key === 'F12';
            if (isDevToolsShortcut) {
                _event.preventDefault();
            }
        });
    }
    // Intercept new-window requests and zoom shortcuts from webview guests
    mainWindow.webContents.on('did-attach-webview', (_event, webContents) => {
        webContents.setWindowOpenHandler(({ url }) => {
            if (mainWindow) {
                mainWindow.webContents.send('webview-new-window', url);
            }
            return { action: 'deny' };
        });
        // HTTP Basic/Digest auth. Electron has no built-in credentials prompt for
        // <webview> guests the way Chrome does — without handling `login`, the
        // challenge goes unanswered and the server returns 401. Prompt the user via a
        // global renderer dialog, then feed the result back into the login callback.
        webContents.on('login', (event, authDetails, authInfo, callback) => {
            // Only prompt for server (non-proxy) Basic/Digest — the cases Chrome shows
            // its dialog for. Proxy auth and Negotiate/NTLM fall through to defaults.
            if (authInfo.isProxy || (authInfo.scheme !== 'basic' && authInfo.scheme !== 'digest')) {
                return;
            }
            event.preventDefault();
            const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            pendingWebviewAuth.set(requestId, callback);
            const delivered = sendToRenderer('webview-http-auth', {
                requestId,
                host: authInfo.host,
                port: authInfo.port,
                realm: authInfo.realm || '',
                scheme: authInfo.scheme,
                url: authDetails.url,
            });
            if (!delivered) {
                // No renderer to prompt with — cancel so the request doesn't hang.
                pendingWebviewAuth.delete(requestId);
                callback();
            }
        });
        // Forward shortcuts from webview guest to renderer.
        // When the webview has focus, keydown events go to the guest page and never
        // reach the renderer's window.addEventListener('keydown').
        webContents.on('before-input-event', (event, input) => {
            if (input.type !== 'keyDown')
                return;
            const hasMeta = input.meta || input.control;
            if (!hasMeta || input.shift)
                return;
            // Zoom shortcuts
            if (input.key === '=' || input.key === '+') {
                event.preventDefault();
                sendToRenderer('app:webview-zoom-shortcut', 'in');
            }
            else if (input.key === '-') {
                event.preventDefault();
                sendToRenderer('app:webview-zoom-shortcut', 'out');
            }
            else if (input.key === '0') {
                event.preventDefault();
                sendToRenderer('app:webview-zoom-shortcut', 'reset');
            }
            // Reload shortcut
            else if (input.key === 'r') {
                event.preventDefault();
                sendToRenderer('app:webview-zoom-shortcut', 'reload');
            }
            // Tab/navigation shortcuts
            else if (input.key === 't') {
                event.preventDefault();
                sendToRenderer('app:webview-shortcut', 'new-item');
            }
            else if (input.key === 'w') {
                event.preventDefault();
                sendToRenderer('app:webview-shortcut', 'close-item');
            }
            else if (input.key === ']') {
                event.preventDefault();
                sendToRenderer('app:webview-shortcut', 'next-item');
            }
            else if (input.key === '[') {
                event.preventDefault();
                sendToRenderer('app:webview-shortcut', 'prev-item');
            }
        });
    });
    mainWindow.on('close', (event) => {
        // On macOS the red traffic-light close fires `close` (not `before-quit`),
        // so route it through the same confirmation as Cmd+Q — the user wants the
        // window close to offer saving terminal sessions via QuitConfirmDialog.
        // `confirmTerminalSessionQuit()` re-enters this handler via app.quit(), but
        // by then isQuitAllowed() is true, so it closes without re-prompting.
        if ((0, AppQuitService_1.isQuitAllowed)())
            return;
        if (!shouldConfirmTerminalSessionQuit())
            return;
        event.preventDefault();
        void confirmTerminalSessionQuit();
    });
    mainWindow.on('closed', () => {
        setRemoteRendererReady(false);
        getOrchestrationRunTracker()?.resetSubscriptions();
        onClosed();
    });
    mainWindow.webContents.on('did-start-loading', () => {
        setRemoteRendererReady(false);
    });
    mainWindow.webContents.on('did-finish-load', () => {
        // A fresh document just loaded, so any run-tracker subscription belongs to
        // a torn-down renderer that never sent `orchestration:unsubscribe-runs` —
        // drop it or the 3 s poll + fs.watch outlive the dashboard forever.
        getOrchestrationRunTracker()?.resetSubscriptions();
        // Apply persisted UI scale
        const prefs = getStoreManager()?.getPreferences();
        const uiScale = prefs?.appearance?.uiScale;
        if (uiScale && uiScale !== 1 && mainWindow) {
            mainWindow.webContents.setZoomFactor(uiScale);
        }
        // Hand the window reference to the LSP host so it can post MessagePorts
        // and crash notifications back to the renderer. Done after did-finish-load
        // (not at createWindow time) so the first lsp:port post lands in a
        // renderer that has already attached its `lsp:port` listener via the
        // preload bridge.
        const lspHost = getLspHost();
        if (lspHost) {
            lspHost.attachWindow(mainWindow);
        }
    });
    mainWindow.webContents.on('render-process-gone', (_, details) => {
        setRemoteRendererReady(false);
        getOrchestrationRunTracker()?.resetSubscriptions();
        console.error('Renderer process exited unexpectedly', details);
        // Recover from renderer crashes by reloading. Skip if the window was
        // intentionally closed or the process exited cleanly.
        if (details.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed()) {
            console.log('Reloading renderer after crash...');
            setTimeout(() => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.reload();
                }
            }, 500);
        }
    });
    // Set up auto-updater
    if (!isDev) {
        (0, updater_1.setupUpdater)(mainWindow, {
            getPreferences: () => getStoreManager()?.getPreferences(),
            getLicenseInfo: () => LicenseService_1.licenseService.getLicenseInfo(),
        });
    }
    // Entitlement GATE (P2 phase 2, docs/product/strategy/licensing-updates-monetization.md §6 P2 + §8): the
    // cryptographic verdict now overrides the legacy `isLicensed` boolean for Pro.
    // Fail-safe (any error → legacy boolean), session-latched (never downgrades a
    // running session), 14-day migration grace. Kill-switch:
    // ONEDEVTOOL_DISABLE_ENTITLEMENT_GATE=1.
    if (!entitlementState.gate) {
        entitlementState.gate = (0, entitlementGate_1.createEntitlementGate)({
            userDataDir: electron_1.app.getPath('userData'),
            getRawLicense: () => LicenseService_1.licenseService.getRawLicenseSnapshot(),
        });
        LicenseService_1.licenseService.setEntitlementEvaluator(() => entitlementState.gate.getDecision(), 
        // License-mutation refresh: activation re-evaluates immediately (fresh Pro
        // must not hide behind the boot latch); deactivation also drops the latch.
        (opts) => {
            try {
                if (opts?.resetLatch)
                    entitlementState.gate.resetLatch();
                else
                    entitlementState.gate.evaluate();
            }
            catch (error) {
                console.warn('[entitlement] gate refresh on license mutation failed', error);
            }
        });
        // Latch the boot verdict from the cached entitlement before any renderer read.
        entitlementState.gate.evaluate();
    }
    // Entitlement refresh runner (was "shadow" in P2 phase 1). Still exchanges the
    // stored license for a signed entitlement, verifies, caches, and logs — but now
    // its result is authoritative via the gate. Each pass re-evaluates the gate so a
    // successful migration exchange upgrades free→Pro live; the latch blocks any
    // downgrade until next boot. Kill-switch: ONEDEVTOOL_DISABLE_ENTITLEMENT_SHADOW=1.
    if (!entitlementState.shadow) {
        entitlementState.shadow = (0, shadow_1.createEntitlementShadow)({
            userDataDir: electron_1.app.getPath('userData'),
            getLicense: () => LicenseService_1.licenseService.getRawLicenseSnapshot(),
            onPass: () => {
                try {
                    entitlementState.gate?.evaluate();
                    LicenseService_1.licenseService.notifyLicenseChanged();
                }
                catch (error) {
                    console.warn('[entitlement] gate re-eval after pass failed', error);
                }
            },
        });
        entitlementState.stopShadow = entitlementState.shadow.start();
    }
    // Track window focus for notification logic
    mainWindow.on('focus', () => {
        setWindowFocused(true);
    });
    mainWindow.on('blur', () => {
        setWindowFocused(false);
    });
    // Set up application menu
    createApplicationMenu();
    return mainWindow;
}
