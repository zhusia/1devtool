"use strict";
/**
 * Resolve a hierarchy/pipeline seat's saved startup-command binding.
 *
 * The renderer sends only a preset id. Main looks up the current preference,
 * verifies that the user marked it as an AI command and that its executable
 * still matches the chart selector, then returns the trusted launch spec.
 * Raw commands never cross this IPC boundary from the caller.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveHierarchyStartupPreset = resolveHierarchyStartupPreset;
const agentIdentity_1 = require("../../shared/agentIdentity");
const types_1 = require("../../shared/types");
function resolveHierarchyStartupPreset(presets, presetId, target) {
    const preset = presets.find((item) => item.id === presetId);
    if (!preset)
        return { ok: false, error: 'that startup command no longer exists' };
    if (!preset.isAiAgent) {
        return { ok: false, error: `"${preset.name}" is not an AI startup command` };
    }
    const presetAgent = (0, agentIdentity_1.normalizeAgentId)((0, agentIdentity_1.resolveAgentIdFromCommand)(preset.command));
    const expectedAgent = (0, agentIdentity_1.normalizeAgentId)(target);
    if (!presetAgent || presetAgent !== expectedAgent) {
        return {
            ok: false,
            error: `"${preset.name}" launches ${presetAgent || 'an unknown agent'}, not ${expectedAgent || target}`,
        };
    }
    const agentType = Object.prototype.hasOwnProperty.call(types_1.AGENT_CONFIG, presetAgent)
        ? presetAgent
        : 'custom';
    return {
        ok: true,
        launch: {
            agentType,
            name: preset.name.trim() || types_1.AGENT_CONFIG[agentType].name,
            command: preset.command,
            forceAiAgent: true,
        },
    };
}
