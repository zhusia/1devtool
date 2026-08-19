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
exports.registerDeviceIpcHandlers = registerDeviceIpcHandlers;
/**
 * Multi-Control Device IPC. THE §4.1 GATE LIVES HERE:
 *
 * - `device:get-state` at zero peers answers from the on-disk gate check
 *   alone — no service construction, no store instantiation, no identity.
 * - The federation service module (socket.io, express, electron-store) is
 *   loaded via dynamic import only when device state already exists on disk
 *   (paired user relaunch) or the user starts/joins a pairing flow.
 * - Pairing is Pro-gated (product decision 2026-08-04). Maintenance of
 *   already-paired devices (confirm/revoke/grants/catalog) is never gated —
 *   an expired license must not hold existing pairings hostage.
 */
const electron_1 = require("electron");
const identity_1 = require("../../shared/device/identity");
const gate_1 = require("../device/gate");
const humanGesture_1 = require("../orchestration/humanGesture");
const rendererGuards_1 = require("./rendererGuards");
const PRO_ERROR = {
    code: 'DEVICE_PRO_REQUIRED',
    message: 'Pairing devices is a Pro feature. Activate a license in Settings → License.',
};
function registerDeviceIpcHandlers(deps) {
    let service = null;
    let servicePromise = null;
    const getOrCreateService = () => {
        if (service)
            return Promise.resolve(service);
        if (!servicePromise) {
            servicePromise = Promise.all([Promise.resolve().then(() => __importStar(require('../device/service'))), Promise.resolve().then(() => __importStar(require('../device/electronKv')))]).then(async ([mod, kvMod]) => {
                const created = new mod.DeviceFederationService({
                    userDataPath: electron_1.app.getPath('userData'),
                    appVersion: electron_1.app.getVersion(),
                    kvFactory: kvMod.createElectronKV,
                    getCatalogSources: deps.getCatalogSources,
                    sendToRenderer: deps.sendToRenderer,
                    terminalConnectionService: deps.terminalConnectionService,
                    resolveLocalTerminal: deps.resolveLocalTerminal,
                    searchLocalMemory: deps.searchLocalMemory,
                    readLocalMemoryEntry: deps.readLocalMemoryEntry,
                    writeLocalMemoryEntry: deps.writeLocalMemoryEntry,
                    getLocalTerminalBuffer: deps.getLocalTerminalBuffer,
                    subscribeLocalTerminalOutput: deps.subscribeLocalTerminalOutput,
                    getLinkRegistry: deps.getLinkRegistry,
                    getTeamController: deps.getTeamController,
                    scanLocalResumeSessions: deps.scanLocalResumeSessions,
                    resumeLocalSession: deps.resumeLocalSession,
                    applyLocalSkillPolicy: deps.applyLocalSkillPolicy,
                    createLocalTerminalForPeer: deps.createLocalTerminalForPeer,
                });
                await created.init();
                service = created;
                return created;
            });
        }
        return servicePromise;
    };
    const getExistingService = async () => {
        if (service)
            return service;
        if (servicePromise)
            return servicePromise;
        if (!(0, gate_1.isDeviceFederationMaterialized)(electron_1.app.getPath('userData')))
            return null;
        return getOrCreateService();
    };
    const { isMainRenderer } = (0, rendererGuards_1.createRendererGuards)(deps.getMainWindow);
    // Paired-user relaunch: bring the transport back up. Zero-peer machines
    // never reach this (gate false) and load nothing.
    if ((0, gate_1.isDeviceFederationMaterialized)(electron_1.app.getPath('userData'))) {
        void getOrCreateService().catch(() => {
            servicePromise = null;
        });
    }
    electron_1.ipcMain.handle('device:get-state', async () => {
        if (!service && !servicePromise && !(0, gate_1.isDeviceFederationMaterialized)(electron_1.app.getPath('userData'))) {
            return (0, identity_1.emptyDeviceFederationState)();
        }
        return (await getOrCreateService()).getState();
    });
    electron_1.ipcMain.handle('device:start-pairing', async () => {
        if (!deps.isProEntitled())
            return { ok: false, error: PRO_ERROR };
        const svc = await getOrCreateService();
        return { ok: true, state: await svc.startPairing() };
    });
    electron_1.ipcMain.handle('device:cancel-pairing', async () => {
        const svc = await getOrCreateService();
        return { ok: true, state: svc.cancelPairing() };
    });
    electron_1.ipcMain.handle('device:start-relay', async () => {
        if (!deps.isProEntitled())
            return { ok: false, error: PRO_ERROR };
        return (await getOrCreateService()).startRelay();
    });
    electron_1.ipcMain.handle('device:stop-relay', async () => {
        return { ok: true, state: await (await getOrCreateService()).stopRelay() };
    });
    electron_1.ipcMain.handle('device:join-pairing', async (_e, args) => {
        if (!deps.isProEntitled())
            return { ok: false, error: PRO_ERROR };
        const svc = await getOrCreateService();
        return svc.joinPairing(args?.code ?? '');
    });
    electron_1.ipcMain.handle('device:confirm-peer', async (_e, args) => {
        const svc = await getOrCreateService();
        return { ok: true, state: await svc.confirmPeer(args?.deviceId ?? '') };
    });
    electron_1.ipcMain.handle('device:revoke-peer', async (_e, args) => {
        const svc = await getOrCreateService();
        return { ok: true, state: svc.revokePeer(args?.deviceId ?? '') };
    });
    electron_1.ipcMain.handle('device:set-peer-grants', async (_e, args) => {
        const svc = await getOrCreateService();
        return { ok: true, state: svc.setPeerGrants(args?.deviceId ?? '', args?.grants) };
    });
    electron_1.ipcMain.handle('device:rename-self', async (_e, args) => {
        const svc = await getOrCreateService();
        return { ok: true, state: svc.renameSelf(args?.displayName ?? '') };
    });
    electron_1.ipcMain.handle('device:fetch-peer-catalog', async (_e, args) => {
        const svc = await getOrCreateService();
        return svc.fetchPeerCatalog(args?.deviceId ?? '');
    });
    electron_1.ipcMain.handle('device:list-peer-sessions', async (event, args) => {
        if (!isMainRenderer(event)) {
            return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'Untrusted renderer origin.' } };
        }
        return (await getOrCreateService()).listPeerResumeSessions(args?.deviceId ?? '');
    });
    electron_1.ipcMain.handle('device:resume-peer-session', async (event, args) => {
        if (!isMainRenderer(event)) {
            return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'Untrusted renderer origin.' } };
        }
        return (await getOrCreateService()).resumePeerSession(args?.deviceId ?? '', args?.sessionId ?? '', args?.projectId ?? '');
    });
    electron_1.ipcMain.handle('device:apply-skill', async (event, args) => {
        if (!isMainRenderer(event)) {
            return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'Untrusted renderer origin.' } };
        }
        return (await getOrCreateService()).applySkillOnPeer(args?.deviceId ?? '', {
            targets: args?.targets,
            policy: args?.policy ?? null,
        });
    });
    electron_1.ipcMain.handle('device:create-terminal', async (event, args) => {
        if (!isMainRenderer(event)) {
            return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'Untrusted renderer origin.' } };
        }
        return (await getOrCreateService()).createPeerTerminal({
            deviceId: args?.deviceId ?? '',
            projectId: args?.projectId ?? '',
            agentType: args?.agentType ?? '',
            name: args?.name,
        });
    });
    electron_1.ipcMain.handle('device:ensure-link', async (event, args) => {
        if (!isMainRenderer(event)) {
            return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'Untrusted renderer origin.' } };
        }
        const proven = (0, humanGesture_1.consumeHumanGesture)(args?.gestureToken ?? '', {
            focusedTerminalId: args?.fromTerminalId ?? '',
            projectId: args?.fromProjectId ?? '',
            draftHash: args?.draftHash ?? '',
        });
        if (!proven) {
            return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'A fresh desktop gesture is required to create this peer link.' } };
        }
        const svc = await getOrCreateService();
        return svc.ensureFederatedLink({
            fromTerminalId: args?.fromTerminalId ?? '',
            fromProjectId: args?.fromProjectId ?? '',
            to: args.to,
        });
    });
    electron_1.ipcMain.handle('device:send-link-message', async (event, args) => {
        if (!isMainRenderer(event)) {
            return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'Untrusted renderer origin.' } };
        }
        const svc = await getOrCreateService();
        return svc.sendFederatedMessage({
            fromTerminalId: args?.fromTerminalId ?? '',
            to: args?.to,
            body: args?.body ?? '',
        });
    });
    electron_1.ipcMain.handle('device:remove-link', async (_e, args) => {
        const svc = await getOrCreateService();
        return svc.removeFederatedLink(args?.linkId ?? '');
    });
    electron_1.ipcMain.handle('device:memory-search', async (_e, args) => {
        const svc = await getOrCreateService();
        return svc.searchPeerMemory(args?.deviceId ?? '', {
            query: args?.query,
            projectPath: args?.projectPath,
            agentType: args?.agentType,
        });
    });
    electron_1.ipcMain.handle('device:memory-read', async (_e, args) => {
        const svc = await getOrCreateService();
        return svc.readPeerMemoryEntry(args?.deviceId ?? '', args?.filePath ?? '');
    });
    electron_1.ipcMain.handle('device:memory-write', async (_e, args) => {
        const svc = await getOrCreateService();
        return svc.writePeerMemoryEntry(args?.deviceId ?? '', args?.filePath ?? '', args?.content ?? '');
    });
    electron_1.ipcMain.handle('device:mirror-start', async (_e, args) => {
        const svc = await getOrCreateService();
        return svc.startPeerMirror(args?.deviceId ?? '', args?.terminalId ?? '', args?.terminalGeneration);
    });
    electron_1.ipcMain.handle('device:mirror-stop', async (_e, args) => {
        const svc = await getOrCreateService();
        svc.stopPeerMirror(args?.deviceId ?? '', args?.terminalId ?? '');
        return { ok: true };
    });
    electron_1.ipcMain.handle('device:mirror-ack-v2', async (_e, args) => {
        const svc = await getOrCreateService();
        return svc.acknowledgePeerTerminalFrame(args?.deviceId ?? '', args?.connectionId ?? '', args?.syncGeneration ?? 0, args?.frameId ?? '');
    });
    electron_1.ipcMain.handle('device:mirror-resync-v2', async (_e, args) => {
        const svc = await getOrCreateService();
        return svc.resyncPeerTerminal(args?.deviceId ?? '', args?.connectionId ?? '');
    });
    electron_1.ipcMain.handle('device:submit-prompt', async (_e, args) => {
        // No gate short-circuit needed: a caller can only hold a peer deviceId if
        // pairing already materialized the service.
        const svc = await getOrCreateService();
        return svc.submitToPeerTerminal(args?.deviceId ?? '', args?.terminalId ?? '', args?.text ?? '', args?.terminalGeneration);
    });
    return {
        sendFederatedReply: async (input) => (await getOrCreateService()).sendFederatedReply(input),
        validatePeerTeamMember: async (input) => (await getOrCreateService()).validatePeerTeamMember(input),
        startPeerTeamMember: async (input) => (await getOrCreateService()).startPeerTeamMember(input),
        sendPeerTeamMember: async (input) => (await getOrCreateService()).sendPeerTeamMember(input),
        collectPeerTeamRun: async (input) => (await getOrCreateService()).collectPeerTeamRun(input),
        stopPeerTeam: async (input) => (await getOrCreateService()).stopPeerTeam(input),
        listPeerHosts: async () => (await getExistingService())?.listRemotePeerHosts() ?? [],
        fetchPeerCatalog: async (deviceId) => {
            const existing = await getExistingService();
            return existing
                ? existing.fetchPeerCatalog(deviceId)
                : { ok: false, error: { code: 'DEVICE_NOT_PAIRED', message: 'No peer devices are paired.' } };
        },
        subscribePeerTerminal: async (deviceId, terminalId, terminalGeneration, onData) => {
            const existing = await getExistingService();
            return existing
                ? existing.subscribeRemotePeerTerminal(deviceId, terminalId, terminalGeneration, onData)
                : { ok: false, error: { code: 'DEVICE_NOT_PAIRED', message: 'No peer devices are paired.' } };
        },
        unsubscribePeerTerminal: (deviceId, terminalId, onData) => {
            void getExistingService().then((existing) => {
                existing?.unsubscribeRemotePeerTerminal(deviceId, terminalId, onData);
            });
        },
        acknowledgePeerTerminalFrame: async (deviceId, connectionId, syncGeneration, frameId) => {
            const existing = await getExistingService();
            return existing
                ? existing.acknowledgePeerTerminalFrame(deviceId, connectionId, syncGeneration, frameId)
                : { ok: false, error: { code: 'DEVICE_NOT_PAIRED', message: 'No peer devices are paired.' } };
        },
        resyncPeerTerminal: async (deviceId, connectionId) => {
            const existing = await getExistingService();
            return existing
                ? existing.resyncPeerTerminal(deviceId, connectionId)
                : { ok: false, error: { code: 'DEVICE_NOT_PAIRED', message: 'No peer devices are paired.' } };
        },
        setPeerTerminalVisibility: async (deviceId, connectionId, visible) => {
            const existing = await getExistingService();
            return existing
                ? existing.setPeerTerminalVisibility(deviceId, connectionId, visible)
                : { ok: false, error: { code: 'DEVICE_NOT_PAIRED', message: 'No peer devices are paired.' } };
        },
        submitPeerPrompt: async (deviceId, terminalId, terminalGeneration, text) => {
            const existing = await getExistingService();
            return existing
                ? existing.submitToPeerTerminal(deviceId, terminalId, text, terminalGeneration)
                : { ok: false, error: { code: 'DEVICE_NOT_PAIRED', message: 'No peer devices are paired.' } };
        },
        disposeDeviceService: async () => {
            if (service) {
                await service.dispose();
                service = null;
                servicePromise = null;
            }
        },
    };
}
