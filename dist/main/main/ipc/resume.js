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
exports.registerResumeIpcHandlers = registerResumeIpcHandlers;
/**
 * Terminal session IPC hotspot. Read docs/common-errors/terminals/INDEX.md
 * before changing session detection, ownership, or native-resume behavior.
 */
const electron_1 = require("electron");
const contracts_1 = require("../../shared/terminal/contracts");
function registerResumeIpcHandlers({ resumeManager, ptyBackend, storeManager, }) {
    // Resume manager handlers
    electron_1.ipcMain.handle('resume:scan', async (_, args) => {
        return resumeManager.scanSessions(args);
    });
    electron_1.ipcMain.handle('resume:scan-recent', async (_, args) => {
        return resumeManager.getRecentSessions(args?.limit, {
            agentType: args?.agentType,
            projectPath: args?.projectPath,
        });
    });
    electron_1.ipcMain.handle('resume:get-detail', async (_, args) => {
        return resumeManager.getSessionDetail(args.agentType, args.sessionId);
    });
    electron_1.ipcMain.handle('resume:get-command', async (_, args) => {
        return resumeManager.getResumeCommand(args.agentType, args.sessionId);
    });
    electron_1.ipcMain.handle('resume:rename-terminal-session', async (_, args) => {
        if (typeof args?.terminalId !== 'string' || typeof args?.title !== 'string') {
            throw new Error('Invalid terminal session rename request.');
        }
        // A renderer may name only the session owned by this persisted terminal.
        // Never accept a caller-supplied session id or infer identity from the tab
        // title/transcript; both are display history, not ownership evidence.
        const location = storeManager.findTerminalLocation(args.terminalId);
        const terminal = location?.terminal;
        const agentType = terminal?.lastSessionAgentType
            ?? (terminal ? (0, contracts_1.mapToResumeAgentType)(terminal.agentType, terminal.startupCommand) : null);
        if (!terminal?.lastSessionId || !agentType) {
            throw new Error('This terminal is not bound to a persistent coding CLI session.');
        }
        return resumeManager.renameSession(agentType, terminal.lastSessionId, args.title);
    });
    electron_1.ipcMain.handle('resume:get-projects', async () => {
        return resumeManager.getUniqueProjects();
    });
    electron_1.ipcMain.handle('resume:clear-cache', async () => {
        resumeManager.clearCache();
    });
    electron_1.ipcMain.handle('resume:detect-session-for-terminal', async (_, args) => {
        // Ownership evidence from this exact PTY: Enter timing narrows candidates;
        // submitted prompt text identifies a strict match among simultaneous
        // 1DevTool/external sessions.
        return resumeManager.detectSessionForTerminal(args.terminalId, args.agentType, args.projectPath, args.startedAfter, ptyBackend.getLastSubmitTime(args.terminalId) ?? null, ptyBackend.getSubmittedPrompts(args.terminalId));
    });
    // External AI sessions running in OTHER terminals (Ghostty/iTerm/VS Code/…).
    // The scanner module is dynamic-imported so neither it nor its process-ancestry
    // machinery costs anything at boot — it loads on the first detect call.
    electron_1.ipcMain.handle('resume:detect-external', async (_, args) => {
        const { getExternalAgentScanner } = await Promise.resolve().then(() => __importStar(require('../externalAgentScanner')));
        return getExternalAgentScanner(resumeManager).detect({ forceRefresh: Boolean(args?.forceRefresh) });
    });
    electron_1.ipcMain.handle('resume:terminate-process', async (_, args) => {
        const { getExternalAgentScanner } = await Promise.resolve().then(() => __importStar(require('../externalAgentScanner')));
        return getExternalAgentScanner(resumeManager).terminate(args.pid);
    });
    electron_1.ipcMain.handle('resume:list-native-terminals', async () => {
        const { getNativeTerminalLauncher } = await Promise.resolve().then(() => __importStar(require('../nativeTerminalLauncher')));
        return getNativeTerminalLauncher().list();
    });
    electron_1.ipcMain.handle('resume:open-native-terminal', async (_, args) => {
        // Main owns discovery and launches only a known terminal application. The
        // renderer supplies a directory, never an executable or shell command.
        if (typeof args?.terminalAppId !== 'string' || typeof args?.cwd !== 'string') {
            return { ok: false, error: 'Invalid native terminal request.' };
        }
        const { getNativeTerminalLauncher } = await Promise.resolve().then(() => __importStar(require('../nativeTerminalLauncher')));
        return getNativeTerminalLauncher().open(args.terminalAppId, args.cwd);
    });
    electron_1.ipcMain.handle('resume:open-in-native-terminal', async (_, args) => {
        // The renderer selects only identity + destination. Main reconstructs the
        // command so an IPC caller cannot turn this feature into arbitrary shell
        // execution. Local agent ids are opaque but never contain shell syntax.
        if (typeof args?.terminalAppId !== 'string' || typeof args?.cwd !== 'string') {
            return { ok: false, error: 'Invalid native terminal request.' };
        }
        if (typeof args?.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/.test(args.sessionId)) {
            return { ok: false, error: 'The current AI session id is invalid.' };
        }
        const { getNativeTerminalLauncher, prepareNativeTerminalResumeCommand } = await Promise.resolve().then(() => __importStar(require('../nativeTerminalLauncher')));
        const command = prepareNativeTerminalResumeCommand(args.agentType, resumeManager.getResumeCommand(args.agentType, args.sessionId));
        if (!command)
            return { ok: false, error: 'This AI agent does not support native session resume.' };
        return getNativeTerminalLauncher().launch(args.terminalAppId, {
            cwd: args.cwd,
            resumeCommand: command,
        });
    });
}
