"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.APP_CONFIG_TRANSFER_MIN_SUPPORTED_SCHEMA_VERSION = exports.APP_CONFIG_TRANSFER_SCHEMA_VERSION = void 0;
exports.ensureSupportedTransferSchema = ensureSupportedTransferSchema;
exports.validateTransferBundle = validateTransferBundle;
exports.breakGroupParentCycles = breakGroupParentCycles;
exports.sanitizeImportedWorkspaceState = sanitizeImportedWorkspaceState;
/**
 * Schema history:
 * - 1 — projects, groups, preferences, themes.
 * - 2 — Workspace Control: adds `workspaces`, `workspaceOrder`,
 *   `projectWorkspacePreference` (docs/workspace_control/00-decisions.md D8).
 *   V1 imports stay accepted; missing workspace fields default to empty.
 */
exports.APP_CONFIG_TRANSFER_SCHEMA_VERSION = 2;
exports.APP_CONFIG_TRANSFER_MIN_SUPPORTED_SCHEMA_VERSION = 1;
// --- Pure validation / sanitize helpers (unit-tested without Electron) ---
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const stringArray = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
/** Accepts any released schema in [1, current]; refuses newer/garbage. */
function ensureSupportedTransferSchema(schemaVersion) {
    if (!Number.isInteger(schemaVersion)) {
        throw new Error('Import file is missing a valid schemaVersion.');
    }
    const numeric = schemaVersion;
    if (numeric > exports.APP_CONFIG_TRANSFER_SCHEMA_VERSION) {
        throw new Error(`This config file uses schemaVersion ${numeric}, but this app supports up to ${exports.APP_CONFIG_TRANSFER_SCHEMA_VERSION}.`);
    }
    if (numeric < exports.APP_CONFIG_TRANSFER_MIN_SUPPORTED_SCHEMA_VERSION) {
        throw new Error(`Unsupported config schemaVersion ${numeric}.`);
    }
    return numeric;
}
/**
 * Validates the parsed JSON and normalizes it to the current payload shape.
 * V1 bundles get empty workspace fields (D8); V2 bundles must carry them
 * well-formed. The returned payload always has all three workspace keys.
 */
function validateTransferBundle(parsed) {
    if (!isRecord(parsed)) {
        throw new Error('Import file must be a JSON object.');
    }
    const schemaVersion = ensureSupportedTransferSchema(parsed.schemaVersion);
    if (typeof parsed.exportedAt !== 'string' || !isRecord(parsed.exportedFrom) || !isRecord(parsed.payload)) {
        throw new Error('Import file is missing required metadata.');
    }
    const payload = parsed.payload;
    if (!isRecord(payload.preferences) ||
        !Array.isArray(payload.projects) ||
        !Array.isArray(payload.projectOrder) ||
        !isRecord(payload.projectGroups) ||
        !Array.isArray(payload.projectGroupOrder) ||
        !Array.isArray(payload.customThemes)) {
        throw new Error('Import file payload is malformed.');
    }
    if (schemaVersion >= 2) {
        if (!isRecord(payload.workspaces) ||
            !Array.isArray(payload.workspaceOrder) ||
            !isRecord(payload.projectWorkspacePreference)) {
            throw new Error('Import file payload is missing workspace fields required by schemaVersion 2.');
        }
    }
    const bundle = parsed;
    return {
        ...bundle,
        payload: {
            ...bundle.payload,
            workspaces: isRecord(payload.workspaces) ? payload.workspaces : {},
            workspaceOrder: stringArray(payload.workspaceOrder),
            projectWorkspacePreference: isRecord(payload.projectWorkspacePreference)
                ? payload.projectWorkspacePreference
                : {},
        },
    };
}
/**
 * Break `parentId` cycles in a group record before it can reach a store or a
 * resolve walk (D8/D9): every group on a detected cycle gets `parentId: null`.
 * Import must never persist a graph that can loop.
 */
function breakGroupParentCycles(groups) {
    const broken = new Set();
    for (const startId of Object.keys(groups)) {
        const path = [];
        const seen = new Set();
        let current = startId;
        while (current && groups[current]) {
            if (seen.has(current)) {
                // Everything from the first repeat onward is on the cycle.
                const cycleStart = path.indexOf(current);
                for (const gid of path.slice(cycleStart))
                    broken.add(gid);
                break;
            }
            seen.add(current);
            path.push(current);
            current = groups[current].parentId;
        }
    }
    if (broken.size === 0)
        return { groups, brokenGroupIds: [] };
    const next = {};
    for (const [gid, group] of Object.entries(groups)) {
        next[gid] = broken.has(gid) ? { ...group, parentId: null } : group;
    }
    return { groups: next, brokenGroupIds: [...broken] };
}
/**
 * D8 sanitize: drop malformed workspace entries, strip project/group ids not
 * present in the imported payload, normalize the order array, drop preference
 * entries pointing at missing workspaces/projects, and mint a missing
 * `membershipGeneration` as 1.
 */
function sanitizeImportedWorkspaceState(state, validProjectIds, validGroupIds) {
    const workspaces = {};
    for (const [id, candidate] of Object.entries(state.workspaces ?? {})) {
        if (!isRecord(candidate))
            continue;
        const raw = candidate;
        if (typeof raw.name !== 'string' || raw.name.trim() === '')
            continue;
        if (raw.membershipMode !== 'live' && raw.membershipMode !== 'snapshot')
            continue;
        const workspaceId = typeof raw.id === 'string' && raw.id ? raw.id : id;
        workspaces[workspaceId] = {
            id: workspaceId,
            name: raw.name.trim(),
            ...(typeof raw.color === 'string' ? { color: raw.color } : {}),
            ...(typeof raw.avatar === 'string' ? { avatar: raw.avatar } : {}),
            ...(typeof raw.emoji === 'string' ? { emoji: raw.emoji } : {}),
            projectIds: stringArray(raw.projectIds).filter((pid) => validProjectIds.has(pid)),
            groupIds: stringArray(raw.groupIds).filter((gid) => validGroupIds.has(gid)),
            membershipMode: raw.membershipMode,
            includeNestedGroups: raw.includeNestedGroups !== false,
            membershipGeneration: Number.isInteger(raw.membershipGeneration) && raw.membershipGeneration >= 1
                ? raw.membershipGeneration
                : 1,
            createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
            updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
            order: typeof raw.order === 'number' ? raw.order : Object.keys(workspaces).length,
            archived: raw.archived === true,
        };
    }
    const workspaceOrder = stringArray(state.workspaceOrder).filter((id) => workspaces[id]);
    for (const id of Object.keys(workspaces)) {
        if (!workspaceOrder.includes(id))
            workspaceOrder.push(id);
    }
    const projectWorkspacePreference = {};
    for (const [projectId, workspaceId] of Object.entries(state.projectWorkspacePreference ?? {})) {
        if (typeof workspaceId !== 'string')
            continue;
        if (!validProjectIds.has(projectId))
            continue;
        if (!workspaces[workspaceId])
            continue;
        projectWorkspacePreference[projectId] = workspaceId;
    }
    return { workspaces, workspaceOrder, projectWorkspacePreference };
}
