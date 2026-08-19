"use strict";
/**
 * Main-side live capture of agent TUI footer context percentages.
 *
 * Subscribes to the PTY output pipe for terminals whose declared kind paints
 * a "% context left" footer (gemini, qwen, codex) and keeps the latest
 * reading per terminal. Capture MUST live in main: the renderer only receives
 * PTY output while a view is subscribed, so a background/unfocused terminal
 * would go blind exactly when an unattended consumer (the context chip via
 * IPC today, the auto-compact engine later) needs the number.
 *
 * Classification: declared kind only (`getDeclaredAgentKind` at the create
 * site — rule A1/A3). Custom wrappers and sniffed shells never attach; an
 * unverifiable CLI must never feed a context %.
 *
 * Freshness (rule A4): `getReading` returns whatever the live stream last
 * painted, stamped `at`. Trigger-grade consumers must additionally check the
 * terminal is still live and that no submit happened after `at`
 * (`PtyRuntimeStatus.lastSubmitAt`) — that policy lives in
 * `contextSignals.ts`, not here. There is deliberately NO saved-buffer
 * hydration: after an app restart a live CLI repaints its footer within
 * seconds, and a fresh (non-resumed) session resets its context — a stale
 * hydrated percent would be confidently wrong in exactly the dangerous
 * direction.
 *
 * Cost per chunk when nothing matches: one indexOf inside
 * `scanChunkForContextPercent`'s gate (hotpath-perf: indexOf before regex).
 * No timers, no store writes — a Map.set only on a successful match.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextFooterTracker = exports.FOOTER_SCAN_KINDS = void 0;
const contextFooter_1 = require("../../shared/terminal/contextFooter");
/** Declared kinds whose TUIs self-report "% context left". */
exports.FOOTER_SCAN_KINDS = new Set([
    'gemini',
    'qwen',
    'codex',
]);
class ContextFooterTracker {
    getBackend;
    entries = new Map();
    constructor(getBackend) {
        this.getBackend = getBackend;
    }
    /**
     * Start scanning a terminal's live output. No-op for kinds without a footer
     * pattern and when already attached. Call only AFTER the backend create
     * succeeded — `onOutput` on a non-live terminal returns a no-op
     * unsubscribe that would permanently deafen the entry.
     */
    attach(terminalId, kind) {
        if (!kind || !exports.FOOTER_SCAN_KINDS.has(kind) || this.entries.has(terminalId))
            return;
        const backend = this.getBackend();
        if (!backend?.hasLiveInstance(terminalId))
            return;
        const entry = {
            kind,
            state: (0, contextFooter_1.createContextFooterScanState)(),
            reading: null,
            unsubscribe: () => { },
        };
        entry.unsubscribe = backend.onOutput(terminalId, (data) => {
            const reading = (0, contextFooter_1.scanChunkForContextPercent)(entry.state, data, entry.kind);
            if (reading)
                entry.reading = reading;
        });
        this.entries.set(terminalId, entry);
    }
    /** Stop scanning and forget the reading (terminal exit/kill). */
    detach(terminalId) {
        const entry = this.entries.get(terminalId);
        if (!entry)
            return;
        entry.unsubscribe();
        this.entries.delete(terminalId);
    }
    getReading(terminalId) {
        return this.entries.get(terminalId)?.reading ?? null;
    }
    dispose() {
        for (const entry of this.entries.values())
            entry.unsubscribe();
        this.entries.clear();
    }
}
exports.ContextFooterTracker = ContextFooterTracker;
