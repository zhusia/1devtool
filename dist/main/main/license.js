"use strict";
/**
 * License IPC Handlers
 *
 * Exposes license operations to the renderer process.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerLicenseHandlers = registerLicenseHandlers;
const electron_1 = require("electron");
const LicenseService_1 = require("./services/LicenseService");
function formatLicenseError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorMap = {
        'license_key not found': 'Your license key is not valid. Please check and try again.',
        'License key is required': 'Please enter a license key to continue.',
        'Email does not match license purchase': 'The email address does not match the license purchase. Please use the email you used when purchasing.',
        'activation limit exceeded': 'This license has reached its activation limit. Please deactivate it on another device first.',
        'License activation failed': 'Unable to activate license. Please check your internet connection and try again.',
    };
    if (errorMap[message]) {
        return errorMap[message];
    }
    const lowerMessage = message.toLowerCase();
    if (lowerMessage.includes('license_key not found') ||
        lowerMessage.includes('license key not found')) {
        return 'Your license key is not valid. Please check and try again.';
    }
    if (lowerMessage.includes('activation limit')) {
        return 'This license has reached its activation limit. Please deactivate it on another device first.';
    }
    if (lowerMessage.includes('email') && lowerMessage.includes('match')) {
        return 'The email address does not match the license purchase. Please use the email you used when purchasing.';
    }
    if (lowerMessage.includes('network') ||
        lowerMessage.includes('fetch') ||
        lowerMessage.includes('connection')) {
        return 'Unable to connect to license server. Please check your internet connection and try again.';
    }
    if (lowerMessage.includes('expired')) {
        return 'Your update eligibility has expired. All PRO features remain available — purchase a new license to receive updates.';
    }
    return message;
}
function registerLicenseHandlers(broadcast) {
    if (broadcast) {
        LicenseService_1.licenseService.onChange((snapshot) => {
            broadcast('license:changed', snapshot);
        });
    }
    electron_1.ipcMain.handle('license:get-info', async () => {
        try {
            const info = LicenseService_1.licenseService.getLicenseInfo();
            return { success: true, data: info };
        }
        catch (error) {
            console.error('[license ipc] Failed to fetch license info', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle('license:get-limits', async () => {
        try {
            const limits = LicenseService_1.licenseService.getUsageLimits();
            return { success: true, data: limits };
        }
        catch (error) {
            console.error('[license ipc] Failed to fetch usage limits', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle('license:activate', async (_event, payload) => {
        try {
            const { licenseKey, email } = payload;
            await LicenseService_1.licenseService.activateLicense(licenseKey, email);
            const info = LicenseService_1.licenseService.getLicenseInfo();
            const limits = LicenseService_1.licenseService.getUsageLimits();
            return { success: true, data: { info, limits } };
        }
        catch (error) {
            console.error('[license ipc] Failed to activate license', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle('license:validate', async () => {
        try {
            const isValid = await LicenseService_1.licenseService.validateLicense();
            const info = LicenseService_1.licenseService.getLicenseInfo();
            return { success: true, data: { valid: isValid, info } };
        }
        catch (error) {
            console.error('[license ipc] Failed to validate license', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle('license:deactivate', async () => {
        try {
            await LicenseService_1.licenseService.deactivateLicense();
            const info = LicenseService_1.licenseService.getLicenseInfo();
            const limits = LicenseService_1.licenseService.getUsageLimits();
            return { success: true, data: { info, limits } };
        }
        catch (error) {
            console.error('[license ipc] Failed to deactivate license', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle('license:can-add-project', async (_event, payload) => {
        try {
            const result = LicenseService_1.licenseService.canAddProject(payload?.currentCount ?? 0);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[license ipc] Failed to evaluate project limit', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle('license:can-add-terminal', async (_event, payload) => {
        try {
            const result = LicenseService_1.licenseService.canAddTerminal(payload.currentCount);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[license ipc] Failed to evaluate terminal limit', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle('license:can-add-browser-tab', async (_event, payload) => {
        try {
            const result = LicenseService_1.licenseService.canAddBrowserTab(payload.currentCount);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[license ipc] Failed to evaluate browser tab limit', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle('license:can-add-channel', async (_event, payload) => {
        try {
            const result = LicenseService_1.licenseService.canAddChannel(payload.currentCount);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[license ipc] Failed to evaluate channel limit', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle('license:can-add-db-connection', async (_event, payload) => {
        try {
            const result = LicenseService_1.licenseService.canAddDbConnection(payload.scope, payload.currentCount);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[license ipc] Failed to evaluate DB connection limit', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle('license:can-save-http-request', async (_event, payload) => {
        try {
            const result = LicenseService_1.licenseService.canSaveHttpRequest(payload.currentCount);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[license ipc] Failed to evaluate HTTP saved request limit', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle('license:can-add-git-worktree', async (_event, payload) => {
        try {
            const result = LicenseService_1.licenseService.canAddGitWorktree(payload.currentCount);
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[license ipc] Failed to evaluate git worktree limit', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle('license:can-use-ai-diff', async () => {
        try {
            const result = LicenseService_1.licenseService.canUseAiDiff();
            return { success: true, data: result };
        }
        catch (error) {
            console.error('[license ipc] Failed to evaluate AI Diff limit', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
    electron_1.ipcMain.handle('license:increment-ai-diff', async () => {
        try {
            LicenseService_1.licenseService.incrementAiDiff();
            return { success: true };
        }
        catch (error) {
            console.error('[license ipc] Failed to increment AI Diff counter', error);
            return { success: false, error: formatLicenseError(error) };
        }
    });
}
