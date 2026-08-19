"use strict";
/**
 * Orchestration routing policy — the user-configured mapping of task
 * categories (`plan`, `test`, `browser`, …) to delegate agents/models that the
 * Orchestration Dashboard edits and `skillContent.ts` compiles into every
 * installed 1devtool-orchestrator SKILL.md.
 *
 * Draft-vs-applied split (docs/features/orchestration/dashboard.md §4.1): dashboard
 * edits mutate `draft` only; Apply promotes it to `applied` after the shim
 * install succeeds. Boot installs compile `applied` — an unapplied edit can
 * never leak into skill files via an app restart.
 *
 * Schema bounds are ENFORCED IN MAIN on `orchestration:set-policy` (single
 * source of truth); the renderer only mirrors them for inline feedback.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROUTING_MODES = exports.CUSTOM_INSTRUCTIONS_MAX_BYTES = exports.ROUTING_SECTION_MAX_BYTES = exports.ROUTING_LABEL_MAX_CHARS = exports.ROUTING_NOTES_MAX_CHARS = exports.CUSTOM_CATEGORY_ID_RE = exports.MAX_CUSTOM_CATEGORIES = exports.INTRINSIC_TERMINAL_SKILLS = exports.ORCHESTRATION_SKILL_COMMAND_RE = exports.ORCHESTRATION_SUBSTRATES = exports.ROUTED_TASK_FAILURE_RULE = exports.ROUTED_TASK_OWNERSHIP_RULE = exports.ROUTING_CATEGORIES = void 0;
exports.utf8ByteLength = utf8ByteLength;
exports.sanitizeRoutingText = sanitizeRoutingText;
exports.sanitizeCustomInstructions = sanitizeCustomInstructions;
exports.emptyPolicyDraft = emptyPolicyDraft;
exports.defaultOrchestrationPolicyState = defaultOrchestrationPolicyState;
exports.normalizePolicyDraft = normalizePolicyDraft;
exports.normalizeOrchestrationPolicyState = normalizeOrchestrationPolicyState;
exports.enabledRoutingRows = enabledRoutingRows;
exports.resolveRoutingSubstrate = resolveRoutingSubstrate;
exports.hasActiveRouting = hasActiveRouting;
exports.canonicalPolicyHash = canonicalPolicyHash;
// IMPORTANT: this module is imported as VALUES by the renderer (drift hash,
// bounds mirrors) — keep every import pure (no node:fs / Buffer / Electron).
const headlessMode_1 = require("./headlessMode");
const agentModels_1 = require("./agentModels");
const orchestrationCategory_1 = require("./orchestrationCategory");
// Function-level cycle with ./orchestration/hierarchy (it imports
// sanitizeRoutingText); safe — neither module calls the other at eval time.
const hierarchy_1 = require("./orchestration/hierarchy");
/** UTF-8 byte length without Buffer (renderer-safe). */
function utf8ByteLength(text) {
    return new TextEncoder().encode(text).length;
}
exports.ROUTING_CATEGORIES = [
    'plan', 'implement', 'test', 'review', 'browser', 'docs', 'research', 'debug',
];
/** Shared wording emitted by both the installed skill and Agent Input nudge.
 *  Keep this contract byte-identical across both surfaces: host models may
 *  have either source freshest in context when a routed delegate fails. */
exports.ROUTED_TASK_OWNERSHIP_RULE = 'Routing does not begin until the user authorizes delegation. Once authorized, enabled assignments ' +
    'are exclusive task ownership, not soft preferences. A host that is not the assigned agent must not ' +
    'perform that part with its own tools or send it to another agent.';
exports.ROUTED_TASK_FAILURE_RULE = 'Routing remains binding after delegation. If the assigned agent is unavailable or cannot complete ' +
    'its assigned part for any reason—including a missing agent, a failed or timed-out call, refusal, ' +
    'an incomplete result, or a report that a required tool or capability is unavailable—do not reclaim ' +
    'that part, use your own tools, or silently reroute it, even if you have the needed capability. Stop ' +
    'and ask the user how to proceed unless the user already explicitly authorized fallback for that part.';
exports.ORCHESTRATION_SUBSTRATES = ['auto', 'headless', 'terminal'];
/** Slash-skill commands are data passed to an interactive agent, never shell
 * input. User-created skill slugs may begin with a digit (for example,
 * `1devtool-orchestrator`), so keep the canonical transport grammar aligned
 * with the skill inventory rather than limiting it to built-in names.
 * Keeping the validation here lets policy normalization enforce the
 * capability gate without importing main/renderer code. */
exports.ORCHESTRATION_SKILL_COMMAND_RE = /^\/[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/;
/** Categories whose capability contract always requires a real terminal. */
exports.INTRINSIC_TERMINAL_SKILLS = {
    browser: '/chrome',
};
// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------
exports.MAX_CUSTOM_CATEGORIES = 8;
exports.CUSTOM_CATEGORY_ID_RE = orchestrationCategory_1.ORCHESTRATION_CATEGORY_RE;
exports.ROUTING_NOTES_MAX_CHARS = 120;
exports.ROUTING_LABEL_MAX_CHARS = 40;
/** Compiled routing section hard cap, measured in UTF-8 bytes (§4.1).
 *  Sized so a full policy (8 built-ins + 8 customs with modest notes,
 *  ~6.1 KB) fits under the fixed ~2.4 KB preamble/rules overhead, while a
 *  field-maxed policy (~8.4 KB) still exceeds it — the bound must stay
 *  reachable or it is dead code. */
exports.ROUTING_SECTION_MAX_BYTES = 8 * 1024;
/** Custom-instructions block cap, measured in UTF-8 bytes (§6.5). */
exports.CUSTOM_INSTRUCTIONS_MAX_BYTES = 2 * 1024;
exports.ROUTING_MODES = ['on-generic-delegate', 'suggest'];
// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------
/** Notes/labels land inside a markdown table row: strip newlines, `|`, and
 *  control chars; collapse whitespace; cap length. */
function sanitizeRoutingText(text, maxChars) {
    return text
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001F\u007F|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxChars)
        .trim();
}
/** Custom instructions allow markdown but must not be able to break the
 *  generated document structure: strip HTML comments (so the
 *  `<!-- 1devtool:custom -->` markers can't be forged/terminated) and `---`
 *  frontmatter fences at line starts; cap at 2 KB UTF-8. */
function sanitizeCustomInstructions(text) {
    let out = text
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<!--/g, '')
        .replace(/-->/g, '')
        .split('\n')
        .map((line) => (/^\s*---+\s*$/.test(line) ? '' : line))
        .join('\n')
        .replace(/\r/g, '')
        .trim();
    // Enforce the byte cap without splitting a multi-byte char.
    while (utf8ByteLength(out) > exports.CUSTOM_INSTRUCTIONS_MAX_BYTES) {
        out = out.slice(0, -1);
    }
    return out.trim();
}
// ---------------------------------------------------------------------------
// Defaults / normalization / validation
// ---------------------------------------------------------------------------
function emptyPolicyDraft() {
    return {
        assignments: {},
        customCategories: [],
        mode: 'on-generic-delegate',
        defaultSubstrate: 'auto',
        updatedAt: 0,
    };
}
function defaultOrchestrationPolicyState() {
    return { draft: emptyPolicyDraft(), applied: null };
}
function normalizeAssignment(raw, where, errors, categoryId) {
    if (!raw || typeof raw !== 'object')
        return null;
    const a = raw;
    if (typeof a.agent !== 'string' || !a.agent)
        return null;
    if (!Object.keys(headlessMode_1.HEADLESS_SPECS).includes(a.agent)) {
        errors.push(`${where}: unknown agent "${a.agent}"`);
        return null;
    }
    const out = {
        agent: a.agent,
        enabled: a.enabled === true,
    };
    if (typeof a.model === 'string' && a.model.trim()) {
        const model = a.model.trim();
        if (!agentModels_1.AGENT_MODEL_SPECS[a.agent]) {
            // A model the CLI would reject must not be storable (§4.1).
            errors.push(`${where}: agent "${a.agent}" does not support a model — clear the model field`);
        }
        else if (!(0, agentModels_1.isValidModelId)(model)) {
            errors.push(`${where}: "${model}" is not a valid model id`);
        }
        else {
            out.model = model;
        }
    }
    if (typeof a.notes === 'string') {
        const notes = sanitizeRoutingText(a.notes, exports.ROUTING_NOTES_MAX_CHARS);
        if (notes)
            out.notes = notes;
    }
    if (a.substrate !== undefined) {
        if (!exports.ORCHESTRATION_SUBSTRATES.includes(a.substrate)) {
            errors.push(`${where}: substrate must be auto, headless, or terminal`);
        }
        else {
            out.substrate = a.substrate;
        }
    }
    if (typeof a.skill === 'string' && a.skill.trim()) {
        const skill = a.skill.trim();
        if (!exports.ORCHESTRATION_SKILL_COMMAND_RE.test(skill)) {
            errors.push(`${where}: skill must be a slash command such as /chrome`);
        }
        else if (out.substrate !== 'terminal') {
            errors.push(`${where}: a skill requires substrate "terminal"`);
        }
        else {
            out.skill = skill;
        }
    }
    const intrinsicSkill = categoryId ? exports.INTRINSIC_TERMINAL_SKILLS[categoryId] : undefined;
    if (intrinsicSkill && out.substrate === 'headless') {
        errors.push(`${where}: ${categoryId} requires ${intrinsicSkill} in a real terminal`);
    }
    return out;
}
/**
 * Normalize + validate a policy draft coming over IPC (or from disk). Every
 * bound from §4.1 is enforced here — this is the single source of truth.
 * Errors are collected, not thrown; callers reject the save when non-empty.
 */
function normalizePolicyDraft(raw) {
    const errors = [];
    const src = (raw && typeof raw === 'object' ? raw : {});
    const assignments = {};
    const srcAssignments = (src.assignments && typeof src.assignments === 'object' ? src.assignments : {});
    for (const category of exports.ROUTING_CATEGORIES) {
        const normalized = normalizeAssignment(srcAssignments[category], `category "${category}"`, errors, category);
        if (normalized)
            assignments[category] = normalized;
    }
    const customCategories = [];
    const seenIds = new Set(exports.ROUTING_CATEGORIES);
    const srcCustoms = Array.isArray(src.customCategories) ? src.customCategories : [];
    if (srcCustoms.length > exports.MAX_CUSTOM_CATEGORIES) {
        errors.push(`too many custom categories (max ${exports.MAX_CUSTOM_CATEGORIES})`);
    }
    for (const rawCustom of srcCustoms.slice(0, exports.MAX_CUSTOM_CATEGORIES)) {
        if (!rawCustom || typeof rawCustom !== 'object')
            continue;
        const c = rawCustom;
        const id = typeof c.id === 'string' ? c.id : '';
        if (!exports.CUSTOM_CATEGORY_ID_RE.test(id)) {
            errors.push(`custom category id "${id}" must match ^[a-z][a-z0-9-]{1,23}$`);
            continue;
        }
        if (seenIds.has(id)) {
            errors.push(`custom category id "${id}" duplicates an existing category`);
            continue;
        }
        const assignment = normalizeAssignment(c, `custom category "${id}"`, errors, id);
        if (!assignment)
            continue;
        seenIds.add(id);
        const label = sanitizeRoutingText(typeof c.label === 'string' ? c.label : '', exports.ROUTING_LABEL_MAX_CHARS);
        customCategories.push({ id, label: label || id, ...assignment });
    }
    const mode = exports.ROUTING_MODES.includes(src.mode)
        ? src.mode
        : 'on-generic-delegate';
    const defaultSubstrate = exports.ORCHESTRATION_SUBSTRATES.includes(src.defaultSubstrate)
        ? src.defaultSubstrate
        : 'auto';
    const customInstructions = typeof src.customInstructions === 'string'
        ? sanitizeCustomInstructions(src.customInstructions)
        : '';
    // Hierarchy chart (v5): validated by its own module; an empty chart means
    // "no hierarchy" and is stored as absence so legacy policies hash unchanged.
    let hierarchy;
    if (src.hierarchy !== undefined && src.hierarchy !== null) {
        const chart = (0, hierarchy_1.normalizeHierarchyChart)(src.hierarchy);
        errors.push(...chart.errors.map((entry) => `hierarchy: ${entry}`));
        if (chart.normalized.nodes.length > 0)
            hierarchy = chart.normalized;
    }
    const normalized = {
        assignments,
        customCategories,
        mode,
        defaultSubstrate,
        ...(customInstructions ? { customInstructions } : {}),
        ...(hierarchy ? { hierarchy } : {}),
        updatedAt: typeof src.updatedAt === 'number' && Number.isFinite(src.updatedAt) ? src.updatedAt : 0,
    };
    return { normalized, errors };
}
/** Tolerant whole-state normalization for Preferences hydration — never
 *  errors; invalid pieces are dropped. */
function normalizeOrchestrationPolicyState(raw) {
    const src = (raw && typeof raw === 'object' ? raw : {});
    const draft = normalizePolicyDraft(src.draft).normalized;
    const applied = src.applied ? normalizePolicyDraft(src.applied).normalized : null;
    const lastInstallResults = Array.isArray(src.lastInstallResults)
        ? src.lastInstallResults.filter((r) => !!r && typeof r === 'object' &&
            typeof r.target === 'string' &&
            typeof r.status === 'string' &&
            typeof r.at === 'number')
        : undefined;
    return {
        draft,
        applied,
        ...(typeof src.appliedAt === 'number' ? { appliedAt: src.appliedAt } : {}),
        ...(typeof src.appliedPolicyHash === 'string' ? { appliedPolicyHash: src.appliedPolicyHash } : {}),
        ...(lastInstallResults && lastInstallResults.length > 0 ? { lastInstallResults } : {}),
    };
}
// ---------------------------------------------------------------------------
// Canonical hash
// ---------------------------------------------------------------------------
/** Rows that actually route (enabled, valid agent). */
function enabledRoutingRows(policy) {
    const rows = [];
    for (const category of exports.ROUTING_CATEGORIES) {
        const a = policy.assignments[category];
        if (a?.enabled && a.agent) {
            rows.push({
                id: category,
                label: category,
                agent: a.agent,
                model: a.model,
                notes: a.notes,
                substrate: resolveRoutingSubstrate(category, a, policy.defaultSubstrate),
                skill: a.skill ?? exports.INTRINSIC_TERMINAL_SKILLS[category],
            });
        }
    }
    for (const custom of policy.customCategories) {
        if (custom.enabled && custom.agent) {
            rows.push({
                id: custom.id,
                label: custom.label || custom.id,
                agent: custom.agent,
                model: custom.model,
                notes: custom.notes,
                substrate: resolveRoutingSubstrate(custom.id, custom, policy.defaultSubstrate),
                skill: custom.skill ?? exports.INTRINSIC_TERMINAL_SKILLS[custom.id],
            });
        }
    }
    return rows;
}
/** Capability gate first, preference second (§3.10). Intrinsic/configured
 * skills can never be downgraded by a global or per-row preference. */
function resolveRoutingSubstrate(categoryId, assignment, defaultSubstrate = 'auto') {
    if (assignment.skill || exports.INTRINSIC_TERMINAL_SKILLS[categoryId])
        return 'terminal';
    return assignment.substrate ?? defaultSubstrate;
}
function hasActiveRouting(policy) {
    return !!policy && enabledRoutingRows(policy).length > 0;
}
/**
 * Hash of the policy's SEMANTIC projection only: `mode`, sorted built-in
 * category keys with `{agent, model, notes, enabled}`, `customCategories`
 * including `{id, label}` sorted by id, and `customInstructions` — excluding
 * `updatedAt`/applied metadata (a label edit produces drift, a timestamp
 * doesn't). Deliberately NOT skillContentHash: skill files are per-target, so
 * a single content hash cannot represent "the applied policy" (§4.1).
 */
function canonicalPolicyHash(policy) {
    const hierarchy = (0, hierarchy_1.canonicalHierarchyProjection)(policy.hierarchy);
    const projection = {
        mode: policy.mode,
        defaultSubstrate: policy.defaultSubstrate,
        assignments: exports.ROUTING_CATEGORIES
            .filter((c) => policy.assignments[c])
            .map((c) => {
            const a = policy.assignments[c];
            return [c, a.agent, a.model ?? '', a.notes ?? '', a.substrate ?? '', a.skill ?? '', a.enabled];
        }),
        customCategories: [...policy.customCategories]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((c) => [c.id, c.label, c.agent, c.model ?? '', c.notes ?? '', c.substrate ?? '', c.skill ?? '', c.enabled]),
        customInstructions: policy.customInstructions ?? '',
        // Only when configured — a chart-less policy must hash exactly as it did
        // before v5, or every existing install reports skill drift on update.
        ...(hierarchy ? { hierarchy } : {}),
    };
    return fnv1a64(JSON.stringify(projection));
}
/** FNV-1a 64-bit (same scheme as skillContentHash — collision-safe enough
 *  for drift detection). */
function fnv1a64(input) {
    let h = BigInt('14695981039346656037');
    const prime = BigInt('1099511628211');
    const mask = (BigInt(1) << BigInt(64)) - BigInt(1);
    for (let i = 0; i < input.length; i++) {
        h ^= BigInt(input.charCodeAt(i) & 0xffff);
        h = (h * prime) & mask;
    }
    return h.toString(16).padStart(16, '0');
}
