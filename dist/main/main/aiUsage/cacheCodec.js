"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.USAGE_CACHE_SCHEMA_VERSION = void 0;
exports.encodeUsageCache = encodeUsageCache;
exports.decodeUsageCache = decodeUsageCache;
exports.USAGE_CACHE_SCHEMA_VERSION = 2;
/**
 * Losslessly dictionary-encode repeated record fields per source file. A Claude
 * transcript commonly repeats the same agent/session/project/model hundreds of
 * times, so keeping full object keys and values on every record wastes most of
 * the persisted cache.
 */
function encodeUsageCache(files, pricingVersion) {
    return {
        v: exports.USAGE_CACHE_SCHEMA_VERSION,
        p: pricingVersion,
        f: files.map(encodeParsedFile),
    };
}
/** Decode both the compact format and the legacy object-heavy V1 cache. */
function decodeUsageCache(value) {
    if (!isRecord(value))
        return null;
    if (value.v === exports.USAGE_CACHE_SCHEMA_VERSION && Array.isArray(value.f)) {
        const files = [];
        let requiresRewrite = false;
        for (const entry of value.f) {
            const decoded = decodeCompactFile(entry);
            if (decoded)
                files.push(decoded);
            else
                requiresRewrite = true;
        }
        return { files, requiresRewrite };
    }
    if (value.schemaVersion === 1 && Array.isArray(value.files)) {
        const files = value.files.filter(isParsedFile);
        return {
            files,
            // Reading V1 is intentionally supported for a no-reparse migration, but
            // the next advisory save should replace it with V2.
            requiresRewrite: true,
        };
    }
    return null;
}
function encodeParsedFile(file) {
    const agents = [];
    const sessions = [];
    const projects = [];
    const models = [];
    const agentIndexes = new Map();
    const sessionIndexes = new Map();
    const projectIndexes = new Map();
    const modelIndexes = new Map();
    const records = file.records.map((record) => [
        intern(agents, agentIndexes, record.agent),
        intern(sessions, sessionIndexes, record.sessionId),
        intern(projects, projectIndexes, record.projectPath),
        intern(models, modelIndexes, record.model),
        record.inputTokens,
        record.outputTokens,
        record.cacheReadTokens,
        record.cacheCreateTokens,
        record.reasoningTokens,
        record.timestampMs,
        record.dedupeKey,
    ]);
    return [file.filePath, file.mtimeMs, agents, sessions, projects, models, records];
}
function decodeCompactFile(value) {
    if (!Array.isArray(value) || value.length !== 7)
        return null;
    const [filePath, mtimeMs, agents, sessions, projects, models, records] = value;
    if (typeof filePath !== 'string'
        || !isFiniteNumber(mtimeMs)
        || !isStringArray(agents)
        || !isStringArray(sessions)
        || !isNullableStringArray(projects)
        || !isNullableStringArray(models)
        || !Array.isArray(records)) {
        return null;
    }
    const decodedRecords = [];
    for (const record of records) {
        if (!Array.isArray(record) || record.length !== 11)
            return null;
        const [agentIndex, sessionIndex, projectIndex, modelIndex, inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, reasoningTokens, timestampMs, dedupeKey,] = record;
        const agent = agents[agentIndex];
        const sessionId = sessions[sessionIndex];
        if (!isArrayIndex(agentIndex, agents)
            || !isArrayIndex(sessionIndex, sessions)
            || !isArrayIndex(projectIndex, projects)
            || !isArrayIndex(modelIndex, models)
            || typeof agent !== 'string'
            || typeof sessionId !== 'string'
            || !isFiniteNumber(inputTokens)
            || !isFiniteNumber(outputTokens)
            || !isFiniteNumber(cacheReadTokens)
            || !isFiniteNumber(cacheCreateTokens)
            || !isFiniteNumber(reasoningTokens)
            || !isFiniteNumber(timestampMs)
            || typeof dedupeKey !== 'string') {
            return null;
        }
        decodedRecords.push({
            agent: agent,
            sessionId,
            projectPath: projects[projectIndex],
            model: models[modelIndex],
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreateTokens,
            reasoningTokens,
            timestampMs,
            dedupeKey,
        });
    }
    return { filePath, mtimeMs, records: decodedRecords };
}
function intern(values, indexes, value) {
    const existing = indexes.get(value);
    if (existing !== undefined)
        return existing;
    const index = values.length;
    values.push(value);
    indexes.set(value, index);
    return index;
}
function isParsedFile(value) {
    if (!isRecord(value))
        return false;
    return typeof value.filePath === 'string'
        && isFiniteNumber(value.mtimeMs)
        && Array.isArray(value.records)
        && value.records.every(isUsageRecord);
}
function isUsageRecord(value) {
    if (!isRecord(value))
        return false;
    return typeof value.agent === 'string'
        && typeof value.sessionId === 'string'
        && (value.projectPath === null || typeof value.projectPath === 'string')
        && (value.model === null || typeof value.model === 'string')
        && isFiniteNumber(value.inputTokens)
        && isFiniteNumber(value.outputTokens)
        && isFiniteNumber(value.cacheReadTokens)
        && isFiniteNumber(value.cacheCreateTokens)
        && isFiniteNumber(value.reasoningTokens)
        && isFiniteNumber(value.timestampMs)
        && typeof value.dedupeKey === 'string';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function isStringArray(value) {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
function isNullableStringArray(value) {
    return Array.isArray(value)
        && value.every((entry) => entry === null || typeof entry === 'string');
}
function isArrayIndex(index, values) {
    return typeof index === 'number'
        && Number.isInteger(index)
        && index >= 0
        && index < values.length;
}
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
