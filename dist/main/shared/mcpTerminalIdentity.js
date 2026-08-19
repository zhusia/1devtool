"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ONEDEVTOOL_TERMINAL_ID_ENV = void 0;
exports.readOneDevToolTerminalId = readOneDevToolTerminalId;
exports.withOneDevToolTerminalEnv = withOneDevToolTerminalEnv;
exports.ONEDEVTOOL_TERMINAL_ID_ENV = 'ONEDEVTOOL_TERMINAL_ID';
function readOneDevToolTerminalId(env) {
    const terminalId = env[exports.ONEDEVTOOL_TERMINAL_ID_ENV]?.trim();
    return terminalId || undefined;
}
function withOneDevToolTerminalEnv(env, terminalId) {
    return {
        ...env,
        [exports.ONEDEVTOOL_TERMINAL_ID_ENV]: terminalId,
    };
}
