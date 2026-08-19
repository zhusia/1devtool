"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthManager = void 0;
const crypto_1 = __importDefault(require("crypto"));
const os_1 = __importDefault(require("os"));
class AuthManager {
    pairingState = null;
    PAIRING_TTL = 10 * 60 * 1000; // 10 minutes
    /**
     * Generate new ECDH keypair + pairing secret.
     * Returns the secret (for QR code) and the desktop public key (for ECDH).
     */
    generatePairing() {
        // Invalidate any previous pairing attempt
        this.pairingState = null;
        const ecdh = crypto_1.default.createECDH('prime256v1');
        ecdh.generateKeys();
        const secret = crypto_1.default.randomBytes(32).toString('base64url');
        this.pairingState = {
            secret,
            desktopPrivateKey: Buffer.from(ecdh.getPrivateKey()),
            desktopPublicKey: Buffer.from(ecdh.getPublicKey()),
            createdAt: Date.now(),
        };
        return {
            pairingSecret: secret,
            publicKeyBase64: ecdh.getPublicKey().toString('base64url'),
        };
    }
    /**
     * Verify pairing secret and derive keys from phone's public key.
     * Returns null if the secret is invalid or expired.
     *
     * The secret is deliberately MULTI-USE within its TTL: scanning a QR on a
     * phone often lands in an in-app browser (camera/scanner apps, Telegram…)
     * whose localStorage is isolated from the real browser. The user then opens
     * the same URL in Safari/Chrome and must be able to pair again. Each
     * successful pair creates its own device record (own keys, own entry in the
     * devices list, audited), so a reused secret never shares credentials.
     * Replay of a captured /api/pair request only re-runs ECDH against the
     * attacker's own public key — it cannot recover another device's keys.
     */
    completePairing(pairingSecret, phonePublicKeyBase64) {
        if (!this.pairingState) {
            return null;
        }
        // Check expiry
        if (Date.now() - this.pairingState.createdAt > this.PAIRING_TTL) {
            this.pairingState = null;
            return null;
        }
        // Constant-time secret comparison
        const expectedBuf = Buffer.from(this.pairingState.secret, 'utf-8');
        const receivedBuf = Buffer.from(pairingSecret, 'utf-8');
        if (expectedBuf.length !== receivedBuf.length || !crypto_1.default.timingSafeEqual(expectedBuf, receivedBuf)) {
            return null;
        }
        // Sliding window: a successful pair refreshes the TTL so the user has a
        // full window to redo the pairing in their real browser right after
        // pairing inside an in-app browser.
        this.pairingState.createdAt = Date.now();
        try {
            // Reconstruct ECDH from stored private key
            const ecdh = crypto_1.default.createECDH('prime256v1');
            ecdh.setPrivateKey(this.pairingState.desktopPrivateKey);
            // Decode phone's public key from base64url
            const phonePublicKey = Buffer.from(phonePublicKeyBase64, 'base64url');
            // Compute shared secret via ECDH
            const rawSharedSecret = ecdh.computeSecret(phonePublicKey);
            // Derive authKey and encryptKey using HKDF with pairing secret as salt
            const salt = Buffer.from(pairingSecret, 'utf-8');
            const authKeyBuf = Buffer.from(crypto_1.default.hkdfSync('sha256', rawSharedSecret, salt, Buffer.from('1devtool-auth-key'), 32));
            const encryptKeyBuf = Buffer.from(crypto_1.default.hkdfSync('sha256', rawSharedSecret, salt, Buffer.from('1devtool-encrypt-key'), 32));
            return {
                sharedSecret: rawSharedSecret,
                authKey: authKeyBuf,
                encryptKey: encryptKeyBuf,
            };
        }
        catch {
            return null;
        }
    }
    /**
     * Whether the current pairing secret exists and is still within its TTL.
     * Used to lazily rotate a stale secret before handing out the QR/URL.
     */
    isPairingValid() {
        return (this.pairingState !== null &&
            Date.now() - this.pairingState.createdAt <= this.PAIRING_TTL);
    }
    /**
     * Encrypt pair response payload with AES-256-GCM using the derived encryptKey.
     * Returns nonce and ciphertext (with auth tag appended) as base64url strings.
     */
    encryptPairResponse(encryptKey, payload) {
        const nonce = crypto_1.default.randomBytes(12);
        const cipher = crypto_1.default.createCipheriv('aes-256-gcm', encryptKey, nonce);
        const plaintextJson = JSON.stringify(payload);
        const encrypted = Buffer.concat([cipher.update(plaintextJson, 'utf-8'), cipher.final()]);
        const authTag = cipher.getAuthTag();
        // Append auth tag to ciphertext so the receiver can split on known tag length (16 bytes)
        const ciphertextWithTag = Buffer.concat([encrypted, authTag]);
        return {
            nonce: nonce.toString('base64url'),
            ciphertext: ciphertextWithTag.toString('base64url'),
        };
    }
    /**
     * Generate a random 32-byte challenge for socket authentication.
     */
    generateChallenge() {
        return crypto_1.default.randomBytes(32).toString('base64url');
    }
    /**
     * Verify HMAC-SHA256 challenge-response proof.
     *
     * The proof is HMAC(authKey, challenge || deviceId || timestamp).
     * Timestamp must be within 60 seconds of current time.
     */
    verifyProof(authKey, challenge, deviceId, timestamp, proof) {
        // Reject stale timestamps (60 second window)
        const now = Date.now();
        if (Math.abs(now - timestamp) > 60_000) {
            return false;
        }
        try {
            const keyBuf = Buffer.from(authKey, 'base64url');
            const message = `${challenge}|${deviceId}|${timestamp}`;
            const expectedHmac = crypto_1.default
                .createHmac('sha256', keyBuf)
                .update(message)
                .digest('base64url');
            // Constant-time comparison
            const expectedBuf = Buffer.from(expectedHmac, 'utf-8');
            const receivedBuf = Buffer.from(proof, 'utf-8');
            if (expectedBuf.length !== receivedBuf.length) {
                return false;
            }
            return crypto_1.default.timingSafeEqual(expectedBuf, receivedBuf);
        }
        catch {
            return false;
        }
    }
    /**
     * Get the display name for this desktop machine.
     */
    getDesktopName() {
        return os_1.default.hostname() || '1DevTool Desktop';
    }
}
exports.AuthManager = AuthManager;
