"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceService = void 0;
const workspace_1 = require("../../shared/workspace");
const ids_1 = require("./ids");
const uniq = (values) => [...new Set(values ?? [])];
class WorkspaceService {
    deps;
    /**
     * Last known resolvedProjectIds per workspace — a diff baseline for the
     * group-mutation hook, never authority (invariant 2: authority is a fresh
     * recompute).
     */
    lastResolvedIds = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    emitChanged(event) {
        this.deps.sendToRenderer?.('workspace:changed', event);
    }
    /**
     * One projects/groups snapshot per synchronous span. `store.getProjects()`
     * re-parses the entire config file per call (electron-store `get()`
     * semantics), and one roster/authorize/update operation resolves several
     * workspaces — uncached, a single agent roster call paid 10–20 full-file
     * parses on the main thread. Project/group mutations always run in a later
     * event-loop turn (IPC handlers), and the group-mutation funnel mutates
     * BEFORE calling into this service, so a memo dropped at microtask end can
     * never serve a stale snapshot.
     */
    mapsMemo = null;
    maps() {
        if (!this.mapsMemo) {
            this.mapsMemo = {
                projects: new Map(this.deps.store.getProjects().map((p) => [p.id, p])),
                groups: new Map(this.deps.store.getProjectGroups().map((g) => [g.id, g])),
            };
            queueMicrotask(() => {
                this.mapsMemo = null;
            });
        }
        return this.mapsMemo;
    }
    projectsMap() {
        return this.maps().projects;
    }
    groupsMap() {
        return this.maps().groups;
    }
    resolveWorkspace(workspace) {
        const result = (0, workspace_1.resolveWorkspaceMembers)(workspace, this.projectsMap(), this.groupsMap());
        this.lastResolvedIds.set(workspace.id, result.resolvedProjectIds);
        return result;
    }
    assertLicense(workspace) {
        if (this.deps.isMultiProjectAllowed?.() !== false)
            return;
        const resolved = (0, workspace_1.resolveWorkspaceMembers)(workspace, this.projectsMap(), this.groupsMap());
        if (resolved.resolvedProjectIds.length > 1) {
            throw new workspace_1.WorkspaceError('WORKSPACE_LICENSE', 'Multi-project workspaces require Pro. You can still create a single-project workspace.');
        }
    }
    // --- CRUD (main mints id, order, timestamps, generation — D10) ---
    list(includeArchived = false) {
        const all = this.deps.store.getWorkspaces();
        return includeArchived ? all : all.filter((w) => w.archived !== true);
    }
    get(id) {
        return this.deps.store.getWorkspace(id);
    }
    create(input) {
        const name = (input.name ?? '').trim();
        if (!name)
            throw new workspace_1.WorkspaceError('WORKSPACE_INVALID', 'Workspace name is required');
        if (input.membershipMode !== 'live' && input.membershipMode !== 'snapshot') {
            throw new workspace_1.WorkspaceError('WORKSPACE_INVALID', 'membershipMode must be live or snapshot');
        }
        const now = Date.now();
        const existing = this.deps.store.getWorkspaces();
        const workspace = {
            id: (0, ids_1.mintWorkspaceId)(),
            name,
            ...(input.color ? { color: input.color } : {}),
            ...(input.avatar ? { avatar: input.avatar } : {}),
            ...(input.emoji ? { emoji: input.emoji } : {}),
            projectIds: uniq(input.projectIds),
            groupIds: uniq(input.groupIds),
            membershipMode: input.membershipMode,
            includeNestedGroups: input.includeNestedGroups ?? true,
            membershipGeneration: 1,
            createdAt: now,
            updatedAt: now,
            order: existing.reduce((max, w) => Math.max(max, w.order), -1) + 1,
            archived: false,
        };
        this.assertLicense(workspace);
        this.deps.store.saveWorkspace(workspace);
        this.deps.store.setWorkspaceOrder([...this.deps.store.getWorkspaceOrder(), workspace.id]);
        this.resolveWorkspace(workspace); // seed the diff baseline
        this.emitChanged({ workspaceIds: [workspace.id], reason: 'meta' });
        return workspace;
    }
    update(id, patch) {
        const existing = this.deps.store.getWorkspace(id);
        if (!existing)
            throw new workspace_1.WorkspaceError('WORKSPACE_NOT_FOUND');
        const membershipTouched = patch.projectIds !== undefined ||
            patch.groupIds !== undefined ||
            patch.membershipMode !== undefined ||
            patch.includeNestedGroups !== undefined;
        const before = membershipTouched
            ? (0, workspace_1.resolveWorkspaceMembers)(existing, this.projectsMap(), this.groupsMap())
            : null;
        const name = patch.name !== undefined ? patch.name.trim() : existing.name;
        if (!name)
            throw new workspace_1.WorkspaceError('WORKSPACE_INVALID', 'Workspace name is required');
        const next = {
            ...existing,
            name,
            ...(patch.color !== undefined ? { color: patch.color } : {}),
            ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
            ...(patch.emoji !== undefined ? { emoji: patch.emoji } : {}),
            ...(patch.projectIds !== undefined ? { projectIds: uniq(patch.projectIds) } : {}),
            ...(patch.groupIds !== undefined ? { groupIds: uniq(patch.groupIds) } : {}),
            ...(patch.membershipMode !== undefined ? { membershipMode: patch.membershipMode } : {}),
            ...(patch.includeNestedGroups !== undefined
                ? { includeNestedGroups: patch.includeNestedGroups }
                : {}),
            ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
            updatedAt: Date.now(),
            membershipGeneration: membershipTouched
                ? existing.membershipGeneration + 1
                : existing.membershipGeneration,
        };
        if (membershipTouched)
            this.assertLicense(next);
        this.deps.store.saveWorkspace(next);
        let reason = 'meta';
        if (patch.archived !== undefined && patch.archived !== (existing.archived === true)) {
            reason = 'archived';
        }
        else if (membershipTouched && before) {
            const after = this.resolveWorkspace(next);
            const beforeSet = new Set(before.resolvedProjectIds);
            const removed = before.resolvedProjectIds.some((pid) => !after.resolvedProjectIds.includes(pid));
            const added = after.resolvedProjectIds.some((pid) => !beforeSet.has(pid));
            if (removed)
                reason = 'membership-shrunk';
            else if (added)
                reason = 'membership-expanded';
        }
        this.emitChanged({ workspaceIds: [id], reason });
        return next;
    }
    /** Deleting a workspace never deletes projects (invariant 4). */
    delete(id) {
        if (!this.deps.store.getWorkspace(id))
            throw new workspace_1.WorkspaceError('WORKSPACE_NOT_FOUND');
        this.deps.store.deleteWorkspace(id);
        this.lastResolvedIds.delete(id);
        this.emitChanged({ workspaceIds: [id], reason: 'meta' });
    }
    setOrder(order) {
        const known = new Set(this.deps.store.getWorkspaces().map((w) => w.id));
        this.deps.store.setWorkspaceOrder(order.filter((id) => known.has(id)));
    }
    setProjectPreference(projectId, workspaceId) {
        if (workspaceId !== null && !this.deps.store.getWorkspace(workspaceId)) {
            throw new workspace_1.WorkspaceError('WORKSPACE_NOT_FOUND');
        }
        this.deps.store.setProjectWorkspacePreference(projectId, workspaceId);
    }
    getProjectPreference() {
        return this.deps.store.getProjectWorkspacePreference();
    }
    // --- Resolve + authorization ---
    /**
     * Fresh membership resolve. `purpose: 'action'` refuses archived
     * workspaces (D3: archived is non-authorizing); 'display' may still
     * resolve them for history UI.
     */
    resolve(id, purpose = 'display') {
        const workspace = this.deps.store.getWorkspace(id);
        if (!workspace)
            throw new workspace_1.WorkspaceError('WORKSPACE_NOT_FOUND');
        if (purpose === 'action' && workspace.archived)
            throw new workspace_1.WorkspaceError('WORKSPACE_ARCHIVED');
        return this.resolveWorkspace(workspace);
    }
    /** Non-archived workspaces whose live resolve contains the project. */
    forProject(projectId) {
        return this.list(false).filter((workspace) => this.resolveWorkspace(workspace).resolvedProjectIds.includes(projectId));
    }
    /**
     * Privileged-action gate for a caller project (bridge + renderer both end
     * up here; neither re-implements the check).
     */
    authorizeAction(workspaceId, callerProjectId) {
        const workspace = this.deps.store.getWorkspace(workspaceId);
        if (!workspace)
            throw new workspace_1.WorkspaceError('WORKSPACE_NOT_FOUND');
        const resolve = this.resolveWorkspace(workspace);
        (0, workspace_1.assertWorkspaceActionAllowed)(workspace, resolve, callerProjectId);
        return resolve;
    }
    // --- Live membership hook (02-data-model §2, D3) ---
    /**
     * Called from the group save/delete IPC funnel. Any group change can affect
     * any live workspace through nesting, so re-resolve every live workspace
     * and diff against the last known set; a changed set bumps
     * membershipGeneration and emits workspace:changed. Workspaces are few and
     * resolve is in-memory — this is cheap and only runs on group mutations.
     */
    onProjectGroupMutated(_groupId) {
        // This is the designated post-mutation entry point: the group write has
        // just happened, possibly in this same synchronous span — never let the
        // snapshot memo serve the pre-mutation groups (invariant 2: authority is
        // a fresh recompute).
        this.mapsMemo = null;
        const projects = this.projectsMap();
        const groups = this.groupsMap();
        const expanded = [];
        const shrunk = [];
        for (const workspace of this.deps.store.getWorkspaces()) {
            if (workspace.membershipMode !== 'live')
                continue;
            const previous = this.lastResolvedIds.get(workspace.id);
            const next = (0, workspace_1.resolveWorkspaceMembers)(workspace, projects, groups).resolvedProjectIds;
            this.lastResolvedIds.set(workspace.id, next);
            if (!previous)
                continue; // no baseline yet — first observation is not a change
            const previousSet = new Set(previous);
            const added = next.some((pid) => !previousSet.has(pid));
            const removed = previous.some((pid) => !next.includes(pid));
            if (!added && !removed)
                continue;
            this.deps.store.saveWorkspace({
                ...workspace,
                membershipGeneration: workspace.membershipGeneration + 1,
                updatedAt: Date.now(),
            });
            if (removed)
                shrunk.push(workspace.id);
            else
                expanded.push(workspace.id);
        }
        if (expanded.length > 0) {
            this.emitChanged({ workspaceIds: expanded, reason: 'membership-expanded' });
        }
        if (shrunk.length > 0) {
            this.emitChanged({ workspaceIds: shrunk, reason: 'membership-shrunk' });
        }
    }
    /**
     * Seed the group-hook diff baseline for every live workspace. Called once
     * at startup so the first real group edit after launch is a detectable
     * change rather than a silent baseline write.
     */
    primeResolveBaselines() {
        this.mapsMemo = null;
        const projects = this.projectsMap();
        const groups = this.groupsMap();
        for (const workspace of this.deps.store.getWorkspaces()) {
            if (workspace.membershipMode !== 'live')
                continue;
            this.lastResolvedIds.set(workspace.id, (0, workspace_1.resolveWorkspaceMembers)(workspace, projects, groups).resolvedProjectIds);
        }
    }
}
exports.WorkspaceService = WorkspaceService;
