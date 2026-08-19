"use strict";
/**
 * Public CliRegistry facade.
 *
 * `getCliBinary` is the hot path called by AgentSessionManager (future)
 * and any other caller that just needs "where is `claude`?". Critical
 * invariants from §3.6.4:
 *   - NEVER waits for the bulk scan to finish.
 *   - Reads from store cache first (50ms target).
 *   - On cache miss, runs a targeted 2s scan for that one CLI only.
 *   - On `not-found` from cache + spawn-time ENOENT, schedules a
 *     targeted re-scan (caller handles the typed error).
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.CliRegistry = void 0;
const events_1 = require("events");
const knownClis_1 = require("./knownClis");
const store_1 = require("./store");
const scanner_1 = require("./scanner");
class CliRegistry extends events_1.EventEmitter {
    store;
    scanInFlight = null;
    constructor(store) {
        super();
        this.store = store ?? new store_1.CliRegistryStore();
    }
    async init() {
        await this.store.load();
    }
    /** Merge known + user-defined custom CLIs. */
    knownClis() {
        const customs = this.store.getCustomClis().map((c) => ({
            id: c.id,
            displayName: c.displayName,
            category: 'custom',
            binaries: c.binaries,
            versionArgs: c.versionArgs,
            defaultSpawnArgs: c.defaultSpawnArgs,
        }));
        return [...knownClis_1.KNOWN_CLIS, ...customs];
    }
    list() {
        const findings = this.store.getFindings();
        const known = this.knownClis();
        return known.map((cli) => {
            const existing = findings[cli.id];
            if (existing)
                return existing;
            const override = this.store.getOverride(cli.id);
            return {
                cliId: cli.id,
                state: override ? 'override' : 'unverified',
                paths: override ? [override] : [],
                selectedPath: override,
                version: null,
                lastScanAt: 0,
                scanDurationMs: 0,
            };
        });
    }
    /**
     * Hot path. Never waits for the bulk scan. ~50ms target on cache hit.
     * On cache miss, targeted scan capped at PER_CLI_TIMEOUT_MS (2s).
     */
    async getCliBinary(id) {
        const override = this.store.getOverride(id);
        if (override) {
            // Trust override even without re-verify, but surface override-missing
            // if the file vanished.
            try {
                const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
                await fs.access(override);
                const reg = this.store.getFindings()[id];
                return { ok: true, path: override, version: reg?.version ?? null, state: 'override' };
            }
            catch {
                return { ok: false, reason: 'override-missing' };
            }
        }
        const findings = this.store.getFindings();
        const cached = findings[id];
        if (cached && cached.selectedPath && (cached.state === 'detected' || cached.state === 'override')) {
            return { ok: true, path: cached.selectedPath, version: cached.version, state: cached.state };
        }
        if (cached && cached.state === 'ambiguous' && cached.selectedPath) {
            return { ok: false, reason: 'ambiguous' };
        }
        // No useful cache → targeted scan for this one CLI only.
        const cli = this.knownClis().find((c) => c.id === id);
        if (!cli)
            return { ok: false, reason: 'not-found' };
        const versionCache = this.store.getVersionCache();
        const finding = await (0, scanner_1.scanOneCli)(cli, { cache: versionCache });
        this.store.commitVersionCache(versionCache);
        const reg = this.store.toRegistration(finding);
        this.store.updateFinding(reg);
        this.emit('change', reg);
        if (finding.state === 'detected' && finding.verifiedPath) {
            return { ok: true, path: finding.verifiedPath, version: finding.version, state: 'detected' };
        }
        if (finding.state === 'ambiguous' && finding.paths[0]) {
            return { ok: false, reason: 'ambiguous' };
        }
        if (finding.state === 'timeout' || finding.state === 'unverified') {
            return { ok: false, reason: 'timeout' };
        }
        return { ok: false, reason: 'not-found' };
    }
    /**
     * Trigger a full background scan. Multiple concurrent calls share the same
     * in-flight scan promise so we never run two at once.
     *
     * If `only` is provided, only those CLIs are scanned; the global timeout
     * is per-cli * 1.5 (bounded).
     */
    async rescan(opts = {}) {
        if (this.scanInFlight && !opts.force) {
            return this.scanInFlight.promise;
        }
        if (this.scanInFlight && opts.force) {
            this.scanInFlight.ctl.abort();
        }
        const ctl = new AbortController();
        const known = this.knownClis();
        const targets = opts.only ? known.filter((c) => opts.only.includes(c.id)) : known;
        const versionCache = this.store.getVersionCache();
        const rescanFlag = (this.store.getFindings() && Object.keys(this.store.getFindings()).length > 0);
        const promise = (0, scanner_1.scanAll)(targets, {
            signal: ctl.signal,
            rescan: opts.force ? false : rescanFlag,
            cache: versionCache,
            onProgress: (p) => {
                const reg = this.store.toRegistration(p.finding);
                this.store.updateFinding(reg);
                this.emit('progress', p);
                this.emit('change', reg);
            },
        }).then((findings) => {
            this.store.commitVersionCache(versionCache);
            const regs = findings.map((f) => this.store.toRegistration(f));
            for (const reg of regs)
                this.store.updateFinding(reg);
            this.emit('scanComplete', regs);
            this.scanInFlight = null;
            return regs;
        });
        this.scanInFlight = { ctl, promise };
        return promise;
    }
    cancelScan() {
        this.scanInFlight?.ctl.abort();
        this.scanInFlight = null;
    }
    async setOverride(id, value) {
        this.store.setOverride(id, value);
        // Bump the registration with override state + invalidate version
        const findings = this.store.getFindings();
        const existing = findings[id];
        const reg = {
            cliId: id,
            state: value ? 'override' : (existing?.state ?? 'not-found'),
            paths: value ? [value, ...(existing?.paths ?? [])] : (existing?.paths ?? []),
            selectedPath: value ?? existing?.selectedPath ?? null,
            version: existing?.version ?? null,
            lastScanAt: existing?.lastScanAt ?? 0,
            scanDurationMs: existing?.scanDurationMs ?? 0,
        };
        this.store.updateFinding(reg);
        this.emit('change', reg);
    }
    async addCustom(spec) {
        this.store.addCustom(spec);
    }
    async removeCustom(id) {
        this.store.removeCustom(id);
    }
    slowPaths() {
        return this.store.listSlowPathQuarantined();
    }
    clearSlowPathStrikes(entry) {
        this.store.clearSlowPathStrikes(entry);
    }
}
exports.CliRegistry = CliRegistry;
