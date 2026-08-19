"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TERMINAL_RAW_V1_GRACE_MS = exports.TERMINAL_RAW_V1_MIN_REMOVAL_VERSION = exports.TERMINAL_V2_REMOTE_DEFAULT_RELEASED_AT = exports.TERMINAL_V2_REMOTE_DEFAULT_RELEASE_VERSION = void 0;
exports.rawV1RemoteCompatibilityActive = rawV1RemoteCompatibilityActive;
/** Raw-v1 Remote UI compatibility clock.
 *
 * v2 became the default in the 1.60.1 release line. Raw-v1 remains available
 * until BOTH the N+1 minor gate and the 90-day cache/WebView grace have
 * elapsed. Desktop IPC is same-binary and does not use this long-tail gate.
 */
exports.TERMINAL_V2_REMOTE_DEFAULT_RELEASE_VERSION = '1.60.1';
exports.TERMINAL_V2_REMOTE_DEFAULT_RELEASED_AT = Date.parse('2026-08-10T00:00:00Z');
exports.TERMINAL_RAW_V1_MIN_REMOVAL_VERSION = '1.61.0';
exports.TERMINAL_RAW_V1_GRACE_MS = 90 * 24 * 60 * 60 * 1_000;
/** Unparseable versions fail open as 0.0.0 (compatibility stays active). */
function parseVersion(value) {
    const match = /^(\d+)\.(\d+)\.(\d+)(-\S+)?/.exec(value);
    if (!match)
        return { parts: [0, 0, 0], prerelease: false };
    return {
        parts: [Number(match[1]), Number(match[2]), Number(match[3])],
        prerelease: match[4] !== undefined,
    };
}
function compareVersions(left, right) {
    const a = parseVersion(left);
    const b = parseVersion(right);
    for (let index = 0; index < 3; index += 1) {
        if (a.parts[index] !== b.parts[index])
            return a.parts[index] < b.parts[index] ? -1 : 1;
    }
    // A prerelease of X.Y.Z sorts below X.Y.Z (semver precedence): 1.61.0-beta.1
    // must not end raw-v1 compatibility before stable 1.61.0 ships.
    if (a.prerelease === b.prerelease)
        return 0;
    return a.prerelease ? -1 : 1;
}
function rawV1RemoteCompatibilityActive(currentVersion, now = Date.now()) {
    const insideTimeGrace = now < exports.TERMINAL_V2_REMOTE_DEFAULT_RELEASED_AT + exports.TERMINAL_RAW_V1_GRACE_MS;
    const beforeNextMinor = compareVersions(currentVersion, exports.TERMINAL_RAW_V1_MIN_REMOVAL_VERSION) < 0;
    return insideTimeGrace || beforeNextMinor;
}
