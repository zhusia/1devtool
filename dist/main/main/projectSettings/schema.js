"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.upgrade = upgrade;
exports.parseDomain = parseDomain;
exports.summarize = summarize;
const types_1 = require("../../shared/types");
const tasks_1 = require("../../shared/tasks");
/**
 * schema — tolerant coercion + version upgrade + human summaries for each
 * `.1devtool/` domain file. Everything here is defensive: unknown fields are
 * dropped, missing arrays default to empty, and a malformed shape degrades to a
 * safe default rather than throwing.
 */
const asArray = (v) => (Array.isArray(v) ? v : []);
const asString = (v) => (typeof v === 'string' ? v : undefined);
/** v1 passthrough today; the hook for future per-file schema upgraders. */
function upgrade(_domain, raw) {
    return raw;
}
/**
 * Coerce a parsed JSON value into the expected domain shape (never throws).
 * Returns null only when the input isn't an object at all.
 */
function parseDomain(domain, raw) {
    if (raw == null || typeof raw !== 'object')
        return null;
    const o = raw;
    const version = typeof o.version === 'number' ? o.version : types_1.PROJECT_SETTINGS_FILE_VERSION;
    switch (domain) {
        case 'settings':
            return {
                version,
                name: asString(o.name),
                color: asString(o.color),
                emoji: asString(o.emoji),
                layout: o.layout,
                editorCommand: asString(o.editorCommand),
            };
        case 'browser':
            return {
                version,
                url: asString(o.url),
                tabs: asArray(o.tabs),
                activeTabId: o.activeTabId ?? null,
                worktreeUrls: o.worktreeUrls || undefined,
                bookmarks: asArray(o.bookmarks),
            };
        case 'database':
            return { version, connections: asArray(o.connections), activeConnectionId: o.activeConnectionId ?? null };
        case 'http':
            return {
                version,
                tabs: asArray(o.tabs),
                environments: asArray(o.environments),
                activeEnvironmentId: o.activeEnvironmentId ?? null,
            };
        case 'deploy':
            return { version, activeProvider: o.activeProvider || 'vercel', configs: o.configs || {} };
        case 'env':
            return { version, activeFile: asString(o.activeFile), declaredKeys: asArray(o.declaredKeys) };
        case 'agents':
            return {
                version,
                defaultAgent: o.defaultAgent,
                startupCommand: asString(o.startupCommand),
                lsp: o.lsp,
                presets: asArray(o.presets),
            };
        case 'channels':
            return { version, templates: asArray(o.templates) };
        case 'prompts':
            return { version, templates: asArray(o.templates) };
        case 'layouts':
            return { version, presets: asArray(o.presets) };
        case 'tasks': {
            // Coerced key by key against TASKS_CONFIG_DEFAULTS: a cloned file that
            // says `onTimeout: "approve"` or ships a hostile shape degrades to the
            // safe default rather than widening anything (docs/tasks_v2.md §5.1).
            // Approval is still required before ANY of this applies — this only makes
            // the held value well-formed and summarizable.
            const gates = (o.gates || {});
            const asBool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
            return {
                version,
                gates: {
                    spec: asBool(gates.spec, tasks_1.TASKS_CONFIG_DEFAULTS.gates.spec),
                    plan: asBool(gates.plan, tasks_1.TASKS_CONFIG_DEFAULTS.gates.plan),
                    done: asBool(gates.done, tasks_1.TASKS_CONFIG_DEFAULTS.gates.done),
                },
                gateTimeoutMs: typeof o.gateTimeoutMs === 'number' && o.gateTimeoutMs > 0
                    ? o.gateTimeoutMs
                    : tasks_1.TASKS_CONFIG_DEFAULTS.gateTimeoutMs,
                // 'approve' deliberately does not exist — silence is never consent.
                onTimeout: o.onTimeout === 'decline' ? 'decline' : 'block',
                definitionOfDone: asArray(o.definitionOfDone).filter((s) => typeof s === 'string'),
                crossProjectWrites: asBool(o.crossProjectWrites, false),
                gitTracked: asBool(o.gitTracked, true),
                ...(typeof o.migratedFromV1 === 'boolean' ? { migratedFromV1: o.migratedFromV1 } : {}),
                ...(Array.isArray(o.labelVocabulary) ? { labelVocabulary: o.labelVocabulary } : {}),
                ...(typeof o.defaultSwimlane === 'string'
                    ? { defaultSwimlane: o.defaultSwimlane }
                    : {}),
            };
        }
        default:
            return { version };
    }
}
/** Short human-readable summary of a domain's config for the review sheet / status. */
function summarize(domain, value) {
    const o = (value || {});
    const n = (v) => (Array.isArray(v) ? v.length : 0);
    const plural = (count, one) => `${count} ${one}${count === 1 ? '' : 's'}`;
    switch (domain) {
        case 'settings':
            return 'General project settings';
        case 'browser': {
            const tabs = n(o.tabs);
            if (tabs > 1)
                return `${plural(tabs, 'tab')}${o.url ? ` · start ${o.url}` : ''}`;
            return o.url ? `Start URL ${o.url}` : 'Browser settings';
        }
        case 'database':
            return plural(n(o.connections), 'connection');
        case 'http': {
            const reqs = n(o.tabs);
            const envs = n(o.environments);
            return `${plural(reqs, 'request')} · ${plural(envs, 'environment')}`;
        }
        case 'deploy':
            return `Deploy config${o.activeProvider ? ` · ${o.activeProvider}` : ''}`;
        case 'env':
            return o.activeFile ? `Env file ${o.activeFile}` : 'Env settings';
        case 'agents': {
            const parts = [];
            if (o.startupCommand)
                parts.push(`startup "${o.startupCommand}"`);
            const presets = n(o.presets);
            if (presets)
                parts.push(plural(presets, 'agent preset'));
            return parts.join(' · ') || 'Agent config';
        }
        case 'channels':
            return plural(n(o.templates), 'channel template');
        case 'prompts':
            return plural(n(o.templates), 'prompt template');
        case 'layouts':
            return plural(n(o.presets), 'layout preset');
        case 'skills':
            return 'Skills';
        case 'tasks': {
            const gates = (o.gates || {});
            const on = ['spec', 'plan', 'done'].filter((k) => gates[k] === true);
            const parts = [on.length ? `gates ${on.join('+')}` : 'no approval gates'];
            if (o.crossProjectWrites === true)
                parts.push('cross-project writes ALLOWED');
            if (o.onTimeout === 'decline')
                parts.push('decline on timeout');
            return `Task policy · ${parts.join(' · ')}`;
        }
        default:
            return domain;
    }
}
