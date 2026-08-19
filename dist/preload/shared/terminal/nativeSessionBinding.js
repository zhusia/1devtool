"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getNativeSessionBindingUpdate = getNativeSessionBindingUpdate;
/**
 * Apply a process-attributed native hook binding only to the exact terminal
 * and exact previous state it was validated for.
 */
function getNativeSessionBindingUpdate(terminal, event) {
    if (terminal.id !== event.terminalId)
        return null;
    if ((terminal.lastSessionId ?? null) !== event.previousSessionId)
        return null;
    if (terminal.lastSessionId === event.sessionId &&
        terminal.lastSessionAgentType === event.agentType) {
        return null;
    }
    return {
        lastSessionId: event.sessionId,
        lastSessionAgentType: event.agentType,
    };
}
