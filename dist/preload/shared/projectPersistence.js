"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDefaultOutputPanelState = getDefaultOutputPanelState;
exports.createProjectFileTreeState = createProjectFileTreeState;
exports.createPersistedProject = createPersistedProject;
/** Defaults always populate the optional sections — the return type says so,
 * so merge code can spread `defaults.env`/`defaults.database` without guards. */
function getDefaultOutputPanelState(mode = 'http') {
    return {
        mode,
        isOpen: true,
        width: 300,
        http: {
            method: 'GET',
            url: '',
            headers: {},
            body: '',
            auth: { type: 'none' },
            savedRequests: [],
            urlHistory: [],
            tabs: [],
            openTabIds: [],
            environments: [],
            importSources: [],
        },
        browser: {
            url: 'https://1devtool.com/',
            history: [],
        },
        env: {
            activeFile: '.env.local',
        },
        database: {
            connections: [],
            activeConnectionId: null,
            query: 'select 1;',
            history: [],
        },
        mobileEmulator: {
            platform: 'ios',
            selectedDeviceId: null,
            orientation: 'portrait',
        },
    };
}
function createProjectFileTreeState(rootPath, preferences) {
    return {
        expandedPaths: [rootPath],
        showHiddenFiles: preferences.behavior.showHiddenFiles,
        respectGitignore: preferences.behavior.respectGitignore,
    };
}
function createPersistedProject(input) {
    return {
        id: input.id,
        name: input.name,
        rootPath: input.rootPath,
        sourceType: input.sourceType ?? 'local',
        ...(input.ssh ? { ssh: input.ssh } : {}),
        color: input.color,
        ...(input.avatar ? { avatar: input.avatar } : {}),
        ...(input.emoji ? { emoji: input.emoji } : {}),
        ...(input.editorCommand ? { editorCommand: input.editorCommand } : {}),
        createdAt: input.createdAt,
        terminals: [],
        openFiles: [],
        activeFile: null,
        editorPaneHeight: 420,
        editorPaneCollapsed: false,
        terminalColumnRatios: [1, 1],
        terminalGridSplit: { column: 0.5, row: 0.5 },
        outputPanel: getDefaultOutputPanelState(),
        fileTree: createProjectFileTreeState(input.rootPath, input.preferences),
        layout: input.layout,
        gitAccountId: input.gitAccountId ?? null,
        quickCommands: input.quickCommands ?? [],
        pipes: [],
        activePipeRun: null,
        pipeRunHistory: [],
        ...(input.worktreeColors ? { worktreeColors: input.worktreeColors } : {}),
        ...(input.lspEnabled !== undefined ? { lspEnabled: input.lspEnabled } : {}),
        ...(input.lspLanguages ? { lspLanguages: input.lspLanguages } : {}),
    };
}
