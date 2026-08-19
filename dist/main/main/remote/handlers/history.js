"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerHistoryHandlers = registerHistoryHandlers;
function errorMessage(err) {
    return err instanceof Error ? err.message : 'History command failed';
}
function sanitizeLimit(value, fallback) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.max(1, Math.min(100, Math.floor(n)));
}
function sanitizeOffset(value) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n))
        return 0;
    return Math.max(0, Math.floor(n));
}
/**
 * Register read-mostly prompt history + sticky note history operations for the
 * phone UI. Search is viewer-access; sync/delete are permission-gated centrally
 * by EVENT_PERMISSIONS.
 */
function registerHistoryHandlers(io, managers) {
    const { promptHistoryManager, notesManager, resumeManager } = managers;
    io.on('connection', (socket) => {
        socket.on('history:prompts:search', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (!promptHistoryManager) {
                ack({ ok: false, error: 'Prompt history unavailable' });
                return;
            }
            try {
                const result = promptHistoryManager.search({
                    ...(payload || {}),
                    limit: sanitizeLimit(payload?.limit, 50),
                    offset: sanitizeOffset(payload?.offset),
                });
                ack({ ok: true, result });
            }
            catch (err) {
                ack({ ok: false, error: errorMessage(err) });
            }
        });
        socket.on('history:prompts:delete', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (!promptHistoryManager) {
                ack({ ok: false, error: 'Prompt history unavailable' });
                return;
            }
            const id = Number(payload?.id);
            if (!Number.isInteger(id) || id <= 0) {
                ack({ ok: false, error: 'Missing prompt id' });
                return;
            }
            try {
                promptHistoryManager.delete(id);
                ack({ ok: true });
            }
            catch (err) {
                ack({ ok: false, error: errorMessage(err) });
            }
        });
        socket.on('history:prompts:sync-local', async (_payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (!promptHistoryManager || !resumeManager) {
                ack({ ok: false, error: 'Prompt sync unavailable' });
                return;
            }
            try {
                const localPrompts = await resumeManager.collectLocalPromptRecords();
                const result = promptHistoryManager.importLocalPrompts(localPrompts.records, {
                    scannedSessions: localPrompts.scannedSessions,
                    agents: localPrompts.agents,
                });
                ack({ ok: true, result });
            }
            catch (err) {
                ack({ ok: false, error: errorMessage(err) });
            }
        });
        socket.on('history:notes:search', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (!notesManager) {
                ack({ ok: false, error: 'Sticky notes unavailable' });
                return;
            }
            try {
                const result = notesManager.search({
                    ...(payload || {}),
                    limit: sanitizeLimit(payload?.limit, 50),
                    offset: sanitizeOffset(payload?.offset),
                });
                ack({ ok: true, result });
            }
            catch (err) {
                ack({ ok: false, error: errorMessage(err) });
            }
        });
        socket.on('history:notes:delete', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (!notesManager) {
                ack({ ok: false, error: 'Sticky notes unavailable' });
                return;
            }
            const id = Number(payload?.id);
            if (!Number.isInteger(id) || id <= 0) {
                ack({ ok: false, error: 'Missing note id' });
                return;
            }
            try {
                notesManager.delete(id);
                ack({ ok: true });
            }
            catch (err) {
                ack({ ok: false, error: errorMessage(err) });
            }
        });
    });
}
