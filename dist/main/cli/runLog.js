"use strict";
/**
 * Best-effort run-record writer for the standalone `1devtool-agent` CLI.
 *
 * The CLI owns the write so runs are captured even when 1DevTool is closed
 * (docs/features/orchestration/dashboard.md §4.2). Every write is wrapped: a record
 * failure must never fail the delegation — same philosophy as bridgeNotify.
 *
 * meta.json is written twice: once at run start (`status: 'running'`, before
 * binary resolution so `not-installed` is capturable) and once at the end via
 * `finalize` — both atomic tmp+rename inside the run dir. Content files
 * (prompt/output/stderr) land only when config.json opts into captureContent.
 * The CLI never prunes — pruning is main-owned; past 2× the retention cap it
 * only logs a one-line stderr warning.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startRunLog = startRunLog;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const orchestrationRuns_1 = require("../shared/orchestrationRuns");
const NOOP_RUN_LOG_BASE = { captureContent: false, finalize: () => { } };
/**
 * Start a run record: create the run dir, write the initial `running`
 * meta.json, and (when capturing) persist the capped prompt. Never throws —
 * on any failure it degrades to a no-op log so the delegation proceeds.
 */
function startRunLog(args) {
    let config;
    try {
        config = (0, orchestrationRuns_1.readOrchestrationConfig)();
    }
    catch {
        config = {
            ...orchestrationRuns_1.DEFAULT_ORCHESTRATION_CONFIG,
            retention: { ...orchestrationRuns_1.DEFAULT_ORCHESTRATION_CONFIG.retention },
            scheduling: { ...orchestrationRuns_1.DEFAULT_ORCHESTRATION_CONFIG.scheduling },
        };
    }
    let runDir;
    const truncation = {};
    let record;
    try {
        const runsDir = (0, orchestrationRuns_1.getOrchestrationRunsDir)();
        runDir = (0, orchestrationRuns_1.getRunDir)(args.callId);
        (0, orchestrationRuns_1.ensureDir)(runsDir, 0o700);
        (0, orchestrationRuns_1.ensureDir)(runDir, 0o700);
        record = {
            callId: args.callId,
            target: args.target,
            ...(args.category ? { category: args.category } : {}),
            ...(args.model ? { model: args.model } : {}),
            command: args.command,
            cwd: args.cwd,
            ...(args.hostTerminalId ? { hostTerminalId: args.hostTerminalId } : {}),
            startedAt: args.startedAt,
            timeoutSeconds: args.timeoutSeconds,
            status: 'running',
            promptChars: args.prompt.length,
            contentCaptured: config.captureContent,
        };
        if (config.captureContent) {
            const capped = (0, orchestrationRuns_1.truncateUtf8Bytes)(args.prompt, orchestrationRuns_1.RUN_PROMPT_CAP_BYTES);
            if (capped.truncated)
                truncation.prompt = true;
            writeContentFile(runDir, 'prompt', capped.text);
        }
        if (truncation.prompt)
            record.truncated = { ...truncation };
        (0, orchestrationRuns_1.writeRunMeta)(runDir, record);
        warnPastRetention(runsDir, config);
    }
    catch {
        return { callId: args.callId, ...NOOP_RUN_LOG_BASE };
    }
    let finalized = false;
    return {
        callId: args.callId,
        captureContent: config.captureContent,
        finalize: (final) => {
            if (finalized)
                return;
            finalized = true;
            try {
                const merged = { ...truncation, ...(final.truncated ?? {}) };
                if (config.captureContent) {
                    if (typeof final.output === 'string' && final.output.length > 0) {
                        const capped = (0, orchestrationRuns_1.truncateChars)(final.output, orchestrationRuns_1.RUN_OUTPUT_CAP_CHARS);
                        if (capped.truncated)
                            merged.output = true;
                        writeContentFile(runDir, 'output', capped.text);
                    }
                    if (typeof final.stderr === 'string' && final.stderr.length > 0) {
                        const capped = (0, orchestrationRuns_1.truncateUtf8Bytes)(final.stderr, orchestrationRuns_1.RUN_STDERR_CAP_BYTES);
                        if (capped.truncated)
                            merged.stderr = true;
                        writeContentFile(runDir, 'stderr', capped.text);
                    }
                }
                const finalRecord = {
                    ...record,
                    status: final.status,
                    endedAt: final.endedAt,
                    durationSeconds: Math.max(0, Math.round((final.endedAt - record.startedAt) / 1000)),
                    ...(typeof final.exitCode === 'number' ? { exitCode: final.exitCode } : {}),
                    ...(typeof final.output === 'string' ? { outputChars: final.output.length } : {}),
                    ...(Object.keys(merged).length > 0 ? { truncated: merged } : {}),
                };
                (0, orchestrationRuns_1.writeRunMeta)(runDir, finalRecord);
            }
            catch { /* best-effort — never fail the delegation */ }
        },
    };
}
function writeContentFile(runDir, file, text) {
    try {
        node_fs_1.default.writeFileSync(node_path_1.default.join(runDir, (0, orchestrationRuns_1.getRunContentFileName)(file)), text, { encoding: 'utf-8', mode: 0o600 });
    }
    catch { /* best-effort */ }
}
/** The CLI never prunes (no rewrite races by construction) — past 2× the run
 *  cap it emits a single stderr line so an app-less machine isn't silent. */
function warnPastRetention(runsDir, config) {
    try {
        const count = node_fs_1.default.readdirSync(runsDir).length;
        if (count > config.retention.maxRuns * 2) {
            process.stderr.write(`1devtool-agent: ${count} orchestration run records under ${runsDir} ` +
                '(open 1DevTool to prune, or delete the directory)\n');
        }
    }
    catch { /* best-effort */ }
}
