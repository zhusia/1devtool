"use strict";
/**
 * HappyRemote socket handlers (DEV-ONLY).
 *
 * Streams an AI agent terminal's JSONL transcript to the phone as structured
 * HappyEnvelopes so the remote UI can render Happy-style per-tool cards instead
 * of mirroring raw xterm bytes. Registered only when the dev gate is on (see
 * RemoteServer.start) so it never ships in production.
 *
 * Events:
 *   happy:subscribe   { terminalId } -> ack { ok, envelopes?, pending?, reason? }
 *                                        + live `happy:envelopes` pushes
 *   happy:unsubscribe { terminalId }
 *
 * Reuses the desktop's existing transcript discovery (`ResumeManager`) and the
 * terminal→cwd/agent mapping from the project store. The only genuinely new
 * desktop logic is the tool-preserving mapper + tailer.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerHappyHandlers = registerHappyHandlers;
const transcriptTailer_1 = require("../happy/transcriptTailer");
const transcriptToEnvelopes_1 = require("../happy/transcriptToEnvelopes");
function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
/** Read a terminal record's declared agent + project from the store. */
function findTerminal(storeManager, terminalId) {
    if (!storeManager)
        return null;
    try {
        for (const project of storeManager.getProjects()) {
            const found = (project.terminals || []).find((t) => t.id === terminalId);
            if (found)
                return { agentType: found.agentType, projectId: found.projectId };
        }
    }
    catch {
        /* ignore */
    }
    return null;
}
function findProjectRoot(storeManager, projectId) {
    if (!storeManager || !projectId)
        return null;
    try {
        const project = storeManager.getProjects().find((p) => p.id === projectId);
        return project?.rootPath || null;
    }
    catch {
        return null;
    }
}
const normPath = (p) => (p || '').replace(/[\\/]+$/, '').toLowerCase();
/** Newest matching session file for an agent running in `cwd`. */
async function resolveTranscriptFile(resumeManager, agentType, cwd) {
    const all = await resumeManager.getAllSessions();
    const target = normPath(cwd);
    const matches = all
        .filter((s) => s.agentType === agentType &&
        (normPath(s.cwd) === target || normPath(s.projectPath) === target))
        .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    return matches[0]?.filePath || null;
}
function registerHappyHandlers(io, deps) {
    io.on('connection', (socket) => {
        const tailers = new Map();
        const stopTailer = (terminalId) => {
            tailers.get(terminalId)?.stop();
            tailers.delete(terminalId);
        };
        socket.on('happy:subscribe', async (payload, ack) => {
            const terminalId = payload?.terminalId;
            if (!terminalId) {
                ack?.({ ok: false, reason: 'not-found', error: 'Missing terminalId' });
                return;
            }
            // Re-subscribe replaces any prior tailer for this terminal on this socket.
            stopTailer(terminalId);
            const term = findTerminal(deps.storeManager, terminalId);
            const agentType = term?.agentType;
            if (!term || !(0, transcriptToEnvelopes_1.isTailableAgent)(agentType)) {
                ack?.({ ok: false, reason: 'no-transcript' });
                return;
            }
            const cwd = findProjectRoot(deps.storeManager, term.projectId);
            if (!cwd || !deps.resumeManager) {
                ack?.({ ok: false, reason: 'not-found' });
                return;
            }
            const resumeManager = deps.resumeManager;
            const begin = async (filePath, viaAck) => {
                if (socket.disconnected)
                    return;
                const tailer = new transcriptTailer_1.TranscriptTailer(filePath, agentType);
                tailers.set(terminalId, tailer);
                await tailer.start((snapshot) => {
                    if (viaAck)
                        ack?.({ ok: true, envelopes: snapshot });
                    else if (snapshot.length)
                        socket.emit('happy:envelopes', { terminalId, envelopes: snapshot });
                }, (delta) => socket.emit('happy:envelopes', { terminalId, envelopes: delta }));
            };
            // The agent may not have flushed its transcript yet — try once now, and
            // if absent, ack "pending" and keep retrying in the background, pushing
            // the snapshot over `happy:envelopes` once the file appears.
            const immediate = await resolveTranscriptFile(resumeManager, agentType, cwd);
            if (immediate) {
                await begin(immediate, true);
                return;
            }
            ack?.({ ok: true, envelopes: [], pending: true });
            for (let i = 0; i < 20; i++) {
                if (socket.disconnected || !tailers.has(terminalId)) {
                    // unsubscribed/disconnected while waiting — but note: we only set the
                    // tailer once resolved, so guard on disconnect only.
                }
                if (socket.disconnected)
                    return;
                await delay(1500);
                const found = await resolveTranscriptFile(resumeManager, agentType, cwd);
                if (found) {
                    await begin(found, false);
                    return;
                }
            }
        });
        socket.on('happy:unsubscribe', (payload) => {
            if (payload?.terminalId)
                stopTailer(payload.terminalId);
        });
        socket.on('disconnect', () => {
            for (const tailer of tailers.values())
                tailer.stop();
            tailers.clear();
        });
    });
}
