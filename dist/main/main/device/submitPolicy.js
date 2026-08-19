"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authorizeTerminalMirror = authorizeTerminalMirror;
exports.authorizeTerminalSubmit = authorizeTerminalSubmit;
const identity_1 = require("../../shared/device/identity");
function authorizeTerminalMirror(input) {
    const { peer, resolved, terminalGeneration } = input;
    if (!peer) {
        return { ok: false, error: { code: 'DEVICE_NOT_PAIRED', message: 'Unknown device.' } };
    }
    if (peer.confirmedAt === null) {
        return {
            ok: false,
            error: { code: 'DEVICE_NOT_CONFIRMED', message: 'Confirm the fingerprint on this machine first.' },
        };
    }
    if (!(0, identity_1.hasDeviceGrant)(peer.grants, 'terminalControl')) {
        return {
            ok: false,
            error: {
                code: 'DEVICE_GRANT_MISSING',
                message: `${peer.displayName} may see the agent roster here, not stream terminal output. Enable "Control terminals" in Settings → Devices.`,
            },
        };
    }
    if (!resolved) {
        return {
            ok: false,
            error: { code: 'DEVICE_TERMINAL_NOT_FOUND', message: 'That terminal no longer exists on this machine.' },
        };
    }
    if (!(0, identity_1.projectInGrantScope)(peer.grants, resolved.projectId)) {
        return {
            ok: false,
            error: { code: 'DEVICE_TERMINAL_NOT_FOUND', message: 'That terminal is outside the shared project scope.' },
        };
    }
    if (!resolved.running) {
        return {
            ok: false,
            error: { code: 'DEVICE_TERMINAL_NOT_RUNNING', message: 'That terminal is not running on this machine.' },
        };
    }
    if (!Number.isSafeInteger(terminalGeneration) ||
        terminalGeneration <= 0 ||
        terminalGeneration !== resolved.terminalGeneration) {
        return {
            ok: false,
            error: { code: 'DEVICE_GENERATION_MISMATCH', message: 'The mirrored terminal was restarted. Refresh it before subscribing.' },
        };
    }
    return { ok: true };
}
function authorizeTerminalSubmit(input) {
    const { peer, resolved, text } = input;
    if (!peer) {
        return { ok: false, error: { code: 'DEVICE_NOT_PAIRED', message: 'Unknown device.' } };
    }
    if (peer.confirmedAt === null) {
        return {
            ok: false,
            error: { code: 'DEVICE_NOT_CONFIRMED', message: 'Confirm the fingerprint on this machine first.' },
        };
    }
    if (!(0, identity_1.hasDeviceGrant)(peer.grants, 'terminalControl')) {
        return {
            ok: false,
            error: {
                code: 'DEVICE_GRANT_MISSING',
                message: `${peer.displayName} may view agents here, not control them. Enable "Control terminals" in Settings → Devices.`,
            },
        };
    }
    if (typeof text !== 'string' || text.trim().length === 0) {
        return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Empty prompt.' } };
    }
    if (!resolved) {
        return {
            ok: false,
            error: { code: 'DEVICE_TERMINAL_NOT_FOUND', message: 'That terminal no longer exists on this machine.' },
        };
    }
    if (!(0, identity_1.projectInGrantScope)(peer.grants, resolved.projectId)) {
        return {
            ok: false,
            error: { code: 'DEVICE_TERMINAL_NOT_FOUND', message: 'That terminal is outside the shared project scope.' },
        };
    }
    if (!resolved.isInteractiveAgent) {
        return {
            ok: false,
            error: {
                code: 'DEVICE_TERMINAL_NOT_AI',
                message: 'That is a shell, not an AI terminal — a staged prompt would run as a command.',
            },
        };
    }
    if (!resolved.running) {
        return {
            ok: false,
            error: { code: 'DEVICE_TERMINAL_NOT_RUNNING', message: 'That terminal is not running on this machine.' },
        };
    }
    return { ok: true };
}
