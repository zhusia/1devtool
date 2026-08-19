"use strict";
/**
 * Transcript → HappyEnvelope mapper (desktop).
 *
 * Converts an AI agent's raw JSONL transcript lines into the structured,
 * provider-agnostic envelope stream that HappyRemote renders. Unlike
 * `resumeManager`'s parsers (which flatten everything to `{role, content}`),
 * this PRESERVES tool_use / tool_result / thinking blocks so the phone can draw
 * per-tool cards. Modeled on slopus/happy's `sessionProtocolMapper.ts`.
 *
 * Phase 1 supports the two append-per-line JSONL agents — Claude and Codex
 * (rollout format). Gemini/Qwen/OpenCode are Phase 2.
 *
 * Pure + stateless per line (the only "state" is the line index, passed in), so
 * the tailer can map a full snapshot OR just newly-appended lines identically.
 * Every line is wrapped in try/catch and unknown shapes are tolerated — a new
 * agent/API field must never throw and blank the feed.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTailableAgent = isTailableAgent;
exports.mapTranscriptLines = mapTranscriptLines;
/** Whether this agent's transcript is line-appended JSONL we can tail+map. */
function isTailableAgent(agentType) {
    return agentType === 'claude' || agentType === 'codex';
}
/**
 * Map a batch of raw JSONL lines to envelopes.
 * @param lines    full transcript lines (snapshot) or just the new ones (delta)
 * @param agentType which dialect to parse
 * @param baseIndex line index of `lines[0]` within the whole file — keeps ids
 *                  stable between the snapshot pass and later delta passes so
 *                  the phone reducer dedupes correctly.
 */
function mapTranscriptLines(lines, agentType, baseIndex = 0) {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        if (!raw || !raw.trim())
            continue;
        let entry;
        try {
            entry = JSON.parse(raw);
        }
        catch {
            continue; // partial / non-JSON line — skip
        }
        try {
            if (agentType === 'claude') {
                mapClaudeEntry(entry, baseIndex + i, out);
            }
            else {
                mapCodexEntry(entry, baseIndex + i, out);
            }
        }
        catch {
            // tolerate any single bad entry; never blank the whole feed
        }
    }
    return out;
}
// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------
function mapClaudeEntry(entry, index, out) {
    // Curation: drop noise the human shouldn't see (matches Happy's mapper).
    if (!entry || typeof entry !== 'object')
        return;
    if (entry.type === 'summary' || entry.type === 'system')
        return;
    if (entry.isMeta || entry.isCompactSummary)
        return;
    // Phase 1: skip sub-agent sidechains (Task internals) — Phase 2 nests them.
    if (entry.isSidechain)
        return;
    const at = toMillis(entry.timestamp);
    const baseId = typeof entry.uuid === 'string' && entry.uuid ? entry.uuid : `l${index}`;
    const role = entry.type || entry.role;
    const content = entry.message?.content ?? entry.content;
    if (role === 'assistant') {
        if (typeof content === 'string') {
            if (content.trim())
                out.push({ t: 'agent-text', id: baseId, text: content, createdAt: at });
            return;
        }
        if (!Array.isArray(content))
            return;
        content.forEach((block, bi) => {
            const id = `${baseId}:${bi}`;
            if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                out.push({ t: 'agent-text', id, text: block.text, createdAt: at });
            }
            else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
                out.push({ t: 'agent-text', id, text: block.thinking, thinking: true, createdAt: at });
            }
            else if (block?.type === 'tool_use') {
                const call = typeof block.id === 'string' && block.id ? block.id : id;
                const name = typeof block.name === 'string' ? block.name : 'tool';
                out.push({
                    t: 'tool-call-start',
                    id,
                    call,
                    name,
                    title: toolTitle(name, block.input),
                    input: block.input,
                    createdAt: at,
                });
            }
        });
        return;
    }
    if (role === 'user') {
        if (typeof content === 'string') {
            if (content.trim())
                out.push({ t: 'user-text', id: baseId, text: content, createdAt: at });
            return;
        }
        if (!Array.isArray(content))
            return;
        const hasToolResult = content.some((b) => b?.type === 'tool_result');
        content.forEach((block, bi) => {
            if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                out.push({
                    t: 'tool-call-end',
                    call: block.tool_use_id,
                    result: extractClaudeResult(block.content),
                    isError: block.is_error === true,
                    createdAt: at,
                });
            }
            else if (!hasToolResult && block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                out.push({ t: 'user-text', id: `${baseId}:${bi}`, text: block.text, createdAt: at });
            }
        });
    }
}
function extractClaudeResult(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        return content
            .map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : ''))
            .filter(Boolean)
            .join('\n');
    }
    if (content && typeof content === 'object')
        return JSON.stringify(content);
    return '';
}
// ---------------------------------------------------------------------------
// Codex (rollout JSONL)
// ---------------------------------------------------------------------------
function mapCodexEntry(entry, index, out) {
    if (!entry || typeof entry !== 'object')
        return;
    const at = toMillis(entry.timestamp);
    const baseId = typeof entry.id === 'string' && entry.id ? entry.id : `l${index}`;
    // Codex wraps payloads: { type:'response_item', payload:{...} }
    const payload = entry.payload ?? entry;
    const ptype = payload?.type;
    if (ptype === 'message') {
        const role = payload.role === 'assistant' ? 'agent-text' : 'user-text';
        const text = extractCodexText(payload.content);
        if (text.trim()) {
            if (role === 'agent-text')
                out.push({ t: 'agent-text', id: baseId, text, createdAt: at });
            else
                out.push({ t: 'user-text', id: baseId, text, createdAt: at });
        }
        return;
    }
    if (ptype === 'function_call' || ptype === 'local_shell_call') {
        const call = typeof payload.call_id === 'string' ? payload.call_id : baseId;
        const name = typeof payload.name === 'string' ? payload.name : 'shell';
        let input = payload.arguments ?? payload.action ?? payload.input;
        if (typeof input === 'string') {
            try {
                input = JSON.parse(input);
            }
            catch { /* keep string */ }
        }
        out.push({ t: 'tool-call-start', id: baseId, call, name, title: toolTitle(name, input), input, createdAt: at });
        return;
    }
    if (ptype === 'function_call_output' || ptype === 'local_shell_call_output') {
        const call = typeof payload.call_id === 'string' ? payload.call_id : baseId;
        out.push({
            t: 'tool-call-end',
            call,
            result: extractCodexOutput(payload.output),
            isError: false,
            createdAt: at,
        });
    }
}
function extractCodexText(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        return content
            .map((b) => typeof b?.text === 'string' ? b.text : typeof b === 'string' ? b : '')
            .filter(Boolean)
            .join('\n');
    }
    return '';
}
function extractCodexOutput(output) {
    if (typeof output === 'string')
        return output;
    if (output && typeof output === 'object') {
        const o = output;
        if (typeof o.output === 'string')
            return o.output;
        return JSON.stringify(output);
    }
    return '';
}
// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
/** A short, human title for a tool call derived from its most telling input. */
function toolTitle(name, input) {
    if (input && typeof input === 'object') {
        if (typeof input.command === 'string')
            return clip(input.command, 60);
        if (typeof input.file_path === 'string')
            return basename(input.file_path);
        if (typeof input.path === 'string')
            return basename(input.path);
        if (typeof input.pattern === 'string')
            return `“${clip(input.pattern, 40)}”`;
        if (typeof input.description === 'string')
            return clip(input.description, 60);
        if (typeof input.prompt === 'string')
            return clip(input.prompt, 60);
    }
    return name;
}
function basename(p) {
    return p.split(/[\\/]/).pop() || p;
}
function clip(s, n) {
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function toMillis(ts) {
    if (typeof ts === 'number')
        return ts;
    if (typeof ts === 'string') {
        const n = Date.parse(ts);
        if (!Number.isNaN(n))
            return n;
    }
    return Date.now();
}
