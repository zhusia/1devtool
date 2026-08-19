"use strict";
/**
 * Main-owned scope resolution for Mission Control's "Export current" action.
 *
 * The renderer names only the project it is showing. Active Team/Swarm
 * snapshots and durable terminal links decide which terminal ids and run ids
 * belong in the export; filesystem paths never cross IPC.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveCurrentLogExportScope = resolveCurrentLogExportScope;
function linkTouchesProject(link, projectId) {
    return link.projectId === projectId
        || link.from.projectId === projectId
        || link.to.projectId === projectId;
}
/**
 * Collect a stable, deduplicated point-in-time scope. PTY liveness is checked
 * by the caller immediately before buffer reads because it is main-process
 * runtime state, not part of these durable orchestration projections.
 */
function resolveCurrentLogExportScope(args) {
    const orchestrationIds = new Set();
    const linkIds = new Set();
    const terminalIds = new Set();
    const callIds = new Set();
    for (const orchestration of args.orchestrations) {
        if (orchestration.projectId !== args.projectId)
            continue;
        orchestrationIds.add(orchestration.topology === 'team' ? orchestration.teamId : orchestration.swarmId);
        terminalIds.add(orchestration.hostTerminalId);
        const units = orchestration.topology === 'team'
            ? orchestration.members
            : orchestration.workers;
        for (const unit of units) {
            if (unit.terminalId)
                terminalIds.add(unit.terminalId);
            for (const runId of unit.runIds)
                callIds.add(runId);
        }
    }
    for (const link of args.links) {
        if (!linkTouchesProject(link, args.projectId))
            continue;
        linkIds.add(link.linkId);
        terminalIds.add(link.from.terminalId);
        terminalIds.add(link.to.terminalId);
    }
    return {
        orchestrationIds: [...orchestrationIds],
        linkIds: [...linkIds],
        terminalIds: [...terminalIds],
        callIds: [...callIds],
    };
}
