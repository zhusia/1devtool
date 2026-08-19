"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createElectronKV = createElectronKV;
/**
 * Production DeviceKV backed by electron-store. Isolated in its own module so
 * every other device file stays importable under tsx (no electron).
 * electron-store only writes its file on first set — instantiating here does
 * not materialize state on disk, preserving the §4.1 gate semantics.
 */
const electron_store_1 = __importDefault(require("electron-store"));
function createElectronKV(name) {
    const store = new electron_store_1.default({ name });
    return {
        get: (key) => store.get(key),
        set: (key, value) => store.set(key, value),
        delete: (key) => store.delete(key),
    };
}
