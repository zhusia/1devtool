"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerStorageIpcHandlers = registerStorageIpcHandlers;
const electron_1 = require("electron");
const updater_1 = require("../updater");
const LicenseService_1 = require("../services/LicenseService");
const projectRename_1 = require("../projectRename");
const files_1 = require("../projectSettings/files");
function registerStorageIpcHandlers({ storeManager, projectSettingsManager, appConfigTransferService, getMainWindow, onProjectGroupMutated, onAppConfigImported, onPreferencesChanged, }) {
    // Store handlers
    electron_1.ipcMain.handle('store:get', async (_, args) => {
        const { key } = args;
        return storeManager.get(key);
    });
    electron_1.ipcMain.handle('store:set', async (_, args) => {
        const { key, value } = args;
        storeManager.set(key, value);
    });
    electron_1.ipcMain.handle('store:get-projects', async () => {
        return storeManager.getProjects();
    });
    electron_1.ipcMain.handle('store:save-project', async (_, project) => {
        storeManager.saveProject(project);
        // Mirror the project-backed domains into `.1devtool/` (no-op unless the
        // folder is enabled + user is Pro; debounced + own-write-guarded).
        for (const domain of ['settings', 'browser', 'database', 'env', 'http']) {
            projectSettingsManager?.writeBack(project.id, domain);
        }
    });
    electron_1.ipcMain.handle('store:rename-project', async (_, args) => {
        const project = storeManager.getProjects().find((item) => item.id === args.projectId);
        if (!project)
            throw new Error('Project not found.');
        const result = (0, projectRename_1.renameProject)(project, args.name, { renameFolder: args.renameFolder === true });
        storeManager.saveProject(result.project);
        // The `.1devtool/` folder moves with the project directory. Trigger the
        // normal write-back path so derived files settle at the new root. A
        // label-only rename leaves the root where it was, so there is nothing
        // to settle.
        if (result.newRootPath !== result.oldRootPath) {
            for (const domain of ['settings', 'browser', 'database', 'env', 'http']) {
                projectSettingsManager?.writeBack(result.project.id, domain);
            }
        }
        return result;
    });
    electron_1.ipcMain.handle('store:set-project-http-tabs', async (_, args) => {
        storeManager.setProjectHttpTabs(args.projectId, args.tabs);
        projectSettingsManager?.writeBack(args.projectId, 'http');
    });
    // --- Project settings folder (.1devtool/) ---
    electron_1.ipcMain.handle('projectSettings:get-status', async (_, args) => {
        return projectSettingsManager.getStatus(args.projectId);
    });
    electron_1.ipcMain.handle('projectSettings:enable', async (_, args) => {
        return projectSettingsManager.enable(args.projectId);
    });
    electron_1.ipcMain.handle('projectSettings:disable', async (_, args) => {
        await projectSettingsManager.disable(args.projectId);
        return projectSettingsManager.getStatus(args.projectId);
    });
    electron_1.ipcMain.handle('projectSettings:approve', async (_, args) => {
        return projectSettingsManager.approve(args.projectId, args.files);
    });
    electron_1.ipcMain.handle('projectSettings:export', async (_, args) => {
        return projectSettingsManager.export(args.projectId);
    });
    electron_1.ipcMain.handle('projectSettings:reload', async (_, args) => {
        return projectSettingsManager.reload(args.projectId);
    });
    electron_1.ipcMain.handle('projectSettings:set-secret', async (_, args) => {
        return projectSettingsManager.setSecret(args.projectId, args.ref, args.plaintext);
    });
    electron_1.ipcMain.handle('projectSettings:reveal', async (_, args) => {
        if (!LicenseService_1.licenseService.getLicenseInfo().isLicensed)
            throw new Error('PRO_REQUIRED');
        const project = storeManager.getProjects().find((p) => p.id === args.projectId);
        if (!project)
            return;
        electron_1.shell.showItemInFolder((0, files_1.settingsDir)(project.rootPath));
    });
    electron_1.ipcMain.handle('store:delete-project', async (_, args) => {
        const { id } = args;
        storeManager.deleteProject(id);
    });
    electron_1.ipcMain.handle('store:set-project-order', async (_, order) => {
        storeManager.setProjectOrder(order);
    });
    electron_1.ipcMain.handle('store:get-project-groups', async () => {
        return storeManager.getProjectGroups();
    });
    electron_1.ipcMain.handle('store:save-project-group', async (_, group) => {
        storeManager.saveProjectGroup(group);
        onProjectGroupMutated?.(group.id);
    });
    electron_1.ipcMain.handle('store:delete-project-group', async (_, args) => {
        const { id } = args;
        storeManager.deleteProjectGroup(id);
        onProjectGroupMutated?.(id);
    });
    electron_1.ipcMain.handle('store:set-project-group-order', async (_, order) => {
        storeManager.setProjectGroupOrder(order);
    });
    electron_1.ipcMain.handle('store:get-project-root-order', async () => {
        return storeManager.getProjectRootOrder();
    });
    electron_1.ipcMain.handle('store:set-project-root-order', async (_, order) => {
        storeManager.setProjectRootOrder(order);
    });
    electron_1.ipcMain.handle('db:get-global-connections', async () => {
        return storeManager.getGlobalDatabaseConnections();
    });
    electron_1.ipcMain.handle('db:set-global-connections', async (_, args) => {
        const { connections } = args;
        storeManager.setGlobalDatabaseConnections(connections);
    });
    electron_1.ipcMain.handle('http:get-global-tabs', async () => {
        return storeManager.getGlobalHttpTabs();
    });
    electron_1.ipcMain.handle('http:set-global-tabs', async (_, args) => {
        const { tabs } = args;
        storeManager.setGlobalHttpTabs(tabs);
    });
    electron_1.ipcMain.handle('store:get-preferences', async () => {
        return storeManager.getPreferences();
    });
    electron_1.ipcMain.handle('store:set-preferences', async (_, prefs) => {
        storeManager.setPreferences(prefs);
        onPreferencesChanged?.(storeManager.getPreferences());
        // Re-apply update prefs (autoInstallOnQuit) so a Settings change takes
        // effect without a restart. No-op in dev (updater never set up).
        (0, updater_1.applyUpdaterPreferences)();
    });
    electron_1.ipcMain.handle('store:update-preference', async (_, path, value) => {
        storeManager.updatePreference(path, value);
        onPreferencesChanged?.(storeManager.getPreferences());
    });
    electron_1.ipcMain.handle('app-config:export', async () => {
        try {
            const { dialog } = await Promise.resolve().then(() => __importStar(require('electron')));
            const { writeFile } = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const payload = await appConfigTransferService.exportToJson();
            const dateStamp = new Date().toISOString().slice(0, 10);
            const result = await dialog.showSaveDialog(getMainWindow(), {
                title: 'Export App Configuration',
                defaultPath: `1devtool-config-${dateStamp}.json`,
                filters: [{ name: '1DevTool Config', extensions: ['json'] }],
            });
            if (result.canceled || !result.filePath) {
                return { ok: false, canceled: true };
            }
            await writeFile(result.filePath, payload, 'utf8');
            return { ok: true, path: result.filePath };
        }
        catch (error) {
            console.error('[app-config] export failed', error);
            return {
                ok: false,
                error: error instanceof Error ? error.message : 'Failed to export app configuration.',
            };
        }
    });
    electron_1.ipcMain.handle('app-config:select-import-file', async () => {
        const { dialog } = await Promise.resolve().then(() => __importStar(require('electron')));
        const result = await dialog.showOpenDialog(getMainWindow(), {
            title: 'Import App Configuration',
            filters: [{ name: '1DevTool Config', extensions: ['json'] }],
            properties: ['openFile'],
        });
        return result.canceled ? null : result.filePaths[0] ?? null;
    });
    electron_1.ipcMain.handle('app-config:preview-import', async (_, args) => {
        return appConfigTransferService.previewImport(args.filePath);
    });
    electron_1.ipcMain.handle('app-config:apply-import', async (_, args) => {
        try {
            const result = await appConfigTransferService.applyImport(args);
            if (result.ok) {
                onAppConfigImported?.();
                onPreferencesChanged?.(storeManager.getPreferences());
            }
            return result;
        }
        catch (error) {
            console.error('[app-config] import failed', error);
            return {
                ok: false,
                importedProjects: 0,
                skippedProjects: 0,
                error: error instanceof Error ? error.message : 'Failed to import app configuration.',
            };
        }
    });
    // Theme management
    electron_1.ipcMain.handle('theme:get-custom-themes', async () => {
        return storeManager.getCustomThemes();
    });
    electron_1.ipcMain.handle('theme:save-custom-theme', async (_, theme) => {
        storeManager.saveCustomTheme(theme);
    });
    electron_1.ipcMain.handle('theme:delete-custom-theme', async (_, id) => {
        storeManager.deleteCustomTheme(id);
    });
    electron_1.ipcMain.handle('theme:import-vscode-file', async () => {
        const { dialog } = await Promise.resolve().then(() => __importStar(require('electron')));
        const result = await dialog.showOpenDialog({
            title: 'Import VS Code Theme',
            filters: [{ name: 'JSON Files', extensions: ['json'] }],
            properties: ['openFile'],
        });
        if (result.canceled || !result.filePaths.length)
            return null;
        const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
        const content = await fs.readFile(result.filePaths[0], 'utf-8');
        const path = await Promise.resolve().then(() => __importStar(require('path')));
        return { name: path.basename(result.filePaths[0], '.json'), content };
    });
}
