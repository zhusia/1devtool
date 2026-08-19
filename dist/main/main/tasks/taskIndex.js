"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskIndexer = void 0;
exports.defaultTasksDir = defaultTasksDir;
const fs_1 = require("fs");
const path = __importStar(require("path"));
const frontmatter_1 = require("./frontmatter");
const ids_1 = require("./ids");
const concurrency_1 = require("../aiUsage/concurrency");
function defaultTasksDir(repoRoot) {
    return path.join(repoRoot, '.1devtool', 'tasks');
}
async function atomicWrite(filePath, data) {
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs_1.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs_1.promises.writeFile(tmp, data, 'utf8');
    await fs_1.promises.rename(tmp, filePath);
}
async function readOptional(filePath) {
    try {
        return (await fs_1.promises.readFile(filePath, 'utf8')).trim();
    }
    catch {
        return undefined;
    }
}
/**
 * A branch name is not a HEAD generation. On a normal checkout `.git/HEAD`
 * stays `ref: refs/heads/main` while commits, rebases and resets move that ref;
 * in a worktree `.git` is a pointer file. Include the resolved ref value (and
 * understand worktree gitdirs) so either kind of checkout invalidates the
 * fingerprint fast path.
 */
async function readGitHeadSignature(repoRoot) {
    const dotGit = path.join(repoRoot, '.git');
    let gitDir = dotGit;
    try {
        const stat = await fs_1.promises.stat(dotGit);
        if (stat.isFile()) {
            const pointer = await fs_1.promises.readFile(dotGit, 'utf8');
            const match = /^gitdir:\s*(.+)\s*$/im.exec(pointer);
            if (!match)
                return undefined;
            gitDir = path.resolve(repoRoot, match[1]);
        }
    }
    catch {
        return undefined;
    }
    const head = await readOptional(path.join(gitDir, 'HEAD'));
    if (!head)
        return undefined;
    if (!head.startsWith('ref: '))
        return head;
    const ref = head.slice(5).trim();
    let value = await readOptional(path.join(gitDir, ref));
    if (!value) {
        const commonDirValue = await readOptional(path.join(gitDir, 'commondir'));
        const commonDir = commonDirValue ? path.resolve(gitDir, commonDirValue) : gitDir;
        value = await readOptional(path.join(commonDir, ref));
        if (!value) {
            const packed = await readOptional(path.join(commonDir, 'packed-refs'));
            value = packed
                ?.split('\n')
                .find((line) => !line.startsWith('#') && !line.startsWith('^') && line.endsWith(` ${ref}`))
                ?.split(' ')[0];
        }
    }
    return `${head}\n${value ?? ''}`;
}
class TaskIndexer {
    deps;
    index = null;
    reconcileTail = Promise.resolve();
    constructor(deps) {
        this.deps = deps;
    }
    async load() {
        if (this.index)
            return this.index;
        try {
            const raw = JSON.parse(await fs_1.promises.readFile(this.deps.indexPath, 'utf8'));
            this.index = raw && raw.version === 4 ? raw : { version: 4, entries: {} };
        }
        catch {
            this.index = { version: 4, entries: {} };
        }
        return this.index;
    }
    async persist() {
        if (!this.index)
            return;
        await atomicWrite(this.deps.indexPath, JSON.stringify(this.index));
    }
    entryFor(projectId) {
        const index = this.index;
        if (!index.entries[projectId]) {
            index.entries[projectId] = { repoRoots: {}, tasks: [], errors: [] };
        }
        return index.entries[projectId];
    }
    /** Read the resolved Git HEAD signature; a change bumps the generation. */
    async checkHead(repoRoot, state) {
        const head = await readGitHeadSignature(repoRoot);
        if (head !== undefined && head !== state.headRef) {
            state.headRef = head;
            state.generation += 1;
            return true;
        }
        return false;
    }
    /**
     * Reconcile one repo root. Returns whether anything changed. Truth comes
     * from this readdir pass — never from watcher events.
     */
    async reconcileRoot(ref, opts = {}) {
        const run = () => this.reconcileRootNow(ref, opts);
        const operation = this.reconcileTail.then(run, run);
        this.reconcileTail = operation.then(() => undefined, () => undefined);
        return operation;
    }
    async reconcileRootNow(ref, opts = {}) {
        await this.load();
        const entry = this.entryFor(ref.projectId);
        const state = entry.repoRoots[ref.repoRoot] ?? (entry.repoRoots[ref.repoRoot] = { generation: 0, files: {} });
        const headChanged = await this.checkHead(ref.repoRoot, state);
        const force = opts.force || headChanged;
        const dir = ref.tasksDir ?? defaultTasksDir(ref.repoRoot);
        let names = [];
        try {
            names = (await fs_1.promises.readdir(dir)).filter((n) => n.endsWith('.md') && !n.endsWith('.conflict.md') && (0, ids_1.taskIdFromFileName)(n) !== null);
        }
        catch {
            names = []; // directory absent = zero tasks for this root
        }
        const seen = new Set(names);
        const nextErrors = [];
        let changed = headChanged;
        const rowsByPath = new Map(entry.tasks.filter((r) => r.repoRoot === ref.repoRoot).map((r) => [r.relPath, r]));
        const outcomes = await (0, concurrency_1.mapWithConcurrency)(names, 16, async (name) => {
            const absPath = path.join(dir, name);
            let stat;
            try {
                stat = await fs_1.promises.stat(absPath);
            }
            catch {
                return { kind: 'skip', name }; // vanished between readdir and stat — next reconcile settles it
            }
            const prev = state.files[name];
            const fp = { mtimeMs: stat.mtimeMs, size: stat.size };
            let needsRead = force || !prev || prev.size !== stat.size;
            if (!needsRead && prev && prev.mtimeMs !== stat.mtimeMs) {
                // Ambiguity: same size, different mtime — hash decides (a touch or a
                // same-length edit; mtime alone cannot tell them apart).
                needsRead = true;
            }
            if (!needsRead)
                return { kind: 'skip', name };
            let text;
            try {
                text = await fs_1.promises.readFile(absPath, 'utf8');
            }
            catch {
                return { kind: 'skip', name };
            }
            fp.hash = (0, frontmatter_1.contentHash)(text);
            if (prev?.hash === fp.hash && !force) {
                // Content identical (touch, checkout of the same bytes): refresh the
                // fingerprint, keep the row, no re-parse.
                return { kind: 'fingerprint-only', name, fp };
            }
            // External edit racing an in-flight app write (§4.4a): both versions are
            // observable at this moment, so preserve the external bytes as a
            // conflict copy before the queued app write lands.
            const rowId = rowsByPath.get(name)?.id ?? (0, ids_1.taskIdFromFileName)(name);
            let conflictCopy = false;
            if (prev?.hash !== undefined &&
                prev.hash !== fp.hash &&
                rowId !== null &&
                this.deps.isWritePending?.(rowId, fp.hash) === true) {
                try {
                    await fs_1.promises.writeFile(absPath.replace(/\.md$/, '.conflict.md'), text, 'utf8');
                    conflictCopy = true;
                }
                catch { /* preservation is best-effort; the error row still surfaces it */ }
            }
            const parsed = (0, frontmatter_1.parseTask)(text, { projectId: ref.projectId, repoRoot: ref.repoRoot });
            if (!parsed.ok) {
                // The file on disk is the content source, and it is currently
                // unreadable — a VISIBLE error row replaces the task row rather than
                // showing stale content as live.
                return { kind: 'error', name, fp, reason: parsed.reason, conflictCopy };
            }
            const t = parsed.task;
            const fileId = (0, ids_1.taskIdFromFileName)(name);
            if (!fileId || t.id !== fileId) {
                return {
                    kind: 'error',
                    name,
                    fp,
                    reason: `frontmatter id ${JSON.stringify(t.id)} does not match filename id ${JSON.stringify(fileId)}`,
                    conflictCopy,
                };
            }
            return {
                kind: 'row',
                name,
                fp,
                conflictCopy,
                row: {
                    id: t.id,
                    relPath: name,
                    projectId: ref.projectId,
                    repoRoot: ref.repoRoot,
                    title: t.title,
                    status: t.status,
                    priority: t.priority,
                    // Authority fields are placeholders here and overlaid on read
                    // (`applyAuthority`). Persisting the file's `assignee:` would let an
                    // agent assign itself work with a text editor.
                    assignee: null,
                    labels: t.labels,
                    blockedBy: t.deps.blockedBy,
                    updatedAt: t.updatedAt,
                    // Counts, never text: a card shows `2/5` without the board loading
                    // a single body (§4.4 — the index never holds task bodies).
                    ...(t.acceptanceCriteria.length
                        ? {
                            criteriaTotal: t.acceptanceCriteria.length,
                            criteriaDone: t.acceptanceCriteria.filter((criterion) => criterion.done).length,
                        }
                        : {}),
                    ...(t.ref ? { ref: t.ref } : {}),
                    openGateKind: null,
                    ...(t.mergedInto ? { mergedInto: t.mergedInto } : {}),
                },
            };
        });
        for (const outcome of outcomes) {
            if (outcome.kind === 'skip')
                continue;
            state.files[outcome.name] = outcome.fp;
            if (outcome.kind === 'fingerprint-only')
                continue;
            changed = true;
            if (outcome.conflictCopy) {
                nextErrors.push({ relPath: outcome.name, reason: 'external edit raced an app write — preserved as conflict copy' });
            }
            entry.tasks = entry.tasks.filter((r) => !(r.repoRoot === ref.repoRoot && r.relPath === outcome.name));
            if (outcome.kind === 'error')
                nextErrors.push({ relPath: outcome.name, reason: outcome.reason });
            else
                entry.tasks.push(outcome.row);
        }
        // PRUNE: fingerprints and rows whose file was not seen this pass.
        for (const known of Object.keys(state.files)) {
            if (!seen.has(known)) {
                delete state.files[known];
                entry.tasks = entry.tasks.filter((r) => !(r.repoRoot === ref.repoRoot && r.relPath === known));
                changed = true;
            }
        }
        // Errors for this root are recomputed each pass (files may have healed).
        const otherErrors = entry.errors.filter((e) => !seen.has(e.relPath) && state.files[e.relPath] !== undefined);
        entry.errors = [...otherErrors, ...nextErrors];
        if (nextErrors.length)
            changed = true;
        if (changed)
            await this.persist();
        return changed;
    }
    async rows(scope) {
        const index = await this.load();
        const entries = scope.kind === 'all'
            ? Object.values(index.entries)
            : [index.entries[scope.projectId]].filter((e) => Boolean(e));
        const rows = entries.flatMap((e) => e.tasks);
        return this.applyAuthority(rows);
    }
    /**
     * Overlay app-owned authority onto derived rows. One authority load per read,
     * not one per row — the overlay is on the panel-open path (§9).
     */
    async applyAuthority(rows) {
        const view = await this.deps.authorityView?.();
        if (!view)
            return rows.map((row) => ({ ...row, assignee: null, openGateKind: null }));
        return rows.map((row) => {
            const authority = view.of(row.id);
            const effectiveStatus = authority.status ?? row.status;
            return {
                ...row,
                status: effectiveStatus,
                ...(authority.status && authority.status !== row.status
                    ? { proposedStatus: row.status }
                    : {}),
                assignee: authority.assignee,
                openGateKind: authority.openGateKind,
                ...(authority.holds.length ? { holds: authority.holds } : {}),
            };
        });
    }
    async errors(projectId) {
        const index = await this.load();
        return index.entries[projectId]?.errors ?? [];
    }
    /** Raw file lifecycle values, used only to seed first-seen authority. */
    async fileStatuses(projectId, repoRoot) {
        const index = await this.load();
        return (index.entries[projectId]?.tasks ?? [])
            .filter((row) => row.repoRoot === repoRoot)
            .map((row) => ({ id: row.id, status: row.status }));
    }
    /** Locate a task file by id — the index stores relPath precisely for this. */
    async locate(id) {
        const index = await this.load();
        for (const entry of Object.values(index.entries)) {
            const row = entry.tasks.find((r) => r.id === id);
            if (row) {
                const dir = this.deps.tasksDirFor?.(row.repoRoot) ?? defaultTasksDir(row.repoRoot);
                const [overlaid] = await this.applyAuthority([row]);
                return { row: overlaid, absPath: path.join(dir, row.relPath) };
            }
        }
        return null;
    }
}
exports.TaskIndexer = TaskIndexer;
