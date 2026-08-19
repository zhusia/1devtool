"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isQuitAllowed = isQuitAllowed;
exports.forceAllowQuit = forceAllowQuit;
exports.requestAppRelaunch = requestAppRelaunch;
exports.resetQuitState = resetQuitState;
const electron_1 = require("electron");
/**
 * Manages the app quit state.
 * Used to bypass any close handlers when force-quitting
 * (e.g., for auto-updater installation).
 */
let allowQuit = false;
/**
 * Returns whether the app is allowed to quit (bypassing close handlers).
 */
function isQuitAllowed() {
    return allowQuit;
}
/**
 * Force allows the app to quit, bypassing any close handlers.
 * Used by the auto-updater to ensure the app quits for install.
 */
function forceAllowQuit() {
    allowQuit = true;
}
/**
 * Relaunches the app through the same "allow quit first" path used by
 * updater-driven quits, so close handlers do not swallow the restart.
 */
function requestAppRelaunch() {
    forceAllowQuit();
    electron_1.app.relaunch();
    electron_1.app.quit();
}
/**
 * Resets the quit state (for completeness, not typically needed).
 */
function resetQuitState() {
    allowQuit = false;
}
