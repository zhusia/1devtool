"use strict";
/**
 * Pull-based context reads for generation-bound terminal links (V3 I1/V4-5).
 *
 * This service deliberately has no serializer, lease, queue, or renderer
 * dependency. Entry authorization and return-time revalidation live in
 * LinkRegistry; content comes only from exact vendor session ids, the
 * main-owned pipe buffer, or endpoint-bound published artifacts.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.teamReadServiceInternals = exports.TeamReadService = void 0;
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const replay_1 = require("../../shared/terminal/replay");
const TerminalScreenModel_1 = require("./TerminalScreenModel");
const DEFAULT_TRANSCRIPT_LINES = 40;
const MAX_TRANSCRIPT_LINES = 200;
const DEFAULT_SCREEN_ROWS = 200;
const MAX_SCREEN_ROWS = 200;
const DEFAULT_ARTIFACT_LINES = 80;
const MAX_ARTIFACT_LINES = 400;
const MAX_READ_BODY_BYTES = 64 * 1024;
const MAX_FRESHNESS_CURSORS = 2_000;
function boundedInteger(value, fallback, max) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(1, Math.min(max, Math.floor(value)))
        : fallback;
}
function sanitizePlainText(value) {
    return (0, replay_1.stripAnsi)(value)
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}
function capUtf8(value, maxBytes, keep) {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.length <= maxBytes)
        return { body: value, truncated: false };
    const slice = keep === 'head'
        ? bytes.subarray(0, maxBytes)
        : bytes.subarray(bytes.length - maxBytes);
    let body = slice.toString('utf8');
    // Buffer boundaries can split one UTF-8 code point. Never return the
    // replacement glyph as invented transcript content.
    body = keep === 'head'
        ? body.replace(/\uFFFD+$/u, '')
        : body.replace(/^\uFFFD+/u, '');
    return { body, truncated: true };
}
function scopeKey(scope, epoch) {
    return JSON.stringify([
        epoch,
        scope.linkId,
        scope.to.terminalId,
        scope.to.terminalGeneration,
        scope.to.projectId,
        scope.to.worktreePath ?? '',
        scope.to.nativeSessionId ?? '',
    ]);
}
function samePath(left, right) {
    const normalizedLeft = path_1.default.resolve(left);
    const normalizedRight = path_1.default.resolve(right);
    return process.platform === 'win32'
        ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
        : normalizedLeft === normalizedRight;
}
class TeamReadService {
    deps;
    cursorEpoch = (0, crypto_1.randomBytes)(16).toString('hex');
    freshnessCursors = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    async read(callerTerminalId, request) {
        switch (request.kind) {
            case 'peers':
                return {
                    ok: true,
                    kind: 'peers',
                    producedAt: Date.now(),
                    // Discovery must include send-only links. The actual read methods
                    // still authorize through resolveReadScope(), so this widens routing
                    // visibility without widening context-read permission.
                    edges: this.deps.registry.linkedPeers(callerTerminalId),
                };
            case 'transcript':
                return this.readTranscript(callerTerminalId, request);
            case 'screen':
                return this.readScreen(callerTerminalId, request);
            case 'artifact':
                return this.readArtifacts(callerTerminalId, request);
            case 'freshness':
                return this.readFreshness(callerTerminalId, request);
        }
    }
    async readTranscript(callerTerminalId, request) {
        const permission = request.full ? 'read-transcript-full' : 'read-transcript';
        const resolved = this.deps.registry.resolveReadScope(callerTerminalId, request.targetTerminalId, permission);
        if (!resolved.ok)
            return resolved;
        const { scope } = resolved;
        const sessionId = scope.to.nativeSessionId;
        const terminal = this.deps.registry.terminalInfoForRead(scope.to.terminalId);
        if (!sessionId)
            return { ok: false, reason: 'no-transcript' };
        if (!terminal?.resumeAgentType)
            return { ok: false, reason: 'unsupported-agent' };
        let detail;
        try {
            detail = await this.deps.resumeManager.getSessionDetail(terminal.resumeAgentType, sessionId);
        }
        catch {
            detail = null;
        }
        if (!detail || detail.id !== sessionId) {
            return { ok: false, reason: 'no-transcript' };
        }
        if (scope.to.worktreePath &&
            detail.cwd &&
            !samePath(scope.to.worktreePath, detail.cwd)) {
            return { ok: false, reason: 'scope-changed' };
        }
        const formatted = detail.messages
            .map((message) => `[${message.role}]\n${sanitizePlainText(message.content)}`)
            .join('\n\n');
        const lines = formatted.split('\n');
        const selected = request.full
            ? formatted
            : lines
                .slice(-boundedInteger(request.maxLines, DEFAULT_TRANSCRIPT_LINES, MAX_TRANSCRIPT_LINES))
                .join('\n');
        const capped = capUtf8(selected, MAX_READ_BODY_BYTES, 'tail');
        const validation = this.deps.registry.revalidateReadScope(scope);
        if (!validation.ok)
            return validation;
        if (!capped.body.trim())
            return { ok: false, reason: 'no-transcript' };
        return {
            ok: true,
            kind: 'transcript',
            producedAt: Date.now(),
            sourceKind: 'vendor-transcript',
            truncated: capped.truncated || (!request.full && selected !== formatted),
            body: capped.body,
        };
    }
    async readScreen(callerTerminalId, request) {
        const resolved = this.deps.registry.resolveReadScope(callerTerminalId, request.targetTerminalId, 'read-screen');
        if (!resolved.ok)
            return resolved;
        const { scope } = resolved;
        const terminal = this.deps.registry.terminalInfoForRead(scope.to.terminalId);
        if (!terminal)
            return { ok: false, reason: 'target-closed' };
        const rows = boundedInteger(request.rows, DEFAULT_SCREEN_ROWS, MAX_SCREEN_ROWS);
        let snapshot;
        try {
            snapshot = await this.deps.ptyBackend.getBufferSnapshot(scope.to.terminalId);
        }
        catch {
            return { ok: false, reason: 'target-closed' };
        }
        const sanitized = (0, replay_1.sanitizeReplayBuffer)(snapshot.content);
        const size = this.deps.ptyBackend.getSize(scope.to.terminalId);
        const modelRows = terminal.isNativeTui
            ? Math.max(2, size?.rows ?? 30)
            : Math.max(2, rows);
        const screen = new TerminalScreenModel_1.TerminalScreenModel(modelRows, Math.max(2, size?.cols ?? 160));
        screen.feed(sanitized);
        let body = screen.render()
            .split('\n')
            .slice(-rows)
            .join('\n')
            .trim();
        // A native full-screen TUI exposes only its current rendered frame. The
        // label prevents an agent from mistaking that frame for conversation
        // history; control-protocol cleanup is not secret redaction.
        if (body && terminal.isNativeTui) {
            body = `[current native-TUI screen frame; not a transcript]\n${body}`;
        }
        else {
            body = (0, replay_1.stripAnsiPreservingLayout)(body);
        }
        const capped = capUtf8(body, MAX_READ_BODY_BYTES, 'tail');
        const validation = this.deps.registry.revalidateReadScope(scope);
        if (!validation.ok)
            return validation;
        if (!capped.body.trim())
            return { ok: false, reason: 'no-transcript' };
        const sourceRows = (sanitized.match(/\n/g)?.length ?? 0) + 1;
        return {
            ok: true,
            kind: 'screen',
            producedAt: Date.now(),
            sourceKind: 'pipe-buffer',
            truncated: capped.truncated || sourceRows > rows,
            body: capped.body,
        };
    }
    async readArtifacts(callerTerminalId, request) {
        const resolved = this.deps.registry.resolveReadScope(callerTerminalId, request.targetTerminalId, 'read-artifact');
        if (!resolved.ok)
            return resolved;
        const { scope } = resolved;
        const artifacts = this.deps.registry.artifactsForReadScope(scope);
        if (artifacts.length === 0)
            return { ok: false, reason: 'no-transcript', detail: 'No artifacts were published' };
        const body = artifacts
            .map((artifact) => `# ${sanitizePlainText(artifact.title)}\n${sanitizePlainText(artifact.body)}`)
            .join('\n\n');
        const maxLines = boundedInteger(request.maxLines, DEFAULT_ARTIFACT_LINES, MAX_ARTIFACT_LINES);
        const selected = body.split('\n').slice(-maxLines).join('\n');
        const capped = capUtf8(selected, MAX_READ_BODY_BYTES, 'tail');
        const validation = this.deps.registry.revalidateReadScope(scope);
        if (!validation.ok)
            return validation;
        return {
            ok: true,
            kind: 'artifact',
            producedAt: Date.now(),
            sourceKind: 'link-artifact',
            truncated: capped.truncated || selected !== body,
            body: capped.body,
        };
    }
    async readFreshness(callerTerminalId, request) {
        const resolved = this.deps.registry.resolveReadScope(callerTerminalId, request.targetTerminalId, 'read-transcript');
        if (!resolved.ok)
            return resolved;
        const { scope } = resolved;
        const key = scopeKey(scope, this.cursorEpoch);
        const previous = request.changedSince
            ? this.freshnessCursors.get(request.changedSince)
            : undefined;
        if (request.changedSince && (!previous || previous.scopeKey !== key)) {
            return { ok: false, reason: 'scope-changed' };
        }
        // Main's PTY event timestamps are the source; this path never opens or
        // parses a transcript just to answer "has it moved?".
        const lastActivityAt = this.deps.ptyBackend.getAllStatuses()[scope.to.terminalId]?.lastActivityAt ?? 0;
        const cursor = (0, crypto_1.randomBytes)(18).toString('base64url');
        this.freshnessCursors.set(cursor, { scopeKey: key, lastActivityAt });
        while (this.freshnessCursors.size > MAX_FRESHNESS_CURSORS) {
            const oldest = this.freshnessCursors.keys().next().value;
            if (typeof oldest !== 'string')
                break;
            this.freshnessCursors.delete(oldest);
        }
        const validation = this.deps.registry.revalidateReadScope(scope);
        if (!validation.ok) {
            this.freshnessCursors.delete(cursor);
            return validation;
        }
        return {
            ok: true,
            kind: 'freshness',
            producedAt: Date.now(),
            changed: previous ? lastActivityAt > previous.lastActivityAt : true,
            lastActivityAt,
            cursor,
        };
    }
}
exports.TeamReadService = TeamReadService;
exports.teamReadServiceInternals = {
    capUtf8,
    sanitizePlainText,
    scopeKey,
};
