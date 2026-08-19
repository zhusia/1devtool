"use strict";
/**
 * Main-owned, origin-tagged terminal input serializer for Agent Teams.
 *
 * Terminal safety rules: docs/common-errors/terminals/INDEX.md (B1-B4, B11-B12, B17).
 * Keep every Team submission on the shared staged agent prompt writer.
 *
 * All ordinary input paths call `noteNonTeamInput` before their PTY write.
 * Team submissions use a lease epoch and the shared agent-aware prompt
 * sequencer. Revocation between text and Enter aborts the Enter and suppresses
 * the user's keystroke so it cannot be mixed into a partial team draft.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerminalInputSerializer = exports.SubmissionInterruptedError = void 0;
exports.buildSgrPrimaryClick = buildSgrPrimaryClick;
const agentPromptWrite_1 = require("../../shared/terminal/agentPromptWrite");
const contracts_1 = require("../../shared/terminal/contracts");
const node_crypto_1 = require("node:crypto");
const connectionProtocol_1 = require("../../shared/terminal/connectionProtocol");
const SUBMISSION_SETTLE_MS = 500;
const OPENTUI_FOCUS_SETTLE_MS = 75;
const TERMINAL_FOCUS_IN = '\x1b[I';
const WINDOWS_QUIET_WINDOW_MS = 120;
const WINDOWS_QUIET_POLL_MS = 40;
const WINDOWS_QUIET_MAX_WAIT_MS = 2_000;
const LINK_CORRELATION_MARKER_RE = /\[1devtool-message:lm-[A-Za-z0-9-]+\]/;
function flattenWindowsOpenTuiPrompt(prompt) {
    const flattened = prompt.replace(/\r\n?|\n/g, ' ');
    const marker = flattened.match(LINK_CORRELATION_MARKER_RE)?.[0];
    return marker && !flattened.startsWith(marker)
        ? `${marker} ${flattened}`
        : flattened;
}
/**
 * Cline's OpenTUI prompt handles mouse-down by focusing its textarea. After a
 * submit Cline 3.0.48 remounts that textarea, so a linked background send must
 * reproduce the same in-app focus gesture a real click would generate.
 */
function buildSgrPrimaryClick(position) {
    const column = Math.max(1, Math.trunc(position.column));
    const row = Math.max(1, Math.trunc(position.row));
    return `\x1b[<0;${column};${row}M\x1b[<0;${column};${row}m`;
}
class SubmissionInterruptedError extends Error {
    partial;
    constructor(partial) {
        super(partial
            ? 'Team submission was interrupted after prompt bytes were written'
            : 'Team submission lease was revoked before submit');
        this.partial = partial;
        this.name = 'SubmissionInterruptedError';
    }
}
exports.SubmissionInterruptedError = SubmissionInterruptedError;
class TerminalInputSerializer {
    getPtyBackend;
    onRevoked;
    platform;
    leases = new Map();
    constructor(getPtyBackend, onRevoked, platform = process.platform) {
        this.getPtyBackend = getPtyBackend;
        this.onRevoked = onRevoked;
        this.platform = platform;
    }
    state(terminalId) {
        let state = this.leases.get(terminalId);
        if (!state) {
            state = { epoch: 0, writeStarted: false, enterWritten: false };
            this.leases.set(terminalId, state);
        }
        return state;
    }
    /** Must run synchronously before the caller forwards ordinary input. */
    noteNonTeamInput(terminalId, origin = 'user') {
        // Xterm emits terminal-generated protocol replies through the same onData
        // event as keyboard/paste/mouse input. Replies must reach the PTY, but they
        // are not a human takeover and must not revoke the Team lease.
        if (origin === 'terminal-response')
            return { forward: true };
        const state = this.state(terminalId);
        const revokedRunId = state.runId;
        const partial = !!revokedRunId && state.writeStarted && !state.enterWritten;
        state.epoch += 1;
        state.runId = undefined;
        state.writeStarted = false;
        state.enterWritten = false;
        if (revokedRunId)
            this.onRevoked?.(terminalId, revokedRunId, partial);
        return {
            // Never mix a human/remote key into a half-written paced submission.
            forward: !partial,
            ...(revokedRunId ? { revokedRunId, partialSubmission: partial } : {}),
        };
    }
    currentEpoch(terminalId) {
        return this.state(terminalId).epoch;
    }
    release(terminalId, runId) {
        const state = this.state(terminalId);
        if (runId && state.runId !== runId)
            return;
        state.epoch += 1;
        state.runId = undefined;
        state.writeStarted = false;
        state.enterWritten = false;
    }
    async submitTeamPrompt(args) {
        const backend = this.getPtyBackend();
        const currentOwner = backend?.getOwnerIdentity(args.terminalId);
        const expectedOwner = args.expectedOwner ?? currentOwner;
        if (!backend || !expectedOwner || !(0, connectionProtocol_1.sameTerminalOwner)(currentOwner, expectedOwner)) {
            throw new Error('Delegate terminal is not running');
        }
        const state = this.state(args.terminalId);
        state.epoch += 1;
        const epoch = state.epoch;
        state.runId = args.runId;
        state.writeStarted = false;
        state.enterWritten = false;
        let interrupted = false;
        let promptBytesWritten = false;
        let enterWritten = false;
        let textWrittenAt = 0;
        let lastOutputAt = 0;
        let quietEnter = null;
        const fenceId = (0, node_crypto_1.randomUUID)();
        let partNumber = 0;
        let lastPart = null;
        let fenceTail = Promise.resolve();
        const trace = (event, detail = {}) => {
            if (process.env.ONEDEVTOOL_CONPTY_TRACE !== '1')
                return;
            console.info('[team-input]', JSON.stringify({
                at: Date.now(),
                event,
                terminalId: args.terminalId,
                runId: args.runId,
                fenceId,
                ...detail,
            }));
        };
        const disposeOutput = this.platform === 'win32'
            ? backend.onOutput(args.terminalId, () => { lastOutputAt = Date.now(); })
            : undefined;
        const rejectFence = (result) => {
            interrupted = true;
            const partial = result.bytesAttempted > 0 || result.completedParts > 0;
            if (partial)
                promptBytesWritten = true;
            throw new SubmissionInterruptedError(partial);
        };
        const writeFencedPart = async (data, kind) => {
            const live = this.state(args.terminalId);
            if (live.epoch !== epoch || live.runId !== args.runId) {
                interrupted = true;
                throw new SubmissionInterruptedError(promptBytesWritten && !enterWritten);
            }
            const part = {
                fenceId,
                terminalId: args.terminalId,
                expectedOwner,
                partNumber: ++partNumber,
                kind,
                data,
            };
            lastPart = part;
            if (kind === 'submit-enter')
                args.onSubmitEnter?.();
            const result = await backend.writeFenced(part);
            trace('part-completed', {
                partNumber: part.partNumber,
                kind,
                bytes: Buffer.byteLength(data, 'utf8'),
                status: result.status,
                bytesAttempted: result.bytesAttempted,
                bytesCompleted: result.bytesCompleted,
                chunksAttempted: result.chunksAttempted,
                chunksCompleted: result.chunksCompleted,
                enterAttempted: result.enterAttempted,
                enterPipeCompleted: result.enterPipeCompleted,
            });
            if (result.status !== 'pipe-completed')
                rejectFence(result);
            if (data)
                live.writeStarted = true;
            if (kind === 'prompt-bytes' && data) {
                promptBytesWritten = true;
                textWrittenAt = Date.now();
            }
            if (kind === 'submit-enter') {
                live.enterWritten = true;
                enterWritten = true;
            }
        };
        const queueFencedPart = (data, kind) => {
            fenceTail = fenceTail.then(() => writeFencedPart(data, kind));
            return fenceTail;
        };
        const writeEnterAfterWindowsQuiet = async () => {
            const startedAt = Date.now();
            let quietObserved = false;
            while (Date.now() - startedAt < WINDOWS_QUIET_MAX_WAIT_MS) {
                const live = this.state(args.terminalId);
                if (live.epoch !== epoch || live.runId !== args.runId) {
                    interrupted = true;
                    return;
                }
                if (lastOutputAt > textWrittenAt && Date.now() - lastOutputAt >= WINDOWS_QUIET_WINDOW_MS) {
                    quietObserved = true;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, WINDOWS_QUIET_POLL_MS));
            }
            const live = this.state(args.terminalId);
            if (live.epoch !== epoch || live.runId !== args.runId) {
                interrupted = true;
                return;
            }
            trace('windows-quiet-finished', {
                waitedMs: Date.now() - startedAt,
                quietObserved,
                outputAfterPromptCompletion: lastOutputAt > textWrittenAt,
            });
            await queueFencedPart('\r', 'submit-enter');
        };
        const guardedWrite = (data) => {
            const live = this.state(args.terminalId);
            if (live.epoch !== epoch || live.runId !== args.runId) {
                interrupted = true;
                return;
            }
            // `submitAgentPrompt` emits the submitting key as one exact token.
            // A Windows/PowerShell-originated prompt commonly contains CRLF inside
            // its body; treating any string containing `\r` as Enter discards that
            // entire prompt on the Windows quiet-wait branch and sends only a bare
            // Enter. Classify the control token, never prompt content.
            if (data === '\r') {
                if (this.platform === 'win32') {
                    // The generic 150 ms submit timer can fire while a callback-paced
                    // prompt is still crossing node-pty. Starting the quiet observer at
                    // that point leaves textWrittenAt at zero and can mistake old TUI
                    // output for post-prompt quiet, effectively placing Enter directly
                    // behind the last pipe callback. Anchor the quiet window behind the
                    // exact prompt-part completion instead.
                    if (!quietEnter) {
                        const promptCompletion = fenceTail;
                        quietEnter = promptCompletion.then(() => writeEnterAfterWindowsQuiet());
                        // If the prompt fence itself rejects, the main submission awaits
                        // and reports that rejection first. Mark this dependent promise
                        // handled as well so it cannot become a second unhandled error.
                        void quietEnter.catch(() => { });
                    }
                    return;
                }
                void queueFencedPart(data, 'submit-enter').catch(() => { });
                return;
            }
            void queueFencedPart(data, 'prompt-bytes').catch(() => { });
        };
        const timers = [];
        const schedule = (callback, delayMs) => {
            timers.push(setTimeout(callback, delayMs));
        };
        try {
            const kind = (0, contracts_1.getDeclaredAgentKind)(args.target.agentType, args.target.startupCommand);
            const shouldFocusCline = kind === 'cline' && args.composerPosition;
            const shouldFocusWindowsOpenTui = this.platform === 'win32'
                && (kind === 'grok' || kind === 'opencode')
                && args.composerPosition;
            if (shouldFocusCline || shouldFocusWindowsOpenTui) {
                // Cline consumes the in-app mouse press after its textarea remount.
                // Windows OpenTUI agents need both the terminal focus report and the
                // in-app press after a completed-turn remount. Flush before prompt
                // bytes so the next write belongs to the remounted composer.
                await queueFencedPart(shouldFocusWindowsOpenTui
                    ? `${TERMINAL_FOCUS_IN}${buildSgrPrimaryClick(args.composerPosition)}`
                    : buildSgrPrimaryClick(args.composerPosition), 'focus-gesture');
                const focusPart = lastPart;
                if (!focusPart)
                    throw new SubmissionInterruptedError(false);
                const focusFlush = await backend.flushFenced({ ...focusPart, finalize: false });
                if (focusFlush.status !== 'pipe-completed')
                    rejectFence(focusFlush);
                await new Promise((resolve) => setTimeout(resolve, OPENTUI_FOCUS_SETTLE_MS));
                const live = this.state(args.terminalId);
                if (live.epoch !== epoch || live.runId !== args.runId) {
                    throw new SubmissionInterruptedError(false);
                }
            }
            // Grok and OpenCode stop consuming bracketed multiline paste after the
            // first Windows OpenTUI input remount. Preserve the complete envelope as
            // ordinary typed text; other platforms retain the native multiline path.
            const prompt = this.platform === 'win32' && (kind === 'grok' || kind === 'opencode')
                ? flattenWindowsOpenTuiPrompt(args.prompt)
                : args.prompt;
            (0, agentPromptWrite_1.submitAgentPrompt)(guardedWrite, prompt, args.target, schedule, { clearExisting: false });
            await fenceTail;
            await new Promise((resolve) => setTimeout(resolve, SUBMISSION_SETTLE_MS));
            for (const timer of timers)
                clearTimeout(timer);
            if (quietEnter)
                await quietEnter;
            await fenceTail;
            const finalPart = lastPart;
            if (!finalPart)
                throw new SubmissionInterruptedError(false);
            const finalFlush = await backend.flushFenced({ ...finalPart, finalize: true });
            trace('fence-finalized', {
                partNumber: finalPart.partNumber,
                kind: finalPart.kind,
                status: finalFlush.status,
                bytesAttempted: finalFlush.bytesAttempted,
                bytesCompleted: finalFlush.bytesCompleted,
                chunksAttempted: finalFlush.chunksAttempted,
                chunksCompleted: finalFlush.chunksCompleted,
                enterAttempted: finalFlush.enterAttempted,
                enterPipeCompleted: finalFlush.enterPipeCompleted,
            });
            if (finalFlush.status !== 'pipe-completed')
                rejectFence(finalFlush);
            const live = this.state(args.terminalId);
            if (interrupted || live.epoch !== epoch || live.runId !== args.runId || !live.enterWritten) {
                throw new SubmissionInterruptedError(promptBytesWritten && !enterWritten);
            }
            return epoch;
        }
        finally {
            for (const timer of timers)
                clearTimeout(timer);
            disposeOutput?.();
        }
    }
}
exports.TerminalInputSerializer = TerminalInputSerializer;
