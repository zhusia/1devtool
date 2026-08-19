"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildCatalogSnapshot = buildCatalogSnapshot;
const identity_1 = require("../../shared/device/identity");
const protocol_1 = require("../../shared/device/protocol");
function buildCatalogSnapshot(sources, grant, now = Date.now()) {
    const statuses = sources.getPtyStatuses();
    const terminals = [];
    const projects = [];
    for (const project of sources.getProjects()) {
        if (!(0, identity_1.projectInGrantScope)(grant, project.id))
            continue;
        projects.push({
            projectId: project.id,
            name: project.name,
            rootPath: project.rootPath,
            sourceType: project.sourceType === 'ssh' ? 'ssh' : 'local',
        });
        for (const terminal of project.terminals) {
            const status = statuses[terminal.id];
            terminals.push({
                terminalId: terminal.id,
                terminalGeneration: sources.getTerminalGeneration?.(terminal.id) ?? 0,
                projectId: project.id,
                projectName: project.name,
                name: terminal.name,
                agentType: terminal.agentType,
                isInteractiveAgent: terminal.isInteractiveAgent === true,
                running: status?.isAlive === true,
                lastActivityAt: status?.lastActivityAt ?? null,
                isHidden: terminal.isHidden === true,
            });
        }
    }
    const clis = sources.listClis().map((cli) => ({
        cliId: cli.cliId,
        state: cli.state,
        version: cli.version,
        selectedPath: cli.selectedPath,
    }));
    return {
        protocolVersion: protocol_1.DEVICE_PROTOCOL_VERSION,
        deviceId: sources.selfDeviceId,
        generatedAt: now,
        terminals,
        clis,
        projects,
    };
}
