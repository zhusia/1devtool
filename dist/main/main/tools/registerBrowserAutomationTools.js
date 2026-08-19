"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerBrowserAutomationTools = registerBrowserAutomationTools;
const node_path_1 = __importDefault(require("node:path"));
function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Tool input must be an object');
    return value;
}
function samePath(left, right) {
    const a = node_path_1.default.resolve(left);
    const b = node_path_1.default.resolve(right);
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function principalOwnsLease(principal, lease) {
    if (lease.scope.projectId !== principal.projectId || !samePath(lease.scope.workspacePath, principal.workspacePath))
        return false;
    if (lease.scope.kind === 'run')
        return Boolean(principal.runId && principal.runId === lease.scope.runId);
    if (lease.scope.kind === 'session')
        return Boolean(principal.sessionId && principal.sessionId === lease.scope.sessionId);
    return true;
}
function requireOwnedLease(browser, principal, leaseId) {
    const lease = browser.list().find((item) => item.leaseId === leaseId);
    if (!lease || !principalOwnsLease(principal, lease))
        throw new Error('Browser lease does not belong to this tool principal');
}
function registerBrowserAutomationTools(gateway, browser) {
    gateway.onPrincipalRevoked((principal) => {
        const owned = browser.list().filter((lease) => principalOwnsLease(principal, lease));
        void Promise.allSettled(owned.map((lease) => browser.closeContext(lease.leaseId)));
    });
    gateway.register({
        name: 'browser.context.create',
        description: 'Create a fresh isolated Playwright browser context scoped to this session or run.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    }, 'browser:write', async (principal) => browser.createContext(principal.runId ? {
        kind: 'run', projectId: principal.projectId, workspacePath: principal.workspacePath,
        runId: principal.runId, ...(principal.teamId ? { orchestrationId: principal.teamId } : {}),
    } : principal.sessionId ? {
        kind: 'session', projectId: principal.projectId, workspacePath: principal.workspacePath,
        sessionId: principal.sessionId,
    } : {
        kind: 'workspace', projectId: principal.projectId, workspacePath: principal.workspacePath,
    }));
    gateway.register({
        name: 'browser.perform',
        description: 'Perform one authorized operation in an isolated browser context.',
        inputSchema: {
            type: 'object',
            required: ['leaseId', 'capabilityToken', 'operation'],
            properties: {
                leaseId: { type: 'string' },
                capabilityToken: { type: 'string' },
                operation: { type: 'object' },
            },
        },
    }, 'browser:write', async (principal, input) => {
        const value = record(input);
        if (typeof value.leaseId !== 'string' || typeof value.capabilityToken !== 'string')
            throw new Error('leaseId and capabilityToken are required');
        requireOwnedLease(browser, principal, value.leaseId);
        return browser.perform(value.leaseId, value.capabilityToken, value.operation);
    });
    gateway.register({
        name: 'browser.context.close',
        description: 'Close an isolated browser context and release its pages.',
        inputSchema: {
            type: 'object', required: ['leaseId', 'capabilityToken'],
            properties: { leaseId: { type: 'string' }, capabilityToken: { type: 'string' } },
        },
    }, 'browser:write', async (principal, input) => {
        const value = record(input);
        if (typeof value.leaseId !== 'string' || typeof value.capabilityToken !== 'string')
            throw new Error('leaseId and capabilityToken are required');
        requireOwnedLease(browser, principal, value.leaseId);
        await browser.closeContext(value.leaseId, value.capabilityToken);
        return { closed: true };
    });
}
