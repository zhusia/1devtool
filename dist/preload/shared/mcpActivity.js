"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MCP_ACTIVITY_PREVIEW_MAX_CHARS = exports.MCP_ACTIVITY_DEFAULT_QUERY_LIMIT = exports.MCP_ACTIVITY_QUERY_LIMIT = exports.MCP_ACTIVITY_HISTORY_LIMIT = void 0;
exports.createMcpActivityPreview = createMcpActivityPreview;
exports.truncateMcpActivityError = truncateMcpActivityError;
exports.MCP_ACTIVITY_HISTORY_LIMIT = 500;
exports.MCP_ACTIVITY_QUERY_LIMIT = 500;
exports.MCP_ACTIVITY_DEFAULT_QUERY_LIMIT = 100;
exports.MCP_ACTIVITY_PREVIEW_MAX_CHARS = 6_000;
const SENSITIVE_KEY = /(?:password|passphrase|secret|token|authorization|cookie|credential|api[-_]?key|private[-_]?key)/i;
const BASE64_PREFIX = /^(?:data:[^;,]+;base64,)?[A-Za-z0-9+/_=-]{512}/;
const MAX_DEPTH = 5;
const MAX_OBJECT_KEYS = 40;
const MAX_ARRAY_ITEMS = 30;
const MAX_STRING_CHARS = 4_000;
function truncateText(value, maxChars) {
    if (value.length <= maxChars)
        return value;
    return `${value.slice(0, maxChars)}… [${value.length - maxChars} chars omitted]`;
}
function sanitizeValue(value, seen, depth, key = '') {
    if (SENSITIVE_KEY.test(key))
        return '[redacted]';
    if (value == null || typeof value === 'number' || typeof value === 'boolean')
        return value;
    if (typeof value === 'bigint')
        return value.toString();
    if (typeof value === 'string') {
        if ((key === 'data' || key === 'image' || key === 'imageData') && value.length > 1_024 && BASE64_PREFIX.test(value)) {
            return `[binary payload omitted: ${value.length.toLocaleString()} chars]`;
        }
        return truncateText(value, MAX_STRING_CHARS);
    }
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'undefined') {
        return `[${typeof value}]`;
    }
    if (depth >= MAX_DEPTH)
        return '[depth limit]';
    if (typeof value !== 'object')
        return String(value);
    if (seen.has(value))
        return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) {
        const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, seen, depth + 1));
        if (value.length > MAX_ARRAY_ITEMS)
            items.push(`[${value.length - MAX_ARRAY_ITEMS} items omitted]`);
        return items;
    }
    const source = value;
    const entries = Object.entries(source);
    const result = {};
    for (const [entryKey, entryValue] of entries.slice(0, MAX_OBJECT_KEYS)) {
        result[entryKey] = sanitizeValue(entryValue, seen, depth + 1, entryKey);
    }
    if (entries.length > MAX_OBJECT_KEYS) {
        result.__omittedKeys = entries.length - MAX_OBJECT_KEYS;
    }
    return result;
}
/**
 * Produce a JSON-cloneable, secret-redacted and size-bounded diagnostic view.
 * The live MCP result is never modified; this preview is only for activity UI
 * and persistence.
 */
function createMcpActivityPreview(value) {
    const sanitized = sanitizeValue(value, new WeakSet(), 0);
    let serialized;
    try {
        serialized = JSON.stringify(sanitized);
    }
    catch {
        return '[unserializable payload]';
    }
    if (serialized.length <= exports.MCP_ACTIVITY_PREVIEW_MAX_CHARS)
        return sanitized;
    return {
        __truncated: true,
        originalCharacters: serialized.length,
        preview: serialized.slice(0, exports.MCP_ACTIVITY_PREVIEW_MAX_CHARS),
    };
}
function truncateMcpActivityError(error) {
    return error == null ? undefined : truncateText(error, exports.MCP_ACTIVITY_PREVIEW_MAX_CHARS);
}
