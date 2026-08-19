"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProjectSettingsManager = void 0;
const fs_1 = require("fs");
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const types_1 = require("../../shared/types");
const ssh_1 = require("../ssh");
const files_1 = require("./files");
const secretRefs_1 = require("./secretRefs");
const gitignore_1 = require("./gitignore");
const schema_1 = require("./schema");
const trust_1 = require("./trust");
/** Domains reconciled from folder → store on load (folder is authoritative). */
const PASSIVE_DOMAINS = [
    'settings',
    'browser',
    'database',
    'http',
    'deploy',
    'env',
    'prompts',
    'layouts',
];
/** Domains written out by "Share project setup" / on enable (have a real store source). */
const EXPORT_DOMAINS = [
    'settings',
    'browser',
    'database',
    'http',
    'deploy',
    'env',
];
const DEBOUNCE_MS = 500;
const OWN_WRITE_IGNORE_MS = 1500;
class ProjectSettingsManager {
    deps;
    activeRoots = new Map(); // projectId → rootPath
    debounceTimers = new Map(); // `${projectId}:${domain}` → timer
    lastWrittenHash = new Map(); // absolute filePath → last-written content hash
    ignoreUntil = new Map(); // absolute filePath → epoch ms
    statusCache = new Map();
    loadedProjects = new Set(); // adopted + watched this session
    sessionSecrets = new Map(); // ref → plaintext (safeStorage-unavailable fallback)
    constructor(deps) {
        this.deps = deps;
    }
    assertLicensed() {
        if (!this.deps.isLicensed())
            throw new Error('PRO_REQUIRED');
    }
    // --- lifecycle ----------------------------------------------------------
    async enable(projectId) {
        this.assertLicensed();
        const project = this.getProject(projectId);
        if (!project)
            throw new Error('project not found');
        await (0, gitignore_1.ensureSecretsGitignored)(project.rootPath);
        const meta = this.deps.storeManager.getProjectSettingsMeta(projectId);
        this.deps.storeManager.setProjectSettingsMeta(projectId, { ...meta, enabled: true });
        await this.doExport(project); // capture current store state into the folder
        this.loadedProjects.add(projectId);
        this.startWatch(project);
        return this.reconcile(project, true);
    }
    async disable(projectId) {
        this.stopWatch(projectId);
        const meta = this.deps.storeManager.getProjectSettingsMeta(projectId);
        this.deps.storeManager.setProjectSettingsMeta(projectId, { ...meta, enabled: false });
        // Reflect the disabled state immediately; files are left on disk (never
        // delete user data on disable).
        const cached = this.statusCache.get(projectId);
        if (cached)
            this.statusCache.set(projectId, { ...cached, enabled: false });
    }
    /** Called on project activation: reconcile folder → store and start watching. */
    async load(project) {
        if (!this.deps.isLicensed()) {
            this.stopWatch(project.id);
            return this.reconcile(project, false);
        }
        this.loadedProjects.add(project.id);
        this.startWatch(project);
        return this.reconcile(project, true);
    }
    startWatch(project) {
        // We piggyback on the always-on root watcher (see index.ts fs:watch fan-out)
        // rather than opening our own chokidar instance. sshfs roots are excluded
        // from live reconcile (FUSE doesn't forward inotify); their edits are picked
        // up on the next explicit reload instead.
        if (project.sourceType === 'ssh' || (0, ssh_1.isSshfsPath)(project.rootPath)) {
            this.activeRoots.delete(project.id);
            return;
        }
        this.activeRoots.set(project.id, project.rootPath);
    }
    stopWatch(projectId) {
        this.activeRoots.delete(projectId);
    }
    // --- external-edit detection (fan-out from fs:watch) --------------------
    handleFsEvent(_event, filePath) {
        if (!this.deps.isLicensed())
            return;
        // Cheap early-out: this fires on every file change under the project root,
        // and the overwhelming majority are not inside `.1devtool/`.
        if (!filePath.includes('.1devtool'))
            return;
        for (const [projectId, rootPath] of this.activeRoots) {
            const dir = (0, files_1.settingsDir)(rootPath);
            if (!(0, files_1.isInsideDir)(dir, filePath))
                continue;
            const base = path_1.default.basename(filePath);
            if (base === 'secrets.local.json' || base === '.gitignore' || base.startsWith('.'))
                return;
            void this.onExternalEdit(projectId, rootPath, filePath).catch((err) => {
                console.warn('[projectSettings] external edit handling failed:', err.message);
            });
            return;
        }
    }
    async onExternalEdit(projectId, rootPath, filePath) {
        // Own-write guard: skip if within the ignore window or the disk content
        // matches what we just wrote (survives coalesced chokidar events).
        if (Date.now() < (this.ignoreUntil.get(filePath) ?? 0))
            return;
        const text = await (0, files_1.readTextTolerant)(filePath);
        if (text != null && (0, files_1.contentHash)(text) === this.lastWrittenHash.get(filePath))
            return;
        const project = this.getProject(projectId);
        if (!project)
            return;
        await this.reconcile(project, true);
    }
    // --- writes -------------------------------------------------------------
    /** Debounced, atomic, secret-stripped mirror of one domain to its file. */
    writeBack(projectId, domain) {
        if (!this.deps.isLicensed())
            return; // folder freezes on downgrade; store keeps working
        const meta = this.deps.storeManager.getProjectSettingsMeta(projectId);
        if (!meta.enabled)
            return;
        const key = `${projectId}:${domain}`;
        const existing = this.debounceTimers.get(key);
        if (existing)
            clearTimeout(existing);
        this.debounceTimers.set(key, setTimeout(() => {
            this.debounceTimers.delete(key);
            const project = this.getProject(projectId);
            if (!project)
                return;
            void this.flushDomain(project, domain).catch((err) => {
                this.setLastError(projectId, err.message);
            });
        }, DEBOUNCE_MS));
    }
    async flushDomain(project, domain) {
        if (domain === 'skills' || domain === 'agents' || domain === 'channels' || domain === 'prompts' || domain === 'layouts') {
            return; // executable / hand-authored domains are not auto-mirrored
        }
        const payload = this.collectDomain(project, domain);
        if (!payload)
            return;
        await this.writeDomainFile(project, domain, payload);
        this.pushChanged(project.id, [domain]);
    }
    async writeDomainFile(project, domain, payload) {
        const { sanitized, secrets } = (0, secretRefs_1.stripSecrets)(domain, payload);
        await this.writeSecrets(project.rootPath, secrets);
        const fileObj = { version: types_1.PROJECT_SETTINGS_FILE_VERSION, ...sanitized };
        const filePath = (0, files_1.domainFilePath)(project.rootPath, domain);
        const text = (0, files_1.stableStringify)(fileObj);
        const hash = (0, files_1.contentHash)(text);
        const strippedRefs = Object.keys(secrets);
        // Skip identical writes — project saves fire often for unrelated reasons
        // (file opens, layout changes); avoids needless disk churn + git noise.
        const onDisk = await (0, files_1.readTextTolerant)(filePath);
        if (onDisk != null && (0, files_1.contentHash)(onDisk) === hash) {
            this.lastWrittenHash.set(filePath, hash);
            return { file: (0, files_1.domainToFile)(domain), strippedRefs, hash };
        }
        this.ignoreUntil.set(filePath, Date.now() + OWN_WRITE_IGNORE_MS);
        this.lastWrittenHash.set(filePath, hash);
        await (0, files_1.writeJsonAtomic)(filePath, text);
        return { file: (0, files_1.domainToFile)(domain), strippedRefs, hash };
    }
    /**
     * Snapshot the current workspace "opening" — the open terminals + LSP config —
     * as shareable agent presets. Captured by "Update from current app" so a
     * teammate cloning the repo can recreate the same terminal setup (review-gated).
     */
    collectAgents(project) {
        const terminals = (project.terminals || []).filter((t) => !t.isHidden);
        const presets = terminals.map((t) => ({
            id: t.id,
            name: t.name,
            agentType: t.agentType,
            ...(t.startupCommand ? { startupCommand: t.startupCommand } : {}),
            ...(t.cwd && t.cwd !== project.rootPath ? { cwd: t.cwd } : {}),
        }));
        const active = terminals.find((t) => t.isActive) ?? terminals[0];
        return {
            ...(active ? { defaultAgent: active.agentType } : {}),
            lsp: { enabled: project.lspEnabled ?? false, languages: project.lspLanguages ?? [] },
            presets,
        };
    }
    /** "Share project setup": write all core domains to the folder. */
    async export(projectId) {
        this.assertLicensed();
        const project = this.getProject(projectId);
        if (!project)
            throw new Error('project not found');
        const meta = this.deps.storeManager.getProjectSettingsMeta(projectId);
        if (!meta.enabled)
            this.deps.storeManager.setProjectSettingsMeta(projectId, { ...meta, enabled: true });
        return this.doExport(project);
    }
    async doExport(project) {
        await (0, gitignore_1.ensureSecretsGitignored)(project.rootPath);
        const written = [];
        const strippedSecrets = new Set();
        for (const domain of EXPORT_DOMAINS) {
            const payload = this.collectDomain(project, domain);
            if (!payload)
                continue;
            const { file, strippedRefs } = await this.writeDomainFile(project, domain, payload);
            written.push({ file, summary: (0, schema_1.summarize)(domain, payload) });
            strippedRefs.forEach((r) => strippedSecrets.add(r));
        }
        // Capture the current "opening" — open terminals + LSP — into agents.json.
        // It's executable, so record our own approval (you trust your own edits)
        // to keep it out of the author's review sheet.
        const agents = this.collectAgents(project);
        if (agents.presets.length || agents.lsp.enabled) {
            const { file, hash } = await this.writeDomainFile(project, 'agents', agents);
            written.push({ file, summary: (0, schema_1.summarize)('agents', agents) });
            const m = this.deps.storeManager.getProjectSettingsMeta(project.id);
            this.deps.storeManager.setProjectSettingsMeta(project.id, (0, trust_1.recordApproval)(m, file, hash));
        }
        const meta = this.deps.storeManager.getProjectSettingsMeta(project.id);
        this.deps.storeManager.setProjectSettingsMeta(project.id, { ...meta, lastExportAt: Date.now() });
        // Refresh the status cache so a follow-up getStatus doesn't return the
        // pre-export snapshot (getStatus returns the cache when present).
        await this.reconcile(project, false);
        return { written, strippedSecrets: [...strippedSecrets], folderPath: (0, files_1.settingsDir)(project.rootPath) };
    }
    // --- trust / approvals --------------------------------------------------
    async getPendingApprovals(projectId) {
        const project = this.getProject(projectId);
        if (!project)
            return [];
        return this.computePending(project);
    }
    async approve(projectId, files) {
        this.assertLicensed();
        const project = this.getProject(projectId);
        if (!project)
            throw new Error('project not found');
        let meta = this.deps.storeManager.getProjectSettingsMeta(projectId);
        for (const file of files) {
            const filePath = path_1.default.join((0, files_1.settingsDir)(project.rootPath), file);
            const text = file === 'skills' ? await this.hashSkillsDir(project.rootPath) : await (0, files_1.readTextTolerant)(filePath);
            if (text == null)
                continue;
            meta = (0, trust_1.recordApproval)(meta, file, (0, trust_1.fileContentHash)(text));
        }
        this.deps.storeManager.setProjectSettingsMeta(projectId, meta);
        return this.reconcile(project, true);
    }
    // --- status -------------------------------------------------------------
    async getStatus(projectId) {
        const project = this.getProject(projectId);
        if (!project) {
            const meta = this.deps.storeManager.getProjectSettingsMeta(projectId);
            return { enabled: meta.enabled, hasFolder: false, pendingApprovals: [], missingSecretRefs: [], lastError: null };
        }
        // First status request per session = project activation → adopt-on-open:
        // reconcile passive config folder → store and start watching for edits.
        if (!this.loadedProjects.has(projectId)) {
            return this.load(project);
        }
        const cached = this.statusCache.get(projectId);
        if (cached)
            return cached;
        return this.reconcile(project, false);
    }
    async reload(projectId) {
        this.assertLicensed();
        const project = this.getProject(projectId);
        if (!project)
            throw new Error('project not found');
        return this.reconcile(project, true);
    }
    async setSecret(projectId, ref, plaintext) {
        this.assertLicensed();
        const project = this.getProject(projectId);
        if (!project)
            throw new Error('project not found');
        await this.writeSecrets(project.rootPath, { [ref]: plaintext });
        return this.reconcile(project, true);
    }
    // --- core reconcile -----------------------------------------------------
    async reconcile(project, apply) {
        const meta = this.deps.storeManager.getProjectSettingsMeta(project.id);
        const hasFolder = await this.folderExists(project.rootPath);
        const status = {
            enabled: meta.enabled,
            hasFolder,
            pendingApprovals: [],
            missingSecretRefs: [],
            lastError: null,
        };
        if (!hasFolder) {
            this.statusCache.set(project.id, status);
            return status;
        }
        const resolver = this.makeResolver(project.rootPath);
        const errors = [];
        let workingProject = apply ? { ...project } : null;
        let projectMutated = false;
        const changedDomains = [];
        // Passive domains reconcile immediately.
        for (const domain of PASSIVE_DOMAINS) {
            const filePath = (0, files_1.domainFilePath)(project.rootPath, domain);
            const { value, error } = await (0, files_1.readJsonTolerant)(filePath);
            if (error)
                errors.push(error);
            if (!value)
                continue;
            const parsed = (0, schema_1.parseDomain)(domain, value);
            if (!parsed)
                continue;
            const { config, missingRefs } = (0, secretRefs_1.resolveSecrets)(domain, this.stripVersion(parsed), resolver);
            status.missingSecretRefs.push(...missingRefs);
            if (apply && workingProject) {
                const next = this.applyDomain(workingProject, domain, config);
                if (next) {
                    workingProject = next;
                    projectMutated = true;
                }
                changedDomains.push(domain);
            }
        }
        // Executable domains gate on approval.
        for (const domain of types_1.EXECUTABLE_PROJECT_SETTINGS_DOMAINS) {
            const { file, hash, text } = await this.readExecutable(project.rootPath, domain);
            if (text == null)
                continue;
            const summary = (0, schema_1.summarize)(domain, (0, schema_1.parseDomain)(domain, this.safeParse(text)) ?? {});
            if ((0, trust_1.isApproved)(meta, file, hash)) {
                if (apply) {
                    const next = this.applyExecutable(workingProject, project, domain, text);
                    if (next) {
                        workingProject = next;
                        projectMutated = true;
                    }
                    changedDomains.push(domain);
                }
            }
            else {
                status.pendingApprovals.push({ domain, file, hash, summary });
            }
        }
        if (apply && workingProject && projectMutated) {
            this.deps.storeManager.saveProject(workingProject);
        }
        status.lastError = errors.length ? errors[0] : null;
        if (meta.lastError !== status.lastError) {
            this.deps.storeManager.setProjectSettingsMeta(project.id, { ...meta, lastError: status.lastError });
        }
        this.statusCache.set(project.id, status);
        if (apply && changedDomains.length)
            this.pushChanged(project.id, changedDomains);
        return status;
    }
    async computePending(project) {
        const meta = this.deps.storeManager.getProjectSettingsMeta(project.id);
        const pending = [];
        for (const domain of types_1.EXECUTABLE_PROJECT_SETTINGS_DOMAINS) {
            const { file, hash, text } = await this.readExecutable(project.rootPath, domain);
            if (text == null)
                continue;
            if (!(0, trust_1.isApproved)(meta, file, hash)) {
                pending.push({ domain, file, hash, summary: (0, schema_1.summarize)(domain, (0, schema_1.parseDomain)(domain, this.safeParse(text)) ?? {}) });
            }
        }
        return pending;
    }
    // --- per-domain collect (store → payload) -------------------------------
    collectDomain(project, domain) {
        switch (domain) {
            case 'settings':
                return {
                    name: project.name,
                    color: project.color,
                    emoji: project.emoji,
                    layout: project.layout,
                    editorCommand: project.editorCommand,
                };
            case 'browser': {
                const browser = project.outputPanel?.browser;
                return {
                    url: browser?.url,
                    // Preserve every open tab and its order so a teammate reopens the same
                    // set of URLs, not just the single active view.
                    tabs: (browser?.tabs || []).map((t) => ({ id: t.id, url: t.url, title: t.title })),
                    activeTabId: browser?.activeTabId ?? null,
                    worktreeUrls: browser?.worktreeUrls,
                };
            }
            case 'database': {
                const db = project.outputPanel?.database;
                if (!db)
                    return { connections: [], activeConnectionId: null };
                return {
                    connections: (db.connections || []).filter((c) => c.scope !== 'global'),
                    activeConnectionId: db.activeConnectionId ?? null,
                };
            }
            case 'http':
                return {
                    tabs: this.deps.storeManager.getProjectHttpTabs(project.id),
                    environments: project.outputPanel?.http?.environments || [],
                    activeEnvironmentId: project.outputPanel?.http?.activeEnvironmentId ?? null,
                };
            case 'deploy': {
                const data = this.deps.deployStore.getProjectData(project.id);
                const hasToken = {
                    vercel: this.deps.deploySecretStore.getToken('vercel') != null,
                    cloudflare: this.deps.deploySecretStore.getToken('cloudflare') != null,
                };
                return { activeProvider: data.activeProvider, configs: data.configs, hasToken };
            }
            case 'env':
                return { activeFile: project.outputPanel?.env?.activeFile };
            default:
                return null;
        }
    }
    // --- per-domain apply (config → store) ----------------------------------
    /** Returns a mutated project clone (or null if the domain writes elsewhere). */
    applyDomain(project, domain, config) {
        const c = config;
        switch (domain) {
            case 'settings':
                return {
                    ...project,
                    name: c.name ?? project.name,
                    color: c.color ?? project.color,
                    emoji: c.emoji ?? project.emoji,
                    layout: c.layout ?? project.layout,
                    editorCommand: c.editorCommand ?? project.editorCommand,
                };
            case 'browser': {
                const browser = project.outputPanel.browser;
                const parsedTabs = Array.isArray(c.tabs) ? c.tabs : [];
                const hasTabs = parsedTabs.length > 0;
                return {
                    ...project,
                    outputPanel: {
                        ...project.outputPanel,
                        browser: {
                            ...browser,
                            url: c.url ?? browser.url,
                            // Only overwrite tabs when the folder actually carries some, so an
                            // older browser.json (no tabs) never wipes the live tab set.
                            tabs: hasTabs ? parsedTabs : browser.tabs,
                            activeTabId: hasTabs
                                ? (c.activeTabId ?? parsedTabs[0]?.id ?? null)
                                : browser.activeTabId,
                            worktreeUrls: c.worktreeUrls ?? browser.worktreeUrls,
                        },
                    },
                };
            }
            case 'database': {
                const cfg = config;
                const existing = project.outputPanel.database;
                const globals = (existing?.connections || []).filter((x) => x.scope === 'global');
                return {
                    ...project,
                    outputPanel: {
                        ...project.outputPanel,
                        database: {
                            connections: [...(cfg.connections || []), ...globals],
                            activeConnectionId: cfg.activeConnectionId ?? null,
                            query: existing?.query ?? 'select 1;',
                            history: existing?.history ?? [],
                            savedQueries: existing?.savedQueries,
                            sidebarWidth: existing?.sidebarWidth,
                            resultsHeight: existing?.resultsHeight,
                            railWidth: existing?.railWidth,
                            railCollapsed: existing?.railCollapsed,
                            activeSchema: existing?.activeSchema,
                        },
                    },
                };
            }
            case 'http': {
                const cfg = config;
                if (cfg.tabs)
                    this.deps.storeManager.setProjectHttpTabs(project.id, cfg.tabs);
                return {
                    ...project,
                    outputPanel: {
                        ...project.outputPanel,
                        http: {
                            ...project.outputPanel.http,
                            environments: cfg.environments || [],
                            activeEnvironmentId: cfg.activeEnvironmentId ?? null,
                        },
                    },
                };
            }
            case 'deploy': {
                const dep = config;
                for (const [provider, cfg] of Object.entries(dep.configs || {})) {
                    this.deps.deployStore.updateConfig(project.id, provider, cfg);
                }
                if (dep.activeProvider)
                    this.deps.deployStore.setActiveProvider(project.id, dep.activeProvider);
                return null; // deploy writes to its own store
            }
            case 'env': {
                const raw = c.activeFile;
                const valid = raw === '.env' || raw === '.env.local' || raw === '.env.production'
                    ? raw
                    : project.outputPanel.env?.activeFile ?? '.env.local';
                return {
                    ...project,
                    outputPanel: { ...project.outputPanel, env: { activeFile: valid } },
                };
            }
            case 'prompts':
            case 'layouts':
                return null; // folder-owned round-trip; no live store target in this pass
            default:
                return null;
        }
    }
    /** Apply an approved executable domain. Returns mutated project or null. */
    applyExecutable(workingProject, project, domain, text) {
        if (domain === 'agents') {
            const parsed = (0, schema_1.parseDomain)('agents', this.safeParse(text));
            if (parsed?.lsp && workingProject) {
                return {
                    ...workingProject,
                    lspEnabled: parsed.lsp.enabled,
                    lspLanguages: parsed.lsp.languages || [],
                };
            }
            return null;
        }
        if (domain === 'skills') {
            void this.installSkills(project).catch((err) => console.warn('[projectSettings] skill install failed:', err.message));
            return null;
        }
        // channels: folder-owned templates; surfaced but no live instance in this pass.
        return null;
    }
    async installSkills(project) {
        if (!this.deps.skillsManager)
            return;
        const dir = (0, files_1.skillsDirPath)(project.rootPath);
        let entries;
        try {
            entries = await fs_1.promises.readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const skillMd = path_1.default.join(dir, entry.name, 'SKILL.md');
            await this.deps.skillsManager.installSkill(project.rootPath, { name: entry.name, filePath: skillMd, source: 'local' }, 'claude');
        }
    }
    // --- secret bridge ------------------------------------------------------
    makeResolver(rootPath) {
        let cache = null;
        return (ref) => {
            if ((0, secretRefs_1.isDeployTokenRef)(ref)) {
                const provider = ref.split('.')[1];
                return this.deps.deploySecretStore.getToken(provider);
            }
            const session = this.sessionSecrets.get(ref);
            if (session != null)
                return session;
            if (!cache)
                cache = this.readSecretsFileSync(rootPath);
            const encrypted = cache[ref];
            if (encrypted == null)
                return null;
            if (!electron_1.safeStorage.isEncryptionAvailable())
                return null;
            try {
                return electron_1.safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
            }
            catch {
                return null;
            }
        };
    }
    readSecretsFileSync(rootPath) {
        // Synchronous read is acceptable here — the file is tiny and this runs
        // during reconcile, not on a hot path. Kept sync so the resolver closure
        // stays synchronous (secretRefs.resolveSecrets is sync).
        try {
            const raw = (0, fs_1.readFileSync)((0, files_1.secretsFilePath)(rootPath), 'utf8');
            const parsed = JSON.parse(raw);
            return parsed?.values || {};
        }
        catch {
            return {};
        }
    }
    async writeSecrets(rootPath, secrets) {
        const entries = Object.entries(secrets);
        if (!entries.length)
            return;
        await (0, gitignore_1.ensureSecretsGitignored)(rootPath);
        const filePath = (0, files_1.secretsFilePath)(rootPath);
        const existing = (await (0, files_1.readJsonTolerant)(filePath)).value;
        const values = { ...(existing?.values || {}) };
        let fileChanged = false;
        for (const [ref, plain] of entries) {
            if ((0, secretRefs_1.isDeployTokenRef)(ref)) {
                const provider = ref.split('.')[1];
                this.deps.deploySecretStore.setToken(provider, plain);
                continue;
            }
            if (electron_1.safeStorage.isEncryptionAvailable()) {
                values[ref] = electron_1.safeStorage.encryptString(plain).toString('base64');
                fileChanged = true;
            }
            else {
                // No OS keychain: keep the secret in-session only, never write plaintext.
                this.sessionSecrets.set(ref, plain);
            }
        }
        if (fileChanged) {
            await (0, files_1.writeJsonAtomic)(filePath, { version: types_1.PROJECT_SETTINGS_FILE_VERSION, values });
        }
    }
    // --- helpers ------------------------------------------------------------
    getProject(projectId) {
        return this.deps.storeManager.getProjects().find((p) => p.id === projectId) ?? null;
    }
    async folderExists(rootPath) {
        try {
            const stat = await fs_1.promises.stat((0, files_1.settingsDir)(rootPath));
            return stat.isDirectory();
        }
        catch {
            return false;
        }
    }
    stripVersion(parsed) {
        if (parsed && typeof parsed === 'object') {
            const { version: _v, ...rest } = parsed;
            return rest;
        }
        return parsed;
    }
    safeParse(text) {
        try {
            return JSON.parse(text);
        }
        catch {
            return null;
        }
    }
    /**
     * Is a trust-gated domain approved at its CURRENT content hash?
     *
     * For consumers that read their own file rather than going through the
     * store-reconcile path (Tasks policy, docs/tasks_v2.md §5.1). A missing file
     * counts as approved: there is nothing untrusted to hold, and the consumer's
     * own defaults apply.
     */
    async isDomainApproved(projectId, domain) {
        const project = this.getProject(projectId);
        if (!project)
            return false;
        const { file, hash, text } = await this.readExecutable(project.rootPath, domain);
        if (text == null)
            return true;
        return (0, trust_1.isApproved)(this.deps.storeManager.getProjectSettingsMeta(projectId), file, hash);
    }
    /**
     * Record approval for a domain the APP just wrote. An app-originated write is
     * trusted by construction; without this the user's own edit would come back
     * as untrusted input on the next read.
     */
    async recordDomainApproval(projectId, domain) {
        const project = this.getProject(projectId);
        if (!project)
            return;
        const { file, hash, text } = await this.readExecutable(project.rootPath, domain);
        if (text == null)
            return;
        const meta = this.deps.storeManager.getProjectSettingsMeta(projectId);
        this.deps.storeManager.setProjectSettingsMeta(projectId, (0, trust_1.recordApproval)(meta, file, hash));
    }
    async readExecutable(rootPath, domain) {
        if (domain === 'skills') {
            const text = await this.hashSkillsDir(rootPath);
            return { file: 'skills', hash: text ? (0, trust_1.fileContentHash)(text) : '', text };
        }
        const file = (0, files_1.domainToFile)(domain);
        const filePath = path_1.default.join((0, files_1.settingsDir)(rootPath), file);
        const text = await (0, files_1.readTextTolerant)(filePath);
        return { file, hash: text ? (0, trust_1.fileContentHash)(text) : '', text };
    }
    /** A stable digest of the skills/ tree (names + SKILL.md contents) for approval hashing. */
    async hashSkillsDir(rootPath) {
        const dir = (0, files_1.skillsDirPath)(rootPath);
        let entries;
        try {
            entries = await fs_1.promises.readdir(dir, { withFileTypes: true });
        }
        catch {
            return null;
        }
        const parts = [];
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (!entry.isDirectory())
                continue;
            const skillMd = await (0, files_1.readTextTolerant)(path_1.default.join(dir, entry.name, 'SKILL.md'));
            parts.push(`${entry.name}\n${skillMd ?? ''}`);
        }
        return parts.length ? parts.join('\n---\n') : null;
    }
    setLastError(projectId, message) {
        const meta = this.deps.storeManager.getProjectSettingsMeta(projectId);
        this.deps.storeManager.setProjectSettingsMeta(projectId, { ...meta, lastError: message });
        const cached = this.statusCache.get(projectId);
        if (cached)
            this.statusCache.set(projectId, { ...cached, lastError: message });
    }
    pushChanged(projectId, changedDomains) {
        const status = this.statusCache.get(projectId);
        if (!status)
            return;
        const payload = { projectId, changedDomains, status };
        this.deps.sendToRenderer('projectSettings:changed', payload);
    }
}
exports.ProjectSettingsManager = ProjectSettingsManager;
