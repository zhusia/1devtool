"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.newTaskId = newTaskId;
exports.migrationTaskId = migrationTaskId;
exports.isTaskId = isTaskId;
exports.taskFileName = taskFileName;
exports.taskIdFromFileName = taskIdFromFileName;
const crypto_1 = require("crypto");
/**
 * Task ids (docs/tasks_v2.md §4.3): `t-` + at least 64 random bits, base32.
 * Collisions are not a design consideration at 64 bits; the create-time index
 * check stays only as a belt-and-braces assert. Sub-tasks get their own
 * full-entropy ids — hierarchy lives in `deps.parent` only.
 *
 * Crockford base32 (lowercase, no i/l/o/u) keeps ids unambiguous in filenames
 * and terminals. 13 chars × 5 bits = 65 bits of capacity for 64 random bits.
 */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const ID_CHARS = 13;
function encodeBase32(bytes, chars) {
    let value = 0n;
    for (const b of bytes)
        value = (value << 8n) | BigInt(b);
    let out = '';
    for (let i = 0; i < chars; i++) {
        out = ALPHABET[Number(value & 31n)] + out;
        value >>= 5n;
    }
    return out;
}
function newTaskId() {
    return `t-${encodeBase32((0, crypto_1.randomBytes)(8), ID_CHARS)}`;
}
/**
 * Deterministic legacy→v2 id for migration (§10): derived from the legacy
 * task's stable fields with no random salt, so a crash after some files but
 * before the guard flag re-runs into the SAME filenames and overwrites
 * instead of duplicating. Migration-only — new tasks use `newTaskId()`.
 */
function migrationTaskId(repoRoot, legacyKey) {
    const digest = (0, crypto_1.createHash)('sha256').update(`${repoRoot}\n${legacyKey}`).digest();
    return `t-${encodeBase32(digest.subarray(0, 8), ID_CHARS)}`;
}
function isTaskId(value) {
    if (!value.startsWith('t-') || value.length !== 2 + ID_CHARS)
        return false;
    for (const ch of value.slice(2))
        if (!ALPHABET.includes(ch))
            return false;
    return true;
}
/** Filename slug: `<id>-<slug>.md`, slug from the title for human legibility. */
function taskFileName(id, title) {
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    return slug ? `${id}-${slug}.md` : `${id}.md`;
}
/** Extract the task id from a `<id>-<slug>.md` filename, or null. */
function taskIdFromFileName(fileName) {
    if (!fileName.endsWith('.md'))
        return null;
    const base = fileName.slice(0, -3);
    const candidate = base.slice(0, 2 + ID_CHARS);
    if (!isTaskId(candidate))
        return null;
    const rest = base.slice(2 + ID_CHARS);
    if (rest !== '' && !rest.startsWith('-'))
        return null;
    return candidate;
}
