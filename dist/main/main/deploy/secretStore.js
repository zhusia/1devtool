"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeploySecretStore = void 0;
exports.hashToken = hashToken;
exports.tokenLast4 = tokenLast4;
const electron_1 = require("electron");
const electron_store_1 = __importDefault(require("electron-store"));
const crypto_1 = require("crypto");
class DeploySecretStore {
    store;
    constructor() {
        this.store = new electron_store_1.default({
            name: '1devtool',
            defaults: {
                deploySecrets: {},
            },
        });
    }
    setToken(provider, token) {
        const trimmed = token.trim();
        if (!trimmed) {
            this.deleteToken(provider);
            return;
        }
        if (!electron_1.safeStorage.isEncryptionAvailable()) {
            throw new Error('Secure token storage is not available on this machine.');
        }
        const encrypted = electron_1.safeStorage.encryptString(trimmed).toString('base64');
        const all = this.store.get('deploySecrets') || {};
        this.store.set('deploySecrets', {
            ...all,
            [this.keyForProvider(provider)]: encrypted,
        });
    }
    getToken(provider) {
        const all = this.store.get('deploySecrets') || {};
        const encrypted = all[this.keyForProvider(provider)];
        if (!encrypted)
            return null;
        if (!electron_1.safeStorage.isEncryptionAvailable()) {
            throw new Error('Secure token storage is not available on this machine.');
        }
        try {
            return electron_1.safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
        }
        catch {
            return null;
        }
    }
    deleteToken(provider) {
        const all = { ...(this.store.get('deploySecrets') || {}) };
        delete all[this.keyForProvider(provider)];
        this.store.set('deploySecrets', all);
    }
    tokenHash(token) {
        return hashToken(token);
    }
    keyForProvider(provider) {
        return `1devtool.deploy.${provider}`;
    }
}
exports.DeploySecretStore = DeploySecretStore;
function hashToken(token) {
    return (0, crypto_1.createHash)('sha256').update(token.trim()).digest('hex');
}
function tokenLast4(token) {
    return token.trim().slice(-4);
}
