"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupAuthMiddleware = setupAuthMiddleware;
const connectionProtocol_1 = require("../../../shared/terminal/connectionProtocol");
const featureFlags_1 = require("../../terminal-connection/featureFlags");
// Track failed auth attempts per socket to disconnect after threshold
const failedAttempts = new WeakMap();
const MAX_FAILED_ATTEMPTS = 3;
/**
 * Set up authentication middleware for socket.io connections.
 *
 * Flow:
 * 1. On connection, server emits auth:challenge with a random 32-byte challenge
 * 2. Client responds with auth:handshake { deviceId, timestamp, proof }
 * 3. Server verifies deviceId exists, timestamp within 60s, HMAC proof matches
 * 4. On success: marks socket as authenticated, emits ACK with permissions
 * 5. On failure: emits ACK with error, disconnects after 3 failures
 * 6. All non-auth events are blocked until authenticated
 */
function setupAuthMiddleware(io, auth, devices, onAuthSuccess) {
    // Middleware that blocks all events (except auth:handshake and auth:import)
    // until the socket is authenticated
    io.use((socket, next) => {
        // Initialize socket data
        socket.data = {
            deviceId: '',
            deviceName: '',
            permissionLevel: 'viewer',
            connectionMode: 'lan',
            authenticated: false,
        };
        next();
    });
    // Per-event middleware: block non-auth events until handshake completes
    io.on('connection', (socket) => {
        failedAttempts.set(socket, 0);
        // Generate and send challenge immediately on connection
        const challenge = auth.generateChallenge();
        // Determine connection mode from socket handshake
        const connectionMode = detectConnectionMode(socket);
        socket.data.connectionMode = connectionMode;
        socket.emit('auth:challenge', { challenge });
        // Register the auth:handshake listener
        socket.on('auth:handshake', (payload, ack) => {
            const respond = (response) => {
                if (typeof ack === 'function') {
                    ack(response);
                }
                else {
                    socket.emit('auth:handshake:ack', response);
                }
            };
            const { deviceId, timestamp, proof } = payload || {};
            // Validate payload structure
            if (!deviceId || !timestamp || !proof) {
                handleFailure(socket, respond, 'Missing required fields', 'invalid-request');
                return;
            }
            // Look up device
            const device = devices.getDevice(deviceId);
            if (!device) {
                handleFailure(socket, respond, 'This browser is no longer paired with the desktop', 'pairing-required');
                return;
            }
            // Verify timestamp freshness (60 second window)
            const now = Date.now();
            if (Math.abs(now - timestamp) > 60_000) {
                handleFailure(socket, respond, 'Phone and desktop clocks are too far apart', 'clock-skew');
                return;
            }
            // Verify HMAC proof using the device's authKey and the challenge we sent
            const valid = auth.verifyProof(device.authKey, challenge, deviceId, timestamp, proof);
            if (!valid) {
                handleFailure(socket, respond, 'Saved pairing credentials are no longer valid', 'pairing-required');
                return;
            }
            // Authentication successful
            socket.data.deviceId = deviceId;
            socket.data.deviceName = device.displayName;
            socket.data.permissionLevel = device.permissionLevel;
            socket.data.authenticated = true;
            // Update device tracking. recordHandshake renews the sliding pairing
            // expiry + replay challenge in one store write; send the fresh value so
            // the phone can update its local copy — the phone self-destructs
            // credentials past its STORED expiresAt, so without this the
            // desktop-side renewal never reaches it and an actively-used device
            // still re-pairs at the original window.
            const renewed = devices.recordHandshake(deviceId, challenge);
            const terminalV2 = (0, featureFlags_1.remoteTerminalAckResyncEnabled)();
            respond({
                ok: true,
                permissions: device.permissionLevel,
                expiresAt: renewed?.expiresAt,
                ...(terminalV2 ? {
                    terminalProtocolVersion: connectionProtocol_1.TERMINAL_CONNECTION_PROTOCOL_VERSION,
                    terminalCapabilities: [...connectionProtocol_1.RAW_V2_CAPABILITIES],
                } : {}),
            });
            // Notify handlers (dashboard, etc.) to push initial data
            if (onAuthSuccess) {
                onAuthSuccess(socket);
            }
        });
        // Block all other events until authenticated.
        // IMPORTANT: Do NOT call next(new Error(...)) — socket.io v4 treats that
        // as a fatal error and disconnects the socket. Instead, silently drop
        // the event so the client can still complete auth.
        socket.use((packet, next) => {
            const [eventName] = packet;
            // Allow auth-related events through
            if (eventName === 'auth:handshake' || eventName === 'auth:import') {
                next();
                return;
            }
            // Silently drop non-auth events until authenticated
            if (!socket.data.authenticated) {
                // If there's an ACK callback, respond with an error instead of disconnecting
                const ackFn = packet[packet.length - 1];
                if (typeof ackFn === 'function') {
                    ackFn({ ok: false, error: 'Not authenticated' });
                }
                // Do NOT call next() — just swallow the event
                return;
            }
            next();
        });
    });
}
/**
 * Handle a failed authentication attempt. Increments the failure counter and
 * disconnects the socket after MAX_FAILED_ATTEMPTS.
 */
function handleFailure(socket, respond, error, code) {
    const attempts = (failedAttempts.get(socket) || 0) + 1;
    failedAttempts.set(socket, attempts);
    respond({ ok: false, error, code });
    if (attempts >= MAX_FAILED_ATTEMPTS) {
        socket.disconnect(true);
    }
}
/**
 * Detect the connection mode based on the socket's remote address.
 * - 127.x / ::1 / private ranges (10.x, 172.16-31.x, 192.168.x) -> 'lan'
 * - Everything else -> 'relay' (conservative default; VPN detection requires
 *   more infrastructure and is upgraded by the client in its handshake)
 */
function detectConnectionMode(socket) {
    const remoteAddr = socket.handshake.address || '';
    const cleanAddr = remoteAddr.replace(/^::ffff:/, '');
    // Localhost
    if (cleanAddr === '127.0.0.1' || cleanAddr === '::1' || cleanAddr === 'localhost') {
        return 'lan';
    }
    // Private IPv4 ranges
    if (cleanAddr.startsWith('10.') ||
        cleanAddr.startsWith('192.168.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(cleanAddr)) {
        return 'lan';
    }
    // Private IPv6 (fd00::/8 ULA)
    if (cleanAddr.startsWith('fd') || cleanAddr.startsWith('fc')) {
        return 'lan';
    }
    // Tailscale CGNAT range (100.64/10) — phone connecting over the tailnet
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(cleanAddr)) {
        return 'vpn';
    }
    return 'relay';
}
