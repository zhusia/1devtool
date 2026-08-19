"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HarnessRegistry = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const runtimePolicy_1 = require("../../../shared/orchestration/runtimePolicy");
function emptyCache() {
    return { version: 1, entries: {} };
}
function cacheKey(harness, detection) {
    return node_crypto_1.default.createHash('sha256').update(JSON.stringify({
        harnessId: harness.id,
        adapterVersion: harness.adapterVersion,
        binaryPath: detection.binaryPath ?? '',
        binaryVersion: detection.version ?? '',
    })).digest('hex');
}
class HarnessRegistry {
    probeCachePath;
    harnesses = new Map();
    cache = null;
    constructor(probeCachePath) {
        this.probeCachePath = probeCachePath;
    }
    register(harness) {
        if (this.harnesses.has(harness.id))
            throw new Error(`Harness ${harness.id} is already registered`);
        this.harnesses.set(harness.id, harness);
    }
    unregister(harnessId) {
        this.harnesses.delete(harnessId);
    }
    get(harnessId) {
        return this.harnesses.get(harnessId) ?? null;
    }
    list(agentId) {
        return [...this.harnesses.values()].filter((harness) => !agentId || harness.agentId === agentId);
    }
    async detect(agentId) {
        return Promise.all(this.list(agentId).map(async (harness) => ({
            harness,
            detection: await harness.detect({ agentId: harness.agentId }),
        })));
    }
    async probe(harnessId, force = false) {
        const harness = this.get(harnessId);
        if (!harness)
            throw new Error(`Unknown harness ${harnessId}`);
        const detection = await harness.detect({ agentId: harness.agentId });
        const key = cacheKey(harness, detection);
        const cache = this.loadCache();
        if (!force && cache.entries[key])
            return cache.entries[key];
        if (!detection.available) {
            const failed = {
                state: 'failed',
                capabilities: {},
                checkedAt: Date.now(),
                binaryPath: detection.binaryPath,
                binaryVersion: detection.version,
                adapterVersion: harness.adapterVersion,
                fingerprint: key,
                reason: detection.reason ?? 'Adapter binary is unavailable',
            };
            cache.entries[key] = failed;
            this.saveCache();
            return failed;
        }
        const result = await harness.probe({
            agentId: harness.agentId,
            binaryPath: detection.binaryPath,
            binaryVersion: detection.version,
            timeoutMs: 30_000,
        });
        const normalized = { ...result, fingerprint: key };
        cache.entries[key] = normalized;
        this.saveCache();
        return normalized;
    }
    async resolve(agentId, preference, requirements = {}) {
        const rows = await this.detect(agentId);
        const cache = this.loadCache();
        const candidates = rows.map(({ harness, detection }, index) => {
            const probe = cache.entries[cacheKey(harness, detection)];
            return {
                harnessId: harness.id,
                agentId: harness.agentId,
                declared: harness.declaredCapabilities,
                verified: probe?.capabilities,
                probeState: probe?.state ?? 'unknown',
                available: detection.available,
                priority: index,
            };
        });
        return (0, runtimePolicy_1.resolveRuntimeCandidate)(candidates, preference, requirements);
    }
    diagnostics() {
        return this.list().map((harness) => ({
            harnessId: harness.id,
            agentId: harness.agentId,
            adapterVersion: harness.adapterVersion,
            declared: harness.declaredCapabilities,
        }));
    }
    loadCache() {
        if (this.cache)
            return this.cache;
        try {
            const parsed = JSON.parse(node_fs_1.default.readFileSync(this.probeCachePath, 'utf-8'));
            this.cache = parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object' ? parsed : emptyCache();
        }
        catch {
            this.cache = emptyCache();
        }
        return this.cache;
    }
    saveCache() {
        if (!this.cache)
            return;
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(this.probeCachePath), { recursive: true, mode: 0o700 });
        const tmp = `${this.probeCachePath}.${process.pid}.tmp`;
        node_fs_1.default.writeFileSync(tmp, JSON.stringify(this.cache, null, 2), { encoding: 'utf-8', mode: 0o600 });
        node_fs_1.default.renameSync(tmp, this.probeCachePath);
    }
}
exports.HarnessRegistry = HarnessRegistry;
