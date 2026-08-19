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
exports.registerFileSystemIpcHandlers = registerFileSystemIpcHandlers;
const electron_1 = require("electron");
function registerFileSystemIpcHandlers({ fsManager, rustServiceBridge, rustSidecarManager, aiDiffManager, projectSettingsManager, getMainWindow, sendToRenderer, }) {
    // File system handlers
    electron_1.ipcMain.handle('fs:readdir', async (_, args) => {
        const { path: dirPath, respectGitignore, showHidden } = args;
        return rustServiceBridge.readDirectory(dirPath, respectGitignore, showHidden);
    });
    electron_1.ipcMain.handle('fs:list-files', async (_, args) => {
        const { path: dirPath, respectGitignore, showHidden, limit } = args;
        return rustServiceBridge.listFiles(dirPath, respectGitignore, showHidden, limit);
    });
    electron_1.ipcMain.handle('fs:search-paths', async (_, args) => {
        const { path: dirPath, query, respectGitignore, showHidden, limit } = args;
        return rustServiceBridge.searchPaths(dirPath, query, respectGitignore, showHidden, limit);
    });
    electron_1.ipcMain.handle('fs:search-content', async (_, args) => {
        const { path: dirPath, query, respectGitignore, showHidden, limit } = args;
        return rustServiceBridge.searchContent(dirPath, query, respectGitignore, showHidden, limit);
    });
    electron_1.ipcMain.handle('fs:search-workspace', async (event, request) => {
        return fsManager.searchWorkspace({
            ...request,
            scopeId: `${event.sender.id}:${request.scopeId}`,
        });
    });
    electron_1.ipcMain.handle('fs:cancel-workspace-search', (event, args) => {
        fsManager.cancelWorkspaceSearch(`${event.sender.id}:${args.scopeId}`, args.requestId);
    });
    electron_1.ipcMain.handle('rust:get-diagnostics', () => {
        return rustServiceBridge?.getDiagnostics() ?? {
            sidecar: rustSidecarManager?.getDiagnostics() ?? null,
        };
    });
    const forwardFsEvent = (event, filePath) => {
        aiDiffManager?.handleFsEvent(event, filePath);
        projectSettingsManager?.handleFsEvent(event, filePath);
        sendToRenderer('fs:change', { type: event, path: filePath });
    };
    electron_1.ipcMain.handle('fs:watch', async (_, args) => {
        const { path: dirPath, profile } = args;
        await rustServiceBridge.watch(dirPath, forwardFsEvent, { profile });
    });
    electron_1.ipcMain.handle('fs:unwatch', async (_, args) => {
        const { path: dirPath, profile } = args;
        await rustServiceBridge.unwatch(dirPath, { profile });
    });
    electron_1.ipcMain.handle('fs:stat-files', async (_, args) => {
        return fsManager.statFiles(args.paths);
    });
    electron_1.ipcMain.handle('fs:read-file', async (_, args) => {
        const { path: filePath, maxBytes } = args;
        return fsManager.readFile(filePath, maxBytes);
    });
    electron_1.ipcMain.handle('fs:write-file', async (_, args) => {
        const { path: filePath, content } = args;
        return fsManager.writeFile(filePath, content);
    });
    electron_1.ipcMain.handle('fs:open-in-editor', async (_, args) => {
        const { path: filePath, editor } = args;
        return fsManager.openInEditor(filePath, editor);
    });
    electron_1.ipcMain.handle('fs:detect-editors', async () => {
        return [];
    });
    electron_1.ipcMain.handle('fs:get-editor-icon', async () => {
        return null;
    });
    electron_1.ipcMain.handle('fs:pick-editor-binary', async () => {
        const { dialog } = await Promise.resolve().then(() => __importStar(require('electron')));
        const filters = process.platform === 'win32'
            ? [{ name: 'Executables', extensions: ['exe', 'cmd', 'bat'] }]
            : [{ name: 'All Files', extensions: ['*'] }];
        const result = await dialog.showOpenDialog(getMainWindow(), {
            title: 'Choose Editor',
            properties: ['openFile'],
            filters,
        });
        if (result.canceled || !result.filePaths.length)
            return null;
        return result.filePaths[0];
    });
    electron_1.ipcMain.handle('fs:reveal-in-finder', async (_, args) => {
        const { path: filePath } = args;
        electron_1.shell.showItemInFolder(filePath);
    });
    electron_1.ipcMain.handle('fs:get-git-branch', async (_, args) => {
        const { path: dirPath } = args;
        return fsManager.getGitBranch(dirPath);
    });
    electron_1.ipcMain.handle('fs:copy-path', async (_, args) => {
        const { path: filePath } = args;
        const { clipboard } = await Promise.resolve().then(() => __importStar(require('electron')));
        clipboard.writeText(filePath);
    });
    electron_1.ipcMain.handle('fs:create-file', async (_, args) => {
        const { path: filePath } = args;
        fsManager.createFile(filePath);
    });
    electron_1.ipcMain.handle('fs:create-directory', async (_, args) => {
        const { path: dirPath } = args;
        fsManager.createDirectory(dirPath);
    });
    electron_1.ipcMain.handle('fs:delete', async (_, args) => {
        const { path: itemPath } = args;
        fsManager.deleteItem(itemPath);
    });
    electron_1.ipcMain.handle('fs:rename', async (_, args) => {
        const { oldPath, newPath } = args;
        fsManager.renameItem(oldPath, newPath);
    });
    electron_1.ipcMain.handle('fs:copy-item', async (_, args) => {
        const { srcPath, destPath } = args;
        fsManager.copyItem(srcPath, destPath);
    });
    electron_1.ipcMain.handle('fs:exists', async (_, args) => {
        const { path: itemPath } = args;
        return fsManager.exists(itemPath);
    });
}
