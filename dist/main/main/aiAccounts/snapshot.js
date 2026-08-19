"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeEncryptedSnapshot = writeEncryptedSnapshot;
exports.readEncryptedSnapshot = readEncryptedSnapshot;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
/**
 * Encrypt `payload` via Electron safeStorage and atomically write to `destPath`.
 * Callers must have already verified `safeStorage.isEncryptionAvailable()` — we
 * throw here as a belt-and-braces check so we never land plaintext tokens on disk.
 */
async function writeEncryptedSnapshot(destPath, payload) {
    if (!electron_1.safeStorage.isEncryptionAvailable()) {
        throw new Error('Secure storage is not available on this machine.');
    }
    const plaintext = JSON.stringify(payload);
    const ciphertext = electron_1.safeStorage.encryptString(plaintext);
    await fs_1.promises.mkdir(path_1.default.dirname(destPath), { recursive: true });
    const tmp = `${destPath}.${process.pid}.${Date.now()}.tmp`;
    await fs_1.promises.writeFile(tmp, ciphertext, { mode: 0o600 });
    await fs_1.promises.rename(tmp, destPath);
}
async function readEncryptedSnapshot(srcPath) {
    let buf;
    try {
        buf = await fs_1.promises.readFile(srcPath);
    }
    catch {
        return null;
    }
    if (!electron_1.safeStorage.isEncryptionAvailable()) {
        throw new Error('Secure storage is not available on this machine.');
    }
    try {
        const plaintext = electron_1.safeStorage.decryptString(buf);
        return JSON.parse(plaintext);
    }
    catch {
        return null;
    }
}
