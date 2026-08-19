"use strict";
/**
 * Hierarchy chart contracts + validation (orchestration v5 — chain of command).
 *
 * A chart is an abstract org template: role slots (nodes bound to agent
 * SELECTORS, not terminals) plus directed `manages` / `skip-level` edges.
 * Charts are preferences (draft/applied split, same discipline as the routing
 * policy); ACTIVATION (hierarchyActivation.ts) binds slots to concrete
 * terminal endpoints per project. Rank is never stored — tiers are derived as
 * the longest path from the roots, so the graph must stay a DAG.
 *
 * Validation bounds are ENFORCED IN MAIN on `orchestration:set-hierarchy`
 * (single source of truth); the renderer mirrors them for inline feedback —
 * the exact `normalizePolicyDraft` pattern.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EFFECTIVE_TO_HEADLESS_AGENT_KIND = exports.MAX_PIPELINE_STAGES = exports.MAX_PIPELINE_GATE_ROUNDS = exports.MIN_PIPELINE_GATE_ROUNDS = exports.DEFAULT_PIPELINE_GATE_ROUNDS = exports.DEFAULT_HIERARCHY_CHAIN_DEPTH = exports.HIERARCHY_QUALITY_GATE_MAX_CHARS = exports.HIERARCHY_BRIEF_MAX_CHARS = exports.HIERARCHY_LABEL_MAX_CHARS = exports.HIERARCHY_NODE_ID_RE = exports.MAX_HIERARCHY_EDGES = exports.MAX_HIERARCHY_NODES = void 0;
exports.hierarchyManagesEdges = hierarchyManagesEdges;
exports.hierarchyDirectManagers = hierarchyDirectManagers;
exports.hierarchyDirectSubordinates = hierarchyDirectSubordinates;
exports.hierarchySkipLevelTargets = hierarchySkipLevelTargets;
exports.hierarchyRootIds = hierarchyRootIds;
exports.hierarchyIsManagesAncestor = hierarchyIsManagesAncestor;
exports.findHierarchyNode = findHierarchyNode;
exports.deriveHierarchyTiers = deriveHierarchyTiers;
exports.hierarchyChartDepth = hierarchyChartDepth;
exports.hierarchyChartHasStructure = hierarchyChartHasStructure;
exports.headlessAgentKindForEffectiveKind = headlessAgentKindForEffectiveKind;
exports.hierarchyNodeRole = hierarchyNodeRole;
exports.hierarchyTaskSourceIds = hierarchyTaskSourceIds;
exports.emptyHierarchyChart = emptyHierarchyChart;
exports.normalizeHierarchyChart = normalizeHierarchyChart;
exports.canonicalHierarchyProjection = canonicalHierarchyProjection;
// IMPORTANT: imported as VALUES by the renderer (editor validation mirror) —
// keep every import pure (no node:fs / Buffer / Electron).
const headlessMode_1 = require("../headlessMode");
const agentModels_1 = require("../agentModels");
const orchestrationPolicy_1 = require("../orchestrationPolicy");
const teamMessages_1 = require("./teamMessages");
// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------
exports.MAX_HIERARCHY_NODES = 12;
exports.MAX_HIERARCHY_EDGES = 24;
exports.HIERARCHY_NODE_ID_RE = /^[a-z][a-z0-9-]{1,23}$/;
exports.HIERARCHY_LABEL_MAX_CHARS = 40;
exports.HIERARCHY_BRIEF_MAX_CHARS = 200;
exports.HIERARCHY_QUALITY_GATE_MAX_CHARS = 160;
exports.DEFAULT_HIERARCHY_CHAIN_DEPTH = 5;
exports.DEFAULT_PIPELINE_GATE_ROUNDS = 2;
exports.MIN_PIPELINE_GATE_ROUNDS = 1;
exports.MAX_PIPELINE_GATE_ROUNDS = 4;
/** A linear handoff consumes one hop per boundary (the substrate caps at 8). */
exports.MAX_PIPELINE_STAGES = Math.min(exports.MAX_HIERARCHY_NODES, teamMessages_1.TEAM_MESSAGE_MAX_HOPS + 1);
// ---------------------------------------------------------------------------
// Graph helpers (pure; shared by validation, the main-process guard, and the
// renderer editor — one reachability definition, not three)
// ---------------------------------------------------------------------------
function hierarchyManagesEdges(chart) {
    return chart.edges.filter((edge) => edge.kind === 'manages');
}
function hierarchyDirectManagers(chart, nodeId) {
    return hierarchyManagesEdges(chart)
        .filter((edge) => edge.to === nodeId)
        .map((edge) => edge.from);
}
function hierarchyDirectSubordinates(chart, nodeId) {
    return hierarchyManagesEdges(chart)
        .filter((edge) => edge.from === nodeId)
        .map((edge) => edge.to);
}
function hierarchySkipLevelTargets(chart, nodeId) {
    return chart.edges
        .filter((edge) => edge.kind === 'skip-level' && edge.from === nodeId)
        .map((edge) => edge.to);
}
/** Roots = nodes with no inbound `manages` edge. They report to the human. */
function hierarchyRootIds(chart) {
    const managed = new Set(hierarchyManagesEdges(chart).map((edge) => edge.to));
    return chart.nodes.map((node) => node.nodeId).filter((nodeId) => !managed.has(nodeId));
}
/** Reachability over `manages` edges only (skip-level grants no ancestry). */
function hierarchyIsManagesAncestor(chart, ancestorId, nodeId) {
    if (ancestorId === nodeId)
        return false;
    const queue = [ancestorId];
    const visited = new Set();
    while (queue.length > 0) {
        const current = queue.shift();
        if (visited.has(current))
            continue;
        visited.add(current);
        for (const next of hierarchyDirectSubordinates(chart, current)) {
            if (next === nodeId)
                return true;
            queue.push(next);
        }
    }
    return false;
}
function findHierarchyNode(chart, nodeId) {
    return chart.nodes.find((node) => node.nodeId === nodeId);
}
/**
 * Tier = longest path from any root over `manages` edges. Assumes a DAG —
 * callers validate first; on a cyclic input the unreachable remainder is
 * simply absent from the result rather than looping forever.
 */
function deriveHierarchyTiers(chart) {
    const tiers = {};
    const indegree = new Map();
    for (const node of chart.nodes)
        indegree.set(node.nodeId, 0);
    for (const edge of hierarchyManagesEdges(chart)) {
        if (!indegree.has(edge.from) || !indegree.has(edge.to))
            continue;
        indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    }
    const queue = [...indegree.entries()].filter(([, count]) => count === 0).map(([nodeId]) => nodeId);
    for (const nodeId of queue)
        tiers[nodeId] = 0;
    while (queue.length > 0) {
        const current = queue.shift();
        for (const next of hierarchyDirectSubordinates(chart, current)) {
            if (!indegree.has(next))
                continue;
            tiers[next] = Math.max(tiers[next] ?? 0, (tiers[current] ?? 0) + 1);
            const remaining = (indegree.get(next) ?? 0) - 1;
            indegree.set(next, remaining);
            if (remaining === 0)
                queue.push(next);
        }
    }
    return tiers;
}
/** Deepest derived tier — the longest chain of command in the chart. */
function hierarchyChartDepth(chart) {
    return Object.values(deriveHierarchyTiers(chart)).reduce((max, tier) => Math.max(max, tier), 0);
}
/** A chart worth activating: at least a manager and a subordinate. */
function hierarchyChartHasStructure(chart) {
    return !!chart && chart.nodes.length >= 2 && hierarchyManagesEdges(chart).length >= 1;
}
/** Live terminals report their DECLARED interactive kind; selectors bind to
 *  HEADLESS_SPECS keys. One alias table (the CLI link guard's), one place. */
exports.EFFECTIVE_TO_HEADLESS_AGENT_KIND = {
    'claude-command': 'claude',
    antigravity: 'agy',
};
function headlessAgentKindForEffectiveKind(effectiveAgentKind) {
    return exports.EFFECTIVE_TO_HEADLESS_AGENT_KIND[effectiveAgentKind] ?? effectiveAgentKind;
}
/** Director = root (reports to the human); worker = leaf; manager = both
 *  managed and managing (the §0.1 "lead" and "manager" tiers). */
function hierarchyNodeRole(chart, nodeId) {
    const isRoot = hierarchyDirectManagers(chart, nodeId).length === 0;
    if (isRoot)
        return 'director';
    return hierarchyDirectSubordinates(chart, nodeId).length > 0 ? 'manager' : 'worker';
}
/** Seats allowed to task this node: direct managers + skip-level grantors. */
function hierarchyTaskSourceIds(chart, nodeId) {
    const sources = new Set(hierarchyDirectManagers(chart, nodeId));
    for (const edge of chart.edges) {
        if (edge.kind === 'skip-level' && edge.to === nodeId)
            sources.add(edge.from);
    }
    return [...sources];
}
/** First cycle in the `manages` subgraph, as node ids in walk order, or null. */
function findManagesCycle(chart) {
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map();
    for (const node of chart.nodes)
        color.set(node.nodeId, WHITE);
    const stack = [];
    let cycle = null;
    const visit = (nodeId) => {
        color.set(nodeId, GRAY);
        stack.push(nodeId);
        for (const next of hierarchyDirectSubordinates(chart, nodeId)) {
            if (!color.has(next))
                continue;
            if (color.get(next) === GRAY) {
                const start = stack.indexOf(next);
                cycle = [...stack.slice(start), next];
                return true;
            }
            if (color.get(next) === WHITE && visit(next))
                return true;
        }
        stack.pop();
        color.set(nodeId, BLACK);
        return false;
    };
    for (const node of chart.nodes) {
        if (color.get(node.nodeId) === WHITE && visit(node.nodeId))
            return cycle;
    }
    return null;
}
// ---------------------------------------------------------------------------
// Normalization / validation
// ---------------------------------------------------------------------------
function emptyHierarchyChart() {
    return {
        chartId: 'default',
        name: 'default',
        nodes: [],
        edges: [],
        maxChainDepth: exports.DEFAULT_HIERARCHY_CHAIN_DEPTH,
        updatedAt: 0,
    };
}
function normalizeSelector(raw, where, errors) {
    const src = (raw && typeof raw === 'object' ? raw : {});
    const agentKind = typeof src.agentKind === 'string' ? src.agentKind.trim() : '';
    if (!agentKind) {
        errors.push(`${where}: selector needs an agentKind`);
        return null;
    }
    if (!Object.keys(headlessMode_1.HEADLESS_SPECS).includes(agentKind)) {
        errors.push(`${where}: unknown agent "${agentKind}"`);
        return null;
    }
    const selector = { agentKind };
    if (typeof src.model === 'string' && src.model.trim()) {
        const model = src.model.trim();
        if (!agentModels_1.AGENT_MODEL_SPECS[agentKind]) {
            errors.push(`${where}: agent "${agentKind}" does not support a model — clear the model field`);
        }
        else if (!(0, agentModels_1.isValidModelId)(model)) {
            errors.push(`${where}: "${model}" is not a valid model id`);
        }
        else {
            selector.model = model;
        }
    }
    return selector;
}
/**
 * Normalize + validate a chart coming over IPC (or from disk). Every §2 rule
 * is enforced here — this is the single source of truth. Errors are collected,
 * not thrown; callers reject the save when non-empty.
 */
function normalizeHierarchyChart(raw) {
    const errors = [];
    const src = (raw && typeof raw === 'object' ? raw : {});
    const pipelineTopology = src.topology === 'pipeline';
    const nodes = [];
    const seenIds = new Set();
    const srcNodes = Array.isArray(src.nodes) ? src.nodes : [];
    if (srcNodes.length > exports.MAX_HIERARCHY_NODES) {
        errors.push(`too many nodes (max ${exports.MAX_HIERARCHY_NODES})`);
    }
    for (const rawNode of srcNodes.slice(0, exports.MAX_HIERARCHY_NODES)) {
        if (!rawNode || typeof rawNode !== 'object')
            continue;
        const n = rawNode;
        const nodeId = typeof n.nodeId === 'string' ? n.nodeId : '';
        if (!exports.HIERARCHY_NODE_ID_RE.test(nodeId)) {
            errors.push(`node id "${nodeId}" must match ^[a-z][a-z0-9-]{1,23}$`);
            continue;
        }
        if (seenIds.has(nodeId)) {
            errors.push(`node id "${nodeId}" is duplicated`);
            continue;
        }
        const selector = normalizeSelector(n.selector, `node "${nodeId}"`, errors);
        if (!selector)
            continue;
        seenIds.add(nodeId);
        const label = (0, orchestrationPolicy_1.sanitizeRoutingText)(typeof n.label === 'string' ? n.label : '', exports.HIERARCHY_LABEL_MAX_CHARS);
        const brief = typeof n.brief === 'string'
            ? (0, orchestrationPolicy_1.sanitizeRoutingText)(n.brief, exports.HIERARCHY_BRIEF_MAX_CHARS)
            : '';
        const qualityGate = typeof n.qualityGate === 'string'
            ? (0, orchestrationPolicy_1.sanitizeRoutingText)(n.qualityGate, exports.HIERARCHY_QUALITY_GATE_MAX_CHARS)
            : '';
        const reportsTo = typeof n.reportsTo === 'string' && n.reportsTo.trim() ? n.reportsTo.trim() : undefined;
        nodes.push({
            nodeId,
            label: label || nodeId,
            selector,
            ...(reportsTo ? { reportsTo } : {}),
            ...(brief ? { brief } : {}),
            ...(n.suppressReport === true ? { suppressReport: true } : {}),
            ...(pipelineTopology && qualityGate ? { qualityGate } : {}),
        });
    }
    const edges = [];
    const seenEdges = new Set();
    const srcEdges = Array.isArray(src.edges) ? src.edges : [];
    if (srcEdges.length > exports.MAX_HIERARCHY_EDGES) {
        errors.push(`too many edges (max ${exports.MAX_HIERARCHY_EDGES})`);
    }
    for (const rawEdge of srcEdges.slice(0, exports.MAX_HIERARCHY_EDGES)) {
        if (!rawEdge || typeof rawEdge !== 'object')
            continue;
        const e = rawEdge;
        const from = typeof e.from === 'string' ? e.from : '';
        const to = typeof e.to === 'string' ? e.to : '';
        const kind = e.kind;
        if (kind !== 'manages' && kind !== 'skip-level') {
            errors.push(`edge ${from || '?'} → ${to || '?'}: unknown kind "${String(kind)}"`);
            continue;
        }
        if (!seenIds.has(from) || !seenIds.has(to)) {
            errors.push(`edge ${from || '?'} → ${to || '?'}: both ends must be chart nodes`);
            continue;
        }
        if (from === to) {
            errors.push(`edge ${from} → ${to}: a node cannot manage itself`);
            continue;
        }
        const key = `${from} ${to} ${kind}`;
        if (seenEdges.has(key)) {
            errors.push(`edge ${from} → ${to} (${kind}) is duplicated`);
            continue;
        }
        seenEdges.add(key);
        edges.push({ from, to, kind });
    }
    const draft = {
        chartId: typeof src.chartId === 'string' && src.chartId.trim() ? src.chartId.trim() : 'default',
        name: (0, orchestrationPolicy_1.sanitizeRoutingText)(typeof src.name === 'string' ? src.name : '', exports.HIERARCHY_LABEL_MAX_CHARS) || 'default',
        nodes,
        edges,
        maxChainDepth: exports.DEFAULT_HIERARCHY_CHAIN_DEPTH,
        updatedAt: typeof src.updatedAt === 'number' && Number.isFinite(src.updatedAt) ? src.updatedAt : 0,
        ...(pipelineTopology ? { topology: 'pipeline' } : {}),
    };
    // --- Structural rules (only meaningful once ids/edges are well-formed) ---
    const cycle = findManagesCycle(draft);
    if (cycle) {
        errors.push(`hierarchy contains a cycle: ${cycle.join(' → ')}`);
    }
    const tiers = cycle ? {} : deriveHierarchyTiers(draft);
    for (const node of draft.nodes) {
        const managers = hierarchyDirectManagers(draft, node.nodeId);
        if (managers.length === 0) {
            // Root: reports to the human, never to a node.
            if (node.reportsTo) {
                errors.push(`root node "${node.nodeId}" reports to the human — remove reportsTo`);
                delete node.reportsTo;
            }
            continue;
        }
        if (!node.reportsTo) {
            if (managers.length === 1) {
                // D4: default to the only manager.
                node.reportsTo = managers[0];
            }
            else {
                errors.push(`node "${node.nodeId}" has several managers (${managers.join(', ')}) — pick one reportsTo`);
            }
            continue;
        }
        if (!managers.includes(node.reportsTo)) {
            errors.push(`node "${node.nodeId}" reportsTo "${node.reportsTo}" is not one of its direct managers (${managers.join(', ')})`);
        }
    }
    for (const edge of draft.edges) {
        if (edge.kind !== 'skip-level')
            continue;
        if (seenEdges.has(`${edge.from} ${edge.to} manages`)) {
            errors.push(`skip-level ${edge.from} → ${edge.to} duplicates a manages edge — a direct manager needs no skip-level`);
            continue;
        }
        if (!cycle && !hierarchyIsManagesAncestor(draft, edge.from, edge.to)) {
            errors.push(`skip-level ${edge.from} → ${edge.to}: "${edge.from}" is not an ancestor of "${edge.to}" through manages edges`);
        }
    }
    let maxChainDepth = exports.DEFAULT_HIERARCHY_CHAIN_DEPTH;
    if (!pipelineTopology) {
        const rawDepth = src.maxChainDepth;
        if (rawDepth !== undefined) {
            if (typeof rawDepth !== 'number' || !Number.isInteger(rawDepth) || rawDepth < 1) {
                errors.push('maxChainDepth must be a positive integer');
            }
            else if (rawDepth > teamMessages_1.TEAM_MESSAGE_MAX_HOPS) {
                errors.push(`maxChainDepth must be ≤ ${teamMessages_1.TEAM_MESSAGE_MAX_HOPS}`);
            }
            else {
                maxChainDepth = rawDepth;
            }
        }
    }
    const depth = cycle ? 0 : hierarchyChartDepth(draft);
    if (draft.topology !== 'pipeline' && maxChainDepth < depth) {
        errors.push(`maxChainDepth ${maxChainDepth} is below the chart depth ${depth} — the bottom tier could never be tasked`);
    }
    draft.maxChainDepth = maxChainDepth;
    if (draft.topology === 'pipeline') {
        if (draft.nodes.length < 2)
            errors.push('pipeline needs at least two stages');
        if (draft.nodes.length > exports.MAX_PIPELINE_STAGES) {
            errors.push(`pipeline has too many stages (max ${exports.MAX_PIPELINE_STAGES})`);
        }
        if (draft.edges.some((edge) => edge.kind !== 'manages')) {
            errors.push('pipeline may contain only adjacent manages edges');
        }
        const manages = hierarchyManagesEdges(draft);
        if (manages.length !== Math.max(0, draft.nodes.length - 1)) {
            errors.push('pipeline stages must form one connected linear chain');
        }
        for (const node of draft.nodes) {
            if (hierarchyDirectManagers(draft, node.nodeId).length > 1
                || hierarchyDirectSubordinates(draft, node.nodeId).length > 1) {
                errors.push(`pipeline stage "${node.nodeId}" branches; stages must be linear`);
            }
            if (node.suppressReport) {
                errors.push(`pipeline stage "${node.nodeId}" cannot suppress its handoff`);
                delete node.suppressReport;
            }
        }
        const roots = hierarchyRootIds(draft);
        const leaves = draft.nodes.filter((node) => hierarchyDirectSubordinates(draft, node.nodeId).length === 0);
        if (draft.nodes.length > 0 && (roots.length !== 1 || leaves.length !== 1)) {
            errors.push('pipeline must have one first stage and one final stage');
        }
        const finalNode = roots.length === 1 ? findHierarchyNode(draft, roots[0]) : undefined;
        if (finalNode?.qualityGate) {
            errors.push(`final pipeline stage "${finalNode.nodeId}" cannot define a quality gate`);
            delete finalNode.qualityGate;
        }
        const rawRounds = src.maxGateRounds;
        let maxGateRounds = exports.DEFAULT_PIPELINE_GATE_ROUNDS;
        if (rawRounds !== undefined) {
            if (typeof rawRounds !== 'number' || !Number.isInteger(rawRounds)
                || rawRounds < exports.MIN_PIPELINE_GATE_ROUNDS || rawRounds > exports.MAX_PIPELINE_GATE_ROUNDS) {
                errors.push(`maxGateRounds must be an integer from ${exports.MIN_PIPELINE_GATE_ROUNDS} to ${exports.MAX_PIPELINE_GATE_ROUNDS}`);
            }
            else {
                maxGateRounds = rawRounds;
            }
        }
        draft.maxGateRounds = maxGateRounds;
        // A valid pipeline's depth is entirely determined by its ordered stages.
        draft.maxChainDepth = Math.max(1, draft.nodes.length - 1);
    }
    return { normalized: draft, errors, tiers };
}
/**
 * Semantic projection for canonicalPolicyHash: everything that changes what
 * an activation or installed skill would do, nothing that doesn't
 * (`updatedAt` excluded — same rule as the routing hash).
 */
function canonicalHierarchyProjection(chart) {
    if (!chart || chart.nodes.length === 0)
        return null;
    return {
        chartId: chart.chartId,
        name: chart.name,
        maxChainDepth: chart.maxChainDepth,
        nodes: [...chart.nodes]
            .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
            .map((node) => [
            node.nodeId,
            node.label,
            node.selector.agentKind,
            node.selector.model ?? '',
            node.reportsTo ?? '',
            node.brief ?? '',
            // Appended only when set so every pre-existing chart keeps its hash.
            ...(node.suppressReport ? ['no-report'] : []),
            ...(node.qualityGate ? ['gate', node.qualityGate] : []),
        ]),
        edges: [...chart.edges]
            .sort((a, b) => `${a.from} ${a.to} ${a.kind}`.localeCompare(`${b.from} ${b.to} ${b.kind}`))
            .map((edge) => [edge.from, edge.to, edge.kind]),
        ...(chart.topology === 'pipeline'
            ? {
                topology: 'pipeline',
                maxGateRounds: chart.maxGateRounds ?? exports.DEFAULT_PIPELINE_GATE_ROUNDS,
            }
            : {}),
    };
}
