"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseOpencodeFile = parseOpencodeFile;
exports.discoverOpencodeFiles = discoverOpencodeFiles;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
/**
 * Parse the OpenCode SQLite database into per-message usage records.
 *
 * Each assistant `message.data` blob carries a `tokens` block of the form
 * `{ total, input, output, reasoning, cache: { read, write } }`. The `input`
 * count is already cache-exclusive — verified against real data, where
 * `total === input + output + reasoning + cache.read + cache.write` — so the
 * fields map straight onto our schema the same way Claude's do (no need to
 * subtract cache from input, unlike Codex/Gemini/Qwen).
 *
 * `time.completed` is a millisecond epoch, so no unit conversion is required.
 */
async function parseOpencodeFile(filePath, mtimeMs) {
    const records = [];
    let db;
    try {
        // readonly + fileMustExist: never (re)create the DB, and tolerate a live
        // opencode process holding the write lock — SQLite WAL permits concurrent
        // readers alongside the single writer.
        db = new better_sqlite3_1.default(filePath, { readonly: true, fileMustExist: true });
    }
    catch {
        // DB missing/locked/corrupt — nothing to report this scan.
        return { filePath, mtimeMs, records };
    }
    try {
        // Filter to assistant rows in SQL. User-message `data` blobs can be
        // megabytes (they embed prompt content), while assistant blobs are tiny
        // metadata — so the json_extract predicate keeps us from pulling all that
        // user content into JS just to discard it.
        const rows = db
            .prepare(`SELECT id, session_id, time_created, data
         FROM message
         WHERE json_extract(data, '$.role') = 'assistant'`)
            .all();
        for (const row of rows) {
            let data;
            try {
                data = JSON.parse(row.data);
            }
            catch {
                continue;
            }
            const tokens = data.tokens;
            if (!tokens)
                continue;
            const input = nonNegative(tokens.input);
            const output = nonNegative(tokens.output);
            const cacheRead = nonNegative(tokens.cache?.read);
            const cacheCreate = nonNegative(tokens.cache?.write);
            const reasoning = nonNegative(tokens.reasoning);
            if (input + output + cacheRead + cacheCreate + reasoning === 0)
                continue;
            const timestampMs = nonNegative(data.time?.completed) || nonNegative(data.time?.created) || row.time_created || 0;
            records.push({
                agent: 'opencode',
                sessionId: row.session_id,
                projectPath: typeof data.path?.cwd === 'string' ? data.path.cwd : null,
                // Store the bare model id (e.g. `claude-sonnet-4-6`) so it matches the
                // shared pricing table keys. OpenCode's own free/relayed models
                // (`deepseek-v4-pro`, `kimi-k2.6`, …) aren't in the table and correctly
                // fall through to $0, consistent with how unknown models are handled.
                model: typeof data.modelID === 'string' ? data.modelID : null,
                inputTokens: input,
                outputTokens: output,
                cacheReadTokens: cacheRead,
                cacheCreateTokens: cacheCreate,
                reasoningTokens: reasoning,
                timestampMs,
                // message.id is a globally-unique primary key, so it's a stable dedupe
                // key on its own.
                dedupeKey: `opencode:${row.id}`,
            });
        }
    }
    finally {
        db.close();
    }
    return { filePath, mtimeMs, records };
}
/**
 * OpenCode keeps all sessions in a single `opencode.db` at the agent root, so
 * discovery is just "does that file exist". Returning the path lets the cache
 * layer key on the DB's mtime — re-parsed only after a WAL checkpoint bumps it,
 * or whenever the user forces a refresh.
 */
async function discoverOpencodeFiles(agentRoot) {
    const dbPath = path_1.default.join(agentRoot, 'opencode.db');
    try {
        const stat = await fs_1.promises.stat(dbPath);
        if (stat.isFile())
            return [dbPath];
    }
    catch {
        // No opencode.db — opencode isn't installed or hasn't been used.
    }
    return [];
}
function nonNegative(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
