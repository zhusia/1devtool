"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DECOMPOSE_TERMINAL_TIMEOUT_S = void 0;
exports.runDecomposeInTerminal = runDecomposeInTerminal;
const crypto_1 = require("crypto");
/** Planning is a read-shaped turn; a slow one is still usually under a minute. */
exports.DECOMPOSE_TERMINAL_TIMEOUT_S = 240;
async function runDecomposeInTerminal(deps, input) {
    if (input.signal?.aborted) {
        return { ok: false, error: 'the decomposition was interrupted' };
    }
    const controller = deps.getController();
    if (!controller)
        return { ok: false, error: 'the orchestration control plane is unavailable' };
    const adoptable = controller.adoptableTerminalTarget(input.terminalId);
    if (!adoptable.ok)
        return { ok: false, error: adoptable.error };
    if (adoptable.projectId !== input.projectId) {
        return {
            ok: false,
            error: `"${adoptable.name}" belongs to another project — it would plan against the wrong repo`,
        };
    }
    const principal = await deps.hostPrincipal.principal(input.projectId);
    const started = await controller.startTeam(principal, {
        clientRequestId: `tasks-decompose-${(0, crypto_1.randomUUID)()}`,
        members: [{
                target: adoptable.target,
                prompt: input.prompt,
                terminalId: input.terminalId,
                // The human chose this terminal. An `auto` preference resolving to a
                // headless runtime would answer a different question than the one asked.
                substrate: 'terminal',
                runtimePreference: 'native-terminal',
            }],
        closeTerminalsOnStop: false,
    });
    if (!started.ok || !started.orchestration || !started.runs?.length) {
        return { ok: false, error: started.error ?? 'that terminal did not accept the prompt' };
    }
    const orchestrationId = started.orchestration.topology === 'team' ? started.orchestration.teamId : '';
    const runId = started.runs[0].runId;
    const timeoutMs = (input.timeoutSeconds ?? exports.DECOMPOSE_TERMINAL_TIMEOUT_S) * 1000;
    try {
        const collect = controller.collectRun(principal, runId, timeoutMs);
        let removeAbortListener;
        const collected = input.signal
            ? await Promise.race([
                collect,
                new Promise((_, reject) => {
                    const abort = () => reject(new Error('the decomposition was interrupted'));
                    if (input.signal.aborted) {
                        abort();
                        return;
                    }
                    input.signal.addEventListener('abort', abort, { once: true });
                    removeAbortListener = () => input.signal.removeEventListener('abort', abort);
                }),
            ]).finally(() => removeAbortListener?.())
            : await collect;
        if (collected.stillRunning) {
            return {
                ok: false,
                error: 'that terminal is still working — check it, then propose again',
            };
        }
        if (!collected.ok) {
            return { ok: false, error: collected.error || `the run ended ${collected.state ?? 'unexpectedly'}` };
        }
        return { ok: true, ...(collected.output ? { output: collected.output } : {}) };
    }
    finally {
        // Release the claim whatever happened above. A decomposition team has no
        // reason to outlive the proposal, and leaving one behind would make the
        // terminal look "already owned by another orchestration" to the next
        // assign — the exact failure this path is most likely to cause.
        if (orchestrationId) {
            await controller.stop(principal, orchestrationId, false).catch(() => { });
        }
    }
}
