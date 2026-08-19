"use strict";
/**
 * Per-agent model selection for orchestration delegation.
 *
 * Maps each delegate agent (keys of HEADLESS_SPECS) to the CLI flag that
 * selects a model plus a curated list of known model ids. Curated lists are a
 * FALLBACK — agents with a `listArgs` enumeration command (OpenCode's
 * `opencode models`) are probed lazily by the main-process catalog
 * (`src/main/orchestration/agentModelCatalog.ts`) and the probed list
 * replaces the static one. Users refresh via Settings → AI → Orchestration.
 *
 * Every id here is passed verbatim as the value of `modelFlag` via execFile
 * (never a shell), e.g. `claude --model sonnet`, `opencode run … --model
 * opencode/claude-sonnet-5`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CODEX_REASONING_EFFORTS = exports.MODEL_ID_RE = exports.AGENT_MODEL_SPECS = void 0;
exports.isValidModelId = isValidModelId;
exports.splitCodexModelEffort = splitCodexModelEffort;
exports.buildModelFlags = buildModelFlags;
exports.parseModelListOutput = parseModelListOutput;
exports.parsePiModelListOutput = parsePiModelListOutput;
exports.parseCodexModelsCache = parseCodexModelsCache;
exports.parseClineProvidersConfig = parseClineProvidersConfig;
exports.parseAnthropicModelsResponse = parseAnthropicModelsResponse;
exports.parseGeminiModelsResponse = parseGeminiModelsResponse;
exports.parseModelsDevProvider = parseModelsDevProvider;
/** Keys mirror HEADLESS_SPECS (the `--to=` targets). Agents without a model
 *  flag (amp) are intentionally absent — `--model` is rejected for them. */
exports.AGENT_MODEL_SPECS = {
    claude: {
        modelFlag: '--model',
        // Aliases resolve to the latest model of each family (per `claude --help`),
        // so this list never goes stale the way full ids would.
        staticModels: [
            { id: 'fable', label: 'Fable (latest)' },
            { id: 'opus', label: 'Opus' },
            { id: 'sonnet', label: 'Sonnet' },
            { id: 'haiku', label: 'Haiku' },
        ],
    },
    codex: {
        // Real models come from Codex's own account-entitlement cache
        // (`<codexHome>/models_cache.json`, parsed by parseCodexModelsCache) —
        // the main catalog reads it on every request. This static list is only
        // the fallback when that cache doesn't exist yet (codex never run).
        modelFlag: '--model',
        staticModels: [
            { id: 'gpt-5.5' },
            { id: 'gpt-5.4' },
            { id: 'gpt-5.4-mini' },
        ],
    },
    gemini: {
        modelFlag: '--model',
        staticModels: [
            { id: 'gemini-3.1-pro' },
            { id: 'gemini-3.5-flash' },
            { id: 'gemini-3-flash' },
        ],
    },
    kimi: {
        modelFlag: '--model',
        // Kimi also accepts provider/model aliases from its config. Keep the
        // official coding model as the safe default and allow manual ids.
        staticModels: [
            { id: 'kimi-code/kimi-for-coding', label: 'Kimi for Coding' },
        ],
    },
    agy: {
        // Antigravity CLI 1.1.10 validates --model in both print and interactive
        // modes ("invalid model selection" + the model list on a garbage id —
        // verified live), reversing the older builds that silently ignored it in
        // print mode. Ids are the slugs `agy models` prints one per line (effort
        // is baked into the slug: gemini-3.6-flash-high); the live probe replaces
        // this curated fallback.
        modelFlag: '--model',
        staticModels: [
            { id: 'gemini-3.6-flash-high' },
            { id: 'gemini-3.1-pro-high' },
            { id: 'claude-sonnet-4-6' },
            { id: 'claude-opus-4-6-thinking' },
        ],
        listArgs: ['models'],
    },
    cline: {
        // No curated list — cline's model space depends on the authenticated
        // provider. The main catalog surfaces the models the user configured in
        // `<clineData>/settings/providers.json` (parseClineProvidersConfig).
        modelFlag: '--model',
        staticModels: [],
    },
    opencode: {
        modelFlag: '--model',
        // `opencode models` prints one `provider/model` per line; the probed list
        // replaces these few well-known ids.
        staticModels: [
            { id: 'opencode/claude-sonnet-5' },
            { id: 'opencode/gpt-5.5' },
            { id: 'opencode/qwen3-coder' },
        ],
        listArgs: ['models'],
    },
    qwen: {
        // qwen-code has no CLI enumeration. Catalog matches @qwen-code/qwen-code
        // generateCodingPlanTemplate (china + international) plus the vision model
        // (qwen3-vl-plus) and coder-model / qwen3-coder-flash aliases that still
        // exist outside the plan templates. vision-model was removed upstream —
        // do not reintroduce it. qwen3.7-plus does not exist in the package.
        modelFlag: '--model',
        staticModels: [
            { id: 'coder-model', label: 'Coder (default alias)' },
            { id: 'qwen3.5-plus' },
            { id: 'qwen3.6-plus' },
            { id: 'qwen3-vl-plus', label: 'Vision (qwen3-vl-plus)' },
            { id: 'qwen3-coder-plus' },
            { id: 'qwen3-coder-next' },
            { id: 'qwen3-coder-flash' },
            { id: 'qwen3-max-2026-01-23' },
            { id: 'glm-5' },
            { id: 'glm-4.7' },
            { id: 'kimi-k2.5' },
            { id: 'MiniMax-M2.5' },
        ],
    },
    grok: {
        modelFlag: '--model',
        staticModels: [
            { id: 'grok-4.5' },
            { id: 'grok-code-fast-1' },
        ],
        // `grok models` prints a bulleted, annotated list — handled by the
        // tolerant parseModelListOutput.
        listArgs: ['models'],
    },
    hermes: {
        modelFlag: '--model',
        // Hermes accepts provider/model ids. The configured provider determines
        // which ids are valid, so keep this user-entered instead of guessing.
        staticModels: [],
    },
    cursor: {
        modelFlag: '--model',
        // Plain ids only. Cursor also accepts bracket overrides
        // (`claude-opus-4-8[context=1m,effort=high]`), but those characters are
        // deliberately outside MODEL_ID_RE — widening it to pass them through to
        // argv would weaken the smuggling guard for every agent.
        staticModels: [
            { id: 'auto', label: 'Auto' },
        ],
        // `cursor-agent --list-models` prints `<id> - <Label>` under an
        // `Available models` banner (needs an authed account; probing just yields
        // the static fallback when logged out).
        listArgs: ['--list-models'],
    },
    pi: {
        modelFlag: '--model',
        // Pi resolves `--model` against the providers the user has actually
        // configured, so a curated list would name ids this install may not be
        // entitled to. `pi --list-models` prints the real, per-install set as a
        // whitespace-aligned TABLE (not one id per line), so it is probed through
        // parsePiModelListOutput rather than the generic line parser — and the ids
        // are emitted as `provider/model`, the disambiguated form pi's own
        // `--model` accepts.
        staticModels: [],
        listArgs: ['--list-models'],
    },
    aider: {
        modelFlag: '--model',
        staticModels: [],
    },
};
/** Model ids ride into argv and (sanitized) into prompt text — restrict to the
 *  charset real ids use so a hostile cache/CLI line can't smuggle words. */
exports.MODEL_ID_RE = /^[A-Za-z0-9][\w.:/-]{0,127}$/;
function isValidModelId(id) {
    return exports.MODEL_ID_RE.test(id);
}
/** Reasoning levels Codex models support (from models_cache.json). A codex
 *  model id may carry one as a `:effort` suffix — `gpt-5.6-sol:xhigh` — which
 *  buildModelFlags translates to `-c model_reasoning_effort=xhigh`. */
exports.CODEX_REASONING_EFFORTS = new Set([
    'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
]);
/** Split `gpt-5.6-sol:xhigh` → { slug, effort }; null when the id has no
 *  recognised effort suffix (then the whole id is the model slug). */
function splitCodexModelEffort(modelId) {
    const idx = modelId.lastIndexOf(':');
    if (idx <= 0)
        return null;
    const effort = modelId.slice(idx + 1);
    if (!exports.CODEX_REASONING_EFFORTS.has(effort))
        return null;
    return { slug: modelId.slice(0, idx), effort };
}
/** argv that selects `modelId` for `agentId`, e.g. ['--model','sonnet'].
 *  Codex ids may carry a `:effort` suffix which maps to a config override
 *  (verified live: `codex exec -m gpt-5.6-sol -c model_reasoning_effort=xhigh`).
 *  Returns null when the agent has no model flag (amp) or the id is invalid. */
function buildModelFlags(agentId, modelId) {
    const spec = exports.AGENT_MODEL_SPECS[agentId];
    if (!spec || !modelId || !isValidModelId(modelId))
        return null;
    if (agentId === 'codex') {
        const split = splitCodexModelEffort(modelId);
        if (split) {
            return [spec.modelFlag, split.slug, '--config', `model_reasoning_effort=${split.effort}`];
        }
    }
    return [spec.modelFlag, modelId];
}
/** Parse a model-enumeration command's stdout (one model per line). Tolerates
 *  banners, bullets, and annotations: `grok models` prints
 *  `  * grok-4.5 (default)` / `  - grok-composer-2.5-fast` under headers like
 *  `Available models:`, and `cursor-agent --list-models` prints the labelled
 *  `gpt-5.3-codex-low - Codex 5.3 Low` form. Bullets and trailing
 *  parentheticals are stripped, an `<id> - <Label>` / `<id>: <Label>`
 *  annotation is split into id + label, and anything still containing spaces
 *  (prose, headers) is dropped. */
function parseModelListOutput(stdout) {
    const seen = new Set();
    const out = [];
    for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine
            .trim()
            .replace(/^[-*•·]\s+/, '')
            .replace(/\s*\([^)]*\)\s*$/, '');
        if (!line)
            continue;
        // Split on the FIRST separator only — model ids contain `-` and `:`
        // themselves, and the id side must be a single token, which is what keeps
        // prose like `Default model: grok-4.5` out.
        const annotated = /^(\S+)(?:\s+[-–—]\s+|:\s+)(\S.*)$/.exec(line);
        const id = annotated ? annotated[1] : line;
        const label = annotated ? annotated[2].trim() : '';
        if (id.includes(' ') || !isValidModelId(id))
            continue;
        if (seen.has(id))
            continue;
        seen.add(id);
        out.push(label && label !== id ? { id, label } : { id });
    }
    return out;
}
/**
 * Parse `pi --list-models` — a whitespace-aligned table, one model per row:
 *
 *   provider      model                        context  max-out  thinking  images
 *   anthropic     claude-fable-5               1M       128K     yes       yes
 *
 * The generic line parser drops every one of those rows (each still contains
 * spaces after bullet/annotation stripping), so pi gets its own. Columns are
 * split on runs of 2+ spaces; the header row and anything that is not a
 * two-column-or-wider row is skipped. Emits `provider/model`, which is the
 * unambiguous spelling `pi --model` accepts.
 */
function parsePiModelListOutput(stdout) {
    const seen = new Set();
    const out = [];
    for (const rawLine of stdout.split(/\r?\n/)) {
        const columns = rawLine.trim().split(/\s{2,}/);
        if (columns.length < 2)
            continue;
        const [provider, model] = columns;
        if (!provider || !model)
            continue;
        if (provider === 'provider' && model === 'model')
            continue;
        const id = `${provider}/${model}`;
        if (!isValidModelId(id))
            continue;
        if (seen.has(id))
            continue;
        seen.add(id);
        out.push({ id });
    }
    return out;
}
/**
 * Parse Codex's `<codexHome>/models_cache.json` — the account-entitlement
 * model list the Codex CLI fetches from its backend (so it reflects what THIS
 * login can actually use, unlike any curated list). Emits, per visible model
 * in priority order: the bare slug, then one `slug:effort` variant per
 * supported reasoning level other than the model's default.
 */
function parseCodexModelsCache(raw) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.models))
        return [];
    const visible = parsed.models
        .filter((m) => typeof m.slug === 'string' && isValidModelId(m.slug) && (m.visibility ?? 'list') === 'list')
        .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    const out = [];
    for (const model of visible) {
        const slug = model.slug;
        const label = model.display_name || slug;
        out.push({ id: slug, label });
        for (const level of model.supported_reasoning_levels ?? []) {
            const effort = level.effort;
            if (!effort || effort === model.default_reasoning_level || !exports.CODEX_REASONING_EFFORTS.has(effort))
                continue;
            out.push({ id: `${slug}:${effort}`, label: `${label} · ${effort}` });
        }
    }
    return out;
}
/**
 * Parse Cline's `<clineData>/settings/providers.json`. Cline has no model
 * enumeration (its catalog lives behind the authenticated provider), but the
 * file records the model the user configured per provider — surface those as
 * the selectable options for `cline --model`.
 */
function parseClineProvidersConfig(raw) {
    const parsed = JSON.parse(raw);
    if (!parsed.providers || typeof parsed.providers !== 'object')
        return [];
    const seen = new Set();
    const out = [];
    for (const [providerKey, provider] of Object.entries(parsed.providers)) {
        const model = provider?.settings?.model;
        if (typeof model !== 'string' || !isValidModelId(model) || seen.has(model))
            continue;
        seen.add(model);
        out.push({ id: model, label: `configured in cline (${providerKey})` });
    }
    return out;
}
/**
 * Parse Anthropic's `GET /v1/models` response (needs ANTHROPIC_API_KEY).
 * Note the API realm differs from a Claude-Max CLI login — treat results as
 * discovery of valid full ids, not entitlement truth; the CLI aliases stay
 * the safest picks and are listed first by the catalog.
 */
function parseAnthropicModelsResponse(raw) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.data))
        return [];
    const seen = new Set();
    const out = [];
    for (const model of parsed.data) {
        const id = model?.id;
        if (typeof id !== 'string' || !isValidModelId(id) || seen.has(id))
            continue;
        seen.add(id);
        out.push({ id, ...(model.display_name ? { label: model.display_name } : {}) });
    }
    return out;
}
/**
 * Parse Google's `GET /v1beta/models` response (needs GEMINI_API_KEY or
 * GOOGLE_API_KEY). Keeps generateContent-capable gemini-* chat models and
 * strips the `models/` resource prefix so ids match what `gemini -m` takes.
 */
function parseGeminiModelsResponse(raw) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.models))
        return [];
    const seen = new Set();
    const out = [];
    for (const model of parsed.models) {
        if (typeof model?.name !== 'string')
            continue;
        if (!model.supportedGenerationMethods?.includes('generateContent'))
            continue;
        const id = model.name.replace(/^models\//, '');
        if (!id.startsWith('gemini') || !isValidModelId(id) || seen.has(id))
            continue;
        seen.add(id);
        out.push({ id, ...(model.displayName ? { label: model.displayName } : {}) });
    }
    return out;
}
/**
 * Parse one provider's models out of models.dev's `api.json` — the free,
 * keyless, open-source model catalog (the same source OpenCode uses). Chosen
 * over OpenRouter because models.dev records each provider's CANONICAL ids
 * (`claude-opus-4-8`, not `anthropic/claude-opus-4.8`), which is what the
 * CLIs' `--model` flags accept. Newest first via release_date.
 */
function parseModelsDevProvider(raw, providerId, opts = {}) {
    const parsed = JSON.parse(raw);
    const models = parsed?.[providerId]?.models;
    if (!models || typeof models !== 'object')
        return [];
    const seen = new Set();
    const rows = [];
    for (const [key, model] of Object.entries(models)) {
        const id = typeof model?.id === 'string' && model.id ? model.id : key;
        if (!isValidModelId(id) || seen.has(id))
            continue;
        if (opts.idPrefix && !id.startsWith(opts.idPrefix))
            continue;
        if (opts.requireToolCall && model?.tool_call !== true)
            continue;
        seen.add(id);
        rows.push({
            option: { id, ...(model?.name ? { label: model.name } : {}) },
            releasedAt: typeof model?.release_date === 'string' ? model.release_date : '',
        });
    }
    rows.sort((a, b) => b.releasedAt.localeCompare(a.releasedAt));
    return rows.map((r) => r.option);
}
