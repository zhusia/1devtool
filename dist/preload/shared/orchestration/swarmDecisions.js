"use strict";
/**
 * Leaderless swarm decisions (orchestration v4 — broadcast + quorum voting).
 *
 * A decision has NO owner with special power. Any linked terminal may open
 * one, every eligible terminal gets exactly one vote (the opener included),
 * and the outcome is decided by counting — not by whoever asked. The opener's
 * only privilege is provenance in the record.
 *
 * This module is deliberately React-free and side-effect-free so the counting
 * rules — the part that decides whether work is accepted — are unit-tested
 * without a registry, a PTY, or a clock.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DECISION_OPTION_MAX_CHARS = exports.DECISION_MAX_OPTIONS = exports.DECISION_QUESTION_MAX_CHARS = exports.DEFAULT_DECISION_OPTIONS = void 0;
exports.defaultQuorum = defaultQuorum;
exports.tallyVotes = tallyVotes;
exports.resolveOutcome = resolveOutcome;
exports.isDeadlocked = isDeadlocked;
exports.validateDecisionInput = validateDecisionInput;
exports.DEFAULT_DECISION_OPTIONS = ['approve', 'reject'];
exports.DECISION_QUESTION_MAX_CHARS = 500;
exports.DECISION_MAX_OPTIONS = 8;
exports.DECISION_OPTION_MAX_CHARS = 40;
/**
 * Strict majority of everyone entitled to vote. Chosen over "first past the
 * post" because a leaderless group with 3 peers and 2 options must not be
 * decided by a single early voter, and over unanimity because one dead peer
 * would deadlock every decision forever.
 */
function defaultQuorum(eligibleCount) {
    return Math.floor(Math.max(1, eligibleCount) / 2) + 1;
}
/** Votes per option, counting one vote per terminal (latest wins). */
function tallyVotes(decision) {
    const latestByTerminal = new Map();
    for (const vote of decision.votes) {
        const previous = latestByTerminal.get(vote.terminalId);
        if (!previous || vote.at >= previous.at)
            latestByTerminal.set(vote.terminalId, vote);
    }
    const tally = {};
    for (const option of decision.options)
        tally[option] = 0;
    for (const vote of latestByTerminal.values()) {
        if (vote.value in tally)
            tally[vote.value] += 1;
    }
    return tally;
}
/**
 * The winning option, or null while the decision is genuinely undecided.
 *
 * Ties never resolve: with 1-vs-1 and a quorum of 2 nothing wins, which is
 * correct — a leaderless group has no casting vote to break it. The decision
 * stays open until another peer votes or a human cancels it.
 */
function resolveOutcome(decision) {
    const tally = tallyVotes(decision);
    const reached = decision.options.filter((option) => tally[option] >= decision.quorum);
    if (reached.length !== 1)
        return null;
    return reached[0];
}
/**
 * Can this decision still change? Once every eligible terminal has voted and
 * no option reached quorum, it is deadlocked — reported honestly rather than
 * left looking live.
 */
function isDeadlocked(decision) {
    if (resolveOutcome(decision) !== null)
        return false;
    const voted = new Set(decision.votes.map((vote) => vote.terminalId));
    const remaining = decision.eligibleTerminalIds.filter((id) => !voted.has(id)).length;
    if (remaining > 0)
        return false;
    const tally = tallyVotes(decision);
    return !decision.options.some((option) => tally[option] + remaining >= decision.quorum);
}
/** Shape check for an opening request; returns null when the input is usable. */
function validateDecisionInput(input) {
    const question = input.question.trim();
    if (!question)
        return { error: 'invalid-request', detail: 'a decision needs a question' };
    if (question.length > exports.DECISION_QUESTION_MAX_CHARS) {
        return { error: 'invalid-request', detail: `question exceeds ${exports.DECISION_QUESTION_MAX_CHARS} characters` };
    }
    const options = input.options ?? [...exports.DEFAULT_DECISION_OPTIONS];
    if (options.length < 2)
        return { error: 'invalid-request', detail: 'a decision needs at least two options' };
    if (options.length > exports.DECISION_MAX_OPTIONS) {
        return { error: 'invalid-request', detail: `at most ${exports.DECISION_MAX_OPTIONS} options` };
    }
    if (new Set(options).size !== options.length) {
        return { error: 'invalid-request', detail: 'options must be unique' };
    }
    if (options.some((option) => !option.trim() || option.length > exports.DECISION_OPTION_MAX_CHARS)) {
        return { error: 'invalid-request', detail: 'options must be non-empty and short' };
    }
    if (input.eligibleCount < 2) {
        return { error: 'invalid-request', detail: 'a decision needs at least two linked peers' };
    }
    if (input.quorum !== undefined) {
        if (!Number.isInteger(input.quorum) || input.quorum < 1) {
            return { error: 'invalid-request', detail: 'quorum must be a positive integer' };
        }
        // A quorum nobody can reach is a decision that can never resolve.
        if (input.quorum > input.eligibleCount) {
            return { error: 'invalid-request', detail: `quorum ${input.quorum} exceeds ${input.eligibleCount} eligible voters` };
        }
    }
    return null;
}
