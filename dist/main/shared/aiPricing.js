"use strict";
// Usage pricing in USD per 1M tokens.
// Schemas ported from github.com/ryoppippi/ccusage (commit c. 2026-03-10,
// v18.0.10). Prices are a frozen snapshot — update on each release.
//
// Unknown models fall back to $0 so the UI can still display raw token totals
// without misleading cost numbers.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MODEL_PRICING = exports.PRICING_VERSION = void 0;
exports.lookupPricing = lookupPricing;
exports.costFor = costFor;
exports.PRICING_VERSION = '2026-04-19';
exports.MODEL_PRICING = {
    // Anthropic — Claude Code
    'claude-opus-4-7': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    'claude-opus-4-6': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    'claude-haiku-4-5': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
    'claude-3-5-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
    // OpenAI — Codex CLI (list prices; actual model depends on user config)
    'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125 },
    'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025 },
    'gpt-5-nano': { input: 0.05, output: 0.4, cacheRead: 0.005 },
    'gpt-4.1': { input: 2, output: 8, cacheRead: 0.5 },
    'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25 },
    'o4-mini': { input: 1.1, output: 4.4 },
    'o3': { input: 2, output: 8 },
    // Google — Gemini CLI
    'gemini-3-pro': { input: 2, output: 12 },
    'gemini-3-flash-preview': { input: 0.3, output: 2.5 },
    'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.31 },
    'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheRead: 0.075 },
    // Alibaba — Qwen. Qwen-OAuth is a free subscription plan, so list as $0 to
    // reflect what the user actually pays through the CLI.
    'coder-model': { input: 0, output: 0 },
    'qwen-3-coder-plus': { input: 0, output: 0 },
};
/**
 * Longest-first prefix keys, sorted ONCE.
 *
 * This lookup runs per usage record — hundreds of thousands of times on a busy
 * machine — and real model ids are dated (`claude-opus-4-6-20260410`), so the
 * exact-match fast path misses every time. Sorting the key list inside the
 * function meant allocating and sorting an array per record.
 */
const PREFIX_KEYS = Object.keys(exports.MODEL_PRICING).sort((a, b) => b.length - a.length);
/** Resolved ids (hits and misses alike) — a miss must not re-scan every time. */
const pricingCache = new Map();
function lookupPricing(modelId) {
    if (!modelId)
        return null;
    const direct = exports.MODEL_PRICING[modelId];
    if (direct)
        return direct;
    const cached = pricingCache.get(modelId);
    if (cached !== undefined)
        return cached;
    // Prefix match handles dated IDs (e.g. `claude-opus-4-6-20260410`). Longest
    // key first so `claude-opus-4-6` wins over `claude-opus-4`.
    let resolved = null;
    for (const key of PREFIX_KEYS) {
        if (modelId.startsWith(key)) {
            resolved = exports.MODEL_PRICING[key];
            break;
        }
    }
    pricingCache.set(modelId, resolved);
    return resolved;
}
function costFor(modelId, tokens) {
    const p = lookupPricing(modelId);
    if (!p)
        return 0;
    const M = 1_000_000;
    let cost = (tokens.input * p.input) / M + (tokens.output * p.output) / M;
    if (p.cacheRead)
        cost += (tokens.cacheRead * p.cacheRead) / M;
    if (p.cacheWrite)
        cost += (tokens.cacheCreate * p.cacheWrite) / M;
    if (p.reasoning && tokens.reasoning)
        cost += (tokens.reasoning * p.reasoning) / M;
    return cost;
}
