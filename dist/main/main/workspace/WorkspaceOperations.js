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
exports.WorkspaceOperations = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const contracts_1 = require("../../shared/terminal/contracts");
const workspace_1 = require("../../shared/workspace");
const ids_1 = require("./ids");
class WorkspaceOperations {
    deps;
    operations = null;
    constructor(deps) {
        this.deps = deps;
    }
    now() {
        return this.deps.now?.() ?? Date.now();
    }
    load() {
        if (this.operations)
            return this.operations;
        let parsed = null;
        try {
            parsed = JSON.parse(fs.readFileSync(this.deps.operationsFilePath, 'utf8'));
        }
        catch { /* fresh */ }
        this.operations = parsed?.operations && typeof parsed.operations === 'object' ? parsed.operations : {};
        this.prune();
        return this.operations;
    }
    prune() {
        if (!this.operations)
            return;
        const cutoff = this.now() - workspace_1.WORKSPACE_OPERATION_TTL_MS;
        for (const [id, record] of Object.entries(this.operations)) {
            if (record.enqueuedAt < cutoff)
                delete this.operations[id];
        }
    }
    persist() {
        if (!this.operations)
            return;
        this.prune();
        try {
            fs.mkdirSync(path.dirname(this.deps.operationsFilePath), { recursive: true });
            const payload = { version: 1, operations: this.operations };
            fs.writeFileSync(this.deps.operationsFilePath, JSON.stringify(payload));
        }
        catch { /* journal is best-effort; records also live in memory */ }
    }
    /** Resolve the target workspace: explicit id, or unique for the caller. */
    resolveWorkspaceId(callerProjectId, workspaceId) {
        if (workspaceId)
            return workspaceId;
        const candidates = this.deps.service.forProject(callerProjectId);
        if (candidates.length === 1)
            return candidates[0].id;
        if (candidates.length === 0)
            throw new workspace_1.WorkspaceError('WORKSPACE_NOT_FOUND', 'No workspace contains the calling project');
        throw new workspace_1.WorkspaceError('WORKSPACE_AMBIGUOUS', `The calling project is in ${candidates.length} workspaces — pass --workspace= one of: ${candidates.map((w) => `${w.id} (${w.name})`).join(', ')}`);
    }
    deliveryPathFor(callerTerminalId, targetTerminalId) {
        const registry = this.deps.getLinkRegistry();
        if (!registry || callerTerminalId === targetTerminalId)
            return null;
        const links = registry.linksForTerminal(callerTerminalId);
        const edge = links.outbound.find((row) => row.to.terminalId === targetTerminalId && row.state === 'active' && row.permissions.includes('send'));
        return edge ? 'link' : null;
    }
    listRoster(callerProjectId, workspaceId, callerTerminalId) {
        const resolvedWorkspaceId = this.resolveWorkspaceId(callerProjectId, workspaceId);
        const resolve = this.deps.service.authorizeAction(resolvedWorkspaceId, callerProjectId);
        const workspace = this.deps.service.get(resolvedWorkspaceId);
        const memberIds = new Set(resolve.resolvedProjectIds);
        const projects = this.deps.getProjects().filter((project) => memberIds.has(project.id));
        const terminals = [];
        const terminalIds = new Set();
        for (const project of projects) {
            for (const terminal of project.terminals) {
                if (terminal.isHidden)
                    continue;
                if (!(0, contracts_1.isInteractiveAgentTerminal)(terminal.agentType, terminal.startupCommand, terminal.forceAiAgent))
                    continue;
                terminalIds.add(terminal.id);
                terminals.push({
                    terminalId: terminal.id,
                    projectId: project.id,
                    projectName: project.name,
                    name: terminal.name || terminal.agentType,
                    agentType: terminal.agentType,
                    isInteractiveAi: true,
                    isHidden: false,
                    // Honest best-effort: without a live screen model read here we
                    // report unknown rather than inventing readiness from history.
                    readiness: 'unknown',
                    ...(callerTerminalId
                        ? { deliveryPath: this.deliveryPathFor(callerTerminalId, terminal.id) }
                        : {}),
                });
            }
        }
        const registry = this.deps.getLinkRegistry();
        const links = registry
            ? registry.listLinks().filter((row) => terminalIds.has(row.from.terminalId) && terminalIds.has(row.to.terminalId)).map((row) => ({
                linkId: row.linkId,
                fromTerminalId: row.from.terminalId,
                toTerminalId: row.to.terminalId,
                outstanding: false,
                quarantined: row.state === 'quarantined',
            }))
            : [];
        const controller = this.deps.getTeamController?.();
        const teams = controller
            ? controller.listForRenderer()
                .filter((item) => item.topology === 'team' &&
                (item.workspaceId === resolvedWorkspaceId || memberIds.has(item.projectId)))
                .map((item) => ({
                teamId: item.teamId,
                projectId: item.projectId,
                ...(item.workspaceId ? { workspaceId: item.workspaceId } : {}),
                memberTerminalIds: (item.members ?? [])
                    .map((member) => member.terminalId)
                    .filter((id) => typeof id === 'string'),
                state: item.state,
            }))
            : [];
        return {
            workspaceId: resolvedWorkspaceId,
            workspaceName: workspace?.name ?? resolvedWorkspaceId,
            resolvedProjectIds: resolve.resolvedProjectIds,
            terminals,
            links,
            teams,
            generatedAt: this.now(),
        };
    }
    /** Resolve a `--to` target against the roster — fail closed on ambiguity. */
    resolveTarget(roster, to) {
        const trimmed = to.trim();
        if (!trimmed)
            throw new workspace_1.WorkspaceError('WORKSPACE_TARGET_AMBIGUOUS', 'A --to target is required');
        const byId = roster.terminals.find((t) => t.terminalId === trimmed);
        if (byId)
            return byId;
        if (trimmed.startsWith('project:')) {
            const projectKey = trimmed.slice('project:'.length).trim();
            const matches = roster.terminals.filter((t) => t.projectId === projectKey || t.projectName === projectKey);
            if (matches.length === 1)
                return matches[0];
            throw new workspace_1.WorkspaceError('WORKSPACE_TARGET_AMBIGUOUS', matches.length === 0
                ? `No interactive AI terminal in project "${projectKey}"`
                : `Project "${projectKey}" has ${matches.length} AI terminals — pass a terminalId: ${matches.map((m) => `${m.terminalId} (${m.name})`).join(', ')}`);
        }
        const byName = roster.terminals.filter((t) => t.name === trimmed);
        if (byName.length === 1)
            return byName[0];
        throw new workspace_1.WorkspaceError('WORKSPACE_TARGET_AMBIGUOUS', byName.length === 0
            ? `No workspace terminal is named "${trimmed}" — roster names: ${roster.terminals.map((t) => t.name).join(', ') || '(none)'}`
            : `${byName.length} terminals are named "${trimmed}" — pass a terminalId`);
    }
    async deliver(callerTerminalId, target, message) {
        const base = { terminalId: target.terminalId, projectId: target.projectId };
        const registry = this.deps.getLinkRegistry();
        const channel = this.deliveryPathFor(callerTerminalId, target.terminalId);
        if (!registry || channel === null) {
            return {
                ...base,
                ok: false,
                error: 'WORKSPACE_NO_DELIVERY_PATH: no active link with send permission to this terminal — membership alone never creates one',
            };
        }
        const sent = await registry.sendMessage(callerTerminalId, {
            toTerminalId: target.terminalId,
            body: message,
        });
        if (!sent.ok || !sent.receipt) {
            return { ...base, ok: false, error: sent.detail ?? sent.error ?? 'delivery failed' };
        }
        return { ...base, ok: true, messageId: sent.receipt.messageId, channel: 'link' };
    }
    recordOperation(record) {
        const operations = this.load();
        operations[record.operationId] = record;
        this.persist();
    }
    async send(input) {
        const body = (input.message ?? '').trim();
        if (!body)
            return { ok: false, error: 'A non-empty --message is required' };
        const roster = this.listRoster(input.callerProjectId, input.workspaceId, input.callerTerminalId);
        const target = this.resolveTarget(roster, input.to);
        const result = await this.deliver(input.callerTerminalId, target, body);
        const operationId = (0, ids_1.mintWorkspaceOperationId)();
        this.recordOperation({
            operationId,
            kind: 'send',
            workspaceId: roster.workspaceId,
            callerTerminalId: input.callerTerminalId,
            callerProjectId: input.callerProjectId,
            targets: [result],
            enqueuedAt: this.now(),
        });
        return { ok: result.ok, operationId, workspaceId: roster.workspaceId, results: [result], ...(result.ok ? {} : { error: result.error }) };
    }
    async broadcast(input) {
        const body = (input.message ?? '').trim();
        if (!body)
            return { ok: false, error: 'A non-empty --message is required' };
        const roster = this.listRoster(input.callerProjectId, input.workspaceId, input.callerTerminalId);
        const targets = roster.terminals.filter((t) => !(input.excludeSelf !== false && t.terminalId === input.callerTerminalId));
        const cap = Math.min(input.limit ?? workspace_1.WORKSPACE_BROADCAST_HARD_CAP, workspace_1.WORKSPACE_BROADCAST_HARD_CAP);
        if (targets.length > cap) {
            // Refuse the whole call rather than silently truncating (04 §12).
            throw new workspace_1.WorkspaceError('WORKSPACE_BROADCAST_CAP', `${targets.length} targets exceed the cap of ${cap} — narrow with --to sends or a smaller workspace`);
        }
        const results = [];
        for (const target of targets) {
            // Sequential on purpose: the serializer owns PTY pacing and partial
            // failure stays per-target (partial failure is OK by contract).
            results.push(await this.deliver(input.callerTerminalId, target, body));
        }
        const operationId = (0, ids_1.mintWorkspaceOperationId)();
        this.recordOperation({
            operationId,
            kind: 'broadcast',
            workspaceId: roster.workspaceId,
            callerTerminalId: input.callerTerminalId,
            callerProjectId: input.callerProjectId,
            targets: results,
            enqueuedAt: this.now(),
        });
        return { ok: results.some((r) => r.ok), operationId, workspaceId: roster.workspaceId, results };
    }
    /**
     * Correlated collect (D7): answers tied to the operation's messageIds
     * ONLY. `timeoutSeconds` polls until every target settles or the clock
     * runs out; pending items stay honestly pending.
     */
    async collect(input) {
        const operations = this.load();
        const record = operations[input.operationId];
        if (!record || record.enqueuedAt < this.now() - workspace_1.WORKSPACE_OPERATION_TTL_MS) {
            throw new workspace_1.WorkspaceError('WORKSPACE_OPERATION_NOT_FOUND', `Unknown or expired operation ${input.operationId}`);
        }
        if (record.callerTerminalId !== input.callerTerminalId) {
            throw new workspace_1.WorkspaceError('WORKSPACE_MEMBERSHIP', 'Only the operation caller may collect it');
        }
        // Re-authorize against LIVE membership — a caller whose project left the
        // workspace (or an archived workspace) loses collect too (D2).
        this.deps.service.authorizeAction(record.workspaceId, input.callerProjectId);
        const projectNames = new Map(this.deps.getProjects().map((p) => [p.id, p.name]));
        const deadline = this.now() + Math.max(0, Math.min(input.timeoutSeconds ?? 0, 300)) * 1000;
        const registry = this.deps.getLinkRegistry();
        const readItems = () => record.targets.map((target) => {
            const base = {
                terminalId: target.terminalId,
                projectId: target.projectId,
                projectName: projectNames.get(target.projectId) ?? target.projectId,
            };
            if (!target.ok || !target.messageId) {
                return { ...base, status: 'unavailable', error: target.error ?? 'not delivered' };
            }
            if (!registry)
                return { ...base, status: 'unavailable', error: 'links unavailable' };
            const answer = registry.collectAnswer(input.callerTerminalId, target.messageId);
            return {
                ...base,
                status: answer.status,
                ...(answer.status !== 'unavailable' ? { source: 'link' } : {}),
                ...(answer.text ? { text: answer.text } : {}),
            };
        });
        let items = readItems();
        while (items.some((item) => item.status === 'pending') && this.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            items = readItems();
        }
        return { ok: true, workspaceId: record.workspaceId, operationId: record.operationId, items, collectedAt: this.now() };
    }
    /** Live member projectIds for consumers outside this module (tasks scope).
     *  Display purpose — an archived workspace still resolves for its board. */
    resolveMemberProjectIds(workspaceId) {
        try {
            return this.deps.service.resolve(workspaceId, 'display').resolvedProjectIds;
        }
        catch {
            return null;
        }
    }
    /** Non-archived workspaces containing the project (id + name only). */
    workspacesForProject(projectId) {
        return this.deps.service.forProject(projectId).map((workspace) => ({
            id: workspace.id,
            name: workspace.name,
        }));
    }
    getOperation(input) {
        const record = this.load()[input.operationId];
        if (!record)
            throw new workspace_1.WorkspaceError('WORKSPACE_OPERATION_NOT_FOUND');
        if (record.callerTerminalId !== input.callerTerminalId) {
            throw new workspace_1.WorkspaceError('WORKSPACE_MEMBERSHIP', 'Only the operation caller may read it');
        }
        return record;
    }
}
exports.WorkspaceOperations = WorkspaceOperations;
