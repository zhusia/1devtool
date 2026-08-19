"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DevicePeerStore = void 0;
const PEERS_KEY = 'peers';
class DevicePeerStore {
    kv;
    constructor(kv) {
        this.kv = kv;
    }
    read() {
        return this.kv.get(PEERS_KEY) ?? {};
    }
    write(peers) {
        this.kv.set(PEERS_KEY, peers);
    }
    add(peer) {
        const peers = this.read();
        peers[peer.deviceId] = peer;
        this.write(peers);
    }
    get(deviceId) {
        return this.read()[deviceId] ?? null;
    }
    getAll() {
        return Object.values(this.read());
    }
    /** Peers the human on this machine has fingerprint-confirmed. */
    getConfirmed() {
        return this.getAll().filter((p) => p.confirmedAt !== null);
    }
    count() {
        return this.getAll().length;
    }
    confirm(deviceId, now = Date.now()) {
        const peers = this.read();
        const peer = peers[deviceId];
        if (!peer)
            return null;
        if (peer.confirmedAt === null) {
            peers[deviceId] = { ...peer, confirmedAt: now };
            this.write(peers);
        }
        return peers[deviceId];
    }
    remove(deviceId) {
        const peers = this.read();
        if (!peers[deviceId])
            return false;
        delete peers[deviceId];
        this.write(peers);
        return true;
    }
    setGrants(deviceId, grants) {
        const peers = this.read();
        const peer = peers[deviceId];
        if (!peer)
            return null;
        peers[deviceId] = { ...peer, grants };
        this.write(peers);
        return peers[deviceId];
    }
    updateLastSeen(deviceId, now = Date.now()) {
        const peers = this.read();
        const peer = peers[deviceId];
        if (!peer)
            return;
        peers[deviceId] = { ...peer, lastSeenAt: now };
        this.write(peers);
    }
    updateEndpointSuccess(deviceId, url, now = Date.now()) {
        const peers = this.read();
        const peer = peers[deviceId];
        if (!peer)
            return;
        const endpoints = peer.endpoints.map((e) => (e.url === url ? { ...e, lastSuccessAt: now } : e));
        peers[deviceId] = { ...peer, endpoints };
        this.write(peers);
    }
    /** Replace a peer's advertised routes while preserving success timestamps
     * for URLs that still exist. Endpoint updates are authenticated, encrypted,
     * and owner-authored; stale public quick-tunnel URLs disappear here. */
    replaceEndpoints(deviceId, endpoints) {
        const peers = this.read();
        const peer = peers[deviceId];
        if (!peer)
            return null;
        const lastSuccess = new Map(peer.endpoints.map((row) => [row.url, row.lastSuccessAt]));
        peers[deviceId] = {
            ...peer,
            endpoints: endpoints.map((row) => ({
                ...row,
                ...(lastSuccess.get(row.url) ? { lastSuccessAt: lastSuccess.get(row.url) } : {}),
            })),
        };
        this.write(peers);
        return peers[deviceId];
    }
}
exports.DevicePeerStore = DevicePeerStore;
