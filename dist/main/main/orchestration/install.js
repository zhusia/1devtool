"use strict";
/**
 * One install coordinator for all three orchestration entry points — boot,
 * Settings → Reinstall, and the dashboard's Apply (docs/features/orchestration/dashboard.md §5).
 *
 * Invariants it exists to enforce (shim-stale-path.md skew class):
 *  1. Shim first; skill writes proceed ONLY when the shim result is `wrote`
 *     or `skipped-unchanged`.
 *  2. On shim `error` skills abort; on `skipped-dev-preserve` they are a
 *     complete no-op — shim and skill move in lockstep (a preserved v8-era
 *     shim + a v9 skill advertising `--category` would repeat the shipped
 *     `--model` skew).
 *  3. Promotion of draft → applied is the CALLER's job and only ever happens
 *     after this returns with a successful shim step (full Apply only).
 *  4. The Tasks skill runs through this coordinator for the single Reinstall
 *     button and the single status surface, but NOT through the shim gate: it
 *     documents onedevtool MCP tools, not the CLI, so it has no shim to be
 *     skewed against (docs/tasks_v2.md §6.3).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.runOrchestrationInstall = runOrchestrationInstall;
const shimInstall_1 = require("./shimInstall");
async function runOrchestrationInstall(deps, args) {
    // Tasks skills first, and outside every shim gate (invariant 4): they teach
    // the onedevtool MCP task tools, which are live whenever the app is. Sharing
    // the shim's dev-preserve/error gate would ship a build whose agents have the
    // tools and no instructions — the opposite of the skew the gate prevents.
    const tasksSkills = deps.installTasksSkills?.(args.targets) ?? [];
    const nodeBin = await deps.resolveNodeBin();
    const shim = (0, shimInstall_1.installOrchestratorShim)(nodeBin, { force: args.force });
    if (shim.status === 'error') {
        return { shim, skills: [], skillsSkipped: 'shim-error', tasksSkills };
    }
    if (shim.status === 'skipped-dev-preserve') {
        // Complete no-op for orchestration skills: the preserved shim executes an
        // OLDER CLI, so rewriting them to this build's docs would advertise flags
        // it rejects.
        return { shim, skills: [], skillsSkipped: 'dev-preserve', tasksSkills };
    }
    const nativeHook = deps.installNativeHooks?.(shim.shimPath, nodeBin);
    const skills = deps.installSkills(shim.shimPath, args.policy, args.targets);
    return { shim, skills, tasksSkills, ...(nativeHook ? { nativeHook } : {}) };
}
