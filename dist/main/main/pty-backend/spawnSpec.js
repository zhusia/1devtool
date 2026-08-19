"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildSpawnSpec = buildSpawnSpec;
/*
 * SpawnSpec builder (docs/architecture/pty-daemon.md §3.3) — MAIN-ONLY policy: resolves
 * cwd, shell candidates, per-candidate env thunks, tmux decision, and startup
 * write. The fd owner (embedded PtyManager or the daemon) only executes it.
 */
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const contracts_1 = require("../../shared/terminal/contracts");
const mcpTerminalIdentity_1 = require("../../shared/mcpTerminalIdentity");
const pty_1 = require("../pty");
function resolveCwd(cwd) {
    try {
        if (cwd && fs_1.default.existsSync(cwd) && fs_1.default.statSync(cwd).isDirectory()) {
            return cwd;
        }
    }
    catch {
        // Fall through to safe defaults.
    }
    const home = os_1.default.homedir();
    if (home && fs_1.default.existsSync(home)) {
        return home;
    }
    return process.cwd();
}
function buildSpawnSpec(request, env, tmux) {
    const { terminalId, shell, command, agentType, forceAiAgent } = request;
    const tmuxMouseBehavior = (0, pty_1.normalizeTmuxMouseBehavior)(request.tmuxMouseBehavior);
    const useTmux = tmux.isAvailable() && (0, contracts_1.allowsTmux)(agentType, command, forceAiAgent);
    const declaredKind = (0, contracts_1.getDeclaredAgentKind)(agentType, command);
    const candidates = env.getShellCandidates(shell).map((executable) => ({
        executable,
        args: env.getShellArgs(executable),
        // Lazy: login-shell probes cost 200ms–3s per shell — only pay for
        // candidates actually attempted (see SpawnCandidate.resolveEnv).
        resolveEnv: () => (0, mcpTerminalIdentity_1.withOneDevToolTerminalEnv)((0, pty_1.applyTerminalEnvDefaults)(env.getShellEnv(executable), agentType, command), terminalId),
    }));
    const trimmedCommand = command?.trim();
    return {
        terminalId,
        cwd: resolveCwd(request.cwd),
        candidates,
        useTmux,
        tmux: useTmux
            ? {
                path: tmux.getPath() || 'tmux',
                sessionName: (0, pty_1.tmuxSessionNameForTerminal)(terminalId),
                supportsEnvFlag: tmux.supportsEnvFlag(),
            }
            : undefined,
        tmuxMouseBehavior,
        startupWrite: trimmedCommand ? `${trimmedCommand}\r` : undefined,
        // Alt-screen + mouse + paste modes are set ONCE at startup by these TUIs, so a
        // bounded pipe-buffer trim must re-emit them or a remount rebuilds the terminal
        // in the normal buffer with mouse reporting off (replay.ts
        // trimReplayBufferPreservingModes). Qwen Code 0.21's virtual viewport has the
        // same one-shot setup — `?1049h ?1002h ?1006h ?2004h` and nothing after.
        preserveOpenTuiReplayModes: ['cline', 'grok', 'hermes', 'qwen'].includes(declaredKind ?? ''),
        effectiveAgentKind: request.effectiveAgentKind ?? declaredKind ?? undefined,
        agentType,
    };
}
