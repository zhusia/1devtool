"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCodexFile = parseCodexFile;
exports.discoverCodexFiles = discoverCodexFiles;
const path_1 = __importDefault(require("path"));
const jsonl_1 = require("../jsonl");
const claude_1 = require("./claude");
// Codex emits a cumulative `total_token_usage` in each `token_count` event.
// Taking the LAST such event per session gives the session's final totals
// without double-counting emits of the same snapshot. `cached_input_tokens`
// is a subset of `input_tokens` (the portion that hit OpenAI's prompt cache),
// so we split it out to match the cache-read semantics of other agents.
async function parseCodexFile(filePath, mtimeMs) {
    let sessionId = path_1.default.basename(filePath, '.jsonl');
    let cwd = null;
    let startedAt = 0;
    let lastTimestamp = 0;
    let lastTotals = null;
    for await (const raw of (0, jsonl_1.streamJsonLines)(filePath)) {
        const line = raw;
        const ts = line.timestamp ? Date.parse(line.timestamp) : 0;
        if (line.type === 'session_meta' && line.payload) {
            if (line.payload.id)
                sessionId = line.payload.id;
            if (line.payload.cwd)
                cwd = line.payload.cwd;
            if (line.payload.timestamp)
                startedAt = Date.parse(line.payload.timestamp);
        }
        if (line.type === 'event_msg' &&
            line.payload?.type === 'token_count' &&
            line.payload.info?.total_token_usage) {
            const total = line.payload.info.total_token_usage;
            lastTotals = {
                input: total.input_tokens ?? 0,
                output: total.output_tokens ?? 0,
                cached: total.cached_input_tokens ?? 0,
                reasoning: total.reasoning_output_tokens ?? 0,
            };
            if (ts > lastTimestamp)
                lastTimestamp = ts;
        }
    }
    if (!lastTotals)
        return { filePath, mtimeMs, records: [] };
    const record = {
        agent: 'codex',
        sessionId,
        projectPath: cwd,
        // session_meta doesn't carry the specific model id; cost falls back to $0
        // until we detect it from response_item events in a later pass.
        model: null,
        inputTokens: Math.max(0, lastTotals.input - lastTotals.cached),
        outputTokens: lastTotals.output,
        cacheReadTokens: lastTotals.cached,
        cacheCreateTokens: 0,
        reasoningTokens: lastTotals.reasoning,
        timestampMs: lastTimestamp || startedAt,
        dedupeKey: `codex:${sessionId}`,
    };
    return { filePath, mtimeMs, records: [record] };
}
async function discoverCodexFiles(agentRoot) {
    return (0, claude_1.walkJsonl)(path_1.default.join(agentRoot, 'sessions'));
}
