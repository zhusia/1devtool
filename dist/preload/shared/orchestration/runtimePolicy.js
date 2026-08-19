"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AGENT_RUNTIME_PREFERENCES = void 0;
exports.normalizeRuntimePreference = normalizeRuntimePreference;
exports.capabilityRejectionReason = capabilityRejectionReason;
exports.resolveRuntimeCandidate = resolveRuntimeCandidate;
exports.AGENT_RUNTIME_PREFERENCES = [
    'auto', 'structured', 'headless', 'native-terminal',
];
function normalizeRuntimePreference(value, legacySubstrate) {
    if (exports.AGENT_RUNTIME_PREFERENCES.includes(value))
        return value;
    if (legacySubstrate === 'headless')
        return 'headless';
    if (legacySubstrate === 'terminal')
        return 'native-terminal';
    return 'auto';
}
function transportMatchesPreference(transport, preference) {
    if (preference === 'auto')
        return true;
    if (preference === 'native-terminal')
        return transport === 'pty';
    if (preference === 'headless')
        return transport === 'structured-cli' || transport === 'plain-cli';
    return transport === 'app-server' || transport === 'acp' || transport === 'sdk';
}
function capabilityRejectionReason(capabilities, requirements) {
    if (requirements.nativeSkill && capabilities.transport !== 'pty')
        return 'requires a native terminal skill';
    if (requirements.nativeTui && !capabilities.nativeTui)
        return 'requires the native TUI';
    if (requirements.browserTools && capabilities.dynamicTools === 'none')
        return 'does not provide browser-capable dynamic tools';
    if (requirements.images && !capabilities.images)
        return 'does not accept images';
    if (requirements.approvals && capabilities.approvals === 'none')
        return 'has no attributed approval channel';
    if (requirements.resume && capabilities.resume === 'none')
        return 'cannot resume a native session';
    if (requirements.dynamicTools && capabilities.dynamicTools === 'none')
        return 'cannot receive 1DevTool tools';
    return null;
}
function effectiveCapabilities(candidate) {
    return { ...candidate.declared, ...(candidate.probeState === 'verified' ? candidate.verified : {}) };
}
function automaticRank(candidate) {
    const transportRank = {
        'app-server': 0,
        acp: 1,
        sdk: 2,
        'structured-cli': 3,
        'plain-cli': 4,
        pty: 5,
    };
    return (candidate.priority ?? 0) * 10 + transportRank[candidate.declared.transport];
}
/** Resolve a runtime without upgrading unknown probes into stronger claims. */
function resolveRuntimeCandidate(candidates, preference, requirements = {}) {
    const rejected = [];
    const accepted = [];
    for (const candidate of candidates) {
        if (!candidate.available) {
            rejected.push({ harnessId: candidate.harnessId, reason: 'adapter or binary is unavailable' });
            continue;
        }
        if (!transportMatchesPreference(candidate.declared.transport, preference)) {
            rejected.push({ harnessId: candidate.harnessId, reason: `does not match ${preference} preference` });
            continue;
        }
        if (candidate.probeState === 'failed') {
            rejected.push({ harnessId: candidate.harnessId, reason: 'live capability probe failed' });
            continue;
        }
        const effective = effectiveCapabilities(candidate);
        const reason = capabilityRejectionReason(effective, requirements);
        if (reason) {
            rejected.push({ harnessId: candidate.harnessId, reason });
            continue;
        }
        // Unknown probes may use compatibility transports, but never satisfy a
        // safety-sensitive claim that exists only in the declaration.
        if (candidate.probeState === 'unknown' && (requirements.browserTools || requirements.approvals || requirements.resume || requirements.dynamicTools)) {
            rejected.push({ harnessId: candidate.harnessId, reason: 'required capability has not been verified locally' });
            continue;
        }
        accepted.push(candidate);
    }
    accepted.sort((a, b) => automaticRank(a) - automaticRank(b));
    return accepted[0]
        ? { selected: accepted[0], rejected }
        : { rejected, error: `No safe ${preference} runtime satisfies the requested capabilities` };
}
