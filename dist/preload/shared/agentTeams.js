"use strict";
/**
 * Durable Agent Teams / Swarms contracts shared by the standalone CLI,
 * Electron main process, preload, and renderer.
 *
 * Topology (`team` vs `swarm`) and substrate (`terminal` vs `headless`) are
 * deliberately independent. Main resolves `auto` before provisioning and is
 * the only process allowed to mutate these state machines.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AGENT_ORCHESTRATION_AGGREGATE_CAP_CHARS = exports.AGENT_ORCHESTRATION_OUTPUT_CAP_CHARS = exports.AGENT_ORCHESTRATION_DEFAULT_CONCURRENCY = exports.AGENT_SWARM_DEFAULT_POOL = exports.AGENT_SWARM_MAX_WORKERS = exports.AGENT_TEAM_MAX_MEMBERS = void 0;
exports.isTerminalState = isTerminalState;
exports.AGENT_TEAM_MAX_MEMBERS = 8;
exports.AGENT_SWARM_MAX_WORKERS = 32;
exports.AGENT_SWARM_DEFAULT_POOL = 4;
exports.AGENT_ORCHESTRATION_DEFAULT_CONCURRENCY = 8;
exports.AGENT_ORCHESTRATION_OUTPUT_CAP_CHARS = 100_000;
exports.AGENT_ORCHESTRATION_AGGREGATE_CAP_CHARS = 200_000;
function isTerminalState(state) {
    return [
        'done', 'error', 'timed-out', 'submission-interrupted', 'uncertain',
        'interrupted', 'cancelled', 'discarded',
    ].includes(state);
}
