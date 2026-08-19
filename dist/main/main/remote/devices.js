"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeviceManager = exports.DEFAULT_PAIRING_TTL = void 0;
const electron_store_1 = __importDefault(require("electron-store"));
exports.DEFAULT_PAIRING_TTL = 7;
/** Far-future sentinel for 'never' — keeps every `now <= expiresAt` check valid. */
const NEVER_EXPIRES = Number.MAX_SAFE_INTEGER;
class DeviceManager {
    store;
    // In-memory mirror of the store. electron-store re-reads and re-parses the
    // whole file on EVERY .get() and fsyncs an atomic rewrite on every .set(),
    // and DeviceManager sits on per-connection (auth handshake) and per-message
    // (terminal:input audit) paths in the PTY-pumping main process — so reads
    // must never touch disk. This process is the file's only writer.
    devices;
    pairingTtl;
    constructor() {
        this.store = new electron_store_1.default({
            name: 'remote-devices',
            defaults: {
                devices: {},
                pairingTtl: exports.DEFAULT_PAIRING_TTL,
            },
        });
        this.devices = this.store.get('devices');
        const ttl = this.store.get('pairingTtl');
        this.pairingTtl = ttl === 30 || ttl === 'never' ? ttl : exports.DEFAULT_PAIRING_TTL;
    }
    persistDevices() {
        this.store.set('devices', this.devices);
    }
    getPairingTtl() {
        return this.pairingTtl;
    }
    /**
     * Change the pairing TTL and re-extend every currently-paired device from
     * now, so the new window applies immediately (a device one hour from expiry
     * that the user just granted 30 days must not still die tonight).
     */
    setPairingTtl(setting) {
        this.pairingTtl = setting;
        this.store.set('pairingTtl', setting);
        const now = Date.now();
        const expiry = this.computeExpiry(now);
        let changed = false;
        for (const device of Object.values(this.devices)) {
            if (now <= device.expiresAt) {
                device.expiresAt = expiry;
                changed = true;
            }
        }
        if (changed) {
            this.persistDevices();
        }
    }
    /** Expiry timestamp for a pairing established/renewed at `from`. */
    computeExpiry(from = Date.now()) {
        if (this.pairingTtl === 'never')
            return NEVER_EXPIRES;
        return from + this.pairingTtl * 24 * 60 * 60 * 1000;
    }
    /**
     * Register a newly paired device.
     */
    addDevice(record) {
        this.devices[record.deviceId] = record;
        this.persistDevices();
    }
    /**
     * Retrieve a device by its ID. Returns null if not found or expired.
     */
    getDevice(deviceId) {
        const device = this.devices[deviceId];
        if (!device) {
            return null;
        }
        // Auto-expire if past TTL
        if (Date.now() > device.expiresAt) {
            this.removeDevice(deviceId);
            return null;
        }
        return device;
    }
    /**
     * Get all non-expired paired devices.
     */
    getAllDevices() {
        const now = Date.now();
        const result = [];
        for (const device of Object.values(this.devices)) {
            if (now <= device.expiresAt) {
                result.push(device);
            }
        }
        return result;
    }
    /**
     * Remove a device by its ID (revoke pairing).
     */
    removeDevice(deviceId) {
        delete this.devices[deviceId];
        this.persistDevices();
    }
    /**
     * Update the permission level for a device.
     */
    setPermission(deviceId, level) {
        const device = this.devices[deviceId];
        if (!device) {
            return;
        }
        device.permissionLevel = level;
        this.persistDevices();
    }
    /**
     * Record a successful auth handshake: refresh last-seen (sliding expiry
     * window per the configured TTL) and the replay-prevention challenge in ONE
     * store write, and return the renewed record. Handshakes rerun on every
     * socket reconnect, so this path must not multiply fsync'd rewrites.
     */
    recordHandshake(deviceId, challenge) {
        const device = this.devices[deviceId];
        if (!device) {
            return null;
        }
        device.lastSeenAt = Date.now();
        device.expiresAt = this.computeExpiry(device.lastSeenAt);
        device.lastChallenge = challenge;
        this.persistDevices();
        return device;
    }
    /**
     * Update last-seen timestamp for a device (extends effective expiry window).
     */
    updateLastSeen(deviceId) {
        const device = this.devices[deviceId];
        if (!device) {
            return;
        }
        device.lastSeenAt = Date.now();
        // Extend expiry from last seen (sliding window per the configured TTL)
        device.expiresAt = this.computeExpiry(device.lastSeenAt);
        this.persistDevices();
    }
    /**
     * Store the last challenge sent to a device (for replay prevention).
     */
    setLastChallenge(deviceId, challenge) {
        const device = this.devices[deviceId];
        if (!device) {
            return;
        }
        device.lastChallenge = challenge;
        this.persistDevices();
    }
    /**
     * Remove all devices that have expired.
     */
    cleanExpired() {
        const now = Date.now();
        let changed = false;
        for (const [id, device] of Object.entries(this.devices)) {
            if (now > device.expiresAt) {
                delete this.devices[id];
                changed = true;
            }
        }
        if (changed) {
            this.persistDevices();
        }
    }
    /**
     * Look up a device by its authKey (for import/migration lookups).
     */
    getDeviceByAuthKey(authKey) {
        for (const device of Object.values(this.devices)) {
            if (device.authKey === authKey && Date.now() <= device.expiresAt) {
                return device;
            }
        }
        return null;
    }
}
exports.DeviceManager = DeviceManager;
