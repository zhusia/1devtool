"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerGstackIpcHandlers = registerGstackIpcHandlers;
const electron_1 = require("electron");
function registerGstackIpcHandlers(gstackManager, sendToRenderer) {
    // gstack handlers
    electron_1.ipcMain.handle('gstack:get-status', async () => {
        return gstackManager.getStatus();
    });
    electron_1.ipcMain.handle('gstack:check-prerequisites', async () => {
        return gstackManager.checkPrerequisites();
    });
    electron_1.ipcMain.handle('gstack:install', async () => {
        return gstackManager.install((data) => {
            sendToRenderer('gstack:install-log', { data });
        });
    });
    electron_1.ipcMain.handle('gstack:update', async () => {
        return gstackManager.update((data) => {
            sendToRenderer('gstack:install-log', { data });
        });
    });
    electron_1.ipcMain.handle('gstack:get-skills', async () => {
        return gstackManager.getSkills();
    });
    electron_1.ipcMain.handle('gstack:check-update', async () => {
        return gstackManager.checkForUpdate();
    });
}
