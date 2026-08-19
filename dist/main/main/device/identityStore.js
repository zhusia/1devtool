"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeviceIdentityStore = void 0;
/**
 * Local device identity. LAZY BY CONTRACT (§4.1): nothing constructs this
 * store — and no identity is minted — until the user enters a pairing flow.
 * `device:get-state` at zero peers must answer without touching this module.
 */
const crypto_1 = __importDefault(require("crypto"));
const IDENTITY_KEY = 'identity';
const PRIVATE_KEY_KEY = 'privateKeyPem';
class DeviceIdentityStore {
    kv;
    constructor(kv) {
        this.kv = kv;
    }
    get() {
        return this.kv.get(IDENTITY_KEY) ?? null;
    }
    /**
     * Create the identity on first pairing flow. Long-lived Ed25519 device key
     * (plan §6.1) — session auth uses pairing-derived HMAC keys; this key is
     * reserved for future re-key/attestation, minted now so the id is stable.
     */
    ensure(input, now = Date.now()) {
        const existing = this.get();
        if (existing)
            return existing;
        const { publicKey, privateKey } = crypto_1.default.generateKeyPairSync('ed25519');
        const identity = {
            deviceId: crypto_1.default.randomBytes(16).toString('base64url'),
            displayName: input.displayName,
            platform: input.platform,
            appVersion: input.appVersion,
            publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
            createdAt: now,
        };
        this.kv.set(PRIVATE_KEY_KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
        this.kv.set(IDENTITY_KEY, identity);
        return identity;
    }
    rename(displayName) {
        const identity = this.get();
        if (!identity)
            return null;
        const next = { ...identity, displayName };
        this.kv.set(IDENTITY_KEY, next);
        return next;
    }
    /** Keep advertised appVersion current across app updates. */
    refreshAppVersion(appVersion) {
        const identity = this.get();
        if (identity && identity.appVersion !== appVersion) {
            this.kv.set(IDENTITY_KEY, { ...identity, appVersion });
        }
    }
}
exports.DeviceIdentityStore = DeviceIdentityStore;
