"use strict";
/**
 * Level-based authoring operations over a HierarchyChart (orchestration v5.1).
 *
 * The chart (nodes + manages/skip-level edges) stays the ONLY stored and
 * validated format — guard, hashing, activation, and skills are untouched.
 * This module is the simpler authoring vocabulary on top of it: levels are
 * derived tiers, and every operation is a pure chart→chart transform the
 * Hierarchy tab (and the prompt-directive builder) compose. Renderer and main
 * both import it, so it must stay free of node/Electron globals, exactly like
 * hierarchy.ts.
 *
 * "Level-simple" charts — no skip-level edges, at most one manager per node —
 * are the ones the level editor can fully express. Charts beyond that (second
 * managers, skip-level grants) still RENDER as levels but structural edits go
 * through the advanced editor.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.chartIsLevelSimple = chartIsLevelSimple;
exports.hierarchyPrimaryParent = hierarchyPrimaryParent;
exports.chartLevels = chartLevels;
exports.mintNodeId = mintNodeId;
exports.addChildNode = addChildNode;
exports.setNodeParent = setNodeParent;
exports.hierarchyPrimaryChildren = hierarchyPrimaryChildren;
exports.setLayoutParent = setLayoutParent;
exports.promoteNode = promoteNode;
exports.demoteNode = demoteNode;
exports.canPromoteNode = canPromoteNode;
exports.canDemoteNode = canDemoteNode;
exports.removeNodeReparent = removeNodeReparent;
exports.chartFromKindEdges = chartFromKindEdges;
const hierarchy_1 = require("./hierarchy");
/** True when the level editor can express every structural edit: a forest of
 *  single-manager nodes with no skip-level grants. */
function chartIsLevelSimple(chart) {
    if (chart.edges.some((edge) => edge.kind === 'skip-level'))
        return false;
    return chart.nodes.every((node) => (0, hierarchy_1.hierarchyDirectManagers)(chart, node.nodeId).length <= 1);
}
/** The node this seat hangs under in a levels/org rendering: `reportsTo` when
 *  set, else its only manager. Multi-manager nodes without reportsTo fall back
 *  to the first manages edge so a projection can always draw. */
function hierarchyPrimaryParent(chart, nodeId) {
    const node = chart.nodes.find((n) => n.nodeId === nodeId);
    if (node?.reportsTo)
        return node.reportsTo;
    return (0, hierarchy_1.hierarchyDirectManagers)(chart, nodeId)[0];
}
/** Nodes grouped by derived tier: result[0] = roots. Always dense (no holes). */
function chartLevels(chart) {
    const tiers = (0, hierarchy_1.deriveHierarchyTiers)(chart);
    const depth = Object.values(tiers).reduce((max, tier) => Math.max(max, tier), 0);
    const levels = Array.from({ length: chart.nodes.length ? depth + 1 : 0 }, () => []);
    for (const node of chart.nodes) {
        levels[tiers[node.nodeId] ?? 0]?.push(node);
    }
    return levels;
}
/** Mint a readable node id from the agent kind: grok, grok-2, grok-3… */
function mintNodeId(chart, agentKind) {
    const base = hierarchy_1.HIERARCHY_NODE_ID_RE.test(agentKind) ? agentKind : 'agent';
    if (!chart.nodes.some((n) => n.nodeId === base))
        return base;
    let index = 2;
    while (chart.nodes.some((n) => n.nodeId === `${base}-${index}`))
        index++;
    return `${base}-${index}`;
}
function withoutManagesInto(chart, nodeId) {
    return chart.edges.filter((edge) => !(edge.kind === 'manages' && edge.to === nodeId));
}
/**
 * Add a subordinate under `parentId` (the org-chart "+" gesture), or a new
 * root when parentId is undefined. Returns the unchanged chart at the node cap
 * — the editor mirrors the cap, main enforces it.
 */
function addChildNode(chart, parentId, selector, label) {
    if (chart.nodes.length >= hierarchy_1.MAX_HIERARCHY_NODES)
        return { chart, nodeId: null };
    if (parentId && !chart.nodes.some((n) => n.nodeId === parentId))
        return { chart, nodeId: null };
    const nodeId = mintNodeId(chart, selector.agentKind);
    const node = {
        nodeId,
        label: label || selector.agentKind,
        selector,
        ...(parentId ? { reportsTo: parentId } : {}),
    };
    return {
        nodeId,
        chart: {
            ...chart,
            nodes: [...chart.nodes, node],
            edges: parentId ? [...chart.edges, { from: parentId, to: nodeId, kind: 'manages' }] : chart.edges,
        },
    };
}
/**
 * Re-hang a node under a new parent (level editing: changing the parent IS
 * changing the level). Replaces every inbound manages edge with the one new
 * edge — level-simple charts have at most one anyway, and the level editor is
 * only offered for those. `parentId: undefined` promotes the node to a root.
 * Self/descendant parents are refused (would cycle) by returning the chart
 * unchanged; the caller disables those options.
 */
function setNodeParent(chart, nodeId, parentId) {
    if (!chart.nodes.some((n) => n.nodeId === nodeId))
        return chart;
    if (parentId !== undefined) {
        if (parentId === nodeId || !chart.nodes.some((n) => n.nodeId === parentId))
            return chart;
        if (isDescendant(chart, nodeId, parentId))
            return chart;
    }
    const edges = withoutManagesInto(chart, nodeId);
    return {
        ...chart,
        nodes: chart.nodes.map((n) => n.nodeId === nodeId
            ? { ...n, ...(parentId ? { reportsTo: parentId } : { reportsTo: undefined }) }
            : n),
        edges: parentId ? [...edges, { from: parentId, to: nodeId, kind: 'manages' }] : edges,
    };
}
/** Nodes whose org-chart parent is `parentId` (`undefined` = current roots). */
function hierarchyPrimaryChildren(chart, parentId) {
    return chart.nodes
        .filter((node) => hierarchyPrimaryParent(chart, node.nodeId) === parentId)
        .map((node) => node.nodeId);
}
/**
 * Change who this node hangs under in the org chart.
 *
 * If `parentId` already manages the node, only `reportsTo` changes — extra
 * managers and skip-level grants stay. Otherwise this is a move: inbound
 * `manages` edges are replaced (same as `setNodeParent`).
 */
function setLayoutParent(chart, nodeId, parentId) {
    if (parentId && (0, hierarchy_1.hierarchyDirectManagers)(chart, nodeId).includes(parentId)) {
        if (!chart.nodes.some((n) => n.nodeId === nodeId))
            return chart;
        return {
            ...chart,
            nodes: chart.nodes.map((n) => n.nodeId === nodeId ? { ...n, reportsTo: parentId } : n),
        };
    }
    return setNodeParent(chart, nodeId, parentId);
}
/** Outdent: hang under the current parent's parent (or become a root). */
function promoteNode(chart, nodeId) {
    const parent = hierarchyPrimaryParent(chart, nodeId);
    if (!parent)
        return chart;
    return setNodeParent(chart, nodeId, hierarchyPrimaryParent(chart, parent));
}
/** Indent: hang under the previous sibling on the same level. */
function demoteNode(chart, nodeId) {
    const siblings = hierarchyPrimaryChildren(chart, hierarchyPrimaryParent(chart, nodeId));
    const index = siblings.indexOf(nodeId);
    if (index <= 0)
        return chart;
    return setNodeParent(chart, nodeId, siblings[index - 1]);
}
function canPromoteNode(chart, nodeId) {
    return hierarchyPrimaryParent(chart, nodeId) !== undefined;
}
function canDemoteNode(chart, nodeId) {
    const siblings = hierarchyPrimaryChildren(chart, hierarchyPrimaryParent(chart, nodeId));
    return siblings.indexOf(nodeId) > 0;
}
/** True when `maybeDescendant` sits somewhere under `nodeId` via manages edges. */
function isDescendant(chart, nodeId, maybeDescendant) {
    const queue = [nodeId];
    const visited = new Set();
    while (queue.length > 0) {
        const current = queue.shift();
        if (visited.has(current))
            continue;
        visited.add(current);
        for (const edge of chart.edges) {
            if (edge.kind !== 'manages' || edge.from !== current)
                continue;
            if (edge.to === maybeDescendant)
                return true;
            queue.push(edge.to);
        }
    }
    return false;
}
/**
 * Remove a node the org-chart way: its children re-hang under its parent
 * (or become roots) instead of silently losing their manager. Skip-level
 * edges touching the node are dropped.
 */
function removeNodeReparent(chart, nodeId) {
    if (!chart.nodes.some((n) => n.nodeId === nodeId))
        return chart;
    const parentId = hierarchyPrimaryParent(chart, nodeId);
    const childIds = chart.edges
        .filter((edge) => edge.kind === 'manages' && edge.from === nodeId)
        .map((edge) => edge.to);
    let next = {
        ...chart,
        nodes: chart.nodes
            .filter((n) => n.nodeId !== nodeId)
            .map((n) => (n.reportsTo === nodeId ? { ...n, reportsTo: undefined } : n)),
        edges: chart.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
    };
    for (const childId of childIds) {
        next = setNodeParent(next, childId, parentId);
    }
    return next;
}
/**
 * Build a chart from kind-level delegation edges (prompt-derived hierarchy:
 * "claude request grok, grok request opencode"). One node per kind; managers
 * are created before their subordinates so ids stay readable. Suppressed
 * kinds get `suppressReport` ("review back to Grok, do not report to me").
 */
function chartFromKindEdges(edges, options) {
    let chart = {
        chartId: options?.chartId ?? 'default',
        name: options?.name ?? 'default',
        nodes: [],
        edges: [],
        maxChainDepth: hierarchy_1.DEFAULT_HIERARCHY_CHAIN_DEPTH,
        updatedAt: 0,
    };
    const nodeIdByKind = new Map();
    const managerOf = new Map(edges.map((edge) => [edge.toKind, edge.fromKind]));
    const suppress = new Set(options?.suppressReportKinds ?? []);
    const building = new Set();
    const ensureNode = (kind) => {
        const existing = nodeIdByKind.get(kind);
        if (existing)
            return existing;
        // A managerOf cycle would recurse forever; break it by rooting the kind.
        if (building.has(kind))
            return null;
        building.add(kind);
        const managerKind = managerOf.get(kind);
        const parentId = managerKind !== undefined ? ensureNode(managerKind) : undefined;
        if (managerKind !== undefined && parentId === null)
            return null;
        const result = addChildNode(chart, parentId ?? undefined, { agentKind: kind }, options?.labels?.[kind]);
        if (!result.nodeId)
            return null;
        chart = result.chart;
        nodeIdByKind.set(kind, result.nodeId);
        return result.nodeId;
    };
    for (const edge of edges) {
        if (ensureNode(edge.fromKind) === null)
            break;
        if (ensureNode(edge.toKind) === null)
            break;
    }
    return {
        ...chart,
        nodes: chart.nodes.map((node) => suppress.has(node.selector.agentKind) ? { ...node, suppressReport: true } : node),
    };
}
