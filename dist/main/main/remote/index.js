"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RemoteServer = void 0;
const os_1 = __importDefault(require("os"));
const crypto_1 = __importDefault(require("crypto"));
const qrcode_1 = __importDefault(require("qrcode"));
const auth_1 = require("./auth");
const devices_1 = require("./devices");
const audit_1 = require("./audit");
const server_1 = require("./server");
const terminalSizePolicy_1 = require("./terminalSizePolicy");
const auth_middleware_1 = require("./middleware/auth-middleware");
const permission_1 = require("./middleware/permission");
const dashboard_1 = require("./handlers/dashboard");
const terminal_1 = require("./handlers/terminal");
const files_1 = require("./handlers/files");
const git_1 = require("./handlers/git");
const tasks_1 = require("./handlers/tasks");
const resume_1 = require("./handlers/resume");
const happy_1 = require("./handlers/happy");
const tools_1 = require("./handlers/tools");
const history_1 = require("./handlers/history");
const orchestration_1 = require("./handlers/orchestration");
const electron_1 = require("electron");
/**
 * HappyRemote (semantic transcript view) is an experimental dev-only feature.
 * Gated so it never ships in packaged builds unless explicitly opted in.
 * Evaluated lazily (not at module load) so importing this file outside Electron
 * — e.g. a unit test — never trips on `app`.
 */
function isHappyRemoteEnabled() {
    return !electron_1.app.isPackaged || process.env.ONEDEVTOOL_HAPPY_REMOTE === '1';
}
const DEFAULT_PORT = 1834;
class RemoteServer {
    managers;
    server = null;
    io = null;
    expressApp = null;
    auth;
    devices;
    audit;
    port;
    /** Originally-requested port; the search always restarts here on each start(). */
    preferredPort;
    currentPairingUrl = null;
    outputUnsubscribers = new Map();
    /**
     * When set, the QR code, pairing URL, and pair-response `serverUrl` use this
     * URL instead of the LAN address. Set by the Cloudflare Tunnel integration
     * when a public tunnel is active.
     */
    publicUrlOverride = null;
    publicConnectionMode = 'lan';
    onStatusChange = null;
    /** Register a callback that fires whenever the server status changes (start/stop/connect/disconnect). */
    setStatusChangeCallback(cb) {
        this.onStatusChange = cb;
    }
    emitStatusToRenderer() {
        if (this.onStatusChange) {
            this.onStatusChange(this.getStatus());
        }
    }
    constructor(managers, port) {
        this.managers = managers;
        this.port = port || DEFAULT_PORT;
        this.preferredPort = this.port;
        this.auth = new auth_1.AuthManager();
        this.devices = new devices_1.DeviceManager();
        this.audit = new audit_1.RemoteAuditLog();
    }
    /**
     * Start the remote control server.
     * Returns the URL and QR pairing data for the initial pairing flow.
     */
    async start() {
        if (this.server) {
            throw new Error('Remote server is already running');
        }
        // Clean up expired devices on startup
        this.devices.cleanExpired();
        // Create HTTP + socket.io infrastructure
        const { app: expressApp, server, io } = (0, server_1.createRemoteServer)(this.port);
        this.server = server;
        this.io = io;
        this.expressApp = expressApp;
        // Wire up pairing endpoint
        expressApp.post('/api/pair', (req, res) => {
            this.handlePair(req, res).catch((err) => {
                res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
            });
        });
        // Set up auth middleware (challenge-response flow)
        // On successful auth, push dashboard snapshot immediately
        (0, auth_middleware_1.setupAuthMiddleware)(io, this.auth, this.devices, (socket) => {
            (0, dashboard_1.pushDashboardToSocket)(socket, this.managers).catch(() => { });
        });
        // Set up per-event permission middleware
        (0, permission_1.setupPermissionMiddleware)(io);
        // Register event handlers
        (0, dashboard_1.registerDashboardHandlers)(io, this.managers);
        (0, terminal_1.registerTerminalHandlers)(io, {
            ptyBackend: this.managers.ptyBackend,
            storeManager: this.managers.storeManager,
            skillsManager: this.managers.skillsManager,
            ensureRendererWindow: this.managers.ensureRendererWindow,
            getDeviceHostProxy: this.managers.getDeviceHostProxy,
            terminalConnectionService: this.managers.terminalConnectionService,
        });
        (0, files_1.registerFileHandlers)(io, { storeManager: this.managers.storeManager, fsManager: this.managers.fsManager });
        (0, git_1.registerGitHandlers)(io, { storeManager: this.managers.storeManager, gitManager: this.managers.gitManager });
        // Approvals only — see handlers/tasks.ts for why the phone surface is two
        // events rather than a proxy of the desktop's task IPC.
        (0, tasks_1.registerTaskHandlers)(io, { getTasksManager: this.managers.getTasksManager });
        (0, orchestration_1.registerOrchestrationHandlers)(io, {
            storeManager: this.managers.storeManager,
            getAgentTeamController: this.managers.getAgentTeamController,
            getLinkRegistry: this.managers.getLinkRegistry,
            getHierarchyActivations: this.managers.getHierarchyActivations,
            getRunTracker: this.managers.getRunTracker,
        });
        (0, resume_1.registerResumeHandlers)(io, { storeManager: this.managers.storeManager, resumeManager: this.managers.resumeManager ?? null });
        (0, history_1.registerHistoryHandlers)(io, {
            promptHistoryManager: this.managers.promptHistoryManager ?? null,
            notesManager: this.managers.notesManager ?? null,
            resumeManager: this.managers.resumeManager ?? null,
        });
        (0, tools_1.registerToolHandlers)(io, {
            storeManager: this.managers.storeManager,
            httpClient: this.managers.httpClient ?? null,
            databaseManager: this.managers.databaseManager ?? null,
        });
        if (isHappyRemoteEnabled()) {
            (0, happy_1.registerHappyHandlers)(io, { storeManager: this.managers.storeManager, resumeManager: this.managers.resumeManager ?? null });
        }
        // Set up terminal output bridge
        this.setupTerminalBridge();
        // Track connection count changes and notify renderer
        io.on('connection', (socket) => {
            this.emitStatusToRenderer();
            socket.on('disconnect', () => {
                this.emitStatusToRenderer();
            });
        });
        // Wire up audit logging for all socket events
        this.setupAuditLogging(io);
        // Start listening. If the preferred port is taken, walk forward to the
        // next free one instead of failing — a stale instance or another app on
        // 1834 shouldn't block remote control. The bound port is written back to
        // this.port so the URL, QR, audit log, and tunnel target all agree.
        try {
            this.port = await this.listenWithFallback(server, this.preferredPort, '0.0.0.0');
        }
        catch (err) {
            // Bind failed entirely — reset state so the next start() isn't blocked by
            // the "already running" guard (this.server was assigned above).
            try {
                server.close();
            }
            catch { /* never bound */ }
            if (this.io) {
                this.io.close();
                this.io = null;
            }
            this.server = null;
            this.expressApp = null;
            throw err;
        }
        // Generate initial pairing data
        const url = `http://${this.getLanIp()}:${this.port}`;
        const qrData = this.rotatePairingUrl();
        this.audit.log({
            timestamp: Date.now(),
            deviceId: 'system',
            deviceName: 'system',
            event: 'server:start',
            details: { port: this.port, url },
            result: 'ok',
            permissionLevel: 'admin',
            connectionMode: 'lan',
        });
        return { url, qrData };
    }
    /**
     * Bind `server` to the first free port at or after `startPort`, retrying on
     * EADDRINUSE up to `maxAttempts` times. Resolves with the port that bound.
     * A net.Server can be re-listened after an EADDRINUSE error (it never bound),
     * so we reuse the same server instance rather than racing a separate probe.
     */
    listenWithFallback(server, startPort, host, maxAttempts = 20) {
        return new Promise((resolve, reject) => {
            let port = startPort;
            let attempts = 0;
            const cleanup = () => {
                server.off('error', onError);
                server.off('listening', onListening);
            };
            const onError = (err) => {
                if (err.code === 'EADDRINUSE' && attempts < maxAttempts) {
                    attempts++;
                    port++;
                    // Re-listen on the next port. Deferred so the failed attempt fully
                    // unwinds before we rebind.
                    setImmediate(() => server.listen(port, host));
                    return;
                }
                cleanup();
                if (err.code === 'EADDRINUSE') {
                    reject(new Error(`No free port found in range ${startPort}–${port}.`));
                }
                else {
                    reject(err);
                }
            };
            const onListening = () => {
                cleanup();
                // Keep a benign error listener so a later runtime socket error can't
                // crash the process with an unhandled 'error' event.
                server.on('error', () => { });
                resolve(port);
            };
            server.on('error', onError);
            server.on('listening', onListening);
            server.listen(port, host);
        });
    }
    /**
     * Stop the remote control server and clean up all resources.
     */
    async stop() {
        // Tunnel mode's override is cleared by cloudflared's 'stopped' event, but
        // Tailscale has no lifecycle events — clear a VPN override here or a stale
        // tailnet URL survives a stop/start after the user switches modes.
        if (this.publicConnectionMode === 'vpn') {
            this.publicUrlOverride = null;
            this.publicConnectionMode = 'lan';
        }
        // Unsubscribe all terminal output listeners
        for (const [, unsubscribe] of this.outputUnsubscribers) {
            unsubscribe();
        }
        this.outputUnsubscribers.clear();
        // Disconnect all sockets
        if (this.io) {
            this.io.disconnectSockets(true);
            this.io.close();
            this.io = null;
        }
        // Backstop: each socket's disconnect handler released its size-authority
        // claims (healing PTYs to desktop dims); clear anything that survived an
        // abnormal teardown so no stale claim keeps gating desktop pty:resize.
        terminalSizePolicy_1.remoteSizeAuthority.clear();
        // Close HTTP server
        if (this.server) {
            await new Promise((resolve) => {
                this.server.close(() => resolve());
                // Force close after 3 seconds
                setTimeout(() => resolve(), 3000);
            });
            this.server = null;
        }
        this.expressApp = null;
        this.audit.log({
            timestamp: Date.now(),
            deviceId: 'system',
            deviceName: 'system',
            event: 'server:stop',
            details: {},
            result: 'ok',
            permissionLevel: 'admin',
            connectionMode: 'lan',
        });
        this.audit.close();
    }
    /**
     * Get the current server status.
     */
    getStatus() {
        if (!this.server || !this.io) {
            return { running: false, connectedDevices: 0 };
        }
        return {
            running: true,
            url: `http://${this.getLanIp()}:${this.port}`,
            publicUrl: this.publicUrlOverride || undefined,
            connectionMode: this.publicConnectionMode,
            connectedDevices: this.io.sockets.sockets.size,
        };
    }
    /**
     * Push an AI-terminal activity event to every authenticated phone. Server →
     * client only (not permission-gated): viewers should still be pinged when
     * their agent finishes or goes idle. Best-effort fan-out.
     */
    broadcastActivity(payload) {
        if (!this.io)
            return;
        for (const [, socket] of this.io.sockets.sockets) {
            if (socket.data.authenticated) {
                socket.emit('notify:activity', payload);
            }
        }
    }
    /** Local port the express server is listening on — needed by tunnel front-ends. */
    getLocalPort() {
        return this.port;
    }
    /**
     * Set or clear the public URL that the QR / pairing URL / pair-response
     * should advertise. Pass null to fall back to LAN. Always rotates the
     * pairing secret so a leaked code against the previous URL can't be reused.
     */
    setPublicUrlOverride(url, mode = 'tunnel') {
        this.publicUrlOverride = url;
        this.publicConnectionMode = url ? mode : 'lan';
        this.rotatePairingUrl();
        this.emitStatusToRenderer();
    }
    /**
     * Clear the public URL override only when it was set by `mode`. Used by
     * modes without lifecycle events (Tailscale) so their teardown can never
     * stomp an override owned by another mode (an active tunnel).
     */
    clearPublicUrlOverrideIf(mode) {
        if (!this.publicUrlOverride || this.publicConnectionMode !== mode)
            return false;
        this.setPublicUrlOverride(null);
        return true;
    }
    /**
     * Get all paired devices.
     */
    getDevices() {
        return this.devices.getAllDevices();
    }
    /**
     * Revoke a device's pairing and disconnect its socket.
     */
    revokeDevice(deviceId) {
        // Disconnect any active sockets for this device
        if (this.io) {
            for (const [, socket] of this.io.sockets.sockets) {
                if (socket.data.deviceId === deviceId) {
                    socket.disconnect(true);
                }
            }
        }
        const device = this.devices.getDevice(deviceId);
        this.devices.removeDevice(deviceId);
        this.audit.log({
            timestamp: Date.now(),
            deviceId,
            deviceName: device?.displayName || 'unknown',
            event: 'device:revoke',
            details: {},
            result: 'ok',
            permissionLevel: 'admin',
            connectionMode: 'lan',
        });
    }
    /**
     * Revoke every paired device at once. Disconnects all device sockets and
     * removes every record. Returns the number of devices removed so the caller
     * can reflect it in the UI / audit.
     */
    revokeAllDevices() {
        const all = this.devices.getAllDevices();
        for (const device of all) {
            this.revokeDevice(device.deviceId);
        }
        return all.length;
    }
    /** Current pairing TTL setting (how long idle devices stay paired). */
    getPairingTtl() {
        return this.devices.getPairingTtl();
    }
    /** Change the pairing TTL. Re-extends every currently-paired device from now. */
    setPairingTtl(setting) {
        this.devices.setPairingTtl(setting);
    }
    /**
     * Update a device's permission level.
     */
    setPermission(deviceId, level) {
        this.devices.setPermission(deviceId, level);
        // Update permission on any active sockets for this device and notify them
        if (this.io) {
            for (const [, socket] of this.io.sockets.sockets) {
                if (socket.data.deviceId === deviceId) {
                    socket.data.permissionLevel = level;
                    socket.emit('permission:changed', { permissionLevel: level });
                }
            }
        }
        this.audit.log({
            timestamp: Date.now(),
            deviceId,
            deviceName: this.devices.getDevice(deviceId)?.displayName || 'unknown',
            event: 'device:permission',
            details: { level },
            result: 'ok',
            permissionLevel: 'admin',
            connectionMode: 'lan',
        });
    }
    /**
     * Generate a QR code as a base64 PNG data URL for the *current* pairing
     * session. Does NOT rotate the secret — that's important: every socket
     * event (connect/disconnect, permission change, tunnel start) triggers the
     * renderer to refetch the QR, and rotating on every refetch would
     * invalidate a copied/displayed pairing URL the user is about to paste.
     *
     * To explicitly rotate (e.g. user clicks "Refresh QR Code"), call
     * rotatePairing() before getQRCode().
     */
    async getQRCode() {
        const qrUrl = this.getValidPairingUrl();
        try {
            const dataUrl = await qrcode_1.default.toDataURL(qrUrl, {
                errorCorrectionLevel: 'M',
                type: 'image/png',
                margin: 2,
                width: 300,
            });
            return dataUrl;
        }
        catch {
            throw new Error('Failed to generate QR code');
        }
    }
    /**
     * Explicitly rotate the pairing secret + URL. Used by the "Refresh QR Code"
     * button in Settings. After this, any previously-displayed/copied URL is
     * invalid.
     */
    rotatePairing() {
        return this.rotatePairingUrl();
    }
    /**
     * Get the current pairing URL for copy-paste testing in a desktop browser.
     * Reuses the most recent QR pairing session so the URL and displayed QR stay in sync.
     */
    getPairingUrl() {
        return this.getValidPairingUrl();
    }
    /**
     * Current pairing URL, lazily rotated when the underlying secret has
     * expired. Without this, a QR displayed long after server start (or after
     * the 10-minute pairing TTL) would encode a dead secret and every scan
     * would land on "Invalid or expired pairing secret".
     */
    getValidPairingUrl() {
        if (this.currentPairingUrl && this.auth.isPairingValid()) {
            return this.currentPairingUrl;
        }
        return this.rotatePairingUrl();
    }
    /**
     * Get recent audit log entries.
     */
    getAuditLog(limit = 100) {
        return this.audit.getRecent(limit);
    }
    /**
     * Get the LAN IP address for this machine.
     * Prefers WiFi/Ethernet interfaces, skips VPN/tunnel interfaces.
     */
    getLanIp() {
        const interfaces = os_1.default.networkInterfaces();
        // VPN/tunnel interface name patterns to skip
        const vpnPatterns = /^(utun|tun|tap|ppp|wg|tailscale|ipsec|gpd|vmnet|veth|docker|br-)/i;
        // Preferred interface names (WiFi / Ethernet)
        const preferredNames = ['en0', 'eth0', 'en1', 'eth1', 'wlan0', 'Wi-Fi'];
        function isLanAddress(addr) {
            // Accept common LAN private ranges, reject everything else
            return (addr.startsWith('192.168.') ||
                addr.startsWith('10.') ||
                /^172\.(1[6-9]|2\d|3[01])\./.test(addr));
        }
        function isUsable(info) {
            return (info.family === 'IPv4' &&
                !info.internal &&
                !info.address.startsWith('169.254.') &&
                !info.address.startsWith('127.'));
        }
        // First pass: preferred interfaces with LAN addresses
        for (const name of preferredNames) {
            const iface = interfaces[name];
            if (!iface)
                continue;
            for (const info of iface) {
                if (isUsable(info) && isLanAddress(info.address)) {
                    return info.address;
                }
            }
        }
        // Second pass: any non-VPN interface with a LAN address
        for (const [name, iface] of Object.entries(interfaces)) {
            if (!iface || vpnPatterns.test(name))
                continue;
            for (const info of iface) {
                if (isUsable(info) && isLanAddress(info.address)) {
                    return info.address;
                }
            }
        }
        // Third pass: any non-VPN, non-internal IPv4 (may be non-private range)
        for (const [name, iface] of Object.entries(interfaces)) {
            if (!iface || vpnPatterns.test(name))
                continue;
            for (const info of iface) {
                if (isUsable(info)) {
                    return info.address;
                }
            }
        }
        return '127.0.0.1';
    }
    /**
     * Build the QR code URL that the phone will scan.
     * Format: http://{IP}:{PORT}/ui/#1dt={base64url(JSON({v,m,s,k,n}))}
     * The fragment is never sent to the server — phone JS reads it client-side.
     */
    buildQRUrl(pairingSecret, publicKey) {
        const pairingJSON = JSON.stringify({
            v: 1,
            m: this.publicConnectionMode,
            s: pairingSecret,
            k: publicKey,
            n: this.auth.getDesktopName(),
        });
        const fragment = Buffer.from(pairingJSON).toString('base64url');
        const base = this.publicUrlOverride || `http://${this.getLanIp()}:${this.port}`;
        return `${base}/ui/#1dt=${fragment}`;
    }
    rotatePairingUrl() {
        const { pairingSecret, publicKeyBase64 } = this.auth.generatePairing();
        const pairingUrl = this.buildQRUrl(pairingSecret, publicKeyBase64);
        this.currentPairingUrl = pairingUrl;
        return pairingUrl;
    }
    /**
     * Handle the POST /api/pair endpoint.
     *
     * The phone sends: { phonePublicKey, pairingSecret, deviceName, platform, userAgent }
     * Desktop verifies the secret, completes ECDH, derives keys, creates a device record,
     * and returns the encrypted response with desktop info + device credentials.
     */
    async handlePair(req, res) {
        const { phonePublicKey, pairingSecret, deviceName, platform, userAgent } = req.body || {};
        if (!phonePublicKey || !pairingSecret) {
            res.status(400).json({ error: 'Missing phonePublicKey or pairingSecret' });
            return;
        }
        // Complete ECDH + derive keys
        const keys = this.auth.completePairing(pairingSecret, phonePublicKey);
        if (!keys) {
            this.audit.log({
                timestamp: Date.now(),
                deviceId: 'unknown',
                deviceName: deviceName || 'unknown',
                event: 'pair:attempt',
                details: { reason: 'Invalid or expired pairing secret' },
                result: 'denied',
                permissionLevel: 'viewer',
                connectionMode: this.publicConnectionMode,
            });
            res.status(403).json({ error: 'Invalid or expired pairing secret' });
            return;
        }
        // Generate a unique device ID
        const deviceId = crypto_1.default.randomBytes(16).toString('base64url');
        // Create device record
        const now = Date.now();
        const record = {
            deviceId,
            displayName: deviceName || `Phone (${platform || 'unknown'})`,
            platform: platform || 'unknown',
            authKey: keys.authKey.toString('base64url'),
            encryptKey: keys.encryptKey.toString('base64url'),
            permissionLevel: 'admin', // LAN pairing grants admin — desktop user explicitly approved via QR scan
            pairedAt: now,
            expiresAt: this.devices.computeExpiry(now), // sliding window per the configured pairing TTL
            lastSeenAt: now,
            lastChallenge: '',
        };
        this.devices.addDevice(record);
        // Build the response payload
        // Phase 1 (LAN only): send plaintext — encryption is for Phase 4 relay mode.
        // The pairing secret + ECDH handshake already authenticates both sides.
        const responsePayload = {
            deviceId,
            desktopName: this.auth.getDesktopName(),
            permissionLevel: record.permissionLevel,
            serverUrl: this.publicUrlOverride || `http://${this.getLanIp()}:${this.port}`,
            expiresAt: record.expiresAt,
        };
        this.audit.log({
            timestamp: Date.now(),
            deviceId,
            deviceName: record.displayName,
            event: 'pair:success',
            details: { platform: record.platform, userAgent: userAgent || '' },
            result: 'ok',
            permissionLevel: record.permissionLevel,
            connectionMode: this.publicConnectionMode,
        });
        res.json(responsePayload);
        // Deliberately NO rotation here: the secret stays valid for its TTL so
        // the same link can be re-paired in the user's real browser after an
        // in-app browser (QR scanner, Telegram, …) consumed the first pair.
        // Each pair creates its own device record; "Refresh QR Code" in Settings
        // rotates explicitly. Status emit refreshes the devices list in Settings.
        this.emitStatusToRenderer();
    }
    /**
     * Wire PtyManager output listeners to socket.io terminal rooms.
     * This is a bridge between the existing terminal infrastructure and
     * the remote socket.io streaming. The actual per-terminal listeners
     * are managed by the terminal handler (registerTerminalHandlers),
     * but this method sets up any cross-cutting terminal monitoring.
     */
    setupTerminalBridge() {
        // The terminal handler (handlers/terminal.ts) manages per-terminal
        // listeners on-demand when sockets subscribe. This method exists for
        // any additional global terminal monitoring needed by the server.
        //
        // For example, tracking terminal lifecycle events for the dashboard:
        const { ptyBackend } = this.managers;
        // Periodically check for new/removed terminals and update the bridge
        const bridgeInterval = setInterval(() => {
            if (!this.io) {
                clearInterval(bridgeInterval);
                return;
            }
            const allStatuses = ptyBackend.getAllStatuses();
            const activeTerminalIds = new Set(Object.keys(allStatuses));
            // Clean up listeners for terminals that no longer exist
            for (const [terminalId, unsubscribe] of this.outputUnsubscribers) {
                if (!activeTerminalIds.has(terminalId)) {
                    unsubscribe();
                    this.outputUnsubscribers.delete(terminalId);
                }
            }
        }, 10_000); // Check every 10 seconds
        // Store the interval so we can clean it up on stop
        const originalStop = this.stop.bind(this);
        this.stop = async () => {
            clearInterval(bridgeInterval);
            await originalStop();
        };
    }
    /**
     * Set up audit logging for socket events.
     */
    setupAuditLogging(io) {
        io.on('connection', (socket) => {
            // Log successful authentication
            socket.on('auth:success', (data) => {
                const device = this.devices.getDevice(data.deviceId);
                this.audit.log({
                    timestamp: Date.now(),
                    deviceId: data.deviceId,
                    deviceName: device?.displayName || 'unknown',
                    event: 'auth:success',
                    details: {},
                    result: 'ok',
                    permissionLevel: data.permissionLevel,
                    connectionMode: data.connectionMode,
                });
            });
            // Log disconnections
            socket.on('disconnect', (reason) => {
                if (socket.data.deviceId) {
                    const device = this.devices.getDevice(socket.data.deviceId);
                    this.audit.log({
                        timestamp: Date.now(),
                        deviceId: socket.data.deviceId,
                        deviceName: device?.displayName || 'unknown',
                        event: 'disconnect',
                        details: { reason },
                        result: 'ok',
                        permissionLevel: socket.data.permissionLevel || 'viewer',
                        connectionMode: socket.data.connectionMode || 'lan',
                    });
                }
            });
            // Log terminal input events (security-relevant). Runs once per remote
            // keystroke — read the handshake-cached name, never the device store.
            socket.on('terminal:input', (payload) => {
                if (socket.data.deviceId && payload?.terminalId) {
                    this.audit.log({
                        timestamp: Date.now(),
                        deviceId: socket.data.deviceId,
                        deviceName: socket.data.deviceName || 'unknown',
                        event: 'terminal:input',
                        details: { terminalId: payload.terminalId },
                        result: 'ok',
                        permissionLevel: socket.data.permissionLevel || 'viewer',
                        connectionMode: socket.data.connectionMode || 'lan',
                    });
                }
            });
        });
    }
}
exports.RemoteServer = RemoteServer;
