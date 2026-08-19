"use strict";
// ⚠️ DEV / TEST ONLY — Workstream A / roadmap #8, phase P0.
//
// In production the Ed25519 PRIVATE KEY lives ONLY in the Worker's secret store
// (P1) and NEVER ships in the app — the app embeds the PUBLIC key and can only
// verify, never mint (docs/product/strategy/licensing-updates-monetization.md §4.1, §4.4 "Crown jewel").
//
// This helper exists so unit tests and local tooling can generate throwaway
// keypairs and mint fixtures. Do NOT import it from the app's license flow.
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateKeypair = generateKeypair;
exports.signEntitlement = signEntitlement;
exports.signEntitlementBlob = signEntitlementBlob;
const node_crypto_1 = require("node:crypto");
const canonicalize_1 = require("./canonicalize");
/** Generate a throwaway Ed25519 keypair (dev/test only). */
function generateKeypair() {
    const { publicKey, privateKey } = (0, node_crypto_1.generateKeyPairSync)('ed25519');
    return { publicKey, privateKey };
}
/**
 * Sign an entitlement over its canonical bytes.
 * @returns base64 Ed25519 signature. (Algorithm arg is null — required for Ed25519.)
 */
function signEntitlement(entitlement, privateKey) {
    return (0, node_crypto_1.sign)(null, (0, canonicalize_1.canonicalBytes)(entitlement), privateKey).toString('base64');
}
/** Convenience: produce the full `{ entitlement, signature }` blob. */
function signEntitlementBlob(entitlement, privateKey) {
    return { entitlement, signature: signEntitlement(entitlement, privateKey) };
}
