"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDeployTokenRef = isDeployTokenRef;
exports.looksLikeSecretValue = looksLikeSecretValue;
exports.stripSecrets = stripSecrets;
exports.resolveSecrets = resolveSecrets;
/** A deploy token ref routes to the existing DeploySecretStore, not secrets.local.json. */
function isDeployTokenRef(ref) {
    return /^deploy\.(vercel|cloudflare)\.token$/.test(ref);
}
// Ref builders (id-based so a rename doesn't orphan the secret).
const dbRef = (connId, field) => `db.${connId}.${field}`;
const httpRef = (envId, key) => `http.${envId}.${key}`;
const deployTokenRef = (provider) => `deploy.${provider}.token`;
const deployEnvRef = (provider, key) => `deploy.${provider}.env.${key}`;
/**
 * Heuristic: does this value look like a live credential? Used to default the
 * HTTP env per-variable `secret` flag ON so users don't accidentally commit a
 * pasted token. The user can always override.
 */
function looksLikeSecretValue(value) {
    const v = value.trim();
    if (!v)
        return false;
    if (/^(sk-|pk-|ghp_|gho_|ghu_|ghs_|github_pat_|xox[baprs]-|glpat-|Bearer\s+)/.test(v))
        return true;
    if (/^eyJ[A-Za-z0-9_-]{3,}\./.test(v))
        return true; // JWT
    if (/^AKIA[0-9A-Z]{16}$/.test(v))
        return true; // AWS access key id
    if (/^[A-Fa-f0-9]{40,}$/.test(v))
        return true; // long hex secret
    return false;
}
function stripDatabase(payload) {
    const secrets = {};
    const connections = (payload.connections || []).map((conn) => {
        const { password, apiKey, influxToken, connectionUri, scope: _scope, ...rest } = conn;
        const shared = { ...rest };
        if (password) {
            shared.passwordRef = dbRef(conn.id, 'password');
            secrets[shared.passwordRef] = password;
        }
        if (apiKey) {
            shared.apiKeyRef = dbRef(conn.id, 'apiKey');
            secrets[shared.apiKeyRef] = apiKey;
        }
        if (influxToken) {
            shared.influxTokenRef = dbRef(conn.id, 'influxToken');
            secrets[shared.influxTokenRef] = influxToken;
        }
        if (connectionUri && /:\/\/[^/@]*:[^/@]*@/.test(connectionUri)) {
            // Only treat a connection URI as secret when it embeds credentials.
            shared.connectionUriRef = dbRef(conn.id, 'connectionUri');
            secrets[shared.connectionUriRef] = connectionUri;
        }
        else if (connectionUri) {
            ;
            shared.connectionUri = connectionUri;
        }
        return shared;
    });
    return { sanitized: { connections, activeConnectionId: payload.activeConnectionId ?? null }, secrets };
}
function resolveDatabase(payload, resolve) {
    const missingRefs = [];
    const take = (ref) => {
        if (!ref)
            return '';
        const v = resolve(ref);
        if (v == null) {
            missingRefs.push(ref);
            return '';
        }
        return v;
    };
    const connections = (payload.connections || []).map((shared) => {
        const { passwordRef, apiKeyRef, influxTokenRef, connectionUriRef, ...rest } = shared;
        const conn = {
            ...rest,
            password: take(passwordRef),
            scope: 'project',
        };
        if (apiKeyRef)
            conn.apiKey = take(apiKeyRef);
        if (influxTokenRef)
            conn.influxToken = take(influxTokenRef);
        if (connectionUriRef)
            conn.connectionUri = take(connectionUriRef);
        else if (rest.connectionUri) {
            conn.connectionUri = rest.connectionUri;
        }
        return conn;
    });
    return { config: { connections, activeConnectionId: payload.activeConnectionId ?? null }, missingRefs };
}
function stripHttp(payload) {
    const secrets = {};
    const environments = (payload.environments || []).map((env) => ({
        id: env.id,
        name: env.name,
        variables: (env.variables || []).map((v) => {
            const flaggedSecret = env.isSecret?.[v.key] === true || looksLikeSecretValue(v.value ?? '');
            if (flaggedSecret && v.value) {
                const ref = httpRef(env.id, v.key);
                secrets[ref] = v.value;
                return { key: v.key, secret: true, valueRef: ref, enabled: v.enabled };
            }
            return { key: v.key, value: v.value ?? '', enabled: v.enabled };
        }),
    }));
    // Strip the transient `scope` tag from tabs before committing.
    const tabs = (payload.tabs || []).map((t) => {
        const { scope: _scope, ...rest } = t;
        return rest;
    });
    return {
        sanitized: { tabs, environments, activeEnvironmentId: payload.activeEnvironmentId ?? null },
        secrets,
    };
}
function resolveHttp(payload, resolve) {
    const missingRefs = [];
    const environments = (payload.environments || []).map((env) => {
        const isSecret = {};
        const variables = (env.variables || []).map((v) => {
            if (v.secret || v.valueRef) {
                isSecret[v.key] = true;
                const ref = v.valueRef ?? httpRef(env.id, v.key);
                const val = resolve(ref);
                if (val == null)
                    missingRefs.push(ref);
                return { key: v.key, value: val ?? '', enabled: v.enabled ?? true };
            }
            return { key: v.key, value: v.value ?? '', enabled: v.enabled ?? true };
        });
        const out = { id: env.id, name: env.name, variables };
        if (Object.keys(isSecret).length)
            out.isSecret = isSecret;
        return out;
    });
    return {
        config: { tabs: payload.tabs || [], environments, activeEnvironmentId: payload.activeEnvironmentId ?? null },
        missingRefs,
    };
}
function stripDeploy(payload) {
    const secrets = {};
    const configs = {};
    for (const [provider, config] of Object.entries(payload.configs || {})) {
        if (!config)
            continue;
        const { tokenHash: _h, tokenVerifiedAt: _v, envVars, ...rest } = config;
        const shared = { ...rest };
        if (payload.hasToken?.[provider])
            shared.tokenRef = deployTokenRef(provider);
        if (envVars && envVars.length) {
            shared.envVars = envVars.map((e) => {
                if (e.value) {
                    const ref = deployEnvRef(provider, e.key);
                    secrets[ref] = e.value;
                    return { key: e.key, valueRef: ref };
                }
                return { key: e.key };
            });
        }
        configs[provider] = shared;
    }
    return { sanitized: { activeProvider: payload.activeProvider, configs }, secrets };
}
function resolveDeploy(payload, resolve) {
    const missingRefs = [];
    const configs = {};
    for (const [provider, shared] of Object.entries(payload.configs || {})) {
        if (!shared)
            continue;
        const { tokenRef, envVars, ...rest } = shared;
        if (tokenRef && resolve(tokenRef) == null)
            missingRefs.push(tokenRef);
        const config = { ...rest };
        if (envVars && envVars.length) {
            config.envVars = envVars.map((e) => {
                if (e.valueRef) {
                    const val = resolve(e.valueRef);
                    if (val == null)
                        missingRefs.push(e.valueRef);
                    return { key: e.key, value: val ?? '' };
                }
                return { key: e.key, value: e.value ?? '' };
            });
        }
        configs[provider] = config;
    }
    return { config: { activeProvider: payload.activeProvider, configs }, missingRefs };
}
// --- dispatch -------------------------------------------------------------
function clone(v) {
    return JSON.parse(JSON.stringify(v ?? null));
}
/**
 * Strip secrets from a domain payload. Only database/http/deploy carry secrets;
 * every other domain is passed through unchanged (deep-cloned) with an empty
 * secrets map.
 */
function stripSecrets(domain, config) {
    switch (domain) {
        case 'database':
            return stripDatabase(config);
        case 'http':
            return stripHttp(config);
        case 'deploy':
            return stripDeploy(config);
        default:
            return { sanitized: clone(config), secrets: {} };
    }
}
/** Rehydrate a sanitized domain payload, filling secrets from the resolver. */
function resolveSecrets(domain, sanitized, resolve) {
    switch (domain) {
        case 'database':
            return resolveDatabase(sanitized, resolve);
        case 'http':
            return resolveHttp(sanitized, resolve);
        case 'deploy':
            return resolveDeploy(sanitized, resolve);
        default:
            return { config: clone(sanitized), missingRefs: [] };
    }
}
