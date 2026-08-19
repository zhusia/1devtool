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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerOrchestrationIpcHandlers = registerOrchestrationIpcHandlers;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const orchestrationPolicy_1 = require("../../shared/orchestrationPolicy");
const hierarchy_1 = require("../../shared/orchestration/hierarchy");
const hierarchyLevels_1 = require("../../shared/orchestration/hierarchyLevels");
const hierarchyPromptDirectives_1 = require("../../shared/orchestration/hierarchyPromptDirectives");
const hierarchyProvisioning_1 = require("../orchestration/hierarchyProvisioning");
const interactiveDelegation_1 = require("../../shared/interactiveDelegation");
const terminal_1 = require("../remote/handlers/terminal");
const hierarchyStartupPreset_1 = require("../orchestration/hierarchyStartupPreset");
const orchestrationRuns_1 = require("../../shared/orchestrationRuns");
const runExport_1 = require("../orchestration/runExport");
const currentLogExport_1 = require("../orchestration/currentLogExport");
const agentPaths_1 = require("../agentPaths");
const agentModelCatalog_1 = require("../orchestration/agentModelCatalog");
const install_1 = require("../orchestration/install");
const nativeHookInstall_1 = require("../orchestration/nativeHookInstall");
const runtimeConfig_1 = require("../orchestration/runtime/runtimeConfig");
const skillContent_1 = require("../orchestration/skillContent");
const skillContent_2 = require("../tasks/skillContent");
const rendererGuards_1 = require("./rendererGuards");
const shimInstall_1 = require("../orchestration/shimInstall");
const contextMeter_1 = require("../orchestration/contextMeter");
const contextSignals_1 = require("../orchestration/contextSignals");
const terminalLinks_1 = require("../../shared/orchestration/terminalLinks");
const linkNudge_1 = require("../orchestration/linkNudge");
const pipeline_1 = require("../../shared/orchestration/pipeline");
const linkReadAuthorization_1 = require("../orchestration/linkReadAuthorization");
const humanGesture_1 = require("../orchestration/humanGesture");
function registerOrchestrationIpcHandlers({ storeManager, skillsManager, orchestrationRunTracker, agentTeamController, harnessRegistry, cliRegistry, getLinkRegistry, getHierarchyActivations, getMainWindow, getInstallDependencies, sendToRenderer, getWorkspaceOperations, contextFooterTracker, getPtyBackend, }) {
    // SECURITY BOUNDARY — one definition, in ./rendererGuards.ts, shared with
    // Tasks (docs/tasks_v2.md §8.1a). This file used to carry a byte-identical
    // copy guarded by a drift test; the copy is gone and the guards are now
    // impossible to diverge. Do not re-inline them.
    const { isMainRenderer, hasMainRendererGesture } = (0, rendererGuards_1.createRendererGuards)(getMainWindow);
    const consumeReadAuthorization = (grant, subject) => Boolean(grant?.authorizationToken &&
        (0, linkReadAuthorization_1.consumeLinkReadAuthorization)(grant.authorizationToken, subject, grant.fingerprint));
    const rendererPrincipal = (orchestrationId) => {
        const item = agentTeamController?.listForRenderer().find((row) => row.topology === 'team' ? row.teamId === orchestrationId : row.swarmId === orchestrationId);
        return item
            ? { terminalId: item.hostTerminalId, projectId: item.projectId, kind: 'renderer-user' }
            : null;
    };
    // Read-only roster snapshot for UI filters (workspace_control 09-ui §7).
    // Human path: authorization is the main-renderer boundary + membership of
    // the caller-chosen project; no xterm mounts, pure store/controller reads.
    electron_1.ipcMain.handle('orchestration:list-workspace-roster', async (event, args) => {
        if (!isMainRenderer(event))
            throw new Error('WORKSPACE_FORBIDDEN: main renderer only');
        const operations = getWorkspaceOperations?.();
        if (!operations)
            throw new Error('Workspace operations are unavailable');
        return operations.listRoster(args.callerProjectId, args.workspaceId);
    });
    electron_1.ipcMain.handle('orchestration:list-active', async () => {
        await agentTeamController?.initialize();
        // Previous-run husks (every unit inert, nothing awaiting the user) are
        // auto-stopped so the dashboard only lists orchestrations that are alive.
        agentTeamController?.sweepInertOrchestrations();
        return agentTeamController?.listForRenderer() ?? [];
    });
    electron_1.ipcMain.handle('orchestration:get-runtime-config', () => (0, runtimeConfig_1.readOrchestrationRuntimeConfig)());
    electron_1.ipcMain.handle('orchestration:set-runtime-config', (_, args = {}) => {
        if (!args.config || typeof args.config !== 'object')
            return (0, runtimeConfig_1.readOrchestrationRuntimeConfig)();
        return (0, runtimeConfig_1.writeOrchestrationRuntimeConfig)(args.config);
    });
    electron_1.ipcMain.handle('orchestration:harnesses', () => harnessRegistry?.diagnostics() ?? []);
    electron_1.ipcMain.handle('orchestration:probe-harness', async (_, args = {}) => {
        if (!args.harnessId || !harnessRegistry?.get(args.harnessId))
            return { ok: false, error: 'Unknown harness' };
        try {
            return { ok: true, probe: await harnessRegistry.probe(args.harnessId, args.force === true) };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    electron_1.ipcMain.handle('orchestration:runtime-events', async (_, args = {}) => {
        if (!args.runId || !agentTeamController)
            return { ok: false, error: 'invalid runtime run id' };
        const item = agentTeamController.listForRenderer().find((row) => {
            const units = row.topology === 'team' ? row.members : row.workers;
            return units.some((unit) => unit.runIds.includes(args.runId));
        });
        if (!item)
            return { ok: false, error: 'runtime run not found' };
        const events = agentTeamController.runtimeEvents({ terminalId: item.hostTerminalId, projectId: item.projectId, kind: 'renderer-user' }, args.runId, args.epoch, args.afterSeq ?? 0);
        return events ? { ok: true, ...events } : { ok: false, error: 'runtime event stream is unavailable' };
    });
    electron_1.ipcMain.handle('orchestration:resolve-runtime-interaction', async (_, args = {}) => {
        if (!args.runId || !args.interactionId || !args.capabilityToken || !agentTeamController) {
            return { ok: false, error: 'invalid runtime interaction' };
        }
        const item = agentTeamController.listForRenderer().find((row) => {
            const units = row.topology === 'team' ? row.members : row.workers;
            return units.some((unit) => unit.runIds.includes(args.runId));
        });
        if (!item)
            return { ok: false, error: 'runtime run not found' };
        return agentTeamController.resolveRuntimeInteraction({ terminalId: item.hostTerminalId, projectId: item.projectId, kind: 'renderer-user' }, {
            runId: args.runId,
            interactionId: args.interactionId,
            capabilityToken: args.capabilityToken,
            decision: args.decision,
            answer: args.answer,
            answers: args.answers,
        });
    });
    electron_1.ipcMain.handle('orchestration:stop-active', async (_, args = {}) => {
        if (!args.orchestrationId || !agentTeamController)
            return { ok: false, error: 'invalid orchestration id' };
        const principal = rendererPrincipal(args.orchestrationId);
        if (!principal)
            return { ok: false, error: 'orchestration not found' };
        return agentTeamController.stop(principal, args.orchestrationId, args.closeTerminals === true, args.finishRunning === true);
    });
    electron_1.ipcMain.handle('orchestration:set-swarm-paused', async (_, args = {}) => {
        if (!args.swarmId || !agentTeamController || typeof args.paused !== 'boolean') {
            return { ok: false, error: 'invalid Swarm pause request' };
        }
        const principal = rendererPrincipal(args.swarmId);
        if (!principal)
            return { ok: false, error: 'Swarm not found' };
        return agentTeamController.setSwarmPaused(principal, args.swarmId, args.paused);
    });
    electron_1.ipcMain.handle('orchestration:confirm-submit', async (_, args = {}) => {
        if (!args.runId || !agentTeamController)
            return { ok: false, error: 'invalid run id' };
        const item = agentTeamController.listForRenderer().find((row) => {
            const units = row.topology === 'team' ? row.members : row.workers;
            return units.some((unit) => unit.runIds.includes(args.runId));
        });
        if (!item)
            return { ok: false, error: 'run not found' };
        return agentTeamController.confirmQueuedSubmit({ terminalId: item.hostTerminalId, projectId: item.projectId, kind: 'renderer-user' }, args.runId);
    });
    electron_1.ipcMain.handle('orchestration:team-send', async (_, args = {}) => {
        if (!args.teamId || !args.memberId || !args.submissionId || !args.prompt?.trim() || !agentTeamController) {
            return { ok: false, error: 'invalid Team message' };
        }
        const team = agentTeamController.listForRenderer().find((row) => row.topology === 'team' && row.teamId === args.teamId);
        if (!team || team.topology !== 'team')
            return { ok: false, error: 'Team not found' };
        return agentTeamController.send({ terminalId: team.hostTerminalId, projectId: team.projectId, kind: 'renderer-user' }, { teamId: team.teamId, memberId: args.memberId, submissionId: args.submissionId, prompt: args.prompt });
    });
    electron_1.ipcMain.handle('orchestration:team-messages', async (_, args = {}) => {
        if (!args.teamId || !agentTeamController)
            return { ok: false, error: 'invalid Team id' };
        const principal = rendererPrincipal(args.teamId);
        if (!principal)
            return { ok: false, error: 'Team not found' };
        const page = agentTeamController.teamMessages(principal, args.teamId, args.cursor ?? 0, args.limit ?? 50);
        return page ? { ok: true, ...page } : { ok: false, error: 'Team messages are unavailable' };
    });
    electron_1.ipcMain.handle('orchestration:team-connections', async (_, args = {}) => {
        if (!args.teamId || !agentTeamController)
            return { ok: false, error: 'invalid Team id' };
        const principal = rendererPrincipal(args.teamId);
        if (!principal)
            return { ok: false, error: 'Team not found' };
        const connections = agentTeamController.teamConnections(principal, args.teamId);
        return connections ? { ok: true, connections } : { ok: false, error: 'Team connections are unavailable' };
    });
    electron_1.ipcMain.handle('orchestration:set-team-connections', async (_, args = {}) => {
        if (!args.teamId || !Array.isArray(args.connections) || !agentTeamController) {
            return { ok: false, error: 'invalid Team connection graph' };
        }
        const principal = rendererPrincipal(args.teamId);
        if (!principal)
            return { ok: false, error: 'Team not found' };
        return agentTeamController.setTeamConnections(principal, args.teamId, args.connections);
    });
    electron_1.ipcMain.handle('orchestration:resume-team-member', async (_, args = {}) => {
        if (!args.teamId || !args.memberId || !agentTeamController)
            return { ok: false, error: 'invalid Team member' };
        const principal = rendererPrincipal(args.teamId);
        if (!principal)
            return { ok: false, error: 'Team not found' };
        return agentTeamController.resumeTeamMemberAutomation(principal, args.teamId, args.memberId);
    });
    electron_1.ipcMain.handle('orchestration:resolve-confirmation', async (_, args = {}) => {
        if (!args.runId || !agentTeamController || !['done', 'error', 'cancelled'].includes(args.outcome ?? '')) {
            return { ok: false, error: 'invalid confirmation' };
        }
        const item = agentTeamController.listForRenderer().find((row) => {
            const units = row.topology === 'team' ? row.members : row.workers;
            return units.some((unit) => unit.runIds.includes(args.runId));
        });
        if (!item)
            return { ok: false, error: 'run not found' };
        return agentTeamController.resolveConfirmation({ terminalId: item.hostTerminalId, projectId: item.projectId, kind: 'renderer-user' }, args.runId, args.outcome);
    });
    electron_1.ipcMain.handle('orchestration:resolve-fallback', async (_, args = {}) => {
        if (!args.runId || !agentTeamController || !['retry', 'headless', 'reassign', 'skip', 'close'].includes(args.action ?? '')) {
            return { ok: false, error: 'invalid fallback action' };
        }
        const item = agentTeamController.listForRenderer().find((row) => {
            const units = row.topology === 'team' ? row.members : row.workers;
            return units.some((unit) => unit.runIds.includes(args.runId));
        });
        if (!item)
            return { ok: false, error: 'run not found' };
        return agentTeamController.resolveFallback({ terminalId: item.hostTerminalId, projectId: item.projectId, kind: 'renderer-user' }, {
            runId: args.runId,
            action: args.action,
            ...(args.target ? { target: args.target } : {}),
        });
    });
    electron_1.ipcMain.handle('orchestration:promote-worker', async (_, args = {}) => {
        if (!args.swarmId || !args.workerId || !agentTeamController)
            return { ok: false, error: 'invalid worker promotion' };
        const swarm = agentTeamController.listForRenderer().find((row) => row.topology === 'swarm' && row.swarmId === args.swarmId);
        if (!swarm || swarm.topology !== 'swarm')
            return { ok: false, error: 'Swarm not found' };
        return agentTeamController.promoteSwarmWorker({ terminalId: swarm.hostTerminalId, projectId: swarm.projectId, kind: 'renderer-user' }, swarm.swarmId, args.workerId, 
        // Human-origin (Mission Control click) — revealing the promoted
        // terminal is the point. The agent bridge route stays background.
        { focusWindow: true });
    });
    // Settings → AI → Orchestration → Reinstall. Thin wrapper over the shared
    // install coordinator (§5) so Settings and the dashboard can't drift apart;
    // compiles the stored APPLIED policy, forced (bypasses dev-preserve).
    electron_1.ipcMain.handle('skills:install-orchestrator-globally', async () => {
        const appliedPolicy = storeManager.getPreferences().orchestration?.applied ?? null;
        const browserMcpSkill = skillsManager.installBrowserMcpSkillForCodex();
        const outcome = await (0, install_1.runOrchestrationInstall)(getInstallDependencies(), {
            policy: appliedPolicy,
            force: true,
        });
        return [
            {
                tool: '1devtool-agent',
                path: outcome.shim.shimPath,
                status: outcome.shim.status === 'skipped-dev-preserve' ? 'skipped-unchanged' : outcome.shim.status,
                ...(outcome.shim.error ? { error: outcome.shim.error } : {}),
            },
            browserMcpSkill,
            ...outcome.skills,
        ];
    });
    electron_1.ipcMain.handle('orchestration:get-shim-path', async () => {
        return (0, shimInstall_1.getOrchestratorShimPath)();
    });
    // --- Terminal Links (orchestration v4 L1/L4) -----------------------------
    // These channels are renderer-only by construction: bridge/CLI/Remote UI
    // callers have no route here, which is what makes a minted gesture a proof
    // of the human-origin class (v4 invariant 21).
    electron_1.ipcMain.handle('orchestration:mint-gesture', async (event, args = {}) => {
        if (!args.terminalId || !args.projectId || typeof args.draftHash !== 'string')
            return null;
        if (!await hasMainRendererGesture(event, args.terminalId))
            return null;
        const source = storeManager.findTerminalLocation(args.terminalId);
        if (!source || source.project.id !== args.projectId)
            return null;
        return (0, humanGesture_1.mintHumanGesture)({
            focusedTerminalId: args.terminalId,
            projectId: args.projectId,
            draftHash: args.draftHash,
        });
    });
    electron_1.ipcMain.handle('orchestration:ensure-link', async (event, args = {}) => {
        if (!isMainRenderer(event))
            return { ok: false, error: 'untrusted renderer origin' };
        const registry = getLinkRegistry?.();
        if (!registry)
            return { ok: false, error: 'Terminal links are unavailable' };
        if (!args.gestureToken || !args.projectId || !args.fromTerminalId || !args.toTerminalId || typeof args.draftHash !== 'string') {
            return { ok: false, error: 'invalid link request' };
        }
        const source = storeManager.findTerminalLocation(args.fromTerminalId);
        if (!source || source.project.id !== args.projectId) {
            return { ok: false, error: 'source terminal/project mismatch' };
        }
        const proven = (0, humanGesture_1.consumeHumanGesture)(args.gestureToken, {
            focusedTerminalId: args.fromTerminalId,
            projectId: args.projectId,
            draftHash: args.draftHash,
        });
        // Fail closed: without a valid gesture the send may still deliver a
        // one-shot delegation, but nothing durable is created.
        if (!proven)
            return { ok: false, error: 'human-gesture proof missing or expired' };
        // args.projectId binds the GESTURE (the host's project); the target may
        // live in another project — cross-project links are allowed (rev 5).
        const result = registry.ensureLink({
            fromTerminalId: args.fromTerminalId,
            toTerminalId: args.toTerminalId,
            createdBy: 'user-mention',
        });
        if (!result.ok)
            return result;
        // Reply edge, ALWAYS. Delegating work to a peer is itself the consent to
        // receive the answer — an outbound-only delegation edge is a dead end by
        // construction: the peer does the work, is told "you have no link back",
        // prints its result locally, and the host polls a receipt that says
        // `delivered` forever (docs/common-errors/orchestration/link-reply-never-returns.md).
        // This used to be gated on the user ALSO @-mentioning their own terminal,
        // which nobody does, so every real delegation stranded its own answer.
        // Both edges ride the one consumed gesture — the human proved intent once,
        // for this exact draft.
        const reverse = registry.ensureLink({
            fromTerminalId: args.toTerminalId,
            toTerminalId: args.fromTerminalId,
            createdBy: 'user-mention',
        });
        // Honest, not optimistic: `created` is false for an edge that already
        // existed, and the reverse can legitimately fail (peer no longer running).
        // The nudge must promise a reply command only when one will actually work.
        const canReplyBack = reverse.ok;
        // One notice into the peer, not two: the mutual form carries the inbound
        // fact AND the reply command.
        if (result.created || (reverse.ok && reverse.created)) {
            injectInboundNudge(result.link, canReplyBack);
        }
        return { ...result, reverse: canReplyBack };
    });
    // Inbound notice into the peer (L2). The outbound contract rides inside
    // the submitted prompt's send-time nudge (mention path) or `whoami`
    // discovery (explicit path). Best-effort: a busy peer fails the staged
    // submit and the link stands.
    const injectInboundNudge = (link, mutual = false) => {
        const from = storeManager.findTerminalLocation(link.from.terminalId);
        const to = storeManager.findTerminalLocation(link.to.terminalId);
        const registry = getLinkRegistry?.();
        if (!registry || !from || !to)
            return;
        const context = {
            link,
            fromTitle: from.terminal.name || from.terminal.agentType,
            toTitle: to.terminal.name || to.terminal.agentType,
            shimPath: (0, shimInstall_1.getOrchestratorShimPath)(),
        };
        const nudge = mutual ? (0, linkNudge_1.composeMutualLinkNudge)(context) : (0, linkNudge_1.composeInboundLinkNudge)(context);
        void registry.deliverNotice(link, `link-nudge-${link.linkId}`, nudge);
    };
    // Explicit link creation (v4 L5 map drag / context menus). Renderer-only
    // channel + an explicit in-UI confirmation = user-initiated origin
    // (invariant 21's 'user-explicit' class); agents still cannot reach this.
    electron_1.ipcMain.handle('orchestration:ensure-link-explicit', async (event, args = {}) => {
        if (!await hasMainRendererGesture(event)) {
            return { ok: false, error: 'human gesture required' };
        }
        const registry = getLinkRegistry?.();
        if (!registry)
            return { ok: false, error: 'Terminal links are unavailable' };
        if (!args.fromTerminalId || !args.toTerminalId)
            return { ok: false, error: 'invalid link request' };
        const result = registry.ensureLink({
            fromTerminalId: args.fromTerminalId,
            toTerminalId: args.toTerminalId,
            createdBy: 'user-explicit',
        });
        if (result.ok && result.created)
            injectInboundNudge(result.link);
        return result;
    });
    electron_1.ipcMain.handle('orchestration:update-link', async (event, args = {}) => {
        if (!args.linkId)
            return { ok: false, error: 'invalid link update' };
        // A preview click had live Chromium activation and minted this exact,
        // one-shot capability. It remains valid while the user reads the consent
        // dialogs; never let it authorize an unrelated delivery-mode edit.
        const readAuthorized = args.delivery === undefined &&
            Boolean(args.permissions?.some((permission) => permission.startsWith('read-'))) &&
            consumeReadAuthorization(args.readConsent, { kind: 'link', linkId: args.linkId });
        if (!readAuthorized && !await hasMainRendererGesture(event)) {
            return { ok: false, error: 'human gesture required' };
        }
        const registry = getLinkRegistry?.();
        if (!registry)
            return { ok: false, error: 'Terminal links are unavailable' };
        return registry.updateLink(args.linkId, {
            ...(args.permissions ? { permissions: args.permissions } : {}),
            ...(args.delivery ? { delivery: args.delivery } : {}),
            ...(args.readConsent ? { readConsent: args.readConsent } : {}),
        });
    });
    // Read-only closure preview. The returned fingerprint binds the exact
    // endpoint generations, permissions, closure, and graph revision; the
    // subsequent gesture-gated mutation recomputes and compares it.
    electron_1.ipcMain.handle('orchestration:preview-read-consent', async (event, args = {}) => {
        if (!await hasMainRendererGesture(event)) {
            return { ok: false, error: 'human gesture required' };
        }
        const registry = getLinkRegistry?.();
        if (!registry)
            return { ok: false, error: 'Terminal links are unavailable' };
        let result;
        if (args.linkId) {
            result = registry.previewReadConsent({
                kind: 'link',
                linkId: args.linkId,
                ...(args.permissions ? { permissions: args.permissions } : {}),
            });
        }
        else if (args.requestId) {
            result = registry.previewReadConsent({ kind: 'request', requestId: args.requestId });
        }
        else {
            return { ok: false, error: 'invalid read-consent preview' };
        }
        if (!result.ok)
            return result;
        return {
            ok: true,
            preview: {
                ...result.preview,
                authorizationToken: (0, linkReadAuthorization_1.mintLinkReadAuthorization)(result.preview.subject, result.preview.fingerprint),
            },
        };
    });
    // Agent requests are inspectable but inert until this gesture-gated
    // renderer decision creates the exact generation-bound edge.
    electron_1.ipcMain.handle('orchestration:list-link-requests', (event, args = {}) => {
        if (!isMainRenderer(event))
            return [];
        return getLinkRegistry?.()?.listLinkRequests(args.projectId) ?? [];
    });
    electron_1.ipcMain.handle('orchestration:resolve-link-request', async (event, args = {}) => {
        if (!args.requestId || typeof args.approve !== 'boolean') {
            return { ok: false, error: 'invalid link-request decision' };
        }
        const readAuthorized = args.approve &&
            consumeReadAuthorization(args.readConsent, {
                kind: 'request',
                requestId: args.requestId,
            });
        if (!readAuthorized && !await hasMainRendererGesture(event)) {
            return { ok: false, error: 'human gesture required' };
        }
        const registry = getLinkRegistry?.();
        if (!registry)
            return { ok: false, error: 'Terminal links are unavailable' };
        const result = registry.resolveLinkRequest(args.requestId, args.approve, args.readConsent);
        if (result.ok && result.link)
            injectInboundNudge(result.link);
        return result;
    });
    electron_1.ipcMain.handle('orchestration:resolve-link-message', async (event, args = {}) => {
        if (!await hasMainRendererGesture(event)) {
            return { ok: false, error: 'human gesture required' };
        }
        const registry = getLinkRegistry?.();
        if (!registry)
            return { ok: false, error: 'Terminal links are unavailable' };
        if (!args.messageId || typeof args.approve !== 'boolean') {
            return { ok: false, error: 'invalid queued-message decision' };
        }
        return args.approve
            ? registry.approveQueuedMessage(args.messageId)
            : registry.rejectQueuedMessage(args.messageId);
    });
    /**
     * Un-strand a delegation whose answer has nowhere to go (Mission Control's
     * "N stuck" repair).
     *
     * A message delivered while no reverse edge existed carries the envelope
     * "you have no link back … do not invent a send command". Minting the edge
     * afterwards fixes FUTURE messages but not that one — the peer is holding a
     * finished answer and believes there is no channel. So this does both: it
     * creates the reply edge, then types one notice into the PEER correcting the
     * fact it was told and handing it the exact `--reply-to` command.
     *
     * Everything is derived from main's own durable record; the renderer supplies
     * only an opaque messageId, and a message that is not delivered-and-unanswered
     * is refused (nothing to un-strand).
     */
    electron_1.ipcMain.handle('orchestration:restore-reply-link', async (event, args = {}) => {
        if (!await hasMainRendererGesture(event)) {
            return { ok: false, error: 'human gesture required' };
        }
        const registry = getLinkRegistry?.();
        if (!registry)
            return { ok: false, error: 'Terminal links are unavailable' };
        if (!args.messageId)
            return { ok: false, error: 'invalid repair request' };
        // Same call and same scope the renderer's roster uses (unfiltered, newest
        // 200), so a row the user can see is always a row main can resolve.
        const summary = registry.listMessageSummaries().find((row) => row.messageId === args.messageId);
        if (!summary)
            return { ok: false, error: 'message not found' };
        if (!(0, terminalLinks_1.isLinkMessageOutstanding)(summary)) {
            return { ok: false, error: 'message is not awaiting a reply' };
        }
        // The peer received it; the host sent it. The missing edge is peer → host.
        const reverse = registry.ensureLink({
            fromTerminalId: summary.toTerminalId,
            toTerminalId: summary.fromTerminalId,
            createdBy: 'user-explicit',
        });
        if (!reverse.ok)
            return reverse;
        // Notice rides the FORWARD edge, because that is the one pointing at the
        // peer. A peer relaunch quarantines the original forward link (endpoints
        // are spawn-bound), so "Re-start" re-mints it against the live endpoints —
        // without this, every post-relaunch repair ended "the peer could not be
        // told" and the button read as broken.
        let forward = registry
            .listLinks()
            .find((row) => row.state === 'active' &&
            row.from.terminalId === summary.fromTerminalId &&
            row.to.terminalId === summary.toTerminalId);
        if (!forward) {
            const reminted = registry.ensureLink({
                fromTerminalId: summary.fromTerminalId,
                toTerminalId: summary.toTerminalId,
                createdBy: 'user-explicit',
            });
            if (reminted.ok)
                forward = reminted.link;
        }
        if (!forward) {
            return { ok: true, linked: true, notified: false, error: 'reply link created, but the link to the peer could not be restored — the peer was not told' };
        }
        const host = storeManager.findTerminalLocation(summary.fromTerminalId);
        // Two peers, two truths: one still holds the delivered task in context and
        // only lacks the channel; the other relaunched since delivery and has
        // NOTHING in context — telling it to "send the answer you already have"
        // asks for an answer it cannot produce. The restart nudge re-states the
        // task itself (Mission Control's "Re-start").
        const restart = registry.messageRestartContext(summary.messageId);
        const nudgeInput = {
            hostTitle: host?.terminal.name || host?.terminal.agentType || 'the sender',
            hostTerminalId: summary.fromTerminalId,
            messageId: summary.messageId,
            shimPath: (0, shimInstall_1.getOrchestratorShimPath)(),
            ...(registry.replyTokenFor(summary.messageId) ? { replyToken: registry.replyTokenFor(summary.messageId) } : {}),
            recipientAgentKind: forward.to.effectiveAgentKind,
        };
        const notified = await registry.deliverNotice(forward, 
        // The unique-per-click rule from nudge-reply: a user who re-starts the
        // same stuck row again after ten minutes must not be dropped as an
        // already-used runId.
        `reply-path-${summary.messageId}-${Date.now()}`, restart && !restart.peerContextIntact
            ? (0, linkNudge_1.composeRestartDelegationNudge)({ ...nudgeInput, brief: restart.brief })
            : (0, linkNudge_1.composeReplyPathRestoredNudge)(nudgeInput));
        return { ok: true, linked: true, notified };
    });
    /**
     * Human-in-the-loop unblock for the OTHER field failure: the reply edge
     * exists, the peer finished the work — the verdict is sitting in its
     * scrollback — and it never ran `link send`, so the delegating terminal
     * waits forever on a receipt that says `delivered`. Nothing in the system
     * re-prompts a peer on its own; this click is that re-prompt. Refused when
     * no reply path exists — that is the stranded case and its repair
     * (restore-reply-link) also mints the missing edge.
     */
    electron_1.ipcMain.handle('orchestration:nudge-reply', async (event, args = {}) => {
        if (!await hasMainRendererGesture(event)) {
            return { ok: false, error: 'human gesture required' };
        }
        const registry = getLinkRegistry?.();
        if (!registry)
            return { ok: false, error: 'Terminal links are unavailable' };
        if (!args.messageId)
            return { ok: false, error: 'invalid nudge request' };
        const summary = registry.listMessageSummaries().find((row) => row.messageId === args.messageId);
        if (!summary)
            return { ok: false, error: 'message not found' };
        if (!(0, terminalLinks_1.isLinkMessageOutstanding)(summary)) {
            return { ok: false, error: 'message is not awaiting a reply' };
        }
        const links = registry.listLinks();
        const canReply = links.some((row) => row.state === 'active' &&
            row.permissions.includes('send') &&
            row.from.terminalId === summary.toTerminalId &&
            row.to.terminalId === summary.fromTerminalId);
        if (!canReply) {
            return { ok: false, error: 'the peer has no link back — use the "stuck" repair instead' };
        }
        // The notice rides the forward edge because that is the one pointing AT
        // the peer that owes the answer.
        const forward = links.find((row) => row.state === 'active' &&
            row.from.terminalId === summary.fromTerminalId &&
            row.to.terminalId === summary.toTerminalId);
        if (!forward)
            return { ok: false, error: 'no active link reaches the peer' };
        const host = storeManager.findTerminalLocation(summary.fromTerminalId);
        const notified = await registry.deliverNotice(forward, 
        // Unique per click: a reminder the user repeats after ten minutes must
        // not be dropped as an already-used runId.
        `reply-reminder-${summary.messageId}-${Date.now()}`, (0, linkNudge_1.composeReplyReminderNudge)({
            hostTitle: host?.terminal.name || host?.terminal.agentType || 'the sender',
            hostTerminalId: summary.fromTerminalId,
            messageId: summary.messageId,
            shimPath: (0, shimInstall_1.getOrchestratorShimPath)(),
            ...(registry.replyTokenFor(summary.messageId) ? { replyToken: registry.replyTokenFor(summary.messageId) } : {}),
            recipientAgentKind: forward.to.effectiveAgentKind,
            ...(hierarchyRoleLineFor(summary.toTerminalId)
                ? { roleLine: hierarchyRoleLineFor(summary.toTerminalId) }
                : {}),
        }));
        return { ok: true, notified };
    });
    /**
     * Stop waiting on a delegation, by explicit human decision.
     *
     * The counterpart to Remind: reminding assumes an answer is still coming,
     * and some rows are structurally never going to get one — the observed case
     * is a broadcast whose own body reads "final message — do NOT reply to this
     * one", which the peer correctly obeys while the row waits forever. Also
     * covers an answer the user already read in the peer's terminal and relayed
     * by hand, and work dropped when the plan changed.
     *
     * Nothing is delivered to any terminal, so this is not a delegation action —
     * but it IS gesture-gated all the same, because it edits durable state that
     * the delegating agent reads back through `link status`.
     */
    electron_1.ipcMain.handle('orchestration:close-message', async (event, args = {}) => {
        if (!await hasMainRendererGesture(event)) {
            return { ok: false, error: 'human gesture required' };
        }
        const registry = getLinkRegistry?.();
        if (!registry)
            return { ok: false, error: 'Terminal links are unavailable' };
        if (!args.messageId)
            return { ok: false, error: 'invalid request' };
        return registry.closeMessage(args.messageId);
    });
    /**
     * Resume an interrupted orchestration (Mission Control "Resume team").
     *
     * A restart (or closed terminals reopening) quarantines every link, and the
     * agents wake up with the pre-interruption facts still in context: hosts
     * keep polling a dead board, peers keep believing their channel is gone.
     * Repair therefore has two halves, and both are required:
     *
     *  1. Re-bind every revivable quarantined link touching this project to the
     *     terminals as they are NOW (same consent class as the per-row Relink —
     *     one gesture covers the batch).
     *  2. Deliver the correction. One notice per terminal, chosen by what that
     *     terminal is blocked on: peers owing replies get the exact `--reply-to`
     *     command (newest 3, oldest work is usually superseded); delegating
     *     terminals get the status-board wake-up; everyone else linked gets the
     *     standard inbound/mutual notice so the restored edge is a fact in
     *     their context, not just in ours.
     */
    electron_1.ipcMain.handle('orchestration:resume-orchestration', async (event, args = {}) => {
        if (!await hasMainRendererGesture(event)) {
            return { ok: false, error: 'human gesture required' };
        }
        const registry = getLinkRegistry?.();
        if (!registry)
            return { ok: false, error: 'Terminal links are unavailable' };
        if (!args.projectId)
            return { ok: false, error: 'invalid resume request' };
        const projectId = args.projectId;
        const touchesProject = (row) => row.projectId === projectId || row.from.projectId === projectId || row.to.projectId === projectId;
        let relinked = 0;
        for (const link of registry.listLinks().filter((row) => row.state === 'quarantined' && touchesProject(row))) {
            // Notices are sent once per terminal below, not per relinked edge — a
            // 3-terminal mesh is 6 edges and six near-identical nudges is a storm.
            const result = registry.relink(link.linkId);
            if (result.ok)
                relinked += 1;
        }
        // Hierarchy seats vacated by the same interruption re-bind under the same
        // gesture (§7.2) — the resume notices below then carry each seat's role
        // line, so a woken agent re-learns its place in the notice that unblocks it.
        const seatsRebound = resumeRebindHierarchySeats(projectId);
        const links = registry.listLinks();
        const activeSendEdge = (fromId, toId) => links.find((row) => row.state === 'active' &&
            row.permissions.includes('send') &&
            row.from.terminalId === fromId &&
            row.to.terminalId === toId);
        const shimPath = (0, shimInstall_1.getOrchestratorShimPath)();
        const open = registry.listMessageSummaries(projectId)
            .filter(terminalLinks_1.isLinkMessageOutstanding);
        const owedByTerminal = new Map();
        const awaitingByTerminal = new Map();
        for (const row of open) {
            const owed = owedByTerminal.get(row.toTerminalId) ?? [];
            owed.push(row);
            owedByTerminal.set(row.toTerminalId, owed);
            awaitingByTerminal.set(row.fromTerminalId, (awaitingByTerminal.get(row.fromTerminalId) ?? 0) + 1);
        }
        const participantIds = new Set();
        for (const row of links) {
            if (row.state !== 'active' || !touchesProject(row))
                continue;
            participantIds.add(row.from.terminalId);
            participantIds.add(row.to.terminalId);
        }
        let reminded = 0;
        let woken = 0;
        for (const terminalId of participantIds) {
            const owed = (owedByTerminal.get(terminalId) ?? [])
                .filter((row) => activeSendEdge(row.toTerminalId, row.fromTerminalId))
                .sort((a, b) => b.createdAt - a.createdAt)
                .slice(0, 3);
            if (owed.length > 0) {
                for (const row of owed) {
                    const forward = activeSendEdge(row.fromTerminalId, row.toTerminalId);
                    if (!forward)
                        continue;
                    const host = storeManager.findTerminalLocation(row.fromTerminalId);
                    const ok = await registry.deliverNotice(forward, `reply-reminder-${row.messageId}-${Date.now()}`, (0, linkNudge_1.composeReplyReminderNudge)({
                        hostTitle: host?.terminal.name || host?.terminal.agentType || 'the sender',
                        hostTerminalId: row.fromTerminalId,
                        messageId: row.messageId,
                        shimPath,
                        ...(registry.replyTokenFor(row.messageId) ? { replyToken: registry.replyTokenFor(row.messageId) } : {}),
                        recipientAgentKind: forward.to.effectiveAgentKind,
                        ...(hierarchyRoleLineFor(terminalId) ? { roleLine: hierarchyRoleLineFor(terminalId) } : {}),
                    }));
                    if (ok)
                        reminded += 1;
                }
                continue;
            }
            const inbound = links.find((row) => row.state === 'active' && row.to.terminalId === terminalId);
            if (!inbound)
                continue;
            const awaitingCount = awaitingByTerminal.get(terminalId) ?? 0;
            let prompt;
            if (awaitingCount > 0) {
                prompt = (0, linkNudge_1.composeResumeOrchestrationNudge)({
                    awaitingCount,
                    shimPath,
                    ...(hierarchyRoleLineFor(terminalId) ? { roleLine: hierarchyRoleLineFor(terminalId) } : {}),
                });
            }
            else {
                // No outstanding traffic — the restored edge itself is the news.
                const from = storeManager.findTerminalLocation(inbound.from.terminalId);
                const to = storeManager.findTerminalLocation(inbound.to.terminalId);
                if (!from || !to)
                    continue;
                const context = {
                    link: inbound,
                    fromTitle: from.terminal.name || from.terminal.agentType,
                    toTitle: to.terminal.name || to.terminal.agentType,
                    shimPath,
                };
                prompt = activeSendEdge(terminalId, inbound.from.terminalId)
                    ? (0, linkNudge_1.composeMutualLinkNudge)(context)
                    : (0, linkNudge_1.composeInboundLinkNudge)(context);
            }
            const ok = await registry.deliverNotice(inbound, `resume-${projectId}-${terminalId}-${Date.now()}`, prompt);
            if (ok)
                woken += 1;
        }
        return { ok: true, relinked, reminded, woken, seatsRebound };
    });
    electron_1.ipcMain.handle('orchestration:unlink', async (event, args = {}) => {
        if (!await hasMainRendererGesture(event))
            return { ok: false };
        const registry = getLinkRegistry?.();
        if (!registry)
            return { ok: false };
        const ids = args.linkIds ?? (args.linkId ? [args.linkId] : []);
        if (ids.length === 0)
            return { ok: false };
        let removed = 0;
        for (const id of ids) {
            if (typeof id === 'string' && registry.unlink(id))
                removed += 1;
        }
        return { ok: removed > 0, removed };
    });
    // Revive a quarantined link (v4 lifecycle): re-bind the same pair to their
    // current endpoints. Gesture-gated like every other renderer-only mutation —
    // reviving grants delivery authority again, so it is the user's call.
    electron_1.ipcMain.handle('orchestration:relink', async (event, args = {}) => {
        if (!args.linkId)
            return { ok: false, error: 'invalid relink request' };
        const readAuthorized = consumeReadAuthorization(args.readConsent, { kind: 'link', linkId: args.linkId });
        if (!readAuthorized && !await hasMainRendererGesture(event)) {
            return { ok: false, error: 'human gesture required' };
        }
        const registry = getLinkRegistry?.();
        if (!registry)
            return { ok: false, error: 'Terminal links are unavailable' };
        const result = registry.relink(args.linkId, 'user-explicit', args.readConsent);
        // A revived link means the peer relaunched: its context lost the original
        // notice, so re-inject it (same rule as session replacement, v4 L2).
        if (result.ok && result.created)
            injectInboundNudge(result.link);
        return result;
    });
    // Read-only, body-free message rows for Mission Control's awaiting-reply
    // counts. No gesture: it mutates nothing and discloses no prompt bodies.
    electron_1.ipcMain.handle('orchestration:list-link-messages', (event, args = {}) => {
        if (!isMainRenderer(event))
            return [];
        return getLinkRegistry?.()?.listMessageSummaries(args.projectId) ?? [];
    });
    // Leaderless swarm decisions: read-only for the user, plus a cancel escape
    // hatch for a vote nobody can finish (dead peer, impossible options).
    electron_1.ipcMain.handle('orchestration:list-decisions', (event, args = {}) => {
        if (!isMainRenderer(event))
            return [];
        return getLinkRegistry?.()?.listDecisions(args.projectId) ?? [];
    });
    electron_1.ipcMain.handle('orchestration:cancel-decision', async (event, args = {}) => {
        if (!await hasMainRendererGesture(event))
            return { ok: false };
        if (!args.decisionId)
            return { ok: false };
        return { ok: getLinkRegistry?.()?.cancelDecision(args.decisionId) ?? false };
    });
    electron_1.ipcMain.handle('orchestration:list-links', (event, args = {}) => {
        if (!isMainRenderer(event))
            return [];
        return getLinkRegistry?.()?.listLinks(args.projectId) ?? [];
    });
    // Read-only session-team projection for the Resume dialog: which native
    // sessions ran as one linked team. Ids and display names only — no bodies.
    electron_1.ipcMain.handle('orchestration:list-session-teams', (event) => {
        if (!isMainRenderer(event))
            return [];
        return getLinkRegistry?.()?.listSessionTeams() ?? [];
    });
    // Per-terminal context meter (v4 L7). Cheap by construction: transcript
    // tail reads behind an mtime + 60s TTL cache; unknown states return null.
    // Composed with the live footer tracker so gemini/qwen (footer-only) and
    // codex (footer fallback) terminals get a percent too — see
    // orchestration/contextSignals.ts for the per-kind source priority.
    const contextMeter = new contextMeter_1.ContextMeterService({
        getAgentRoot: (agent) => (0, agentPaths_1.getAgentRoot)(agent, storeManager.getPreferences().aiAgentPaths || {}),
    });
    const contextSignals = new contextSignals_1.TerminalContextSignals({
        meter: contextMeter,
        footer: contextFooterTracker,
        getBackend: getPtyBackend,
        findTerminal: (terminalId) => {
            const location = storeManager.findTerminalLocation(terminalId);
            if (!location)
                return null;
            return {
                agentType: location.terminal.agentType,
                startupCommand: location.terminal.startupCommand,
                lastSessionAgentType: location.terminal.lastSessionAgentType,
                lastSessionId: location.terminal.lastSessionId,
            };
        },
    });
    electron_1.ipcMain.handle('orchestration:context-usage', (event, args = {}) => {
        if (!isMainRenderer(event))
            return null;
        if (!args.terminalId)
            return null;
        return contextSignals.getSnapshot(args.terminalId);
    });
    // Settings → AI → Orchestration doctor: read-only view of Codex's notify
    // chain. A `cycle` verdict is the notify-storm precursor
    // (docs/engineering/performance/codex-notify-chain-storm.md); the Reinstall
    // button repairs it because the installer sanitizes previousNotify.
    electron_1.ipcMain.handle('orchestration:notify-chain-status', async () => {
        return (0, nativeHookInstall_1.diagnoseCodexNotifyChain)();
    });
    // --- Orchestration Dashboard: routing policy (docs/features/orchestration/dashboard.md §7)
    electron_1.ipcMain.handle('orchestration:get-policy', async () => {
        return (0, orchestrationPolicy_1.normalizeOrchestrationPolicyState)(storeManager.getPreferences().orchestration);
    });
    // Draft save. Schema bounds are enforced HERE (single source of truth —
    // the renderer only mirrors them). Rejected saves change nothing.
    electron_1.ipcMain.handle('orchestration:set-policy', async (_, args = {}) => {
        const prefs = storeManager.getPreferences();
        const state = (0, orchestrationPolicy_1.normalizeOrchestrationPolicyState)(prefs.orchestration);
        // The hierarchy chart is owned by `orchestration:set-hierarchy` — a
        // routing save carries whatever (possibly stale) copy its tab hydrated
        // at dialog open and must never clobber a chart edited since (v5 §3).
        const rawDraft = args?.draft && typeof args.draft === 'object'
            ? (() => {
                const clone = { ...args.draft };
                delete clone.hierarchy;
                return clone;
            })()
            : args?.draft;
        const { normalized, errors } = (0, orchestrationPolicy_1.normalizePolicyDraft)(rawDraft);
        if (state.draft.hierarchy)
            normalized.hierarchy = state.draft.hierarchy;
        // Compiled routing section hard cap — prevents 15-file skill bloat by
        // construction (§4.1). Measured in UTF-8 bytes.
        const sectionBytes = Buffer.byteLength((0, skillContent_1.renderRoutingSectionMarkdown)(normalized), 'utf-8');
        if (sectionBytes > orchestrationPolicy_1.ROUTING_SECTION_MAX_BYTES) {
            errors.push(`compiled routing section is ${sectionBytes} bytes — the maximum is ${orchestrationPolicy_1.ROUTING_SECTION_MAX_BYTES} (shorten notes/labels or disable rows)`);
        }
        if (errors.length > 0) {
            return { ok: false, errors, state };
        }
        const nextState = {
            ...state,
            draft: { ...normalized, updatedAt: Date.now() },
        };
        storeManager.setPreferences({ ...prefs, orchestration: nextState });
        return { ok: true, errors: [], state: nextState };
    });
    // Apply. No `targets` = full Apply (compiles the just-validated draft,
    // promotes draft → applied ONLY after shim success). With `targets` =
    // retry: recompiles the persisted APPLIED snapshot for just those targets,
    // merges rows, never touches draft, never promotes (§5, review round 3).
    electron_1.ipcMain.handle('orchestration:apply-policy', async (_, args = {}) => {
        const prefs = storeManager.getPreferences();
        const state = (0, orchestrationPolicy_1.normalizeOrchestrationPolicyState)(prefs.orchestration);
        const now = Date.now();
        const targets = Array.isArray(args?.targets) && args.targets.length > 0
            ? args.targets.filter((t) => skillContent_1.ORCHESTRATION_SKILL_TARGETS.includes(t))
            : undefined;
        const policy = targets ? state.applied : state.draft;
        if (targets && !policy) {
            return { ok: false, error: 'No applied policy to retry — run a full Apply first.', state };
        }
        const outcome = await (0, install_1.runOrchestrationInstall)(getInstallDependencies(), {
            policy: policy ?? null,
            force: true,
            targets,
        });
        if (outcome.shim.status === 'error') {
            // Skill writes were gated off; nothing was promoted (§5 step 2).
            return {
                ok: false,
                error: `1devtool-agent shim install failed: ${outcome.shim.error ?? 'unknown error'}`,
                shim: outcome.shim,
                state,
            };
        }
        const rows = outcome.skills.map((r) => ({
            target: r.tool,
            status: r.status,
            ...(r.error ? { error: r.error } : {}),
            at: now,
        }));
        let nextState;
        if (targets) {
            const kept = (state.lastInstallResults ?? []).filter((r) => !targets.includes(r.target));
            nextState = { ...state, lastInstallResults: [...kept, ...rows] };
        }
        else {
            // Promote after shim success. Per-target skill failures don't revert
            // the promotion — they stay as persisted error rows with Retry (§4.1).
            nextState = {
                ...state,
                applied: state.draft,
                appliedAt: now,
                appliedPolicyHash: (0, orchestrationPolicy_1.canonicalPolicyHash)(state.draft),
                lastInstallResults: rows,
            };
        }
        storeManager.setPreferences({ ...prefs, orchestration: nextState });
        return { ok: true, shim: outcome.shim, results: rows, state: nextState };
    });
    // Per-target expected-vs-actual { version, shim, policyHash } from on-disk
    // frontmatter, so Router's apply log can show WHICH target is stale and why.
    electron_1.ipcMain.handle('orchestration:skill-status', async () => {
        const state = (0, orchestrationPolicy_1.normalizeOrchestrationPolicyState)(storeManager.getPreferences().orchestration);
        const expected = {
            version: skillContent_1.SKILL_VERSION,
            shim: (0, shimInstall_1.getOrchestratorShimPath)(),
            policyHash: state.applied ? (0, orchestrationPolicy_1.canonicalPolicyHash)(state.applied) : null,
        };
        const actual = skillsManager.readOrchestrationSkillStates();
        // Tasks staleness rides the same surface (docs/tasks_v2.md §6.3) — one
        // status readout, one Reinstall. It has no shim or policy of its own, so
        // version is the whole comparison.
        const tasksTargets = skillsManager.readTasksSkillStates().map((row) => ({
            ...row,
            stale: row.agentDirExists && (!row.exists || row.version !== skillContent_2.TASKS_SKILL_VERSION),
        }));
        return {
            expected,
            targets: actual.map((row) => ({
                ...row,
                stale: row.agentDirExists && (!row.exists ||
                    row.version !== expected.version ||
                    row.shim !== expected.shim ||
                    row.policyHash !== expected.policyHash),
            })),
            tasks: { expected: { version: skillContent_2.TASKS_SKILL_VERSION }, targets: tasksTargets },
        };
    });
    // Pure preview — renders the exact markdown Apply would bake in. No fs writes.
    electron_1.ipcMain.handle('orchestration:preview-skill-section', async (_, args = {}) => {
        const { normalized } = (0, orchestrationPolicy_1.normalizePolicyDraft)(args?.draft);
        const routing = (0, skillContent_1.renderRoutingSectionMarkdown)(normalized);
        const custom = (0, skillContent_1.renderCustomInstructionsMarkdown)(normalized);
        return {
            markdown: [routing, custom].filter(Boolean).join('\n'),
            routingSectionBytes: Buffer.byteLength(routing, 'utf-8'),
            customInstructionsBytes: Buffer.byteLength(normalized.customInstructions ?? '', 'utf-8'),
        };
    });
    // --- Orchestration v5: hierarchy chart (docs/orchestration_v5.md §3).
    // Charts ride OrchestrationPolicyDraft.hierarchy with the same
    // draft/applied split as routing; these channels own the chart field.
    electron_1.ipcMain.handle('orchestration:get-hierarchy', async (event) => {
        if (!isMainRenderer(event))
            throw new Error('HIERARCHY_FORBIDDEN: main renderer only');
        const state = (0, orchestrationPolicy_1.normalizeOrchestrationPolicyState)(storeManager.getPreferences().orchestration);
        const draft = state.draft.hierarchy ?? null;
        return {
            draft,
            applied: state.applied?.hierarchy ?? null,
            ...(state.appliedAt ? { appliedAt: state.appliedAt } : {}),
            tiers: draft ? (0, hierarchy_1.normalizeHierarchyChart)(draft).tiers : {},
        };
    });
    // Draft save — bounds enforced in main (the §2 validation matrix), the
    // renderer editor only mirrors them. A null/empty chart clears the field so
    // chart-less policies keep their pre-v5 canonical hash.
    electron_1.ipcMain.handle('orchestration:set-hierarchy', async (event, args = {}) => {
        if (!isMainRenderer(event))
            return { ok: false, errors: ['untrusted renderer origin'] };
        const prefs = storeManager.getPreferences();
        const state = (0, orchestrationPolicy_1.normalizeOrchestrationPolicyState)(prefs.orchestration);
        const cleared = args?.chart === null || args?.chart === undefined;
        const { normalized, errors, tiers } = (0, hierarchy_1.normalizeHierarchyChart)(args?.chart ?? {});
        if (!cleared && errors.length > 0) {
            return { ok: false, errors, state, tiers };
        }
        const draft = { ...state.draft, updatedAt: Date.now() };
        if (cleared || normalized.nodes.length === 0) {
            delete draft.hierarchy;
        }
        else {
            draft.hierarchy = { ...normalized, updatedAt: Date.now() };
        }
        const nextState = { ...state, draft };
        storeManager.setPreferences({ ...prefs, orchestration: nextState });
        return { ok: true, errors: [], state: nextState, tiers };
    });
    // Pure preview — the exact §5.3 role card each seat would receive at
    // activation, with node ids standing in for the not-yet-bound terminal
    // ids. No fs writes, no delivery.
    electron_1.ipcMain.handle('orchestration:preview-hierarchy-nudges', async (event, args = {}) => {
        if (!isMainRenderer(event))
            throw new Error('HIERARCHY_FORBIDDEN: main renderer only');
        const { normalized } = (0, hierarchy_1.normalizeHierarchyChart)(args?.chart ?? {});
        const shimPath = (0, shimInstall_1.getOrchestratorShimPath)();
        const previewSeats = normalized.nodes.map((node) => ({
            nodeId: node.nodeId,
            state: 'active',
            endpoint: {
                terminalId: `<${node.nodeId}>`,
                terminalGeneration: 1,
                projectId: 'preview',
                effectiveAgentKind: node.selector.agentKind,
            },
        }));
        const seats = normalized.nodes.map((node) => {
            const nudge = (0, hierarchyProvisioning_1.composeSeatNudge)(normalized, node, previewSeats, shimPath);
            return {
                nodeId: node.nodeId,
                label: node.label,
                nudge,
                bytes: Buffer.byteLength(nudge, 'utf-8'),
            };
        });
        return { seats };
    });
    // Apply — promotes ONLY the chart into `applied` (the Hierarchy tab must
    // never surprise-apply unapplied routing edits) and reinstalls skills so
    // `orchestration:skill-status` staleness rides the policy-hash extension
    // unchanged. The helper deliberately owns no gesture check: the ordinary
    // Apply IPC checks once, while preset activation calls it from inside the
    // already gesture-gated activate IPC. Splitting those into two renderer
    // round trips lets Chromium's transient activation expire between them.
    const applyHierarchyDraft = async () => {
        const prefs = storeManager.getPreferences();
        const state = (0, orchestrationPolicy_1.normalizeOrchestrationPolicyState)(prefs.orchestration);
        const draftChart = state.draft.hierarchy ?? null;
        if (draftChart) {
            const { errors } = (0, hierarchy_1.normalizeHierarchyChart)(draftChart);
            if (errors.length > 0) {
                return { ok: false, error: `hierarchy draft is invalid: ${errors[0]}`, state };
            }
        }
        const appliedBase = state.applied ?? (0, orchestrationPolicy_1.emptyPolicyDraft)();
        const nextApplied = { ...appliedBase };
        if (draftChart)
            nextApplied.hierarchy = draftChart;
        else
            delete nextApplied.hierarchy;
        const now = Date.now();
        const outcome = await (0, install_1.runOrchestrationInstall)(getInstallDependencies(), {
            policy: nextApplied,
            force: true,
        });
        if (outcome.shim.status === 'error') {
            return {
                ok: false,
                error: `1devtool-agent shim install failed: ${outcome.shim.error ?? 'unknown error'}`,
                shim: outcome.shim,
                state,
            };
        }
        const rows = outcome.skills.map((r) => ({
            target: r.tool,
            status: r.status,
            ...(r.error ? { error: r.error } : {}),
            at: now,
        }));
        const nextState = {
            ...state,
            applied: nextApplied,
            appliedAt: now,
            appliedPolicyHash: (0, orchestrationPolicy_1.canonicalPolicyHash)(nextApplied),
            lastInstallResults: rows,
        };
        storeManager.setPreferences({ ...prefs, orchestration: nextState });
        return { ok: true, shim: outcome.shim, results: rows, state: nextState };
    };
    electron_1.ipcMain.handle('orchestration:apply-hierarchy', async (event) => {
        if (!await hasMainRendererGesture(event)) {
            return { ok: false, error: 'human gesture required' };
        }
        return applyHierarchyDraft();
    });
    // --- Orchestration v5: hierarchy activation (docs/orchestration_v5.md §5).
    // Edge minting, role nudges, rebind, and promote live in
    // orchestration/hierarchyProvisioning.ts — shared with the phone's
    // approver Rebind so every surface repairs the org identically.
    /** One-line seat summary for hierarchy-aware repair nudges (§7.2), or
     *  undefined when the terminal is not seated in an active org. */
    const hierarchyRoleLineFor = (terminalId) => {
        const seatInfo = getHierarchyActivations?.()?.reportTarget(terminalId);
        if (!seatInfo)
            return undefined;
        const node = seatInfo.chart.nodes.find((row) => row.nodeId === seatInfo.seat.nodeId);
        if (!node)
            return undefined;
        if ((0, pipeline_1.isPipelineChart)(seatInfo.chart)) {
            const stages = (0, pipeline_1.pipelineStages)(seatInfo.chart);
            const stageIndex = stages.findIndex((stage) => stage.nodeId === node.nodeId);
            const next = stages[stageIndex + 1];
            const nextSeat = next
                ? seatInfo.activation.seats.find((seat) => seat.nodeId === next.nodeId)
                : undefined;
            return (0, linkNudge_1.composePipelineRoleLine)({
                nodeLabel: node.label,
                stageIndex: stageIndex + 1,
                stageCount: stages.length,
                ...(next && nextSeat
                    ? { next: { label: next.label, terminalId: nextSeat.endpoint.terminalId } }
                    : {}),
            });
        }
        return (0, linkNudge_1.composeHierarchyRoleLine)({
            nodeLabel: node.label,
            role: (0, hierarchy_1.hierarchyNodeRole)(seatInfo.chart, node.nodeId),
            ...(seatInfo.reportsToSeat
                ? {
                    reportsTo: {
                        label: seatInfo.chart.nodes.find((row) => row.nodeId === seatInfo.reportsToSeat.nodeId)?.label
                            ?? seatInfo.reportsToSeat.nodeId,
                        terminalId: seatInfo.reportsToSeat.endpoint.terminalId,
                    },
                }
                : {}),
        });
    };
    /** Shared deps for the provisioning flows (rebind/promote/resume repair). */
    const hierarchyProvisioning = () => {
        const activations = getHierarchyActivations?.();
        const registry = getLinkRegistry?.();
        if (!activations || !registry)
            return null;
        return {
            activations,
            registry,
            shimPath: (0, shimInstall_1.getOrchestratorShimPath)(),
            log: (line) => console.warn('[hierarchy]', line),
        };
    };
    /**
     * Resume repair for hierarchy seats (§7.2): a restart vacates every seat
     * (new PTY generations), and resume-orchestration just relinked the same
     * terminals — re-bind each vacant seat whose ORIGINAL terminal is live
     * again with a matching agent kind. Same consent class as the batch relink:
     * one gesture covers it. skipNudge: the resume notice itself carries the
     * seat's role line, and two staged notices into one composer is a storm.
     * Returns how many seats were re-bound.
     */
    const resumeRebindHierarchySeats = (projectId) => {
        const deps = hierarchyProvisioning();
        if (!deps)
            return 0;
        const activation = deps.activations.activeForProject(projectId);
        if (!activation)
            return 0;
        let rebound = 0;
        for (const seat of activation.seats) {
            if (seat.state !== 'vacant')
                continue;
            // rebindHierarchySeat validates liveness/project/kind; later seats in
            // this loop see the repaired counterpart and mint their shared edges.
            const result = (0, hierarchyProvisioning_1.rebindHierarchySeat)(deps, {
                projectId,
                nodeId: seat.nodeId,
                terminalId: seat.endpoint.terminalId,
                skipNudge: true,
            });
            if (result.ok)
                rebound += 1;
        }
        return rebound;
    };
    electron_1.ipcMain.handle('orchestration:activate-hierarchy', async (event, args = {}) => {
        if (!await hasMainRendererGesture(event)) {
            return { ok: false, error: 'human gesture required' };
        }
        const activations = getHierarchyActivations?.();
        const registry = getLinkRegistry?.();
        if (!activations || !registry)
            return { ok: false, error: 'Hierarchy activation is unavailable' };
        const projectId = args.projectId;
        if (!projectId)
            return { ok: false, error: 'projectId is required' };
        if (args.setupChart !== undefined) {
            const { normalized, errors } = (0, hierarchy_1.normalizeHierarchyChart)(args.setupChart);
            if (errors.length > 0 || !(0, hierarchy_1.hierarchyChartHasStructure)(normalized)) {
                return { ok: false, error: errors[0] ?? 'the setup chart has no structure' };
            }
            const setupPreferences = storeManager.getPreferences();
            const setupState = (0, orchestrationPolicy_1.normalizeOrchestrationPolicyState)(setupPreferences.orchestration);
            const now = Date.now();
            const draft = {
                ...setupState.draft,
                hierarchy: { ...normalized, updatedAt: now },
                updatedAt: now,
            };
            storeManager.setPreferences({
                ...setupPreferences,
                orchestration: { ...setupState, draft },
            });
            const applied = await applyHierarchyDraft();
            if (!applied.ok)
                return applied;
        }
        const preferences = storeManager.getPreferences();
        const state = (0, orchestrationPolicy_1.normalizeOrchestrationPolicyState)(preferences.orchestration);
        const chart = state.applied?.hierarchy ?? null;
        if (!chart || !(0, hierarchy_1.hierarchyChartHasStructure)(chart)) {
            return { ok: false, error: 'Apply a hierarchy chart first — activation binds the applied chart' };
        }
        const existing = activations.activeForProject(projectId);
        if (existing) {
            if (!args.replaceActive) {
                return { ok: false, error: 'stop the current hierarchy first — one activation per project' };
            }
            // One explicit preset click may replace the current structure. Keep the
            // teardown inside the same authorized transaction; a second renderer
            // call would need a second transient gesture and can fail halfway.
            for (const linkId of existing.linkIds)
                registry.unlink(linkId);
            registry.cancelPipelineRuns(existing.activationId);
            activations.stop(existing.activationId);
        }
        const requested = new Map();
        const presetLaunches = new Map();
        for (const row of Array.isArray(args.seats) ? args.seats : []) {
            if (typeof row?.nodeId !== 'string')
                continue;
            const node = chart.nodes.find((candidate) => candidate.nodeId === row.nodeId);
            if (!node)
                return { ok: false, error: `unknown hierarchy seat "${row.nodeId}"` };
            if (requested.has(row.nodeId)) {
                return { ok: false, error: `duplicate hierarchy seat "${row.nodeId}"` };
            }
            if (row.terminalId && row.startupPresetId) {
                return { ok: false, error: `seat "${row.nodeId}" cannot adopt a terminal and launch a startup preset` };
            }
            if (row.startupPresetId) {
                if (!/^[A-Za-z0-9._:-]{1,128}$/.test(row.startupPresetId)) {
                    return { ok: false, error: `seat "${row.nodeId}": invalid startup preset id` };
                }
                const resolved = (0, hierarchyStartupPreset_1.resolveHierarchyStartupPreset)(preferences.startupCommands?.customPresets ?? [], row.startupPresetId, node.selector.agentKind);
                if (!resolved.ok) {
                    return { ok: false, error: `seat "${row.nodeId}": ${resolved.error}` };
                }
                presetLaunches.set(row.nodeId, resolved);
            }
            requested.set(row.nodeId, {
                ...(row.terminalId ? { terminalId: row.terminalId } : {}),
                ...(row.startupPresetId ? { startupPresetId: row.startupPresetId } : {}),
            });
        }
        // Seat resolution in tier order (§5.1). Adoption never mutates the
        // adopted terminal; a missing pick spawns via the interactive launch spec.
        const tiers = (0, hierarchy_1.deriveHierarchyTiers)(chart);
        const order = [...chart.nodes].sort((a, b) => (tiers[a.nodeId] ?? 0) - (tiers[b.nodeId] ?? 0));
        const used = new Set();
        const seats = [];
        for (const node of order) {
            const seatRequest = requested.get(node.nodeId);
            let terminalId = seatRequest?.terminalId;
            const spawned = !terminalId;
            if (!terminalId) {
                const defaultSpawnArgs = cliRegistry?.knownClis()
                    .find((cli) => cli.id === node.selector.agentKind)?.defaultSpawnArgs ?? [];
                const presetLaunch = presetLaunches.get(node.nodeId)?.launch;
                const launch = presetLaunch ?? (0, interactiveDelegation_1.buildInteractiveAgentLaunchSpec)(node.selector.agentKind, node.selector.model, undefined, defaultSpawnArgs, process.platform === 'win32');
                if (!launch) {
                    return { ok: false, error: `seat "${node.nodeId}": ${node.selector.agentKind} has no interactive launcher` };
                }
                const created = await (0, terminal_1.requestRendererCreateTerminal)({
                    projectId,
                    agentType: launch.agentType,
                    name: presetLaunch ? launch.name : node.label,
                    command: launch.command,
                    forceAiAgent: launch.forceAiAgent,
                    focusWindow: false,
                });
                if (!created.ok || !created.terminalId) {
                    return { ok: false, error: created.error ?? `seat "${node.nodeId}": could not spawn a terminal` };
                }
                terminalId = created.terminalId;
            }
            if (used.has(terminalId)) {
                return { ok: false, error: `terminal ${terminalId} was picked for two seats` };
            }
            // A seat MAIN just spawned is acked before its PTY exists: wait for the
            // process instead of failing the whole activation on the race. An
            // ADOPTED terminal is answered immediately — the user picked it, so a
            // missing endpoint really is "that terminal is not a running agent".
            const endpoint = spawned
                ? await (0, hierarchyProvisioning_1.waitForSpawnedSeatEndpoint)(activations, terminalId)
                : activations.resolveEndpoint(terminalId);
            if (!endpoint) {
                return {
                    ok: false,
                    error: spawned
                        ? `seat "${node.nodeId}": the new ${node.selector.agentKind} terminal did not start`
                        : `seat "${node.nodeId}": the terminal is not a running AI terminal`,
                };
            }
            if (endpoint.projectId !== projectId) {
                return { ok: false, error: `seat "${node.nodeId}": the terminal is not in this project` };
            }
            // Model-qualified selectors match on agent kind alone when the model is
            // unknown (§13) — never block activation on a chip heuristic.
            if ((0, hierarchy_1.headlessAgentKindForEffectiveKind)(endpoint.effectiveAgentKind) !== node.selector.agentKind) {
                return {
                    ok: false,
                    error: `seat "${node.nodeId}" needs a ${node.selector.agentKind} terminal, got ${endpoint.effectiveAgentKind}`,
                };
            }
            used.add(terminalId);
            seats.push({ nodeId: node.nodeId, endpoint, state: 'active' });
        }
        // Edge minting (§5.2). All-or-nothing: a failed mint unwinds what this
        // call created so a half-wired org never runs.
        const mintedLinkIds = [];
        const seatTerminal = (nodeId) => seats.find((row) => row.nodeId === nodeId).endpoint.terminalId;
        for (const pair of (0, hierarchyProvisioning_1.seatEdgePairs)(chart)) {
            const minted = (0, hierarchyProvisioning_1.mintHierarchyEdge)(registry, seatTerminal(pair.fromNodeId), seatTerminal(pair.toNodeId), mintedLinkIds);
            if (!minted.ok) {
                for (const linkId of mintedLinkIds)
                    registry.unlink(linkId);
                return { ok: false, error: `could not link ${pair.fromNodeId} → ${pair.toNodeId}: ${minted.error}` };
            }
        }
        const created = activations.create({
            chartId: chart.chartId,
            chart,
            projectId,
            seats,
            linkIds: [...new Set(mintedLinkIds)],
        });
        if (!created.ok) {
            for (const linkId of mintedLinkIds)
                registry.unlink(linkId);
            return created;
        }
        // Role nudges — one per seat (§5.3), best-effort staged submits.
        for (const node of order) {
            void (0, hierarchyProvisioning_1.injectSeatNudge)(registry, chart, node, seats, created.activation.activationId, (0, shimInstall_1.getOrchestratorShimPath)(), (line) => console.warn('[hierarchy]', line));
        }
        return { ok: true, activation: created.activation };
    });
    // Prompt-as-instructor (v5.1): the submit path parsed an explicit chain of
    // command out of the user's own prompt ("claude request grok, grok request
    // opencode, review back to grok, do not report to me") and asks main to run
    // it as an EPHEMERAL activation — adopt-only (never spawns), root = the
    // terminal the prompt was typed into, one per project. A configured, user-
    // activated org always wins: the prompt chain then stays social (the prompt
    // text still teaches the routes) instead of clobbering an explicit gesture.
    electron_1.ipcMain.handle('orchestration:activate-prompt-chain', async (event, args = {}) => {
        if (!await hasMainRendererGesture(event)) {
            return { ok: false, error: 'human gesture required' };
        }
        const activations = getHierarchyActivations?.();
        const registry = getLinkRegistry?.();
        if (!activations || !registry)
            return { ok: false, error: 'Hierarchy activation is unavailable' };
        const projectId = args.projectId;
        if (!projectId)
            return { ok: false, error: 'projectId is required' };
        if (args.topology === 'pipeline') {
            const allowedKeys = new Set(['projectId', 'topology', 'originTerminalId', 'stages']);
            if (Object.keys(args).some((key) => !allowedKeys.has(key))) {
                return { ok: false, error: 'Pipeline activation accepts ordered stage references only; edges, generations, ids, and hashes are main-owned' };
            }
            const rawStages = Array.isArray(args.stages) ? args.stages : [];
            if (!args.originTerminalId || rawStages.length < 2) {
                return { ok: false, error: 'Pipeline needs an origin terminal and at least two ordered stages' };
            }
            const stageAllowed = new Set(['selector', 'terminalId', 'brief', 'qualityGate']);
            const selectorAllowed = new Set(['agentKind', 'model']);
            if (rawStages.some((stage) => !stage || typeof stage !== 'object'
                || Object.keys(stage).some((key) => !stageAllowed.has(key))
                || !stage.selector || typeof stage.selector !== 'object'
                || Object.keys(stage.selector).some((key) => !selectorAllowed.has(key)))) {
                return { ok: false, error: 'Pipeline stage payload contains caller-authored authority fields' };
            }
            const compiled = (0, pipeline_1.chartFromPipelineStages)(rawStages.map((stage, index) => ({
                nodeId: `stage-${index + 1}`,
                label: typeof stage.selector?.agentKind === 'string' ? stage.selector.agentKind : `Stage ${index + 1}`,
                selector: {
                    agentKind: typeof stage.selector?.agentKind === 'string' ? stage.selector.agentKind : '',
                    ...(typeof stage.selector?.model === 'string' ? { model: stage.selector.model } : {}),
                },
                ...(typeof stage.brief === 'string' ? { brief: stage.brief } : {}),
                ...(typeof stage.qualityGate === 'string' ? { qualityGate: stage.qualityGate } : {}),
            })), {
                chartId: hierarchyProvisioning_1.PROMPT_PIPELINE_CHART_ID,
                name: 'Prompt Pipeline',
            });
            if (compiled.errors.length > 0)
                return { ok: false, error: compiled.errors[0] };
            const normalized = compiled.normalized;
            const ordered = (0, pipeline_1.pipelineStages)(normalized);
            const used = new Set();
            const seats = [];
            for (let index = 0; index < ordered.length; index += 1) {
                const raw = rawStages[index];
                const terminalId = typeof raw.terminalId === 'string' ? raw.terminalId : '';
                if (!terminalId || (index === 0 && terminalId !== args.originTerminalId)) {
                    return { ok: false, error: index === 0 ? 'the origin terminal must be stage 1' : `stage ${index + 1} has no exact local terminal` };
                }
                if (used.has(terminalId))
                    return { ok: false, error: `terminal ${terminalId} was picked for two Pipeline stages` };
                const endpoint = activations.resolveEndpoint(terminalId);
                if (!endpoint || endpoint.projectId !== projectId) {
                    return { ok: false, error: `stage ${index + 1}: the terminal is not a running local AI terminal in this project` };
                }
                if ((0, hierarchy_1.headlessAgentKindForEffectiveKind)(endpoint.effectiveAgentKind) !== ordered[index].selector.agentKind) {
                    return { ok: false, error: `stage ${index + 1} needs ${ordered[index].selector.agentKind}, got ${endpoint.effectiveAgentKind}` };
                }
                used.add(terminalId);
                seats.push({ nodeId: ordered[index].nodeId, endpoint, state: 'active' });
            }
            const existing = activations.activeForProject(projectId);
            if (existing) {
                if (!(0, hierarchyProvisioning_1.promptPipelineActivationMatches)(existing, normalized, seats)) {
                    return { ok: false, error: 'an active structure conflicts with this Pipeline — Deactivate or switch mode' };
                }
                if (registry.activePipelineRun(existing.activationId)) {
                    return { ok: false, error: 'this Pipeline already has an open run — resolve or cancel it before submitting another' };
                }
                return { ok: true, activation: existing, reused: true };
            }
            const mintedLinkIds = [];
            const terminalFor = (nodeId) => seats.find((seat) => seat.nodeId === nodeId).endpoint.terminalId;
            for (const pair of (0, hierarchyProvisioning_1.seatEdgePairs)(normalized)) {
                const minted = (0, hierarchyProvisioning_1.mintHierarchyEdge)(registry, terminalFor(pair.fromNodeId), terminalFor(pair.toNodeId), mintedLinkIds);
                if (!minted.ok) {
                    for (const linkId of mintedLinkIds)
                        registry.unlink(linkId);
                    return { ok: false, error: `could not link Pipeline stages: ${minted.error}` };
                }
            }
            const created = activations.create({
                chartId: normalized.chartId,
                chart: normalized,
                projectId,
                seats,
                linkIds: [...new Set(mintedLinkIds)],
            });
            if (!created.ok) {
                for (const linkId of mintedLinkIds)
                    registry.unlink(linkId);
                return created;
            }
            const installed = await Promise.all(ordered.map(async (node) => {
                const seat = seats.find((row) => row.nodeId === node.nodeId);
                if (seat.endpoint.terminalId === args.originTerminalId)
                    return true;
                return (0, hierarchyProvisioning_1.injectSeatNudge)(registry, normalized, node, seats, created.activation.activationId, (0, shimInstall_1.getOrchestratorShimPath)());
            }));
            if (installed.some((ok) => !ok)) {
                for (const linkId of mintedLinkIds)
                    registry.unlink(linkId);
                activations.stop(created.activation.activationId);
                return { ok: false, error: 'Pipeline role cards could not be installed; the draft was retained' };
            }
            return { ok: true, activation: created.activation };
        }
        if (args.topology !== undefined)
            return { ok: false, error: 'unknown prompt activation topology' };
        const edges = (Array.isArray(args.edges) ? args.edges : [])
            .filter((row) => typeof row?.fromKind === 'string' && typeof row?.toKind === 'string');
        if (edges.length === 0)
            return { ok: false, error: 'no chain edges' };
        // "review back to X" suppresses X's upward report; "do not report to me"
        // additionally ends the chain at its roots (no final user-facing report).
        const managedKinds = new Set(edges.map((edge) => edge.toKind));
        const suppressKinds = new Set();
        if (typeof args.reportStopKind === 'string')
            suppressKinds.add(args.reportStopKind);
        if (args.suppressUserReport) {
            for (const edge of edges) {
                if (!managedKinds.has(edge.fromKind))
                    suppressKinds.add(edge.fromKind);
            }
        }
        const chart = (0, hierarchyLevels_1.chartFromKindEdges)(edges, {
            chartId: hierarchyPromptDirectives_1.PROMPT_CHAIN_CHART_ID,
            name: 'Prompt chain',
            ...(args.labels ? { labels: args.labels } : {}),
            suppressReportKinds: [...suppressKinds],
        });
        const { normalized, errors } = (0, hierarchy_1.normalizeHierarchyChart)(chart);
        if (errors.length > 0 || !(0, hierarchy_1.hierarchyChartHasStructure)(normalized)) {
            return { ok: false, error: errors[0] ?? 'the prompt chain has no structure' };
        }
        const existing = activations.activeForProject(projectId);
        if (existing) {
            if (existing.chart.chartId !== hierarchyPromptDirectives_1.PROMPT_CHAIN_CHART_ID) {
                return { ok: false, error: 'a configured hierarchy is already active for this project' };
            }
            // A newer prompt chain replaces the previous prompt chain.
            for (const linkId of existing.linkIds)
                registry.unlink(linkId);
            registry.cancelPipelineRuns(existing.activationId);
            activations.stop(existing.activationId);
        }
        const picks = new Map((Array.isArray(args.seats) ? args.seats : [])
            .filter((row) => typeof row?.kind === 'string' && typeof row?.terminalId === 'string')
            .map((row) => [row.kind, row.terminalId]));
        const tiers = (0, hierarchy_1.deriveHierarchyTiers)(normalized);
        const order = [...normalized.nodes].sort((a, b) => (tiers[a.nodeId] ?? 0) - (tiers[b.nodeId] ?? 0));
        const used = new Set();
        const seats = [];
        for (const node of order) {
            const terminalId = picks.get(node.selector.agentKind);
            if (!terminalId) {
                return { ok: false, error: `no open ${node.selector.agentKind} terminal for the chain` };
            }
            if (used.has(terminalId)) {
                return { ok: false, error: `terminal ${terminalId} was picked for two chain seats` };
            }
            const endpoint = activations.resolveEndpoint(terminalId);
            if (!endpoint) {
                return { ok: false, error: `chain seat "${node.nodeId}": the terminal is not a running AI terminal` };
            }
            if (endpoint.projectId !== projectId) {
                return { ok: false, error: `chain seat "${node.nodeId}": the terminal is not in this project` };
            }
            if ((0, hierarchy_1.headlessAgentKindForEffectiveKind)(endpoint.effectiveAgentKind) !== node.selector.agentKind) {
                return {
                    ok: false,
                    error: `chain seat "${node.nodeId}" needs a ${node.selector.agentKind} terminal, got ${endpoint.effectiveAgentKind}`,
                };
            }
            used.add(terminalId);
            seats.push({ nodeId: node.nodeId, endpoint, state: 'active' });
        }
        // Same all-or-nothing edge minting as a chart activation (§5.2/D7).
        const mintedLinkIds = [];
        const seatTerminal = (nodeId) => seats.find((row) => row.nodeId === nodeId).endpoint.terminalId;
        for (const pair of (0, hierarchyProvisioning_1.seatEdgePairs)(normalized)) {
            const minted = (0, hierarchyProvisioning_1.mintHierarchyEdge)(registry, seatTerminal(pair.fromNodeId), seatTerminal(pair.toNodeId), mintedLinkIds);
            if (!minted.ok) {
                for (const linkId of mintedLinkIds)
                    registry.unlink(linkId);
                return { ok: false, error: `could not link ${pair.fromNodeId} → ${pair.toNodeId}: ${minted.error}` };
            }
        }
        const created = activations.create({
            chartId: normalized.chartId,
            chart: normalized,
            projectId,
            seats,
            linkIds: [...new Set(mintedLinkIds)],
        });
        if (!created.ok) {
            for (const linkId of mintedLinkIds)
                registry.unlink(linkId);
            return created;
        }
        // Role cards for every seat EXCEPT the roots: the prompt itself is the
        // root's instruction, and staging a notice into the composer the user just
        // submitted from risks composer junk for zero information.
        for (const node of order) {
            if ((tiers[node.nodeId] ?? 0) === 0)
                continue;
            void (0, hierarchyProvisioning_1.injectSeatNudge)(registry, normalized, node, seats, created.activation.activationId, (0, shimInstall_1.getOrchestratorShimPath)(), (line) => console.warn('[hierarchy]', line));
        }
        return { ok: true, activation: created.activation };
    });
    electron_1.ipcMain.handle('orchestration:deactivate-hierarchy', async (event, args = {}) => {
        if (!await hasMainRendererGesture(event)) {
            return { ok: false, error: 'human gesture required' };
        }
        const activations = getHierarchyActivations?.();
        const registry = getLinkRegistry?.();
        if (!activations || !registry || !args.projectId) {
            return { ok: false, error: 'Hierarchy activation is unavailable' };
        }
        const activation = activations.activeForProject(args.projectId);
        if (!activation)
            return { ok: false, error: 'no active hierarchy for this project' };
        // Remove exactly what activation minted — user ad-hoc links survive (D7).
        for (const linkId of activation.linkIds)
            registry.unlink(linkId);
        registry.cancelPipelineRuns(activation.activationId);
        activations.stop(activation.activationId);
        return { ok: true };
    });
    electron_1.ipcMain.handle('orchestration:hierarchy-status', async (event, args = {}) => {
        if (!isMainRenderer(event))
            throw new Error('HIERARCHY_FORBIDDEN: main renderer only');
        const activations = getHierarchyActivations?.();
        if (!activations || !args.projectId) {
            return {
                activation: null,
                tiers: {},
                violations: [],
                violationCount: 0,
                escalations: [],
                orphanedNodeIds: [],
            };
        }
        const status = activations.status(args.projectId);
        const registry = getLinkRegistry?.();
        if (status.activation?.chart.topology === 'pipeline' && registry) {
            const activePipelineRun = registry.pipelineRunStatus(status.activation.activationId, status.activation.chart);
            return { ...status, ...(activePipelineRun ? { activePipelineRun } : {}) };
        }
        return status;
    });
    electron_1.ipcMain.handle('orchestration:resolve-pipeline-run', async (event, args = {}) => {
        if (!await hasMainRendererGesture(event))
            return { ok: false, error: 'human gesture required' };
        const activations = getHierarchyActivations?.();
        const registry = getLinkRegistry?.();
        if (!activations || !registry || !args.projectId)
            return { ok: false, error: 'Pipeline runtime is unavailable' };
        const activation = activations.activeForProject(args.projectId);
        if (!activation || !(0, pipeline_1.isPipelineChart)(activation.chart))
            return { ok: false, error: 'no active Pipeline' };
        return registry.resolvePipelineRun(activation.activationId);
    });
    // Repair a vacant seat (§5.4): relink semantics — re-mint the seat's edges
    // to the new endpoint and re-inject the role nudge (a relaunched agent's
    // context lost it). Same flow the phone's approver Rebind runs.
    //
    // A request WITHOUT a terminalId asks main to spawn the seat instead:
    // `startupPresetId` launches that saved AI command (validated against the
    // seat's kind), plain `spawn` launches the selector's default CLI. This is
    // the closed-terminals repair path — after quitting the app or closing the
    // team's terminals every seat is "empty · terminal-closed" and there is
    // nothing live to pick, so a picker-only Rebind dead-ends the Start
    // surfaces. Spawn + endpoint wait + rebind stay inside this ONE gesture-
    // gated call (the agent-input-hierarchy-gesture-expiry rule).
    electron_1.ipcMain.handle('orchestration:rebind-seat', async (event, args = {}) => {
        if (!await hasMainRendererGesture(event)) {
            return { ok: false, error: 'human gesture required' };
        }
        const deps = hierarchyProvisioning();
        if (!deps || !args.projectId || !args.nodeId) {
            return { ok: false, error: 'invalid rebind request' };
        }
        if (args.terminalId && args.startupPresetId) {
            return { ok: false, error: 'a seat cannot adopt a terminal and launch a startup preset' };
        }
        let terminalId = args.terminalId;
        if (!terminalId && (args.spawn || args.startupPresetId)) {
            const activation = deps.activations.activeForProject(args.projectId);
            const node = activation?.chart.nodes.find((row) => row.nodeId === args.nodeId);
            if (!node)
                return { ok: false, error: 'no active hierarchy seat to spawn for' };
            let launch;
            if (args.startupPresetId) {
                if (!/^[A-Za-z0-9._:-]{1,128}$/.test(args.startupPresetId)) {
                    return { ok: false, error: 'invalid startup preset id' };
                }
                const resolved = (0, hierarchyStartupPreset_1.resolveHierarchyStartupPreset)(storeManager.getPreferences().startupCommands?.customPresets ?? [], args.startupPresetId, node.selector.agentKind);
                if (!resolved.ok)
                    return resolved;
                launch = resolved.launch;
            }
            else {
                const defaultSpawnArgs = cliRegistry?.knownClis()
                    .find((cli) => cli.id === node.selector.agentKind)?.defaultSpawnArgs ?? [];
                launch = (0, interactiveDelegation_1.buildInteractiveAgentLaunchSpec)(node.selector.agentKind, node.selector.model, undefined, defaultSpawnArgs, process.platform === 'win32');
            }
            if (!launch) {
                return { ok: false, error: `${node.selector.agentKind} has no interactive launcher` };
            }
            const created = await (0, terminal_1.requestRendererCreateTerminal)({
                projectId: args.projectId,
                agentType: launch.agentType,
                name: args.startupPresetId ? launch.name : node.label,
                command: launch.command,
                forceAiAgent: launch.forceAiAgent,
                focusWindow: false,
            });
            if (!created.ok || !created.terminalId) {
                return { ok: false, error: created.error ?? `could not spawn a ${node.selector.agentKind} terminal` };
            }
            // The renderer ACKs a create when the RECORD exists, not when the PTY
            // runs — wait for the liveness fact like activation does for its own
            // spawns (team-start-spawned-seat-not-running).
            const endpoint = await (0, hierarchyProvisioning_1.waitForSpawnedSeatEndpoint)(deps.activations, created.terminalId);
            if (!endpoint) {
                return { ok: false, error: `the new ${node.selector.agentKind} terminal did not start` };
            }
            terminalId = created.terminalId;
        }
        if (!terminalId)
            return { ok: false, error: 'invalid rebind request' };
        return (0, hierarchyProvisioning_1.rebindHierarchySeat)(deps, {
            projectId: args.projectId,
            nodeId: args.nodeId,
            terminalId,
        });
    });
    // Promote a subordinate into a vacant seat (§5.4 stretch — the swarm
    // promote-worker precedent). Explicit user action, so the seat's agent-kind
    // selector is deliberately waived for the stand-in.
    electron_1.ipcMain.handle('orchestration:promote-seat', async (event, args = {}) => {
        if (!await hasMainRendererGesture(event)) {
            return { ok: false, error: 'human gesture required' };
        }
        const deps = hierarchyProvisioning();
        if (!deps || !args.projectId || !args.nodeId || !args.fromNodeId) {
            return { ok: false, error: 'invalid promote request' };
        }
        return (0, hierarchyProvisioning_1.promoteHierarchySeat)(deps, {
            projectId: args.projectId,
            nodeId: args.nodeId,
            fromNodeId: args.fromNodeId,
        });
    });
    // Read one installed SKILL.md verbatim (Skill tab). Target validated
    // against ORCHESTRATION_SKILL_TARGETS — never a renderer-supplied path.
    electron_1.ipcMain.handle('orchestration:read-skill', async (_, args = {}) => {
        const target = args?.target;
        if (typeof target !== 'string' || !skillContent_1.ORCHESTRATION_SKILL_TARGETS.includes(target)) {
            return null;
        }
        return skillsManager.readOrchestrationSkillFile(target);
    });
    // Content-capture consent + retention. config.json is the single source of
    // truth (one writer, one reader path — the standalone CLI reads it without
    // IPC). Toggling capture affects FUTURE runs only (§4.2).
    electron_1.ipcMain.handle('orchestration:get-config', async () => {
        return (0, orchestrationRuns_1.readOrchestrationConfig)();
    });
    electron_1.ipcMain.handle('orchestration:set-config', async (_, args = {}) => {
        const normalized = (0, orchestrationRuns_1.normalizeOrchestrationConfig)(args?.config);
        (0, orchestrationRuns_1.writeOrchestrationConfig)(normalized);
        return normalized;
    });
    // --- Orchestration Dashboard: run records (§4.3, §7). All id-based —
    // main derives + validates every path; no renderer-supplied paths.
    electron_1.ipcMain.handle('orchestration:list-runs', async (_, query = {}) => {
        return orchestrationRunTracker?.list({
            limit: typeof query?.limit === 'number' ? query.limit : undefined,
            agent: typeof query?.agent === 'string' ? query.agent : undefined,
            status: typeof query?.status === 'string' ? query.status : undefined,
            sinceMs: typeof query?.sinceMs === 'number' ? query.sinceMs : undefined,
        }) ?? [];
    });
    electron_1.ipcMain.handle('orchestration:get-run-file', async (_, args = {}) => {
        const file = args?.file;
        if (typeof args?.callId !== 'string' || (file !== 'prompt' && file !== 'output' && file !== 'stderr'))
            return null;
        return orchestrationRunTracker?.readRunFile(args.callId, file) ?? null;
    });
    electron_1.ipcMain.handle('orchestration:delete-run', async (_, args = {}) => {
        if (typeof args?.callId !== 'string')
            return { ok: false, error: 'invalid run id' };
        return orchestrationRunTracker?.deleteRun(args.callId) ?? { ok: false, error: 'tracker unavailable' };
    });
    electron_1.ipcMain.handle('orchestration:clear-runs', async () => {
        return orchestrationRunTracker?.clearRuns() ?? { deleted: 0, skippedRunning: 0 };
    });
    // Export run logs as one shareable zip (selected callIds, or the whole
    // runs/ folder when none are given) + orchestration.log. Same id-based
    // contract as every other run handler: ids are validated here and paths are
    // derived by main — the renderer never supplies one. Save target comes from
    // a native dialog, so the write destination is user-chosen by construction.
    electron_1.ipcMain.handle('orchestration:export-runs', async (_, args = {}) => {
        if (!orchestrationRunTracker)
            return { ok: false, error: 'run tracker unavailable' };
        const callIds = Array.isArray(args.callIds)
            ? [...new Set(args.callIds.filter((id) => typeof id === 'string' && (0, orchestrationRuns_1.isValidRunCallId)(id)))]
            : [];
        const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
        const window = getMainWindow?.() ?? null;
        const saveOptions = {
            title: 'Export orchestration logs',
            defaultPath: path_1.default.join(electron_1.app.getPath('downloads'), `1devtool-orchestration-logs-${stamp}.zip`),
            filters: [{ name: 'Zip archive', extensions: ['zip'] }],
        };
        const { canceled, filePath } = window
            ? await electron_1.dialog.showSaveDialog(window, saveOptions)
            : await electron_1.dialog.showSaveDialog(saveOptions);
        if (canceled || !filePath)
            return { ok: false, canceled: true };
        try {
            const result = await (0, runExport_1.buildRunsExportZip)({
                ...(callIds.length > 0 ? { callIds } : {}),
                logPath: orchestrationRunTracker.getLogPath(),
                appVersion: electron_1.app.getVersion(),
            });
            fs_1.default.writeFileSync(filePath, result.zip);
            electron_1.shell.showItemInFolder(filePath);
            orchestrationRunTracker.log(`export-runs scope=${callIds.length > 0 ? `selected(${callIds.length})` : 'all'} runs=${result.runCount} files=${result.fileCount} -> ${filePath}`);
            return { ok: true, path: filePath, runCount: result.runCount };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    // Mission Control's project-scoped export. The renderer supplies only the
    // project id it is displaying; main re-derives Team/Swarm + terminal-link
    // membership, verifies live local PTYs, and snapshots their bounded buffers.
    // This keeps an old renderer projection from exporting arbitrary terminal
    // ids and makes cross-project links explicit in the archive manifest.
    electron_1.ipcMain.handle('orchestration:export-current-logs', async (event, args = {}) => {
        if (!isMainRenderer(event))
            return { ok: false, error: 'main renderer only' };
        if (!await hasMainRendererGesture(event))
            return { ok: false, error: 'human gesture required' };
        if (typeof args.projectId !== 'string')
            return { ok: false, error: 'invalid project id' };
        const project = storeManager.getProjects().find((item) => item.id === args.projectId);
        if (!project)
            return { ok: false, error: 'project not found' };
        const scope = (0, currentLogExport_1.resolveCurrentLogExportScope)({
            projectId: project.id,
            orchestrations: agentTeamController?.listForRenderer() ?? [],
            links: getLinkRegistry?.()?.listLinks() ?? [],
        });
        if (scope.orchestrationIds.length === 0 && scope.linkIds.length === 0) {
            return { ok: false, error: 'No current orchestration or terminal links were found for this project.' };
        }
        const backend = getPtyBackend?.() ?? null;
        const liveTerminals = backend
            ? scope.terminalIds.flatMap((terminalId) => {
                const location = storeManager.findTerminalLocation(terminalId);
                if (!location || !backend.hasLiveInstance(terminalId))
                    return [];
                return [{ terminalId, location }];
            })
            : [];
        const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
        const window = getMainWindow?.() ?? null;
        const saveOptions = {
            title: 'Export current orchestration logs',
            defaultPath: path_1.default.join(electron_1.app.getPath('downloads'), `1devtool-current-orchestration-${stamp}.zip`),
            filters: [{ name: 'Zip archive', extensions: ['zip'] }],
        };
        const { canceled, filePath } = window
            ? await electron_1.dialog.showSaveDialog(window, saveOptions)
            : await electron_1.dialog.showSaveDialog(saveOptions);
        if (canceled || !filePath)
            return { ok: false, canceled: true };
        try {
            const terminalLogs = await Promise.all(liveTerminals.map(async ({ terminalId, location }) => {
                let content = '';
                let unavailableReason;
                if (!backend?.hasLiveInstance(terminalId)) {
                    unavailableReason = 'terminal stopped before its buffer was captured';
                }
                else {
                    try {
                        content = await backend.getBuffer(terminalId);
                    }
                    catch {
                        unavailableReason = 'terminal buffer could not be read';
                    }
                }
                return {
                    terminalId,
                    terminalName: location.terminal.name || location.terminal.agentType,
                    projectId: location.project.id,
                    projectName: location.project.name,
                    agentType: location.terminal.agentType,
                    content,
                    ...(unavailableReason ? { unavailableReason } : {}),
                };
            }));
            const result = await (0, runExport_1.buildRunsExportZip)({
                callIds: scope.callIds,
                logPath: orchestrationRunTracker?.getLogPath() ?? null,
                appVersion: electron_1.app.getVersion(),
                terminalLogs,
                scope: 'current-orchestration',
                project: { id: project.id, name: project.name },
                orchestrationIds: scope.orchestrationIds,
                linkIds: scope.linkIds,
            });
            await fs_1.default.promises.writeFile(filePath, result.zip);
            electron_1.shell.showItemInFolder(filePath);
            orchestrationRunTracker?.log(`export-current project=${project.id} orchestrations=${scope.orchestrationIds.length} links=${scope.linkIds.length} terminals=${result.terminalCount} runs=${result.runCount} -> ${filePath}`);
            return {
                ok: true,
                path: filePath,
                runCount: result.runCount,
                terminalCount: result.terminalCount,
            };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    });
    // Tail of <userData>/logs/orchestration.log. Fixed id enum — unrelated app
    // logs (updater/entitlement) are deliberately not reachable here (§6.6).
    electron_1.ipcMain.handle('orchestration:read-app-log', async (_, args = {}) => {
        if (args?.id !== 'orchestration')
            return { text: '', truncated: false };
        const logPath = orchestrationRunTracker?.getLogPath();
        if (!logPath)
            return { text: '', truncated: false };
        const maxBytes = Math.min(Math.max(typeof args?.maxBytes === 'number' ? args.maxBytes : 64 * 1024, 1024), 256 * 1024);
        try {
            const { size } = fs_1.default.statSync(logPath);
            const readBytes = Math.min(size, maxBytes);
            const fd = fs_1.default.openSync(logPath, 'r');
            try {
                const buf = Buffer.alloc(readBytes);
                fs_1.default.readSync(fd, buf, 0, readBytes, size - readBytes);
                return { text: buf.toString('utf-8'), truncated: size > readBytes };
            }
            finally {
                fs_1.default.closeSync(fd);
            }
        }
        catch {
            return { text: '', truncated: false };
        }
    });
    // Reveal in Finder via ids only — the generic renderer-supplied-path reveal
    // handler is off-limits under §7's contract.
    electron_1.ipcMain.handle('orchestration:reveal-run-file', async (event, args = {}) => {
        if (!isMainRenderer(event))
            return false;
        if (args?.id === 'orchestration') {
            const logPath = orchestrationRunTracker?.getLogPath();
            if (logPath && fs_1.default.existsSync(logPath)) {
                electron_1.shell.showItemInFolder(logPath);
                return true;
            }
            return false;
        }
        const file = args?.file === 'meta' || args?.file === 'prompt' || args?.file === 'output' || args?.file === 'stderr'
            ? args.file
            : 'meta';
        if (typeof args?.callId !== 'string')
            return false;
        const resolved = orchestrationRunTracker?.resolveRunFile(args.callId, file);
        if (!resolved)
            return false;
        electron_1.shell.showItemInFolder(resolved);
        return true;
    });
    // Dashboard-open lifecycle: polling is the primary refresh while open
    // (§4.3); the renderer subscribes on mount and unsubscribes on close.
    electron_1.ipcMain.handle('orchestration:subscribe-runs', async () => {
        orchestrationRunTracker?.subscribe();
    });
    electron_1.ipcMain.handle('orchestration:unsubscribe-runs', async () => {
        orchestrationRunTracker?.unsubscribe();
    });
    // Per-agent selectable models for @mention delegation. Lazy: the first call
    // (mention picker opening) probes enumerable CLIs and disk-caches the
    // result; `refresh: true` (Settings → AI → Orchestration) forces a re-probe.
    electron_1.ipcMain.handle('orchestration:agent-models', async (_, args = {}) => {
        const registrations = cliRegistry ? cliRegistry.list() : [];
        const overrides = storeManager.getPreferences().aiAgentPaths || {};
        return (0, agentModelCatalog_1.getAgentModelCatalog)(registrations.map((r) => ({ cliId: r.cliId, state: r.state, selectedPath: r.selectedPath })), { refresh: args.refresh === true, codexHome: (0, agentPaths_1.getAgentRoot)('codex', overrides) });
    });
    electron_1.ipcMain.handle('skills:install-via-cli', async (_, args) => {
        return skillsManager.installViaCli(args.source, args.skillId, args.projectPath, args.global);
    });
    electron_1.ipcMain.handle('skills:exists', async (_, args) => {
        return skillsManager.skillExists(args.projectPath, args.skillName, args.tool);
    });
    electron_1.ipcMain.handle('skills:check-update', async (_, args) => {
        return skillsManager.checkForUpdate(args.skill);
    });
    electron_1.ipcMain.handle('skills:get-references', async (_, args) => {
        const { SkillsManager: SM } = await Promise.resolve().then(() => __importStar(require('../skills')));
        return SM.extractReferences(args.content);
    });
    electron_1.ipcMain.handle('skills:get-active', async (_, args) => {
        const active = skillsManager.getActiveSkills(args.projectPath);
        return [...active];
    });
    electron_1.ipcMain.handle('skills:fetch-remote', async (_, args) => {
        return skillsManager.fetchRemoteSkills(args?.query);
    });
    electron_1.ipcMain.handle('skills:fetch-remote-skill', async (_, args) => {
        return skillsManager.fetchRemoteSkill(args.skillPath);
    });
    electron_1.ipcMain.handle('skills:fetch-audited', async () => {
        return skillsManager.fetchAuditedSkills();
    });
    electron_1.ipcMain.handle('skills:watch', async (_, args) => {
        skillsManager.watch(args?.projectPath, () => {
            sendToRenderer('skills:changed');
        });
    });
    electron_1.ipcMain.handle('skills:unwatch', async () => {
        skillsManager.unwatchAll();
    });
}
