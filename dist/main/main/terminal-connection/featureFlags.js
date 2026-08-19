"use strict";
/** Runtime rollback controls for Terminal Connection v2.
 * Terminal hotspot: read docs/common-errors/terminals/INDEX.md before editing.
 *
 * These environment switches are intentionally non-persistent. A rollback
 * never rewrites terminal records and a clean launch restores the shipped
 * defaults unless release operations explicitly retain the override.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.terminalConnectionV2Enabled = terminalConnectionV2Enabled;
exports.remoteTerminalAckResyncEnabled = remoteTerminalAckResyncEnabled;
function enabled(value) {
    return value !== '0' && value !== 'false' && value !== 'off';
}
function terminalConnectionV2Enabled(env = process.env) {
    return enabled(env.ONEDEVTOOL_TERMINAL_CONNECTION_V2);
}
function remoteTerminalAckResyncEnabled(env = process.env) {
    return terminalConnectionV2Enabled(env) && enabled(env.ONEDEVTOOL_REMOTE_TERMINAL_ACK_RESYNC);
}
