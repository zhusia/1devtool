"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RemotePromptSubmitCoordinator = exports.ProgrammaticPromptSubmissionError = void 0;
/**
 * Main-owned completion boundary for full prompts submitted by Remote Control.
 *
 * A phone prompt is one logical takeover even though an agent-safe submit is
 * emitted as several timed PTY writes. Claim the non-Team input lease once,
 * serialize complete prompts per terminal, and do not report success until the
 * final staged write has reached the PTY owner.
 */
const agentPromptWrite_1 = require("../../shared/terminal/agentPromptWrite");
const node_crypto_1 = require("node:crypto");
const TERMINAL_NOT_RUNNING_ERROR = 'The terminal connection is not running. Refresh the terminal and try again.';
const PROMPT_TAKEOVER_BLOCKED_ERROR = 'Another staged prompt was still being delivered. Nothing was sent; try again.';
class ProgrammaticPromptSubmissionError extends Error {
    code;
    completedParts;
    enterPipeCompleted;
    constructor(code, completedParts, enterPipeCompleted) {
        super(code === 'owner-changed' || code === 'capability-unavailable'
            ? 'The terminal transport was unavailable before the prompt was written. Nothing was sent.'
            : 'The terminal transport became uncertain during prompt delivery. Submission was not retried.');
        this.code = code;
        this.completedParts = completedParts;
        this.enterPipeCompleted = enterPipeCompleted;
        this.name = 'ProgrammaticPromptSubmissionError';
    }
}
exports.ProgrammaticPromptSubmissionError = ProgrammaticPromptSubmissionError;
const defaultWait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));
class RemotePromptSubmitCoordinator {
    tails = new Map();
    backend;
    claimInput;
    wait;
    constructor(options) {
        this.backend = options.backend;
        this.claimInput = options.claimInput;
        this.wait = options.wait ?? defaultWait;
    }
    /**
     * Queue a complete prompt behind any prompt already staging into the same
     * terminal. Different terminals remain independent.
     */
    submit(request) {
        const previous = this.tails.get(request.terminalId) ?? Promise.resolve();
        const delivery = previous
            .catch(() => { })
            .then(() => this.deliver(request));
        const tracked = delivery.finally(() => {
            if (this.tails.get(request.terminalId) === tracked) {
                this.tails.delete(request.terminalId);
            }
        });
        this.tails.set(request.terminalId, tracked);
        return tracked;
    }
    async deliver({ terminalId, text, target }) {
        const expectedOwner = this.backend.getOwnerIdentity(terminalId);
        if (!expectedOwner) {
            throw new Error(TERMINAL_NOT_RUNNING_ERROR);
        }
        if (this.claimInput && !this.claimInput(terminalId, text)) {
            throw new Error(PROMPT_TAKEOVER_BLOCKED_ERROR);
        }
        const scheduled = [];
        let scheduleOrder = 0;
        const schedule = (callback, delayMs) => {
            scheduled.push({ callback, delayMs: Math.max(0, delayMs), order: scheduleOrder++ });
        };
        const fenceId = (0, node_crypto_1.randomUUID)();
        let partNumber = 0;
        let lastPart = null;
        let lastResult = {
            status: 'pipe-completed',
            attemptedParts: 0,
            completedParts: 0,
            bytesAttempted: 0,
            bytesCompleted: 0,
            chunksAttempted: 0,
            chunksCompleted: 0,
            enterAttempted: false,
            enterPipeCompleted: false,
        };
        let writeTail = Promise.resolve();
        const assertAccepted = (result) => {
            lastResult = result;
            if (result.status !== 'pipe-completed') {
                throw new ProgrammaticPromptSubmissionError(result.status, result.completedParts, result.enterPipeCompleted);
            }
        };
        const write = (data) => {
            const part = {
                fenceId,
                terminalId,
                expectedOwner,
                partNumber: ++partNumber,
                kind: data.includes('\r') ? 'submit-enter' : 'prompt-bytes',
                data,
            };
            lastPart = part;
            writeTail = writeTail.then(async () => assertAccepted(await this.backend.writeFenced(part)));
        };
        // Remote owns a separate phone composer, so Claude must never receive the
        // empty-composer Esc-Esc/Rewind shortcut here.
        (0, agentPromptWrite_1.submitAgentPrompt)(write, text, target, schedule, { clearExisting: false });
        await writeTail;
        scheduled.sort((left, right) => left.delayMs - right.delayMs || left.order - right.order);
        let previousDelayMs = 0;
        for (const entry of scheduled) {
            // Preserve the gap between actual writes. Absolute deadlines collapse
            // after an event-loop stall and can put text + Enter back-to-back.
            const gapMs = Math.max(0, entry.delayMs - previousDelayMs);
            if (gapMs > 0)
                await this.wait(gapMs);
            entry.callback();
            await writeTail;
            previousDelayMs = entry.delayMs;
        }
        if (!lastPart)
            throw new Error(TERMINAL_NOT_RUNNING_ERROR);
        assertAccepted(await this.backend.flushFenced(lastPart));
        if (lastResult.status !== 'pipe-completed')
            throw new Error(TERMINAL_NOT_RUNNING_ERROR);
    }
}
exports.RemotePromptSubmitCoordinator = RemotePromptSubmitCoordinator;
