"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mapWithConcurrency = mapWithConcurrency;
/**
 * Map an array through a fixed-size worker pool while preserving input order.
 *
 * AI usage directories can contain thousands of session files. Unbounded
 * Promise.all() would make cold scans contend for file descriptors and memory,
 * while a serial loop leaves most filesystem latency on the table.
 */
async function mapWithConcurrency(items, limit, mapper) {
    if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError('Concurrency limit must be a positive integer');
    }
    if (items.length === 0)
        return [];
    const results = new Array(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await mapper(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}
