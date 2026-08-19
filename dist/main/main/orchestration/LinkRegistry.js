"use strict";
/**
 * Durable Terminal Link registry (orchestration v4 — L1 links, L4 receipts).
 *
 * Main is the only owner of link rows and link-message records. Links are
 * generation-bound: an endpoint captures the PTY spawn time at creation, and
 * every delivery revalidates it — a relaunched/closed terminal quarantines
 * the link (typed failure) instead of silently rebinding to whatever reuses
 * the id. Delivery reuses the Team transport exactly (TerminalInputSerializer
 * staged submit, lease epochs, occupancy revocation); the registry never
 * touches a PTY directly.
 *
 * Storage follows the TeamMessageBus pattern: atomic tmp+rename snapshot,
 * crash-honest load (a message caught 'delivering' at load becomes 'failed'
 * while a pre-write queued message stays queued — a dispatch is never
 * replayed from disk). Receipts are resolved
 * only for callers whose bridge-attributed terminal matches the record's
 * `from` endpoint, checked here against the durable record.
 * Terminal delivery hotspot: read docs/common-errors/terminals/INDEX.md
 * before changing readiness, prompt injection, or receipt settlement.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LinkRegistry = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
const terminalLinks_1 = require("../../shared/orchestration/terminalLinks");
const teamMessages_1 = require("../../shared/orchestration/teamMessages");
const pipeline_1 = require("../../shared/orchestration/pipeline");
const linkNudge_1 = require("./linkNudge");
const swarmDecisions_1 = require("../../shared/orchestration/swarmDecisions");
const LINK_MESSAGE_MAX_RECORDS = 2_000;
/**
 * Quarantined rows kept per store once their terminals still exist. Restarts
 * quarantine every prior link, so an unbounded history would turn the
 * "N quarantined" counter into noise and grow the snapshot forever.
 */
const LINK_MAX_QUARANTINED_RECORDS = 50;
const LINK_MESSAGE_MAX_IN_FLIGHT = 32;
const LINK_MAX_DECISION_RECORDS = 200;
const LINK_PREVIEW_MAX_CHARS = 120;
/** Settled records beyond this many newest keep only their preview — a body
 *  is never read again after settlement, and 2 000 × 64 KB bodies made every
 *  commit a multi-MB synchronous stringify+write (R23). */
const LINK_SETTLED_BODY_KEEP = 100;
/**
 * First meaningful line, bounded. Computed ONCE per record at creation
 * (stored on the record) — polled surfaces must never re-derive it from a
 * body that can be 64 KB. The scan itself is bounded too: a first line, if
 * one exists, lives in the first few KB.
 */
function previewOfBody(body) {
    const head = body.length > 8_192 ? body.slice(0, 8_192) : body;
    const line = head.split('\n').map((entry) => entry.trim()).find(Boolean) ?? '';
    return line.length > LINK_PREVIEW_MAX_CHARS ? `${line.slice(0, LINK_PREVIEW_MAX_CHARS - 1)}…` : line;
}
const RECEIPT_WAIT_MAX_MS = 120_000;
/**
 * A timed-out positive readiness proof is transient, regardless of agent kind:
 * the target may still be starting or may currently be busy. Re-run the full
 * proof before every attempt and stop after a bounded window. Unsupported
 * agents remain human-mediated; no retry ever turns unknown readiness into a
 * blind write.
 */
const REDELIVERY_INTERVAL_MS = 15_000;
/** ~10 minutes of retries, then a typed failure — never an endless park. */
const REDELIVERY_MAX_ATTEMPTS = 40;
const REDELIVERY_WINDOW_MS = REDELIVERY_INTERVAL_MS * REDELIVERY_MAX_ATTEMPTS;
/**
 * Stall sweep (auto-nudge). Field failure it exists for: every observed
 * multi-agent run eventually sat on "N awaiting reply" until the user clicked
 * Restore link context — whose useful half, mid-run, is just "remind everyone
 * who owes an answer". Main now does that itself, tightly bounded:
 *
 *  - only DELEGATIONS (never replies — auto-reminding ack chatter is how the
 *    standby ping-pong storms start), outstanding for ≥ the stall window;
 *  - only when a live reply edge exists (the stranded case is Mission
 *    Control's Re-start, a human call);
 *  - at most ONE reminder per message, ever (`autoNudgedAt`), and one
 *    injection per recipient terminal per sweep;
 *  - delivery rides deliverNotice's single-shot readiness gate, so a BUSY
 *    peer is skipped and simply retried next sweep — the reminder lands the
 *    moment the peer goes idle, which is exactly when a reminder means
 *    anything. A bounded attempt cap turns "never ready" into giving up.
 */
const AUTO_NUDGE_AFTER_MS = 4 * 60_000;
const AUTO_NUDGE_SCAN_INTERVAL_MS = 60_000;
const AUTO_NUDGE_MAX_ATTEMPTS = 10;
const LINK_MAX_REQUEST_RECORDS = 200;
const LINK_MAX_ARTIFACT_RECORDS = 200;
const LINK_ARTIFACT_MAX_TITLE_CHARS = 160;
class LinkRegistry {
    links = [];
    messages = [];
    requests = [];
    decisions = [];
    artifacts = [];
    federatedAdmissions = [];
    federatedMessages = [];
    directSubmissions = [];
    pipelineRuns = [];
    waiters = new Map();
    deliveryChains = new Map();
    /** messageId → pending bounded readiness retry. */
    redeliveryTimers = new Map();
    deliveredProjects = new Set();
    graphRevision = 0;
    loaded = false;
    autoNudgeTimer = null;
    autoNudgeSweepInFlight = false;
    /** messageId → sweep attempts so a never-ready peer cannot be polled forever. */
    autoNudgeAttempts = new Map();
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    ensureAutoNudgeTimer() {
        // Gated on getShimPath: the reminder embeds the exact reply command, and a
        // registry constructed without a shim (tests) must stay deterministic.
        if (this.autoNudgeTimer || !this.deps.getShimPath)
            return;
        this.autoNudgeTimer = setInterval(() => { void this.runAutoNudgeSweep(); }, AUTO_NUDGE_SCAN_INTERVAL_MS);
        this.autoNudgeTimer.unref?.();
    }
    /**
     * The stall sweep (see AUTO_NUDGE_AFTER_MS). Public so tests can drive it
     * directly; production runs it on an unref'd interval. Returns how many
     * reminders were delivered this pass.
     */
    async runAutoNudgeSweep(now = Date.now()) {
        if (this.autoNudgeSweepInFlight)
            return 0;
        const shimPath = this.deps.getShimPath?.();
        if (!shimPath)
            return 0;
        this.autoNudgeSweepInFlight = true;
        try {
            this.load();
            // In-flight traffic means that recipient's delivery chain is already
            // busy — stay out of its way this sweep.
            const busyRecipients = new Set(this.messages
                .filter((row) => row.state === 'queued' || row.state === 'delivering')
                .map((row) => row.to.terminalId));
            // One reminder per recipient per sweep, and the NEWEST eligible
            // delegation wins — older open work toward the same peer is usually
            // superseded (same choice the manual Resume path makes).
            const candidateByRecipient = new Map();
            for (const message of this.messages) {
                if (!(0, terminalLinks_1.isLinkMessageOutstanding)(message))
                    continue;
                if (message.replyToMessageId)
                    continue;
                if (message.autoNudgedAt)
                    continue;
                const referenceAt = message.deliveredAt ?? message.createdAt;
                if (now - referenceAt < AUTO_NUDGE_AFTER_MS)
                    continue;
                if (busyRecipients.has(message.to.terminalId))
                    continue;
                const current = candidateByRecipient.get(message.to.terminalId);
                if (!current || (current.deliveredAt ?? current.createdAt) < referenceAt) {
                    candidateByRecipient.set(message.to.terminalId, message);
                }
            }
            let delivered = 0;
            for (const message of candidateByRecipient.values()) {
                // No reply edge = the stranded case — Mission Control's Re-start, a
                // human call. Reminding a peer that cannot answer is just noise.
                const reverse = this.links.find((row) => row.state === 'active' &&
                    row.permissions.includes('send') &&
                    row.from.terminalId === message.to.terminalId &&
                    row.to.terminalId === message.from.terminalId);
                if (!reverse)
                    continue;
                const forward = this.links.find((row) => row.state === 'active' &&
                    row.from.terminalId === message.from.terminalId &&
                    row.to.terminalId === message.to.terminalId);
                if (!forward)
                    continue;
                const fromInfo = this.deps.getTerminalInfo(message.from.terminalId);
                if (!fromInfo)
                    continue;
                const attempts = (this.autoNudgeAttempts.get(message.messageId) ?? 0) + 1;
                this.autoNudgeAttempts.set(message.messageId, attempts);
                const ok = await this.deliverNotice(forward, 
                // Stable across attempts: if a submit crossed while acceptance was
                // uncertain, the serializer's runId dedup blocks a duplicate type.
                `auto-reply-reminder-${message.messageId}`, (0, linkNudge_1.composeReplyReminderNudge)({
                    hostTitle: fromInfo.name || fromInfo.effectiveAgentKind,
                    hostTerminalId: message.from.terminalId,
                    messageId: message.messageId,
                    shimPath,
                    auto: true,
                    ...(this.replyTokenFor(message.messageId) ? { replyToken: this.replyTokenFor(message.messageId) } : {}),
                    recipientAgentKind: forward.to.effectiveAgentKind,
                }));
                if (ok || attempts >= AUTO_NUDGE_MAX_ATTEMPTS) {
                    const row = this.messages.find((entry) => entry.messageId === message.messageId);
                    if (row && !row.autoNudgedAt) {
                        row.autoNudgedAt = Date.now();
                        this.commit();
                    }
                    this.autoNudgeAttempts.delete(message.messageId);
                    if (ok)
                        delivered += 1;
                }
            }
            return delivered;
        }
        finally {
            this.autoNudgeSweepInFlight = false;
        }
    }
    load() {
        if (this.loaded)
            return;
        this.loaded = true;
        this.ensureAutoNudgeTimer();
        try {
            const raw = fs_1.default.readFileSync(this.deps.storagePath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed?.version === 1) {
                this.graphRevision = Number.isSafeInteger(parsed.graphRevision) && (parsed.graphRevision ?? 0) >= 0
                    ? parsed.graphRevision
                    : 0;
                this.links = Array.isArray(parsed.links) ? parsed.links : [];
                this.messages = Array.isArray(parsed.messages) ? parsed.messages : [];
                this.requests = Array.isArray(parsed.requests) ? parsed.requests : [];
                this.decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
                this.artifacts = Array.isArray(parsed.artifacts) ? parsed.artifacts : [];
                this.federatedAdmissions = Array.isArray(parsed.federatedAdmissions) ? parsed.federatedAdmissions : [];
                this.federatedMessages = Array.isArray(parsed.federatedMessages) ? parsed.federatedMessages : [];
                this.directSubmissions = Array.isArray(parsed.directSubmissions) ? parsed.directSubmissions : [];
                this.pipelineRuns = Array.isArray(parsed.pipelineRuns) ? parsed.pipelineRuns : [];
            }
        }
        catch {
            this.links = [];
            this.messages = [];
            this.requests = [];
            this.decisions = [];
            this.artifacts = [];
            this.federatedAdmissions = [];
            this.federatedMessages = [];
            this.directSubmissions = [];
            this.graphRevision = 0;
        }
        // Crash honesty: a dispatch that crossed into `delivering` is never
        // replayed from disk. Human-mediated rows remain queued. A transient
        // readiness wait is re-armed only inside its ORIGINAL bounded window;
        // older AUTO rows with no durable owner fail typed on load.
        let repaired = false;
        const rearm = [];
        const now = Date.now();
        for (const submission of this.directSubmissions) {
            if (submission.state !== 'delivering')
                continue;
            submission.state = 'failed';
            submission.error = 'delivery-unconfirmed';
            repaired = true;
        }
        for (const message of this.federatedMessages) {
            if (message.state !== 'delivering')
                continue;
            message.state = 'failed';
            // The Enter may already have crossed before the crash. Never replay a
            // federated delivery from disk and never turn uncertainty into success.
            message.error = 'delivery-unconfirmed';
            repaired = true;
        }
        for (const message of this.messages) {
            if (message.state === 'delivering') {
                message.state = 'failed';
                // The process may have crashed after the one Enter crossed the PTY
                // boundary. Never replay it and never pretend to know it was rejected.
                message.error = 'delivery-unconfirmed';
                repaired = true;
            }
            else if (message.state === 'queued') {
                const link = this.links.find((row) => row.linkId === message.linkId);
                if (!link) {
                    message.state = 'failed';
                    message.error = 'delivery-failed';
                    repaired = true;
                    continue;
                }
                if (link.delivery === 'confirm') {
                    if (message.queuedReason !== 'confirmation-required') {
                        message.queuedReason = 'confirmation-required';
                        repaired = true;
                    }
                    continue;
                }
                // Upgrade fresh Cursor rows written by the Cursor-only retry build to
                // the explicit transient reason. Other legacy target-not-ready rows
                // retain their human-mediated contract and never arrive by surprise.
                if (message.queuedReason === 'target-not-ready' &&
                    link.to.effectiveAgentKind === 'cursor') {
                    if (now - message.createdAt >= REDELIVERY_WINDOW_MS) {
                        message.state = 'failed';
                        message.error = 'delivery-failed';
                        delete message.queuedReason;
                        repaired = true;
                        continue;
                    }
                    message.queuedReason = 'waiting-for-readiness';
                    repaired = true;
                }
                if (message.queuedReason === 'waiting-for-readiness') {
                    const age = Math.max(0, now - message.createdAt);
                    if (age >= REDELIVERY_WINDOW_MS) {
                        message.state = 'failed';
                        message.error = 'delivery-failed';
                        delete message.queuedReason;
                        repaired = true;
                    }
                    else {
                        rearm.push({
                            link,
                            message,
                            attempt: Math.min(REDELIVERY_MAX_ATTEMPTS - 2, Math.floor(age / REDELIVERY_INTERVAL_MS)),
                        });
                    }
                }
                else if (message.queuedReason !== 'target-not-ready' &&
                    message.queuedReason !== 'confirmation-required') {
                    message.state = 'failed';
                    message.error = 'delivery-failed';
                    delete message.queuedReason;
                    repaired = true;
                }
            }
        }
        // Older builds marked an original answered as soon as a reply RECORD was
        // queued. Repair only when a correlated reply row is present: delivered
        // replies settle the original; rows that never delivered restore it to
        // outstanding. Missing historical reply rows are left untouched because
        // retention may already have pruned valid evidence.
        const hierarchy = this.deps.hierarchy?.();
        for (const run of this.pipelineRuns) {
            if (!run.closedAt && hierarchy && !hierarchy.activationIsActive(run.activationId)) {
                const currentMessage = run.currentMessageId
                    ? this.messages.find((row) => row.messageId === run.currentMessageId)
                    : undefined;
                if (currentMessage && (0, terminalLinks_1.isLinkMessageOutstanding)(currentMessage)) {
                    currentMessage.closedAt = Date.now();
                }
                run.state = 'cancelled';
                run.closedAt = Date.now();
                run.updatedAt = run.closedAt;
                repaired = true;
            }
            if (!run.closedAt && hierarchy && (run.state === 'blocked' || run.state === 'gate-cap')) {
                const message = run.currentMessageId
                    ? this.messages.find((row) => row.messageId === run.currentMessageId)
                    : undefined;
                hierarchy.recordEscalation(run.activationId, {
                    kind: run.state === 'gate-cap' ? 'pipeline-gate-cap' : 'pipeline-stage-blocked',
                    pipelineRunId: run.pipelineRunId,
                    ...(run.state === 'gate-cap' && run.currentMessageId
                        ? { triggeringMessageId: run.currentMessageId }
                        : {}),
                    at: run.updatedAt,
                    fromTerminalId: message?.to.terminalId ?? '',
                    ...(message?.pipeline?.checkerNodeId ? { fromNodeId: message.pipeline.checkerNodeId } : {}),
                    toTerminalId: message?.from.terminalId ?? 'user',
                    preview: run.state === 'gate-cap'
                        ? 'Pipeline quality gate reached its reject limit'
                        : 'Pipeline stage is blocked and needs a decision',
                });
            }
        }
        const replyEvidence = new Map();
        for (const reply of this.messages) {
            if (!reply.replyToMessageId)
                continue;
            const evidence = replyEvidence.get(reply.replyToMessageId) ?? { delivered: false };
            if (reply.state === 'delivered' || reply.state === 'answered') {
                evidence.delivered = true;
                evidence.deliveredAt ??= reply.deliveredAt ?? reply.createdAt;
            }
            replyEvidence.set(reply.replyToMessageId, evidence);
        }
        for (const original of this.messages) {
            const evidence = replyEvidence.get(original.messageId);
            if (!evidence)
                continue;
            // A delivered reply is proof the original reached its recipient even
            // when the delivery confirmation never fired (see
            // repairUnconfirmedDelivery) — settle it as answered, not failed.
            if (evidence.delivered &&
                original.state === 'failed' &&
                original.error === 'delivery-unconfirmed') {
                original.state = 'delivered';
                original.deliveredAt ??= original.createdAt;
                delete original.error;
                repaired = true;
            }
            if (evidence.delivered && original.state === 'delivered') {
                original.state = 'answered';
                original.answeredAt = evidence.deliveredAt ?? original.createdAt;
                repaired = true;
            }
            else if (!evidence.delivered && original.state === 'answered') {
                original.state = 'delivered';
                delete original.answeredAt;
                repaired = true;
            }
        }
        if (this.closeUnactionableMessages())
            repaired = true;
        this.pruneMessages();
        if (repaired)
            this.commit();
        // After pruneMessages, so a row dropped by retention is never re-armed.
        for (const { link, message, attempt } of rearm) {
            if (this.messages.includes(message))
                this.scheduleRedelivery(link, message, attempt);
        }
    }
    commit(graphChanged = false) {
        if (graphChanged) {
            this.graphRevision += 1;
            this.refreshReadConsentSuspensions();
        }
        this.pruneMessages();
        const dir = path_1.default.dirname(this.deps.storagePath);
        fs_1.default.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const tmp = `${this.deps.storagePath}.${process.pid}.tmp`;
        const payload = {
            version: 1,
            graphRevision: this.graphRevision,
            links: this.links,
            messages: this.messages,
            requests: this.requests,
            decisions: this.decisions,
            artifacts: this.artifacts,
            federatedAdmissions: this.federatedAdmissions,
            federatedMessages: this.federatedMessages,
            directSubmissions: this.directSubmissions.slice(-500),
            pipelineRuns: this.pipelineRuns,
        };
        fs_1.default.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
        fs_1.default.renameSync(tmp, this.deps.storagePath);
        this.deps.onChanged?.();
    }
    currentEndpoint(terminalId) {
        const info = this.deps.getTerminalInfo(terminalId);
        if (!info)
            return null;
        const generation = this.deps.getTerminalGeneration(terminalId);
        if (generation === undefined)
            return null;
        return {
            terminalId,
            terminalGeneration: generation,
            projectId: info.projectId,
            worktreePath: info.worktreePath,
            effectiveAgentKind: info.effectiveAgentKind,
            ...(info.nativeSessionId ? { nativeSessionId: info.nativeSessionId } : {}),
        };
    }
    /** Preview backfill for records written before previews were stored.
     *  In-memory only; it rides the next natural commit. */
    summaryPreview(message) {
        message.preview ??= previewOfBody(message.body);
        return message.preview;
    }
    pruneMessages() {
        const openRunIds = new Set(this.pipelineRuns.filter((run) => !run.closedAt).map((run) => run.pipelineRunId));
        // Body eviction: a settled record's body is never read again (delivery
        // requires `queued`; replies validate ids/states; every surface reads the
        // stored preview). Keeping the newest few for forensics bounds the store
        // hard — before this, every commit re-serialized up to 2 000 × 64 KB of
        // dead prompt text on the main thread.
        let settledWithBody = 0;
        for (let i = this.messages.length - 1; i >= 0; i--) {
            const message = this.messages[i];
            if (message.state === 'queued' || message.state === 'delivering')
                continue;
            if (!message.body)
                continue;
            settledWithBody += 1;
            if (settledWithBody > (this.deps.retention?.settledBodyKeep ?? LINK_SETTLED_BODY_KEEP)) {
                this.summaryPreview(message);
                message.body = '';
            }
        }
        const open = this.pipelineRuns.filter((run) => !run.closedAt);
        const closed = this.pipelineRuns
            .filter((run) => Boolean(run.closedAt))
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, 200);
        this.pipelineRuns = [...open, ...closed];
        if (this.messages.length <= LINK_MESSAGE_MAX_RECORDS)
            return;
        let remove = this.messages.length - LINK_MESSAGE_MAX_RECORDS;
        this.messages = this.messages.filter((message) => {
            if (remove <= 0)
                return true;
            if (message.state === 'queued' || message.state === 'delivering')
                return true;
            if (message.pipeline && openRunIds.has(message.pipeline.pipelineRunId))
                return true;
            remove -= 1;
            return false;
        });
    }
    endpointMismatch(bound, current) {
        if (bound.terminalId !== current.terminalId ||
            bound.terminalGeneration !== current.terminalGeneration) {
            return 'terminal-relaunched';
        }
        if (bound.projectId !== current.projectId)
            return 'project-removed';
        if (bound.worktreePath !== undefined &&
            bound.worktreePath !== current.worktreePath) {
            return 'worktree-changed';
        }
        if (bound.effectiveAgentKind !== current.effectiveAgentKind)
            return 'agent-kind-changed';
        if (bound.nativeSessionId !== undefined &&
            bound.nativeSessionId !== current.nativeSessionId) {
            return 'session-replaced';
        }
        return null;
    }
    /**
     * Validate a bound endpoint against live state. A session discovered after
     * link creation may be bound once; after that, replacement is a quarantine
     * event rather than a silent rebind.
     */
    reconcileEndpoint(bound, current) {
        const reason = this.endpointMismatch(bound, current);
        if (reason)
            return { ok: false, reason };
        let changed = false;
        if (!bound.worktreePath && current.worktreePath) {
            bound.worktreePath = current.worktreePath;
            changed = true;
        }
        if (!bound.nativeSessionId && current.nativeSessionId) {
            bound.nativeSessionId = current.nativeSessionId;
            changed = true;
        }
        return { ok: true, changed };
    }
    quarantine(link, reason) {
        link.state = 'quarantined';
        link.quarantineReason = reason;
    }
    validateLiveLink(link) {
        if (!this.links.includes(link) || link.state === 'quarantined') {
            return { ok: false, error: 'quarantined' };
        }
        const fromNow = this.currentEndpoint(link.from.terminalId);
        const toNow = this.currentEndpoint(link.to.terminalId);
        if (!toNow) {
            this.quarantine(link, 'terminal-closed');
            return { ok: false, error: 'target-closed' };
        }
        if (!fromNow) {
            this.quarantine(link, 'terminal-closed');
            return { ok: false, error: 'generation-mismatch' };
        }
        const from = this.reconcileEndpoint(link.from, fromNow);
        const to = this.reconcileEndpoint(link.to, toNow);
        if (!from.ok || !to.ok) {
            this.quarantine(link, !from.ok ? from.reason : !to.ok ? to.reason : 'terminal-relaunched');
            return { ok: false, error: 'generation-mismatch' };
        }
        return { ok: true, changed: from.changed || to.changed };
    }
    /** Reconcile active rows before exposing the graph. Closing/relaunching a
     * terminal must become visible as quarantine even if nobody attempts a
     * send afterward. */
    reconcileVisibleLinks() {
        let changed = false;
        for (const link of this.links) {
            if (link.state !== 'active')
                continue;
            const result = this.validateLiveLink(link);
            if (!result.ok || result.changed)
                changed = true;
        }
        if (this.pruneQuarantinedLinks())
            changed = true;
        if (this.closeUnactionableMessages())
            changed = true;
        if (changed)
            this.commit(true);
    }
    /**
     * Close outstanding delegations no terminal can ever resolve.
     *
     * A delivered-unanswered row needs BOTH endpoints alive to settle: the
     * recipient produces the answer, the sender is the one waiting for it. Once
     * either terminal RECORD is deleted (a closed tab — relaunching keeps the
     * record), the row is un-repairable by design ("Both terminals must be
     * running") and would sit in Mission Control's "stuck" list forever; every
     * closed-terminal test run then piles more of them onto the next one.
     * Closing (not deleting) keeps the true history in the activity timeline —
     * `closedReason: 'terminal-gone'` says retention did it, not the user. A
     * late reply by token still correlates, same as a user close.
     */
    closeUnactionableMessages() {
        let changed = false;
        for (const message of this.messages) {
            if (!(0, terminalLinks_1.isLinkMessageOutstanding)(message))
                continue;
            const fromExists = this.deps.getTerminalInfo(message.from.terminalId) !== null;
            const toExists = this.deps.getTerminalInfo(message.to.terminalId) !== null;
            if (fromExists && toExists)
                continue;
            message.closedAt = Date.now();
            message.closedReason = 'terminal-gone';
            this.emitMessageState(message);
            changed = true;
        }
        return changed;
    }
    /**
     * Drop quarantined rows the user can never act on.
     *
     * Every app restart relaunches terminals with new PTY generations, so all
     * pre-restart links quarantine; without this they accumulate forever and the
     * "N quarantined" counter grows past anything actionable. Two rules, both
     * deliberately conservative:
     *
     *  1. A row whose BOTH endpoints have no terminal record left is unrevivable
     *     (nothing can ever re-bind it) — dropped. A row keeping even one live
     *     record survives, because relinking it is a one-click action.
     *  2. Beyond {@link LINK_MAX_QUARANTINED_RECORDS}, oldest-first, so a
     *     long-lived workspace cannot grow the store without bound.
     *
     * Never touches active rows. Returns true when something was removed.
     */
    pruneQuarantinedLinks() {
        const quarantined = this.links.filter((row) => row.state === 'quarantined');
        if (quarantined.length === 0)
            return false;
        const doomed = new Set();
        for (const row of quarantined) {
            const fromExists = this.deps.getTerminalInfo(row.from.terminalId) !== null;
            const toExists = this.deps.getTerminalInfo(row.to.terminalId) !== null;
            if (!fromExists && !toExists)
                doomed.add(row.linkId);
        }
        const survivors = quarantined.filter((row) => !doomed.has(row.linkId));
        if (survivors.length > LINK_MAX_QUARANTINED_RECORDS) {
            const byAge = [...survivors].sort((a, b) => a.createdAt - b.createdAt);
            for (const row of byAge.slice(0, survivors.length - LINK_MAX_QUARANTINED_RECORDS)) {
                doomed.add(row.linkId);
            }
        }
        if (doomed.size === 0)
            return false;
        this.links = this.links.filter((row) => !doomed.has(row.linkId));
        return true;
    }
    endpointDisclosureKey(endpoint) {
        return JSON.stringify([
            endpoint.terminalId,
            endpoint.terminalGeneration,
            endpoint.projectId,
            endpoint.worktreePath ?? '',
            endpoint.effectiveAgentKind,
            endpoint.nativeSessionId ?? '',
        ]);
    }
    readPermissions(permissions) {
        return permissions.filter(teamMessages_1.isTeamReadPermission);
    }
    /**
     * Effective disclosure closure for a target. Traversal follows every active
     * read-capable edge, regardless of read kind: if B can pull C's screen, that
     * content may already be present in B's transcript before A reads B.
     */
    computeReadClosure(targetTerminalId) {
        const closure = new Map();
        const queued = [targetTerminalId];
        const visited = new Set();
        while (queued.length > 0) {
            const terminalId = queued.shift();
            if (visited.has(terminalId))
                continue;
            visited.add(terminalId);
            const endpoint = this.currentEndpoint(terminalId);
            if (!endpoint)
                continue;
            closure.set(this.endpointDisclosureKey(endpoint), { ...endpoint });
            for (const link of this.links) {
                if (link.state !== 'active' ||
                    link.from.terminalId !== terminalId ||
                    this.readPermissions(link.permissions).length === 0) {
                    continue;
                }
                queued.push(link.to.terminalId);
            }
        }
        return [...closure.values()].sort((left, right) => this.endpointDisclosureKey(left).localeCompare(this.endpointDisclosureKey(right)));
    }
    consentCoversClosure(consent, closure) {
        if (!consent)
            return false;
        const acknowledged = new Set(consent.closure.map((endpoint) => this.endpointDisclosureKey(endpoint)));
        return closure.every((endpoint) => acknowledged.has(this.endpointDisclosureKey(endpoint)));
    }
    /**
     * Expansion is fail-closed. A closure shrink (edge revocation/quarantine)
     * may resume the already-acknowledged grant; it cannot recall content that
     * was previously disclosed, which the UI states explicitly.
     */
    refreshReadConsentSuspensions() {
        for (const link of this.links) {
            const reads = this.readPermissions(link.permissions);
            if (reads.length === 0) {
                delete link.readConsent;
                continue;
            }
            const closure = link.state === 'active'
                ? this.computeReadClosure(link.to.terminalId)
                : [];
            const consent = link.readConsent;
            const missingDisclosure = !consent?.vendorTranscriptAcknowledgedAt ||
                (reads.includes('read-screen') && !consent.screenSecretsAcknowledgedAt);
            if (consent) {
                consent.suspended =
                    link.state !== 'active' ||
                        closure.length === 0 ||
                        missingDisclosure ||
                        !this.consentCoversClosure(consent, closure);
            }
        }
    }
    consentFingerprint(input) {
        return (0, crypto_1.createHash)('sha256')
            .update(JSON.stringify({
            subject: input.subject,
            graphRevision: this.graphRevision,
            from: this.endpointDisclosureKey(input.from),
            to: this.endpointDisclosureKey(input.to),
            permissions: [...input.permissions].sort(),
            closure: input.closure.map((endpoint) => this.endpointDisclosureKey(endpoint)),
        }))
            .digest('hex');
    }
    buildReadConsentPreview(input) {
        const reads = this.readPermissions(input.permissions);
        const endpoints = this.computeReadClosure(input.to.terminalId);
        const preview = {
            subject: input.subject,
            fingerprint: this.consentFingerprint({
                ...input,
                closure: endpoints,
            }),
            closure: endpoints.map((endpoint) => {
                const info = this.deps.getTerminalInfo(endpoint.terminalId);
                return {
                    terminalId: endpoint.terminalId,
                    displayName: info?.name ?? endpoint.terminalId,
                    agentId: endpoint.effectiveAgentKind,
                    projectId: endpoint.projectId,
                };
            }),
            // Every content read enters the requesting agent's vendor-managed
            // transcript. This acknowledgement is deliberately independent of the
            // app's own content-capture preference.
            requiresVendorTranscriptConsent: reads.length > 0,
            requiresScreenSecretConsent: reads.includes('read-screen'),
        };
        return { preview, endpoints };
    }
    previewReadConsent(subject) {
        this.load();
        this.reconcileVisibleLinks();
        if (subject.kind === 'link') {
            const link = this.links.find((row) => row.linkId === subject.linkId);
            if (!link)
                return { ok: false, error: 'link not found' };
            const normalized = this.normalizePermissions(subject.permissions ?? link.permissions);
            if (!normalized.ok)
                return normalized;
            if (this.readPermissions(normalized.permissions).length === 0) {
                return { ok: false, error: 'the proposed link has no read permission' };
            }
            const from = this.currentEndpoint(link.from.terminalId);
            const to = this.currentEndpoint(link.to.terminalId);
            if (!from || !to)
                return { ok: false, error: 'terminal is not running' };
            return {
                ok: true,
                preview: this.buildReadConsentPreview({
                    subject: { kind: 'link', linkId: link.linkId },
                    from,
                    to,
                    permissions: normalized.permissions,
                }).preview,
            };
        }
        const request = this.requests.find((row) => row.requestId === subject.requestId);
        if (!request)
            return { ok: false, error: 'link request not found' };
        if (request.state !== 'pending')
            return { ok: false, error: 'link request is already resolved' };
        const from = this.currentEndpoint(request.from.terminalId);
        const to = this.currentEndpoint(request.to.terminalId);
        if (!from || !to || !(0, terminalLinks_1.endpointsMatch)(from, request.from) || !(0, terminalLinks_1.endpointsMatch)(to, request.to)) {
            return { ok: false, error: 'a requested terminal changed before approval' };
        }
        if (this.readPermissions(request.permissions).length === 0) {
            return { ok: false, error: 'the requested link has no read permission' };
        }
        return {
            ok: true,
            preview: this.buildReadConsentPreview({
                subject: { kind: 'request', requestId: request.requestId },
                from,
                to,
                permissions: request.permissions,
            }).preview,
        };
    }
    materializeReadConsent(input) {
        const reads = this.readPermissions(input.permissions);
        if (reads.length === 0)
            return { ok: true };
        const { preview, endpoints } = this.buildReadConsentPreview(input);
        const existingValid = input.existing &&
            this.consentCoversClosure(input.existing, endpoints) &&
            Boolean(input.existing.vendorTranscriptAcknowledgedAt) &&
            (!reads.includes('read-screen') || Boolean(input.existing.screenSecretsAcknowledgedAt));
        if (!input.grant) {
            return existingValid
                ? { ok: true, consent: { ...input.existing, suspended: false } }
                : { ok: false, error: 'read consent required' };
        }
        if (input.grant.fingerprint !== preview.fingerprint) {
            return { ok: false, error: 'read disclosure scope changed; review it again' };
        }
        if (preview.requiresVendorTranscriptConsent && !input.grant.vendorTranscript) {
            return { ok: false, error: 'vendor transcript retention consent required' };
        }
        if (preview.requiresScreenSecretConsent && !input.grant.screenSecrets) {
            return { ok: false, error: 'unredacted screen disclosure consent required' };
        }
        const now = Date.now();
        return {
            ok: true,
            consent: {
                closure: endpoints.map((endpoint) => ({ ...endpoint })),
                acknowledgedAt: now,
                ...(input.grant.vendorTranscript ? { vendorTranscriptAcknowledgedAt: now } : {}),
                ...(input.grant.screenSecrets ? { screenSecretsAcknowledgedAt: now } : {}),
                suspended: false,
            },
        };
    }
    /**
     * Revive a quarantined row: re-bind the same terminal pair to their CURRENT
     * endpoints and retire the stale row. Not a rebind of the old row — that is
     * exactly what quarantine exists to prevent — but a fresh, generation-current
     * link created through the normal path, carrying the original permissions and
     * delivery mode. Fails when either terminal is gone or not running, so a
     * revive can never resurrect a link to something that no longer exists.
     *
     * The caller must have proven user initiation (renderer gesture); this is the
     * same consent class as creating the edge by hand.
     */
    relink(linkId, createdBy = 'user-explicit', readConsent) {
        this.load();
        const stale = this.links.find((row) => row.linkId === linkId);
        if (!stale)
            return { ok: false, error: 'link not found' };
        if (stale.state !== 'quarantined')
            return { ok: false, error: 'link is not quarantined' };
        const result = this.ensureLink({
            fromTerminalId: stale.from.terminalId,
            toTerminalId: stale.to.terminalId,
            createdBy,
            permissions: stale.permissions,
            delivery: stale.delivery,
            ...(readConsent ? { readConsent } : {}),
            readConsentSubject: { kind: 'link', linkId: stale.linkId },
            allowSuspendedReadWithoutConsent: true,
        });
        if (!result.ok)
            return result;
        // Retire the stale row only once its replacement exists.
        if (result.link.linkId !== stale.linkId)
            this.unlink(stale.linkId);
        return result;
    }
    notify(messageId) {
        const waiters = this.waiters.get(messageId);
        if (!waiters)
            return;
        this.waiters.delete(messageId);
        for (const wake of waiters)
            wake();
    }
    emitMessageState(message) {
        this.deps.onMessageState?.({
            linkId: message.linkId,
            messageId: message.messageId,
            projectId: message.projectId,
            fromTerminalId: message.from.terminalId,
            toTerminalId: message.to.terminalId,
            state: message.state,
            ...(message.queuedReason ? { queuedReason: message.queuedReason } : {}),
        });
    }
    receiptFor(message) {
        return {
            messageId: message.messageId,
            linkId: message.linkId,
            toTerminalId: message.to.terminalId,
            state: message.state,
            ...(message.queuedReason ? { queuedReason: message.queuedReason } : {}),
            ...(message.deliveredAt ? { deliveredAt: message.deliveredAt } : {}),
            ...(message.answeredAt ? { answeredAt: message.answeredAt } : {}),
            ...(message.closedAt ? { closedAt: message.closedAt } : {}),
            ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
            ...(message.error ? { error: message.error } : {}),
        };
    }
    /**
     * Map a durable message record to the CLI/API result shape.
     *
     * When the caller used `--wait`, a terminal failure must not look like
     * success: host agents check `ok` (and exit code) before `receipt.state`.
     * Without wait, a still-queued receipt is expected success — delivery is
     * asynchronous.
     */
    receiptResult(message, waitMs) {
        const receipt = this.receiptFor(message);
        if (waitMs &&
            waitMs > 0 &&
            (receipt.state === 'failed' || receipt.state === 'cancelled')) {
            return {
                ok: false,
                error: receipt.error ?? 'delivery-failed',
                // Unconfirmed ≠ undelivered, and agents reading a bare failure either
                // resent (duplicate prompts in the peer) or STOPPED and asked the
                // human — both observed. Teach the honest next move in the receipt
                // itself; the peer's reply to this exact id settles it automatically
                // (repairUnconfirmedDelivery).
                ...(receipt.error === 'delivery-unconfirmed'
                    ? {
                        detail: 'The prompt was typed into the peer terminal once; only the acceptance confirmation timed out — it usually arrived. ' +
                            'Do NOT resend. If the peer answers this message id, this receipt settles automatically; continue with other work and check `link status` later.',
                    }
                    : {}),
                receipt,
            };
        }
        if (message.pipeline?.kind === 'gate-accept' && message.replyToMessageId
            && (message.state === 'delivered' || message.state === 'answered')) {
            const context = this.deps.hierarchy?.()?.pipelineContext(message.from.terminalId);
            const nextAction = context && context.stageIndex === context.stages.length - 1
                ? 'Write the user-facing result in this terminal, then run `report --complete`.'
                : `Continue this stage, then hand off with \`report --continue=${message.replyToMessageId}\`.`;
            return { ok: true, receipt, nextAction };
        }
        return { ok: true, receipt };
    }
    /**
     * Idempotent edge creation. A stale row for the same terminal pair whose
     * generations no longer match the live endpoints is quarantined (never
     * rebound) and a fresh active row is created — the caller has already
     * proven user initiation, which is the consent to re-link.
     */
    ensureLink(input) {
        this.load();
        const from = this.currentEndpoint(input.fromTerminalId);
        const to = this.currentEndpoint(input.toTerminalId);
        if (!from || !to)
            return { ok: false, error: 'terminal is not running' };
        // Cross-project links are allowed (user request, rev 5): both terminals
        // belong to the same user on the same machine. The link is OWNED by the
        // sender's project — auto-grid and project listings scope to it.
        if (input.fromTerminalId === input.toTerminalId) {
            return { ok: false, error: 'cannot link a terminal to itself' };
        }
        if (!this.deps.getTerminalInfo(input.fromTerminalId)?.isInteractiveAgent ||
            !this.deps.getTerminalInfo(input.toTerminalId)?.isInteractiveAgent) {
            return { ok: false, error: 'link endpoints must be AI terminals' };
        }
        const permissions = this.normalizePermissions(input.permissions ?? ['send', 'ask']);
        if (!permissions.ok)
            return permissions;
        if (input.delivery !== undefined && input.delivery !== 'auto' && input.delivery !== 'confirm') {
            return { ok: false, error: 'unknown delivery mode' };
        }
        const candidates = this.links.filter((row) => row.from.terminalId === input.fromTerminalId &&
            row.to.terminalId === input.toTerminalId);
        let changed = false;
        let link;
        for (const row of candidates) {
            if (row.state !== 'active')
                continue;
            const fromMatch = this.reconcileEndpoint(row.from, from);
            const toMatch = this.reconcileEndpoint(row.to, to);
            if (fromMatch.ok && toMatch.ok) {
                // Prefer the newest current row if a prior buggy build left
                // duplicates. Never let an older quarantined row shadow it.
                link = row;
                changed ||= fromMatch.changed || toMatch.changed;
                continue;
            }
            this.quarantine(row, !fromMatch.ok ? fromMatch.reason : !toMatch.ok ? toMatch.reason : 'terminal-relaunched');
            changed = true;
        }
        const created = !link;
        if (!link) {
            link = {
                linkId: `lk-${(0, crypto_1.randomUUID)()}`,
                projectId: from.projectId,
                from,
                to,
                permissions: permissions.permissions,
                delivery: input.delivery ?? 'auto',
                state: 'active',
                createdAt: Date.now(),
                createdBy: input.createdBy,
            };
        }
        // A normal idempotent mention carries no permissions/delivery patch and
        // must not reset an edge the user edited in Settings. Explicit callers
        // (request approval/relink) do apply the reviewed values.
        const nextPermissions = input.permissions === undefined
            ? link.permissions
            : permissions.permissions;
        let consent = !created && input.permissions === undefined && !input.readConsent
            ? { ok: true, consent: link.readConsent }
            : this.materializeReadConsent({
                subject: input.readConsentSubject ?? { kind: 'link', linkId: link.linkId },
                from,
                to,
                permissions: nextPermissions,
                grant: input.readConsent,
                existing: link.readConsent,
            });
        if (!consent.ok &&
            input.allowSuspendedReadWithoutConsent &&
            this.readPermissions(nextPermissions).length > 0) {
            consent = {
                ok: true,
                consent: {
                    closure: [],
                    acknowledgedAt: 0,
                    suspended: true,
                },
            };
        }
        if (!consent.ok)
            return consent;
        if (created) {
            link.permissions = nextPermissions;
            if (consent.consent)
                link.readConsent = consent.consent;
            this.links.push(link);
            changed = true;
        }
        else {
            if (input.permissions !== undefined &&
                JSON.stringify(link.permissions) !== JSON.stringify(nextPermissions)) {
                link.permissions = nextPermissions;
                changed = true;
            }
            if (input.delivery !== undefined && link.delivery !== input.delivery) {
                link.delivery = input.delivery;
                changed = true;
            }
            if (consent.consent &&
                JSON.stringify(link.readConsent) !== JSON.stringify(consent.consent)) {
                link.readConsent = consent.consent;
                changed = true;
            }
            else if (!consent.consent && link.readConsent) {
                delete link.readConsent;
                changed = true;
            }
        }
        if (changed)
            this.commit(true);
        return { ok: true, link, created };
    }
    normalizePermissions(requested) {
        const permissions = [...new Set(requested)];
        if (permissions.length === 0)
            return { ok: false, error: 'link needs at least one permission' };
        const known = new Set([
            'send',
            'ask',
            'share-artifact',
            ...teamMessages_1.TEAM_READ_PERMISSIONS,
        ]);
        if (permissions.some((permission) => !known.has(permission))) {
            return { ok: false, error: 'unknown permission kind' };
        }
        if (permissions.includes('read-transcript-full') &&
            !permissions.includes('read-transcript')) {
            return { ok: false, error: 'read-transcript-full also requires read-transcript' };
        }
        return { ok: true, permissions };
    }
    updateLink(linkId, patch) {
        this.load();
        const link = this.links.find((row) => row.linkId === linkId);
        if (!link)
            return { ok: false, error: 'link not found' };
        const normalized = patch.permissions
            ? this.normalizePermissions(patch.permissions)
            : { ok: true, permissions: link.permissions };
        if (!normalized.ok)
            return normalized;
        if (patch.delivery !== undefined && patch.delivery !== 'auto' && patch.delivery !== 'confirm') {
            return { ok: false, error: 'unknown delivery mode' };
        }
        const from = this.currentEndpoint(link.from.terminalId);
        const to = this.currentEndpoint(link.to.terminalId);
        if (!from || !to)
            return { ok: false, error: 'terminal is not running' };
        const consent = this.materializeReadConsent({
            subject: { kind: 'link', linkId },
            from,
            to,
            permissions: normalized.permissions,
            grant: patch.readConsent,
            existing: link.readConsent,
        });
        if (!consent.ok)
            return consent;
        link.permissions = normalized.permissions;
        if (patch.delivery)
            link.delivery = patch.delivery;
        if (consent.consent)
            link.readConsent = consent.consent;
        else
            delete link.readConsent;
        this.commit(true);
        return { ok: true, link, created: false };
    }
    /**
     * Agents can ask for an edge but never create one. The endpoint generations
     * are captured now and checked again at approval so an old request cannot
     * authorize a relaunched terminal.
     */
    requestLink(callerTerminalId, input) {
        this.load();
        const from = this.currentEndpoint(callerTerminalId);
        const to = this.currentEndpoint(input.toTerminalId);
        if (!from || !to)
            return { ok: false, error: 'terminal is not running' };
        if (callerTerminalId === input.toTerminalId) {
            return { ok: false, error: 'cannot link a terminal to itself' };
        }
        if (!this.deps.getTerminalInfo(callerTerminalId)?.isInteractiveAgent ||
            !this.deps.getTerminalInfo(input.toTerminalId)?.isInteractiveAgent) {
            return { ok: false, error: 'link endpoints must be AI terminals' };
        }
        const normalized = this.normalizePermissions(input.permissions ?? ['send', 'ask']);
        if (!normalized.ok)
            return normalized;
        // Agent-originated links always start strict. A caller may ask for
        // stricter semantics, never for auto-delivery authority.
        if (input.delivery !== undefined && input.delivery !== 'confirm') {
            return { ok: false, error: 'agent-requested links must use confirm delivery' };
        }
        // Hierarchy guard (v5 §4): a seated agent may not even REQUEST an edge
        // the chart forbids — the refusal teaches the configured route instead
        // of parking a request the human would have to deny.
        const guard = this.deps.hierarchy?.();
        if (guard) {
            const verdict = guard.checkSend({
                fromTerminalId: callerTerminalId,
                toTerminalId: input.toTerminalId,
                isReply: false,
                senderAgentKind: from.effectiveAgentKind,
            });
            if (verdict && !verdict.allow) {
                return { ok: false, error: verdict.detail ?? 'refused: hierarchy' };
            }
        }
        const existing = [...this.requests].reverse().find((row) => row.state === 'pending' &&
            (0, terminalLinks_1.endpointsMatch)(row.from, from) &&
            (0, terminalLinks_1.endpointsMatch)(row.to, to) &&
            row.permissions.length === normalized.permissions.length &&
            row.permissions.every((permission) => normalized.permissions.includes(permission)));
        if (existing)
            return { ok: true, request: existing, created: false };
        const request = {
            requestId: `lr-${(0, crypto_1.randomUUID)()}`,
            projectId: from.projectId,
            from,
            to,
            permissions: normalized.permissions,
            delivery: 'confirm',
            state: 'pending',
            createdAt: Date.now(),
        };
        this.requests.push(request);
        this.pruneRequests();
        this.commit();
        return { ok: true, request, created: true };
    }
    listLinkRequests(projectId) {
        this.load();
        return this.requests.filter((row) => !projectId || row.projectId === projectId);
    }
    resolveLinkRequest(requestId, approve, readConsent) {
        this.load();
        const request = this.requests.find((row) => row.requestId === requestId);
        if (!request)
            return { ok: false, error: 'link request not found' };
        if (request.state !== 'pending')
            return { ok: false, error: 'link request is already resolved' };
        const from = this.currentEndpoint(request.from.terminalId);
        const to = this.currentEndpoint(request.to.terminalId);
        if (!from || !to || !(0, terminalLinks_1.endpointsMatch)(from, request.from) || !(0, terminalLinks_1.endpointsMatch)(to, request.to)) {
            request.state = 'cancelled';
            request.decidedAt = Date.now();
            this.commit();
            return { ok: false, error: 'a requested terminal changed before approval' };
        }
        if (!approve) {
            request.state = 'denied';
            request.decidedAt = Date.now();
            this.commit();
            return { ok: true, request };
        }
        const created = this.ensureLink({
            fromTerminalId: request.from.terminalId,
            toTerminalId: request.to.terminalId,
            createdBy: 'agent-confirmed',
            permissions: request.permissions,
            delivery: 'confirm',
            ...(readConsent ? { readConsent } : {}),
            readConsentSubject: { kind: 'request', requestId: request.requestId },
        });
        if (!created.ok)
            return created;
        request.state = 'approved';
        request.decidedAt = Date.now();
        request.linkId = created.link.linkId;
        this.commit();
        return { ok: true, request, link: created.link };
    }
    pruneRequests() {
        if (this.requests.length <= LINK_MAX_REQUEST_RECORDS)
            return;
        let remove = this.requests.length - LINK_MAX_REQUEST_RECORDS;
        this.requests = this.requests.filter((request) => {
            if (remove <= 0 || request.state === 'pending')
                return true;
            remove -= 1;
            return false;
        });
    }
    unlink(linkId) {
        this.load();
        const link = this.links.find((row) => row.linkId === linkId);
        if (!link)
            return false;
        const cancelled = this.messages.filter((message) => message.linkId === linkId && message.state === 'queued');
        for (const message of cancelled) {
            this.cancelRedelivery(message.messageId);
            message.state = 'cancelled';
            delete message.queuedReason;
            this.updatePipelineAfterFailure(message);
        }
        this.links = this.links.filter((row) => row.linkId !== linkId);
        this.commit(true);
        for (const message of cancelled) {
            this.notify(message.messageId);
            this.emitMessageState(message);
        }
        return true;
    }
    linksForTerminal(terminalId) {
        this.load();
        this.reconcileVisibleLinks();
        return {
            outbound: this.links.filter((row) => row.from.terminalId === terminalId),
            inbound: this.links.filter((row) => row.to.terminalId === terminalId),
        };
    }
    listLinks(projectId) {
        this.load();
        this.reconcileVisibleLinks();
        return projectId ? this.links.filter((row) => row.projectId === projectId) : [...this.links];
    }
    terminalInfoForRead(terminalId) {
        const info = this.deps.getTerminalInfo(terminalId);
        if (!info)
            return null;
        return {
            name: info.name,
            effectiveAgentKind: info.effectiveAgentKind,
            resumeAgentType: info.resumeAgentType,
            isNativeTui: info.isNativeTui,
            worktreePath: info.worktreePath,
        };
    }
    readablePeers(callerTerminalId) {
        this.load();
        this.reconcileVisibleLinks();
        this.refreshReadConsentSuspensions();
        return this.links
            .filter((link) => link.state === 'active' &&
            link.from.terminalId === callerTerminalId &&
            this.readPermissions(link.permissions).length > 0)
            .map((link) => ({
            targetTerminalId: link.to.terminalId,
            displayName: this.deps.getTerminalInfo(link.to.terminalId)?.name ?? link.to.terminalId,
            agentId: link.to.effectiveAgentKind,
            permissions: this.readPermissions(link.permissions),
            ...(link.readConsent?.suspended ? { suspended: true } : {}),
        }));
    }
    /**
     * Discover every active outbound edge owned by the caller.
     *
     * Peer discovery is not a context read: send-only links still need to be
     * visible so a CLI can route `link send`. Keep `readablePeers()` separate so
     * listing a peer never grants transcript, screen, or artifact access.
     */
    linkedPeers(callerTerminalId) {
        this.load();
        this.reconcileVisibleLinks();
        this.refreshReadConsentSuspensions();
        return this.links
            .filter((link) => link.state === 'active' &&
            link.from.terminalId === callerTerminalId)
            .map((link) => ({
            targetTerminalId: link.to.terminalId,
            displayName: this.deps.getTerminalInfo(link.to.terminalId)?.name ?? link.to.terminalId,
            agentId: link.to.effectiveAgentKind,
            permissions: [...link.permissions],
            ...(link.readConsent?.suspended ? { suspended: true } : {}),
        }));
    }
    checkReadConsent(link, permission) {
        const consent = link.readConsent;
        const closure = this.computeReadClosure(link.to.terminalId);
        if (!consent ||
            consent.suspended ||
            !consent.vendorTranscriptAcknowledgedAt ||
            (permission === 'read-screen' && !consent.screenSecretsAcknowledgedAt) ||
            !this.consentCoversClosure(consent, closure)) {
            return {
                ok: false,
                reason: 'consent-required',
                detail: 'The effective disclosure scope must be reviewed in Link settings',
            };
        }
        return null;
    }
    /**
     * Entry-time authorization for a content read. The returned scope is an
     * immutable snapshot used only for return-time revalidation; it never
     * becomes a cache of permission truth.
     */
    resolveReadScope(callerTerminalId, targetTerminalId, permission) {
        this.load();
        this.reconcileVisibleLinks();
        const link = [...this.links].reverse().find((row) => row.state === 'active' &&
            row.from.terminalId === callerTerminalId &&
            row.to.terminalId === targetTerminalId);
        if (!link)
            return { ok: false, reason: 'no-connection' };
        if (!link.permissions.includes(permission)) {
            return { ok: false, reason: 'permission-denied' };
        }
        const validation = this.validateLiveLink(link);
        if (!validation.ok) {
            this.commit(true);
            return {
                ok: false,
                reason: validation.error === 'target-closed' ? 'target-closed' : 'scope-changed',
            };
        }
        if (validation.changed)
            this.commit(true);
        const consentFailure = this.checkReadConsent(link, permission);
        if (consentFailure)
            return consentFailure;
        return {
            ok: true,
            scope: {
                linkId: link.linkId,
                from: { ...link.from },
                to: { ...link.to },
                permission,
                graphRevision: this.graphRevision,
            },
        };
    }
    /**
     * Linearization point immediately before a body leaves main. A graph change
     * does not automatically fail an unrelated read; instead the exact edge,
     * endpoint scope, permission, and transitive consent are recomputed under
     * the current revision. Revocation/expansion can therefore never return the
     * body collected under the earlier scope.
     */
    revalidateReadScope(scope) {
        this.load();
        const link = this.links.find((row) => row.linkId === scope.linkId);
        if (!link || link.state !== 'active')
            return { ok: false, reason: 'scope-changed' };
        const validation = this.validateLiveLink(link);
        if (!validation.ok) {
            this.commit(true);
            return { ok: false, reason: 'scope-changed' };
        }
        if (validation.changed)
            this.commit(true);
        if (!(0, terminalLinks_1.endpointsMatch)(link.from, scope.from) ||
            !(0, terminalLinks_1.endpointsMatch)(link.to, scope.to) ||
            !link.permissions.includes(scope.permission)) {
            return { ok: false, reason: 'scope-changed' };
        }
        const consentFailure = this.checkReadConsent(link, scope.permission);
        if (consentFailure) {
            return consentFailure.reason === 'consent-required'
                ? consentFailure
                : { ok: false, reason: 'scope-changed' };
        }
        return {
            ok: true,
            scope: {
                ...scope,
                graphRevision: this.graphRevision,
            },
        };
    }
    publishArtifact(callerTerminalId, input) {
        this.load();
        const owner = this.currentEndpoint(callerTerminalId);
        if (!owner)
            return { ok: false, error: 'The calling terminal is no longer available' };
        const title = typeof input.title === 'string' ? input.title.trim() : '';
        const body = typeof input.body === 'string' ? input.body : '';
        if (!title || title.length > LINK_ARTIFACT_MAX_TITLE_CHARS) {
            return { ok: false, error: `artifact title must be 1-${LINK_ARTIFACT_MAX_TITLE_CHARS} characters` };
        }
        if (!body.trim() || body.length > teamMessages_1.TEAM_MESSAGE_MAX_BODY_CHARS) {
            return { ok: false, error: 'artifact body is empty or too large' };
        }
        const artifact = {
            artifactId: `la-${(0, crypto_1.randomUUID)()}`,
            owner,
            title,
            body,
            createdAt: Date.now(),
        };
        this.artifacts.push(artifact);
        if (this.artifacts.length > LINK_MAX_ARTIFACT_RECORDS) {
            this.artifacts.splice(0, this.artifacts.length - LINK_MAX_ARTIFACT_RECORDS);
        }
        this.commit();
        const { body: _body, ...summary } = artifact;
        return { ok: true, artifact: summary };
    }
    artifactsForReadScope(scope) {
        this.load();
        if (scope.permission !== 'read-artifact')
            return [];
        return this.artifacts
            .filter((artifact) => (0, terminalLinks_1.endpointsMatch)(artifact.owner, scope.to))
            .map((artifact) => ({
            ...artifact,
            owner: { ...artifact.owner },
        }));
    }
    /**
     * Fan a message out to every peer this terminal can send to, optionally
     * opening a DECISION (leaderless swarm: broadcast + quorum voting).
     *
     * There is no master. The opener is one voter among the recipients, the
     * outcome is decided by counting, and the result is broadcast back to
     * everyone — including the opener — so no participant holds privileged
     * knowledge of what the group decided.
     */
    async broadcast(callerTerminalId, input) {
        this.load();
        const body = typeof input.body === 'string' ? input.body : '';
        if (!body.trim() || body.length > teamMessages_1.TEAM_MESSAGE_MAX_BODY_CHARS) {
            return { ok: false, error: 'invalid-request', detail: 'message body is empty or too large' };
        }
        let peerIds = [
            ...new Set(this.links
                .filter((row) => row.state === 'active' &&
                row.permissions.includes('send') &&
                row.from.terminalId === callerTerminalId)
                .map((row) => row.to.terminalId)),
        ];
        if (peerIds.length === 0)
            return { ok: false, error: 'no-link' };
        const caller = this.deps.getTerminalInfo(callerTerminalId);
        if (!caller)
            return { ok: false, error: 'target-closed' };
        // Hierarchy scoping (v5 §4): a seated manager's broadcast fans out to its
        // DIRECT subordinates only, and leaderless voting is not meaningful
        // inside a chain of command — decisions escalate, they are not polled.
        const broadcastScope = this.deps.hierarchy?.()?.broadcastScope(callerTerminalId) ?? null;
        if (broadcastScope) {
            if (input.vote) {
                return { ok: false, error: 'hierarchy-violation', detail: broadcastScope.voteRefusal };
            }
            peerIds = peerIds.filter((peerId) => broadcastScope.allowedTargetIds.includes(peerId));
            if (peerIds.length === 0) {
                const pipelineRefusal = broadcastScope.voteRefusal.startsWith('refused: pipelines');
                return {
                    ok: false,
                    error: 'hierarchy-violation',
                    detail: pipelineRefusal
                        ? broadcastScope.voteRefusal
                        : 'refused: hierarchy — broadcast reaches only your direct subordinates, and none are linked and live.',
                };
            }
        }
        let decision;
        if (input.vote) {
            // The opener votes too — that is what makes this leaderless rather than
            // "one agent polls the others".
            const eligibleTerminalIds = [callerTerminalId, ...peerIds];
            const invalid = (0, swarmDecisions_1.validateDecisionInput)({
                question: input.vote.question,
                options: input.vote.options,
                quorum: input.vote.quorum,
                eligibleCount: eligibleTerminalIds.length,
            });
            if (invalid)
                return { ok: false, error: 'invalid-request', detail: invalid.detail };
            const options = input.vote.options ?? [...swarmDecisions_1.DEFAULT_DECISION_OPTIONS];
            decision = {
                decisionId: `dc-${(0, crypto_1.randomUUID)()}`,
                projectId: caller.projectId,
                openedByTerminalId: callerTerminalId,
                openedByName: caller.name,
                question: input.vote.question.trim(),
                options,
                quorum: input.vote.quorum ?? (0, swarmDecisions_1.defaultQuorum)(eligibleTerminalIds.length),
                eligibleTerminalIds,
                votes: [],
                state: 'open',
                createdAt: Date.now(),
            };
            this.decisions.push(decision);
            this.pruneDecisions();
            this.commit();
        }
        const deliveredTo = [];
        for (const peerId of peerIds) {
            const prompt = decision
                ? (0, linkNudge_1.composeDecisionPrompt)({
                    decisionId: decision.decisionId,
                    openedByTitle: caller.name,
                    openedByTerminalId: callerTerminalId,
                    openedByAgentKind: caller.effectiveAgentKind,
                    question: decision.question,
                    options: decision.options,
                    quorum: decision.quorum,
                    eligibleCount: decision.eligibleTerminalIds.length,
                    body,
                    ...(this.deps.getShimPath ? { shimPath: this.deps.getShimPath() } : {}),
                })
                : null;
            // Plain broadcasts ride the normal message path (durable receipts);
            // decision broadcasts deliver the composed envelope as a notice, since
            // the reply channel for them is `link vote`, not a link message.
            if (prompt) {
                const link = this.links.find((row) => row.state === 'active' &&
                    row.from.terminalId === callerTerminalId &&
                    row.to.terminalId === peerId);
                if (!link)
                    continue;
                if (await this.deliverNotice(link, `decision-${decision.decisionId}-${peerId}`, prompt)) {
                    deliveredTo.push(peerId);
                }
                continue;
            }
            const sent = await this.sendMessage(callerTerminalId, { toTerminalId: peerId, body });
            if (sent.ok)
                deliveredTo.push(peerId);
        }
        return { ok: true, deliveredTo, ...(decision ? { decision } : {}) };
    }
    /**
     * One vote per eligible terminal; re-voting while open replaces the previous
     * one. Eligibility is the durable record's own list — a terminal that was
     * not part of the broadcast cannot vote itself into the group.
     */
    async vote(callerTerminalId, input) {
        this.load();
        const decision = this.decisions.find((row) => row.decisionId === input.decisionId);
        if (!decision)
            return { ok: false, error: 'unknown-decision' };
        if (!decision.eligibleTerminalIds.includes(callerTerminalId)) {
            return { ok: false, error: 'not-eligible' };
        }
        if (!decision.options.includes(input.value)) {
            return {
                ok: false,
                error: 'invalid-option',
                detail: `expected one of: ${decision.options.join(', ')}`,
            };
        }
        // A closed decision still answers honestly rather than erroring — the
        // voter's real need is to learn what the group decided.
        if (decision.state !== 'open') {
            return { ok: true, decision, outcome: decision.outcome ?? null, late: true };
        }
        const at = Date.now();
        const existing = decision.votes.find((row) => row.terminalId === callerTerminalId);
        if (existing) {
            existing.value = input.value;
            existing.at = at;
            if (input.reason)
                existing.reason = input.reason;
        }
        else {
            decision.votes.push({
                terminalId: callerTerminalId,
                value: input.value,
                at,
                ...(input.reason ? { reason: input.reason } : {}),
            });
        }
        const outcome = (0, swarmDecisions_1.resolveOutcome)(decision);
        const deadlocked = outcome === null && (0, swarmDecisions_1.isDeadlocked)(decision);
        if (outcome) {
            decision.state = 'resolved';
            decision.outcome = outcome;
            decision.resolvedAt = at;
        }
        this.commit();
        this.deps.onDecisionChanged?.(decision);
        // Everyone hears the result at the same time, including the opener.
        if (outcome || deadlocked) {
            void this.announceDecision(decision, outcome, deadlocked);
        }
        return { ok: true, decision, outcome, late: false };
    }
    /** Human override for a decision nobody can finish (dead peer, bad options). */
    cancelDecision(decisionId) {
        this.load();
        const decision = this.decisions.find((row) => row.decisionId === decisionId);
        if (!decision || decision.state !== 'open')
            return false;
        decision.state = 'cancelled';
        decision.resolvedAt = Date.now();
        this.commit();
        this.deps.onDecisionChanged?.(decision);
        return true;
    }
    listDecisions(projectId) {
        this.load();
        return this.decisions.filter((row) => !projectId || row.projectId === projectId);
    }
    async announceDecision(decision, outcome, deadlocked) {
        const prompt = (0, linkNudge_1.composeDecisionOutcomePrompt)({
            decisionId: decision.decisionId,
            question: decision.question,
            outcome,
            quorum: decision.quorum,
            tally: (0, swarmDecisions_1.tallyVotes)(decision),
            votes: decision.votes.map((row) => ({
                name: this.deps.getTerminalInfo(row.terminalId)?.name ?? row.terminalId,
                value: row.value,
            })),
            deadlocked,
        });
        for (const terminalId of decision.eligibleTerminalIds) {
            // Announce over whichever active edge reaches that voter; the opener
            // hears it through an inbound edge if one exists, else not at all —
            // it already holds the record and the UI shows it.
            const link = this.links.find((row) => row.state === 'active' &&
                row.permissions.includes('send') &&
                row.to.terminalId === terminalId);
            if (!link)
                continue;
            await this.deliverNotice(link, `decision-outcome-${decision.decisionId}-${terminalId}`, prompt);
        }
    }
    pruneDecisions() {
        if (this.decisions.length <= LINK_MAX_DECISION_RECORDS)
            return;
        let remove = this.decisions.length - LINK_MAX_DECISION_RECORDS;
        this.decisions = this.decisions.filter((row) => {
            if (remove <= 0)
                return true;
            if (row.state === 'open')
                return true;
            remove -= 1;
            return false;
        });
    }
    /**
     * Bounded, body-free message rows for renderer surfaces (Mission Control's
     * "awaiting reply" count). Prompt bodies stay in main — they are unbounded
     * user/agent content and the UI only needs states.
     */
    listMessageSummaries(projectId, limit = 200) {
        this.load();
        const bounded = Math.max(1, Math.min(limit, 500));
        return [...this.messages]
            .reverse()
            .filter((message) => !projectId || message.projectId === projectId)
            .slice(0, bounded)
            .map((message) => ({
            messageId: message.messageId,
            linkId: message.linkId,
            projectId: message.projectId,
            fromTerminalId: message.from.terminalId,
            toTerminalId: message.to.terminalId,
            state: message.state,
            ...(message.queuedReason ? { queuedReason: message.queuedReason } : {}),
            createdAt: message.createdAt,
            ...(message.deliveredAt ? { deliveredAt: message.deliveredAt } : {}),
            ...(message.answeredAt ? { answeredAt: message.answeredAt } : {}),
            ...(message.closedAt ? { closedAt: message.closedAt } : {}),
            ...(message.closedReason ? { closedReason: message.closedReason } : {}),
            ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
            preview: this.summaryPreview(message),
        }));
    }
    /**
     * Stop waiting on a delivered message, by explicit human decision.
     *
     * The escape hatch for delegations that can never resolve on their own: a
     * broadcast whose own body says "do not reply", an answer the user already
     * read in the peer's terminal and relayed by hand, work dropped when the plan
     * changed. Without it the awaiting-reply counter only ever grows, and a
     * counter that cannot reach zero stops being read at all — which costs the
     * user the one signal that catches a genuinely stuck peer.
     *
     * Nothing is sent anywhere: this edits the sender's own bookkeeping, and the
     * peer is never told — it was not the one waiting. Closing also never costs
     * an answer: a late reply (by `--reply-to` or by token) still delivers and
     * still correlates, flipping the row to `answered`. Both timestamps then
     * stand, which is the truth — the user stopped waiting, and the answer came
     * anyway.
     */
    closeMessage(messageId) {
        this.load();
        const message = this.messages.find((row) => row.messageId === messageId);
        if (!message)
            return { ok: false, error: 'message not found' };
        if (message.closedAt)
            return { ok: true };
        if (!(0, terminalLinks_1.isLinkMessageOutstanding)(message)) {
            return { ok: false, error: 'message is not awaiting a reply' };
        }
        message.closedAt = Date.now();
        message.closedReason = 'user';
        if (message.pipeline) {
            const run = this.pipelineRuns.find((row) => row.pipelineRunId === message.pipeline.pipelineRunId && !row.closedAt);
            if (run) {
                run.state = 'cancelled';
                run.closedAt = Date.now();
                run.updatedAt = run.closedAt;
            }
        }
        this.commit();
        this.emitMessageState(message);
        return { ok: true };
    }
    /**
     * Project the link graph onto native sessions for Resume surfaces.
     *
     * A team that stopped (quit, closed terminals) leaves nothing running, but
     * the durable ledger still knows which terminals were wired together and
     * which native session each seat held — endpoints capture `nativeSessionId`
     * at bind/send time. Connected components over terminal ids (links in ANY
     * state plus message endpoints, so a pruned link cannot erase collaboration
     * evidence) become groups; each terminal contributes its NEWEST known
     * session id, because that is the conversation resuming would continue —
     * older eras of the same terminals are superseded, not part of the current
     * team.
     */
    listSessionTeams() {
        this.load();
        const parent = new Map();
        const find = (id) => {
            let root = id;
            while (parent.get(root) !== undefined && parent.get(root) !== root)
                root = parent.get(root);
            parent.set(id, root);
            return root;
        };
        const union = (a, b) => {
            if (!parent.has(a))
                parent.set(a, a);
            if (!parent.has(b))
                parent.set(b, b);
            const rootA = find(a);
            const rootB = find(b);
            if (rootA !== rootB)
                parent.set(rootA, rootB);
        };
        const sessionByTerminal = new Map();
        const agentByTerminal = new Map();
        const record = (endpoint, at) => {
            agentByTerminal.set(endpoint.terminalId, endpoint.effectiveAgentKind);
            if (!endpoint.nativeSessionId)
                return;
            const existing = sessionByTerminal.get(endpoint.terminalId);
            if (!existing || at >= existing.at) {
                sessionByTerminal.set(endpoint.terminalId, { sessionId: endpoint.nativeSessionId, at });
            }
        };
        const newestEdge = new Map();
        const touch = (terminalId, at, projectId) => {
            const existing = newestEdge.get(terminalId);
            if (!existing || at >= existing.at)
                newestEdge.set(terminalId, { at, projectId });
        };
        for (const link of this.links) {
            union(link.from.terminalId, link.to.terminalId);
            record(link.from, link.createdAt);
            record(link.to, link.createdAt);
            touch(link.from.terminalId, link.createdAt, link.projectId);
            touch(link.to.terminalId, link.createdAt, link.projectId);
        }
        for (const message of this.messages) {
            union(message.from.terminalId, message.to.terminalId);
            record(message.from, message.createdAt);
            record(message.to, message.createdAt);
            touch(message.from.terminalId, message.createdAt, message.projectId);
            touch(message.to.terminalId, message.createdAt, message.projectId);
        }
        const components = new Map();
        for (const terminalId of parent.keys()) {
            const root = find(terminalId);
            const rows = components.get(root) ?? [];
            rows.push(terminalId);
            components.set(root, rows);
        }
        const groups = [];
        for (const terminalIds of components.values()) {
            if (terminalIds.length < 2)
                continue;
            const sorted = [...terminalIds].sort();
            const members = sorted.map((terminalId) => {
                const info = this.deps.getTerminalInfo(terminalId);
                const session = sessionByTerminal.get(terminalId);
                return {
                    terminalId,
                    agentKind: info?.effectiveAgentKind ?? agentByTerminal.get(terminalId) ?? 'agent',
                    ...(info ? { name: info.name } : {}),
                    ...(session ? { sessionId: session.sessionId } : {}),
                };
            });
            const sessionIds = [...new Set(members.map((m) => m.sessionId).filter((id) => Boolean(id)))];
            // A component with no known session cannot be matched to any Resume row.
            if (sessionIds.length === 0)
                continue;
            let lastActivityAt = 0;
            let projectId = '';
            for (const terminalId of sorted) {
                const edge = newestEdge.get(terminalId);
                if (edge && edge.at >= lastActivityAt) {
                    lastActivityAt = edge.at;
                    projectId = edge.projectId;
                }
            }
            groups.push({
                groupId: `st-${sorted.join('+')}`,
                projectId,
                members,
                sessionIds,
                lastActivityAt,
            });
        }
        return groups.sort((a, b) => b.lastActivityAt - a.lastActivityAt).slice(0, 20);
    }
    /**
     * Does `fromTerminalId` hold an ACTIVE send-capable edge to `toTerminalId`?
     * Decides whether a delivered message may advertise a reply command — an
     * agent told to run a command that will fail is worse than one told plainly
     * that it has no channel back.
     */
    hasReplyPath(fromTerminalId, toTerminalId) {
        return this.links.some((row) => row.state === 'active' &&
            row.permissions.includes('send') &&
            row.from.terminalId === fromTerminalId &&
            row.to.terminalId === toTerminalId);
    }
    /**
     * Everything the calling terminal is waiting on, and everything it owes.
     *
     * Without this a host delegating to several peers has only per-message
     * receipts, so it resorts to polling each id on a timer — observed in the
     * field as a 20-minute `sleep 30` loop that could never succeed. Ownership
     * is implicit: rows are selected BY the caller's endpoint, so no terminal
     * can read another's traffic.
     */
    statusBoard(callerTerminalId, limit = 20) {
        this.load();
        this.reconcileVisibleLinks();
        const bounded = Math.max(1, Math.min(limit, 100));
        const row = (message, peerTerminalId) => ({
            messageId: message.messageId,
            peerTerminalId,
            peerName: this.deps.getTerminalInfo(peerTerminalId)?.name ?? peerTerminalId,
            state: message.state,
            createdAt: message.createdAt,
            ...(message.queuedReason ? { queuedReason: message.queuedReason } : {}),
            ...(message.deliveredAt ? { deliveredAt: message.deliveredAt } : {}),
            ...(message.answeredAt ? { answeredAt: message.answeredAt } : {}),
            ...(message.closedAt ? { closedAt: message.closedAt } : {}),
            preview: this.summaryPreview(message),
            ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
            ...(message.error ? { error: message.error } : {}),
        });
        const newestFirst = [...this.messages].reverse();
        return {
            terminalId: callerTerminalId,
            sent: newestFirst
                .filter((message) => message.from.terminalId === callerTerminalId)
                .slice(0, bounded)
                .map((message) => row(message, message.to.terminalId)),
            awaitingMyReply: newestFirst
                // A user-closed row is dropped here too: the sender stopped waiting, so
                // telling the peer it still owes an answer would send it to redo work
                // nobody is expecting.
                .filter((message) => message.to.terminalId === callerTerminalId &&
                (0, terminalLinks_1.isLinkMessageOutstanding)(message))
                .slice(0, bounded)
                .map((message) => row(message, message.from.terminalId)),
        };
    }
    /**
     * Send from the bridge-attributed caller over its outbound link. Validates
     * the edge, permission, and BOTH endpoint generations at delivery time;
     * mismatches quarantine the link and fail typed. `waitMs` bounds a receipt
     * wait; the durable state is always returned honestly at timeout.
     */
    preparePipelineAdmission(callerTerminalId, toTerminalId, input, replyTarget) {
        const hierarchy = this.deps.hierarchy?.();
        const context = hierarchy?.pipelineContext(callerTerminalId) ?? null;
        if (!context) {
            if (input.pipelineIntent || input.continueFromMessageId || input.gateDecision) {
                return { ok: false, result: { ok: false, error: 'hierarchy-violation', detail: 'refused: pipeline — this terminal is not seated in an active Pipeline.' } };
            }
            return { ok: true };
        }
        const fail = (detail) => ({
            ok: false,
            result: { ok: false, error: 'hierarchy-violation', detail },
        });
        const { activation, chart, seat, stages, stageIndex } = context;
        const openRun = this.pipelineRuns.find((run) => run.activationId === activation.activationId && !run.closedAt);
        if (input.pipelineIntent === 'handoff') {
            if (replyTarget)
                return fail('refused: pipeline — a handoff is not a reply.');
            if (stageIndex >= stages.length - 1) {
                return fail('refused: pipeline — this is the final stage. Write the result here, then run `report --complete`.');
            }
            const nextNode = stages[stageIndex + 1];
            const nextSeat = activation.seats.find((row) => row.nodeId === nextNode.nodeId && row.state === 'active');
            if (!nextSeat || nextSeat.endpoint.terminalId !== toTerminalId) {
                return fail(`refused: pipeline — ${nextNode.label} is the next active stage.`);
            }
            let run;
            let continuedFromMessageId;
            let hopCount;
            if (stageIndex === 0) {
                if (input.continueFromMessageId)
                    return fail('refused: pipeline — stage 1 must omit --continue.');
                if (openRun && openRun.state !== 'handoff-failed') {
                    return fail(`refused: pipeline — another run is open at stage ${openRun.currentStageIndex}/${openRun.stageCount}. Ask the user to resolve or cancel it.`);
                }
                run = openRun ?? {
                    pipelineRunId: `pr-${(0, crypto_1.randomUUID)()}`,
                    activationId: activation.activationId,
                    projectId: activation.projectId,
                    currentStageIndex: 1,
                    stageCount: stages.length,
                    state: 'handoff-pending',
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                };
                if (!openRun)
                    this.pipelineRuns.push(run);
                run.state = 'handoff-pending';
                hopCount = 1;
            }
            else {
                continuedFromMessageId = input.continueFromMessageId?.trim();
                if (!continuedFromMessageId) {
                    return fail(`refused: pipeline — stage ${stageIndex + 1} must use --continue=<accepted-input-message-id>.`);
                }
                const acceptedInput = this.messages.find((message) => message.messageId === continuedFromMessageId);
                if (!acceptedInput?.pipeline
                    || !['handoff', 'rework'].includes(acceptedInput.pipeline.kind)
                    || acceptedInput.pipeline.activationId !== activation.activationId
                    || acceptedInput.pipeline.checkerNodeId !== seat.nodeId
                    || !openRun
                    || acceptedInput.pipeline.pipelineRunId !== openRun.pipelineRunId) {
                    return fail('refused: pipeline — --continue does not name this stage\'s accepted input in the active run.');
                }
                const accept = this.messages.find((message) => message.replyToMessageId === acceptedInput.messageId
                    && message.pipeline?.kind === 'gate-accept'
                    && message.pipeline.pipelineRunId === openRun.pipelineRunId
                    && (message.state === 'delivered' || message.state === 'answered'));
                if (!accept)
                    return fail('refused: pipeline — that input has not been accepted by this stage.');
                const ownsProof = this.messages.some((message) => message.pipeline?.continuedFromMessageId === acceptedInput.messageId
                    && message.state !== 'failed' && message.state !== 'cancelled');
                if (ownsProof)
                    return fail('refused: pipeline — that accepted input already owns a live continuation.');
                if (!['stage-active', 'handoff-failed'].includes(openRun.state)
                    || openRun.currentStageIndex !== stageIndex + 1) {
                    return fail('refused: pipeline — the active run is not ready for this stage to hand off.');
                }
                run = openRun;
                run.state = 'handoff-pending';
                hopCount = (acceptedInput.hopCount ?? stageIndex) + 1;
            }
            return {
                ok: true,
                run,
                hopCount,
                metadata: {
                    activationId: activation.activationId,
                    pipelineRunId: run.pipelineRunId,
                    producerNodeId: seat.nodeId,
                    checkerNodeId: nextNode.nodeId,
                    kind: 'handoff',
                    gateRound: 0,
                    ...(continuedFromMessageId ? { continuedFromMessageId } : {}),
                },
            };
        }
        if (replyTarget?.pipeline) {
            const original = replyTarget.pipeline;
            if (original.activationId !== activation.activationId || !openRun
                || original.pipelineRunId !== openRun.pipelineRunId) {
                return fail('refused: pipeline — that message is not part of this activation\'s open run.');
            }
            if (original.kind === 'handoff' || original.kind === 'rework') {
                if (original.checkerNodeId !== seat.nodeId || !input.gateDecision) {
                    return fail('refused: pipeline — reply with --gate=accept or --gate=reject.');
                }
                if (input.gateDecision === 'reject') {
                    const cap = chart.maxGateRounds ?? 2;
                    if (original.gateRound >= cap) {
                        openRun.state = 'gate-cap';
                        openRun.updatedAt = Date.now();
                        openRun.currentMessageId = replyTarget.messageId;
                        this.commit();
                        const producerLabel = chart.nodes.find((node) => node.nodeId === original.producerNodeId)?.label ?? original.producerNodeId;
                        const detail = `refused: pipeline — ${producerLabel} has been sent back ${cap} times (limit ${cap}). Stop and write the failure in your terminal; the user will decide.`;
                        hierarchy.recordViolation(activation.activationId, {
                            at: Date.now(),
                            fromTerminalId: callerTerminalId,
                            fromNodeId: seat.nodeId,
                            toTerminalId: replyTarget.from.terminalId,
                            toNodeId: original.producerNodeId,
                            route: detail,
                        });
                        hierarchy.recordEscalation(activation.activationId, {
                            kind: 'pipeline-gate-cap',
                            pipelineRunId: openRun.pipelineRunId,
                            triggeringMessageId: replyTarget.messageId,
                            at: Date.now(),
                            fromTerminalId: callerTerminalId,
                            fromNodeId: seat.nodeId,
                            toTerminalId: replyTarget.from.terminalId,
                            preview: `${producerLabel} reached the ${cap}-round gate limit`,
                        });
                        return fail(detail);
                    }
                }
                openRun.state = 'gate-decision-pending';
                openRun.updatedAt = Date.now();
                return {
                    ok: true,
                    run: openRun,
                    hopCount: replyTarget.hopCount ?? 1,
                    ...(input.gateDecision === 'accept' ? { expectsReply: false } : {}),
                    metadata: {
                        ...original,
                        kind: input.gateDecision === 'accept' ? 'gate-accept' : 'gate-reject',
                        gateRound: input.gateDecision === 'reject' ? original.gateRound + 1 : original.gateRound,
                    },
                };
            }
            if (original.kind === 'gate-reject') {
                if (original.producerNodeId !== seat.nodeId || input.gateDecision) {
                    return fail('refused: pipeline — return corrected work as an ordinary reply to the exact reject.');
                }
                openRun.state = 'rework-pending';
                openRun.updatedAt = Date.now();
                return { ok: true, run: openRun, hopCount: replyTarget.hopCount ?? 1, metadata: { ...original, kind: 'rework' } };
            }
            return fail('refused: pipeline — a gate acceptance has no reply duty.');
        }
        if (input.continueFromMessageId)
            return fail('refused: pipeline — --continue is valid only with report/handoff.');
        // A raw-send refusal must teach a command main would actually admit.
        // Middle stages require a validated accepted-input proof; before accept,
        // point at the pending gate instead of suggesting an invalid bare report.
        if (stageIndex > 0 && stageIndex < stages.length - 1 && openRun?.currentMessageId) {
            const current = this.messages.find((message) => message.messageId === openRun.currentMessageId);
            const belongsToStage = current?.pipeline?.activationId === activation.activationId
                && current.pipeline.pipelineRunId === openRun.pipelineRunId
                && current.pipeline.checkerNodeId === seat.nodeId
                && (current.pipeline.kind === 'handoff' || current.pipeline.kind === 'rework');
            if (belongsToStage && openRun.state === 'stage-active'
                && openRun.currentStageIndex === stageIndex + 1) {
                const accepted = this.messages.some((message) => message.replyToMessageId === current.messageId
                    && message.pipeline?.kind === 'gate-accept'
                    && message.pipeline.pipelineRunId === openRun.pipelineRunId
                    && (message.state === 'delivered' || message.state === 'answered'));
                if (accepted)
                    return { ok: true, pipelineContinuationMessageId: current.messageId };
            }
            if (belongsToStage && openRun.state === 'gate-pending' && (0, terminalLinks_1.isLinkMessageOutstanding)(current)) {
                return { ok: true, pipelinePendingGateMessageId: current.messageId };
            }
        }
        return { ok: true };
    }
    updatePipelineAfterDelivery(message) {
        const metadata = message.pipeline;
        if (!metadata)
            return;
        const run = this.pipelineRuns.find((row) => row.pipelineRunId === metadata.pipelineRunId && !row.closedAt);
        if (!run)
            return;
        if (metadata.kind === 'handoff' || metadata.kind === 'rework') {
            run.state = 'gate-pending';
            run.currentMessageId = message.messageId;
        }
        else if (metadata.kind === 'gate-reject') {
            run.state = 'rework-needed';
            run.currentMessageId = message.messageId;
        }
        else {
            run.state = 'stage-active';
            const context = this.deps.hierarchy?.()?.pipelineContext(message.from.terminalId);
            if (context?.activation.activationId === metadata.activationId) {
                run.currentStageIndex = context.stageIndex + 1;
            }
            // The accepted input, not the acknowledgement, is the continuation proof.
            run.currentMessageId = message.replyToMessageId;
        }
        run.updatedAt = Date.now();
    }
    updatePipelineAfterFailure(message) {
        const metadata = message.pipeline;
        if (!metadata)
            return;
        const run = this.pipelineRuns.find((row) => row.pipelineRunId === metadata.pipelineRunId && !row.closedAt);
        if (!run)
            return;
        if (metadata.kind === 'handoff')
            run.state = 'handoff-failed';
        else if (metadata.kind === 'rework')
            run.state = 'rework-needed';
        else
            run.state = 'gate-pending';
        run.updatedAt = Date.now();
    }
    activePipelineRun(activationId) {
        this.load();
        const run = this.pipelineRuns.find((row) => row.activationId === activationId && !row.closedAt);
        return run ? { ...run } : null;
    }
    /** Renderer-safe projection. Gate count remains derived from the durable
     * message chain instead of being duplicated on the run record. */
    pipelineRunStatus(activationId, chart) {
        this.load();
        const run = this.pipelineRuns.find((row) => row.activationId === activationId && !row.closedAt);
        const stages = (0, pipeline_1.pipelineStages)(chart);
        if (!run || stages.length === 0)
            return null;
        const message = run.currentMessageId
            ? this.messages.find((row) => row.messageId === run.currentMessageId)
            : undefined;
        const metadata = message?.pipeline;
        const currentIndex = Math.max(1, Math.min(run.currentStageIndex, stages.length));
        const activeStage = stages[currentIndex - 1];
        const nextStage = stages[currentIndex];
        const state = run.state === 'gate-cap'
            ? 'escalated'
            : run.state === 'blocked'
                ? 'blocked'
                : run.state === 'rework-needed'
                    ? 'waiting-rework'
                    : run.state === 'gate-pending'
                        || run.state === 'gate-decision-pending'
                        || run.state === 'rework-pending'
                        ? 'waiting-gate'
                        : 'stage-active';
        const pairFromMessage = state === 'waiting-gate' || state === 'waiting-rework' || state === 'escalated';
        const producerNodeId = pairFromMessage ? metadata?.producerNodeId : activeStage?.nodeId;
        const checkerNodeId = pairFromMessage ? metadata?.checkerNodeId : nextStage?.nodeId;
        return {
            pipelineRunId: run.pipelineRunId,
            currentStageIndex: currentIndex,
            stageCount: stages.length,
            state,
            ...(producerNodeId ? { producerNodeId } : {}),
            ...(checkerNodeId ? { checkerNodeId } : {}),
            gateRound: metadata?.gateRound ?? 0,
            maxGateRounds: chart.maxGateRounds ?? 2,
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
        };
    }
    listPipelineRuns(projectId) {
        this.load();
        return this.pipelineRuns
            .filter((run) => !projectId || run.projectId === projectId)
            .map((run) => ({ ...run }));
    }
    pipelineGateRound(messageId) {
        this.load();
        return this.messages.find((message) => message.messageId === messageId)?.pipeline?.gateRound ?? 0;
    }
    cancelPipelineRuns(activationId) {
        this.load();
        let changed = false;
        const closedMessages = [];
        for (const run of this.pipelineRuns) {
            if (run.activationId !== activationId || run.closedAt)
                continue;
            const currentMessage = run.currentMessageId
                ? this.messages.find((row) => row.messageId === run.currentMessageId)
                : undefined;
            if (currentMessage && (0, terminalLinks_1.isLinkMessageOutstanding)(currentMessage)) {
                currentMessage.closedAt = Date.now();
                closedMessages.push(currentMessage);
            }
            run.state = 'cancelled';
            run.closedAt = Date.now();
            run.updatedAt = run.closedAt;
            changed = true;
        }
        if (changed) {
            this.commit();
            for (const message of closedMessages)
                this.emitMessageState(message);
        }
    }
    resolvePipelineRun(activationId) {
        this.load();
        const run = this.pipelineRuns.find((row) => row.activationId === activationId && !row.closedAt);
        if (!run)
            return { ok: false, error: 'no open Pipeline run' };
        const currentMessage = run.currentMessageId
            ? this.messages.find((row) => row.messageId === run.currentMessageId)
            : undefined;
        if (currentMessage && (0, terminalLinks_1.isLinkMessageOutstanding)(currentMessage)) {
            currentMessage.closedAt = Date.now();
        }
        run.state = 'cancelled';
        run.closedAt = Date.now();
        run.updatedAt = run.closedAt;
        this.commit();
        if (currentMessage?.closedAt)
            this.emitMessageState(currentMessage);
        return { ok: true };
    }
    completePipelineRun(callerTerminalId) {
        this.load();
        const context = this.deps.hierarchy?.()?.pipelineContext(callerTerminalId);
        if (!context || context.stageIndex !== context.stages.length - 1) {
            return { ok: false, error: 'hierarchy-violation', detail: 'refused: pipeline — only the final frozen seat may run report --complete.' };
        }
        const run = this.pipelineRuns.find((row) => row.activationId === context.activation.activationId && !row.closedAt);
        if (!run || run.state !== 'stage-active' || run.currentStageIndex !== run.stageCount) {
            return { ok: false, error: 'hierarchy-violation', detail: 'refused: pipeline — accept the current input before completing the run.' };
        }
        run.state = 'completed';
        run.closedAt = Date.now();
        run.updatedAt = run.closedAt;
        this.commit();
        return {
            ok: true,
            receipt: {
                messageId: run.pipelineRunId,
                linkId: '',
                toTerminalId: 'user',
                state: 'delivered',
                deliveredAt: run.closedAt,
            },
        };
    }
    blockPipelineRun(callerTerminalId, body) {
        this.load();
        const hierarchy = this.deps.hierarchy?.();
        const context = hierarchy?.pipelineContext(callerTerminalId);
        if (!context)
            return { ok: false, error: 'hierarchy-violation', detail: 'refused: pipeline — no active Pipeline seat.' };
        let run = this.pipelineRuns.find((row) => row.activationId === context.activation.activationId && !row.closedAt);
        if (run && run.currentStageIndex !== context.stageIndex + 1) {
            return { ok: false, error: 'hierarchy-violation', detail: 'refused: pipeline — no active run reaches this stage.' };
        }
        if (!run) {
            if (context.stageIndex !== 0) {
                return { ok: false, error: 'hierarchy-violation', detail: 'refused: pipeline — no active run reaches this stage.' };
            }
            run = {
                pipelineRunId: `pr-${(0, crypto_1.randomUUID)()}`,
                activationId: context.activation.activationId,
                projectId: context.activation.projectId,
                currentStageIndex: 1,
                stageCount: context.stages.length,
                state: 'blocked',
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            this.pipelineRuns.push(run);
        }
        run.state = 'blocked';
        run.currentStageIndex = context.stageIndex + 1;
        run.updatedAt = Date.now();
        this.commit();
        hierarchy.recordEscalation(context.activation.activationId, {
            kind: 'pipeline-stage-blocked',
            pipelineRunId: run.pipelineRunId,
            at: Date.now(),
            fromTerminalId: callerTerminalId,
            fromNodeId: context.seat.nodeId,
            toTerminalId: 'user',
            preview: previewOfBody(body),
        });
        return {
            ok: true,
            receipt: {
                messageId: run.pipelineRunId,
                linkId: '',
                toTerminalId: 'user',
                state: 'delivered',
                deliveredAt: Date.now(),
            },
        };
    }
    async sendMessage(callerTerminalId, input) {
        this.load();
        const body = typeof input.body === 'string' ? input.body : '';
        if (!body.trim() || body.length > teamMessages_1.TEAM_MESSAGE_MAX_BODY_CHARS) {
            return { ok: false, error: 'invalid-request', detail: 'message body is empty or too large' };
        }
        // Newest active row wins. Older quarantined generations intentionally
        // remain in the ledger for audit and must never shadow a fresh re-link.
        const link = [...this.links].reverse().find((row) => row.state === 'active' &&
            row.from.terminalId === callerTerminalId &&
            row.to.terminalId === input.toTerminalId) ?? [...this.links].reverse().find((row) => row.from.terminalId === callerTerminalId && row.to.terminalId === input.toTerminalId);
        if (!link)
            return { ok: false, error: 'no-link' };
        if (link.state === 'quarantined')
            return { ok: false, error: 'quarantined' };
        if (!link.permissions.includes('send'))
            return { ok: false, error: 'permission-denied' };
        const validation = this.validateLiveLink(link);
        if (!validation.ok) {
            this.commit(true);
            this.deps.onDeliveryFailed?.({ link, error: validation.error });
            return { ok: false, error: validation.error };
        }
        if (validation.changed)
            this.commit(true);
        const fromInfo = this.deps.getTerminalInfo(link.from.terminalId);
        const toInfo = this.deps.getTerminalInfo(link.to.terminalId);
        if (!toInfo || !fromInfo)
            return { ok: false, error: 'target-closed' };
        const inFlight = this.messages.filter((row) => row.state === 'queued' || row.state === 'delivering').length;
        if (inFlight >= LINK_MESSAGE_MAX_IN_FLIGHT) {
            return {
                ok: false,
                error: 'invalid-request',
                detail: 'link in-flight message budget is exhausted',
            };
        }
        // Reply correlation: only the RECIPIENT of the original may answer it, and
        // only over an edge pointing back at that original's sender. Anything else
        // is dropped silently from the correlation (the message still sends) —
        // a bad id must never let one terminal close another's delegation.
        const replyTarget = this.resolveAnsweredMessage(callerTerminalId, link.to.terminalId, input.replyToMessageId);
        if (input.gateDecision && !replyTarget) {
            return {
                ok: false,
                error: 'hierarchy-violation',
                detail: 'refused: pipeline — --gate requires a live, correlated Pipeline handoff or rework reply.',
            };
        }
        const pipelineAdmission = this.preparePipelineAdmission(callerTerminalId, input.toTerminalId, input, replyTarget);
        if (!pipelineAdmission.ok)
            return pipelineAdmission.result;
        // Hierarchy guard (v5 §4): agent-originated sends between seated
        // terminals must follow the chain of command. Replies always follow
        // their message (invariant 27); refusals teach the correct route.
        const hopCount = pipelineAdmission.hopCount
            ?? this.inheritedHopCount(callerTerminalId, replyTarget);
        const guard = this.deps.hierarchy?.();
        if (guard) {
            const verdict = guard.checkSend({
                fromTerminalId: callerTerminalId,
                toTerminalId: input.toTerminalId,
                isReply: Boolean(replyTarget),
                hopCount,
                senderAgentKind: fromInfo.effectiveAgentKind,
                ...(input.pipelineIntent ? { pipelineIntent: input.pipelineIntent } : {}),
                ...(replyTarget?.pipeline ? { replyPipelineKind: replyTarget.pipeline.kind } : {}),
                ...(input.gateDecision ? { gateDecision: input.gateDecision } : {}),
                ...(pipelineAdmission.pipelineContinuationMessageId
                    ? { pipelineContinuationMessageId: pipelineAdmission.pipelineContinuationMessageId }
                    : {}),
                ...(pipelineAdmission.pipelinePendingGateMessageId
                    ? { pipelinePendingGateMessageId: pipelineAdmission.pipelinePendingGateMessageId }
                    : {}),
            });
            if (verdict && !verdict.allow) {
                return { ok: false, error: 'hierarchy-violation', detail: verdict.detail };
            }
        }
        const message = {
            messageId: `lm-${(0, crypto_1.randomUUID)()}`,
            linkId: link.linkId,
            projectId: link.projectId,
            from: { ...link.from },
            to: { ...link.to },
            body,
            preview: previewOfBody(body),
            state: 'queued',
            ...(link.delivery === 'confirm'
                ? { queuedReason: 'confirmation-required' }
                : {}),
            hopCount,
            createdAt: Date.now(),
            // Reply capability, delivered only inside the recipient's envelope —
            // the attribution path for agents PTY ancestry can never identify.
            ...(pipelineAdmission.expectsReply === false
                ? {}
                : { replyToken: (0, crypto_1.randomBytes)(12).toString('hex') }),
            ...(replyTarget ? { replyToMessageId: replyTarget.messageId } : {}),
            ...(pipelineAdmission.metadata ? { pipeline: pipelineAdmission.metadata } : {}),
            ...(pipelineAdmission.expectsReply === false ? { expectsReply: false } : {}),
        };
        if (pipelineAdmission.run) {
            pipelineAdmission.run.currentMessageId = message.messageId;
            pipelineAdmission.run.updatedAt = Date.now();
        }
        this.messages.push(message);
        this.commit();
        this.emitMessageState(message);
        if (link.delivery === 'confirm') {
            // Strict mode: stays queued for an explicit user confirmation surface.
            // A waiting caller returns immediately because the durable reason is
            // already known; it must not burn its timeout pretending progress is
            // still automatic.
            if (input.waitMs && input.waitMs > 0) {
                await this.waitForSettled(message.messageId, Math.min(input.waitMs, RECEIPT_WAIT_MAX_MS));
            }
            return this.receiptResult(message, input.waitMs);
        }
        const delivery = this.enqueueDelivery(link.to.terminalId, async () => {
            await this.deliverQueuedMessage(link, message, fromInfo, toInfo);
        }).catch((error) => {
            if (message.state === 'queued' || message.state === 'delivering') {
                this.failMessage(link, message, 'delivery-failed', error);
            }
        });
        void delivery;
        if (input.waitMs && input.waitMs > 0) {
            await this.waitForSettled(message.messageId, Math.min(input.waitMs, RECEIPT_WAIT_MAX_MS));
        }
        // Without --wait the journaled queued receipt returns immediately while
        // the target-specific chain performs readiness + staged submit. This
        // keeps the CLI bridge timeout shorter than the readiness deadline without
        // ever reporting a false failure for a delivery still running in main.
        // With --wait, a terminal failure (failed/cancelled) must surface as
        // ok:false so host agents do not treat a dead delivery as success
        // (Windows field: Interaction board failed while CLI printed ok:true).
        return this.receiptResult(message, input.waitMs);
    }
    /**
     * Persist the resource-owner half of a cross-device link. The originating
     * host may display an active edge only after this method returns success.
     */
    admitFederatedLink(input) {
        this.load();
        const operationId = input.operationId?.trim();
        if (!operationId || !input.linkId || !input.originDeviceId || input.from.terminalGeneration <= 0) {
            return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Malformed federated admission.' } };
        }
        const byOperation = this.federatedAdmissions.find((row) => row.operationId === operationId);
        if (byOperation) {
            const same = byOperation.linkId === input.linkId &&
                byOperation.originDeviceId === input.originDeviceId &&
                byOperation.from.terminalId === input.from.terminalId &&
                byOperation.from.terminalGeneration === input.from.terminalGeneration &&
                byOperation.to.terminalId === input.to.terminalId &&
                byOperation.to.terminalGeneration === input.to.terminalGeneration;
            return same
                ? { ok: true, admission: { ...byOperation }, created: false }
                : { ok: false, error: { code: 'DEVICE_OPERATION_CONFLICT', message: 'That operation id was already used for another link.' } };
        }
        const current = this.currentEndpoint(input.to.terminalId);
        const info = this.deps.getTerminalInfo(input.to.terminalId);
        if (!current || !info) {
            return { ok: false, error: { code: 'DEVICE_TERMINAL_NOT_RUNNING', message: 'The target terminal is not running.' } };
        }
        if (!info.isInteractiveAgent) {
            return { ok: false, error: { code: 'DEVICE_TERMINAL_NOT_AI', message: 'Federated links require an interactive AI terminal.' } };
        }
        if (current.terminalGeneration !== input.to.terminalGeneration ||
            current.projectId !== input.to.projectId ||
            current.effectiveAgentKind !== input.to.agentType) {
            return { ok: false, error: { code: 'DEVICE_GENERATION_MISMATCH', message: 'The target terminal changed. Refresh the peer catalog and link again.' } };
        }
        // A new human-authorized admission supersedes older mirrors for this
        // origin/link pair; stale rows stay in the audit ledger as quarantined.
        for (const row of this.federatedAdmissions) {
            if (row.originDeviceId === input.originDeviceId && row.linkId === input.linkId && row.state === 'active') {
                row.state = 'quarantined';
                row.quarantineReason = 'peer-generation-mismatch';
            }
        }
        const admission = {
            admissionId: `fa-${(0, crypto_1.randomUUID)()}`,
            linkId: input.linkId,
            operationId,
            originDeviceId: input.originDeviceId,
            originDeviceName: input.originDeviceName || input.originDeviceId,
            from: { ...input.from },
            to: { ...current },
            state: 'active',
            createdAt: Date.now(),
        };
        this.federatedAdmissions.push(admission);
        this.commit();
        return { ok: true, admission: { ...admission }, created: true };
    }
    listFederatedAdmissions() {
        this.load();
        for (const admission of this.federatedAdmissions) {
            if (admission.state !== 'active')
                continue;
            this.validateFederatedAdmission(admission);
        }
        return this.federatedAdmissions.map((row) => ({ ...row, from: { ...row.from }, to: { ...row.to } }));
    }
    /** Generation-bound direct prompt used by a trusted peer control surface
     * (including the phone host proxy). This deliberately has no link/reply
     * semantics, but it retains the exact same readiness, serializer, and
     * positive target-acceptance contract as conversational delivery. */
    async submitFederatedDirect(input) {
        this.load();
        const body = typeof input.body === 'string' ? input.body : '';
        if (!input.operationId || !input.terminalId || !Number.isSafeInteger(input.terminalGeneration) ||
            input.terminalGeneration <= 0 || !body.trim() || body.length > teamMessages_1.TEAM_MESSAGE_MAX_BODY_CHARS) {
            return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Direct peer prompt is malformed, empty, or too large.' } };
        }
        let record = this.directSubmissions.find((row) => row.operationId === input.operationId);
        if (record) {
            if (record.terminalId !== input.terminalId ||
                record.terminalGeneration !== input.terminalGeneration || record.body !== body) {
                return { ok: false, error: { code: 'DEVICE_OPERATION_CONFLICT', message: 'That operation id was already used for another prompt.' } };
            }
            if (record.state === 'delivered')
                return { ok: true, deliveredAt: record.deliveredAt ?? record.createdAt };
            if (record.state !== 'queued') {
                return { ok: false, error: { code: 'DEVICE_OPERATION_CONFLICT', message: 'The earlier submit may have crossed the PTY boundary and will not be replayed.' } };
            }
        }
        else {
            record = {
                operationId: input.operationId,
                terminalId: input.terminalId,
                terminalGeneration: input.terminalGeneration,
                body,
                state: 'queued',
                createdAt: Date.now(),
            };
            this.directSubmissions.push(record);
            if (this.directSubmissions.length > 500) {
                const removable = this.directSubmissions.findIndex((row) => row.state !== 'queued' && row.state !== 'delivering');
                if (removable >= 0)
                    this.directSubmissions.splice(removable, 1);
            }
            this.commit();
        }
        await this.enqueueDelivery(record.terminalId, () => this.deliverDirectSubmission(record));
        if (record.state === 'delivered')
            return { ok: true, deliveredAt: record.deliveredAt ?? Date.now() };
        const generationFailure = record.error === 'generation-mismatch' || record.error === 'target-closed';
        return {
            ok: false,
            error: {
                code: generationFailure ? 'DEVICE_GENERATION_MISMATCH' : 'DEVICE_INTERNAL',
                message: record.error === 'delivery-unconfirmed'
                    ? 'The prompt crossed the PTY boundary, but the target agent did not confirm acceptance. It was not retried.'
                    : 'The target agent did not accept the direct peer prompt.',
            },
        };
    }
    async deliverDirectSubmission(record) {
        if (record.state !== 'queued')
            return;
        const current = this.currentEndpoint(record.terminalId);
        const info = this.deps.getTerminalInfo(record.terminalId);
        if (!current || !info?.isInteractiveAgent) {
            record.state = 'failed';
            record.error = 'target-closed';
            this.commit();
            return;
        }
        if (current.terminalGeneration !== record.terminalGeneration) {
            record.state = 'failed';
            record.error = 'generation-mismatch';
            this.commit();
            return;
        }
        try {
            const readiness = this.deps.prepareTarget
                ? await this.deps.prepareTarget(record.terminalId, info.promptTarget, 0)
                : { ok: true };
            if (!readiness.ok) {
                record.state = 'failed';
                record.error = readiness.reason === 'exited' ? 'target-closed' : 'delivery-failed';
                this.commit();
                return;
            }
        }
        catch {
            record.state = 'failed';
            record.error = 'delivery-failed';
            this.commit();
            return;
        }
        const serializer = this.deps.getSerializer();
        if (!serializer || this.currentEndpoint(record.terminalId)?.terminalGeneration !== record.terminalGeneration) {
            record.state = 'failed';
            record.error = serializer ? 'generation-mismatch' : 'delivery-failed';
            this.commit();
            return;
        }
        let probe;
        try {
            probe = await this.deps.createSubmissionProbe(record.terminalId, info.promptTarget, { allowUnready: false });
        }
        catch {
            record.state = 'failed';
            record.error = 'delivery-failed';
            this.commit();
            return;
        }
        record.state = 'delivering';
        this.commit();
        let submissionArmed = false;
        try {
            await serializer.submitTeamPrompt({
                terminalId: record.terminalId,
                runId: `direct:${record.operationId}`,
                prompt: record.body,
                target: info.promptTarget,
                ...(probe.composerPosition ? { composerPosition: probe.composerPosition } : {}),
                onSubmitEnter: () => {
                    submissionArmed = true;
                    probe.armSubmission();
                },
            });
            const acceptance = await probe.waitForAcceptance();
            if (!acceptance.ok) {
                record.state = 'failed';
                record.error = 'delivery-unconfirmed';
            }
            else if (this.currentEndpoint(record.terminalId)?.terminalGeneration !== record.terminalGeneration) {
                record.state = 'failed';
                record.error = 'generation-mismatch';
            }
            else {
                record.state = 'delivered';
                record.deliveredAt = Date.now();
            }
            this.commit();
        }
        catch {
            record.state = 'failed';
            record.error = submissionArmed ? 'delivery-unconfirmed' : 'delivery-failed';
            this.commit();
        }
        finally {
            probe.dispose();
        }
    }
    /**
     * Owner-side accepted delivery. The returned success is a target-composer
     * acceptance receipt, not merely a socket/write acknowledgement.
     */
    async deliverFederatedMessage(input) {
        this.load();
        const body = typeof input.body === 'string' ? input.body : '';
        if (!input.operationId || !input.messageId || !body.trim() || body.length > teamMessages_1.TEAM_MESSAGE_MAX_BODY_CHARS) {
            return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'Federated message is empty or too large.' } };
        }
        const admission = this.federatedAdmissions.find((row) => row.admissionId === input.admissionId);
        if (!admission || admission.linkId !== input.linkId || admission.originDeviceId !== input.originDeviceId) {
            return { ok: false, error: { code: 'DEVICE_GRANT_MISSING', message: 'This peer has not admitted that conversational link.' } };
        }
        if (admission.from.terminalId !== input.from.terminalId ||
            admission.from.terminalGeneration !== input.from.terminalGeneration ||
            admission.to.terminalId !== input.to.terminalId ||
            admission.to.terminalGeneration !== input.to.terminalGeneration) {
            return { ok: false, error: { code: 'DEVICE_GENERATION_MISMATCH', message: 'A link endpoint changed after admission.' } };
        }
        const admissionError = this.validateFederatedAdmission(admission);
        if (admissionError) {
            this.commit();
            return { ok: false, error: admissionError };
        }
        let message = this.federatedMessages.find((row) => row.operationId === input.operationId);
        if (message) {
            const same = message.messageId === input.messageId &&
                message.linkId === input.linkId &&
                message.from.terminalId === input.from.terminalId &&
                message.to.terminalId === input.to.terminalId &&
                message.body === body;
            if (!same) {
                return { ok: false, error: { code: 'DEVICE_OPERATION_CONFLICT', message: 'That operation id was already used for another message.' } };
            }
            if (message.state === 'delivered' || message.state === 'answered') {
                return { ok: true, deliveredAt: message.deliveredAt ?? message.createdAt };
            }
            if (message.state !== 'queued') {
                return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'The earlier delivery did not complete and will not be replayed.' } };
            }
        }
        else {
            message = {
                messageId: input.messageId,
                operationId: input.operationId,
                admissionId: input.admissionId,
                linkId: input.linkId,
                originDeviceId: input.originDeviceId,
                from: { ...input.from },
                to: { ...admission.to },
                body,
                preview: previewOfBody(body),
                state: 'queued',
                createdAt: Date.now(),
                replyToken: input.replyToken,
            };
            this.federatedMessages.push(message);
            this.commit();
        }
        await this.enqueueDelivery(admission.to.terminalId, () => this.deliverFederatedInbound(admission, message));
        if (message.state === 'delivered' || message.state === 'answered') {
            return { ok: true, deliveredAt: message.deliveredAt ?? Date.now() };
        }
        return {
            ok: false,
            error: {
                code: message.error === 'generation-mismatch' ? 'DEVICE_GENERATION_MISMATCH' : 'DEVICE_INTERNAL',
                message: message.error === 'delivery-unconfirmed'
                    ? 'The prompt crossed the PTY boundary but the target agent did not confirm acceptance; it was not retried.'
                    : 'The target agent did not accept the federated message.',
            },
        };
    }
    /** Reply delivery on the originating host; its own edge ledger is the admit. */
    async deliverFederatedReply(input) {
        const current = this.currentEndpoint(input.toTerminalId);
        const info = this.deps.getTerminalInfo(input.toTerminalId);
        if (!current || !info) {
            return { ok: false, error: { code: 'DEVICE_TERMINAL_NOT_RUNNING', message: 'The originating terminal is no longer running.' } };
        }
        if (current.terminalGeneration !== input.toTerminalGeneration) {
            return { ok: false, error: { code: 'DEVICE_GENERATION_MISMATCH', message: 'The originating terminal was restarted.' } };
        }
        const synthetic = {
            admissionId: `reply:${input.linkId}`,
            linkId: input.linkId,
            operationId: input.operationId,
            originDeviceId: input.originDeviceId,
            originDeviceName: input.from.deviceName,
            from: { ...input.from },
            to: current,
            state: 'active',
            createdAt: Date.now(),
        };
        let row = this.federatedMessages.find((item) => item.operationId === input.operationId);
        if (!row) {
            row = {
                messageId: input.messageId,
                operationId: input.operationId,
                admissionId: synthetic.admissionId,
                linkId: input.linkId,
                originDeviceId: input.originDeviceId,
                from: { ...input.from },
                to: current,
                body: input.body,
                preview: previewOfBody(input.body),
                state: 'queued',
                createdAt: Date.now(),
                replyToken: input.replyToken,
            };
            this.federatedMessages.push(row);
            this.commit();
        }
        if (row.state === 'delivered' || row.state === 'answered') {
            return { ok: true, deliveredAt: row.deliveredAt ?? row.createdAt };
        }
        if (row.state !== 'queued') {
            return { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'The earlier reply was not accepted and will not be replayed.' } };
        }
        await this.enqueueDelivery(current.terminalId, () => this.deliverFederatedInbound(synthetic, row, { allowActiveTurnComposer: true }));
        const settled = this.federatedMessages.find((item) => item.operationId === input.operationId);
        return settled?.state === 'delivered' || settled?.state === 'answered'
            ? { ok: true, deliveredAt: settled.deliveredAt ?? Date.now() }
            : { ok: false, error: { code: 'DEVICE_INTERNAL', message: 'The originating agent did not accept the reply.' } };
    }
    validateFederatedAdmission(admission) {
        if (admission.state !== 'active') {
            return { code: 'DEVICE_GRANT_MISSING', message: 'The federated admission is quarantined.' };
        }
        const current = this.currentEndpoint(admission.to.terminalId);
        if (!current) {
            admission.state = 'quarantined';
            admission.quarantineReason = 'peer-terminal-gone';
            return { code: 'DEVICE_TERMINAL_NOT_RUNNING', message: 'The admitted target terminal is no longer running.' };
        }
        if (current.projectId !== admission.to.projectId) {
            admission.state = 'quarantined';
            admission.quarantineReason = 'peer-project-out-of-scope';
            return { code: 'DEVICE_PROJECT_OUT_OF_SCOPE', message: 'The admitted terminal moved outside its project scope.' };
        }
        if (current.terminalGeneration !== admission.to.terminalGeneration ||
            current.effectiveAgentKind !== admission.to.effectiveAgentKind) {
            admission.state = 'quarantined';
            admission.quarantineReason = 'peer-generation-mismatch';
            return { code: 'DEVICE_GENERATION_MISMATCH', message: 'The admitted target terminal was restarted or replaced.' };
        }
        return null;
    }
    failFederatedMessage(message, error) {
        message.state = 'failed';
        message.error = error;
        this.commit();
    }
    async deliverFederatedInbound(admission, message, options = {}) {
        if (message.state !== 'queued')
            return;
        const denied = this.validateFederatedAdmission(admission);
        if (denied) {
            this.failFederatedMessage(message, denied.code === 'DEVICE_GENERATION_MISMATCH' ? 'generation-mismatch' : 'target-closed');
            return;
        }
        const targetInfo = this.deps.getTerminalInfo(admission.to.terminalId);
        if (!targetInfo?.isInteractiveAgent) {
            this.failFederatedMessage(message, 'target-closed');
            return;
        }
        try {
            const readiness = this.deps.prepareTarget
                ? await this.deps.prepareTarget(admission.to.terminalId, targetInfo.promptTarget, 0, options)
                : { ok: true };
            if (!readiness.ok) {
                this.failFederatedMessage(message, readiness.reason === 'exited' ? 'target-closed' : 'delivery-failed');
                return;
            }
        }
        catch {
            this.failFederatedMessage(message, 'delivery-failed');
            return;
        }
        if (this.validateFederatedAdmission(admission)) {
            this.failFederatedMessage(message, 'generation-mismatch');
            return;
        }
        const serializer = this.deps.getSerializer();
        if (!serializer) {
            this.failFederatedMessage(message, 'delivery-failed');
            return;
        }
        const correlationMarker = (0, linkNudge_1.linkMessageCorrelationMarker)(message.messageId);
        let probe;
        let prompt;
        try {
            prompt = (0, linkNudge_1.composeLinkMessagePrompt)({
                fromTitle: message.from.name || admission.originDeviceName,
                fromTerminalId: message.from.terminalId,
                fromAgentKind: message.from.agentType,
                messageId: message.messageId,
                body: message.body,
                ...(this.deps.getShimPath ? { shimPath: this.deps.getShimPath() } : {}),
                canReply: Boolean(this.deps.sendFederatedReply),
                replyToken: message.replyToken,
                toAgentKind: admission.to.effectiveAgentKind,
            });
            probe = await this.deps.createSubmissionProbe(admission.to.terminalId, targetInfo.promptTarget, { allowUnready: false, correlationMarker });
        }
        catch {
            this.failFederatedMessage(message, 'delivery-failed');
            return;
        }
        if (this.validateFederatedAdmission(admission)) {
            probe.dispose();
            this.failFederatedMessage(message, 'generation-mismatch');
            return;
        }
        message.state = 'delivering';
        this.commit();
        let submissionArmed = false;
        try {
            const composerPosition = probe.composerPosition;
            await serializer.submitTeamPrompt({
                terminalId: admission.to.terminalId,
                runId: message.messageId,
                prompt,
                target: targetInfo.promptTarget,
                ...(composerPosition ? { composerPosition } : {}),
                onSubmitEnter: () => {
                    submissionArmed = true;
                    probe.armSubmission();
                },
            });
            const acceptance = await probe.waitForAcceptance();
            if (!acceptance.ok) {
                this.failFederatedMessage(message, 'delivery-unconfirmed');
                return;
            }
            if (this.validateFederatedAdmission(admission)) {
                this.failFederatedMessage(message, 'generation-mismatch');
                return;
            }
            message.state = 'delivered';
            message.deliveredAt = Date.now();
            this.commit();
        }
        catch {
            this.failFederatedMessage(message, submissionArmed ? 'delivery-unconfirmed' : 'delivery-failed');
        }
        finally {
            probe.dispose();
        }
    }
    /**
     * The reply capability for a message, minting one lazily for rows created
     * before tokens existed (the repair/reminder nudges hand out the reply
     * command and must include it). Main-internal — never exposed to the
     * renderer.
     */
    replyTokenFor(messageId) {
        this.load();
        const message = this.messages.find((row) => row.messageId === messageId);
        if (!message)
            return null;
        if (!message.replyToken) {
            message.replyToken = (0, crypto_1.randomBytes)(12).toString('hex');
            this.commit();
        }
        return message.replyToken;
    }
    /**
     * What Mission Control's "Re-start" needs to know about a stuck delegation:
     * whether the peer that received it still holds the conversation it was
     * delivered into, and the original brief for when it does not.
     *
     * The reply-path repair used to assume the answer was still sitting in the
     * peer's context ("send what is already in this conversation"). A peer whose
     * terminal relaunched or whose native session was replaced has NOTHING in
     * context — the corrective notice must re-state the task, or it asks for an
     * answer the peer cannot produce. Body may have been evicted by retention on
     * settled rows; the stored preview is the honest fallback.
     */
    messageRestartContext(messageId) {
        this.load();
        const message = this.messages.find((row) => row.messageId === messageId);
        if (!message)
            return null;
        const current = this.currentEndpoint(message.to.terminalId);
        const peerContextIntact = current !== null && this.endpointMismatch(message.to, current) === null;
        return { peerContextIntact, brief: message.body || this.summaryPreview(message) };
    }
    /**
     * Token-attributed reply for agents PTY ancestry cannot identify.
     *
     * Cline's hub daemon (and any agent whose exec shells parent to launchd,
     * not the terminal PTY) can never pass the bridge's ancestry gate — its
     * finished answers died with "does not own the calling terminal" while the
     * delegating terminal waited forever. Possession of the single-use token
     * that was typed INTO the recipient terminal's envelope is the attribution:
     * only something reading that terminal's context has it. Everything else —
     * sender, recipient, correlation — comes from main's own durable record;
     * the caller's word is never used. Scope on a leak: one reply, to one
     * sender, closing one message.
     */
    async sendReplyByToken(input) {
        this.load();
        const token = input.replyToken?.trim();
        if (!token)
            return { ok: false, error: 'invalid-request', detail: 'unknown reply token' };
        const original = this.messages.find((row) => row.replyToken === token);
        if (!original) {
            if (input.gateDecision) {
                return { ok: false, error: 'hierarchy-violation', detail: 'refused: pipeline — Pipeline gates are local, frozen-seat replies.' };
            }
            const federated = this.federatedMessages.find((row) => row.replyToken === token);
            if (!federated || !this.deps.sendFederatedReply) {
                return { ok: false, error: 'invalid-request', detail: 'unknown reply token' };
            }
            if (federated.state === 'answered' && federated.answeredAt) {
                return { ok: false, error: 'invalid-request', detail: 'message is not awaiting a reply' };
            }
            if (federated.state !== 'delivered') {
                return { ok: false, error: 'invalid-request', detail: 'message is not awaiting a reply' };
            }
            const admission = this.federatedAdmissions.find((row) => row.admissionId === federated.admissionId);
            if (!admission)
                return { ok: false, error: 'no-link', detail: 'federated admission is missing' };
            federated.replyOperationId ??= `federated-reply:${federated.messageId}`;
            federated.replyMessageId ??= `frm-${(0, crypto_1.randomUUID)()}`;
            this.commit();
            const sent = await this.deps.sendFederatedReply({
                admission,
                original: federated,
                body: input.body,
                operationId: federated.replyOperationId,
                messageId: federated.replyMessageId,
                replyToken: (0, crypto_1.randomBytes)(12).toString('hex'),
                ...(input.waitMs !== undefined ? { waitMs: input.waitMs } : {}),
            });
            if (sent.ok && (sent.receipt.state === 'delivered' || sent.receipt.state === 'answered')) {
                federated.state = 'answered';
                federated.answeredAt = sent.receipt.deliveredAt ?? Date.now();
                this.commit();
            }
            return sent;
        }
        const existingReply = this.findLiveReplyFor(original);
        if (existingReply &&
            (existingReply.state === 'queued' || existingReply.state === 'delivering')) {
            return { ok: true, receipt: this.receiptFor(existingReply) };
        }
        // Possession of the token is proof the envelope reached that terminal —
        // it exists nowhere else. See repairUnconfirmedDelivery.
        this.repairUnconfirmedDelivery(original);
        if (original.state !== 'delivered' || original.answeredAt) {
            return { ok: false, error: 'invalid-request', detail: 'message is not awaiting a reply' };
        }
        return this.sendMessage(original.to.terminalId, {
            toTerminalId: original.from.terminalId,
            body: input.body,
            replyToMessageId: original.messageId,
            ...(input.gateDecision ? { gateDecision: input.gateDecision } : {}),
            ...(input.waitMs !== undefined ? { waitMs: input.waitMs } : {}),
        });
    }
    /**
     * Delegation-chain depth (v5 §4). A reply travels back along the chain and
     * keeps its original's depth; an initiation inherits `hopCount + 1` from
     * the newest outstanding message delivered TO the caller — the work that
     * caused this send, correlated the same way sub-agent delegation events
     * are. A send with no outstanding inbound starts a fresh chain at 1.
     */
    inheritedHopCount(callerTerminalId, replyTarget) {
        if (replyTarget)
            return replyTarget.hopCount ?? 1;
        const inbound = [...this.messages].reverse().find((row) => row.to.terminalId === callerTerminalId && (0, terminalLinks_1.isLinkMessageOutstanding)(row));
        return inbound ? (inbound.hopCount ?? 1) + 1 : 1;
    }
    /**
     * The message a reply closes, or null. Requires: the id exists, the caller
     * was its recipient, the reply is addressed to its sender, and it is still
     * open. Anything unproven returns null rather than throwing — a mistyped
     * `--reply-to` should not lose the answer itself.
     */
    resolveAnsweredMessage(callerTerminalId, replyingToTerminalId, replyToMessageId) {
        if (!replyToMessageId)
            return null;
        const original = this.messages.find((row) => row.messageId === replyToMessageId);
        if (!original)
            return null;
        if (original.to.terminalId !== callerTerminalId)
            return null;
        if (original.from.terminalId !== replyingToTerminalId)
            return null;
        // The RECIPIENT quoting the exact message id is the proof-of-receipt an
        // unconfirmed delivery was missing — see repairUnconfirmedDelivery.
        this.repairUnconfirmedDelivery(original);
        if (original.state !== 'delivered')
            return null;
        if (this.findLiveReplyFor(original))
            return null;
        return original;
    }
    /**
     * An unCONFIRMED delivery is not a failed one — the submit Enter may have
     * crossed just before the readiness probe gave up (the opencode TUI in the
     * field: both pipeline handoffs were sitting in its scrollback while their
     * receipts said `failed`/`delivery-unconfirmed`). When the recipient later
     * ANSWERS that exact message — by its single-use token, or by quoting a
     * message id only its injected envelope carried — that answer is positive
     * proof the text landed. Repair the record to `delivered` so the reply (and
     * any pipeline gate riding it) can settle; refusing with "message is not
     * awaiting a reply" deadlocked the whole run: the checker stage could
     * neither accept the input nor `report --complete` without accepting it.
     * Only `delivery-unconfirmed` qualifies — a typed rejection or a cancelled
     * send stays failed, because there the non-delivery is certain.
     */
    repairUnconfirmedDelivery(original) {
        if (original.state !== 'failed' || original.error !== 'delivery-unconfirmed')
            return;
        original.state = 'delivered';
        original.deliveredAt ??= Date.now();
        delete original.error;
        this.cancelRedelivery(original.messageId);
        this.updatePipelineAfterDelivery(original);
        this.commit();
        this.emitMessageState(original);
    }
    /**
     * A reply capability is single-flight. A queued/delivering reply already
     * owns the correlation; a delivered one has consumed it. Failed/cancelled
     * attempts do not consume it.
     */
    findLiveReplyFor(original) {
        return this.messages.find((row) => row.replyToMessageId === original.messageId &&
            row.from.terminalId === original.to.terminalId &&
            row.to.terminalId === original.from.terminalId &&
            (row.state === 'queued' ||
                row.state === 'delivering' ||
                row.state === 'delivered' ||
                row.state === 'answered')) ?? null;
    }
    /**
     * Correlation settles only at the same durable commit as successful reply
     * delivery. Creating, queueing, rejecting, or failing a reply must leave the
     * original outstanding so Mission Control and `link status` tell the truth.
     */
    settleAnsweredMessage(reply) {
        if (!reply.replyToMessageId)
            return null;
        const original = this.messages.find((row) => row.messageId === reply.replyToMessageId);
        if (!original)
            return null;
        if (original.to.terminalId !== reply.from.terminalId)
            return null;
        if (original.from.terminalId !== reply.to.terminalId)
            return null;
        if (original.state !== 'delivered' || original.answeredAt)
            return null;
        original.state = 'answered';
        original.answeredAt = reply.deliveredAt ?? Date.now();
        return original;
    }
    async enqueueDelivery(terminalId, task) {
        const previous = this.deliveryChains.get(terminalId) ?? Promise.resolve();
        const run = previous.catch(() => { }).then(task);
        const tail = run.then(() => { }, () => { });
        this.deliveryChains.set(terminalId, tail);
        try {
            await run;
        }
        finally {
            if (this.deliveryChains.get(terminalId) === tail) {
                this.deliveryChains.delete(terminalId);
            }
        }
    }
    /** Drop any pending readiness retry for this message. */
    cancelRedelivery(messageId) {
        const timer = this.redeliveryTimers.get(messageId);
        if (!timer)
            return;
        clearTimeout(timer);
        this.redeliveryTimers.delete(messageId);
    }
    /**
     * Re-attempt a transient readiness timeout. Nothing about the message is
     * trusted across the wait: the retry re-reads the record, link, and BOTH
     * terminals, then requires fresh positive composer proof. Exhausting either
     * the attempt budget or original wall-clock window fails typed.
     */
    scheduleRedelivery(link, message, attempt) {
        this.cancelRedelivery(message.messageId);
        if (message.state !== 'queued' ||
            message.queuedReason !== 'waiting-for-readiness')
            return;
        const remainingMs = REDELIVERY_WINDOW_MS - (Date.now() - message.createdAt);
        if (attempt + 1 >= REDELIVERY_MAX_ATTEMPTS || remainingMs <= 0) {
            this.failMessage(link, message, 'delivery-failed');
            return;
        }
        const delayMs = Math.min(this.deps.redeliveryIntervalMs ?? REDELIVERY_INTERVAL_MS, remainingMs);
        const timer = setTimeout(() => {
            void this.retryQueuedDelivery(message.messageId, attempt + 1);
        }, delayMs);
        // A pending retry must never be a reason for the process to stay alive.
        timer.unref?.();
        this.redeliveryTimers.set(message.messageId, timer);
    }
    async retryQueuedDelivery(messageId, attempt) {
        this.redeliveryTimers.delete(messageId);
        this.load();
        const message = this.messages.find((row) => row.messageId === messageId);
        // The user may have approved or rejected this exact row while we waited,
        // or it may have been delivered by another path.
        if (!message ||
            message.state !== 'queued' ||
            message.queuedReason !== 'waiting-for-readiness')
            return;
        const link = this.links.find((row) => row.linkId === message.linkId);
        if (!link) {
            message.state = 'failed';
            message.error = 'no-link';
            delete message.queuedReason;
            this.commit();
            this.notify(message.messageId);
            this.emitMessageState(message);
            return;
        }
        const fromInfo = this.deps.getTerminalInfo(link.from.terminalId);
        const toInfo = this.deps.getTerminalInfo(link.to.terminalId);
        if (!fromInfo || !toInfo) {
            this.failMessage(link, message, 'target-closed');
            return;
        }
        await this.enqueueDelivery(link.to.terminalId, async () => {
            await this.deliverQueuedMessage(link, message, fromInfo, toInfo, false, attempt);
        }).catch((error) => {
            if (message.state === 'queued' || message.state === 'delivering') {
                this.failMessage(link, message, 'delivery-failed', error);
            }
        });
    }
    failMessage(link, message, error, logError) {
        this.cancelRedelivery(message.messageId);
        message.state = 'failed';
        message.error = error;
        delete message.queuedReason;
        this.updatePipelineAfterFailure(message);
        this.commit();
        this.notify(message.messageId);
        this.emitMessageState(message);
        this.deps.onDeliveryFailed?.({ link, error });
        if (logError !== undefined) {
            this.deps.log?.(`link delivery failed: ${logError instanceof Error ? logError.message : String(logError)}`);
        }
    }
    /** A transport-complete Enter is never retried. When the ordinary 12 s
     * receipt window expires, retain only the exact native-session/hook adapter
     * and allow that same message id to reconcile later. */
    async reconcileLateExactAcceptance(link, message, probe) {
        try {
            const acceptance = await probe.waitForLateAcceptance?.();
            if (!acceptance?.ok)
                return;
            if (message.state !== 'failed' || message.error !== 'delivery-unconfirmed')
                return;
            const validation = this.validateLiveLink(link);
            if (!validation.ok) {
                this.commit(true);
                return;
            }
            if (validation.changed)
                this.commit(true);
            message.state = 'delivered';
            message.deliveredAt = Date.now();
            delete message.error;
            const answered = this.settleAnsweredMessage(message);
            this.updatePipelineAfterDelivery(message);
            this.commit();
            this.notify(message.messageId);
            if (answered) {
                this.notify(answered.messageId);
                this.emitMessageState(answered);
            }
            this.emitMessageState(message);
            this.deps.log?.(`link delivery reconciled by late exact ${acceptance.evidence} receipt: ${message.messageId}`);
            if (!this.deliveredProjects.has(link.projectId)) {
                this.deliveredProjects.add(link.projectId);
                this.deps.onLinkActivity?.({
                    projectId: link.projectId,
                    hostTerminalId: link.from.terminalId,
                    peerTerminalIds: [link.to.terminalId],
                });
            }
        }
        finally {
            probe.dispose();
        }
    }
    async deliverQueuedMessage(link, message, fromInfo, toInfo, userApproved = false, attempt = 0) {
        // Whatever happens below supersedes any timer that queued this attempt.
        this.cancelRedelivery(message.messageId);
        if (message.state !== 'queued')
            return;
        // A message may have waited behind another delivery. Revalidate at the
        // actual PTY boundary, not only when the caller first queued it.
        const beforeReady = this.validateLiveLink(link);
        if (!beforeReady.ok) {
            this.commit(true);
            this.failMessage(link, message, beforeReady.error);
            return;
        }
        if (beforeReady.changed)
            this.commit(true);
        try {
            const readiness = userApproved || !this.deps.prepareTarget
                ? { ok: true }
                : await this.deps.prepareTarget(link.to.terminalId, toInfo.promptTarget, attempt);
            if (!readiness.ok) {
                if (readiness.reason === 'timeout') {
                    // The route is authorized and the readiness contract is supported,
                    // but the live empty composer did not appear in this observation
                    // window. Keep working automatically; every retry repeats the full
                    // positive proof and link-generation validation.
                    const changed = message.queuedReason !== 'waiting-for-readiness';
                    message.queuedReason = 'waiting-for-readiness';
                    if (changed) {
                        this.commit();
                        this.notify(message.messageId);
                        this.emitMessageState(message);
                    }
                    this.scheduleRedelivery(link, message, attempt);
                    return;
                }
                if (readiness.reason === 'unsupported') {
                    // There is no safe automatic proof for this target. Preserve the
                    // exact row for an explicit Submit/Cancel decision; never turn
                    // unsupported readiness into a timer-based blind write.
                    if (message.queuedReason !== 'target-not-ready') {
                        message.queuedReason = 'target-not-ready';
                        this.commit();
                        this.notify(message.messageId);
                        this.emitMessageState(message);
                    }
                    return;
                }
                this.failMessage(link, message, readiness.reason === 'exited' ? 'target-closed' : 'delivery-failed', readiness.error);
                return;
            }
        }
        catch (error) {
            this.failMessage(link, message, 'delivery-failed', error);
            return;
        }
        const afterReady = this.validateLiveLink(link);
        if (!afterReady.ok) {
            this.commit(true);
            this.failMessage(link, message, afterReady.error);
            return;
        }
        if (afterReady.changed)
            this.commit(true);
        const serializer = this.deps.getSerializer();
        if (!serializer) {
            this.failMessage(link, message, 'delivery-failed');
            return;
        }
        const correlationMarker = (0, linkNudge_1.linkMessageCorrelationMarker)(message.messageId);
        let prompt;
        let probe;
        try {
            // Provenance AND return path. A name-only prefix left the peer with no
            // way to answer: it would finish the work, print the result in its own
            // terminal, and the sender would wait forever (see linkNudge.ts).
            prompt = (0, linkNudge_1.composeLinkMessagePrompt)({
                fromTitle: fromInfo.name,
                fromTerminalId: link.from.terminalId,
                fromAgentKind: link.from.effectiveAgentKind,
                messageId: message.messageId,
                body: message.body,
                ...(this.deps.getShimPath ? { shimPath: this.deps.getShimPath() } : {}),
                canReply: this.hasReplyPath(link.to.terminalId, link.from.terminalId),
                ...(message.replyToken ? { replyToken: message.replyToken } : {}),
                toAgentKind: link.to.effectiveAgentKind,
                ...(message.pipeline ? { pipeline: message.pipeline } : {}),
                ...(message.expectsReply === false ? { expectsReply: false } : {}),
            });
            probe = await this.deps.createSubmissionProbe(link.to.terminalId, toInfo.promptTarget, { allowUnready: userApproved, correlationMarker });
        }
        catch (error) {
            this.failMessage(link, message, 'delivery-failed', error);
            return;
        }
        // Snapshotting the retained observer is asynchronous. Pin the link once
        // more before the first prompt byte, then keep the observer across Enter.
        const beforeWrite = this.validateLiveLink(link);
        if (!beforeWrite.ok) {
            probe.dispose();
            this.commit(true);
            this.failMessage(link, message, beforeWrite.error);
            return;
        }
        if (beforeWrite.changed)
            this.commit(true);
        message.state = 'delivering';
        delete message.queuedReason;
        this.commit();
        this.emitMessageState(message);
        let submissionArmed = false;
        let probeRetainedForLateReceipt = false;
        try {
            const composerPosition = probe.composerPosition;
            await serializer.submitTeamPrompt({
                terminalId: link.to.terminalId,
                runId: message.messageId,
                prompt,
                target: toInfo.promptTarget,
                ...(composerPosition ? { composerPosition } : {}),
                onSubmitEnter: () => {
                    submissionArmed = true;
                    probe.armSubmission();
                },
            });
            const acceptance = await probe.waitForAcceptance();
            if (!acceptance.ok) {
                this.failMessage(link, message, 'delivery-unconfirmed', acceptance.error);
                if (acceptance.reason === 'timeout' && probe.waitForLateAcceptance) {
                    probeRetainedForLateReceipt = true;
                    void this.reconcileLateExactAcceptance(link, message, probe);
                }
                return;
            }
            // An acknowledgement from a replacement terminal/session must never
            // settle the old generation-bound row.
            const afterAcceptance = this.validateLiveLink(link);
            if (!afterAcceptance.ok) {
                this.commit(true);
                this.failMessage(link, message, afterAcceptance.error);
                return;
            }
            if (afterAcceptance.changed)
                this.commit(true);
            message.state = 'delivered';
            message.deliveredAt = Date.now();
            const answered = this.settleAnsweredMessage(message);
            this.updatePipelineAfterDelivery(message);
            this.commit();
            this.notify(message.messageId);
            if (answered) {
                this.notify(answered.messageId);
                this.emitMessageState(answered);
            }
            this.emitMessageState(message);
            if (!this.deliveredProjects.has(link.projectId)) {
                this.deliveredProjects.add(link.projectId);
                this.deps.onLinkActivity?.({
                    projectId: link.projectId,
                    hostTerminalId: link.from.terminalId,
                    peerTerminalIds: [
                        ...new Set(this.links
                            .filter((row) => row.state === 'active' &&
                            row.projectId === link.projectId &&
                            row.from.terminalId === link.from.terminalId)
                            .map((row) => row.to.terminalId)),
                    ],
                });
            }
        }
        catch (error) {
            this.failMessage(link, message, submissionArmed ? 'delivery-unconfirmed' : 'delivery-failed', error);
        }
        finally {
            if (!probeRetainedForLateReceipt)
                probe.dispose();
        }
    }
    async approveQueuedMessage(messageId) {
        this.load();
        const message = this.messages.find((row) => row.messageId === messageId);
        if (!message || message.state !== 'queued' || !message.queuedReason) {
            return { ok: false, error: 'invalid-request', detail: 'message is not awaiting approval' };
        }
        const link = this.links.find((row) => row.linkId === message.linkId);
        if (!link)
            return { ok: false, error: 'no-link' };
        const fromInfo = this.deps.getTerminalInfo(link.from.terminalId);
        const toInfo = this.deps.getTerminalInfo(link.to.terminalId);
        if (!fromInfo || !toInfo) {
            this.failMessage(link, message, 'target-closed');
            return { ok: false, error: 'target-closed' };
        }
        await this.enqueueDelivery(link.to.terminalId, async () => {
            await this.deliverQueuedMessage(link, message, fromInfo, toInfo, true);
        });
        return { ok: true, receipt: this.receiptFor(message) };
    }
    rejectQueuedMessage(messageId) {
        this.load();
        const message = this.messages.find((row) => row.messageId === messageId);
        if (!message || message.state !== 'queued' || !message.queuedReason) {
            return { ok: false, error: 'invalid-request', detail: 'message is not awaiting approval' };
        }
        // An explicit Reject outranks any retry still pending for this row.
        this.cancelRedelivery(message.messageId);
        message.state = 'cancelled';
        delete message.queuedReason;
        this.updatePipelineAfterFailure(message);
        this.commit();
        this.notify(message.messageId);
        this.emitMessageState(message);
        return { ok: true, receipt: this.receiptFor(message) };
    }
    /**
     * Best-effort app-authored link notice. It shares the same per-target
     * serialization and positive readiness gate as real link messages, but has
     * no receipt because failure does not revoke the already-created edge.
     */
    async deliverNotice(link, runId, prompt) {
        this.load();
        let delivered = false;
        await this.enqueueDelivery(link.to.terminalId, async () => {
            const validation = this.validateLiveLink(link);
            if (!validation.ok) {
                this.commit(true);
                return;
            }
            if (validation.changed)
                this.commit(true);
            const toInfo = this.deps.getTerminalInfo(link.to.terminalId);
            const serializer = this.deps.getSerializer();
            if (!toInfo || !serializer)
                return;
            const readiness = this.deps.prepareTarget
                ? await this.deps.prepareTarget(link.to.terminalId, toInfo.promptTarget)
                : { ok: true };
            if (!readiness.ok)
                return;
            const finalValidation = this.validateLiveLink(link);
            if (!finalValidation.ok) {
                this.commit(true);
                return;
            }
            if (finalValidation.changed)
                this.commit(true);
            const probe = await this.deps.createSubmissionProbe(link.to.terminalId, toInfo.promptTarget, { allowUnready: false });
            try {
                const composerPosition = probe.composerPosition;
                await serializer.submitTeamPrompt({
                    terminalId: link.to.terminalId,
                    runId,
                    prompt,
                    target: toInfo.promptTarget,
                    ...(composerPosition ? { composerPosition } : {}),
                    onSubmitEnter: () => probe.armSubmission(),
                });
                delivered = true;
            }
            finally {
                probe.dispose();
            }
        }).catch((error) => {
            this.deps.log?.(`link notice delivery failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        return delivered;
    }
    /**
     * Resolve when the message leaves the automatic-delivery path, or when the
     * timeout fires. Human-mediated parked states settle immediately so --wait
     * does not spin on a user decision; `waiting-for-readiness` does NOT — that
     * reason is main-owned redelivery work and --wait must keep watching until
     * delivered/failed or the caller's bound expires.
     */
    isWaitSettled(message) {
        if (!message)
            return true;
        if (message.state === 'delivering')
            return false;
        if (message.state !== 'queued')
            return true;
        // Auto-retry path — still in flight for wait purposes.
        if (message.queuedReason === 'waiting-for-readiness')
            return false;
        // confirmation-required / target-not-ready: human must act.
        return message.queuedReason !== undefined;
    }
    waitForSettled(messageId, timeoutMs) {
        const message = this.messages.find((row) => row.messageId === messageId);
        if (this.isWaitSettled(message)) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            let settled = false;
            const removeWake = (wake) => {
                const current = this.waiters.get(messageId);
                if (!current)
                    return;
                const next = current.filter((candidate) => candidate !== wake);
                if (next.length > 0)
                    this.waiters.set(messageId, next);
                else
                    this.waiters.delete(messageId);
            };
            const finish = (wake) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                removeWake(wake);
                resolve();
            };
            let timer;
            const wake = () => {
                // notify() removes every waiter before calling it. A readiness-timeout
                // park is NOT a settlement for --wait (redelivery is still live), so
                // re-arm until delivered/failed/cancelled or the outer bound fires.
                const current = this.messages.find((row) => row.messageId === messageId);
                if (!this.isWaitSettled(current)) {
                    if (settled)
                        return;
                    const existing = this.waiters.get(messageId) ?? [];
                    if (!existing.includes(wake)) {
                        existing.push(wake);
                        this.waiters.set(messageId, existing);
                    }
                    return;
                }
                finish(wake);
            };
            timer = setTimeout(() => finish(wake), timeoutMs);
            // A pending wait must never be a reason for the process to stay alive
            // (same invariant as the redelivery timer).
            timer.unref?.();
            const existing = this.waiters.get(messageId) ?? [];
            existing.push(wake);
            this.waiters.set(messageId, existing);
        });
    }
    /** Receipt lookup, owner-checked against the durable `from` endpoint. */
    messageStatus(callerTerminalId, messageId) {
        this.load();
        const message = this.messages.find((row) => row.messageId === messageId);
        const caller = this.currentEndpoint(callerTerminalId);
        if (!message ||
            !caller ||
            message.from.terminalId !== callerTerminalId ||
            this.endpointMismatch(message.from, caller) !== null) {
            return { ok: false, error: 'invalid-request', detail: 'unknown message for this terminal' };
        }
        return { ok: true, receipt: this.receiptFor(message) };
    }
    /**
     * Workspace collect (workspace_control D7): the answer correlated to ONE
     * message this caller sent — the reply record whose `replyToMessageId`
     * names it. Sender-scoped exactly like messageStatus. Never returns "any
     * outstanding reply", and a settled record whose body was dropped reports
     * answered without text rather than inventing one.
     */
    collectAnswer(callerTerminalId, messageId) {
        this.load();
        const message = this.messages.find((row) => row.messageId === messageId);
        const caller = this.currentEndpoint(callerTerminalId);
        if (!message ||
            !caller ||
            message.from.terminalId !== callerTerminalId ||
            this.endpointMismatch(message.from, caller) !== null) {
            return { status: 'unavailable' };
        }
        const reply = this.messages.find((row) => row.replyToMessageId === messageId && row.to.terminalId === callerTerminalId);
        if (reply) {
            return { status: 'answered', ...(reply.body || reply.preview ? { text: reply.body || reply.preview } : {}) };
        }
        if (message.state === 'answered')
            return { status: 'answered' };
        if (message.state === 'failed' || message.state === 'cancelled')
            return { status: 'unavailable' };
        return { status: 'pending' };
    }
}
exports.LinkRegistry = LinkRegistry;
