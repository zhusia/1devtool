"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAiSettingsIpcHandlers = registerAiSettingsIpcHandlers;
const electron_1 = require("electron");
const agentPaths_1 = require("../agentPaths");
function registerAiSettingsIpcHandlers({ storeManager, aiUsageService, }) {
    // AI agent paths (Settings → AI tab) ───────────────────────────────────
    electron_1.ipcMain.handle('ai-paths:list', async () => {
        const overrides = storeManager.getPreferences().aiAgentPaths || {};
        return (0, agentPaths_1.listAgentDescriptors)().map((d) => ({
            agentType: d.agentType,
            defaultPath: (0, agentPaths_1.getDefaultAgentRoot)(d.agentType),
            currentPath: (0, agentPaths_1.getAgentRoot)(d.agentType, overrides),
            isDefault: !(overrides[d.agentType]?.trim()),
            subdirs: d.subdirs,
        }));
    });
    electron_1.ipcMain.handle('ai-paths:scan', async (_, args) => {
        return (0, agentPaths_1.scanAgentPath)(args.agentType, args.override);
    });
    electron_1.ipcMain.handle('ai-paths:default', async (_, args) => {
        return (0, agentPaths_1.getDefaultAgentRoot)(args.agentType);
    });
    // AI usage tracking (Settings → AI tab, Usage section) ───────────────────
    electron_1.ipcMain.handle('ai-usage:summary', async (_, query) => {
        const overrides = storeManager.getPreferences().aiAgentPaths || {};
        return aiUsageService.buildSummary(overrides, query);
    });
    electron_1.ipcMain.handle('ai-usage:refresh', async (_, query) => {
        aiUsageService.clearCache();
        const overrides = storeManager.getPreferences().aiAgentPaths || {};
        return aiUsageService.buildSummary(overrides, query);
    });
    // Per-session totals — the Orchestration Dashboard joins these to terminals
    // to report usage per agent team (docs/features/orchestration/dashboard.md §6.4).
    electron_1.ipcMain.handle('ai-usage:by-session', async (_, query) => {
        const overrides = storeManager.getPreferences().aiAgentPaths || {};
        return aiUsageService.buildSessionUsage(overrides, query);
    });
}
