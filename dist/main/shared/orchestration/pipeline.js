"use strict";
/** Pure Pipeline authoring, compilation, and prompt parsing (v6). */
Object.defineProperty(exports, "__esModule", { value: true });
exports.pipelineStageIndex = exports.pipelinePreviousStage = exports.pipelineNextStage = exports.parsePromptPipelineDirectives = exports.bindPromptPipelineGates = exports.MIN_PIPELINE_GATE_ROUNDS = exports.MAX_PIPELINE_STAGES = exports.MAX_PIPELINE_GATE_ROUNDS = exports.DEFAULT_PIPELINE_GATE_ROUNDS = void 0;
exports.isPipelineChart = isPipelineChart;
exports.pipelineStages = pipelineStages;
exports.chartFromPipelineStages = chartFromPipelineStages;
exports.normalizePipelineChart = normalizePipelineChart;
const orchestrationPolicy_1 = require("../orchestrationPolicy");
const hierarchy_1 = require("./hierarchy");
Object.defineProperty(exports, "DEFAULT_PIPELINE_GATE_ROUNDS", { enumerable: true, get: function () { return hierarchy_1.DEFAULT_PIPELINE_GATE_ROUNDS; } });
Object.defineProperty(exports, "MAX_PIPELINE_GATE_ROUNDS", { enumerable: true, get: function () { return hierarchy_1.MAX_PIPELINE_GATE_ROUNDS; } });
Object.defineProperty(exports, "MAX_PIPELINE_STAGES", { enumerable: true, get: function () { return hierarchy_1.MAX_PIPELINE_STAGES; } });
Object.defineProperty(exports, "MIN_PIPELINE_GATE_ROUNDS", { enumerable: true, get: function () { return hierarchy_1.MIN_PIPELINE_GATE_ROUNDS; } });
function slug(value, index, used) {
    let base = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!/^[a-z]/.test(base))
        base = `stage-${index + 1}`;
    base = base.slice(0, 24);
    if (base.length < 2)
        base = `stage-${index + 1}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
        const tail = `-${suffix++}`;
        candidate = `${base.slice(0, 24 - tail.length)}${tail}`;
    }
    used.add(candidate);
    return candidate;
}
function isPipelineChart(chart) {
    return chart?.topology === 'pipeline';
}
/** Ordered first → final, or [] when the stored graph is not one chain. */
function pipelineStages(chart) {
    if (!isPipelineChart(chart) || !chart || chart.nodes.length < 2)
        return [];
    if (chart.edges.some((edge) => edge.kind !== 'manages'))
        return [];
    const first = chart.nodes.filter((node) => (0, hierarchy_1.hierarchyDirectSubordinates)(chart, node.nodeId).length === 0);
    const roots = chart.nodes.filter((node) => (0, hierarchy_1.hierarchyDirectManagers)(chart, node.nodeId).length === 0);
    if (first.length !== 1 || roots.length !== 1 || chart.edges.length !== chart.nodes.length - 1)
        return [];
    const ordered = [];
    const visited = new Set();
    let current = first[0];
    while (current && !visited.has(current.nodeId)) {
        ordered.push(current);
        visited.add(current.nodeId);
        if (!current.reportsTo)
            break;
        current = (0, hierarchy_1.findHierarchyNode)(chart, current.reportsTo);
    }
    return ordered.length === chart.nodes.length && ordered.at(-1)?.nodeId === roots[0].nodeId
        ? ordered
        : [];
}
/** Compile the authoring line to the existing inverted manages tree. */
function chartFromPipelineStages(stages, opts = {}) {
    const used = new Set();
    const nodes = stages.map((stage, index) => {
        const nodeId = slug(stage.nodeId || stage.label || stage.selector.agentKind, index, used);
        return {
            nodeId,
            label: (0, orchestrationPolicy_1.sanitizeRoutingText)(stage.label || stage.selector.agentKind, 40) || nodeId,
            selector: { ...stage.selector },
            ...(stage.brief
                ? { brief: (0, orchestrationPolicy_1.sanitizeRoutingText)(stage.brief, hierarchy_1.HIERARCHY_BRIEF_MAX_CHARS) }
                : {}),
            ...(stage.qualityGate
                ? { qualityGate: (0, orchestrationPolicy_1.sanitizeRoutingText)(stage.qualityGate, hierarchy_1.HIERARCHY_QUALITY_GATE_MAX_CHARS) }
                : {}),
        };
    });
    for (let index = 0; index < nodes.length - 1; index += 1) {
        nodes[index].reportsTo = nodes[index + 1].nodeId;
    }
    return (0, hierarchy_1.normalizeHierarchyChart)({
        chartId: opts.chartId ?? 'pipeline',
        name: opts.name ?? 'Pipeline',
        topology: 'pipeline',
        nodes,
        edges: nodes.slice(0, -1).map((node, index) => ({
            from: nodes[index + 1].nodeId,
            to: node.nodeId,
            kind: 'manages',
        })),
        maxChainDepth: Math.max(1, nodes.length - 1),
        maxGateRounds: opts.maxGateRounds ?? hierarchy_1.DEFAULT_PIPELINE_GATE_ROUNDS,
        updatedAt: opts.updatedAt ?? Date.now(),
    });
}
function normalizePipelineChart(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return (0, hierarchy_1.normalizeHierarchyChart)({ ...src, topology: 'pipeline' });
}
// Public facade: chart/editor callers import this module. Gate parsing remains
// conservative in pipelinePrompt, which the eager composer imports directly so
// lazy editor helpers do not inflate the renderer entry chunk.
var pipelinePrompt_1 = require("./pipelinePrompt");
Object.defineProperty(exports, "bindPromptPipelineGates", { enumerable: true, get: function () { return pipelinePrompt_1.bindPromptPipelineGates; } });
Object.defineProperty(exports, "parsePromptPipelineDirectives", { enumerable: true, get: function () { return pipelinePrompt_1.parsePromptPipelineDirectives; } });
Object.defineProperty(exports, "pipelineNextStage", { enumerable: true, get: function () { return pipelinePrompt_1.pipelineNextStage; } });
Object.defineProperty(exports, "pipelinePreviousStage", { enumerable: true, get: function () { return pipelinePrompt_1.pipelinePreviousStage; } });
Object.defineProperty(exports, "pipelineStageIndex", { enumerable: true, get: function () { return pipelinePrompt_1.pipelineStageIndex; } });
