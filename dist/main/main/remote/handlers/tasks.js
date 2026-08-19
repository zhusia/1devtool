"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTaskHandlers = registerTaskHandlers;
const PAYLOAD_CAP = 4000;
function registerTaskHandlers(io, managers) {
    const manager = () => managers.getTasksManager?.() ?? null;
    io.on('connection', (socket) => {
        /**
         * The review queue, phone-shaped. `viewer` is enough to LOOK: seeing that
         * an agent is blocked is not an action.
         */
        socket.on('tasks:gates', async (_payload, ack) => {
            const tasks = manager();
            if (!tasks) {
                ack?.({ ok: false, error: 'Tasks unavailable' });
                return;
            }
            try {
                const open = await tasks.openGates();
                const gates = [];
                for (const { taskId, gate } of open) {
                    const found = await tasks.get(taskId);
                    if (!found)
                        continue;
                    const status = await tasks.gates.status(gate.id);
                    gates.push({
                        gateId: gate.id,
                        taskId,
                        taskTitle: found.task.title,
                        projectName: '',
                        kind: gate.kind,
                        payload: gate.payload.slice(0, PAYLOAD_CAP),
                        ...(gate.options?.length ? { options: gate.options } : {}),
                        requestedBy: gate.requestedBy.label,
                        requestedAt: gate.requestedAt,
                        ...(status.status === 'stale' && status.detail ? { stale: status.detail } : {}),
                    });
                }
                ack?.({ ok: true, gates });
            }
            catch (error) {
                ack?.({ ok: false, error: error instanceof Error ? error.message : 'Failed to read approvals' });
            }
        });
        /**
         * The verdict. `approver` — the same level the existing approval events
         * use, so a phone that may approve a terminal action may approve a task
         * gate, and a viewer-only device may do neither.
         *
         * The human's words travel verbatim, exactly as on the desktop: this is the
         * whole value of answering from a phone, and paraphrasing it into a bare
         * "approved" would throw it away.
         */
        socket.on('tasks:resolve-gate', async (payload, ack) => {
            const tasks = manager();
            if (!tasks) {
                ack?.({ ok: false, error: 'Tasks unavailable' });
                return;
            }
            const { gateId, verdict } = payload ?? {};
            if (typeof gateId !== 'string' || !gateId) {
                ack?.({ ok: false, error: 'gateId is required' });
                return;
            }
            if (verdict !== 'approved' && verdict !== 'changes-requested' && verdict !== 'declined') {
                ack?.({ ok: false, error: 'invalid verdict' });
                return;
            }
            try {
                const result = await tasks.resolveGate(gateId, {
                    verdict,
                    ...(typeof payload.response === 'string' && payload.response.trim()
                        ? { response: payload.response.trim().slice(0, 2000) }
                        : {}),
                    // Attributed to the human, not to the device: the phone is how the
                    // person answered, not a second kind of actor in the ledger.
                    resolvedBy: { kind: 'human', id: 'me', label: 'me (phone)' },
                });
                ack?.({ ok: result.ok, ...(result.error ? { error: result.error } : {}) });
            }
            catch (error) {
                ack?.({ ok: false, error: error instanceof Error ? error.message : 'Failed to record the verdict' });
            }
        });
    });
}
