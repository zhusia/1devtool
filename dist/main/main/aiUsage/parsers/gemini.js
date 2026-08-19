"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseGeminiFile = parseGeminiFile;
exports.discoverGeminiFiles = discoverGeminiFiles;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
// Gemini CLI stores one session per JSON file (not JSONL). Each gemini-role
// message carries its own `tokens` block.
async function parseGeminiFile(filePath, mtimeMs) {
    const records = [];
    let raw;
    try {
        raw = await fs_1.promises.readFile(filePath, 'utf-8');
    }
    catch {
        return { filePath, mtimeMs, records };
    }
    let data;
    try {
        data = JSON.parse(raw);
    }
    catch {
        return { filePath, mtimeMs, records };
    }
    const sessionId = data.sessionId ?? path_1.default.basename(filePath, '.json');
    // tmp/<projectName>/chats/session-*.json — Gemini doesn't store the full
    // cwd, so fall back to the tmp-subdir name as the project identifier.
    const projectPath = path_1.default.basename(path_1.default.dirname(path_1.default.dirname(filePath)));
    for (const msg of data.messages ?? []) {
        if (msg.type !== 'gemini' || !msg.tokens)
            continue;
        const input = msg.tokens.input ?? 0;
        const output = msg.tokens.output ?? 0;
        const cached = msg.tokens.cached ?? 0;
        const thoughts = msg.tokens.thoughts ?? 0;
        if (input + output + cached + thoughts === 0)
            continue;
        records.push({
            agent: 'gemini',
            sessionId,
            projectPath,
            model: msg.model ?? null,
            inputTokens: Math.max(0, input - cached),
            outputTokens: output,
            cacheReadTokens: cached,
            cacheCreateTokens: 0,
            reasoningTokens: thoughts,
            timestampMs: msg.timestamp ? Date.parse(msg.timestamp) : 0,
            dedupeKey: `gemini:${sessionId}:${msg.id ?? records.length}`,
        });
    }
    return { filePath, mtimeMs, records };
}
async function discoverGeminiFiles(agentRoot) {
    const tmpDir = path_1.default.join(agentRoot, 'tmp');
    const out = [];
    let projects;
    try {
        projects = await fs_1.promises.readdir(tmpDir, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const p of projects) {
        if (!p.isDirectory())
            continue;
        const chatsDir = path_1.default.join(tmpDir, p.name, 'chats');
        let files;
        try {
            files = await fs_1.promises.readdir(chatsDir);
        }
        catch {
            continue;
        }
        for (const f of files) {
            if (f.endsWith('.json'))
                out.push(path_1.default.join(chatsDir, f));
        }
    }
    return out;
}
