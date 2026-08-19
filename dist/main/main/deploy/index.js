"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeploySecretStore = exports.DeployStore = exports.DeployManager = void 0;
exports.createDeployManager = createDeployManager;
exports.registerDeployIpcHandlers = registerDeployIpcHandlers;
const electron_1 = require("electron");
const manager_1 = require("./manager");
const secretStore_1 = require("./secretStore");
const store_1 = require("./store");
var manager_2 = require("./manager");
Object.defineProperty(exports, "DeployManager", { enumerable: true, get: function () { return manager_2.DeployManager; } });
var store_2 = require("./store");
Object.defineProperty(exports, "DeployStore", { enumerable: true, get: function () { return store_2.DeployStore; } });
var secretStore_2 = require("./secretStore");
Object.defineProperty(exports, "DeploySecretStore", { enumerable: true, get: function () { return secretStore_2.DeploySecretStore; } });
function createDeployManager(projectStore, emitLog) {
    return new manager_1.DeployManager(new store_1.DeployStore(), new secretStore_1.DeploySecretStore(), projectStore, emitLog);
}
function registerDeployIpcHandlers(manager) {
    electron_1.ipcMain.handle('deploy:getConfig', async (_, args) => {
        return manager.getConfig(args.projectId);
    });
    electron_1.ipcMain.handle('deploy:list', async (_, args) => {
        return manager.list(args.projectId);
    });
    electron_1.ipcMain.handle('deploy:setConfig', async (_, args) => {
        return manager.setConfig(args.projectId, args.provider, args.config);
    });
    electron_1.ipcMain.handle('deploy:setToken', async (_, args) => {
        return manager.setToken(args.provider, args.token);
    });
    electron_1.ipcMain.handle('deploy:testToken', async (_, args) => {
        return manager.testToken(args);
    });
    electron_1.ipcMain.handle('deploy:verifyToken', async (_, args) => {
        return manager.testToken(args);
    });
    electron_1.ipcMain.handle('deploy:start', async (_, args) => {
        return manager.start(args);
    });
    electron_1.ipcMain.handle('deploy:cancel', async (_, args) => {
        return manager.cancel(args.deployId);
    });
    electron_1.ipcMain.handle('deploy:scan', async (_, args) => {
        return manager.scan(args.projectId);
    });
}
