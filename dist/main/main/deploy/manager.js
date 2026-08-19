"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeployManager = void 0;
const crypto_1 = require("crypto");
const secretStore_1 = require("./secretStore");
const vercel_1 = require("./providers/vercel");
const cloudflare_1 = require("./providers/cloudflare");
const build_1 = require("./build");
const scan_1 = require("./scan");
class DeployManager {
    deployStore;
    secretStore;
    projectStore;
    emitLog;
    running = new Map();
    constructor(deployStore, secretStore, projectStore, emitLog) {
        this.deployStore = deployStore;
        this.secretStore = secretStore;
        this.projectStore = projectStore;
        this.emitLog = emitLog;
    }
    getConfig(projectId) {
        return this.deployStore.getProjectData(projectId);
    }
    setConfig(projectId, provider, config) {
        return this.deployStore.updateConfig(projectId, provider, config);
    }
    list(projectId) {
        return this.deployStore.listHistory(projectId);
    }
    setToken(provider, token) {
        this.secretStore.setToken(provider, token);
        return { tokenLast4: (0, secretStore_1.tokenLast4)(token) };
    }
    testToken(request) {
        if (request.provider === 'vercel')
            return (0, vercel_1.testVercelToken)(request);
        return (0, cloudflare_1.testCloudflareToken)(request);
    }
    async scan(projectId) {
        const project = this.getProject(projectId);
        if (!project) {
            throw new Error('Project not found.');
        }
        return (0, scan_1.scanDeployProject)(project);
    }
    async start(request) {
        const project = this.getProject(request.projectId);
        if (!project) {
            throw new Error('Project not found.');
        }
        const data = request.config
            ? this.deployStore.updateConfig(project.id, request.provider, request.config)
            : this.deployStore.getProjectData(project.id);
        const config = data.configs[request.provider];
        const token = this.secretStore.getToken(request.provider);
        if (!token) {
            throw new Error(`No ${providerLabel(request.provider)} token saved. Test and save a token first.`);
        }
        const deployId = (0, crypto_1.randomUUID)();
        const startedAt = Date.now();
        let logLines = [];
        const controller = new AbortController();
        const record = {
            id: deployId,
            projectId: project.id,
            provider: request.provider,
            url: null,
            status: 'running',
            target: config.target,
            startedAt,
            finishedAt: null,
            logs: [],
            logsPath: null,
            error: null,
            providerDeployId: null,
        };
        this.running.set(deployId, { controller, record });
        this.deployStore.addOrUpdateRecord(project.id, record);
        const emit = (stream, message) => {
            const redacted = (0, build_1.redactValue)(message, [token]);
            logLines = [...logLines, ...redacted.split(/\r?\n/).filter(Boolean)].slice(-500);
            this.emitLog({
                deployId,
                projectId: project.id,
                provider: request.provider,
                stream,
                message: redacted,
                timestamp: Date.now(),
            });
        };
        emit('system', `Starting ${providerLabel(request.provider)} deploy for ${project.name}.\n`);
        try {
            const partial = request.provider === 'vercel'
                ? await (0, vercel_1.deployVercel)({ project, config, token, deployId, signal: controller.signal, onLog: emit })
                : await (0, cloudflare_1.deployCloudflare)({ project, config, token, deployId, signal: controller.signal, onLog: emit });
            const success = {
                ...record,
                ...partial,
                status: controller.signal.aborted ? 'cancelled' : 'success',
                finishedAt: Date.now(),
                logs: logLines,
                error: null,
            };
            this.deployStore.addOrUpdateRecord(project.id, success);
            emit('system', success.status === 'success' ? `Deploy finished${success.url ? `: ${success.url}` : ''}.\n` : 'Deploy cancelled.\n');
            return success;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const failed = {
                ...record,
                status: controller.signal.aborted ? 'cancelled' : 'error',
                finishedAt: Date.now(),
                logs: logLines,
                error: (0, build_1.redactValue)(message, [token]),
            };
            this.deployStore.addOrUpdateRecord(project.id, failed);
            emit('system', `${failed.status === 'cancelled' ? 'Deploy cancelled' : `Deploy failed: ${failed.error}`}.\n`);
            return failed;
        }
        finally {
            this.running.delete(deployId);
        }
    }
    cancel(deployId) {
        const running = this.running.get(deployId);
        if (!running)
            return { ok: false };
        running.controller.abort();
        return { ok: true };
    }
    getProject(projectId) {
        return this.projectStore.getProjects().find((project) => project.id === projectId) || null;
    }
}
exports.DeployManager = DeployManager;
function providerLabel(provider) {
    return provider === 'vercel' ? 'Vercel' : 'Cloudflare Pages';
}
