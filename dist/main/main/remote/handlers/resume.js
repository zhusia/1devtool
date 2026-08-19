"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerResumeHandlers = registerResumeHandlers;
const types_1 = require("../../../shared/types");
/** Resume agents that actually have a working resume command (others are read-only). */
const RESUMABLE_AGENTS = new Set([
    'claude', 'codex', 'gemini', 'kimi', 'agy', 'qwen', 'amp', 'opencode', 'cline', 'grok', 'hermes', 'pi',
]);
/** Cap a single scan so a cold parse of every local session can't run unbounded. */
const SCAN_LIMIT_MAX = 100;
function folderName(p) {
    if (!p)
        return null;
    return p.split(/[\\/]/).filter(Boolean).pop() || p;
}
/**
 * Mirror of the renderer's stripSystemTags (utils/changeAi). Drops the agent
 * transcript's bookkeeping XML so previews/messages read as plain conversation.
 */
function stripSystemTags(text) {
    if (!text)
        return '';
    return text
        .replace(/<(?:system-reminder|local-command-caveat|local-command-stdout|command-name|command-message|command-args)[^>]*>[\s\S]*?<\/(?:system-reminder|local-command-caveat|local-command-stdout|command-name|command-message|command-args)>/g, '')
        .replace(/<(?:system-reminder|local-command-caveat|local-command-stdout|command-name|command-message|command-args)[^>]*\/>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
function toWireSession(s) {
    return {
        id: s.id,
        agentType: s.agentType,
        firstPrompt: stripSystemTags(s.firstPrompt).slice(0, 400),
        sessionName: s.sessionName ? stripSystemTags(s.sessionName).slice(0, 200) : undefined,
        lastAssistantPreview: s.lastAssistantPreview
            ? stripSystemTags(s.lastAssistantPreview).slice(0, 400)
            : undefined,
        messageCount: s.messageCount,
        startedAt: s.startedAt,
        lastActivityAt: s.lastActivityAt,
        projectFolder: folderName(s.projectPath) || folderName(s.cwd),
        model: s.model,
    };
}
// ── Resume command construction (mirrors ResumePanel.tsx) ──────────────────
//
// The server builds both the normal and bypass commands so the phone never
// constructs a shell command itself. `getResumeCommand` already returns the
// canonical normal command (and handles Codex inline mode); bypass appends the
// agent's skip-permissions flag.
function buildDefaultResumeCommand(agentType, sessionId) {
    switch (agentType) {
        case 'claude': return `claude --resume ${sessionId}`;
        case 'codex': return `codex --no-alt-screen resume ${sessionId}`;
        case 'gemini': return `gemini --resume ${sessionId}`;
        case 'kimi': return `kimi --session ${sessionId}`;
        case 'agy': return `agy --conversation ${sessionId}`;
        case 'qwen': return `qwen --resume ${sessionId}`;
        case 'grok': return `grok --resume ${sessionId}`;
        case 'hermes': return `hermes --resume ${sessionId}`;
        case 'cursor': return sessionId ? `cursor-agent --resume ${sessionId}` : 'cursor-agent --resume';
        case 'pi': return sessionId ? `pi --session ${sessionId}` : 'pi -r';
        case 'cline': return `cline --id ${sessionId}`;
        case 'amp': return `amp --resume ${sessionId}`;
        case 'opencode': return `opencode -s ${sessionId}`;
        default: return types_1.AGENT_CONFIG[agentType]?.command || '';
    }
}
function appendCommandFlag(command, flag, aliases = [flag]) {
    const trimmed = command.trim();
    if (!trimmed)
        return trimmed;
    const tokens = trimmed.split(/\s+/);
    if (aliases.some((alias) => tokens.includes(alias)))
        return trimmed;
    if (aliases.includes('--approval-mode=yolo') && /\s--approval-mode\s+yolo(?:\s|$)/.test(` ${trimmed} `))
        return trimmed;
    return `${trimmed} ${flag}`;
}
function buildBypassResumeCommand(agentType, sessionId, normalCommand) {
    const baseCommand = normalCommand.trim() || buildDefaultResumeCommand(agentType, sessionId);
    switch (agentType) {
        case 'claude': return appendCommandFlag(baseCommand, '--dangerously-skip-permissions');
        case 'codex': return appendCommandFlag(baseCommand, '--dangerously-bypass-approvals-and-sandbox', ['--dangerously-bypass-approvals-and-sandbox', '--yolo']);
        case 'gemini': return appendCommandFlag(baseCommand, '--approval-mode=yolo', ['--approval-mode=yolo', '--yolo', '-y']);
        case 'kimi': return appendCommandFlag(baseCommand, '--yolo');
        case 'agy': return appendCommandFlag(baseCommand, '--dangerously-skip-permissions');
        case 'qwen': return appendCommandFlag(baseCommand, '--approval-mode=yolo', ['--approval-mode=yolo', '--yolo', '-y']);
        case 'grok': return appendCommandFlag(baseCommand, '--always-approve');
        case 'hermes': return appendCommandFlag(baseCommand, '--yolo');
        case 'cursor': return appendCommandFlag(baseCommand, '--force', ['--force', '--yolo']);
        case 'amp': return appendCommandFlag(baseCommand, '--dangerously-allow-all');
        case 'opencode': return appendCommandFlag(baseCommand, '--dangerously-skip-permissions');
        default: return baseCommand;
    }
}
function resolveProjectPath(storeManager, projectId) {
    if (!storeManager || !projectId)
        return undefined;
    return storeManager.getProjects().find((p) => p.id === projectId)?.rootPath || undefined;
}
/** The open terminal (if any) already bound to this session across all projects. */
function findOpenTerminalForSession(storeManager, sessionId) {
    if (!storeManager)
        return null;
    try {
        for (const project of storeManager.getProjects()) {
            const terminal = (project.terminals || []).find((t) => t.lastSessionId === sessionId);
            if (terminal) {
                return {
                    terminalId: terminal.id,
                    projectId: project.id,
                    terminalName: terminal.name,
                    projectName: project.name,
                };
            }
        }
    }
    catch {
        // Ownership info is best-effort; the phone falls back to plain resume.
    }
    return null;
}
function errorMessage(err) {
    return err instanceof Error ? err.message : 'Resume command failed';
}
/**
 * Register read-only resume-session browsing for the remote phone UI. Actually
 * resuming a session reuses the existing `terminal:create` event (operator) with
 * the resume command this handler builds — there's no separate write event here.
 *
 *   resume:scan    -> AI sessions, optionally scoped to a project (viewer)
 *   resume:detail  -> one session's transcript (viewer)
 *   resume:command -> normal + bypass resume commands for a session (viewer)
 *
 * Permission gating is enforced centrally by the permission middleware
 * (EVENT_PERMISSIONS).
 */
function registerResumeHandlers(io, managers) {
    const { storeManager, resumeManager } = managers;
    io.on('connection', (socket) => {
        socket.on('resume:scan', async (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (!resumeManager) {
                ack({ ok: false, error: 'Resume unavailable' });
                return;
            }
            // Scope to the project's path unless the phone explicitly asks for all.
            const projectPath = payload?.scope === 'all'
                ? undefined
                : resolveProjectPath(storeManager, payload?.projectId);
            const limit = Math.min(Math.max(1, payload?.limit || 50), SCAN_LIMIT_MAX);
            const offset = Math.max(0, payload?.offset || 0);
            try {
                const result = await resumeManager.scanSessions({
                    query: payload?.query || undefined,
                    agentType: payload?.agentType,
                    projectPath,
                    limit,
                    offset,
                });
                ack({ ok: true, sessions: result.sessions.map(toWireSession), total: result.total });
            }
            catch (err) {
                ack({ ok: false, error: errorMessage(err) });
            }
        });
        socket.on('resume:detail', async (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (!resumeManager) {
                ack({ ok: false, error: 'Resume unavailable' });
                return;
            }
            if (!payload?.agentType || !payload?.sessionId) {
                ack({ ok: false, error: 'Missing agentType or sessionId' });
                return;
            }
            try {
                const detail = await resumeManager.getSessionDetail(payload.agentType, payload.sessionId);
                if (!detail) {
                    ack({ ok: false, error: 'Session not found' });
                    return;
                }
                ack({
                    ok: true,
                    detail: {
                        ...toWireSession(detail),
                        messages: detail.messages
                            .map((m) => ({ role: m.role, content: stripSystemTags(m.content) }))
                            .filter((m) => m.content),
                    },
                });
            }
            catch (err) {
                ack({ ok: false, error: errorMessage(err) });
            }
        });
        socket.on('resume:command', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (!resumeManager) {
                ack({ ok: false, error: 'Resume unavailable' });
                return;
            }
            const { agentType, sessionId } = payload || {};
            if (!agentType || !sessionId) {
                ack({ ok: false, error: 'Missing agentType or sessionId' });
                return;
            }
            if (!RESUMABLE_AGENTS.has(agentType)) {
                ack({ ok: false, error: `${agentType} sessions can't be resumed` });
                return;
            }
            try {
                const normal = resumeManager.getResumeCommand(agentType, sessionId)?.trim()
                    || buildDefaultResumeCommand(agentType, sessionId);
                if (!normal) {
                    ack({ ok: false, error: 'No resume command available' });
                    return;
                }
                ack({
                    ok: true,
                    commands: {
                        normal,
                        bypass: buildBypassResumeCommand(agentType, sessionId, normal),
                    },
                    openTerminal: findOpenTerminalForSession(storeManager, sessionId) || undefined,
                });
            }
            catch (err) {
                ack({ ok: false, error: errorMessage(err) });
            }
        });
    });
}
