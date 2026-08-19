"use strict";
/**
 * Multi-Control Device — wire protocol constants and message shapes.
 *
 * Everything here crosses the desktop↔desktop boundary, so changes require a
 * PROTOCOL_VERSION bump and a negotiation rule. See docs/multi_control_device.md §6.4.
 *
 * This module is electron-free and side-effect-free (unit-testable via tsx).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEVICE_HEALTH_PATH = exports.DEVICE_PAIR_CODE_PREFIX = exports.DEVICE_PEER_STALE_MS = exports.DEVICE_PAIRING_TTL_MS = exports.DEVICE_DEFAULT_PORT = exports.DEVICE_PROTOCOL_VERSION = void 0;
/** Bumped on any incompatible change to pairing or /device namespace payloads. */
exports.DEVICE_PROTOCOL_VERSION = 4;
/** Default TCP port for the device federation server (separate from phone Remote's 1834). */
exports.DEVICE_DEFAULT_PORT = 1841;
/** Pairing secret time-to-live (same policy as phone Remote pairing). */
exports.DEVICE_PAIRING_TTL_MS = 10 * 60 * 1000;
/** Peer records do not silently expire like phone records; re-verified via lastSeen only. */
exports.DEVICE_PEER_STALE_MS = 90 * 24 * 60 * 60 * 1000;
/** Prefix for the human-pasteable pairing code. */
exports.DEVICE_PAIR_CODE_PREFIX = '1DVT-DEV-';
/** Probe path used to pick a reachable endpoint before opening a session. */
exports.DEVICE_HEALTH_PATH = '/api/device-health';
