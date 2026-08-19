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
exports.registerDesignIpcHandlers = registerDesignIpcHandlers;
const electron_1 = require("electron");
const setup_1 = require("../mcp-servers/_shared/setup");
function registerDesignIpcHandlers({ getMcpBridgePort, getMainWindow, sendToRenderer, }) {
    // Design tool AI generation handlers
    electron_1.ipcMain.handle('design:generate', async (_, args) => {
        try {
            const { generateDesign } = await Promise.resolve().then(() => __importStar(require('../design')));
            const result = await generateDesign(args, (message) => {
                sendToRenderer('design:progress', { message });
            }, (component) => {
                // Stream each component to renderer in real-time
                sendToRenderer('design:stream-component', component);
            });
            return result;
        }
        catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : 'Design generation failed',
            };
        }
    });
    electron_1.ipcMain.on('design:cancel', () => {
        Promise.resolve().then(() => __importStar(require('../design'))).then(({ cancelDesignGeneration }) => {
            cancelDesignGeneration();
        });
    });
    electron_1.ipcMain.handle('design:get-mcp-config', async () => {
        return (0, setup_1.getMcpConfigJson)();
    });
    electron_1.ipcMain.handle('design:setup-mcp', async () => {
        return (0, setup_1.install)();
    });
    electron_1.ipcMain.handle('design:get-bridge-port', () => {
        return getMcpBridgePort();
    });
    // ── Prototype Tool ────────────────────────────────────────────────────
    electron_1.ipcMain.handle('prototype:generate', async (_, args) => {
        try {
            const { generatePrototype } = await Promise.resolve().then(() => __importStar(require('../prototype')));
            const result = await generatePrototype(args, (message) => {
                sendToRenderer('prototype:progress', { message });
            }, (spec) => {
                sendToRenderer('prototype:stream-spec', spec);
            });
            return result;
        }
        catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : 'Prototype generation failed',
            };
        }
    });
    electron_1.ipcMain.on('prototype:cancel', () => {
        Promise.resolve().then(() => __importStar(require('../prototype'))).then(({ cancelPrototypeGeneration }) => {
            cancelPrototypeGeneration();
        });
    });
    electron_1.ipcMain.handle('design:export-image', async (_, args) => {
        try {
            const { format, rect } = args;
            const { dialog } = await Promise.resolve().then(() => __importStar(require('electron')));
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const image = await getMainWindow()?.webContents.capturePage({
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
            });
            if (!image || image.isEmpty())
                return { ok: false, error: 'Failed to capture image' };
            const ext = format === 'jpeg' ? 'jpg' : format;
            const filters = format === 'png'
                ? [{ name: 'PNG Image', extensions: ['png'] }]
                : format === 'jpeg'
                    ? [{ name: 'JPEG Image', extensions: ['jpg', 'jpeg'] }]
                    : [{ name: 'SVG Image', extensions: ['svg'] }];
            const result = await dialog.showSaveDialog(getMainWindow(), {
                title: 'Export Design',
                defaultPath: `design-export.${ext}`,
                filters,
            });
            if (result.canceled || !result.filePath)
                return { ok: false, error: 'Cancelled' };
            let buffer;
            if (format === 'svg') {
                const pngBase64 = image.toPNG().toString('base64');
                const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(rect.width)}" height="${Math.round(rect.height)}">
  <image href="data:image/png;base64,${pngBase64}" width="${Math.round(rect.width)}" height="${Math.round(rect.height)}" />
</svg>`;
                buffer = Buffer.from(svgContent, 'utf-8');
            }
            else if (format === 'jpeg') {
                buffer = image.toJPEG(92);
            }
            else {
                buffer = image.toPNG();
            }
            await fs.writeFile(result.filePath, buffer);
            return { ok: true, path: result.filePath };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : 'Export failed' };
        }
    });
}
