"use strict";
/**
 * Runs-folder export (Run & Logs → Export logs): bundles selected (or all)
 * `runs/<callId>/` dirs plus the orchestration app log into one zip the user
 * can attach to a bug report.
 *
 * Pure Node (fs/path/zlib) — no Electron imports, unit-testable under tsx
 * like the tracker. Same id-based path contract as
 * OrchestrationRunTracker.resolveRunFile: only validated callId dirs and the
 * fixed content-file names are ever read; symlinks and oversized foreign
 * files are skipped, never followed.
 *
 * The zip writer is deliberately minimal (local headers + central directory +
 * EOCD, deflate via zlib) so the app needs no archive dependency. Entry
 * counts and file sizes stay far below the ZIP64 thresholds by construction:
 * run files are capped by their writer and dirs are capped at retention size.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TERMINAL_LOG_EXPORT_CAP_CHARS = void 0;
exports.buildZip = buildZip;
exports.terminalTranscriptToPlainText = terminalTranscriptToPlainText;
exports.buildRunsExportZip = buildRunsExportZip;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_zlib_1 = __importDefault(require("node:zlib"));
const replay_1 = require("../../shared/terminal/replay");
const orchestrationRuns_1 = require("../../shared/orchestrationRuns");
/** Mirrors the tracker's SCAN_MAX_DIRS — beyond retention, junk costs disk only. */
const EXPORT_MAX_RUN_DIRS = 1000;
/** Legit run files are ≤ ~400 KB by their writer's caps; anything bigger is foreign. */
const EXPORT_FILE_CAP_BYTES = 8 * 1024 * 1024;
/** One pipe buffer is already bounded to 2 MiB; retain the same upper bound in
 * the user-created archive even if a backend briefly reports a pre-trim value. */
exports.TERMINAL_LOG_EXPORT_CAP_CHARS = 2 * 1024 * 1024;
const EXPORT_MAX_TERMINALS = 64;
// ---------------------------------------------------------------------------
// Minimal zip writer
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();
function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
/** MS-DOS date/time pair (zip header format); clamped to the 1980 epoch. */
function dosDateTime(mtimeMs) {
    const d = new Date(mtimeMs);
    const year = Math.max(d.getFullYear(), 1980);
    return {
        date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
        time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    };
}
function buildZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf-8');
        const deflated = node_zlib_1.default.deflateRawSync(entry.data, { level: 6 });
        // Store uncompressed when deflate doesn't help (tiny/incompressible data).
        const useDeflate = deflated.length < entry.data.length;
        const payload = useDeflate ? deflated : entry.data;
        const method = useDeflate ? 8 : 0;
        const crc = crc32(entry.data);
        const { date, time } = dosDateTime(entry.mtimeMs);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0x0800, 6); // UTF-8 names
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(payload.length, 18);
        local.writeUInt32LE(entry.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28); // extra len
        locals.push(local, name, payload);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4); // version made by
        central.writeUInt16LE(20, 6); // version needed
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(payload.length, 20);
        central.writeUInt32LE(entry.data.length, 24);
        central.writeUInt16LE(name.length, 28);
        // extra/comment/disk/internal/external attrs all zero
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += local.length + name.length + payload.length;
    }
    const centralSize = centrals.reduce((sum, buf) => sum + buf.length, 0);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...centrals, eocd]);
}
/** Read one known-name run file; null for missing/symlink/oversized targets. */
function readRunFileSafe(filePath) {
    try {
        const lst = node_fs_1.default.lstatSync(filePath);
        if (!lst.isFile() || lst.isSymbolicLink() || lst.size > EXPORT_FILE_CAP_BYTES)
            return null;
        return { data: node_fs_1.default.readFileSync(filePath), mtimeMs: lst.mtimeMs };
    }
    catch {
        return null;
    }
}
function safeArchiveSegment(value, fallback) {
    const safe = value
        .normalize('NFKD')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^[.-]+|[.-]+$/g, '')
        .slice(0, 72);
    return safe || fallback;
}
/** Convert a replay-safe raw PTY tail into a bounded, portable text log. */
function terminalTranscriptToPlainText(content) {
    const truncated = content.length > exports.TERMINAL_LOG_EXPORT_CAP_CHARS;
    const tail = truncated ? content.slice(-exports.TERMINAL_LOG_EXPORT_CAP_CHARS) : content;
    const plain = (0, replay_1.stripAnsiPreservingLayout)(tail)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
    return {
        text: truncated ? `[older terminal output omitted]\n${plain}` : plain,
        truncated,
    };
}
async function buildRunsExportZip(options = {}) {
    const homeDir = options.homeDir ?? node_os_1.default.homedir();
    const runsDir = (0, orchestrationRuns_1.getOrchestrationRunsDir)(homeDir);
    let callIds;
    if (options.callIds !== undefined) {
        callIds = [...new Set(options.callIds.filter(orchestrationRuns_1.isValidRunCallId))];
    }
    else {
        try {
            callIds = node_fs_1.default.readdirSync(runsDir).filter(orchestrationRuns_1.isValidRunCallId);
        }
        catch {
            callIds = [];
        }
    }
    callIds = callIds.sort().slice(0, EXPORT_MAX_RUN_DIRS);
    const fileNames = [orchestrationRuns_1.RUN_META_FILE, ...orchestrationRuns_1.RUN_CONTENT_FILES.map(orchestrationRuns_1.getRunContentFileName)];
    const entries = [];
    let runCount = 0;
    for (let i = 0; i < callIds.length; i++) {
        const callId = callIds[i];
        let added = false;
        for (const fileName of fileNames) {
            const file = readRunFileSafe(node_path_1.default.join(runsDir, callId, fileName));
            if (!file)
                continue;
            entries.push({ name: `runs/${callId}/${fileName}`, data: file.data, mtimeMs: file.mtimeMs });
            added = true;
        }
        if (added)
            runCount++;
        // Yield periodically so a full 500-run export can't starve the main loop.
        if (i % 25 === 24)
            await new Promise((resolve) => setImmediate(resolve));
    }
    if (options.logPath) {
        const log = readRunFileSafe(options.logPath);
        if (log)
            entries.push({ name: 'orchestration.log', data: log.data, mtimeMs: log.mtimeMs });
    }
    const terminalInfo = [];
    const terminalIds = new Set();
    for (const terminal of (options.terminalLogs ?? []).slice(0, EXPORT_MAX_TERMINALS)) {
        if (!terminal.terminalId || terminalIds.has(terminal.terminalId))
            continue;
        terminalIds.add(terminal.terminalId);
        const index = terminalInfo.length + 1;
        const name = safeArchiveSegment(terminal.terminalName, 'terminal');
        const id = safeArchiveSegment(terminal.terminalId, `terminal-${index}`);
        const file = `terminals/${String(index).padStart(2, '0')}-${name}-${id}.log`;
        const transcript = terminalTranscriptToPlainText(terminal.content);
        const body = terminal.unavailableReason
            ? `[Terminal buffer unavailable during export: ${terminal.unavailableReason}]\n`
            : transcript.text;
        entries.push({ name: file, data: Buffer.from(body, 'utf-8'), mtimeMs: Date.now() });
        terminalInfo.push({
            terminalId: terminal.terminalId,
            terminalName: terminal.terminalName,
            projectId: terminal.projectId,
            projectName: terminal.projectName,
            agentType: terminal.agentType,
            file,
            truncated: transcript.truncated,
            ...(terminal.unavailableReason ? { unavailableReason: terminal.unavailableReason } : {}),
        });
    }
    const info = {
        tool: '1DevTool orchestration Run & Logs export',
        appVersion: options.appVersion ?? 'unknown',
        platform: process.platform,
        exportedAt: new Date().toISOString(),
        scope: options.scope ?? (options.callIds !== undefined ? 'selected' : 'all'),
        runCount,
        terminalCount: terminalInfo.length,
        fileCount: entries.length,
        ...(options.project ? { project: options.project } : {}),
        ...(options.orchestrationIds ? { orchestrationIds: options.orchestrationIds } : {}),
        ...(options.linkIds ? { linkIds: options.linkIds } : {}),
        ...(terminalInfo.length > 0 ? { terminals: terminalInfo } : {}),
    };
    entries.unshift({
        name: 'export-info.json',
        data: Buffer.from(JSON.stringify(info, null, 2), 'utf-8'),
        mtimeMs: Date.now(),
    });
    return {
        zip: buildZip(entries),
        runCount,
        fileCount: entries.length,
        terminalCount: terminalInfo.length,
    };
}
