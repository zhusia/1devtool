"use strict";
/** Pure contracts for the durable, principal-bound Team collaboration plane. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TEAM_MESSAGE_MAX_HOPS = exports.TEAM_MESSAGE_MAX_IN_FLIGHT = exports.TEAM_MESSAGE_MAX_PER_TEAM = exports.TEAM_MESSAGE_MAX_BODY_CHARS = exports.TEAM_READ_PERMISSIONS = void 0;
exports.isTeamReadPermission = isTeamReadPermission;
exports.teamConnectionKey = teamConnectionKey;
exports.isTeamMessageTerminal = isTeamMessageTerminal;
exports.TEAM_READ_PERMISSIONS = [
    'read-transcript',
    'read-transcript-full',
    'read-screen',
    'read-artifact',
];
function isTeamReadPermission(permission) {
    return exports.TEAM_READ_PERMISSIONS.includes(permission);
}
exports.TEAM_MESSAGE_MAX_BODY_CHARS = 64_000;
exports.TEAM_MESSAGE_MAX_PER_TEAM = 2_000;
exports.TEAM_MESSAGE_MAX_IN_FLIGHT = 32;
exports.TEAM_MESSAGE_MAX_HOPS = 8;
function teamConnectionKey(connection) {
    return `${connection.fromMemberId}\u0000${connection.toMemberId}`;
}
function isTeamMessageTerminal(state) {
    return state === 'answered' || state === 'failed' || state === 'cancelled';
}
