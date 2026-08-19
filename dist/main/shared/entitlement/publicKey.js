"use strict";
// Embedded Ed25519 PUBLIC key for entitlement verification — Workstream A, P2.
//
// Open-source build: the entitlement gate and shadow exchange are permanently
// disabled, so no verification endpoint or public key material is needed.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENTITLEMENT_ENDPOINT = exports.ENTITLEMENT_DEVICE_SALT = exports.ENTITLEMENT_PRODUCT = exports.ENTITLEMENT_PUBLIC_KEY_PEM = void 0;
exports.ENTITLEMENT_PUBLIC_KEY_PEM = ``;
/** Wire product id this app sends to — and expects back from — the signer. */
exports.ENTITLEMENT_PRODUCT = '1devtool';
/**
 * Per-product salt folded into the hardware hash (see deviceHash.ts). NOT a
 * secret — it only keeps one product's deviceHash from matching another's.
 */
exports.ENTITLEMENT_DEVICE_SALT = '1devtool-entitlement-v1';
/** Production signing endpoint — removed in the open-source build. */
exports.ENTITLEMENT_ENDPOINT = '';
