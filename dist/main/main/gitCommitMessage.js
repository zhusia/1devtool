"use strict";
/**
 * "Generate Commit Message" service for the git client dialog. Reads the
 * staged diff (working-tree diff when nothing is staged — matching the commit
 * flow, which auto-stages `-A`), then asks an installed AI CLI in headless
 * mode for a Conventional Commits message. Never throws across IPC: every
 * outcome is a structured `GenerateCommitMessageResult`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateCommitMessage = generateCommitMessage;
const gitCommitMessage_1 = require("../shared/gitCommitMessage");
const headlessMode_1 = require("../shared/headlessMode");
const runHeadlessAgent_1 = require("./orchestration/runHeadlessAgent");
const GENERATE_TIMEOUT_S = 90;
// One generation per repo: a newer request (regenerate, repo switch) aborts
// the CLI still running for the previous one instead of stacking processes.
const inFlightByRepo = new Map();
async function generateCommitMessage(deps, request) {
    try {
        return await generate(deps, request);
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
async function generate(deps, request) {
    const { gitManager } = deps;
    const { repoPath } = request;
    // Probing calls must not surface git failures as thrown IPC errors — an
    // empty diff simply falls through to the next candidate range.
    const gitOptions = { ...(request.gitOptions ?? {}), $nullOnError: true };
    let diff = await gitManager.getDiff(repoPath, undefined, true, gitOptions);
    let usedFallbackDiff = false;
    let statArgs = ['--cached', '--stat'];
    if (!diff.trim()) {
        usedFallbackDiff = true;
        diff = (await gitManager.run(repoPath, 'diff', gitOptions, 'HEAD'))?.stdout || '';
        statArgs = ['HEAD', '--stat'];
        if (!diff.trim()) {
            // A repo without a commit yet has no HEAD to diff against.
            diff = (await gitManager.run(repoPath, 'diff', gitOptions))?.stdout || '';
            statArgs = ['--stat'];
        }
    }
    const diffStat = (await gitManager.run(repoPath, 'diff', gitOptions, ...statArgs))?.stdout || '';
    // Untracked files appear in no diff, but commit auto-stages them when
    // nothing is staged — name them so brand-new files still get described.
    let untrackedFiles = [];
    if (usedFallbackDiff) {
        const status = (await gitManager.run(repoPath, 'status', gitOptions, '--porcelain'))?.stdout || '';
        untrackedFiles = status
            .split('\n')
            .filter((line) => line.startsWith('?? '))
            .map((line) => line.slice(3).trim())
            .filter(Boolean);
    }
    if (!diff.trim() && untrackedFiles.length === 0) {
        return { ok: false, error: 'No changes to describe — modify or stage files first.' };
    }
    const registry = deps.getCliRegistry();
    if (!registry) {
        return { ok: false, error: 'CLI detection has not finished yet — try again in a moment.' };
    }
    // A pinned agent is an explicit user choice — honor it or fail with its
    // name; never silently substitute another CLI.
    const settings = request.settings;
    const pinnedId = settings?.agentId && settings.agentId !== 'auto' ? settings.agentId : null;
    if (pinnedId && !headlessMode_1.HEADLESS_SPECS[pinnedId]) {
        return { ok: false, error: `"${pinnedId}" has no headless mode — pick another agent in the generate settings.` };
    }
    const registrations = new Map(registry.list().map((r) => [r.cliId, r]));
    const candidates = (pinnedId ? [pinnedId] : gitCommitMessage_1.COMMIT_MESSAGE_AGENT_ORDER).filter((id) => {
        if (!headlessMode_1.HEADLESS_SPECS[id])
            return false;
        if (pinnedId)
            return true;
        const reg = registrations.get(id);
        return !!reg?.selectedPath && (reg.state === 'detected' || reg.state === 'override');
    });
    let chosen = null;
    for (const id of candidates) {
        const binary = await registry.getCliBinary(id);
        if (binary.ok) {
            chosen = { id, binaryPath: binary.path };
            break;
        }
    }
    if (!chosen) {
        return pinnedId
            ? {
                ok: false,
                error: `"${pinnedId}" is selected in the generate settings but was not found — install it or pick another agent.`,
            }
            : {
                ok: false,
                error: 'No AI CLI found. Install Claude Code, Codex, Gemini CLI, or another supported agent, then retry.',
            };
    }
    const prompt = (0, gitCommitMessage_1.buildCommitMessagePrompt)({
        diff,
        diffStat,
        untrackedFiles,
        avoidSummaries: request.avoidSummaries,
        style: settings?.style,
        diffCharLimit: settings?.diffCharLimit,
    });
    inFlightByRepo.get(repoPath)?.abort();
    const ctl = new AbortController();
    inFlightByRepo.set(repoPath, ctl);
    try {
        const result = await (0, runHeadlessAgent_1.runHeadlessAgent)({
            agentId: chosen.id,
            prompt,
            cwd: repoPath,
            binaryPath: chosen.binaryPath,
            signal: ctl.signal,
            timeoutSeconds: GENERATE_TIMEOUT_S,
        });
        if (ctl.signal.aborted && !result.timedOut) {
            return { ok: false, error: 'Superseded by a newer generate request.' };
        }
        if (result.timedOut) {
            return { ok: false, error: `${chosen.id} timed out generating the commit message.` };
        }
        if (result.exitCode !== 0) {
            const detail = result.stderr ? `: ${result.stderr.slice(0, 300)}` : '';
            return { ok: false, error: `${chosen.id} failed (exit ${result.exitCode})${detail}` };
        }
        const parsed = (0, gitCommitMessage_1.parseCommitMessageOutput)(result.output);
        if (!parsed) {
            return { ok: false, error: `${chosen.id} returned no usable commit message.` };
        }
        return { ok: true, ...parsed, agent: chosen.id, usedFallbackDiff };
    }
    finally {
        if (inFlightByRepo.get(repoPath) === ctl)
            inFlightByRepo.delete(repoPath);
    }
}
