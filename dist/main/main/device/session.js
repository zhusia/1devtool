"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PeerSession = void 0;
/**
 * Outbound connection to a peer's /device namespace. socket.io-client keeps
 * its own reconnect backoff; we re-run the challenge handshake on every
 * (re)connect because the server mints a fresh challenge per connection.
 *
 * Sessions exist only for CONFIRMED peers — never at zero peers (§4.1).
 */
const node_crypto_1 = require("node:crypto");
const socket_io_client_1 = require("socket.io-client");
const protocol_1 = require("../../shared/device/protocol");
const pairingCrypto_1 = require("./pairingCrypto");
const transportCrypto_1 = require("./transportCrypto");
class PeerSession {
    opts;
    socket;
    authenticated = false;
    disposed = false;
    retryTimer = null;
    /** One owner-side Terminal Connection per local consumer. ACK state must
     * never be shared between a desktop mirror and a phone relay. */
    outputHandlers = new Map();
    /** Fresh server challenge binding every encrypted frame to this connection. */
    sessionChallenge = null;
    handshakePending = false;
    outboundSequence = 0;
    inboundSequence = 0;
    /** AES-GCM sequence numbers are a single ordered stream. Serialize secure
     * requests so concurrent Team/skill/endpoint actions cannot receive ACKs in
     * the opposite order and look like a replay. */
    secureQueue = Promise.resolve();
    constructor(opts) {
        this.opts = opts;
        this.socket = (0, socket_io_client_1.io)(`${opts.url}/device`, {
            transports: ['websocket'],
            reconnection: true,
            reconnectionDelay: 2_000,
            reconnectionDelayMax: 60_000,
            timeout: 8_000,
        });
        this.socket.on('auth:challenge', ({ challenge }) => {
            if (!challenge || this.authenticated || this.handshakePending)
                return;
            this.handshakePending = true;
            this.sessionChallenge = challenge;
            const timestamp = Date.now();
            const proof = (0, pairingCrypto_1.computeDeviceProof)(this.opts.authKey, challenge, this.opts.selfDeviceId, timestamp);
            this.socket.emit('auth:handshake', {
                deviceId: this.opts.selfDeviceId,
                timestamp,
                proof,
                protocolVersion: protocol_1.DEVICE_PROTOCOL_VERSION,
            }, (ack) => {
                if (this.disposed)
                    return;
                this.handshakePending = false;
                this.authenticated = ack?.ok === true;
                if (this.authenticated) {
                    this.outboundSequence = 0;
                    this.inboundSequence = 0;
                }
                if (this.authenticated && this.outputHandlers.size > 0) {
                    for (const [previousConnectionId, subscription] of [...this.outputHandlers]) {
                        void this.subscribeMirror(subscription.terminalId, subscription.terminalGeneration).then((ack) => {
                            if (!ack.ok || !ack.attach)
                                return;
                            if (this.outputHandlers.get(previousConnectionId) !== subscription)
                                return;
                            this.outputHandlers.delete(previousConnectionId);
                            this.outputHandlers.set(ack.attach.connectionId, subscription);
                            subscription.handler({ kind: 'attach', attach: ack.attach });
                        });
                    }
                }
                if (!this.authenticated && ack?.error?.code === 'DEVICE_NOT_CONFIRMED') {
                    // Retryable: the human on the peer hasn't pressed "They match" yet.
                    // The server keeps the socket open, so no reconnect (and thus no
                    // fresh challenge) would ever fire — cycle the connection gently
                    // until the peer confirms or we're disposed.
                    this.scheduleAuthRetry();
                }
                this.opts.onStatusChange();
            });
        });
        this.socket.on('device:event', (envelope) => {
            if (!this.authenticated || !this.sessionChallenge)
                return;
            try {
                const event = (0, transportCrypto_1.openDevicePayload)(this.opts.encryptKey, envelope, {
                    fromDeviceId: this.opts.peerDeviceId,
                    toDeviceId: this.opts.selfDeviceId,
                    channel: 'event',
                    sessionChallenge: this.sessionChallenge,
                }, ++this.inboundSequence);
                if (event.event !== 'terminal:connection-frame-v2')
                    return;
                const { terminalGeneration, frame } = event.payload ?? {};
                const subscription = frame ? this.outputHandlers.get(frame.connectionId) : undefined;
                if (!subscription ||
                    subscription.terminalGeneration !== terminalGeneration ||
                    !frame)
                    return;
                subscription.handler({ kind: 'frame', frame });
            }
            catch {
                this.authenticated = false;
                this.socket.disconnect();
            }
        });
        this.socket.on('disconnect', () => {
            this.authenticated = false;
            this.handshakePending = false;
            this.sessionChallenge = null;
            this.opts.onStatusChange();
        });
        this.socket.on('connect', () => {
            if (this.retryTimer) {
                clearTimeout(this.retryTimer);
                this.retryTimer = null;
            }
        });
        this.socket.on('connect_error', () => {
            // Reported via isOnline(); socket.io-client keeps backing off.
        });
    }
    isOnline() {
        return this.authenticated && this.socket.connected;
    }
    scheduleAuthRetry(delayMs = 5_000) {
        if (this.disposed || this.retryTimer)
            return;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (this.disposed || this.authenticated)
                return;
            // Cycle the transport to get a fresh auth:challenge from the server.
            this.socket.disconnect();
            this.socket.connect();
        }, delayMs);
    }
    /**
     * Request the peer's catalog. Typed failures only — the caller maps these
     * straight to UI copy; there is no silent fallback (§4 principle 6).
     */
    requestCatalog(timeoutMs = 10_000) {
        const operationId = `catalog-${(0, node_crypto_1.randomUUID)()}`;
        return this.secureRequest('catalog:snapshot', { operationId }, operationId, timeoutMs).then((ack) => ack.ok && ack.snapshot
            ? { ok: true, snapshot: ack.snapshot }
            : {
                ok: false,
                error: ack.error ?? { code: 'DEVICE_INTERNAL', message: 'Malformed catalog response.' },
            });
    }
    /** Challenge-bound, encrypted, sequenced RPC for every v4 peer operation. */
    secureRequest(event, payload, operationId, timeoutMs = 30_000) {
        const task = this.secureQueue.then(() => this.secureRequestNow(event, payload, operationId, timeoutMs));
        this.secureQueue = task.then(() => undefined, () => undefined);
        return task;
    }
    secureRequestNow(event, payload, operationId, timeoutMs) {
        const sessionChallenge = this.sessionChallenge;
        if (!this.isOnline() || !sessionChallenge) {
            return Promise.resolve({
                ok: false,
                error: { code: 'DEVICE_OFFLINE', message: 'Peer is offline or not yet authenticated.' },
            });
        }
        const request = { event, payload, operationId };
        const sequence = ++this.outboundSequence;
        const envelope = (0, transportCrypto_1.sealDevicePayload)(this.opts.encryptKey, sequence, {
            fromDeviceId: this.opts.selfDeviceId,
            toDeviceId: this.opts.peerDeviceId,
            channel: 'rpc',
            sessionChallenge,
        }, request);
        return new Promise((resolve) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                // The owner may have processed the frame and its ACK may still arrive.
                // Sequence state is therefore uncertain; reconnect before another RPC.
                this.authenticated = false;
                this.socket.disconnect();
                if (!this.disposed)
                    this.socket.connect();
                resolve({ ok: false, error: { code: 'DEVICE_TIMEOUT', message: 'The peer operation timed out.' } });
            }, timeoutMs);
            this.socket.emit('device:rpc', envelope, (sealedAck) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                try {
                    const ack = (0, transportCrypto_1.openDevicePayload)(this.opts.encryptKey, sealedAck, {
                        fromDeviceId: this.opts.peerDeviceId,
                        toDeviceId: this.opts.selfDeviceId,
                        channel: 'ack',
                        sessionChallenge,
                    }, ++this.inboundSequence);
                    if (!ack.ok) {
                        resolve({ ok: false, error: ack.error ?? { code: 'DEVICE_INTERNAL', message: 'Malformed encrypted response.' } });
                        return;
                    }
                    resolve((ack.payload ?? { ok: true }));
                }
                catch {
                    this.socket.disconnect();
                    resolve({ ok: false, error: { code: 'DEVICE_PROTOCOL_MISMATCH', message: 'The encrypted peer response failed authentication or replay checks.' } });
                }
            });
        });
    }
    /** Live output from a peer terminal. Returns the scrollback snapshot. */
    async startMirror(terminalId, onData, terminalGeneration) {
        if (!Number.isSafeInteger(terminalGeneration) || terminalGeneration <= 0) {
            return {
                ok: false,
                error: { code: 'DEVICE_GENERATION_MISMATCH', message: 'Refresh the peer terminal before opening it.' },
            };
        }
        const ack = await this.subscribeMirror(terminalId, terminalGeneration);
        if (!ack.ok || !ack.attach) {
            return { ok: false, error: ack.error ?? { code: 'DEVICE_INTERNAL', message: 'Mirror refused.' } };
        }
        // A handler represents exactly one downstream display/application point.
        // Replace only that handler's stale subscription; never collapse distinct
        // consumers of the same terminal into one ACK window.
        this.stopMirror(terminalId, onData);
        this.outputHandlers.set(ack.attach.connectionId, {
            terminalId,
            terminalGeneration,
            handler: onData,
        });
        return { ok: true, attach: ack.attach };
    }
    subscribeMirror(terminalId, terminalGeneration) {
        const operationId = `terminal-subscribe-${(0, node_crypto_1.randomUUID)()}`;
        return this.secureRequest('terminal:subscribe', { terminalId, terminalGeneration, clientRequestId: operationId }, operationId);
    }
    stopMirror(terminalId, onData) {
        const match = [...this.outputHandlers.entries()].find(([, subscription]) => subscription.terminalId === terminalId && subscription.handler === onData);
        if (!match)
            return;
        const [connectionId] = match;
        this.outputHandlers.delete(connectionId);
        if (this.isOnline()) {
            const operationId = `terminal-unsubscribe-${(0, node_crypto_1.randomUUID)()}`;
            void this.secureRequest('terminal:unsubscribe', { connectionId }, operationId);
        }
    }
    acknowledgeMirrorFrame(connectionId, syncGeneration, frameId) {
        const operationId = `terminal-ack-${(0, node_crypto_1.randomUUID)()}`;
        return this.secureRequest('terminal:ack-v2', { connectionId, syncGeneration, frameId }, operationId);
    }
    resyncMirror(connectionId) {
        const operationId = `terminal-resync-${(0, node_crypto_1.randomUUID)()}`;
        return this.secureRequest('terminal:resync-v2', { connectionId }, operationId);
    }
    setMirrorVisibility(connectionId, visible) {
        const operationId = `terminal-visibility-${(0, node_crypto_1.randomUUID)()}`;
        return this.secureRequest('terminal:visibility-v2', { connectionId, visible }, operationId);
    }
    dispose() {
        this.disposed = true;
        this.authenticated = false;
        this.handshakePending = false;
        this.outboundSequence = 0;
        this.inboundSequence = 0;
        this.sessionChallenge = null;
        this.outputHandlers.clear();
        if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        this.socket.removeAllListeners();
        this.socket.disconnect();
    }
}
exports.PeerSession = PeerSession;
