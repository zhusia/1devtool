"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerWorkspaceIpcHandlers = registerWorkspaceIpcHandlers;
const electron_1 = require("electron");
const rendererGuards_1 = require("./rendererGuards");
function registerWorkspaceIpcHandlers({ workspaceService, getMainWindow, }) {
    const { isMainRenderer } = (0, rendererGuards_1.createRendererGuards)(getMainWindow);
    const guarded = (handler) => async (event, args) => {
        if (!isMainRenderer(event))
            throw new Error('WORKSPACE_FORBIDDEN: main renderer only');
        return handler(args);
    };
    electron_1.ipcMain.handle('workspace:list', guarded((args) => workspaceService.list(args?.includeArchived === true)));
    electron_1.ipcMain.handle('workspace:get', guarded((args) => workspaceService.get(args.id) ?? null));
    electron_1.ipcMain.handle('workspace:resolve', guarded((args) => workspaceService.resolve(args.id, args.purpose ?? 'display')));
    electron_1.ipcMain.handle('workspace:create', guarded((input) => workspaceService.create(input)));
    electron_1.ipcMain.handle('workspace:update', guarded((args) => workspaceService.update(args.id, args.patch)));
    electron_1.ipcMain.handle('workspace:delete', guarded((args) => {
        workspaceService.delete(args.id);
        return { ok: true };
    }));
    electron_1.ipcMain.handle('workspace:set-order', guarded((args) => {
        workspaceService.setOrder(args.order);
        return { ok: true };
    }));
    electron_1.ipcMain.handle('workspace:set-project-preference', guarded((args) => {
        workspaceService.setProjectPreference(args.projectId, args.workspaceId);
        return { ok: true };
    }));
    electron_1.ipcMain.handle('workspace:get-project-preference', guarded(() => workspaceService.getProjectPreference()));
    electron_1.ipcMain.handle('workspace:for-project', guarded((args) => workspaceService.forProject(args.projectId)));
}
