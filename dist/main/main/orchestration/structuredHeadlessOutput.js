"use strict";
/** Parse opt-in machine-readable output used by promotable Swarm workers. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.structuredCaptureFlags = structuredCaptureFlags;
exports.parseStructuredHeadlessOutput = parseStructuredHeadlessOutput;
function positiveNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function lastRecordMatching(values, predicate) {
    for (let index = values.length - 1; index >= 0; index -= 1) {
        if (predicate(values[index]))
            return values[index];
    }
    return undefined;
}
function projectClaudeResult(events, allowUntypedResult, depth = 0) {
    const typedFinalEvent = lastRecordMatching(events, (event) => (event.type === 'result' && typeof event.result === 'string'));
    const finalEvent = typedFinalEvent ?? (allowUntypedResult
        ? lastRecordMatching(events, (event) => typeof event.result === 'string')
        : undefined);
    if (!finalEvent || typeof finalEvent.result !== 'string')
        return undefined;
    // Claude can wrap the SDK transcript inside the outer result string. Only
    // unwrap a JSON array with a typed Claude result event; a final response
    // that happens to be ordinary JSON must remain the user's response.
    if (depth < 3) {
        try {
            const nested = JSON.parse(finalEvent.result);
            if (Array.isArray(nested)) {
                const nestedProjection = projectClaudeResult(nested.filter(isRecord), false, depth + 1);
                if (nestedProjection) {
                    return {
                        output: nestedProjection.output,
                        finalEvent,
                        // Outer aggregate metadata wins when present; reverse searches
                        // below therefore see these outer events last.
                        events: [...nestedProjection.events, ...events],
                    };
                }
            }
        }
        catch { /* final response is ordinary text */ }
    }
    return { output: finalEvent.result.trim(), finalEvent, events };
}
function parseClaudeOutput(raw) {
    try {
        const parsed = JSON.parse(raw);
        const events = Array.isArray(parsed)
            ? parsed.filter(isRecord)
            : isRecord(parsed) ? [parsed] : [];
        if (events.length === 0)
            return { output: raw };
        const projection = projectClaudeResult(events, true);
        const metadataEvents = projection?.events ?? events;
        const metadataEvent = projection?.finalEvent ?? events[events.length - 1];
        const usageEvent = isRecord(metadataEvent.usage)
            ? metadataEvent
            : lastRecordMatching(metadataEvents, (event) => isRecord(event.usage));
        const usage = usageEvent && isRecord(usageEvent.usage) ? usageEvent.usage : null;
        const sessionEvent = typeof metadataEvent.session_id === 'string' && metadataEvent.session_id
            ? metadataEvent
            : lastRecordMatching(metadataEvents, (event) => typeof event.session_id === 'string' && !!event.session_id);
        const inputTokens = usage
            ? positiveNumber(usage.input_tokens) + positiveNumber(usage.cache_creation_input_tokens) + positiveNumber(usage.cache_read_input_tokens)
            : 0;
        const outputTokens = usage ? positiveNumber(usage.output_tokens) : 0;
        const cost = typeof metadataEvent.total_cost_usd === 'number'
            ? metadataEvent.total_cost_usd
            : typeof usageEvent?.total_cost_usd === 'number' ? usageEvent.total_cost_usd : undefined;
        return {
            output: projection ? projection.output : raw,
            ...(sessionEvent && typeof sessionEvent.session_id === 'string'
                ? { sessionId: sessionEvent.session_id }
                : {}),
            ...(usage ? {
                usage: {
                    inputTokens,
                    outputTokens,
                    ...(cost !== undefined ? { costUsd: cost } : {}),
                },
            } : {}),
        };
    }
    catch {
        return { output: raw };
    }
}
function structuredCaptureFlags(agentId) {
    if (agentId === 'claude')
        return ['--output-format', 'json'];
    if (agentId === 'codex')
        return ['--json'];
    return [];
}
function parseStructuredHeadlessOutput(agentId, raw) {
    if (agentId === 'claude') {
        return parseClaudeOutput(raw);
    }
    if (agentId === 'codex') {
        let sessionId;
        let inputTokens = 0;
        let outputTokens = 0;
        const messages = [];
        let parsedAny = false;
        for (const line of raw.split(/\r?\n/)) {
            if (!line.trim())
                continue;
            try {
                const event = JSON.parse(line);
                parsedAny = true;
                if (event.type === 'thread.started') {
                    const id = event.thread_id ?? event.threadId;
                    if (typeof id === 'string' && id)
                        sessionId = id;
                }
                if (event.type === 'item.completed' && event.item && typeof event.item === 'object') {
                    const item = event.item;
                    if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
                        messages.push(item.text.trim());
                    }
                }
                if (event.type === 'turn.completed' && event.usage && typeof event.usage === 'object') {
                    const usage = event.usage;
                    inputTokens += positiveNumber(usage.input_tokens);
                    outputTokens += positiveNumber(usage.output_tokens);
                }
            }
            catch { /* retain fallback below */ }
        }
        if (parsedAny) {
            return {
                output: messages.join('\n\n') || raw,
                ...(sessionId ? { sessionId } : {}),
                usage: { inputTokens, outputTokens },
            };
        }
    }
    return { output: raw };
}
