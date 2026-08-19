"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getKimiHome = getKimiHome;
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
/** Kimi Code's relocatable data root (`$KIMI_CODE_HOME`, then ~/.kimi-code). */
function getKimiHome() {
    const configured = process.env.KIMI_CODE_HOME?.trim();
    return configured ? path_1.default.resolve(configured) : path_1.default.join(os_1.default.homedir(), '.kimi-code');
}
