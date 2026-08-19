"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeviceFederationService = void 0;
/**
 * DeviceFederationService — owns identity, peers, pairing, the device server,
 * and outbound peer sessions. Constructed LAZILY (see ipc/device.ts): never
 * at app boot, only when device state already exists on disk or the user
 * starts a pairing flow. Single authoritative owner of federation state; the
 * renderer's deviceStore is a projection fed by `device:state-changed`.
 */
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const identity_1 = require("../../shared/device/identity");
const replyPolicy_1 = require("./replyPolicy");
const protocol_1 = require("../../shared/device/protocol");
const catalogService_1 = require("./catalogService");
const gate_1 = require("./gate");
const identityStore_1 = require("./identityStore");
const endpoints_1 = require("./endpoints");
const lanIp_1 = require("./lanIp");
const pairingCrypto_1 = require("./pairingCrypto");
const linkStore_1 = require("./linkStore");
const peerStore_1 = require("./peerStore");
const server_1 = require("./server");
const session_1 = require("./session");
const submitPolicy_1 = require("./submitPolicy");
const transportCrypto_1 = require("./transportCrypto");
const process_1 = require("../cloudflared/process");
const featureFlags_1 = require("../terminal-connection/featureFlags");
const connectionProtocol_1 = require("../../shared/terminal/connectionProtocol");
class DeviceFederationService {
    deps;
    identityStore;
    peerStore;
    linkStore;
    pairingSession = null;
    pairingCode = null;
    pairingUrl = null;
    server = null;
    serverStarting = null;
    sessions = new Map();
    /** Dedicated public transport for /device. It is independent from the phone
     * Remote tunnel, so both surfaces can be public at the same time. */
    relayTunnel = new process_1.TunnelManager(protocol_1.DEVICE_HEALTH_PATH);
    /** Peers whose endpoint probe is in flight — prevents duplicate sessions. */
    sessionStarting = new Set();
    /** Active mirrors keyed `deviceId|terminalId` → the forwarding handler. */
    mirrors = new Map();
    disposed = false;
    constructor(deps) {
        this.deps = deps;
        this.identityStore = new identityStore_1.DeviceIdentityStore(deps.kvFactory(gate_1.DEVICE_IDENTITY_STORE_NAME));
        this.peerStore = new peerStore_1.DevicePeerStore(deps.kvFactory(gate_1.DEVICE_PEERS_STORE_NAME));
        this.linkStore = new linkStore_1.FederatedLinkStore(deps.kvFactory(gate_1.DEVICE_PEERS_STORE_NAME));
        this.identityStore.refreshAppVersion(deps.appVersion);
        this.relayTunnel.on('event', (event) => {
            if (event.type === 'running') {
                this.rebuildPairingCode();
                void this.broadcastEndpointAdvertisement();
            }
            else if (event.type === 'stopped' || event.type === 'error') {
                this.rebuildPairingCode();
                void this.broadcastEndpointAdvertisement();
            }
            this.emitState();
        });
    }
    /** Bring the transport up for existing confirmed peers (called once, lazily). */
    async init() {
        if (this.peerStore.count() > 0) {
            await this.ensureServer();
            await this.ensureSessions();
        }
        this.emitState();
    }
    /* ------------------------------------------------------------- state */
    getState() {
        const online = new Set(this.onlinePeerIds());
        const peers = this.peerStore.getAll().map((p) => (0, identity_1.toPeerSummary)(p, online.has(p.deviceId)));
        return {
            self: this.identityStore.get(),
            peers,
            serverRunning: this.server !== null,
            serverPort: this.server?.port ?? null,
            relay: this.identityStore.get() ? this.relayTunnel.getStatus() : undefined,
            pairing: {
                active: (0, pairingCrypto_1.isPairingSessionValid)(this.pairingSession),
                code: (0, pairingCrypto_1.isPairingSessionValid)(this.pairingSession) ? this.pairingCode : null,
                url: (0, pairingCrypto_1.isPairingSessionValid)(this.pairingSession) ? this.pairingUrl : null,
                expiresAt: this.pairingSession?.expiresAt ?? null,
            },
            pendingConfirm: peers.filter((p) => p.confirmedAt === null),
            links: this.linkStore.getAll(),
        };
    }
    /**
     * Create or refresh a cross-device edge. Called after a human gesture on the
     * control surface (an @mention send) — never minted by an agent or the CLI,
     * same rule as local links (plan invariant 21).
     */
    async ensureFederatedLink(input) {
        const source = this.deps.resolveLocalTerminal?.(input.fromTerminalId) ?? null;
        const identity = this.identityStore.get();
        if (!identity || !source || source.projectId !== input.fromProjectId || !source.terminalGeneration) {
            return { ok: false, error: { code: 'DEVICE_TERMINAL_NOT_RUNNING', message: 'The source terminal is not running on this machine.' } };
        }
        if (!source.isInteractiveAgent) {
            return { ok: false, error: { code: 'DEVICE_TERMINAL_NOT_AI', message: 'Conversational links require an AI terminal.' } };
        }
        if (!input.to?.deviceId || !input.to.terminalId || input.to.terminalGeneration <= 0) {
            return { ok: false, error: { code: 'DEVICE_GENERATION_MISMATCH', message: 'Refresh the peer catalog before linking this terminal.' } };
        }
        const existing = this.linkStore.getAll().find((row) => row.from.terminalId === input.fromTerminalId &&
            row.from.terminalGeneration === source.terminalGeneration &&
            row.to.deviceId === input.to.deviceId &&
            row.to.terminalId === input.to.terminalId &&
            row.to.terminalGeneration === input.to.terminalGeneration &&
            row.state === 'active');
        if (existing)
            return { ok: true, link: existing, created: false, reverse: true };
        const ready = await this.readySession(input.to.deviceId);
        if ('error' in ready)
            return { ok: false, error: ready.error };
        const linkId = `fl-${(0, crypto_1.randomBytes)(8).toString('hex')}`;
        const operationId = `admit-${(0, crypto_1.randomUUID)()}`;
        const from = {
            deviceId: identity.deviceId,
            deviceName: identity.displayName,
            terminalId: input.fromTerminalId,
            terminalGeneration: source.terminalGeneration,
            projectId: source.projectId,
            projectName: this.deps.getCatalogSources().getProjects().find((row) => row.id === source.projectId)?.name ?? '',
            name: source.name ?? input.fromTerminalId,
            agentType: source.agentType ?? 'custom',
        };
        const request = {
            operationId,
            linkId,
            originDeviceName: identity.displayName,
            from,
            to: input.to,
        };
        const ack = await ready.value.secureRequest('orchestration:admit', request, operationId);
        if (!ack.ok)
            return { ok: false, error: ack.error ?? { code: 'DEVICE_INTERNAL', message: 'The peer refused the link admission.' } };
        const link = this.linkStore.ensure({
            fromTerminalId: input.fromTerminalId,
            fromTerminalGeneration: source.terminalGeneration,
            fromProjectId: input.fromProjectId,
            to: input.to,
            linkId,
            operationId,
            admissionId: ack.admissionId,
        });
        this.audit('link:admitted', input.to.deviceId, { linkId: link.linkId, admissionId: link.admissionId, to: input.to.terminalId });
        this.emitState();
        return { ok: true, link, created: true, reverse: true };
    }
    removeFederatedLink(linkId) {
        this.linkStore.remove(linkId);
        this.emitState();
        return this.getState();
    }
    emitState() {
        if (this.disposed)
            return;
        this.deps.sendToRenderer('device:state-changed', this.getState());
    }
    onlinePeerIds() {
        const ids = [];
        for (const [deviceId, session] of this.sessions) {
            if (session.isOnline())
                ids.push(deviceId);
        }
        if (this.server) {
            for (const [, socket] of this.server.nsp.sockets) {
                const data = socket.data;
                if (data.authenticated && data.deviceId && !ids.includes(data.deviceId)) {
                    ids.push(data.deviceId);
                }
            }
        }
        return ids;
    }
    /* ----------------------------------------------------------- pairing */
    /** Host side: mint identity if needed, start server, return pasteable code. */
    async startPairing() {
        const identity = this.ensureIdentity();
        await this.ensureServer();
        const session = (0, pairingCrypto_1.createPairingSession)();
        this.pairingSession = session;
        // Advertise EVERY address we might be reachable on (LAN first, then VPN /
        // tunnel). A peer that shares only a Tailscale/WireGuard route with us can
        // then still pair — the joiner probes them in order.
        this.rebuildPairingCode();
        this.audit('pairing:start', identity.deviceId, {});
        this.emitState();
        return this.getState();
    }
    cancelPairing() {
        this.pairingSession = null;
        this.pairingCode = null;
        this.pairingUrl = null;
        this.stopServerIfIdle();
        this.emitState();
        return this.getState();
    }
    /**
     * Joiner side: parse the code from the host machine, bring our own server
     * up (dial-back endpoint), POST /api/device-pair, store the peer pending
     * mutual confirm. Returns the fingerprint the human must compare.
     */
    async joinPairing(code) {
        const parsed = this.parsePairCode(code);
        if (!parsed) {
            return { ok: false, error: { code: 'DEVICE_PAIRING_INVALID', message: 'That code is not a valid 1DevTool device pairing code.' } };
        }
        if (parsed.v !== protocol_1.DEVICE_PROTOCOL_VERSION) {
            return { ok: false, error: { code: 'DEVICE_PROTOCOL_MISMATCH', message: 'The other machine runs an incompatible 1DevTool version. Update both apps.' } };
        }
        const identity = this.ensureIdentity();
        await this.ensureServer();
        const selfEndpoints = this.selfEndpoints();
        const selfUrl = selfEndpoints[0]?.url ?? `http://${(0, lanIp_1.getLanIp)()}:${this.server.port}`;
        // Reach the host on whichever of its advertised addresses answers — this is
        // what makes a VPN-only pair (no shared LAN) work.
        const hostCandidates = [parsed.u, ...(Array.isArray(parsed.e) ? parsed.e : [])]
            .filter(endpoints_1.isSafeAdvertisedEndpoint);
        const reachable = await (0, endpoints_1.pickReachableEndpoint)(hostCandidates.map((url) => ({ kind: 'lan', url })), { timeoutMs: 3_000 });
        if (!reachable) {
            this.stopServerIfIdle();
            return {
                ok: false,
                error: {
                    code: 'DEVICE_OFFLINE',
                    message: `Could not reach that machine on ${hostCandidates.length} address(es). Same network or VPN? Firewall?`,
                },
            };
        }
        const hostUrl = reachable.url;
        const exchange = (0, pairingCrypto_1.completePairingAsJoiner)(parsed.s, parsed.k);
        if (!exchange) {
            return { ok: false, error: { code: 'DEVICE_PAIRING_INVALID', message: 'Could not complete the key exchange for that code.' } };
        }
        const request = {
            protocolVersion: protocol_1.DEVICE_PROTOCOL_VERSION,
            pairingSecret: parsed.s,
            deviceId: identity.deviceId,
            displayName: identity.displayName,
            platform: process.platform,
            appVersion: this.deps.appVersion,
            publicKey: exchange.publicKeyBase64,
            endpointUrl: selfUrl,
            endpointUrls: selfEndpoints.map((endpoint) => endpoint.url),
        };
        let response;
        try {
            const res = await fetch(`${hostUrl}/api/device-pair`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) {
                const body = (await res.json().catch(() => null));
                return {
                    ok: false,
                    error: body?.error ?? { code: 'DEVICE_PAIRING_INVALID', message: `The other machine rejected the pairing (HTTP ${res.status}).` },
                };
            }
            response = (await res.json());
        }
        catch {
            this.stopServerIfIdle();
            return { ok: false, error: { code: 'DEVICE_OFFLINE', message: 'Could not reach the other machine. Same network? Firewall?' } };
        }
        const fingerprint = (0, pairingCrypto_1.fingerprintFromKeys)(exchange.keys);
        const now = Date.now();
        const peer = {
            deviceId: response.deviceId,
            displayName: response.displayName || parsed.n,
            platform: response.platform,
            appVersion: response.appVersion,
            // The address that actually answered leads the next connect.
            endpoints: (0, endpoints_1.endpointsFromUrls)(hostCandidates, hostUrl, now),
            authKey: exchange.keys.authKey.toString('base64url'),
            encryptKey: exchange.keys.encryptKey.toString('base64url'),
            grants: (0, identity_1.defaultDeviceGrant)(),
            pairedAt: now,
            confirmedAt: null,
            lastSeenAt: null,
            trustFingerprint: fingerprint,
        };
        this.peerStore.add(peer);
        this.audit('pairing:joined', peer.deviceId, { url: parsed.u });
        this.emitState();
        return { ok: true, fingerprint, peerName: peer.displayName };
    }
    /** Host-side HTTP handler for POST /api/device-pair (wired into server.ts). */
    handlePairRequest(body, remoteAddress) {
        const req = body;
        if (!req || typeof req !== 'object' || !req.pairingSecret || !req.publicKey || !req.deviceId) {
            return { status: 400, body: { error: { code: 'DEVICE_PAIRING_INVALID', message: 'Malformed pairing request.' } } };
        }
        if (req.protocolVersion !== protocol_1.DEVICE_PROTOCOL_VERSION) {
            return { status: 409, body: { error: { code: 'DEVICE_PROTOCOL_MISMATCH', message: 'Incompatible protocol version. Update both apps.' } } };
        }
        const advertisedUrls = (Array.isArray(req.endpointUrls) && req.endpointUrls.length > 0
            ? req.endpointUrls
            : [req.endpointUrl]).filter(endpoints_1.isSafeAdvertisedEndpoint);
        if (advertisedUrls.length === 0 || advertisedUrls.length > 12) {
            return { status: 400, body: { error: { code: 'DEVICE_PAIRING_INVALID', message: 'No safe dial-back endpoint was advertised.' } } };
        }
        const keys = (0, pairingCrypto_1.completePairingAsHost)(this.pairingSession, req.pairingSecret, req.publicKey);
        if (!keys) {
            this.audit('pairing:denied', req.deviceId, { remoteAddress });
            return { status: 403, body: { error: { code: 'DEVICE_PAIRING_INVALID', message: 'Invalid or expired pairing secret.' } } };
        }
        const identity = this.identityStore.get();
        const fingerprint = (0, pairingCrypto_1.fingerprintFromKeys)(keys);
        const now = Date.now();
        const peer = {
            deviceId: req.deviceId,
            displayName: req.displayName || 'Unnamed device',
            platform: req.platform || 'unknown',
            appVersion: req.appVersion || 'unknown',
            // Host side: keep every dial-back candidate the joiner advertised, so a
            // VPN-only route survives here too. None is marked successful yet — the
            // first outbound connect decides that.
            endpoints: (0, endpoints_1.endpointsFromUrls)(advertisedUrls),
            authKey: keys.authKey.toString('base64url'),
            encryptKey: keys.encryptKey.toString('base64url'),
            grants: (0, identity_1.defaultDeviceGrant)(),
            pairedAt: now,
            confirmedAt: null,
            lastSeenAt: null,
            trustFingerprint: fingerprint,
        };
        this.peerStore.add(peer);
        // One code pairs one machine: end the pairing session, keep the server up
        // (a pending-confirm peer now exists).
        this.pairingSession = null;
        this.pairingCode = null;
        this.pairingUrl = null;
        this.audit('pairing:success', peer.deviceId, { remoteAddress, fingerprint });
        this.emitState();
        const response = {
            protocolVersion: protocol_1.DEVICE_PROTOCOL_VERSION,
            deviceId: identity.deviceId,
            displayName: identity.displayName,
            platform: process.platform,
            appVersion: this.deps.appVersion,
        };
        return { status: 200, body: response };
    }
    /** Human pressed "They match" on this machine. */
    async confirmPeer(deviceId) {
        const peer = this.peerStore.confirm(deviceId);
        if (peer) {
            this.audit('peer:confirmed', deviceId, {});
            await this.ensureServer();
            await this.ensureSessions();
        }
        this.emitState();
        return this.getState();
    }
    revokePeer(deviceId) {
        const session = this.sessions.get(deviceId);
        if (session) {
            session.dispose();
            this.sessions.delete(deviceId);
        }
        if (this.server) {
            for (const [, socket] of this.server.nsp.sockets) {
                if (socket.data.deviceId === deviceId)
                    socket.disconnect(true);
            }
        }
        this.peerStore.remove(deviceId);
        // Revoking a device removes its edges outright — an unpaired machine has no
        // relationship left to quarantine.
        this.linkStore.removeDevice(deviceId);
        this.audit('peer:revoked', deviceId, {});
        this.stopServerIfIdle();
        this.emitState();
        return this.getState();
    }
    setPeerGrants(deviceId, grants) {
        this.peerStore.setGrants(deviceId, grants);
        this.audit('peer:grants-changed', deviceId, { grants: { ...grants, projectScope: undefined } });
        this.emitState();
        return this.getState();
    }
    renameSelf(displayName) {
        this.identityStore.rename(displayName);
        this.rebuildPairingCode();
        this.emitState();
        return this.getState();
    }
    /** Start an outbound HTTPS quick tunnel dedicated to the peer protocol. */
    async startRelay() {
        if (!(0, pairingCrypto_1.isPairingSessionValid)(this.pairingSession) && this.peerStore.count() === 0) {
            return {
                ok: false,
                error: { code: 'DEVICE_RELAY_UNAVAILABLE', message: 'Start a device pairing flow before enabling the public device link.' },
            };
        }
        this.ensureIdentity();
        await this.ensureServer();
        const existing = this.relayTunnel.getStatus();
        if (existing.running && existing.url)
            return { ok: true, state: this.getState() };
        const result = await this.relayTunnel.start(this.server.port);
        if (!result.ok) {
            return {
                ok: false,
                error: { code: 'DEVICE_RELAY_UNAVAILABLE', message: result.error ?? 'Could not start the public device link.' },
            };
        }
        this.audit('relay:start', this.identityStore.get().deviceId, { url: result.url });
        this.rebuildPairingCode();
        this.emitState();
        return { ok: true, state: this.getState() };
    }
    async stopRelay() {
        const identity = this.identityStore.get();
        await this.relayTunnel.stop();
        if (identity)
            this.audit('relay:stop', identity.deviceId, {});
        this.rebuildPairingCode();
        this.emitState();
        return this.getState();
    }
    /* ----------------------------------------------------------- catalog */
    async fetchPeerCatalog(deviceId) {
        const peer = this.peerStore.get(deviceId);
        if (!peer) {
            return { ok: false, error: { code: 'DEVICE_NOT_PAIRED', message: 'That device is not paired.' } };
        }
        if (peer.confirmedAt === null) {
            return { ok: false, error: { code: 'DEVICE_NOT_CONFIRMED', message: 'Confirm the fingerprint on this machine first.' } };
        }
        await this.ensureSessions();
        const session = this.sessions.get(deviceId);
        if (!session) {
            return { ok: false, error: { code: 'DEVICE_OFFLINE', message: `${peer.displayName} has no reachable endpoint.` } };
        }
        // Give a cold/reconnecting session a moment to authenticate before failing
        // honestly — never fall back to anything local (§4 principle 6).
        if (!session.isOnline()) {
            await waitFor(() => session.isOnline(), 5_000);
        }
        const result = await session.requestCatalog();
        if (result.ok) {
            this.peerStore.updateLastSeen(deviceId);
        }
        return result;
    }
    async listPeerResumeSessions(deviceId) {
        const session = await this.readySession(deviceId);
        if ('error' in session)
            return { ok: false, error: session.error };
        const operationId = `resume-list-${(0, crypto_1.randomUUID)()}`;
        const result = await session.value.secureRequest('resume:list', { operationId }, operationId, 30_000);
        return result.ok ? result : { ok: false, error: result.error ?? { code: 'DEVICE_INTERNAL', message: 'Peer resume scan failed.' } };
    }
    async resumePeerSession(deviceId, sessionId, projectId) {
        const session = await this.readySession(deviceId);
        if ('error' in session)
            return { ok: false, error: session.error };
        const operationId = `resume-${(0, crypto_1.randomUUID)()}`;
        const request = { operationId, sessionId, projectId };
        const result = await session.value.secureRequest('resume:start', request, operationId, 45_000);
        return result.ok ? result : { ok: false, error: result.error ?? { code: 'DEVICE_INTERNAL', message: 'Peer resume failed.' } };
    }
    async validatePeerTeamMember(input) {
        const peer = this.peerStore.get(input.deviceId);
        if (!peer)
            return { ok: false, error: 'The selected Team device is not paired.' };
        if (peer.confirmedAt === null)
            return { ok: false, error: `Confirm ${peer.displayName}'s fingerprint before assigning Team work.` };
        const ready = await this.readySession(input.deviceId);
        if ('error' in ready)
            return { ok: false, error: ready.error.message };
        return { ok: true, deviceName: peer.displayName };
    }
    async startPeerTeamMember(input) {
        const ready = await this.readySession(input.deviceId);
        if ('error' in ready)
            return { ok: false, error: ready.error.message };
        const request = {
            operationId: input.operationId,
            projectId: input.projectId,
            member: input.member,
        };
        const result = await ready.value.secureRequest('team:start', request, input.operationId, 60_000);
        return result.ok
            ? result
            : { ok: false, error: result.error?.message ?? 'The peer refused the Team member.' };
    }
    async sendPeerTeamMember(input) {
        const ready = await this.readySession(input.deviceId);
        if ('error' in ready)
            return { ok: false, error: ready.error.message };
        const request = {
            operationId: input.operationId,
            projectId: input.projectId,
            teamId: input.teamId,
            memberId: input.memberId,
            prompt: input.prompt,
        };
        const result = await ready.value.secureRequest('team:send', request, input.operationId, 45_000);
        return result.ok
            ? result
            : { ok: false, error: result.error?.message ?? 'The peer refused the Team message.' };
    }
    async collectPeerTeamRun(input) {
        const ready = await this.readySession(input.deviceId);
        if ('error' in ready)
            return { ok: false, error: ready.error.message };
        const request = {
            operationId: input.operationId,
            projectId: input.projectId,
            teamId: input.teamId,
            runId: input.runId,
            timeoutMs: input.timeoutMs,
        };
        const result = await ready.value.secureRequest('team:collect', request, input.operationId, Math.max(30_000, input.timeoutMs + 10_000));
        return result.ok
            ? result
            : { ok: false, error: result.error?.message ?? 'The peer run could not be collected.' };
    }
    async stopPeerTeam(input) {
        const ready = await this.readySession(input.deviceId);
        if ('error' in ready)
            return { ok: false, error: ready.error.message };
        const request = {
            operationId: input.operationId,
            projectId: input.projectId,
            teamId: input.teamId,
        };
        const result = await ready.value.secureRequest('team:stop', request, input.operationId, 45_000);
        return result.ok
            ? { ok: true }
            : { ok: false, error: result.error?.message ?? 'The peer did not confirm Team shutdown.' };
    }
    async applySkillOnPeer(deviceId, input) {
        const ready = await this.readySession(deviceId);
        if ('error' in ready)
            return { ok: false, error: ready.error };
        const operationId = `skill-apply-${(0, crypto_1.randomUUID)()}`;
        const request = { ...input, operationId };
        const result = await ready.value.secureRequest('skill:apply', request, operationId, 90_000);
        return result.ok
            ? result
            : { ok: false, error: result.error ?? { code: 'DEVICE_INTERNAL', message: 'The peer skill apply failed.' } };
    }
    async createPeerTerminal(input) {
        const ready = await this.readySession(input.deviceId);
        if ('error' in ready)
            return { ok: false, error: ready.error };
        const operationId = `terminal-create-${(0, crypto_1.randomUUID)()}`;
        const request = {
            operationId,
            projectId: input.projectId,
            agentType: input.agentType,
            name: input.name,
        };
        const result = await ready.value.secureRequest('terminal:create', request, operationId, 60_000);
        return result.ok
            ? result
            : { ok: false, error: result.error ?? { code: 'DEVICE_INTERNAL', message: 'The peer terminal could not be created.' } };
    }
    /**
     * Deliver a prompt to an AI terminal on a peer. Never falls back to anything
     * local: a failure here is reported as-is so the user knows the message did
     * NOT run somewhere else (§4 principle 6).
     */
    async submitToPeerTerminal(deviceId, terminalId, text, terminalGeneration) {
        const ready = await this.readySession(deviceId);
        if ('error' in ready)
            return { ok: false, error: ready.error };
        let generation = terminalGeneration;
        if (!Number.isSafeInteger(generation) || (generation ?? 0) <= 0) {
            const catalog = await ready.value.requestCatalog();
            generation = catalog.ok
                ? catalog.snapshot.terminals.find((row) => row.terminalId === terminalId)?.terminalGeneration
                : undefined;
        }
        if (!generation) {
            return { ok: false, error: { code: 'DEVICE_GENERATION_MISMATCH', message: 'Refresh the peer terminal before submitting a prompt.' } };
        }
        const operationId = `terminal-submit-${(0, crypto_1.randomUUID)()}`;
        const request = {
            operationId,
            terminalId,
            terminalGeneration: generation,
            text,
        };
        const result = await ready.value.secureRequest('terminal:submit', request, operationId, 60_000);
        if (result.ok) {
            this.peerStore.updateLastSeen(deviceId);
            // Keep the map honest: a delivery proves the edge is live.
            const link = this.linkStore
                .getAll()
                .find((row) => row.to.deviceId === deviceId && row.to.terminalId === terminalId);
            if (link) {
                this.linkStore.markDelivered(link.linkId);
                this.emitState();
            }
            return { ok: true };
        }
        else {
            const error = result.error ?? { code: 'DEVICE_INTERNAL', message: 'The peer returned a malformed submit receipt.' };
            // Typed quarantine so the edge stays on the map showing WHY it stopped,
            // rather than silently disappearing (plan §7.2).
            const reason = error.code === 'DEVICE_GRANT_MISSING'
                ? 'peer-grant-revoked'
                : error.code === 'DEVICE_TERMINAL_NOT_FOUND' || error.code === 'DEVICE_TERMINAL_NOT_RUNNING'
                    ? 'peer-terminal-gone'
                    : error.code === 'DEVICE_PROTOCOL_MISMATCH'
                        ? 'peer-app-version-incompatible'
                        : 'peer-offline';
            const link = this.linkStore
                .getAll()
                .find((row) => row.to.deviceId === deviceId && row.to.terminalId === terminalId);
            if (link) {
                this.linkStore.quarantine(link.linkId, reason);
                this.emitState();
            }
            return { ok: false, error };
        }
    }
    /** Send over a dual-admitted conversational edge and wait for acceptance. */
    async sendFederatedMessage(input) {
        const source = this.deps.resolveLocalTerminal?.(input.fromTerminalId) ?? null;
        const identity = this.identityStore.get();
        const link = [...this.linkStore.getAll()].reverse().find((row) => row.state === 'active' &&
            row.from.terminalId === input.fromTerminalId &&
            row.to.deviceId === input.to.deviceId &&
            row.to.terminalId === input.to.terminalId);
        if (!link)
            return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'No admitted conversational link exists for that peer terminal.' } };
        if (!source || !identity || source.terminalGeneration !== link.from.terminalGeneration) {
            this.linkStore.quarantine(link.linkId, 'peer-generation-mismatch');
            this.emitState();
            return { ok: false, error: { code: 'DEVICE_GENERATION_MISMATCH', message: 'The source terminal changed. Link it again before sending.' } };
        }
        if (link.to.terminalGeneration !== input.to.terminalGeneration) {
            this.linkStore.quarantine(link.linkId, 'peer-generation-mismatch');
            this.emitState();
            return { ok: false, error: { code: 'DEVICE_GENERATION_MISMATCH', message: 'The peer terminal changed. Refresh the catalog and link it again.' } };
        }
        const session = await this.readySession(input.to.deviceId);
        if ('error' in session) {
            this.linkStore.quarantine(link.linkId, 'peer-offline');
            this.emitState();
            return { ok: false, error: session.error };
        }
        const operationId = `deliver-${(0, crypto_1.randomUUID)()}`;
        const messageId = `fm-${(0, crypto_1.randomUUID)()}`;
        const from = {
            deviceId: identity.deviceId,
            deviceName: identity.displayName,
            terminalId: input.fromTerminalId,
            terminalGeneration: link.from.terminalGeneration,
            projectId: source.projectId,
            projectName: this.deps.getCatalogSources().getProjects().find((row) => row.id === source.projectId)?.name ?? '',
            name: source.name ?? input.fromTerminalId,
            agentType: source.agentType ?? 'custom',
        };
        const record = {
            messageId,
            operationId,
            linkId: link.linkId,
            admissionId: link.admissionId,
            from,
            to: { ...link.to },
            preview: input.body.trim().split('\n')[0].slice(0, 120),
            state: 'queued',
            replyToken: (0, crypto_1.randomBytes)(12).toString('hex'),
            createdAt: Date.now(),
        };
        const begun = this.linkStore.beginMessage(record);
        if (!begun.ok)
            return { ok: false, error: { code: 'DEVICE_OPERATION_CONFLICT', message: 'Message operation conflict.' } };
        this.linkStore.updateMessage(messageId, { state: 'delivering' });
        const request = {
            operationId,
            admissionId: link.admissionId,
            linkId: link.linkId,
            messageId,
            from,
            to: { ...link.to },
            body: input.body,
            replyToken: record.replyToken,
        };
        const ack = await session.value.secureRequest('orchestration:deliver', request, operationId, 60_000);
        if (ack.ok) {
            this.linkStore.updateMessage(messageId, { state: 'delivered', deliveredAt: ack.deliveredAt });
            this.linkStore.markDelivered(link.linkId, ack.deliveredAt);
            this.audit('link:message-delivered', input.to.deviceId, { linkId: link.linkId, messageId });
            this.emitState();
            return { ok: true, messageId, deliveredAt: ack.deliveredAt };
        }
        const error = ack.error ?? { code: 'DEVICE_INTERNAL', message: 'The peer did not accept the message.' };
        this.linkStore.updateMessage(messageId, { state: 'failed', error: error.code });
        this.quarantineForError(link.linkId, error);
        this.emitState();
        return { ok: false, error };
    }
    /** Called only by LinkRegistry after a peer-delivered reply token is used. */
    async sendFederatedReply(input) {
        const session = await this.readySession(input.admission.originDeviceId);
        if ('error' in session)
            return { ok: false, error: 'delivery-failed', detail: session.error.message };
        const identity = this.identityStore.get();
        const source = this.deps.resolveLocalTerminal?.(input.admission.to.terminalId) ?? null;
        if (!identity || !source || !source.terminalGeneration) {
            return { ok: false, error: 'target-closed', detail: 'Replying terminal is no longer running.' };
        }
        const from = {
            deviceId: identity.deviceId,
            deviceName: identity.displayName,
            terminalId: input.admission.to.terminalId,
            terminalGeneration: source.terminalGeneration,
            projectId: source.projectId,
            projectName: this.deps.getCatalogSources().getProjects().find((row) => row.id === source.projectId)?.name ?? '',
            name: source.name ?? input.admission.to.terminalId,
            agentType: source.agentType ?? input.admission.to.effectiveAgentKind,
        };
        const request = {
            operationId: input.operationId,
            linkId: input.admission.linkId,
            admissionId: input.admission.admissionId,
            originalMessageId: input.original.messageId,
            originalReplyToken: input.original.replyToken,
            messageId: input.messageId,
            from,
            to: { ...input.admission.from },
            body: input.body,
            replyToken: input.replyToken,
        };
        const ack = await session.value.secureRequest('orchestration:reply', request, input.operationId, Math.max(60_000, input.waitMs ?? 0));
        if (!ack.ok)
            return { ok: false, error: 'delivery-failed', detail: ack.error?.message ?? 'Peer reply delivery failed.' };
        return {
            ok: true,
            receipt: {
                messageId: input.messageId,
                linkId: input.admission.linkId,
                toTerminalId: input.admission.from.terminalId,
                state: 'delivered',
                deliveredAt: ack.deliveredAt,
                replyToMessageId: input.original.messageId,
            },
        };
    }
    quarantineForError(linkId, error) {
        const reason = error.code === 'DEVICE_GRANT_MISSING'
            ? 'peer-grant-revoked'
            : error.code === 'DEVICE_GENERATION_MISMATCH'
                ? 'peer-generation-mismatch'
                : error.code === 'DEVICE_PROJECT_OUT_OF_SCOPE'
                    ? 'peer-project-out-of-scope'
                    : error.code === 'DEVICE_TERMINAL_NOT_FOUND' || error.code === 'DEVICE_TERMINAL_NOT_RUNNING'
                        ? 'peer-terminal-gone'
                        : error.code === 'DEVICE_PROTOCOL_MISMATCH'
                            ? 'peer-app-version-incompatible'
                            : 'peer-offline';
        this.linkStore.quarantine(linkId, reason);
    }
    /** Peer memory metadata (plan §6.6) — on-demand RPC, never a vault sync. */
    async searchPeerMemory(deviceId, params) {
        const session = await this.readySession(deviceId);
        if ('error' in session)
            return { ok: false, error: session.error };
        const operationId = `memory-search-${(0, crypto_1.randomUUID)()}`;
        const ack = await session.value.secureRequest('memory:search', params ?? {}, operationId);
        if (!ack.ok)
            return { ok: false, error: ack.error ?? { code: 'DEVICE_INTERNAL', message: 'Memory scan failed.' } };
        return { ok: true, entries: ack.result?.entries ?? [], total: ack.result?.total ?? 0 };
    }
    /** Body of one peer memory entry. Content travels over the session, not disk. */
    async readPeerMemoryEntry(deviceId, filePath) {
        const session = await this.readySession(deviceId);
        if ('error' in session)
            return { ok: false, error: session.error };
        const operationId = `memory-read-${(0, crypto_1.randomUUID)()}`;
        const ack = await session.value.secureRequest('memory:read-entry', { filePath }, operationId);
        if (!ack.ok)
            return { ok: false, error: ack.error ?? { code: 'DEVICE_INTERNAL', message: 'Memory read failed.' } };
        return { ok: true, entry: ack.entry ?? null };
    }
    /** Save an edited memory entry on the peer (needs its memoryWrite grant). */
    async writePeerMemoryEntry(deviceId, filePath, content) {
        const session = await this.readySession(deviceId);
        if ('error' in session)
            return { ok: false, error: session.error };
        const operationId = `memory-write-${(0, crypto_1.randomUUID)()}`;
        const ack = await session.value.secureRequest('memory:write-entry', { filePath, content }, operationId);
        if (!ack.ok)
            return { ok: false, error: ack.error ?? { code: 'DEVICE_INTERNAL', message: 'Write failed.' } };
        return { ok: true };
    }
    /**
     * Open a live mirror of a peer terminal. Output is pushed to the renderer as
     * `device:terminal-output`; the renderer owns the xterm, main owns the wire.
     */
    async startPeerMirror(deviceId, terminalId, terminalGeneration) {
        if (!Number.isSafeInteger(terminalGeneration) || (terminalGeneration ?? 0) <= 0) {
            return {
                ok: false,
                error: { code: 'DEVICE_GENERATION_MISMATCH', message: 'Refresh the peer terminal before opening it.' },
            };
        }
        const generation = terminalGeneration;
        const session = await this.readySession(deviceId);
        if ('error' in session)
            return { ok: false, error: session.error };
        const key = `${deviceId}|${terminalId}`;
        if (this.mirrors.has(key)) {
            // Already mirroring — re-request the snapshot so a second viewer paints.
            return session.value.startMirror(terminalId, this.mirrors.get(key), generation);
        }
        const handler = (delivery) => {
            this.deps.sendToRenderer('device:terminal-delivery-v2', { deviceId, terminalId, delivery });
        };
        const result = await session.value.startMirror(terminalId, handler, generation);
        if (result.ok)
            this.mirrors.set(key, handler);
        return result;
    }
    stopPeerMirror(deviceId, terminalId) {
        const key = `${deviceId}|${terminalId}`;
        const handler = this.mirrors.get(key);
        if (!handler)
            return;
        this.mirrors.delete(key);
        this.sessions.get(deviceId)?.stopMirror(terminalId, handler);
    }
    listRemotePeerHosts() {
        const online = new Set(this.onlinePeerIds());
        return this.peerStore.getConfirmed().map((peer) => ({
            deviceId: peer.deviceId,
            displayName: peer.displayName,
            online: online.has(peer.deviceId),
            platform: peer.platform,
            appVersion: peer.appVersion,
        }));
    }
    async subscribeRemotePeerTerminal(deviceId, terminalId, terminalGeneration, onData) {
        const ready = await this.readySession(deviceId);
        if ('error' in ready)
            return { ok: false, error: ready.error };
        return ready.value.startMirror(terminalId, onData, terminalGeneration);
    }
    unsubscribeRemotePeerTerminal(deviceId, terminalId, onData) {
        this.sessions.get(deviceId)?.stopMirror(terminalId, onData);
    }
    async acknowledgePeerTerminalFrame(deviceId, connectionId, syncGeneration, frameId) {
        const ready = await this.readySession(deviceId);
        if ('error' in ready)
            return { ok: false, error: ready.error };
        return ready.value.acknowledgeMirrorFrame(connectionId, syncGeneration, frameId);
    }
    async resyncPeerTerminal(deviceId, connectionId) {
        const ready = await this.readySession(deviceId);
        if ('error' in ready)
            return { ok: false, error: ready.error };
        return ready.value.resyncMirror(connectionId);
    }
    async setPeerTerminalVisibility(deviceId, connectionId, visible) {
        const ready = await this.readySession(deviceId);
        if ('error' in ready)
            return { ok: false, error: ready.error };
        return ready.value.setMirrorVisibility(connectionId, visible);
    }
    /**
     * Shared preamble for every peer RPC: paired, confirmed, and an authenticated
     * session that has had a moment to come up. Failures are typed, never local
     * fallbacks.
     */
    async readySession(deviceId) {
        const peer = this.peerStore.get(deviceId);
        if (!peer)
            return { error: { code: 'DEVICE_NOT_PAIRED', message: 'That device is not paired.' } };
        if (peer.confirmedAt === null) {
            return { error: { code: 'DEVICE_NOT_CONFIRMED', message: `Confirm ${peer.displayName}'s fingerprint first.` } };
        }
        await this.ensureSessions();
        const session = this.sessions.get(deviceId);
        if (!session) {
            return { error: { code: 'DEVICE_OFFLINE', message: `${peer.displayName} has no reachable endpoint.` } };
        }
        if (!session.isOnline())
            await waitFor(() => session.isOnline(), 5_000);
        if (!session.isOnline()) {
            return {
                error: {
                    code: 'DEVICE_OFFLINE',
                    message: `${peer.displayName} is offline. Last seen ${peer.lastSeenAt ? new Date(peer.lastSeenAt).toLocaleTimeString() : 'never'}.`,
                },
            };
        }
        this.peerStore.updateLastSeen(deviceId);
        return { value: session };
    }
    /* --------------------------------------------------------- transport */
    selfEndpoints() {
        if (!this.server)
            return [];
        const local = (0, endpoints_1.endpointsFromHosts)((0, lanIp_1.getCandidateHosts)(), this.server.port);
        const publicUrl = this.relayTunnel.getStatus().url;
        return publicUrl
            ? [...local, ...(0, endpoints_1.endpointsFromUrls)([publicUrl])]
            : local;
    }
    /** Re-encode the still-live one-time pairing artifact whenever its endpoint
     * set or display name changes. The ECDH secret/key stay the same. */
    rebuildPairingCode() {
        if (!this.server || !(0, pairingCrypto_1.isPairingSessionValid)(this.pairingSession))
            return;
        const identity = this.identityStore.get();
        if (!identity || !this.pairingSession)
            return;
        const endpoints = this.selfEndpoints();
        const url = endpoints[0]?.url ?? `http://${(0, lanIp_1.getLanIp)()}:${this.server.port}`;
        const payload = {
            v: protocol_1.DEVICE_PROTOCOL_VERSION,
            u: url,
            s: this.pairingSession.pairingSecret,
            k: this.pairingSession.publicKeyBase64,
            n: identity.displayName,
            d: identity.deviceId,
            ...(endpoints.length > 1 ? { e: endpoints.slice(1).map((endpoint) => endpoint.url) } : {}),
        };
        this.pairingCode = protocol_1.DEVICE_PAIR_CODE_PREFIX + Buffer.from(JSON.stringify(payload)).toString('base64url');
        this.pairingUrl = url;
    }
    /** Send the complete current route set to every authenticated peer. This is
     * encrypted and replacement-based so an expired quick-tunnel URL cannot
     * accumulate in durable peer records. */
    async broadcastEndpointAdvertisement() {
        const identity = this.identityStore.get();
        if (!identity || !this.server)
            return;
        const urls = this.selfEndpoints().map((row) => row.url);
        const sends = [];
        for (const [peerDeviceId, session] of this.sessions) {
            if (!session.isOnline())
                continue;
            const operationId = `endpoint-${(0, crypto_1.randomUUID)()}`;
            sends.push(session.secureRequest('endpoint:update', { operationId, urls }, operationId, 15_000).then((result) => {
                if (result.ok)
                    this.audit('endpoint:advertised', peerDeviceId, { count: urls.length });
            }));
        }
        await Promise.allSettled(sends);
    }
    async ensureServer() {
        if (this.server)
            return;
        if (this.serverStarting)
            return this.serverStarting;
        this.serverStarting = (async () => {
            const handle = await (0, server_1.startDeviceServer)({
                preferredPort: protocol_1.DEVICE_DEFAULT_PORT,
                handlePairRequest: (body, remoteAddress) => this.handlePairRequest(body, remoteAddress),
            });
            this.server = handle;
            this.attachNamespaceHandlers();
        })();
        try {
            await this.serverStarting;
        }
        finally {
            this.serverStarting = null;
        }
    }
    attachNamespaceHandlers() {
        const nsp = this.server.nsp;
        nsp.on('connection', (socket) => {
            const data = {
                authenticated: false,
                deviceId: '',
                challenge: (0, pairingCrypto_1.generateDeviceChallenge)(),
                inboundSequence: 0,
                outboundSequence: 0,
                encryptKey: '',
            };
            socket.data = data;
            socket.emit('auth:challenge', { challenge: data.challenge });
            // Mirror state is owned by this authenticated socket. Snapshots and live
            // chunks both travel inside the same challenge-bound encrypted stream as
            // every other peer RPC; the relay learns only frame timing and size.
            const outputSubscriptions = new Map();
            const stopMirror = (connectionId) => {
                outputSubscriptions.get(connectionId)?.stop();
                outputSubscriptions.delete(connectionId);
            };
            const subscribeMirror = async (payload) => {
                const terminalId = payload?.terminalId ?? '';
                const peer = this.peerStore.get(data.deviceId);
                const resolved = terminalId ? this.deps.resolveLocalTerminal?.(terminalId) ?? null : null;
                const verdict = (0, submitPolicy_1.authorizeTerminalMirror)({
                    peer,
                    resolved,
                    terminalGeneration: payload?.terminalGeneration,
                });
                if (!verdict.ok)
                    return { ok: false, error: verdict.error };
                if (!(0, featureFlags_1.terminalConnectionV2Enabled)()) {
                    // ONEDEVTOOL_TERMINAL_CONNECTION_V2=0 rolls back peer-mirror
                    // streaming too: no raw-v1 peer path remains in this tree, so the
                    // serving device refuses the v2 attach outright.
                    return {
                        ok: false,
                        error: { code: 'DEVICE_INTERNAL', message: 'Terminal Connection v2 is disabled on this device.' },
                    };
                }
                const terminalGeneration = payload.terminalGeneration;
                const connectionService = this.deps.terminalConnectionService;
                const ownerIdentity = this.identityStore.get();
                if (!connectionService || !ownerIdentity || !payload.clientRequestId) {
                    return {
                        ok: false,
                        error: { code: 'DEVICE_INTERNAL', message: 'Terminal Connection v2 is unavailable.' },
                    };
                }
                const principal = {
                    origin: 'peer-device',
                    subjectId: data.deviceId,
                    owningDeviceId: ownerIdentity.deviceId,
                    permissions: new Set(['read']),
                };
                try {
                    const attach = await connectionService.attach({
                        terminalId,
                        clientRequestId: payload.clientRequestId,
                        capabilities: [...connectionProtocol_1.RAW_V2_CAPABILITIES],
                        historyMode: 'normal',
                    }, principal, (frame) => {
                        if (!data.authenticated)
                            return;
                        const current = this.deps.resolveLocalTerminal?.(terminalId) ?? null;
                        if (current?.terminalGeneration !== terminalGeneration) {
                            connectionService.detach(frame.connectionId, principal);
                            outputSubscriptions.delete(frame.connectionId);
                            return;
                        }
                        const identity = this.identityStore.get();
                        if (!identity) {
                            socket.disconnect(true);
                            return;
                        }
                        const event = {
                            event: 'terminal:connection-frame-v2',
                            payload: { terminalId, terminalGeneration, frame },
                        };
                        socket.emit('device:event', (0, transportCrypto_1.sealDevicePayload)(data.encryptKey, ++data.outboundSequence, {
                            fromDeviceId: identity.deviceId,
                            toDeviceId: data.deviceId,
                            channel: 'event',
                            sessionChallenge: data.challenge,
                        }, event));
                    });
                    if (attach.session.identity.terminalGeneration !== terminalGeneration) {
                        connectionService.detach(attach.connectionId, principal);
                        return {
                            ok: false,
                            error: { code: 'DEVICE_GENERATION_MISMATCH', message: 'The mirrored terminal generation changed during attach.' },
                        };
                    }
                    outputSubscriptions.set(attach.connectionId, {
                        terminalId,
                        terminalGeneration,
                        stop: () => connectionService.detach(attach.connectionId, principal),
                    });
                    this.audit('terminal:mirror-start', data.deviceId, { terminalId, terminalGeneration });
                    return { ok: true, attach };
                }
                catch (error) {
                    return {
                        ok: false,
                        error: {
                            code: error instanceof connectionProtocol_1.TerminalConnectionError && error.code === 'terminal-not-live'
                                ? 'DEVICE_TERMINAL_NOT_RUNNING'
                                : error instanceof connectionProtocol_1.TerminalConnectionError && error.code === 'owner-changed'
                                    ? 'DEVICE_GENERATION_MISMATCH'
                                    : 'DEVICE_INTERNAL',
                            message: error instanceof Error ? error.message : 'Could not open the mirror.',
                        },
                    };
                }
            };
            socket.on('auth:handshake', (payload, ack) => {
                const respond = (r) => {
                    if (typeof ack === 'function')
                        ack(r);
                };
                if (data.authenticated) {
                    this.audit('auth:repeat-denied', data.deviceId, {});
                    respond({ ok: false, error: { code: 'DEVICE_PAIRING_INVALID', message: 'This connection is already authenticated.' } });
                    socket.disconnect(true);
                    return;
                }
                const { deviceId, timestamp, proof, protocolVersion } = payload || {};
                if (!deviceId || !timestamp || !proof) {
                    respond({ ok: false, error: { code: 'DEVICE_PAIRING_INVALID', message: 'Malformed handshake.' } });
                    return;
                }
                if (protocolVersion !== protocol_1.DEVICE_PROTOCOL_VERSION) {
                    respond({ ok: false, error: { code: 'DEVICE_PROTOCOL_MISMATCH', message: 'Incompatible protocol version.' } });
                    socket.disconnect(true);
                    return;
                }
                const peer = this.peerStore.get(deviceId);
                if (!peer) {
                    respond({ ok: false, error: { code: 'DEVICE_NOT_PAIRED', message: 'Unknown device.' } });
                    socket.disconnect(true);
                    return;
                }
                if (peer.confirmedAt === null) {
                    // Not an attack: the human here simply hasn't confirmed yet.
                    respond({ ok: false, error: { code: 'DEVICE_NOT_CONFIRMED', message: 'Awaiting fingerprint confirmation on this machine.' } });
                    return;
                }
                if (!(0, pairingCrypto_1.verifyDeviceProof)(peer.authKey, data.challenge, deviceId, timestamp, proof)) {
                    this.audit('auth:denied', deviceId, {});
                    respond({ ok: false, error: { code: 'DEVICE_PAIRING_INVALID', message: 'Invalid proof.' } });
                    socket.disconnect(true);
                    return;
                }
                data.authenticated = true;
                data.deviceId = deviceId;
                data.encryptKey = peer.encryptKey;
                data.inboundSequence = 0;
                data.outboundSequence = 0;
                this.peerStore.updateLastSeen(deviceId);
                this.audit('auth:success', deviceId, {});
                respond({ ok: true });
                this.emitState();
            });
            socket.on('device:rpc', async (envelope, ack) => {
                if (!data.authenticated || !data.deviceId || !data.encryptKey || typeof ack !== 'function') {
                    socket.disconnect(true);
                    return;
                }
                const identity = this.identityStore.get();
                if (!identity) {
                    socket.disconnect(true);
                    return;
                }
                let request;
                try {
                    request = (0, transportCrypto_1.openDevicePayload)(data.encryptKey, envelope, {
                        fromDeviceId: data.deviceId,
                        toDeviceId: identity.deviceId,
                        channel: 'rpc',
                        sessionChallenge: data.challenge,
                    }, ++data.inboundSequence);
                }
                catch {
                    this.audit('transport:replay-denied', data.deviceId, {});
                    socket.disconnect(true);
                    return;
                }
                let response;
                try {
                    let payload;
                    if (!request.operationId || typeof request.operationId !== 'string') {
                        payload = { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'A stable operation id is required.' } };
                    }
                    else if (request.event === 'terminal:subscribe') {
                        payload = await subscribeMirror(request.payload);
                    }
                    else if (request.event === 'terminal:ack-v2') {
                        const frame = request.payload;
                        const subscription = frame.connectionId
                            ? outputSubscriptions.get(frame.connectionId)
                            : undefined;
                        const owner = this.identityStore.get();
                        if (!subscription || !owner || !this.deps.terminalConnectionService ||
                            !frame.connectionId || !frame.frameId || !Number.isSafeInteger(frame.syncGeneration)) {
                            payload = { ok: false, error: { code: 'DEVICE_GENERATION_MISMATCH', message: 'Peer terminal frame is stale.' } };
                        }
                        else {
                            const principal = {
                                origin: 'peer-device',
                                subjectId: data.deviceId,
                                owningDeviceId: owner.deviceId,
                                permissions: new Set(['read']),
                            };
                            payload = {
                                ok: this.deps.terminalConnectionService.ack(frame.connectionId, frame.syncGeneration, frame.frameId, principal),
                            };
                        }
                    }
                    else if (request.event === 'terminal:resync-v2') {
                        const frame = request.payload;
                        const subscription = frame.connectionId
                            ? outputSubscriptions.get(frame.connectionId)
                            : undefined;
                        const owner = this.identityStore.get();
                        if (!subscription || !owner || !this.deps.terminalConnectionService || !frame.connectionId) {
                            payload = { ok: false, error: { code: 'DEVICE_GENERATION_MISMATCH', message: 'Peer terminal connection is stale.' } };
                        }
                        else {
                            const principal = {
                                origin: 'peer-device',
                                subjectId: data.deviceId,
                                owningDeviceId: owner.deviceId,
                                permissions: new Set(['read']),
                            };
                            payload = {
                                ok: true,
                                attach: await this.deps.terminalConnectionService.resync(frame.connectionId, principal),
                            };
                        }
                    }
                    else if (request.event === 'terminal:visibility-v2') {
                        const frame = request.payload;
                        const subscription = frame.connectionId
                            ? outputSubscriptions.get(frame.connectionId)
                            : undefined;
                        const owner = this.identityStore.get();
                        if (!subscription || !owner || !this.deps.terminalConnectionService ||
                            !frame.connectionId || typeof frame.visible !== 'boolean') {
                            payload = { ok: false, error: { code: 'DEVICE_GENERATION_MISMATCH', message: 'Peer terminal connection is stale.' } };
                        }
                        else {
                            const principal = {
                                origin: 'peer-device',
                                subjectId: data.deviceId,
                                owningDeviceId: owner.deviceId,
                                permissions: new Set(['read']),
                            };
                            payload = {
                                ok: true,
                                ...this.deps.terminalConnectionService.setVisibility(frame.connectionId, frame.visible, principal),
                            };
                        }
                    }
                    else if (request.event === 'terminal:unsubscribe') {
                        const connectionId = request.payload?.connectionId;
                        if (connectionId)
                            stopMirror(connectionId);
                        payload = connectionId
                            ? { ok: true }
                            : { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Missing connection id.' } };
                    }
                    else {
                        payload = await this.handleSecureRpc(data.deviceId, request.event, request.payload, request.operationId);
                    }
                    response = { ok: true, payload };
                }
                catch (error) {
                    response = {
                        ok: false,
                        error: {
                            code: 'DEVICE_INTERNAL',
                            message: error instanceof Error ? error.message : 'Peer operation failed.',
                        },
                    };
                }
                ack((0, transportCrypto_1.sealDevicePayload)(data.encryptKey, ++data.outboundSequence, {
                    fromDeviceId: identity.deviceId,
                    toDeviceId: data.deviceId,
                    channel: 'ack',
                    sessionChallenge: data.challenge,
                }, response));
            });
            socket.on('disconnect', () => {
                for (const connectionId of [...outputSubscriptions.keys()])
                    stopMirror(connectionId);
                if (data.authenticated)
                    this.emitState();
            });
        });
    }
    async handleSecureRpc(peerDeviceId, event, payload, operationId) {
        const peer = this.peerStore.get(peerDeviceId);
        if (!peer || peer.confirmedAt === null) {
            return { ok: false, error: { code: 'DEVICE_NOT_CONFIRMED', message: 'Peer record missing or unconfirmed.' } };
        }
        if (!operationId || typeof operationId !== 'string') {
            return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'A stable operation id is required.' } };
        }
        if (event === 'catalog:snapshot') {
            if (!(0, identity_1.hasDeviceGrant)(peer.grants, 'catalog')) {
                return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'This machine does not grant catalog access to that device.' } };
            }
            const identity = this.identityStore.get();
            if (!identity) {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'No local device identity.' } };
            }
            try {
                const snapshot = (0, catalogService_1.buildCatalogSnapshot)({ selfDeviceId: identity.deviceId, ...this.deps.getCatalogSources() }, peer.grants);
                this.audit('catalog:served', peerDeviceId, { terminals: snapshot.terminals.length });
                const result = { ok: true, snapshot };
                return result;
            }
            catch {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Failed to build catalog.' } };
            }
        }
        if (event === 'memory:search' || event === 'memory:read-entry' || event === 'memory:write-entry') {
            if (!(0, identity_1.hasDeviceGrant)(peer.grants, 'memoryRead')) {
                return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'This machine does not share its memories with that device.' } };
            }
            if (event === 'memory:search') {
                try {
                    const result = (await this.deps.searchLocalMemory?.((payload ?? {}))) ?? { entries: [], total: 0 };
                    this.audit('memory:search', peerDeviceId, { total: result.total });
                    const ack = { ok: true, result };
                    return ack;
                }
                catch {
                    return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Memory scan failed.' } };
                }
            }
            if (event === 'memory:read-entry') {
                const request = payload;
                if (!request?.filePath) {
                    return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Missing filePath.' } };
                }
                try {
                    const entry = (await this.deps.readLocalMemoryEntry?.(request.filePath)) ?? null;
                    this.audit('memory:read', peerDeviceId, { found: entry !== null });
                    const ack = { ok: true, entry };
                    return ack;
                }
                catch {
                    return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Memory read failed.' } };
                }
            }
            if (!(0, identity_1.hasDeviceGrant)(peer.grants, 'memoryWrite')) {
                return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'This machine does not allow that device to edit its memories.' } };
            }
            const request = payload;
            if (!request?.filePath || typeof request.content !== 'string') {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Missing filePath or content.' } };
            }
            try {
                const ok = (await this.deps.writeLocalMemoryEntry?.(request.filePath, request.content)) ?? false;
                this.audit('memory:write', peerDeviceId, { ok });
                return ok
                    ? { ok: true }
                    : { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Write rejected.' } };
            }
            catch {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Memory write failed.' } };
            }
        }
        if (event === 'terminal:submit') {
            const request = payload;
            const resolved = request?.terminalId
                ? this.deps.resolveLocalTerminal?.(request.terminalId) ?? null
                : null;
            const verdict = (0, submitPolicy_1.authorizeTerminalSubmit)({ peer, resolved, text: request?.text });
            if (!verdict.ok)
                return { ok: false, error: verdict.error };
            if (request.operationId !== operationId || !request.terminalGeneration ||
                request.terminalGeneration !== resolved?.terminalGeneration) {
                return { ok: false, error: { code: 'DEVICE_GENERATION_MISMATCH', message: 'The target terminal was restarted. Refresh it before sending.' } };
            }
            if (!(0, identity_1.projectInGrantScope)(peer.grants, resolved.projectId)) {
                return { ok: false, error: { code: 'DEVICE_PROJECT_OUT_OF_SCOPE', message: 'The target project is outside this peer grant.' } };
            }
            const registry = this.deps.getLinkRegistry?.();
            if (!registry) {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'The accepted prompt delivery service is unavailable.' } };
            }
            const result = await registry.submitFederatedDirect({
                operationId,
                terminalId: request.terminalId,
                terminalGeneration: request.terminalGeneration,
                body: request.text,
            });
            this.audit(result.ok ? 'terminal:submit-accepted' : 'terminal:submit-denied', peerDeviceId, {
                terminalId: request.terminalId,
                ...(result.ok ? { deliveredAt: result.deliveredAt } : { code: result.error.code }),
            });
            return result.ok ? { ok: true } : result;
        }
        if (event === 'endpoint:update') {
            const request = payload;
            if (request.operationId !== operationId || !Array.isArray(request.urls) || request.urls.length > 12) {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Malformed endpoint advertisement.' } };
            }
            const urls = request.urls.filter(endpoints_1.isSafeAdvertisedEndpoint);
            if (urls.length !== request.urls.length || urls.length === 0) {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Endpoint advertisement contained an unsafe route.' } };
            }
            this.peerStore.replaceEndpoints(peerDeviceId, (0, endpoints_1.endpointsFromUrls)(urls));
            this.audit('endpoint:updated', peerDeviceId, { count: urls.length });
            this.emitState();
            return { ok: true };
        }
        const registry = this.deps.getLinkRegistry?.();
        if (event === 'orchestration:admit') {
            const request = payload;
            if (!peer.grants.orchestrationWrite) {
                return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'Enable Orchestration for this peer in Settings → Devices.' } };
            }
            if (!request?.to || !(0, identity_1.projectInGrantScope)(peer.grants, request.to.projectId)) {
                return { ok: false, error: { code: 'DEVICE_PROJECT_OUT_OF_SCOPE', message: 'The target project is outside this peer grant.' } };
            }
            if (!registry || request.operationId !== operationId) {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Orchestration registry is unavailable or the operation id changed.' } };
            }
            const result = registry.admitFederatedLink({
                operationId,
                linkId: request.linkId,
                originDeviceId: peerDeviceId,
                originDeviceName: request.originDeviceName || peer.displayName,
                from: request.from,
                to: request.to,
            });
            if (!result.ok)
                return result;
            this.audit('orchestration:admit', peerDeviceId, { linkId: request.linkId, admissionId: result.admission.admissionId });
            const ack = {
                ok: true,
                admissionId: result.admission.admissionId,
                acceptedAt: result.admission.createdAt,
            };
            return ack;
        }
        if (event === 'orchestration:deliver') {
            const request = payload;
            if (!peer.grants.orchestrationWrite) {
                return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'This machine no longer admits orchestration writes from that peer.' } };
            }
            if (!request?.to || !(0, identity_1.projectInGrantScope)(peer.grants, request.to.projectId)) {
                return { ok: false, error: { code: 'DEVICE_PROJECT_OUT_OF_SCOPE', message: 'The target project is outside this peer grant.' } };
            }
            if (!registry || request.operationId !== operationId) {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Orchestration registry is unavailable or the operation id changed.' } };
            }
            const result = await registry.deliverFederatedMessage({
                ...request,
                originDeviceId: peerDeviceId,
            });
            this.audit(result.ok ? 'orchestration:delivered' : 'orchestration:delivery-denied', peerDeviceId, {
                linkId: request.linkId,
                messageId: request.messageId,
                ...(result.ok ? {} : { code: result.error.code }),
            });
            return result;
        }
        if (event === 'orchestration:reply') {
            const request = payload;
            const authorization = (0, replyPolicy_1.authorizeFederatedReply)({
                links: this.linkStore.getAll(),
                messages: this.linkStore.listMessages(),
                peerDeviceId,
                request,
            });
            if (!authorization.ok)
                return authorization;
            const { link } = authorization;
            if (!registry || request.operationId !== operationId) {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Orchestration registry is unavailable or the operation id changed.' } };
            }
            const result = await registry.deliverFederatedReply({
                operationId,
                linkId: link.linkId,
                messageId: request.messageId,
                originDeviceId: peerDeviceId,
                from: request.from,
                toTerminalId: link.from.terminalId,
                toTerminalGeneration: link.from.terminalGeneration,
                body: request.body,
                replyToken: request.replyToken,
            });
            if (result.ok) {
                this.linkStore.updateMessage(request.originalMessageId, { state: 'answered', answeredAt: result.deliveredAt });
                this.emitState();
            }
            this.audit(result.ok ? 'orchestration:reply-delivered' : 'orchestration:reply-denied', peerDeviceId, {
                linkId: request.linkId,
                messageId: request.messageId,
            });
            return result;
        }
        if (event === 'resume:list') {
            if (!peer.grants.catalog) {
                return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'This machine does not share its session catalog with that peer.' } };
            }
            const sessions = await this.localResumeSessions(peer.grants);
            this.audit('resume:list', peerDeviceId, { count: sessions.length });
            const result = { ok: true, sessions };
            return result;
        }
        if (event === 'resume:start') {
            const request = payload;
            if (!(0, identity_1.hasDeviceGrant)(peer.grants, 'terminalLaunch')) {
                return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'Enable "Start terminals" for this peer before it can resume sessions.' } };
            }
            if (request?.operationId !== operationId || !request.sessionId || !request.projectId) {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Malformed peer resume request.' } };
            }
            if (!(0, identity_1.projectInGrantScope)(peer.grants, request.projectId)) {
                return { ok: false, error: { code: 'DEVICE_PROJECT_OUT_OF_SCOPE', message: 'That session project is outside this peer grant.' } };
            }
            const all = (await this.deps.scanLocalResumeSessions?.()) ?? [];
            const project = this.deps.getCatalogSources().getProjects().find((row) => row.id === request.projectId);
            const found = project
                ? all.find((row) => row.id === request.sessionId && ownerPathsMatch(row.projectPath || row.cwd, project.rootPath))
                : undefined;
            if (!found || !project) {
                return { ok: false, error: { code: 'DEVICE_SESSION_NOT_FOUND', message: 'That session no longer belongs to the selected project on this machine.' } };
            }
            const created = await this.deps.resumeLocalSession?.(found, project.id, operationId);
            if (!created?.ok || !created.terminalId) {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: created?.error ?? 'The desktop could not create the resume terminal.' } };
            }
            const createdTerminalId = created.terminalId;
            await waitFor(() => Boolean(this.deps.resolveLocalTerminal?.(createdTerminalId)?.terminalGeneration), 15_000);
            const resolved = this.deps.resolveLocalTerminal?.(createdTerminalId) ?? null;
            const identity = this.identityStore.get();
            if (!identity || !resolved?.terminalGeneration) {
                return { ok: false, error: { code: 'DEVICE_TERMINAL_NOT_RUNNING', message: 'The resume terminal was created but its PTY did not start.' } };
            }
            const result = {
                ok: true,
                terminal: {
                    deviceId: identity.deviceId,
                    deviceName: identity.displayName,
                    terminalId: createdTerminalId,
                    terminalGeneration: resolved.terminalGeneration,
                    projectId: project.id,
                    projectName: project.name,
                    name: resolved.name ?? found.sessionName ?? `${found.agentType} resume`,
                    agentType: resolved.agentType ?? found.agentType,
                },
            };
            this.audit('resume:start', peerDeviceId, { projectId: project.id, terminalId: createdTerminalId });
            return result;
        }
        if (event === 'team:start') {
            const request = payload;
            const controller = this.deps.getTeamController?.();
            if (!peer.grants.orchestrationWrite) {
                return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'Enable Orchestration for this peer before assigning Team members.' } };
            }
            if (!request?.member || request.operationId !== operationId || !request.projectId || request.member.projectId !== request.projectId) {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Malformed peer Team start request.' } };
            }
            if (!(0, identity_1.projectInGrantScope)(peer.grants, request.projectId)) {
                return { ok: false, error: { code: 'DEVICE_PROJECT_OUT_OF_SCOPE', message: 'That Team project is outside this peer grant.' } };
            }
            if (!controller) {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'The owner-side Team controller is unavailable.' } };
            }
            if (request.member.deviceId || request.member.terminalId || request.member.startupPresetId) {
                return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'A peer Team request cannot re-delegate or adopt an unbound owner terminal.' } };
            }
            const explicitlyHeadless = request.member.substrate === 'headless' || request.member.runtimePreference === 'headless';
            if (explicitlyHeadless && !peer.grants.headlessRun) {
                return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'Enable Headless runs for this peer before routing this member headlessly.' } };
            }
            // With no headless grant, an auto request is constrained to the native
            // terminal controller. This is still execution on the selected peer;
            // it cannot silently select the owner's configured headless preference.
            const member = {
                ...request.member,
                deviceId: undefined,
                deviceName: undefined,
                ...(!peer.grants.headlessRun && request.member.runtimePreference !== 'structured'
                    ? { runtimePreference: 'native-terminal' }
                    : {}),
            };
            const principal = {
                terminalId: `device:${peerDeviceId}`,
                projectId: request.projectId,
                kind: 'host',
                depth: 0,
            };
            const started = await controller.startTeam(principal, {
                clientRequestId: `device:${peerDeviceId}:${operationId}`,
                members: [member],
            });
            const team = started.orchestration?.topology === 'team' ? started.orchestration : undefined;
            const ownerMember = team?.members[0];
            const ownerRun = started.runs?.find((row) => row.memberId === ownerMember?.id);
            if (!started.ok || !team || !ownerMember || !ownerRun) {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: started.error ?? 'The owner controller refused the Team member.' } };
            }
            this.audit('team:start', peerDeviceId, { projectId: request.projectId, teamId: team.teamId, runId: ownerRun.runId });
            const result = {
                ok: true,
                teamId: team.teamId,
                memberId: ownerMember.id,
                runId: ownerRun.runId,
                ...(ownerMember.terminalId ? { terminalId: ownerMember.terminalId } : {}),
                member: ownerMember,
                run: ownerRun,
            };
            return result;
        }
        if (event === 'team:send') {
            const request = payload;
            const controller = this.deps.getTeamController?.();
            if (!peer.grants.orchestrationWrite) {
                return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'This peer no longer accepts Team messages.' } };
            }
            if (!controller || request?.operationId !== operationId || !request.projectId || !request.teamId || !request.memberId || typeof request.prompt !== 'string') {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Malformed peer Team message request.' } };
            }
            if (!(0, identity_1.projectInGrantScope)(peer.grants, request.projectId)) {
                return { ok: false, error: { code: 'DEVICE_PROJECT_OUT_OF_SCOPE', message: 'That Team project is outside this peer grant.' } };
            }
            const sent = await controller.sendTeamMessage({
                terminalId: `device:${peerDeviceId}`,
                projectId: request.projectId,
                kind: 'host',
            }, {
                teamId: request.teamId,
                toMemberId: request.memberId,
                clientSubmissionId: `device:${peerDeviceId}:${operationId}`,
                body: request.prompt,
                kind: 'follow-up',
            });
            const remoteRunId = sent.message?.destinationRunId;
            if (!sent.ok || !remoteRunId) {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: sent.error ?? 'The owner controller refused the Team message.' } };
            }
            this.audit('team:send', peerDeviceId, { teamId: request.teamId, runId: remoteRunId });
            const result = { ok: true, runId: remoteRunId };
            return result;
        }
        if (event === 'team:collect') {
            const request = payload;
            const controller = this.deps.getTeamController?.();
            if (!peer.grants.orchestrationWrite) {
                return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'This peer no longer exposes Team run receipts.' } };
            }
            if (!controller || request?.operationId !== operationId || !request.projectId || !request.teamId || !request.runId) {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Malformed peer Team collect request.' } };
            }
            if (!(0, identity_1.projectInGrantScope)(peer.grants, request.projectId)) {
                return { ok: false, error: { code: 'DEVICE_PROJECT_OUT_OF_SCOPE', message: 'That Team project is outside this peer grant.' } };
            }
            const collected = await controller.collectRun({
                terminalId: `device:${peerDeviceId}`,
                projectId: request.projectId,
                kind: 'host',
            }, request.runId, Math.min(Math.max(request.timeoutMs ?? 0, 0), 30_000));
            const result = { ok: true, result: collected };
            return result;
        }
        if (event === 'team:stop') {
            const request = payload;
            const controller = this.deps.getTeamController?.();
            if (!peer.grants.orchestrationWrite) {
                return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'This peer no longer accepts Team shutdown requests.' } };
            }
            if (!controller || request?.operationId !== operationId || !request.projectId || !request.teamId) {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Malformed peer Team stop request.' } };
            }
            if (!(0, identity_1.projectInGrantScope)(peer.grants, request.projectId)) {
                return { ok: false, error: { code: 'DEVICE_PROJECT_OUT_OF_SCOPE', message: 'That Team project is outside this peer grant.' } };
            }
            const stopped = await controller.stop({
                terminalId: `device:${peerDeviceId}`,
                projectId: request.projectId,
                kind: 'host',
            }, request.teamId, true);
            if (!stopped.ok) {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: stopped.error ?? 'Owner-side Team shutdown was not confirmed.' } };
            }
            this.audit('team:stop', peerDeviceId, { teamId: request.teamId });
            return { ok: true };
        }
        if (event === 'skill:apply') {
            const request = payload;
            if (!peer.grants.skillInstall) {
                return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'Enable Install orchestration skill for this peer in Settings → Devices.' } };
            }
            if (request?.operationId !== operationId || (request.targets !== undefined && !Array.isArray(request.targets))) {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Malformed peer skill apply request.' } };
            }
            if (!this.deps.applyLocalSkillPolicy) {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'The owner-side skill installer is unavailable.' } };
            }
            const result = await this.deps.applyLocalSkillPolicy({ targets: request.targets, policy: request.policy ?? null });
            this.audit(result.ok ? 'skill:applied' : 'skill:apply-failed', peerDeviceId, {
                targets: request.targets ?? ['all'],
                ...(result.ok ? { results: result.results.map((row) => ({ target: row.target, status: row.status })) } : { code: result.error.code }),
            });
            return result;
        }
        if (event === 'terminal:create') {
            const request = payload;
            if (!(0, identity_1.hasDeviceGrant)(peer.grants, 'terminalLaunch')) {
                return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'Enable "Start terminals" for this peer before it can create agents.' } };
            }
            if (request?.operationId !== operationId || !request.projectId || !request.agentType || request.startupPresetId) {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Malformed peer terminal create request.' } };
            }
            if (!(0, identity_1.projectInGrantScope)(peer.grants, request.projectId)) {
                return { ok: false, error: { code: 'DEVICE_PROJECT_OUT_OF_SCOPE', message: 'That terminal project is outside this peer grant.' } };
            }
            const project = this.deps.getCatalogSources().getProjects().find((row) => row.id === request.projectId);
            const cli = this.deps.getCatalogSources().listClis().find((row) => row.cliId === request.agentType && Boolean(row.selectedPath) && ['detected', 'override'].includes(row.state));
            if (!project || !cli || !this.deps.createLocalTerminalForPeer) {
                return { ok: false, error: { code: 'DEVICE_TERMINAL_NOT_AI', message: 'The requested project or AI CLI is not available on this machine.' } };
            }
            const created = await this.deps.createLocalTerminalForPeer({
                projectId: project.id,
                agentType: request.agentType,
                name: request.name,
                operationId,
            });
            if (!created.ok || !created.terminalId) {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: created.error ?? 'The owner could not create the terminal.' } };
            }
            const terminalId = created.terminalId;
            await waitFor(() => Boolean(this.deps.resolveLocalTerminal?.(terminalId)?.terminalGeneration), 15_000);
            const resolved = this.deps.resolveLocalTerminal?.(terminalId);
            const identity = this.identityStore.get();
            if (!identity || !resolved?.terminalGeneration || !resolved.isInteractiveAgent) {
                return { ok: false, error: { code: 'DEVICE_TERMINAL_NOT_RUNNING', message: 'The owner terminal record did not start an interactive AI PTY.' } };
            }
            const result = {
                ok: true,
                terminal: {
                    deviceId: identity.deviceId,
                    deviceName: identity.displayName,
                    terminalId,
                    terminalGeneration: resolved.terminalGeneration,
                    projectId: project.id,
                    projectName: project.name,
                    name: resolved.name ?? request.name ?? request.agentType,
                    agentType: resolved.agentType ?? request.agentType,
                },
            };
            this.audit('terminal:create', peerDeviceId, { projectId: project.id, terminalId });
            return result;
        }
        return { ok: false, error: { code: 'DEVICE_INTERNAL', message: `Unsupported peer operation: ${event}` } };
    }
    async localResumeSessions(grant) {
        const sessions = (await this.deps.scanLocalResumeSessions?.()) ?? [];
        const projects = this.deps.getCatalogSources().getProjects();
        const result = [];
        for (const session of sessions) {
            const project = projects.find((row) => (0, identity_1.projectInGrantScope)(grant, row.id) && ownerPathsMatch(session.projectPath || session.cwd, row.rootPath));
            if (!project)
                continue;
            result.push({
                sessionId: session.id,
                agentType: session.agentType,
                title: (session.sessionName || `${session.agentType} session`).slice(0, 200),
                projectId: project.id,
                projectName: project.name,
                updatedAt: session.lastActivityAt,
            });
            if (result.length >= 100)
                break;
        }
        return result;
    }
    /**
     * Outbound sessions for every confirmed peer. The endpoint is chosen by
     * probing the peer's advertised addresses (LAN, Tailscale, WireGuard…) —
     * whichever answers wins, and the winner is remembered so the next connect
     * starts there.
     */
    async ensureSessions() {
        for (const peer of this.peerStore.getConfirmed()) {
            if (this.sessions.has(peer.deviceId) || this.sessionStarting.has(peer.deviceId))
                continue;
            if (peer.endpoints.length === 0)
                continue;
            this.sessionStarting.add(peer.deviceId);
            try {
                const endpoint = await (0, endpoints_1.pickReachableEndpoint)(peer.endpoints);
                if (!endpoint)
                    continue; // stays offline; retried on the next call
                if (this.disposed || this.sessions.has(peer.deviceId))
                    continue;
                const session = new session_1.PeerSession({
                    url: endpoint.url,
                    selfDeviceId: this.identityStore.get()?.deviceId ?? '',
                    peerDeviceId: peer.deviceId,
                    authKey: peer.authKey,
                    encryptKey: peer.encryptKey,
                    onStatusChange: () => {
                        if (this.sessions.get(peer.deviceId)?.isOnline()) {
                            this.peerStore.updateLastSeen(peer.deviceId);
                            this.peerStore.updateEndpointSuccess(peer.deviceId, endpoint.url);
                            // Offline is the one quarantine reason that self-heals.
                            this.linkStore.reactivateDevice(peer.deviceId);
                        }
                        else {
                            this.linkStore.quarantineDevice(peer.deviceId, 'peer-offline');
                        }
                        this.emitState();
                    },
                });
                this.sessions.set(peer.deviceId, session);
            }
            finally {
                this.sessionStarting.delete(peer.deviceId);
            }
        }
    }
    stopServerIfIdle() {
        if (!this.server)
            return;
        if (this.peerStore.count() > 0)
            return;
        if ((0, pairingCrypto_1.isPairingSessionValid)(this.pairingSession))
            return;
        if (this.relayTunnel.isRunning())
            void this.relayTunnel.stop();
        const handle = this.server;
        this.server = null;
        void handle.close();
    }
    /* ------------------------------------------------------------- misc */
    ensureIdentity() {
        return this.identityStore.ensure({
            displayName: os_1.default.hostname().replace(/\.local$/i, ''),
            platform: process.platform,
            appVersion: this.deps.appVersion,
        });
    }
    parsePairCode(code) {
        const trimmed = (code || '').trim();
        if (!trimmed.startsWith(protocol_1.DEVICE_PAIR_CODE_PREFIX))
            return null;
        try {
            const json = Buffer.from(trimmed.slice(protocol_1.DEVICE_PAIR_CODE_PREFIX.length), 'base64url').toString('utf8');
            const payload = JSON.parse(json);
            if (typeof payload?.u !== 'string' || typeof payload?.s !== 'string' || typeof payload?.k !== 'string')
                return null;
            return payload;
        }
        catch {
            return null;
        }
    }
    /** Append-only audit trail (plan §12), parallel to the remote audit log. */
    audit(event, deviceId, details) {
        try {
            const line = JSON.stringify({ ts: Date.now(), event, deviceId, details }) + '\n';
            fs_1.default.appendFile(path_1.default.join(this.deps.userDataPath, 'device-audit.jsonl'), line, () => { });
        }
        catch {
            // Audit must never break the feature.
        }
    }
    async dispose() {
        this.disposed = true;
        this.mirrors.clear();
        for (const [, session] of this.sessions)
            session.dispose();
        this.sessions.clear();
        // dispose() is called from app quit without an awaitable Electron barrier;
        // use the synchronous fast path so no public tunnel can outlive the app.
        this.relayTunnel.killChildSync();
        if (this.server) {
            const handle = this.server;
            this.server = null;
            await handle.close();
        }
    }
}
exports.DeviceFederationService = DeviceFederationService;
function waitFor(check, timeoutMs, intervalMs = 250) {
    return new Promise((resolve) => {
        if (check())
            return resolve(true);
        const start = Date.now();
        const timer = setInterval(() => {
            if (check()) {
                clearInterval(timer);
                resolve(true);
            }
            else if (Date.now() - start > timeoutMs) {
                clearInterval(timer);
                resolve(false);
            }
        }, intervalMs);
    });
}
function ownerPathsMatch(left, right) {
    if (!left || !right || left.includes('://') || right.includes('://'))
        return left === right;
    const normalize = (value) => {
        const resolved = path_1.default.resolve(value).replace(/[\\/]+$/, '');
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    return normalize(left) === normalize(right);
}
