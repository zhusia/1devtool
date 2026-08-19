"use strict";
// Hardware-derived device hash — Workstream A / roadmap #8, phase P0.
// Closes §4.4 hole #1: today `ensureDeviceId()` stores a randomUUID() in the same
// editable JSON as the license, so anyone can COPY a friend's signed entitlement
// and TYPE their `deviceId` to match → binding worthless. The fix: derive the
// identity from HARDWARE, hash it with a per-product salt, and recompute it at
// verify time — NEVER read it from disk.
//
// MAIN-PROCESS ONLY. This uses child_process + fs and is deliberately kept OUT of
// the pure verifier (verify.ts takes `currentDeviceHash` as an injected string).
// Platform branches are guarded; every failure path returns null so the caller
// can decide policy (e.g. fall back to activation-limit reset, §4.4 #1).
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRawHardwareId = getRawHardwareId;
exports.computeDeviceHash = computeDeviceHash;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_crypto_1 = require("node:crypto");
const EXEC_OPTS = { encoding: 'utf8', timeout: 4000 };
/** macOS: IOPlatformUUID from the IOPlatformExpertDevice registry entry. */
function readDarwinId() {
    try {
        const out = (0, node_child_process_1.execFileSync)('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], EXEC_OPTS);
        const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
        return m ? m[1] : null;
    }
    catch {
        return null;
    }
}
/** Windows: MachineGuid from HKLM\SOFTWARE\Microsoft\Cryptography. */
function readWindowsId() {
    try {
        const out = (0, node_child_process_1.execFileSync)('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], EXEC_OPTS);
        const m = out.match(/MachineGuid\s+REG_SZ\s+([^\s]+)/i);
        return m ? m[1].trim() : null;
    }
    catch {
        return null;
    }
}
/** Linux / others: /etc/machine-id (fallback to the dbus copy). */
function readLinuxId() {
    for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
            const id = (0, node_fs_1.readFileSync)(p, 'utf8').trim();
            if (id)
                return id;
        }
        catch {
            // try next path
        }
    }
    return null;
}
/**
 * Raw, un-hashed hardware id for the given platform (defaults to the host's).
 * Returns null when it can't be read (locked-down env, motherboard swap, etc.).
 */
function getRawHardwareId(platform = process.platform) {
    if (platform === 'darwin')
        return readDarwinId();
    if (platform === 'win32')
        return readWindowsId();
    return readLinuxId();
}
/**
 * sha256(hardwareId + '::' + productSalt) as lowercase hex — the value the
 * verifier compares against `entitlement.deviceHash`. Salting per product keeps
 * a hash minted for one app from matching on another. Returns null when the
 * hardware id is unavailable (caller falls back to the documented reset path).
 */
function computeDeviceHash(productSalt, platform = process.platform) {
    const raw = getRawHardwareId(platform);
    if (!raw)
        return null;
    return (0, node_crypto_1.createHash)('sha256').update(`${raw}::${productSalt}`).digest('hex');
}
