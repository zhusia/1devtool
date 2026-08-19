"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractCodexModelPin = extractCodexModelPin;
exports.applyCodexModelPin = applyCodexModelPin;
exports.codexConfigPath = codexConfigPath;
exports.readCodexModelPin = readCodexModelPin;
exports.writeCodexModelPin = writeCodexModelPin;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const agentPaths_1 = require("../agentPaths");
const atomicWrite_1 = require("./atomicWrite");
const MODEL_KEY = 'model';
const EFFORT_KEY = 'model_reasoning_effort';
/** Lines before the first `[table]` header — the only region we may edit. */
function splitAtFirstTable(content) {
    const lines = content.split('\n');
    const tableIndex = lines.findIndex((line) => /^\s*\[/.test(line));
    if (tableIndex === -1)
        return { preamble: lines, rest: [] };
    return { preamble: lines.slice(0, tableIndex), rest: lines.slice(tableIndex) };
}
function keyLinePattern(key) {
    return new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`);
}
/** Parse a TOML scalar as far as we need: quoted basic string or bare token. */
function parseTomlValue(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return null;
    if (trimmed.startsWith('"')) {
        const end = trimmed.indexOf('"', 1);
        return end > 0 ? trimmed.slice(1, end) : null;
    }
    const token = trimmed.split(/[\s#]/, 1)[0];
    return token || null;
}
function extractCodexModelPin(content) {
    const { preamble } = splitAtFirstTable(content);
    const read = (key) => {
        for (const line of preamble) {
            const match = keyLinePattern(key).exec(line);
            if (match)
                return parseTomlValue(match[1]);
        }
        return null;
    };
    return { model: read(MODEL_KEY), reasoningEffort: read(EFFORT_KEY) };
}
function formatKeyLine(key, value) {
    return `${key} = "${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
/**
 * Return `content` with the top-level model pin set to `pin`. A null pin (or
 * null fields) removes the corresponding key. Everything outside the two keys
 * in the preamble is preserved byte-identical.
 */
function applyCodexModelPin(content, pin) {
    const { preamble, rest } = splitAtFirstTable(content);
    const desired = [
        [MODEL_KEY, pin?.model ?? null],
        [EFFORT_KEY, pin?.reasoningEffort ?? null],
    ];
    let lines = [...preamble];
    for (const [key, value] of desired) {
        const pattern = keyLinePattern(key);
        const existingIndex = lines.findIndex((line) => pattern.test(line));
        if (value == null) {
            if (existingIndex !== -1)
                lines = lines.filter((_, index) => index !== existingIndex);
        }
        else if (existingIndex !== -1) {
            lines[existingIndex] = formatKeyLine(key, value);
        }
        else {
            // Append at the end of the preamble so any header comments stay on top
            // and the key stays above the first [table].
            let insertAt = lines.length;
            while (insertAt > 0 && lines[insertAt - 1].trim() === '')
                insertAt -= 1;
            lines.splice(insertAt, 0, formatKeyLine(key, value));
        }
    }
    return [...lines, ...rest].join('\n');
}
function codexConfigPath(overrides) {
    return path_1.default.join((0, agentPaths_1.getAgentRoot)('codex', overrides), 'config.toml');
}
/** The model pin currently live in ~/.codex/config.toml (all-null when the
 * file is missing or carries no pin). */
async function readCodexModelPin(overrides) {
    const content = await fs_1.promises.readFile(codexConfigPath(overrides), 'utf8').catch(() => null);
    if (content == null)
        return { model: null, reasoningEffort: null };
    return extractCodexModelPin(content);
}
/** Write `pin` into config.toml (atomic; no-op when nothing changes, so a
 * missing config file is never created just to hold an empty pin). */
async function writeCodexModelPin(overrides, pin) {
    const configPath = codexConfigPath(overrides);
    const content = (await fs_1.promises.readFile(configPath, 'utf8').catch(() => null)) ?? '';
    const next = applyCodexModelPin(content, pin);
    if (next === content)
        return;
    await (0, atomicWrite_1.writeFileAtomic)(configPath, next);
}
