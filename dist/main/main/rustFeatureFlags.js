"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RUST_FILE_WATCHER_FLAG = exports.RUST_FILE_SYSTEM_FLAG = void 0;
exports.isRustFeatureEnabled = isRustFeatureEnabled;
exports.getRustFeatureFlagDiagnostics = getRustFeatureFlagDiagnostics;
exports.RUST_FILE_SYSTEM_FLAG = 'rust.fileSystem.enabled';
exports.RUST_FILE_WATCHER_FLAG = 'rust.fileWatcher.enabled';
const FLAG_ENV_NAMES = {
    [exports.RUST_FILE_SYSTEM_FLAG]: [
        'ONEDEVTOOL_RUST_FILE_SYSTEM',
        'ONEDEVTOOL_RUST_FILE_SYSTEM_ENABLED',
    ],
    [exports.RUST_FILE_WATCHER_FLAG]: [
        'ONEDEVTOOL_RUST_FILE_WATCHER',
        'ONEDEVTOOL_RUST_FILE_WATCHER_ENABLED',
    ],
};
const FLAG_DEFAULTS = {
    [exports.RUST_FILE_SYSTEM_FLAG]: false,
    // The native watcher is the shipping path. A missing or unhealthy sidecar
    // falls back per root, and the env flag remains a release kill switch.
    [exports.RUST_FILE_WATCHER_FLAG]: true,
};
function isRustFeatureEnabled(flag) {
    for (const name of FLAG_ENV_NAMES[flag]) {
        const override = parseBoolean(process.env[name]);
        if (override !== undefined) {
            return override;
        }
    }
    return FLAG_DEFAULTS[flag];
}
function getRustFeatureFlagDiagnostics() {
    return {
        [exports.RUST_FILE_SYSTEM_FLAG]: isRustFeatureEnabled(exports.RUST_FILE_SYSTEM_FLAG),
        [exports.RUST_FILE_WATCHER_FLAG]: isRustFeatureEnabled(exports.RUST_FILE_WATCHER_FLAG),
    };
}
function parseBoolean(value) {
    if (value === undefined)
        return undefined;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized))
        return true;
    if (['0', 'false', 'no', 'off'].includes(normalized))
        return false;
    return undefined;
}
