"use strict";
/**
 * Headless-run link guard (orchestration v4 — L1/L4 hardening).
 *
 * Field failure this prevents: an agent with an ACTIVE link to an open peer
 * terminal still delegates via the legacy skill pattern
 * `1devtool-agent run --to=<agent>` — which spawns a FRESH headless agent.
 * Headless claude/gemini get no permission bypass (headlessMode.ts), so a
 * write-task stalls at the permission wall while the linked live terminal —
 * the one that could actually do the work — never receives anything, and the
 * caller waits out its full timeout for an empty result.
 *
 * The nudge advises but the skill competes, so the CLI is the enforcement
 * point: `run --to=X` fails fast with the exact `link send` command when an
 * active sendable link to an X terminal exists. `--no-link` is the explicit
 * override for intentionally spawning a fresh headless agent — fail-fast with
 * a stated escape hatch, never a silent reroute.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.findLinkedPeerForAgent = findLinkedPeerForAgent;
exports.findLinkedPeersForAgent = findLinkedPeersForAgent;
exports.formatLinkGuardError = formatLinkGuardError;
const orchestrationCommand_1 = require("../shared/orchestrationCommand");
/** Agent-id aliases: CLI target ids vs terminal effectiveAgentKind values. */
const AGENT_KIND_ALIASES = {
    'claude-command': 'claude',
    antigravity: 'agy',
};
function normalizeKind(kind) {
    if (!kind)
        return null;
    const lower = kind.toLowerCase();
    return AGENT_KIND_ALIASES[lower] ?? lower;
}
/**
 * The single unambiguous active outbound link whose peer runs the target
 * agent and grants 'send'. Multiple matches return null here; the CLI guard
 * uses the plural resolver below so it can show every explicit destination.
 */
function findLinkedPeerForAgent(whoami, targetAgentId) {
    const peers = findLinkedPeersForAgent(whoami, targetAgentId);
    return peers.length === 1 ? peers[0] : null;
}
/** All matching peers, used by the CLI guard so ambiguity is shown rather
 * than silently choosing whichever same-agent link happened to be first. */
function findLinkedPeersForAgent(whoami, targetAgentId) {
    if (!whoami?.ok || !Array.isArray(whoami.links?.outbound))
        return [];
    const target = normalizeKind(targetAgentId);
    if (!target)
        return [];
    return whoami.links.outbound.filter((row) => row.state === 'active' &&
        row.permissions?.includes('send') &&
        normalizeKind(row.agent) === target);
}
function formatLinkGuardError(rowOrRows, targetAgentId, shimPath) {
    const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
    const targets = rows.map((row) => `"${row.peerName}" (${row.peerTerminalId}):\n` +
        (0, orchestrationCommand_1.indentOrchestrationSnippet)((0, orchestrationCommand_1.buildLinkSendCommandSnippet)(shimPath, row.peerTerminalId), 2)).join('\n\n');
    const destination = rows.length === 1
        ? `the open ${targetAgentId} terminal `
        : `${rows.length} open ${targetAgentId} terminals; choose the intended terminal explicitly:\n\n`;
    const targetText = rows.length === 1
        ? `"${rows[0].peerName}" (${rows[0].peerTerminalId}). Deliver over the link instead — it uses the ` +
            `live session (approvals, context, visible to the user):\n\n${targets}`
        : `${targets}\n\nDo not choose a peer from ordering alone.`;
    return (`active links already connect you to ${destination}${targetText}\n\n` +
        `A fresh headless ${targetAgentId} cannot answer permission prompts and cannot see that ` +
        `terminal's context. Pass --no-link only if you intentionally want a separate headless run.`);
}
