"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mintLinkReadAuthorization = mintLinkReadAuthorization;
exports.consumeLinkReadAuthorization = consumeLinkReadAuthorization;
exports.resetLinkReadAuthorizationsForTests = resetLinkReadAuthorizationsForTests;
const node_crypto_1 = require("node:crypto");
const LINK_READ_AUTHORIZATION_TTL_MS = 5 * 60_000;
const LINK_READ_AUTHORIZATION_MAX_RECORDS = 256;
const authorizations = new Map();
function subjectKey(subject) {
    return subject.kind === 'link'
        ? `link:${subject.linkId}`
        : `request:${subject.requestId}`;
}
function prune(now = Date.now()) {
    for (const [token, record] of authorizations) {
        if (record.expiresAt <= now)
            authorizations.delete(token);
    }
    while (authorizations.size >= LINK_READ_AUTHORIZATION_MAX_RECORDS) {
        const oldest = authorizations.keys().next().value;
        if (typeof oldest !== 'string')
            break;
        authorizations.delete(oldest);
    }
}
/**
 * Minted only after main observes live Chromium user activation on the
 * disclosure-preview IPC. It lets the user take time to read two confirmation
 * dialogs without relying on that transient activation still being alive.
 */
function mintLinkReadAuthorization(subject, fingerprint) {
    prune();
    const token = (0, node_crypto_1.randomBytes)(24).toString('base64url');
    authorizations.set(token, {
        subject,
        fingerprint,
        expiresAt: Date.now() + LINK_READ_AUTHORIZATION_TTL_MS,
    });
    return token;
}
/** Single-use and exact-subject/fingerprint-bound, including on mismatch. */
function consumeLinkReadAuthorization(token, subject, fingerprint) {
    const record = authorizations.get(token);
    if (!record)
        return false;
    authorizations.delete(token);
    return (record.expiresAt > Date.now() &&
        record.fingerprint === fingerprint &&
        subjectKey(record.subject) === subjectKey(subject));
}
function resetLinkReadAuthorizationsForTests() {
    authorizations.clear();
}
