"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerHttpTools = registerHttpTools;
const toolRegistry_1 = require("../_shared/toolRegistry");
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const BODY_TYPES = ['none', 'json', 'text', 'xml', 'form-urlencoded', 'form-data'];
const MAX_BODY_PREVIEW = 16_000;
const SECRET_HEADER_PATTERN = /^(authorization|cookie|x-api-key|x-auth-token|proxy-authorization)$/i;
function findProject(storeManager, args) {
    const projects = storeManager.getProjects();
    const requestedId = typeof args.projectId === 'string' ? args.projectId : null;
    const requestedName = typeof args.project === 'string' ? args.project : null;
    if (requestedId) {
        return projects.find((p) => p.id === requestedId) ?? null;
    }
    if (requestedName) {
        const lower = requestedName.toLowerCase();
        return projects.find((p) => p.name.toLowerCase() === lower)
            ?? projects.find((p) => p.name.toLowerCase().includes(lower))
            ?? null;
    }
    const activeId = storeManager.getActiveProjectId();
    if (activeId) {
        const active = projects.find((p) => p.id === activeId);
        if (active)
            return active;
    }
    return projects[0] ?? null;
}
function asMethod(value) {
    const upper = typeof value === 'string' ? value.toUpperCase() : '';
    return HTTP_METHODS.includes(upper) ? upper : 'GET';
}
function asBodyType(value) {
    if (typeof value !== 'string')
        return undefined;
    return BODY_TYPES.includes(value) ? value : undefined;
}
function redactHeaders(headers) {
    const out = {};
    for (const [k, v] of Object.entries(headers)) {
        out[k] = SECRET_HEADER_PATTERN.test(k) ? '«redacted»' : v;
    }
    return out;
}
function summarizeResponse(response) {
    const truncated = response.body.length > MAX_BODY_PREVIEW;
    return {
        ...response,
        body: truncated ? response.body.slice(0, MAX_BODY_PREVIEW) : response.body,
        bodyTruncated: truncated,
        headers: redactHeaders(response.headers),
    };
}
function summarizeRequest(request) {
    return {
        id: request.id,
        name: request.name,
        method: request.method,
        url: request.url,
        bodyPreview: request.body ? request.body.slice(0, 200) : '',
        hasAuth: request.auth?.type !== 'none',
        headerNames: Object.keys(request.headers ?? {}),
    };
}
function buildAuth(args) {
    const bearer = typeof args.bearerToken === 'string' ? args.bearerToken : null;
    const user = typeof args.basicUsername === 'string' ? args.basicUsername : null;
    const pass = typeof args.basicPassword === 'string' ? args.basicPassword : null;
    if (bearer)
        return { type: 'bearer', token: bearer };
    if (user && pass)
        return { type: 'basic', username: user, password: pass };
    return undefined;
}
function resolveEnvironmentVariables(project, environmentId) {
    const envs = project?.outputPanel.http?.environments ?? [];
    const targetId = environmentId ?? project?.outputPanel.http?.activeEnvironmentId;
    const env = envs.find((e) => e.id === targetId);
    if (!env)
        return {};
    const out = {};
    for (const v of env.variables) {
        if (v.enabled === false)
            continue;
        out[v.key] = v.value;
    }
    return out;
}
function interpolate(value, vars) {
    if (!value || !Object.keys(vars).length)
        return value;
    return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
        return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : `{{${key}}}`;
    });
}
function interpolateHeaders(headers, vars) {
    const out = {};
    for (const [k, v] of Object.entries(headers))
        out[k] = interpolate(v, vars);
    return out;
}
function registerHttpTools(bridge, deps) {
    const registry = bridge.getToolRegistry();
    registry.register({
        name: 'http.request',
        profile: 'http',
        description: 'Send a one-off HTTP request through the 1DevTool HTTP client.',
        inputSchema: (0, toolRegistry_1.objectSchema)({
            method: { type: 'string', enum: HTTP_METHODS },
            url: { type: 'string' },
            headers: { type: 'object', additionalProperties: { type: 'string' } },
            body: { type: 'string' },
            bodyType: { type: 'string', enum: BODY_TYPES },
            bearerToken: { type: 'string' },
            basicUsername: { type: 'string' },
            basicPassword: { type: 'string' },
        }, ['url']),
        outputKind: 'json',
        mutates: true,
        longRunning: true,
        execute: async (_, args) => {
            const method = asMethod(args.method);
            const url = typeof args.url === 'string' ? args.url : '';
            if (!url)
                throw new Error('url is required');
            const headers = args.headers && typeof args.headers === 'object' ? args.headers : {};
            const startedAt = Date.now();
            const response = await deps.httpClient.request({
                method,
                url,
                headers,
                body: typeof args.body === 'string' ? args.body : undefined,
                bodyType: asBodyType(args.bodyType),
                auth: buildAuth(args),
            });
            deps.notifyResult?.({
                projectId: null,
                source: 'request',
                title: `${method} ${url}`,
                request: { method, url },
                response,
                error: null,
                ranAt: startedAt,
            });
            return {
                request: { method, url, headerNames: Object.keys(headers) },
                response: summarizeResponse(response),
            };
        },
    });
    registry.register({
        name: 'http.list_saved_requests',
        profile: 'http',
        description: 'List saved HTTP requests for a project.',
        inputSchema: (0, toolRegistry_1.objectSchema)({
            projectId: { type: 'string' },
            project: { type: 'string' },
        }),
        outputKind: 'json',
        execute: (_, args) => {
            const project = findProject(deps.storeManager, args);
            const requests = project?.outputPanel.http?.savedRequests ?? [];
            return {
                project: project ? { id: project.id, name: project.name } : null,
                count: requests.length,
                requests: requests.map(summarizeRequest),
            };
        },
    });
    registry.register({
        name: 'http.list_environments',
        profile: 'http',
        description: 'List HTTP environments and their variables for a project.',
        inputSchema: (0, toolRegistry_1.objectSchema)({
            projectId: { type: 'string' },
            project: { type: 'string' },
        }),
        outputKind: 'json',
        execute: (_, args) => {
            const project = findProject(deps.storeManager, args);
            const envs = project?.outputPanel.http?.environments ?? [];
            const activeId = project?.outputPanel.http?.activeEnvironmentId ?? null;
            return {
                project: project ? { id: project.id, name: project.name } : null,
                activeEnvironmentId: activeId,
                count: envs.length,
                environments: envs.map((env) => ({
                    id: env.id,
                    name: env.name,
                    active: env.id === activeId,
                    variables: env.variables.map((v) => ({
                        key: v.key,
                        value: v.value,
                        enabled: v.enabled !== false,
                    })),
                })),
            };
        },
    });
    registry.register({
        name: 'http.run_saved_request',
        profile: 'http',
        description: 'Execute a saved HTTP request, applying the active environment variables.',
        inputSchema: (0, toolRegistry_1.objectSchema)({
            projectId: { type: 'string' },
            project: { type: 'string' },
            requestId: { type: 'string' },
            requestName: { type: 'string' },
            environmentId: { type: 'string' },
            overrideUrl: { type: 'string' },
        }),
        outputKind: 'json',
        mutates: true,
        longRunning: true,
        execute: async (_, args) => {
            const project = findProject(deps.storeManager, args);
            const saved = project?.outputPanel.http?.savedRequests ?? [];
            const requestedId = typeof args.requestId === 'string' ? args.requestId : null;
            const requestedName = typeof args.requestName === 'string' ? args.requestName : null;
            const found = requestedId
                ? saved.find((r) => r.id === requestedId)
                : requestedName
                    ? saved.find((r) => r.name.toLowerCase() === requestedName.toLowerCase())
                        ?? saved.find((r) => r.name.toLowerCase().includes(requestedName.toLowerCase()))
                    : saved[0];
            if (!found)
                throw new Error('Saved request not found. Use http.list_saved_requests first.');
            const envVars = resolveEnvironmentVariables(project, typeof args.environmentId === 'string' ? args.environmentId : null);
            const finalUrl = interpolate(typeof args.overrideUrl === 'string' && args.overrideUrl ? args.overrideUrl : found.url, envVars);
            const finalHeaders = interpolateHeaders(found.headers ?? {}, envVars);
            const finalBody = interpolate(found.body ?? '', envVars);
            const startedAt = Date.now();
            const response = await deps.httpClient.request({
                method: found.method,
                url: finalUrl,
                headers: finalHeaders,
                body: finalBody || undefined,
                auth: found.auth,
            });
            deps.notifyResult?.({
                projectId: project?.id ?? null,
                source: 'saved',
                title: found.name || `${found.method} ${finalUrl}`,
                request: { method: found.method, url: finalUrl },
                response,
                error: null,
                ranAt: startedAt,
            });
            return {
                project: project ? { id: project.id, name: project.name } : null,
                savedRequest: { id: found.id, name: found.name },
                request: { method: found.method, url: finalUrl, headerNames: Object.keys(finalHeaders) },
                response: summarizeResponse(response),
            };
        },
    });
    bridge.addRoutes('http', [
        { path: '/http/request', method: 'POST', handler: (p) => registry.call('http.request', p) },
        { path: '/http/list-saved-requests', method: 'POST', handler: (p) => registry.call('http.list_saved_requests', p) },
        { path: '/http/list-environments', method: 'POST', handler: (p) => registry.call('http.list_environments', p) },
        { path: '/http/run-saved-request', method: 'POST', handler: (p) => registry.call('http.run_saved_request', p) },
    ]);
    bridge.enableFeature('http');
}
