"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserAutomationService = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const types_1 = require("./types");
function clone(value) {
    return JSON.parse(JSON.stringify(value));
}
function safeArtifactSegment(value) {
    return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) || 'browser';
}
class BrowserAutomationService {
    provider;
    artifactRoot;
    leases = new Map();
    chains = new Map();
    started = false;
    reapTimer = null;
    constructor(provider, artifactRoot) {
        this.provider = provider;
        this.artifactRoot = artifactRoot;
    }
    async start() {
        if (this.started)
            return;
        await this.provider.start();
        this.started = true;
        this.reapTimer = setInterval(() => { void this.reapExpired(); }, 30_000);
        this.reapTimer.unref?.();
    }
    async stop() {
        if (this.reapTimer)
            clearInterval(this.reapTimer);
        this.reapTimer = null;
        const ids = [...this.leases.keys()];
        await Promise.allSettled(ids.map((leaseId) => this.closeContext(leaseId)));
        await this.provider.stop();
        this.started = false;
    }
    async createContext(scope, policy = {}) {
        await this.start();
        const leaseId = node_crypto_1.default.randomUUID();
        const capabilityToken = node_crypto_1.default.randomBytes(32).toString('base64url');
        const normalizedPolicy = {
            ...types_1.DEFAULT_BROWSER_AUTOMATION_POLICY,
            ...policy,
            maxPages: Math.min(Math.max(Math.floor(policy.maxPages ?? types_1.DEFAULT_BROWSER_AUTOMATION_POLICY.maxPages), 1), 32),
            maxArtifactBytes: Math.min(Math.max(Math.floor(policy.maxArtifactBytes ?? types_1.DEFAULT_BROWSER_AUTOMATION_POLICY.maxArtifactBytes), 1), 100 * 1024 * 1024),
            leaseTtlMs: Math.min(Math.max(Math.floor(policy.leaseTtlMs ?? types_1.DEFAULT_BROWSER_AUTOMATION_POLICY.leaseTtlMs), 10_000), 24 * 60 * 60_000),
        };
        const owner = scope.kind === 'run' ? scope.runId : scope.kind === 'session' ? scope.sessionId : scope.projectId;
        const artifactDir = node_path_1.default.join(this.artifactRoot, safeArtifactSegment(owner), leaseId);
        node_fs_1.default.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
        const now = Date.now();
        const lease = {
            leaseId,
            capabilityToken,
            scope: clone(scope),
            providerId: this.provider.id,
            artifactDir,
            createdAt: now,
            expiresAt: now + normalizedPolicy.leaseTtlMs,
            state: 'active',
            pageIds: [],
            policy: normalizedPolicy,
        };
        // Journal ownership before creating provider resources. A failed create
        // leaves a diagnosable dead lease rather than an unowned browser context.
        this.leases.set(leaseId, lease);
        try {
            await this.provider.createContext({ contextId: leaseId, downloadsPath: node_path_1.default.join(artifactDir, 'downloads') });
            return this.publicLease(lease);
        }
        catch (error) {
            lease.state = 'dead';
            lease.error = error instanceof Error ? error.message : String(error);
            throw error;
        }
    }
    list(scope) {
        return [...this.leases.values()]
            .filter((lease) => !scope || Object.entries(scope).every(([key, value]) => lease.scope[key] === value))
            .map((lease) => this.publicLease(lease));
    }
    async perform(leaseId, capabilityToken, operation) {
        const lease = this.authorize(leaseId, capabilityToken);
        return this.serialized(leaseId, async () => {
            if (lease.state !== 'active')
                return { ok: false, error: `Browser context is ${lease.state}` };
            if (Date.now() >= lease.expiresAt) {
                try {
                    await this.provider.closeContext(leaseId);
                }
                finally {
                    lease.state = 'closed';
                    lease.pageIds = [];
                }
                return { ok: false, error: 'Browser context lease expired' };
            }
            const policyError = this.policyError(lease, operation);
            if (policyError)
                return { ok: false, error: policyError };
            if (operation.type === 'page-create') {
                if (lease.pageIds.length >= lease.policy.maxPages)
                    return { ok: false, error: 'Browser page limit reached' };
                const pageId = node_crypto_1.default.randomUUID();
                await this.provider.createPage(leaseId, pageId);
                lease.pageIds.push(pageId);
                return { ok: true, pageId };
            }
            if ('pageId' in operation && !lease.pageIds.includes(operation.pageId)) {
                return { ok: false, error: 'Page does not belong to this browser lease' };
            }
            if (operation.type === 'page-close') {
                await this.provider.closePage(leaseId, operation.pageId);
                lease.pageIds = lease.pageIds.filter((id) => id !== operation.pageId);
                return { ok: true };
            }
            const result = await this.provider.perform(leaseId, operation, lease.artifactDir);
            if (result.artifactPath && !this.isInside(lease.artifactDir, result.artifactPath)) {
                return { ok: false, error: 'Browser provider returned an artifact outside the run directory' };
            }
            if (this.directoryBytes(lease.artifactDir) > lease.policy.maxArtifactBytes) {
                return { ok: false, error: 'Browser artifact cap exceeded' };
            }
            return result;
        });
    }
    async closeContext(leaseId, capabilityToken) {
        const lease = capabilityToken ? this.authorize(leaseId, capabilityToken) : this.leases.get(leaseId);
        if (!lease || lease.state === 'closed')
            return;
        await this.serialized(leaseId, async () => {
            if (lease.state === 'closed')
                return;
            try {
                await this.provider.closeContext(leaseId);
            }
            finally {
                lease.state = 'closed';
                lease.pageIds = [];
            }
        });
        this.chains.delete(leaseId);
    }
    markProviderCrashed(error) {
        for (const lease of this.leases.values()) {
            if (lease.state !== 'active')
                continue;
            lease.state = 'dead';
            lease.error = error;
            lease.pageIds = [];
        }
    }
    authorize(leaseId, capabilityToken) {
        const lease = this.leases.get(leaseId);
        if (!lease)
            throw new Error('Unknown browser lease');
        const expected = Buffer.from(lease.capabilityToken);
        const supplied = Buffer.from(capabilityToken);
        if (expected.length !== supplied.length || !node_crypto_1.default.timingSafeEqual(expected, supplied)) {
            throw new Error('Browser lease capability is invalid');
        }
        return lease;
    }
    policyError(lease, operation) {
        if (operation.type === 'navigate') {
            let url;
            try {
                url = new URL(operation.url);
            }
            catch {
                return 'Navigation URL is invalid';
            }
            if (url.protocol !== 'http:' && url.protocol !== 'https:')
                return 'Only HTTP(S) browser navigation is allowed';
            const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
            if (!local && !lease.policy.allowExternalNetwork)
                return 'External browser navigation is disabled for this lease';
            if (lease.policy.allowedHosts?.length && !lease.policy.allowedHosts.includes(url.hostname))
                return 'Navigation host is outside the lease allowlist';
        }
        if (operation.type === 'upload') {
            if (!lease.policy.allowUploads)
                return 'Browser uploads require explicit authorization';
            if (operation.paths.some((file) => !this.isRealFileInside(lease.scope.workspacePath, file))) {
                return 'Uploads must resolve to files inside the workspace';
            }
        }
        return null;
    }
    serialized(leaseId, operation) {
        const previous = this.chains.get(leaseId) ?? Promise.resolve();
        const next = previous.catch(() => { }).then(operation);
        this.chains.set(leaseId, next);
        return next.finally(() => {
            if (this.chains.get(leaseId) === next)
                this.chains.delete(leaseId);
        });
    }
    async reapExpired() {
        const expired = [...this.leases.values()].filter((lease) => lease.state === 'active' && Date.now() >= lease.expiresAt);
        await Promise.allSettled(expired.map((lease) => this.closeContext(lease.leaseId)));
    }
    publicLease(lease) {
        return clone(lease);
    }
    isInside(root, target) {
        const relative = node_path_1.default.relative(node_path_1.default.resolve(root), node_path_1.default.resolve(target));
        return relative === '' || (!relative.startsWith('..') && !node_path_1.default.isAbsolute(relative));
    }
    isRealFileInside(root, target) {
        try {
            const canonicalRoot = node_fs_1.default.realpathSync(root);
            const canonicalTarget = node_fs_1.default.realpathSync(target);
            return node_fs_1.default.statSync(canonicalTarget).isFile() && this.isInside(canonicalRoot, canonicalTarget);
        }
        catch {
            return false;
        }
    }
    directoryBytes(dir) {
        let total = 0;
        const stack = [dir];
        while (stack.length > 0 && total <= 100 * 1024 * 1024) {
            const current = stack.pop();
            let entries;
            try {
                entries = node_fs_1.default.readdirSync(current, { withFileTypes: true });
            }
            catch {
                continue;
            }
            for (const entry of entries) {
                const item = node_path_1.default.join(current, entry.name);
                if (entry.isDirectory())
                    stack.push(item);
                else if (entry.isFile()) {
                    try {
                        total += node_fs_1.default.statSync(item).size;
                    }
                    catch { /* raced cleanup */ }
                }
            }
        }
        return total;
    }
}
exports.BrowserAutomationService = BrowserAutomationService;
