"use strict";
/**
 * Orchestration setup presets — named, user-saved snapshots of the three
 * Set-up surfaces (Router table, Hierarchy org chart, Pipeline stage list).
 *
 * Presets are a LIBRARY, not a second live slot: loading one writes it into
 * the same single draft the dashboard already owns (`draft.hierarchy` for
 * charts, the routing fields of the policy draft for routing), so every v5/v6
 * validation, hash, apply, and activation invariant is unchanged. Stored in
 * `preferences.orchestrationSetups` (global, same discipline as
 * `startupCommands.terminalSets` — project and seats are chosen at apply
 * time).
 *
 * PURE module: imported as values by the renderer (preset UI) and by main
 * (preferences normalization) — no node:fs / Electron / Buffer.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_ORCHESTRATION_SETUP_PRESETS = exports.SETUP_PRESET_NAME_MAX_CHARS = exports.ORCHESTRATION_SETUP_KINDS = void 0;
exports.normalizeOrchestrationSetupPreset = normalizeOrchestrationSetupPreset;
exports.normalizeOrchestrationSetupPresets = normalizeOrchestrationSetupPresets;
exports.setupPresetsOfKind = setupPresetsOfKind;
exports.describeSetupPreset = describeSetupPreset;
const orchestrationPolicy_1 = require("../orchestrationPolicy");
const hierarchy_1 = require("./hierarchy");
const pipeline_1 = require("./pipeline");
exports.ORCHESTRATION_SETUP_KINDS = [
    'routing',
    'hierarchy',
    'pipeline',
];
exports.SETUP_PRESET_NAME_MAX_CHARS = 40;
exports.MAX_ORCHESTRATION_SETUP_PRESETS = 50;
function normalizeRoutingSnapshot(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    // Clamps every field through the single §4.1 source of truth; a preset with
    // out-of-bound text degrades to the clamped form instead of being dropped,
    // because main re-validates again on apply (`set-policy`).
    const { normalized } = (0, orchestrationPolicy_1.normalizePolicyDraft)(raw);
    return {
        assignments: normalized.assignments,
        customCategories: normalized.customCategories,
        mode: normalized.mode,
        defaultSubstrate: normalized.defaultSubstrate,
        ...(normalized.customInstructions ? { customInstructions: normalized.customInstructions } : {}),
    };
}
/** One preset. Returns null when the payload cannot round-trip safely. */
function normalizeOrchestrationSetupPreset(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const src = raw;
    if (typeof src.id !== 'string' || !src.id.trim() || src.id.length > 64)
        return null;
    const kind = src.kind;
    if (kind !== 'routing' && kind !== 'hierarchy' && kind !== 'pipeline')
        return null;
    const name = (0, orchestrationPolicy_1.sanitizeRoutingText)(typeof src.name === 'string' ? src.name : '', exports.SETUP_PRESET_NAME_MAX_CHARS);
    if (!name)
        return null;
    const createdAt = typeof src.createdAt === 'number' && Number.isFinite(src.createdAt)
        ? src.createdAt
        : 0;
    const updatedAt = typeof src.updatedAt === 'number' && Number.isFinite(src.updatedAt)
        ? src.updatedAt
        : undefined;
    const base = {
        id: src.id,
        name,
        kind,
        createdAt,
        ...(updatedAt !== undefined ? { updatedAt } : {}),
    };
    if (kind === 'routing') {
        const routing = normalizeRoutingSnapshot(src.routing);
        if (!routing)
            return null;
        return { ...base, routing };
    }
    const { normalized, errors } = (0, hierarchy_1.normalizeHierarchyChart)(src.chart);
    if (errors.length > 0)
        return null;
    // An empty chart "preset" would only delete the draft when loaded — the
    // validator tolerates shapeless input by returning an empty chart, so
    // require real structure here.
    if (normalized.nodes.length === 0)
        return null;
    // A pipeline preset must stay a pipeline (and vice versa) or loading it
    // into the single chart slot would silently flip the topology's guard
    // semantics (v6 D2).
    if (kind === 'pipeline' ? !(0, pipeline_1.isPipelineChart)(normalized) : (0, pipeline_1.isPipelineChart)(normalized))
        return null;
    const startupPresetIds = {};
    const rawBindings = src.startupPresetIds;
    if (rawBindings && typeof rawBindings === 'object' && !Array.isArray(rawBindings)) {
        const nodeIds = new Set(normalized.nodes.map((node) => node.nodeId));
        for (const [nodeId, presetId] of Object.entries(rawBindings)) {
            if (!nodeIds.has(nodeId))
                continue;
            if (typeof presetId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(presetId))
                continue;
            startupPresetIds[nodeId] = presetId;
        }
    }
    return {
        ...base,
        chart: normalized,
        ...(Object.keys(startupPresetIds).length > 0 ? { startupPresetIds } : {}),
    };
}
/** The whole stored list: invalid rows dropped, ids deduped, list capped. */
function normalizeOrchestrationSetupPresets(raw) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    const seen = new Set();
    for (const row of raw) {
        const preset = normalizeOrchestrationSetupPreset(row);
        if (!preset || seen.has(preset.id))
            continue;
        seen.add(preset.id);
        out.push(preset);
        if (out.length >= exports.MAX_ORCHESTRATION_SETUP_PRESETS)
            break;
    }
    return out;
}
function setupPresetsOfKind(presets, kind) {
    return (presets ?? []).filter((preset) => preset.kind === kind);
}
const SUMMARY_MAX_ENTRIES = 3;
/** One line for chips/rows: what applying this preset would set up. */
function describeSetupPreset(preset) {
    if (preset.kind === 'routing' && preset.routing) {
        const parts = [];
        for (const [category, assignment] of Object.entries(preset.routing.assignments)) {
            if (!assignment || assignment.enabled === false)
                continue;
            parts.push(`${category} → ${assignment.agent}`);
        }
        for (const custom of preset.routing.customCategories) {
            if (custom.enabled === false)
                continue;
            parts.push(`${custom.label} → ${custom.agent}`);
        }
        if (parts.length === 0)
            return 'No roles routed';
        const shown = parts.slice(0, SUMMARY_MAX_ENTRIES).join(' · ');
        return parts.length > SUMMARY_MAX_ENTRIES
            ? `${shown} · +${parts.length - SUMMARY_MAX_ENTRIES} more`
            : shown;
    }
    const chart = preset.chart;
    if (!chart)
        return '';
    if (preset.kind === 'pipeline') {
        const stages = (0, pipeline_1.pipelineStages)(chart);
        return stages.map((stage) => `${stage.label} (${stage.selector.agentKind})`).join(' → ');
    }
    const kinds = [...new Set(chart.nodes.map((node) => node.selector.agentKind))];
    return `${chart.nodes.length} seat${chart.nodes.length === 1 ? '' : 's'}: ${kinds.join(', ')}`;
}
