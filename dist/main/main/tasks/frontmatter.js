"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contentHash = contentHash;
exports.capBody = capBody;
exports.serializeTask = serializeTask;
exports.parseTask = parseTask;
const crypto_1 = require("crypto");
const yaml_1 = require("yaml");
const tasks_1 = require("../../shared/tasks");
/**
 * Task file serialization (docs/tasks_v2.md §4.2): one Markdown file with YAML
 * frontmatter per task. Frontmatter is authoritative for structured fields;
 * the body is free text. Serialization is deterministic (fixed key order,
 * no line wrapping) so write → read → write is byte-stable — the P0 gate
 * measures that, not asserts it.
 *
 * Authority fields present in frontmatter (`assignee`, `gates`, `runs`,
 * `activity`) are PROJECTIONS (§4.1): the app writes them for the git ledger
 * and never reads authority back out of them.
 */
const FRONTMATTER_OPEN = '---\n';
const FRONTMATTER_CLOSE = '\n---\n';
/** Git conflict markers make YAML unparsable; we detect and refuse to parse
 * around them — the file becomes a visible error row (§4.4). */
const CONFLICT_MARKER = /^(<{7} |={7}$|>{7} )/m;
function contentHash(text) {
    return (0, crypto_1.createHash)('sha256').update(text, 'utf8').digest('hex');
}
/** Cap a body per §4.5b: head + tail with an elision marker, enforced in main
 * on every write path — the renderer-side cap is UX, this is the enforcement. */
function capBody(body, maxBytes = tasks_1.TASK_BODY_MAX_BYTES) {
    const buf = Buffer.from(body, 'utf8');
    if (buf.byteLength <= maxBytes)
        return body;
    const headBytes = Math.floor(maxBytes * 0.7);
    const tailBytes = Math.floor(maxBytes * 0.2);
    const head = buf.subarray(0, headBytes).toString('utf8').replace(/�+$/, '');
    const tail = buf.subarray(buf.byteLength - tailBytes).toString('utf8').replace(/^�+/, '');
    return `${head}\n\n…[elided ${buf.byteLength - headBytes - tailBytes} bytes]…\n\n${tail}`;
}
/** Build the frontmatter object in a FIXED key order — determinism depends on it. */
function frontmatterOf(task) {
    const fm = {
        id: task.id,
        projectId: task.projectId,
        repoRoot: task.repoRoot,
        title: task.title,
        status: task.status,
        priority: task.priority,
        origin: task.origin,
        labels: task.labels,
        assignee: task.assignee,
        acceptanceCriteria: task.acceptanceCriteria,
        definitionOfDone: task.definitionOfDone,
        deps: task.deps,
        ref: task.ref,
        gates: task.gates,
        runs: task.runs,
        activity: task.activity,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        closedAt: task.closedAt,
    };
    if (task.mergedInto)
        fm.mergedInto = task.mergedInto;
    if (task.plan !== null)
        fm.plan = task.plan;
    return fm;
}
function serializeTask(task) {
    const yaml = (0, yaml_1.stringify)(frontmatterOf(task), {
        lineWidth: 0, // no wrapping — wrapped strings are not byte-stable
        defaultKeyType: 'PLAIN',
        defaultStringType: 'QUOTE_DOUBLE',
    });
    const body = task.body.length ? `\n${task.body}\n` : '';
    return `${FRONTMATTER_OPEN}${yaml}${FRONTMATTER_CLOSE}\n# ${task.title}\n${body}`;
}
function parseTask(text, fallback) {
    if (CONFLICT_MARKER.test(text)) {
        return { ok: false, reason: 'git conflict markers present — resolve the conflict first' };
    }
    if (!text.startsWith(FRONTMATTER_OPEN)) {
        return { ok: false, reason: 'missing frontmatter' };
    }
    const close = text.indexOf(FRONTMATTER_CLOSE, FRONTMATTER_OPEN.length);
    if (close === -1)
        return { ok: false, reason: 'unterminated frontmatter' };
    let fm;
    try {
        const parsed = (0, yaml_1.parse)(text.slice(FRONTMATTER_OPEN.length, close));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { ok: false, reason: 'frontmatter is not a mapping' };
        }
        fm = parsed;
    }
    catch (err) {
        return { ok: false, reason: `frontmatter YAML: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (typeof fm.id !== 'string' || typeof fm.title !== 'string') {
        return { ok: false, reason: 'frontmatter missing id or title' };
    }
    // Body: everything after the close fence, minus the rendered `# title` line.
    let body = text.slice(close + FRONTMATTER_CLOSE.length);
    body = body.replace(/^\n?# [^\n]*\n?/, '').replace(/^\n/, '').replace(/\n$/, '');
    const str = (v, dflt) => (typeof v === 'string' ? v : dflt);
    const arr = (v) => (Array.isArray(v) ? v : []);
    const num = (v, dflt) => (typeof v === 'number' ? v : dflt);
    const depsRaw = (fm.deps ?? {});
    const task = {
        id: fm.id,
        projectId: str(fm.projectId, fallback.projectId),
        repoRoot: str(fm.repoRoot, fallback.repoRoot),
        title: fm.title,
        body,
        status: str(fm.status, 'backlog'),
        priority: str(fm.priority, 'p2'),
        origin: str(fm.origin, 'manual'),
        labels: arr(fm.labels),
        assignee: fm.assignee ?? null,
        acceptanceCriteria: arr(fm.acceptanceCriteria),
        definitionOfDone: arr(fm.definitionOfDone),
        plan: typeof fm.plan === 'string' ? fm.plan : null,
        deps: {
            blockedBy: arr(depsRaw.blockedBy),
            parent: typeof depsRaw.parent === 'string' ? depsRaw.parent : null,
            relatesTo: arr(depsRaw.relatesTo),
        },
        ref: fm.ref ?? null,
        gates: arr(fm.gates),
        runs: arr(fm.runs),
        activity: arr(fm.activity),
        ...(typeof fm.mergedInto === 'string' ? { mergedInto: fm.mergedInto } : {}),
        createdAt: num(fm.createdAt, 0),
        updatedAt: num(fm.updatedAt, 0),
        closedAt: typeof fm.closedAt === 'number' ? fm.closedAt : null,
    };
    return { ok: true, task, hash: contentHash(text) };
}
