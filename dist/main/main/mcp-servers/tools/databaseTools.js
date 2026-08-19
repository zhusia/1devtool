"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerDatabaseTools = registerDatabaseTools;
const database_engines_1 = require("../../../shared/database-engines");
const utils_1 = require("../../database/utils");
const toolRegistry_1 = require("../_shared/toolRegistry");
const MAX_SCHEMA_TABLES = 200;
const SAMPLE_ROW_LIMIT = 25;
function stripScope(connection) {
    const copy = { ...connection };
    delete copy.scope;
    return copy;
}
function connectionSummary(connection, project, activeConnectionId) {
    return {
        id: connection.id,
        name: connection.name,
        engine: connection.engine,
        host: connection.host,
        port: connection.port,
        database: connection.database,
        safeMode: connection.safeMode,
        colorTag: connection.colorTag,
        scope: connection.scope,
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
        active: connection.id === activeConnectionId,
    };
}
function findProject(storeManager, args) {
    const projects = storeManager.getProjects();
    const requestedProjectId = typeof args.projectId === 'string' ? args.projectId : null;
    const requestedProjectName = typeof args.project === 'string' ? args.project : null;
    if (requestedProjectId) {
        return projects.find((project) => project.id === requestedProjectId) ?? null;
    }
    if (requestedProjectName) {
        const lower = requestedProjectName.toLowerCase();
        return projects.find((project) => project.name.toLowerCase() === lower)
            ?? projects.find((project) => project.name.toLowerCase().includes(lower))
            ?? null;
    }
    const activeProjectId = storeManager.getActiveProjectId();
    if (activeProjectId) {
        const activeProject = projects.find((project) => project.id === activeProjectId);
        if (activeProject)
            return activeProject;
    }
    return projects[0] ?? null;
}
function getMergedConnections(storeManager, project) {
    const projectConnections = (project?.outputPanel.database?.connections ?? [])
        .map((connection) => ({ ...connection, scope: 'project' }));
    const globalConnections = storeManager.getGlobalDatabaseConnections()
        .map((connection) => ({ ...connection, scope: 'global' }));
    const seenProjectIds = new Set(projectConnections.map((connection) => connection.id));
    return [
        ...projectConnections,
        ...globalConnections.filter((connection) => !seenProjectIds.has(connection.id)),
    ];
}
function resolveConnection(storeManager, args) {
    const project = findProject(storeManager, args);
    const mergedConnections = getMergedConnections(storeManager, project);
    const requestedConnectionId = typeof args.connectionId === 'string' ? args.connectionId : null;
    const requestedConnectionName = typeof args.connectionName === 'string' ? args.connectionName : null;
    const activeConnectionId = project?.outputPanel.database?.activeConnectionId ?? null;
    const connection = requestedConnectionId
        ? mergedConnections.find((candidate) => candidate.id === requestedConnectionId)
        : requestedConnectionName
            ? mergedConnections.find((candidate) => candidate.name.toLowerCase() === requestedConnectionName.toLowerCase())
                ?? mergedConnections.find((candidate) => candidate.name.toLowerCase().includes(requestedConnectionName.toLowerCase()))
            : mergedConnections.find((candidate) => candidate.id === activeConnectionId) ?? mergedConnections[0];
    if (!connection) {
        throw new Error('No database connection found. Create or select a connection in the Database panel first.');
    }
    return { project, connection: stripScope(connection) };
}
function summarizeResult(result) {
    return {
        ...result,
        rows: result.rows.slice(0, SAMPLE_ROW_LIMIT),
        documents: Array.isArray(result.documents) ? result.documents.slice(0, SAMPLE_ROW_LIMIT) : result.documents,
        rawOutput: typeof result.rawOutput === 'string' ? result.rawOutput.slice(0, 16_000) : result.rawOutput,
    };
}
function isSqlReadOnly(sql) {
    const statements = (0, utils_1.splitSqlStatements)(sql);
    return statements.length === 0 || statements.every(utils_1.isReadOnlyStatement);
}
function shouldDescribeSqlFirst(connection) {
    const engineDef = database_engines_1.ENGINE_REGISTRY[connection.engine];
    return engineDef?.queryLanguage === 'sql'
        || engineDef?.queryLanguage === 'cql'
        || engineDef?.queryLanguage === 'surrealql';
}
function registerDatabaseTools(bridge, deps) {
    const registry = bridge.getToolRegistry();
    registry.register({
        name: 'database.list_connections',
        profile: 'database',
        description: 'List configured database connections without returning credentials.',
        inputSchema: (0, toolRegistry_1.objectSchema)({
            projectId: { type: 'string', description: 'Optional project id to scope project connections' },
            project: { type: 'string', description: 'Optional project name to scope project connections' },
        }),
        outputKind: 'json',
        execute: (_, args) => {
            const project = findProject(deps.storeManager, args);
            const activeConnectionId = project?.outputPanel.database?.activeConnectionId ?? null;
            const connections = getMergedConnections(deps.storeManager, project)
                .map((connection) => connectionSummary(connection, project, activeConnectionId));
            return { connections };
        },
    });
    registry.register({
        name: 'database.describe_schema',
        profile: 'database',
        description: 'Describe tables, columns, primary keys, and collection metadata for a database connection.',
        inputSchema: (0, toolRegistry_1.objectSchema)({
            projectId: { type: 'string' },
            project: { type: 'string' },
            connectionId: { type: 'string' },
            connectionName: { type: 'string' },
            schema: { type: 'string', description: 'Optional schema/keyspace/database filter' },
        }),
        outputKind: 'json',
        longRunning: true,
        execute: async (_, args) => {
            const { project, connection } = resolveConnection(deps.storeManager, args);
            const schemaFilter = typeof args.schema === 'string' ? args.schema.toLowerCase() : null;
            const tables = await deps.databaseManager.schema(connection);
            const filtered = schemaFilter
                ? tables.filter((table) => table.schema.toLowerCase() === schemaFilter)
                : tables;
            return {
                connection: connectionSummary({ ...connection, scope: undefined }, project, project?.outputPanel.database?.activeConnectionId ?? null),
                tableCount: filtered.length,
                capped: filtered.length > MAX_SCHEMA_TABLES,
                tables: filtered.slice(0, MAX_SCHEMA_TABLES),
            };
        },
    });
    registry.register({
        name: 'database.query',
        profile: 'database',
        description: 'Run a query against the active or named database connection. Safe Mode blocks write queries.',
        inputSchema: (0, toolRegistry_1.objectSchema)({
            projectId: { type: 'string' },
            project: { type: 'string' },
            connectionId: { type: 'string' },
            connectionName: { type: 'string' },
            sql: { type: 'string', description: 'Query text to execute' },
        }, ['sql']),
        outputKind: 'json',
        mutates: true,
        longRunning: true,
        execute: async (_, args) => {
            if (typeof args.sql !== 'string' || !args.sql.trim()) {
                throw new Error('sql is required');
            }
            const { project, connection } = resolveConnection(deps.storeManager, args);
            const startedAt = Date.now();
            const results = await deps.databaseManager.query(connection, args.sql);
            const summarized = results.map(summarizeResult);
            deps.notifyResult?.({
                projectId: project?.id ?? null,
                connectionId: connection.id,
                connectionName: connection.name,
                source: 'query',
                title: 'AI query',
                sql: args.sql,
                results,
                error: null,
                ranAt: startedAt,
            });
            return {
                connection: connectionSummary({ ...connection, scope: undefined }, project, project?.outputPanel.database?.activeConnectionId ?? null),
                readOnly: isSqlReadOnly(args.sql),
                shouldDescribeSchemaFirst: shouldDescribeSqlFirst(connection),
                statementCount: results.length,
                results: summarized.map((result) => ({
                    statement: result.statement,
                    rowCount: result.rowCount,
                    columns: result.columns,
                    sampleRows: result.rows,
                    durationMs: result.durationMs,
                    notice: result.notice,
                    resultFormat: result.resultFormat,
                    sampleDocuments: result.documents,
                    rawOutputPreview: result.rawOutput,
                })),
            };
        },
    });
    registry.register({
        name: 'database.preview_table',
        profile: 'database',
        description: 'Preview rows from a table using the same adapter path as the Database panel.',
        inputSchema: (0, toolRegistry_1.objectSchema)({
            projectId: { type: 'string' },
            project: { type: 'string' },
            connectionId: { type: 'string' },
            connectionName: { type: 'string' },
            schema: { type: 'string' },
            table: { type: 'string' },
            search: { type: 'string' },
            filter: { type: 'string' },
            limit: { type: 'number' },
            offset: { type: 'number' },
            sortColumn: { type: 'string' },
            sortDirection: { type: 'string', enum: ['asc', 'desc'] },
        }, ['schema', 'table']),
        outputKind: 'json',
        longRunning: true,
        execute: async (_, args) => {
            if (typeof args.schema !== 'string' || typeof args.table !== 'string') {
                throw new Error('schema and table are required');
            }
            const { project, connection } = resolveConnection(deps.storeManager, args);
            const options = {
                search: typeof args.search === 'string' ? args.search : undefined,
                filter: typeof args.filter === 'string' ? args.filter : undefined,
                limit: typeof args.limit === 'number' ? args.limit : SAMPLE_ROW_LIMIT,
                offset: typeof args.offset === 'number' ? args.offset : undefined,
                sortColumn: typeof args.sortColumn === 'string' ? args.sortColumn : undefined,
                sortDirection: args.sortDirection === 'desc' ? 'desc' : 'asc',
            };
            const startedAt = Date.now();
            const result = await deps.databaseManager.previewTable(connection, args.schema, args.table, options);
            deps.notifyResult?.({
                projectId: project?.id ?? null,
                connectionId: connection.id,
                connectionName: connection.name,
                source: 'table',
                title: `${args.schema}.${args.table}`,
                results: [result],
                error: null,
                ranAt: startedAt,
            });
            const summarized = summarizeResult(result);
            return {
                connection: connectionSummary({ ...connection, scope: undefined }, project, project?.outputPanel.database?.activeConnectionId ?? null),
                schema: args.schema,
                table: args.table,
                rowCount: result.rowCount,
                columns: result.columns,
                sampleRows: summarized.rows,
                durationMs: result.durationMs,
                notice: result.notice,
            };
        },
    });
}
