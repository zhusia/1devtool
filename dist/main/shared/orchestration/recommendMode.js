"use strict";
/**
 * Auto mode recommender (orchestration v6 D5 / §6.1).
 *
 * One pure function over the text the USER TYPED in the composer. It reads
 * the live draft and names the pattern the prompt describes so Agent Input's
 * Auto segment can apply it.
 *
 * Hard rules this module exists to keep:
 * - It is not a second model. Deterministic parsers only, the same ones v5.1
 *   and v6 already ship. No LLM call, no heuristic vibes.
 * - It runs on composer text, never on PTY bytes. Phrase-matching terminal
 *   output stays forbidden (terminal index rule); the user's own sentence is
 *   fair game because they typed it.
 * - Ambiguity does not flip anything: unclear prompts return `team` at LOW
 *   confidence, and Agent Input leaves the effective mode on Team.
 * - It never returns `off`. Auto is a recommendation to delegate, never a
 *   decision to stop delegating (v6 invariant 35).
 *
 * Pure module — renderer-safe, unit-tested against the v6 §10 table.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RECOMMEND_REASON_MAX_CHARS = void 0;
exports.recommendOrchestrationMode = recommendOrchestrationMode;
const hierarchyPromptDirectives_1 = require("./hierarchyPromptDirectives");
const pipelinePrompt_1 = require("./pipelinePrompt");
/** Reason strings are pinned by tests — they are UI copy, not debug output. */
exports.RECOMMEND_REASON_MAX_CHARS = 60;
/** "in parallel", "fan out" / "fan this out", "swarm", "8 workers",
 *  "at the same time". */
const PARALLEL_RE = /\bparallel\b|\bfan(?:[\s-]+(?:\w+[\s-]+){0,3})?out\b|\bswarms?\b|\bconcurrently\b|\bsimultaneously\b|\bat\s+the\s+same\s+time\b|\b\d+\s+(?:workers?|agents?|instances?|copies)\b/i;
/** A bare sequence marker — enough to call a prompt ambiguous next to "parallel". */
const SEQUENCE_HINT_RE = /\bthen\b|\bafter\s+that\b|→|->/i;
/** "agents", "workers" — a plural crowd counts even with no agent named. */
const CROWD_RE = /\bagents\b|\bworkers\b|\bmodels\b/i;
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Distinct agent KINDS the prompt names, longest name first so "Claude Code"
 *  is not counted twice as "Claude". */
function namedKinds(text, agents) {
    const sorted = [...agents]
        .filter((agent) => agent.name.trim())
        .sort((a, b) => b.name.length - a.name.length);
    const kinds = [];
    let remaining = text;
    for (const agent of sorted) {
        const re = new RegExp(`\\b${escapeRe(agent.name.trim())}\\b`, 'i');
        if (!re.test(remaining))
            continue;
        remaining = remaining.replace(new RegExp(`\\b${escapeRe(agent.name.trim())}\\b`, 'gi'), ' ');
        if (!kinds.includes(agent.kind))
            kinds.push(agent.kind);
    }
    return kinds;
}
/**
 * Recommend one pattern for this draft. First matching rule wins; the
 * ambiguity rule is checked FIRST so a prompt that says both "then" and
 * "in parallel" cannot be claimed by either specialist parser (v6 §6.1
 * priority 6, and the V6-0 gate `then` + `in parallel` → team/low).
 */
function recommendOrchestrationMode(input) {
    const text = input.text ?? '';
    const agents = input.agents ?? [];
    const terminalMentions = input.terminalMentions ?? 0;
    const kinds = namedKinds(text, agents);
    // 0 — ambiguous: a sequence AND parallel language in one prompt. Do not
    // guess which half they meant; Team is the safe read and the banner asks.
    if (SEQUENCE_HINT_RE.test(text) && PARALLEL_RE.test(text)) {
        return { mode: 'team', confidence: 'low', reason: 'sequence and parallel — pick one' };
    }
    // 1 — an explicit stage sequence over known agents, headed by this terminal.
    const pipeline = (0, pipelinePrompt_1.parsePromptPipelineDirectives)(text, agents, input.currentAgentKind);
    if (pipeline) {
        return {
            mode: 'pipeline',
            confidence: 'high',
            reason: pipeline.marker === '→' ? 'you wrote "→"' : `you wrote "${pipeline.marker}"`,
        };
    }
    // 1b — a sequence we cannot own: the user wrote an ordered chain that does
    // not start here (or repeats an agent). Team is the safe read, but say so
    // at LOW confidence instead of pretending the order was never written.
    if (SEQUENCE_HINT_RE.test(text)
        && kinds.length >= 2
        && !(0, hierarchyPromptDirectives_1.parsePromptChainDirectives)(text, agents)) {
        return { mode: 'team', confidence: 'low', reason: 'that sequence does not start here' };
    }
    // 2 — parallel language with something to parallelize.
    if (PARALLEL_RE.test(text) && (kinds.length > 0 || CROWD_RE.test(text))) {
        return { mode: 'swarm', confidence: 'high', reason: 'you asked to fan out' };
    }
    // 3 / 4 — named collaborators, no order and no fan-out: the host integrates.
    if (kinds.length >= 2) {
        return { mode: 'team', confidence: 'high', reason: `${kinds.length} agents, no order given` };
    }
    if (kinds.length === 1) {
        return { mode: 'team', confidence: 'high', reason: 'one agent — you integrate' };
    }
    // 5 — live terminals only: delivery rides the existing links either way.
    if (terminalMentions > 0) {
        return { mode: 'team', confidence: 'low', reason: 'linked terminals — links still mint' };
    }
    // 7 — nothing to go on. Do not flip.
    return { mode: 'team', confidence: 'low', reason: 'no agents named' };
}
