"use strict";
/**
 * Chart ↔ mermaid bridge for the orchestration Set-up editors.
 *
 * One flowchart dialect serves three jobs:
 *   - `chartToMermaid` renders the current draft as mermaid — for "Open in
 *     Draw" (mermaid-to-excalidraw turns it into editable shapes on the Draw
 *     canvas) and for anywhere else mermaid pastes (markdown, docs, issues).
 *   - `chartFromMermaidGraph` reads a parsed flowchart BACK into a validated
 *     HierarchyChart, so an AI-generated diagram becomes a real editable
 *     draft instead of a picture of one.
 *   - `buildOrchestrationChartPrompt` teaches a headless CLI to emit exactly
 *     the dialect the other two speak.
 *
 * Parsing deliberately does NOT happen here. The renderer already ships a
 * tested mermaid-flowchart parser (`renderer/utils/mermaidGraph.ts`) and
 * shared/ must never import from renderer/, so callers hand us its parsed
 * shape (structurally typed as `MermaidGraphInput`) and this module owns every
 * orchestration semantic: agent-kind inference, edge kinds, stage order, and
 * the bounds. Validation is always delegated to `normalizeHierarchyChart` /
 * `chartFromPipelineStages` — a generated chart is held to exactly the same
 * rules main enforces on save.
 *
 * IMPORTANT: imported as VALUES by the renderer — keep every import pure.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHART_RETRY_OUTPUT_CHAR_CAP = exports.CHART_RETRY_ERROR_CHAR_CAP = exports.CHART_PROMPT_CHAR_CAP = void 0;
exports.inferAgentKind = inferAgentKind;
exports.chartToMermaid = chartToMermaid;
exports.chartFromMermaidGraph = chartFromMermaidGraph;
exports.buildOrchestrationChartPrompt = buildOrchestrationChartPrompt;
const agentModels_1 = require("../agentModels");
const headlessMode_1 = require("../headlessMode");
const orchestrationPolicy_1 = require("../orchestrationPolicy");
const hierarchy_1 = require("./hierarchy");
const pipeline_1 = require("./pipeline");
const AGENT_KINDS = Object.keys(headlessMode_1.HEADLESS_SPECS);
/**
 * Spellings a model is likely to write that are not HEADLESS_SPECS keys.
 * Whole-token matches only — see `SHORT_KINDS` for why prefixes are unsafe.
 */
const KIND_ALIASES = {
    openai: 'codex',
    chatgpt: 'codex',
    gpt: 'codex',
    anthropic: 'claude',
    antigravity: 'agy',
    moonshot: 'kimi',
    kimicode: 'kimi',
    xai: 'grok',
    sourcegraph: 'amp',
    'cursor-agent': 'cursor',
    cursoragent: 'cursor',
};
/**
 * Kinds too short to match as a prefix. `pi` would otherwise claim "pipeline",
 * "pipe", and any role label that merely starts with those letters (the same
 * trap `AgentLogo`'s exact-alias table exists for).
 */
const SHORT_KINDS = new Set(AGENT_KINDS.filter((kind) => kind.length < 3));
/** Longest-first so `opencode` wins over any shorter kind sharing a prefix. */
const PREFIX_KINDS = AGENT_KINDS.filter((kind) => !SHORT_KINDS.has(kind)).sort((a, b) => b.length - a.length);
/**
 * Resolve an agent kind from free text (a role label, a mermaid node id, …).
 * Exact tokens win over aliases, aliases over prefixes; returns null when
 * nothing matches so the caller can apply its own default.
 */
function inferAgentKind(...texts) {
    for (const raw of texts) {
        if (!raw)
            continue;
        const text = raw.toLowerCase().trim();
        if (!text)
            continue;
        const tokens = text.split(/[^a-z0-9]+/).filter(Boolean);
        for (const token of tokens) {
            if (headlessMode_1.HEADLESS_SPECS[token])
                return token;
            const alias = KIND_ALIASES[token];
            if (alias)
                return alias;
        }
        for (const kind of PREFIX_KINDS) {
            if (tokens.some((token) => token.startsWith(kind)))
                return kind;
        }
    }
    return null;
}
// ---------------------------------------------------------------------------
// Chart → mermaid
// ---------------------------------------------------------------------------
/** Characters that would terminate a quoted mermaid label or a node shape. */
function mermaidLabel(text) {
    return text
        .replace(/["'`<>{}()[\]|#;]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
/**
 * Render a chart as a mermaid flowchart: `TD` for a hierarchy (managers above
 * reports), `LR` for a pipeline (left-to-right in run order).
 *
 * Every label carries its agent in parentheses — `Lead (claude)` — which is
 * how `chartFromMermaidGraph` reads the binding back. The suffix is dropped
 * when the label alone already names that agent, so a role called "Grok"
 * stays "Grok" rather than "Grok (grok)".
 */
function chartToMermaid(chart, opts = {}) {
    const nodes = chart?.nodes ?? [];
    const pipeline = (0, pipeline_1.isPipelineChart)(chart);
    const lines = [];
    if (opts.header !== false) {
        lines.push(`%% 1DevTool orchestration — ${pipeline ? 'pipeline' : 'hierarchy'}`);
    }
    lines.push(`flowchart ${pipeline ? 'LR' : 'TD'}`);
    if (nodes.length === 0)
        return lines.join('\n');
    // A pipeline's stored edges point BACKWARD (each stage reports to the next),
    // so the picture is drawn from the stage order instead of the edge list.
    const ordered = pipeline ? pipelineOrder(chart) : nodes;
    for (const node of ordered) {
        const label = mermaidLabel(node.label || node.nodeId);
        const kind = node.selector.agentKind;
        const model = node.selector.model;
        const inferred = inferAgentKind(label);
        const suffix = !model && inferred === kind ? '' : ` (${model ? `${kind}/${model}` : kind})`;
        lines.push(`  ${node.nodeId}["${label}${suffix}"]`);
    }
    if (pipeline) {
        for (let index = 0; index < ordered.length - 1; index += 1) {
            const gate = ordered[index].qualityGate;
            // A stage's quality gate rides its forward edge — `-->|gate: …|` — so
            // the whole pipeline contract fits in one fenced block (§4.1 of the
            // Builder doc). `mermaidLabel` strips `|`, keeping the edge well-formed.
            lines.push(gate
                ? `  ${ordered[index].nodeId} -->|gate: ${mermaidLabel(gate)}| ${ordered[index + 1].nodeId}`
                : `  ${ordered[index].nodeId} --> ${ordered[index + 1].nodeId}`);
        }
        return lines.join('\n');
    }
    for (const edge of chart?.edges ?? []) {
        lines.push(edge.kind === 'skip-level'
            ? `  ${edge.from} -.->|skip| ${edge.to}`
            : `  ${edge.from} --> ${edge.to}`);
    }
    return lines.join('\n');
}
/** Stage order for a pipeline chart: follow `reportsTo` from the first stage. */
function pipelineOrder(chart) {
    const byId = new Map(chart.nodes.map((node) => [node.nodeId, node]));
    const reportedTo = new Set(chart.nodes.map((node) => node.reportsTo).filter(Boolean));
    const first = chart.nodes.find((node) => !reportedTo.has(node.nodeId)) ?? chart.nodes[0];
    const ordered = [];
    const seen = new Set();
    let cursor = first;
    while (cursor && !seen.has(cursor.nodeId)) {
        seen.add(cursor.nodeId);
        ordered.push(cursor);
        cursor = cursor.reportsTo ? byId.get(cursor.reportsTo) : undefined;
    }
    // Anything not on the chain (a malformed draft) still gets drawn.
    for (const node of chart.nodes)
        if (!seen.has(node.nodeId))
            ordered.push(node);
    return ordered;
}
/** Trailing `(kind)` / `(kind/model)` binding written by our own emitter. */
const BINDING_RE = /\(([^()]+)\)\s*$/;
function nodeIdFrom(value, index, used) {
    let base = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!/^[a-z]/.test(base))
        base = `role-${index + 1}`;
    base = base.slice(0, 24);
    if (base.length < 2)
        base = `role-${index + 1}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
        const tail = `-${suffix++}`;
        candidate = `${base.slice(0, 24 - tail.length)}${tail}`;
    }
    used.add(candidate);
    return candidate;
}
/**
 * Turn a parsed mermaid flowchart into a validated chart.
 *
 * Hierarchy: `a --> b` means "a manages b"; `a -.->|skip| b` (any edge whose
 * label mentions skip) becomes a skip-level line. Each node's `reportsTo` is
 * its first manager.
 *
 * Pipeline: `a --> b` means "a runs before b". The chain is topologically
 * ordered and rebuilt through `chartFromPipelineStages`, which owns the
 * backward `reportsTo`/edge wiring — this function never writes those by hand.
 */
function chartFromMermaidGraph(graph, opts) {
    const errors = [];
    const warnings = [];
    const pipeline = opts.topology === 'pipeline';
    const maxNodes = pipeline ? pipeline_1.MAX_PIPELINE_STAGES : hierarchy_1.MAX_HIERARCHY_NODES;
    if (graph.nodes.length === 0) {
        return { chart: null, errors: ['The diagram has no roles in it.'], warnings };
    }
    const kept = graph.nodes.slice(0, maxNodes);
    if (graph.nodes.length > kept.length) {
        warnings.push(`Kept the first ${maxNodes} roles — the diagram had ${graph.nodes.length}.`);
    }
    const fallbackKind = opts.fallbackAgentKind && headlessMode_1.HEADLESS_SPECS[opts.fallbackAgentKind]
        ? opts.fallbackAgentKind
        : AGENT_KINDS[0];
    const used = new Set();
    const idMap = new Map();
    const guessed = [];
    const nodes = kept.map((raw, index) => {
        const rawLabel = (raw.label ?? raw.id).trim();
        const binding = BINDING_RE.exec(rawLabel);
        const [bindKind, bindModel] = (binding?.[1] ?? '').split('/').map((part) => part.trim());
        const labelText = binding ? rawLabel.slice(0, binding.index).trim() : rawLabel;
        const matched = inferAgentKind(bindKind, labelText, raw.id);
        const kind = matched ?? fallbackKind;
        const nodeId = nodeIdFrom(raw.id || labelText, index, used);
        idMap.set(raw.id, nodeId);
        const label = (0, orchestrationPolicy_1.sanitizeRoutingText)(labelText || nodeId, hierarchy_1.HIERARCHY_LABEL_MAX_CHARS) || nodeId;
        if (!matched)
            guessed.push(label);
        // A hallucinated model would fail validation and reject the whole chart —
        // drop it and keep the role instead.
        const model = bindModel && agentModels_1.AGENT_MODEL_SPECS[kind] && (0, agentModels_1.isValidModelId)(bindModel)
            ? bindModel
            : undefined;
        if (bindModel && !model)
            warnings.push(`Ignored the model "${bindModel}" on ${label}.`);
        return {
            nodeId,
            label,
            selector: model ? { agentKind: kind, model } : { agentKind: kind },
        };
    });
    if (guessed.length > 0) {
        const shown = guessed.slice(0, 3).join(', ');
        warnings.push(`No agent named for ${shown}${guessed.length > 3 ? ', …' : ''} — used ${fallbackKind}.`);
    }
    const links = [];
    for (const edge of graph.edges) {
        const from = idMap.get(edge.source);
        const to = idMap.get(edge.target);
        if (!from || !to || from === to)
            continue;
        const label = edge.label ?? '';
        // `-->|gate: …|` puts the source stage's quality gate on the wire.
        const gateMatch = /^\s*gate\s*:\s*(.*)$/i.exec(label);
        const gate = gateMatch?.[1]?.trim();
        links.push({ from, to, skip: /skip/i.test(label), ...(gate ? { gate } : {}) });
    }
    if (pipeline) {
        const ordered = topologicalOrder(nodes.map((node) => node.nodeId), links);
        const byId = new Map(nodes.map((node) => [node.nodeId, node]));
        const gateBySource = new Map(links.filter((link) => !link.skip && link.gate).map((link) => [link.from, link.gate]));
        const stages = ordered
            .map((id) => byId.get(id))
            .filter((node) => Boolean(node))
            .map((node) => ({
            nodeId: node.nodeId,
            label: node.label,
            selector: node.selector,
            ...(gateBySource.has(node.nodeId) ? { qualityGate: gateBySource.get(node.nodeId) } : {}),
        }));
        if (stages.length < 2) {
            return { chart: null, errors: ['A pipeline needs at least two stages.'], warnings };
        }
        const result = (0, pipeline_1.chartFromPipelineStages)(stages, {
            chartId: opts.chartId ?? 'default',
            name: opts.name ?? 'Pipeline',
            updatedAt: opts.updatedAt ?? 0,
        });
        return { chart: result.errors.length > 0 ? null : result.normalized, errors: result.errors, warnings };
    }
    const edges = links.map((link) => ({
        from: link.from,
        to: link.to,
        kind: link.skip ? 'skip-level' : 'manages',
    }));
    for (const node of nodes) {
        const manager = edges.find((edge) => edge.kind === 'manages' && edge.to === node.nodeId);
        if (manager)
            node.reportsTo = manager.from;
    }
    const result = (0, hierarchy_1.normalizeHierarchyChart)({
        chartId: opts.chartId ?? 'default',
        name: opts.name ?? 'default',
        nodes,
        edges,
        maxChainDepth: hierarchy_1.DEFAULT_HIERARCHY_CHAIN_DEPTH,
        updatedAt: opts.updatedAt ?? 0,
    });
    return { chart: result.errors.length > 0 ? null : result.normalized, errors: result.errors, warnings };
}
/** Kahn's algorithm; leftover cycle members keep their declaration order. */
function topologicalOrder(ids, links) {
    const flow = links.filter((link) => !link.skip);
    const indegree = new Map(ids.map((id) => [id, 0]));
    for (const link of flow)
        indegree.set(link.to, (indegree.get(link.to) ?? 0) + 1);
    const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
    const ordered = [];
    const seen = new Set();
    while (queue.length > 0) {
        const id = queue.shift();
        if (seen.has(id))
            continue;
        seen.add(id);
        ordered.push(id);
        for (const link of flow) {
            if (link.from !== id)
                continue;
            const next = (indegree.get(link.to) ?? 0) - 1;
            indegree.set(link.to, next);
            if (next <= 0 && !seen.has(link.to))
                queue.push(link.to);
        }
    }
    for (const id of ids)
        if (!seen.has(id))
            ordered.push(id);
    return ordered;
}
exports.CHART_PROMPT_CHAR_CAP = 4_000;
exports.CHART_RETRY_ERROR_CHAR_CAP = 300;
exports.CHART_RETRY_OUTPUT_CHAR_CAP = 2_000;
/**
 * The prompt that teaches a headless CLI the dialect above. Deliberately
 * narrower than the Draw canvas prompt: no skeleton JSON, no diagram type
 * other than flowchart, and the agent list is closed — anything else would
 * fail `normalizeHierarchyChart` on the way in.
 */
function buildOrchestrationChartPrompt(input) {
    const pipeline = input.topology === 'pipeline';
    const parts = [
        pipeline
            ? 'Convert the description below into an AI agent PIPELINE: an ordered sequence of stages where each stage hands its result to the next.'
            : 'Convert the description below into an AI agent ORG CHART: roles and who reports to whom.',
        '',
        'Reply with ONLY one fenced ```mermaid code block — no prose before or after it.',
        '',
        'Rules:',
        `- Use \`flowchart ${pipeline ? 'LR' : 'TD'}\`. Never any other diagram type, and never JSON.`,
        '- One node per ROLE. Node ids are short lowercase slugs: lead, tester, reviewer.',
        '- Every label is quoted and ends with the agent in parentheses, e.g. lead["Lead (claude)"].',
        `- The agent MUST be one of: ${AGENT_KINDS.join(', ')}. Pick the best fit; never invent one.`,
        pipeline
            ? '- Draw ONE straight chain in run order: `a --> b --> c`. No branches, no loops, no extra edges.'
            : '- `manager --> report` means the manager assigns work to that report. Every role except the top one has exactly one manager.',
        pipeline
            ? `- Between 2 and ${pipeline_1.MAX_PIPELINE_STAGES} stages.`
            : `- At most ${hierarchy_1.MAX_HIERARCHY_NODES} roles. Add \`boss -.->|skip| grandchild\` only for an explicit skip-level line.`,
        ...(pipeline
            ? ['- When the description names acceptance criteria for a hand-off, put it on that edge: `a -->|gate: tests pass| b`.']
            : []),
        '- No subgraphs, no classDef, no style lines, no comments.',
    ];
    const retry = input.retry;
    if (retry) {
        parts.push('', 'Your previous attempt could not be used:', retry.error.slice(0, exports.CHART_RETRY_ERROR_CHAR_CAP), 'Previous output (may be truncated):', retry.previousOutput.slice(0, exports.CHART_RETRY_OUTPUT_CHAR_CAP), 'Produce a corrected diagram following the same rules.');
    }
    parts.push('', 'Description:', input.userPrompt.slice(0, exports.CHART_PROMPT_CHAR_CAP));
    return parts.join('\n');
}
