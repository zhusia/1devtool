"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrayManager = void 0;
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const contracts_1 = require("../shared/terminal/contracts");
const REFRESH_INTERVAL_MS = 5_000;
const WORKING_THRESHOLD_MS = 3_000;
const MAX_TERMINALS_IN_MENU = 8;
const MAX_PROJECTS_IN_MENU = 6;
class TrayManager {
    tray = null;
    refreshTimer = null;
    deps;
    avatarCache = new Map();
    lastProjectsSnapshot = null;
    lastAgentStateSignature = null;
    lastWorkingCount = null;
    constructor(deps) {
        this.deps = deps;
    }
    start() {
        if (this.tray)
            return;
        const iconFile = process.platform === 'win32' ? 'resources/icon.ico' : 'resources/icon.png';
        let image = electron_1.nativeImage.createFromPath(path_1.default.join(electron_1.app.getAppPath(), iconFile));
        if (!image.isEmpty()) {
            image = image.resize({ width: 18, height: 18, quality: 'best' });
        }
        this.tray = new electron_1.Tray(image);
        this.tray.setToolTip('1DevTool');
        this.refresh();
        this.refreshTimer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
    }
    stop() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
        if (process.platform === 'darwin') {
            electron_1.app.dock?.setBadge('');
        }
        if (this.tray) {
            this.tray.destroy();
            this.tray = null;
        }
        this.avatarCache.clear();
        this.lastProjectsSnapshot = null;
        this.lastAgentStateSignature = null;
        this.lastWorkingCount = null;
    }
    refresh() {
        if (!this.tray)
            return;
        // Project metadata is a stable minimal snapshot; PTY activity remains a
        // live poll because an agent can become idle without a store mutation.
        const projects = this.deps.storeManager.getTrayProjectsSnapshot();
        const projectsChanged = projects !== this.lastProjectsSnapshot;
        if (projectsChanged)
            this.pruneAvatarCache(projects);
        const agentTerminals = this.collectActiveAgentTerminals(projects);
        const workingCount = agentTerminals.filter((t) => t.working).length;
        if (process.platform === 'darwin' && workingCount !== this.lastWorkingCount) {
            electron_1.app.dock?.setBadge(workingCount > 0 ? String(workingCount) : '');
            this.tray.setTitle(workingCount > 0 ? ` ${workingCount}` : '');
        }
        this.lastWorkingCount = workingCount;
        const agentStateSignature = agentTerminals
            .map((terminal) => `${terminal.terminalId}:${Number(terminal.working)}`)
            .join('|');
        if (!projectsChanged && agentStateSignature === this.lastAgentStateSignature)
            return;
        this.lastProjectsSnapshot = projects;
        this.lastAgentStateSignature = agentStateSignature;
        const template = [];
        template.push({
            label: 'Show 1DevTool',
            click: () => this.deps.focusMainWindow(),
        });
        if (agentTerminals.length > 0) {
            template.push({ type: 'separator' });
            template.push({ label: 'Active AI Terminals', enabled: false });
            const projectById = new Map(projects.map((p) => [p.id, p]));
            const sorted = [...agentTerminals].sort((a, b) => Number(b.working) - Number(a.working));
            for (const t of sorted.slice(0, MAX_TERMINALS_IN_MENU)) {
                const project = projectById.get(t.projectId);
                const icon = project ? this.getProjectIcon(project) : undefined;
                const emojiPrefix = !icon && project?.emoji ? `${project.emoji} ` : '';
                template.push({
                    label: `${emojiPrefix}${t.projectName} — ${t.label}`,
                    ...(icon ? { icon } : {}),
                    click: () => {
                        this.deps.sendMenuCommand({
                            type: 'focus-terminal',
                            projectId: t.projectId,
                            terminalId: t.terminalId,
                        });
                    },
                });
            }
        }
        if (projects.length > 0) {
            template.push({ type: 'separator' });
            template.push({ label: 'Switch Project', enabled: false });
            for (const project of projects.slice(0, MAX_PROJECTS_IN_MENU)) {
                const icon = this.getProjectIcon(project);
                const prefix = !icon && project.emoji ? `${project.emoji} ` : '';
                template.push({
                    label: `${prefix}${project.name}`,
                    ...(icon ? { icon } : {}),
                    click: () => {
                        this.deps.sendMenuCommand({ type: 'switch-project', projectId: project.id });
                    },
                });
            }
        }
        template.push({ type: 'separator' });
        template.push({ label: 'Quit 1DevTool', role: 'quit' });
        this.tray.setContextMenu(electron_1.Menu.buildFromTemplate(template));
    }
    pruneAvatarCache(projects) {
        if (this.avatarCache.size === 0)
            return;
        const live = new Set(projects.map((p) => p.id));
        for (const id of this.avatarCache.keys()) {
            if (!live.has(id))
                this.avatarCache.delete(id);
        }
    }
    getProjectIcon(project) {
        const src = project.avatar;
        if (!src || !src.startsWith('data:'))
            return undefined;
        const cached = this.avatarCache.get(project.id);
        if (cached && cached.src === src)
            return cached.image;
        try {
            const raw = electron_1.nativeImage.createFromDataURL(src);
            if (raw.isEmpty())
                return undefined;
            const image = raw.resize({ width: 16, height: 16, quality: 'best' });
            this.avatarCache.set(project.id, { src, image });
            return image;
        }
        catch {
            return undefined;
        }
    }
    collectActiveAgentTerminals(projects) {
        const result = [];
        for (const project of projects) {
            for (const terminal of project.terminals) {
                if (terminal.isHidden)
                    continue;
                if (!(0, contracts_1.isInteractiveAgentTerminal)(terminal.agentType, terminal.startupCommand, terminal.forceAiAgent)) {
                    continue;
                }
                if (!this.deps.ptyBackend.hasLiveInstance(terminal.id))
                    continue;
                const working = !this.deps.ptyBackend.isIdle(terminal.id, WORKING_THRESHOLD_MS);
                result.push({
                    projectId: project.id,
                    projectName: project.name,
                    terminalId: terminal.id,
                    label: terminal.name || terminal.agentType,
                    working,
                });
            }
        }
        return result;
    }
}
exports.TrayManager = TrayManager;
