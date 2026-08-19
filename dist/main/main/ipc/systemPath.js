"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSystemPathIpcHandlers = registerSystemPathIpcHandlers;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const env_1 = require("../utils/env");
function registerSystemPathIpcHandlers(cliRegistry) {
    // System / PATH handlers
    electron_1.ipcMain.handle('system:get-resolved-path', async () => {
        const raw = (0, env_1.getEnrichedPath)();
        const entries = raw.split(path_1.default.delimiter).filter(s => s.length > 0);
        const checks = await Promise.all(entries.map(async (entry) => {
            try {
                const stat = await fs_1.default.promises.stat(entry);
                return { path: entry, exists: stat.isDirectory() };
            }
            catch {
                return { path: entry, exists: false };
            }
        }));
        return { raw, entries: checks };
    });
    electron_1.ipcMain.handle('system:find-in-path', async (_, args) => {
        const query = (args?.query ?? '').trim().toLowerCase();
        if (!query)
            return [];
        const raw = (0, env_1.getEnrichedPath)();
        const entries = Array.from(new Set(raw.split(path_1.default.delimiter).filter(s => s.length > 0)));
        // Scan each dir for filenames containing `query` (case-insensitive). Cap
        // matches per dir to keep payload small and the UI readable.
        const PER_DIR_MATCH_CAP = 8;
        const results = await Promise.all(entries.map(async (dir) => {
            try {
                const items = await fs_1.default.promises.readdir(dir);
                const matches = [];
                for (const item of items) {
                    if (item.toLowerCase().includes(query)) {
                        matches.push(item);
                        if (matches.length >= PER_DIR_MATCH_CAP)
                            break;
                    }
                }
                return matches.length > 0 ? { path: dir, matches } : null;
            }
            catch {
                return null;
            }
        }));
        return results.filter((r) => r !== null);
    });
    // CLI Registry handlers — see docs/features/channels/cli-subprocess.md §3.6.
    electron_1.ipcMain.handle('cli-registry:list', () => {
        if (!cliRegistry)
            return { registrations: [], knownClis: [], slowPaths: [] };
        return {
            registrations: cliRegistry.list(),
            knownClis: cliRegistry.knownClis(),
            slowPaths: cliRegistry.slowPaths(),
        };
    });
    electron_1.ipcMain.handle('cli-registry:rescan', async (_, args = {}) => {
        if (!cliRegistry)
            return { ok: false, error: 'registry-not-ready' };
        try {
            await cliRegistry.rescan(args);
            return { ok: true };
        }
        catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    });
    electron_1.ipcMain.handle('cli-registry:cancel-scan', async () => {
        cliRegistry?.cancelScan();
        return { ok: true };
    });
    electron_1.ipcMain.handle('cli-registry:set-override', async (_, args) => {
        if (!cliRegistry)
            return { ok: false, error: 'registry-not-ready' };
        await cliRegistry.setOverride(args.id, args.path);
        return { ok: true };
    });
    electron_1.ipcMain.handle('cli-registry:add-custom', async (_, args) => {
        if (!cliRegistry)
            return { ok: false, error: 'registry-not-ready' };
        await cliRegistry.addCustom(args);
        return { ok: true };
    });
    electron_1.ipcMain.handle('cli-registry:remove-custom', async (_, args) => {
        if (!cliRegistry)
            return { ok: false, error: 'registry-not-ready' };
        await cliRegistry.removeCustom(args.id);
        return { ok: true };
    });
    electron_1.ipcMain.handle('cli-registry:get-binary', async (_, args) => {
        if (!cliRegistry)
            return { ok: false, reason: 'not-found' };
        return cliRegistry.getCliBinary(args.id);
    });
    electron_1.ipcMain.handle('cli-registry:clear-slow-paths', async (_, args = {}) => {
        cliRegistry?.clearSlowPathStrikes(args.entry);
        return { ok: true };
    });
}
