"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEVICE_PEERS_STORE_NAME = exports.DEVICE_IDENTITY_STORE_NAME = void 0;
exports.deviceStoreFilePaths = deviceStoreFilePaths;
exports.isDeviceFederationMaterialized = isDeviceFederationMaterialized;
/**
 * §4.1 single-device gate. `device:get-state` at zero peers must answer from
 * here alone — without constructing stores, minting identity, or importing
 * the federation service. The check is "do the on-disk store files exist",
 * which is exactly "has the user ever entered a pairing flow on this machine".
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/** electron-store file names (name → <userData>/<name>.json). */
exports.DEVICE_IDENTITY_STORE_NAME = 'device-identity';
exports.DEVICE_PEERS_STORE_NAME = 'device-peers';
function deviceStoreFilePaths(userDataPath) {
    return {
        identity: path_1.default.join(userDataPath, `${exports.DEVICE_IDENTITY_STORE_NAME}.json`),
        peers: path_1.default.join(userDataPath, `${exports.DEVICE_PEERS_STORE_NAME}.json`),
    };
}
/**
 * True once this machine has ever materialized device-federation state.
 * False ⇒ the app must behave byte-for-byte like a build without the feature.
 */
function isDeviceFederationMaterialized(userDataPath) {
    const files = deviceStoreFilePaths(userDataPath);
    return fs_1.default.existsSync(files.identity) || fs_1.default.existsSync(files.peers);
}
