"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSimulatorIpcHandlers = registerSimulatorIpcHandlers;
const electron_1 = require("electron");
const android_build_run_1 = require("../simulator/android-build-run");
const ios_build_run_1 = require("../simulator/ios-build-run");
function registerSimulatorIpcHandlers({ simulatorManager, sendToRenderer, }) {
    // Simulator / Mobile Emulator handlers
    electron_1.ipcMain.handle('simulator:detect-toolchains', async () => {
        try {
            return await simulatorManager.detectToolchains();
        }
        catch {
            return {
                ios: { available: false, reason: 'Detection failed' },
                android: { available: false, reason: 'Detection failed' },
            };
        }
    });
    electron_1.ipcMain.handle('simulator:list', async (_, args) => {
        try {
            const devices = await simulatorManager.list(args.platform);
            return { ok: true, devices };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Failed to list devices' };
        }
    });
    electron_1.ipcMain.handle('simulator:boot', async (_, args) => {
        try {
            await simulatorManager.boot(args.platform, args.deviceId);
            return { ok: true };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Failed to boot device' };
        }
    });
    electron_1.ipcMain.handle('simulator:shutdown', async (_, args) => {
        try {
            await simulatorManager.shutdown(args.platform, args.deviceId);
            return { ok: true };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Failed to shutdown device' };
        }
    });
    electron_1.ipcMain.handle('simulator:install', async (_, args) => {
        try {
            await simulatorManager.install(args.platform, args.deviceId, args.appPath);
            return { ok: true };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Failed to install app' };
        }
    });
    electron_1.ipcMain.handle('simulator:open-url', async (_, args) => {
        try {
            await simulatorManager.openUrl(args.platform, args.deviceId, args.url);
            return { ok: true };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Failed to open URL' };
        }
    });
    electron_1.ipcMain.handle('simulator:build-and-run-ios', async (_, args) => {
        return (0, ios_build_run_1.buildAndRunIOSApp)(args.projectRoot, args.deviceId, args.options);
    });
    electron_1.ipcMain.handle('simulator:build-and-run-android', async (_, args) => {
        if (!args?.deviceId) {
            return { ok: false, error: 'Select an Android emulator before building.' };
        }
        try {
            await simulatorManager.boot('android', args.deviceId);
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Failed to boot Android emulator.' };
        }
        return (0, android_build_run_1.buildAndRunAndroidApp)(args.projectRoot, args.deviceId, args.options);
    });
    electron_1.ipcMain.handle('simulator:send-input', async (_, args) => {
        try {
            await simulatorManager.sendInput(args.platform, args.deviceId, args.event);
            return { ok: true };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Failed to send input' };
        }
    });
    electron_1.ipcMain.handle('simulator:start-stream', async (_, args) => {
        try {
            const streamId = `${args.platform}:${args.deviceId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
            const stream = await simulatorManager.startStream(args.platform, args.deviceId, (chunk) => {
                sendToRenderer('simulator:stream-data', {
                    deviceId: args.deviceId,
                    streamId,
                    base64: chunk.toString('base64'),
                });
            }, (error) => {
                sendToRenderer('simulator:stream-error', { deviceId: args.deviceId, streamId, error: error.message });
            }, (code) => {
                sendToRenderer('simulator:stream-exit', { deviceId: args.deviceId, streamId, code });
            });
            return {
                ok: true,
                streamId,
                streamUrl: stream.streamUrl,
                captureSourceId: stream.captureSourceId,
                captureSourceName: stream.captureSourceName,
                streamMode: stream.streamMode,
            };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Failed to start stream' };
        }
    });
    electron_1.ipcMain.handle('simulator:set-dimensions', async (_, args) => {
        simulatorManager.setScreenshotDimensions(args.platform, args.deviceId, args.width, args.height);
        return { ok: true };
    });
    electron_1.ipcMain.handle('simulator:wda-host', async (_, args) => {
        try {
            const adapter = await simulatorManager.getAdapter('ios');
            if (typeof args?.host === 'string') {
                adapter?.setWDAHost?.(args.host);
            }
            return { ok: true, host: adapter?.getWDAHost?.() };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Failed to update WDA host' };
        }
    });
    electron_1.ipcMain.handle('simulator:wda-command', async (_, args) => {
        try {
            const adapter = await simulatorManager.getAdapter('ios');
            if (args.command === 'home') {
                await adapter?.pressHome?.(args.deviceId);
            }
            else if (args.command === 'lock') {
                await adapter?.pressLock?.(args.deviceId);
            }
            else if (args.command === 'launch') {
                await adapter?.launchApp?.(args.deviceId, args.bundleId);
            }
            else if (args.command === 'source') {
                const source = await adapter?.getSource?.(args.deviceId);
                return { ok: true, source };
            }
            return { ok: true };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Simulator command failed' };
        }
    });
    electron_1.ipcMain.handle('simulator:android-command', async (_, args) => {
        try {
            const adapter = await simulatorManager.getAdapter('android');
            if (args.command === 'home') {
                await adapter?.pressHome?.(args.deviceId);
            }
            else if (args.command === 'back') {
                await adapter?.pressBack?.(args.deviceId);
            }
            else if (args.command === 'overview') {
                await adapter?.pressOverview?.(args.deviceId);
            }
            else if (args.command === 'lock') {
                await adapter?.pressLock?.(args.deviceId);
            }
            else if (args.command === 'launch') {
                await adapter?.launchApp?.(args.deviceId, args.packageName, args.activityName);
            }
            return { ok: true };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Android command failed' };
        }
    });
    electron_1.ipcMain.handle('simulator:anchor', async (_, args) => {
        try {
            const adapter = await simulatorManager.getAdapter('ios');
            if (adapter?.anchorWindow) {
                return await adapter.anchorWindow(args.x, args.y);
            }
            return { ok: false, error: 'Anchor is not supported' };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Failed to anchor simulator' };
        }
    });
    electron_1.ipcMain.handle('simulator:reposition', async (_, args) => {
        try {
            const adapter = await simulatorManager.getAdapter('ios');
            await adapter?.repositionWindow?.(args.x, args.y);
            return { ok: true };
        }
        catch {
            return { ok: true };
        }
    });
    electron_1.ipcMain.handle('simulator:hide-window', async () => {
        try {
            const adapter = await simulatorManager.getAdapter('ios');
            await adapter?.hideWindow?.();
            return { ok: true };
        }
        catch {
            return { ok: true };
        }
    });
    electron_1.ipcMain.handle('simulator:show-window', async () => {
        try {
            const adapter = await simulatorManager.getAdapter('ios');
            await adapter?.showWindow?.();
            return { ok: true };
        }
        catch {
            return { ok: true };
        }
    });
    electron_1.ipcMain.handle('simulator:unfloat', async () => {
        try {
            const adapter = await simulatorManager.getAdapter('ios');
            await adapter?.unfloatWindow?.();
            return { ok: true };
        }
        catch {
            return { ok: true };
        }
    });
    electron_1.ipcMain.handle('simulator:stop-stream', async (_, args) => {
        simulatorManager.stopStream(args.deviceId);
        return { ok: true };
    });
}
