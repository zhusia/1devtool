"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.McpActivityLog = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const promises_1 = __importDefault(require("node:fs/promises"));
const node_path_1 = __importDefault(require("node:path"));
const mcpActivity_1 = require("../shared/mcpActivity");
// Five hundred entries can each contain bounded input, output, and error
// previews. Keep startup reads finite while leaving room for the worst-case
// valid retained set plus JSON metadata.
const MAX_DISK_BYTES = 16 * 1024 * 1024;
const DEFAULT_SAVE_DEBOUNCE_MS = 750;
function validStatus(value) {
    return value === 'running' || value === 'done' || value === 'error' || value === 'interrupted';
}
function normalizeDiskEntry(value) {
    if (!value || typeof value !== 'object')
        return null;
    const entry = value;
    if (typeof entry.callId !== 'string'
        || typeof entry.toolName !== 'string'
        || typeof entry.profile !== 'string'
        || typeof entry.startedAt !== 'number'
        || !validStatus(entry.status))
        return null;
    return {
        callId: entry.callId,
        toolName: entry.toolName,
        profile: entry.profile,
        status: entry.status,
        startedAt: entry.startedAt,
        endedAt: typeof entry.endedAt === 'number' ? entry.endedAt : null,
        durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : null,
        ...(typeof entry.terminalId === 'string' ? { terminalId: entry.terminalId } : {}),
        ...(typeof entry.terminalLabel === 'string' ? { terminalLabel: entry.terminalLabel } : {}),
        ...(typeof entry.projectName === 'string' ? { projectName: entry.projectName } : {}),
        ...(typeof entry.agentType === 'string' ? { agentType: entry.agentType } : {}),
        ...(entry.inputPreview !== undefined ? { inputPreview: (0, mcpActivity_1.createMcpActivityPreview)(entry.inputPreview) } : {}),
        ...(entry.outputPreview !== undefined ? { outputPreview: (0, mcpActivity_1.createMcpActivityPreview)(entry.outputPreview) } : {}),
        ...(typeof entry.error === 'string' ? { error: (0, mcpActivity_1.truncateMcpActivityError)(entry.error) } : {}),
    };
}
/** Main-process owner for bounded, restart-persistent MCP diagnostics. */
class McpActivityLog {
    filePath;
    maxEntries;
    saveDebounceMs;
    onChanged;
    entries = [];
    sequence = 0;
    saveTimer = null;
    writeChain = Promise.resolve();
    dirty = false;
    disposed = false;
    constructor(options) {
        this.filePath = options.filePath;
        this.maxEntries = Math.max(1, options.maxEntries ?? mcpActivity_1.MCP_ACTIVITY_HISTORY_LIMIT);
        this.saveDebounceMs = Math.max(0, options.saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS);
        this.onChanged = options.onChanged ?? null;
        this.load();
    }
    start(event, metadata = {}) {
        const entry = {
            callId: event.callId,
            toolName: event.toolName,
            profile: event.profile,
            status: 'running',
            startedAt: event.startedAt,
            endedAt: null,
            durationMs: null,
            ...(event.terminalId ? { terminalId: event.terminalId } : {}),
            ...(metadata.terminalLabel ? { terminalLabel: metadata.terminalLabel } : {}),
            ...(metadata.projectName ? { projectName: metadata.projectName } : {}),
            ...(metadata.agentType ? { agentType: metadata.agentType } : {}),
            ...(event.args !== undefined ? { inputPreview: (0, mcpActivity_1.createMcpActivityPreview)(event.args) } : {}),
        };
        this.entries = [entry, ...this.entries.filter((candidate) => candidate.callId !== entry.callId)]
            .slice(0, this.maxEntries);
        this.changed();
        return entry;
    }
    complete(event) {
        const index = this.entries.findIndex((entry) => entry.callId === event.callId);
        const existing = index >= 0 ? this.entries[index] : null;
        const startedAt = existing?.startedAt ?? event.endedAt;
        const entry = {
            ...(existing ?? {
                callId: event.callId,
                toolName: event.toolName,
                profile: event.profile,
                startedAt,
            }),
            status: event.status,
            endedAt: event.endedAt,
            durationMs: Math.max(0, event.endedAt - startedAt),
            ...(event.result !== undefined ? { outputPreview: (0, mcpActivity_1.createMcpActivityPreview)(event.result) } : {}),
            ...(event.error ? { error: (0, mcpActivity_1.truncateMcpActivityError)(event.error) } : {}),
        };
        if (index >= 0) {
            const next = [...this.entries];
            next[index] = entry;
            this.entries = next;
        }
        else {
            this.entries = [entry, ...this.entries].slice(0, this.maxEntries);
        }
        this.changed();
        return entry;
    }
    query(query = {}) {
        const limit = Math.max(1, Math.min(mcpActivity_1.MCP_ACTIVITY_QUERY_LIMIT, Math.floor(query.limit ?? mcpActivity_1.MCP_ACTIVITY_DEFAULT_QUERY_LIMIT)));
        const status = query.status && query.status !== 'all' ? query.status : null;
        const search = query.search?.trim().toLowerCase() ?? '';
        const matches = this.entries.filter((entry) => {
            if (status && entry.status !== status)
                return false;
            if (!search)
                return true;
            return [
                entry.toolName,
                entry.profile,
                entry.terminalLabel,
                entry.projectName,
                entry.agentType,
                entry.error,
            ].some((value) => value?.toLowerCase().includes(search));
        });
        return {
            sequence: this.sequence,
            entries: matches.slice(0, limit),
            total: matches.length,
            retained: this.entries.length,
        };
    }
    clear() {
        if (this.entries.length === 0)
            return;
        this.entries = [];
        this.changed();
    }
    async flush() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        if (this.dirty)
            this.enqueueSave();
        await this.writeChain;
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        this.dirty = false;
        const snapshot = this.diskSnapshot();
        const tempPath = `${this.filePath}.${process.pid}.shutdown.tmp`;
        try {
            node_fs_1.default.mkdirSync(node_path_1.default.dirname(this.filePath), { recursive: true, mode: 0o700 });
            node_fs_1.default.writeFileSync(tempPath, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
            node_fs_1.default.renameSync(tempPath, this.filePath);
        }
        catch {
            try {
                node_fs_1.default.rmSync(tempPath, { force: true });
            }
            catch { /* best-effort */ }
        }
    }
    load() {
        try {
            const stat = node_fs_1.default.statSync(this.filePath);
            if (stat.size > MAX_DISK_BYTES)
                return;
            const parsed = JSON.parse(node_fs_1.default.readFileSync(this.filePath, 'utf8'));
            if (parsed.version !== 1 || !Array.isArray(parsed.entries))
                return;
            this.sequence = typeof parsed.sequence === 'number' ? parsed.sequence : 0;
            this.entries = parsed.entries
                .map(normalizeDiskEntry)
                .filter((entry) => entry !== null)
                .slice(0, this.maxEntries)
                .map((entry) => entry.status === 'running'
                ? {
                    ...entry,
                    status: 'interrupted',
                    endedAt: null,
                    durationMs: null,
                    error: entry.error ?? 'App closed before completion was recorded',
                }
                : entry);
        }
        catch {
            this.entries = [];
            this.sequence = 0;
        }
    }
    changed() {
        this.sequence += 1;
        this.dirty = true;
        this.onChanged?.(this.sequence);
        if (this.saveTimer || this.disposed)
            return;
        if (this.saveDebounceMs === 0) {
            this.enqueueSave();
            return;
        }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.enqueueSave();
        }, this.saveDebounceMs);
        this.saveTimer.unref?.();
    }
    diskSnapshot() {
        return { version: 1, sequence: this.sequence, entries: this.entries };
    }
    enqueueSave() {
        if (!this.dirty)
            return;
        this.dirty = false;
        const snapshot = this.diskSnapshot();
        const capturedSequence = snapshot.sequence;
        this.writeChain = this.writeChain.then(async () => {
            const tempPath = `${this.filePath}.${process.pid}.${capturedSequence}.tmp`;
            try {
                await promises_1.default.mkdir(node_path_1.default.dirname(this.filePath), { recursive: true, mode: 0o700 });
                await promises_1.default.writeFile(tempPath, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
                if (capturedSequence !== this.sequence) {
                    await promises_1.default.rm(tempPath, { force: true });
                    return;
                }
                await promises_1.default.rename(tempPath, this.filePath);
            }
            catch {
                try {
                    await promises_1.default.rm(tempPath, { force: true });
                }
                catch { /* best-effort */ }
            }
        });
    }
}
exports.McpActivityLog = McpActivityLog;
