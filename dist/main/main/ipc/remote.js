"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRemoteServerAndRegisterIpc = createRemoteServerAndRegisterIpc;
const electron_1 = require("electron");
const cloudflared = __importStar(require("../cloudflared"));
const tailscale = __importStar(require("../tailscale"));
const tasks_1 = require("./tasks");
const index_1 = require("../remote/index");
const terminalSizePolicy_1 = require("../remote/terminalSizePolicy");
function createRemoteServerAndRegisterIpc({ getPtyBackend, ptyBackendReady, storeManager, gitManager, fsManager, skillsManager, resumeManager, httpClient, databaseManager, promptHistoryManager, notesManager, getAgentTeamController, getLinkRegistry, getHierarchyActivations, getRunTracker, getDeviceHostProxy, ensureRendererWindow, sendToRenderer, terminalConnectionService, }) {
    // Approvals only — the phone can see and answer gates and nothing else.
    // Remote control
    const remoteServer = new index_1.RemoteServer({
        // Lazy: in daemon mode the backend materializes after selection resolves;
        // remote handlers only run post-auth, well after ptyBackendReady settles.
        get ptyBackend() {
            return getPtyBackend();
        },
        storeManager: storeManager,
        gitManager: gitManager,
        fsManager: fsManager,
        skillsManager: skillsManager,
        resumeManager,
        httpClient: httpClient,
        databaseManager: databaseManager,
        promptHistoryManager,
        notesManager,
        ensureRendererWindow,
        getTasksManager: tasks_1.getTasksManager,
        getAgentTeamController,
        getLinkRegistry,
        getHierarchyActivations,
        getRunTracker,
        getDeviceHostProxy,
        terminalConnectionService,
    });
    // Test seam: let the e2e harness drive broadcastActivity() and phone
    // size-authority claims through app.evaluate() without faking a PTY idle
    // event or a socket connection. Test-only.
    if (process.env.NODE_ENV === 'test') {
        ;
        globalThis.__remoteServer = remoteServer;
        globalThis.__remoteSizeAuthority =
            terminalSizePolicy_1.remoteSizeAuthority;
    }
    // Real-time status updates (connect/disconnect/start/stop) → renderer
    remoteServer.setStatusChangeCallback((status) => {
        sendToRenderer('remote:status-change', status);
    });
    // Per-terminal size-authority transitions (a phone taking/releasing PTY
    // dims) → the terminal pane's "Sized for phone" status badge.
    terminalSizePolicy_1.remoteSizeAuthority.onChange((change) => {
        sendToRenderer('remote:size-authority-changed', change);
    });
    electron_1.ipcMain.handle('remote:start', async () => {
        try {
            await ptyBackendReady;
            const result = await remoteServer.start();
            return { ok: true, ...result };
        }
        catch (error) {
            return { ok: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('remote:stop', async () => {
        try {
            // Tunnel without a target is useless — stop it first so its target URL
            // doesn't briefly point at a dead express server.
            if (cloudflared.getTunnelStatus().running) {
                await cloudflared.stopTunnel();
            }
            // remoteServer.stop() clears a VPN url override itself; the loss-watch
            // poll just has nothing left to watch. Also drop the Serve HTTPS proxy
            // so we don't leave a stale https://*.ts.net → dead-port handler.
            tailscale.stopAdvertisePoll();
            await tailscale.disableServeHttps();
            await remoteServer.stop();
            return { ok: true };
        }
        catch (error) {
            return { ok: false, error: error.message };
        }
    });
    electron_1.ipcMain.handle('remote:status', () => remoteServer.getStatus());
    electron_1.ipcMain.handle('remote:get-qr', () => remoteServer.getQRCode());
    electron_1.ipcMain.handle('remote:get-pairing-url', () => remoteServer.getPairingUrl());
    electron_1.ipcMain.handle('remote:rotate-pairing', () => remoteServer.rotatePairing());
    electron_1.ipcMain.handle('remote:get-devices', () => remoteServer.getDevices().map(d => ({
        deviceId: d.deviceId,
        displayName: d.displayName,
        platform: d.platform,
        permissionLevel: d.permissionLevel,
        lastSeenAt: d.lastSeenAt,
    })));
    electron_1.ipcMain.handle('remote:revoke-device', (_, deviceId) => {
        remoteServer.revokeDevice(deviceId);
    });
    electron_1.ipcMain.handle('remote:revoke-all-devices', () => remoteServer.revokeAllDevices());
    electron_1.ipcMain.handle('remote:set-permission', (_, deviceId, level) => {
        remoteServer.setPermission(deviceId, level);
    });
    electron_1.ipcMain.handle('remote:get-audit-log', (_, limit) => remoteServer.getAuditLog(limit));
    electron_1.ipcMain.handle('remote:get-pairing-ttl', () => remoteServer.getPairingTtl());
    electron_1.ipcMain.handle('remote:set-pairing-ttl', (_, setting) => {
        // Validate — the value crosses the IPC boundary untyped.
        if (setting !== 7 && setting !== 30 && setting !== 'never') {
            return { ok: false, error: 'Invalid pairing TTL' };
        }
        remoteServer.setPairingTtl(setting);
        return { ok: true };
    });
    // -------- Cloudflare Tunnel --------
    // Lazy-downloaded `cloudflared` binary + per-session quick tunnel that
    // exposes the remote server over the public internet. See plan in
    // src/main/cloudflared/. Tunnel target URL is rewritten via
    // remoteServer.setPublicUrlOverride() so the QR + pairing flow advertise
    // the tunnel URL instead of the LAN IP.
    // Forward tunnel install/runtime events to the renderer.
    cloudflared.onInstallProgress((p) => {
        sendToRenderer('tunnel:install-progress', p);
    });
    cloudflared.onTunnelEvent((ev) => {
        // When the tunnel goes live or down, plumb the URL into the remote server
        // so QR + pair-response reflect the public endpoint. Pairing code rotation
        // is built into setPublicUrlOverride().
        if (ev.type === 'running') {
            remoteServer?.setPublicUrlOverride(ev.url, 'tunnel');
        }
        else if (ev.type === 'stopped' || ev.type === 'error') {
            remoteServer?.setPublicUrlOverride(null);
        }
        sendToRenderer('tunnel:event', ev);
    });
    electron_1.ipcMain.handle('tunnel:install-status', () => cloudflared.getInstallStatus());
    electron_1.ipcMain.handle('tunnel:install', async () => {
        return cloudflared.installBinary();
    });
    electron_1.ipcMain.handle('tunnel:install-cancel', () => {
        cloudflared.cancelInstall();
    });
    electron_1.ipcMain.handle('tunnel:remove', () => {
        cloudflared.uninstallBinary();
        return { ok: true };
    });
    electron_1.ipcMain.handle('tunnel:start', async () => {
        if (!remoteServer) {
            return { ok: false, error: 'Remote server is not running. Start it first.' };
        }
        const status = remoteServer.getStatus();
        if (!status.running) {
            return { ok: false, error: 'Remote server is not running. Start it first.' };
        }
        return cloudflared.startTunnel(remoteServer.getLocalPort());
    });
    electron_1.ipcMain.handle('tunnel:stop', async () => {
        await cloudflared.stopTunnel();
        return { ok: true };
    });
    electron_1.ipcMain.handle('tunnel:status', () => cloudflared.getTunnelStatus());
    // -------- Tailscale / VPN --------
    // Detect + Tailscale Serve HTTPS. The server already listens on 0.0.0.0, so
    // a tailnet peer can reach the plain 100.x address — but Safari tears down
    // sustained plain-HTTP sessions to private/CGNAT IPs. Serve terminates TLS
    // on the MagicDNS name and reverse-proxies to the local port; we advertise
    // that https:// URL via setPublicUrlOverride. A loss-watch poll reverts to
    // LAN if Tailscale goes away.
    // After a VPN override is cleared, a still-running tunnel must get its URL
    // back — otherwise a tunnel → vpn → tunnel mode round-trip leaves the QR
    // encoding the LAN address while the tunnel panel says "active".
    const restoreTunnelOverrideIfRunning = () => {
        const t = cloudflared.getTunnelStatus();
        if (t.running && t.url) {
            remoteServer.setPublicUrlOverride(t.url, 'tunnel');
        }
    };
    tailscale.onEvent((ev) => {
        // Confirmed loss while advertised — revert QR/pairing to the LAN URL
        // (setPublicUrlOverride rotates the pairing secret) and tell the renderer.
        void tailscale.disableServeHttps();
        if (remoteServer.clearPublicUrlOverrideIf('vpn')) {
            restoreTunnelOverrideIfRunning();
        }
        sendToRenderer('tailscale:event', ev);
    });
    electron_1.ipcMain.handle('tailscale:status', (_, force) => tailscale.getStatus(force === true));
    electron_1.ipcMain.handle('tailscale:enable', async () => {
        const status = remoteServer.getStatus();
        if (!status.running) {
            return { ok: false, error: 'Remote server is not running. Start it first.' };
        }
        const ts = await tailscale.getStatus(true);
        if (!ts.installed) {
            return { ok: false, error: 'Tailscale is not installed on this machine.', status: ts };
        }
        if (!ts.running) {
            return { ok: false, error: 'Tailscale is not connected. Open the Tailscale app and sign in.', status: ts };
        }
        if (!ts.ip) {
            return { ok: false, error: 'Tailscale is running but has no IPv4 tailnet address.', status: ts };
        }
        // Prefer HTTPS via Serve — required for Safari / full mobile browsers.
        const localPort = remoteServer.getLocalPort();
        const serve = await tailscale.enableServeHttps(localPort, ts);
        if (!serve.ok || !serve.url) {
            return {
                ok: false,
                error: serve.error || 'Failed to configure Tailscale HTTPS (Serve).',
                enableUrl: serve.enableUrl,
                status: serve.status,
            };
        }
        remoteServer.setPublicUrlOverride(serve.url, 'vpn');
        tailscale.startAdvertisePoll();
        return { ok: true, url: serve.url, status: serve.status };
    });
    electron_1.ipcMain.handle('tailscale:disable', async () => {
        tailscale.stopAdvertisePoll();
        await tailscale.disableServeHttps();
        if (remoteServer.clearPublicUrlOverrideIf('vpn')) {
            restoreTunnelOverrideIfRunning();
        }
        return { ok: true };
    });
    return remoteServer;
}
