"use strict";
/**
 * Model-family → context-window table for the per-terminal context meter
 * (orchestration v4 — L7).
 *
 * Carried rule (v3 I8): the window can NOT be reliably detected from a model
 * id — Claude sessions may run a 1M window while the transcript still says
 * "claude-opus-4-8". Entries are therefore marked `assumed`, the UI renders
 * an approximate percent (`~62%`) for assumed windows and raw tokens when no
 * entry matches, and a wrong-confident denominator is never shown.
 *
 * **Observation outranks the table.** When measured prompt tokens exceed an
 * assumed window, that entry is DISPROVEN for the session — the only honest
 * output is raw tokens, never a >100% percent and never a clamp. Opus 5's 1M
 * beta is the live case: it reports a plain `claude-opus-5` id with no `[1m]`
 * marker and no window field, so 375k prompt tokens rendered as a red `~188%`
 * (docs/common-errors/orchestration/context-meter-percent-over-100.md). Do NOT
 * "fix" that by adding a 1M entry for Opus 5 — the same id also runs 200k
 * sessions, so a bigger denominator would hide real context pressure.
 *
 * Verified on: 2026-07-24 (standard Claude windows = 200k). Update the date
 * when revalidating; add entries rather than guessing.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONTEXT_WINDOW_TABLE = void 0;
exports.resolveContextWindow = resolveContextWindow;
exports.CONTEXT_WINDOW_TABLE = [
    { match: 'claude', window: 200_000, confidence: 'assumed' },
];
function resolveContextWindow(modelId) {
    if (!modelId)
        return null;
    const id = modelId.toLowerCase();
    return exports.CONTEXT_WINDOW_TABLE.find((entry) => id.includes(entry.match)) ?? null;
}
