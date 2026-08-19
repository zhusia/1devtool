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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendToPopoutWindows = sendToPopoutWindows;
exports.registerAppWindowsIpcHandlers = registerAppWindowsIpcHandlers;
/*
 * ⚠ Terminal minefield — read docs/common-errors/terminals/INDEX.md before editing.
 * Pop-out window creation owns free-floating lifecycle (no parent), ready-to-show
 * reveal, and pathToFileURL query loading (popout-blank-window.md / C15).
 */
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const AppQuitService_1 = require("../services/AppQuitService");
const windowAssets_1 = require("../windowAssets");
const popoutWindows = new Map();
const subAgentHistoryWindows = new Map();
/** Send PTY events to every detached terminal window. */
function sendToPopoutWindows(channel, payload) {
    for (const win of popoutWindows.values()) {
        if (!win.isDestroyed()) {
            try {
                if (payload === undefined) {
                    win.webContents.send(channel);
                }
                else {
                    win.webContents.send(channel, payload);
                }
            }
            catch {
                // Window may have been destroyed between check and send.
            }
        }
    }
}
function registerAppWindowsIpcHandlers({ getMainWindow, storeManager, sendToRenderer, isDev, devServerUrl, }) {
    electron_1.ipcMain.handle('app:get-homedir', () => {
        return os_1.default.homedir();
    });
    electron_1.ipcMain.handle('app:get-default-shell', () => {
        if (process.platform === 'win32') {
            return 'powershell.exe';
        }
        return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
    });
    electron_1.ipcMain.handle('app:open-external', async (_, args) => {
        const { url } = args;
        await electron_1.shell.openExternal(url);
    });
    electron_1.ipcMain.handle('app:open-path-external', async (_, args) => {
        const { path: filePath } = args;
        const { pathToFileURL } = await Promise.resolve().then(() => __importStar(require('url')));
        await electron_1.shell.openExternal(pathToFileURL(filePath).href);
    });
    // Look up a word/phrase in the native macOS Dictionary via the `dict://`
    // URL scheme (handled by Dictionary.app). No-op on other platforms, which
    // ship no equivalent system dictionary. Used only as the explicit
    // "Open in Dictionary" action — the default Look Up flow stays in-app.
    electron_1.ipcMain.handle('app:look-up-dictionary', async (_, args) => {
        if (process.platform !== 'darwin')
            return;
        const { text } = args;
        const term = (text || '').replace(/\s+/g, ' ').trim().slice(0, 100);
        if (!term)
            return;
        await electron_1.shell.openExternal('dict://' + encodeURIComponent(term));
    });
    // Fetch macOS system-dictionary definitions for a term so the renderer can
    // render an in-app Look Up popover instead of bouncing to Dictionary.app.
    // Enumerates every dictionary the user activated in Dictionary.app settings
    // (DCSGetActiveDictionaries/DCSDictionaryGetName are private CoreServices
    // APIs, hence the explicit JXA bindings) and returns one entry per
    // dictionary that knows the term, in the user's configured order. Falls back
    // to the default-dictionary lookup when the private APIs are unavailable.
    // The term is passed as argv — never interpolated into the script.
    electron_1.ipcMain.handle('app:dictionary-definition', async (_, args) => {
        if (process.platform !== 'darwin')
            return null;
        const { text } = args;
        const term = (text || '').replace(/\s+/g, ' ').trim().replace(/^-+/, '').slice(0, 100);
        if (!term)
            return null;
        const script = "ObjC.import('CoreServices');" +
            'function run(argv){' +
            'const t=$.NSString.alloc.initWithUTF8String(argv[0]);' +
            'const r=$.NSMakeRange(0,t.length);' +
            'const read=function(ref){if(!ref)return null;const o=ObjC.castRefToObject(ref);' +
            'return o&&!(o.isNil&&o.isNil())?o.js:null};' +
            'const out=[];' +
            'try{' +
            "ObjC.bindFunction('DCSGetActiveDictionaries',['id',[]]);" +
            "ObjC.bindFunction('DCSDictionaryGetName',['id',['id']]);" +
            'const dicts=$.DCSGetActiveDictionaries();' +
            'const n=dicts.count;' +
            'for(let i=0;i<n;i++){' +
            'const d=dicts.objectAtIndex(i);' +
            'let def=null;' +
            'try{def=read($.DCSCopyTextDefinition(d,t,r))}catch(e){def=null}' +
            'if(!def)continue;' +
            'let name=null;' +
            'try{const nm=$.DCSDictionaryGetName(d);' +
            'name=nm&&!(nm.isNil&&nm.isNil())?nm.js:null}catch(e){name=null}' +
            'out.push({name:name,definition:def});' +
            '}}catch(e){}' +
            'if(!out.length){' +
            'try{const def=read($.DCSCopyTextDefinition(null,t,r));' +
            'if(def)out.push({name:null,definition:def})}catch(e){}' +
            '}' +
            'return JSON.stringify(out)}';
        const { execFile } = await Promise.resolve().then(() => __importStar(require('child_process')));
        return await new Promise((resolve) => {
            execFile('osascript', ['-l', 'JavaScript', '-e', script, term], { timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
                if (error)
                    return resolve(null);
                try {
                    const entries = JSON.parse(String(stdout).trim());
                    if (!Array.isArray(entries))
                        return resolve(null);
                    const valid = entries.filter((e) => e && typeof e.definition === 'string' && e.definition.length > 0 &&
                        (e.name === null || typeof e.name === 'string'));
                    resolve(valid.length ? valid : null);
                }
                catch {
                    resolve(null);
                }
            });
        });
    });
    electron_1.ipcMain.handle('app:copy-text', async (_, args) => {
        const { text } = args;
        const { clipboard } = await Promise.resolve().then(() => __importStar(require('electron')));
        clipboard.writeText(text);
    });
    electron_1.ipcMain.handle('app:copy-image-from-data-url', async (_, args) => {
        const { dataUrl } = args;
        const { clipboard, nativeImage } = await Promise.resolve().then(() => __importStar(require('electron')));
        clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
    });
    electron_1.ipcMain.handle('app:paste', async () => {
        getMainWindow()?.webContents.paste();
    });
    electron_1.ipcMain.handle('app:save-image-from-data-url', async (_, args) => {
        const { dataUrl, projectId, suggestedName } = args;
        const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
        if (!match) {
            throw new Error('Invalid image data URL');
        }
        const [, mimeType, base64Payload] = match;
        const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
        const safeProjectId = String(projectId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
        const safeName = String(suggestedName || 'browser-screenshot').replace(/[^a-zA-Z0-9._-]/g, '-');
        const outputDir = path_1.default.join(electron_1.app.getPath('temp'), '1devtool-ai-images', safeProjectId);
        const outputPath = path_1.default.join(outputDir, `${Date.now()}-${safeName}.${extension}`);
        const { mkdir, writeFile } = await Promise.resolve().then(() => __importStar(require('fs/promises')));
        await mkdir(outputDir, { recursive: true });
        await writeFile(outputPath, Buffer.from(base64Payload, 'base64'));
        return outputPath;
    });
    electron_1.ipcMain.handle('app:export-save-dialog', async (_, args) => {
        const { dialog } = await Promise.resolve().then(() => __importStar(require('electron')));
        const { writeFile } = await Promise.resolve().then(() => __importStar(require('fs/promises')));
        const result = await dialog.showSaveDialog(getMainWindow(), {
            title: 'Export',
            defaultPath: args.defaultName,
            filters: args.filters,
        });
        if (result.canceled || !result.filePath)
            return { ok: false };
        const isBase64 = args.data.startsWith('data:');
        if (isBase64) {
            const base64 = args.data.replace(/^data:[^;]+;base64,/, '');
            await writeFile(result.filePath, Buffer.from(base64, 'base64'));
        }
        else {
            await writeFile(result.filePath, args.data, 'utf-8');
        }
        return { ok: true, path: result.filePath };
    });
    electron_1.ipcMain.handle('app:relaunch', async () => {
        (0, AppQuitService_1.requestAppRelaunch)();
        return { ok: true };
    });
    electron_1.ipcMain.handle('app:capture-screen', async () => {
        const { desktopCapturer } = await Promise.resolve().then(() => __importStar(require('electron')));
        try {
            const sources = await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: { width: 3840, height: 2160 }, // 4K max
            });
            if (sources.length > 0) {
                // Return the first screen's thumbnail as a data URL
                return sources[0].thumbnail.toDataURL();
            }
            return null;
        }
        catch (error) {
            console.error('Failed to capture screen:', error);
            return null;
        }
    });
    electron_1.ipcMain.handle('app:capture-page', async () => {
        try {
            const image = await getMainWindow()?.webContents.capturePage();
            return image ? image.toDataURL() : null;
        }
        catch {
            return null;
        }
    });
    electron_1.ipcMain.handle('app:set-full-screen', async (_, args) => {
        const { isFullScreen } = args;
        getMainWindow()?.setFullScreen(Boolean(isFullScreen));
    });
    electron_1.ipcMain.handle('app:set-window-buttons-visibility', async (_, args) => {
        const { visible } = args;
        const mainWindow = getMainWindow();
        if (process.platform === 'darwin' && mainWindow) {
            mainWindow.setWindowButtonVisibility(Boolean(visible));
        }
    });
    electron_1.ipcMain.handle('app:get-theme', () => {
        return electron_1.nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    });
    electron_1.ipcMain.handle('app:set-ui-scale', (_, args) => {
        const { scale } = args;
        getMainWindow()?.webContents.setZoomFactor(scale);
        sendToRenderer('app:ui-scale-changed', { scale });
    });
    // Pop-out terminal window management
    electron_1.ipcMain.handle('app:popout-terminal', async (_, args) => {
        const { terminalId, projectId } = args;
        // If already popped out, focus the existing window
        const existing = popoutWindows.get(terminalId);
        if (existing && !existing.isDestroyed()) {
            existing.focus();
            return { ok: true };
        }
        // Free-floating (no `parent`): child windows on Windows have intermittent
        // blank/black paint failures and cannot freely move to another monitor —
        // which is the whole point of pop-out. macOS traffic lights still need
        // hiddenInset chrome; Windows/Linux get a normal frame + hidden menu bar.
        const popout = new electron_1.BrowserWindow({
            width: 800,
            height: 600,
            minWidth: 400,
            minHeight: 300,
            backgroundColor: '#080A0E',
            show: false,
            title: '1DevTool Terminal',
            titleBarStyle: 'hiddenInset',
            trafficLightPosition: { x: 12, y: 12 },
            autoHideMenuBar: true,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                webviewTag: false,
                preload: (0, windowAssets_1.getPreloadPath)(),
            },
        });
        // Build the query string once and load via URL so Windows production
        // reliably sees `?popout=&projectId=` on `window.location.search`.
        // `loadFile({ query })` has been flaky for child windows on some Electron
        // builds; pathToFileURL matches the main-window asset base.
        const query = `?popout=${encodeURIComponent(terminalId)}&projectId=${encodeURIComponent(projectId)}`;
        if (isDev) {
            void popout.loadURL(`${devServerUrl}${query}`);
        }
        else {
            const { pathToFileURL } = await Promise.resolve().then(() => __importStar(require('url')));
            void popout.loadURL(`${pathToFileURL((0, windowAssets_1.getRendererHtmlPath)()).href}${query}`);
        }
        popoutWindows.set(terminalId, popout);
        popout.on('closed', () => {
            popoutWindows.delete(terminalId);
            sendToRenderer('app:popout-closed', { terminalId });
        });
        const reveal = () => {
            if (popout.isDestroyed())
                return;
            const prefs = storeManager?.getPreferences();
            const uiScale = prefs?.appearance?.uiScale;
            if (uiScale && uiScale !== 1) {
                popout.webContents.setZoomFactor(uiScale);
            }
            if (!popout.isVisible()) {
                popout.show();
                popout.focus();
            }
        };
        // ready-to-show fires after the first paint — avoids a black flash and
        // Windows cases where show() before layout left a blank client area.
        popout.once('ready-to-show', reveal);
        // Fallback if ready-to-show is skipped (some GPU paths never emit it).
        popout.webContents.on('did-finish-load', () => {
            // Give React one frame to mount before forcing visibility.
            setTimeout(reveal, 50);
        });
        popout.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
            console.error(`[popout] failed to load terminal window: ${errorCode} ${errorDescription}`);
            reveal();
        });
        return { ok: true };
    });
    electron_1.ipcMain.handle('app:anchor-terminal', async (_, args) => {
        const { terminalId } = args;
        const win = popoutWindows.get(terminalId);
        if (win && !win.isDestroyed()) {
            win.close();
        }
        popoutWindows.delete(terminalId);
        return { ok: true };
    });
    // ── Sub-agent history window ──────────────────────────────────────────────
    // Drives the SubAgentBadge click target in TerminalView: locate the most
    // recent session JSONL written by the spawned sub-CLI and open a read-only
    // viewer in a new BrowserWindow.
    electron_1.ipcMain.handle('sub-agent:find-recent-session', async (_, args) => {
        const { cli, cwd } = args;
        const { findRecentSession } = await Promise.resolve().then(() => __importStar(require('../subAgentHistory')));
        return findRecentSession(cli, cwd);
    });
    electron_1.ipcMain.handle('sub-agent:read-jsonl', async (_, args) => {
        const { path: jsonlPath, offset } = args;
        try {
            const fsp = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const stat = await fsp.stat(jsonlPath);
            const start = Math.max(0, offset ?? 0);
            if (start >= stat.size)
                return { ok: true, content: '', size: stat.size };
            const handle = await fsp.open(jsonlPath, 'r');
            try {
                // 4MB max per read — JSONL transcripts can be large but the viewer
                // streams in chunks via repeated reads with offset advancement.
                const chunk = Math.min(stat.size - start, 4 * 1024 * 1024);
                const buf = Buffer.alloc(chunk);
                await handle.read(buf, 0, chunk, start);
                return { ok: true, content: buf.toString('utf8'), size: stat.size };
            }
            finally {
                await handle.close();
            }
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    });
    electron_1.ipcMain.handle('sub-agent:open-history-window', async (_, args) => {
        const { cli, cwd, command } = args;
        const { findRecentSession } = await Promise.resolve().then(() => __importStar(require('../subAgentHistory')));
        const result = await findRecentSession(cli, cwd);
        if (!result.ok || !result.path) {
            return { ok: false, reason: result.reason ?? 'no-recent-session', error: result.error };
        }
        // Reuse-on-second-click: if a window for this file is already open, focus it.
        const existing = subAgentHistoryWindows.get(result.path);
        if (existing && !existing.isDestroyed()) {
            existing.focus();
            return { ok: true, path: result.path, reused: true };
        }
        const win = new electron_1.BrowserWindow({
            width: 960,
            height: 720,
            minWidth: 480,
            minHeight: 320,
            backgroundColor: '#080A0E',
            titleBarStyle: 'hiddenInset',
            trafficLightPosition: { x: 12, y: 12 },
            title: `${cli} session — ${path_1.default.basename(result.path)}`,
            parent: getMainWindow() ?? undefined,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                webviewTag: false,
                preload: (0, windowAssets_1.getPreloadPath)(),
            },
        });
        const format = result.format ?? 'jsonl';
        const query = `?subAgentHistory=${encodeURIComponent(result.path)}&cli=${encodeURIComponent(cli)}&format=${encodeURIComponent(format)}` +
            (command ? `&command=${encodeURIComponent(command)}` : '');
        if (isDev) {
            win.loadURL(`${devServerUrl}${query}`);
        }
        else {
            win.loadFile((0, windowAssets_1.getRendererHtmlPath)(), {
                query: { subAgentHistory: result.path, cli, format, ...(command ? { command } : {}) },
            });
        }
        subAgentHistoryWindows.set(result.path, win);
        win.on('closed', () => {
            subAgentHistoryWindows.delete(result.path);
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
        return { ok: true, path: result.path, reused: false };
    });
    // Listen for system theme changes and notify renderer
    electron_1.nativeTheme.on('updated', () => {
        const theme = electron_1.nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
        sendToRenderer('app:theme-changed', { theme });
    });
    // Dialog handlers
    electron_1.ipcMain.handle('dialog:select-folder', async () => {
        const { dialog } = await Promise.resolve().then(() => __importStar(require('electron')));
        const result = await dialog.showOpenDialog(getMainWindow(), {
            properties: ['openDirectory'],
        });
        return result.canceled ? null : result.filePaths[0];
    });
    electron_1.ipcMain.handle('dialog:select-files', async () => {
        const { dialog } = await Promise.resolve().then(() => __importStar(require('electron')));
        const result = await dialog.showOpenDialog(getMainWindow(), {
            properties: ['openFile', 'multiSelections'],
        });
        return result.canceled ? [] : result.filePaths;
    });
    electron_1.ipcMain.handle('dialog:select-database-file', async () => {
        const { dialog } = await Promise.resolve().then(() => __importStar(require('electron')));
        const result = await dialog.showOpenDialog(getMainWindow(), {
            title: 'Select SQLite Database',
            filters: [
                { name: 'SQLite Databases', extensions: ['sqlite', 'sqlite3', 'db'] },
                { name: 'All Files', extensions: ['*'] },
            ],
            properties: ['openFile'],
        });
        return result.canceled ? null : result.filePaths[0] ?? null;
    });
    electron_1.ipcMain.handle('dialog:select-image', async () => {
        const { dialog } = await Promise.resolve().then(() => __importStar(require('electron')));
        const fs = await Promise.resolve().then(() => __importStar(require('fs')));
        const path = await Promise.resolve().then(() => __importStar(require('path')));
        const mime = {
            '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
        };
        const result = await dialog.showOpenDialog(getMainWindow(), {
            title: 'Select Project Avatar',
            filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'] }],
            properties: ['openFile'],
        });
        if (result.canceled || result.filePaths.length === 0)
            return null;
        const src = result.filePaths[0];
        const ext = path.extname(src).toLowerCase();
        const mimeType = mime[ext] || 'image/png';
        if (ext === '.svg') {
            const svgContent = fs.readFileSync(src, 'utf-8');
            return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgContent)}`;
        }
        const buf = fs.readFileSync(src);
        return `data:${mimeType};base64,${buf.toString('base64')}`;
    });
    electron_1.ipcMain.handle('dialog:import-font', async () => {
        const { dialog, app } = await Promise.resolve().then(() => __importStar(require('electron')));
        const fs = await Promise.resolve().then(() => __importStar(require('fs')));
        const path = await Promise.resolve().then(() => __importStar(require('path')));
        const result = await dialog.showOpenDialog(getMainWindow(), {
            title: 'Import Font',
            filters: [{ name: 'Font Files', extensions: ['ttf', 'otf', 'woff2', 'woff'] }],
            properties: ['openFile', 'multiSelections'],
        });
        if (result.canceled || result.filePaths.length === 0)
            return [];
        const fontsDir = path.join(app.getPath('userData'), 'fonts');
        if (!fs.existsSync(fontsDir))
            fs.mkdirSync(fontsDir, { recursive: true });
        const imported = [];
        for (const filePath of result.filePaths) {
            const fileName = path.basename(filePath);
            const fontName = path.parse(fileName).name.replace(/[-_]/g, ' ');
            const dest = path.join(fontsDir, fileName);
            fs.copyFileSync(filePath, dest);
            imported.push({ name: fontName, path: dest });
        }
        return imported;
    });
    electron_1.ipcMain.handle('dialog:read-font-file', async (_, fontPath) => {
        const fs = await Promise.resolve().then(() => __importStar(require('fs')));
        if (!fs.existsSync(fontPath))
            return null;
        const buffer = fs.readFileSync(fontPath);
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    });
    electron_1.ipcMain.handle('dialog:delete-font', async (_, fontPath) => {
        const fs = await Promise.resolve().then(() => __importStar(require('fs')));
        if (fs.existsSync(fontPath))
            fs.unlinkSync(fontPath);
    });
}
