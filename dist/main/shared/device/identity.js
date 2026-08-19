"use strict";
/**
 * Multi-Control Device — device identity, peer records, capability grants.
 *
 * A "device" here is another 1DevTool desktop host owned by the same user —
 * never a phone (phones stay in src/main/remote/devices.ts with a different
 * permission model). See docs/multi_control_device.md §6.1.
 *
 * Electron-free and side-effect-free.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultDeviceGrant = defaultDeviceGrant;
exports.hasDeviceGrant = hasDeviceGrant;
exports.projectInGrantScope = projectInGrantScope;
exports.toPeerSummary = toPeerSummary;
exports.emptyDeviceFederationState = emptyDeviceFederationState;
/**
 * Conservative pairing defaults (plan J1): see + drive terminals, nothing
 * else. Orchestration and memory are explicit second steps in Settings.
 */
function defaultDeviceGrant() {
    return {
        catalog: true,
        terminalControl: true,
        terminalLaunch: false,
        orchestrationWrite: false,
        memoryRead: false,
        memoryWrite: false,
        headlessRun: false,
        skillInstall: false,
        projectScope: 'all',
    };
}
function hasDeviceGrant(grant, capability) {
    if (!grant)
        return false;
    return grant[capability] === true;
}
function projectInGrantScope(grant, projectId) {
    if (!grant)
        return false;
    if (grant.projectScope === 'all')
        return true;
    return grant.projectScope.projectIds.includes(projectId);
}
function toPeerSummary(peer, online) {
    return {
        deviceId: peer.deviceId,
        displayName: peer.displayName,
        platform: peer.platform,
        appVersion: peer.appVersion,
        endpoints: peer.endpoints,
        // Additive grant migration: old peer rows remain readable without a store
        // rewrite and new capabilities stay denied until explicitly enabled.
        grants: { ...defaultDeviceGrant(), ...peer.grants },
        pairedAt: peer.pairedAt,
        confirmedAt: peer.confirmedAt,
        lastSeenAt: peer.lastSeenAt,
        trustFingerprint: peer.trustFingerprint,
        online,
    };
}
function emptyDeviceFederationState() {
    return {
        self: null,
        peers: [],
        serverRunning: false,
        serverPort: null,
        pairing: { active: false, code: null, url: null, expiresAt: null },
        pendingConfirm: [],
        links: [],
    };
}
