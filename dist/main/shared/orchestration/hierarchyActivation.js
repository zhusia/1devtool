"use strict";
/**
 * Hierarchy activation contracts (orchestration v5 — runtime binding).
 *
 * An activation binds one chart's role slots to live terminal endpoints in
 * one project. Main owns the record (durable beside terminal-links.json,
 * atomic snapshot writes, crash-honest load); the renderer and CLI only
 * mirror. The chart is FROZEN at activation (invariant 30): later chart
 * edits affect the next activation, never a running org.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HIERARCHY_MAX_ESCALATION_RECORDS = exports.HIERARCHY_MAX_VIOLATION_RECORDS = void 0;
exports.findSeatByNode = findSeatByNode;
exports.findSeatByEndpoint = findSeatByEndpoint;
exports.orphanedSubtreeNodeIds = orphanedSubtreeNodeIds;
exports.HIERARCHY_MAX_VIOLATION_RECORDS = 50;
exports.HIERARCHY_MAX_ESCALATION_RECORDS = 50;
function findSeatByNode(activation, nodeId) {
    return activation.seats.find((seat) => seat.nodeId === nodeId);
}
/** Seat lookup for a LIVE terminal: id + generation must both match, so a
 *  relaunched terminal (new generation) is unseated by construction. */
function findSeatByEndpoint(activation, terminalId, terminalGeneration) {
    return activation.seats.find((seat) => seat.endpoint.terminalId === terminalId &&
        (terminalGeneration === undefined || seat.endpoint.terminalGeneration === terminalGeneration));
}
/**
 * Every node whose chain of command passes through a vacant seat. Computed
 * over `manages` edges of the frozen chart: descendants of vacant nodes are
 * stranded even when their own seats are healthy.
 */
function orphanedSubtreeNodeIds(chart, vacantNodeIds) {
    const orphaned = new Set();
    const queue = [...vacantNodeIds];
    while (queue.length > 0) {
        const current = queue.shift();
        for (const edge of chart.edges) {
            if (edge.kind !== 'manages' || edge.from !== current)
                continue;
            if (orphaned.has(edge.to) || vacantNodeIds.includes(edge.to))
                continue;
            orphaned.add(edge.to);
            queue.push(edge.to);
        }
    }
    return [...orphaned];
}
