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
exports.registerDockerIpcHandlers = registerDockerIpcHandlers;
const electron_1 = require("electron");
const docker = __importStar(require("../docker"));
function registerDockerIpcHandlers() {
    // Docker handlers
    electron_1.ipcMain.handle('docker:available', async () => {
        return docker.isDockerAvailable();
    });
    electron_1.ipcMain.handle('docker:containers', async () => {
        return docker.listContainers();
    });
    electron_1.ipcMain.handle('docker:images', async () => {
        return docker.listImages();
    });
    electron_1.ipcMain.handle('docker:start', async (_, args) => {
        return docker.startContainer(args.containerId);
    });
    electron_1.ipcMain.handle('docker:stop', async (_, args) => {
        return docker.stopContainer(args.containerId);
    });
    electron_1.ipcMain.handle('docker:restart', async (_, args) => {
        return docker.restartContainer(args.containerId);
    });
    electron_1.ipcMain.handle('docker:remove-container', async (_, args) => {
        return docker.removeContainer(args.containerId);
    });
    electron_1.ipcMain.handle('docker:remove-image', async (_, args) => {
        return docker.removeImage(args.imageId);
    });
    electron_1.ipcMain.handle('docker:inspect-container', async (_, args) => {
        return docker.inspectContainer(args.containerId);
    });
    electron_1.ipcMain.handle('docker:container-logs', async (_, args) => {
        return docker.getContainerLogs(args.containerId, args.tail);
    });
    electron_1.ipcMain.handle('docker:container-stats', async (_, args) => {
        return docker.getContainerStats(args.containerId);
    });
    electron_1.ipcMain.handle('docker:pause', async (_, args) => {
        return docker.pauseContainer(args.containerId);
    });
    electron_1.ipcMain.handle('docker:unpause', async (_, args) => {
        return docker.unpauseContainer(args.containerId);
    });
    electron_1.ipcMain.handle('docker:inspect-image', async (_, args) => {
        return docker.inspectImage(args.imageId);
    });
    electron_1.ipcMain.handle('docker:image-history', async (_, args) => {
        return docker.getImageHistory(args.imageId);
    });
    electron_1.ipcMain.handle('docker:image-containers', async (_, args) => {
        return docker.getContainersUsingImage(args.imageId);
    });
    electron_1.ipcMain.handle('docker:volumes', async () => {
        return docker.listVolumes();
    });
    electron_1.ipcMain.handle('docker:inspect-volume', async (_, args) => {
        return docker.inspectVolume(args.name);
    });
    electron_1.ipcMain.handle('docker:remove-volume', async (_, args) => {
        return docker.removeVolume(args.name);
    });
    electron_1.ipcMain.handle('docker:stream-logs-start', async (event, args) => {
        const { containerId } = args;
        docker.streamContainerLogs(containerId, (data) => {
            event.sender.send('docker:log-data', { containerId, data });
        }, (error) => {
            event.sender.send('docker:log-data', { containerId, data: `[Error] ${error}\n` });
        });
        return { ok: true };
    });
    electron_1.ipcMain.handle('docker:stream-logs-stop', async (_, args) => {
        docker.stopLogStream(args.containerId);
        return { ok: true };
    });
}
