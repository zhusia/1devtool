"use strict";
/**
 * Attention inbox contracts (orchestration v4 — L6).
 *
 * An attention event is ADVISORY UI, never control: it may open a card in the
 * unified activity feed and an amber dot on the terminal tab; resolving one
 * submits normal prompts or calls existing orchestration IPC — it never
 * advances a run, completes a message, or bypasses a confirmation (v4
 * invariant 24).
 *
 * Kinds map to what the installed producers actually provide today:
 * - 'agent-done'    — a non-Team terminal's agent finished a turn. detail is
 *                     Codex's last-assistant-message or a bounded read of
 *                     Claude's transcript tail; may be absent.
 * - 'agent-question'— structured question WITH choices; only the headless
 *                     runtime produces these (PTY terminals have no options
 *                     source — scoped honestly, not scraped).
 * - 'link-failed'   — an L4 link delivery failed typed.
 * - 'task-gate'     — a Tasks approval gate opened and is waiting on the human
 *                     (docs/tasks_v2.md §5.3). Advisory like the rest: the card
 *                     routes to the review queue, and resolving still goes
 *                     through the gesture-gated `tasks:resolve-gate`. The
 *                     terminal fields name the agent that ASKED; a gate opened
 *                     by a task with no live terminal carries the task id in
 *                     `terminalId` so the card stays addressable.
 * Team/Swarm attention (needs-confirm / mediated submit / fallback) is NOT
 * re-emitted through this channel: the renderer already holds those states in
 * the orchestration snapshot and derives its cards from there — one owner per
 * fact.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ATTENTION_DETAIL_MAX_CHARS = void 0;
exports.ATTENTION_DETAIL_MAX_CHARS = 500;
