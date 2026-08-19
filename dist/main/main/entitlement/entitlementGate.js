"use strict";
// Entitlement GATE — P2 phase 2 IO wrapper (docs/product/strategy/licensing-updates-monetization.md §6 P2 + §8).
//
// Turns the pure decision (gate.ts) into the thing LicenseService consults. It:
//   - memoizes the hardware device hash (one ioreg/reg/machine-id read per run),
//   - reads the cached signed entitlement (entitlement.json) and verifies it,
//   - reads the shadow/refresh state (entitlement-shadow.json: maxSeen + last
//     exchange outcome) to classify the last exchange,
//   - persists grace bookkeeping (entitlement-gate.json),
//   - LATCHES the session grant so a mid-session refresh can UPGRADE free→Pro but
//     NEVER downgrades Pro→free under a running app (§8.3 rule 4). Downgrades
//     take effect on the next boot.
//
// Fail-safe everywhere: any throw, unreadable file, or absent evaluator degrades
// to the legacy boolean. Kill switch: ONEDEVTOOL_DISABLE_ENTITLEMENT_GATE=1.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENTITLEMENT_GATE_ENABLED = void 0;
exports.isEntitlementGateEnabled = isEntitlementGateEnabled;
exports.cacheKeyMatchesStored = cacheKeyMatchesStored;
exports.createEntitlementGate = createEntitlementGate;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const verify_1 = require("../../shared/entitlement/verify");
const deviceHash_1 = require("../../shared/entitlement/deviceHash");
const publicKey_1 = require("../../shared/entitlement/publicKey");
const buildReleaseDate_1 = require("./buildReleaseDate");
const gate_1 = require("./gate");
/**
 * The flip. `true` makes the cryptographic verdict authoritative; `false` ships
 * the code dormant (pure legacy boolean). Kept as a constant so the flip is one
 * line, and paired with the env kill switch + NODE_ENV=test guard below.
 */
exports.ENTITLEMENT_GATE_ENABLED = false;
function isEntitlementGateEnabled() {
    // Open-source build: the cryptographic gate is permanently disabled.
    return false;
}
/**
 * The cached entitlement is only usable if its blob was minted for the license
 * key CURRENTLY stored on disk (1.42.1 tightening). Without this, a still-valid
 * signature for a PREVIOUS key keeps granting Pro after the stored key is
 * swapped for a dead/refunded one — the exact case observed live: a refunded key
 * riding the prior real key's blob until its `notAfter`. On a legit key change
 * (re-activation, tier upgrade → new key) the mismatch simply routes through the
 * exchange/grace path, which mints a fresh matching blob within grace.
 */
function cacheKeyMatchesStored(cachedKey, storedKey) {
    if (typeof cachedKey !== 'string' || typeof storedKey !== 'string')
        return false;
    return cachedKey.trim() === storedKey.trim();
}
function createEntitlementGate(deps) {
    const now = deps.now ?? (() => new Date());
    const cachePath = node_path_1.default.join(deps.userDataDir, 'entitlement.json');
    const shadowStatePath = node_path_1.default.join(deps.userDataDir, 'entitlement-shadow.json');
    const gateStatePath = node_path_1.default.join(deps.userDataDir, 'entitlement-gate.json');
    // Memoized hardware hash — the expensive part (spawns ioreg/reg). Null result
    // is cached too (it's stable within a run); a hardware id doesn't appear later.
    let deviceHashComputed = false;
    let deviceHash = null;
    const getDeviceHash = () => {
        if (!deviceHashComputed) {
            try {
                deviceHash = deps.computeDeviceHash
                    ? deps.computeDeviceHash()
                    : (0, deviceHash_1.computeDeviceHash)(publicKey_1.ENTITLEMENT_DEVICE_SALT);
            }
            catch {
                deviceHash = null;
            }
            deviceHashComputed = true;
        }
        return deviceHash;
    };
    const buildReleaseDate = (0, buildReleaseDate_1.getBuildReleaseDate)() ?? new Date(0);
    const readJson = (p) => {
        try {
            return JSON.parse((0, node_fs_1.readFileSync)(p, 'utf8'));
        }
        catch {
            return null;
        }
    };
    const readGraceState = () => readJson(gateStatePath) ?? {};
    const writeGraceState = (graceStartedAt) => {
        try {
            (0, node_fs_1.writeFileSync)(gateStatePath, JSON.stringify({ graceStartedAt: graceStartedAt ? graceStartedAt.toISOString() : null }, null, 2));
        }
        catch {
            // Best-effort — the gate must never throw into the app.
        }
    };
    // Session latch: once Pro this session, never drop under the running app.
    let sessionPro = null;
    let latched = null;
    const rawEvaluate = () => {
        const gateEnabled = isEntitlementGateEnabled();
        const license = deps.getRawLicense();
        const legacyLicensed = license.isLicensed === true;
        const hasPlausibleKey = typeof license.licenseKey === 'string' && license.licenseKey.trim().length >= 8;
        const hash = getDeviceHash();
        // Verify the cached blob (if any) with the same inputs the shadow uses.
        // The blob must belong to the CURRENTLY-STORED key (1.42.1) — a cache for a
        // different key is treated as no cache, so the decision falls through to the
        // exchange/grace path instead of granting Pro off a stale key's signature.
        let cacheVerify = null;
        let cacheExpiresAt = null;
        const cached = readJson(cachePath);
        const cacheUsable = cacheKeyMatchesStored(cached?.entitlement?.licenseKey, license.licenseKey);
        if (cached && hash && cacheUsable) {
            const shadowState = readJson(shadowStatePath);
            const maxSeen = shadowState?.maxSeenTimestamp ? new Date(shadowState.maxSeenTimestamp) : null;
            cacheVerify = (0, verify_1.verifyEntitlement)(cached, {
                publicKey: publicKey_1.ENTITLEMENT_PUBLIC_KEY_PEM,
                expectedProduct: publicKey_1.ENTITLEMENT_PRODUCT,
                currentDeviceHash: hash,
                buildReleaseDate,
                now: now(),
                maxSeenTimestamp: maxSeen,
            });
            cacheExpiresAt = cached.entitlement?.expiresAt ?? null;
        }
        // Classify the most recent exchange from the shadow/refresh runner.
        const lastOutcome = readJson(shadowStatePath)?.lastOutcome;
        const lastExchange = (0, gate_1.classifyExchange)(lastOutcome?.stage, lastOutcome?.detail);
        const grace = readGraceState();
        const graceStartedAt = grace.graceStartedAt ? new Date(grace.graceStartedAt) : null;
        return (0, gate_1.decideEntitlement)({
            gateEnabled,
            legacyLicensed,
            hasPlausibleKey,
            deviceHashAvailable: hash !== null,
            cacheVerify,
            cacheExpiresAt,
            lastExchange,
            graceStartedAt,
            now: now(),
        });
    };
    const evaluate = () => {
        let raw;
        try {
            raw = rawEvaluate();
        }
        catch {
            // Absolute fail-safe: never let a gate bug strip Pro. Legacy boolean wins.
            const legacy = safeLegacy(deps);
            raw = {
                pro: legacy,
                source: 'legacy-fallback',
                reason: 'gate-error',
                notice: null,
                windowEndedAt: null,
                graceUntil: null,
                definitive: false,
                graceStartedAt: null,
            };
        }
        // Persist grace bookkeeping from the RAW decision (before the latch) — the
        // latch is a display concession, not the source of truth for next boot.
        writeGraceState(raw.graceStartedAt);
        // Session latch: upgrades apply immediately; downgrades wait for next boot.
        if (sessionPro === true && raw.pro === false) {
            latched = {
                ...raw,
                pro: true,
                source: 'session-latch',
                reason: `latched-${raw.reason}`,
            };
        }
        else {
            latched = raw;
            if (raw.pro)
                sessionPro = true;
            else if (sessionPro === null)
                sessionPro = false;
        }
        return latched;
    };
    const getDecision = () => latched ?? evaluate();
    const resetLatch = () => {
        sessionPro = null;
        latched = null;
        return evaluate();
    };
    return {
        evaluate,
        getDecision,
        resetLatch,
        getStatus: () => ({ enabled: isEntitlementGateEnabled(), decision: latched }),
    };
}
function safeLegacy(deps) {
    try {
        return deps.getRawLicense().isLicensed === true;
    }
    catch {
        return true; // even the raw read failed — bias to NOT punishing a customer.
    }
}
