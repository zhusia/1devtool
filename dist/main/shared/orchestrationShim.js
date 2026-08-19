"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ORCHESTRATOR_SHIM_NAME_WIN = exports.ORCHESTRATOR_SHIM_NAME_UNIX = exports.ORCHESTRATOR_SHIM_GENERATION = void 0;
exports.buildOrchestratorShimContent = buildOrchestratorShimContent;
/**
 * Generation-pinned orchestration shim names shared by installers and native
 * agent hooks. Bump the generation whenever skill prose starts requiring a
 * changed `1devtool-agent` command surface.
 */
// v3: adds whoami, link send/status, and run's --no-link guard (orchestration
// v4). A v2 shim may target an older packaged app whose CLI rejects `link` —
// the observed field failure — so nudges/skills that document these verbs must
// pin a shim generation whose target is guaranteed to serve them.
// v4: `link send` gains `--reply-token` (single-use reply attribution for
// daemon-hosted agents). parseArgs is strict, so an older pinned CLI would
// hard-fail the exact command the new envelopes tell peers to run — same
// failure class as the v2→v3 verb change, same remedy.
// v5: agents may request (but never mint) a generation-bound terminal link
// with `link request`; an older pinned CLI would reject that strict verb.
// v6: transport-authenticated pull verbs (`link peers/read/screen/peek/notes`
// and endpoint-bound `link publish`) are available on proven platforms.
// v7: Team member selectors (`team peers/read/screen/peek/notes`) adapt onto
// that same authenticated, consented terminal-link graph.
// v8: hierarchy `report [--blocked]` (orchestration v5). Role nudges and the
// skill teach seated agents to run it; a v7 shim's strict parseArgs would
// hard-fail with `unknown subcommand: report` — the v2→v3 failure class.
// v9: Pipeline adds the `handoff` alias, structured `link send --gate`, and
// `report --continue/--complete`; strict older CLIs reject every one.
exports.ORCHESTRATOR_SHIM_GENERATION = 9;
exports.ORCHESTRATOR_SHIM_NAME_UNIX = `1devtool-agent-v${exports.ORCHESTRATOR_SHIM_GENERATION}`;
exports.ORCHESTRATOR_SHIM_NAME_WIN = `1devtool-agent-v${exports.ORCHESTRATOR_SHIM_GENERATION}.cmd`;
/**
 * The exact bytes of the shim file — pure so tests can pin both platforms'
 * shapes without Electron. Quoting matters: paths regularly contain spaces
 * (`C:\Program Files`, `Application Support`).
 */
function buildOrchestratorShimContent(target, isWindows) {
    if (isWindows) {
        return target.runAsNode
            ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${target.runtime}" "${target.cliPath}" %*\r\n`
            : `@echo off\r\n"${target.runtime}" "${target.cliPath}" %*\r\n`;
    }
    return target.runAsNode
        ? `#!/usr/bin/env sh\nELECTRON_RUN_AS_NODE=1 exec "${target.runtime}" "${target.cliPath}" "$@"\n`
        : `#!/usr/bin/env sh\nexec "${target.runtime}" "${target.cliPath}" "$@"\n`;
}
