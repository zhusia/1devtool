"use strict";
/**
 * Terminal skill invocation contract.
 *
 * Read docs/common-errors/terminals/INDEX.md rule B15 before changing this
 * file. Codex explicitly invokes skills with `$name`; `/name` is reserved for
 * slash commands. Kimi Code namespaces discovered skills as `/skill:<name>`;
 * other supported interactive agents keep their plain slash-skill syntax.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAgentSkillInvocationPrefix = getAgentSkillInvocationPrefix;
exports.formatAgentInvocation = formatAgentInvocation;
exports.formatAgentSkillInvocation = formatAgentSkillInvocation;
function getAgentSkillInvocationPrefix(agentKind) {
    if (agentKind === 'codex')
        return '$';
    if (agentKind === 'kimi')
        return '/skill:';
    return '/';
}
function formatAgentInvocation(name, prefix) {
    return `${prefix}${name.trim().replace(/^[$/]/, '')} `;
}
function formatAgentSkillInvocation(skillName, agentKind) {
    return formatAgentInvocation(skillName, getAgentSkillInvocationPrefix(agentKind));
}
