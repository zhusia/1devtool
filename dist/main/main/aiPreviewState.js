"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dynamicAiTerminals = void 0;
exports.resolveEffectivePreviewAgentType = resolveEffectivePreviewAgentType;
const contracts_1 = require("../shared/terminal/contracts");
// Sniffer- or input-detection-promoted terminals: started as bash/custom but
// running an AI agent (e.g. user typed `claude` at the shell prompt).
// Lifted out of index.ts so notification + dashboard preview resolvers can
// see it without depending on index.ts directly.
exports.dynamicAiTerminals = new Map();
/**
 * Resolve the AgentType that `PtyManager.getBufferPreview` should use for AI
 * chrome stripping. Returns `undefined` for non-AI terminals.
 *
 * Returning an AI `AgentType` (claude/codex/...) enables the prompt-box border
 * and footer-chrome filters in `getBufferPreview`. This covers three sources
 * of "this terminal is actually running an AI agent":
 *   1. Declared agentType (`'claude'`, `'codex'`, ...).
 *   2. Sniffer/input-side promotion when the user runs `claude` etc. inside
 *      a bash/custom terminal.
 *   3. `forceAiAgent` or a startup command that launches an AI executable.
 *
 * For sniffer kinds that aren't first-class `AgentType` values (`aider`),
 * we fall back to `'claude'` so the generic prompt-box /
 * separator chrome patterns still fire.
 */
function resolveEffectivePreviewAgentType(terminalId, agentType, startupCommand, forceAi) {
    // Keep labels/chrome stripping aligned with the shared runtime contract.
    // A known startup executable must beat stale preset metadata (for example,
    // agentType=claude while the pane actually runs cursor-agent).
    const declaredAgentType = (0, contracts_1.mapToResumeAgentType)(agentType, startupCommand);
    if (declaredAgentType)
        return declaredAgentType;
    if (agentType && (0, contracts_1.isInteractiveAgentType)(agentType))
        return agentType;
    const dynamic = exports.dynamicAiTerminals.get(terminalId);
    if (dynamic)
        return mapDynamicKindToAgentType(dynamic);
    if ((0, contracts_1.isInteractiveAgentTerminal)(agentType, startupCommand, forceAi))
        return 'claude';
    return undefined;
}
function mapDynamicKindToAgentType(kind) {
    if (kind === 'claude' || kind === 'codex' || kind === 'gemini' || kind === 'kimi' || kind === 'qwen' || kind === 'grok' || kind === 'hermes' || kind === 'cursor' || kind === 'pi') {
        return kind;
    }
    return 'claude';
}
