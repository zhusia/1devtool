"use strict";
// BUILD_RELEASE_DATE reader — the offline half of §4.2's build-date rule.
// CI exports BUILD_RELEASE_DATE before `npm run build`; copy-main-assets.mjs
// stamps it into dist/main/build-release-date.json, which ships inside the asar
// next to the compiled main bundle. Local/dev builds have no stamp → null, and
// callers must treat null as "no window constraint" (epoch) — a legit user who
// builds from source or runs dev must never lose Pro to a missing stamp.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBuildReleaseDate = getBuildReleaseDate;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
let cached;
function getBuildReleaseDate() {
    if (cached !== undefined)
        return cached;
    // Test/dev override.
    const fromEnv = process.env.ONEDEVTOOL_BUILD_RELEASE_DATE;
    if (fromEnv) {
        const d = new Date(fromEnv);
        cached = Number.isNaN(d.getTime()) ? null : d;
        return cached;
    }
    // Compiled location: dist/main/main/entitlement/buildReleaseDate.js → stamp
    // sits at dist/main/build-release-date.json (two levels up).
    try {
        const stampPath = node_path_1.default.join(__dirname, '..', '..', 'build-release-date.json');
        const parsed = JSON.parse((0, node_fs_1.readFileSync)(stampPath, 'utf8'));
        const d = parsed.releaseDate ? new Date(parsed.releaseDate) : null;
        cached = d && !Number.isNaN(d.getTime()) ? d : null;
    }
    catch {
        cached = null;
    }
    return cached;
}
