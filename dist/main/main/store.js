"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.StoreManager = void 0;
exports.migrateLegacyDefaultTerminalFontPreference = migrateLegacyDefaultTerminalFontPreference;
exports.migrateGeminiRecommendedVisibilityPreference = migrateGeminiRecommendedVisibilityPreference;
exports.normalizePreferences = normalizePreferences;
const electron_store_1 = __importDefault(require("electron-store"));
const types_1 = require("../shared/types");
const orchestrationPolicy_1 = require("../shared/orchestrationPolicy");
const setupPresets_1 = require("../shared/orchestration/setupPresets");
const LEGACY_UNBUNDLED_DEFAULT_TERMINAL_FONT = 'JetBrains Mono';
/**
 * The app used JetBrains Mono as its default before the font was bundled. On
 * machines without a system copy (notably clean Windows installs), that saved
 * value resolves to Chromium's generic monospace fallback even though the app
 * now ships a deterministic Nerd Font build.
 *
 * This helper is only called by the versioned one-shot migration below. That
 * lets someone deliberately select JetBrains Mono again after migration while
 * preserving every unrelated appearance preference.
 */
function migrateLegacyDefaultTerminalFontPreference(preferences) {
    if (preferences.appearance?.terminalFontFamily !== LEGACY_UNBUNDLED_DEFAULT_TERMINAL_FONT) {
        return preferences;
    }
    return {
        ...preferences,
        appearance: {
            ...preferences.appearance,
            terminalFontFamily: types_1.DEFAULT_PREFERENCES.appearance.terminalFontFamily,
        },
    };
}
/**
 * Gemini remains supported, but Antigravity (`agy`) is now the recommended
 * Google agent. Existing profiles may already have a non-empty hidden-agent
 * list that overrides the new default, so add Gemini once during migration.
 * The versioned caller ensures a later manual re-enable remains untouched.
 */
function migrateGeminiRecommendedVisibilityPreference(preferences) {
    const hiddenAgents = preferences.startupCommands?.hiddenAgents ?? [];
    if (hiddenAgents.includes('gemini'))
        return preferences;
    return {
        ...preferences,
        startupCommands: {
            ...preferences.startupCommands,
            customPresets: preferences.startupCommands?.customPresets ?? [],
            hiddenAgents: [...hiddenAgents, 'gemini'],
        },
    };
}
function normalizePreferences(preferences) {
    return {
        ...types_1.DEFAULT_PREFERENCES,
        ...preferences,
        workspace: {
            ...types_1.DEFAULT_PREFERENCES.workspace,
            ...preferences.workspace,
        },
        ide: {
            ...types_1.DEFAULT_PREFERENCES.ide,
            ...preferences.ide,
            readerMode: {
                ...types_1.DEFAULT_PREFERENCES.ide.readerMode,
                ...preferences.ide?.readerMode,
            },
        },
        languages: {
            ...types_1.DEFAULT_PREFERENCES.languages,
            ...preferences.languages,
            enabled: preferences.languages?.enabled || types_1.DEFAULT_PREFERENCES.languages.enabled,
            installPaths: preferences.languages?.installPaths || {},
            installedVersions: preferences.languages?.installedVersions || {},
            perLanguageOverrides: preferences.languages?.perLanguageOverrides,
        },
        appearance: {
            ...types_1.DEFAULT_PREFERENCES.appearance,
            ...preferences.appearance,
        },
        behavior: {
            ...types_1.DEFAULT_PREFERENCES.behavior,
            ...preferences.behavior,
            terminalScrollback: (0, types_1.clampTerminalScrollback)(preferences.behavior?.terminalScrollback),
        },
        terminal: {
            ...types_1.DEFAULT_PREFERENCES.terminal,
            ...preferences.terminal,
        },
        defaults: {
            ...types_1.DEFAULT_PREFERENCES.defaults,
            ...preferences.defaults,
        },
        browser: {
            ...types_1.DEFAULT_PREFERENCES.browser,
            ...preferences.browser,
        },
        git: {
            ...types_1.DEFAULT_PREFERENCES.git,
            ...preferences.git,
            accounts: preferences.git?.accounts || [],
        },
        draw: {
            ...types_1.DEFAULT_PREFERENCES.draw,
            ...preferences.draw,
        },
        ssh: {
            ...types_1.DEFAULT_PREFERENCES.ssh,
            ...preferences.ssh,
            connections: preferences.ssh?.connections || [],
        },
        startupCommands: {
            ...types_1.DEFAULT_PREFERENCES.startupCommands,
            ...preferences.startupCommands,
            customPresets: preferences.startupCommands?.customPresets || [],
        },
        aiAgentPaths: {
            ...types_1.DEFAULT_PREFERENCES.aiAgentPaths,
            ...(preferences.aiAgentPaths ?? {}),
        },
        updates: {
            ...types_1.DEFAULT_PREFERENCES.updates,
            ...preferences.updates,
        },
        privacy: {
            ...types_1.DEFAULT_PREFERENCES.privacy,
            ...preferences.privacy,
        },
        onboarding: {
            ...types_1.DEFAULT_PREFERENCES.onboarding,
            ...preferences.onboarding,
            completedSteps: preferences.onboarding?.completedSteps ?? [],
            dismissedSteps: preferences.onboarding?.dismissedSteps ?? [],
        },
        orchestration: (0, orchestrationPolicy_1.normalizeOrchestrationPolicyState)(preferences.orchestration),
        orchestrationSetups: {
            presets: (0, setupPresets_1.normalizeOrchestrationSetupPresets)(preferences.orchestrationSetups?.presets),
        },
    };
}
class StoreManager {
    store;
    httpTabsStore;
    // Lazy O(1) index for findTerminalLocation. Built on first lookup after any
    // project mutation; invalidated by saveProject/deleteProject/`set('projects')`.
    // Without this, callers like pty:input → getTerminalRecord scan
    // O(projects × terminals_per_project) per keystroke.
    terminalIndex = null;
    // The tray polls live PTY activity every five seconds, but project metadata
    // only changes through the mutation methods below. Keep a minimal snapshot
    // so an unchanged tray tick never reparses the full electron-store file (or
    // retains large saved buffers/output-panel state just to render its menu).
    trayProjectsSnapshot = null;
    // Deletion is authoritative for the lifetime of this main process. Project
    // records are saved as whole-object upserts from several async renderer/main
    // paths (terminal session detection, settings reconciliation, HTTP state).
    // A result that started before deleteProject() must never recreate that ID.
    // An explicit full `set('projects', ...)` replacement (config import) clears
    // the tombstones because it is a new authoritative collection.
    deletedProjectIds = new Set();
    constructor() {
        this.store = new electron_store_1.default({
            name: '1devtool',
            defaults: {
                projects: {},
                preferences: types_1.DEFAULT_PREFERENCES,
                activeProjectId: null,
                projectOrder: [],
                combinedSessions: [],
                customThemes: [],
                channels: {},
                obsidianVaultPath: null,
                globalDatabaseConnections: [],
                globalHttpTabs: [],
                projectGroups: {},
                projectGroupOrder: [],
                workspaces: {},
                workspaceOrder: [],
                projectWorkspacePreference: {},
                projectRootOrder: [],
                mcpDisabledTools: [],
                projectSettings: {},
                migrations: {},
            },
        });
        this.httpTabsStore = new electron_store_1.default({
            name: '1devtool-http-tabs',
            defaults: {
                projectTabs: {},
                globalTabs: [],
            },
        });
        this.runMigrations();
    }
    splitHttpTabs(project) {
        const tabs = project.outputPanel?.http?.tabs;
        if (!tabs)
            return { project, tabs };
        const http = { ...project.outputPanel.http };
        delete http.tabs;
        return {
            tabs,
            project: {
                ...project,
                outputPanel: {
                    ...project.outputPanel,
                    http,
                },
            },
        };
    }
    hydrateHttpTabs(project, projectTabs) {
        const tabs = projectTabs[project.id] ?? project.outputPanel?.http?.tabs ?? [];
        return {
            ...project,
            outputPanel: {
                ...project.outputPanel,
                http: {
                    ...project.outputPanel.http,
                    tabs,
                },
            },
        };
    }
    readProjectsAndOrder() {
        // electron-store reparses the complete JSON file for every `get()`. Read
        // its snapshot once when both keys are needed so ordering does not double
        // the synchronous main-thread I/O.
        const snapshot = this.store.store;
        return {
            projects: snapshot.projects || {},
            order: snapshot.projectOrder || [],
        };
    }
    getProjectHttpTabs(projectId) {
        const projectTabs = this.httpTabsStore.get('projectTabs') || {};
        return projectTabs[projectId] || [];
    }
    setProjectHttpTabs(projectId, tabs) {
        if (this.deletedProjectIds.has(projectId)) {
            console.warn(`[store] Ignored stale HTTP-tab save for deleted project ${projectId}`);
            return;
        }
        const projectTabs = this.httpTabsStore.get('projectTabs') || {};
        this.httpTabsStore.set('projectTabs', {
            ...projectTabs,
            [projectId]: tabs,
        });
    }
    runMigrations() {
        const migrations = this.store.get('migrations') || {};
        // tmuxMouseBehaviorV2 (2026-05-05): the original 'native-selection' default
        // silently disabled wheel scrolling inside tmux-managed terminals because
        // tmux always uses xterm's alternate buffer where scrollLines is a no-op.
        // Flip saved 'native-selection' to 'force-on' so wheel scroll works. Users
        // who want drag-select can switch back via Settings → Terminal → Advance.
        if (!migrations.tmuxMouseBehaviorV2) {
            const preferences = this.store.get('preferences');
            if (preferences?.terminal?.tmuxMouseBehavior === 'native-selection') {
                this.store.set('preferences', {
                    ...preferences,
                    terminal: {
                        ...preferences.terminal,
                        tmuxMouseBehavior: 'force-on',
                    },
                });
            }
            this.store.set('migrations', { ...migrations, tmuxMouseBehaviorV2: true });
        }
        // httpTabsSideStoreV1 (2026-05-28): large imported HTTP collections live in
        // a dedicated electron-store file so project metadata writes don't rewrite
        // multi-megabyte request arrays on every request-field edit.
        if (!migrations.httpTabsSideStoreV1) {
            const projects = this.store.get('projects') || {};
            const projectTabs = { ...(this.httpTabsStore.get('projectTabs') || {}) };
            const strippedProjects = {};
            let changed = false;
            for (const [projectId, project] of Object.entries(projects)) {
                const split = this.splitHttpTabs(project);
                if (split.tabs && split.tabs.length && !projectTabs[projectId]?.length) {
                    projectTabs[projectId] = split.tabs;
                    changed = true;
                }
                strippedProjects[projectId] = split.project;
                if (split.tabs)
                    changed = true;
            }
            const legacyGlobalTabs = this.store.get('globalHttpTabs') || [];
            if (legacyGlobalTabs.length && !(this.httpTabsStore.get('globalTabs') || []).length) {
                this.httpTabsStore.set('globalTabs', legacyGlobalTabs);
            }
            this.httpTabsStore.set('projectTabs', projectTabs);
            if (changed)
                this.store.set('projects', strippedProjects);
            if (legacyGlobalTabs.length)
                this.store.set('globalHttpTabs', []);
            this.store.set('migrations', { ...this.store.get('migrations'), httpTabsSideStoreV1: true });
        }
        // tmuxMouseBehaviorV3 (2026-05-22): native-selection now disables tmux's
        // alternate-screen via terminal-overrides, so wheel scroll works in xterm's
        // normal buffer (no more no-op) and the user gets native text selection plus
        // no copy-mode position indicator. The V2 band-aid that forced users onto
        // 'force-on' is no longer needed — flip those users back to the now-working
        // default. Users who explicitly switched to force-on/respect-config after V2
        // ran will have those values preserved (only literal 'force-on' is flipped,
        // and only once).
        const migrationsAfterHttpTabs = this.store.get('migrations') || {};
        if (!migrationsAfterHttpTabs.tmuxMouseBehaviorV3) {
            const preferences = this.store.get('preferences');
            if (preferences?.terminal?.tmuxMouseBehavior === 'force-on') {
                this.store.set('preferences', {
                    ...preferences,
                    terminal: {
                        ...preferences.terminal,
                        tmuxMouseBehavior: 'native-selection',
                    },
                });
            }
            this.store.set('migrations', { ...migrationsAfterHttpTabs, tmuxMouseBehaviorV3: true });
        }
        // projectSettingsFolderV1 (2026-07-03): introduce the per-project
        // `.1devtool/` settings folder. Non-destructive — seeds a disabled meta
        // record for every existing project and leaves all data in the store. No
        // file I/O at migration time; a folder is only written when the user opts
        // in via "Enable settings folder" / "Share project setup".
        const migrationsAfterV3 = this.store.get('migrations') || {};
        if (!migrationsAfterV3.projectSettingsFolderV1) {
            const meta = this.store.get('projectSettings') || {};
            const projects = this.store.get('projects') || {};
            const next = { ...meta };
            for (const id of Object.keys(projects)) {
                if (!next[id])
                    next[id] = { enabled: false, approvals: {} };
            }
            this.store.set('projectSettings', next);
            this.store.set('migrations', { ...this.store.get('migrations'), projectSettingsFolderV1: true });
        }
        // bundledTerminalFontV1 (2026-08-09): JetBrains Mono was the old default,
        // but it was never shipped with the app. Clean Windows machines therefore
        // rendered old profiles with Chromium's generic monospace fallback. Move
        // that legacy default to the bundled face once; after this flag is set, an
        // explicit user selection of JetBrains Mono remains untouched.
        const migrationsAfterProjectSettings = this.store.get('migrations') || {};
        if (!migrationsAfterProjectSettings.bundledTerminalFontV1) {
            const preferences = this.store.get('preferences');
            const migratedPreferences = migrateLegacyDefaultTerminalFontPreference(preferences);
            if (migratedPreferences !== preferences) {
                this.store.set('preferences', migratedPreferences);
            }
            this.store.set('migrations', {
                ...migrationsAfterProjectSettings,
                bundledTerminalFontV1: true,
            });
        }
        // geminiStartupVisibilityV1 (2026-08-10): Gemini CLI remains available,
        // but Antigravity (`agy`) supersedes it in the recommended agent list.
        // Hide Gemini once for existing profiles, including profiles whose saved
        // non-empty hidden list would otherwise override the new default. After
        // this flag is set, a user can re-enable Gemini and keep that choice.
        const migrationsAfterBundledFont = this.store.get('migrations') || {};
        if (!migrationsAfterBundledFont.geminiStartupVisibilityV1) {
            const preferences = this.store.get('preferences');
            const migratedPreferences = migrateGeminiRecommendedVisibilityPreference(preferences);
            if (migratedPreferences !== preferences) {
                this.store.set('preferences', migratedPreferences);
            }
            this.store.set('migrations', {
                ...migrationsAfterBundledFont,
                geminiStartupVisibilityV1: true,
            });
        }
    }
    getProjectSettingsMeta(projectId) {
        const all = this.store.get('projectSettings') || {};
        return all[projectId] || { enabled: false, approvals: {} };
    }
    getAllProjectSettingsMeta() {
        return this.store.get('projectSettings') || {};
    }
    setProjectSettingsMeta(projectId, meta) {
        const all = this.store.get('projectSettings') || {};
        this.store.set('projectSettings', { ...all, [projectId]: meta });
    }
    getProjectGroups() {
        const groups = this.store.get('projectGroups') || {};
        const order = this.store.get('projectGroupOrder') || [];
        const all = Object.values(groups);
        if (order.length > 0) {
            const orderMap = new Map(order.map((id, i) => [id, i]));
            return all.sort((a, b) => {
                const ai = orderMap.get(a.id);
                const bi = orderMap.get(b.id);
                if (ai !== undefined && bi !== undefined)
                    return ai - bi;
                if (ai !== undefined)
                    return -1;
                if (bi !== undefined)
                    return 1;
                return a.order - b.order;
            });
        }
        return all.sort((a, b) => a.order - b.order);
    }
    saveProjectGroup(group) {
        const groups = this.store.get('projectGroups') || {};
        groups[group.id] = group;
        this.store.set('projectGroups', groups);
    }
    deleteProjectGroup(id) {
        const groups = this.store.get('projectGroups') || {};
        delete groups[id];
        this.store.set('projectGroups', groups);
        const order = (this.store.get('projectGroupOrder') || []).filter((gid) => gid !== id);
        this.store.set('projectGroupOrder', order);
    }
    setProjectGroupOrder(order) {
        this.store.set('projectGroupOrder', order);
    }
    // --- Workspaces (docs/workspace_control/02-data-model.md §2). Same shape
    // as the ProjectGroup accessors above: the store persists records verbatim;
    // WorkspaceService owns minting, validation, and resolve. ---
    getWorkspaces() {
        const workspaces = this.store.get('workspaces') || {};
        const order = this.store.get('workspaceOrder') || [];
        const all = Object.values(workspaces);
        const orderMap = new Map(order.map((id, i) => [id, i]));
        return all.sort((a, b) => {
            const ai = orderMap.get(a.id);
            const bi = orderMap.get(b.id);
            if (ai !== undefined && bi !== undefined)
                return ai - bi;
            if (ai !== undefined)
                return -1;
            if (bi !== undefined)
                return 1;
            return a.order - b.order;
        });
    }
    getWorkspace(id) {
        return (this.store.get('workspaces') || {})[id];
    }
    saveWorkspace(workspace) {
        const workspaces = this.store.get('workspaces') || {};
        workspaces[workspace.id] = workspace;
        this.store.set('workspaces', workspaces);
    }
    /** Removes the record, its order entry, and preferences pointing at it.
     *  Never touches projects (invariant: delete workspace ≠ delete projects). */
    deleteWorkspace(id) {
        const workspaces = this.store.get('workspaces') || {};
        delete workspaces[id];
        this.store.set('workspaces', workspaces);
        const order = (this.store.get('workspaceOrder') || []).filter((wid) => wid !== id);
        this.store.set('workspaceOrder', order);
        const preference = { ...(this.store.get('projectWorkspacePreference') || {}) };
        let preferenceChanged = false;
        for (const [projectId, workspaceId] of Object.entries(preference)) {
            if (workspaceId === id) {
                delete preference[projectId];
                preferenceChanged = true;
            }
        }
        if (preferenceChanged)
            this.store.set('projectWorkspacePreference', preference);
    }
    getWorkspaceOrder() {
        return this.store.get('workspaceOrder') || [];
    }
    setWorkspaceOrder(order) {
        this.store.set('workspaceOrder', order);
    }
    getProjectWorkspacePreference() {
        return this.store.get('projectWorkspacePreference') || {};
    }
    setProjectWorkspacePreference(projectId, workspaceId) {
        const preference = { ...(this.store.get('projectWorkspacePreference') || {}) };
        if (workspaceId === null)
            delete preference[projectId];
        else
            preference[projectId] = workspaceId;
        this.store.set('projectWorkspacePreference', preference);
    }
    getProjectRootOrder() {
        return this.store.get('projectRootOrder') || [];
    }
    setProjectRootOrder(order) {
        this.store.set('projectRootOrder', order);
    }
    getGlobalDatabaseConnections() {
        return this.store.get('globalDatabaseConnections') || [];
    }
    setGlobalDatabaseConnections(connections) {
        this.store.set('globalDatabaseConnections', connections);
    }
    getGlobalHttpTabs() {
        return this.httpTabsStore.get('globalTabs') || this.store.get('globalHttpTabs') || [];
    }
    setGlobalHttpTabs(tabs) {
        this.httpTabsStore.set('globalTabs', tabs);
        this.store.set('globalHttpTabs', []);
    }
    getObsidianVaultPath() {
        return this.store.get('obsidianVaultPath') ?? null;
    }
    setObsidianVaultPath(value) {
        this.store.set('obsidianVaultPath', value);
    }
    get(key) {
        if (key === 'globalHttpTabs') {
            return this.getGlobalHttpTabs();
        }
        if (key === 'projects') {
            const projects = this.store.get('projects') || {};
            const projectTabs = this.httpTabsStore.get('projectTabs') || {};
            return Object.fromEntries(Object.entries(projects).map(([projectId, project]) => [
                projectId,
                this.hydrateHttpTabs(project, projectTabs),
            ]));
        }
        return this.store.get(key);
    }
    set(key, value) {
        if (key === 'globalHttpTabs') {
            this.setGlobalHttpTabs(value);
            return;
        }
        if (key === 'projects') {
            const projects = value;
            const stripped = {};
            const projectTabs = { ...(this.httpTabsStore.get('projectTabs') || {}) };
            let projectTabsChanged = false;
            for (const [projectId, project] of Object.entries(projects)) {
                const split = this.splitHttpTabs(project);
                if (split.tabs) {
                    projectTabs[projectId] = split.tabs;
                    projectTabsChanged = true;
                }
                stripped[projectId] = split.project;
            }
            if (projectTabsChanged)
                this.httpTabsStore.set('projectTabs', projectTabs);
            this.store.set('projects', stripped);
            this.deletedProjectIds.clear();
            this.invalidateProjectCaches();
            return;
        }
        this.store.set(key, value);
    }
    /**
     * O(1) lookup for `(project, terminal)` by terminalId. Used by main-process
     * hot paths (pty:input, notification fire, preview resolver) instead of the
     * old O(projects × terminals) linear scan.
     *
     * Internally lazy-builds an index on the first call after any mutation
     * (`saveProject`, `deleteProject`, `set('projects', …)`). Subsequent calls
     * before the next mutation are pure Map lookups.
     */
    findTerminalLocation(terminalId) {
        if (!this.terminalIndex) {
            const idx = new Map();
            const projects = this.store.get('projects') || {};
            for (const project of Object.values(projects)) {
                if (!project?.terminals)
                    continue;
                for (const terminal of project.terminals) {
                    idx.set(terminal.id, { project, terminal });
                }
            }
            this.terminalIndex = idx;
        }
        return this.terminalIndex.get(terminalId) ?? null;
    }
    getProjects() {
        const { projects, order } = this.readProjectsAndOrder();
        const projectTabs = this.httpTabsStore.get('projectTabs') || {};
        const all = Object.values(projects).map((project) => this.hydrateHttpTabs(project, projectTabs));
        // If we have a custom order, sort by it; unordered projects go at the end sorted by createdAt
        if (order.length > 0) {
            const orderMap = new Map(order.map((id, i) => [id, i]));
            return all.sort((a, b) => {
                const aIdx = orderMap.get(a.id);
                const bIdx = orderMap.get(b.id);
                if (aIdx !== undefined && bIdx !== undefined)
                    return aIdx - bIdx;
                if (aIdx !== undefined)
                    return -1;
                if (bIdx !== undefined)
                    return 1;
                return a.createdAt - b.createdAt;
            });
        }
        return all.sort((a, b) => a.createdAt - b.createdAt);
    }
    /**
     * Minimal stable project view for the polling tray menu. Repeated calls are
     * O(1) and return the same array until project data or ordering changes.
     * HTTP tabs, saved terminal buffers, editor state, and other large project
     * fields are deliberately excluded.
     */
    getTrayProjectsSnapshot() {
        if (this.trayProjectsSnapshot)
            return this.trayProjectsSnapshot;
        const { projects, order } = this.readProjectsAndOrder();
        const orderMap = new Map(order.map((id, index) => [id, index]));
        const snapshot = Object.values(projects).map((project) => ({
            id: project.id,
            name: project.name,
            avatar: project.avatar,
            emoji: project.emoji,
            createdAt: project.createdAt,
            terminals: project.terminals.map((terminal) => ({
                id: terminal.id,
                name: terminal.name,
                agentType: terminal.agentType,
                startupCommand: terminal.startupCommand,
                isHidden: terminal.isHidden,
                forceAiAgent: terminal.forceAiAgent,
            })),
        }));
        snapshot.sort((a, b) => {
            const aIdx = orderMap.get(a.id);
            const bIdx = orderMap.get(b.id);
            if (aIdx !== undefined && bIdx !== undefined)
                return aIdx - bIdx;
            if (aIdx !== undefined)
                return -1;
            if (bIdx !== undefined)
                return 1;
            return a.createdAt - b.createdAt;
        });
        this.trayProjectsSnapshot = snapshot;
        return snapshot;
    }
    saveProject(project) {
        if (this.deletedProjectIds.has(project.id)) {
            console.warn(`[store] Ignored stale save for deleted project ${project.id}`);
            return;
        }
        const split = this.splitHttpTabs(project);
        if (split.tabs)
            this.setProjectHttpTabs(project.id, split.tabs);
        const projects = this.store.get('projects') || {};
        projects[project.id] = split.project;
        this.store.set('projects', projects);
        this.invalidateProjectCaches();
    }
    deleteProject(id) {
        // Record the tombstone before any store writes. A stale async save can
        // otherwise land between the primary and HTTP-side-store deletions and
        // resurrect the project during Restart & Install shutdown persistence.
        this.deletedProjectIds.add(id);
        const projects = this.store.get('projects') || {};
        delete projects[id];
        this.store.set('projects', projects);
        const projectTabs = this.httpTabsStore.get('projectTabs') || {};
        if (projectTabs[id]) {
            delete projectTabs[id];
            this.httpTabsStore.set('projectTabs', projectTabs);
        }
        this.invalidateProjectCaches();
    }
    getPreferences() {
        const preferences = this.store.get('preferences') || types_1.DEFAULT_PREFERENCES;
        return normalizePreferences(preferences);
    }
    setPreferences(preferences) {
        this.store.set('preferences', normalizePreferences(preferences));
    }
    getMcpDisabledTools() {
        const value = this.store.get('mcpDisabledTools');
        if (!Array.isArray(value))
            return [];
        return [...new Set(value.filter((name) => typeof name === 'string' && name.length > 0))]
            .sort();
    }
    setMcpDisabledTools(toolNames) {
        this.store.set('mcpDisabledTools', [...new Set([...toolNames].filter((name) => name.length > 0))].sort());
    }
    getActiveProjectId() {
        return this.store.get('activeProjectId');
    }
    setActiveProjectId(id) {
        this.store.set('activeProjectId', id);
    }
    getProjectOrder() {
        return this.store.get('projectOrder') || [];
    }
    setProjectOrder(order) {
        this.store.set('projectOrder', order);
        this.trayProjectsSnapshot = null;
    }
    invalidateProjectCaches() {
        this.terminalIndex = null;
        this.trayProjectsSnapshot = null;
    }
    updatePreference(path, value) {
        const prefs = this.getPreferences();
        const keys = path.split('.');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let current = prefs;
        for (let i = 0; i < keys.length - 1; i++) {
            current = current[keys[i]];
        }
        current[keys[keys.length - 1]] = value;
        this.setPreferences(prefs);
    }
    getCustomThemes() {
        return this.store.get('customThemes') || [];
    }
    saveCustomTheme(theme) {
        const themes = this.getCustomThemes();
        const idx = themes.findIndex((t) => t.id === theme.id);
        if (idx >= 0) {
            themes[idx] = theme;
        }
        else {
            themes.push(theme);
        }
        this.store.set('customThemes', themes);
    }
    deleteCustomTheme(id) {
        const themes = this.getCustomThemes();
        this.store.set('customThemes', themes.filter((t) => t.id !== id));
    }
}
exports.StoreManager = StoreManager;
