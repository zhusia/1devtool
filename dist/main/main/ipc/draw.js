"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerDrawIpcHandlers = registerDrawIpcHandlers;
const electron_1 = require("electron");
const drawGeneration_1 = require("../drawGeneration");
function registerDrawIpcHandlers({ getCliRegistry }) {
    // Generate a mermaid/skeleton diagram from a prompt via an installed
    // headless AI CLI. Returns a structured { ok } result — errors never
    // surface as thrown IPC failures. The renderer converts the source into
    // editable Excalidraw elements (conversion needs the DOM).
    electron_1.ipcMain.handle('draw:generate-diagram', async (_, args) => {
        const { prompt, projectPath, settings, retry, variant, topology } = args;
        return (0, drawGeneration_1.generateDrawDiagram)({ getCliRegistry }, { prompt, projectPath, settings, retry, variant, topology });
    });
    electron_1.ipcMain.handle('draw:cancel-diagram', async () => {
        (0, drawGeneration_1.cancelDrawDiagram)();
    });
}
