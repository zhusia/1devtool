"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDefaultAgentRoot = getDefaultAgentRoot;
exports.getAgentRoot = getAgentRoot;
exports.getAgentSubPath = getAgentSubPath;
exports.getAgentDescriptor = getAgentDescriptor;
exports.listAgentDescriptors = listAgentDescriptors;
exports.scanAgentPath = scanAgentPath;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const AGENT_DESCRIPTORS = [
    {
        agentType: 'claude',
        rootDirSegments: ['.claude'],
        subdirs: [
            { name: 'projects', label: 'Projects / Resume' },
            { name: 'skills', label: 'Skills' },
            { name: 'commands', label: 'Slash Commands' },
        ],
    },
    {
        agentType: 'codex',
        rootDirSegments: ['.codex'],
        subdirs: [
            { name: 'sessions', label: 'Sessions / Resume' },
            { name: 'prompts', label: 'Prompts' },
        ],
    },
    {
        agentType: 'gemini',
        rootDirSegments: ['.gemini'],
        subdirs: [
            { name: 'tmp', label: 'Sessions / Resume' },
        ],
    },
    {
        agentType: 'qwen',
        rootDirSegments: ['.qwen'],
        subdirs: [
            { name: 'projects', label: 'Projects / Resume' },
        ],
    },
    {
        agentType: 'opencode',
        rootDirSegments: ['.local', 'share', 'opencode'],
        subdirs: [
            { name: 'project', label: 'Projects / Sessions' },
            { name: 'log', label: 'Logs' },
        ],
    },
];
const DESCRIPTOR_BY_TYPE = AGENT_DESCRIPTORS.reduce((acc, d) => {
    acc[d.agentType] = d;
    return acc;
}, {});
/**
 * Built-in default root for an agent on the current platform. We always anchor at
 * `os.homedir()` and join with each agent's relative path segments — `path.join`
 * produces the right separators on Windows and POSIX alike. Periods in
 * the username are tolerated by the OS but break the *encoded* directory naming
 * Claude/Qwen use under `projects/` — that's a separate decode problem handled in
 * resumeManager/memoryManager, not in the root resolution itself.
 */
function getDefaultAgentRoot(agentType) {
    const descriptor = DESCRIPTOR_BY_TYPE[agentType];
    if (!descriptor)
        throw new Error(`Unknown agent type: ${agentType}`);
    return path_1.default.join(os_1.default.homedir(), ...descriptor.rootDirSegments);
}
/**
 * Resolve the agent root, preferring the user override when non-empty. Trims
 * whitespace and trailing separators so callers can safely `path.join(root, sub)`.
 */
function getAgentRoot(agentType, overrides) {
    const raw = overrides?.[agentType]?.trim();
    if (raw) {
        return raw.replace(/[\\/]+$/, '');
    }
    return getDefaultAgentRoot(agentType);
}
/** Convenience: join a subpath onto the resolved agent root. */
function getAgentSubPath(agentType, overrides, ...subPaths) {
    return path_1.default.join(getAgentRoot(agentType, overrides), ...subPaths);
}
function getAgentDescriptor(agentType) {
    const d = DESCRIPTOR_BY_TYPE[agentType];
    if (!d)
        throw new Error(`Unknown agent type: ${agentType}`);
    return d;
}
function listAgentDescriptors() {
    return AGENT_DESCRIPTORS;
}
/**
 * Scan a directory recursively, summing up file count + total bytes. Bails out
 * gracefully on any per-entry error so a single permission-denied subdir doesn't
 * void the whole report. Hard-capped at MAX_ENTRIES to keep stat fan-out bounded
 * for users with extremely large `.claude/projects` trees.
 */
async function summarizeDir(dirPath) {
    const MAX_ENTRIES = 50_000;
    let fileCount = 0;
    let sizeBytes = 0;
    let visited = 0;
    async function walk(p) {
        if (visited >= MAX_ENTRIES)
            return;
        let entries;
        try {
            entries = await fs_1.promises.readdir(p, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (visited >= MAX_ENTRIES)
                return;
            visited++;
            const child = path_1.default.join(p, entry.name);
            if (entry.isDirectory()) {
                await walk(child);
            }
            else if (entry.isFile()) {
                try {
                    const st = await fs_1.promises.stat(child);
                    fileCount++;
                    sizeBytes += st.size;
                }
                catch {
                    // skip unreadable files
                }
            }
        }
    }
    try {
        const st = await fs_1.promises.stat(dirPath);
        if (!st.isDirectory())
            return { exists: false, fileCount: 0, sizeBytes: 0 };
    }
    catch {
        return { exists: false, fileCount: 0, sizeBytes: 0 };
    }
    await walk(dirPath);
    return { exists: true, fileCount, sizeBytes };
}
/**
 * Validate + measure an agent root for the AI settings tab. Returns counts per
 * known subdirectory so the UI can show "Projects: 142 files (3.2 MB)" rows.
 */
async function scanAgentPath(agentType, override) {
    const descriptor = getAgentDescriptor(agentType);
    const trimmedOverride = override?.trim() || undefined;
    const resolvedPath = trimmedOverride
        ? trimmedOverride.replace(/[\\/]+$/, '')
        : getDefaultAgentRoot(agentType);
    const isDefault = !trimmedOverride;
    let exists = false;
    let readable = false;
    let error;
    try {
        const st = await fs_1.promises.stat(resolvedPath);
        exists = st.isDirectory();
        if (!exists) {
            error = 'Path exists but is not a directory';
        }
    }
    catch (err) {
        exists = false;
        error = err instanceof Error ? err.message : String(err);
    }
    if (exists) {
        try {
            await fs_1.promises.access(resolvedPath, fs_1.constants.R_OK);
            readable = true;
        }
        catch (err) {
            readable = false;
            error = err instanceof Error ? err.message : String(err);
        }
    }
    const subdirs = [];
    let totalFiles = 0;
    let totalSizeBytes = 0;
    if (exists && readable) {
        for (const sub of descriptor.subdirs) {
            const summary = await summarizeDir(path_1.default.join(resolvedPath, sub.name));
            subdirs.push({
                name: sub.name,
                label: sub.label,
                exists: summary.exists,
                fileCount: summary.fileCount,
                sizeBytes: summary.sizeBytes,
            });
            totalFiles += summary.fileCount;
            totalSizeBytes += summary.sizeBytes;
        }
    }
    else {
        for (const sub of descriptor.subdirs) {
            subdirs.push({
                name: sub.name,
                label: sub.label,
                exists: false,
                fileCount: 0,
                sizeBytes: 0,
            });
        }
    }
    return {
        agentType,
        resolvedPath,
        isDefault,
        exists,
        readable,
        totalFiles,
        totalSizeBytes,
        subdirs,
        error,
    };
}
