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
exports.registerDataToolsIpcHandlers = registerDataToolsIpcHandlers;
const electron_1 = require("electron");
const windowAssets_1 = require("../windowAssets");
let cronWindow = null;
function registerDataToolsIpcHandlers({ httpClient, databaseManager, portManager, cronManager, storeManager, getMainWindow, sendToRenderer, isDev, devServerUrl, }) {
    // HTTP handlers
    electron_1.ipcMain.handle('http:request', async (_, args) => {
        return httpClient.request(args);
    });
    electron_1.ipcMain.handle('http:import-collection', async (_, args) => {
        try {
            const { dialog } = await Promise.resolve().then(() => __importStar(require('electron')));
            const { importCollection } = await Promise.resolve().then(() => __importStar(require('../httpImport')));
            let targetPath = args.path;
            if (!targetPath) {
                const envKey = `E2E_HTTP_IMPORT_${args.format.toUpperCase()}`;
                const envPath = process.env[envKey];
                if (process.env.NODE_ENV === 'test' && envPath) {
                    targetPath = envPath;
                }
                else {
                    const isBruno = args.format === 'bruno';
                    const result = await dialog.showOpenDialog(getMainWindow(), {
                        title: isBruno ? 'Import Bruno Collection Folder' : `Import ${args.format === 'postman' ? 'Postman' : 'Insomnia'} Collection`,
                        properties: isBruno ? ['openDirectory'] : ['openFile'],
                        filters: isBruno ? undefined : [{ name: 'Collection Files', extensions: ['json', 'yaml', 'yml'] }],
                    });
                    if (result.canceled || !result.filePaths.length)
                        return { ok: false, canceled: true };
                    targetPath = result.filePaths[0];
                }
            }
            const collection = await importCollection(args.format, targetPath);
            return { ok: true, collection };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle('http:detect-import-file', async (_, args) => {
        try {
            const { detectHttpImportFile } = await Promise.resolve().then(() => __importStar(require('../httpImport')));
            const result = await detectHttpImportFile(args.path);
            if (!result)
                return { ok: false };
            return { ok: true, format: result.format, sourcePath: result.sourcePath };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle('http:import-file', async (_, args) => {
        try {
            const { importHttpFile } = await Promise.resolve().then(() => __importStar(require('../httpImport')));
            const result = await importHttpFile(args.path);
            return { ok: true, ...result };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle('http:export-collection', async (_, args) => {
        try {
            const { dialog } = await Promise.resolve().then(() => __importStar(require('electron')));
            const pathMod = await Promise.resolve().then(() => __importStar(require('path')));
            const { exportCollection } = await Promise.resolve().then(() => __importStar(require('../httpExport')));
            const safeName = args.collectionName.replace(/[/\\:*?"<>|]/g, '_').trim() || 'Collection';
            let targetPath = args.path;
            if (!targetPath) {
                const envKey = `E2E_HTTP_EXPORT_${args.format.toUpperCase()}`;
                const envPath = process.env[envKey];
                if (process.env.NODE_ENV === 'test' && envPath) {
                    targetPath = envPath;
                }
                else if (args.format === 'bruno') {
                    const result = await dialog.showOpenDialog(getMainWindow(), {
                        title: 'Choose folder to save Bruno collection into',
                        properties: ['openDirectory', 'createDirectory'],
                    });
                    if (result.canceled || !result.filePaths.length)
                        return { ok: false, canceled: true };
                    targetPath = pathMod.join(result.filePaths[0], safeName);
                }
                else {
                    const ext = args.format === 'postman' ? '.postman_collection.json' : '.insomnia_v4.json';
                    const result = await dialog.showSaveDialog(getMainWindow(), {
                        title: `Save ${args.format === 'postman' ? 'Postman' : 'Insomnia'} Collection`,
                        defaultPath: `${safeName}${ext}`,
                        filters: [{ name: 'JSON Files', extensions: ['json'] }],
                    });
                    if (result.canceled || !result.filePath)
                        return { ok: false, canceled: true };
                    targetPath = result.filePath;
                }
            }
            await exportCollection(args.format, targetPath, args.tabs, args.collectionName);
            return { ok: true, path: targetPath };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle('db:test-connection', async (_, args) => {
        try {
            await databaseManager.testConnection(args.connection);
            return { ok: true };
        }
        catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : 'Failed to connect to database',
            };
        }
    });
    electron_1.ipcMain.handle('db:query', async (_, args) => {
        try {
            const results = await databaseManager.query(args.connection, args.sql);
            return { ok: true, results };
        }
        catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : 'Failed to execute query',
            };
        }
    });
    electron_1.ipcMain.handle('db:schema', async (_, args) => {
        try {
            const tables = await databaseManager.schema(args.connection);
            return { ok: true, tables };
        }
        catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : 'Failed to load database schema',
            };
        }
    });
    electron_1.ipcMain.handle('db:preview-table', async (_, args) => {
        try {
            const result = await databaseManager.previewTable(args.connection, args.schema, args.table, args.options ?? args.filter, args.limit);
            return { ok: true, result };
        }
        catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : 'Failed to preview table',
            };
        }
    });
    electron_1.ipcMain.handle('db:update-row', async (_, args) => {
        try {
            await databaseManager.updateRow(args.connection, args.schema, args.table, args.nextRow, args.originalRow, args.primaryKeys);
            return { ok: true };
        }
        catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : 'Failed to update row',
            };
        }
    });
    // Database export/import handlers
    electron_1.ipcMain.handle('db:export', async (_, args) => {
        try {
            const { exportTableData } = await Promise.resolve().then(() => __importStar(require('../database/export')));
            const data = await exportTableData(databaseManager, {
                connection: args.connection,
                schema: args.schema,
                table: args.table,
                format: args.format,
                limit: args.limit,
                onProgress: (pct) => sendToRenderer('db:export-progress', { pct }),
            });
            return { ok: true, data };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Export failed' };
        }
    });
    electron_1.ipcMain.handle('db:import', async (_, args) => {
        try {
            const { importTableData } = await Promise.resolve().then(() => __importStar(require('../database/import')));
            const result = await importTableData(databaseManager, {
                connection: args.connection,
                schema: args.schema,
                table: args.table,
                data: args.data,
                format: args.format,
                onProgress: (pct) => sendToRenderer('db:import-progress', { pct }),
            });
            return { ok: true, rowsImported: result.rowsImported };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Import failed' };
        }
    });
    // Port manager handlers
    electron_1.ipcMain.handle('ports:list', async () => {
        return portManager.listPorts();
    });
    electron_1.ipcMain.handle('ports:kill', async (_, args) => {
        const { pid } = args;
        return portManager.killProcess(pid);
    });
    electron_1.ipcMain.handle('ports:detail', async (_, args) => {
        const { pid } = args;
        return portManager.getProcessDetail(pid);
    });
    // Cron job manager handlers
    electron_1.ipcMain.handle('cron:list', async () => {
        return cronManager.list();
    });
    electron_1.ipcMain.handle('cron:add', async (_, args) => {
        return cronManager.add(args.schedule, args.command);
    });
    electron_1.ipcMain.handle('cron:update', async (_, args) => {
        return cronManager.update(args.line, args.expectedRaw, args.schedule, args.command);
    });
    electron_1.ipcMain.handle('cron:remove', async (_, args) => {
        return cronManager.remove(args.line, args.expectedRaw);
    });
    electron_1.ipcMain.handle('cron:set-enabled', async (_, args) => {
        return cronManager.setEnabled(args.line, args.expectedRaw, args.enabled);
    });
    electron_1.ipcMain.handle('cron:logs', async () => {
        return cronManager.logs();
    });
    // Opens the cron manager as its own OS window so it can be dragged to
    // another monitor — an in-app modal can never leave the main window.
    electron_1.ipcMain.handle('cron:open-window', async () => {
        if (cronWindow && !cronWindow.isDestroyed()) {
            cronWindow.focus();
            return { ok: true };
        }
        const win = new electron_1.BrowserWindow({
            width: 900,
            height: 560,
            minWidth: 600,
            minHeight: 400,
            backgroundColor: '#080A0E',
            titleBarStyle: 'hiddenInset',
            trafficLightPosition: { x: 12, y: 12 },
            title: 'Cron Jobs',
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                webviewTag: false,
                preload: (0, windowAssets_1.getPreloadPath)(),
            },
        });
        if (isDev) {
            win.loadURL(`${devServerUrl}?cronWindow=1`);
        }
        else {
            win.loadFile((0, windowAssets_1.getRendererHtmlPath)(), {
                query: { cronWindow: '1' },
            });
        }
        cronWindow = win;
        win.on('closed', () => {
            cronWindow = null;
        });
        win.webContents.on('did-finish-load', () => {
            win.show();
            win.focus();
            const prefs = storeManager?.getPreferences();
            const uiScale = prefs?.appearance?.uiScale;
            if (uiScale && uiScale !== 1) {
                win.webContents.setZoomFactor(uiScale);
            }
        });
        return { ok: true };
    });
}
