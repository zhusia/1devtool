"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.settingsDir = settingsDir;
exports.domainToFile = domainToFile;
exports.domainFilePath = domainFilePath;
exports.secretsFilePath = secretsFilePath;
exports.skillsDirPath = skillsDirPath;
exports.gitignorePath = gitignorePath;
exports.isInsideDir = isInsideDir;
exports.contentHash = contentHash;
exports.stableStringify = stableStringify;
exports.readJsonTolerant = readJsonTolerant;
exports.readTextTolerant = readTextTolerant;
exports.writeJsonAtomic = writeJsonAtomic;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const crypto_1 = require("crypto");
/** Absolute path to a project's `.1devtool/` folder. */
function settingsDir(rootPath) {
    return path_1.default.join(rootPath, '.1devtool');
}
/** JSON file name that owns a given config domain (`skills` is a folder). */
const DOMAIN_FILES = {
    settings: 'settings.json',
    browser: 'browser.json',
    database: 'database.json',
    http: 'http.json',
    deploy: 'deploy.json',
    env: 'env.json',
    agents: 'agents.json',
    channels: 'channels.json',
    prompts: 'prompts.json',
    layouts: 'layouts.json',
    tasks: 'tasks.config.json',
};
function domainToFile(domain) {
    return DOMAIN_FILES[domain];
}
function domainFilePath(rootPath, domain) {
    return path_1.default.join(settingsDir(rootPath), DOMAIN_FILES[domain]);
}
function secretsFilePath(rootPath) {
    return path_1.default.join(settingsDir(rootPath), 'secrets.local.json');
}
function skillsDirPath(rootPath) {
    return path_1.default.join(settingsDir(rootPath), 'skills');
}
function gitignorePath(rootPath) {
    return path_1.default.join(settingsDir(rootPath), '.gitignore');
}
/** True when `child` resolves to a path inside `parent` (blocks `../` traversal). */
function isInsideDir(parent, child) {
    const rel = path_1.default.relative(path_1.default.resolve(parent), path_1.default.resolve(child));
    return rel !== '' && !rel.startsWith('..') && !path_1.default.isAbsolute(rel);
}
/**
 * sha256 hex of raw text — used for own-write detection and executable-file
 * approval hashes.
 */
function contentHash(text) {
    return (0, crypto_1.createHash)('sha256').update(text, 'utf8').digest('hex');
}
/**
 * Deterministic, diff-stable JSON serialization: object keys sorted
 * recursively, 2-space indent, single trailing newline. Same logical input →
 * byte-identical output (the property the diff-focus + team-merge design rests
 * on). `undefined`-valued keys are dropped exactly like `JSON.stringify`.
 */
function stableStringify(value) {
    return JSON.stringify(sortValue(value), null, 2) + '\n';
}
function sortValue(value) {
    if (Array.isArray(value))
        return value.map(sortValue);
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            const v = value[key];
            if (v === undefined)
                continue;
            out[key] = sortValue(v);
        }
        return out;
    }
    return value;
}
/**
 * Read + parse a `.1devtool/` JSON file without ever throwing. A missing file
 * is `{ value: null, error: null }` (a first-class "absent" state, not an
 * error). Malformed / oversized / symlinked files return an error string that
 * surfaces as the `lastError` chip — the folder must never crash the main loop.
 */
async function readJsonTolerant(filePath, maxBytes = 2_000_000) {
    let stat;
    try {
        stat = await fs_1.promises.lstat(filePath);
    }
    catch (err) {
        const code = err.code;
        if (code === 'ENOENT')
            return { value: null, error: null };
        return { value: null, error: err.message };
    }
    if (stat.isSymbolicLink()) {
        return { value: null, error: `refusing to read symlink: ${path_1.default.basename(filePath)}` };
    }
    if (!stat.isFile())
        return { value: null, error: null };
    if (stat.size > maxBytes) {
        return { value: null, error: `${path_1.default.basename(filePath)} exceeds ${maxBytes} bytes` };
    }
    let text;
    try {
        text = await fs_1.promises.readFile(filePath, 'utf8');
    }
    catch (err) {
        return { value: null, error: err.message };
    }
    try {
        return { value: JSON.parse(text), error: null };
    }
    catch (err) {
        return { value: null, error: `invalid JSON in ${path_1.default.basename(filePath)}: ${err.message}` };
    }
}
/** Read the raw text of a `.1devtool/` file (for content hashing), or null. */
async function readTextTolerant(filePath, maxBytes = 2_000_000) {
    try {
        const stat = await fs_1.promises.lstat(filePath);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes)
            return null;
        return await fs_1.promises.readFile(filePath, 'utf8');
    }
    catch {
        return null;
    }
}
let tmpCounter = 0;
/**
 * Atomic write: serialize (stable order unless a raw string is passed), write to
 * a temp file in the same directory, fsync, then rename over the target. Mirrors
 * electron-store's own atomic-write strategy so a crash mid-write can never
 * leave a half-written config file.
 */
async function writeJsonAtomic(filePath, value) {
    const dir = path_1.default.dirname(filePath);
    await fs_1.promises.mkdir(dir, { recursive: true });
    const data = typeof value === 'string' ? value : stableStringify(value);
    const tmp = path_1.default.join(dir, `.${path_1.default.basename(filePath)}.tmp-${process.pid}-${++tmpCounter}`);
    const handle = await fs_1.promises.open(tmp, 'w');
    try {
        await handle.writeFile(data, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await fs_1.promises.rename(tmp, filePath);
}
