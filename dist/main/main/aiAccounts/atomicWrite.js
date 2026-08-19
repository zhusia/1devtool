"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeFileAtomic = writeFileAtomic;
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const RETRYABLE_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EEXIST', 'EPERM']);
const defaultOps = {
    mkdir: async (dirPath) => {
        await fs_1.promises.mkdir(dirPath, { recursive: true });
    },
    writeFile: async (filePath, contents) => {
        await fs_1.promises.writeFile(filePath, contents, { mode: 0o600 });
    },
    rename: (from, to) => fs_1.promises.rename(from, to),
    rm: async (filePath) => {
        await fs_1.promises.rm(filePath, { force: true });
    },
    wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
};
function errorCode(error) {
    if (!error || typeof error !== 'object')
        return undefined;
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Replace a credential file atomically. Windows may briefly reject rename-over-file
 * while Codex or security software has the destination open, so retry only those
 * transient filesystem errors. Persistent failure remains loud to the caller.
 */
async function writeFileAtomic(filePath, contents, options = {}) {
    const ops = { ...defaultOps, ...options.ops };
    const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
    const baseDelayMs = Math.max(0, options.baseDelayMs ?? 50);
    const dir = path_1.default.dirname(filePath);
    const tmp = path_1.default.join(dir, `.${path_1.default.basename(filePath)}.${process.pid}.${(0, crypto_1.randomUUID)()}.tmp`);
    await ops.mkdir(dir);
    await ops.writeFile(tmp, contents);
    try {
        for (let attempt = 1;; attempt += 1) {
            try {
                await ops.rename(tmp, filePath);
                return;
            }
            catch (error) {
                const code = errorCode(error);
                if (attempt >= maxAttempts || !code || !RETRYABLE_RENAME_CODES.has(code)) {
                    throw error;
                }
                await ops.wait(baseDelayMs * attempt);
            }
        }
    }
    catch (error) {
        await ops.rm(tmp).catch(() => undefined);
        const code = errorCode(error);
        const suffix = code ? ` (${code})` : '';
        throw new Error(`Could not replace credential file "${filePath}"${suffix}: ${errorMessage(error)}`, { cause: error });
    }
}
