"use strict";
// Deterministic JSON canonicalization — Workstream A / roadmap #8, phase P0.
// See docs/product/strategy/licensing-updates-monetization.md §4.1: "Signature is over canonical
// (deterministic-key-order) JSON bytes. Both signer and verifier must use the
// IDENTICAL canonicalization or verification is a coin flip. Write this once,
// share it." This is that once — imported by both sign.ts and verify.ts.
//
// Guarantees, for any value with the same logical content:
//   - object keys are emitted in sorted (Unicode code-unit) order, recursively,
//     so `{a,b}` and `{b,a}` produce byte-identical output;
//   - `undefined`-valued object properties are dropped (JSON has no undefined);
//   - arrays keep their order (order is semantically meaningful);
//   - primitives use JSON.stringify, so string escaping matches the parser.
// It intentionally REJECTS values JSON cannot round-trip losslessly
// (non-finite numbers, bigint, functions, symbols) so signer/verifier can never
// silently disagree.
Object.defineProperty(exports, "__esModule", { value: true });
exports.canonicalize = canonicalize;
exports.canonicalBytes = canonicalBytes;
function serialize(value) {
    if (value === null)
        return 'null';
    const t = typeof value;
    if (t === 'string' || t === 'boolean')
        return JSON.stringify(value);
    if (t === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error('canonicalize: cannot serialize non-finite number');
        }
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return '[' + value.map((item) => serialize(item)).join(',') + ']';
    }
    if (t === 'object') {
        const obj = value;
        const keys = Object.keys(obj)
            .filter((k) => obj[k] !== undefined)
            .sort();
        const body = keys
            .map((k) => JSON.stringify(k) + ':' + serialize(obj[k]))
            .join(',');
        return '{' + body + '}';
    }
    throw new Error(`canonicalize: cannot serialize value of type ${t}`);
}
/** Deterministic string form of `value` (stable key order, recursive). */
function canonicalize(value) {
    return serialize(value);
}
/** UTF-8 bytes of the canonical form — the exact bytes that get signed/verified. */
function canonicalBytes(value) {
    return Buffer.from(canonicalize(value), 'utf8');
}
