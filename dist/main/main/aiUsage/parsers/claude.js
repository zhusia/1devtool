"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseClaudeFile = parseClaudeFile;
exports.discoverClaudeFiles = discoverClaudeFiles;
exports.walkJsonl = walkJsonl;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const jsonl_1 = require("../jsonl");
async function parseClaudeFile(filePath, mtimeMs) {
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
        if (line.type !== 'assistant' || !line.message?.usage)
            continue;
        const u = line.message.usage;
        const input = u.input_tokens ?? 0;
        const output = u.output_tokens ?? 0;
        const cacheRead = u.cache_read_input_tokens ?? 0;
        const cacheCreate = u.cache_creation_input_tokens ?? 0;
        if (input + output + cacheRead + cacheCreate === 0)
            continue;
        const messageId = line.message.id ?? line.uuid;
        const key = line.requestId && messageId
            ? `claude:${line.requestId}:${messageId}`
            : `claude:${sessionId}:${line.uuid ?? records.length}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        records.push({
            agent: 'claude',
            sessionId,
            projectPath: cwd,
            model: line.message.model ?? null,
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cacheRead,
            cacheCreateTokens: cacheCreate,
            reasoningTokens: 0,
            timestampMs: line.timestamp ? Date.parse(line.timestamp) : 0,
            dedupeKey: key,
        });
    }
    return { filePath, mtimeMs, records };
}
async function discoverClaudeFiles(agentRoot) {
    return walkJsonl(path_1.default.join(agentRoot, 'projects'));
}
async function walkJsonl(dir, out = []) {
    let entries;
    try {
        entries = await fs_1.promises.readdir(dir, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const entry of entries) {
        const p = path_1.default.join(dir, entry.name);
        if (entry.isDirectory()) {
            await walkJsonl(p, out);
        }
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            out.push(p);
        }
    }
    return out;
}
