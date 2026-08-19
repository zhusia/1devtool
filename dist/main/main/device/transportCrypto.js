"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sealDevicePayload = sealDevicePayload;
exports.openDevicePayload = openDevicePayload;
/**
 * End-to-end payload protection for the peer namespace.
 *
 * TLS tunnels protect the hop to the relay, not necessarily the relay itself.
 * Pairing already derives a unique AES-256 key, so every post-auth RPC/event
 * is sealed with AES-GCM and a monotonic, direction-bound sequence number.
 */
const node_crypto_1 = require("node:crypto");
function keyBytes(encoded) {
    const key = Buffer.from(encoded, 'base64url');
    if (key.length !== 32)
        throw new Error('Invalid device encryption key');
    return key;
}
function aadBytes(context, sequence) {
    const { fromDeviceId, toDeviceId, channel, sessionChallenge } = context;
    if (!fromDeviceId || !toDeviceId || !sessionChallenge) {
        throw new Error('Missing device frame session context');
    }
    return Buffer.from(`1devtool-device-v3\0${fromDeviceId}\0${toDeviceId}\0${channel}\0${sessionChallenge}\0${sequence}`, 'utf8');
}
function sealDevicePayload(encodedKey, sequence, context, value) {
    if (!Number.isSafeInteger(sequence) || sequence <= 0)
        throw new Error('Invalid device sequence');
    const nonce = (0, node_crypto_1.randomBytes)(12);
    const cipher = (0, node_crypto_1.createCipheriv)('aes-256-gcm', keyBytes(encodedKey), nonce);
    cipher.setAAD(aadBytes(context, sequence));
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
        version: 1,
        sequence,
        nonce: nonce.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
    };
}
function openDevicePayload(encodedKey, envelope, context, expectedSequence) {
    if (envelope?.version !== 1 ||
        envelope.sequence !== expectedSequence ||
        !Number.isSafeInteger(expectedSequence) ||
        expectedSequence <= 0) {
        throw new Error('Device frame replay or sequence gap');
    }
    const nonce = Buffer.from(envelope.nonce, 'base64url');
    const tag = Buffer.from(envelope.tag, 'base64url');
    if (nonce.length !== 12 || tag.length !== 16)
        throw new Error('Malformed device frame');
    const decipher = (0, node_crypto_1.createDecipheriv)('aes-256-gcm', keyBytes(encodedKey), nonce);
    decipher.setAAD(aadBytes(context, expectedSequence));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
        decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8'));
}
