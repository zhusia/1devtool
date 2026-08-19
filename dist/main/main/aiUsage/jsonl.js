"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.streamJsonLines = streamJsonLines;
const fs_1 = require("fs");
const readline_1 = __importDefault(require("readline"));
async function* streamJsonLines(filePath) {
    const stream = (0, fs_1.createReadStream)(filePath, { encoding: 'utf-8' });
    const rl = readline_1.default.createInterface({ input: stream, crlfDelay: Infinity });
    try {
        for await (const line of rl) {
            if (!line.trim())
                continue;
            try {
                yield JSON.parse(line);
            }
            catch {
                // Skip malformed lines — JSONL files can be partially written.
            }
        }
    }
    finally {
        rl.close();
        stream.close();
    }
}
