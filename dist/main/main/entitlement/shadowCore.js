"use strict";
// Pure decision/formatting helpers for the entitlement SHADOW pass — P2 phase 1.
// (docs/product/strategy/licensing-updates-monetization.md §6 P2, shipped observe-only per the 2026-07-16
// decision: the verifier's verdict is computed and LOGGED on real installs, but
// Pro keeps gating on the legacy `isLicensed` boolean. No user-visible change.)
//
// Everything here is pure so it can be unit-tested without Electron; the IO
// glue (fetch, fs, timers, app paths) lives in ./shadow.ts.
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDefinitiveExchangeStatus = isDefinitiveExchangeStatus;
exports.maskLicenseKey = maskLicenseKey;
exports.isPlausibleLicenseKey = isPlausibleLicenseKey;
exports.computeShadowPro = computeShadowPro;
exports.computeAgrees = computeAgrees;
exports.buildLogLine = buildLogLine;
/** HTTP statuses that mean "the server understood and said no" — do not retry. */
function isDefinitiveExchangeStatus(status) {
    return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
/** `FC92E921-…` — enough to correlate, never the whole key. */
function maskLicenseKey(key) {
    if (!key)
        return '(none)';
    return key.length <= 8 ? `${key}…` : `${key.slice(0, 8)}…`;
}
/**
 * A licenseKey worth attempting to exchange (§8.3 rule 5: grace and exchange
 * are for plausible keys only — `isLicensed: true` with no key gets nothing).
 */
function isPlausibleLicenseKey(key) {
    return typeof key === 'string' && key.trim().length >= 8;
}
function computeShadowPro(outcome) {
    if (outcome.stage === 'verified')
        return outcome.verify?.ok === true;
    if (outcome.stage === 'no-license')
        return false;
    if (outcome.stage === 'exchange-definitive')
        return false;
    // transient / device-unavailable / disabled → no verdict; real P2 would fall
    // back to the cached entitlement (until notAfter) or the §8 grace window.
    return null;
}
function computeAgrees(shadowPro, legacyPro) {
    if (shadowPro === null)
        return null;
    return shadowPro === legacyPro;
}
/** Single log line (JSONL) — greppable, no full license key, no signature. */
function buildLogLine(outcome, maskedKey) {
    return JSON.stringify({
        at: outcome.at,
        trigger: outcome.trigger,
        stage: outcome.stage,
        verify: outcome.verify ?? null,
        detail: outcome.detail ?? null,
        shadowPro: outcome.shadowPro,
        legacyPro: outcome.legacyPro,
        agrees: outcome.agrees,
        latencyMs: outcome.latencyMs ?? null,
        notAfter: outcome.notAfter ?? null,
        licenseKey: maskedKey,
    });
}
