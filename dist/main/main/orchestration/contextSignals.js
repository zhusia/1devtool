"use strict";
/**
 * Unified per-terminal context-usage view: composes the transcript meter
 * (contextMeter.ts — claude/codex session JSONL tails) with the live footer
 * tracker (contextFooterTracker.ts — gemini/qwen/codex "% context left").
 *
 * Two access grades, deliberately separate:
 *
 * - `getSnapshot` — DISPLAY. Whatever the best available source painted;
 *   may include a stale-after-compact transcript percent or a footer reading
 *   whose terminal has since been typed into. The chip renders it with the
 *   honesty rules it already has.
 *
 * - `getPercentUsed` — TRIGGER-GRADE (built for the auto-compact engine,
 *   docs/auto_compact.md). Returns null in EVERY doubtful case: no ratio →
 *   no action, ever (docs/common-errors/orchestration/context-meter-percent-over-100.md).
 *   Transcript percents require tokens ≤ window and no compact-staleness;
 *   footer percents require a live PTY and no submit after the paint
 *   (rule A4 — a reading is state only while nothing has moved under it).
 *
 * Source priority per declared kind (A1/A3 — declared kind only):
 * - claude-command → transcript (its footer has no % item).
 * - codex → transcript when it carries a verified window (codex ≥0.145
 *   `model_context_window`), else the live footer, else tokens-only.
 * - gemini/qwen → footer (their transcripts carry no usable token data).
 * - everything else → transcript (a custom wrapper with a bound claude/codex
 *   session keeps its meter exactly as before this module existed).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalContextSignals = void 0;
const contracts_1 = require("../../shared/terminal/contracts");
class TerminalContextSignals {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    resolve(terminalId) {
        const location = this.deps.findTerminal(terminalId);
        if (!location)
            return null;
        const kind = (0, contracts_1.getDeclaredAgentKind)(location.agentType, location.startupCommand);
        const transcript = this.deps.meter.getUsage(location.lastSessionAgentType, location.lastSessionId);
        const reading = kind && (kind === 'gemini' || kind === 'qwen' || kind === 'codex')
            ? this.deps.footer?.getReading(terminalId) ?? null
            : null;
        const footer = reading
            ? {
                percentUsed: reading.percentUsed,
                ...(reading.model ? { model: reading.model } : {}),
                source: 'footer',
                at: reading.at,
            }
            : null;
        return { kind, transcript, footer };
    }
    /** Best available snapshot for chip display. */
    getSnapshot(terminalId) {
        const resolved = this.resolve(terminalId);
        if (!resolved)
            return null;
        const { kind, transcript, footer } = resolved;
        if (kind === 'gemini' || kind === 'qwen')
            return footer ?? transcript;
        if (kind === 'codex') {
            // A transcript snapshot with a window is the verified-rich view; the
            // footer covers codex versions whose transcripts lack the field.
            if (transcript?.window)
                return transcript;
            return footer ?? transcript;
        }
        return transcript;
    }
    /**
     * Trigger-grade percent. Null unless a genuine, current ratio exists.
     * Not yet consumed in phase 1 (chip is display-only) — the auto-compact
     * engine (phase 2) polls this. Policy lives here so the engine can't
     * accidentally act on display-grade data.
     */
    getPercentUsed(terminalId) {
        const resolved = this.resolve(terminalId);
        if (!resolved)
            return null;
        const { kind, transcript, footer } = resolved;
        const fromTranscript = () => {
            if (!transcript)
                return null;
            if (transcript.staleAfterCompact)
                return null;
            if (typeof transcript.tokens !== 'number' ||
                typeof transcript.window !== 'number' ||
                transcript.window <= 0 ||
                transcript.tokens > transcript.window) {
                return null;
            }
            return {
                percent: (transcript.tokens / transcript.window) * 100,
                at: transcript.at,
                source: 'transcript',
            };
        };
        const fromFooter = () => {
            if (!footer || typeof footer.percentUsed !== 'number')
                return null;
            const backend = this.deps.getBackend?.() ?? null;
            if (!backend?.hasLiveInstance(terminalId))
                return null;
            // A submit after the paint means the percent may have moved — wait for
            // the next repaint rather than act on a superseded number.
            const status = backend.getAllStatuses()[terminalId];
            const lastSubmitAt = status?.lastSubmitAt ?? 0;
            if (footer.at < lastSubmitAt)
                return null;
            return { percent: footer.percentUsed, at: footer.at, source: 'footer' };
        };
        if (kind === 'gemini' || kind === 'qwen')
            return fromFooter();
        if (kind === 'codex')
            return fromTranscript() ?? fromFooter();
        return fromTranscript();
    }
}
exports.TerminalContextSignals = TerminalContextSignals;
