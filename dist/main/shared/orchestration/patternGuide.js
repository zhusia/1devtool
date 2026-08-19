"use strict";
/**
 * Pattern Guide content (orchestration v6 §6.6).
 *
 * Users confuse Team with Hierarchy (both "have a boss") and Swarm with Mesh
 * (both "are many agents"). The skill's `## Choosing a pattern` table teaches
 * HOST AGENTS; this module is the same decision, written for the person at
 * the keyboard, and it is rendered in two places: the `?` on Agent Input's
 * mode control and the `?` on the dashboard.
 *
 * v6 invariant 36 — THE GUIDE EXPLAINS, IT NEVER DECIDES. This module exports
 * static data and nothing else: no function here reads a draft, returns a
 * mode, or touches `recommendOrchestrationMode`. Opening the guide has no
 * effect on the effective mode. A unit test pins that.
 *
 * Pure module — renderer-safe, no imports, no state.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PATTERN_SUBSTRATE_NOTE = exports.PATTERN_GUIDE_HEADLINE = exports.PATTERN_GUIDE_FOOTNOTES = exports.TEAM_VS_HIERARCHY = exports.ORCHESTRATION_PATTERNS = void 0;
/** The five patterns, in the order the guide shows them. */
exports.ORCHESTRATION_PATTERNS = [
    {
        id: 'team',
        name: 'Team',
        verb: 'fans out',
        mark: 'fan',
        shape: 'Host plus independent workers; the host merges the answers.',
        pickWhen: 'Independent subtasks, and the agent you are talking to integrates them.',
        runs: ['headless', 'live'],
        composerMode: 'team',
    },
    {
        id: 'swarm',
        name: 'Swarm',
        verb: 'explores in parallel',
        mark: 'scatter',
        shape: 'N workers, one shared brief, no cross-talk.',
        pickWhen: 'Same brief, unknown search space, three or more workers.',
        runs: ['headless', 'live'],
        composerMode: 'swarm',
    },
    {
        id: 'pipeline',
        name: 'Pipeline',
        verb: 'passes forward',
        mark: 'chain',
        shape: 'Ordered stages; each output is the next input, with quality gates.',
        pickWhen: 'A fixed sequence where every stage needs the stage before it.',
        runs: ['live'],
        composerMode: 'pipeline',
    },
    {
        id: 'mesh',
        name: 'Mesh',
        verb: 'negotiates',
        mark: 'ring',
        shape: 'Linked peers messaging and voting on one artifact.',
        pickWhen: 'Three to eight peers iterating, or you @mentioned live terminals.',
        runs: ['live'],
    },
    {
        id: 'hierarchy',
        name: 'Hierarchy',
        verb: 'reports up',
        mark: 'tree',
        shape: 'Multi-level org; managers summarize upward.',
        pickWhen: 'A ranked org with middle managers and a structure worth keeping.',
        runs: ['live'],
    },
];
/** The most-confused pair. Both "have a boss"; almost nothing else matches. */
exports.TEAM_VS_HIERARCHY = [
    {
        axis: 'Depth',
        team: 'One level: host plus workers',
        hierarchy: 'Up to 12 nodes, with middle managers',
    },
    {
        axis: 'Who is in charge',
        team: 'The terminal you typed in',
        hierarchy: 'Whoever the chart says — you may be a leaf',
    },
    {
        axis: 'Authoring',
        team: 'Ephemeral, built from the prompt at submit',
        hierarchy: 'Durable org chart: Apply, then Activate',
    },
    {
        axis: 'Integration',
        team: 'Workers report to the host; the host merges',
        hierarchy: 'Managers summarize upward; only the root reports to you',
    },
    {
        axis: 'Enforcement',
        team: 'Social — the manifest text asks',
        hierarchy: 'Structural — lateral and skip sends are refused',
    },
    {
        axis: 'Lifetime',
        team: 'One turn',
        hierarchy: 'Until you deactivate; seats and journals persist',
    },
    {
        axis: 'Decides by',
        team: 'The host',
        hierarchy: 'Escalation up the chain — never a quorum',
    },
];
/** Ships verbatim under the tables. */
exports.PATTERN_GUIDE_FOOTNOTES = [
    'A 2-level org chart is structurally a Team — Hierarchy earns its overhead at depth 3 or more, or when you want the chain enforced.',
    '"A requests B" in the composer activates a lightweight prompt-chain hierarchy without the dashboard; "then" means Pipeline instead.',
    'Team fans out · Pipeline passes forward · Hierarchy reports up.',
];
/** The line the guide opens with. */
exports.PATTERN_GUIDE_HEADLINE = 'Five ways to put more than one agent on a problem.';
/** Headless and Live are a separate axis from the pattern — the one place we
 *  say so, because the composer shows the Swarm substrate toggle right next
 *  to the pattern control and the two read as one setting otherwise. */
exports.PATTERN_SUBSTRATE_NOTE = 'Headless and Live is a separate choice from the pattern: headless workers are disposable and scale, live workers are visible terminals you can watch and approve in.';
