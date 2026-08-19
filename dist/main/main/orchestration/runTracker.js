"use strict";
/**
 * Main-process index over the CLI-written orchestration run records
 * (docs/features/orchestration/dashboard.md §4.3).
 *
 * Ownership contract:
 *  - The CLI owns every `runs/<callId>/` dir and its meta.json. This tracker
 *    NEVER rewrites meta.json — `interrupted` is DERIVED at serve time
 *    (startedAt + timeoutSeconds + grace) so a late CLI finalizer always wins.
 *  - Bridge /subagent events are low-latency WAKE HINTS only; meta.json is
 *    authoritative (bridge POSTs are best-effort with a 400 ms timeout).
 *    Dedupe by callId is inherent: the index is keyed by run dir.
 *  - Polling (3 s) is the primary refresh while the dashboard is open; the
 *    non-recursive fs.watch on runs/ cannot reliably observe the atomic
 *    replacement of meta.json on all platforms, so it too is only a hint.
 *  - Pruning is main-owned only (boot + dashboard open) and always skips
 *    records whose served status is `running` — a live CLI owns that dir.
 *
 * No Electron imports — paths are injected so unit tests can run under tsx.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrchestrationRunTracker = exports.RUN_FILE_READ_CAP_BYTES = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const orchestrationRuns_1 = require("../../shared/orchestrationRuns");
/** Hard bound on how many run dirs a single scan will consider (beyond the
 *  retention cap, extra dirs cost only disk until pruned). */
const SCAN_MAX_DIRS = 1000;
const POLL_INTERVAL_MS = 3000;
const EMIT_THROTTLE_MS = 1000;
const HINT_DEBOUNCE_MS = 300;
const CACHE_SAVE_DEBOUNCE_MS = 5000;
exports.RUN_FILE_READ_CAP_BYTES = 256 * 1024;
class OrchestrationRunTracker {
    homeDir;
    cachePath;
    logPath;
    onRunsChanged;
    cache = new Map();
    cacheLoaded = false;
    subscriberCount = 0;
    pollTimer = null;
    watcher = null;
    hintTimer = null;
    cacheSaveTimer = null;
    lastEmitAt = 0;
    pendingEmitTimer = null;
    disposed = false;
    constructor(options = {}) {
        this.homeDir = options.homeDir ?? node_os_1.default.homedir();
        this.cachePath = options.cachePath ?? null;
        this.logPath = options.logPath ?? null;
        this.onRunsChanged = options.onRunsChanged ?? null;
    }
    runsDir() {
        return (0, orchestrationRuns_1.getOrchestrationRunsDir)(this.homeDir);
    }
    // -------------------------------------------------------------------------
    // Activity log
    // -------------------------------------------------------------------------
    log(message) {
        if (!this.logPath)
            return;
        try {
            node_fs_1.default.mkdirSync(node_path_1.default.dirname(this.logPath), { recursive: true });
            node_fs_1.default.appendFileSync(this.logPath, `${new Date().toISOString()} ${message}\n`, 'utf-8');
            // Bound the log: past 512 KB keep the newest 256 KB.
            const { size } = node_fs_1.default.statSync(this.logPath);
            if (size > 512 * 1024) {
                const fd = node_fs_1.default.openSync(this.logPath, 'r');
                try {
                    const keep = Buffer.alloc(256 * 1024);
                    node_fs_1.default.readSync(fd, keep, 0, keep.length, size - keep.length);
                    node_fs_1.default.writeFileSync(this.logPath, keep);
                }
                finally {
                    node_fs_1.default.closeSync(fd);
                }
            }
        }
        catch { /* best-effort */ }
    }
    getLogPath() {
        return this.logPath;
    }
    // -------------------------------------------------------------------------
    // Persisted cache (mtime-keyed, same pattern as ai-usage-cache.json)
    // -------------------------------------------------------------------------
    loadPersistedCache() {
        if (this.cacheLoaded)
            return;
        this.cacheLoaded = true;
        if (!this.cachePath)
            return;
        try {
            const parsed = JSON.parse(node_fs_1.default.readFileSync(this.cachePath, 'utf-8'));
            if (parsed?.version !== 1 || !Array.isArray(parsed.entries))
                return;
            for (const entry of parsed.entries) {
                if (!entry || !(0, orchestrationRuns_1.isValidRunCallId)(entry.callId ?? '') || typeof entry.metaMtimeMs !== 'number')
                    continue;
                if (!entry.record || typeof entry.record !== 'object')
                    continue;
                this.cache.set(entry.callId, { record: entry.record, metaMtimeMs: entry.metaMtimeMs });
            }
        }
        catch { /* cold cache */ }
    }
    scheduleCacheSave() {
        if (!this.cachePath || this.cacheSaveTimer || this.disposed)
            return;
        this.cacheSaveTimer = setTimeout(() => {
            this.cacheSaveTimer = null;
            try {
                const payload = {
                    version: 1,
                    entries: [...this.cache.entries()].map(([callId, cached]) => ({
                        callId,
                        metaMtimeMs: cached.metaMtimeMs,
                        record: cached.record,
                    })),
                };
                node_fs_1.default.mkdirSync(node_path_1.default.dirname(this.cachePath), { recursive: true });
                node_fs_1.default.writeFileSync(this.cachePath, JSON.stringify(payload), 'utf-8');
            }
            catch { /* best-effort */ }
        }, CACHE_SAVE_DEBOUNCE_MS);
        this.cacheSaveTimer.unref?.();
    }
    // -------------------------------------------------------------------------
    // Scan / index
    // -------------------------------------------------------------------------
    /** Rescan runs/: pick up new dirs, drop deleted ones, and re-read any
     *  meta.json whose mtime changed or whose cached status is `running`. */
    scan() {
        this.loadPersistedCache();
        let names;
        try {
            names = node_fs_1.default.readdirSync(this.runsDir()).slice(0, SCAN_MAX_DIRS);
        }
        catch {
            if (this.cache.size > 0) {
                this.cache.clear();
                this.emitChanged();
            }
            return;
        }
        const seen = new Set();
        let changed = false;
        for (const name of names) {
            if (!(0, orchestrationRuns_1.isValidRunCallId)(name))
                continue;
            seen.add(name);
            const runDir = node_path_1.default.join(this.runsDir(), name);
            let mtimeMs;
            try {
                mtimeMs = node_fs_1.default.statSync(node_path_1.default.join(runDir, orchestrationRuns_1.RUN_META_FILE)).mtimeMs;
            }
            catch {
                continue; // meta not written yet (dir just created) — next poll catches it
            }
            const cached = this.cache.get(name);
            // Re-read on mtime drift AND for running records (a same-ms rewrite or
            // coarse-mtime filesystem must not strand a stale `running`).
            if (cached && cached.metaMtimeMs === mtimeMs && cached.record.status !== 'running')
                continue;
            const record = (0, orchestrationRuns_1.readRunMeta)(runDir);
            if (!record || record.callId !== name)
                continue;
            if (!cached || cached.metaMtimeMs !== mtimeMs || cached.record.status !== record.status) {
                changed = changed || !cached || cached.record.status !== record.status || cached.metaMtimeMs !== mtimeMs;
            }
            this.cache.set(name, { record, metaMtimeMs: mtimeMs });
        }
        for (const callId of [...this.cache.keys()]) {
            if (!seen.has(callId)) {
                this.cache.delete(callId);
                changed = true;
            }
        }
        if (changed) {
            this.scheduleCacheSave();
            this.emitChanged();
        }
    }
    /** Served index: newest first, statuses derived (§4.3 — a stale `running`
     *  past deadline+grace is SERVED as `interrupted`, meta.json untouched). */
    list(query = {}) {
        this.scan();
        const now = Date.now();
        let rows = [...this.cache.values()].map(({ record }) => ({
            ...record,
            status: (0, orchestrationRuns_1.deriveServedStatus)(record, now),
        }));
        if (query.agent)
            rows = rows.filter((r) => r.target === query.agent);
        if (query.status)
            rows = rows.filter((r) => r.status === query.status);
        if (typeof query.sinceMs === 'number')
            rows = rows.filter((r) => r.startedAt >= query.sinceMs);
        rows.sort((a, b) => b.startedAt - a.startedAt);
        const limit = typeof query.limit === 'number' && query.limit > 0 ? Math.min(query.limit, SCAN_MAX_DIRS) : 200;
        return rows.slice(0, limit);
    }
    /** Count of runs currently served as `running`. */
    activeCount() {
        return this.list({ status: 'running', limit: SCAN_MAX_DIRS }).length;
    }
    // -------------------------------------------------------------------------
    // Path derivation (id-based IPC contract, §7)
    // -------------------------------------------------------------------------
    /** Derive + validate a run content-file path from ids. Returns null unless
     *  the target exists, is a regular non-symlink file, and its real path
     *  stays inside runs/. Never accepts renderer-supplied paths. */
    resolveRunFile(callId, file) {
        if (!(0, orchestrationRuns_1.isValidRunCallId)(callId))
            return null;
        if (file !== 'meta' && !orchestrationRuns_1.RUN_CONTENT_FILES.includes(file))
            return null;
        const fileName = file === 'meta' ? orchestrationRuns_1.RUN_META_FILE : (0, orchestrationRuns_1.getRunContentFileName)(file);
        const runsDir = this.runsDir();
        const candidate = node_path_1.default.join(runsDir, callId, fileName);
        try {
            const lst = node_fs_1.default.lstatSync(candidate);
            if (!lst.isFile() || lst.isSymbolicLink())
                return null;
            const real = node_fs_1.default.realpathSync(candidate);
            const realRoot = node_fs_1.default.realpathSync(runsDir);
            if (!real.startsWith(realRoot + node_path_1.default.sep))
                return null;
            return real;
        }
        catch {
            return null;
        }
    }
    readRunFile(callId, file) {
        const resolved = this.resolveRunFile(callId, file);
        if (!resolved)
            return null;
        try {
            const { size } = node_fs_1.default.statSync(resolved);
            const fd = node_fs_1.default.openSync(resolved, 'r');
            try {
                const readBytes = Math.min(size, exports.RUN_FILE_READ_CAP_BYTES);
                const buf = Buffer.alloc(readBytes);
                node_fs_1.default.readSync(fd, buf, 0, readBytes, 0);
                return { text: buf.toString('utf-8'), truncated: size > exports.RUN_FILE_READ_CAP_BYTES };
            }
            finally {
                node_fs_1.default.closeSync(fd);
            }
        }
        catch {
            return null;
        }
    }
    // -------------------------------------------------------------------------
    // Delete / prune (running-safe by construction)
    // -------------------------------------------------------------------------
    deleteRun(callId) {
        if (!(0, orchestrationRuns_1.isValidRunCallId)(callId))
            return { ok: false, error: 'invalid run id' };
        this.scan();
        const cached = this.cache.get(callId);
        if (cached && (0, orchestrationRuns_1.deriveServedStatus)(cached.record, Date.now()) === 'running') {
            return { ok: false, error: 'run is still running — a live CLI owns this record' };
        }
        try {
            node_fs_1.default.rmSync(node_path_1.default.join(this.runsDir(), callId), { recursive: true, force: true });
            this.cache.delete(callId);
            this.scheduleCacheSave();
            this.emitChanged();
            return { ok: true };
        }
        catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
    clearRuns() {
        this.scan();
        const now = Date.now();
        let deleted = 0;
        let skippedRunning = 0;
        for (const [callId, cached] of [...this.cache.entries()]) {
            if ((0, orchestrationRuns_1.deriveServedStatus)(cached.record, now) === 'running') {
                skippedRunning++;
                continue;
            }
            try {
                node_fs_1.default.rmSync(node_path_1.default.join(this.runsDir(), callId), { recursive: true, force: true });
                this.cache.delete(callId);
                deleted++;
            }
            catch { /* keep going */ }
        }
        this.log(`clear-runs deleted=${deleted} skippedRunning=${skippedRunning}`);
        this.scheduleCacheSave();
        this.emitChanged();
        return { deleted, skippedRunning };
    }
    /** Retention prune (boot + dashboard open). Deletes run dirs beyond
     *  config.retention, always skipping served-`running` records. */
    prune() {
        this.scan();
        const config = (0, orchestrationRuns_1.readOrchestrationConfig)(this.homeDir);
        const now = Date.now();
        const maxAgeMs = config.retention.maxAgeDays * 24 * 60 * 60 * 1000;
        const rows = [...this.cache.values()]
            .map(({ record }) => ({ record, served: (0, orchestrationRuns_1.deriveServedStatus)(record, now) }))
            .sort((a, b) => b.record.startedAt - a.record.startedAt);
        const toDelete = [];
        rows.forEach((row, index) => {
            if (row.served === 'running')
                return;
            if (index >= config.retention.maxRuns || now - row.record.startedAt > maxAgeMs) {
                toDelete.push(row.record.callId);
            }
        });
        let deleted = 0;
        for (const callId of toDelete) {
            try {
                node_fs_1.default.rmSync(node_path_1.default.join(this.runsDir(), callId), { recursive: true, force: true });
                this.cache.delete(callId);
                deleted++;
            }
            catch { /* keep going */ }
        }
        if (deleted > 0) {
            this.log(`prune deleted=${deleted} (maxRuns=${config.retention.maxRuns} maxAgeDays=${config.retention.maxAgeDays})`);
            this.scheduleCacheSave();
            this.emitChanged();
        }
        return { deleted };
    }
    // -------------------------------------------------------------------------
    // Live refresh: subscriptions, polling, hints
    // -------------------------------------------------------------------------
    /** Renderer dashboard opened: start the 3 s poll (primary refresh) and the
     *  dir watcher (wake hint only). Reference-counted. */
    subscribe() {
        this.subscriberCount++;
        if (this.subscriberCount > 1)
            return;
        this.prune();
        this.pollTimer = setInterval(() => this.scan(), POLL_INTERVAL_MS);
        this.pollTimer.unref?.();
        try {
            this.watcher = node_fs_1.default.watch(this.runsDir(), { persistent: false }, () => this.hintScan());
        }
        catch { /* dir may not exist yet — polling still covers it */ }
    }
    unsubscribe() {
        this.subscriberCount = Math.max(0, this.subscriberCount - 1);
        if (this.subscriberCount > 0)
            return;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.watcher) {
            try {
                this.watcher.close();
            }
            catch { /* noop */ }
            this.watcher = null;
        }
    }
    /** Renderer reload/crash/close: the dashboard's `unsubscribe-runs` never
     *  arrives, so drop every renderer-held subscription and stop the
     *  poll/watcher — a remounted dashboard re-subscribes from zero. */
    resetSubscriptions() {
        if (this.subscriberCount === 0)
            return;
        this.subscriberCount = 0;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        if (this.watcher) {
            try {
                this.watcher.close();
            }
            catch { /* noop */ }
            this.watcher = null;
        }
    }
    /** Bridge /subagent start/end or fs.watch event — debounced wake hint.
     *  meta.json stays authoritative; this only makes the next read sooner.
     *  No-op with zero subscribers: there is no one to wake, and list() rescans
     *  on demand anyway. */
    hintScan() {
        if (this.hintTimer || this.disposed || this.subscriberCount === 0)
            return;
        this.hintTimer = setTimeout(() => {
            this.hintTimer = null;
            this.scan();
        }, HINT_DEBOUNCE_MS);
        this.hintTimer.unref?.();
    }
    emitChanged() {
        if (!this.onRunsChanged || this.disposed)
            return;
        const now = Date.now();
        const elapsed = now - this.lastEmitAt;
        if (elapsed >= EMIT_THROTTLE_MS) {
            this.lastEmitAt = now;
            this.onRunsChanged();
            return;
        }
        if (this.pendingEmitTimer)
            return;
        this.pendingEmitTimer = setTimeout(() => {
            this.pendingEmitTimer = null;
            this.lastEmitAt = Date.now();
            this.onRunsChanged?.();
        }, EMIT_THROTTLE_MS - elapsed);
        this.pendingEmitTimer.unref?.();
    }
    dispose() {
        this.disposed = true;
        if (this.pollTimer)
            clearInterval(this.pollTimer);
        if (this.watcher) {
            try {
                this.watcher.close();
            }
            catch { /* noop */ }
        }
        if (this.hintTimer)
            clearTimeout(this.hintTimer);
        if (this.pendingEmitTimer)
            clearTimeout(this.pendingEmitTimer);
        if (this.cacheSaveTimer)
            clearTimeout(this.cacheSaveTimer);
    }
}
exports.OrchestrationRunTracker = OrchestrationRunTracker;
