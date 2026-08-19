"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLOUDFLARED_VERSION_FALLBACK = void 0;
exports.onInstallProgress = onInstallProgress;
exports.onTunnelEvent = onTunnelEvent;
exports.getInstallStatus = getInstallStatus;
exports.installBinary = installBinary;
exports.cancelInstall = cancelInstall;
exports.uninstallBinary = uninstallBinary;
exports.startTunnel = startTunnel;
exports.stopTunnel = stopTunnel;
exports.getTunnelStatus = getTunnelStatus;
exports.killTunnelSync = killTunnelSync;
const events_1 = require("events");
const version_1 = require("./version");
Object.defineProperty(exports, "CLOUDFLARED_VERSION_FALLBACK", { enumerable: true, get: function () { return version_1.CLOUDFLARED_VERSION_FALLBACK; } });
const paths_1 = require("./paths");
const download_1 = require("./download");
const process_1 = require("./process");
/**
 * Aggregator emitter combining install progress + tunnel lifecycle events
 * for the renderer.
 */
const events = new events_1.EventEmitter();
events.setMaxListeners(50);
process_1.tunnelManager.on('event', (ev) => {
    events.emit('tunnel-event', ev);
});
function onInstallProgress(cb) {
    events.on('install-progress', cb);
    return () => events.off('install-progress', cb);
}
function onTunnelEvent(cb) {
    events.on('tunnel-event', cb);
    return () => events.off('tunnel-event', cb);
}
function getInstallStatus() {
    try {
        (0, paths_1.resolvePlatformAsset)();
    }
    catch (err) {
        return {
            installed: false,
            supported: false,
            unsupportedReason: err.message,
        };
    }
    if (!(0, download_1.isInstalled)()) {
        return { installed: false, supported: true };
    }
    const meta = (0, download_1.readMeta)();
    if (!meta)
        return { installed: false, supported: true };
    return {
        installed: true,
        supported: true,
        version: meta.version,
        path: (0, paths_1.getBinaryPath)(),
        sizeBytes: meta.sizeBytes,
        installedAt: meta.installedAt,
    };
}
async function installBinary() {
    try {
        const { emitter, promise } = (0, download_1.downloadBinary)();
        emitter.on('progress', (p) => {
            events.emit('install-progress', p);
        });
        await promise;
        return { ok: true };
    }
    catch (err) {
        if (err instanceof download_1.DownloadError) {
            return { ok: false, error: err.message, errorCode: err.code };
        }
        return { ok: false, error: err.message };
    }
}
function cancelInstall() {
    (0, download_1.cancelDownload)();
}
function uninstallBinary() {
    (0, download_1.removeBinary)();
}
async function startTunnel(localPort) {
    return process_1.tunnelManager.start(localPort);
}
async function stopTunnel() {
    await process_1.tunnelManager.stop();
}
function getTunnelStatus() {
    return process_1.tunnelManager.getStatus();
}
/**
 * App-quit teardown. Synchronous SIGKILL — see process.ts for rationale.
 */
function killTunnelSync() {
    process_1.tunnelManager.killChildSync();
}
