"use strict";
/**
 * Best-effort email extraction from raw CLI auth payloads.
 *
 * We intentionally never fail hard here — a missing email just means the
 * Accounts row renders only the user-provided label, which is fine.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractClaudeEmail = extractClaudeEmail;
exports.extractCodexEmail = extractCodexEmail;
exports.extractGeminiEmail = extractGeminiEmail;
exports.extractQwenEmail = extractQwenEmail;
exports.extractOpencodeEmail = extractOpencodeEmail;
function decodeJwtPayload(token) {
    const parts = token.split(".");
    if (parts.length < 2)
        return null;
    try {
        const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
        const json = Buffer.from(padded, "base64").toString("utf8");
        return JSON.parse(json);
    }
    catch {
        return null;
    }
}
function emailFromJwt(token) {
    if (!token)
        return undefined;
    const payload = decodeJwtPayload(String(token));
    if (!payload)
        return undefined;
    const email = payload["email"];
    return typeof email === "string" ? email : undefined;
}
function looksLikeEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
function findFirstEmail(value, seen = new Set()) {
    if (!value)
        return undefined;
    if (typeof value === "string") {
        return looksLikeEmail(value) ? value : undefined;
    }
    if (typeof value !== "object")
        return undefined;
    if (seen.has(value))
        return undefined;
    seen.add(value);
    if (Array.isArray(value)) {
        for (const item of value) {
            const found = findFirstEmail(item, seen);
            if (found)
                return found;
        }
        return undefined;
    }
    for (const [key, nested] of Object.entries(value)) {
        if (typeof nested === "string" &&
            key.toLowerCase().includes("email") &&
            looksLikeEmail(nested)) {
            return nested;
        }
        const found = findFirstEmail(nested, seen);
        if (found)
            return found;
    }
    return undefined;
}
function extractClaudeEmail(raw) {
    try {
        const parsed = JSON.parse(raw);
        const oauth = parsed["claudeAiOauth"];
        if (oauth && typeof oauth["accountEmail"] === "string")
            return oauth["accountEmail"];
        const access = oauth?.["accessToken"];
        if (typeof access === "string")
            return emailFromJwt(access);
        const topEmail = parsed["email"];
        if (typeof topEmail === "string")
            return topEmail;
    }
    catch {
        // fall through
    }
    return undefined;
}
function extractCodexEmail(raw) {
    try {
        const parsed = JSON.parse(raw);
        const tokens = parsed["tokens"];
        const idToken = tokens?.["id_token"];
        if (typeof idToken === "string")
            return emailFromJwt(idToken);
    }
    catch {
        // fall through
    }
    return undefined;
}
function extractGeminiEmail(rawOauth, rawGoogleAccounts) {
    try {
        const parsed = JSON.parse(rawOauth);
        const idToken = parsed["id_token"];
        if (typeof idToken === "string") {
            const email = emailFromJwt(idToken);
            if (email)
                return email;
        }
    }
    catch {
        // fall through
    }
    if (rawGoogleAccounts) {
        try {
            const parsed = JSON.parse(rawGoogleAccounts);
            const keys = Object.keys(parsed);
            for (const k of keys) {
                const v = parsed[k];
                if (typeof v === "string" && v.includes("@"))
                    return v;
                if (v && typeof v === "object") {
                    const email = v["email"];
                    if (typeof email === "string")
                        return email;
                }
            }
            if (keys.length > 0 && keys[0].includes("@"))
                return keys[0];
        }
        catch {
            // ignore
        }
    }
    return undefined;
}
function extractQwenEmail(raw) {
    try {
        const parsed = JSON.parse(raw);
        const idToken = parsed["id_token"];
        if (typeof idToken === "string")
            return emailFromJwt(idToken);
        const email = parsed["email"];
        if (typeof email === "string")
            return email;
    }
    catch {
        // fall through
    }
    return undefined;
}
function extractOpencodeEmail(raw) {
    try {
        const parsed = JSON.parse(raw);
        return findFirstEmail(parsed);
    }
    catch {
        return undefined;
    }
}
