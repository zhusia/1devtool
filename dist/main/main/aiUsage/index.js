"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiUsageService = void 0;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const aiUsage_1 = require("../../shared/aiUsage");
const aiPricing_1 = require("../../shared/aiPricing");
const agentPaths_1 = require("../agentPaths");
const claude_1 = require("./parsers/claude");
const codex_1 = require("./parsers/codex");
const gemini_1 = require("./parsers/gemini");
const qwen_1 = require("./parsers/qwen");
const opencode_1 = require("./parsers/opencode");
const concurrency_1 = require("./concurrency");
const cacheCodec_1 = require("./cacheCodec");
const HANDLERS = {
    claude: { discover: claude_1.discoverClaudeFiles, parse: claude_1.parseClaudeFile },
    codex: { discover: codex_1.discoverCodexFiles, parse: codex_1.parseCodexFile },
    gemini: { discover: gemini_1.discoverGeminiFiles, parse: gemini_1.parseGeminiFile },
    qwen: { discover: qwen_1.discoverQwenFiles, parse: qwen_1.parseQwenFile },
    opencode: { discover: opencode_1.discoverOpencodeFiles, parse: opencode_1.parseOpencodeFile },
};
const AGENTS = ['claude', 'codex', 'gemini', 'qwen', 'opencode'];
const FILE_STAT_CONCURRENCY = 64;
const FILE_PARSE_CONCURRENCY = 8;
class AiUsageService {
    options;
    // Per-file cache keyed by absolute path. Invalidated when mtime changes so a
    // Claude session still being written is re-parsed on the next scan.
    // Persisted to disk so unchanged session files are parsed at most once
    // across app restarts.
    fileCache = new Map();
    cacheLoaded = false;
    cacheLoadPromise = null;
    saveTimer = null;
    savePromise = null;
    cacheGeneration = 0;
    cacheRevision = 0;
    persistedRevision = 0;
    inFlightSummaries = new Map();
    inFlightSessionUsage = new Map();
    inFlightParses = new Map();
    constructor(options = {}) {
        this.options = options;
    }
    get cacheFilePath() {
        return this.options.cacheFilePath ?? path_1.default.join(electron_1.app.getPath('userData'), 'ai-usage-cache.json');
    }
    buildSummary(overrides, query) {
        const generation = this.cacheGeneration;
        const key = this.getSummaryKey(generation, overrides, query);
        const existing = this.inFlightSummaries.get(key);
        if (existing)
            return existing;
        const pending = this.runBuildSummary(generation, overrides, query);
        this.inFlightSummaries.set(key, pending);
        const cleanup = () => {
            if (this.inFlightSummaries.get(key) === pending) {
                this.inFlightSummaries.delete(key);
            }
        };
        void pending.then(cleanup, cleanup);
        return pending;
    }
    async runBuildSummary(generation, overrides, query) {
        await this.ensureCacheLoaded();
        const livePaths = new Set();
        const byAgent = [];
        for (const agent of this.options.agents ?? AGENTS) {
            byAgent.push(await this.summarizeAgent(agent, overrides, query, livePaths, generation));
        }
        const total = sumTotals(byAgent.map((a) => a.totals));
        if (generation === this.cacheGeneration) {
            this.pruneDeadFiles(livePaths);
            if (this.cacheRevision !== this.persistedRevision)
                this.scheduleSave();
        }
        return { byAgent, total, scannedAt: Date.now(), pricingVersion: aiPricing_1.PRICING_VERSION };
    }
    /**
     * Per-session totals for the same window a summary would cover.
     *
     * Shares the file cache, the parse pool and the in-flight dedupe with
     * `buildSummary` — asking for both costs one scan, not two. Consumers join
     * these rows to a terminal's `lastSessionId`; sessions nobody claims stay
     * visible in `total`, which is what keeps an attribution view honest.
     */
    buildSessionUsage(overrides, query) {
        const generation = this.cacheGeneration;
        const filter = normalizeSessionFilter(query?.sessionIds);
        const key = `session:${this.getSummaryKey(generation, overrides, query)}:${filter ? [...filter].sort().join(',') : '*'}`;
        const existing = this.inFlightSessionUsage.get(key);
        if (existing)
            return existing;
        const pending = this.runBuildSessionUsage(generation, overrides, query, filter);
        this.inFlightSessionUsage.set(key, pending);
        const cleanup = () => {
            if (this.inFlightSessionUsage.get(key) === pending) {
                this.inFlightSessionUsage.delete(key);
            }
        };
        void pending.then(cleanup, cleanup);
        return pending;
    }
    async runBuildSessionUsage(generation, overrides, query, filter) {
        await this.ensureCacheLoaded();
        const livePaths = new Set();
        const rows = [];
        const total = { ...aiUsage_1.EMPTY_TOTALS };
        // `total` counts EVERY session in the window, filtered or not — it is what
        // the unattributed remainder is computed from.
        let sessionCount = 0;
        for (const agent of this.options.agents ?? AGENTS) {
            const collected = await this.collectAgentRecords(agent, overrides, livePaths, generation);
            // An unreadable/unsupported agent contributes no sessions. The per-agent
            // summary is where that distinction is reported.
            if (!collected.ok)
                continue;
            const aggregated = aggregateSessions(agent, collected.records, query, filter);
            for (const entry of aggregated.rows)
                rows.push(entry);
            addTotals(total, aggregated.total);
            sessionCount += aggregated.sessionCount;
        }
        total.sessions = sessionCount;
        // Newest first: the cap must drop history, never the session the user is
        // sitting in right now.
        rows.sort((a, b) => b.lastActivityMs - a.lastActivityMs || a.sessionId.localeCompare(b.sessionId));
        const truncated = rows.length > aiUsage_1.SESSION_USAGE_MAX_ROWS;
        if (generation === this.cacheGeneration) {
            this.pruneDeadFiles(livePaths);
            if (this.cacheRevision !== this.persistedRevision)
                this.scheduleSave();
        }
        return {
            bySession: truncated ? rows.slice(0, aiUsage_1.SESSION_USAGE_MAX_ROWS) : rows,
            truncated,
            total,
            scannedAt: Date.now(),
            pricingVersion: aiPricing_1.PRICING_VERSION,
        };
    }
    clearCache() {
        this.cacheGeneration++;
        this.fileCache.clear();
        this.inFlightParses.clear();
        this.markCacheDirty();
        // A refresh before the first summary must not reload the persisted cache.
        this.cacheLoaded = true;
        this.scheduleSave();
    }
    async ensureCacheLoaded() {
        if (this.cacheLoaded)
            return;
        if (!this.cacheLoadPromise) {
            const generation = this.cacheGeneration;
            this.cacheLoadPromise = (async () => {
                try {
                    const raw = await fs_1.promises.readFile(this.cacheFilePath, 'utf8');
                    const data = (0, cacheCodec_1.decodeUsageCache)(JSON.parse(raw));
                    if (!data)
                        return;
                    // If pricing has changed since the cache was written, the raw token
                    // buckets are still valid — cost is recomputed in aggregateAgent from
                    // the current pricing table, so we can keep the parsed records.
                    if (generation !== this.cacheGeneration)
                        return;
                    for (const entry of data.files) {
                        this.fileCache.set(entry.filePath, entry);
                    }
                    if (data.requiresRewrite)
                        this.markCacheDirty();
                }
                catch {
                    // No cache yet or unreadable — start fresh.
                }
                finally {
                    if (generation === this.cacheGeneration)
                        this.cacheLoaded = true;
                    this.cacheLoadPromise = null;
                }
            })();
        }
        await this.cacheLoadPromise;
    }
    pruneDeadFiles(livePaths) {
        for (const key of this.fileCache.keys()) {
            if (!livePaths.has(key) && this.fileCache.delete(key))
                this.markCacheDirty();
        }
    }
    scheduleSave() {
        if (this.cacheRevision === this.persistedRevision
            || this.saveTimer
            || this.savePromise) {
            return;
        }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            const revision = this.cacheRevision;
            const pending = this.saveCache(revision);
            this.savePromise = pending;
            void pending.finally(() => {
                if (this.savePromise === pending)
                    this.savePromise = null;
                // If the cache changed while the snapshot was being written, persist
                // the newest revision after this write settles. A failed unchanged
                // write waits for the next scan instead of entering a retry loop.
                if (this.cacheRevision !== revision)
                    this.scheduleSave();
            });
        }, this.options.saveDebounceMs ?? 500);
    }
    async saveCache(revision) {
        const payload = (0, cacheCodec_1.encodeUsageCache)(Array.from(this.fileCache.values()), aiPricing_1.PRICING_VERSION);
        const tmp = `${this.cacheFilePath}.tmp`;
        try {
            await fs_1.promises.writeFile(tmp, JSON.stringify(payload), 'utf8');
            if (revision !== this.cacheRevision) {
                await fs_1.promises.unlink(tmp).catch(() => { });
                return;
            }
            await fs_1.promises.rename(tmp, this.cacheFilePath);
            this.persistedRevision = revision;
        }
        catch {
            // Cache is advisory — swallow write errors rather than blocking scan.
        }
    }
    markCacheDirty() {
        this.cacheRevision++;
    }
    async summarizeAgent(agent, overrides, query, livePaths, generation) {
        const collected = await this.collectAgentRecords(agent, overrides, livePaths, generation);
        if (!collected.ok)
            return emptyAgent(agent, collected.available, collected.error);
        return aggregateAgent(agent, collected.records, query);
    }
    /**
     * Discover → parse → dedupe one agent's usage records. Shared by the
     * per-agent summary and the per-session roster so both views are built from
     * exactly the same evidence.
     */
    async collectAgentRecords(agent, overrides, livePaths, generation) {
        const root = (this.options.resolveAgentRoot ?? agentPaths_1.getAgentRoot)(agent, overrides);
        const handlers = (this.options.handlers ?? HANDLERS)[agent];
        if (!handlers) {
            return { ok: false, available: true, error: 'Usage parsing is not yet supported for this CLI.' };
        }
        try {
            const stat = await fs_1.promises.stat(root);
            if (!stat.isDirectory())
                return { ok: false, available: false, error: 'Agent root is not a directory' };
        }
        catch {
            return { ok: false, available: false };
        }
        let files;
        try {
            files = await handlers.discover(root);
        }
        catch (err) {
            return { ok: false, available: true, error: err instanceof Error ? err.message : String(err) };
        }
        for (const file of files) {
            livePaths.add(file);
        }
        const parsedFiles = await this.getParsedFiles(files, handlers.parse, generation);
        const records = [];
        for (const parsed of parsedFiles) {
            if (parsed)
                records.push(...parsed.records);
        }
        // Cross-file dedupe — necessary when Claude resumes into a new session
        // file but replays earlier assistant messages with their original ids.
        const seen = new Set();
        const unique = [];
        for (const r of records) {
            if (seen.has(r.dedupeKey))
                continue;
            seen.add(r.dedupeKey);
            unique.push(r);
        }
        return { ok: true, records: unique };
    }
    async getParsedFiles(filePaths, parse, generation) {
        // Metadata checks are lightweight and benefit from a wide pool on large,
        // warm caches. Parsing uses a deliberately smaller pool so a first scan
        // cannot open and materialize thousands of JSONL files at once.
        const mtimes = await (0, concurrency_1.mapWithConcurrency)(filePaths, this.options.statConcurrency ?? FILE_STAT_CONCURRENCY, async (filePath) => {
            try {
                return { filePath, mtimeMs: (await fs_1.promises.stat(filePath)).mtimeMs };
            }
            catch {
                if (generation === this.cacheGeneration
                    && this.fileCache.delete(filePath)) {
                    this.markCacheDirty();
                }
                return null;
            }
        });
        return (0, concurrency_1.mapWithConcurrency)(mtimes, this.options.parseConcurrency ?? FILE_PARSE_CONCURRENCY, async (entry) => entry ? this.getParsedFile(entry, parse, generation) : null);
    }
    async getParsedFile({ filePath, mtimeMs }, parse, generation) {
        const cached = this.fileCache.get(filePath);
        if (cached && cached.mtimeMs === mtimeMs)
            return cached;
        const existing = this.inFlightParses.get(filePath);
        if (existing
            && existing.generation === generation
            && existing.mtimeMs === mtimeMs) {
            try {
                return await existing.promise;
            }
            catch {
                return cached ?? null;
            }
        }
        // Normalize a synchronous parser throw into a rejected promise so it keeps
        // the same stale-cache fallback behavior as an async parser failure.
        const pending = Promise.resolve().then(() => parse(filePath, mtimeMs));
        const inFlight = { generation, mtimeMs, promise: pending };
        this.inFlightParses.set(filePath, inFlight);
        const cleanup = () => {
            if (this.inFlightParses.get(filePath) === inFlight) {
                this.inFlightParses.delete(filePath);
            }
        };
        try {
            const parsed = await pending;
            if (generation === this.cacheGeneration) {
                this.fileCache.set(filePath, parsed);
                this.markCacheDirty();
            }
            return parsed;
        }
        catch {
            return cached ?? null;
        }
        finally {
            cleanup();
        }
    }
    getSummaryKey(generation, overrides, query) {
        const resolveRoot = this.options.resolveAgentRoot ?? agentPaths_1.getAgentRoot;
        const roots = (this.options.agents ?? AGENTS).map((agent) => [agent, resolveRoot(agent, overrides)]);
        return JSON.stringify([
            generation,
            roots,
            query?.fromMs ?? null,
            query?.toMs ?? null,
        ]);
    }
}
exports.AiUsageService = AiUsageService;
function emptyAgent(agent, available, error) {
    return {
        agent,
        available,
        error,
        totals: { ...aiUsage_1.EMPTY_TOTALS },
        byModel: [],
        lastActivityMs: null,
    };
}
function aggregateAgent(agent, records, query) {
    const totalsByModel = new Map();
    const overallSessions = new Set();
    const total = { ...aiUsage_1.EMPTY_TOTALS };
    let lastActivityMs = 0;
    for (const r of records) {
        if (!matchesUsageQuery(r.timestampMs, query))
            continue;
        overallSessions.add(r.sessionId);
        if (r.timestampMs > lastActivityMs)
            lastActivityMs = r.timestampMs;
        const modelKey = r.model ?? 'unknown';
        let bucket = totalsByModel.get(modelKey);
        if (!bucket) {
            bucket = { totals: { ...aiUsage_1.EMPTY_TOTALS }, sessions: new Set() };
            totalsByModel.set(modelKey, bucket);
        }
        bucket.sessions.add(r.sessionId);
        const cost = (0, aiPricing_1.costFor)(r.model, {
            input: r.inputTokens,
            output: r.outputTokens,
            cacheRead: r.cacheReadTokens,
            cacheCreate: r.cacheCreateTokens,
            reasoning: r.reasoningTokens,
        });
        const totalDelta = r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreateTokens + r.reasoningTokens;
        accumulate(bucket.totals, r, cost, totalDelta);
        accumulate(total, r, cost, totalDelta);
    }
    total.sessions = overallSessions.size;
    const byModel = [];
    for (const [model, bucket] of totalsByModel) {
        bucket.totals.sessions = bucket.sessions.size;
        byModel.push({ model, totals: bucket.totals });
    }
    byModel.sort((a, b) => b.totals.totalTokens - a.totals.totalTokens);
    return {
        agent,
        available: true,
        totals: total,
        byModel,
        lastActivityMs: lastActivityMs > 0 ? lastActivityMs : null,
    };
}
/**
 * Collapse one agent's records into per-session rows. Each row's `sessions` is
 * 1 by construction — it IS a session — and its model is the one that produced
 * the most tokens, because a resumed session can switch models mid-way.
 */
function aggregateSessions(agent, records, query, filter) {
    const bySession = new Map();
    // Sessions the filter excluded still count toward the machine total, so an
    // attribution view can report the unattributed remainder truthfully.
    const total = { ...aiUsage_1.EMPTY_TOTALS };
    const seenSessions = new Set();
    for (const r of records) {
        if (!matchesUsageQuery(r.timestampMs, query))
            continue;
        seenSessions.add(r.sessionId);
        const cost = (0, aiPricing_1.costFor)(r.model, {
            input: r.inputTokens,
            output: r.outputTokens,
            cacheRead: r.cacheReadTokens,
            cacheCreate: r.cacheCreateTokens,
            reasoning: r.reasoningTokens,
        });
        const totalDelta = r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreateTokens + r.reasoningTokens;
        accumulate(total, r, cost, totalDelta);
        // Bucketing is the expensive half; skip it for sessions nobody asked about.
        if (filter && !filter.has(r.sessionId))
            continue;
        let bucket = bySession.get(r.sessionId);
        if (!bucket) {
            bucket = {
                totals: { ...aiUsage_1.EMPTY_TOTALS, sessions: 1 },
                projectPath: r.projectPath,
                lastActivityMs: 0,
                tokensByModel: new Map(),
            };
            bySession.set(r.sessionId, bucket);
        }
        accumulate(bucket.totals, r, cost, totalDelta);
        if (r.timestampMs > bucket.lastActivityMs)
            bucket.lastActivityMs = r.timestampMs;
        if (!bucket.projectPath && r.projectPath)
            bucket.projectPath = r.projectPath;
        if (r.model)
            bucket.tokensByModel.set(r.model, (bucket.tokensByModel.get(r.model) ?? 0) + totalDelta);
    }
    const rows = [];
    for (const [sessionId, bucket] of bySession) {
        let model = null;
        let best = -1;
        for (const [candidate, tokens] of bucket.tokensByModel) {
            if (tokens > best) {
                best = tokens;
                model = candidate;
            }
        }
        rows.push({
            agent,
            sessionId,
            projectPath: bucket.projectPath,
            model,
            totals: bucket.totals,
            lastActivityMs: bucket.lastActivityMs,
        });
    }
    return { rows, total, sessionCount: seenSessions.size };
}
/**
 * Bounded, de-duplicated session filter. An oversized list is dropped rather
 * than honored partially — a partial filter would silently hide rows the caller
 * asked for, which is worse than returning the (capped) full roster.
 */
function normalizeSessionFilter(sessionIds) {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0)
        return null;
    if (sessionIds.length > aiUsage_1.SESSION_USAGE_MAX_FILTER_IDS)
        return null;
    const ids = new Set();
    for (const id of sessionIds) {
        if (typeof id === 'string' && id.length > 0)
            ids.add(id);
    }
    return ids.size > 0 ? ids : null;
}
function matchesUsageQuery(timestampMs, query) {
    if (query?.fromMs !== undefined && timestampMs < query.fromMs)
        return false;
    if (query?.toMs !== undefined && timestampMs >= query.toMs)
        return false;
    return true;
}
function accumulate(t, r, cost, totalDelta) {
    t.inputTokens += r.inputTokens;
    t.outputTokens += r.outputTokens;
    t.cacheReadTokens += r.cacheReadTokens;
    t.cacheCreateTokens += r.cacheCreateTokens;
    t.reasoningTokens += r.reasoningTokens;
    t.totalTokens += totalDelta;
    t.costUsd += cost;
}
/** Fold `add` into `into`. `sessions` is owned by the caller — session counts
 *  are cardinalities, not sums of per-row 1s in every context. */
function addTotals(into, add) {
    into.inputTokens += add.inputTokens;
    into.outputTokens += add.outputTokens;
    into.cacheReadTokens += add.cacheReadTokens;
    into.cacheCreateTokens += add.cacheCreateTokens;
    into.reasoningTokens += add.reasoningTokens;
    into.totalTokens += add.totalTokens;
    into.costUsd += add.costUsd;
}
function sumTotals(totals) {
    const out = { ...aiUsage_1.EMPTY_TOTALS };
    for (const t of totals) {
        out.sessions += t.sessions;
        out.inputTokens += t.inputTokens;
        out.outputTokens += t.outputTokens;
        out.cacheReadTokens += t.cacheReadTokens;
        out.cacheCreateTokens += t.cacheCreateTokens;
        out.reasoningTokens += t.reasoningTokens;
        out.totalTokens += t.totalTokens;
        out.costUsd += t.costUsd;
    }
    return out;
}
