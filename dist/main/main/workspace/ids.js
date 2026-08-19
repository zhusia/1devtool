"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mintWorkspaceId = mintWorkspaceId;
exports.mintWorkspaceOperationId = mintWorkspaceOperationId;
const crypto_1 = require("crypto");
/**
 * Workspace ids (docs/workspace_control/02-data-model.md §2): `ws-` + at
 * least 64 random bits, Crockford base32 (lowercase, no i/l/o/u) — the same
 * scheme as Task ids. Never derived from a name or group id.
 */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const ID_CHARS = 13;
function encodeBase32(bytes, chars) {
    let value = 0n;
    for (const b of bytes)
        value = (value << 8n) | BigInt(b);
    let out = '';
    for (let i = 0; i < chars; i++) {
        out = ALPHABET[Number(value & 31n)] + out;
        value >>= 5n;
    }
    return out;
}
function mintWorkspaceId() {
    return `ws-${encodeBase32((0, crypto_1.randomBytes)(8), ID_CHARS)}`;
}
/** Operation ids for workspace send/broadcast/collect correlation (D7, P3). */
function mintWorkspaceOperationId() {
    return `wop-${encodeBase32((0, crypto_1.randomBytes)(8), ID_CHARS)}`;
}
