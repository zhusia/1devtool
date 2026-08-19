"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseQwenFile = parseQwenFile;
exports.discoverQwenFiles = discoverQwenFiles;
const path_1 = __importDefault(require("path"));
const jsonl_1 = require("../jsonl");
const claude_1 = require("./claude");
async function parseQwenFile(filePath, mtimeMs) {
    const records = [];
    const seen = new Set();
    let sessionId = path_1.default.basename(filePath, '.jsonl');
    let cwd = null;
    for await (const raw of (0, jsonl_1.streamJsonLines)(filePath)) {
        const line = raw;
        if (line.sessionId)
            sessionId = line.sessionId;
        if (line.cwd)
            cwd = line.cwd;
        if (line.type !== 'system' || line.subtype !== 'ui_telemetry')
            continue;
        const evt = line.systemPayload?.uiEvent;
        if (!evt || evt['event.name'] !== 'qwen-code.api_response')
            continue;
        const responseId = typeof evt.response_id === 'string' ? evt.response_id : '';
        const evtTs = typeof evt['event.timestamp'] === 'string' ? evt['event.timestamp'] : undefined;
        const key = responseId
            ? `qwen:${responseId}`
            : `qwen:${sessionId}:${evtTs ?? records.length}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        const input = toNumber(evt.input_token_count);
        const output = toNumber(evt.output_token_count);
        const cached = toNumber(evt.cached_content_token_count);
        const thoughts = toNumber(evt.thoughts_token_count);
        if (input + output + cached + thoughts === 0)
            continue;
        records.push({
            agent: 'qwen',
            sessionId,
            projectPath: cwd,
            model: typeof evt.model === 'string' ? evt.model : null,
            inputTokens: Math.max(0, input - cached),
            outputTokens: output,
            cacheReadTokens: cached,
            cacheCreateTokens: 0,
            reasoningTokens: thoughts,
            timestampMs: evtTs ? Date.parse(evtTs) : line.timestamp ? Date.parse(line.timestamp) : 0,
            dedupeKey: key,
        });
    }
    return { filePath, mtimeMs, records };
}
function toNumber(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
async function discoverQwenFiles(agentRoot) {
    return (0, claude_1.walkJsonl)(path_1.default.join(agentRoot, 'projects'));
}
