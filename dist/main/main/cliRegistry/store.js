"use strict";
/**
 * Persisted CLI registry state: user overrides, custom CLIs, slow-PATH strikes,
 * last-scan timestamps. Backed by electron-store via the existing StoreManager
 * pattern; keys are isolated under 'cliRegistry.*'.
 *
 * The store is mutable in-memory and is the source of truth for `getCliBinary`
 * (cache-first lookups). It is rebuilt on app boot from disk and lazily mutated
 * by the scanner.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CliRegistryStore = void 0;
const electron_1 = require("electron");
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const SCHEMA_VERSION = 1;
const STORE_FILENAME = 'cli-registry.json';
function emptyState() {
    return {
        overrides: {},
        customClis: [],
        slowPathStrikes: {},
        findings: {},
        versionCache: {},
        schemaVersion: SCHEMA_VERSION,
    };
}
class CliRegistryStore {
    state = emptyState();
    writeChain = Promise.resolve();
    filePath;
    constructor(filePath) {
        this.filePath = filePath ?? path_1.default.join(electron_1.app.getPath('userData'), STORE_FILENAME);
    }
    async load() {
        try {
            const raw = await promises_1.default.readFile(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            this.state = {
                ...emptyState(),
                ...parsed,
                overrides: parsed.overrides ?? {},
                customClis: parsed.customClis ?? [],
                slowPathStrikes: parsed.slowPathStrikes ?? {},
                findings: parsed.findings ?? {},
                versionCache: parsed.versionCache ?? {},
                schemaVersion: SCHEMA_VERSION,
            };
        }
        catch {
            this.state = emptyState();
        }
    }
    save() {
        // Serialize writes with an atomic rename to avoid corruption on crash.
        const snapshot = JSON.stringify(this.state);
        this.writeChain = this.writeChain.then(async () => {
            const tmp = `${this.filePath}.tmp`;
            try {
                await promises_1.default.mkdir(path_1.default.dirname(this.filePath), { recursive: true });
                await promises_1.default.writeFile(tmp, snapshot, 'utf8');
                await promises_1.default.rename(tmp, this.filePath);
            }
            catch {
                // swallow — store layer should never throw at callers
            }
        });
    }
    getVersionCache() {
        return new Map(Object.entries(this.state.versionCache));
    }
    commitVersionCache(map) {
        this.state.versionCache = Object.fromEntries(map);
        this.save();
    }
    getOverride(id) {
        return this.state.overrides[id] ?? null;
    }
    setOverride(id, value) {
        if (value === null) {
            delete this.state.overrides[id];
        }
        else {
            this.state.overrides[id] = value;
        }
        this.save();
    }
    listOverrides() {
        const result = {};
        for (const [k, v] of Object.entries(this.state.overrides)) {
            if (v !== null && v !== undefined)
                result[k] = v;
        }
        return result;
    }
    getCustomClis() {
        return [...this.state.customClis];
    }
    addCustom(spec) {
        // Replace any existing entry with the same id
        const existing = this.state.customClis.findIndex((c) => c.id === spec.id);
        if (existing >= 0) {
            this.state.customClis[existing] = spec;
        }
        else {
            this.state.customClis.push(spec);
        }
        this.save();
    }
    removeCustom(id) {
        this.state.customClis = this.state.customClis.filter((c) => c.id !== id);
        this.save();
    }
    getFindings() {
        return { ...this.state.findings };
    }
    updateFinding(reg) {
        this.state.findings[reg.cliId] = reg;
        this.save();
    }
    /** Convert a raw ScanFinding into a CliRegistration, honoring any override. */
    toRegistration(finding) {
        const override = this.getOverride(finding.cliId);
        const selectedPath = override ?? finding.verifiedPath ?? (finding.paths[0] ?? null);
        const state = override
            ? 'override'
            : finding.state === 'ambiguous'
                ? 'ambiguous'
                : finding.state;
        return {
            cliId: finding.cliId,
            state,
            paths: finding.paths,
            selectedPath,
            version: finding.version,
            lastScanAt: Date.now(),
            scanDurationMs: finding.scanDurationMs,
            error: finding.error,
        };
    }
    recordSlowPathStrike(entry) {
        const n = (this.state.slowPathStrikes[entry] ?? 0) + 1;
        this.state.slowPathStrikes[entry] = n;
        this.save();
        return n;
    }
    isSlowPathQuarantined(entry) {
        return (this.state.slowPathStrikes[entry] ?? 0) >= 2;
    }
    clearSlowPathStrikes(entry) {
        if (entry) {
            delete this.state.slowPathStrikes[entry];
        }
        else {
            this.state.slowPathStrikes = {};
        }
        this.save();
    }
    listSlowPathQuarantined() {
        return Object.entries(this.state.slowPathStrikes)
            .filter(([, n]) => n >= 2)
            .map(([k]) => k);
    }
}
exports.CliRegistryStore = CliRegistryStore;
