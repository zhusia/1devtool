"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskDispatcher = void 0;
exports.composeVerdictNudge = composeVerdictNudge;
const crypto_1 = require("crypto");
const prompt_1 = require("./prompt");
const dispatchGrant_1 = require("./dispatchGrant");
/**
 * `dispatchTask` — the thin façade (docs/tasks_v2.md §4.7).
 *
 * Rev 5 wanted a dispatch API that could adopt an arbitrary terminal; review
 * showed that is not implementable within the current model — `topology` and
 * `newRun()` are Team-or-Swarm-only, and authorization, unit lookup, terminal
 * claims, completion and fallback all require the parent unit. So v2 took the
 * narrow contract: **every dispatch is a singleton Team**, and follow-ups go
 * through the member channel.
 *
 * That contract still holds; what changed is the conclusion drawn from it.
 * Adoption never needed a run "outside a Team" — it needs a Team member that
 * starts already bound to a live terminal, which `runTerminalUnit` has always
 * supported (it is the same branch a recovered member takes). So the third
 * target, `existing-terminal`, is this same path with the spawn skipped: same
 * sentinel host, same grant, same binding, and two rules the controller
 * enforces because the terminal is the human's — it is never killed on stop or
 * fallback, and a terminal that has since exited fails rather than being
 * silently respawned.
 *
 * This façade owns nothing the controller does not already do. It validates
 * targets, builds the prompt in main, checks the human's grant, and records the
 * binding — which is the one thing the controller genuinely does not know
 * about, because snapshots carry no `taskId`.
 */
/**
 * The message an agent receives when a human answers its gate.
 *
 * The human's words travel VERBATIM (§5.2) — never summarized, never
 * paraphrased into an instruction. A verdict that says "not like that, do X"
 * is the whole point of the gate, and rewriting it is how that value is lost.
 */
function composeVerdictNudge(input) {
    const { gate } = input;
    const lines = [
        `A human answered your ${gate.kind} request on task ${input.taskId} (${input.title}).`,
        '',
        `Verdict: ${gate.verdict}`,
    ];
    if (gate.response)
        lines.push('', 'They said:', gate.response);
    lines.push('');
    switch (gate.verdict) {
        case 'approved':
            lines.push(gate.kind === 'plan'
                ? 'Go ahead and implement the plan as approved.'
                : 'Approved. Nothing further is needed on this task unless you were mid-work.');
            break;
        case 'changes-requested':
            lines.push('Revise according to their words above, then come back through the same gate.');
            break;
        case 'declined':
            lines.push('This is declined and the task is cancelled. Stop work on it and do not reopen it yourself.');
            break;
        case 'timeout':
            lines.push('Nobody answered in time, so the task is blocked. Do not proceed as if approved.');
            break;
        default:
            break;
    }
    return lines.join('\n');
}
class TaskDispatcher {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * The exact prompt `assign` would send. Writes nothing. The fingerprint
     * returned here is included in the action tuple minted from the eventual
     * Assign click; if the task changes first, dispatch fails closed.
     */
    async preview(input) {
        const built = await this.build(input.taskId, input.overrides);
        if (!built.ok)
            return built;
        // Say why a target cannot take this task while the dialog is still open,
        // rather than minting a grant for a dispatch that will be refused. Assign
        // re-checks — this is a better error, never the authorization.
        const reachable = this.targetReachable(input.target, built.task.projectId);
        if (!reachable.ok)
            return { ok: false, error: reachable.error };
        return {
            ok: true,
            preview: {
                taskId: input.taskId,
                prompt: built.prompt,
                promptFingerprint: built.fingerprint,
                gates: built.gates,
                target: input.target,
            },
        };
    }
    /**
     * Dispatch. Carries no prompt from the renderer by design — main rebuilds it
     * and compares fingerprints, so there is no field through which something
     * other than the task could be sent.
     */
    async assign(input) {
        const check = (0, dispatchGrant_1.consumeTaskActionGrant)(input.grant, {
            action: 'assign',
            taskId: input.taskId,
            target: input.target,
            promptFingerprint: input.promptFingerprint,
            ...(input.overrides ? { overrides: input.overrides } : {}),
        });
        if (!check.ok)
            return { ok: false, error: check.error, code: check.code };
        const built = await this.build(input.taskId, input.overrides);
        if (!built.ok)
            return { ok: false, error: built.error };
        if (built.fingerprint !== input.promptFingerprint) {
            return {
                ok: false,
                code: 'content-drift',
                error: 'this task changed after you reviewed it — open the assign dialog again',
            };
        }
        const controller = this.deps.getController();
        if (!controller)
            return { ok: false, error: 'orchestration is not available in this session' };
        const { task } = built;
        const previouslyHeld = await this.deps.manager.prepareDispatchPlanHold(input.taskId, built.gates.plan);
        let dispatched;
        try {
            dispatched = input.target.kind === 'new-terminal'
                ? await this.startSingletonTeam(controller, task.projectId, input.target, built.prompt)
                : input.target.kind === 'existing-terminal'
                    ? await this.adoptTerminal(controller, task.projectId, input.target, built.prompt)
                    : await this.sendToMember(controller, task.projectId, input.target, built.prompt);
        }
        catch (error) {
            await this.deps.manager.restoreDispatchPlanHold(input.taskId, previouslyHeld);
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        if (!dispatched.ok) {
            await this.deps.manager.restoreDispatchPlanHold(input.taskId, previouslyHeld);
            return dispatched;
        }
        try {
            await this.bind(input.taskId, dispatched.run, dispatched.teamId);
        }
        catch (error) {
            // A running-but-unbound prompt violates the central Tasks invariant.
            // Stop the Tasks-owned team (the terminal itself is retained by its
            // manifest) and fail visibly instead of pretending assignment succeeded.
            try {
                const principal = await this.deps.hostPrincipal.principal(task.projectId);
                await controller.stop(principal, dispatched.teamId, false);
            }
            catch { /* the binding failure is still the primary error */ }
            await this.deps.manager.restoreDispatchPlanHold(input.taskId, previouslyHeld);
            return {
                ok: false,
                error: `the run started but could not be bound to the task: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
        return {
            ok: true,
            runId: dispatched.run.runId,
            teamId: dispatched.teamId,
            ...(dispatched.run.terminalId ? { terminalId: dispatched.run.terminalId } : {}),
        };
    }
    /**
     * Clear the assignment. Does not stop a live run — ending work is Mission
     * Control's job, and pretending otherwise here would give Tasks a second,
     * weaker control plane over the same run.
     */
    async unassign(taskId) {
        const found = await this.deps.manager.get(taskId);
        if (!found)
            return { ok: false, error: `task not found: ${taskId}` };
        await this.deps.manager.setAssignee(taskId, null);
        await this.deps.manager.comment(taskId, { kind: 'human', id: 'me', label: 'me' }, 'unassigned', 'claimed');
        return { ok: true };
    }
    /**
     * Leg 2 of verdict delivery (§5.2): the agent's turn is usually over by the
     * time a human answers a done gate, so the verdict is nudged to the terminal
     * the task is bound to.
     *
     * It goes through `send()` — the same member channel a dispatch uses — for
     * the reasons §4.7 spells out: never a raw `pty.write`, and never a submit
     * that races the agent's current turn. A busy member queues behind its own
     * run. Failure is not fatal and deliberately not retried: leg 3 already put
     * the verdict in the record, so an agent that never receives this still
     * finds it on the next `tasks_get`.
     */
    async nudgeVerdict(taskId, gate) {
        const controller = this.deps.getController();
        if (!controller)
            return { delivered: false, reason: 'orchestration unavailable' };
        const authority = await this.deps.manager.authorityOf(taskId);
        // The most recent bound run that knows which member to talk to.
        const bound = [...authority.runs].reverse().find((run) => run.orchestrationId && run.memberId);
        if (!bound?.orchestrationId || !bound.memberId) {
            return { delivered: false, reason: 'this task has no dispatched terminal to notify' };
        }
        const found = await this.deps.manager.get(taskId);
        if (!found)
            return { delivered: false, reason: 'task not found' };
        const principal = await this.deps.hostPrincipal.principal(found.task.projectId);
        const sent = await controller.send(principal, {
            teamId: bound.orchestrationId,
            memberId: bound.memberId,
            submissionId: `tasks-verdict-${gate.id}`,
            prompt: composeVerdictNudge({ taskId, title: found.task.title, gate }),
        });
        return sent.ok ? { delivered: true } : { delivered: false, reason: sent.error ?? 'send failed' };
    }
    /**
     * Tell the terminal working a merged-away task which task survived (§4.6).
     *
     * Without this an agent keeps working an id that no longer names anything —
     * its next `tasks_get` would redirect, but it has no reason to call one. Same
     * channel and same best-effort contract as a verdict nudge.
     */
    async nudgeMerged(mergedId, survivorId) {
        const controller = this.deps.getController();
        if (!controller)
            return { delivered: false, reason: 'orchestration unavailable' };
        const authority = await this.deps.manager.authorityOf(mergedId);
        const bound = [...authority.runs].reverse().find((run) => run.orchestrationId && run.memberId);
        if (!bound?.orchestrationId || !bound.memberId) {
            return { delivered: false, reason: 'nobody was working that task' };
        }
        const survivor = await this.deps.manager.get(survivorId);
        if (!survivor)
            return { delivered: false, reason: 'survivor not found' };
        const principal = await this.deps.hostPrincipal.principal(survivor.task.projectId);
        const sent = await controller.send(principal, {
            teamId: bound.orchestrationId,
            memberId: bound.memberId,
            submissionId: `tasks-merged-${mergedId}`,
            prompt: [
                `Task ${mergedId} was merged into ${survivorId} ("${survivor.task.title}").`,
                '',
                'Everything from the old task — body, acceptance criteria, activity — is on the survivor.',
                `Continue there: call tasks_get ${survivorId}. The old id still resolves, so anything you`,
                'already wrote referring to it is not lost.',
            ].join('\n'),
        });
        return sent.ok ? { delivered: true } : { delivered: false, reason: sent.error ?? 'send failed' };
    }
    // --- internals ------------------------------------------------------------
    async build(taskId, overrides) {
        const found = await this.deps.manager.get(taskId);
        if (!found)
            return { ok: false, error: `task not found: ${taskId}` };
        const authority = await this.deps.manager.authorityOf(taskId);
        if (authority.holds.includes('spec')) {
            return { ok: false, error: 'this task is on a spec hold — approve it before dispatching' };
        }
        const gateBlock = await this.deps.manager.dispatchGateBlock(taskId);
        if (gateBlock)
            return { ok: false, error: gateBlock };
        const policy = await this.deps.manager.effectivePolicy(found.task.projectId, found.task.repoRoot);
        const gates = {
            plan: overrides?.plan ?? policy.gates.plan,
            done: overrides?.done ?? policy.gates.done,
        };
        const rows = await this.deps.manager.list({ scope: { kind: 'all' } });
        const blockers = found.task.deps.blockedBy
            .map((id) => rows.find((row) => row.id === id))
            .filter((row) => Boolean(row))
            .map((row) => ({ id: row.id, title: row.title, status: row.status }));
        const prompt = (0, prompt_1.buildTaskPrompt)({ task: found.task, gates, blockers });
        return { ok: true, task: found.task, prompt, fingerprint: (0, dispatchGrant_1.fingerprintPrompt)(prompt), gates };
    }
    /**
     * One team, one member. Hosted by the main-owned sentinel — never by a
     * terminal, and a caller asking to host on one is refused rather than
     * quietly obliged.
     */
    async startSingletonTeam(controller, projectId, target, prompt) {
        // Spawning into a sibling member project (workspace_control 05 §5): legal
        // only under a shared workspace; the manifest goes workspace-scoped so the
        // controller enforces membership + member cwd at admission (P0b).
        const spawnProjectId = target.projectId && target.projectId !== projectId ? target.projectId : null;
        const spawnWorkspace = spawnProjectId
            ? this.deps.sharedWorkspaceFor?.(projectId, spawnProjectId) ?? null
            : null;
        if (spawnProjectId && !spawnWorkspace) {
            return { ok: false, code: 'target-invalid', error: 'that project does not share a workspace with this task' };
        }
        const principal = await this.deps.hostPrincipal.principal(projectId);
        const started = await controller.startTeam(principal, {
            clientRequestId: `tasks-${(0, crypto_1.randomUUID)()}`,
            ...(spawnWorkspace ? { workspaceId: spawnWorkspace.workspaceId } : {}),
            members: [{
                    target: target.agent,
                    prompt,
                    ...(spawnWorkspace && spawnProjectId ? { projectId: spawnProjectId } : {}),
                    // Tasks attribution and tools are terminal-identity based. Never let
                    // the user's global orchestration runtime preference turn this into a
                    // structured/headless run with no terminalId.
                    substrate: 'terminal',
                    runtimePreference: 'native-terminal',
                    ...(target.model ? { model: target.model } : {}),
                    // The user's own startup command for this agent, when they picked one.
                    // Main resolves the id against preferences — the renderer never sends
                    // a command, so this cannot become an arbitrary spawn.
                    ...(target.presetId ? { startupPresetId: target.presetId } : {}),
                }],
            // A Tasks terminal outlives its first run: the agent keeps working the
            // task, and `tasks_next` hands it the next one. Closing on stop would
            // throw away the session continuity the whole loop depends on.
            closeTerminalsOnStop: false,
        });
        if (!started.ok || !started.orchestration || !started.runs?.length) {
            return { ok: false, error: started.error ?? 'the team did not start', code: 'target-invalid' };
        }
        const teamId = started.orchestration.topology === 'team' ? started.orchestration.teamId : '';
        if (!teamId)
            return { ok: false, error: 'dispatch produced a non-team orchestration' };
        return { ok: true, run: started.runs[0], teamId };
    }
    /**
     * Can this target take work right now? Advisory only — `assign` revalidates
     * through the controller, which is where the answer is authoritative.
     */
    targetReachable(target, projectId) {
        if (target.kind === 'new-terminal') {
            if (!target.projectId || target.projectId === projectId)
                return { ok: true };
            return this.deps.sharedWorkspaceFor?.(projectId, target.projectId)
                ? { ok: true }
                : { ok: false, error: 'that project does not share a workspace with this task' };
        }
        if (target.kind !== 'existing-terminal')
            return { ok: true };
        const controller = this.deps.getController();
        if (!controller)
            return { ok: false, error: 'orchestration is not available in this session' };
        const adoptable = controller.adoptableTerminalTarget(target.terminalId);
        if (!adoptable.ok)
            return adoptable;
        if (adoptable.projectId !== projectId && !this.deps.sharedWorkspaceFor?.(projectId, adoptable.projectId)) {
            return { ok: false, error: `"${adoptable.name}" belongs to another project outside this task's workspace` };
        }
        return { ok: true };
    }
    /**
     * Dispatch into a terminal the user opened themselves (§4.7 adoption).
     *
     * Structurally identical to the spawn path — singleton Team, sentinel host,
     * the same binding — with one member that starts already bound to that
     * terminal. Everything specific to adoption is a refusal: the terminal must
     * still exist, still be running an AI agent this app can write to, belong to
     * THIS task's project, and be owned by nobody else. The controller is the
     * authority on all of that; asking it here only buys a better error than
     * "the team did not start".
     */
    async adoptTerminal(controller, projectId, target, prompt) {
        const adoptable = controller.adoptableTerminalTarget(target.terminalId);
        if (!adoptable.ok)
            return { ok: false, error: adoptable.error, code: 'target-invalid' };
        // Cross-project adoption is legal exactly when a shared workspace covers
        // both the task's home and the terminal's project (workspace_control 05
        // §5). The team then starts WORKSPACE-SCOPED, so the controller
        // re-validates membership and per-member project identity at admission —
        // this check buys a better error, never the authorization.
        const sharedWorkspace = adoptable.projectId !== projectId
            ? this.deps.sharedWorkspaceFor?.(projectId, adoptable.projectId) ?? null
            : null;
        if (adoptable.projectId !== projectId && !sharedWorkspace) {
            return {
                ok: false,
                code: 'target-invalid',
                error: `"${adoptable.name}" belongs to another project outside this task's workspace — a dispatch would run this task in the wrong repo`,
            };
        }
        const principal = await this.deps.hostPrincipal.principal(projectId);
        const started = await controller.startTeam(principal, {
            clientRequestId: `tasks-${(0, crypto_1.randomUUID)()}`,
            ...(sharedWorkspace ? { workspaceId: sharedWorkspace.workspaceId } : {}),
            members: [{
                    target: adoptable.target,
                    prompt,
                    terminalId: target.terminalId,
                    ...(sharedWorkspace ? { projectId: adoptable.projectId } : {}),
                    // Adoption is still native-terminal execution. An `auto` preference
                    // must never detach the task from the terminal the human selected.
                    substrate: 'terminal',
                    runtimePreference: 'native-terminal',
                }],
            // Doubly true here: this terminal was never ours to close.
            closeTerminalsOnStop: false,
        });
        if (!started.ok || !started.orchestration || !started.runs?.length) {
            return { ok: false, error: started.error ?? 'the team did not start', code: 'target-invalid' };
        }
        const teamId = started.orchestration.topology === 'team' ? started.orchestration.teamId : '';
        if (!teamId)
            return { ok: false, error: 'dispatch produced a non-team orchestration' };
        return { ok: true, run: started.runs[0], teamId };
    }
    /**
     * Follow-up into a terminal Tasks already spawned. A busy target is fine:
     * `send()` queues behind the member's current run. That queueing is the
     * mechanism — `orchestration:confirm-submit` is not, and appears only later
     * on the readiness-ambiguity path.
     */
    async sendToMember(controller, projectId, target, prompt) {
        const principal = await this.deps.hostPrincipal.principal(projectId);
        const sent = await controller.send(principal, {
            teamId: target.teamId,
            memberId: target.memberId,
            submissionId: `tasks-${(0, crypto_1.randomUUID)()}`,
            prompt,
        });
        if (!sent.ok || !sent.run) {
            return { ok: false, error: sent.error ?? 'the follow-up did not create a run', code: 'target-invalid' };
        }
        return { ok: true, run: sent.run, teamId: target.teamId };
    }
    /**
     * The binding — app-owned and explicit, because snapshots carry no `taskId`.
     * This is the ONLY way a run becomes a task's run; nothing is ever adopted by
     * inference from the control plane.
     */
    async bind(taskId, run, teamId) {
        const terminalId = run.terminalId ?? '';
        const label = (terminalId && this.deps.getTerminalName?.(terminalId)) || run.target;
        const record = {
            runId: run.runId,
            terminalId,
            // The run snapshot carries the UNIT's project (D4) — for a borrowed
            // foreign-workspace terminal this differs from the task's home project.
            ...(run.projectId ? { projectId: run.projectId } : {}),
            agentType: run.target,
            orchestrationId: teamId,
            ...(run.memberId ? { memberId: run.memberId } : {}),
            startedAt: run.createdAt,
        };
        await this.deps.manager.recordRun(taskId, record);
        this.deps.onRunBound?.(run.runId);
        await this.deps.manager.setAssignee(taskId, {
            kind: 'agent',
            id: terminalId || run.runId,
            label,
            agentType: run.target,
        });
        const marked = await this.deps.manager.markDispatched(taskId, label);
        if (!marked.ok) {
            throw new Error('error' in marked ? marked.error : 'task file changed while recording dispatch');
        }
    }
}
exports.TaskDispatcher = TaskDispatcher;
