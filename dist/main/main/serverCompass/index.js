"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ServerCompassBundleService = void 0;
exports.createServerCompassService = createServerCompassService;
exports.registerServerCompassIpcHandlers = registerServerCompassIpcHandlers;
exports.getServerCompassService = getServerCompassService;
const electron_1 = require("electron");
const bundleService_1 = require("./bundleService");
var bundleService_2 = require("./bundleService");
Object.defineProperty(exports, "ServerCompassBundleService", { enumerable: true, get: function () { return bundleService_2.ServerCompassBundleService; } });
let service = null;
function createServerCompassService(projectStore) {
    service = new bundleService_1.ServerCompassBundleService(projectStore);
    // Fire-and-forget cleanup of stale bundles on app start.
    void service.cleanupOldBundles();
    return service;
}
function registerServerCompassIpcHandlers(svc) {
    electron_1.ipcMain.handle('serverCompass:detectAssets', (_e, args) => svc.detectAssets(args.projectId));
    electron_1.ipcMain.handle('serverCompass:validateLocal', (_e, args) => svc.validateLocally(args.projectId));
    electron_1.ipcMain.handle('serverCompass:createBundle', (_e, args) => svc.createBundle({
        projectId: args.projectId,
        validation: args.validation ?? null,
        metadata: args.metadata,
        buildHint: args.buildHint,
        preferredSource: args.preferredSource,
    }));
    electron_1.ipcMain.handle('serverCompass:openInServerCompass', (_e, args) => svc.openInServerCompass(args));
}
function getServerCompassService() {
    return service;
}
