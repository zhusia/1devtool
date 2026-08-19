"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppConfigTransferService = void 0;
const electron_1 = require("electron");
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const appConfigTransfer_1 = require("../../shared/appConfigTransfer");
const projectPersistence_1 = require("../../shared/projectPersistence");
const themes_1 = require("../../shared/themes");
const store_1 = require("../store");
const LicenseService_1 = require("./LicenseService");
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
async function pathExists(targetPath, requireDirectory = false) {
    try {
        const stats = await fs_1.promises.stat(targetPath);
        return requireDirectory ? stats.isDirectory() : true;
    }
    catch {
        return false;
    }
}
function getAbsoluteCommandPath(command) {
    const trimmed = command?.trim();
    if (!trimmed)
        return null;
    if (trimmed.startsWith('"') || trimmed.startsWith('\'')) {
        const quote = trimmed[0];
        const end = trimmed.indexOf(quote, 1);
        if (end > 1) {
            const candidate = trimmed.slice(1, end);
            return path_1.default.isAbsolute(candidate) ? candidate : null;
        }
    }
    const candidate = trimmed.split(/\s+/, 1)[0];
    return path_1.default.isAbsolute(candidate) ? candidate : null;
}
function compareVersionStrings(left, right) {
    const leftParts = left.split(/[.-]/).map((part) => Number.parseInt(part, 10)).filter((part) => Number.isFinite(part));
    const rightParts = right.split(/[.-]/).map((part) => Number.parseInt(part, 10)).filter((part) => Number.isFinite(part));
    const maxLength = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < maxLength; index += 1) {
        const l = leftParts[index] ?? 0;
        const r = rightParts[index] ?? 0;
        if (l > r)
            return 1;
        if (l < r)
            return -1;
    }
    return 0;
}
// Strip every provider token (GitHub + GitLab) before export. `gitlabInstanceUrl`
// is intentionally kept — it is not a secret and is useful to carry across
// machines so a re-imported account still points at the right GitLab instance.
function stripProviderTokens(account) {
    const { githubToken: _githubToken, gitlabToken: _gitlabToken, ...rest } = account;
    return rest;
}
function sanitizeSshProjectForExport(ssh) {
    if (!ssh)
        return undefined;
    return {
        connectionId: ssh.connectionId,
        label: ssh.label,
        host: ssh.host,
        port: ssh.port,
        username: ssh.username,
        remotePath: ssh.remotePath,
        privateKeyPath: ssh.privateKeyPath,
        uri: ssh.uri,
    };
}
function sanitizeProjectForExport(project) {
    const sourceType = project.sourceType ?? 'local';
    const ssh = sanitizeSshProjectForExport(project.ssh);
    const rootPath = sourceType === 'ssh' ? ssh?.uri ?? project.rootPath : project.rootPath;
    return {
        id: project.id,
        name: project.name,
        color: project.color,
        ...(project.avatar ? { avatar: project.avatar } : {}),
        ...(project.emoji ? { emoji: project.emoji } : {}),
        ...(project.editorCommand ? { editorCommand: project.editorCommand } : {}),
        createdAt: project.createdAt,
        sourceType,
        rootPath,
        ...(ssh ? { ssh } : {}),
        gitAccountId: project.gitAccountId ?? null,
        quickCommands: project.quickCommands ?? [],
        layout: project.layout,
        ...(project.worktreeColors ? { worktreeColors: project.worktreeColors } : {}),
        ...(project.lspEnabled !== undefined ? { lspEnabled: project.lspEnabled } : {}),
        ...(project.lspLanguages ? { lspLanguages: project.lspLanguages } : {}),
    };
}
function sanitizePreferencesForTransfer(preferences) {
    return (0, store_1.normalizePreferences)({
        ...preferences,
        git: {
            ...preferences.git,
            accounts: (preferences.git.accounts ?? []).map(stripProviderTokens),
        },
        languages: {
            ...preferences.languages,
            installPaths: {},
            installedVersions: {},
        },
        updates: {
            ...preferences.updates,
            skippedVersion: null,
        },
    });
}
function sanitizeSshConnection(connection) {
    return {
        ...connection,
        privateKeyPath: connection.privateKeyPath?.trim() || undefined,
    };
}
function sanitizeProjectGroupRecord(groups, validProjectIds) {
    const next = {};
    for (const [groupId, group] of Object.entries(groups)) {
        next[groupId] = {
            ...group,
            projectIds: (group.projectIds ?? []).filter((projectId) => validProjectIds.has(projectId)),
        };
    }
    return next;
}
function normalizeProjectOrder(order, validProjectIds, fallbackProjects) {
    const next = order.filter((projectId) => validProjectIds.has(projectId));
    for (const project of fallbackProjects) {
        if (!next.includes(project.id))
            next.push(project.id);
    }
    return next;
}
function normalizeGroupOrder(order, groups) {
    const next = order.filter((groupId) => groups[groupId]);
    for (const groupId of Object.keys(groups)) {
        if (!next.includes(groupId))
            next.push(groupId);
    }
    return next;
}
function makeIssue(level, code, message, details = {}) {
    return {
        level,
        code,
        message,
        ...details,
    };
}
function extractSummary(parsed) {
    if (!isRecord(parsed) || !isRecord(parsed.exportedFrom))
        return null;
    const schemaVersion = typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : 0;
    const exportedAt = typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '';
    const appVersion = typeof parsed.exportedFrom.appVersion === 'string' ? parsed.exportedFrom.appVersion : 'unknown';
    const platform = typeof parsed.exportedFrom.platform === 'string'
        ? parsed.exportedFrom.platform
        : process.platform;
    return {
        schemaVersion,
        exportedAt,
        exportedFrom: {
            appVersion,
            platform,
        },
    };
}
function ensureProAccess(action) {
    if (!LicenseService_1.licenseService.getLicenseInfo().isLicensed) {
        throw new Error(`A PRO license is required to ${action} app configuration.`);
    }
}
class AppConfigTransferService {
    storeManager;
    constructor(storeManager) {
        this.storeManager = storeManager;
    }
    buildExportBundle() {
        ensureProAccess('export');
        const preferences = sanitizePreferencesForTransfer(this.storeManager.getPreferences());
        const projects = this.storeManager.getProjects().map(sanitizeProjectForExport);
        const validProjectIds = new Set(projects.map((project) => project.id));
        const projectGroups = sanitizeProjectGroupRecord((this.storeManager.get('projectGroups') ?? {}), validProjectIds);
        // Same sanitize as import (D8): exported workspaces reference only
        // projects/groups that are actually in this bundle.
        const workspaceState = (0, appConfigTransfer_1.sanitizeImportedWorkspaceState)({
            workspaces: (this.storeManager.get('workspaces') ?? {}),
            workspaceOrder: (this.storeManager.get('workspaceOrder') ?? []),
            projectWorkspacePreference: this.storeManager.getProjectWorkspacePreference(),
        }, validProjectIds, new Set(Object.keys(projectGroups)));
        return {
            schemaVersion: appConfigTransfer_1.APP_CONFIG_TRANSFER_SCHEMA_VERSION,
            exportedAt: new Date().toISOString(),
            exportedFrom: {
                appVersion: electron_1.app.getVersion(),
                platform: process.platform,
            },
            payload: {
                preferences,
                projects,
                projectOrder: normalizeProjectOrder(this.storeManager.getProjectOrder(), validProjectIds, projects),
                projectGroups,
                projectGroupOrder: normalizeGroupOrder((this.storeManager.get('projectGroupOrder') ?? []), projectGroups),
                customThemes: this.storeManager.getCustomThemes(),
                obsidianVaultPath: this.storeManager.getObsidianVaultPath(),
                workspaces: workspaceState.workspaces,
                workspaceOrder: workspaceState.workspaceOrder,
                projectWorkspacePreference: workspaceState.projectWorkspacePreference,
            },
        };
    }
    async exportToJson() {
        return JSON.stringify(this.buildExportBundle(), null, 2);
    }
    async previewImport(filePath) {
        const replacementCounts = {
            customThemes: this.storeManager.getCustomThemes().length,
            gitAccounts: this.storeManager.getPreferences().git.accounts.length,
        };
        try {
            ensureProAccess('import');
        }
        catch (error) {
            return {
                filePath,
                summary: null,
                counts: { projects: 0, groups: 0, themes: 0 },
                replacementCounts,
                projects: [],
                warnings: [],
                errors: [makeIssue('error', 'pro-required', error instanceof Error ? error.message : String(error))],
            };
        }
        let parsed;
        try {
            parsed = JSON.parse(await fs_1.promises.readFile(filePath, 'utf8'));
        }
        catch (error) {
            return {
                filePath,
                summary: null,
                counts: { projects: 0, groups: 0, themes: 0 },
                replacementCounts,
                projects: [],
                warnings: [],
                errors: [makeIssue('error', 'invalid-json', error instanceof Error ? error.message : 'Failed to read import file.')],
            };
        }
        const summary = extractSummary(parsed);
        let bundle;
        try {
            bundle = (0, appConfigTransfer_1.validateTransferBundle)(parsed);
        }
        catch (error) {
            return {
                filePath,
                summary,
                counts: { projects: 0, groups: 0, themes: 0 },
                replacementCounts,
                projects: [],
                warnings: [],
                errors: [makeIssue('error', 'invalid-schema', error instanceof Error ? error.message : 'Invalid import file.')],
            };
        }
        const warnings = [];
        const normalizedPreferences = sanitizePreferencesForTransfer(bundle.payload.preferences);
        const projects = [];
        for (const project of bundle.payload.projects) {
            const resolvedRootPath = project.sourceType === 'ssh'
                ? project.ssh?.uri ?? project.rootPath
                : project.rootPath;
            const exists = project.sourceType === 'ssh'
                ? true
                : await pathExists(resolvedRootPath, true);
            projects.push({
                id: project.id,
                name: project.name,
                sourceType: project.sourceType,
                rootPath: project.rootPath,
                resolvedRootPath,
                exists,
                requiresPathAction: project.sourceType === 'local' && !exists,
            });
            const editorCommandPath = getAbsoluteCommandPath(project.editorCommand);
            if (editorCommandPath && !(await pathExists(editorCommandPath))) {
                warnings.push(makeIssue('warning', 'missing-editor-command', `Project "${project.name}" references an editor command path that does not exist on this machine.`, { projectId: project.id, projectName: project.name, path: editorCommandPath }));
            }
        }
        for (const font of normalizedPreferences.appearance.customFonts) {
            if (!(await pathExists(font.path))) {
                warnings.push(makeIssue('warning', 'missing-custom-font', `Custom font "${font.name}" does not exist on this machine.`, { path: font.path }));
            }
        }
        for (const account of normalizedPreferences.git.accounts) {
            if (account.sshKeyPath && !(await pathExists(account.sshKeyPath))) {
                warnings.push(makeIssue('warning', 'missing-git-ssh-key', `Git account "${account.label}" references an SSH key that does not exist on this machine.`, { path: account.sshKeyPath }));
            }
        }
        for (const connection of normalizedPreferences.ssh.connections.map(sanitizeSshConnection)) {
            if (connection.privateKeyPath && !(await pathExists(connection.privateKeyPath))) {
                warnings.push(makeIssue('warning', 'missing-ssh-private-key', `SSH connection "${connection.label}" references a private key that does not exist on this machine.`, { path: connection.privateKeyPath }));
            }
        }
        for (const [agentType, rootPath] of Object.entries(normalizedPreferences.aiAgentPaths)) {
            if (rootPath && !(await pathExists(rootPath, true))) {
                warnings.push(makeIssue('warning', 'missing-ai-agent-path', `AI agent path for ${agentType} does not exist on this machine.`, { path: rootPath }));
            }
        }
        if (bundle.payload.obsidianVaultPath && !(await pathExists(bundle.payload.obsidianVaultPath, true))) {
            warnings.push(makeIssue('warning', 'missing-obsidian-vault', 'The configured Obsidian vault path does not exist on this machine.', { path: bundle.payload.obsidianVaultPath }));
        }
        if (summary?.exportedFrom.appVersion) {
            const currentVersion = electron_1.app.getVersion();
            if (compareVersionStrings(summary.exportedFrom.appVersion, currentVersion) > 0) {
                warnings.push(makeIssue('warning', 'newer-app-version', `This config file was exported from 1DevTool ${summary.exportedFrom.appVersion}, which is newer than this app (${currentVersion}).`));
            }
        }
        return {
            filePath,
            summary,
            counts: {
                projects: bundle.payload.projects.length,
                groups: Object.keys(bundle.payload.projectGroups).length,
                themes: bundle.payload.customThemes.length,
            },
            replacementCounts,
            projects,
            warnings,
            errors: [],
        };
    }
    async applyImport(request) {
        ensureProAccess('import');
        const parsed = JSON.parse(await fs_1.promises.readFile(request.filePath, 'utf8'));
        const bundle = (0, appConfigTransfer_1.validateTransferBundle)(parsed);
        const preferences = sanitizePreferencesForTransfer(bundle.payload.preferences);
        const customThemes = bundle.payload.customThemes;
        const validThemeIds = new Set(customThemes.map((theme) => theme.id));
        const themeId = preferences.appearance.theme;
        if (themeId !== 'system' && !(0, themes_1.getThemeById)(themeId) && !validThemeIds.has(themeId)) {
            preferences.appearance.theme = 'dark';
        }
        const normalizedPreferences = (0, store_1.normalizePreferences)(preferences);
        const validGitAccountIds = new Set(normalizedPreferences.git.accounts.map((account) => account.id));
        const importedProjects = [];
        let skippedProjects = 0;
        for (const project of bundle.payload.projects) {
            const decision = request.projectDecisions[project.id] ?? { action: 'import' };
            if (decision.action === 'skip') {
                skippedProjects += 1;
                continue;
            }
            const sourceType = project.sourceType;
            const ssh = project.ssh
                ? {
                    ...project.ssh,
                    privateKeyPath: project.ssh.privateKeyPath?.trim() || undefined,
                }
                : undefined;
            const rootPath = sourceType === 'ssh'
                ? ssh?.uri ?? project.rootPath
                : (decision.rootPath?.trim() || project.rootPath);
            if (sourceType === 'local') {
                const exists = await pathExists(rootPath, true);
                if (!exists) {
                    throw new Error(`Project "${project.name}" points to a folder that does not exist: ${rootPath}`);
                }
            }
            importedProjects.push((0, projectPersistence_1.createPersistedProject)({
                id: project.id,
                name: project.name,
                rootPath,
                sourceType,
                ssh,
                color: project.color,
                avatar: project.avatar,
                emoji: project.emoji,
                editorCommand: project.editorCommand,
                createdAt: project.createdAt,
                gitAccountId: project.gitAccountId && validGitAccountIds.has(project.gitAccountId)
                    ? project.gitAccountId
                    : null,
                quickCommands: project.quickCommands ?? [],
                layout: project.layout,
                worktreeColors: project.worktreeColors,
                lspEnabled: project.lspEnabled,
                lspLanguages: project.lspLanguages,
                preferences: normalizedPreferences,
            }));
        }
        const validProjectIds = new Set(importedProjects.map((project) => project.id));
        const projectOrder = normalizeProjectOrder(bundle.payload.projectOrder, validProjectIds, bundle.payload.projects.filter((project) => validProjectIds.has(project.id)));
        // Break parentId cycles BEFORE the record can reach the store or any
        // resolve walk (D8/D9) — V1 exports can carry them too.
        const { groups: acyclicGroups } = (0, appConfigTransfer_1.breakGroupParentCycles)(bundle.payload.projectGroups);
        const projectGroups = sanitizeProjectGroupRecord(acyclicGroups, validProjectIds);
        const projectGroupOrder = normalizeGroupOrder(bundle.payload.projectGroupOrder, projectGroups);
        const workspaceState = (0, appConfigTransfer_1.sanitizeImportedWorkspaceState)({
            workspaces: bundle.payload.workspaces,
            workspaceOrder: bundle.payload.workspaceOrder,
            projectWorkspacePreference: bundle.payload.projectWorkspacePreference,
        }, validProjectIds, new Set(Object.keys(projectGroups)));
        this.storeManager.set('projects', Object.fromEntries(importedProjects.map((project) => [project.id, project])));
        this.storeManager.setProjectOrder(projectOrder);
        this.storeManager.set('projectGroups', projectGroups);
        this.storeManager.setProjectGroupOrder(projectGroupOrder);
        this.storeManager.set('workspaces', workspaceState.workspaces);
        this.storeManager.setWorkspaceOrder(workspaceState.workspaceOrder);
        this.storeManager.set('projectWorkspacePreference', workspaceState.projectWorkspacePreference);
        this.storeManager.set('customThemes', customThemes);
        this.storeManager.setObsidianVaultPath(bundle.payload.obsidianVaultPath);
        this.storeManager.setPreferences(normalizedPreferences);
        this.storeManager.setActiveProjectId(null);
        return {
            ok: true,
            importedProjects: importedProjects.length,
            skippedProjects,
        };
    }
}
exports.AppConfigTransferService = AppConfigTransferService;
