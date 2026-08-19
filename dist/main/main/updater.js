"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyUpdaterPreferences = applyUpdaterPreferences;
exports.getUpdateStatusSnapshot = getUpdateStatusSnapshot;
exports.setupUpdater = setupUpdater;
exports.setupUpdaterIpcHandlers = setupUpdaterIpcHandlers;
const electron_1 = require("electron");
const electron_updater_1 = require("electron-updater");
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const AppQuitService_1 = require("./services/AppQuitService");
const updateEntitlement_1 = require("../shared/updateEntitlement");
let mainWindow = null;
/**
 * Lazy accessors into main-process state so the updater can read the user's
 * update preferences (autoDownload / autoInstallOnQuit) and license entitlement
 * without importing the store/license singletons directly (avoids init-order
 * coupling — `setupUpdater` can run before `storeManager` exists; the accessors
 * are only ever invoked later, on update events). Both are optional so dev
 * builds and tests degrade to the previous hard-coded defaults.
 */
let getPreferencesFn = null;
let getLicenseInfoFn = null;
function resolveUpdaterPrefs() {
    const updates = getPreferencesFn?.()?.updates;
    return {
        // Preserve the historical hard-coded defaults when prefs are unavailable.
        autoDownload: updates?.autoDownload ?? true,
        autoInstallOnQuit: updates?.autoInstallOnQuit ?? true,
    };
}
/**
 * Apply the user's update preferences to electron-updater. Called at setup and
 * again whenever preferences are saved (so a settings change takes effect
 * without a restart).
 *
 * Note: `autoUpdater.autoDownload` is deliberately kept `false` at the
 * electron-updater level. We drive the download ourselves from the
 * `update-available` handler so it can be gated by BOTH the `autoDownload`
 * preference AND license entitlement (§12.4) — electron-updater's own
 * autoDownload has no entitlement hook. `autoInstallOnAppQuit` only installs an
 * already-downloaded update, so it is safe to map straight from the pref (an
 * unentitled user never has a downloaded update to install).
 */
function applyUpdaterPreferences() {
    electron_updater_1.autoUpdater.autoDownload = false;
    const prefs = resolveUpdaterPrefs();
    electron_updater_1.autoUpdater.autoInstallOnAppQuit = prefs.autoInstallOnQuit;
    if (!prefs.autoDownload) {
        clearDownloadRetry();
    }
}
/**
 * File-backed logger for electron-updater. We do not bundle `electron-log`, so
 * by default the updater logs only to a discarded GUI stderr — which left us
 * blind to Linux/AppImage update failures (the macOS path was only diagnosable
 * because Squirrel's ShipIt writes its own OS-level log). This writes every
 * updater event to `<userData>/logs/updater.log` AND mirrors to console.
 */
function createUpdaterLogger() {
    const logDir = path_1.default.join(electron_1.app.getPath('userData'), 'logs');
    const logFile = path_1.default.join(logDir, 'updater.log');
    try {
        (0, fs_1.mkdirSync)(logDir, { recursive: true });
    }
    catch {
        /* best-effort; never let logging setup break updates */
    }
    const stringify = (a) => a instanceof Error ? (a.stack ?? a.message) : typeof a === 'string' ? a : JSON.stringify(a);
    const write = (level, args) => {
        const line = `${new Date().toISOString()} [${level}] ${args.map(stringify).join(' ')}\n`;
        try {
            (0, fs_1.appendFileSync)(logFile, line);
        }
        catch {
            /* ignore */
        }
    };
    return {
        info: (...args) => {
            write('info', args);
            console.log('[updater]', ...args);
        },
        warn: (...args) => {
            write('warn', args);
            console.warn('[updater]', ...args);
        },
        error: (...args) => {
            write('error', args);
            console.error('[updater]', ...args);
        },
        debug: (...args) => {
            write('debug', args);
        },
    };
}
const FALLBACK_UPDATE_CONFIG = [
    'provider: github',
    'owner: stoicsoft',
    'repo: 1devtool-releases',
    'updaterCacheDirName: 1devtool-updater',
    '',
].join('\n');
/**
 * Background-download resilience state. A mid-download network blip (e.g.
 * `net::ERR_NETWORK_CHANGED` on a Wi-Fi/VPN transition) kills the transfer and
 * electron-updater does nothing further — the "auto" download then silently
 * never happens until the next interval check, which looks to the user like
 * auto-download is broken. When a download we started dies, we re-run
 * `checkForUpdates()` on a backoff schedule; the resulting `update-available`
 * event re-enters the same preference + entitlement gated auto-download path.
 */
const DOWNLOAD_RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
let downloadInFlight = false;
let retryTimer = null;
let retryAttempts = 0;
let retryVersion = null;
/**
 * Version already downloaded AND handed to the platform installer in this
 * process (on macOS, Squirrel stages the bundle in
 * `~/Library/Caches/<id>.ShipIt/update.XXXX` and parks a ShipIt waiting for
 * app termination). Re-running `downloadUpdate()` for the same version — which
 * every `checkForUpdates()` used to do via the update-available handler —
 * re-stages a NEW update.XXXX dir, overwrites ShipItState.plist, and spawns
 * ANOTHER waiting ShipIt; when the app finally exits, a surviving ShipIt can
 * wake up with state pointing at a staging dir a later re-verify already
 * replaced → ENOENT → "Too many attempts to install" → the OLD version is
 * relaunched. One handoff per version per process is all Squirrel needs.
 */
let downloadedVersion = null;
/** Last status pushed to the renderer, plus sticky info/progress so late
 * subscribers (pill after window re-creation, dialog on open) can render the
 * real current state without forcing a fresh check. */
let lastStatus = { status: 'idle' };
let lastInfo;
let lastProgress;
function getUpdateStatusSnapshot() {
    return {
        ...lastStatus,
        info: lastStatus.info ?? lastInfo,
        progress: lastStatus.progress ?? lastProgress,
    };
}
function clearDownloadRetry() {
    if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
}
function scheduleDownloadRetry() {
    if (!resolveUpdaterPrefs().autoDownload)
        return false;
    if (retryAttempts >= DOWNLOAD_RETRY_DELAYS_MS.length)
        return false;
    const delay = DOWNLOAD_RETRY_DELAYS_MS[retryAttempts];
    retryAttempts += 1;
    clearDownloadRetry();
    retryTimer = setTimeout(() => {
        retryTimer = null;
        // A failed download needs a fresh check before downloadUpdate() is valid
        // again; the update-available handler restarts the gated auto-download.
        electron_updater_1.autoUpdater.checkForUpdates().catch(() => { });
    }, delay);
    retryTimer.unref?.();
    return true;
}
function configureUpdater() {
    // Prefer bundled updater metadata generated by electron-builder.
    // If an older packaged build is missing app-update.yml, fall back to a generated copy.
    const bundledConfigPath = path_1.default.join(process.resourcesPath, 'app-update.yml');
    if (!(0, fs_1.existsSync)(bundledConfigPath)) {
        const fallbackDir = path_1.default.join(electron_1.app.getPath('userData'), 'updater');
        const fallbackConfigPath = path_1.default.join(fallbackDir, 'app-update.yml');
        (0, fs_1.mkdirSync)(fallbackDir, { recursive: true });
        (0, fs_1.writeFileSync)(fallbackConfigPath, FALLBACK_UPDATE_CONFIG);
        electron_updater_1.autoUpdater.updateConfigPath = fallbackConfigPath;
    }
    // We use a custom latest-windows.yml filename in releases.
    if (process.platform === 'win32') {
        electron_updater_1.autoUpdater.channel = 'latest-windows';
    }
}
let updaterEventsBound = false;
function setupUpdater(window, deps = {}) {
    mainWindow = window;
    getPreferencesFn = deps.getPreferences ?? null;
    getLicenseInfoFn = deps.getLicenseInfo ?? null;
    // Configure auto-updater
    electron_updater_1.autoUpdater.logger = createUpdaterLogger();
    applyUpdaterPreferences();
    configureUpdater();
    // macOS re-creates the main window after close (app 'activate'), which
    // re-runs setupUpdater. autoUpdater is a process-wide singleton, so only the
    // window/deps rebinding above may repeat — re-registering the handlers would
    // stack duplicates (double downloads, duplicated status events).
    if (updaterEventsBound)
        return;
    updaterEventsBound = true;
    // Event handlers
    electron_updater_1.autoUpdater.on('checking-for-update', () => {
        sendUpdateStatus({ status: 'checking' });
    });
    electron_updater_1.autoUpdater.on('update-available', (info) => {
        // A new release supersedes any retry bookkeeping for the previous one.
        if (retryVersion !== info.version) {
            clearDownloadRetry();
            retryVersion = info.version;
            retryAttempts = 0;
            downloadedVersion = null;
        }
        // Already downloaded and handed to the installer this session — do NOT
        // re-download (see `downloadedVersion`); just re-assert the terminal state
        // so the pill/dialog don't rewind to "Update available".
        if (downloadedVersion === info.version) {
            sendUpdateStatus({ status: 'downloaded', info });
            return;
        }
        sendUpdateStatus({ status: 'available', info });
        // Pill honesty (§12.3): the pill must not read "Relaunch to update" until
        // the bits are actually downloaded. When the user has auto-download on AND
        // is entitled to this release (§12.4), start the download now so the pill
        // can progress available → downloading → downloaded on its own. Unentitled
        // (expired Pro past their window) or auto-download off → stay at
        // "available" and let the user decide via the pill/dialog.
        const { autoDownload } = resolveUpdaterPrefs();
        if (autoDownload && (0, updateEntitlement_1.updateEntitled)(getLicenseInfoFn?.(), info)) {
            downloadInFlight = true;
            electron_updater_1.autoUpdater.downloadUpdate().catch(() => {
                // The 'error' event fires for download failures and owns the status
                // update + retry scheduling; reporting here too would double-send.
            });
        }
    });
    electron_updater_1.autoUpdater.on('update-not-available', (info) => {
        sendUpdateStatus({ status: 'not-available', info });
    });
    electron_updater_1.autoUpdater.on('download-progress', (progress) => {
        downloadInFlight = true;
        sendUpdateStatus({ status: 'downloading', progress });
    });
    electron_updater_1.autoUpdater.on('update-downloaded', (info) => {
        downloadInFlight = false;
        clearDownloadRetry();
        retryAttempts = 0;
        downloadedVersion = info.version;
        sendUpdateStatus({ status: 'downloaded', info });
    });
    electron_updater_1.autoUpdater.on('error', (error) => {
        const wasDownloading = downloadInFlight;
        downloadInFlight = false;
        // Only a dying download gets a retry; failed checks are already re-run by
        // the renderer's interval.
        const retryScheduled = wasDownloading ? scheduleDownloadRetry() : false;
        sendUpdateStatus({ status: 'error', error: formatUpdaterError(error), retryScheduled });
    });
}
function sendUpdateStatus(status) {
    // Record the snapshot before attempting delivery — the window may be closed
    // (macOS) while a background download progresses, and the re-created
    // window's surfaces re-seed from `getUpdateStatusSnapshot()`.
    lastStatus = status;
    if (status.info)
        lastInfo = status.info;
    if (status.progress)
        lastProgress = status.progress;
    if (status.status === 'not-available') {
        lastInfo = status.info;
        lastProgress = undefined;
    }
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
        return;
    }
    try {
        mainWindow.webContents.send('updater:status', status);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('Render frame was disposed') ||
            message.includes('Object has been destroyed') ||
            message.includes('WebContents was destroyed')) {
            return;
        }
        console.error('Failed to send updater status to renderer', error);
    }
}
/** True while an install handoff (session save → quitAndInstall → exit
 * backstop) is in progress; makes updater:install idempotent. */
let installHandoffPending = false;
const PREPARE_FOR_INSTALL_DEADLINE_MS = 10_000;
/** Run the install preparation with a deadline: resolves to its result, or
 * `undefined` once the deadline passes (the preparation keeps running in the
 * background — its writes still race ahead of the 3s exit backstop). */
async function resolveWithDeadline(run, deadlineMs) {
    if (!run)
        return undefined;
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(run),
            new Promise((resolve) => {
                timer = setTimeout(() => {
                    console.warn(`[updater] prepareForInstall exceeded ${deadlineMs}ms — proceeding with install`);
                    resolve(undefined);
                }, deadlineMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function setupUpdaterIpcHandlers(options = {}) {
    electron_1.ipcMain.handle('updater:check', async () => {
        try {
            const result = await electron_updater_1.autoUpdater.checkForUpdates();
            if (result == null) {
                return {
                    ok: false,
                    error: 'Software updates are only available in packaged release builds.',
                };
            }
            return { ok: true, updateInfo: result?.updateInfo };
        }
        catch (error) {
            return {
                ok: false,
                error: formatUpdaterError(error),
            };
        }
    });
    electron_1.ipcMain.handle('updater:download', async () => {
        // Same re-staging guard as the update-available handler: a version that
        // was already handed to the installer must not be shipped again.
        if (downloadedVersion != null && lastInfo?.version === downloadedVersion) {
            sendUpdateStatus({ status: 'downloaded', info: lastInfo });
            return { ok: true };
        }
        try {
            downloadInFlight = true;
            await electron_updater_1.autoUpdater.downloadUpdate();
            return { ok: true };
        }
        catch (error) {
            return {
                ok: false,
                error: formatUpdaterError(error),
            };
        }
    });
    electron_1.ipcMain.handle('updater:get-status', async () => {
        return getUpdateStatusSnapshot();
    });
    electron_1.ipcMain.handle('updater:install', async () => {
        // Single-flight: a second "Restart & Install" click while the first
        // handoff is still driving toward exit must not re-run the session save or
        // re-invoke quitAndInstall (which would re-ship the update to Squirrel —
        // see `downloadedVersion` for the staging race that causes).
        if (installHandoffPending) {
            return { ok: true };
        }
        installHandoffPending = true;
        let rollbackPreparation;
        try {
            // Save before allowing the updater to quit. quitAndInstall may bypass the
            // regular before-quit path, and the packaged-build backstop below uses
            // app.exit(), which does not emit normal shutdown events.
            //
            // Deadline-capped: this sweep walks every terminal (session-id capture +
            // buffer save + daemon lease). If it wedges, the install silently never
            // starts — the app stays open, the exit backstop below is never even
            // scheduled, and "Restart & Install" looks dead. Past the deadline we
            // proceed with the install; losing session metadata is recoverable
            // (normal quit persistence still runs), a blocked update is not.
            const preparation = await resolveWithDeadline(options.prepareForInstall, PREPARE_FOR_INSTALL_DEADLINE_MS);
            rollbackPreparation = typeof preparation === 'function' ? preparation : undefined;
            // Force allow quit to bypass any close handlers (e.g., active processes check).
            // Without this, the app may only minimize instead of quitting on macOS.
            (0, AppQuitService_1.forceAllowQuit)();
            electron_updater_1.autoUpdater.quitAndInstall(false, true);
        }
        catch (error) {
            installHandoffPending = false;
            rollbackPreparation?.();
            (0, AppQuitService_1.resetQuitState)();
            return { ok: false, error: formatUpdaterError(error) };
        }
        // Backstop: `forceAllowQuit()` only flips a permission flag — nothing here
        // forces the process to actually die. On macOS, `quitAndInstall` sometimes
        // fails to fully terminate (it "only minimizes"), so Squirrel's ShipIt sees
        // a still-running instance and aborts the bundle swap with
        // `SQRLInstallerError -9 "App Still Running"`, then relaunches the OLD
        // version — the user has to reboot for the queued install to land. The
        // external installer (ShipIt on mac, the spawned NSIS/AppImage installer on
        // win/linux) was already handed the update synchronously above, so a hard
        // exit after a short grace lets it complete the swap. If the normal quit
        // succeeds first, the process is already gone and this timer never fires.
        // Gated to packaged builds so it can never hard-exit a dev session (where
        // quitAndInstall may be a no-op rather than throwing).
        if (electron_1.app.isPackaged) {
            setTimeout(() => {
                (0, AppQuitService_1.forceAllowQuit)();
                electron_1.app.exit(0);
            }, 3000);
        }
        return { ok: true };
    });
    electron_1.ipcMain.handle('updater:get-version', async () => {
        return electron_1.app.getVersion();
    });
}
function formatUpdaterError(error) {
    const message = error instanceof Error ? error.message : 'Failed to check for updates';
    if (message.includes('app-update.yml') || message.includes('dev-app-update.yml')) {
        return 'This build is missing bundled update metadata. Install a packaged release build to use in-app updates.';
    }
    if (message.includes('nor sha256 neither sha512 checksum')) {
        return 'The update package has a missing checksum. This release may need to be re-published. Please try again later or download the update manually from GitHub.';
    }
    // electron-updater's findFile() returns `undefined` when the release feed has
    // no artifact matching this platform/architecture (e.g. latest-linux.yml
    // listed only the .deb and no .AppImage). It then dereferences
    // `fileInfo.info.sha512`, throwing a raw "Cannot read properties of undefined
    // (reading 'info')". Translate it to something actionable instead of a stack-y
    // TypeError. Also covers the explicit "no files" provider error.
    if (/reading '?info'?/.test(message) ||
        message.includes('ERR_UPDATER_NO_FILES_PROVIDED') ||
        message.includes('No files provided')) {
        return 'This release has no compatible download for your platform/architecture. Please update manually by downloading the latest version from GitHub.';
    }
    // Linux: auto-update only works when running the packaged AppImage.
    if (message.includes('APPIMAGE')) {
        return 'Automatic updates require running the AppImage build. Reinstall from the AppImage, or download the latest version manually from GitHub.';
    }
    return message;
}
