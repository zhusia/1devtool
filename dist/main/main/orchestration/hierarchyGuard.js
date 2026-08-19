"use strict";
/**
 * HierarchyGuard — pure classification of agent-originated link traffic
 * against an activation's FROZEN chart (orchestration v5 §4).
 *
 * Consulted by LinkRegistry at the agent-originated entry points only
 * (linkSend, requestLink, broadcast); renderer/IPC paths are exempt by
 * construction (D7 — the human outranks the chart). The guard only NARROWS
 * what the link substrate already allows (invariant 26): it grants nothing,
 * and a hierarchy edge without an underlying active link still cannot
 * deliver. Every refusal names the correct route (invariant 29).
 *
 * Pure module: no Electron, no fs — unit-testable with plain objects.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyHierarchySend = classifyHierarchySend;
exports.hierarchyBroadcastScope = hierarchyBroadcastScope;
const hierarchy_1 = require("../../shared/orchestration/hierarchy");
const pipeline_1 = require("../../shared/orchestration/pipeline");
const orchestrationCommand_1 = require("../../shared/orchestrationCommand");
function seatByTerminal(seats, terminalId) {
    return seats.find((seat) => seat.state === 'active' && seat.endpoint.terminalId === terminalId);
}
function labelOf(chart, nodeId) {
    return (0, hierarchy_1.findHierarchyNode)(chart, nodeId)?.label ?? nodeId;
}
function reportSnippet(input) {
    if (!input.shimPath)
        return `report --prompt-stdin (via the 1devtool-agent shim)`;
    return (0, orchestrationCommand_1.buildReportCommandSnippet)(input.shimPath, {
        ...(input.pipelineContinuationMessageId
            ? { continueFromMessageId: input.pipelineContinuationMessageId }
            : {}),
        ...((0, orchestrationCommand_1.agentToolShellPrefersPosix)(input.senderAgentKind) ? { posixShell: true } : {}),
    });
}
/**
 * Classify one agent-originated send. The §4 table:
 *
 * | Task (down)       | manages/skip-level edge from S's node to T's node | allow |
 * | Report (up)       | T's node is S's reportsTo                         | allow |
 * | Reply             | answers a message T sent S                       | always allow |
 * | Lateral/skip-up/… | anything else between two seated terminals       | refuse, typed |
 * | Seated → unseated | T outside the org                                | allow (ad-hoc v4) |
 */
function classifyHierarchySend(input) {
    const fromSeat = seatByTerminal(input.seats, input.fromTerminalId);
    const toSeat = seatByTerminal(input.seats, input.toTerminalId);
    // The org constrains its own members' initiations; outsiders keep flat v4
    // semantics in both directions (the org does not annex the project).
    if (!fromSeat)
        return { allow: true, class: 'unseated' };
    const fromNodeId = fromSeat.nodeId;
    const fromNode = (0, hierarchy_1.findHierarchyNode)(input.chart, fromNodeId);
    // Depth guard first — it applies to every seated initiation, including
    // otherwise-legal down-tasks (a runaway chain is refused wherever it turns).
    if (!input.isReply &&
        input.hopCount !== undefined &&
        input.hopCount > input.chart.maxChainDepth) {
        if ((0, pipeline_1.isPipelineChart)(input.chart)) {
            return {
                allow: false,
                class: 'depth-exceeded',
                fromNodeId,
                ...(toSeat ? { toNodeId: toSeat.nodeId } : {}),
                detail: `refused: pipeline — this run is ${input.hopCount} hops deep; the frozen limit is ` +
                    `${input.chart.maxChainDepth}. Do not hand off further — finish and write the result in this terminal.`,
            };
        }
        return {
            allow: false,
            class: 'depth-exceeded',
            fromNodeId,
            ...(toSeat ? { toNodeId: toSeat.nodeId } : {}),
            detail: `refused: hierarchy — this delegation chain is ${input.hopCount} hops deep; the limit is ` +
                `${input.chart.maxChainDepth}. Do not delegate further — finish what you can and report up:\n` +
                reportSnippet(input),
        };
    }
    if (!toSeat) {
        if ((0, pipeline_1.isPipelineChart)(input.chart)) {
            return {
                allow: false,
                class: 'violation',
                fromNodeId,
                detail: 'refused: pipeline — active stages cannot initiate traffic outside the frozen pipeline. Ask the user to send or link that terminal instead.',
            };
        }
        return { allow: true, class: 'unseated', fromNodeId };
    }
    const toNodeId = toSeat.nodeId;
    if ((0, pipeline_1.isPipelineChart)(input.chart)) {
        const stages = (0, pipeline_1.pipelineStages)(input.chart);
        const fromIndex = stages.findIndex((stage) => stage.nodeId === fromNodeId);
        const next = (0, pipeline_1.pipelineNextStage)(stages.map((stage) => ({ kind: stage.nodeId })), fromNodeId);
        const fromLabel = labelOf(input.chart, fromNodeId);
        const toLabel = labelOf(input.chart, toNodeId);
        if (input.isReply) {
            if (input.replyPipelineKind === 'handoff' || input.replyPipelineKind === 'rework') {
                if (!input.gateDecision) {
                    return {
                        allow: false,
                        class: 'violation',
                        fromNodeId,
                        toNodeId,
                        detail: 'refused: pipeline — this reply is a quality-gate decision. Reply to the exact message with `link send --gate=accept` or `--gate=reject`.',
                    };
                }
                return { allow: true, class: 'pipeline-gate', fromNodeId, toNodeId };
            }
            if (input.replyPipelineKind === 'gate-reject') {
                if (input.gateDecision) {
                    return {
                        allow: false,
                        class: 'violation',
                        fromNodeId,
                        toNodeId,
                        detail: 'refused: pipeline — return the corrected work as an ordinary reply to this reject; do not attach another gate decision.',
                    };
                }
                return { allow: true, class: 'pipeline-rework', fromNodeId, toNodeId };
            }
            if (input.replyPipelineKind === 'gate-accept') {
                return {
                    allow: false,
                    class: 'violation',
                    fromNodeId,
                    toNodeId,
                    detail: 'refused: pipeline — an acceptance creates no reply duty. Continue your stage using the accepted input id.',
                };
            }
            if (input.gateDecision) {
                return {
                    allow: false,
                    class: 'violation',
                    fromNodeId,
                    toNodeId,
                    detail: 'refused: pipeline — --gate is valid only when replying to a Pipeline handoff or rework.',
                };
            }
            return { allow: true, class: 'reply', fromNodeId, toNodeId };
        }
        if (input.gateDecision) {
            return {
                allow: false,
                class: 'violation',
                fromNodeId,
                toNodeId,
                detail: 'refused: pipeline — --gate requires a validated --reply-to or --reply-token.',
            };
        }
        if (input.pipelineIntent === 'handoff' && next?.kind === toNodeId) {
            return { allow: true, class: 'pipeline-handoff', fromNodeId, toNodeId };
        }
        const nextLabel = next ? labelOf(input.chart, next.kind) : 'the user';
        const needsAcceptedInput = fromIndex > 0 && fromIndex < stages.length - 1;
        const command = reportSnippet(input);
        const rawNextStage = next?.kind === toNodeId;
        const routeLead = rawNextStage
            ? `refused: pipeline — ${nextLabel} is the next stage, but raw link send bypasses the handoff protocol.`
            : `refused: pipeline — ${nextLabel} is the next stage, not ${toLabel}.`;
        return {
            allow: false,
            class: 'violation',
            fromNodeId,
            toNodeId,
            detail: fromIndex === stages.length - 1
                ? `refused: pipeline — ${fromLabel} is the final stage. Write the result in this terminal and run report --complete.`
                : needsAcceptedInput && !input.pipelineContinuationMessageId
                    ? `${routeLead} ` +
                        (input.pipelinePendingGateMessageId
                            ? `Input ${input.pipelinePendingGateMessageId} is still waiting for this stage's structured accept/reject decision; decide that exact message before handing off.`
                            : 'This stage has no accepted input ready to continue; finish the pending gate or rework before handing off.')
                    : `${routeLead}\nTo hand off:\n${command}`,
        };
    }
    if (input.isReply) {
        return { allow: true, class: 'reply', fromNodeId, toNodeId };
    }
    if ((0, hierarchy_1.hierarchyDirectSubordinates)(input.chart, fromNodeId).includes(toNodeId)) {
        return { allow: true, class: 'task-down', fromNodeId, toNodeId };
    }
    if ((0, hierarchy_1.hierarchySkipLevelTargets)(input.chart, fromNodeId).includes(toNodeId)) {
        return { allow: true, class: 'skip-level-task', fromNodeId, toNodeId };
    }
    if (fromNode?.reportsTo && fromNode.reportsTo === toNodeId) {
        // "review back to <me>, do not report to me": the chain ends at this seat
        // — its upward report is refused with teaching text. Replies to received
        // messages were already allowed above; only the unsolicited report stops.
        if (fromNode.suppressReport) {
            return {
                allow: false,
                class: 'violation',
                fromNodeId,
                toNodeId,
                detail: `refused: hierarchy — the user asked for the chain to end at ` +
                    `${labelOf(input.chart, fromNodeId)}: do not report up. Finish the review ` +
                    `and write the outcome in your own terminal; answers to direct questions ` +
                    `still go back with --reply-to as usual.`,
            };
        }
        return { allow: true, class: 'report-up', fromNodeId, toNodeId };
    }
    // Violation — teach the configured route (invariant 29).
    const fromLabel = labelOf(input.chart, fromNodeId);
    const toLabel = labelOf(input.chart, toNodeId);
    let route;
    if (fromNode?.reportsTo) {
        const managerLabel = labelOf(input.chart, fromNode.reportsTo);
        route =
            `refused: hierarchy — ${fromLabel} reports to ${managerLabel}, not to ${toLabel}. ` +
                `To pass this upward:\n${reportSnippet(input)}`;
    }
    else {
        const subordinates = (0, hierarchy_1.hierarchyDirectSubordinates)(input.chart, fromNodeId)
            .map((nodeId) => labelOf(input.chart, nodeId));
        route =
            `refused: hierarchy — ${fromLabel} has no route to ${toLabel}. ` +
                (subordinates.length > 0
                    ? `Task your own subordinates (${subordinates.join(', ')}) or report results to the user in your own terminal.`
                    : 'Report results to the user in your own terminal.');
    }
    return { allow: false, class: 'violation', fromNodeId, toNodeId, detail: route };
}
/** Broadcast scope for a seated caller; null when the caller is unseated. */
function hierarchyBroadcastScope(chart, seats, callerTerminalId) {
    const seat = seatByTerminal(seats, callerTerminalId);
    if (!seat)
        return null;
    if ((0, pipeline_1.isPipelineChart)(chart)) {
        return {
            allowedTargetIds: [],
            voteRefusal: 'refused: pipelines decide by quality gates, not quorum — hand off with report and use structured accept/reject replies.',
        };
    }
    const subordinateNodeIds = (0, hierarchy_1.hierarchyDirectSubordinates)(chart, seat.nodeId);
    const allowedTargetIds = subordinateNodeIds
        .map((nodeId) => seats.find((row) => row.nodeId === nodeId && row.state === 'active')?.endpoint.terminalId)
        .filter((terminalId) => Boolean(terminalId));
    return {
        allowedTargetIds,
        voteRefusal: 'refused: hierarchies decide by escalation, not quorum — report the question up ' +
            'to your manager (or, as a director, to the user) instead of opening a vote.',
    };
}
