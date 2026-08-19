"use strict";
/**
 * Per-terminal context-window meter (orchestration v4 — L7).
 *
 * "Current context tokens" = the prompt side of the agent's LAST turn:
 * - Claude: the last assistant line's `message.usage` in the bound session
 *   JSONL — input + cache_read + cache_creation (what was sent).
 * - Codex: the last `token_count` event's `last_token_usage` (falling back
 *   to `total_token_usage`) — input + cached of the latest request.
 * Other agents return null (honest `unknown`) until their format is verified.
 *
 * The `window` field is only emitted while the table entry survives contact
 * with the measurement — a prompt larger than the assumed window disproves it
 * for the session and the snapshot then carries tokens alone (see
 * `shared/agentContextWindows.ts`).
 *
 * Cost discipline (`feedback_terminal_hot_path_perf`): resolution caches the
 * transcript path per session, reads are TAIL reads (last 64 KB, never a
 * whole-file parse), and results are served from an mtime + 60s-TTL cache
 * modeled on aiAccounts/status.ts. Never called per keystroke — only from a
 * focused-terminal poll.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextMeterService = void 0;
exports.extractClaudeContextTokens = extractClaudeContextTokens;
exports.extractCodexContextTokens = extractCodexContextTokens;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const agentContextWindows_1 = require("../../shared/agentContextWindows");
const TAIL_BYTES = 64 * 1024;
const TTL_MS = 60_000;
const CODEX_SCAN_DAY_DIRS = 14;
/**
 * Last assistant usage from a Claude session JSONL tail, plus `maxTokens` — the
 * high-water prompt still visible in that tail. Pure — tested.
 *
 * `tokens` is current occupancy and drives the chip; `maxTokens` exists only to
 * re-derive a disproven window from the file itself, so the verdict survives an
 * app restart without persisting anything. Every prompt-side sum here is a
 * single request's total, never a running total — that is what makes a max
 * across lines meaningful (contrast Codex's cumulative `total_token_usage`).
 */
function extractClaudeContextTokens(tail) {
    const lines = tail.split('\n');
    let latest = null;
    let maxTokens = 0;
    // Compaction writes a `type:"user"` line with `isCompactSummary:true`; when
    // that boundary sits closer to EOF than the latest usage line, the usage
    // still describes the PRE-compact context — the real occupancy has dropped
    // and won't be observable until the next assistant turn. Consumers must
    // treat the percent as unusable while stale (no-ratio → no action).
    let staleAfterCompact = false;
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!latest && line.includes('"isCompactSummary":true')) {
            // Cheap gate first; confirm it's the real JSON key, not transcript
            // prose (escaped content renders as \"isCompactSummary\" and never
            // matches the gate, so a parse failure here means a torn line).
            try {
                const parsed = JSON.parse(line);
                if (parsed.type === 'user' && parsed.isCompactSummary === true)
                    staleAfterCompact = true;
            }
            catch {
                // torn line — ignore
            }
            continue;
        }
        if (!line.includes('"usage"') || !line.includes('"assistant"'))
            continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed.type !== 'assistant')
                continue;
            const usage = parsed.message?.usage;
            if (!usage || typeof usage.input_tokens !== 'number')
                continue;
            const tokens = usage.input_tokens +
                (usage.cache_read_input_tokens ?? 0) +
                (usage.cache_creation_input_tokens ?? 0);
            if (tokens > maxTokens)
                maxTokens = tokens;
            // First match walking backward is the latest turn; keep scanning for the peak.
            if (!latest)
                latest = { tokens, ...(parsed.message?.model ? { model: parsed.message.model } : {}) };
        }
        catch {
            // torn first line of the tail window — keep walking backward
        }
    }
    return latest ? { ...latest, maxTokens, staleAfterCompact } : null;
}
/**
 * Last token_count usage from a Codex rollout JSONL tail. Pure — tested.
 *
 * `maxTokens` is intentionally never set: the fallback `total_token_usage` is
 * CUMULATIVE, so a peak across tail lines would manufacture a disproof out of a
 * running total. Declared optional only to keep the extractor union uniform.
 *
 * `contextWindow` is the transcript's own `info.model_context_window`
 * (observed on codex-cli 0.145.0 token_count events, e.g. 258400) — a
 * VERIFIED per-session window from the same line as the usage, not a table
 * guess. Absent on older codex versions, in which case the snapshot stays
 * tokens-only exactly as before.
 */
function extractCodexContextTokens(tail) {
    const lines = tail.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.includes('token_count'))
            continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed.payload?.type !== 'token_count')
                continue;
            const usage = parsed.payload.info?.last_token_usage ?? parsed.payload.info?.total_token_usage;
            if (!usage || typeof usage.input_tokens !== 'number')
                continue;
            const window = parsed.payload.info?.model_context_window;
            return {
                tokens: usage.input_tokens + (usage.cached_input_tokens ?? 0),
                ...(typeof window === 'number' && Number.isFinite(window) && window > 0
                    ? { contextWindow: window }
                    : {}),
            };
        }
        catch {
            // torn line — keep walking
        }
    }
    return null;
}
class ContextMeterService {
    deps;
    pathCache = new Map();
    missingPathUntil = new Map();
    cache = new Map();
    /**
     * Session keys whose table window was disproven by observation (prompt tokens
     * exceeded it). Sticky for the process: after a compaction the tokens drop
     * back under the table value while the real window is still bigger, so
     * without this the chip would resume a percent we already know is wrong.
     *
     * Deliberately NOT persisted. The primary evidence is the transcript tail —
     * `extractClaudeContextTokens` reports the tail's peak prompt, so a cold start
     * re-disproves the window from the file. This Set only covers the narrower
     * case where that evidence has scrolled out of the 64 KB tail while the
     * process kept running.
     */
    disprovenWindows = new Set();
    constructor(deps) {
        this.deps = deps;
    }
    resolveTranscript(agent, sessionId) {
        if (!/^[A-Za-z0-9._-]{1,200}$/.test(sessionId))
            return null;
        const key = `${agent}:${sessionId}`;
        const cached = this.pathCache.get(key);
        if (cached && fs_1.default.existsSync(cached))
            return cached;
        if (cached)
            this.pathCache.delete(key);
        if ((this.missingPathUntil.get(key) ?? 0) > Date.now())
            return null;
        let resolved = null;
        if (agent === 'claude') {
            const projectsDir = path_1.default.join(this.deps.getAgentRoot('claude'), 'projects');
            try {
                for (const dir of fs_1.default.readdirSync(projectsDir)) {
                    const candidate = path_1.default.join(projectsDir, dir, `${sessionId}.jsonl`);
                    if (fs_1.default.existsSync(candidate)) {
                        resolved = candidate;
                        break;
                    }
                }
            }
            catch { /* unknown */ }
        }
        else {
            const sessionsDir = path_1.default.join(this.deps.getAgentRoot('codex'), 'sessions');
            try {
                const dayDirs = [];
                const childDirectories = (dir) => fs_1.default.readdirSync(dir, { withFileTypes: true })
                    .filter((entry) => entry.isDirectory())
                    .map((entry) => entry.name)
                    .sort()
                    .reverse();
                for (const year of childDirectories(sessionsDir)) {
                    for (const month of childDirectories(path_1.default.join(sessionsDir, year))) {
                        for (const day of childDirectories(path_1.default.join(sessionsDir, year, month))) {
                            dayDirs.push(path_1.default.join(sessionsDir, year, month, day));
                            if (dayDirs.length >= CODEX_SCAN_DAY_DIRS)
                                break;
                        }
                        if (dayDirs.length >= CODEX_SCAN_DAY_DIRS)
                            break;
                    }
                    if (dayDirs.length >= CODEX_SCAN_DAY_DIRS)
                        break;
                }
                const suffix = `-${sessionId}.jsonl`;
                for (const dayDir of dayDirs) {
                    const file = fs_1.default.readdirSync(dayDir).find((f) => f.endsWith(suffix));
                    if (file) {
                        resolved = path_1.default.join(dayDir, file);
                        break;
                    }
                }
            }
            catch { /* unknown */ }
        }
        if (resolved) {
            this.pathCache.set(key, resolved);
            this.missingPathUntil.delete(key);
        }
        else {
            // Missing transcripts are a value too: without this negative cache an
            // unsupported/new session would rescan the directory tree every poll.
            this.missingPathUntil.set(key, Date.now() + TTL_MS);
        }
        return resolved;
    }
    readTail(filePath, size) {
        const readBytes = Math.min(size, TAIL_BYTES);
        const fd = fs_1.default.openSync(filePath, 'r');
        try {
            const buf = Buffer.alloc(readBytes);
            fs_1.default.readSync(fd, buf, 0, readBytes, size - readBytes);
            return buf.toString('utf-8');
        }
        finally {
            fs_1.default.closeSync(fd);
        }
    }
    getUsage(agent, sessionId) {
        if ((agent !== 'claude' && agent !== 'codex') || !sessionId)
            return null;
        const key = `${agent}:${sessionId}`;
        const transcript = this.resolveTranscript(agent, sessionId);
        if (!transcript)
            return null;
        let stat;
        try {
            stat = fs_1.default.statSync(transcript);
        }
        catch {
            return null;
        }
        const cached = this.cache.get(key);
        if (cached && cached.mtimeMs === stat.mtimeMs && Date.now() < cached.expiresAt) {
            return cached.snapshot;
        }
        let snapshot = null;
        try {
            const tail = this.readTail(transcript, stat.size);
            const extracted = agent === 'claude'
                ? extractClaudeContextTokens(tail)
                : extractCodexContextTokens(tail);
            if (extracted) {
                const model = extracted.model;
                // A window read from the transcript itself (codex's
                // `model_context_window`, on the same line as the usage) is VERIFIED
                // per-session evidence — it bypasses the assumed table and its
                // disproof bookkeeping entirely. The structural `tokens <= window`
                // guard still applies: a torn line must degrade to raw tokens, never
                // render >100%.
                const verifiedWindow = typeof extracted.contextWindow === 'number' && extracted.tokens <= extracted.contextWindow
                    ? extracted.contextWindow
                    : null;
                const windowEntry = verifiedWindow
                    ? null
                    : (0, agentContextWindows_1.resolveContextWindow)(model ?? (agent === 'claude' ? 'claude' : undefined));
                // Observation outranks the table: a prompt bigger than the assumed
                // window proves the assumption wrong (Opus 5's 1M beta reports a plain
                // `claude-opus-5` id), so the window is dropped and the snapshot
                // degrades to honest raw tokens rather than a >100% percent.
                //
                // The peak is read from the TAIL, not just the latest turn, so the
                // verdict is re-derived from the file on every cold start instead of
                // relying on `disprovenWindows` having survived — no persisted state.
                // Codex is excluded from the peak scan on purpose: its fallback
                // `total_token_usage` is cumulative, so a max across lines would
                // manufacture a disproof. (Codex's window now comes verified from the
                // transcript instead, so the peak/disproof machinery stays
                // Claude-only.)
                const observedPeak = Math.max(extracted.tokens, extracted.maxTokens ?? 0);
                if (windowEntry && observedPeak > windowEntry.window) {
                    this.disprovenWindows.add(key);
                }
                const usableWindow = windowEntry && !this.disprovenWindows.has(key) ? windowEntry : null;
                snapshot = {
                    tokens: extracted.tokens,
                    ...(model ? { model } : {}),
                    ...(verifiedWindow
                        ? { window: verifiedWindow }
                        : usableWindow
                            ? { window: usableWindow.window, assumedWindow: true }
                            : {}),
                    ...(extracted.staleAfterCompact ? { staleAfterCompact: true } : {}),
                    source: 'transcript',
                    at: Date.now(),
                };
            }
        }
        catch { /* unknown */ }
        this.cache.set(key, { snapshot, mtimeMs: stat.mtimeMs, expiresAt: Date.now() + TTL_MS });
        return snapshot;
    }
}
exports.ContextMeterService = ContextMeterService;
