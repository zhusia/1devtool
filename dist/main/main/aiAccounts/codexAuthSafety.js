"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.codexAuthsBelongToSameAccount = codexAuthsBelongToSameAccount;
exports.shouldSyncCodexAuthSnapshot = shouldSyncCodexAuthSnapshot;
exports.reconcileCodexAuthSnapshot = reconcileCodexAuthSnapshot;
function decodeJwtPayload(token) {
    if (typeof token !== 'string')
        return null;
    const parts = token.split('.');
    if (parts.length < 2)
        return null;
    try {
        return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    }
    catch {
        return null;
    }
}
function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function readCodexAccountIdentity(authJson) {
    try {
        const parsed = JSON.parse(authJson);
        const tokens = parsed.tokens && typeof parsed.tokens === 'object'
            ? parsed.tokens
            : null;
        if (!tokens)
            return null;
        const claims = decodeJwtPayload(tokens.id_token);
        const openAiClaims = claims?.['https://api.openai.com/auth'];
        const authClaims = openAiClaims && typeof openAiClaims === 'object'
            ? openAiClaims
            : null;
        const accountId = nonEmptyString(tokens.account_id)
            ?? nonEmptyString(authClaims?.chatgpt_account_id)
            ?? nonEmptyString(claims?.chatgpt_account_id);
        const userId = nonEmptyString(authClaims?.chatgpt_user_id)
            ?? nonEmptyString(claims?.chatgpt_user_id)
            ?? nonEmptyString(claims?.sub);
        const email = nonEmptyString(claims?.email)?.toLowerCase();
        return accountId || userId || email ? { accountId, userId, email } : null;
    }
    catch {
        return null;
    }
}
/**
 * Prove that two Codex auth files belong to the same account before replacing an
 * encrypted snapshot. Refresh/access tokens are deliberately ignored because
 * rotation changes them while the stable account identity remains the same.
 */
function codexAuthsBelongToSameAccount(left, right) {
    const leftIdentity = readCodexAccountIdentity(left);
    const rightIdentity = readCodexAccountIdentity(right);
    if (!leftIdentity || !rightIdentity)
        return false;
    if (leftIdentity.accountId || rightIdentity.accountId) {
        return Boolean(leftIdentity.accountId
            && rightIdentity.accountId
            && leftIdentity.accountId === rightIdentity.accountId);
    }
    if (leftIdentity.userId || rightIdentity.userId) {
        return Boolean(leftIdentity.userId
            && rightIdentity.userId
            && leftIdentity.userId === rightIdentity.userId);
    }
    return Boolean(leftIdentity.email
        && rightIdentity.email
        && leftIdentity.email === rightIdentity.email);
}
function shouldSyncCodexAuthSnapshot(liveAuthJson, savedAuthJson) {
    return liveAuthJson !== savedAuthJson
        && codexAuthsBelongToSameAccount(liveAuthJson, savedAuthJson);
}
/**
 * Reconcile through an injected writer so the identity decision can be tested
 * without loading Electron safeStorage. A different/unknown live identity never
 * reaches the encrypted-snapshot writer.
 */
async function reconcileCodexAuthSnapshot(liveAuthJson, savedAuthJson, persist) {
    if (!shouldSyncCodexAuthSnapshot(liveAuthJson, savedAuthJson))
        return false;
    await persist(liveAuthJson);
    return true;
}
