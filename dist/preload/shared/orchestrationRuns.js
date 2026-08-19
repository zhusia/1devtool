"use strict";
/**
 * Orchestration run records — shared between the standalone `1devtool-agent`
 * CLI (the writer) and the Electron main process (the reader/index owner).
 *
 * Pure Node (fs/os/path only) — the CLI bundles this file, so it must never
 * import Electron.
 *
 * Layout (see docs/features/orchestration/dashboard.md §4.2):
 *
 *   ~/.1devtool/orchestration/            dir mode 0700
 *     config.json                         app-written CLI config (atomic tmp+rename)
 *     runs/<callId>/                      one dir per run; callId = UUID minted by the CLI
 *       meta.json                         atomic tmp+rename WITHIN this dir; authoritative
 *       prompt.txt                        only when captureContent; capped 64 KB; mode 0600
 *       output.txt                        only when captureContent; capped 100k chars
 *       stderr.txt                        only when captureContent; capped 16 KB
 *
 * Each run touches only its own directory → zero cross-run write contention,
 * no locks, no shared append file. The app owns pruning; the CLI never prunes.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RUN_INTERRUPTED_GRACE_MS = exports.DEFAULT_ORCHESTRATION_CONFIG = exports.STORED_RUN_STATUSES = exports.CLI_WRITABLE_RUN_STATUSES = exports.RUN_CATEGORY_RE = exports.RUN_CALL_ID_RE = exports.RUN_STDERR_CAP_BYTES = exports.RUN_OUTPUT_CAP_CHARS = exports.RUN_PROMPT_CAP_BYTES = exports.RUN_CONTENT_FILES = exports.RUN_META_FILE = void 0;
exports.getOrchestrationRootDir = getOrchestrationRootDir;
exports.getOrchestrationRunsDir = getOrchestrationRunsDir;
exports.getOrchestrationConfigPath = getOrchestrationConfigPath;
exports.getRunDir = getRunDir;
exports.getRunContentFileName = getRunContentFileName;
exports.isValidRunCallId = isValidRunCallId;
exports.isValidRunCategory = isValidRunCategory;
exports.normalizeOrchestrationConfig = normalizeOrchestrationConfig;
exports.readOrchestrationConfig = readOrchestrationConfig;
exports.writeOrchestrationConfig = writeOrchestrationConfig;
exports.ensureDir = ensureDir;
exports.writeRunMeta = writeRunMeta;
exports.readRunMeta = readRunMeta;
exports.truncateUtf8Bytes = truncateUtf8Bytes;
exports.truncateChars = truncateChars;
exports.deriveServedStatus = deriveServedStatus;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const orchestrationCategory_1 = require("./orchestrationCategory");
// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
function getOrchestrationRootDir(homeDir = node_os_1.default.homedir()) {
    return node_path_1.default.join(homeDir, '.1devtool', 'orchestration');
}
function getOrchestrationRunsDir(homeDir = node_os_1.default.homedir()) {
    return node_path_1.default.join(getOrchestrationRootDir(homeDir), 'runs');
}
function getOrchestrationConfigPath(homeDir = node_os_1.default.homedir()) {
    return node_path_1.default.join(getOrchestrationRootDir(homeDir), 'config.json');
}
function getRunDir(callId, homeDir = node_os_1.default.homedir()) {
    return node_path_1.default.join(getOrchestrationRunsDir(homeDir), callId);
}
exports.RUN_META_FILE = 'meta.json';
exports.RUN_CONTENT_FILES = ['prompt', 'output', 'stderr'];
function getRunContentFileName(file) {
    return `${file}.txt`;
}
// ---------------------------------------------------------------------------
// Caps + validation
// ---------------------------------------------------------------------------
/** Prompt content file cap, measured in UTF-8 bytes. */
exports.RUN_PROMPT_CAP_BYTES = 64 * 1024;
/** Output content file cap, in chars (mirrors HEADLESS_MAX_OUTPUT_CHARS). */
exports.RUN_OUTPUT_CAP_CHARS = 100_000;
/** Stderr content file / rawStderr cap, measured in UTF-8 bytes. */
exports.RUN_STDERR_CAP_BYTES = 16 * 1024;
/** callId must be a UUID (the CLI mints it with crypto.randomUUID). */
exports.RUN_CALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `--category` slug shape — also enforced for custom category ids (§4.1). */
exports.RUN_CATEGORY_RE = orchestrationCategory_1.ORCHESTRATION_CATEGORY_RE;
function isValidRunCallId(callId) {
    return exports.RUN_CALL_ID_RE.test(callId);
}
function isValidRunCategory(category) {
    return exports.RUN_CATEGORY_RE.test(category);
}
/** Statuses the CLI is allowed to write into meta.json.
 *
 *  `interrupted` is NOT CLI-writable. Two producers may still surface it:
 *   1. **Derived at serve time** (§4.3): a still-`running` meta past
 *      deadline+grace is presented as `interrupted` without rewriting disk.
 *   2. **Controller-owned intentional interrupts**: AgentTeamController's
 *      writeRunRecord persists `interrupted` for uncertain / submission-
 *      interrupted / user-interrupted terminal runs so Run & Logs keeps the
 *      durable record (read via STORED_RUN_STATUSES). */
exports.CLI_WRITABLE_RUN_STATUSES = [
    'running', 'done', 'error', 'timeout', 'not-installed',
];
/** Statuses that may appear in on-disk meta.json. Superset of CLI_WRITABLE —
 *  adds intentional `interrupted` written by the Team/Swarm controller. */
exports.STORED_RUN_STATUSES = [
    ...exports.CLI_WRITABLE_RUN_STATUSES,
    'interrupted',
];
exports.DEFAULT_ORCHESTRATION_CONFIG = {
    captureContent: false,
    retention: { maxRuns: 500, maxAgeDays: 30 },
    scheduling: { maxConcurrentAgents: 8 },
};
// ---------------------------------------------------------------------------
// Config read/write
// ---------------------------------------------------------------------------
function normalizeOrchestrationConfig(raw) {
    const cfg = (raw && typeof raw === 'object' ? raw : {});
    const retention = (cfg.retention && typeof cfg.retention === 'object' ? cfg.retention : {});
    const scheduling = (cfg.scheduling && typeof cfg.scheduling === 'object' ? cfg.scheduling : {});
    const maxRuns = typeof retention.maxRuns === 'number' && Number.isFinite(retention.maxRuns)
        ? Math.min(Math.max(Math.floor(retention.maxRuns), 10), 5000)
        : exports.DEFAULT_ORCHESTRATION_CONFIG.retention.maxRuns;
    const maxAgeDays = typeof retention.maxAgeDays === 'number' && Number.isFinite(retention.maxAgeDays)
        ? Math.min(Math.max(Math.floor(retention.maxAgeDays), 1), 365)
        : exports.DEFAULT_ORCHESTRATION_CONFIG.retention.maxAgeDays;
    const maxConcurrentAgents = typeof scheduling.maxConcurrentAgents === 'number' && Number.isFinite(scheduling.maxConcurrentAgents)
        ? Math.min(Math.max(Math.floor(scheduling.maxConcurrentAgents), 1), 8)
        : exports.DEFAULT_ORCHESTRATION_CONFIG.scheduling.maxConcurrentAgents;
    return {
        captureContent: cfg.captureContent === true,
        retention: { maxRuns, maxAgeDays },
        scheduling: { maxConcurrentAgents },
    };
}
/** Tolerant read — a missing/corrupt config yields the defaults. Used by the
 *  standalone CLI (no IPC) and by main. */
function readOrchestrationConfig(homeDir = node_os_1.default.homedir()) {
    try {
        const raw = node_fs_1.default.readFileSync(getOrchestrationConfigPath(homeDir), 'utf-8');
        return normalizeOrchestrationConfig(JSON.parse(raw));
    }
    catch {
        return {
            ...exports.DEFAULT_ORCHESTRATION_CONFIG,
            retention: { ...exports.DEFAULT_ORCHESTRATION_CONFIG.retention },
            scheduling: { ...exports.DEFAULT_ORCHESTRATION_CONFIG.scheduling },
        };
    }
}
/** Atomic tmp+rename write, main-process owned (§4.2). Creates the 0700 root
 *  dir when missing. Throws on failure — the IPC caller surfaces the error. */
function writeOrchestrationConfig(config, homeDir = node_os_1.default.homedir()) {
    const normalized = normalizeOrchestrationConfig(config);
    const configPath = getOrchestrationConfigPath(homeDir);
    ensureDir(node_path_1.default.dirname(configPath), 0o700);
    const tmpPath = `${configPath}.${process.pid}.tmp`;
    node_fs_1.default.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2), { encoding: 'utf-8', mode: 0o600 });
    node_fs_1.default.renameSync(tmpPath, configPath);
}
// ---------------------------------------------------------------------------
// meta.json read/write
// ---------------------------------------------------------------------------
/** mkdir -p with a best-effort POSIX mode (Windows ignores modes). */
function ensureDir(dir, mode) {
    node_fs_1.default.mkdirSync(dir, { recursive: true, mode });
}
/** Write meta.json via tmp+rename WITHIN the run dir. Throws on failure —
 *  callers (runLog) wrap in best-effort try/catch. */
function writeRunMeta(runDir, record) {
    const metaPath = node_path_1.default.join(runDir, exports.RUN_META_FILE);
    const tmpPath = `${metaPath}.${process.pid}.tmp`;
    node_fs_1.default.writeFileSync(tmpPath, JSON.stringify(record, null, 2), { encoding: 'utf-8', mode: 0o600 });
    node_fs_1.default.renameSync(tmpPath, metaPath);
}
/** Tolerant meta.json read: null on missing/corrupt/shape-invalid records so
 *  a half-written or foreign file can never break the index scan. Accepts
 *  STORED_RUN_STATUSES (CLI-writable + controller-persisted `interrupted`). */
function readRunMeta(runDir) {
    try {
        const raw = node_fs_1.default.readFileSync(node_path_1.default.join(runDir, exports.RUN_META_FILE), 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object')
            return null;
        if (typeof parsed.callId !== 'string' || !isValidRunCallId(parsed.callId))
            return null;
        if (typeof parsed.target !== 'string' || !parsed.target)
            return null;
        if (typeof parsed.startedAt !== 'number' || !Number.isFinite(parsed.startedAt))
            return null;
        if (typeof parsed.status !== 'string')
            return null;
        if (!exports.STORED_RUN_STATUSES.includes(parsed.status))
            return null;
        if (typeof parsed.timeoutSeconds !== 'number' || !Number.isFinite(parsed.timeoutSeconds))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// Truncation helpers
// ---------------------------------------------------------------------------
/** Truncate to a UTF-8 byte budget without splitting a multi-byte char. */
function truncateUtf8Bytes(text, maxBytes) {
    if (Buffer.byteLength(text, 'utf-8') <= maxBytes)
        return { text, truncated: false };
    const sliced = Buffer.from(text, 'utf-8').subarray(0, maxBytes).toString('utf-8');
    // A byte cut inside a multi-byte sequence decodes to U+FFFD — drop it.
    return { text: sliced.replace(/�+$/, ''), truncated: true };
}
function truncateChars(text, maxChars) {
    if (text.length <= maxChars)
        return { text, truncated: false };
    return { text: text.slice(0, maxChars), truncated: true };
}
/** Derived status served by main: a still-`running` record past its deadline
 *  is presented as `interrupted` WITHOUT rewriting meta.json (§4.3). */
exports.RUN_INTERRUPTED_GRACE_MS = 60_000;
function deriveServedStatus(record, nowMs) {
    if (record.status !== 'running')
        return record.status;
    const anchor = Math.max(record.startedAt, record.heartbeatAt ?? 0);
    const deadline = anchor + record.timeoutSeconds * 1000 + exports.RUN_INTERRUPTED_GRACE_MS;
    return nowMs > deadline ? 'interrupted' : 'running';
}
