"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.appendJournal = appendJournal;
exports.readJournal = readJournal;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const history_1 = require("./history");
/*
 * Activity journal (quota-center §7): append-only JSONL, capped at 5k
 * entries, answering "why did it pick that account?". Best-effort telemetry —
 * a failed journal write never blocks a lease or a switch.
 */
const JOURNAL_CAP = 5_000;
/** Rewrite-to-cap only after this much slack so the cap isn't O(n) per append. */
const CAP_SLACK = 500;
function journalPath() {
    return path_1.default.join((0, history_1.getPoolRoot)(), 'journal.jsonl');
}
let writeChain = Promise.resolve();
// Seeded AT the slack threshold so the first append of every app session runs
// one cap check. A typical session appends tens of entries — far under the
// 500-append slack — so a 0-seeded counter would reset each launch and the
// cap would never run, growing journal.jsonl across sessions forever.
let appendsSinceCapCheck = CAP_SLACK;
function appendJournal(entry) {
    const full = { ts: entry.ts ?? Date.now(), ...entry, };
    const run = async () => {
        await fs_1.promises.mkdir((0, history_1.getPoolRoot)(), { recursive: true });
        await fs_1.promises.appendFile(journalPath(), JSON.stringify(full) + '\n');
        appendsSinceCapCheck += 1;
        if (appendsSinceCapCheck >= CAP_SLACK) {
            appendsSinceCapCheck = 0;
            const entries = await readJournal();
            if (entries.length > JOURNAL_CAP) {
                const trimmed = entries.slice(entries.length - JOURNAL_CAP);
                await fs_1.promises.writeFile(journalPath(), trimmed.map((e) => JSON.stringify(e)).join('\n') + '\n');
            }
        }
    };
    writeChain = writeChain.then(run, run).catch(() => undefined);
}
async function readJournal(limit, kinds) {
    const content = await fs_1.promises.readFile(journalPath(), 'utf8').catch(() => '');
    const entries = [];
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed?.ts === 'number' && typeof parsed?.kind === 'string')
                entries.push(parsed);
        }
        catch {
            /* skip torn line */
        }
    }
    const filtered = kinds?.length ? entries.filter((e) => kinds.includes(e.kind)) : entries;
    return limit ? filtered.slice(-limit) : filtered;
}
