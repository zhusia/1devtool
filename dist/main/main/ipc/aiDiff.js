"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAiDiffIpcHandlers = registerAiDiffIpcHandlers;
const electron_1 = require("electron");
function registerAiDiffIpcHandlers(aiDiffManager) {
    electron_1.ipcMain.handle('ai-diff:start-session', async (_, args) => {
        return aiDiffManager.startSession(args);
    });
    electron_1.ipcMain.handle('ai-diff:end-session', async (_, args) => {
        const { sessionId, status } = args;
        return aiDiffManager.endSession(sessionId, status);
    });
    electron_1.ipcMain.handle('ai-diff:list-sessions', async (_, args) => {
        const { projectId } = (args ?? {});
        return aiDiffManager.listSessions(projectId);
    });
    electron_1.ipcMain.handle('ai-diff:list-pending', async (_, args) => {
        const { sessionId } = args;
        return aiDiffManager.listPendingChanges(sessionId);
    });
    electron_1.ipcMain.handle('ai-diff:get-baseline', async (_, args) => {
        const { sessionId, filePath } = args;
        return aiDiffManager.getBaselineContent(sessionId, filePath);
    });
    electron_1.ipcMain.handle('ai-diff:get-diff', async (_, args) => {
        const { sessionId, filePath } = args;
        return aiDiffManager.getDiff(sessionId, filePath);
    });
    electron_1.ipcMain.handle('ai-diff:accept', async (_, args) => {
        const { sessionId, filePath } = args;
        await aiDiffManager.acceptChange(sessionId, filePath);
        return { ok: true };
    });
    electron_1.ipcMain.handle('ai-diff:revert', async (_, args) => {
        const { sessionId, filePath } = args;
        await aiDiffManager.revertFile(sessionId, filePath);
        return { ok: true };
    });
}
