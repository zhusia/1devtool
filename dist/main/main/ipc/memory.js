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
exports.registerMemoryIpcHandlers = registerMemoryIpcHandlers;
const electron_1 = require("electron");
function registerMemoryIpcHandlers({ memoryManager, storeManager, getMainWindow, }) {
    // Memory manager handlers
    electron_1.ipcMain.handle('memory:scan-projects', async () => {
        return memoryManager.scanProjects();
    });
    electron_1.ipcMain.handle('memory:scan-entries', async (_, args) => {
        return memoryManager.scanEntries(args || {});
    });
    electron_1.ipcMain.handle('memory:read-entry', async (_, args) => {
        return memoryManager.readEntry(args.filePath);
    });
    electron_1.ipcMain.handle('memory:delete-entry', async (_, args) => {
        return memoryManager.deleteEntry(args.filePath);
    });
    electron_1.ipcMain.handle('memory:clear-cache', async () => {
        memoryManager.clearCache();
    });
    electron_1.ipcMain.handle('memory:write-entry', async (_, args) => {
        return memoryManager.writeEntry(args.filePath, args.content);
    });
    electron_1.ipcMain.handle('memory:create-entry', async (_, args) => {
        return memoryManager.createEntry(args);
    });
    electron_1.ipcMain.handle('memory:copy-entry', async (_, args) => {
        return memoryManager.copyEntry(args);
    });
    electron_1.ipcMain.handle('memory:append-to-global', async (_, args) => {
        return memoryManager.appendToGlobalClaude(args);
    });
    electron_1.ipcMain.handle('memory:get-graph', async (_, args) => {
        return memoryManager.getGraph(args?.projectPath);
    });
    electron_1.ipcMain.handle('memory:get-obsidian-vault', async () => {
        return storeManager.getObsidianVaultPath();
    });
    electron_1.ipcMain.handle('memory:set-obsidian-vault', async (_, args) => {
        storeManager.setObsidianVaultPath(args?.path ?? null);
        return storeManager.getObsidianVaultPath();
    });
    electron_1.ipcMain.handle('memory:pick-obsidian-vault', async () => {
        const { dialog } = await Promise.resolve().then(() => __importStar(require('electron')));
        const result = await dialog.showOpenDialog(getMainWindow(), {
            title: 'Select Obsidian Vault Folder',
            properties: ['openDirectory'],
        });
        if (result.canceled || result.filePaths.length === 0)
            return null;
        const picked = result.filePaths[0];
        storeManager.setObsidianVaultPath(picked);
        return picked;
    });
    electron_1.ipcMain.handle('memory:open-in-obsidian', async (_, args) => {
        const filePath = args?.filePath;
        if (!filePath)
            return { ok: false, error: 'Missing filePath' };
        const vault = storeManager.getObsidianVaultPath();
        if (!vault)
            return { ok: false, error: 'Obsidian vault not set' };
        const path = await Promise.resolve().then(() => __importStar(require('path')));
        const vaultResolved = path.resolve(vault);
        const fileResolved = path.resolve(filePath);
        if (!fileResolved.startsWith(vaultResolved + path.sep)) {
            return {
                ok: false,
                error: 'File is not inside the configured Obsidian vault. Use "Export to Vault" first.',
            };
        }
        const vaultName = path.basename(vaultResolved);
        const relPath = path.relative(vaultResolved, fileResolved);
        const url = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(relPath)}`;
        await electron_1.shell.openExternal(url);
        return { ok: true, vaultName, relativePath: relPath };
    });
    electron_1.ipcMain.handle('memory:export-to-obsidian-vault', async (_, args) => {
        const projectPath = args?.projectPath;
        const vault = storeManager.getObsidianVaultPath();
        if (!vault)
            return { ok: false, error: 'Obsidian vault not set' };
        try {
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const path = await Promise.resolve().then(() => __importStar(require('path')));
            const projects = await memoryManager.scanProjects();
            const targets = projectPath
                ? projects.filter((p) => p.projectPath === projectPath)
                : projects;
            if (targets.length === 0)
                return { ok: false, error: 'No memory directories found to export' };
            const baseExportDir = path.join(vault, '1DevTool Memory');
            await fs.mkdir(baseExportDir, { recursive: true });
            let copiedFiles = 0;
            for (const proj of targets) {
                const sourceDir = memoryManager.getProjectMemoryDirectory(proj);
                if (!sourceDir)
                    continue;
                const projDir = path.join(baseExportDir, `${proj.agentType} - ${proj.projectName}`);
                await fs.mkdir(projDir, { recursive: true });
                const dirents = await fs.readdir(sourceDir, { withFileTypes: true });
                for (const d of dirents) {
                    if (!d.isFile() || !d.name.toLowerCase().endsWith('.md'))
                        continue;
                    const src = path.join(sourceDir, d.name);
                    const dst = path.join(projDir, d.name);
                    await fs.copyFile(src, dst);
                    copiedFiles++;
                }
            }
            return { ok: true, exportPath: baseExportDir, files: copiedFiles };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : 'Export failed' };
        }
    });
}
