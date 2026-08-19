"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FederatedLinkStore = void 0;
/**
 * Persistence for federated (cross-device) links. Single-writer by design —
 * only the originating host mutates these rows (see shared/device/links.ts).
 */
const crypto_1 = __importDefault(require("crypto"));
const links_1 = require("../../shared/device/links");
const LINKS_KEY = 'federatedLinks';
const MESSAGES_KEY = 'federatedLinkMessages';
class FederatedLinkStore {
    kv;
    constructor(kv) {
        this.kv = kv;
    }
    read() {
        return this.kv.get(LINKS_KEY) ?? {};
    }
    write(links) {
        this.kv.set(LINKS_KEY, links);
    }
    getAll() {
        return Object.values(this.read()).map((link) => {
            // Rows written by the pre-admission implementation cannot authorize a
            // write. Keep them visible and quarantined until a fresh human gesture
            // creates a dual-admitted generation-bound edge.
            if (link.admissionId &&
                link.operationId &&
                link.from?.terminalGeneration > 0 &&
                link.to?.terminalGeneration > 0)
                return link;
            return {
                ...link,
                from: { ...link.from, terminalGeneration: link.from?.terminalGeneration ?? 0 },
                to: { ...link.to, terminalGeneration: link.to?.terminalGeneration ?? 0 },
                admissionId: link.admissionId ?? '',
                operationId: link.operationId ?? '',
                state: 'quarantined',
                quarantineReason: 'peer-app-version-incompatible',
            };
        });
    }
    /**
     * Idempotent by (from, device, to): mentioning the same peer terminal again
     * refreshes the existing edge instead of stacking duplicates on the map.
     */
    ensure(input, now = Date.now()) {
        const links = this.read();
        const key = (0, links_1.federatedLinkKey)(input.fromTerminalId, input.to.deviceId, input.to.terminalId);
        const existing = links[key];
        const next = existing
            ? {
                ...existing,
                from: {
                    terminalId: input.fromTerminalId,
                    terminalGeneration: input.fromTerminalGeneration,
                    projectId: input.fromProjectId,
                },
                to: input.to,
                admissionId: input.admissionId,
                operationId: input.operationId,
                state: 'active',
                quarantineReason: undefined,
            }
            : {
                linkId: input.linkId || `fl-${crypto_1.default.randomBytes(8).toString('hex')}`,
                from: {
                    terminalId: input.fromTerminalId,
                    terminalGeneration: input.fromTerminalGeneration,
                    projectId: input.fromProjectId,
                },
                to: input.to,
                admissionId: input.admissionId,
                operationId: input.operationId,
                state: 'active',
                createdAt: now,
                lastDeliveredAt: null,
            };
        links[key] = next;
        this.write(links);
        return next;
    }
    readMessages() {
        return this.kv.get(MESSAGES_KEY) ?? {};
    }
    writeMessages(messages) {
        this.kv.set(MESSAGES_KEY, messages);
    }
    listMessages(linkId) {
        return Object.values(this.readMessages()).filter((row) => !linkId || row.linkId === linkId);
    }
    /** Idempotent by operation id; a reused id with different content conflicts. */
    beginMessage(record) {
        const messages = this.readMessages();
        const sameOperation = Object.values(messages).find((row) => row.operationId === record.operationId);
        if (sameOperation) {
            const same = sameOperation.linkId === record.linkId && sameOperation.preview === record.preview;
            return same ? { ok: true, record: sameOperation, created: false } : { ok: false };
        }
        messages[record.messageId] = record;
        this.writeMessages(messages);
        return { ok: true, record, created: true };
    }
    updateMessage(messageId, patch) {
        const messages = this.readMessages();
        const row = messages[messageId];
        if (!row)
            return null;
        messages[messageId] = { ...row, ...patch };
        this.writeMessages(messages);
        return messages[messageId];
    }
    markDelivered(linkId, now = Date.now()) {
        const links = this.read();
        for (const [key, link] of Object.entries(links)) {
            if (link.linkId !== linkId)
                continue;
            links[key] = { ...link, lastDeliveredAt: now, state: 'active', quarantineReason: undefined };
            this.write(links);
            return;
        }
    }
    /** Typed quarantine — the edge stays visible so the user sees WHY it stopped. */
    quarantine(linkId, reason) {
        const links = this.read();
        for (const [key, link] of Object.entries(links)) {
            if (link.linkId !== linkId)
                continue;
            links[key] = { ...link, state: 'quarantined', quarantineReason: reason };
            this.write(links);
            return;
        }
    }
    /** Quarantine every edge to a device (peer revoked, or went offline). */
    quarantineDevice(deviceId, reason) {
        const links = this.read();
        let changed = false;
        for (const [key, link] of Object.entries(links)) {
            if (link.to.deviceId !== deviceId || link.state === 'quarantined')
                continue;
            links[key] = { ...link, state: 'quarantined', quarantineReason: reason };
            changed = true;
        }
        if (changed)
            this.write(links);
    }
    /** Reactivate a device's edges once it is reachable again. */
    reactivateDevice(deviceId) {
        const links = this.read();
        let changed = false;
        for (const [key, link] of Object.entries(links)) {
            if (link.to.deviceId !== deviceId)
                continue;
            if (link.state === 'active')
                continue;
            // Only the offline reason self-heals; a revoked grant or a vanished
            // terminal needs a fresh human gesture, not an automatic re-link.
            if (link.quarantineReason !== 'peer-offline')
                continue;
            links[key] = { ...link, state: 'active', quarantineReason: undefined };
            changed = true;
        }
        if (changed)
            this.write(links);
    }
    removeDevice(deviceId) {
        const links = this.read();
        const next = Object.fromEntries(Object.entries(links).filter(([, link]) => link.to.deviceId !== deviceId));
        if (Object.keys(next).length !== Object.keys(links).length)
            this.write(next);
    }
    remove(linkId) {
        const links = this.read();
        const entry = Object.entries(links).find(([, link]) => link.linkId === linkId);
        if (!entry)
            return false;
        delete links[entry[0]];
        this.write(links);
        return true;
    }
}
exports.FederatedLinkStore = FederatedLinkStore;
