"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WORKSPACE_OPERATION_TTL_MS = exports.WORKSPACE_BROADCAST_HARD_CAP = exports.MAX_GROUP_VISITS = exports.MAX_GROUP_DEPTH = exports.WorkspaceError = void 0;
exports.workspaceErrorCode = workspaceErrorCode;
exports.expandGroups = expandGroups;
exports.resolveWorkspaceMembers = resolveWorkspaceMembers;
exports.assertWorkspaceActionAllowed = assertWorkspaceActionAllowed;
exports.isWorkspaceId = isWorkspaceId;
exports.isWorkspaceOperationId = isWorkspaceOperationId;
class WorkspaceError extends Error {
    code;
    constructor(code, message) {
        // The code leads the message so IPC rejection strings stay parseable on
        // the renderer side without a custom serializer.
        super(message ? `${code}: ${message}` : code);
        this.name = 'WorkspaceError';
        this.code = code;
    }
}
exports.WorkspaceError = WorkspaceError;
/** Extract a WorkspaceErrorCode from a (possibly IPC-serialized) error. */
function workspaceErrorCode(error) {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    const match = message.match(/WORKSPACE_[A-Z_]+/);
    return match ? match[0] : null;
}
exports.MAX_GROUP_DEPTH = 32;
exports.MAX_GROUP_VISITS = 256;
/**
 * Cycle-safe group expansion. Returns projectId → contributing groupId
 * (first contributor wins, for member provenance).
 *
 * A revisit on the current DFS path is a real parentId cycle and warns;
 * a revisit from a different path (e.g. a parent group and its child both
 * listed in groupIds) is legal and skipped silently.
 */
function expandGroups(groupIds, groups, includeNested, warnings) {
    const out = new Map();
    const visited = new Set();
    const path = new Set();
    let visits = 0;
    const visit = (gid, depth) => {
        if (path.has(gid)) {
            warnings.push('group-cycle');
            return;
        }
        if (visited.has(gid))
            return;
        if (depth > exports.MAX_GROUP_DEPTH) {
            warnings.push('group-depth-cap');
            return;
        }
        if (++visits > exports.MAX_GROUP_VISITS) {
            warnings.push('group-visit-cap');
            return;
        }
        visited.add(gid);
        path.add(gid);
        const group = groups.get(gid);
        if (group) {
            for (const pid of group.projectIds ?? []) {
                if (!out.has(pid))
                    out.set(pid, gid);
            }
            if (includeNested) {
                for (const [id, child] of groups) {
                    if (child.parentId === gid)
                        visit(id, depth + 1);
                }
            }
        }
        path.delete(gid);
    };
    for (const gid of groupIds)
        visit(gid, 0);
    return out;
}
/**
 * Pure membership resolve. Authority is always a fresh recompute — cached
 * results are hints (invariant 2). Never invents roots for missing projects.
 */
function resolveWorkspaceMembers(workspace, projects, groups) {
    const warnings = [];
    if (workspace.archived)
        warnings.push('archived');
    const explicit = [...new Set(workspace.projectIds ?? [])];
    const explicitSet = new Set(explicit);
    let groupProvenance = new Map();
    if (workspace.membershipMode === 'live') {
        groupProvenance = expandGroups(workspace.groupIds ?? [], groups, workspace.includeNestedGroups !== false, warnings);
    }
    const candidateIds = [...new Set([...explicit, ...groupProvenance.keys()])];
    const members = [];
    const orphanProjectIds = [];
    for (const projectId of candidateIds) {
        const project = projects.get(projectId);
        if (!project) {
            orphanProjectIds.push(projectId);
            warnings.push('missing-project');
            continue;
        }
        const fromGroup = !explicitSet.has(projectId);
        members.push({
            projectId,
            name: project.name,
            rootPath: project.rootPath,
            color: project.color,
            source: fromGroup ? 'group' : 'explicit',
            ...(fromGroup ? { groupId: groupProvenance.get(projectId) } : {}),
        });
    }
    const orphanGroupIds = (workspace.groupIds ?? []).filter((gid) => !groups.has(gid));
    if (orphanGroupIds.length > 0)
        warnings.push('missing-group');
    members.sort((a, b) => a.name.localeCompare(b.name) || a.projectId.localeCompare(b.projectId));
    return {
        workspaceId: workspace.id,
        archived: workspace.archived === true,
        membershipGeneration: workspace.membershipGeneration,
        members,
        resolvedProjectIds: members.map((m) => m.projectId),
        orphanProjectIds,
        orphanGroupIds,
        warnings: [...new Set(warnings)],
    };
}
/**
 * Shared privileged-action gate (D3): archived is non-authorizing and the
 * caller's project must be in the live resolve. Both the renderer IPC layer
 * and the agent bridge call this; display-only reads skip it.
 */
function assertWorkspaceActionAllowed(workspace, resolve, callerProjectId) {
    if (workspace.archived)
        throw new WorkspaceError('WORKSPACE_ARCHIVED');
    if (!resolve.resolvedProjectIds.includes(callerProjectId)) {
        throw new WorkspaceError('WORKSPACE_MEMBERSHIP');
    }
}
function isWorkspaceId(value) {
    return /^ws-[0-9a-z]{13,}$/.test(value);
}
function isWorkspaceOperationId(value) {
    return /^wop-[0-9a-z]{13,}$/.test(value);
}
exports.WORKSPACE_BROADCAST_HARD_CAP = 16;
exports.WORKSPACE_OPERATION_TTL_MS = 24 * 60 * 60 * 1000;
