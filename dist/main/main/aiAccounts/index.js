"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readGrokQuotaCached = exports.readCursorQuotaCached = exports.readAntigravityQuotaCached = exports.readAmpQuotaCached = exports.agentAccountsDir = exports.readRegistry = void 0;
exports.buildAgentStatus = buildAgentStatus;
exports.buildState = buildState;
exports.syncActiveCodexSnapshot = syncActiveCodexSnapshot;
exports.saveCurrent = saveCurrent;
exports.getLiveAuthDigest = getLiveAuthDigest;
exports.autoSaveCurrent = autoSaveCurrent;
exports.refreshSavedAccountStatuses = refreshSavedAccountStatuses;
exports.switchTo = switchTo;
exports.renameAccount = renameAccount;
exports.removeSavedAccount = removeSavedAccount;
exports.restorePrevious = restorePrevious;
exports.getSettings = getSettings;
exports.setAutoSwitch = setAutoSwitch;
exports.acceptAutoSwitchDisclaimer = acceptAutoSwitchDisclaimer;
exports.isAnyAutoSwitchEnabled = isAnyAutoSwitchEnabled;
exports.evaluateAutoSwitch = evaluateAutoSwitch;
exports.setQuotaAlert = setQuotaAlert;
exports.isAnyQuotaAlertEnabled = isAnyQuotaAlertEnabled;
exports.evaluateQuotaAlerts = evaluateQuotaAlerts;
const fs_1 = require("fs");
const crypto_1 = require("crypto");
const electron_1 = require("electron");
const quotaAlerts_1 = require("./quotaAlerts");
const claudeKeychain_1 = require("./claudeKeychain");
const email_1 = require("./email");
const paths_1 = require("./paths");
Object.defineProperty(exports, "agentAccountsDir", { enumerable: true, get: function () { return paths_1.agentAccountsDir; } });
const registry_1 = require("./registry");
Object.defineProperty(exports, "readRegistry", { enumerable: true, get: function () { return registry_1.readRegistry; } });
const snapshot_1 = require("./snapshot");
const status_1 = require("./status");
const quotaProviders_1 = require("./quotaProviders");
Object.defineProperty(exports, "readAmpQuotaCached", { enumerable: true, get: function () { return quotaProviders_1.readAmpQuotaCached; } });
Object.defineProperty(exports, "readAntigravityQuotaCached", { enumerable: true, get: function () { return quotaProviders_1.readAntigravityQuotaCached; } });
Object.defineProperty(exports, "readCursorQuotaCached", { enumerable: true, get: function () { return quotaProviders_1.readCursorQuotaCached; } });
Object.defineProperty(exports, "readGrokQuotaCached", { enumerable: true, get: function () { return quotaProviders_1.readGrokQuotaCached; } });
const codexAuthSafety_1 = require("./codexAuthSafety");
const codexModelConfig_1 = require("./codexModelConfig");
const history_1 = require("../aiPool/history");
const epochs_1 = require("../aiPool/epochs");
const guards_1 = require("../aiPool/guards");
const instanceLock_1 = require("../aiPool/instanceLock");
const atomicWrite_1 = require("./atomicWrite");
const osCredentialStore_1 = require("./osCredentialStore");
const agentPaths_1 = require("../agentPaths");
async function readFileOrNull(filePath) {
    try {
        return await fs_1.promises.readFile(filePath, 'utf8');
    }
    catch {
        return null;
    }
}
async function captureLiveAuth(agent, overrides) {
    const active = (0, paths_1.resolveActiveAuth)(agent, overrides);
    if (agent === 'claude') {
        if (active.kind === 'keychain') {
            const value = await (0, claudeKeychain_1.readClaudeKeychain)(active.keychain.account);
            if (!value)
                return null;
            const payload = { source: 'keychain', value };
            return { payload, email: (0, email_1.extractClaudeEmail)(value) };
        }
        const value = await readFileOrNull(active.files[0]);
        if (!value)
            return null;
        const payload = { source: 'file', value };
        return { payload, email: (0, email_1.extractClaudeEmail)(value) };
    }
    if (agent === 'codex') {
        // Prefer auth.json; when cli_auth_credentials_store is keyring/auto the
        // CLI may have deleted the file after login and kept tokens only in the OS
        // store (common on Windows Credential Manager).
        let authJson = await readFileOrNull(active.files[0]);
        if (!authJson) {
            const codexHome = (0, agentPaths_1.getAgentRoot)('codex', overrides);
            authJson = await (0, osCredentialStore_1.readCodexOsAuth)(codexHome);
        }
        if (!authJson)
            return null;
        const payload = { authJson };
        return { payload, email: (0, email_1.extractCodexEmail)(authJson) };
    }
    if (agent === 'gemini') {
        // Gemini migrates oauth_creds.json into OS keychain / gemini-credentials.json
        // and deletes the plain file. Capture must follow that migration.
        let oauthCreds = await readFileOrNull(active.files[0]);
        if (!oauthCreds) {
            oauthCreds = await (0, osCredentialStore_1.readGeminiOsOauthCredsJson)((0, agentPaths_1.getAgentRoot)('gemini', overrides));
        }
        if (!oauthCreds)
            return null;
        const googleAccounts = await readFileOrNull(active.files[1]);
        const payload = {
            oauthCreds,
            googleAccounts: googleAccounts ?? undefined,
        };
        return { payload, email: (0, email_1.extractGeminiEmail)(oauthCreds, googleAccounts) };
    }
    if (agent === 'opencode') {
        const authJson = await readFileOrNull(active.files[0]);
        if (!authJson)
            return null;
        const payload = { authJson };
        return { payload, email: (0, email_1.extractOpencodeEmail)(authJson) };
    }
    // qwen
    const oauthCreds = await readFileOrNull(active.files[0]);
    if (!oauthCreds)
        return null;
    const payload = { oauthCreds };
    return { payload, email: (0, email_1.extractQwenEmail)(oauthCreds) };
}
function digestPayload(payload) {
    return (0, crypto_1.createHash)('sha256').update(JSON.stringify(payload)).digest('hex');
}
async function applySnapshot(agent, overrides, payload) {
    const active = (0, paths_1.resolveActiveAuth)(agent, overrides);
    if (agent === 'claude') {
        const p = payload;
        if (active.kind === 'keychain') {
            await (0, claudeKeychain_1.writeClaudeKeychain)(active.keychain.account, p.value);
        }
        else {
            await (0, atomicWrite_1.writeFileAtomic)(active.files[0], p.value);
        }
        return;
    }
    if (agent === 'codex') {
        const p = payload;
        const codexHome = (0, agentPaths_1.getAgentRoot)('codex', overrides);
        // 1) Make file storage the source of truth for multi-account swaps.
        await (0, osCredentialStore_1.ensureCodexFileCredentialStore)((0, codexModelConfig_1.codexConfigPath)(overrides)).catch(() => undefined);
        // 2) Drop stale OS keyring entries so Auto/Keyring modes cannot keep the
        //    previous account after we rewrite auth.json (Windows CredMan path).
        await (0, osCredentialStore_1.clearCodexOsCredentials)(codexHome);
        await (0, atomicWrite_1.writeFileAtomic)(active.files[0], p.authJson);
        // 3) Mirror into keyring when possible so a lingering Keyring-only mode
        //    still sees the switched account.
        await (0, osCredentialStore_1.writeCodexOsAuth)(codexHome, p.authJson).catch(() => false);
        return;
    }
    if (agent === 'gemini') {
        const p = payload;
        const geminiRoot = (0, agentPaths_1.getAgentRoot)('gemini', overrides);
        // Clear keychain + encrypted file fallback first so the CLI cannot keep
        // the previous Google account when we restore oauth_creds.json.
        await (0, osCredentialStore_1.clearGeminiOsCredentials)(geminiRoot);
        await (0, atomicWrite_1.writeFileAtomic)(active.files[0], p.oauthCreds);
        if (p.googleAccounts != null) {
            await (0, atomicWrite_1.writeFileAtomic)(active.files[1], p.googleAccounts);
        }
        // Mirror into OS keychain (keytar shape) so Windows Gemini picks it up
        // immediately without waiting for file-migration on next launch.
        await (0, osCredentialStore_1.writeGeminiOsOauthCreds)(p.oauthCreds).catch(() => false);
        return;
    }
    if (agent === 'opencode') {
        const p = payload;
        await (0, atomicWrite_1.writeFileAtomic)(active.files[0], p.authJson);
        return;
    }
    // qwen
    const p = payload;
    await (0, atomicWrite_1.writeFileAtomic)(active.files[0], p.oauthCreds);
}
async function detectLiveAuth(agent, overrides) {
    const active = (0, paths_1.resolveActiveAuth)(agent, overrides);
    if (active.kind === 'keychain') {
        const value = await (0, claudeKeychain_1.readClaudeKeychain)(active.keychain.account).catch(() => null);
        return typeof value === 'string' && value.length > 0;
    }
    const primary = await readFileOrNull(active.files[0]);
    if (typeof primary === 'string' && primary.length > 0)
        return true;
    // File may be gone after OS-keychain migration (Windows Gemini/Codex).
    if (agent === 'codex') {
        const fromOs = await (0, osCredentialStore_1.readCodexOsAuth)((0, agentPaths_1.getAgentRoot)('codex', overrides)).catch(() => null);
        return typeof fromOs === 'string' && fromOs.length > 0;
    }
    if (agent === 'gemini') {
        const fromOs = await (0, osCredentialStore_1.readGeminiOsOauthCredsJson)((0, agentPaths_1.getAgentRoot)('gemini', overrides)).catch(() => null);
        return typeof fromOs === 'string' && fromOs.length > 0;
    }
    return false;
}
/**
 * Live status for a SINGLE agent — the quota pill's lazy path, so focusing a
 * Claude terminal never computes Gemini/OpenCode quota. Cache-bounded by
 * `buildLiveStatus` (60s); `force` clears that agent's cache first (popover Refresh).
 */
async function buildAgentStatus(agent, overrides, force = false) {
    if (force)
        (0, status_1.clearLiveStatusCache)(agent);
    const hasAuth = await detectLiveAuth(agent, overrides);
    return hasAuth ? (0, status_1.buildLiveStatus)(agent, overrides) : null;
}
async function buildState(overrides) {
    // Codex owns refresh-token rotation. If its live CLI has rotated credentials,
    // reconcile that newer auth into the active encrypted snapshot before drift
    // detection. Identity must match, so an unrelated `codex login` can never
    // overwrite the account currently named by the registry.
    await syncActiveCodexSnapshot(overrides).catch(() => false);
    const reg = await (0, registry_1.readRegistry)();
    const agents = ['claude', 'codex', 'gemini', 'qwen', 'opencode'];
    const hasLiveAuth = {};
    const liveDriftsFromActive = {};
    const liveStatus = {};
    await Promise.all(agents.map(async (a) => {
        hasLiveAuth[a] = await detectLiveAuth(a, overrides);
        liveDriftsFromActive[a] = await detectActiveDrift(a, overrides, reg);
        liveStatus[a] = hasLiveAuth[a] ? await (0, status_1.buildLiveStatus)(a, overrides) : null;
        // Epoch ledger: a drifting live login means the user switched OUTSIDE
        // 1DevTool — record it (deduped) so §8 attribution closes its window.
        if (liveDriftsFromActive[a]) {
            (0, epochs_1.appendEpoch)({ agent: a, accountId: null, authDigest: null, source: 'external-detected' });
        }
    }));
    const accounts = await persistFreshLiveStatuses(reg, liveStatus, liveDriftsFromActive);
    return {
        accounts,
        active: reg.active,
        hasLiveAuth,
        liveDriftsFromActive,
        liveStatus,
        secureStorageAvailable: electron_1.safeStorage.isEncryptionAvailable(),
        settings: reg.settings,
    };
}
async function persistFreshLiveStatuses(reg, liveStatus, liveDriftsFromActive) {
    const agents = ['claude', 'codex', 'gemini', 'qwen', 'opencode'];
    const updates = [];
    for (const agent of agents) {
        if (liveDriftsFromActive[agent])
            continue;
        const status = liveStatus[agent];
        const activeId = reg.active[agent];
        if (!status || !activeId)
            continue;
        const active = reg.accounts[agent].find((account) => account.id === activeId);
        if (!active)
            continue;
        const activatedAt = active.lastUsedAt ?? active.createdAt;
        if (status.source === 'codex-session' && status.checkedAt + 5_000 < activatedAt) {
            continue;
        }
        // Compare with checkedAt stripped — it is a fresh Date.now() on every
        // probe past the 60s cache, so including it made every state() assembly
        // rewrite the registry even when no observation changed (the same
        // timestamp-only coalescing appendQuotaSample already applies). The
        // stored copy's checkedAt lags at most one cache TTL; active-account UI
        // freshness comes from the live status, not the registry.
        const storedObservation = active.status ? { ...active.status, checkedAt: 0 } : null;
        if (JSON.stringify(storedObservation) !== JSON.stringify({ ...status, checkedAt: 0 })) {
            updates.push({ agent, id: activeId, status });
        }
    }
    // Quota-history hook (quota-center §7): every identity-resolved live status
    // that changed appends one sample. Drift-skipped above, so a sample is never
    // attributed to an account the live login doesn't match; appendQuotaSample
    // coalesces timestamp-only changes. Best-effort — never blocks state().
    for (const update of updates) {
        void (0, history_1.appendQuotaSampleFromStatus)(update.agent, update.id, update.status);
    }
    if (updates.length === 0)
        return reg.accounts;
    const updated = await (0, registry_1.mutateRegistry)((prev) => {
        let accounts = prev.accounts;
        for (const update of updates) {
            accounts = {
                ...accounts,
                [update.agent]: accounts[update.agent].map((account) => account.id === update.id ? { ...account, status: update.status } : account),
            };
        }
        return { ...prev, accounts };
    });
    return updated.accounts;
}
/**
 * Drift = live credentials on disk don't match the active saved snapshot.
 * Happens after the user runs `codex login` etc. and hasn't clicked
 * Save current yet. We compare serialized payloads (same shape the
 * snapshot stores) so a fresh login trips drift even if the underlying
 * OAuth refresh rotates tokens.
 */
async function detectActiveDrift(agent, overrides, reg) {
    const captured = await captureLiveAuth(agent, overrides).catch(() => null);
    if (!captured)
        return false;
    const activeId = reg.active[agent];
    if (!activeId)
        return true; // live auth exists but nothing is marked active → drift
    const saved = await (0, snapshot_1.readEncryptedSnapshot)((0, paths_1.snapshotFilePath)(agent, activeId)).catch(() => null);
    if (saved == null)
        return true; // active id points to a missing snapshot → drift
    return JSON.stringify(saved) !== JSON.stringify(captured.payload);
}
/**
 * Persist newer live Codex credentials only when both auth files prove the same
 * stable account identity. This preserves CLI-rotated refresh tokens without
 * ever relabeling a newly logged-in account as the previous active account.
 */
async function syncActiveCodexSnapshot(overrides) {
    if (!electron_1.safeStorage.isEncryptionAvailable())
        return false;
    const captured = await captureLiveAuth('codex', overrides);
    const liveAuthJson = captured?.payload?.authJson;
    if (typeof liveAuthJson !== 'string' || !liveAuthJson.trim())
        return false;
    const reg = await (0, registry_1.readRegistry)();
    const activeId = reg.active.codex;
    if (!activeId || !(0, registry_1.findAccount)(reg, 'codex', activeId))
        return false;
    const snapshotPath = (0, paths_1.snapshotFilePath)('codex', activeId);
    const saved = await (0, snapshot_1.readEncryptedSnapshot)(snapshotPath);
    const savedAuthJson = saved?.authJson;
    if (typeof savedAuthJson !== 'string' || !savedAuthJson.trim())
        return false;
    return (0, codexAuthSafety_1.reconcileCodexAuthSnapshot)(liveAuthJson, savedAuthJson, async (authJson) => {
        await (0, snapshot_1.writeEncryptedSnapshot)(snapshotPath, { authJson });
    });
}
function statusSourceForAgent(agent) {
    if (agent === 'claude')
        return 'claude-usage';
    if (agent === 'codex')
        return 'codex-session';
    return 'oauth-expiry';
}
function supportsStatusProbe(agent) {
    return agent === 'claude' || agent === 'codex' || agent === 'gemini' || agent === 'qwen';
}
async function saveCurrent(agent, label, overrides) {
    if (!electron_1.safeStorage.isEncryptionAvailable()) {
        throw new Error('Secure storage is not available on this machine.');
    }
    const captured = await captureLiveAuth(agent, overrides);
    if (!captured) {
        throw new Error(`No active ${agent} login detected. Sign in with the ${agent} CLI first.`);
    }
    (0, status_1.clearLiveStatusCache)(agent);
    return persistCaptured(agent, captured, label, overrides);
}
async function persistCaptured(agent, captured, label, overrides) {
    const id = (0, crypto_1.randomUUID)();
    const dest = (0, paths_1.snapshotFilePath)(agent, id);
    await (0, snapshot_1.writeEncryptedSnapshot)(dest, captured.payload);
    // The account being saved IS the current global identity, so today's
    // config.toml model pin belongs to it (codexModelConfig.ts).
    const codexModel = agent === 'codex' ? await (0, codexModelConfig_1.readCodexModelPin)(overrides) : undefined;
    const now = Date.now();
    const summary = {
        id,
        agentType: agent,
        label: label.trim() || captured.email || 'Account',
        email: captured.email,
        createdAt: now,
        lastUsedAt: now,
        ...(codexModel !== undefined ? { codexModel } : {}),
    };
    await (0, registry_1.mutateRegistry)((prev) => {
        const next = {
            ...prev,
            accounts: {
                ...prev.accounts,
                [agent]: [...prev.accounts[agent], summary],
            },
            active: { ...prev.active, [agent]: id },
        };
        return next;
    });
    return summary;
}
async function markActiveLiveAccount(agent, id) {
    const now = Date.now();
    const reg = await (0, registry_1.mutateRegistry)((prev) => {
        const list = prev.accounts[agent].map((account) => account.id === id ? { ...account, lastUsedAt: now } : account);
        return {
            ...prev,
            accounts: { ...prev.accounts, [agent]: list },
            active: { ...prev.active, [agent]: id },
        };
    });
    const summary = (0, registry_1.findAccount)(reg, agent, id);
    if (!summary)
        throw new Error(`Account ${id} not found for ${agent}`);
    return summary;
}
async function findMatchingSavedAccount(agent, payload, reg) {
    const targetDigest = digestPayload(payload);
    for (const account of reg.accounts[agent]) {
        const snapshot = await (0, snapshot_1.readEncryptedSnapshot)((0, paths_1.snapshotFilePath)(agent, account.id)).catch(() => null);
        if (!snapshot)
            continue;
        if (digestPayload(snapshot) === targetDigest) {
            return account;
        }
    }
    return null;
}
async function getLiveAuthDigest(agent, overrides) {
    const captured = await captureLiveAuth(agent, overrides).catch(() => null);
    return captured ? digestPayload(captured.payload) : null;
}
async function autoSaveCurrent(agent, overrides) {
    if (!electron_1.safeStorage.isEncryptionAvailable()) {
        return null;
    }
    const captured = await captureLiveAuth(agent, overrides);
    if (!captured)
        return null;
    const reg = await (0, registry_1.readRegistry)();
    const activeId = reg.active[agent];
    if (activeId) {
        const activeSnapshot = await (0, snapshot_1.readEncryptedSnapshot)((0, paths_1.snapshotFilePath)(agent, activeId)).catch(() => null);
        if (activeSnapshot && digestPayload(activeSnapshot) === digestPayload(captured.payload)) {
            const summary = (0, registry_1.findAccount)(reg, agent, activeId);
            if (summary) {
                (0, status_1.clearLiveStatusCache)(agent);
                return { summary, action: 'unchanged' };
            }
        }
    }
    const existing = await findMatchingSavedAccount(agent, captured.payload, reg);
    if (existing) {
        const summary = await markActiveLiveAccount(agent, existing.id);
        (0, status_1.clearLiveStatusCache)(agent);
        return { summary, action: 'activated-existing' };
    }
    const summary = await persistCaptured(agent, captured, '', overrides);
    (0, status_1.clearLiveStatusCache)(agent);
    return { summary, action: 'saved' };
}
async function refreshSavedAccountStatuses(agent, overrides) {
    const reg = await (0, registry_1.readRegistry)();
    const agents = agent ? [agent] : ['claude', 'codex', 'gemini', 'qwen', 'opencode'];
    const updates = await Promise.all(agents.flatMap((a) => reg.accounts[a].map(async (account) => {
        const snapshot = await (0, snapshot_1.readEncryptedSnapshot)((0, paths_1.snapshotFilePath)(a, account.id)).catch(() => null);
        if (!snapshot) {
            return {
                agent: a,
                id: account.id,
                status: {
                    source: statusSourceForAgent(a),
                    kind: 'error',
                    summary: 'Saved credentials are missing or could not be decrypted.',
                    checkedAt: Date.now(),
                },
            };
        }
        if (!supportsStatusProbe(a)) {
            return {
                agent: a,
                id: account.id,
                status: {
                    source: statusSourceForAgent(a),
                    kind: 'muted',
                    summary: 'Usage refresh is unavailable for this CLI.',
                    checkedAt: Date.now(),
                },
            };
        }
        const status = await (0, status_1.buildStatusForSnapshot)(a, snapshot).then((result) => (result ?? {
            source: statusSourceForAgent(a),
            kind: 'error',
            summary: 'Saved credentials are not in a probeable format. Save this account again.',
            checkedAt: Date.now(),
        })).catch((err) => ({
            source: statusSourceForAgent(a),
            kind: 'error',
            summary: 'Could not refresh usage for this account.',
            detail: err instanceof Error ? err.message : String(err),
            checkedAt: Date.now(),
        }));
        return { agent: a, id: account.id, status };
    })));
    // Quota-history hook (quota-center §7): snapshot probes carry exact account
    // identity. Error statuses have no windows and are skipped by the helper.
    for (const update of updates) {
        void (0, history_1.appendQuotaSampleFromStatus)(update.agent, update.id, update.status);
    }
    await (0, registry_1.mutateRegistry)((prev) => {
        let accounts = prev.accounts;
        for (const update of updates) {
            accounts = {
                ...accounts,
                [update.agent]: accounts[update.agent].map((account) => account.id === update.id ? { ...account, status: update.status } : account),
            };
        }
        return { ...prev, accounts };
    });
    if (agent) {
        (0, status_1.clearLiveStatusCache)(agent);
    }
    else {
        (0, status_1.clearLiveStatusCache)();
    }
    return buildState(overrides);
}
/**
 * The ONE global-credential switch choke point. Every non-pool path (manual
 * set-default, alert-modal switch, legacy auto-switch) acquires the
 * cross-instance pool lock and proves no conflicting live lease first — the
 * §13 Phase-2 exit gate. Pool-managed callers (prepareSpawn) already hold the
 * lock and have proven exclusivity against durable leases, so they bypass
 * the outer guard with `poolManaged: true`.
 */
async function switchTo(agent, id, overrides, opts) {
    // Pool-managed prepareSpawn always re-applies the snapshot (auth.json is
    // ground truth; registry.active can drift after an in-CLI login). Never
    // short-circuit applySnapshot for same-account — only skip the live-PTY
    // refusal when re-pinning the already-active id (BUG-82 audit round 3).
    if (opts?.poolManaged)
        return switchToUnlocked(agent, id, overrides);
    return (0, instanceLock_1.withPoolLock)(agent, async () => {
        const reg = await (0, registry_1.readRegistry)();
        if (reg.active[agent] !== id)
            await (0, guards_1.assertNoConflictingLease)(agent, id);
        return switchToUnlocked(agent, id, overrides);
    });
}
async function switchToUnlocked(agent, id, overrides) {
    if (agent === 'codex') {
        // Preserve any refresh-token rotation performed by the live Codex CLI
        // before replacing auth.json with another saved account.
        await syncActiveCodexSnapshot(overrides);
    }
    const reg = await (0, registry_1.readRegistry)();
    // Re-apply is unconditional — even when registry.active already names `id`.
    // auth.json can drift (user logged into another account inside the CLI);
    // the pool's prepareSpawn path relies on applySnapshot always writing the
    // reserved account's credentials before spawn.
    const target = (0, registry_1.findAccount)(reg, agent, id);
    if (!target)
        throw new Error(`Account ${id} not found for ${agent}`);
    const snapshot = await (0, snapshot_1.readEncryptedSnapshot)((0, paths_1.snapshotFilePath)(agent, id));
    if (snapshot == null) {
        throw new Error(`Snapshot for ${agent}/${id} is missing or could not be decrypted.`);
    }
    // Codex pins its model globally in config.toml, but model entitlement is
    // per plan (see codexModelConfig.ts). Capture the outgoing identity's pin
    // so it follows that account, and after the auth swap apply the incoming
    // account's pin — removing the keys when it has none recorded, so a
    // Pro-only model never stays pinned under a Free login.
    const outgoingId = reg.active[agent];
    const outgoingModelPin = agent === 'codex' && outgoingId && outgoingId !== id ? await (0, codexModelConfig_1.readCodexModelPin)(overrides) : null;
    // Safety backup: snapshot outgoing active auth so a misclick is recoverable
    // even if the user never explicitly saved that account.
    const captured = await captureLiveAuth(agent, overrides);
    if (captured) {
        await (0, snapshot_1.writeEncryptedSnapshot)((0, paths_1.previousSnapshotPath)(agent), captured.payload);
    }
    await applySnapshot(agent, overrides, snapshot);
    if (agent === 'codex' && outgoingId !== id) {
        await (0, codexModelConfig_1.writeCodexModelPin)(overrides, target.codexModel ?? null);
    }
    // Epoch ledger (quota-center §7): recorded only after the swap succeeded.
    // A failed spawn later never rolls this back — the credentials really changed.
    (0, epochs_1.appendEpoch)({ agent, accountId: id, authDigest: digestPayload(snapshot), source: 'switchTo' });
    (0, status_1.clearLiveStatusCache)(agent);
    const now = Date.now();
    await (0, registry_1.mutateRegistry)((prev) => {
        const list = prev.accounts[agent].map((a) => {
            if (a.id === id)
                return { ...a, lastUsedAt: now };
            if (outgoingModelPin && a.id === outgoingId)
                return { ...a, codexModel: outgoingModelPin };
            return a;
        });
        return {
            ...prev,
            accounts: { ...prev.accounts, [agent]: list },
            active: { ...prev.active, [agent]: id },
        };
    });
    return { ...target, lastUsedAt: now };
}
async function renameAccount(agent, id, label) {
    const trimmed = label.trim();
    if (!trimmed)
        throw new Error('Label cannot be empty');
    const reg = await (0, registry_1.mutateRegistry)((prev) => {
        const list = prev.accounts[agent].map((a) => a.id === id ? { ...a, label: trimmed } : a);
        return { ...prev, accounts: { ...prev.accounts, [agent]: list } };
    });
    const next = (0, registry_1.findAccount)(reg, agent, id);
    if (!next)
        throw new Error(`Account ${id} not found for ${agent}`);
    return next;
}
async function removeSavedAccount(agent, id) {
    await (0, registry_1.mutateRegistry)((prev) => (0, registry_1.removeAccount)(prev, agent, id));
    const snapshotPath = (0, paths_1.snapshotFilePath)(agent, id);
    await fs_1.promises.rm(snapshotPath, { force: true }).catch(() => {
        /* best-effort */
    });
}
async function restorePrevious(agent, overrides) {
    const snapshot = await (0, snapshot_1.readEncryptedSnapshot)((0, paths_1.previousSnapshotPath)(agent));
    if (snapshot == null)
        return false;
    await applySnapshot(agent, overrides, snapshot);
    (0, status_1.clearLiveStatusCache)(agent);
    return true;
}
// ── Settings (auto-switch) ────────────────────────────────────────────────────
async function getSettings() {
    return (await (0, registry_1.readRegistry)()).settings;
}
async function setAutoSwitch(agent, enabled, threshold) {
    const clamped = Math.min(100, Math.max(50, Math.round(threshold)));
    const reg = await (0, registry_1.mutateRegistry)((prev) => ({
        ...prev,
        settings: {
            ...prev.settings,
            autoSwitch: { ...prev.settings.autoSwitch, [agent]: { enabled, threshold: clamped } },
        },
    }));
    return reg.settings;
}
async function acceptAutoSwitchDisclaimer() {
    const reg = await (0, registry_1.mutateRegistry)((prev) => ({
        ...prev,
        settings: { ...prev.settings, autoSwitchDisclaimerAcceptedAt: Date.now() },
    }));
    return reg.settings;
}
/** Whether any tool currently has auto-switch enabled (gates the background poll). */
async function isAnyAutoSwitchEnabled() {
    const { autoSwitch } = (await (0, registry_1.readRegistry)()).settings;
    return Object.values(autoSwitch).some((s) => s?.enabled);
}
// Only tools that expose real quota windows can be rotated on usage.
const AUTO_SWITCH_AGENTS = ['claude', 'codex'];
/**
 * For each Claude/Codex tool with auto-switch enabled: if the active account's
 * usage has reached the threshold, switch to the saved account with the most quota
 * left (below threshold, with known usage). Returns the switches performed.
 *
 * Reads each account's last-known `.status`, so callers should refresh statuses
 * first. Mirrors ai-switcher's `maybe_auto_switch` / `best_replacement`.
 */
async function evaluateAutoSwitch(overrides, onlyAgent) {
    const reg = await (0, registry_1.readRegistry)();
    const results = [];
    const agents = (onlyAgent ? [onlyAgent] : AUTO_SWITCH_AGENTS).filter((a) => AUTO_SWITCH_AGENTS.includes(a));
    for (const agent of agents) {
        const setting = reg.settings.autoSwitch[agent];
        if (!setting?.enabled)
            continue;
        // §13 Phase-2 exit gate: once a pool policy manages this provider, the
        // legacy poll stands down — the pool engine owns rotation via leases.
        if (await (0, guards_1.isPoolManaged)(agent))
            continue;
        const activeId = reg.active[agent];
        if (!activeId)
            continue; // using default / unmanaged — nothing to rotate
        const active = reg.accounts[agent].find((a) => a.id === activeId);
        const activeUsage = (0, quotaAlerts_1.maxUsedPercent)(active?.status);
        if (activeUsage == null || activeUsage < setting.threshold)
            continue;
        const replacement = reg.accounts[agent]
            .filter((a) => a.id !== activeId)
            .map((a) => ({ account: a, usage: (0, quotaAlerts_1.maxUsedPercent)(a.status) }))
            .filter((c) => c.usage != null && c.usage < setting.threshold)
            .sort((l, r) => l.usage - r.usage)[0];
        if (!replacement)
            continue;
        try {
            await switchTo(agent, replacement.account.id, overrides);
            results.push({
                agent,
                fromId: activeId,
                toId: replacement.account.id,
                toLabel: replacement.account.label,
            });
        }
        catch (err) {
            console.warn('[ai-accounts] auto-switch failed:', err);
        }
    }
    return results;
}
// ── Quota alerts (per-agent "warn me at N%") ───────────────────────────────────
// Agents that can report a quota window. evaluateQuotaAlerts skips any whose
// live status has no usedPercent (e.g. qwen/opencode returning oauth-expiry).
// Superset of the account agents with the CLI-only side-channel providers that
// report quota. Cline is displayable as unavailable but intentionally omitted.
const QUOTA_ALERT_AGENTS = [
    'claude', 'codex', 'gemini', 'qwen', 'opencode', 'amp', 'antigravity', 'grok',
];
// Agents backed by the switchable-account system (accounts[]/active[]).
const ACCOUNT_AGENTS = ['claude', 'codex', 'gemini', 'qwen', 'opencode'];
const DEFAULT_QUOTA_ALERT_THRESHOLD = 80;
function isAccountAgent(agent) {
    return ACCOUNT_AGENTS.includes(agent);
}
/**
 * Background quota-alert ticks accept a CLI-probe status this stale instead of
 * re-running the probe. The alert poll fires every 2 min while the probe
 * caches hold 60s, so without this every background tick paid a fresh
 * `amp usage` exec and a full interactive `agy` PTY `/usage` probe (up to
 * 12s of child process per tick, forever). Foreground reads (Quota Center,
 * pill focus, just-enabled evaluation) keep the 60s freshness — and while any
 * such surface is polling, its fresh cache makes background ticks spawn-free.
 * Worst-case alert latency for these two providers becomes ~12 min against
 * 5h/weekly windows.
 */
const BACKGROUND_CLI_PROBE_MAX_AGE_MS = 10 * 60_000;
/**
 * Live quota for any QuotaAgentType — account agents go through the normal
 * auth-gated status pipeline; CLI-only providers ride their cached side channel.
 */
async function readQuotaStatusForAgent(agent, overrides, background = false) {
    const cliProbeMaxAge = background ? BACKGROUND_CLI_PROBE_MAX_AGE_MS : undefined;
    switch (agent) {
        case 'amp':
            return (0, quotaProviders_1.readAmpQuotaCached)(cliProbeMaxAge);
        case 'antigravity':
            return (0, quotaProviders_1.readAntigravityQuotaCached)(overrides, cliProbeMaxAge);
        case 'grok':
            return (0, quotaProviders_1.readGrokQuotaCached)();
        case 'cline':
            return null;
        // Cursor publishes no usage numbers — its side channel reports identity +
        // plan only (window-less), so alert evaluation skips it naturally. Still
        // never cast into AIPathAgentType (rule A7).
        case 'cursor':
            return (0, quotaProviders_1.readCursorQuotaCached)();
        default:
            return buildAgentStatus(agent, overrides);
    }
}
/**
 * Human label for a tripped window when `windowMinutes` alone is ambiguous.
 * Antigravity reports TWO weekly groups (Gemini in primary, Claude & GPT in
 * secondary), so both share windowMinutes=10080 — label them by group instead.
 * Undefined for account agents (labelled off windowMinutes downstream).
 */
function quotaWindowLabel(agent, win) {
    if (agent === 'antigravity')
        return win === 'session' ? 'Gemini' : 'Claude & GPT';
    return undefined;
}
function clampThreshold(value) {
    return Math.min(99, Math.max(1, Math.round(value)));
}
async function setQuotaAlert(agent, enabled, sessionThreshold, weeklyThreshold) {
    const next = {
        enabled,
        sessionThreshold: clampThreshold(sessionThreshold),
        weeklyThreshold: clampThreshold(weeklyThreshold),
    };
    const reg = await (0, registry_1.mutateRegistry)((prev) => ({
        ...prev,
        settings: {
            ...prev.settings,
            quotaAlerts: { ...prev.settings.quotaAlerts, [agent]: next },
        },
    }));
    return reg.settings;
}
/** Whether any agent has a quota alert enabled (gates the background poll). */
async function isAnyQuotaAlertEnabled() {
    const { quotaAlerts } = (await (0, registry_1.readRegistry)()).settings;
    return Object.values(quotaAlerts).some((s) => s?.enabled);
}
// In-memory arm state, keyed `${agent}:${window}` (once-per-window dedup, per
// window). A restart re-arms all, so an alert may re-fire once after relaunch if
// still over threshold.
const quotaAlertArmState = new Map();
// The two independently-thresholded windows: 5h/session (primary) and weekly
// (secondary). Each has its own configured percent, arm state, and reset clock.
const QUOTA_WINDOWS = ['session', 'weekly'];
/**
 * For each agent with a quota alert enabled: read its LIVE status (60s-cached) and
 * evaluate BOTH windows independently against their configured thresholds, emitting
 * an alert for each window that just crossed. Reads live auth directly, so it works
 * even when the Accounts feature was never set up.
 */
async function evaluateQuotaAlerts(overrides, onlyAgent, opts) {
    const reg = await (0, registry_1.readRegistry)();
    const agents = (onlyAgent ? [onlyAgent] : QUOTA_ALERT_AGENTS).filter((a) => QUOTA_ALERT_AGENTS.includes(a));
    const alerts = [];
    for (const agent of agents) {
        const setting = reg.settings.quotaAlerts[agent];
        if (!setting?.enabled)
            continue;
        const status = await readQuotaStatusForAgent(agent, overrides, opts?.background === true).catch(() => null);
        if (!status || status.kind === 'error')
            continue;
        // Pooled agents key arm state per ACCOUNT (quota-center §9): switching
        // the global default must not inherit the previous account's armed state,
        // and each account alerts independently.
        const activeAccountId = isAccountAgent(agent) ? reg.active[agent] ?? null : null;
        const activeAccount = activeAccountId
            ? reg.accounts[agent].find((a) => a.id === activeAccountId)
            : undefined;
        for (const win of QUOTA_WINDOWS) {
            const window = win === 'session' ? status.primary : status.secondary;
            const pct = typeof window?.usedPercent === 'number' ? window.usedPercent : null;
            if (pct == null)
                continue;
            const threshold = (win === 'session' ? setting.sessionThreshold : setting.weeklyThreshold) ??
                DEFAULT_QUOTA_ALERT_THRESHOLD;
            const resetsAt = window?.resetsAt ?? null;
            const stateKey = `${agent}:${activeAccountId ?? 'global'}:${win}`;
            const { fire, next } = (0, quotaAlerts_1.evaluateQuotaCrossing)(quotaAlertArmState.get(stateKey), pct, threshold, resetsAt);
            quotaAlertArmState.set(stateKey, next);
            if (!fire)
                continue;
            alerts.push({
                agent,
                threshold,
                usedPercent: Math.round(pct),
                windowMinutes: window?.windowMinutes ?? null,
                windowLabel: quotaWindowLabel(agent, win),
                resetsAt,
                plan: status.plan,
                hasSpareAccount: hasSpareQuotaAccount(reg, agent, threshold),
                accountId: activeAccountId ?? undefined,
                accountLabel: activeAccount?.label,
                poolHealthyCount: isAccountAgent(agent)
                    ? countHealthyPoolAccounts(reg, agent, threshold)
                    : undefined,
            });
        }
    }
    return alerts;
}
/** How many other enabled accounts sit below `threshold` — lets the alert
 * modal say "pool still has N healthy accounts" (quota-center §9). */
function countHealthyPoolAccounts(reg, agent, threshold) {
    const activeId = reg.active[agent];
    return reg.accounts[agent].filter((account) => {
        if (account.id === activeId || account.enabled === false)
            return false;
        const used = (0, quotaAlerts_1.maxUsedPercent)(account.status ?? null);
        return used == null || used < threshold;
    }).length;
}
/**
 * Whether a saved account for `agent` (other than the active one) still has quota
 * below `threshold` — gates the alert modal's "Switch account" action.
 */
function hasSpareQuotaAccount(reg, agent, threshold) {
    // CLI-only providers (amp/antigravity/grok) have no switchable account.
    if (!isAccountAgent(agent))
        return false;
    const activeId = reg.active[agent];
    return reg.accounts[agent].some((a) => {
        if (a.id === activeId)
            return false;
        const usage = (0, quotaAlerts_1.maxUsedPercent)(a.status);
        return usage != null && usage < threshold;
    });
}
