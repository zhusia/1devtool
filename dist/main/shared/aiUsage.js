"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EMPTY_TOTALS = exports.SESSION_USAGE_MAX_FILTER_IDS = exports.SESSION_USAGE_MAX_ROWS = void 0;
/** Row cap for {@link SessionUsageSummary} — newest sessions win. */
exports.SESSION_USAGE_MAX_ROWS = 4000;
/** Cap on `sessionIds`; beyond this the filter is dropped (cap still applies). */
exports.SESSION_USAGE_MAX_FILTER_IDS = 1000;
exports.EMPTY_TOTALS = {
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsd: 0,
};
