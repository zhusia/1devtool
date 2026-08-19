"use strict";
// Entitlement SHADOW runner — P2 phase 1, observe-only (decision 2026-07-16).
//
// On boot (+15s) and every 24h it exchanges the locally stored license for a
// signed entitlement at the store, verifies it with the embedded public key
// exactly like the future gate will, and LOGS the verdict + whether it agrees
// with the legacy `isLicensed` boolean. It NEVER changes what Pro gates on —
// a disagreement is telemetry, not a downgrade. After a release of clean
// agreement data the gate flips in a follow-up (P2 phase 2).
//
// Kill-switch: ONEDEVTOOL_DISABLE_ENTITLEMENT_SHADOW=1.
//
// Files (all under userData):
//   entitlement.json          cached SignedEntitlement (the cache real P2 reads)
//   entitlement-shadow.json   maxSeenTimestamp (clock guard) + last outcome
//   logs/entitlement-shadow.log  one JSON line per pass
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SHADOW_INTERVAL_MS = void 0;
exports.isShadowDisabled = isShadowDisabled;
exports.createEntitlementShadow = createEntitlementShadow;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const verify_1 = require("../../shared/entitlement/verify");
const clockGuard_1 = require("../../shared/entitlement/clockGuard");
const deviceHash_1 = require("../../shared/entitlement/deviceHash");
const publicKey_1 = require("../../shared/entitlement/publicKey");
const buildReleaseDate_1 = require("./buildReleaseDate");
const shadowCore_1 = require("./shadowCore");
const EXCHANGE_TIMEOUT_MS = 15_000;
exports.SHADOW_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 15_000;
function isShadowDisabled() {
    // Open-source build: the entitlement exchange is permanently disabled.
    return true;
}
function createEntitlementShadow(deps) {
    const endpoint = deps.endpoint ?? publicKey_1.ENTITLEMENT_ENDPOINT;
    const now = deps.now ?? (() => new Date());
    const statePath = node_path_1.default.join(deps.userDataDir, 'entitlement-shadow.json');
    const cachePath = node_path_1.default.join(deps.userDataDir, 'entitlement.json');
    const logDir = node_path_1.default.join(deps.userDataDir, 'logs');
    const logPath = node_path_1.default.join(logDir, 'entitlement-shadow.log');
    let lastOutcome = null;
    const readState = () => {
        try {
            return JSON.parse((0, node_fs_1.readFileSync)(statePath, 'utf8'));
        }
        catch {
            return {};
        }
    };
    const writeState = (state) => {
        try {
            (0, node_fs_1.writeFileSync)(statePath, JSON.stringify(state, null, 2));
        }
        catch {
            // Best-effort — shadow must never throw into the app.
        }
    };
    const log = (outcome, maskedKey) => {
        const line = (0, shadowCore_1.buildLogLine)(outcome, maskedKey);
        try {
            (0, node_fs_1.mkdirSync)(logDir, { recursive: true });
            (0, node_fs_1.appendFileSync)(logPath, line + '\n');
        }
        catch {
            // Best-effort.
        }
        console.log('[entitlement-shadow]', line);
    };
    const finish = (partial, legacyPro, maskedKey) => {
        const shadowPro = (0, shadowCore_1.computeShadowPro)(partial);
        const outcome = {
            ...partial,
            shadowPro,
            legacyPro,
            agrees: (0, shadowCore_1.computeAgrees)(shadowPro, legacyPro),
        };
        lastOutcome = outcome;
        const state = readState();
        writeState({ ...state, lastOutcome: outcome });
        log(outcome, maskedKey);
        if (deps.onPass) {
            try {
                deps.onPass(outcome);
            }
            catch {
                // Best-effort — a gate/UI callback must never break a shadow pass.
            }
        }
        return outcome;
    };
    const run = async (trigger) => {
        const at = now().toISOString();
        const license = deps.getLicense();
        const legacyPro = license.isLicensed === true;
        const maskedKey = (0, shadowCore_1.maskLicenseKey)(license.licenseKey);
        if (isShadowDisabled()) {
            return finish({ at, trigger, stage: 'disabled' }, legacyPro, maskedKey);
        }
        if (!(0, shadowCore_1.isPlausibleLicenseKey)(license.licenseKey)) {
            return finish({ at, trigger, stage: 'no-license' }, legacyPro, maskedKey);
        }
        const deviceHash = (0, deviceHash_1.computeDeviceHash)(publicKey_1.ENTITLEMENT_DEVICE_SALT);
        if (!deviceHash) {
            return finish({ at, trigger, stage: 'device-unavailable' }, legacyPro, maskedKey);
        }
        // --- Exchange ---
        const started = Date.now();
        let response;
        let body;
        try {
            response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    licenseKey: license.licenseKey.trim(),
                    instanceId: license.instanceId ?? 'unactivated',
                    deviceHash,
                    product: publicKey_1.ENTITLEMENT_PRODUCT,
                    version: process.env.npm_package_version ?? 'unknown',
                }),
                signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
            });
            body = await response.json().catch(() => null);
        }
        catch (error) {
            return finish({
                at,
                trigger,
                stage: 'exchange-transient',
                detail: error instanceof Error ? error.name : 'network-error',
                latencyMs: Date.now() - started,
            }, legacyPro, maskedKey);
        }
        const latencyMs = Date.now() - started;
        if (!response.ok) {
            const errCode = body && typeof body === 'object' && 'error' in body ? String(body.error) : '';
            return finish({
                at,
                trigger,
                stage: (0, shadowCore_1.isDefinitiveExchangeStatus)(response.status)
                    ? 'exchange-definitive'
                    : 'exchange-transient',
                detail: `${response.status} ${errCode}`.trim(),
                latencyMs,
            }, legacyPro, maskedKey);
        }
        // --- Verify (identical inputs to the future real gate) ---
        const state = readState();
        const priorMaxSeen = state.maxSeenTimestamp ? new Date(state.maxSeenTimestamp) : null;
        const nowDate = now();
        const verify = (0, verify_1.verifyEntitlement)(body, {
            publicKey: publicKey_1.ENTITLEMENT_PUBLIC_KEY_PEM,
            expectedProduct: publicKey_1.ENTITLEMENT_PRODUCT,
            currentDeviceHash: deviceHash,
            // No stamp (dev/source builds) → epoch: never deny Pro to an unstamped build.
            buildReleaseDate: (0, buildReleaseDate_1.getBuildReleaseDate)() ?? new Date(0),
            now: nowDate,
            maxSeenTimestamp: priorMaxSeen,
        });
        const signed = body;
        const notAfter = verify.ok || signed?.entitlement ? signed?.entitlement?.notAfter : undefined;
        // Clock guard bookkeeping: fold in now + the server's issuedAt.
        const nextMaxSeen = (0, clockGuard_1.advanceMaxSeen)(priorMaxSeen, nowDate, signed?.entitlement?.issuedAt);
        writeState({ ...state, maxSeenTimestamp: nextMaxSeen ? nextMaxSeen.toISOString() : null });
        // Cache the blob for the future real gate (and offline verification drills).
        if (verify.ok) {
            try {
                (0, node_fs_1.writeFileSync)(cachePath, JSON.stringify(signed, null, 2));
            }
            catch {
                // Best-effort.
            }
        }
        return finish({ at, trigger, stage: 'verified', verify, latencyMs, notAfter }, legacyPro, maskedKey);
    };
    const getStatus = () => ({
        lastOutcome: lastOutcome ?? readState().lastOutcome ?? null,
        logPath,
        enabled: !isShadowDisabled(),
    });
    const start = () => {
        if (isShadowDisabled())
            return () => { };
        const bootTimer = setTimeout(() => {
            void run('boot').catch(() => { });
        }, BOOT_DELAY_MS);
        const interval = setInterval(() => {
            void run('interval').catch(() => { });
        }, exports.SHADOW_INTERVAL_MS);
        return () => {
            clearTimeout(bootTimer);
            clearInterval(interval);
        };
    };
    return { run, getStatus, start };
}
