"use strict";
/**
 * License Service
 *
 * Manages license activation, validation, and usage limits using Lemon Squeezy.
 * The legacy lifetime-message cap is removed — conversion is now driven by
 * structural caps in `FREE_TIER_LIMITS` plus visible Pro-only features in the UI.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.licenseService = exports.LicenseService = void 0;
const os_1 = __importDefault(require("os"));
const crypto_1 = require("crypto");
const electron_store_1 = __importDefault(require("electron-store"));
const LemonSqueezyService_1 = require("./LemonSqueezyService");
const licenseLimits_1 = require("../../shared/licenseLimits");
function localDateKey(now) {
    const yyyy = now.getFullYear().toString().padStart(4, '0');
    const mm = (now.getMonth() + 1).toString().padStart(2, '0');
    const dd = now.getDate().toString().padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}
class LicenseService {
    store;
    deviceId;
    deviceName;
    now;
    listeners = new Set();
    /**
     * Entitlement gate evaluator (P2 phase 2). When set, its verdict overrides the
     * legacy `isLicensed` boolean. Injected from main after the gate is built, so
     * LicenseService stays decoupled and unit-testable. Absent → legacy boolean.
     */
    entitlementEvaluator = null;
    entitlementRefresh = null;
    constructor(options = {}) {
        this.now = options.now ?? (() => new Date());
        this.store = new electron_store_1.default({
            name: options.storeName ?? '1devtool-license',
            cwd: options.cwd,
            defaults: {
                license: null,
                deviceId: '',
                deviceName: '',
                isLicensed: false,
                aiDiffUsage: {},
            },
        });
        this.deviceName = os_1.default.hostname() || 'unknown-device';
        this.deviceId = this.ensureDeviceId();
        // Phase 1 migration: clear the legacy `messagesUsed` lifetime counter so it
        // doesn't linger in users' stores after the cap is removed. Safe no-op
        // for installs that never had it.
        try {
            const legacyKey = 'messagesUsed';
            // Cast: legacy field no longer in the schema, but `electron-store` still
            // honors `delete` on whatever string key actually exists on disk.
            if (this.store.has('messagesUsed')) {
                ;
                this.store.delete('messagesUsed');
            }
            void legacyKey;
        }
        catch (error) {
            console.warn('[LicenseService] Failed to clear legacy messagesUsed key', error);
        }
        // Prune old AI-Diff date buckets so the store doesn't grow unboundedly.
        this.pruneAiDiffUsage();
    }
    ensureDeviceId() {
        let deviceId = this.store.get('deviceId');
        if (!deviceId) {
            deviceId = (0, crypto_1.randomUUID)();
            this.store.set('deviceId', deviceId);
            this.store.set('deviceName', this.deviceName);
        }
        return deviceId;
    }
    /** Drop everything except today's bucket from the AI-Diff usage map. */
    pruneAiDiffUsage() {
        const today = localDateKey(this.now());
        const usage = this.store.get('aiDiffUsage') || {};
        if (!usage[today]) {
            this.store.set('aiDiffUsage', {});
            return;
        }
        if (Object.keys(usage).length > 1) {
            this.store.set('aiDiffUsage', { [today]: usage[today] });
        }
    }
    /**
     * Wire the entitlement gate (P2 phase 2). After this, `getLicenseInfo().isLicensed`
     * reflects the cryptographic verdict, not the raw boolean. Fail-safe: the gate
     * itself falls back to the legacy boolean on any error.
     *
     * `refresh` re-evaluates the gate after a LICENSE MUTATION (activate/deactivate)
     * so a fresh activation grants Pro immediately instead of serving the latched
     * pre-activation verdict until the next boot/24h pass. `resetLatch` is set for
     * user-initiated downgrades (deactivate), where "never downgrade mid-session"
     * would wrongly preserve Pro the user just gave up.
     */
    setEntitlementEvaluator(evaluator, refresh) {
        this.entitlementEvaluator = evaluator;
        this.entitlementRefresh = refresh ?? null;
    }
    /** Raw legacy license, straight off disk — the gate's input. NEVER calls the gate. */
    getRawLicenseSnapshot() {
        // Open-source build: the raw snapshot always reports licensed so every
        // legacy-boolean consumer (gate fallback, feature flags) stays unlocked.
        const license = this.store.get('license');
        return {
            isLicensed: true,
            licenseKey: license?.licenseKey ?? null,
            instanceId: license?.instanceId ?? null,
        };
    }
    /** Public re-emit of the license snapshot — used after a gate re-evaluation. */
    notifyLicenseChanged() {
        this.notifyChange();
    }
    getLicenseInfo() {
        // Open-source build: always fully licensed. No key, no server, no gate.
        const license = this.store.get('license');
        return {
            isLicensed: true,
            licenseId: license?.lsLicenseId ?? null,
            licenseKey: license?.licenseKey ?? null,
            email: license?.email ?? null,
            customerName: license?.customerName ?? null,
            deviceLimit: null,
            activatedDevices: license?.activationUsage ?? 0,
            updatesUntil: null,
            activatedAt: license?.activatedAt ?? null,
            lastVerified: null,
            canUpdate: true,
            status: 'active',
            variantName: 'Open Source',
            instanceName: null,
            instanceId: null,
            currentDeviceId: this.deviceId,
            deviceName: this.deviceName,
            proSource: 'open-source',
            entitlementNotice: null,
            graceUntil: null,
        };
    }
    getUsageLimits() {
        const info = this.getLicenseInfo();
        const aiDiffUsedToday = this.getAiDiffUsedToday();
        if (info.isLicensed) {
            return {
                isLicensed: true,
                maxProjects: null,
                maxTerminals: null,
                maxBrowserTabs: null,
                maxChannels: null,
                maxDbConnectionsPerProject: null,
                maxDbConnectionsGlobal: null,
                maxHttpSavedRequests: null,
                maxGitWorktreesPerProject: null,
                aiDiffPerDay: null,
                aiDiffUsedToday,
                promptHistoryRetentionDays: null,
                resumeSessionsRetentionDays: null,
                aiMemoryRetentionDays: null,
            };
        }
        return {
            isLicensed: false,
            maxProjects: licenseLimits_1.FREE_TIER_LIMITS.projects,
            maxTerminals: licenseLimits_1.FREE_TIER_LIMITS.terminalsPerProject,
            maxBrowserTabs: licenseLimits_1.FREE_TIER_LIMITS.browserTabs,
            maxChannels: licenseLimits_1.FREE_TIER_LIMITS.channelsGlobal,
            maxDbConnectionsPerProject: licenseLimits_1.FREE_TIER_LIMITS.dbConnectionsPerProject,
            maxDbConnectionsGlobal: licenseLimits_1.FREE_TIER_LIMITS.dbConnectionsGlobal,
            maxHttpSavedRequests: licenseLimits_1.FREE_TIER_LIMITS.httpSavedRequests,
            maxGitWorktreesPerProject: licenseLimits_1.FREE_TIER_LIMITS.gitWorktreesPerProject,
            aiDiffPerDay: licenseLimits_1.FREE_TIER_LIMITS.aiDiffPerDay,
            aiDiffUsedToday,
            promptHistoryRetentionDays: licenseLimits_1.FREE_TIER_LIMITS.promptHistoryRetentionDays,
            resumeSessionsRetentionDays: licenseLimits_1.FREE_TIER_LIMITS.resumeSessionsRetentionDays,
            aiMemoryRetentionDays: licenseLimits_1.FREE_TIER_LIMITS.aiMemoryRetentionDays,
        };
    }
    generateLimitResult(current, max, isLicensed) {
        const allowed = max === null || current < max;
        return {
            allowed,
            current,
            max,
            remaining: max === null ? null : Math.max(max - current, 0),
            isLicensed,
            reason: allowed
                ? undefined
                : 'Free trial limit reached. Upgrade to unlock more capacity.',
        };
    }
    canAddProject(currentCount) {
        const info = this.getLicenseInfo();
        const limit = info.isLicensed ? null : licenseLimits_1.FREE_TIER_LIMITS.projects;
        return this.generateLimitResult(currentCount, limit, info.isLicensed);
    }
    canAddTerminal(currentCount) {
        const info = this.getLicenseInfo();
        const limit = info.isLicensed ? null : licenseLimits_1.FREE_TIER_LIMITS.terminalsPerProject;
        return this.generateLimitResult(currentCount, limit, info.isLicensed);
    }
    canAddBrowserTab(currentCount) {
        const info = this.getLicenseInfo();
        const limit = info.isLicensed ? null : licenseLimits_1.FREE_TIER_LIMITS.browserTabs;
        return this.generateLimitResult(currentCount, limit, info.isLicensed);
    }
    canAddChannel(currentCount) {
        const info = this.getLicenseInfo();
        const limit = info.isLicensed ? null : licenseLimits_1.FREE_TIER_LIMITS.channelsGlobal;
        return this.generateLimitResult(currentCount, limit, info.isLicensed);
    }
    canAddDbConnection(scope, currentCount) {
        const info = this.getLicenseInfo();
        const limit = info.isLicensed
            ? null
            : scope === 'project'
                ? licenseLimits_1.FREE_TIER_LIMITS.dbConnectionsPerProject
                : licenseLimits_1.FREE_TIER_LIMITS.dbConnectionsGlobal;
        return this.generateLimitResult(currentCount, limit, info.isLicensed);
    }
    canSaveHttpRequest(currentCount) {
        const info = this.getLicenseInfo();
        const limit = info.isLicensed ? null : licenseLimits_1.FREE_TIER_LIMITS.httpSavedRequests;
        return this.generateLimitResult(currentCount, limit, info.isLicensed);
    }
    canAddGitWorktree(currentCount) {
        const info = this.getLicenseInfo();
        const limit = info.isLicensed ? null : licenseLimits_1.FREE_TIER_LIMITS.gitWorktreesPerProject;
        return this.generateLimitResult(currentCount, limit, info.isLicensed);
    }
    /** Check if a free user can run another AI Diff today. */
    canUseAiDiff() {
        const info = this.getLicenseInfo();
        const used = this.getAiDiffUsedToday();
        const limit = info.isLicensed ? null : licenseLimits_1.FREE_TIER_LIMITS.aiDiffPerDay;
        return this.generateLimitResult(used, limit, info.isLicensed);
    }
    getAiDiffUsedToday() {
        const today = localDateKey(this.now());
        const usage = this.store.get('aiDiffUsage') || {};
        return usage[today] || 0;
    }
    /** Increment the AI Diff counter for today. Free users only — Pro is no-op. */
    incrementAiDiff() {
        const info = this.getLicenseInfo();
        if (info.isLicensed)
            return;
        this.pruneAiDiffUsage();
        const today = localDateKey(this.now());
        const usage = this.store.get('aiDiffUsage') || {};
        const current = usage[today] || 0;
        this.store.set('aiDiffUsage', { ...usage, [today]: current + 1 });
        this.notifyChange();
    }
    onChange(listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
    notifyChange() {
        if (this.listeners.size === 0)
            return;
        let snapshot;
        try {
            snapshot = { info: this.getLicenseInfo(), limits: this.getUsageLimits() };
        }
        catch (error) {
            console.error('[LicenseService] Failed to build change snapshot', error);
            return;
        }
        for (const listener of this.listeners) {
            try {
                listener(snapshot);
            }
            catch (error) {
                console.error('[LicenseService] Change listener threw', error);
            }
        }
    }
    async activateLicense(licenseKey, _email) {
        const trimmedKey = licenseKey.trim();
        if (!trimmedKey) {
            throw new Error('License key is required');
        }
        // Open-source build: activation is a local no-op — no LemonSqueezy call.
        const licenseData = {
            licenseKey: trimmedKey,
            lsLicenseId: null,
            instanceId: 'opensource',
            instanceName: 'Open Source',
            email: _email ?? null,
            customerName: null,
            storeId: null,
            orderId: null,
            productId: null,
            variantId: null,
            variantName: 'Open Source',
            activationLimit: null,
            activationUsage: 1,
            status: 'active',
            expiresAt: null,
            activatedAt: new Date().toISOString(),
            lastVerified: new Date().toISOString(),
            metadata: null,
        };
        this.store.set('license', licenseData);
        this.store.set('isLicensed', true);
        this.notifyChange();
    }
    async validateLicense() {
        // Open-source build: always valid, no network call.
        return true;
    }
    async deactivateLicense() {
        const info = this.getLicenseInfo();
        if (!info.isLicensed) {
            throw new Error('No active license to deactivate');
        }
        // Open-source build: deactivation is a local cleanup, no LemonSqueezy call.
        this.store.set('license', null);
        this.store.set('isLicensed', false);
        this.notifyChange();
    }
}
exports.LicenseService = LicenseService;
exports.licenseService = new LicenseService();
