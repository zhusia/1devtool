"use strict";
// Entitlement GATE — P2 phase 2 decision core (docs/product/strategy/licensing-updates-monetization.md §6 P2 + §8).
//
// This is the flip: Pro stops being granted by the editable `isLicensed` boolean
// and starts being granted by the cryptographic verifier. This module is the PURE
// decision — every input injected, no clock/disk/env/crypto here — so the whole
// grant/deny/grace matrix is unit-testable. The IO wrapper (entitlementGate.ts)
// reads the cache, computes the device hash, verifies, and persists grace state.
//
// The prime directive (§8): a PAYING customer is never wrongly downgraded. The
// ONLY paths to pro=false for someone holding a plausible key are:
//   (a) a cryptographically-signed proEnabled:false blob  → refund / disable,
//   (b) a DEFINITIVE server rejection of a real exchange   → refund / not_found /
//       product_mismatch,
//   (c) grace fully expired                                → 14 days of nothing
//       but transient failures (firewall-blocker / genuinely broken).
// Every other uncertainty — no cache yet, transient error, offline, unreadable
// hardware id, hardware changed, unstamped build — keeps Pro.
Object.defineProperty(exports, "__esModule", { value: true });
exports.GRACE_NOTICE_MS = exports.GRACE_WINDOW_MS = void 0;
exports.classifyExchange = classifyExchange;
exports.decideEntitlement = decideEntitlement;
/** 14-day migration grace (§8.3 rule 2): honor a plausible key while we can't verify. */
exports.GRACE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Start surfacing the "couldn't verify" hint only in the last stretch of grace. */
exports.GRACE_NOTICE_MS = 3 * 24 * 60 * 60 * 1000;
/**
 * Exchange error codes that mean "the server understood and this is permanent."
 * Everything NOT in this set (device_mismatch/device_limit/invalid_instance from a
 * hardware change or wiped activation, inactive, error, busy, signing_unavailable,
 * any 5xx/timeout/network) is treated as transient so a legitimate customer is
 * never dropped for a recoverable reason — grace bounds the narrow abuse cases.
 */
const DEFINITIVE_EXCHANGE_CODES = new Set([
    'refunded',
    'disabled',
    'not_found',
    'product_mismatch',
    'unknown_product',
    'invalid_fields',
    'missing_fields',
    'invalid_body',
    'body_too_large',
]);
/**
 * Classify the shadow/refresh runner's last outcome for the gate.
 *
 * `stage` + `detail` come straight from ShadowOutcome (entitlement-shadow.json).
 * The shadow marks any 4xx-except-408/429 as 'exchange-definitive' by STATUS, but
 * a 403 covers both permanent (refunded) and recoverable (device_mismatch) cases,
 * so we re-decide by the error CODE embedded in `detail` ("403 device_mismatch").
 */
function classifyExchange(stage, detail) {
    if (stage === 'verified')
        return 'success';
    if (stage === 'exchange-definitive' || stage === 'exchange-transient') {
        const code = extractErrorCode(detail);
        return code && DEFINITIVE_EXCHANGE_CODES.has(code) ? 'definitive-negative' : 'transient';
    }
    // no-license / device-unavailable / disabled / undefined → nothing exchanged.
    return 'none';
}
/** Pull the error code out of a `"<status> <code>"` detail string. */
function extractErrorCode(detail) {
    if (!detail)
        return null;
    const parts = detail.trim().split(/\s+/);
    // "403 refunded" → "refunded"; "timeout"/"TimeoutError" → itself.
    const tail = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    return tail || null;
}
function decision(partial) {
    return {
        notice: null,
        windowEndedAt: null,
        graceUntil: null,
        definitive: false,
        graceStartedAt: null,
        ...partial,
    };
}
/**
 * Decide the Pro grant. Pure — see the module header for the safety contract.
 * The wrapper applies the session latch (never downgrade mid-session) on top.
 */
function decideEntitlement(input) {
    const graceWindowMs = input.graceWindowMs ?? exports.GRACE_WINDOW_MS;
    const graceNoticeMs = input.graceNoticeMs ?? exports.GRACE_NOTICE_MS;
    // 0. Gate disabled (kill switch / not flipped) → legacy boolean verbatim.
    if (!input.gateEnabled) {
        return decision({ pro: input.legacyLicensed, source: 'legacy-fallback', reason: 'gate-disabled' });
    }
    // 0b. Hardware id unreadable → we cannot produce a trustworthy negative, so we
    //     must not manufacture one. Honor the legacy boolean (a locked-down env or
    //     VM never loses Pro over an unreadable machine id).
    if (!input.deviceHashAvailable) {
        return decision({ pro: input.legacyLicensed, source: 'legacy-fallback', reason: 'device-unavailable' });
    }
    // 1. A cached signed entitlement we can verify locally (offline-capable to notAfter).
    if (input.cacheVerify) {
        if (input.cacheVerify.ok) {
            return decision({ pro: true, source: 'entitlement', reason: 'verified' });
        }
        switch (input.cacheVerify.reason) {
            case 'pro-not-enabled':
                // A signed blob that says NO — refund / disable. Permanent.
                return decision({ pro: false, source: 'free', reason: 'revoked', definitive: true });
            case 'build-outside-updates-window':
                // Legit customer, but this build is past their paid window (§4.2). Free
                // on THIS build — not an error, just the model. Offer renew, don't accuse.
                return decision({
                    pro: false,
                    source: 'free',
                    reason: 'window-ended',
                    notice: 'window-ended',
                    windowEndedAt: input.cacheExpiresAt,
                });
            // device-mismatch (hardware changed), entitlement-expired (cache past
            // notAfter), clock-rolled-back, bad-signature, malformed-* → the cache is
            // unusable but says nothing definitive; fall through to the grace path.
        }
    }
    // 2. No usable cache. Without a plausible key there is nothing to exchange or
    //    shelter — this is the hand-edited `isLicensed:true` + no key case (§8.3 #5).
    if (!input.hasPlausibleKey) {
        return decision({ pro: false, source: 'free', reason: 'no-license' });
    }
    // 3. Plausible key, no usable cache. A DEFINITIVE server rejection ends it now;
    //    anything recoverable falls into the bounded grace window.
    if (input.lastExchange === 'definitive-negative') {
        return decision({ pro: false, source: 'free', reason: 'exchange-rejected', definitive: true });
    }
    const started = input.graceStartedAt ?? input.now;
    const graceEndsMs = started.getTime() + graceWindowMs;
    const graceUntil = new Date(graceEndsMs).toISOString();
    if (input.now.getTime() < graceEndsMs) {
        const nearingEnd = graceEndsMs - input.now.getTime() < graceNoticeMs;
        return decision({
            pro: true,
            source: 'grace',
            reason: 'grace',
            graceUntil,
            graceStartedAt: started,
            notice: nearingEnd ? 'verify-failed' : null,
        });
    }
    // Grace exhausted: 14 days of only-transient failures. Now, and only now, drop.
    return decision({ pro: false, source: 'free', reason: 'grace-expired', notice: 'verify-failed' });
}
