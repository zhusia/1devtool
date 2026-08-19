"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getHermesHome = getHermesHome;
exports.getHermesMemoryDirectory = getHermesMemoryDirectory;
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
/** Hermes' configurable data root. Defaults to ~/.hermes. */
function getHermesHome() {
    const configured = process.env.HERMES_HOME?.trim();
    if (!configured)
        return path_1.default.join(os_1.default.homedir(), '.hermes');
    if (configured === '~')
        return os_1.default.homedir();
    if (configured.startsWith(`~${path_1.default.sep}`) || configured.startsWith('~/')) {
        return path_1.default.join(os_1.default.homedir(), configured.slice(2));
    }
    return path_1.default.resolve(configured);
}
function getHermesMemoryDirectory() {
    return path_1.default.join(getHermesHome(), 'memories');
}
