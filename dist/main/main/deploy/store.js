"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeployStore = void 0;
const electron_store_1 = __importDefault(require("electron-store"));
const SCHEMA_VERSION = 1;
const HISTORY_LIMIT = 25;
const DEFAULT_CONFIGS = {
    vercel: {
        provider: 'vercel',
        vercelScopeMode: 'auto',
        nodeVersion: '',
        target: 'preview',
        buildCommand: '',
        outputDir: '',
        deployCwd: '',
        envVars: [],
        teamId: '',
        projectId: '',
    },
    cloudflare: {
        provider: 'cloudflare',
        target: 'preview',
        buildCommand: '',
        outputDir: '',
        deployCwd: '',
        envVars: [],
        accountId: '',
        projectName: '',
        branch: '',
        productionBranch: 'main',
    },
};
class DeployStore {
    store;
    constructor() {
        this.store = new electron_store_1.default({
            name: '1devtool',
            defaults: {
                deploy: {},
            },
        });
    }
    getProjectData(projectId) {
        const all = this.store.get('deploy') || {};
        return normalizeProjectData(all[projectId]);
    }
    setActiveProvider(projectId, provider) {
        const data = this.getProjectData(projectId);
        const next = { ...data, activeProvider: provider };
        this.saveProjectData(projectId, next);
        return next;
    }
    updateConfig(projectId, provider, config) {
        const data = this.getProjectData(projectId);
        const current = data.configs[provider] || DEFAULT_CONFIGS[provider];
        const nextConfig = normalizeConfig(provider, {
            ...current,
            ...config,
            provider,
        });
        const next = {
            ...data,
            activeProvider: provider,
            configs: {
                ...data.configs,
                [provider]: nextConfig,
            },
        };
        this.saveProjectData(projectId, next);
        return next;
    }
    listHistory(projectId) {
        return this.getProjectData(projectId).history;
    }
    addOrUpdateRecord(projectId, record) {
        const data = this.getProjectData(projectId);
        const withoutExisting = data.history.filter((item) => item.id !== record.id);
        const history = [record, ...withoutExisting]
            .sort((a, b) => b.startedAt - a.startedAt)
            .slice(0, HISTORY_LIMIT);
        const next = {
            ...data,
            history,
        };
        this.saveProjectData(projectId, next);
        return next;
    }
    saveProjectData(projectId, data) {
        const all = this.store.get('deploy') || {};
        this.store.set('deploy', {
            ...all,
            [projectId]: normalizeProjectData(data),
        });
    }
}
exports.DeployStore = DeployStore;
function normalizeProjectData(raw) {
    const activeProvider = isProvider(raw?.activeProvider) ? raw.activeProvider : 'vercel';
    const configs = {
        vercel: normalizeConfig('vercel', raw?.configs?.vercel),
        cloudflare: normalizeConfig('cloudflare', raw?.configs?.cloudflare),
    };
    return {
        schemaVersion: SCHEMA_VERSION,
        activeProvider,
        configs,
        history: Array.isArray(raw?.history) ? raw.history.map(normalizeRecord).filter(Boolean).slice(0, HISTORY_LIMIT) : [],
    };
}
function normalizeConfig(provider, raw) {
    const defaults = DEFAULT_CONFIGS[provider];
    return {
        ...defaults,
        ...raw,
        provider,
        vercelScopeMode: normalizeScopeMode(raw?.vercelScopeMode),
        nodeVersion: normalizeOptionalString(raw?.nodeVersion),
        target: raw?.target === 'production' ? 'production' : 'preview',
        buildCommand: normalizeOptionalString(raw?.buildCommand),
        outputDir: normalizeOptionalString(raw?.outputDir),
        deployCwd: normalizeOptionalString(raw?.deployCwd),
        envVars: Array.isArray(raw?.envVars) ? raw.envVars.filter((item) => item.key?.trim()).map((item) => ({
            key: item.key.trim(),
            value: item.value ?? '',
        })) : [],
        teamId: normalizeOptionalString(raw?.teamId),
        projectId: normalizeOptionalString(raw?.projectId),
        accountId: normalizeOptionalString(raw?.accountId),
        projectName: normalizeOptionalString(raw?.projectName),
        branch: normalizeOptionalString(raw?.branch),
        productionBranch: normalizeOptionalString(raw?.productionBranch) || defaults.productionBranch,
        tokenLast4: normalizeOptionalString(raw?.tokenLast4),
        tokenVerifiedAt: typeof raw?.tokenVerifiedAt === 'number' ? raw.tokenVerifiedAt : undefined,
        tokenIdentityLabel: normalizeOptionalString(raw?.tokenIdentityLabel),
        tokenHash: normalizeOptionalString(raw?.tokenHash),
    };
}
function normalizeRecord(raw) {
    if (!raw || typeof raw.id !== 'string' || !isProvider(raw.provider))
        return null;
    return {
        id: raw.id,
        projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
        provider: raw.provider,
        url: typeof raw.url === 'string' ? raw.url : null,
        status: ['running', 'success', 'error', 'cancelled'].includes(raw.status) ? raw.status : 'error',
        target: raw.target === 'production' ? 'production' : 'preview',
        startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : Date.now(),
        finishedAt: typeof raw.finishedAt === 'number' ? raw.finishedAt : null,
        logsPath: typeof raw.logsPath === 'string' ? raw.logsPath : null,
        logs: Array.isArray(raw.logs) ? raw.logs.slice(-500) : [],
        error: typeof raw.error === 'string' ? raw.error : null,
        providerDeployId: typeof raw.providerDeployId === 'string' ? raw.providerDeployId : null,
    };
}
function isProvider(value) {
    return value === 'vercel' || value === 'cloudflare';
}
function normalizeOptionalString(value) {
    return typeof value === 'string' ? value.trim() : '';
}
function normalizeScopeMode(value) {
    return value === 'personal' || value === 'team' ? value : 'auto';
}
