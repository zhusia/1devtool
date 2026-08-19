"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setupPermissionMiddleware = setupPermissionMiddleware;
exports.hasPermission = hasPermission;
exports.checkConnectionMode = checkConnectionMode;
exports.getRequiredPermission = getRequiredPermission;
/**
 * Permission hierarchy (lowest to highest):
 *   viewer < approver < operator < admin
 */
const PERMISSION_RANK = {
    viewer: 0,
    approver: 1,
    operator: 2,
    admin: 3,
};
/**
 * Map of event names to minimum required permission level.
 */
const EVENT_PERMISSIONS = {
    'terminal:subscribe': 'viewer',
    'terminal:unsubscribe': 'viewer',
    'terminal:input': 'operator',
    'terminal:resize': 'operator',
    'terminal:ai-quota': 'viewer',
    'quota:center-summary': 'viewer',
    'remote:ping': 'viewer',
    'ai:terminals': 'viewer',
    'ai:send': 'operator',
    'browser:screenshot': 'viewer',
    'approval:approve': 'approver',
    'approval:reject': 'approver',
    'git:status': 'viewer',
    'git:diff': 'viewer',
    'git:commit-detail': 'viewer',
    'git:pull': 'operator',
    'git:push': 'operator',
    'git:commit': 'operator',
    'history:prompts:search': 'viewer',
    'history:prompts:delete': 'operator',
    'history:prompts:sync-local': 'operator',
    'history:notes:search': 'viewer',
    'history:notes:delete': 'operator',
    'files:tree': 'viewer',
    'files:read': 'viewer',
    'files:write': 'operator',
    'files:diff': 'viewer',
    'files:search': 'viewer',
    'resume:scan': 'viewer',
    'resume:detail': 'viewer',
    'resume:command': 'viewer',
    'tools:http:list': 'operator',
    'tools:http:get': 'operator',
    'tools:http:send': 'operator',
    'tools:http:save': 'operator',
    'tools:db:list': 'operator',
    'tools:db:test': 'operator',
    'tools:db:schema': 'operator',
    'tools:db:query': 'operator',
    'tools:db:preview': 'operator',
    'dashboard:snapshot': 'viewer',
    'dashboard:select-host': 'viewer',
    // Tasks: seeing what is blocked is not an action, but answering it is the
    // same class of decision as approving a terminal action (docs/tasks_v2.md
    // §5.3). A viewer-paired phone can watch the queue and change nothing.
    'tasks:gates': 'viewer',
    'tasks:resolve-gate': 'approver',
    // Orchestration v4 phone parity: reads are viewer; the two decisions
    // (link request, queued message) are the same class as approving a
    // terminal action or a task gate. Graph creation stays desktop-only.
    'orchestration:snapshot': 'viewer',
    'orchestration:runs': 'viewer',
    'orchestration:run-file': 'viewer',
    'orchestration:app-log': 'viewer',
    'orchestration:resolve-link-request': 'approver',
    'orchestration:resolve-link-message': 'approver',
    // Hierarchy seat repair (orchestration v5 §8) — same authority substitute
    // as the link-request decision: a paired device the user granted approver.
    'orchestration:rebind-seat': 'approver',
    // HappyRemote (dev-only) — read-only semantic transcript stream.
    'happy:subscribe': 'viewer',
    'happy:unsubscribe': 'viewer',
};
/**
 * Allowed connection modes per permission level.
 * Viewers can connect from anywhere; higher privilege requires more trusted networks.
 */
const PERMISSION_MIN_MODE = {
    viewer: ['lan', 'vpn', 'relay'],
    approver: ['lan', 'vpn', 'relay'],
    operator: ['lan', 'vpn', 'relay'],
    admin: ['lan', 'vpn', 'relay'],
};
/**
 * Set up per-event permission checking middleware on the socket.io server.
 * This runs after auth middleware and checks that the authenticated device
 * has sufficient permissions for the requested event.
 */
function setupPermissionMiddleware(io) {
    io.on('connection', (socket) => {
        socket.use((packet, next) => {
            const [eventName] = packet;
            // Skip permission checks for auth and internal events
            if (eventName.startsWith('auth:') ||
                eventName === 'disconnect' ||
                eventName === 'error') {
                next();
                return;
            }
            // If the event has a defined permission requirement, enforce it
            const requiredPermission = EVENT_PERMISSIONS[eventName];
            if (requiredPermission) {
                // Check permission level
                if (!hasPermission(socket, requiredPermission)) {
                    next(new Error(`Insufficient permissions: ${eventName} requires ${requiredPermission}`));
                    return;
                }
                // Check connection mode
                const connectionMode = socket.data.connectionMode;
                if (!checkConnectionMode(connectionMode, requiredPermission)) {
                    next(new Error(`Connection mode '${connectionMode}' not allowed for ${requiredPermission} actions`));
                    return;
                }
            }
            next();
        });
    });
}
/**
 * Check if a socket's permission level meets or exceeds the required level.
 */
function hasPermission(socket, required) {
    const socketLevel = socket.data.permissionLevel || 'viewer';
    return PERMISSION_RANK[socketLevel] >= PERMISSION_RANK[required];
}
/**
 * Check if a connection mode is allowed for the required permission level.
 */
function checkConnectionMode(mode, required) {
    const allowedModes = PERMISSION_MIN_MODE[required];
    if (!allowedModes) {
        return false;
    }
    return allowedModes.includes(mode);
}
/**
 * Get the required permission for an event name.
 * Returns undefined if no permission is mapped (event may be unprotected or unknown).
 */
function getRequiredPermission(eventName) {
    return EVENT_PERMISSIONS[eventName];
}
