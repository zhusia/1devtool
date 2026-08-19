"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBackendAgentSubmissionProbe = createBackendAgentSubmissionProbe;
exports.waitForBackendAgentReady = waitForBackendAgentReady;
const agentReadiness_1 = require("../shared/terminal/agentReadiness");
const TerminalScreenModel_1 = require("./orchestration/TerminalScreenModel");
const TerminalConnectionObserver_1 = require("./terminal-connection/TerminalConnectionObserver");
const DEFAULT_DEADLINE_MS = 30_000;
const MIN_OBSERVE_MS = 750;
const SCREEN_QUIET_MS = 350;
const POLL_MS = 100;
const SUBMISSION_ACK_DEADLINE_MS = 12_000;
const SUBMISSION_ACK_POLL_MS = 75;
const SESSION_ACK_POLL_MS = 500;
const LATE_EXACT_ACK_DEADLINE_MS = 90_000;
const CODEX_WORKING_RE = /(?:^|\n)\s*•\s+Working\s+\([^)]*\besc\s+to\s+interrupt\b[^)]*\)/iu;
/**
 * Shortest marker prefix that may stand in for the whole marker when a TUI
 * CLIPPED the rest. `[1devtool-message:lm-<uuid>]` is unique well inside this,
 * so a match this long cannot collide with another message.
 */
const MARKER_TRUNCATED_MIN_PREFIX = 32;
/** Clip indicators TUIs paint where they cut a line (grok uses U+2026). */
const MARKER_CLIP_INDICATORS = ['…', '...'];
/**
 * Does a visible marker prefix end exactly at a clip indicator?
 *
 * Grok renders a pasted message as a bordered preview and CLIPS each line to
 * the box width: `[1devtool-message:lm-2d3a5dd6-34f3-4af7-a102-a3aea214f…`.
 * The trailing bytes are never painted, so an exact-containment test can never
 * pass and acceptance could never be proven for a long message in a narrow
 * pane — the send failed as `delivery-unconfirmed` while the peer answered
 * normally (docs/common-errors/orchestration/grok-link-marker-truncated.md).
 */
function screenShowsClippedMarker(flat, marker) {
    if (marker.length <= MARKER_TRUNCATED_MIN_PREFIX)
        return false;
    const anchor = marker.slice(0, MARKER_TRUNCATED_MIN_PREFIX);
    for (let at = flat.indexOf(anchor); at >= 0; at = flat.indexOf(anchor, at + 1)) {
        let matched = MARKER_TRUNCATED_MIN_PREFIX;
        while (matched < marker.length && flat[at + matched] === marker[matched])
            matched += 1;
        const tail = flat.slice(at + matched);
        if (MARKER_CLIP_INDICATORS.some((clip) => tail.startsWith(clip)))
            return true;
    }
    return false;
}
function screenContainsCorrelationMarker(screen, marker) {
    if (screen.includes(marker))
        return true;
    // TerminalScreenModel renders physical TUI rows separated by newlines. A
    // long marker may wrap at the viewport edge even though every marker byte
    // is present in order. Codex also paints continuation indentation at the
    // start of a wrapped row, so compare after removing only row separators and
    // their leading layout cells. Preserve ordinary intra-row whitespace and
    // punctuation on both sides.
    const flat = screen.replace(/[\r\n]+[ \t]*/g, '');
    if (flat.includes(marker.replace(/[\r\n]+[ \t]*/g, '')))
        return true;
    return screenShowsClippedMarker(flat, marker);
}
/**
 * Windows TUIs can repaint the app-authored marker label through cursor
 * motion while leaving its random message UUID intact. The UUID is the exact
 * per-message correlation value, not a generic output heuristic, so it is a
 * safe current-screen staging proof for every Windows agent. Acceptance still
 * requires a newer target-owned busy/cleared transition after the one Enter.
 */
function screenContainsWindowsCorrelationId(screen, marker) {
    const uuid = marker.match(/\blm-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/i)?.[1];
    return Boolean(uuid && screen.replace(/[\r\n]+[ \t]*/g, '').includes(uuid));
}
// Hermes replaces its whole composer ROW while a turn runs — `opencode ❯` /
// `❯` becomes `⚕ ❯ msg=interrupt · /queue · /bg · /steer · Ctrl+C cancel`.
// Identical across profiles (captured: default gpt-5.6-sol and opencode-acp),
// and it is composer chrome, so no transcript text can spell it at column 0.
const HERMES_TURN_RUNNING_RE = /(?:^|\n)[\s│┃|]*⚕\s*[>❯›]\s*msg=interrupt\b/u;
function showsNewCodexWork(screen) {
    return CODEX_WORKING_RE.test(screen);
}
function showsHermesTurnRunning(screen) {
    return HERMES_TURN_RUNNING_RE.test(screen);
}
function failure(reason, error) {
    return { ok: false, reason, error };
}
/**
 * Retain the live VT model across a staged submit and require target-side
 * acceptance before a caller may claim delivery. A PTY flush is deliberately
 * absent from the evidence set: it proves injection only.
 */
async function createBackendAgentSubmissionProbe({ backend, connectionService, terminalId, kind, requireReady = true, signal, platform = process.platform, correlationMarker, correlationCheck, timing, }) {
    if (signal?.aborted)
        throw new Error('Send cancelled before submission observation started.');
    if (!backend.hasLiveInstance(terminalId)) {
        throw new Error('The target terminal process is not running.');
    }
    const initialSize = backend.getSize(terminalId);
    const screen = new TerminalScreenModel_1.TerminalScreenModel(initialSize?.rows, initialSize?.cols, platform);
    const deferred = [];
    let snapshotReady = false;
    let disposed = false;
    let observerError = null;
    let armed = false;
    let armedGeneration = 0;
    let codexBusyAtArm = false;
    let grokBusyAtArm = false;
    let hermesBusyAtArm = false;
    let sawExactPromptOnScreen = false;
    const observe = () => {
        // Latch: once the marker has been seen, stop paying a full-screen render
        // per PTY chunk for the rest of the probe's lifetime (the target agent is
        // streaming its hardest exactly then).
        if (sawExactPromptOnScreen)
            return;
        if (correlationMarker) {
            const rendered = screen.render();
            if (screenContainsCorrelationMarker(rendered, correlationMarker) ||
                (platform === 'win32'
                    && screenContainsWindowsCorrelationId(rendered, correlationMarker))) {
                sawExactPromptOnScreen = true;
            }
        }
    };
    const feedAtLiveSize = (data) => {
        try {
            const size = backend.getSize(terminalId);
            if (size)
                screen.resize(size.rows, size.cols);
            screen.feed(data);
            observe();
        }
        catch (error) {
            observerError = error instanceof Error ? error.message : 'Failed to reconstruct terminal output.';
        }
    };
    let disposeOutput = () => { };
    const disposeResize = backend.onResize(terminalId, (size) => {
        try {
            screen.resize(size.rows, size.cols);
        }
        catch (error) {
            observerError = error instanceof Error ? error.message : 'Failed to resize terminal observer.';
        }
    });
    const dispose = () => {
        if (disposed)
            return;
        disposed = true;
        disposeResize();
        disposeOutput();
    };
    try {
        if (connectionService) {
            const observation = await (0, TerminalConnectionObserver_1.observeTerminalConnection)({
                service: connectionService,
                terminalId,
                subjectId: `submission-probe:${terminalId}:${Date.now()}`,
                onSnapshot: (data, replace) => {
                    if (replace)
                        screen.reset();
                    feedAtLiveSize(data);
                },
                onOutput: feedAtLiveSize,
            });
            disposeOutput = observation.dispose;
            snapshotReady = true;
        }
        else {
            // Compatibility/test fallback while every caller adopts the shared
            // connection service.
            disposeOutput = backend.onOutput(terminalId, (data, seq) => {
                if (!snapshotReady)
                    deferred.push({ data, seq });
                else
                    feedAtLiveSize(data);
            });
            const snapshot = await backend.getBufferSnapshot(terminalId);
            feedAtLiveSize(snapshot.content);
            snapshotReady = true;
            for (const chunk of deferred) {
                if (chunk.seq === undefined || chunk.seq > snapshot.seq)
                    feedAtLiveSize(chunk.data);
            }
        }
        if (signal?.aborted)
            throw new Error('Send cancelled before submission observation started.');
        if (!backend.hasLiveInstance(terminalId)) {
            throw new Error('The terminal exited before submission observation started.');
        }
        if (observerError)
            throw new Error(observerError);
        if (requireReady && !backend.getSize(terminalId)) {
            throw new Error('The target terminal dimensions are unavailable; the prompt was not written.');
        }
        if (requireReady && !screen.readiness(kind).ready) {
            throw new Error('The AI composer changed after readiness was proven; the prompt was not written.');
        }
    }
    catch (error) {
        dispose();
        throw error;
    }
    return {
        get composerPosition() {
            const needsComposerFocus = kind === 'cline' || (platform === 'win32' && (kind === 'grok' || kind === 'opencode'));
            return needsComposerFocus && screen.readiness(kind).ready
                ? screen.cursorPosition()
                : undefined;
        },
        armSubmission() {
            if (disposed || armed)
                return;
            armed = true;
            armedGeneration = screen.generation;
            observe();
            codexBusyAtArm = kind === 'codex' && showsNewCodexWork(screen.render());
            grokBusyAtArm = platform === 'win32'
                && kind === 'grok'
                && screen.grokTurnRunning();
            hermesBusyAtArm = kind === 'hermes' && showsHermesTurnRunning(screen.render());
        },
        async waitForAcceptance() {
            if (!armed) {
                return {
                    ok: false,
                    reason: 'failed',
                    error: 'Submission acknowledgement was not armed before Enter.',
                };
            }
            const deadline = Date.now() + Math.max(1, timing?.deadlineMs ?? SUBMISSION_ACK_DEADLINE_MS);
            let lastSessionCheckAt = 0;
            while (Date.now() < deadline) {
                if (disposed || signal?.aborted) {
                    return {
                        ok: false,
                        reason: 'cancelled',
                        error: 'Submission acknowledgement was cancelled after Enter.',
                    };
                }
                if (!backend.hasLiveInstance(terminalId)) {
                    return {
                        ok: false,
                        reason: 'exited',
                        error: 'The target terminal exited before acknowledging the submitted prompt.',
                    };
                }
                if (observerError) {
                    return { ok: false, reason: 'failed', error: observerError };
                }
                const readiness = screen.readiness(kind);
                if (correlationMarker &&
                    sawExactPromptOnScreen &&
                    readiness.generation > armedGeneration &&
                    readiness.ready) {
                    return { ok: true, evidence: 'composer-cleared' };
                }
                if (kind === 'codex' &&
                    correlationMarker &&
                    sawExactPromptOnScreen &&
                    !codexBusyAtArm &&
                    readiness.generation > armedGeneration &&
                    screenContainsCorrelationMarker(readiness.screen, correlationMarker) &&
                    showsNewCodexWork(readiness.screen)) {
                    return { ok: true, evidence: 'agent-busy' };
                }
                // Grok keeps its empty composer mounted while responding on Windows,
                // so `composer-cleared` cannot distinguish idle from accepted. A new
                // current-screen spinner after the exact staged marker and one Enter
                // is the target-owned transition that proves this message started.
                if (platform === 'win32' &&
                    kind === 'grok' &&
                    correlationMarker &&
                    sawExactPromptOnScreen &&
                    !grokBusyAtArm &&
                    readiness.generation > armedGeneration &&
                    screen.grokTurnRunning(readiness.screen)) {
                    return { ok: true, evidence: 'agent-busy' };
                }
                // Hermes: same absent-at-arm → present-after-Enter busy transition as
                // Codex, minus the marker-still-visible clause, because Hermes CLEARS
                // its composer on accept and never repaints the prompt text (verified
                // on real captures, both profiles). Without this the receipt is
                // structurally unreachable: `composer-cleared` needs an idle composer,
                // and Hermes stays busy for the whole turn — 16s for a one-word answer
                // through opencode-acp, minutes for real work — so every send timed
                // out as `delivery-unconfirmed` while the peer was answering normally
                // (docs/common-errors/orchestration/hermes-link-receipt-unconfirmed.md).
                // The exact marker was still proven staged in this composer before the
                // one Enter (`sawExactPromptOnScreen`), which is what makes a NEW busy
                // state attributable to this message.
                if (kind === 'hermes' &&
                    correlationMarker &&
                    sawExactPromptOnScreen &&
                    !hermesBusyAtArm &&
                    readiness.generation > armedGeneration &&
                    showsHermesTurnRunning(readiness.screen)) {
                    return { ok: true, evidence: 'agent-busy' };
                }
                const now = Date.now();
                if (correlationCheck &&
                    now - lastSessionCheckAt >= (timing?.correlationPollMs ?? SESSION_ACK_POLL_MS)) {
                    lastSessionCheckAt = now;
                    try {
                        if (await correlationCheck())
                            return { ok: true, evidence: 'session-message' };
                    }
                    catch {
                        // Session files can be mid-rename/mid-write. Keep the bounded
                        // observer alive; timeout remains the honest final outcome.
                    }
                }
                await new Promise((resolve) => setTimeout(resolve, timing?.pollMs ?? SUBMISSION_ACK_POLL_MS));
            }
            return {
                ok: false,
                reason: 'timeout',
                error: 'The prompt Enter was written once, but the target did not acknowledge accepting the message. ' +
                    'It was not retried to avoid duplicate execution.',
            };
        },
        async waitForLateAcceptance() {
            if (!armed || !correlationMarker || !correlationCheck) {
                return {
                    ok: false,
                    reason: 'failed',
                    error: 'No exact late target-receipt adapter is available for this submission.',
                };
            }
            const deadline = Date.now() + LATE_EXACT_ACK_DEADLINE_MS;
            while (Date.now() < deadline) {
                if (disposed || signal?.aborted) {
                    return {
                        ok: false,
                        reason: 'cancelled',
                        error: 'Late submission acknowledgement was cancelled.',
                    };
                }
                if (!backend.hasLiveInstance(terminalId)) {
                    return {
                        ok: false,
                        reason: 'exited',
                        error: 'The target terminal exited before an exact late receipt arrived.',
                    };
                }
                try {
                    if (await correlationCheck())
                        return { ok: true, evidence: 'session-message' };
                }
                catch {
                    // Native session files can be mid-write or rename. Keep this bounded
                    // observer alive; no screen/output fallback is allowed here.
                }
                await new Promise((resolve) => setTimeout(resolve, SESSION_ACK_POLL_MS));
            }
            return {
                ok: false,
                reason: 'timeout',
                error: 'No exact late target acknowledgement arrived; the prompt was not retried.',
            };
        },
        dispose,
    };
}
async function waitForBackendAgentReady({ backend, connectionService, terminalId, kind, platform = process.platform, allowActiveTurnComposer = false, signal, deadlineMs = DEFAULT_DEADLINE_MS, timing, }) {
    if (!(0, agentReadiness_1.hasKnownReadyMarker)(kind)) {
        return failure('unsupported', 'This AI terminal does not expose a supported readiness signal.');
    }
    if (signal?.aborted)
        return failure('cancelled', 'Send cancelled before the terminal became ready.');
    if (!backend.hasLiveInstance(terminalId)) {
        return failure('failed', 'The target terminal process is not running.');
    }
    const initialSize = backend.getSize(terminalId);
    const screen = new TerminalScreenModel_1.TerminalScreenModel(initialSize?.rows, initialSize?.cols, platform);
    const deferred = [];
    let snapshotReady = false;
    const feedAtLiveSize = (data) => {
        const size = backend.getSize(terminalId);
        if (size)
            screen.resize(size.rows, size.cols);
        screen.feed(data);
    };
    let disposeOutput = () => { };
    const disposeResize = backend.onResize(terminalId, (size) => {
        screen.resize(size.rows, size.cols);
    });
    try {
        if (connectionService) {
            const observation = await (0, TerminalConnectionObserver_1.observeTerminalConnection)({
                service: connectionService,
                terminalId,
                subjectId: `readiness:${terminalId}:${Date.now()}`,
                onSnapshot: (data, replace) => {
                    if (replace)
                        screen.reset();
                    feedAtLiveSize(data);
                },
                onOutput: feedAtLiveSize,
            });
            disposeOutput = observation.dispose;
            snapshotReady = true;
        }
        else {
            disposeOutput = backend.onOutput(terminalId, (data, seq) => {
                if (!snapshotReady)
                    deferred.push({ data, seq });
                else
                    feedAtLiveSize(data);
            });
            const snapshot = await backend.getBufferSnapshot(terminalId);
            feedAtLiveSize(snapshot.content);
            snapshotReady = true;
            for (const chunk of deferred) {
                if (chunk.seq === undefined || chunk.seq > snapshot.seq)
                    feedAtLiveSize(chunk.data);
            }
        }
        if (signal?.aborted)
            return failure('cancelled', 'Send cancelled before the terminal became ready.');
        if (!backend.hasLiveInstance(terminalId)) {
            return failure('exited', 'The terminal exited before its AI composer became ready.');
        }
        const startedAt = Date.now();
        const deadline = startedAt + Math.max(1, deadlineMs);
        while (Date.now() < deadline) {
            if (signal?.aborted)
                return failure('cancelled', 'Send cancelled before the terminal became ready.');
            if (!backend.hasLiveInstance(terminalId)) {
                return failure('exited', 'The terminal exited before its AI composer became ready.');
            }
            const readiness = screen.readiness(kind);
            const activeTurnComposer = allowActiveTurnComposer &&
                readiness.ready &&
                ((kind === 'codex' && showsNewCodexWork(readiness.screen)) ||
                    (kind === 'grok' && screen.grokTurnRunning(readiness.screen)));
            if (readiness.ready &&
                Date.now() - startedAt >= (timing?.minObserveMs ?? MIN_OBSERVE_MS) &&
                (activeTurnComposer ||
                    Date.now() - screen.lastUpdatedAt >= (timing?.screenQuietMs ?? SCREEN_QUIET_MS))) {
                return { ok: true };
            }
            await new Promise((resolve) => setTimeout(resolve, timing?.pollMs ?? POLL_MS));
        }
        return failure('timeout', 'The AI composer did not become ready before the startup deadline.');
    }
    catch (error) {
        return failure('failed', error instanceof Error ? error.message : 'Failed while waiting for the AI terminal.');
    }
    finally {
        disposeResize();
        disposeOutput();
    }
}
