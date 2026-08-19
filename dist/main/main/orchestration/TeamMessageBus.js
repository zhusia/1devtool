"use strict";
/**
 * Durable Team connection graph and message ledger.
 *
 * Main derives the caller principal before invoking this class. The bus never
 * accepts a caller-supplied sender id, journals before dispatch, and delegates
 * prompt delivery to AgentTeamController's existing safe run path.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TeamMessageBus = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const teamMessages_1 = require("../../shared/orchestration/teamMessages");
const LEDGER_VERSION = 1;
function emptyLedger() {
    return { version: LEDGER_VERSION, sequence: 0, teams: {} };
}
function clone(value) {
    return JSON.parse(JSON.stringify(value));
}
function fingerprint(value) {
    return node_crypto_1.default.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function normalizePermissions(value) {
    const known = new Set([
        'send',
        'ask',
        'share-artifact',
        ...teamMessages_1.TEAM_READ_PERMISSIONS,
    ]);
    const permissions = [...new Set(value.filter((item) => known.has(item)))];
    // A full transcript is an elevation of the bounded transcript permission,
    // never an alternative spelling that can stand alone.
    if (permissions.includes('read-transcript-full') &&
        !permissions.includes('read-transcript')) {
        return permissions.filter((item) => item !== 'read-transcript-full');
    }
    return permissions;
}
class TeamMessageBus {
    deps;
    ledger = emptyLedger();
    initialized = false;
    waiters = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    initialize() {
        if (this.initialized)
            return;
        this.ledger = this.load();
        this.initialized = true;
    }
    registerTeam(args) {
        this.initialize();
        const existing = this.ledger.teams[args.teamId];
        if (existing) {
            existing.members = clone(args.members);
            existing.updatedAt = Date.now();
            this.commit();
            return;
        }
        const memberIds = new Set(args.members.map((member) => member.memberId));
        const connections = (args.connections ?? []).filter((connection) => connection.teamId === args.teamId &&
            connection.fromMemberId !== connection.toMemberId &&
            memberIds.has(connection.fromMemberId) &&
            memberIds.has(connection.toMemberId))
            .map((connection) => ({ ...connection, permissions: normalizePermissions(connection.permissions) }));
        this.ledger.teams[args.teamId] = {
            teamId: args.teamId,
            projectId: args.projectId,
            hostTerminalId: args.hostTerminalId,
            members: clone(args.members),
            connections,
            messages: [],
            submissions: {},
            pausedMemberIds: [],
            updatedAt: Date.now(),
        };
        this.commit();
    }
    removeTeam(teamId) {
        this.initialize();
        if (!this.ledger.teams[teamId])
            return;
        delete this.ledger.teams[teamId];
        this.commit();
    }
    listTeamIds(principal) {
        this.initialize();
        return Object.values(this.ledger.teams)
            .filter((team) => this.canRead(principal, team))
            .map((team) => team.teamId);
    }
    members(principal, teamId) {
        this.initialize();
        const team = this.ledger.teams[teamId];
        return team && this.canRead(principal, team) ? clone(team.members) : null;
    }
    connections(principal, teamId) {
        this.initialize();
        const team = this.ledger.teams[teamId];
        if (!team || !this.canRead(principal, team))
            return null;
        return clone(team.connections
            .map((connection) => ({
            ...connection,
            permissions: this.visibleConnectionPermissions(team, connection),
        }))
            .filter((connection) => connection.permissions.length > 0));
    }
    setConnections(principal, teamId, connections) {
        this.initialize();
        const team = this.ledger.teams[teamId];
        if (!team || !this.canManage(principal, team))
            return { ok: false, error: 'Team connection graph is unavailable' };
        const memberIds = new Set(team.members.map((member) => member.memberId));
        const byEdge = new Map();
        for (const raw of connections) {
            if (raw.teamId !== teamId || raw.fromMemberId === raw.toMemberId ||
                !memberIds.has(raw.fromMemberId) || !memberIds.has(raw.toMemberId)) {
                return { ok: false, error: 'Every connection must address two distinct members of this Team' };
            }
            const permissions = normalizePermissions(raw.permissions);
            if (permissions.length === 0)
                return { ok: false, error: 'A Team connection needs at least one permission' };
            if (raw.permissions.includes('read-transcript-full') &&
                !raw.permissions.includes('read-transcript')) {
                return { ok: false, error: 'read-transcript-full also requires read-transcript' };
            }
            const readError = this.validateReadPermissions(team, raw, permissions);
            if (readError)
                return { ok: false, error: readError };
            byEdge.set((0, teamMessages_1.teamConnectionKey)(raw), { ...raw, permissions });
        }
        team.connections = [...byEdge.values()];
        team.updatedAt = Date.now();
        this.commit();
        this.changed(teamId);
        return { ok: true, connections: clone(team.connections) };
    }
    messages(principal, teamId, cursor = 0, limit = 50) {
        this.initialize();
        const team = this.ledger.teams[teamId];
        if (!team || !this.canRead(principal, team))
            return null;
        const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
        const start = cursor < 0 ? Math.max(0, team.messages.length - boundedLimit) : Math.max(0, Math.floor(cursor));
        const page = team.messages.slice(start, start + boundedLimit);
        return {
            messages: clone(page),
            ...(start + page.length < team.messages.length ? { nextCursor: start + page.length } : {}),
        };
    }
    findMessage(principal, messageId) {
        this.initialize();
        for (const team of Object.values(this.ledger.teams)) {
            const message = team.messages.find((item) => item.messageId === messageId);
            if (message && this.canRead(principal, team))
                return clone(message);
        }
        return null;
    }
    async send(principal, input) {
        this.initialize();
        const team = this.ledger.teams[input.teamId];
        if (!team || !this.canRead(principal, team))
            return { ok: false, error: 'Team is not available to this principal' };
        const destination = team.members.find((member) => member.memberId === input.toMemberId);
        if (!destination)
            return { ok: false, error: 'Unknown Team member' };
        const body = input.body.trim();
        if (!input.clientSubmissionId || !body)
            return { ok: false, error: 'clientSubmissionId and body are required' };
        if (body.length > teamMessages_1.TEAM_MESSAGE_MAX_BODY_CHARS)
            return { ok: false, error: `Team message exceeds ${teamMessages_1.TEAM_MESSAGE_MAX_BODY_CHARS} characters` };
        const hopCount = Math.max(0, Math.floor(input.hopCount ?? 0));
        if (hopCount > teamMessages_1.TEAM_MESSAGE_MAX_HOPS)
            return { ok: false, error: 'Team message hop limit exceeded' };
        if (team.pausedMemberIds.includes(input.toMemberId))
            return { ok: false, error: 'Automated delivery is paused while this member is user-controlled' };
        const fromMemberId = principal.kind === 'member' ? principal.memberId : principal.kind === 'user' ? 'user' : 'controller';
        const permission = input.kind === 'question' ? 'ask' : input.kind === 'artifact' ? 'share-artifact' : 'send';
        if (principal.kind === 'member' && !this.hasConnection(team, principal.memberId, input.toMemberId, permission)) {
            return { ok: false, error: `Team connection does not allow ${permission} from this member to the destination` };
        }
        if (principal.kind === 'member' && principal.teamId !== input.teamId) {
            return { ok: false, error: 'A Team member cannot address another Team' };
        }
        const dedupeKey = `${fromMemberId}\u0000${input.clientSubmissionId}`;
        const fp = fingerprint({
            toMemberId: input.toMemberId,
            body,
            kind: input.kind ?? 'follow-up',
            replyToMessageId: input.replyToMessageId,
        });
        const existing = team.submissions[dedupeKey];
        if (existing) {
            if (existing.fingerprint !== fp)
                return { ok: false, error: 'clientSubmissionId was already used for a different Team message' };
            const message = team.messages.find((item) => item.messageId === existing.messageId);
            return message ? { ok: true, message: clone(message) } : { ok: false, error: 'Idempotent Team message record is unavailable' };
        }
        const inFlight = team.messages.filter((message) => !(0, teamMessages_1.isTeamMessageTerminal)(message.state)).length;
        if (inFlight >= teamMessages_1.TEAM_MESSAGE_MAX_IN_FLIGHT)
            return { ok: false, error: 'Team in-flight message budget is exhausted' };
        const message = {
            messageId: node_crypto_1.default.randomUUID(),
            teamId: input.teamId,
            fromMemberId,
            toMemberId: input.toMemberId,
            kind: input.kind ?? 'follow-up',
            body,
            ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
            clientSubmissionId: input.clientSubmissionId,
            state: 'queued',
            createdAt: Date.now(),
            ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
            hopCount,
        };
        team.messages.push(message);
        team.submissions[dedupeKey] = { fingerprint: fp, messageId: message.messageId };
        this.prune(team);
        team.updatedAt = Date.now();
        this.commit();
        this.changed(team.teamId, message);
        message.state = 'delivering';
        team.updatedAt = Date.now();
        this.commit();
        this.changed(team.teamId, message);
        try {
            const delivered = await this.deps.deliver(clone(message));
            message.destinationRunId = delivered.runId;
            team.updatedAt = Date.now();
            this.commit();
            this.changed(team.teamId, message);
            return { ok: true, message: clone(message) };
        }
        catch (error) {
            message.state = 'failed';
            message.error = error instanceof Error ? error.message : String(error);
            team.updatedAt = Date.now();
            this.commit();
            this.notify(message.messageId);
            this.changed(team.teamId, message);
            return { ok: false, message: clone(message), error: message.error };
        }
    }
    async reply(principal, messageId, clientSubmissionId, body) {
        const original = this.findMessage(principal, messageId);
        if (!original)
            return { ok: false, error: 'Team message is unavailable' };
        if (principal.kind !== 'member' || principal.memberId !== original.toMemberId) {
            return { ok: false, error: 'Only the attributed recipient may reply to this message' };
        }
        if (original.fromMemberId === 'user' || original.fromMemberId === 'controller') {
            return { ok: false, error: 'Controller replies are returned through collect/status, not injected into a host terminal' };
        }
        return this.send(principal, {
            teamId: original.teamId,
            toMemberId: original.fromMemberId,
            clientSubmissionId,
            body,
            kind: 'result',
            replyToMessageId: original.messageId,
            sourceRunId: original.destinationRunId,
            hopCount: original.hopCount + 1,
        });
    }
    markDelivered(messageId, runId) {
        this.updateMessage(messageId, (message) => {
            if ((0, teamMessages_1.isTeamMessageTerminal)(message.state))
                return false;
            message.state = 'delivered';
            message.deliveredAt = Date.now();
            if (runId)
                message.destinationRunId = runId;
            return true;
        });
    }
    markAnswered(messageId, output) {
        this.updateMessage(messageId, (message, team) => {
            if (message.state === 'answered')
                return false;
            message.state = 'answered';
            message.deliveredAt ??= Date.now();
            message.answeredAt = Date.now();
            if (output && message.fromMemberId !== 'controller' && message.fromMemberId !== 'user') {
                // The result edge is coordination metadata only. Full output remains
                // in the correlated run/native transcript.
                const summary = output.trim().replace(/\s+/g, ' ').slice(0, 500);
                if (summary) {
                    team.messages.push({
                        messageId: node_crypto_1.default.randomUUID(),
                        teamId: message.teamId,
                        fromMemberId: message.toMemberId,
                        toMemberId: message.fromMemberId,
                        kind: 'result',
                        body: summary,
                        replyToMessageId: message.messageId,
                        clientSubmissionId: `result:${message.messageId}`,
                        state: 'answered',
                        createdAt: Date.now(),
                        deliveredAt: Date.now(),
                        answeredAt: Date.now(),
                        sourceRunId: message.destinationRunId,
                        hopCount: message.hopCount + 1,
                    });
                    this.prune(team);
                }
            }
            return true;
        });
    }
    markFailed(messageId, error) {
        this.updateMessage(messageId, (message) => {
            if ((0, teamMessages_1.isTeamMessageTerminal)(message.state))
                return false;
            message.state = 'failed';
            message.error = error;
            return true;
        });
    }
    markCancelled(messageId, error) {
        this.updateMessage(messageId, (message) => {
            if ((0, teamMessages_1.isTeamMessageTerminal)(message.state))
                return false;
            message.state = 'cancelled';
            if (error)
                message.error = error;
            return true;
        });
    }
    pauseMember(teamId, memberId, reason = 'User took control of the destination terminal') {
        this.initialize();
        const team = this.ledger.teams[teamId];
        if (!team || team.pausedMemberIds.includes(memberId))
            return;
        team.pausedMemberIds.push(memberId);
        for (const message of team.messages) {
            if (message.toMemberId === memberId && message.state === 'queued') {
                message.state = 'cancelled';
                message.error = reason;
                this.notify(message.messageId);
            }
        }
        team.updatedAt = Date.now();
        this.commit();
        this.changed(teamId);
    }
    resumeMember(principal, teamId, memberId) {
        this.initialize();
        const team = this.ledger.teams[teamId];
        if (!team || !this.canManage(principal, team))
            return { ok: false, error: 'Team member automation is unavailable' };
        team.pausedMemberIds = team.pausedMemberIds.filter((id) => id !== memberId);
        const member = team.members.find((item) => item.memberId === memberId);
        if (member)
            member.userControlled = false;
        team.updatedAt = Date.now();
        this.commit();
        this.changed(teamId);
        return { ok: true };
    }
    async waitForTerminalState(messageId, timeoutMs) {
        const current = this.messageById(messageId);
        if (!current || (0, teamMessages_1.isTeamMessageTerminal)(current.state))
            return current ? clone(current) : null;
        await new Promise((resolve) => {
            const set = this.waiters.get(messageId) ?? new Set();
            let timer;
            const done = () => {
                if (timer)
                    clearTimeout(timer);
                set.delete(done);
                resolve();
            };
            set.add(done);
            this.waiters.set(messageId, set);
            timer = setTimeout(done, Math.max(0, timeoutMs));
        });
        const updated = this.messageById(messageId);
        return updated ? clone(updated) : null;
    }
    canRead(principal, team) {
        if (principal.projectId !== team.projectId)
            return false;
        if (principal.kind === 'member')
            return principal.teamId === team.teamId && team.members.some((member) => member.memberId === principal.memberId);
        return principal.terminalId === team.hostTerminalId || principal.kind === 'user';
    }
    canManage(principal, team) {
        return principal.kind !== 'member' && this.canRead(principal, team);
    }
    hasConnection(team, fromMemberId, toMemberId, permission) {
        return team.connections.some((connection) => connection.fromMemberId === fromMemberId &&
            connection.toMemberId === toMemberId &&
            connection.permissions.includes(permission));
    }
    validateReadPermissions(team, connection, permissions) {
        const reads = permissions.filter(teamMessages_1.isTeamReadPermission);
        if (reads.length === 0)
            return null;
        const from = team.members.find((member) => member.memberId === connection.fromMemberId);
        const to = team.members.find((member) => member.memberId === connection.toMemberId);
        if (!from?.terminalId || !to?.terminalId) {
            return 'Team pull reads require two live terminal-backed members';
        }
        for (const permission of reads) {
            if (!this.deps.validateReadConnection?.({
                teamId: team.teamId,
                projectId: team.projectId,
                fromTerminalId: from.terminalId,
                toTerminalId: to.terminalId,
                permission,
            })) {
                return `Team ${permission} must first be granted and consented on the shared terminal link`;
            }
        }
        return null;
    }
    visibleConnectionPermissions(team, connection) {
        const visible = [];
        for (const permission of connection.permissions) {
            if (!(0, teamMessages_1.isTeamReadPermission)(permission)) {
                visible.push(permission);
                continue;
            }
            if (!this.validateReadPermissions(team, connection, [permission])) {
                visible.push(permission);
            }
        }
        return visible;
    }
    messageById(messageId) {
        for (const team of Object.values(this.ledger.teams)) {
            const message = team.messages.find((item) => item.messageId === messageId);
            if (message)
                return message;
        }
        return undefined;
    }
    updateMessage(messageId, mutate) {
        this.initialize();
        for (const team of Object.values(this.ledger.teams)) {
            const message = team.messages.find((item) => item.messageId === messageId);
            if (!message || !mutate(message, team))
                continue;
            team.updatedAt = Date.now();
            this.commit();
            if ((0, teamMessages_1.isTeamMessageTerminal)(message.state) || message.state === 'delivered')
                this.notify(messageId);
            this.changed(team.teamId, message);
            return;
        }
    }
    prune(team) {
        if (team.messages.length <= teamMessages_1.TEAM_MESSAGE_MAX_PER_TEAM)
            return;
        const removable = team.messages.length - teamMessages_1.TEAM_MESSAGE_MAX_PER_TEAM;
        const removed = team.messages.splice(0, removable);
        const removedIds = new Set(removed.map((message) => message.messageId));
        for (const [key, record] of Object.entries(team.submissions)) {
            if (removedIds.has(record.messageId))
                delete team.submissions[key];
        }
    }
    notify(messageId) {
        const set = this.waiters.get(messageId);
        if (!set)
            return;
        this.waiters.delete(messageId);
        for (const resolve of set)
            resolve();
    }
    changed(teamId, message) {
        this.deps.onChanged?.(teamId, message ? clone(message) : undefined);
    }
    load() {
        try {
            const parsed = JSON.parse(node_fs_1.default.readFileSync(this.deps.storagePath, 'utf-8'));
            if (parsed.version !== LEDGER_VERSION || !parsed.teams || typeof parsed.teams !== 'object')
                return emptyLedger();
            const ledger = parsed;
            for (const team of Object.values(ledger.teams)) {
                team.pausedMemberIds ??= [];
                team.submissions ??= {};
                team.connections ??= [];
                team.messages ??= [];
                // Never replay a journaled dispatch after restart. If a destination
                // run id exists, controller recovery owns its outcome; otherwise the
                // pre-submit attempt is diagnosably failed and may be explicitly sent
                // again with a fresh submission id.
                for (const message of team.messages) {
                    if ((message.state === 'queued' || message.state === 'delivering') && !message.destinationRunId) {
                        message.state = 'failed';
                        message.error = 'Delivery was interrupted before a destination run was durably bound';
                    }
                }
            }
            return ledger;
        }
        catch {
            return emptyLedger();
        }
    }
    commit() {
        this.ledger.sequence += 1;
        const dir = node_path_1.default.dirname(this.deps.storagePath);
        node_fs_1.default.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const tmp = `${this.deps.storagePath}.${process.pid}.tmp`;
        node_fs_1.default.writeFileSync(tmp, JSON.stringify(this.ledger, null, 2), { encoding: 'utf-8', mode: 0o600 });
        node_fs_1.default.renameSync(tmp, this.deps.storagePath);
    }
}
exports.TeamMessageBus = TeamMessageBus;
