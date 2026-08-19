"use strict";
/**
 * Lazy, disk-cached catalog of selectable models per delegate agent.
 *
 * Static curated lists come from `src/shared/agentModels.ts`; agents with a
 * `listArgs` enumeration command (OpenCode) are probed via execFile the first
 * time the catalog is requested (mention picker opening) and the result is
 * cached to `~/.1devtool/state/agent-models.json` with a TTL. Settings →
 * AI → Orchestration exposes a manual refresh that forces a re-probe.
 *
 * Best-effort throughout: a failed probe falls back to the static list (or
 * the last good cached probe) and reports `error` — never throws.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAgentModelsCachePath = getAgentModelsCachePath;
exports.getDefaultCodexHome = getDefaultCodexHome;
exports.getAgentModelCatalog = getAgentModelCatalog;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const agentModels_1 = require("../../shared/agentModels");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_BUFFER = 1024 * 1024;
function getAgentModelsCachePath() {
    return path_1.default.join(os_1.default.homedir(), '.1devtool', 'state', 'agent-models.json');
}
function readCacheFile() {
    try {
        const raw = fs_1.default.readFileSync(getAgentModelsCachePath(), 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.version === 1 && parsed.agents && typeof parsed.agents === 'object') {
            return parsed;
        }
    }
    catch { /* missing/corrupt cache → start fresh */ }
    return { version: 1, agents: {} };
}
function writeCacheFile(cache) {
    try {
        const target = getAgentModelsCachePath();
        fs_1.default.mkdirSync(path_1.default.dirname(target), { recursive: true });
        const tmp = `${target}.tmp`;
        fs_1.default.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf-8');
        fs_1.default.renameSync(tmp, target);
    }
    catch { /* best-effort */ }
}
function probeModels(binaryPath, listArgs, opts = {}) {
    const parse = opts.parse ?? agentModels_1.parseModelListOutput;
    return new Promise((resolve, reject) => {
        (0, child_process_1.execFile)(binaryPath, listArgs, {
            timeout: PROBE_TIMEOUT_MS,
            maxBuffer: PROBE_MAX_BUFFER,
            windowsHide: true,
            env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...opts.env },
        }, (error, stdout) => {
            if (error && !stdout) {
                reject(error instanceof Error ? error : new Error(String(error)));
                return;
            }
            const models = parse(typeof stdout === 'string' ? stdout : '');
            if (models.length === 0) {
                reject(new Error('model list command produced no parseable model ids'));
                return;
            }
            resolve(models);
        });
    });
}
/**
 * Codex keeps its ACCOUNT-entitled model list (fetched from the backend by
 * the codex CLI itself) in `<codexHome>/models_cache.json` — slugs, display
 * names, visibility, priority, and per-model reasoning levels. Reading it is
 * the only way to offer models this login can actually use; any curated list
 * drifts (a ChatGPT-auth account rejecting `gpt-5.3-codex` is exactly how
 * this surfaced). File read is cheap, so it runs on every catalog request —
 * no TTL; codex refreshes the file whenever it runs.
 */
function readCodexModelsFile(codexHome) {
    const file = path_1.default.join(codexHome, 'models_cache.json');
    const raw = fs_1.default.readFileSync(file, 'utf-8');
    const models = (0, agentModels_1.parseCodexModelsCache)(raw);
    if (models.length === 0)
        return null;
    let fetchedAt = Date.now();
    try {
        fetchedAt = fs_1.default.statSync(file).mtimeMs;
    }
    catch { /* keep now() */ }
    return { models, fetchedAt };
}
function getDefaultCodexHome() {
    return process.env.CODEX_HOME || path_1.default.join(os_1.default.homedir(), '.codex');
}
/** Cline settings dir, mirroring the env precedence its storage package (and
 *  our resume scanner) honor: CLINE_DATA_DIR → <dir>/settings, CLINE_DIR →
 *  <dir>/data/settings, default ~/.cline/data/settings. */
function getClineSettingsDir() {
    const dataDir = process.env.CLINE_DATA_DIR?.trim();
    if (dataDir)
        return path_1.default.join(path_1.default.resolve(dataDir), 'settings');
    const clineDir = process.env.CLINE_DIR?.trim();
    const root = clineDir ? path_1.default.resolve(clineDir) : path_1.default.join(os_1.default.homedir(), '.cline');
    return path_1.default.join(root, 'data', 'settings');
}
/** Cline can't enumerate its provider catalog, but the models the user
 *  configured per provider are recorded locally — those are guaranteed-valid
 *  values for `cline --model`. */
function readClineConfiguredModels() {
    const file = path_1.default.join(getClineSettingsDir(), 'providers.json');
    const raw = fs_1.default.readFileSync(file, 'utf-8');
    const models = (0, agentModels_1.parseClineProvidersConfig)(raw);
    if (models.length === 0)
        return null;
    let fetchedAt = Date.now();
    try {
        fetchedAt = fs_1.default.statSync(file).mtimeMs;
    }
    catch { /* keep now() */ }
    return { models, fetchedAt };
}
/** In-flight probe dedupe: mention-picker open + settings refresh racing must
 *  not double-spawn the same CLI / double-hit the same API. */
const inflightProbes = new Map();
function probeAndCache(agentId, producer) {
    const existing = inflightProbes.get(agentId);
    if (existing)
        return existing;
    const promise = producer()
        .then((models) => {
        const probe = { models, fetchedAt: Date.now() };
        const cache = readCacheFile();
        cache.agents[agentId] = probe;
        writeCacheFile(cache);
        return probe;
    })
        .finally(() => { inflightProbes.delete(agentId); });
    inflightProbes.set(agentId, promise);
    return promise;
}
/** Shared TTL/disk-cache/error flow for probed sources (CLI spawn or provider
 *  API). Falls back to the last good cached probe on failure, then static. */
async function resolveViaCachedProbe(agentId, base, cache, refresh, source, producer) {
    const cached = cache.agents[agentId];
    const fresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS;
    if (cached && fresh && !refresh) {
        return { ...base, models: cached.models, source, fetchedAt: cached.fetchedAt };
    }
    try {
        const probe = await probeAndCache(agentId, producer);
        return { ...base, models: probe.models, source, fetchedAt: probe.fetchedAt };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Stale probe beats the curated fallback — it at least reflects this install.
        if (cached) {
            return { ...base, models: cached.models, source, fetchedAt: cached.fetchedAt, error: message };
        }
        return { ...base, error: message };
    }
}
const API_PROBE_TIMEOUT_MS = 10_000;
/** GET with a hard timeout. API keys ride in headers only — they must never
 *  appear in thrown messages (which surface in the Settings UI). */
async function fetchText(url, headers, timeoutMs = API_PROBE_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { headers, signal: controller.signal });
        if (!res.ok)
            throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
        return await res.text();
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * models.dev api.json — free, keyless catalog of canonical provider model ids
 * (see parseModelsDevProvider). ~3MB, so the raw JSON is memoized in-process:
 * one refresh must not fetch it once per agent. The per-agent disk cache
 * handles cross-launch reuse; `force` (Settings refresh) bypasses the memo.
 */
let modelsDevMemo = null;
let modelsDevInflight = null;
function getModelsDevJson(force) {
    if (!force && modelsDevMemo && Date.now() - modelsDevMemo.at < CACHE_TTL_MS) {
        return Promise.resolve(modelsDevMemo.raw);
    }
    if (modelsDevInflight)
        return modelsDevInflight;
    modelsDevInflight = fetchText('https://models.dev/api.json', {}, 20_000)
        .then((raw) => {
        modelsDevMemo = { raw, at: Date.now() };
        return raw;
    })
        .finally(() => { modelsDevInflight = null; });
    return modelsDevInflight;
}
/** Keyless discovery via models.dev, curated/alias entries kept first. */
async function probeModelsDev(providerId, curated, force, filter = {}) {
    const raw = await getModelsDevJson(force);
    const discovered = (0, agentModels_1.parseModelsDevProvider)(raw, providerId, filter);
    if (discovered.length === 0)
        throw new Error(`models.dev has no models for provider "${providerId}"`);
    const curatedIds = new Set(curated.map((m) => m.id));
    return [...curated, ...discovered.filter((m) => !curatedIds.has(m.id))];
}
/** Anthropic /v1/models — discovery of valid full ids for `claude --model`.
 *  Aliases stay first: they're entitlement-safe; the API key's realm can
 *  differ from the CLI's Max/Pro login. */
async function probeAnthropicModels(apiKey, aliases) {
    const raw = await fetchText('https://api.anthropic.com/v1/models?limit=1000', {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
    });
    const apiModels = (0, agentModels_1.parseAnthropicModelsResponse)(raw);
    if (apiModels.length === 0)
        throw new Error('Anthropic models API returned no models');
    const aliasIds = new Set(aliases.map((m) => m.id));
    return [...aliases, ...apiModels.filter((m) => !aliasIds.has(m.id))];
}
/** Google generativelanguage /v1beta/models (paginated). */
async function probeGeminiModels(apiKey, curated) {
    const seen = new Set(curated.map((m) => m.id));
    const merged = [...curated];
    let pageToken = '';
    for (let page = 0; page < 5; page++) {
        const url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200' +
            (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
        const raw = await fetchText(url, { 'x-goog-api-key': apiKey });
        for (const model of (0, agentModels_1.parseGeminiModelsResponse)(raw)) {
            if (seen.has(model.id))
                continue;
            seen.add(model.id);
            merged.push(model);
        }
        pageToken = JSON.parse(raw).nextPageToken ?? '';
        if (!pageToken)
            break;
    }
    if (merged.length === curated.length)
        throw new Error('Gemini models API returned no models');
    return merged;
}
/**
 * Resolve the model catalog for the given detected CLI registrations.
 *
 * `refresh: true` forces a re-probe of every enumerable agent; otherwise a
 * probe only runs when there is no cached result younger than the TTL
 * (lazy-load-on-first-use). `codexHome` lets the caller honor the app's
 * AI-path override for codex (defaults to $CODEX_HOME / ~/.codex).
 */
async function getAgentModelCatalog(registrations, opts = {}) {
    const refresh = opts.refresh === true;
    const cache = readCacheFile();
    const detected = registrations.filter((r) => (r.state === 'detected' || r.state === 'override') && agentModels_1.AGENT_MODEL_SPECS[r.cliId]);
    const entries = await Promise.all(detected.map(async (reg) => {
        const spec = agentModels_1.AGENT_MODEL_SPECS[reg.cliId];
        const base = {
            agentId: reg.cliId,
            modelFlag: spec.modelFlag,
            models: spec.staticModels,
            source: 'static',
        };
        if (reg.cliId === 'codex') {
            try {
                const fromFile = readCodexModelsFile(opts.codexHome || getDefaultCodexHome());
                if (fromFile) {
                    return { ...base, models: fromFile.models, source: 'cli', fetchedAt: fromFile.fetchedAt };
                }
                return { ...base, error: 'models_cache.json has no listable models — run codex once to refresh it' };
            }
            catch (error) {
                // Cache file missing/corrupt (codex never run on this machine) —
                // static fallback with the reason surfaced in Settings.
                const message = error instanceof Error ? error.message : String(error);
                return { ...base, error: message };
            }
        }
        if (reg.cliId === 'cline') {
            try {
                const fromConfig = readClineConfiguredModels();
                if (fromConfig) {
                    return { ...base, models: fromConfig.models, source: 'config', fetchedAt: fromConfig.fetchedAt };
                }
                return { ...base, error: 'no models configured — run `cline auth` to pick a provider/model' };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return { ...base, error: message };
            }
        }
        // Provider model discovery. An env API key is preferred (that account's
        // own list); otherwise the free keyless models.dev catalog fills in the
        // provider's canonical ids. Curated aliases always stay first — neither
        // source knows what the CLI's OAuth login is actually entitled to.
        if (reg.cliId === 'claude') {
            const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
            return resolveViaCachedProbe(reg.cliId, base, cache, refresh, 'api', apiKey
                ? () => probeAnthropicModels(apiKey, spec.staticModels)
                : () => probeModelsDev('anthropic', spec.staticModels, refresh));
        }
        if (reg.cliId === 'gemini') {
            const apiKey = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
            return resolveViaCachedProbe(reg.cliId, base, cache, refresh, 'api', apiKey
                ? () => probeGeminiModels(apiKey, spec.staticModels)
                : () => probeModelsDev('google', spec.staticModels, refresh, { idPrefix: 'gemini', requireToolCall: true }));
        }
        // Pi prints a whitespace-aligned table, not one id per line, so it needs
        // its own parser. PI_OFFLINE keeps the probe from doing a catalog refresh
        // or update check while the user waits on a Settings list.
        if (reg.cliId === 'pi' && spec.listArgs && reg.selectedPath) {
            const piArgs = spec.listArgs;
            const piBinary = reg.selectedPath;
            return resolveViaCachedProbe(reg.cliId, base, cache, refresh, 'cli', () => probeModels(piBinary, piArgs, { parse: agentModels_1.parsePiModelListOutput, env: { PI_OFFLINE: '1' } }));
        }
        if (!spec.listArgs || !reg.selectedPath)
            return base;
        const listArgs = spec.listArgs;
        const binaryPath = reg.selectedPath;
        return resolveViaCachedProbe(reg.cliId, base, cache, refresh, 'cli', () => probeModels(binaryPath, listArgs));
    }));
    return { agents: entries };
}
