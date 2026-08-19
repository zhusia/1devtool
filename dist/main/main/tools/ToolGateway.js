"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolGateway = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const INVOCATION_CACHE_CAP = 256;
function invocationFingerprint(invocation) {
    return node_crypto_1.default.createHash('sha256').update(JSON.stringify({
        toolName: invocation.toolName,
        input: invocation.input,
    })).digest('hex');
}
class ToolGateway {
    tools = new Map();
    principals = new Map();
    invocations = new Map();
    revocationListeners = new Set();
    register(definition, requiredPermission, handler) {
        if (!/^[a-z][a-z0-9_.-]{1,63}$/i.test(definition.name))
            throw new Error('Invalid tool name');
        if (this.tools.has(definition.name))
            throw new Error(`Tool ${definition.name} is already registered`);
        this.tools.set(definition.name, { definition, requiredPermission, handler });
    }
    createPrincipal(principal, ttlMs = 60 * 60_000) {
        this.revokePrincipal(principal.principalId);
        const capabilityToken = node_crypto_1.default.randomBytes(32).toString('base64url');
        const expiresAt = Date.now() + Math.min(Math.max(ttlMs, 10_000), 24 * 60 * 60_000);
        this.principals.set(principal.principalId, {
            principal: { ...principal, permissions: [...principal.permissions] },
            capabilityToken,
            expiresAt,
        });
        this.invocations.delete(principal.principalId);
        return { capabilityToken, expiresAt };
    }
    revokePrincipal(principalId) {
        const lease = this.principals.get(principalId);
        this.principals.delete(principalId);
        this.invocations.delete(principalId);
        if (lease) {
            for (const listener of this.revocationListeners)
                listener({
                    ...lease.principal,
                    permissions: [...lease.principal.permissions],
                });
        }
    }
    onPrincipalRevoked(listener) {
        this.revocationListeners.add(listener);
        return () => this.revocationListeners.delete(listener);
    }
    definitions(principalId) {
        const lease = this.principals.get(principalId);
        if (!lease || lease.expiresAt <= Date.now())
            return [];
        return [...this.tools.values()]
            .filter((tool) => lease.principal.permissions.includes(tool.requiredPermission))
            .map((tool) => tool.definition);
    }
    async invoke(principalId, invocation) {
        const lease = this.principals.get(principalId);
        if (!lease || lease.expiresAt <= Date.now())
            return { ok: false, error: 'Tool principal is expired or unknown' };
        const expected = Buffer.from(lease.capabilityToken);
        const supplied = Buffer.from(invocation.capabilityToken);
        if (expected.length !== supplied.length || !node_crypto_1.default.timingSafeEqual(expected, supplied)) {
            return { ok: false, error: 'Tool capability is invalid' };
        }
        const tool = this.tools.get(invocation.toolName);
        if (!tool)
            return { ok: false, error: 'Unknown tool' };
        if (!lease.principal.permissions.includes(tool.requiredPermission))
            return { ok: false, error: 'Tool permission is not granted to this principal' };
        if (!invocation.callId)
            return { ok: false, error: 'Tool call id is required' };
        const fingerprint = invocationFingerprint(invocation);
        const byCall = this.invocations.get(principalId) ?? new Map();
        this.invocations.set(principalId, byCall);
        const cached = byCall.get(invocation.callId);
        if (cached) {
            if (cached.fingerprint !== fingerprint)
                return { ok: false, error: 'Tool call id was reused for a different invocation' };
            return cached.result;
        }
        const result = (async () => {
            try {
                return { ok: true, output: await tool.handler(lease.principal, invocation.input) };
            }
            catch (error) {
                return { ok: false, error: error instanceof Error ? error.message : String(error) };
            }
        })();
        byCall.set(invocation.callId, { fingerprint, result });
        while (byCall.size > INVOCATION_CACHE_CAP)
            byCall.delete(byCall.keys().next().value);
        return result;
    }
}
exports.ToolGateway = ToolGateway;
