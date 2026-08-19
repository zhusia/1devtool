"use strict";
/**
 * Prompt-as-instructor (orchestration v5.1): extract an EXPLICIT chain of
 * command from the user's own prompt text, so a hierarchy works without any
 * configured chart:
 *
 *   "claude request grok and Grok request opencode for sample tasks and then
 *    review back to Grok, do not report to me"
 *
 *   → grok manages opencode, claude manages grok, the chain ends at grok
 *     (its upward report is suppressed).
 *
 * Design constraints, in order:
 * - DETERMINISTIC and conservative. This is the browser-MCP-guard precedent
 *   (a narrow capability regex over the prompt), not semantic inference: only
 *   known agent names joined by an explicit delegation verb count. Anything
 *   ambiguous (two managers for one agent, a cycle) returns null and the
 *   prompt falls back to today's flat behavior — a wrong org is worse than no
 *   org.
 * - Names come from the caller (CLI registry display names + the terminal's
 *   own kind); nothing is hard-coded.
 * - Output is a kind-level DAG the caller turns into a HierarchyChart and an
 *   ephemeral activation; enforcement stays in main (v5 invariant 28).
 *
 * Pure module — imported by the renderer submit path and by main.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROMPT_CHAIN_CHART_ID = void 0;
exports.parsePromptChainDirectives = parsePromptChainDirectives;
exports.directivesEndChainAt = directivesEndChainAt;
/** chartId marking an activation as prompt-derived — a newer prompt chain may
 *  replace it; a user-activated chart activation never carries it. */
exports.PROMPT_CHAIN_CHART_ID = 'prompt-chain';
const DELEGATION_VERB = '(?:requests?|asks?|tells?|uses?|delegates?(?:\\s+to)?|instructs?|directs?|manages?|tasks?|has|have)';
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Longest-first alternation so "Claude Code" wins over "Claude". */
function namePattern(agents) {
    const names = [...new Set(agents.map((a) => a.name.trim()).filter(Boolean))]
        .sort((a, b) => b.length - a.length)
        .map(escapeRe);
    return names.length ? `(${names.join('|')})` : null;
}
function kindOf(agents, name) {
    const lower = name.trim().toLowerCase();
    return agents.find((a) => a.name.trim().toLowerCase() === lower)?.kind;
}
/**
 * Parse chain directives out of a prompt. Returns null when the prompt names
 * no parseable chain OR names one that is ambiguous/cyclic — the caller must
 * treat null as "no hierarchy", never as an error.
 */
function parsePromptChainDirectives(text, agents) {
    const names = namePattern(agents);
    if (!names || !text.trim())
        return null;
    // A manages B: "<A> request(s) <B>", "<A> asks <B>", "<A> delegates to <B>".
    const pairRe = new RegExp(`\\b${names}\\s+(?:should\\s+|must\\s+|will\\s+|then\\s+)?${DELEGATION_VERB}\\s+(?:the\\s+)?${names}\\b`, 'gi');
    const edges = [];
    const seenEdges = new Set();
    for (const match of text.matchAll(pairRe)) {
        const fromKind = kindOf(agents, match[1]);
        const toKind = kindOf(agents, match[2]);
        if (!fromKind || !toKind || fromKind === toKind)
            continue;
        const key = `${fromKind}>${toKind}`;
        if (seenEdges.has(key))
            continue;
        seenEdges.add(key);
        edges.push({ fromKind, toKind });
    }
    if (edges.length === 0)
        return null;
    // One manager per kind, no cycles — refuse to guess (return null) otherwise.
    const managerOf = new Map();
    for (const edge of edges) {
        const existing = managerOf.get(edge.toKind);
        if (existing && existing !== edge.fromKind)
            return null;
        managerOf.set(edge.toKind, edge.fromKind);
    }
    const kinds = [];
    for (const edge of edges) {
        if (!kinds.includes(edge.fromKind))
            kinds.push(edge.fromKind);
        if (!kinds.includes(edge.toKind))
            kinds.push(edge.toKind);
    }
    for (const kind of kinds) {
        // Walk up; revisiting a kind means a cycle.
        const walked = new Set();
        let current = kind;
        while (current !== undefined) {
            if (walked.has(current))
                return null;
            walked.add(current);
            current = managerOf.get(current);
        }
    }
    // "review back to <X>" / "report back to <X>" — the chain ends at X.
    const reportStopRe = new RegExp(`\\b(?:reviews?|reports?)\\s+(?:it\\s+|everything\\s+|results?\\s+)?back\\s+to\\s+(?:the\\s+)?${names}\\b`, 'gi');
    let reportStopKind;
    for (const match of text.matchAll(reportStopRe)) {
        const kind = kindOf(agents, match[1]);
        if (kind && kinds.includes(kind))
            reportStopKind = kind;
    }
    // "do not report (back) (to me)" / "don't report to me" / "no report to me".
    const suppressUserReport = /\b(?:do\s*n[o']t|don't|never|no need to)\s+report(?:\s+(?:back|anything|it|results?))?(?:\s+to\s+me)?\b/i.test(text) ||
        /\bno\s+(?:final\s+)?report(?:s)?(?:\s+(?:back\s+)?to\s+me)?\b/i.test(text);
    return {
        edges,
        kinds,
        ...(reportStopKind ? { reportStopKind } : {}),
        suppressUserReport,
    };
}
/** True when the directives suppress SOMEONE's upward/user report — used to
 *  pick nudge text ("the chain ends at <label>"). */
function directivesEndChainAt(directives) {
    if (directives.reportStopKind)
        return directives.reportStopKind;
    if (!directives.suppressUserReport)
        return undefined;
    // With no explicit stop, "do not report to me" ends the chain at its roots.
    const managed = new Set(directives.edges.map((edge) => edge.toKind));
    return directives.kinds.find((kind) => !managed.has(kind));
}
