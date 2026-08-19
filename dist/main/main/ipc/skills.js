"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSkillsIpcHandlers = registerSkillsIpcHandlers;
const electron_1 = require("electron");
function registerSkillsIpcHandlers(skillsManager) {
    // Skills manager handlers
    electron_1.ipcMain.handle('skills:scan-all', async (_, args) => {
        return skillsManager.scanAll(args?.projectPath);
    });
    electron_1.ipcMain.handle('skills:scan-global', async () => {
        return skillsManager.scanGlobal();
    });
    electron_1.ipcMain.handle('skills:scan-project', async (_, args) => {
        return skillsManager.scanProject(args.projectPath);
    });
    electron_1.ipcMain.handle('skills:read', async (_, args) => {
        return skillsManager.readSkill(args.filePath);
    });
    electron_1.ipcMain.handle('skills:write', async (_, args) => {
        skillsManager.writeSkill(args.filePath, args.content);
    });
    electron_1.ipcMain.handle('skills:create', async (_, args) => {
        return skillsManager.createSkill(args.dir, args.name, args.tool, args.category);
    });
    electron_1.ipcMain.handle('skills:delete', async (_, args) => {
        return skillsManager.deleteSkill(args.filePath);
    });
    electron_1.ipcMain.handle('skills:install', async (_, args) => {
        return skillsManager.installSkill(args.projectPath, args.skill, args.tool);
    });
    // Control-plane store + per-project manifest
    electron_1.ipcMain.handle('skills:store-list', async () => {
        return skillsManager.storeList();
    });
    electron_1.ipcMain.handle('skills:store-add', async (_, args) => {
        return skillsManager.storeAdd(args.skill);
    });
    electron_1.ipcMain.handle('skills:store-remove', async (_, args) => {
        return skillsManager.storeRemove(args.name, args.version);
    });
    electron_1.ipcMain.handle('skills:store-read', async (_, args) => {
        return skillsManager.storeRead(args.name, args.version);
    });
    electron_1.ipcMain.handle('skills:manifest-get', async (_, args) => {
        return skillsManager.manifestGet(args.projectPath);
    });
    electron_1.ipcMain.handle('skills:manifest-set', async (_, args) => {
        skillsManager.manifestSet(args.projectPath, args.manifest);
    });
    electron_1.ipcMain.handle('skills:manifest-plan', async (_, args) => {
        return skillsManager.manifestPlan(args.projectPath);
    });
    electron_1.ipcMain.handle('skills:manifest-apply', async (_, args) => {
        return skillsManager.manifestApply(args.projectPath, args.options);
    });
}
