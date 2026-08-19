"use strict";
/** Lightweight Pipeline prompt parsing (orchestration v6). */
Object.defineProperty(exports, "__esModule", { value: true });
exports.bindPromptPipelineGates = bindPromptPipelineGates;
exports.parsePromptPipelineDirectives = parsePromptPipelineDirectives;
exports.pipelineStageIndex = pipelineStageIndex;
exports.pipelineNextStage = pipelineNextStage;
exports.pipelinePreviousStage = pipelinePreviousStage;
exports.orderedExplicitPipelineMentionLabels = orderedExplicitPipelineMentionLabels;
const orchestrationPolicy_1 = require("../orchestrationPolicy");
const hierarchyPromptDirectives_1 = require("./hierarchyPromptDirectives");
const hierarchy_1 = require("./hierarchy");
const SEQUENCE_MARKER_RE = /\bthen\b|\bafter\s+that\b|→|->/gi;
const SENTENCE_SPLIT_RE = /[.!?]+\s+|\n+/;
const GATE_HINT_RE = /\b(?:reject|accept)\b/i;
// `only\s+if` must precede `if`: the lazy subject otherwise hands "only" to
// the subject and matches the bare "if", so every accept clause (which
// REQUIRES "only if") would fail its connector check and null the parse.
const GATE_CLAUSE_RE = /\b(reject|accept)\b\s+(.+?)\s+(only\s+if|if)\s+([^.!?\n]+)[.!?]?/gi;
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function nameRegex(agents) {
    const names = [...new Set(agents.map((agent) => agent.name.trim()).filter(Boolean))]
        .sort((a, b) => b.length - a.length)
        .map(escapeRe);
    return names.length > 0 ? new RegExp(`\\b(${names.join('|')})\\b`, 'i') : null;
}
function kindOf(agents, name) {
    const lower = name.trim().toLowerCase();
    return agents.find((agent) => agent.name.trim().toLowerCase() === lower)?.kind;
}
function markerLabel(raw) {
    const value = raw.trim().toLowerCase();
    if (value === 'then')
        return 'then';
    if (value === '→' || value === '->')
        return '→';
    return 'after that';
}
/**
 * Bind one unambiguous gate clause. Generic output words bind to the
 * penultimate producer; a named subject binds to exactly one non-final stage.
 */
function bindPromptPipelineGates(text, stages) {
    if (!GATE_HINT_RE.test(text))
        return stages.map((stage) => ({ ...stage }));
    if ((text.match(/\b(?:reject|accept)\b/gi) ?? []).length !== 1)
        return null;
    const clauses = [...text.matchAll(GATE_CLAUSE_RE)];
    if (clauses.length !== 1 || stages.length < 2)
        return null;
    const [, decision, subject, connector, rawCriterion] = clauses[0];
    if (decision.toLowerCase() === 'accept' && connector.toLowerCase().replace(/\s+/g, ' ') !== 'only if') {
        return null;
    }
    // `qualityGate` is an ACCEPTANCE criterion (checked by the next stage). A
    // reject clause states the failure condition, so it keeps its polarity —
    // storing the bare criterion would invert the user's intent ("reject if
    // tests are missing" must never read as "accept when tests are missing").
    const criterion = (0, orchestrationPolicy_1.sanitizeRoutingText)(decision.toLowerCase() === 'reject' ? `reject if ${rawCriterion}` : rawCriterion, hierarchy_1.HIERARCHY_QUALITY_GATE_MAX_CHARS);
    if (!criterion)
        return null;
    const normalizedSubject = subject.toLowerCase();
    const named = stages
        .slice(0, -1)
        .map((stage, index) => ({ stage, index }))
        .filter(({ stage }) => [stage.name, stage.kind].some((label) => new RegExp(`\\b${escapeRe(label.toLowerCase())}(?:['’]s)?\\b`, 'i').test(normalizedSubject)));
    const generic = /^(?:the\s+)?(?:output|draft|result|work|artifact|input|it)$/i.test(subject.trim());
    let targetIndex;
    if (named.length === 1)
        targetIndex = named[0].index;
    else if (named.length > 1)
        return null;
    else if (generic)
        targetIndex = stages.length - 2;
    else
        return null;
    const result = stages.map((stage) => ({ ...stage }));
    result[targetIndex].qualityGate = criterion;
    return result;
}
/** Conservative, self-first parser for an explicit fixed sequence. */
function parsePromptPipelineDirectives(text, agents, currentAgentKind) {
    if (!text.trim() || (0, hierarchyPromptDirectives_1.parsePromptChainDirectives)(text, agents))
        return null;
    const nameRe = nameRegex(agents);
    if (!nameRe)
        return null;
    const sequenced = text
        .split(SENTENCE_SPLIT_RE)
        .filter((sentence) => new RegExp(SEQUENCE_MARKER_RE.source, 'i').test(sentence));
    if (sequenced.length !== 1)
        return null;
    const chain = sequenced[0];
    const markers = [...chain.matchAll(SEQUENCE_MARKER_RE)];
    const segments = chain.split(SEQUENCE_MARKER_RE);
    if (markers.length === 0 || segments.length < 2)
        return null;
    const named = [];
    const seenKinds = new Set();
    let firstNamed = false;
    for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index].trim().replace(/^[,;:\s]+|[,;:\s]+$/g, '');
        const match = segment.match(nameRe);
        if (!match) {
            if (index === 0)
                continue;
            return null;
        }
        const kind = kindOf(agents, match[1]);
        if (!kind || seenKinds.has(kind))
            return null;
        seenKinds.add(kind);
        if (index === 0)
            firstNamed = true;
        const brief = (0, orchestrationPolicy_1.sanitizeRoutingText)(segment, hierarchy_1.HIERARCHY_BRIEF_MAX_CHARS);
        named.push({ name: match[1], kind, ...(brief ? { brief } : {}) });
    }
    let stages;
    if (currentAgentKind && !firstNamed) {
        if (named.length < 2 || named.some((stage) => stage.kind === currentAgentKind))
            return null;
        const brief = (0, orchestrationPolicy_1.sanitizeRoutingText)(segments[0], hierarchy_1.HIERARCHY_BRIEF_MAX_CHARS);
        stages = [{ name: 'you', kind: currentAgentKind, isSelf: true, ...(brief ? { brief } : {}) }, ...named];
    }
    else {
        if (named.length < 2)
            return null;
        if (currentAgentKind && named[0].kind !== currentAgentKind)
            return null;
        stages = named.map((stage, index) => ({
            ...stage,
            ...(index === 0 && currentAgentKind ? { isSelf: true } : {}),
        }));
    }
    if (stages.length < 2 || stages.length > hierarchy_1.MAX_PIPELINE_STAGES)
        return null;
    const gated = bindPromptPipelineGates(text, stages);
    return gated ? { stages: gated, marker: markerLabel(markers[0][0]) } : null;
}
function pipelineStageIndex(stages, kind) {
    return stages.findIndex((stage) => stage.kind === kind) + 1;
}
function pipelineNextStage(stages, kind) {
    const index = stages.findIndex((stage) => stage.kind === kind);
    return index < 0 ? undefined : stages[index + 1];
}
function pipelinePreviousStage(stages, kind) {
    const index = stages.findIndex((stage) => stage.kind === kind);
    return index <= 0 ? undefined : stages[index - 1];
}
/** Preview the exact mention order a locked Pipeline will resolve at submit.
 * Kept in this lazy module so the eager composer pays only for rendering. */
function orderedExplicitPipelineMentionLabels(text, mentions, terminalTargets, spawnExpansions) {
    return mentions
        .filter((name) => text.includes(name)
        && (Boolean(terminalTargets[name]) || Object.hasOwn(spawnExpansions, name)))
        .sort((a, b) => text.indexOf(a) - text.indexOf(b))
        .filter((name, index, rows) => rows.indexOf(name) === index)
        .map((name) => terminalTargets[name]?.title || name);
}
