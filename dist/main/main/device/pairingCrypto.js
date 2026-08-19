"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPairingSession = createPairingSession;
exports.isPairingSessionValid = isPairingSessionValid;
exports.deriveDeviceKeys = deriveDeviceKeys;
exports.completePairingAsHost = completePairingAsHost;
exports.completePairingAsJoiner = completePairingAsJoiner;
exports.computeDeviceProof = computeDeviceProof;
exports.verifyDeviceProof = verifyDeviceProof;
exports.generateDeviceChallenge = generateDeviceChallenge;
exports.fingerprintFromKeys = fingerprintFromKeys;
/**
 * Device↔device pairing crypto. Same primitives as phone Remote pairing
 * (src/main/remote/auth.ts: ECDH prime256v1 + HKDF-SHA256 + HMAC challenge
 * proofs) but standalone functions so BOTH sides of a desktop pair can derive
 * identical keys, plus a human-verifiable fingerprint (plan §6.1 mutual
 * confirm). Node-only, electron-free — unit-tested directly via tsx.
 */
const crypto_1 = __importDefault(require("crypto"));
const protocol_1 = require("../../shared/device/protocol");
/** Host side: mint a one-time secret + ephemeral ECDH keypair. */
function createPairingSession(now = Date.now()) {
    const ecdh = crypto_1.default.createECDH('prime256v1');
    ecdh.generateKeys();
    return {
        pairingSecret: crypto_1.default.randomBytes(32).toString('base64url'),
        publicKeyBase64: ecdh.getPublicKey().toString('base64url'),
        expiresAt: now + protocol_1.DEVICE_PAIRING_TTL_MS,
        ecdh,
    };
}
function isPairingSessionValid(session, now = Date.now()) {
    return !!session && now < session.expiresAt;
}
/** Both keys derive from ECDH shared secret salted with the pairing secret. */
function deriveDeviceKeys(sharedSecret, pairingSecret) {
    const salt = Buffer.from(pairingSecret, 'utf8');
    const authKey = Buffer.from(crypto_1.default.hkdfSync('sha256', sharedSecret, salt, '1devtool-device-auth-key', 32));
    const encryptKey = Buffer.from(crypto_1.default.hkdfSync('sha256', sharedSecret, salt, '1devtool-device-encrypt-key', 32));
    return { sharedSecret, authKey, encryptKey };
}
/**
 * Host side: verify the presented secret (timing-safe) and complete ECDH
 * against the joiner's public key. Returns null on any mismatch/expiry.
 */
function completePairingAsHost(session, presentedSecret, joinerPublicKeyBase64, now = Date.now()) {
    if (!isPairingSessionValid(session, now) || !session)
        return null;
    const expected = Buffer.from(session.pairingSecret, 'utf8');
    const presented = Buffer.from(presentedSecret || '', 'utf8');
    if (expected.length !== presented.length)
        return null;
    if (!crypto_1.default.timingSafeEqual(expected, presented))
        return null;
    try {
        const shared = session.ecdh.computeSecret(Buffer.from(joinerPublicKeyBase64, 'base64url'));
        return deriveDeviceKeys(shared, session.pairingSecret);
    }
    catch {
        return null;
    }
}
/**
 * Joiner side: generate our own ephemeral keypair and complete ECDH against
 * the host public key embedded in the pairing code.
 */
function completePairingAsJoiner(pairingSecret, hostPublicKeyBase64) {
    try {
        const ecdh = crypto_1.default.createECDH('prime256v1');
        ecdh.generateKeys();
        const shared = ecdh.computeSecret(Buffer.from(hostPublicKeyBase64, 'base64url'));
        return {
            publicKeyBase64: ecdh.getPublicKey().toString('base64url'),
            keys: deriveDeviceKeys(shared, pairingSecret),
        };
    }
    catch {
        return null;
    }
}
/* ---------------------------------------------------------------- proofs */
/** HMAC proof over challenge|deviceId|timestamp — same shape as phone auth. */
function computeDeviceProof(authKeyBase64, challenge, deviceId, timestamp) {
    const key = Buffer.from(authKeyBase64, 'base64url');
    const message = `${challenge}|${deviceId}|${timestamp}`;
    return crypto_1.default.createHmac('sha256', key).update(message).digest('base64url');
}
function verifyDeviceProof(authKeyBase64, challenge, deviceId, timestamp, proof, now = Date.now()) {
    if (Math.abs(now - timestamp) > 60_000)
        return false;
    const expected = computeDeviceProof(authKeyBase64, challenge, deviceId, timestamp);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(proof || '', 'utf8');
    if (a.length !== b.length)
        return false;
    return crypto_1.default.timingSafeEqual(a, b);
}
function generateDeviceChallenge() {
    return crypto_1.default.randomBytes(32).toString('base64url');
}
/* ----------------------------------------------------------- fingerprint */
/**
 * Human-verifiable trust fingerprint, e.g. "coral-lake-42". Both sides derive
 * it from the ECDH shared secret, so it matches iff the key exchange was not
 * intercepted. 64×64×100 ≈ 400k combinations — fine for a human compare that
 * an attacker cannot influence without breaking ECDH.
 */
const FP_ADJECTIVES = [
    'amber', 'azure', 'brave', 'briar', 'cedar', 'civic', 'coral', 'crisp',
    'delta', 'dusty', 'ebony', 'ember', 'fable', 'flint', 'gale', 'glade',
    'hazel', 'ionic', 'ivory', 'jade', 'karst', 'kelp', 'linen', 'lunar',
    'maple', 'mint', 'noble', 'north', 'ocher', 'olive', 'onyx', 'opal',
    'pearl', 'pine', 'plume', 'polar', 'quartz', 'quiet', 'rapid', 'raven',
    'reef', 'ridge', 'river', 'rustic', 'sable', 'sage', 'slate', 'solar',
    'spruce', 'steel', 'stone', 'storm', 'swift', 'terra', 'tidal', 'topaz',
    'umber', 'vapor', 'velvet', 'vivid', 'walnut', 'willow', 'zephyr', 'zinc',
];
const FP_NOUNS = [
    'arch', 'atlas', 'basin', 'beach', 'bend', 'bluff', 'brook', 'cairn',
    'canyon', 'cape', 'cliff', 'cloud', 'cove', 'creek', 'crest', 'dale',
    'delta', 'dune', 'falls', 'fern', 'field', 'fjord', 'forge', 'fork',
    'glen', 'grove', 'harbor', 'haven', 'heath', 'hill', 'holt', 'inlet',
    'isle', 'knoll', 'lagoon', 'lake', 'ledge', 'marsh', 'mesa', 'moor',
    'oasis', 'orchard', 'pass', 'peak', 'pier', 'plain', 'point', 'pond',
    'port', 'prairie', 'quay', 'reef', 'ridge', 'shoal', 'shore', 'sound',
    'spring', 'strait', 'summit', 'trail', 'vale', 'valley', 'wharf', 'wood',
];
function fingerprintFromKeys(keys) {
    const digest = crypto_1.default
        .createHash('sha256')
        .update('1devtool-device-fingerprint')
        .update(keys.sharedSecret)
        .digest();
    const adjective = FP_ADJECTIVES[digest[0] % FP_ADJECTIVES.length];
    const noun = FP_NOUNS[digest[1] % FP_NOUNS.length];
    const num = ((digest[2] << 8) | digest[3]) % 100;
    return `${adjective}-${noun}-${num}`;
}
