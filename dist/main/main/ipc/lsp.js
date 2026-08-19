"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerLspIpcHandlers = registerLspIpcHandlers;
const electron_1 = require("electron");
const installer_1 = require("../lsp/installer");
const host_1 = require("../lsp/host");
const registry_1 = require("../lsp/registry");
function registerLspIpcHandlers({ storeManager, lspHost, }) {
    electron_1.ipcMain.handle('lsp:registry', async () => {
        return (0, registry_1.getLspLanguageRegistry)();
    });
    electron_1.ipcMain.handle('lsp:detect', async (_, args) => {
        const { languageId } = (args ?? {});
        const preferences = storeManager.getPreferences();
        if (languageId) {
            return (0, installer_1.detectLanguageStatus)(languageId, preferences.languages);
        }
        return (0, installer_1.detectAllLanguageStatuses)(preferences.languages);
    });
    electron_1.ipcMain.handle('lsp:enable', async (_, args) => {
        const { languageId } = args;
        const preferences = storeManager.getPreferences();
        const enabled = preferences.languages.enabled.includes(languageId)
            ? preferences.languages.enabled
            : [...preferences.languages.enabled, languageId];
        storeManager.setPreferences({
            ...preferences,
            languages: {
                ...preferences.languages,
                enabled,
            },
        });
        return storeManager.getPreferences().languages;
    });
    electron_1.ipcMain.handle('lsp:disable', async (_, args) => {
        const { languageId } = args;
        const preferences = storeManager.getPreferences();
        storeManager.setPreferences({
            ...preferences,
            languages: {
                ...preferences.languages,
                enabled: preferences.languages.enabled.filter((id) => id !== languageId),
            },
        });
        return storeManager.getPreferences().languages;
    });
    electron_1.ipcMain.handle('lsp:install', async (_, args) => {
        const { languageId } = args;
        const preferences = storeManager.getPreferences();
        const result = await (0, installer_1.installLanguage)(languageId, preferences.languages);
        if (result.ok && result.status?.binaryPath) {
            storeManager.setPreferences({
                ...preferences,
                languages: {
                    ...preferences.languages,
                    installPaths: {
                        ...preferences.languages.installPaths,
                        [languageId]: result.status.binaryPath,
                    },
                },
            });
        }
        return result;
    });
    // -------------------------------------------------------------------------
    // Per-project LSP — phase 4 plumbing for the user's right-click flow.
    // The renderer triggers `lsp:enable-project` after the user clicks "Enable
    // language support" on a project; main spawns the requested language
    // servers and forwards a MessagePort per server back via webContents
    // .postMessage('lsp:port', …). Crashes flow back via 'lsp:crashed'.
    // -------------------------------------------------------------------------
    electron_1.ipcMain.handle('lsp:detect-project-languages', async (_, args) => {
        const { projectRoot } = args;
        if (!projectRoot) {
            throw new Error('projectRoot is required');
        }
        const preferences = storeManager.getPreferences();
        const enabledLanguageIds = new Set(preferences.languages.enabled);
        const counts = (0, host_1.detectLanguagesInProject)(projectRoot);
        const detections = [];
        for (const [languageId, fileCount] of counts.entries()) {
            if (!enabledLanguageIds.has(languageId))
                continue;
            const definition = (0, registry_1.getLspLanguageDefinition)(languageId);
            if (!definition)
                continue;
            const status = await (0, installer_1.detectLanguageStatus)(languageId, preferences.languages);
            detections.push({
                languageId,
                displayName: definition.displayName,
                fileCount,
                installed: status.detected,
                status,
            });
        }
        // Sort by file count (most-prevalent language first) so the dialog leads
        // with what the user is most likely to want.
        detections.sort((a, b) => b.fileCount - a.fileCount);
        return detections;
    });
    electron_1.ipcMain.handle('lsp:enable-project', async (_, args) => {
        const { projectId, projectRoot, languageIds } = args;
        if (!lspHost)
            throw new Error('LSP host not initialized');
        if (!projectId || !projectRoot) {
            throw new Error('projectId and projectRoot are required');
        }
        if (!Array.isArray(languageIds) || languageIds.length === 0) {
            throw new Error('languageIds must be a non-empty array');
        }
        const preferences = storeManager.getPreferences();
        const enabledLanguageIds = new Set(preferences.languages.enabled);
        const allowedLanguageIds = [...new Set(languageIds)].filter((languageId) => enabledLanguageIds.has(languageId));
        if (allowedLanguageIds.length === 0) {
            throw new Error('No selected languages are enabled in Settings → IDE → Code Intelligence');
        }
        return lspHost.enableForProject({ projectId, projectRoot, languageIds: allowedLanguageIds });
    });
    electron_1.ipcMain.handle('lsp:disable-project', async (_, args) => {
        const { projectId } = args;
        if (!lspHost)
            throw new Error('LSP host not initialized');
        if (!projectId)
            throw new Error('projectId is required');
        await lspHost.disableForProject(projectId);
        return { ok: true };
    });
    electron_1.ipcMain.handle('lsp:project-status', async (_, args) => {
        const { projectId } = (args ?? {});
        if (!lspHost)
            return [];
        return lspHost.getProjectStatus(projectId);
    });
    electron_1.ipcMain.handle('lsp:notify-initialized', async (_, args) => {
        const { instanceId } = args;
        if (!lspHost)
            return;
        lspHost.notifyInitialized(instanceId);
    });
}
