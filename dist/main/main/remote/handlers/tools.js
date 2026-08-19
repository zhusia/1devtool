"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerToolHandlers = registerToolHandlers;
const crypto_1 = require("crypto");
function errorMessage(err, fallback) {
    return err instanceof Error ? err.message : fallback;
}
function findProject(storeManager, projectId) {
    if (!projectId)
        return null;
    return storeManager.getProjects().find((project) => project.id === projectId) || null;
}
function projectHttpTabs(project) {
    return project.outputPanel?.http?.tabs || [];
}
function projectDatabaseConnections(project) {
    return project.outputPanel?.database?.connections || [];
}
function httpSummary(tab, scope, project) {
    return {
        id: tab.id,
        scope,
        projectId: project?.id,
        projectName: project?.name,
        name: tab.name || tab.url || 'Untitled request',
        method: tab.method,
        url: tab.url,
    };
}
function dbSummary(connection, scope, project) {
    return {
        id: connection.id,
        scope,
        projectId: project?.id,
        projectName: project?.name,
        name: connection.name,
        engine: connection.engine,
        host: connection.host,
        port: connection.port,
        database: connection.database,
        safeMode: connection.safeMode,
    };
}
function findHttpTab(storeManager, ref) {
    if (ref.scope === 'global') {
        return storeManager.getGlobalHttpTabs().find((tab) => tab.id === ref.id) || null;
    }
    const project = findProject(storeManager, ref.projectId);
    if (!project)
        return null;
    return projectHttpTabs(project).find((tab) => tab.id === ref.id) || null;
}
function saveHttpTab(storeManager, scope, projectId, draft) {
    const id = draft.id || (0, crypto_1.randomUUID)();
    const tab = {
        id,
        name: draft.name?.trim() || draft.url || 'Untitled request',
        method: draft.method,
        url: draft.url,
        headers: draft.headers || {},
        body: draft.body || '',
        auth: draft.auth || { type: 'none' },
        bodyType: draft.bodyType || 'json',
        formBody: draft.formBody || [],
    };
    if (scope === 'global') {
        const tabs = storeManager.getGlobalHttpTabs();
        const idx = tabs.findIndex((existing) => existing.id === id);
        const next = idx >= 0
            ? tabs.map((existing) => (existing.id === id ? { ...existing, ...tab } : existing))
            : [tab, ...tabs];
        storeManager.setGlobalHttpTabs(next);
        return tab;
    }
    const project = findProject(storeManager, projectId);
    if (!project)
        throw new Error('Project not found');
    const tabs = projectHttpTabs(project);
    const idx = tabs.findIndex((existing) => existing.id === id);
    const nextTabs = idx >= 0
        ? tabs.map((existing) => (existing.id === id ? { ...existing, ...tab } : existing))
        : [tab, ...tabs];
    storeManager.saveProject({
        ...project,
        outputPanel: {
            ...project.outputPanel,
            http: {
                ...project.outputPanel.http,
                tabs: nextTabs,
            },
        },
    });
    return tab;
}
function findDatabaseConnection(storeManager, ref) {
    if (ref.scope === 'global') {
        return storeManager.getGlobalDatabaseConnections().find((connection) => connection.id === ref.id) || null;
    }
    const project = findProject(storeManager, ref.projectId);
    if (!project)
        return null;
    return projectDatabaseConnections(project).find((connection) => connection.id === ref.id) || null;
}
/**
 * Mobile Tools bridge. The phone UI is Preact/socket-based, so it cannot mount
 * the desktop React/Electron components directly. These handlers expose the
 * same persisted HTTP/database state and execution managers over authenticated
 * socket events.
 */
function registerToolHandlers(io, managers) {
    const { storeManager, httpClient, databaseManager } = managers;
    io.on('connection', (socket) => {
        socket.on('tools:http:list', (_payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (!storeManager) {
                ack({ ok: false, error: 'Store unavailable' });
                return;
            }
            try {
                const requests = [
                    ...storeManager.getGlobalHttpTabs().map((tab) => httpSummary(tab, 'global')),
                ];
                for (const project of storeManager.getProjects()) {
                    requests.push(...projectHttpTabs(project).map((tab) => httpSummary(tab, 'project', project)));
                }
                ack({ ok: true, requests });
            }
            catch (err) {
                ack({ ok: false, error: errorMessage(err, 'Failed to load HTTP requests') });
            }
        });
        socket.on('tools:http:get', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (!storeManager) {
                ack({ ok: false, error: 'Store unavailable' });
                return;
            }
            const tab = findHttpTab(storeManager, payload);
            if (!tab) {
                ack({ ok: false, error: 'Request not found' });
                return;
            }
            ack({ ok: true, request: tab });
        });
        socket.on('tools:http:send', async (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (!httpClient) {
                ack({ ok: false, error: 'HTTP client unavailable' });
                return;
            }
            if (!payload?.url) {
                ack({ ok: false, error: 'URL is required' });
                return;
            }
            try {
                const response = await httpClient.request({
                    method: payload.method,
                    url: payload.url,
                    headers: payload.headers || {},
                    body: payload.body || '',
                    auth: payload.auth || { type: 'none' },
                    bodyType: payload.bodyType || 'json',
                    formBody: payload.formBody || [],
                });
                ack({ ok: true, response });
            }
            catch (err) {
                ack({ ok: false, error: errorMessage(err, 'Request failed') });
            }
        });
        socket.on('tools:http:save', (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (!storeManager) {
                ack({ ok: false, error: 'Store unavailable' });
                return;
            }
            if (!payload?.request?.url) {
                ack({ ok: false, error: 'URL is required' });
                return;
            }
            try {
                const saved = saveHttpTab(storeManager, payload.scope, payload.projectId, payload.request);
                const project = payload.scope === 'project' ? findProject(storeManager, payload.projectId) || undefined : undefined;
                ack({ ok: true, request: httpSummary(saved, payload.scope, project) });
            }
            catch (err) {
                ack({ ok: false, error: errorMessage(err, 'Failed to save request') });
            }
        });
        socket.on('tools:db:list', (_payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (!storeManager) {
                ack({ ok: false, error: 'Store unavailable' });
                return;
            }
            try {
                const connections = [
                    ...storeManager.getGlobalDatabaseConnections().map((connection) => dbSummary(connection, 'global')),
                ];
                for (const project of storeManager.getProjects()) {
                    connections.push(...projectDatabaseConnections(project).map((connection) => dbSummary(connection, 'project', project)));
                }
                ack({ ok: true, connections });
            }
            catch (err) {
                ack({ ok: false, error: errorMessage(err, 'Failed to load database connections') });
            }
        });
        socket.on('tools:db:test', async (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (!storeManager || !databaseManager) {
                ack({ ok: false, error: 'Database unavailable' });
                return;
            }
            const connection = findDatabaseConnection(storeManager, payload);
            if (!connection) {
                ack({ ok: false, error: 'Connection not found' });
                return;
            }
            try {
                await databaseManager.testConnection(connection);
                ack({ ok: true });
            }
            catch (err) {
                ack({ ok: false, error: errorMessage(err, 'Failed to connect to database') });
            }
        });
        socket.on('tools:db:schema', async (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (!storeManager || !databaseManager) {
                ack({ ok: false, error: 'Database unavailable' });
                return;
            }
            const connection = findDatabaseConnection(storeManager, payload);
            if (!connection) {
                ack({ ok: false, error: 'Connection not found' });
                return;
            }
            try {
                const tables = await databaseManager.schema(connection);
                ack({ ok: true, tables });
            }
            catch (err) {
                ack({ ok: false, error: errorMessage(err, 'Failed to load database schema') });
            }
        });
        socket.on('tools:db:query', async (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (!storeManager || !databaseManager) {
                ack({ ok: false, error: 'Database unavailable' });
                return;
            }
            const sql = (payload?.sql || '').trim();
            if (!sql) {
                ack({ ok: false, error: 'Query is required' });
                return;
            }
            const connection = findDatabaseConnection(storeManager, payload);
            if (!connection) {
                ack({ ok: false, error: 'Connection not found' });
                return;
            }
            try {
                const results = await databaseManager.query(connection, sql);
                ack({ ok: true, results });
            }
            catch (err) {
                ack({ ok: false, error: errorMessage(err, 'Failed to execute query') });
            }
        });
        socket.on('tools:db:preview', async (payload, ack) => {
            if (!socket.data.authenticated)
                return;
            if (typeof ack !== 'function')
                return;
            if (!storeManager || !databaseManager) {
                ack({ ok: false, error: 'Database unavailable' });
                return;
            }
            const connection = findDatabaseConnection(storeManager, payload);
            if (!connection) {
                ack({ ok: false, error: 'Connection not found' });
                return;
            }
            try {
                const result = await databaseManager.previewTable(connection, payload.schema, payload.table, payload.options || { limit: 50 });
                ack({ ok: true, result });
            }
            catch (err) {
                ack({ ok: false, error: errorMessage(err, 'Failed to preview table') });
            }
        });
    });
}
