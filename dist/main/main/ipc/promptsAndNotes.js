"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerPromptsAndNotesIpcHandlers = registerPromptsAndNotesIpcHandlers;
const electron_1 = require("electron");
function registerPromptsAndNotesIpcHandlers({ promptHistoryManager, notesManager, resumeManager, }) {
    // Prompt history handlers
    electron_1.ipcMain.handle('prompts:save', async (_, args) => {
        try {
            promptHistoryManager.save(args);
        }
        catch (error) {
            console.error('Failed to save prompt:', error);
        }
    });
    electron_1.ipcMain.handle('prompts:search', async (_, args) => {
        return promptHistoryManager.search(args);
    });
    electron_1.ipcMain.handle('prompts:delete', async (_, args) => {
        promptHistoryManager.delete(args.id);
    });
    electron_1.ipcMain.handle('prompts:projects', async () => {
        return promptHistoryManager.getDistinctProjects();
    });
    electron_1.ipcMain.handle('prompts:agents', async () => {
        return promptHistoryManager.getDistinctAgents();
    });
    electron_1.ipcMain.handle('prompts:latest-by-terminals', async (_, args) => {
        const { terminalIds } = args;
        return promptHistoryManager.getLatestPromptsByTerminals(terminalIds);
    });
    electron_1.ipcMain.handle('prompts:sync-local-data', async () => {
        const localPrompts = await resumeManager.collectLocalPromptRecords();
        return promptHistoryManager.importLocalPrompts(localPrompts.records, {
            scannedSessions: localPrompts.scannedSessions,
            agents: localPrompts.agents,
        });
    });
    // Sticky notes handlers
    electron_1.ipcMain.handle('notes:create', async (_, args) => {
        try {
            return notesManager.create(args);
        }
        catch (error) {
            console.error('Failed to create note:', error);
            return null;
        }
    });
    electron_1.ipcMain.handle('notes:update', async (_, args) => {
        try {
            notesManager.update(args);
        }
        catch (error) {
            console.error('Failed to update note:', error);
        }
    });
    electron_1.ipcMain.handle('notes:delete', async (_, args) => {
        notesManager.delete(args.id);
    });
    electron_1.ipcMain.handle('notes:list-context', async (_, args) => {
        return notesManager.listForContext(args);
    });
    electron_1.ipcMain.handle('notes:search', async (_, args) => {
        return notesManager.search(args);
    });
    electron_1.ipcMain.handle('notes:projects', async () => {
        return notesManager.getDistinctProjects();
    });
}
