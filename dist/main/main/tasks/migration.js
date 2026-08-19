"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.migrateRepoRoot = migrateRepoRoot;
const fs_1 = require("fs");
const path = __importStar(require("path"));
const tasks_1 = require("../../shared/tasks");
const ids_1 = require("./ids");
const frontmatter_1 = require("./frontmatter");
const taskIndex_1 = require("./taskIndex");
const V1_PRIORITY_MAP = {
    critical: 'p0',
    high: 'p1',
    normal: 'p2',
};
function normalizeGroupBy(groupBy) {
    if (groupBy === 'priority')
        return 'priority';
    if (groupBy === 'tag')
        return 'label';
    // v1 'source' / 'file' / 'author' have no v2 lane: source is gone, file
    // lanes died with the scanner, and there is one human (§10).
    return 'terminal';
}
async function migrateRepoRoot(input) {
    const { projectId, repoRoot } = input;
    const config = input.config ?? tasks_1.TASKS_CONFIG_DEFAULTS;
    if (config.migratedFromV1)
        return { migrated: 0, skipped: true, configPatch: {} };
    const dotDir = path.join(repoRoot, '.1devtool');
    const manualPath = path.join(dotDir, 'manual-tasks.json');
    const legacyConfigPath = path.join(dotDir, 'tasks.json');
    const now = input.now ?? Date.now();
    let legacyTasks = [];
    try {
        const parsed = JSON.parse(await fs_1.promises.readFile(manualPath, 'utf8'));
        if (Array.isArray(parsed))
            legacyTasks = parsed;
    }
    catch { /* no manual tasks file — nothing to migrate */ }
    let legacyConfig = {};
    try {
        const parsed = JSON.parse(await fs_1.promises.readFile(legacyConfigPath, 'utf8'));
        if (parsed && typeof parsed === 'object')
            legacyConfig = parsed;
    }
    catch { /* no legacy config */ }
    const tasksDir = input.tasksDir ?? (0, taskIndex_1.defaultTasksDir)(repoRoot);
    let migrated = 0;
    for (const legacy of legacyTasks) {
        if (legacy.source !== 'manual')
            continue; // scanned tasks are not migrated (§10)
        const legacyKey = legacy.id || legacy.description || '';
        if (!legacyKey)
            continue;
        const id = (0, ids_1.migrationTaskId)(repoRoot, legacyKey);
        const title = (legacy.description || 'Untitled task').slice(0, 200);
        const task = {
            id,
            projectId,
            repoRoot,
            title,
            body: legacy.context ? `\`\`\`\n${legacy.context}\n\`\`\`` : '',
            status: 'backlog',
            priority: V1_PRIORITY_MAP[legacy.priority] ?? 'p2',
            origin: 'manual',
            labels: legacy.tag ? [legacy.tag] : [],
            assignee: legacy.author ? { kind: 'human', id: 'me', label: legacy.author } : null,
            acceptanceCriteria: [],
            definitionOfDone: [],
            plan: null,
            deps: { blockedBy: [], parent: null, relatesTo: [] },
            ref: legacy.file
                ? {
                    kind: 'file',
                    label: `${legacy.file}:${legacy.line}`,
                    file: legacy.file,
                    line: legacy.line,
                    capturedAt: now,
                }
                : null,
            gates: [],
            runs: [],
            activity: [
                {
                    at: now,
                    actor: { kind: 'human', id: 'me', label: 'migration' },
                    kind: 'created',
                    text: 'migrated from v1 manual-tasks.json',
                },
            ],
            createdAt: now,
            updatedAt: now,
            closedAt: null,
        };
        await fs_1.promises.mkdir(tasksDir, { recursive: true });
        // Deterministic filename + full overwrite: a re-run after a crash lands on
        // the same path with the same content — zero duplicates by construction.
        await fs_1.promises.writeFile(path.join(tasksDir, (0, ids_1.taskFileName)(id, title)), (0, frontmatter_1.serializeTask)(task), 'utf8');
        migrated += 1;
    }
    // Preserve user-authored vocabulary regardless of whether any migrated task
    // carries it (§10 — NB5 correction).
    const vocabulary = [
        ...(legacyConfig.tags ?? []),
        ...(legacyConfig.customTags ?? []).map((t) => (typeof t === 'string' ? t : t.name ?? '')),
    ].filter(Boolean);
    // Rename originals *after* all files landed — the last step before the flag.
    for (const p of [manualPath, legacyConfigPath]) {
        try {
            await fs_1.promises.rename(p, `${p}.v1.bak`);
        }
        catch { /* absent or already renamed by a previous (crashed) run */ }
    }
    return {
        migrated,
        skipped: false,
        configPatch: {
            migratedFromV1: true,
            defaultSwimlane: normalizeGroupBy(legacyConfig.groupBy),
            ...(vocabulary.length ? { labelVocabulary: [...new Set(vocabulary)] } : {}),
        },
    };
}
