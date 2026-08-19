"use strict";
/**
 * Link-time contract injection (orchestration v4 — L2).
 *
 * When a TerminalLink is created (or revived from quarantine), main types one
 * short app-authored notice into each endpoint through the normal staged
 * write path. The nudge IS the communication contract for the happy path —
 * absolute shim path inline, "no action needed now" etiquette — so the
 * orchestrator skill stays a fallback reference and no skill load happens at
 * link time. Size is capped by construction: composers throw in dev if a
 * nudge exceeds LINK_NUDGE_MAX_BYTES rather than silently bloating every
 * linked composer.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HIERARCHY_ROLE_NUDGE_MAX_BYTES = exports.DECISION_ENVELOPE_MAX_BYTES = exports.LINK_MESSAGE_ENVELOPE_MAX_BYTES = exports.LINK_NUDGE_MAX_BYTES = void 0;
exports.composeOutboundLinkNudge = composeOutboundLinkNudge;
exports.composeInboundLinkNudge = composeInboundLinkNudge;
exports.linkMessageCorrelationMarker = linkMessageCorrelationMarker;
exports.composeDecisionPrompt = composeDecisionPrompt;
exports.composeDecisionOutcomePrompt = composeDecisionOutcomePrompt;
exports.composeLinkMessagePrompt = composeLinkMessagePrompt;
exports.composeReplyPathRestoredNudge = composeReplyPathRestoredNudge;
exports.composeRestartDelegationNudge = composeRestartDelegationNudge;
exports.composeReplyReminderNudge = composeReplyReminderNudge;
exports.composeResumeOrchestrationNudge = composeResumeOrchestrationNudge;
exports.composeHierarchyRoleLine = composeHierarchyRoleLine;
exports.composePipelineRoleLine = composePipelineRoleLine;
exports.composePipelineRoleNudge = composePipelineRoleNudge;
exports.composeHierarchyRoleNudge = composeHierarchyRoleNudge;
exports.composeMutualLinkNudge = composeMutualLinkNudge;
const orchestrationCommand_1 = require("../../shared/orchestrationCommand");
exports.LINK_NUDGE_MAX_BYTES = 1200;
function assertBounded(text, maxBytes = exports.LINK_NUDGE_MAX_BYTES, label = 'link nudge') {
    if (Buffer.byteLength(text, 'utf-8') > maxBytes) {
        throw new Error(`${label} exceeds ${maxBytes} bytes — shorten the template, never raise the cap silently`);
    }
    return text;
}
/** Notice typed into the SENDING endpoint (link.from). */
function composeOutboundLinkNudge({ link, toTitle, shimPath }) {
    const perms = link.permissions.join('/');
    const readPermissions = link.permissions.filter((permission) => permission.startsWith('read-'));
    const sendCommand = (0, orchestrationCommand_1.indentOrchestrationSnippet)((0, orchestrationCommand_1.buildLinkSendCommandSnippet)(shimPath, link.to.terminalId), 2);
    return assertBounded(`[1devtool] Linked to "${toTitle}" (${link.to.effectiveAgentKind}, terminal ${link.to.terminalId}, ` +
        `direction: you → it, permissions: ${perms}). ` +
        `To message it when the task calls for it:\n${sendCommand}\n` +
        `--wait prints the target-acceptance delivery receipt; 'link status --message=<id>' polls later; '${shimPath}' whoami lists your links. ` +
        (readPermissions.length > 0
            ? `Pull only when needed: '${shimPath}' link peers --json, then ` +
                `'${shimPath}' link read --from=${link.to.terminalId} --lines=40 (other read verbs require their named grant). `
            : '') +
        `Never \`run --to=${link.to.effectiveAgentKind}\` for this — that spawns a separate headless agent instead of this linked terminal. ` +
        `No action needed now — acknowledge briefly and do not run these commands yet.`);
}
/** Notice typed into the RECEIVING endpoint (link.to). */
function composeInboundLinkNudge({ link, fromTitle, shimPath }) {
    const readPermissions = link.permissions.filter((permission) => permission.startsWith('read-'));
    return assertBounded(`[1devtool] "${fromTitle}" (${link.from.effectiveAgentKind}, terminal ${link.from.terminalId}) is now linked to you ` +
        `and may send you prompts; they arrive as normal messages. ` +
        (readPermissions.length > 0
            ? `The user also granted it ${readPermissions.join('/')}; pull reads are bounded and do not touch your composer. `
            : '') +
        `'${shimPath}' whoami lists your links. No action needed now — acknowledge briefly.`);
}
/** Envelope budget for a delivered link message — the BODY is never counted. */
exports.LINK_MESSAGE_ENVELOPE_MAX_BYTES = 900;
/** Decision envelopes carry the question + options, so they get their own cap. */
exports.DECISION_ENVELOPE_MAX_BYTES = 2_000;
/** Unique, non-secret target-side acceptance marker for one durable message. */
function linkMessageCorrelationMarker(messageId) {
    return `[1devtool-message:${messageId}]`;
}
/**
 * Envelope for a broadcast that opens a decision (leaderless swarm).
 *
 * Same rule as every other injected text: the command the peer needs is IN
 * the message. It also states the power model explicitly — one vote each, the
 * opener's vote counts the same — because an agent that assumes the asker
 * decides will defer instead of voting.
 */
function composeDecisionPrompt(input) {
    const header = `[1devtool] Decision ${input.decisionId} opened by "${input.openedByTitle}" ` +
        `(${input.openedByAgentKind}, terminal ${input.openedByTerminalId}).\n` +
        `Question: ${input.question}\n` +
        `Options: ${input.options.join(' | ')}\n` +
        `Voters: ${input.eligibleCount} · ${input.quorum} votes decide it.`;
    const footer = input.shimPath
        ? `[1devtool] Every voter has ONE vote and there is no master — the opener's vote counts the ` +
            `same as yours, so decide for yourself rather than deferring to them:\n` +
            (0, orchestrationCommand_1.indentOrchestrationSnippet)(`${quoteForShim(input.shimPath)} link vote --on=${input.decisionId} --value=<${input.options.join('|')}> --reason="why"`, 2) +
            `\nThe outcome is broadcast to everyone automatically once ${input.quorum} votes agree. ` +
            `A tie stays open — nothing is decided until it breaks.`
        : `[1devtool] Voting is unavailable (no CLI path resolved); reply in prose and a human will relay.`;
    return assertBounded(`${header}\n\n${input.body}\n\n${footer}`, exports.DECISION_ENVELOPE_MAX_BYTES, 'decision');
}
/** Outcome (or honest deadlock) broadcast to every eligible voter. */
function composeDecisionOutcomePrompt(input) {
    const tallyText = Object.entries(input.tally)
        .map(([option, count]) => `${option} ${count}`)
        .join(', ');
    const voteText = input.votes.map((entry) => `${entry.name}=${entry.value}`).join(', ');
    const headline = input.outcome
        ? `resolved: ${input.outcome} (${input.quorum} needed).`
        : input.deadlocked
            ? `is DEADLOCKED — everyone voted and no option reached ${input.quorum}. Nothing is decided.`
            : `updated; still open.`;
    return assertBounded(`[1devtool] Decision ${input.decisionId} ${headline}\n` +
        `Question: ${input.question}\n` +
        `Tally: ${tallyText}${voteText ? `\nVotes: ${voteText}` : ''}` +
        (input.outcome
            ? `\nThis is the group's decision — act on it; do not re-litigate it without opening a new decision.`
            : input.deadlocked
                ? `\nDo not act unilaterally. Open a new decision with different options, or ask the user.`
                : ''), exports.DECISION_ENVELOPE_MAX_BYTES, 'decision outcome');
}
/** POSIX-quoted for the shell the snippet runs in; Windows shims quote later. */
function quoteForShim(shimPath) {
    return `'${shimPath.replace(/'/g, `'\\''`)}'`;
}
/**
 * Envelope wrapped around a message delivered over a link.
 *
 * The prefix used to be `[link message from "<name>"]` — a display name and
 * nothing else. A peer that finished the work then had no way to return it:
 * no sender terminal id, no command, and no statement that answering in its
 * own terminal reaches nobody. Observed live with three linked terminals: two
 * reviewers produced full reviews, both printed them locally believing that
 * was delivery, and the sender waited on a poll loop that could never resolve.
 *
 * So the envelope now carries provenance AND the exact return path — or an
 * honest statement that there is no return path, which is equally important:
 * without it an agent invents a command that does not work.
 */
function composeLinkMessagePrompt(input) {
    const correlationMarker = linkMessageCorrelationMarker(input.messageId);
    const header = `[1devtool] Message over a terminal link from "${input.fromTitle}" ` +
        `(${input.fromAgentKind}, terminal ${input.fromTerminalId}).`;
    const gateFooter = input.pipeline
        && (input.pipeline.kind === 'handoff' || input.pipeline.kind === 'rework')
        && input.canReply && input.shimPath
        ? `[1devtool] This is Pipeline input. Check it, then reply to this exact message with one structured decision:\n` +
            (0, orchestrationCommand_1.indentOrchestrationSnippet)((0, orchestrationCommand_1.buildLinkSendCommandSnippet)(input.shimPath, input.fromTerminalId, '$REPLY', {
                replyToMessageId: input.messageId,
                ...(input.replyToken ? { replyToken: input.replyToken } : {}),
                gateDecision: 'accept',
                ...((0, orchestrationCommand_1.agentToolShellPrefersPosix)(input.toAgentKind) ? { posixShell: true } : {}),
            }), 2) + `\nOr replace --gate=accept with --gate=reject and explain the required correction.`
        : null;
    const footer = input.expectsReply === false
        ? '[1devtool] Pipeline gate accepted. This acknowledgement creates no reply duty; do not answer it.'
        : gateFooter ?? (input.canReply && input.shimPath
            ? `[1devtool] Your answer does NOT reach them by printing it here — send it back over your link:\n` +
                (0, orchestrationCommand_1.indentOrchestrationSnippet)((0, orchestrationCommand_1.buildLinkSendCommandSnippet)(input.shimPath, input.fromTerminalId, '$REPLY', {
                    replyToMessageId: input.messageId,
                    ...(input.replyToken ? { replyToken: input.replyToken } : {}),
                    ...((0, orchestrationCommand_1.agentToolShellPrefersPosix)(input.toAgentKind) ? { posixShell: true } : {}),
                }), 2) + `\nDo that once you have the answer; there is no other channel back to them.`
            : `[1devtool] You have no link back to "${input.fromTitle}", so your answer stays in this ` +
                `terminal for the user to relay. Do not invent a send command.`);
    assertEnvelopeBounded(`${header}\n\n\n\n${footer}\n${correlationMarker}`);
    // Keep the correlation marker last. Native textarea redraws commonly show
    // only the tail of a long paste; the retained screen observer can therefore
    // prove this exact draft appeared before the composer cleared.
    return `${header}\n\n${input.body}\n\n${footer}\n${correlationMarker}`;
}
function assertEnvelopeBounded(envelope) {
    if (Buffer.byteLength(envelope, 'utf-8') > exports.LINK_MESSAGE_ENVELOPE_MAX_BYTES) {
        throw new Error(`link message envelope exceeds ${exports.LINK_MESSAGE_ENVELOPE_MAX_BYTES} bytes — shorten the template, never raise the cap silently`);
    }
}
/**
 * Notice typed into a peer whose reply path was restored AFTER it already
 * received a message that told it there was none.
 *
 * A delivered envelope is a snapshot: a peer told "you have no link back … do
 * not invent a send command" will hold a finished answer forever, because the
 * statement was true when it read it and nothing ever contradicts it. Creating
 * the missing edge silently is therefore not a repair — the peer must be told
 * the fact changed, and handed the exact command, or the work stays stranded
 * in its scrollback (docs/common-errors/orchestration/link-reply-never-returns.md).
 */
function composeReplyPathRestoredNudge(input) {
    const replyCommand = (0, orchestrationCommand_1.indentOrchestrationSnippet)((0, orchestrationCommand_1.buildLinkSendCommandSnippet)(input.shimPath, input.hostTerminalId, '$REPLY', {
        replyToMessageId: input.messageId,
        ...(input.replyToken ? { replyToken: input.replyToken } : {}),
        ...((0, orchestrationCommand_1.agentToolShellPrefersPosix)(input.recipientAgentKind) ? { posixShell: true } : {}),
    }), 2);
    return assertBounded(`[1devtool] You now have a link back to "${input.hostTitle}" (terminal ${input.hostTerminalId}). ` +
        `An earlier message told you there was no way to answer — that is no longer true. ` +
        `Send the answer you already produced for it:\n${replyCommand}\n` +
        `Do not redo the work and do not re-read the task — send what is already in this conversation. ` +
        `If you have not finished yet, send it when you are done.`);
}
/**
 * Typed into a peer whose stuck delegation is being RE-STARTED after its
 * session no longer holds the original task (terminal relaunched, session
 * replaced, `/clear`). {@link composeReplyPathRestoredNudge} says "send what
 * is already in this conversation" — for this peer nothing is; the honest
 * unblock must re-state the task itself, then ask for the answer over the
 * freshly minted reply edge. The brief can be a full prompt body, so this
 * nudge gets the role-card byte budget, with the brief bounded first.
 */
const RESTART_BRIEF_MAX_BYTES = 700;
/** Byte-bounded head of a possibly multi-byte brief — never splits a code point. */
function truncateBriefBytes(brief, maxBytes) {
    if (Buffer.byteLength(brief, 'utf-8') <= maxBytes)
        return { text: brief, truncated: false };
    let text = brief;
    while (text.length > 0 && Buffer.byteLength(text, 'utf-8') > maxBytes) {
        text = text.slice(0, Math.max(0, Math.floor(text.length * 0.9) - 1));
    }
    return { text, truncated: true };
}
function composeRestartDelegationNudge(input) {
    const replyCommand = (0, orchestrationCommand_1.indentOrchestrationSnippet)((0, orchestrationCommand_1.buildLinkSendCommandSnippet)(input.shimPath, input.hostTerminalId, '$REPLY', {
        replyToMessageId: input.messageId,
        ...(input.replyToken ? { replyToken: input.replyToken } : {}),
        ...((0, orchestrationCommand_1.agentToolShellPrefersPosix)(input.recipientAgentKind) ? { posixShell: true } : {}),
    }), 2);
    const bounded = truncateBriefBytes(input.brief, RESTART_BRIEF_MAX_BYTES);
    const brief = bounded.truncated
        ? `${bounded.text}… [truncated — ask the sender if you need the rest]`
        : bounded.text;
    return assertBounded(`[1devtool] Re-start: "${input.hostTitle}" (terminal ${input.hostTerminalId}) is still waiting on a ` +
        `delegation delivered before this session started, so it is not in your context. The task was:\n` +
        `  ${brief}\n` +
        `Do the work now (reuse anything you already produced), then send the result back with:\n${replyCommand}`, exports.HIERARCHY_ROLE_NUDGE_MAX_BYTES, 'restart delegation nudge');
}
/**
 * Human-initiated reminder into a peer that OWES a reply it can send.
 *
 * The stranded case (no edge back) is repaired by
 * {@link composeReplyPathRestoredNudge}; this is the other block observed in
 * the field: the reply edge exists, the peer finished the work — full verdict
 * sitting in its scrollback — and it simply never ran `link send`, so the
 * delegating terminal polls forever. The user clicking "Nudge" in Mission
 * Control is one re-prompt; main's bounded stall sweep
 * (LinkRegistry.runAutoNudgeSweep, `auto: true`) is the other — added after
 * every observed run eventually needed a manual "Restore link context" click
 * whose only mid-run effect was exactly this reminder.
 */
function composeReplyReminderNudge(input) {
    const replyCommand = (0, orchestrationCommand_1.indentOrchestrationSnippet)((0, orchestrationCommand_1.buildLinkSendCommandSnippet)(input.shimPath, input.hostTerminalId, '$REPLY', {
        replyToMessageId: input.messageId,
        ...(input.replyToken ? { replyToken: input.replyToken } : {}),
        ...((0, orchestrationCommand_1.agentToolShellPrefersPosix)(input.recipientAgentKind) ? { posixShell: true } : {}),
    }), 2);
    const opener = input.auto
        ? `[1devtool] Reminder: message ${input.messageId} from "${input.hostTitle}" `
        : `[1devtool] The user asked me to check on message ${input.messageId} from "${input.hostTitle}" `;
    return assertBounded(opener +
        `(terminal ${input.hostTerminalId}) — it is still waiting on your answer. ` +
        `If the work is done, send the result you already have now:\n${replyCommand}\n` +
        `Do not redo the work — send what is already in this conversation. ` +
        `If you are still working, continue and send it the moment you finish.` +
        (input.roleLine ? `\n${input.roleLine}` : ''));
}
/**
 * Typed into a DELEGATING terminal after the user resumed an interrupted
 * orchestration (Mission Control "Resume team").
 *
 * Every restart quarantines the links, and a host that was mid-poll when the
 * app closed wakes up with a dead board and no signal that the channels came
 * back. Silent repair is not repair (same rule as the reply-path restore): the
 * host must be handed the new fact — links are live again — plus the one
 * command that shows where its delegations stand, or it keeps waiting on
 * state from before the interruption.
 */
function composeResumeOrchestrationNudge(input) {
    const statusCommand = (0, orchestrationCommand_1.indentOrchestrationSnippet)(`'${input.shimPath.replace(/'/g, `'\\''`)}' link status`, 2);
    const awaiting = input.awaitingCount > 0
        ? `You are still waiting on ${input.awaitingCount} unanswered delegation(s); their peers were just reminded to reply. `
        : '';
    return assertBounded(`[1devtool] The user resumed this orchestration — your terminal links were restored after an ` +
        `interruption and messages flow again. ${awaiting}` +
        `Check where everything stands:\n${statusCommand}\n` +
        `Then continue the task. Re-send only a delegation the board shows as failed or missing; ` +
        `answers to delivered ones will arrive here as normal messages — do not poll.` +
        (input.roleLine ? `\n${input.roleLine}` : ''));
}
/** One-line seat summary for hierarchy-aware repair nudges (§7.2). */
function composeHierarchyRoleLine(input) {
    const reportLine = input.reportsTo
        ? `report to ${input.reportsTo.label} (${input.reportsTo.terminalId})`
        : 'you report to the user';
    return `Your hierarchy seat is unchanged: you are ${input.nodeLabel} — ${input.role}; ${reportLine}.`;
}
function composePipelineRoleLine(input) {
    return `Your pipeline seat is unchanged: you are ${input.nodeLabel} — stage ${input.stageIndex}/${input.stageCount}; ` +
        (input.next ? `next is ${input.next.label} (${input.next.terminalId}).` : 'you are the final stage.');
}
/**
 * Role card typed into each seat at hierarchy activation (v5 §5.3): one
 * notice per SEAT, never per edge — the resume-orchestration storm rule.
 * The nudge is the whole happy-path contract: who this seat is, who it may
 * task, where it reports, and the exact commands, so the chart never has to
 * enter any prompt. Rosters are capped so a max-fanout node cannot push the
 * composed text past its byte budget (no silent truncation — the remainder
 * is named and discoverable via whoami).
 */
exports.HIERARCHY_ROLE_NUDGE_MAX_BYTES = 2_000;
const ROLE_NUDGE_MAX_ROSTER_ENTRIES = 6;
function composePipelineRoleNudge(input) {
    const posix = (0, orchestrationCommand_1.agentToolShellPrefersPosix)(input.recipientAgentKind);
    const lines = [
        `[1devtool] You are ${input.nodeLabel} — stage ${input.stageIndex}/${input.stageCount} in this project's Pipeline.`,
    ];
    if (input.brief)
        lines.push(`Your stage: ${input.brief}`);
    if (input.previous) {
        lines.push(`Previous stage: ${input.previous.label} (${input.previous.terminalId}).`);
        lines.push(`Gate its input: ${input.incomingQualityGate || 'input is complete and usable for this stage'}.`);
        lines.push('Reply to the exact handoff/rework with `link send --gate=accept` or `--gate=reject`; ' +
            `rejects are capped at ${input.maxGateRounds}. Keep the accepted input message id.`);
    }
    if (input.next) {
        lines.push(`Next stage: ${input.next.label} (${input.next.terminalId}).`);
        if (input.outgoingQualityGate)
            lines.push(`They check: ${input.outgoingQualityGate}.`);
        const report = (0, orchestrationCommand_1.buildReportCommandSnippet)(input.shimPath, {
            ...(input.stageIndex > 1 ? { continueFromMessageId: '<accepted-input-message-id>' } : {}),
            ...(posix ? { posixShell: true } : {}),
        });
        lines.push(`Hand off only with report/handoff — never raw link send or a skipped stage:\n${(0, orchestrationCommand_1.indentOrchestrationSnippet)(report, 2)}`);
    }
    else {
        lines.push('After accepting the input, produce the user-facing result in this terminal, then close the run with `report --complete`.');
    }
    if (input.stageIndex === 1) {
        lines.push('You start the run. If rejected, return corrected work by replying to that exact rejection; do not open another report.');
    }
    else {
        lines.push('If your output is rejected, return corrected work as a reply to that exact rejection.');
    }
    lines.push('Pipeline traffic is adjacent and typed; backward tasks, broadcasts, raw handoffs, and outside sends are refused. No action needed now — acknowledge briefly.');
    return assertBounded(lines.join('\n'), exports.HIERARCHY_ROLE_NUDGE_MAX_BYTES, 'pipeline role nudge');
}
function rosterText(seats) {
    const shown = seats.slice(0, ROLE_NUDGE_MAX_ROSTER_ENTRIES);
    const rest = seats.length - shown.length;
    const list = shown.map((seat) => `${seat.label} (${seat.terminalId})`).join(', ');
    return rest > 0 ? `${list}, +${rest} more (run whoami for the full list)` : list;
}
function composeHierarchyRoleNudge(input) {
    const posix = (0, orchestrationCommand_1.agentToolShellPrefersPosix)(input.recipientAgentKind);
    const lines = [];
    lines.push(`[1devtool] You are ${input.nodeLabel} — ${input.role} in this project's agent hierarchy.`);
    if (input.brief)
        lines.push(`Your charge: ${input.brief}`);
    if (input.reportsTo) {
        lines.push(`Your manager: ${input.reportsTo.label} (${input.reportsTo.terminalId}).`);
    }
    if (input.role === 'worker' && input.takesTasksFrom.length > 0) {
        lines.push(`You take tasks from: ${rosterText(input.takesTasksFrom)}.`);
    }
    if (input.manages.length > 0) {
        lines.push(`You manage: ${rosterText(input.manages)}.`);
    }
    if (input.skipLevelTargets.length > 0) {
        lines.push(`You may also task directly (skip-level): ${rosterText(input.skipLevelTargets)}.`);
    }
    if (input.manages.length > 0 || input.skipLevelTargets.length > 0) {
        const sendSnippet = (0, orchestrationCommand_1.buildLinkSendCommandSnippet)(input.shimPath, '<terminal-id>', '$MSG', {
            ...(posix ? { posixShell: true } : {}),
        });
        lines.push(`Task them:\n${(0, orchestrationCommand_1.indentOrchestrationSnippet)(sendSnippet, 2)}`);
    }
    if (input.manages.length > 0) {
        // Two field failures these lines exist for. A director wrote "do not
        // delegate" into a manager's brief — without knowing the manager had a
        // seat under it — and the whole subtree idled (the manager line defuses
        // that). Then a director judged the task "trivial, nothing separable",
        // did it solo, and told every seat to stay idle — an org the user built
        // specifically to be exercised did nothing (the director line).
        lines.push(input.role === 'director'
            ? 'Route the work: hand tasks to the seats below and keep yourself for direction, ' +
                'review, and integration — even a small task goes to the seat whose charge fits; ' +
                'work alone only when no seat could do it.'
            : 'Delegate separable work to those seats; a "do not delegate" from your manager ' +
                'means outside help, not your own seats.');
    }
    if (input.reportsTo && input.suppressReport) {
        lines.push('The user asked for the chain to END at your seat: when the work comes back, review it and ' +
            'write the outcome in your own terminal — do NOT report up or message your manager unsolicited.');
    }
    else if (input.reportsTo) {
        const reportSnippet = (0, orchestrationCommand_1.buildReportCommandSnippet)(input.shimPath, {
            ...(posix ? { posixShell: true } : {}),
        });
        lines.push(`Report up (status/results/escalations — add --blocked when stuck):\n${(0, orchestrationCommand_1.indentOrchestrationSnippet)(reportSnippet, 2)}`);
    }
    if (input.role === 'director' && input.suppressReport) {
        lines.push('The user asked for NO final report — when the chain finishes, leave the results where ' +
            'they are; do not compose a summary.');
    }
    else if (input.role === 'director') {
        lines.push('You report to the user — write results in your own terminal; do not look for a manager to message.');
    }
    const ruleParts = [];
    if (input.manages.length > 0 || input.skipLevelTargets.length > 0) {
        ruleParts.push('task only the seats listed above');
    }
    if (input.reportsTo && input.suppressReport) {
        ruleParts.push('finish in place — no unsolicited upward messages');
    }
    else if (input.reportsTo) {
        ruleParts.push('report only to your manager — never sideways or past it');
    }
    if (input.manages.length > 0 && input.reportsTo && !input.suppressReport) {
        ruleParts.push('when your subordinates report in, summarize before reporting up — do not forward raw output');
    }
    if (input.role === 'worker') {
        ruleParts.push('do the work, then report — never message other agents directly');
    }
    if (ruleParts.length > 0)
        lines.push(`Rules: ${ruleParts.join('; ')}.`);
    lines.push(`Answers to messages you received go back with --reply-to as usual (delegation chains are capped at ${input.chainDepthLimit} hops). ` +
        'No action needed now — acknowledge briefly.');
    return assertBounded(lines.join('\n'), exports.HIERARCHY_ROLE_NUDGE_MAX_BYTES, 'hierarchy role nudge');
}
/**
 * Single notice for the peer when the user granted BOTH directions at once
 * (self-mention reply edge): the peer receives prompts from the host AND may
 * reply over its own edge back. One nudge, not an inbound + outbound pair —
 * two app-authored messages into the same composer is two staged submits and
 * reads as noise.
 */
function composeMutualLinkNudge({ link, fromTitle, shimPath }) {
    const replyCommand = (0, orchestrationCommand_1.indentOrchestrationSnippet)((0, orchestrationCommand_1.buildLinkSendCommandSnippet)(shimPath, link.from.terminalId), 2);
    return assertBounded(`[1devtool] "${fromTitle}" (${link.from.effectiveAgentKind}, terminal ${link.from.terminalId}) is now linked to you ` +
        `and may send you prompts; they arrive as normal messages. You can reply back over your own link:\n${replyCommand}\n` +
        `--wait prints the target-acceptance delivery receipt; '${shimPath}' whoami lists your links. ` +
        `No action needed now — acknowledge briefly and do not run these commands yet.`);
}
