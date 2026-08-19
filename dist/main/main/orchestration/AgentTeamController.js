"use strict";
/**
 * Durable control plane for Agent Teams and Swarms.
 *
 * The host plans; this main-process controller owns identity, authorization,
 * claims, reservations, credits, state transitions, prompt submission, and
 * result binding. Every side effect is preceded by a full-state journal
 * commit. Heuristics may update activity copy but never submit or complete a
 * run; terminal completion requires both a post-watermark assistant turn and
 * a generation-current positive empty-composer marker.
 *
 * Terminal safety rules: docs/common-errors/terminals/INDEX.md (A4-A6,
 * B1-B4, B15, C5, C9). Team prompts must stay on the shared staged writer,
 * with skill syntax rendered for the target before submission.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentTeamController = exports.SWARM_SANDBOX_TARGETS = void 0;
exports.unknownMarkerAttentionDelayMs = unknownMarkerAttentionDelayMs;
exports.canonicalizeSwarmManifestBrief = canonicalizeSwarmManifestBrief;
exports.swarmSandboxFlags = swarmSandboxFlags;
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const types_1 = require("../../shared/types");
const agentIdentity_1 = require("../../shared/agentIdentity");
const agentTeams_1 = require("../../shared/agentTeams");
const runtimePolicy_1 = require("../../shared/orchestration/runtimePolicy");
const agentModels_1 = require("../../shared/agentModels");
const agentModels_2 = require("../../shared/agentModels");
const headlessMode_1 = require("../../shared/headlessMode");
const orchestrationPolicy_1 = require("../../shared/orchestrationPolicy");
const orchestrationRuns_1 = require("../../shared/orchestrationRuns");
const contracts_1 = require("../../shared/terminal/contracts");
const interactiveDelegation_1 = require("../../shared/interactiveDelegation");
const TerminalConnectionObserver_1 = require("../terminal-connection/TerminalConnectionObserver");
const runGatedHeadlessAgent_1 = require("./runGatedHeadlessAgent");
const structuredHeadlessOutput_1 = require("./structuredHeadlessOutput");
const processIdentity_1 = require("./processIdentity");
const hookCapability_1 = require("./hookCapability");
const TerminalInputSerializer_1 = require("./TerminalInputSerializer");
const TerminalScreenModel_1 = require("./TerminalScreenModel");
const TeamMessageBus_1 = require("./TeamMessageBus");
const runtimeConfig_1 = require("./runtime/runtimeConfig");
const attention_1 = require("../../shared/orchestration/attention");
const REGISTRY_VERSION = 1;
const TERMINAL_LIVE_DEADLINE_MS = 15_000;
const READINESS_DEADLINE_MS = 30_000;
const READINESS_MIN_OBSERVE_MS = 750;
const READINESS_SCREEN_QUIET_MS = 350;
const UNKNOWN_MARKER_ATTENTION_MS = 5_000;
const WINDOWS_WSL_CURSOR_UNKNOWN_MARKER_ATTENTION_MS = 20_000;
const COMPLETION_SCREEN_QUIET_MS = 2_000;
const COMPLETION_POLL_MS = 750;
const RUN_HEARTBEAT_MS = 20_000;
const DEFAULT_INTERACTIVE_TIMEOUT_S = 600;
const JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
const PROCESS_CLOSE_DEADLINE_MS = 5_000;
const WRITE_WORKTREE_CATEGORIES = new Set(['implement', 'test', 'debug']);
/** Unit states with nothing running and no per-unit recovery affordance.
 * 'fallback' (Retry/Reassign/… buttons) and 'uncertain' (retained
 * reservations awaiting explicit recovery) are deliberately NOT inert. */
const INERT_UNIT_STATES = new Set(['interrupted', 'failed', 'cancelled', 'closed']);
const MANIFEST_TEXT_CAP_CHARS = 200_000;
const VALID_SUBSTRATES = new Set(['auto', 'headless', 'terminal']);
/**
 * A user-configured `agents` command on Windows can be a direct WSL bridge.
 * Cold WSL + Cursor startup regularly takes 10-15 seconds before the first
 * recognizable composer frame, while ordinary native agents paint within the
 * generic five-second unknown-marker window. This grace only postpones the
 * human-confirmation fallback: it never turns time or arbitrary output into a
 * positive readiness signal.
 */
function unknownMarkerAttentionDelayMs(platform, target) {
    if (platform !== 'win32')
        return UNKNOWN_MARKER_ATTENTION_MS;
    const command = target.startupCommand?.trim() ?? '';
    const token = command.match(/^"([^"]+)"|^(\S+)/)?.slice(1).find(Boolean) ?? '';
    const executable = node_path_1.default.win32.basename(token).replace(/\.(?:cmd|ps1|bat|exe)$/i, '').toLowerCase();
    return executable === 'agents'
        ? WINDOWS_WSL_CURSOR_UNKNOWN_MARKER_ATTENTION_MS
        : UNKNOWN_MARKER_ATTENTION_MS;
}
function emptyRegistry() {
    return {
        version: REGISTRY_VERSION,
        sequence: 0,
        teams: {},
        swarms: {},
        runs: {},
        startRequests: {},
        submissions: {},
        claims: {},
        reservations: {},
        credits: {},
    };
}
function stable(value) {
    if (Array.isArray(value))
        return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}
function fingerprint(value) {
    return node_crypto_1.default.createHash('sha256').update(stable(value)).digest('hex');
}
function clone(value) {
    return JSON.parse(JSON.stringify(value));
}
function safeRole(role) {
    if (typeof role !== 'string')
        return undefined;
    const value = role.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    return value || undefined;
}
function isResumeAgentType(value) {
    return ['claude', 'codex', 'gemini', 'kimi', 'amp', 'opencode', 'cline', 'qoder', 'qwen', 'grok', 'hermes', 'cursor', 'pi'].includes(value);
}
function workerCanBeCancelledBeforeAdmission(worker) {
    return worker.state === 'queued';
}
/** A fallback may replay the same run only while both durable projections
 * agree that no prompt byte crossed the submission boundary. Submit-attention
 * is the controller's explicit positive pre-submission state, even though the
 * unit remains visibly in `readiness-test` while awaiting the user's choice. */
function hasProvenPreSubmissionEvidence(run, unit) {
    if (run.submittedAt !== undefined)
        return false;
    if (unit.state === 'fallback' && run.state === 'error')
        return true;
    return run.state === 'pending' &&
        run.needsAttention === true &&
        unit.state === 'readiness-test' &&
        unit.needsAttention === true &&
        unit.attentionKind === 'submit';
}
/**
 * Canonicalize the one field that shipped under two names.
 *
 * `brief` is the durable/public schema. `sharedBrief` is accepted only at
 * this untrusted ingress because older Agent Input nudges described a
 * "shared brief" without pinning the JSON key, and host models emitted that
 * camel-cased phrase. Never retain the alias: equivalent old/new retries must
 * fingerprint to the same manifest.
 */
function canonicalizeSwarmManifestBrief(raw) {
    if (!raw || typeof raw !== 'object')
        return { ok: false, error: 'Swarm brief is required' };
    const input = raw;
    const canonical = input.brief;
    const legacy = input.sharedBrief;
    if (canonical !== undefined && typeof canonical !== 'string') {
        return { ok: false, error: 'Swarm brief must be a string' };
    }
    if (legacy !== undefined && typeof legacy !== 'string') {
        return { ok: false, error: 'Swarm sharedBrief must be a string when provided' };
    }
    const canonicalBrief = typeof canonical === 'string' ? canonical.trim() : '';
    const legacyBrief = typeof legacy === 'string' ? legacy.trim() : '';
    if (canonicalBrief && legacyBrief && canonicalBrief !== legacyBrief) {
        return { ok: false, error: 'Swarm brief and sharedBrief conflict; send only canonical brief' };
    }
    const brief = canonicalBrief || legacyBrief;
    if (!brief)
        return { ok: false, error: 'Swarm brief is required' };
    const { sharedBrief: _legacyBrief, ...canonicalManifest } = input;
    return {
        ok: true,
        manifest: { ...canonicalManifest, brief },
    };
}
/**
 * Safety policy for flat headless Swarm workers.
 *
 * Cursor's print mode is non-interactive. Read workers use its enforced
 * read-only Plan mode; write workers use the bounded Auto-review policy. Both
 * explicitly enable Cursor's command sandbox and trust only the workspace
 * identity prompt. Broad `--force`/`--yolo` approval bypasses stay excluded.
 */
function swarmSandboxFlags(target, profile) {
    if (target === 'codex') {
        return ['--sandbox', profile === 'read' ? 'read-only' : 'workspace-write', '--skip-git-repo-check'];
    }
    if (target === 'claude') {
        return profile === 'read'
            ? ['--allowedTools', 'Read,Glob,Grep']
            : ['--allowedTools', 'Read,Glob,Grep,Write,Edit,Bash'];
    }
    if (target === 'cursor') {
        return profile === 'read'
            ? ['--mode', 'plan', '--sandbox', 'enabled', '--trust']
            : ['--auto-review', '--sandbox', 'enabled', '--trust'];
    }
    return null;
}
/** The targets swarmSandboxFlags can enforce — every other agent is refused
 *  as a headless Swarm worker AT MANIFEST VALIDATION, not per worker, so the
 *  host gets one actionable error instead of N instant silent failures
 *  (docs/common-errors/orchestration/swarm-sandbox-targets-instant-fail.md). */
exports.SWARM_SANDBOX_TARGETS = ['codex', 'claude', 'cursor'];
class AgentTeamController {
    deps;
    homeDir;
    registryPath;
    journalPath;
    defaultConcurrencyLimit;
    registry = emptyRegistry();
    runtimes = new Map();
    waiters = new Map();
    unitChains = new Map();
    initialized = false;
    disposeRuntimeEvents;
    /**
     * Consulted on EVERY fallback resolution, from every ingress, before any
     * action is taken (docs/tasks_v2.md §4.7). Lets an owner of durable run
     * bindings refuse an action that would silently break them — `reassign` on a
     * task-bound run, or `headless`, which strips the terminal identity the MCP
     * loop depends on. A refusal here is enforcement; a hidden button is not.
     */
    fallbackPolicy = null;
    /** Old→new run linkage at the source, so no subscriber has to infer lineage. */
    onFallbackResolved = null;
    stateListeners = new Set();
    inputSerializer;
    messageBus;
    constructor(deps) {
        this.deps = deps;
        this.homeDir = deps.homeDir ?? node_os_1.default.homedir();
        const root = node_path_1.default.join((0, orchestrationRuns_1.getOrchestrationRootDir)(this.homeDir), 'control');
        this.registryPath = node_path_1.default.join(root, 'registry.json');
        this.journalPath = node_path_1.default.join(root, 'journal.jsonl');
        this.defaultConcurrencyLimit = Math.max(1, Math.min(8, deps.concurrencyLimit ?? agentTeams_1.AGENT_ORCHESTRATION_DEFAULT_CONCURRENCY));
        this.inputSerializer = new TerminalInputSerializer_1.TerminalInputSerializer(deps.getPtyBackend, (terminalId, runId, partial) => this.handleLeaseRevocation(terminalId, runId, partial));
        this.messageBus = new TeamMessageBus_1.TeamMessageBus({
            storagePath: node_path_1.default.join(root, 'team-messages.json'),
            deliver: (message) => this.createMessageRun(message),
            validateReadConnection: ({ fromTerminalId, toTerminalId, permission, }) => this.deps.getLinkRegistry?.()
                ?.resolveReadScope(fromTerminalId, toTerminalId, permission).ok === true,
            onChanged: () => this.emitChanged(),
        });
    }
    async initialize() {
        if (this.initialized)
            return;
        this.registry = this.loadRegistry();
        this.messageBus.initialize();
        for (const team of Object.values(this.registry.teams))
            this.registerTeamMessageLedger(team);
        this.disposeRuntimeEvents ??= this.deps.getAgentRuntimeManager?.()?.subscribe((event) => this.handleRuntimeEvent(event));
        await this.reconcile();
        this.sweepInertOrchestrations(true);
        this.initialized = true;
        this.emitChanged();
    }
    // -----------------------------------------------------------------------
    // Public authenticated API
    // -----------------------------------------------------------------------
    async startTeam(principal, raw) {
        await this.initialize();
        if (principal.kind === 'worker')
            return { ok: false, error: 'Swarm workers cannot start an orchestration' };
        const depth = (principal.depth ?? 0) + 1;
        if (depth > 1)
            return { ok: false, error: 'Nested Agent Team depth is limited to 1' };
        const validation = this.validateTeamManifest(raw);
        if (!validation.ok)
            return { ok: false, error: validation.error };
        const manifest = validation.manifest;
        const fp = fingerprint(manifest);
        const requestKey = `team:${principal.projectId}:${manifest.clientRequestId}`;
        const existing = this.registry.startRequests[requestKey];
        if (existing) {
            if (existing.fingerprint !== fp || existing.hostTerminalId !== principal.terminalId) {
                return { ok: false, error: 'clientRequestId was already used with a different Team manifest or host' };
            }
            const team = this.registry.teams[existing.orchestrationId];
            return team
                ? { ok: true, orchestration: clone(team), runs: this.runsFor(team.teamId) }
                : { ok: false, error: 'The idempotent Team record is unavailable' };
        }
        const localMemberCount = manifest.members.filter((member) => !member.deviceId).length;
        if (this.availableReservations() < localMemberCount) {
            return { ok: false, error: this.capacityError(localMemberCount) };
        }
        // Workspace admission (D2): membership resolves ONCE, here. Live group
        // edits after this point never add/remove members or rebind projects.
        let admission = null;
        if (manifest.workspaceId) {
            const resolver = this.deps.resolveWorkspaceAdmission;
            if (!resolver)
                return { ok: false, error: 'Workspace-scoped Teams are not available' };
            const verdict = resolver(manifest.workspaceId, principal.projectId);
            if (!verdict.ok)
                return { ok: false, error: verdict.error };
            admission = verdict;
        }
        // Bind each member to its home project before anything is admitted
        // (D4): declared ∈ workspace resolve, adopted terminals must match their
        // declaration, and a foreign project without workspace authority — or
        // one that does not exist — is a refusal, never a host fallback.
        const store = this.deps.getStoreManager();
        // One config parse for the whole admission loop — store.getProjects()
        // re-parses the config file per call.
        const liveProjectIds = store ? new Set(store.getProjects().map((project) => project.id)) : null;
        const memberProjectIds = [];
        const memberDeviceNames = [];
        for (const memberManifest of manifest.members) {
            if (memberManifest.deviceId) {
                const runtime = this.deps.getFederatedTeamRuntime?.();
                const memberProjectId = memberManifest.projectId;
                if (!runtime)
                    return { ok: false, error: 'Multi-device Team routing is unavailable' };
                const remote = await runtime.validateMember({
                    deviceId: memberManifest.deviceId,
                    projectId: memberProjectId,
                    target: memberManifest.target,
                });
                if (!remote.ok)
                    return { ok: false, error: remote.error };
                memberProjectIds.push(memberProjectId);
                memberDeviceNames.push(remote.deviceName);
                continue;
            }
            const adopted = memberManifest.terminalId
                ? this.adoptableTerminalTarget(memberManifest.terminalId)
                : null;
            if (adopted && !adopted.ok)
                return { ok: false, error: adopted.error };
            const declared = memberManifest.projectId;
            const memberProjectId = declared
                ?? (adopted && adopted.ok ? adopted.projectId : principal.projectId);
            if (adopted && adopted.ok && declared && adopted.projectId !== declared) {
                return { ok: false, error: `"${adopted.name}" belongs to another project than the member's declared projectId` };
            }
            if (admission) {
                if (!admission.resolvedProjectIds.includes(memberProjectId)) {
                    return { ok: false, error: `Member project ${memberProjectId} is not in workspace ${manifest.workspaceId}` };
                }
            }
            else if (declared && declared !== principal.projectId) {
                return { ok: false, error: 'A Team member in another project requires a workspace-scoped manifest' };
            }
            if (memberProjectId !== principal.projectId && !liveProjectIds?.has(memberProjectId)) {
                return { ok: false, error: `Member project ${memberProjectId} no longer exists` };
            }
            memberProjectIds.push(memberProjectId);
            memberDeviceNames.push(undefined);
        }
        const now = Date.now();
        const teamId = node_crypto_1.default.randomUUID();
        const members = [];
        const configuredRuntime = (0, runtimeConfig_1.readOrchestrationRuntimeConfig)(this.homeDir).preferredMode;
        for (const [memberIndex, memberManifest] of manifest.members.entries()) {
            const memberProjectId = memberProjectIds[memberIndex];
            const remoteDeviceId = memberManifest.deviceId;
            const remoteDeviceName = memberDeviceNames[memberIndex];
            const memberId = node_crypto_1.default.randomUUID();
            const substrate = this.resolveSubstrate('team', memberManifest, manifest.defaultSubstrate);
            const runtimePreference = (0, runtimePolicy_1.normalizeRuntimePreference)(memberManifest.runtimePreference ?? manifest.defaultRuntimePreference, memberManifest.substrate ?? manifest.defaultSubstrate);
            const effectiveRuntime = runtimePreference === 'auto' ? configuredRuntime : runtimePreference;
            const run = this.newRun({
                topology: 'team', projectId: memberProjectId, teamId, memberId,
                target: memberManifest.target,
                prompt: remoteDeviceId
                    ? memberManifest.prompt
                    : this.composeMemberPrompt(memberManifest, effectiveRuntime === 'structured'),
                category: memberManifest.category, skill: memberManifest.skill,
                model: memberManifest.model, substrate,
                runtimePreference,
                deviceId: remoteDeviceId,
                deviceName: remoteDeviceName,
            });
            // Allocate terminal identity before returning the admitted Team. The
            // renderer persists/spawns it asynchronously, but dispatch callers need
            // the stable id immediately so a successful Assign click can close the
            // Tasks surface and navigate to the terminal. This is identity
            // allocation, not a claim that the PTY is live.
            const terminalId = remoteDeviceId ? undefined : memberManifest.terminalId ??
                (substrate === 'terminal' ? node_crypto_1.default.randomUUID() : undefined);
            if (terminalId)
                run.terminalId = terminalId;
            this.registry.runs[run.runId] = run;
            const reservationId = remoteDeviceId ? undefined : this.reserve(memberId, memberProjectId);
            members.push({
                id: memberId,
                role: safeRole(memberManifest.role),
                target: memberManifest.target,
                projectId: memberProjectId,
                ...(remoteDeviceId ? { deviceId: remoteDeviceId, deviceName: remoteDeviceName } : {}),
                state: 'queued',
                substrate,
                runtimePreference: run.runtimePreference,
                runIds: [run.runId],
                currentRunId: run.runId,
                ...(terminalId ? { terminalId } : {}),
                ...(memberManifest.terminalId ? { adoptedTerminal: true } : {}),
                ...(memberManifest.startupPresetId ? { startupPresetId: memberManifest.startupPresetId } : {}),
                ...(reservationId ? { reservationId } : {}),
                worktreeRequired: Boolean(memberManifest.category && WRITE_WORKTREE_CATEGORIES.has(memberManifest.category) && !memberManifest.sharedCwd),
                activity: 'Queued',
            });
        }
        const team = {
            topology: 'team', teamId, projectId: principal.projectId,
            hostTerminalId: principal.terminalId, clientRequestId: manifest.clientRequestId,
            manifestFingerprint: fp, depth, state: 'admitting', createdAt: now, updatedAt: now,
            closeTerminalsOnStop: manifest.closeTerminalsOnStop === true,
            ...(manifest.workspaceId && admission
                ? {
                    workspaceId: manifest.workspaceId,
                    admittedProjectIds: admission.resolvedProjectIds,
                    admittedWorkspaceGeneration: admission.membershipGeneration,
                }
                : {}),
            members,
        };
        this.registry.teams[teamId] = team;
        this.registry.startRequests[requestKey] = {
            topology: 'team', clientRequestId: manifest.clientRequestId, projectId: principal.projectId,
            hostTerminalId: principal.terminalId, fingerprint: fp, orchestrationId: teamId,
        };
        this.commit('team-start-intent');
        this.registerTeamMessageLedger(team);
        for (const member of members)
            this.writeRunRecord(this.registry.runs[member.currentRunId]);
        team.state = 'active';
        team.updatedAt = Date.now();
        this.commit('team-admitted');
        members.forEach((member, index) => {
            setTimeout(() => this.enqueueUnit(teamId, member.id), index * 400).unref?.();
        });
        return { ok: true, orchestration: clone(team), runs: this.runsFor(teamId) };
    }
    async startSwarm(principal, raw) {
        await this.initialize();
        if (principal.kind === 'worker')
            return { ok: false, error: 'Swarm workers cannot start an orchestration' };
        const depth = (principal.depth ?? 0) + 1;
        if (depth > 1)
            return { ok: false, error: 'Nested Agent Swarm depth is limited to 1' };
        const validation = this.validateSwarmManifest(raw);
        if (!validation.ok)
            return { ok: false, error: validation.error };
        const manifest = validation.manifest;
        const fp = fingerprint(manifest);
        const requestKey = `swarm:${principal.projectId}:${manifest.clientRequestId}`;
        const existing = this.registry.startRequests[requestKey];
        if (existing) {
            if (existing.fingerprint !== fp || existing.hostTerminalId !== principal.terminalId) {
                return { ok: false, error: 'clientRequestId was already used with a different Swarm manifest or host' };
            }
            const swarm = this.registry.swarms[existing.orchestrationId];
            return swarm
                ? { ok: true, orchestration: clone(swarm), runs: this.runsFor(swarm.swarmId) }
                : { ok: false, error: 'The idempotent Swarm record is unavailable' };
        }
        const poolSize = Math.min(manifest.poolSize ?? agentTeams_1.AGENT_SWARM_DEFAULT_POOL, manifest.count, this.capacityLimit());
        if (this.availableReservations() < Math.min(poolSize, manifest.count)) {
            return { ok: false, error: this.capacityError(Math.min(poolSize, manifest.count)) };
        }
        // Workspace correlation only in v1 — workers still run in the host
        // project — but admission (caller ∈ live resolve, non-archived) is the
        // same gate Teams use (D2).
        let swarmAdmission = null;
        if (manifest.workspaceId) {
            const resolver = this.deps.resolveWorkspaceAdmission;
            if (!resolver)
                return { ok: false, error: 'Workspace-scoped Swarms are not available' };
            const verdict = resolver(manifest.workspaceId, principal.projectId);
            if (!verdict.ok)
                return { ok: false, error: verdict.error };
            swarmAdmission = verdict;
        }
        const now = Date.now();
        const swarmId = node_crypto_1.default.randomUUID();
        const workers = [];
        for (let index = 0; index < manifest.count; index++) {
            const workerId = node_crypto_1.default.randomUUID();
            const target = manifest.targets[index % manifest.targets.length];
            const substrate = this.resolveSubstrate('swarm', manifest, manifest.substrate);
            const prompt = manifest.skill
                ? (0, interactiveDelegation_1.buildInteractiveDelegationPrompt)(manifest.brief, target, manifest.skill)
                : manifest.brief;
            const run = this.newRun({
                topology: 'swarm', projectId: principal.projectId, swarmId, workerId,
                target, prompt, category: manifest.category, model: manifest.model, substrate,
                runtimePreference: (0, runtimePolicy_1.normalizeRuntimePreference)(manifest.runtimePreference, manifest.substrate),
            });
            this.registry.runs[run.runId] = run;
            workers.push({
                id: workerId, target, state: 'queued', substrate, runIds: [run.runId],
                runtimePreference: run.runtimePreference,
                currentRunId: run.runId, activity: 'Queued',
                worktreeRequired: manifest.sandbox === 'write',
            });
        }
        const swarm = {
            topology: 'swarm', swarmId, projectId: principal.projectId,
            hostTerminalId: principal.terminalId, clientRequestId: manifest.clientRequestId,
            manifestFingerprint: fp, depth, state: 'admitting', createdAt: now, updatedAt: now,
            ...(manifest.workspaceId && swarmAdmission
                ? {
                    workspaceId: manifest.workspaceId,
                    admittedProjectIds: swarmAdmission.resolvedProjectIds,
                    admittedWorkspaceGeneration: swarmAdmission.membershipGeneration,
                }
                : {}),
            poolSize, budget: manifest.budget ?? manifest.count, spentCredits: 0, poolPaused: false, workers,
            manifest,
        };
        this.registry.swarms[swarmId] = swarm;
        this.registry.startRequests[requestKey] = {
            topology: 'swarm', clientRequestId: manifest.clientRequestId, projectId: principal.projectId,
            hostTerminalId: principal.terminalId, fingerprint: fp, orchestrationId: swarmId,
        };
        this.commit('swarm-start-intent');
        for (const worker of workers)
            this.writeRunRecord(this.registry.runs[worker.currentRunId]);
        swarm.state = 'active';
        swarm.updatedAt = Date.now();
        this.commit('swarm-admitted');
        this.pumpSwarm(swarmId, manifest);
        return { ok: true, orchestration: clone(swarm), runs: this.runsFor(swarmId) };
    }
    async setSwarmPaused(principal, swarmId, paused) {
        await this.initialize();
        const swarm = this.registry.swarms[swarmId];
        if (!swarm || !this.authorized(principal, swarm)) {
            return { ok: false, error: 'Swarm is not available to this host/project' };
        }
        if (swarm.state !== 'active') {
            return { ok: false, error: `Swarm pool cannot be ${paused ? 'paused' : 'resumed'} while ${swarm.state}` };
        }
        if (Boolean(swarm.poolPaused) === paused) {
            return { ok: true, orchestration: clone(swarm) };
        }
        swarm.poolPaused = paused;
        swarm.updatedAt = Date.now();
        for (const worker of swarm.workers) {
            if (worker.state === 'queued')
                worker.activity = paused ? 'Waiting · pool paused' : 'Queued';
        }
        this.commit(paused ? 'swarm-pool-paused' : 'swarm-pool-resumed');
        if (!paused)
            this.pumpSwarm(swarm.swarmId, swarm.manifest);
        return { ok: true, orchestration: clone(swarm) };
    }
    async send(principal, request) {
        await this.initialize();
        const team = this.registry.teams[request.teamId];
        if (!team)
            return { ok: false, error: 'Team is not available to this host/project' };
        const messagePrincipal = this.teamMessagePrincipal(principal);
        const result = await this.messageBus.send(messagePrincipal, {
            teamId: request.teamId,
            toMemberId: request.memberId,
            clientSubmissionId: request.submissionId,
            body: request.prompt,
            kind: 'follow-up',
        });
        const run = result.message?.destinationRunId ? this.registry.runs[result.message.destinationRunId] : undefined;
        return result.ok && run
            ? { ok: true, run: this.publicRun(run) }
            : { ok: false, error: result.error ?? 'Team message did not create a destination run' };
    }
    listTeams(principal) {
        const messagePrincipal = this.teamMessagePrincipal(principal);
        const ids = new Set(this.messageBus.listTeamIds(messagePrincipal));
        return Object.values(this.registry.teams).filter((team) => ids.has(team.teamId)).map(clone);
    }
    teamMembers(principal, teamId) {
        const team = this.registry.teams[teamId];
        if (team)
            this.registerTeamMessageLedger(team);
        return this.messageBus.members(this.teamMessagePrincipal(principal), teamId);
    }
    teamConnections(principal, teamId) {
        const connections = this.messageBus.connections(this.teamMessagePrincipal(principal), teamId);
        if (!connections)
            return null;
        const team = this.registry.teams[teamId];
        const linkRegistry = this.deps.getLinkRegistry?.();
        if (!team || !linkRegistry)
            return connections;
        // Team and ad-hoc reads are one endpoint graph. Keep Team message
        // permissions in TeamMessageBus, then project every consented read grant
        // between the same member terminals onto the Team edge returned to
        // callers. There is deliberately no second Team read-consent database.
        const byEdge = new Map(connections.map((connection) => [
            `${connection.fromMemberId}\u0000${connection.toMemberId}`,
            { ...connection, permissions: [...connection.permissions] },
        ]));
        const memberByTerminal = new Map(team.members
            .filter((member) => Boolean(member.terminalId))
            .map((member) => [member.terminalId, member]));
        for (const from of memberByTerminal.values()) {
            for (const peer of linkRegistry.readablePeers(from.terminalId)) {
                if (peer.suspended)
                    continue;
                const to = memberByTerminal.get(peer.targetTerminalId);
                if (!to || to.id === from.id)
                    continue;
                const key = `${from.id}\u0000${to.id}`;
                const existing = byEdge.get(key);
                const permissions = [
                    ...new Set([
                        ...(existing?.permissions ?? []),
                        ...peer.permissions,
                    ]),
                ];
                byEdge.set(key, {
                    teamId,
                    fromMemberId: from.id,
                    toMemberId: to.id,
                    permissions,
                });
            }
        }
        return [...byEdge.values()];
    }
    /**
     * Structure-only discovery for the peer-authenticated Team pull surface.
     * Only the attributed member's outbound, consented read edges are exposed;
     * the rest of the Team roster is not a discovery oracle.
     */
    teamReadPeers(principal, teamId) {
        const context = this.teamReadContext(principal, teamId);
        const linkRegistry = this.deps.getLinkRegistry?.();
        if (!context || !linkRegistry)
            return null;
        const memberByTerminal = new Map(context.team.members
            .filter((member) => Boolean(member.terminalId))
            .map((member) => [member.terminalId, member]));
        return linkRegistry
            .readablePeers(context.caller.terminalId)
            .flatMap((peer) => {
            const target = memberByTerminal.get(peer.targetTerminalId);
            if (!target)
                return [];
            return [{
                    targetMemberId: target.id,
                    displayName: target.role || target.target,
                    agentId: target.target,
                    permissions: peer.permissions,
                    ...(peer.suspended ? { suspended: true } : {}),
                }];
        });
    }
    /**
     * Resolve a Team member selector to the same generation/session-bound
     * terminal endpoint used by LinkRegistry. Caller identity remains the
     * transport-derived terminal; targetMemberId is only a selector.
     */
    teamReadTarget(principal, teamId, targetMemberId) {
        const context = this.teamReadContext(principal, teamId);
        if (!context)
            return null;
        const target = context.team.members.find((member) => member.id === targetMemberId && Boolean(member.terminalId));
        if (!target?.terminalId)
            return null;
        return {
            callerTerminalId: context.caller.terminalId,
            targetTerminalId: target.terminalId,
        };
    }
    setTeamConnections(principal, teamId, connections) {
        return this.messageBus.setConnections(this.teamMessagePrincipal(principal), teamId, connections);
    }
    teamMessages(principal, teamId, cursor = 0, limit = 50) {
        return this.messageBus.messages(this.teamMessagePrincipal(principal), teamId, cursor, limit);
    }
    async sendTeamMessage(principal, input) {
        await this.initialize();
        return this.messageBus.send(this.teamMessagePrincipal(principal), input);
    }
    async askTeamMember(principal, input, timeoutMs = 0) {
        await this.initialize();
        const result = await this.messageBus.send(this.teamMessagePrincipal(principal), { ...input, kind: 'question' });
        if (!result.ok || !result.message?.destinationRunId)
            return result;
        const collected = await this.collectRunForMessage(result.message.destinationRunId, timeoutMs);
        const message = this.messageBus.findMessage(this.teamMessagePrincipal(principal), result.message.messageId) ?? result.message;
        return {
            ok: collected.ok || collected.stillRunning === true,
            message,
            output: collected.output,
            stillRunning: collected.stillRunning,
            error: collected.error,
        };
    }
    async replyTeamMessage(principal, messageId, submissionId, prompt) {
        await this.initialize();
        return this.messageBus.reply(this.teamMessagePrincipal(principal), messageId, submissionId, prompt);
    }
    resumeTeamMemberAutomation(principal, teamId, memberId) {
        const team = this.registry.teams[teamId];
        const member = team?.members.find((item) => item.id === memberId);
        if (!team || !member)
            return { ok: false, error: 'Team member is unavailable' };
        const result = this.messageBus.resumeMember(this.teamMessagePrincipal(principal), teamId, memberId);
        if (result.ok) {
            member.userControlled = false;
            if (!member.currentRunId && member.terminalId) {
                member.state = 'ready';
                member.activity = 'Idle Team member';
            }
            this.commit('team-member-automation-resumed');
        }
        return result;
    }
    runtimeEvents(principal, runId, epoch, afterSeq = 0) {
        const run = this.registry.runs[runId];
        if (!run?.runtimeSessionId || !this.authorizedRun(principal, run))
            return null;
        return this.deps.getAgentRuntimeManager?.()?.events(run.runtimeSessionId, epoch, afterSeq) ?? null;
    }
    async resolveRuntimeInteraction(principal, args) {
        const run = this.registry.runs[args.runId];
        if (!run?.runtimeSessionId || !run.runtimeTurnId || !this.authorizedRun(principal, run)) {
            return { ok: false, error: 'Structured interaction is unavailable' };
        }
        const manager = this.deps.getAgentRuntimeManager?.();
        if (!manager)
            return { ok: false, error: 'Structured runtime manager is unavailable' };
        try {
            await manager.resolveInteraction({
                sessionId: run.runtimeSessionId,
                turnId: run.runtimeTurnId,
                interactionId: args.interactionId,
                capabilityToken: args.capabilityToken,
                decision: args.decision,
                answer: args.answer,
                answers: args.answers,
            });
            run.needsInput = false;
            const unit = this.findUnit(run);
            if (unit) {
                unit.needsInput = false;
                unit.activity = 'Working';
            }
            this.writeRunRecord(run);
            this.commit('runtime-interaction-resolved');
            return { ok: true };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
    status(principal, orchestrationId) {
        const item = this.findOrchestrationById(orchestrationId);
        if (!item || !this.authorized(principal, item))
            return null;
        return clone(item);
    }
    /** Renderer/user-only cross-project listing. Never expose this through a CLI route. */
    listForRenderer() {
        return [...Object.values(this.registry.teams), ...Object.values(this.registry.swarms)]
            .filter((item) => item.state !== 'closed' || (item.topology === 'swarm' && item.workers.some((worker) => worker.promotable)))
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map(clone);
    }
    /** Auto-close orchestrations that survive only as husks of a previous run:
     * every unit is inert, no run is in flight, and nothing awaits the user.
     * Restart reconciliation and readiness failures otherwise strand such Teams
     * in `active` forever, cluttering the dashboard with rows whose only
     * meaningful action is Stop. A user-controlled member whose terminal claim
     * is still live is NOT inert — Resume automation genuinely works there.
     * `includeStopping` is boot-only: mid-session a `stopping` item belongs to
     * an in-flight stop() that must keep sole authority over its reservations. */
    sweepInertOrchestrations(includeStopping = false) {
        const backend = this.deps.getPtyBackend();
        let swept = false;
        for (const item of [...Object.values(this.registry.teams), ...Object.values(this.registry.swarms)]) {
            if (item.state !== 'active' && !(includeStopping && item.state === 'stopping'))
                continue;
            const units = item.topology === 'team' ? item.members : item.workers;
            if (units.length === 0)
                continue;
            const orchestrationId = item.topology === 'team' ? item.teamId : item.swarmId;
            const inert = units.every((unit) => {
                if (!INERT_UNIT_STATES.has(unit.state))
                    return false;
                if (unit.needsAttention || unit.needsInput)
                    return false;
                const run = unit.currentRunId ? this.registry.runs[unit.currentRunId] : undefined;
                if (run && !(0, agentTeams_1.isTerminalState)(run.state))
                    return false;
                const claim = unit.terminalId ? this.registry.claims[unit.terminalId] : undefined;
                if (unit.userControlled && unit.terminalId &&
                    claim?.orchestrationId === orchestrationId && claim.unitId === unit.id &&
                    backend?.hasLiveInstance(unit.terminalId)) {
                    return false;
                }
                return true;
            });
            if (!inert)
                continue;
            for (const unit of units) {
                if (unit.state === 'closed')
                    continue;
                this.releaseUnitResources(item, unit);
                unit.state = 'closed';
            }
            item.state = 'closed';
            swept = true;
        }
        if (swept)
            this.commit('inert-orchestration-sweep');
        return swept;
    }
    /** Derive authority from durable terminal membership. A caller cannot turn
     * a Swarm worker into a host by claiming a different terminal id. */
    principalForTerminal(terminalId, projectId) {
        const claim = this.registry.claims[terminalId];
        if (!claim)
            return { terminalId, projectId, kind: 'host', depth: 0 };
        const swarm = this.registry.swarms[claim.orchestrationId];
        if (swarm)
            return { terminalId, projectId, kind: 'worker', depth: swarm.depth };
        const team = this.registry.teams[claim.orchestrationId];
        if (team)
            return { terminalId, projectId, kind: 'team-member', depth: team.depth };
        return { terminalId, projectId, kind: 'host', depth: 0 };
    }
    async reportNativeEvent(principal, event) {
        await this.initialize();
        const run = this.registry.runs[event.runId];
        if (!run || run.projectId !== principal.projectId || run.terminalId !== principal.terminalId) {
            return { ok: false, error: 'Native event is not bound to this terminal' };
        }
        const expected = Buffer.from(run.capabilityToken);
        const supplied = Buffer.from(event.capabilityToken);
        if (expected.length !== supplied.length || !node_crypto_1.default.timingSafeEqual(expected, supplied)) {
            return { ok: false, error: 'Native event capability is invalid' };
        }
        if (event.sessionId && run.sessionId && event.sessionId !== run.sessionId) {
            return { ok: false, error: 'Native event session does not match the bound run' };
        }
        if (event.sessionId && !run.sessionId)
            run.sessionId = event.sessionId;
        const unit = this.findUnit(run);
        if (event.event === 'needs-input') {
            if (run.state !== 'running')
                return { ok: false, error: 'Run is not active' };
            run.needsInput = true;
            if (unit) {
                unit.needsInput = true;
                unit.activity = 'Waiting for your input';
            }
            this.writeRunRecord(run);
            this.commit('native-needs-input');
            return { ok: true };
        }
        if (run.state !== 'running' && run.state !== 'done-candidate') {
            return (0, agentTeams_1.isTerminalState)(run.state) ? { ok: true } : { ok: false, error: 'Run is not active' };
        }
        run.state = 'done-candidate';
        run.needsInput = false;
        if (unit) {
            unit.needsInput = false;
            unit.activity = 'Finalizing result…';
        }
        this.writeRunRecord(run);
        this.commit('native-done-candidate');
        let output = event.output?.trim() || null;
        for (let attempt = 0; !output && attempt < 15; attempt++) {
            output = await this.extractBoundResult(run);
            if (!output)
                await new Promise((resolve) => setTimeout(resolve, 200));
        }
        if (output) {
            this.finishRun(run, 'done', output);
            return { ok: true };
        }
        run.state = 'needs-confirmation';
        run.error = 'Agent reported completion, but its correlated transcript result did not flush in time';
        if (unit) {
            unit.needsAttention = true;
            unit.attentionKind = 'completion';
            unit.activity = 'Completion needs confirmation';
        }
        this.disposeRuntime(run.runId);
        this.clearNativeHook(run);
        this.writeRunRecord(run);
        this.commit('native-done-needs-confirmation');
        this.notifyWaiters(run.runId);
        return { ok: true };
    }
    async collectRun(principal, runId, timeoutMs = 0) {
        await this.initialize();
        const run = this.registry.runs[runId];
        if (!run || !this.authorizedRun(principal, run))
            return { ok: false, error: 'Run is not available to this host/project' };
        if (!(0, agentTeams_1.isTerminalState)(run.state) && timeoutMs > 0)
            await this.waitForRun(runId, timeoutMs);
        const current = this.registry.runs[runId];
        if (!(0, agentTeams_1.isTerminalState)(current.state)) {
            return {
                ok: true, state: current.state, stillRunning: true,
                needsConfirmation: current.state === 'needs-confirmation', run: this.publicRun(current),
            };
        }
        return {
            ok: current.state === 'done', state: current.state, output: current.output,
            error: current.error, run: this.publicRun(current),
        };
    }
    async collectSwarm(principal, swarmId, cursor = 0, limit = 20) {
        await this.initialize();
        const swarm = this.registry.swarms[swarmId];
        if (!swarm || !this.authorized(principal, swarm))
            return { ok: false, error: 'Swarm is not available to this host/project' };
        const page = swarm.workers.slice(Math.max(0, cursor), Math.max(0, cursor) + Math.min(Math.max(limit, 1), 50));
        let aggregate = 0;
        const results = page.map((worker) => {
            const run = this.registry.runs[worker.currentRunId ?? worker.runIds[worker.runIds.length - 1]];
            const output = run.output
                ? (0, orchestrationRuns_1.truncateChars)(run.output, Math.max(0, agentTeams_1.AGENT_ORCHESTRATION_AGGREGATE_CAP_CHARS - aggregate)).text
                : undefined;
            aggregate += output?.length ?? 0;
            return { workerId: worker.id, runId: run.runId, state: run.state, output, error: run.error };
        });
        const nextCursor = cursor + page.length < swarm.workers.length ? cursor + page.length : undefined;
        return { ok: true, state: swarm.state, stillRunning: swarm.state !== 'closed', results, nextCursor };
    }
    async promoteSwarmWorker(principal, swarmId, workerId, 
    /** Only a human-origin caller (Mission Control click) may steal workspace
     *  focus; the agent bridge route defaults to a background promotion. */
    opts = {}) {
        await this.initialize();
        const swarm = this.registry.swarms[swarmId];
        if (!swarm || !this.authorized(principal, swarm))
            return { ok: false, error: 'Swarm is not available' };
        const worker = swarm.workers.find((item) => item.id === workerId);
        const sourceRun = worker?.currentRunId
            ? this.registry.runs[worker.currentRunId]
            : worker?.runIds.length ? this.registry.runs[worker.runIds[worker.runIds.length - 1]] : undefined;
        if (!worker || !sourceRun || sourceRun.state !== 'done' || sourceRun.substrate !== 'headless' ||
            !sourceRun.sessionId || !isResumeAgentType(sourceRun.target) || !sourceRun.promotable) {
            return { ok: false, error: 'This worker has no exact, flushed native session to promote' };
        }
        if (this.runtimes.has(sourceRun.runId) || worker.pid) {
            return { ok: false, error: 'The worker process has not fully closed yet' };
        }
        const resume = this.deps.getResumeManager();
        if (!resume)
            return { ok: false, error: 'Session resume is unavailable' };
        try {
            if (!await resume.getSessionDetail(sourceRun.target, sourceRun.sessionId)) {
                return { ok: false, error: 'The captured native session has not flushed to disk' };
            }
        }
        catch {
            return { ok: false, error: 'The captured native session could not be verified' };
        }
        let team = worker.promotedTeamId ? this.registry.teams[worker.promotedTeamId] : undefined;
        let member = team && worker.promotedMemberId
            ? team.members.find((item) => item.id === worker.promotedMemberId)
            : undefined;
        if (!team || !member) {
            const reservationId = this.reserve(`promotion:${worker.id}`, swarm.projectId);
            if (!reservationId)
                return { ok: false, error: this.capacityError(1) };
            const teamId = node_crypto_1.default.randomUUID();
            const memberId = node_crypto_1.default.randomUUID();
            const terminalId = node_crypto_1.default.randomUUID();
            member = {
                id: memberId,
                role: `Promoted ${safeRole(worker.role) ?? worker.target}`,
                target: worker.target,
                state: 'provisioning',
                substrate: 'terminal',
                runIds: [],
                terminalId,
                reservationId,
                worktreePath: worker.worktreePath,
                worktreeBranch: worker.worktreeBranch,
                activity: 'Opening captured session…',
            };
            const now = Date.now();
            team = {
                topology: 'team', teamId, projectId: swarm.projectId,
                hostTerminalId: swarm.hostTerminalId,
                clientRequestId: `promotion:${sourceRun.runId}`,
                manifestFingerprint: fingerprint({ sourceRunId: sourceRun.runId, sessionId: sourceRun.sessionId }),
                depth: swarm.depth, state: 'admitting', createdAt: now, updatedAt: now,
                members: [member],
            };
            this.registry.teams[teamId] = team;
            this.registry.claims[terminalId] = { orchestrationId: teamId, unitId: memberId };
            worker.promotedTeamId = teamId;
            worker.promotedMemberId = memberId;
            this.commit('swarm-promotion-intent');
        }
        else {
            member.state = 'provisioning';
            member.activity = 'Retrying captured session…';
            delete member.error;
            this.commit('swarm-promotion-retry-intent');
        }
        const command = resume.getResumeCommand(sourceRun.target, sourceRun.sessionId).trim();
        if (!command)
            return { ok: false, error: `${sourceRun.target} does not support native resume` };
        const created = await this.deps.createTerminal({
            projectId: swarm.projectId,
            terminalId: member.terminalId,
            agentType: sourceRun.target,
            name: `Promoted ${sourceRun.target}`,
            command,
            worktreePath: member.worktreePath && node_fs_1.default.existsSync(member.worktreePath) ? member.worktreePath : undefined,
            lastSessionId: sourceRun.sessionId,
            lastSessionAgentType: sourceRun.target,
            focusWindow: opts.focusWindow === true,
        });
        if (!created.ok || created.terminalId !== member.terminalId) {
            team.state = 'active';
            member.state = 'uncertain';
            member.activity = 'Promotion needs attention';
            member.error = created.error ?? 'The promoted terminal creation was not confirmed';
            this.commit('swarm-promotion-unconfirmed');
            return { ok: false, teamId: team.teamId, memberId: member.id, terminalId: member.terminalId, error: member.error };
        }
        team.state = 'active';
        member.state = 'ready';
        member.activity = 'Captured session ready';
        worker.promotable = false;
        sourceRun.promotable = false;
        this.commit('swarm-promotion-complete');
        return { ok: true, teamId: team.teamId, memberId: member.id, terminalId: member.terminalId };
    }
    async confirmQueuedSubmit(principal, runId) {
        await this.initialize();
        const run = this.registry.runs[runId];
        if (!run || !this.authorizedRun(principal, run))
            return { ok: false, error: 'Run is not available' };
        if (!run.terminalId || !run.needsAttention || run.state !== 'pending') {
            return { ok: false, error: 'Run is not waiting for mediated submit confirmation' };
        }
        run.needsAttention = false;
        const unit = this.findUnit(run);
        if (unit) {
            unit.needsAttention = false;
            delete unit.attentionKind;
        }
        this.commit('mediated-submit-confirmed');
        void this.submitTerminalRun(run, true);
        return { ok: true };
    }
    async resolveConfirmation(principal, runId, outcome) {
        await this.initialize();
        const run = this.registry.runs[runId];
        if (!run || !this.authorizedRun(principal, run) || run.state !== 'needs-confirmation') {
            return { ok: false, error: 'Run is not waiting for completion confirmation' };
        }
        if (outcome === 'done') {
            const output = await this.extractBoundResult(run);
            if (!output)
                return { ok: false, error: 'No correlated assistant result is available for this run' };
            this.finishRun(run, 'done', output);
        }
        else {
            this.finishRun(run, outcome, undefined, outcome === 'error' ? 'Marked failed by the user' : 'Cancelled by the user');
        }
        return { ok: true };
    }
    async resolveFallback(principal, request) {
        await this.initialize();
        const run = this.registry.runs[request.runId];
        if (!run || !this.authorizedRun(principal, run))
            return { ok: false, error: 'Run is not available' };
        const orchestration = this.findOrchestration(run);
        const unit = this.findUnit(run);
        if (!orchestration || !unit || !hasProvenPreSubmissionEvidence(run, unit)) {
            return { ok: false, error: 'Only a proven pre-submission fallback can use this action' };
        }
        // Fallback policy hook (docs/tasks_v2.md §4.7). It lives HERE, not in a
        // caller-side façade, because both ingress paths — the Mission Control IPC
        // and a direct loopback bridge call — reach this method directly, and a
        // sheet that hides an option is presentation, not enforcement. Consulted
        // BEFORE any action: `reassign` creates and queues a replacement
        // immediately, so a post-hoc refusal would leave unbound work already
        // running while a fresh assignment dispatched a duplicate.
        const verdict = this.fallbackPolicy?.({
            action: request.action,
            runId: run.runId,
            target: request.target ?? unit.target,
            promptFingerprint: run.promptFingerprint,
        });
        if (verdict && !verdict.ok)
            return { ok: false, error: verdict.error };
        if (request.action === 'headless') {
            if (orchestration.topology !== 'team' || unit.substrate !== 'terminal') {
                return { ok: false, error: 'Headless fallback is only available for a Team terminal member' };
            }
            if ((run.category && orchestrationPolicy_1.INTRINSIC_TERMINAL_SKILLS[run.category]) || /^\s*\//.test(run.prompt)) {
                return { ok: false, error: 'This run requires an interactive skill and cannot be downgraded to headless' };
            }
            const priorState = unit.state;
            const priorActivity = unit.activity;
            unit.state = 'rebinding';
            unit.activity = 'Rebinding to headless…';
            this.commit('fallback-headless-rebind-intent');
            // Readiness observers own no process. Retire them before replacing this
            // run's runtime with the gated headless child; otherwise Stop mistakes a
            // stale listener for a live delegate and the listener itself leaks.
            this.disposeRuntime(run.runId);
            const closed = await this.closeFallbackTerminal(orchestration, unit);
            if (!closed.ok) {
                unit.state = priorState;
                unit.activity = priorActivity;
                this.commit('fallback-headless-rebind-close-unconfirmed');
                return closed;
            }
            unit.substrate = 'headless';
            run.substrate = 'headless';
            run.state = 'pending';
            delete run.completedAt;
            delete run.error;
            delete run.needsAttention;
            delete unit.error;
            delete unit.needsAttention;
            delete unit.attentionKind;
            this.commit('fallback-headless-rebound');
            void this.runHeadlessUnit(orchestration, unit, run, false);
            return { ok: true, run: this.publicRun(run) };
        }
        if (request.action === 'retry' || request.action === 'reassign') {
            const target = request.action === 'reassign' ? request.target : unit.target;
            if (!target || !headlessMode_1.HEADLESS_SPECS[target])
                return { ok: false, error: 'A valid replacement agent is required' };
            if (orchestration.topology === 'team' && !unit.reservationId) {
                unit.reservationId = this.reserve(unit.id, this.unitProjectId(orchestration, unit));
                if (!unit.reservationId)
                    return { ok: false, error: this.capacityError(1) };
            }
            this.commit(request.action === 'retry' ? 'fallback-retry-close-intent' : 'fallback-reassign-close-intent');
            const closed = await this.closeFallbackTerminal(orchestration, unit);
            if (!closed.ok)
                return closed;
            run.state = 'cancelled';
            run.completedAt = Date.now();
            run.error = request.action === 'retry' ? 'Superseded by explicit retry' : `Explicitly reassigned to ${target}`;
            this.writeRunRecord(run);
            this.notifyWaiters(run.runId);
            if (orchestration.topology === 'swarm')
                this.releaseUnitProcessResources(unit);
            const replacement = this.newRun({
                topology: orchestration.topology,
                projectId: orchestration.projectId,
                ...(orchestration.topology === 'team'
                    ? { teamId: orchestration.teamId, memberId: unit.id }
                    : { swarmId: orchestration.swarmId, workerId: unit.id }),
                target,
                prompt: run.prompt,
                category: run.category,
                model: run.model,
                substrate: unit.substrate,
                runtimePreference: run.runtimePreference,
            });
            this.registry.runs[replacement.runId] = replacement;
            unit.target = target;
            unit.runIds.push(replacement.runId);
            unit.currentRunId = replacement.runId;
            unit.state = 'queued';
            unit.activity = request.action === 'retry' ? 'Queued retry' : `Queued for ${target}`;
            delete unit.error;
            this.commit(request.action === 'retry' ? 'fallback-retry-created' : 'fallback-reassign-created');
            // The old→new linkage, reported at the source. A subscriber that needs
            // continuity (Tasks binding its runs) must never infer it by diffing
            // snapshots: "the unit's next run" may be unrelated work.
            this.onFallbackResolved?.({
                action: request.action,
                oldRunId: run.runId,
                replacementRunId: replacement.runId,
                target,
                promptFingerprint: replacement.promptFingerprint,
            });
            this.writeRunRecord(replacement);
            if (orchestration.topology === 'team')
                this.enqueueUnit(orchestration.teamId, unit.id);
            else
                this.pumpSwarm(orchestration.swarmId, orchestration.manifest);
            return { ok: true, run: this.publicRun(replacement) };
        }
        if (request.action === 'skip' || request.action === 'close') {
            this.commit(`fallback-${request.action}-close-intent`);
            const closed = await this.closeFallbackTerminal(orchestration, unit);
            if (!closed.ok)
                return closed;
            run.state = 'cancelled';
            run.completedAt = Date.now();
            run.error = request.action === 'skip' ? 'Skipped by the user' : 'Member closed by the user';
            this.writeRunRecord(run);
            this.notifyWaiters(run.runId);
            if (request.action === 'close') {
                for (const pendingId of unit.runIds) {
                    const pending = this.registry.runs[pendingId];
                    if (!pending || (0, agentTeams_1.isTerminalState)(pending.state))
                        continue;
                    pending.state = 'cancelled';
                    pending.completedAt = Date.now();
                    pending.error = 'Member closed by the user';
                    this.writeRunRecord(pending);
                    this.notifyWaiters(pending.runId);
                }
            }
            const nextRunId = request.action === 'skip'
                ? unit.runIds.find((id) => id !== run.runId && this.registry.runs[id]?.state === 'pending')
                : undefined;
            if (nextRunId && orchestration.topology === 'team') {
                unit.currentRunId = nextRunId;
                unit.state = 'queued';
                unit.activity = 'Queued after skipped run';
                delete unit.error;
                this.commit('fallback-skipped-next-queued');
                this.enqueueUnit(orchestration.teamId, unit.id);
            }
            else {
                unit.currentRunId = undefined;
                unit.state = 'closed';
                unit.activity = 'Closed';
                this.releaseUnitResources(orchestration, unit);
                this.commit(`fallback-${request.action}-closed`);
                if (orchestration.topology === 'swarm')
                    this.onSwarmWorkerSettled(orchestration.swarmId, orchestration.manifest);
            }
            return { ok: true };
        }
        return { ok: false, error: 'Unknown fallback action' };
    }
    async stop(principal, orchestrationId, closeTerminals = false, finishRunning = false) {
        await this.initialize();
        const item = this.findOrchestrationById(orchestrationId);
        if (!item || !this.authorized(principal, item))
            return { ok: false, error: 'Orchestration is not available' };
        if (finishRunning) {
            if (item.topology !== 'swarm')
                return { ok: false, error: 'Only Swarms can finish already-running workers' };
            return this.drainSwarm(item);
        }
        item.state = 'stopping';
        item.updatedAt = Date.now();
        const units = item.topology === 'team' ? item.members : item.workers;
        const mustCloseTerminals = item.topology === 'swarm' || closeTerminals || (item.topology === 'team' && item.closeTerminalsOnStop === true);
        const pendingHeadlessRuns = [];
        const pendingStructuredCloses = [];
        const pendingPeerStops = [];
        /**
         * Which units this stop actually kills a terminal for. An ADOPTED terminal
         * is never one of them, whatever the manifest asked for: it belongs to the
         * human, the orchestration only borrowed it, and closing it would end a
         * session nobody agreed to end.
         */
        const closesTerminalOf = (unit) => Boolean(mustCloseTerminals && unit.terminalId && !unit.adoptedTerminal);
        for (const unit of units) {
            if (unit.deviceId && unit.remoteTeamId) {
                const peerRuntime = this.deps.getFederatedTeamRuntime?.();
                pendingPeerStops.push(peerRuntime
                    ? peerRuntime.stopTeam({
                        deviceId: unit.deviceId,
                        operationId: `peer-stop-${orchestrationId}-${unit.remoteTeamId}`,
                        projectId: this.unitProjectId(item, unit),
                        teamId: unit.remoteTeamId,
                    }).then((result) => ({ unitId: unit.id, result }))
                    : Promise.resolve({
                        unitId: unit.id,
                        result: { ok: false, error: 'Multi-device Team routing is unavailable' },
                    }));
            }
            const run = unit.currentRunId ? this.registry.runs[unit.currentRunId] : undefined;
            if (run && !(0, agentTeams_1.isTerminalState)(run.state)) {
                run.state = 'cancelled';
                run.completedAt = Date.now();
                run.error = 'Stopped by the user';
                this.writeRunRecord(run);
                this.clearNativeHook(run);
                if (run.teamMessageId)
                    this.messageBus.markCancelled(run.teamMessageId, run.error);
                this.notifyWaiters(run.runId);
            }
            const runtimeManager = this.deps.getAgentRuntimeManager?.();
            const structuredClosing = Boolean(run?.runtimeSessionId && run.runtimeTurnId && runtimeManager);
            if (run?.runtimeSessionId && run.runtimeTurnId && runtimeManager) {
                pendingStructuredCloses.push(runtimeManager.cancelTurn({
                    sessionId: run.runtimeSessionId,
                    turnId: run.runtimeTurnId,
                    reason: 'Stopped by the user',
                }).catch(() => { }).then(() => runtimeManager.closeSession({
                    sessionId: run.runtimeSessionId,
                    reason: 'Orchestration stopped',
                })));
            }
            const runtime = this.runtimes.get(unit.currentRunId ?? '');
            if (unit.terminalId && unit.currentRunId) {
                // Revoke any staged text/Enter callbacks before releasing ownership.
                // The submit continuation may settle after Stop, but it must observe
                // the durable cancellation instead of reviving the run.
                this.inputSerializer.release(unit.terminalId, unit.currentRunId);
            }
            runtime?.abort.abort();
            if (runtime && unit.substrate === 'headless' && unit.currentRunId) {
                pendingHeadlessRuns.push(unit.currentRunId);
            }
            else if (runtime && unit.currentRunId) {
                // Terminal runtimes are screen/output observers, not OS-process
                // ownership. Once the run is cancelled they must be disposed before
                // shutdown confirmation, or their Map entry permanently retains the
                // Team reservation even after backend.kill() succeeds.
                this.disposeRuntime(unit.currentRunId);
            }
            unit.state = 'cancelled';
            // A reservation represents a process slot. Keep it until a headless
            // child has drained or a live-worker terminal has positively died.
            if (!runtime && !structuredClosing && (!closesTerminalOf(unit)))
                this.releaseUnitResources(item, unit);
        }
        this.commit('orchestration-stop-intent');
        const backend = this.deps.getPtyBackend();
        if (mustCloseTerminals && backend) {
            await Promise.allSettled(units.filter(closesTerminalOf).map((unit) => backend.kill(unit.terminalId)));
        }
        if (pendingHeadlessRuns.length > 0)
            await this.waitForRuntimeDrain(pendingHeadlessRuns);
        if (pendingStructuredCloses.length > 0)
            await Promise.allSettled(pendingStructuredCloses);
        const peerStopResults = new Map();
        if (pendingPeerStops.length > 0) {
            const settled = await Promise.allSettled(pendingPeerStops);
            for (const result of settled) {
                if (result.status === 'fulfilled')
                    peerStopResults.set(result.value.unitId, result.value.result);
            }
        }
        let closeUnconfirmed = false;
        for (const unit of units) {
            const peerStop = peerStopResults.get(unit.id);
            if (unit.deviceId && unit.remoteTeamId && (!peerStop || !peerStop.ok)) {
                closeUnconfirmed = true;
                unit.state = 'uncertain';
                unit.activity = `Shutdown not confirmed on ${unit.deviceName ?? 'peer'}`;
                unit.error = peerStop && !peerStop.ok ? peerStop.error : 'Peer shutdown receipt was not returned';
                continue;
            }
            const runtimeAlive = unit.currentRunId ? this.runtimes.has(unit.currentRunId) : false;
            const terminalAlive = Boolean(closesTerminalOf(unit) && backend?.hasLiveInstance(unit.terminalId));
            if (runtimeAlive || terminalAlive || (closesTerminalOf(unit) && !backend)) {
                closeUnconfirmed = true;
                unit.state = 'uncertain';
                unit.activity = 'Process close not confirmed';
                unit.error = 'Resources remain reserved until process death is confirmed';
                continue;
            }
            this.releaseUnitResources(item, unit);
            unit.state = 'closed';
        }
        if (closeUnconfirmed) {
            this.commit('orchestration-stop-unconfirmed');
            return { ok: false, error: 'One or more delegate processes did not confirm shutdown; their reservations were retained' };
        }
        item.state = 'closed';
        item.updatedAt = Date.now();
        this.commit('orchestration-closed');
        return { ok: true };
    }
    drainSwarm(swarm) {
        if (swarm.state !== 'active')
            return { ok: false, error: `Swarm cannot drain while ${swarm.state}` };
        swarm.poolPaused = true;
        swarm.state = 'draining';
        swarm.updatedAt = Date.now();
        for (const worker of swarm.workers.filter((item) => workerCanBeCancelledBeforeAdmission(item))) {
            const run = worker.currentRunId ? this.registry.runs[worker.currentRunId] : undefined;
            if (run && !(0, agentTeams_1.isTerminalState)(run.state)) {
                run.state = 'cancelled';
                run.completedAt = Date.now();
                run.error = 'Cancelled before admission while the Swarm drained';
                this.writeRunRecord(run);
                this.notifyWaiters(run.runId);
            }
            worker.state = 'closed';
            worker.activity = 'Not started · Swarm draining';
            this.releaseUnitResources(swarm, worker);
        }
        this.commit('swarm-drain-requested');
        const running = swarm.workers.some((worker) => [
            'admitted', 'gated-spawn', 'running', 'draining', 'provisioning', 'claiming',
            'readiness-test', 'ready', 'engaged', 'rebinding', 'fallback', 'paused',
        ].includes(worker.state));
        if (!running) {
            swarm.state = 'closed';
            swarm.updatedAt = Date.now();
            this.commit('swarm-drain-complete');
        }
        return { ok: true };
    }
    // -----------------------------------------------------------------------
    // Provisioning and execution
    // -----------------------------------------------------------------------
    enqueueUnit(orchestrationId, unitId) {
        const key = `${orchestrationId}:${unitId}`;
        const previous = this.unitChains.get(key) ?? Promise.resolve();
        const next = previous.then(() => this.runUnit(orchestrationId, unitId)).catch((error) => {
            console.warn('[agent-teams] unit failed:', error);
        });
        this.unitChains.set(key, next);
    }
    async runUnit(orchestrationId, unitId) {
        const team = this.registry.teams[orchestrationId];
        if (!team || team.state !== 'active')
            return;
        const unit = team.members.find((item) => item.id === unitId);
        if (!unit?.currentRunId)
            return;
        const run = this.registry.runs[unit.currentRunId];
        if (!run)
            return;
        if (unit.deviceId) {
            if (!['pending', 'submitting', 'running'].includes(run.state))
                return;
            await this.runFederatedUnit(team, unit, run);
            return;
        }
        if (run.state !== 'pending')
            return;
        const runtimeConfig = (0, runtimeConfig_1.readOrchestrationRuntimeConfig)(this.homeDir);
        const effectiveRuntime = this.effectiveRuntimeFor(unit, run, runtimeConfig.preferredMode);
        if (effectiveRuntime === 'structured') {
            if (!runtimeConfig.flags.orchestrationV2Runtime) {
                return this.failBeforeSubmit(team, unit, run, 'Structured orchestration runtime is disabled');
            }
            await this.runStructuredUnit(team, unit, run, runtimeConfig.flags);
            return;
        }
        if (effectiveRuntime === 'native-terminal' && unit.substrate !== 'terminal') {
            unit.substrate = 'terminal';
            run.substrate = 'terminal';
            this.commit('runtime-native-terminal-selected');
        }
        if (effectiveRuntime === 'headless' && unit.substrate !== 'headless') {
            if (run.category && orchestrationPolicy_1.INTRINSIC_TERMINAL_SKILLS[run.category]) {
                return this.failBeforeSubmit(team, unit, run, `${run.category} requires a native terminal runtime`);
            }
            unit.substrate = 'headless';
            run.substrate = 'headless';
            this.commit('runtime-headless-selected');
        }
        if (unit.substrate === 'headless')
            await this.runHeadlessUnit(team, unit, run, false);
        else
            await this.runTerminalUnit(team, unit, run);
    }
    /**
     * A peer owns the actual controller, process, reservation, and transcript.
     * The starter stores only stable owner-side ids and mirrors collect results.
     * Retrying start/send after a crash is safe because operationId derives from
     * this durable local run id and the owner controller is idempotent on it.
     */
    async runFederatedUnit(team, unit, run) {
        const runtime = this.deps.getFederatedTeamRuntime?.();
        const deviceId = unit.deviceId;
        if (!runtime || !deviceId) {
            return this.failBeforeSubmit(team, unit, run, 'Multi-device Team routing is unavailable');
        }
        if (!run.remoteRunId) {
            run.state = 'submitting';
            unit.state = 'provisioning';
            unit.activity = run.remoteTeamId || unit.remoteTeamId
                ? `Sending to ${unit.deviceName ?? 'peer'}…`
                : `Starting on ${unit.deviceName ?? 'peer'}…`;
            this.writeRunRecord(run);
            this.commit('peer-team-dispatch-intent');
            const operationId = `peer-team-${run.runId}`;
            const existingTeamId = run.remoteTeamId ?? unit.remoteTeamId;
            const existingMemberId = run.remoteMemberId ?? unit.remoteMemberId;
            const dispatched = existingTeamId && existingMemberId
                ? { kind: 'send', result: await runtime.sendMember({
                        deviceId,
                        operationId,
                        projectId: run.projectId,
                        teamId: existingTeamId,
                        memberId: existingMemberId,
                        prompt: run.prompt,
                    }) }
                : { kind: 'start', result: await runtime.startMember({
                        deviceId,
                        operationId,
                        projectId: run.projectId,
                        member: {
                            role: unit.role,
                            target: run.target,
                            prompt: run.prompt,
                            projectId: run.projectId,
                            category: run.category,
                            model: run.model,
                            substrate: unit.substrate,
                            runtimePreference: unit.runtimePreference,
                            skill: run.skill,
                            sharedCwd: unit.worktreeRequired !== true,
                        },
                    }) };
            if ((0, agentTeams_1.isTerminalState)(run.state))
                return;
            if (!dispatched.result.ok) {
                // A request timeout cannot prove whether the owner crossed its
                // start/send boundary. Never report a clean pre-submit failure.
                return this.finishRun(run, 'uncertain', undefined, dispatched.result.error);
            }
            if (dispatched.kind === 'start') {
                const started = dispatched.result;
                run.remoteTeamId = started.teamId;
                run.remoteMemberId = started.memberId;
                run.remoteRunId = started.runId;
                run.remoteTerminalId = started.terminalId;
                unit.remoteTeamId = started.teamId;
                unit.remoteMemberId = started.memberId;
                unit.remoteRunId = started.runId;
                unit.remoteTerminalId = started.terminalId;
                unit.substrate = started.member.substrate;
                unit.runtimePreference = started.member.runtimePreference;
                run.substrate = started.run.substrate;
                run.runtimePreference = started.run.runtimePreference;
            }
            else {
                const sent = dispatched.result;
                run.remoteTeamId = existingTeamId;
                run.remoteMemberId = existingMemberId;
                run.remoteRunId = sent.runId;
                unit.remoteRunId = sent.runId;
            }
            run.state = 'running';
            run.submittedAt = Date.now();
            unit.state = 'engaged';
            unit.activity = `Working on ${unit.deviceName ?? 'peer'}`;
            this.writeRunRecord(run);
            this.commit('peer-team-dispatched');
            if (run.teamMessageId)
                this.messageBus.markDelivered(run.teamMessageId, run.runId);
        }
        const remoteTeamId = run.remoteTeamId ?? unit.remoteTeamId;
        const remoteRunId = run.remoteRunId;
        if (!remoteTeamId || !remoteRunId) {
            return this.finishRun(run, 'uncertain', undefined, 'Peer accepted the Team member without returning durable run identities');
        }
        let offlineAttempts = 0;
        while (!(0, agentTeams_1.isTerminalState)(run.state)) {
            const collected = await runtime.collectRun({
                deviceId,
                operationId: `peer-collect-${run.runId}-${node_crypto_1.default.randomUUID()}`,
                projectId: run.projectId,
                teamId: remoteTeamId,
                runId: remoteRunId,
                timeoutMs: 20_000,
            });
            if ((0, agentTeams_1.isTerminalState)(run.state))
                return;
            if (!collected.ok) {
                offlineAttempts += 1;
                const nextActivity = `Run continues on ${unit.deviceName ?? 'peer'} · reconnecting`;
                if (unit.activity !== nextActivity) {
                    unit.activity = nextActivity;
                    unit.error = collected.error;
                    this.commit('peer-team-collect-reconnecting');
                }
                await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, offlineAttempts * 1_000)));
                continue;
            }
            offlineAttempts = 0;
            const result = collected.result;
            if (result.stillRunning) {
                unit.activity = `Working on ${unit.deviceName ?? 'peer'}`;
                delete unit.error;
                continue;
            }
            const state = result.state;
            if (state === 'done')
                return this.finishRun(run, 'done', result.output);
            if (state === 'cancelled')
                return this.finishRun(run, 'cancelled', result.output, result.error);
            if (state === 'timed-out')
                return this.finishRun(run, 'timed-out', result.output, result.error);
            if (state === 'uncertain' || state === 'interrupted' || state === 'submission-interrupted' || state === 'needs-confirmation') {
                return this.finishRun(run, 'uncertain', result.output, result.error ?? `Peer run ended ${state}`);
            }
            return this.finishRun(run, 'error', result.output, result.error ?? `Peer run ended ${state ?? 'without a result'}`);
        }
    }
    async runStructuredUnit(orchestration, unit, run, flags) {
        const manager = this.deps.getAgentRuntimeManager?.();
        const registry = this.deps.getHarnessRegistry?.();
        if (!manager || !registry)
            return this.failBeforeSubmit(orchestration, unit, run, 'Structured runtime manager is unavailable');
        const worktree = await this.ensureUnitWorktree(orchestration, unit);
        if (!worktree.ok)
            return this.failBeforeSubmit(orchestration, unit, run, worktree.error);
        const resolution = await registry.resolve(unit.target, 'structured', {
            browserTools: Boolean(run.category && orchestrationPolicy_1.INTRINSIC_TERMINAL_SKILLS[run.category]),
            approvals: true,
            resume: Boolean(unit.nativeSessionId),
        });
        const selected = resolution.selected;
        if (!selected)
            return this.failBeforeSubmit(orchestration, unit, run, resolution.error ?? 'No structured harness is available');
        if (selected.harnessId === 'codex:app-server' && !flags.codexAppServerHarness) {
            return this.failBeforeSubmit(orchestration, unit, run, 'Codex app-server harness is disabled');
        }
        if (selected.declared.transport === 'acp' && !flags.acpHarness) {
            return this.failBeforeSubmit(orchestration, unit, run, 'ACP harness is disabled');
        }
        if (selected.harnessId === 'opencode:acp' && !flags.opencodeAcpHarness) {
            return this.failBeforeSubmit(orchestration, unit, run, 'OpenCode ACP harness is disabled');
        }
        if (selected.harnessId === 'cline:acp' && !flags.clineAcpHarness) {
            return this.failBeforeSubmit(orchestration, unit, run, 'Cline ACP harness has not passed its release gate');
        }
        if (selected.harnessId === 'gemini:acp' && !flags.geminiAcpHarness) {
            return this.failBeforeSubmit(orchestration, unit, run, 'Gemini ACP harness has not passed its release gate');
        }
        if (run.category && orchestrationPolicy_1.INTRINSIC_TERMINAL_SKILLS[run.category] && !flags.playwrightToolGateway) {
            return this.failBeforeSubmit(orchestration, unit, run, 'Shared Playwright tools are disabled for this structured browser task');
        }
        run.harnessId = selected.harnessId;
        run.harnessTransport = selected.declared.transport;
        unit.harnessId = selected.harnessId;
        unit.harnessTransport = selected.declared.transport;
        unit.state = 'admitted';
        unit.activity = `Starting ${selected.declared.transport} session…`;
        run.state = 'submitting';
        const runtimeSessionId = unit.runtimeSessionId ?? node_crypto_1.default.randomUUID();
        const runtimeTurnId = node_crypto_1.default.randomUUID();
        run.runtimeSessionId = runtimeSessionId;
        run.runtimeTurnId = runtimeTurnId;
        unit.runtimeSessionId = runtimeSessionId;
        this.writeRunRecord(run);
        this.commit('structured-session-start-intent');
        const sessionInput = {
            clientRequestId: `session:${runtimeSessionId}`,
            sessionId: runtimeSessionId,
            agentId: unit.target,
            projectId: this.unitProjectId(orchestration, unit),
            workspacePath: unit.worktreePath ?? this.cwdFor(this.unitProjectId(orchestration, unit)),
            orchestrationId: orchestration.topology === 'team' ? orchestration.teamId : orchestration.swarmId,
            runId: run.runId,
            model: run.model,
            ...(run.category === 'browser' && flags.playwrightToolGateway
                ? { toolPermissions: ['browser:write'] }
                : {}),
        };
        const turnInput = {
            clientRequestId: `turn:${run.runId}`,
            sessionId: runtimeSessionId,
            turnId: runtimeTurnId,
            prompt: { text: run.prompt },
            orchestrationId: orchestration.topology === 'team' ? orchestration.teamId : orchestration.swarmId,
            runId: run.runId,
        };
        try {
            const existing = manager.getSession(runtimeSessionId);
            if (existing?.lifecycle !== 'idle' && unit.nativeSessionId) {
                await manager.loadSession(selected.harnessId, { ...sessionInput, nativeSessionId: unit.nativeSessionId });
            }
            else if (existing?.lifecycle !== 'idle') {
                await manager.createSession(selected.harnessId, sessionInput);
            }
            if (orchestration.topology === 'swarm') {
                if (!unit.creditId || unit.creditState !== 'hold') {
                    throw new Error('Swarm structured-worker credit hold disappeared before submission');
                }
                const credit = this.registry.credits[unit.creditId];
                if (!credit || credit.state !== 'hold')
                    throw new Error('Swarm structured-worker credit is unavailable');
                credit.state = 'spent';
                credit.spentAt = Date.now();
                unit.creditState = 'spent';
                orchestration.spentCredits += 1;
                run.submittedAt = Date.now();
                this.writeRunRecord(run);
                this.commit('structured-brief-release');
            }
            await manager.sendTurn(turnInput);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (run.submittedAt !== undefined)
                this.finishRun(run, 'uncertain', undefined, message);
            else
                this.failBeforeSubmit(orchestration, unit, run, message);
        }
    }
    handleRuntimeEvent(envelope) {
        if (!envelope.runId)
            return;
        const run = this.registry.runs[envelope.runId];
        if (!run || run.runtimeSessionId !== envelope.sessionId || (0, agentTeams_1.isTerminalState)(run.state))
            return;
        const unit = this.findUnit(run);
        if (envelope.nativeSessionId) {
            run.nativeSessionId = envelope.nativeSessionId;
            run.sessionId = envelope.nativeSessionId;
            if (unit)
                unit.nativeSessionId = envelope.nativeSessionId;
        }
        switch (envelope.event.type) {
            case 'session-created':
            case 'session-loaded':
                this.writeRunRecord(run);
                this.commit(`runtime-${envelope.event.type}`);
                return;
            case 'turn-queued':
                if (unit)
                    unit.activity = 'Turn queued';
                this.commit('runtime-turn-queued');
                return;
            case 'turn-started':
                if (run.state !== 'submitting' && run.state !== 'pending')
                    return;
                run.state = 'running';
                run.submittedAt = Date.now();
                if (unit) {
                    unit.state = 'engaged';
                    unit.activity = 'Working';
                }
                this.writeRunRecord(run);
                this.commit('runtime-turn-started');
                if (run.teamMessageId)
                    this.messageBus.markDelivered(run.teamMessageId, run.runId);
                return;
            case 'approval-requested':
            case 'question-requested':
                if (run.state !== 'running')
                    return;
                run.needsInput = true;
                if (unit) {
                    unit.needsInput = true;
                    unit.activity = envelope.event.type === 'approval-requested'
                        ? `Approval needed · ${envelope.event.title}`
                        : 'Question needs an answer';
                }
                this.writeRunRecord(run);
                this.commit(`runtime-${envelope.event.type}`);
                if (envelope.event.type === 'question-requested') {
                    const store = this.deps.getStoreManager();
                    const terminal = unit?.terminalId
                        ? store?.findTerminalLocation(unit.terminalId)
                        : null;
                    const projectName = terminal?.project.name ??
                        store?.getProjects().find((project) => project.id === run.projectId)?.name ??
                        '';
                    this.deps.sendToRenderer('app:attention-event', {
                        id: `question-${run.runId}-${envelope.event.interactionId}`,
                        kind: 'agent-question',
                        terminalId: unit?.terminalId ?? run.runId,
                        projectId: run.projectId,
                        projectName,
                        terminalName: terminal?.terminal.name || unit?.role || unit?.target || run.target,
                        ...(terminal?.terminal.agentType ? { agentType: terminal.terminal.agentType } : {}),
                        detail: envelope.event.question.slice(0, attention_1.ATTENTION_DETAIL_MAX_CHARS),
                        ...((envelope.event.questions?.[0]?.choices ?? envelope.event.choices)?.length
                            ? {
                                options: (envelope.event.questions?.[0]?.choices ?? envelope.event.choices)
                                    .slice(0, 10)
                                    .map((choice) => choice.slice(0, 160)),
                            }
                            : {}),
                        timestamp: envelope.at,
                    });
                }
                return;
            case 'approval-resolved':
            case 'question-resolved':
                run.needsInput = false;
                if (unit) {
                    unit.needsInput = false;
                    unit.activity = 'Working';
                }
                this.writeRunRecord(run);
                this.commit(`runtime-${envelope.event.type}`);
                return;
            case 'usage-updated':
                run.usage = envelope.event.usage;
                this.writeRunRecord(run);
                this.commit('runtime-usage-updated');
                return;
            case 'turn-completed':
                this.finishRun(run, 'done', envelope.event.output);
                return;
            case 'turn-failed':
                this.finishRun(run, 'error', undefined, envelope.event.error);
                return;
            case 'turn-cancelled':
                this.finishRun(run, envelope.event.uncertain ? 'uncertain' : 'cancelled', undefined, envelope.event.reason);
                return;
            case 'adapter-exited': {
                const error = envelope.event.error ?? `Harness exited${envelope.event.code === undefined ? '' : ` with code ${envelope.event.code}`}`;
                if (run.state === 'pending' || run.state === 'submitting') {
                    const orchestration = this.findOrchestration(run);
                    if (orchestration && unit)
                        this.failBeforeSubmit(orchestration, unit, run, error);
                }
                else {
                    this.finishRun(run, 'uncertain', undefined, error);
                }
                return;
            }
            case 'session-error':
                if (run.state === 'submitting') {
                    const orchestration = this.findOrchestration(run);
                    if (orchestration && unit)
                        this.failBeforeSubmit(orchestration, unit, run, envelope.event.error);
                }
                return;
            default:
                // Deltas/tool progress are retained by the runtime event ring and
                // structured session view. They never drive controller lifecycle.
                return;
        }
    }
    async runTerminalUnit(team, unit, run) {
        const backend = this.deps.getPtyBackend();
        const store = this.deps.getStoreManager();
        if (!backend || !store)
            return this.failBeforeSubmit(team, unit, run, 'Terminal backend is unavailable');
        const worktree = await this.ensureUnitWorktree(team, unit);
        if (!worktree.ok)
            return this.failBeforeSubmit(team, unit, run, worktree.error);
        // An adopted terminal is the user's, already running their agent: there is
        // nothing to launch, and a terminal that has since exited is an error — a
        // silent respawn would replace the session the human pointed at.
        if (unit.adoptedTerminal) {
            if (!unit.terminalId || !backend.hasLiveInstance(unit.terminalId)) {
                return this.failBeforeSubmit(team, unit, run, 'That terminal is no longer running');
            }
        }
        // Terminal identity is main-owned: the controller validates the target and
        // builds this launch before asking the renderer to persist a tab. Renderer
        // creation ACK and store persistence are separate IPC operations, so a
        // freshly-created record is allowed to be temporarily absent from
        // StoreManager. Never turn that persistence race into kind === null.
        const defaultArgs = this.deps.getCliRegistry()?.knownClis()
            .find((cli) => cli.id === unit.target)?.defaultSpawnArgs ?? [];
        // A saved preset wins over the built-in launcher: the user configured that
        // command (permission flags, model, wrappers) and a dispatch that quietly
        // ran a bare CLI instead would not be the agent they set up.
        const preset = unit.startupPresetId ? this.resolveStartupPreset(unit.startupPresetId, unit.target) : null;
        if (preset && !preset.ok)
            return this.failBeforeSubmit(team, unit, run, preset.error);
        const launch = preset?.ok
            ? this.launchSpecForPreset(preset.preset, unit.target)
            : (0, interactiveDelegation_1.buildInteractiveAgentLaunchSpec)(unit.target, run.model, run.category, defaultArgs, process.platform === 'win32');
        if (!launch && !unit.adoptedTerminal) {
            return this.failBeforeSubmit(team, unit, run, `${unit.target} has no interactive launcher`);
        }
        const launchTarget = launch
            ? {
                agentType: launch.agentType,
                startupCommand: launch.command,
                forceAiAgent: launch.forceAiAgent,
            }
            : null;
        if (!unit.terminalId) {
            // Main mints and journals the renderer creation key. If the renderer
            // records the terminal but its ACK is lost, a retry resolves the same
            // record instead of creating an untracked duplicate.
            unit.terminalId = node_crypto_1.default.randomUUID();
            run.terminalId = unit.terminalId;
            unit.state = 'claiming';
            unit.activity = 'Claiming terminal…';
            if (!this.claimTerminal(team, unit, unit.terminalId)) {
                return this.failBeforeSubmit(team, unit, run, 'Terminal ownership claim was lost');
            }
        }
        else {
            run.terminalId = unit.terminalId;
            if (!this.claimTerminal(team, unit, unit.terminalId)) {
                return this.failBeforeSubmit(team, unit, run, 'Terminal ownership claim was lost');
            }
        }
        if (launch && !backend.hasLiveInstance(unit.terminalId)) {
            unit.state = 'provisioning';
            unit.activity = 'Opening terminal…';
            this.commit('terminal-provision-intent');
            const created = await this.deps.createTerminal({
                // The MEMBER's project, not the host's (workspace_control D4): the
                // renderer persists the terminal there, so its cwd is that root.
                projectId: this.unitProjectId(team, unit),
                terminalId: unit.terminalId,
                agentType: launch.agentType,
                name: unit.role ? `${launch.name} · ${unit.role}` : launch.name,
                command: launch.command,
                forceAiAgent: launch.forceAiAgent,
                worktreePath: unit.worktreePath,
                focusWindow: false,
            });
            if (!created.ok || !created.terminalId)
                return this.failBeforeSubmit(team, unit, run, created.error ?? 'Terminal creation failed');
            if (created.terminalId !== unit.terminalId) {
                return this.failBeforeSubmit(team, unit, run, 'Renderer returned a different terminal creation key');
            }
            unit.state = 'claiming';
            this.commit('terminal-created');
        }
        if (!await this.waitForLiveTerminal(run)) {
            return this.failBeforeSubmit(team, unit, run, 'Delegate terminal process did not start before the readiness deadline');
        }
        unit.state = 'readiness-test';
        unit.activity = 'Checking readiness…';
        this.commit('terminal-readiness-test');
        const screen = await this.attachScreen(run);
        const record = store.findTerminalLocation(unit.terminalId)?.terminal;
        const promptTarget = record
            ? { agentType: record.agentType, startupCommand: record.startupCommand, forceAiAgent: record.forceAiAgent }
            : launchTarget;
        // Only an adopted terminal can reach this with neither: it has no launch to
        // fall back on, and a missing record means we cannot tell how to write to it.
        if (!promptTarget)
            return this.failBeforeSubmit(team, unit, run, 'That terminal is no longer known to this app');
        const kind = (0, contracts_1.getDeclaredAgentKind)(promptTarget.agentType, promptTarget.startupCommand);
        const readiness = await this.waitForReadiness(run, screen, kind, promptTarget);
        if (!readiness.ready) {
            if (readiness.markerKnown)
                return this.failBeforeSubmit(team, unit, run, 'Agent did not reach a positively empty composer before the readiness deadline');
            unit.needsAttention = true;
            unit.attentionKind = 'submit';
            unit.state = 'readiness-test';
            unit.activity = 'Submit confirmation needed';
            run.needsAttention = true;
            run.state = 'pending';
            this.commit('terminal-needs-mediated-submit');
            return;
        }
        unit.state = 'ready';
        unit.activity = 'Ready';
        this.commit('terminal-ready');
        await this.submitTerminalRun(run, false, promptTarget);
    }
    async submitTerminalRun(run, mediated, knownTarget) {
        const unit = this.findUnit(run);
        const orchestration = this.findOrchestration(run);
        const store = this.deps.getStoreManager();
        if (!unit || !orchestration || !run.terminalId)
            return;
        const record = store?.findTerminalLocation(run.terminalId)?.terminal;
        const target = knownTarget ?? this.promptTargetForRun(run, record);
        if (!target)
            return this.failBeforeSubmit(orchestration, unit, run, 'Delegate terminal identity is unavailable');
        // Pre-submit watermark and intent are durable before the first PTY byte.
        const bound = record ? await this.sessionWatermark(record, run.target) : null;
        if (bound) {
            run.sessionId = bound.sessionId;
            run.messageWatermark = bound.messageCount;
        }
        else {
            run.messageWatermark = 0;
        }
        run.state = 'submitting';
        run.submittedAt = Date.now();
        if (orchestration.topology === 'swarm' && unit.creditId && unit.creditState === 'hold') {
            const credit = this.registry.credits[unit.creditId];
            if (!credit || credit.state !== 'hold') {
                return this.failBeforeSubmit(orchestration, unit, run, 'Swarm live-worker credit hold disappeared');
            }
            credit.state = 'spent';
            credit.spentAt = Date.now();
            unit.creditState = 'spent';
            orchestration.spentCredits += 1;
        }
        unit.activity = mediated ? 'Submitting confirmed prompt…' : 'Submitting…';
        this.writeRunRecord(run);
        this.commit('terminal-submission-intent');
        try {
            (0, hookCapability_1.writeHookCapability)(this.homeDir, {
                terminalId: run.terminalId,
                runId: run.runId,
                capabilityToken: run.capabilityToken,
                expiresAt: Date.now() + (DEFAULT_INTERACTIVE_TIMEOUT_S + 300) * 1000,
            });
        }
        catch (error) {
            // L2 transcript binding remains available. Hook installation/capability
            // is an additive authoritative producer, never a reason to raw-retry.
            console.warn('[agent-teams] could not arm native completion hook:', error);
        }
        try {
            await this.inputSerializer.submitTeamPrompt({
                terminalId: run.terminalId,
                runId: run.runId,
                prompt: run.prompt,
                target,
                expectedOwner: this.runtimes.get(run.runId)?.observedOwner,
            });
        }
        catch (error) {
            if ((0, agentTeams_1.isTerminalState)(run.state))
                return;
            if (error instanceof TerminalInputSerializer_1.SubmissionInterruptedError) {
                run.state = 'submission-interrupted';
                run.error = error.message;
                unit.userControlled = true;
                unit.activity = 'Submission interrupted';
                this.writeRunRecord(run);
                this.commit('terminal-submission-interrupted');
                if (run.teamMessageId)
                    this.messageBus.markCancelled(run.teamMessageId, error.message);
                this.notifyWaiters(run.runId);
                return;
            }
            return this.failBeforeSubmit(orchestration, unit, run, error instanceof Error ? error.message : String(error));
        }
        if ((0, agentTeams_1.isTerminalState)(run.state))
            return;
        run.state = 'running';
        unit.state = 'engaged';
        unit.activity = 'Working';
        const runtime = this.runtimes.get(run.runId);
        if (runtime?.screen)
            runtime.submitGeneration = runtime.screen.generation;
        this.writeRunRecord(run);
        this.commit('terminal-submitted');
        if (run.teamMessageId)
            this.messageBus.markDelivered(run.teamMessageId, run.runId);
        this.monitorTerminalCompletion(run);
    }
    async runHeadlessUnit(orchestration, unit, run, swarmWorker, swarmManifest) {
        const worktree = await this.ensureUnitWorktree(orchestration, unit);
        if (!worktree.ok)
            return this.failBeforeSubmit(orchestration, unit, run, worktree.error);
        const registry = this.deps.getCliRegistry();
        if (!registry)
            return this.failBeforeSubmit(orchestration, unit, run, 'CLI registry is unavailable');
        const resolved = await registry.getCliBinary(unit.target);
        if (!resolved.ok)
            return this.failBeforeSubmit(orchestration, unit, run, `${unit.target} is not installed (${resolved.reason})`);
        const modelFlags = run.model ? (0, agentModels_1.buildModelFlags)(unit.target, run.model) : [];
        if (run.model && !modelFlags)
            return this.failBeforeSubmit(orchestration, unit, run, `Model ${run.model} is invalid for ${unit.target}`);
        const sandboxFlags = swarmWorker ? swarmSandboxFlags(unit.target, swarmManifest?.sandbox ?? 'read') : [];
        if (swarmWorker && !sandboxFlags)
            return this.failBeforeSubmit(orchestration, unit, run, `${unit.target} cannot enforce the requested swarm sandbox (sandbox-capable targets: ${exports.SWARM_SANDBOX_TARGETS.join(', ')})`);
        unit.state = 'admitted';
        unit.activity = 'Admitted';
        if (!unit.reservationId)
            unit.reservationId = this.reserve(unit.id, this.unitProjectId(orchestration, unit));
        if (!unit.reservationId)
            return this.failBeforeSubmit(orchestration, unit, run, this.capacityError(1));
        if (swarmWorker) {
            const swarm = orchestration;
            if (swarm.spentCredits >= swarm.budget) {
                swarm.state = 'budget-exhausted';
                return this.failBeforeSubmit(orchestration, unit, run, 'Swarm budget exhausted');
            }
            if (!unit.creditId) {
                unit.creditId = this.holdCredit(swarm.swarmId, unit.id);
                unit.creditState = 'hold';
            }
        }
        const defaultFlags = swarmWorker ? [] : headlessMode_1.HEADLESS_SPECS[unit.target]?.defaultFlags ?? [];
        const captureFlags = swarmWorker ? (0, structuredHeadlessOutput_1.structuredCaptureFlags)(unit.target) : [];
        const executionFlags = [...(modelFlags ?? []), ...(sandboxFlags ?? []), ...captureFlags];
        const allFlags = [...defaultFlags, ...executionFlags];
        const invocation = (0, headlessMode_1.buildHeadlessInvocation)(unit.target, run.prompt, allFlags);
        if (!invocation)
            return this.failBeforeSubmit(orchestration, unit, run, `${unit.target} has no headless invocation`);
        run.launch = {
            binaryPath: resolved.path,
            args: invocation.args,
            cwd: unit.worktreePath ?? this.cwdFor(this.unitProjectId(orchestration, unit)),
            promptOnStdin: invocation.stdin !== undefined,
        };
        this.commit('headless-launch-intent');
        const abort = new AbortController();
        this.runtimes.set(run.runId, { abort });
        try {
            const result = await (0, runGatedHeadlessAgent_1.runGatedHeadlessAgent)({
                agentId: unit.target,
                prompt: run.prompt,
                flags: executionFlags,
                // Swarms must never inherit the dangerous auto-approval defaults.
                defaultFlags,
                timeoutSeconds: swarmManifest?.timeoutSeconds,
                cwd: unit.worktreePath ?? this.cwdFor(this.unitProjectId(orchestration, unit)),
                binaryPath: resolved.path,
                workerId: unit.id,
                signal: abort.signal,
                beforeRelease: async ({ pid, startTime }) => {
                    if (!Number.isFinite(startTime) || startTime <= 0) {
                        throw new Error('Worker process start identity could not be captured');
                    }
                    unit.pid = pid;
                    unit.pidStartedAt = startTime;
                    unit.state = 'gated-spawn';
                    unit.activity = 'Gated — committing launch';
                    this.commit('headless-gate-created');
                    if (swarmWorker && unit.creditId) {
                        const credit = this.registry.credits[unit.creditId];
                        if (!credit || credit.state !== 'hold')
                            throw new Error('Worker credit hold disappeared');
                        credit.state = 'spent';
                        credit.spentAt = Date.now();
                        unit.creditState = 'spent';
                        orchestration.spentCredits += 1;
                    }
                    unit.state = 'running';
                    unit.activity = 'Working';
                    run.state = 'running';
                    run.submittedAt = Date.now();
                    this.writeRunRecord(run);
                    this.commit('headless-brief-release');
                    if (run.teamMessageId)
                        this.messageBus.markDelivered(run.teamMessageId, run.runId);
                },
            });
            unit.state = 'draining';
            this.commit('headless-draining');
            const parsed = swarmWorker
                ? (0, structuredHeadlessOutput_1.parseStructuredHeadlessOutput)(unit.target, result.output)
                : { output: result.output };
            if (parsed.sessionId)
                run.sessionId = parsed.sessionId;
            if (parsed.usage)
                run.usage = parsed.usage;
            if (result.exitCode === 0)
                this.finishRun(run, 'done', parsed.output);
            else
                this.finishRun(run, result.timedOut ? 'timed-out' : 'error', parsed.output, result.stderr ?? `Exited with code ${result.exitCode}`);
        }
        catch (error) {
            // If the brief crossed into running, outcome is uncertain; never replay.
            const afterRelease = run.state === 'running';
            this.finishRun(run, afterRelease ? 'uncertain' : 'error', undefined, error instanceof Error ? error.message : String(error));
        }
        finally {
            this.runtimes.delete(run.runId);
            delete unit.pid;
            delete unit.pidStartedAt;
            this.releaseUnitProcessResources(unit);
            if (swarmWorker && run.state === 'done')
                await this.refreshPromotionEligibility(run, unit);
            this.commit('headless-process-released');
            if (swarmWorker)
                this.onSwarmWorkerSettled(orchestration.swarmId, swarmManifest);
        }
    }
    pumpSwarm(swarmId, manifest) {
        const swarm = this.registry.swarms[swarmId];
        if (!swarm || swarm.state !== 'active' || swarm.poolPaused)
            return;
        const active = swarm.workers.filter((worker) => ['admitted', 'gated-spawn', 'running', 'draining', 'provisioning', 'readiness-test', 'engaged'].includes(worker.state)).length;
        const heldCredits = Object.values(this.registry.credits)
            .filter((credit) => credit.swarmId === swarmId && credit.state === 'hold').length;
        const slots = Math.max(0, Math.min(swarm.poolSize - active, swarm.budget - swarm.spentCredits - heldCredits));
        const queued = swarm.workers.filter((worker) => worker.state === 'queued').slice(0, slots);
        const admitted = [];
        for (const worker of queued) {
            const reservationId = this.reserve(worker.id, swarm.projectId);
            if (!reservationId)
                break;
            worker.reservationId = reservationId;
            worker.creditId = this.holdCredit(swarm.swarmId, worker.id);
            worker.creditState = 'hold';
            worker.state = 'admitted';
            worker.activity = 'Admitted';
            admitted.push(worker);
        }
        if (admitted.length > 0)
            this.commit('swarm-wave-admitted');
        for (const worker of admitted) {
            const run = this.registry.runs[worker.currentRunId];
            void this.runSwarmUnit(swarm, worker, run, manifest);
        }
    }
    /**
     * Resolve a unit's runtime, honoring the facts that are already terminal.
     *
     * `auto` normally defers to the user's configured preferred mode, but a unit
     * that ADOPTED a live terminal — or that launches one of the user's saved
     * startup presets — has already committed to a terminal. Routing it to the
     * structured runtime silently abandons that terminal and then fails on a
     * harness lookup the user never asked for ("No safe structured runtime
     * satisfies the requested capabilities"), which is what an adopted
     * hermes-opencode member hit on a machine configured with
     * `preferredMode: "structured"`. Manifest validation already refuses the
     * EXPLICIT combination ("adopting a terminal requires the native terminal
     * runtime"); this closes the same hole for the resolved-from-config path.
     * An explicit per-member `structured` preference is still refused earlier,
     * so this can never override a deliberate choice.
     */
    effectiveRuntimeFor(unit, run, configuredMode) {
        // An absent preference is not 'auto': it keeps the legacy substrate-driven
        // path, exactly as before this helper existed.
        if (run.runtimePreference !== 'auto')
            return run.runtimePreference;
        if (unit.adoptedTerminal || unit.startupPresetId)
            return 'native-terminal';
        return configuredMode;
    }
    async runSwarmUnit(swarm, worker, run, manifest) {
        const runtimeConfig = (0, runtimeConfig_1.readOrchestrationRuntimeConfig)(this.homeDir);
        const effectiveRuntime = this.effectiveRuntimeFor(worker, run, runtimeConfig.preferredMode);
        if (effectiveRuntime === 'structured') {
            if (!runtimeConfig.flags.orchestrationV2Runtime) {
                return this.failBeforeSubmit(swarm, worker, run, 'Structured orchestration runtime is disabled');
            }
            await this.runStructuredUnit(swarm, worker, run, runtimeConfig.flags);
            return;
        }
        if (effectiveRuntime === 'native-terminal') {
            worker.substrate = 'terminal';
            run.substrate = 'terminal';
            this.commit('swarm-runtime-native-terminal-selected');
        }
        else if (effectiveRuntime === 'headless') {
            if (run.category && orchestrationPolicy_1.INTRINSIC_TERMINAL_SKILLS[run.category]) {
                return this.failBeforeSubmit(swarm, worker, run, `${run.category} requires a native terminal or structured browser runtime`);
            }
            worker.substrate = 'headless';
            run.substrate = 'headless';
            this.commit('swarm-runtime-headless-selected');
        }
        if (worker.substrate === 'terminal')
            await this.runTerminalUnit(swarm, worker, run);
        else
            await this.runHeadlessUnit(swarm, worker, run, true, manifest);
    }
    onSwarmWorkerSettled(swarmId, manifest) {
        const swarm = this.registry.swarms[swarmId];
        if (!swarm)
            return;
        const unfinished = swarm.workers.some((worker) => [
            'queued', 'admitted', 'gated-spawn', 'running', 'draining', 'provisioning',
            'claiming', 'readiness-test', 'ready', 'engaged', 'paused', 'rebinding', 'fallback',
        ].includes(worker.state));
        if (!unfinished) {
            swarm.state = 'draining';
            this.commit('swarm-draining');
            swarm.state = 'closed';
            swarm.updatedAt = Date.now();
            this.commit('swarm-closed');
            return;
        }
        if (swarm.spentCredits >= swarm.budget && swarm.workers.some((worker) => worker.state === 'queued')) {
            swarm.state = 'budget-exhausted';
            for (const worker of swarm.workers.filter((item) => item.state === 'queued')) {
                worker.state = 'cancelled';
                const run = this.registry.runs[worker.currentRunId];
                run.state = 'cancelled';
                run.error = 'Swarm budget exhausted before launch';
                run.completedAt = Date.now();
                this.writeRunRecord(run);
                this.notifyWaiters(run.runId);
            }
            this.commit('swarm-budget-exhausted');
            return;
        }
        this.pumpSwarm(swarmId, manifest);
    }
    // -----------------------------------------------------------------------
    // Completion, result binding, and state finalization
    // -----------------------------------------------------------------------
    monitorTerminalCompletion(run) {
        const runtime = this.runtimes.get(run.runId);
        const unit = this.findUnit(run);
        if (!runtime?.screen || !unit || !run.terminalId)
            return;
        const store = this.deps.getStoreManager();
        const backend = this.deps.getPtyBackend();
        if (!store || !backend)
            return;
        const record = store.findTerminalLocation(run.terminalId)?.terminal;
        const target = this.promptTargetForRun(run, record);
        const kind = (0, contracts_1.getDeclaredAgentKind)(target?.agentType, target?.startupCommand);
        runtime.heartbeatTimer = setInterval(() => {
            if (run.state !== 'running')
                return;
            this.writeRunRecord(run, Date.now());
        }, RUN_HEARTBEAT_MS);
        runtime.heartbeatTimer.unref?.();
        runtime.completionTimer = setInterval(() => {
            void (async () => {
                if (run.state !== 'running')
                    return;
                if (!backend.hasLiveInstance(run.terminalId)) {
                    this.finishRun(run, 'uncertain', undefined, 'Delegate terminal exited before a correlated completion signal');
                    return;
                }
                const needsInput = runtime.screen.needsInput(kind);
                if (run.needsInput !== needsInput) {
                    run.needsInput = needsInput;
                    unit.needsInput = needsInput;
                    // A delegate parked on a permission prompt while launched WITHOUT
                    // its full-permission flag is almost always a misconfigured
                    // unattended run (user-created/preset terminals run the bare CLI;
                    // registry launches already pass defaultSpawnArgs). Say so with the
                    // exact flag instead of waiting silently.
                    const permissionNudge = needsInput
                        ? (0, interactiveDelegation_1.composeFullPermissionNudge)(run.target, this.deps.getStoreManager()?.findTerminalLocation(run.terminalId)?.terminal.startupCommand, this.deps.getCliRegistry()?.knownClis().find((cli) => cli.id === run.target)?.defaultSpawnArgs)
                        : '';
                    unit.activity = needsInput ? `Waiting for your input${permissionNudge}` : 'Working';
                    this.writeRunRecord(run);
                    this.commit(needsInput ? 'terminal-needs-input' : 'terminal-input-resolved');
                }
                const ready = runtime.screen.readiness(kind);
                if (!ready.ready || ready.generation <= (runtime.submitGeneration ?? 0)) {
                    if (Date.now() - (run.submittedAt ?? Date.now()) < UNKNOWN_MARKER_ATTENTION_MS)
                        return;
                    if (Date.now() - runtime.screen.lastUpdatedAt < COMPLETION_SCREEN_QUIET_MS)
                        return;
                    const candidate = await this.extractBoundResult(run);
                    if (!candidate)
                        return;
                    run.state = 'needs-confirmation';
                    run.error = 'A correlated result exists, but the current-screen completion marker could not be verified';
                    if (unit) {
                        unit.needsAttention = true;
                        unit.attentionKind = 'completion';
                        unit.activity = 'Completion needs confirmation';
                    }
                    this.disposeRuntime(run.runId);
                    this.clearNativeHook(run);
                    this.writeRunRecord(run);
                    this.commit('terminal-completion-needs-confirmation');
                    this.notifyWaiters(run.runId);
                    return;
                }
                const output = await this.extractBoundResult(run);
                if (!output)
                    return;
                run.state = 'done-candidate';
                this.commit('terminal-done-candidate');
                this.finishRun(run, 'done', output);
            })();
        }, COMPLETION_POLL_MS);
        runtime.completionTimer.unref?.();
    }
    async extractBoundResult(run) {
        const store = this.deps.getStoreManager();
        const resume = this.deps.getResumeManager();
        if (!store || !resume || !run.terminalId || !isResumeAgentType(run.target))
            return null;
        const terminal = store.findTerminalLocation(run.terminalId)?.terminal;
        const sessionId = run.sessionId ?? terminal?.lastSessionId;
        if (!sessionId)
            return null;
        // A newly-created Team terminal may bind its session only after first
        // submit. Binding to that exact terminal record is ownership evidence.
        if (!run.sessionId) {
            run.sessionId = sessionId;
            run.messageWatermark = 0;
            this.commit('terminal-session-bound');
        }
        else if (run.sessionId !== sessionId) {
            return null;
        }
        let detail = null;
        try {
            detail = await resume.getSessionDetail(run.target, sessionId);
        }
        catch {
            return null;
        }
        if (!detail)
            return null;
        const messages = detail.messages.slice(run.messageWatermark ?? 0);
        const assistant = messages.filter((message) => message.role === 'assistant' && message.content.trim());
        if (assistant.length === 0)
            return null;
        return (0, orchestrationRuns_1.truncateChars)(assistant.map((message) => message.content.trim()).join('\n\n'), agentTeams_1.AGENT_ORCHESTRATION_OUTPUT_CAP_CHARS).text;
    }
    async refreshPromotionEligibility(run, unit) {
        run.promotable = false;
        unit.promotable = false;
        if (run.topology !== 'swarm' || run.substrate !== 'headless' || !run.sessionId ||
            !isResumeAgentType(run.target) || this.runtimes.has(run.runId) || unit.pid)
            return;
        const resume = this.deps.getResumeManager();
        if (!resume)
            return;
        // Process close already drained stdout/stderr. Require the exact captured
        // session to become readable as a second, bounded flush proof; never use a
        // proximity scan to manufacture promotion evidence.
        for (let attempt = 0; attempt < 15; attempt++) {
            try {
                if (await resume.getSessionDetail(run.target, run.sessionId)) {
                    run.promotable = true;
                    unit.promotable = true;
                    unit.activity = 'Done · can open as terminal';
                    return;
                }
            }
            catch { /* retry bounded transcript flush */ }
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    }
    finishRun(run, state, output, error) {
        if ((0, agentTeams_1.isTerminalState)(run.state) && run.state !== 'uncertain')
            return;
        run.state = state;
        run.completedAt = Date.now();
        if (output)
            run.output = (0, orchestrationRuns_1.truncateChars)(output, agentTeams_1.AGENT_ORCHESTRATION_OUTPUT_CAP_CHARS).text;
        if (error)
            run.error = error;
        const unit = this.findUnit(run);
        if (unit) {
            unit.state = state === 'done' ? 'done' : state === 'uncertain' ? 'uncertain' : state === 'cancelled' ? 'cancelled' : 'failed';
            unit.activity = state === 'done' ? 'Done' : state === 'uncertain' ? 'Outcome uncertain' : error ?? 'Failed';
            unit.error = error;
            unit.needsAttention = false;
            unit.needsInput = false;
            delete unit.attentionKind;
        }
        this.disposeRuntime(run.runId);
        this.clearNativeHook(run);
        this.writeRunRecord(run);
        this.commit(`run-${state}`);
        if (run.teamMessageId) {
            if (state === 'done')
                this.messageBus.markAnswered(run.teamMessageId, run.output);
            else if (state === 'cancelled')
                this.messageBus.markCancelled(run.teamMessageId, error);
            else
                this.messageBus.markFailed(run.teamMessageId, error ?? `Destination run ended ${state}`);
        }
        this.notifyWaiters(run.runId);
        const orchestration = this.findOrchestration(run);
        if (orchestration?.topology === 'team' && unit) {
            this.advanceTeamMember(orchestration, unit);
        }
        else if (orchestration?.topology === 'swarm' && unit && run.harnessId) {
            void this.finalizeStructuredSwarmUnit(orchestration, unit, run);
        }
        else if (orchestration?.topology === 'swarm' && unit && unit.substrate === 'terminal') {
            void this.finalizeSwarmTerminalUnit(orchestration, unit);
        }
    }
    async finalizeStructuredSwarmUnit(swarm, unit, run) {
        const manager = this.deps.getAgentRuntimeManager?.();
        if (manager && run.runtimeSessionId) {
            try {
                await manager.closeSession({ sessionId: run.runtimeSessionId, reason: `Swarm worker ${run.state}` });
            }
            catch (error) {
                unit.state = 'uncertain';
                unit.activity = 'Structured worker cleanup needs attention';
                unit.error = error instanceof Error ? error.message : String(error);
                this.commit('swarm-structured-close-unconfirmed');
                return;
            }
        }
        this.releaseUnitProcessResources(unit);
        if (run.state === 'done')
            await this.refreshPromotionEligibility(run, unit);
        this.commit('swarm-structured-closed');
        this.onSwarmWorkerSettled(swarm.swarmId, swarm.manifest);
    }
    async finalizeSwarmTerminalUnit(swarm, unit) {
        const backend = this.deps.getPtyBackend();
        const terminalId = unit.terminalId;
        if (terminalId && backend?.hasLiveInstance(terminalId)) {
            unit.activity = 'Closing worker terminal…';
            this.commit('swarm-terminal-close-intent');
            try {
                await backend.kill(terminalId);
            }
            catch { /* confirmed below */ }
            await this.waitForTerminalClose(backend, terminalId);
        }
        if (terminalId && (!backend || backend.hasLiveInstance(terminalId))) {
            unit.state = 'uncertain';
            unit.activity = 'Terminal close not confirmed';
            unit.error = 'Worker capacity remains reserved until the terminal process exits';
            this.commit('swarm-terminal-close-unconfirmed');
            return;
        }
        this.releaseUnitResources(swarm, unit);
        this.commit('swarm-terminal-closed');
        this.onSwarmWorkerSettled(swarm.swarmId, swarm.manifest);
    }
    advanceTeamMember(team, unit) {
        if (unit.userControlled) {
            unit.currentRunId = undefined;
            unit.state = 'interrupted';
            unit.activity = 'User controlled · automation paused';
            this.commit('team-member-automation-paused');
            return;
        }
        const currentIndex = unit.currentRunId ? unit.runIds.indexOf(unit.currentRunId) : -1;
        const nextRunId = unit.runIds.slice(currentIndex + 1).find((id) => this.registry.runs[id]?.state === 'pending');
        if (!nextRunId) {
            unit.currentRunId = undefined;
            if (unit.terminalId && this.deps.getPtyBackend()?.hasLiveInstance(unit.terminalId)) {
                unit.state = 'ready';
                unit.activity = 'Idle Team member';
            }
            this.commit('team-member-idle');
            return;
        }
        unit.currentRunId = nextRunId;
        unit.state = unit.terminalId ? 'readiness-test' : 'queued';
        this.commit('team-member-fifo-advance');
        this.enqueueUnit(team.teamId, unit.id);
    }
    // -----------------------------------------------------------------------
    // Screen/readiness helpers
    // -----------------------------------------------------------------------
    /** Resolve prompt sequencing from the persisted record when visible, or the
     * same validated main-owned launch used to create the terminal. */
    promptTargetForRun(run, record) {
        if (record) {
            return {
                agentType: record.agentType,
                startupCommand: record.startupCommand,
                forceAiAgent: record.forceAiAgent,
            };
        }
        const unit = this.findUnit(run);
        if (!unit)
            return null;
        // Same precedence as the launch itself: the user's saved command describes
        // the process that is actually running.
        const preset = unit.startupPresetId ? this.resolveStartupPreset(unit.startupPresetId, unit.target) : null;
        if (preset?.ok) {
            const spec = this.launchSpecForPreset(preset.preset, unit.target);
            return { agentType: spec.agentType, startupCommand: spec.command, forceAiAgent: spec.forceAiAgent };
        }
        const defaultArgs = this.deps.getCliRegistry()?.knownClis()
            .find((cli) => cli.id === unit.target)?.defaultSpawnArgs ?? [];
        const launch = (0, interactiveDelegation_1.buildInteractiveAgentLaunchSpec)(unit.target, run.model, run.category, defaultArgs, process.platform === 'win32');
        return launch ? {
            agentType: launch.agentType,
            startupCommand: launch.command,
            forceAiAgent: launch.forceAiAgent,
        } : null;
    }
    async waitForLiveTerminal(run) {
        const backend = this.deps.getPtyBackend();
        if (!backend || !run.terminalId)
            return false;
        const started = Date.now();
        while (Date.now() - started < TERMINAL_LIVE_DEADLINE_MS) {
            if (run.state === 'cancelled')
                return false;
            if (backend.hasLiveInstance(run.terminalId))
                return true;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return backend.hasLiveInstance(run.terminalId);
    }
    async attachScreen(run) {
        const backend = this.deps.getPtyBackend();
        const connectionService = this.deps.getTerminalConnectionService();
        if (!connectionService)
            throw new Error('Terminal connection service is unavailable');
        const terminalId = run.terminalId;
        let runtime = this.runtimes.get(run.runId);
        if (!runtime) {
            runtime = { abort: new AbortController() };
            this.runtimes.set(run.runId, runtime);
        }
        runtime.disposeOutput?.();
        const initialSize = backend.getSize(terminalId);
        const screen = new TerminalScreenModel_1.TerminalScreenModel(initialSize?.rows, initialSize?.cols);
        const feedAtLiveSize = (data) => {
            const size = backend.getSize(terminalId);
            if (size)
                screen.resize(size.rows, size.cols);
            screen.feed(data);
        };
        runtime.screen = screen;
        const observation = await (0, TerminalConnectionObserver_1.observeTerminalConnection)({
            service: connectionService,
            terminalId,
            subjectId: `team-run:${run.runId}`,
            onSnapshot: (data, replace) => {
                if (replace)
                    screen.reset();
                feedAtLiveSize(data);
            },
            onOutput: feedAtLiveSize,
        });
        const disposeResize = backend.onResize(terminalId, (size) => screen.resize(size.rows, size.cols));
        runtime.observedOwner = observation.identity;
        runtime.disposeOutput = () => {
            disposeResize();
            observation.dispose();
        };
        return screen;
    }
    async waitForReadiness(run, screen, kind, target) {
        const started = Date.now();
        const unknownMarkerAttentionMs = unknownMarkerAttentionDelayMs(process.platform, target);
        while (Date.now() - started < READINESS_DEADLINE_MS) {
            if (run.state === 'cancelled')
                return { ready: false, markerKnown: true };
            const result = screen.readiness(kind);
            const elapsed = Date.now() - started;
            // The positive composer must remain the current, quiet screen long
            // enough to exclude the transient pre-MCP frame Codex paints during
            // startup. Timing only restricts a positive signal; it never creates one.
            if (result.ready &&
                elapsed >= READINESS_MIN_OBSERVE_MS &&
                Date.now() - screen.lastUpdatedAt >= READINESS_SCREEN_QUIET_MS) {
                return { ready: true, markerKnown: true };
            }
            if (!result.markerKnown && elapsed >= unknownMarkerAttentionMs) {
                return { ready: false, markerKnown: false };
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return { ready: false, markerKnown: screen.readiness(kind).markerKnown };
    }
    async sessionWatermark(terminal, target) {
        if (!terminal.lastSessionId || !isResumeAgentType(target))
            return null;
        const resume = this.deps.getResumeManager();
        if (!resume)
            return null;
        try {
            const detail = await resume.getSessionDetail(target, terminal.lastSessionId);
            return detail ? { sessionId: terminal.lastSessionId, messageCount: detail.messages.length } : null;
        }
        catch {
            return null;
        }
    }
    // -----------------------------------------------------------------------
    // Resource ownership
    // -----------------------------------------------------------------------
    availableReservations() {
        return Math.max(0, this.capacityLimit() - Object.keys(this.registry.reservations).length);
    }
    capacityLimit() {
        const configured = this.deps.getConcurrencyLimit?.();
        return typeof configured === 'number' && Number.isFinite(configured)
            ? Math.min(Math.max(Math.floor(configured), 1), 8)
            : this.defaultConcurrencyLimit;
    }
    reserve(ownerId, projectId) {
        if (this.availableReservations() <= 0)
            return undefined;
        const id = node_crypto_1.default.randomUUID();
        this.registry.reservations[id] = { id, ownerId, projectId, createdAt: Date.now() };
        return id;
    }
    holdCredit(swarmId, workerId) {
        const id = node_crypto_1.default.randomUUID();
        this.registry.credits[id] = { id, swarmId, workerId, state: 'hold', createdAt: Date.now() };
        return id;
    }
    claimTerminal(orchestration, unit, terminalId) {
        const existing = this.registry.claims[terminalId];
        const orchestrationId = orchestration.topology === 'team' ? orchestration.teamId : orchestration.swarmId;
        if (existing && (existing.orchestrationId !== orchestrationId || existing.unitId !== unit.id))
            return false;
        if (existing)
            return true;
        this.registry.claims[terminalId] = { orchestrationId, unitId: unit.id };
        this.commit('terminal-claim-acquired');
        return true;
    }
    releaseUnitProcessResources(unit) {
        if (unit.reservationId) {
            delete this.registry.reservations[unit.reservationId];
            delete unit.reservationId;
        }
        if (unit.creditId) {
            const credit = this.registry.credits[unit.creditId];
            if (credit?.state === 'hold')
                delete this.registry.credits[unit.creditId];
            delete unit.creditId;
            delete unit.creditState;
        }
    }
    releaseUnitResources(orchestration, unit) {
        this.releaseUnitProcessResources(unit);
        this.releaseTerminalClaim(orchestration, unit);
    }
    releaseTerminalClaim(orchestration, unit) {
        if (!unit.terminalId)
            return;
        const orchestrationId = orchestration.topology === 'team' ? orchestration.teamId : orchestration.swarmId;
        const claim = this.registry.claims[unit.terminalId];
        if (claim?.orchestrationId === orchestrationId && claim.unitId === unit.id)
            delete this.registry.claims[unit.terminalId];
        this.inputSerializer.release(unit.terminalId);
    }
    async closeFallbackTerminal(orchestration, unit) {
        if (unit.currentRunId)
            this.disposeRuntime(unit.currentRunId);
        const terminalId = unit.terminalId;
        if (!terminalId)
            return { ok: true };
        if (unit.adoptedTerminal) {
            // The human owns this terminal — a fallback gives it back, it does not
            // kill it. The unit unbinds, so a retry provisions its own terminal
            // instead of taking a second run at someone else's session.
            this.releaseTerminalClaim(orchestration, unit);
            delete unit.terminalId;
            delete unit.adoptedTerminal;
            this.commit('fallback-adopted-terminal-released');
            return { ok: true };
        }
        const backend = this.deps.getPtyBackend();
        if (!backend)
            return { ok: false, error: 'Terminal backend is unavailable; ownership was retained' };
        if (backend.hasLiveInstance(terminalId)) {
            try {
                await backend.kill(terminalId);
            }
            catch { /* confirmed below */ }
            await this.waitForTerminalClose(backend, terminalId);
        }
        if (backend.hasLiveInstance(terminalId)) {
            unit.activity = 'Terminal close not confirmed';
            unit.error = 'Retry cannot continue while the failed terminal may still be running';
            this.commit('fallback-terminal-close-unconfirmed');
            return { ok: false, error: unit.error };
        }
        this.releaseTerminalClaim(orchestration, unit);
        delete unit.terminalId;
        this.commit('fallback-terminal-closed');
        return { ok: true };
    }
    capacityError(requested) {
        const held = Object.keys(this.registry.reservations).length;
        return `Agent orchestration capacity is full (${held}/${this.capacityLimit()} slots held; ${requested} requested)`;
    }
    // -----------------------------------------------------------------------
    // Validation, authorization, and lookup
    // -----------------------------------------------------------------------
    /**
     * Whether a terminal the user opened themselves can be adopted as a Team
     * member, and the dispatch target id it maps to.
     *
     * One place decides this: the Tasks dispatcher pre-checks with it so the
     * dialog can say why, and manifest validation re-checks with it so the
     * verdict is main's at the moment of admission, not the caller's from a
     * frame earlier. Identity comes from the startup command first — that is
     * what actually runs — and only then from the persisted `agentType`.
     */
    adoptableTerminalTarget(terminalId) {
        const store = this.deps.getStoreManager();
        const backend = this.deps.getPtyBackend();
        if (!store || !backend)
            return { ok: false, error: 'the terminal backend is unavailable' };
        const location = store.findTerminalLocation(terminalId);
        if (!location)
            return { ok: false, error: 'that terminal no longer exists' };
        const { project, terminal } = location;
        const label = terminal.name || terminal.agentType;
        if (!(0, contracts_1.isInteractiveAgentTerminal)(terminal.agentType, terminal.startupCommand, terminal.forceAiAgent)) {
            // A staged submit into a shell executes as a command — the same rule
            // cross-project links enforce.
            return { ok: false, error: `"${label}" is not an AI terminal` };
        }
        if (!backend.hasLiveInstance(terminalId))
            return { ok: false, error: `"${label}" is not running` };
        if (this.registry.claims[terminalId]) {
            return { ok: false, error: `"${label}" is already owned by another orchestration` };
        }
        const target = (0, agentIdentity_1.normalizeAgentId)((0, agentIdentity_1.resolveAgentIdFromCommand)(terminal.startupCommand) || terminal.agentType);
        if (!target || !headlessMode_1.HEADLESS_SPECS[target]) {
            return { ok: false, error: `"${label}" runs an agent this app cannot dispatch to` };
        }
        return { ok: true, target, name: label, projectId: project.id };
    }
    adoptableTerminal(terminalId, target) {
        const verdict = this.adoptableTerminalTarget(terminalId);
        if (!verdict.ok)
            return verdict;
        if (verdict.target !== (0, agentIdentity_1.normalizeAgentId)(target)) {
            return { ok: false, error: `"${verdict.name}" runs ${verdict.target}, not ${target}` };
        }
        return { ok: true };
    }
    /**
     * A saved AI startup preset, resolved from the user's preferences by id.
     *
     * Manifests carry the id and never the command, so this is the only place a
     * launch string can come from — and it can only be one the user themselves
     * saved. The preset must launch the member's declared target: a manifest
     * that says `codex` and a preset that runs `claude` is a mismatch, not a
     * silent override.
     */
    resolveStartupPreset(presetId, target) {
        const presets = this.deps.getStoreManager()?.getPreferences().startupCommands?.customPresets ?? [];
        const preset = presets.find((item) => item.id === presetId);
        if (!preset)
            return { ok: false, error: 'that startup command no longer exists' };
        if (!preset.isAiAgent)
            return { ok: false, error: `"${preset.name}" is not an AI startup command` };
        const presetAgent = (0, agentIdentity_1.normalizeAgentId)((0, agentIdentity_1.resolveAgentIdFromCommand)(preset.command) ?? '');
        if (presetAgent !== (0, agentIdentity_1.normalizeAgentId)(target)) {
            return { ok: false, error: `"${preset.name}" launches ${presetAgent || 'an unknown agent'}, not ${target}` };
        }
        return { ok: true, preset };
    }
    /** The launch a saved preset describes, in the shape the spawn path wants. */
    launchSpecForPreset(preset, target) {
        const agentId = (0, agentIdentity_1.normalizeAgentId)((0, agentIdentity_1.resolveAgentIdFromCommand)(preset.command) ?? target);
        const agentType = agentId in types_1.AGENT_CONFIG ? agentId : 'custom';
        return {
            agentType,
            name: preset.name.trim() || types_1.AGENT_CONFIG[agentType].name,
            command: preset.command,
            // A wrapper command ('custom') would otherwise be classified as a shell.
            forceAiAgent: true,
        };
    }
    validateTeamManifest(raw) {
        if (!raw || typeof raw !== 'object' || typeof raw.clientRequestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw.clientRequestId.trim()))
            return { ok: false, error: 'clientRequestId must be a 1..128 character opaque id' };
        if (!Array.isArray(raw.members) || raw.members.length < 1 || raw.members.length > agentTeams_1.AGENT_TEAM_MAX_MEMBERS)
            return { ok: false, error: `Team members must contain 1..${agentTeams_1.AGENT_TEAM_MAX_MEMBERS} entries` };
        if (raw.defaultSubstrate !== undefined && !VALID_SUBSTRATES.has(raw.defaultSubstrate))
            return { ok: false, error: 'Invalid Team defaultSubstrate' };
        if (raw.defaultRuntimePreference !== undefined && !runtimePolicy_1.AGENT_RUNTIME_PREFERENCES.includes(raw.defaultRuntimePreference))
            return { ok: false, error: 'Invalid Team defaultRuntimePreference' };
        if (raw.closeTerminalsOnStop !== undefined && typeof raw.closeTerminalsOnStop !== 'boolean')
            return { ok: false, error: 'closeTerminalsOnStop must be boolean' };
        if (raw.workspaceId !== undefined && (typeof raw.workspaceId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw.workspaceId)))
            return { ok: false, error: 'workspaceId must be a 1..128 character workspace id' };
        const members = [];
        for (const item of raw.members) {
            if (!item || typeof item.target !== 'string' || !headlessMode_1.HEADLESS_SPECS[item.target])
                return { ok: false, error: `Unknown Team agent: ${item?.target ?? ''}` };
            if (item.deviceId !== undefined && (typeof item.deviceId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(item.deviceId)))
                return { ok: false, error: 'member deviceId must be a 1..128 character device id' };
            if (item.deviceName !== undefined && typeof item.deviceName !== 'string')
                return { ok: false, error: 'member deviceName must be a string' };
            if (item.projectId !== undefined && (typeof item.projectId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(item.projectId)))
                return { ok: false, error: 'member projectId must be a 1..128 character project id' };
            if (item.deviceId && !item.projectId)
                return { ok: false, error: `A peer Team member must declare its owner-side projectId (member: ${item.target})` };
            if (item.deviceId && item.terminalId)
                return { ok: false, error: 'Peer terminal adoption requires a catalog generation and is not accepted by Team manifests' };
            if (item.deviceId && item.startupPresetId)
                return { ok: false, error: 'A startup preset id is local to its owning device and cannot be sent in a peer Team manifest' };
            // D4: a workspace-scoped team never guesses where a unit runs —
            // adopted members included (their declaration must match the terminal).
            if (raw.workspaceId !== undefined && item.projectId === undefined) {
                return { ok: false, error: `Workspace-scoped Team members must declare a projectId (member: ${item.target})` };
            }
            if (typeof item.prompt !== 'string' || !item.prompt.trim())
                return { ok: false, error: 'Every Team member needs a prompt' };
            if (item.prompt.length > MANIFEST_TEXT_CAP_CHARS)
                return { ok: false, error: `Team member prompts are capped at ${MANIFEST_TEXT_CAP_CHARS} characters` };
            if (item.substrate !== undefined && !VALID_SUBSTRATES.has(item.substrate))
                return { ok: false, error: `Invalid substrate for ${item.target}` };
            if (item.runtimePreference !== undefined && !runtimePolicy_1.AGENT_RUNTIME_PREFERENCES.includes(item.runtimePreference))
                return { ok: false, error: `Invalid runtimePreference for ${item.target}` };
            if (item.category !== undefined && !(0, orchestrationRuns_1.isValidRunCategory)(item.category))
                return { ok: false, error: `Invalid category for ${item.target}` };
            if (item.model !== undefined && (typeof item.model !== 'string' || !(0, agentModels_2.isValidModelId)(item.model)))
                return { ok: false, error: `Invalid model for ${item.target}` };
            if (item.sharedCwd !== undefined && typeof item.sharedCwd !== 'boolean')
                return { ok: false, error: 'sharedCwd must be boolean' };
            if (item.skill && !orchestrationPolicy_1.ORCHESTRATION_SKILL_COMMAND_RE.test(item.skill))
                return { ok: false, error: `Invalid skill for ${item.target}` };
            const requestedRuntime = item.runtimePreference ?? raw.defaultRuntimePreference;
            if (item.skill && requestedRuntime === 'structured')
                return { ok: false, error: 'A slash skill requires the native terminal runtime' };
            if (item.skill && item.substrate === 'headless')
                return { ok: false, error: 'A slash skill requires terminal substrate' };
            if (item.category && orchestrationPolicy_1.INTRINSIC_TERMINAL_SKILLS[item.category] && item.substrate === 'headless' && requestedRuntime !== 'structured')
                return { ok: false, error: `${item.category} cannot run headlessly` };
            // Adoption and preset launches are both terminal-substrate facts, and
            // they are mutually exclusive: a terminal that already exists is not
            // launched from anything.
            if (!item.deviceId && item.terminalId !== undefined) {
                if (typeof item.terminalId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(item.terminalId)) {
                    return { ok: false, error: 'terminalId must be a 1..128 character terminal id' };
                }
                if (item.startupPresetId !== undefined)
                    return { ok: false, error: 'a member cannot both adopt a terminal and launch a startup preset' };
                if (item.substrate === 'headless' || requestedRuntime === 'structured') {
                    return { ok: false, error: 'adopting a terminal requires the native terminal runtime' };
                }
                const adoptable = this.adoptableTerminal(item.terminalId, item.target);
                if (!adoptable.ok)
                    return adoptable;
            }
            if (!item.deviceId && item.startupPresetId !== undefined) {
                if (typeof item.startupPresetId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(item.startupPresetId)) {
                    return { ok: false, error: 'startupPresetId must be a 1..128 character preset id' };
                }
                if (item.substrate === 'headless' || requestedRuntime === 'structured') {
                    return { ok: false, error: 'a startup preset requires the native terminal runtime' };
                }
                const preset = this.resolveStartupPreset(item.startupPresetId, item.target);
                if (!preset.ok)
                    return preset;
            }
            members.push({
                ...item,
                prompt: item.prompt.trim(),
                role: safeRole(item.role),
                ...(item.deviceName ? { deviceName: safeRole(item.deviceName) } : {}),
            });
        }
        return { ok: true, manifest: { ...raw, clientRequestId: raw.clientRequestId.trim(), members } };
    }
    validateSwarmManifest(raw) {
        if (!raw || typeof raw !== 'object' || typeof raw.clientRequestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw.clientRequestId.trim()))
            return { ok: false, error: 'clientRequestId must be a 1..128 character opaque id' };
        const canonical = canonicalizeSwarmManifestBrief(raw);
        if (!canonical.ok)
            return canonical;
        const manifest = canonical.manifest;
        if (manifest.brief.length > MANIFEST_TEXT_CAP_CHARS)
            return { ok: false, error: `Swarm briefs are capped at ${MANIFEST_TEXT_CAP_CHARS} characters` };
        if (!Number.isInteger(manifest.count) || manifest.count < 1 || manifest.count > agentTeams_1.AGENT_SWARM_MAX_WORKERS)
            return { ok: false, error: `Swarm count must be 1..${agentTeams_1.AGENT_SWARM_MAX_WORKERS}` };
        if (!Array.isArray(manifest.targets) || manifest.targets.length < 1 || manifest.targets.some((target) => typeof target !== 'string' || !headlessMode_1.HEADLESS_SPECS[target]))
            return { ok: false, error: 'Swarm targets contain an unknown agent' };
        if (manifest.substrate !== undefined && !VALID_SUBSTRATES.has(manifest.substrate))
            return { ok: false, error: 'Invalid Swarm substrate' };
        if (manifest.runtimePreference !== undefined && !runtimePolicy_1.AGENT_RUNTIME_PREFERENCES.includes(manifest.runtimePreference))
            return { ok: false, error: 'Invalid Swarm runtimePreference' };
        if (manifest.category !== undefined && !(0, orchestrationRuns_1.isValidRunCategory)(manifest.category))
            return { ok: false, error: 'Invalid Swarm category' };
        if (manifest.model !== undefined && (typeof manifest.model !== 'string' || !(0, agentModels_2.isValidModelId)(manifest.model)))
            return { ok: false, error: 'Invalid Swarm model' };
        if (manifest.sandbox !== undefined && manifest.sandbox !== 'read' && manifest.sandbox !== 'write')
            return { ok: false, error: 'Swarm sandbox must be read or write' };
        if (manifest.workspaceId !== undefined && (typeof manifest.workspaceId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(manifest.workspaceId)))
            return { ok: false, error: 'workspaceId must be a 1..128 character workspace id' };
        // Fail the manifest, not the workers: headless workers run under each
        // CLI's enforced sandbox, and a target without one would otherwise be
        // admitted here only to die per-worker with no output.
        if (this.resolveSubstrate('swarm', manifest, manifest.substrate) === 'headless') {
            const unsupported = [...new Set(manifest.targets.filter((target) => !swarmSandboxFlags(target, manifest.sandbox ?? 'read')))];
            if (unsupported.length > 0) {
                return { ok: false, error: `Headless Swarm workers run under an enforced sandbox, which ${unsupported.join(', ')} cannot provide — use targets ${exports.SWARM_SANDBOX_TARGETS.join(', ')}, or "substrate":"terminal" for other agents` };
            }
        }
        if (manifest.poolSize !== undefined && (!Number.isFinite(manifest.poolSize) || !Number.isInteger(manifest.poolSize) || manifest.poolSize < 1))
            return { ok: false, error: 'Swarm poolSize must be a positive integer' };
        if (manifest.budget !== undefined && (!Number.isFinite(manifest.budget) || !Number.isInteger(manifest.budget) || manifest.budget < 1))
            return { ok: false, error: 'Swarm budget must be a positive integer' };
        if (manifest.timeoutSeconds !== undefined && (!Number.isFinite(manifest.timeoutSeconds) || manifest.timeoutSeconds < 1))
            return { ok: false, error: 'Swarm timeoutSeconds must be positive' };
        if (manifest.skill && !orchestrationPolicy_1.ORCHESTRATION_SKILL_COMMAND_RE.test(manifest.skill))
            return { ok: false, error: 'Swarm skill must be a slash command' };
        if (manifest.skill && manifest.runtimePreference === 'structured')
            return { ok: false, error: 'A Swarm slash skill requires the native terminal runtime' };
        if (manifest.skill && manifest.substrate === 'headless')
            return { ok: false, error: 'A Swarm slash skill requires terminal substrate' };
        if (manifest.category && orchestrationPolicy_1.INTRINSIC_TERMINAL_SKILLS[manifest.category] && manifest.substrate === 'headless' && manifest.runtimePreference !== 'structured')
            return { ok: false, error: `${manifest.category} cannot run headlessly` };
        const budget = Math.min(Math.max(Math.floor(manifest.budget ?? manifest.count), 1), agentTeams_1.AGENT_SWARM_MAX_WORKERS * 2);
        const poolSize = Math.min(Math.max(Math.floor(manifest.poolSize ?? agentTeams_1.AGENT_SWARM_DEFAULT_POOL), 1), this.capacityLimit());
        return { ok: true, manifest: { ...manifest, clientRequestId: manifest.clientRequestId.trim(), budget, poolSize } };
    }
    resolveSubstrate(topology, item, defaultSubstrate) {
        if (item.skill || (item.category && orchestrationPolicy_1.INTRINSIC_TERMINAL_SKILLS[item.category]))
            return 'terminal';
        const requested = item.substrate ?? defaultSubstrate ?? 'auto';
        if (requested === 'terminal' || requested === 'headless')
            return requested;
        return topology === 'team' ? 'terminal' : 'headless';
    }
    composeMemberPrompt(item, structured = false) {
        const skill = item.skill ?? (!structured && item.category ? orchestrationPolicy_1.INTRINSIC_TERMINAL_SKILLS[item.category] : undefined);
        return skill ? (0, interactiveDelegation_1.buildInteractiveDelegationPrompt)(item.prompt, item.target, skill) : item.prompt;
    }
    registerTeamMessageLedger(team) {
        const members = team.members.map((member) => ({
            memberId: member.id,
            role: member.role,
            target: member.target,
            terminalId: member.terminalId,
            state: member.state,
            userControlled: member.userControlled,
        }));
        const lead = team.members.find((member) => /\b(lead|orchestrator|maestro)\b/i.test(member.role ?? ''))
            ?? team.members[0];
        const connections = lead
            ? team.members.filter((member) => member.id !== lead.id).flatMap((member) => ([
                {
                    teamId: team.teamId,
                    fromMemberId: lead.id,
                    toMemberId: member.id,
                    permissions: ['send', 'ask', 'share-artifact'],
                },
                {
                    teamId: team.teamId,
                    fromMemberId: member.id,
                    toMemberId: lead.id,
                    permissions: ['send', 'ask', 'share-artifact'],
                },
            ]))
            : [];
        this.messageBus.registerTeam({
            teamId: team.teamId,
            projectId: team.projectId,
            hostTerminalId: team.hostTerminalId,
            members,
            connections,
        });
    }
    teamMessagePrincipal(principal) {
        if (principal.kind === 'renderer-user') {
            return { kind: 'user', projectId: principal.projectId, terminalId: principal.terminalId };
        }
        const claim = this.registry.claims[principal.terminalId];
        const team = claim ? this.registry.teams[claim.orchestrationId] : undefined;
        if (principal.kind === 'team-member' && claim && team?.members.some((member) => member.id === claim.unitId)) {
            return {
                kind: 'member',
                projectId: principal.projectId,
                terminalId: principal.terminalId,
                teamId: team.teamId,
                memberId: claim.unitId,
            };
        }
        return { kind: 'controller', projectId: principal.projectId, terminalId: principal.terminalId };
    }
    teamReadContext(principal, teamId) {
        const caller = this.teamMessagePrincipal(principal);
        const team = this.registry.teams[teamId];
        if (caller.kind !== 'member' ||
            caller.teamId !== teamId ||
            !team ||
            team.projectId !== caller.projectId ||
            !team.members.some((member) => member.id === caller.memberId && member.terminalId === caller.terminalId)) {
            return null;
        }
        return { caller, team };
    }
    async createMessageRun(message) {
        const team = this.registry.teams[message.teamId];
        if (!team || team.state !== 'active')
            throw new Error('Destination Team is not active');
        const member = team.members.find((item) => item.id === message.toMemberId);
        if (!member)
            throw new Error('Destination Team member is unavailable');
        if (member.userControlled)
            throw new Error('Automated delivery is paused while the member is user-controlled');
        const run = this.newRun({
            topology: 'team',
            projectId: this.unitProjectId(team, member),
            teamId: team.teamId,
            memberId: member.id,
            target: member.target,
            prompt: message.body,
            substrate: member.substrate,
            runtimePreference: member.runtimePreference,
            deviceId: member.deviceId,
            deviceName: member.deviceName,
            clientSubmissionId: message.clientSubmissionId,
            teamMessageId: message.messageId,
        });
        this.registry.runs[run.runId] = run;
        member.runIds.push(run.runId);
        if (!member.currentRunId)
            member.currentRunId = run.runId;
        this.commit('team-message-run-intent');
        this.writeRunRecord(run);
        if (member.currentRunId === run.runId)
            this.enqueueUnit(team.teamId, member.id);
        return { runId: run.runId };
    }
    async collectRunForMessage(runId, timeoutMs) {
        const run = this.registry.runs[runId];
        if (!run)
            return { ok: false, error: 'Destination run is unavailable' };
        if (!(0, agentTeams_1.isTerminalState)(run.state) && timeoutMs > 0)
            await this.waitForRun(runId, timeoutMs);
        const current = this.registry.runs[runId];
        if (!(0, agentTeams_1.isTerminalState)(current.state))
            return { ok: true, stillRunning: true, state: current.state };
        return {
            ok: current.state === 'done',
            state: current.state,
            output: current.output,
            error: current.error,
            run: this.publicRun(current),
        };
    }
    authorized(principal, item) {
        return principal.kind !== 'worker' && principal.projectId === item.projectId && principal.terminalId === item.hostTerminalId;
    }
    authorizedRun(principal, run) {
        // Authority is the HOST's (host project + host terminal). `run.projectId`
        // is the unit's project (workspace_control D4) and may legitimately
        // differ from the host's on a workspace-scoped team, so it no longer
        // gates collect — the orchestration record does.
        if (principal.kind === 'worker')
            return false;
        const item = this.findOrchestration(run);
        return !!item && item.projectId === principal.projectId && item.hostTerminalId === principal.terminalId;
    }
    /** The unit's home project; registries persisted before Workspace Control
     * lack the field and default to the orchestration's host project (D4). */
    unitProjectId(item, unit) {
        return unit.projectId ?? item.projectId;
    }
    findOrchestration(run) {
        return run.teamId ? this.registry.teams[run.teamId] : run.swarmId ? this.registry.swarms[run.swarmId] : undefined;
    }
    findOrchestrationById(orchestrationId) {
        return this.registry.teams[orchestrationId]
            ?? this.registry.swarms[orchestrationId];
    }
    findUnit(run) {
        if (run.teamId && run.memberId)
            return this.registry.teams[run.teamId]?.members.find((item) => item.id === run.memberId);
        if (run.swarmId && run.workerId)
            return this.registry.swarms[run.swarmId]?.workers.find((item) => item.id === run.workerId);
        return undefined;
    }
    runsFor(orchestrationId) {
        return Object.values(this.registry.runs)
            .filter((run) => run.teamId === orchestrationId || run.swarmId === orchestrationId)
            .map((run) => this.publicRun(run));
    }
    /** Native completion capabilities are file-scoped secrets consumed only by
     * the installed hook. Never return them through CLI, renderer, or collect. */
    publicRun(run) {
        return { ...clone(run), capabilityToken: '' };
    }
    newRun(input) {
        const runId = node_crypto_1.default.randomUUID();
        const run = {
            runId, projectId: input.projectId, topology: input.topology,
            target: input.target, prompt: input.prompt,
            promptFingerprint: fingerprint(input.prompt), state: 'pending', substrate: input.substrate,
            capabilityToken: node_crypto_1.default.randomBytes(32).toString('base64url'), createdAt: Date.now(),
            ...(input.teamId ? { teamId: input.teamId } : {}),
            ...(input.memberId ? { memberId: input.memberId } : {}),
            ...(input.swarmId ? { swarmId: input.swarmId } : {}),
            ...(input.workerId ? { workerId: input.workerId } : {}),
            ...(input.category ? { category: input.category } : {}),
            ...(input.skill ? { skill: input.skill } : {}),
            ...(input.model ? { model: input.model } : {}),
            ...(input.runtimePreference ? { runtimePreference: input.runtimePreference } : {}),
            ...(input.clientSubmissionId ? { clientSubmissionId: input.clientSubmissionId } : {}),
            ...(input.teamMessageId ? { teamMessageId: input.teamMessageId } : {}),
            ...(input.deviceId ? { deviceId: input.deviceId } : {}),
            ...(input.deviceName ? { deviceName: input.deviceName } : {}),
        };
        return run;
    }
    cwdFor(projectId) {
        return this.deps.getStoreManager()?.getProjects().find((project) => project.id === projectId)?.rootPath ?? process.cwd();
    }
    async ensureUnitWorktree(orchestration, unit) {
        if (!unit.worktreeRequired)
            return { ok: true };
        if (unit.worktreePath && node_fs_1.default.existsSync(unit.worktreePath))
            return { ok: true };
        if (!unit.worktreePath) {
            // Worktrees derive from the MEMBER project's repo, never the host's
            // (workspace_control D4).
            const root = this.cwdFor(this.unitProjectId(orchestration, unit));
            const orchestrationId = orchestration.topology === 'team' ? orchestration.teamId : orchestration.swarmId;
            const suffix = `${orchestration.topology}-${orchestrationId.slice(0, 8)}-${unit.id.slice(0, 8)}`;
            unit.worktreePath = node_path_1.default.join(node_path_1.default.dirname(root), `${node_path_1.default.basename(root)}-1devtool-${suffix}`);
            unit.worktreeBranch = `1devtool/${suffix}`;
            unit.activity = 'Preparing isolated worktree…';
            this.commit('worktree-create-intent');
        }
        const created = await this.deps.createTerminal({
            projectId: this.unitProjectId(orchestration, unit),
            worktreeOnly: true,
            createWorktree: {
                path: unit.worktreePath,
                newBranch: unit.worktreeBranch,
                startPoint: 'HEAD',
            },
            focusWindow: false,
        });
        if (!created.ok)
            return { ok: false, error: created.error ?? 'Dedicated worktree creation failed' };
        if (created.worktreePath)
            unit.worktreePath = created.worktreePath;
        if (!unit.worktreePath || !node_fs_1.default.existsSync(unit.worktreePath)) {
            return { ok: false, error: 'Dedicated worktree was not visible after creation' };
        }
        unit.activity = 'Worktree ready';
        this.commit('worktree-created');
        return { ok: true };
    }
    // -----------------------------------------------------------------------
    // Failure, revocation, waiters
    // -----------------------------------------------------------------------
    failBeforeSubmit(orchestration, unit, run, error) {
        // A late readiness/live check may settle after Stop has durably cancelled
        // the run. Never resurrect that terminal state as a fallback.
        if ((0, agentTeams_1.isTerminalState)(run.state))
            return;
        unit.state = 'fallback';
        unit.activity = 'Can\'t run';
        unit.error = error;
        run.state = 'error';
        run.error = error;
        run.completedAt = Date.now();
        this.writeRunRecord(run);
        // Terminal fallback is recoverable: retain its capacity reservation and
        // terminal claim until the user explicitly retries, rebinds, skips, or
        // closes it. A proven headless pre-spawn failure has no live process and
        // may release its reservation immediately.
        if (unit.substrate === 'headless' || (run.harnessId && !run.terminalId)) {
            this.releaseUnitProcessResources(unit);
        }
        this.commit('unit-fallback');
        if (run.teamMessageId)
            this.messageBus.markFailed(run.teamMessageId, error);
        this.notifyWaiters(run.runId);
        if (orchestration.topology === 'swarm') {
            // Proven pre-submission failure is retryable by a future explicit
            // action. The automatic pool simply advances other queued slots.
            setTimeout(() => this.onSwarmWorkerSettled(orchestration.swarmId, orchestration.manifest), 0);
        }
    }
    handleLeaseRevocation(terminalId, runId, partial) {
        const run = this.registry.runs[runId];
        if (!run || run.terminalId !== terminalId || (0, agentTeams_1.isTerminalState)(run.state))
            return;
        const unit = this.findUnit(run);
        run.userControlled = true;
        if (partial || run.state === 'submitting') {
            run.state = 'submission-interrupted';
            run.error = 'User input revoked the Team lease during prompt submission';
            run.completedAt = Date.now();
        }
        else {
            run.state = 'uncertain';
            run.error = 'User took control while the delegated run was active';
            run.completedAt = Date.now();
        }
        if (unit) {
            unit.userControlled = true;
            unit.state = 'interrupted';
            unit.activity = partial ? 'Submission interrupted' : 'User controlled';
        }
        if (run.teamId && run.memberId) {
            this.messageBus.pauseMember(run.teamId, run.memberId);
            const team = this.registry.teams[run.teamId];
            const member = team?.members.find((item) => item.id === run.memberId);
            if (member) {
                for (const queuedRunId of member.runIds) {
                    if (queuedRunId === runId)
                        continue;
                    const queuedRun = this.registry.runs[queuedRunId];
                    if (!queuedRun || queuedRun.state !== 'pending')
                        continue;
                    queuedRun.state = 'cancelled';
                    queuedRun.error = 'Automated delivery was cancelled when the user took control';
                    queuedRun.completedAt = Date.now();
                    if (queuedRun.teamMessageId)
                        this.messageBus.markCancelled(queuedRun.teamMessageId, queuedRun.error);
                    this.writeRunRecord(queuedRun);
                    this.notifyWaiters(queuedRun.runId);
                }
            }
        }
        if (run.teamMessageId)
            this.messageBus.markCancelled(run.teamMessageId, run.error);
        this.disposeRuntime(runId);
        this.clearNativeHook(run);
        this.writeRunRecord(run);
        this.commit('terminal-lease-revoked');
        this.notifyWaiters(runId);
        const orchestration = this.findOrchestration(run);
        if (orchestration?.topology === 'swarm' && unit?.substrate === 'terminal') {
            void this.finalizeSwarmTerminalUnit(orchestration, unit);
        }
    }
    async waitForRuntimeDrain(runIds) {
        const deadline = Date.now() + PROCESS_CLOSE_DEADLINE_MS;
        while (runIds.some((runId) => this.runtimes.has(runId)) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }
    async waitForTerminalClose(backend, terminalId) {
        const deadline = Date.now() + PROCESS_CLOSE_DEADLINE_MS;
        while (backend.hasLiveInstance(terminalId) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }
    waitForRun(runId, timeoutMs) {
        return new Promise((resolve) => {
            const listeners = this.waiters.get(runId) ?? new Set();
            let timer;
            const finish = () => {
                clearTimeout(timer);
                listeners.delete(finish);
                if (listeners.size === 0)
                    this.waiters.delete(runId);
                resolve();
            };
            listeners.add(finish);
            this.waiters.set(runId, listeners);
            timer = setTimeout(finish, Math.min(Math.max(timeoutMs, 0), 10 * 60_000));
        });
    }
    notifyWaiters(runId) {
        for (const listener of [...(this.waiters.get(runId) ?? [])])
            listener();
    }
    clearNativeHook(run) {
        if (!run.terminalId)
            return;
        (0, hookCapability_1.clearHookCapability)(this.homeDir, run.terminalId, run.runId);
    }
    disposeRuntime(runId) {
        const runtime = this.runtimes.get(runId);
        if (!runtime)
            return;
        if (runtime.completionTimer)
            clearInterval(runtime.completionTimer);
        if (runtime.heartbeatTimer)
            clearInterval(runtime.heartbeatTimer);
        runtime.disposeOutput?.();
        this.runtimes.delete(runId);
    }
    // -----------------------------------------------------------------------
    // Durable journal and restart reconciliation
    // -----------------------------------------------------------------------
    commit(reason) {
        this.registry.sequence += 1;
        for (const item of [...Object.values(this.registry.teams), ...Object.values(this.registry.swarms)]) {
            item.updatedAt = Date.now();
        }
        const dir = node_path_1.default.dirname(this.registryPath);
        (0, orchestrationRuns_1.ensureDir)(dir, 0o700);
        const journalLine = JSON.stringify({
            version: REGISTRY_VERSION,
            sequence: this.registry.sequence,
            at: Date.now(),
            reason,
            registry: this.registry,
        }) + '\n';
        const fd = node_fs_1.default.openSync(this.journalPath, 'a', 0o600);
        try {
            node_fs_1.default.writeSync(fd, journalLine, undefined, 'utf-8');
            node_fs_1.default.fsyncSync(fd);
        }
        finally {
            node_fs_1.default.closeSync(fd);
        }
        const tmp = `${this.registryPath}.${process.pid}.tmp`;
        node_fs_1.default.writeFileSync(tmp, JSON.stringify(this.registry), { encoding: 'utf-8', mode: 0o600 });
        node_fs_1.default.renameSync(tmp, this.registryPath);
        this.compactJournalIfNeeded();
        this.emitChanged();
    }
    loadRegistry() {
        const candidates = [];
        try {
            const parsed = JSON.parse(node_fs_1.default.readFileSync(this.registryPath, 'utf-8'));
            if (parsed?.version === REGISTRY_VERSION)
                candidates.push(parsed);
        }
        catch { /* cold/corrupt snapshot */ }
        try {
            const lines = node_fs_1.default.readFileSync(this.journalPath, 'utf-8').trim().split('\n').slice(-100);
            for (let index = lines.length - 1; index >= 0; index--) {
                try {
                    const event = JSON.parse(lines[index]);
                    if (event.registry?.version === REGISTRY_VERSION) {
                        candidates.push(event.registry);
                        break;
                    }
                }
                catch { /* try prior complete line */ }
            }
        }
        catch { /* no journal */ }
        candidates.sort((a, b) => b.sequence - a.sequence);
        return candidates[0] ?? emptyRegistry();
    }
    compactJournalIfNeeded() {
        try {
            if (node_fs_1.default.statSync(this.journalPath).size <= JOURNAL_MAX_BYTES)
                return;
            const compact = JSON.stringify({
                version: REGISTRY_VERSION, sequence: this.registry.sequence, at: Date.now(),
                reason: 'journal-compaction', registry: this.registry,
            }) + '\n';
            const tmp = `${this.journalPath}.${process.pid}.tmp`;
            node_fs_1.default.writeFileSync(tmp, compact, { encoding: 'utf-8', mode: 0o600 });
            node_fs_1.default.renameSync(tmp, this.journalPath);
        }
        catch { /* snapshot remains authoritative */ }
    }
    async reconcile() {
        const backend = this.deps.getPtyBackend();
        const store = this.deps.getStoreManager();
        // One config parse for the whole startup reconcile — the existence check
        // below runs per unit of every persisted team/swarm, and getProjects()
        // re-parses the config file per call.
        const liveProjectIds = store ? new Set(store.getProjects().map((project) => project.id)) : null;
        const persistedClaims = { ...this.registry.claims };
        let changed = false;
        const resumeTeamUnits = [];
        const resumeSwarmUnits = [];
        const resumeSwarmPools = new Set();
        const finalizeSwarmTerminals = [];
        // Rebuild only claims that were durably owned and still resolve to the
        // same live, project-owned terminal. Merely finding a terminalId in a
        // snapshot is not authority to claim it after restart.
        const claims = {};
        for (const item of [...Object.values(this.registry.teams), ...Object.values(this.registry.swarms)]) {
            if (item.state === 'admitting') {
                // Admission already owned its durable reservations/manifest and had
                // not crossed an external side-effect boundary. Completing it is safe.
                item.state = 'active';
                changed = true;
            }
            const units = item.topology === 'team' ? item.members : item.workers;
            for (const unit of units) {
                const run = unit.currentRunId ? this.registry.runs[unit.currentRunId] : undefined;
                // Peer-owned processes survive a starter restart. Their local project,
                // terminal, pid, and reservation intentionally do not exist here; the
                // durable owner ids are sufficient to resume idempotent start/send or
                // read-only collect without re-attributing work to this host.
                const mayResume = item.state === 'active' || (item.topology === 'swarm' && item.state === 'draining' && unit.state !== 'queued');
                if (unit.deviceId) {
                    if (item.topology === 'team' && run && !(0, agentTeams_1.isTerminalState)(run.state) && mayResume) {
                        resumeTeamUnits.push({ teamId: item.teamId, unitId: unit.id });
                    }
                    continue;
                }
                // D2 restart reconciliation: a unit whose home project no longer
                // exists fails in place. It is NEVER silently re-attributed to the
                // host project — that would move spawn cwd, reservations, and run
                // attribution to a repo the member was never admitted to.
                if (unit.projectId && liveProjectIds && !liveProjectIds.has(unit.projectId)) {
                    if (run && !(0, agentTeams_1.isTerminalState)(run.state)) {
                        run.state = 'error';
                        run.error = `Member project ${unit.projectId} no longer exists`;
                        run.completedAt = Date.now();
                        this.writeRunRecord(run);
                    }
                    if (!INERT_UNIT_STATES.has(unit.state)) {
                        unit.state = 'failed';
                        unit.error = 'The member project no longer exists';
                        this.releaseUnitResources(item, unit);
                        changed = true;
                    }
                    continue;
                }
                // A finish-running Swarm remains in `draining`, but workers that had
                // already crossed admission must still complete after restart. Queued
                // workers were terminalized by drainSwarm and are never admitted.
                // A renderer may have persisted the deterministic terminal record and
                // crashed before starting its PTY or returning the ACK. Re-spawning
                // that exact record is idempotent and never creates a second terminal.
                if (unit.terminalId && backend && !backend.hasLiveInstance(unit.terminalId) &&
                    store?.findTerminalLocation(unit.terminalId) &&
                    persistedClaims[unit.terminalId]?.unitId === unit.id &&
                    !unit.needsAttention && run?.state === 'pending' && mayResume) {
                    try {
                        await this.deps.createTerminal({ spawnOnly: true, terminalId: unit.terminalId });
                    }
                    catch { /* classified by the live check below */ }
                }
                if (unit.state === 'gated-spawn' || unit.state === 'rebinding') {
                    const reaped = await this.reapPid(unit.pid, unit.pidStartedAt);
                    if (!reaped) {
                        if (run && !(0, agentTeams_1.isTerminalState)(run.state)) {
                            run.state = 'uncertain';
                            run.error = 'A gated child could not be identity-verified and reaped during recovery';
                            run.completedAt = Date.now();
                            this.writeRunRecord(run);
                        }
                        unit.state = 'uncertain';
                        unit.error = 'Process identity or shutdown could not be confirmed; capacity remains reserved';
                        changed = true;
                        continue;
                    }
                    if (run && !(0, agentTeams_1.isTerminalState)(run.state)) {
                        run.state = 'cancelled';
                        run.error = 'Cancelled during recovery before the brief was released';
                        run.completedAt = Date.now();
                        this.writeRunRecord(run);
                    }
                    unit.state = 'closed';
                    delete unit.pid;
                    delete unit.pidStartedAt;
                    this.releaseUnitResources(item, unit);
                    changed = true;
                    continue;
                }
                if ((unit.state === 'running' || unit.state === 'draining') && unit.substrate === 'headless') {
                    const reaped = await this.reapPid(unit.pid, unit.pidStartedAt);
                    if (run && !(0, agentTeams_1.isTerminalState)(run.state)) {
                        run.state = 'uncertain';
                        run.error = 'Headless attempt crossed the brief-release boundary before restart';
                        run.completedAt = Date.now();
                        this.writeRunRecord(run);
                    }
                    unit.state = 'uncertain';
                    if (reaped) {
                        delete unit.pid;
                        delete unit.pidStartedAt;
                        this.releaseUnitProcessResources(unit);
                    }
                    else {
                        unit.error = 'Process shutdown could not be confirmed; capacity remains reserved';
                    }
                    changed = true;
                    continue;
                }
                if (unit.terminalId && backend?.hasLiveInstance(unit.terminalId)) {
                    const orchestrationId = item.topology === 'team' ? item.teamId : item.swarmId;
                    const persisted = persistedClaims[unit.terminalId];
                    if (persisted?.orchestrationId === orchestrationId && persisted.unitId === unit.id) {
                        const collision = claims[unit.terminalId];
                        if (collision && (collision.orchestrationId !== orchestrationId || collision.unitId !== unit.id)) {
                            unit.state = 'uncertain';
                            unit.error = 'Terminal ownership claim conflicted during restart reconciliation';
                            changed = true;
                            continue;
                        }
                        claims[unit.terminalId] = { orchestrationId, unitId: unit.id };
                    }
                    if (run && ['submitting', 'running'].includes(run.state)) {
                        run.state = 'uncertain';
                        run.error = 'Interactive run outcome could not be proven after restart';
                        run.completedAt = Date.now();
                        this.writeRunRecord(run);
                        unit.state = 'interrupted';
                        changed = true;
                    }
                    else if (run?.state === 'pending' && !run.needsAttention && mayResume) {
                        if (item.topology === 'team')
                            resumeTeamUnits.push({ teamId: item.teamId, unitId: unit.id });
                        else
                            resumeSwarmUnits.push({ swarmId: item.swarmId, unitId: unit.id });
                    }
                    else if (item.topology === 'swarm' && run && (0, agentTeams_1.isTerminalState)(run.state) &&
                        persistedClaims[unit.terminalId]) {
                        finalizeSwarmTerminals.push({ swarmId: item.swarmId, unitId: unit.id });
                    }
                }
                else if (unit.terminalId && run?.state === 'pending' && !run.needsAttention &&
                    mayResume && persistedClaims[unit.terminalId]) {
                    // The renderer record may not have crossed its own persistence
                    // boundary yet. Retrying the journaled creation key is safe.
                    if (item.topology === 'team')
                        resumeTeamUnits.push({ teamId: item.teamId, unitId: unit.id });
                    else
                        resumeSwarmUnits.push({ swarmId: item.swarmId, unitId: unit.id });
                }
                else if (unit.terminalId && !['closed', 'done', 'failed', 'cancelled'].includes(unit.state)) {
                    if (run && !(0, agentTeams_1.isTerminalState)(run.state)) {
                        run.state = 'interrupted';
                        run.error = 'Delegate terminal was not live during restart reconciliation';
                        run.completedAt = Date.now();
                        this.writeRunRecord(run);
                    }
                    unit.state = 'interrupted';
                    this.releaseUnitResources(item, unit);
                    changed = true;
                }
                else if (!unit.terminalId && run?.state === 'pending' && !run.needsAttention && mayResume) {
                    if (item.topology === 'team') {
                        resumeTeamUnits.push({ teamId: item.teamId, unitId: unit.id });
                    }
                    else if (unit.state === 'admitted') {
                        resumeSwarmUnits.push({ swarmId: item.swarmId, unitId: unit.id });
                    }
                    else if (unit.state === 'queued') {
                        resumeSwarmPools.add(item.swarmId);
                    }
                }
            }
        }
        // A finish-running Swarm can cross the final process-release boundary
        // immediately before main exits. Recovery terminalizes each worker above;
        // close the pool as well once no worker, reservation, or live terminal
        // claim remains. Unconfirmed processes deliberately keep their reservation
        // and therefore leave the Swarm in `draining` for explicit recovery.
        for (const swarm of Object.values(this.registry.swarms)) {
            if (swarm.state !== 'draining')
                continue;
            const unfinished = swarm.workers.some((worker) => [
                'queued', 'admitted', 'gated-spawn', 'running', 'draining', 'provisioning',
                'claiming', 'readiness-test', 'ready', 'engaged', 'paused', 'rebinding', 'fallback',
            ].includes(worker.state));
            const ownsClaim = Object.values(claims).some((claim) => claim.orchestrationId === swarm.swarmId);
            if (unfinished || ownsClaim || swarm.workers.some((worker) => Boolean(worker.reservationId)))
                continue;
            swarm.state = 'closed';
            swarm.updatedAt = Date.now();
            changed = true;
        }
        this.registry.claims = claims;
        if (changed || this.registry.sequence > 0)
            this.commit('boot-reconciliation');
        // Defer execution until initialize() has published the reconciled
        // registry. Every resumed path re-enters its normal write-ahead boundary.
        const resumeTimer = setTimeout(() => {
            for (const task of resumeTeamUnits)
                this.enqueueUnit(task.teamId, task.unitId);
            for (const task of resumeSwarmUnits) {
                const swarm = this.registry.swarms[task.swarmId];
                const unit = swarm?.workers.find((worker) => worker.id === task.unitId);
                const run = unit?.currentRunId ? this.registry.runs[unit.currentRunId] : undefined;
                if (!swarm || !unit || !run || !['active', 'draining'].includes(swarm.state) || run.state !== 'pending')
                    continue;
                void this.runSwarmUnit(swarm, unit, run, swarm.manifest);
            }
            for (const swarmId of resumeSwarmPools) {
                const swarm = this.registry.swarms[swarmId];
                if (swarm)
                    this.pumpSwarm(swarmId, swarm.manifest);
            }
            for (const task of finalizeSwarmTerminals) {
                const swarm = this.registry.swarms[task.swarmId];
                const unit = swarm?.workers.find((worker) => worker.id === task.unitId);
                if (swarm && unit)
                    void this.finalizeSwarmTerminalUnit(swarm, unit);
            }
        }, 0);
        resumeTimer.unref?.();
    }
    async reapPid(pid, startToken) {
        if (!Number.isInteger(pid) || !Number.isFinite(startToken) || (pid ?? 0) <= 0 || (startToken ?? 0) <= 0) {
            return false;
        }
        const result = await (0, processIdentity_1.reapProcessGroup)(pid, startToken, PROCESS_CLOSE_DEADLINE_MS);
        return result !== 'unconfirmed';
    }
    writeRunRecord(run, heartbeatAt) {
        const runDir = (0, orchestrationRuns_1.getRunDir)(run.runId, this.homeDir);
        (0, orchestrationRuns_1.ensureDir)(runDir, 0o700);
        if (run.output !== undefined) {
            const outputPath = node_path_1.default.join(runDir, 'output.txt');
            node_fs_1.default.writeFileSync(outputPath, run.output, { encoding: 'utf-8', mode: 0o600 });
            run.outputPath = outputPath;
        }
        const item = this.findOrchestration(run);
        const record = {
            callId: run.runId,
            target: run.target,
            category: run.category,
            model: run.model,
            command: run.substrate === 'terminal' ? `team terminal --to=${run.target}` : `team headless --to=${run.target}`,
            cwd: this.cwdFor(run.projectId),
            hostTerminalId: item?.hostTerminalId,
            projectId: run.projectId,
            ...(run.deviceId ? { deviceId: run.deviceId } : {}),
            ...(run.deviceName ? { deviceName: run.deviceName } : {}),
            teamId: run.teamId,
            memberId: run.memberId,
            swarmId: run.swarmId,
            workerId: run.workerId,
            topology: run.topology,
            substrate: run.substrate,
            startedAt: run.createdAt,
            timeoutSeconds: DEFAULT_INTERACTIVE_TIMEOUT_S,
            ...(run.completedAt ? { endedAt: run.completedAt, durationSeconds: Math.round((run.completedAt - run.createdAt) / 1000) } : {}),
            ...(heartbeatAt ? { heartbeatAt } : {}),
            // Intentional interrupts are persisted as status:interrupted (STORED_RUN_STATUSES).
            // Do not map them to error-only — Run & Logs filters on interrupted, and
            // dropping them on read used to empty the Windows dashboard after
            // ConPTY submission-interrupted finals (see common-errors doc).
            status: run.state === 'done' ? 'done'
                : run.state === 'timed-out' ? 'timeout'
                    : ['error', 'cancelled', 'discarded'].includes(run.state) ? 'error'
                        : ['uncertain', 'interrupted', 'submission-interrupted'].includes(run.state) ? 'interrupted'
                            : 'running',
            exitCode: run.state === 'done' ? 0 : (0, agentTeams_1.isTerminalState)(run.state) ? 1 : undefined,
            // Without this, a run that dies before producing output (pre-spawn
            // guard, spawn error) exports as status:error and nothing else — the
            // exact shape that made Windows field logs undiagnosable.
            ...(run.error ? { error: run.error.slice(0, 2000) } : {}),
            promptChars: run.prompt.length,
            outputChars: run.output?.length,
            usage: run.usage,
            contentCaptured: true,
        };
        try {
            (0, orchestrationRuns_1.writeRunMeta)(runDir, record);
        }
        catch { /* control registry remains authoritative */ }
    }
    /**
     * Main-side subscription to the same signal the renderer gets. Tasks uses it
     * to mirror run outcomes onto task state; it reflects the snapshot and never
     * second-guesses it.
     */
    addStateListener(listener) {
        this.stateListeners.add(listener);
        return () => this.stateListeners.delete(listener);
    }
    /** Run snapshots by id, for owners of durable bindings. Cloned — read-only. */
    runsByIds(runIds) {
        return runIds
            .map((runId) => this.registry.runs[runId])
            .filter((run) => Boolean(run))
            .map((run) => this.publicRun(run));
    }
    emitChanged() {
        this.deps.sendToRenderer('orchestration:state-changed');
        for (const listener of this.stateListeners) {
            try {
                listener();
            }
            catch {
                // A subscriber's failure must never break the control plane's commit.
            }
        }
    }
}
exports.AgentTeamController = AgentTeamController;
