"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WINDOWS_APP_USER_MODEL_ID = void 0;
exports.configureWindowsAppIdentity = configureWindowsAppIdentity;
exports.shouldUseCustomNotificationIcon = shouldUseCustomNotificationIcon;
/**
 * Must match electron-builder's `build.appId` in package.json. The NSIS
 * shortcut registers this AUMID with Windows, including 1DevTool's display
 * name and icon. Electron otherwise falls back to `electron.app.<name>` for
 * notifications, which Windows exposes as the toast's application identity.
 */
exports.WINDOWS_APP_USER_MODEL_ID = 'com.stoicsoft.1devtool';
function configureWindowsAppIdentity(platform, setAppUserModelId) {
    if (platform === 'win32') {
        setAppUserModelId(exports.WINDOWS_APP_USER_MODEL_ID);
    }
}
/**
 * Windows gets the branded toast logo from the registered AUMID. Supplying a
 * content icon there replaces it (currently with a project avatar), so custom
 * notification icons remain a macOS/Linux-only enhancement.
 */
function shouldUseCustomNotificationIcon(platform) {
    return platform !== 'win32';
}
