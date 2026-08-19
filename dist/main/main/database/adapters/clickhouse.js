"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClickHouseAdapter = void 0;
const utils_1 = require("../utils");
class ClickHouseAdapter {
    async testConnection(conn) {
        await this.withClient(conn, async (client) => {
            const resultSet = await client.query({ query: 'SELECT 1', format: 'JSONEachRow' });
            await resultSet.json();
        });
    }
    async query(conn, sql) {
        const statements = (0, utils_1.splitSqlStatements)(sql);
        return this.withClient(conn, async (client) => {
            const results = [];
            for (const statement of statements) {
                const startedAt = Date.now();
                const resultSet = await client.query({ query: statement, format: 'JSONEachRow' });
                const rows = await resultSet.json();
                results.push({
                    statement,
                    rowCount: rows.length,
                    rows: (0, utils_1.serializeRows)(rows),
                    columns: rows.length > 0
                        ? Object.keys(rows[0]).map((name) => ({
                            name,
                            type: (0, utils_1.inferColumnType)(name, rows),
                        }))
                        : [],
                    durationMs: Date.now() - startedAt,
                    source: { type: 'query' },
                });
            }
            return results;
        });
    }
    async schema(conn) {
        return this.withClient(conn, async (client) => {
            const rows = await this.getSchemaRows(client, conn.database);
            return (0, utils_1.groupSchemaRows)(rows);
        });
    }
    async previewTable(conn, schema, table, options) {
        return this.withClient(conn, async (client) => {
            const columns = await this.getTableColumns(client, conn.database, table);
            const searchClause = this.buildSearchFilter(columns.map((c) => c.name), options.search || '');
            const whereClause = (0, utils_1.joinWhereClauses)([options.filter || '', searchClause]);
            const orderClause = (0, utils_1.buildOrderClause)('clickhouse', columns, options.sortColumn, options.sortDirection);
            const limit = (0, utils_1.clampLimit)(options.limit || 100);
            const offset = (0, utils_1.clampOffset)(options.offset);
            const qualified = schema
                ? (0, utils_1.qualifyTable)('clickhouse', schema, table)
                : (0, utils_1.escapeIdentifier)('clickhouse', table);
            const countStatement = `SELECT count() AS total FROM ${qualified}${whereClause}`;
            const statement = `SELECT * FROM ${qualified}${whereClause}${orderClause} LIMIT ${limit} OFFSET ${offset}`;
            const startedAt = Date.now();
            const countResultSet = await client.query({ query: countStatement, format: 'JSONEachRow' });
            const countRows = await countResultSet.json();
            const resultSet = await client.query({ query: statement, format: 'JSONEachRow' });
            const rows = await resultSet.json();
            const total = Number(countRows[0]?.total ?? rows.length);
            return {
                statement,
                rowCount: Number.isFinite(total) ? total : rows.length,
                rows: (0, utils_1.serializeRows)(rows),
                columns: columns.map((c) => ({ name: c.name, type: c.type })),
                durationMs: Date.now() - startedAt,
                source: { type: 'table', schema, table, primaryKeys: [] },
            };
        });
    }
    async updateRow(_conn, _schema, _table, _nextRow, _originalRow, _primaryKeys) {
        throw new Error('ClickHouse does not support single-row updates');
    }
    async withClient(conn, cb) {
        const { createClient } = await Promise.resolve().then(() => __importStar(require('@clickhouse/client')));
        const client = createClient({
            url: `${conn.ssl ? 'https' : 'http'}://${conn.host}:${conn.port}`,
            username: conn.user,
            password: conn.password,
            database: conn.database,
        });
        try {
            return await cb(client);
        }
        finally {
            await client.close().catch(() => undefined);
        }
    }
    async getSchemaRows(client, database) {
        const resultSet = await client.query({
            query: `
        SELECT
          database,
          table,
          name AS column_name,
          type AS data_type,
          default_kind,
          default_expression,
          is_in_primary_key
        FROM system.columns
        WHERE database = {db:String}
        ORDER BY database, table, position
      `,
            query_params: { db: database },
            format: 'JSONEachRow',
        });
        const rows = await resultSet.json();
        return rows.map((row) => ({
            schema: row.database,
            table: row.table,
            type: 'table',
            column: row.column_name,
            dataType: row.data_type,
            nullable: row.data_type.startsWith('Nullable'),
            defaultValue: row.default_expression || null,
            primaryKey: row.is_in_primary_key === 1,
        }));
    }
    async getTableColumns(client, database, table) {
        const resultSet = await client.query({
            query: `
        SELECT
          name AS column_name,
          type AS data_type
        FROM system.columns
        WHERE database = {db:String}
          AND table = {tbl:String}
        ORDER BY position
      `,
            query_params: { db: database, tbl: table },
            format: 'JSONEachRow',
        });
        const rows = await resultSet.json();
        return rows.map((row) => ({
            name: row.column_name,
            type: row.data_type,
            nullable: row.data_type.startsWith('Nullable'),
        }));
    }
    buildSearchFilter(columnNames, filter) {
        const normalizedFilter = filter.trim();
        if (!normalizedFilter || columnNames.length === 0) {
            return '';
        }
        const escaped = normalizedFilter.replace(/'/g, "\\'");
        const clauses = columnNames.map((name) => `toString(${(0, utils_1.escapeIdentifier)('clickhouse', name)}) LIKE '%${escaped}%'`);
        return clauses.join(' OR ');
    }
}
exports.ClickHouseAdapter = ClickHouseAdapter;
