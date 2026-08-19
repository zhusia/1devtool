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
exports.MssqlAdapter = void 0;
const utils_1 = require("../utils");
class MssqlAdapter {
    async testConnection(conn) {
        await this.withPool(conn, async (pool) => {
            await pool.request().query('SELECT 1');
        });
    }
    async query(conn, sql) {
        const statements = (0, utils_1.splitSqlStatements)(sql);
        return this.withPool(conn, async (pool) => {
            const results = [];
            for (const statement of statements) {
                const startedAt = Date.now();
                const result = await pool.request().query(statement);
                const rows = result.recordset || [];
                results.push({
                    statement,
                    rowCount: result.rowsAffected?.[0] ?? rows.length,
                    rows: (0, utils_1.serializeRows)(rows),
                    columns: rows.length > 0
                        ? Object.keys(rows[0]).map((name) => ({
                            name,
                            type: (0, utils_1.inferColumnType)(name, rows),
                        }))
                        : (result.recordset?.columns
                            ? Object.keys(result.recordset.columns).map((name) => ({
                                name,
                                type: String(result.recordset.columns[name].type?.declaration ?? 'unknown'),
                            }))
                            : []),
                    durationMs: Date.now() - startedAt,
                    source: { type: 'query' },
                });
            }
            return results;
        });
    }
    async schema(conn) {
        return this.withPool(conn, async (pool) => {
            const rows = await this.getSchemaRows(pool);
            return (0, utils_1.groupSchemaRows)(rows);
        });
    }
    async previewTable(conn, schema, table, options) {
        return this.withPool(conn, async (pool) => {
            const columns = await this.getTableColumns(pool, schema, table);
            const primaryKeys = columns.filter((c) => c.primaryKey).map((c) => c.name);
            const { searchClause, params } = this.buildSearchFilter(columns, options.search || '');
            const whereClause = (0, utils_1.joinWhereClauses)([options.filter || '', searchClause]);
            const orderClause = (0, utils_1.buildOrderClause)('mssql', columns, options.sortColumn, options.sortDirection) ||
                (columns[0] ? ` order by ${(0, utils_1.escapeIdentifier)('mssql', columns[0].name)} asc` : ' order by (select null)');
            const limit = (0, utils_1.clampLimit)(options.limit || 100);
            const offset = (0, utils_1.clampOffset)(options.offset);
            const qualifiedTable = (0, utils_1.qualifyTable)('mssql', schema, table);
            const countStatement = `SELECT COUNT(*) AS total FROM ${qualifiedTable}${whereClause}`;
            const statement = `SELECT * FROM ${qualifiedTable}${whereClause}${orderClause} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
            const startedAt = Date.now();
            const countRequest = pool.request();
            params.forEach((value, index) => {
                countRequest.input(`f${index + 1}`, value);
            });
            const countResult = await countRequest.query(countStatement);
            const request = pool.request();
            params.forEach((value, index) => {
                request.input(`f${index + 1}`, value);
            });
            const result = await request.query(statement);
            const rows = result.recordset || [];
            const total = Number(countResult.recordset?.[0]?.total ?? rows.length);
            return {
                statement,
                rowCount: Number.isFinite(total) ? total : rows.length,
                rows: (0, utils_1.serializeRows)(rows),
                columns: columns.map((c) => ({ name: c.name, type: c.type })),
                durationMs: Date.now() - startedAt,
                source: { type: 'table', schema, table, primaryKeys },
            };
        });
    }
    async updateRow(conn, schema, table, nextRow, originalRow, whereColumns) {
        const changedColumns = Object.keys(nextRow).filter((col) => nextRow[col] !== originalRow[col]);
        if (changedColumns.length === 0)
            return;
        return this.withPool(conn, async (pool) => {
            const { sql, values } = (0, utils_1.buildGenericUpdate)('mssql', schema, table, changedColumns, whereColumns, nextRow, originalRow, 'at');
            const request = pool.request();
            values.forEach((value, index) => {
                request.input(`p${index + 1}`, value);
            });
            await request.query(sql);
        });
    }
    async withPool(conn, cb) {
        const mssql = await Promise.resolve().then(() => __importStar(require('mssql')));
        const pool = new mssql.default.ConnectionPool({
            server: conn.host,
            port: conn.port,
            database: conn.database,
            user: conn.user,
            password: conn.password,
            options: {
                encrypt: conn.ssl,
                trustServerCertificate: true,
            },
        });
        await pool.connect();
        try {
            return await cb(pool);
        }
        finally {
            await pool.close().catch(() => undefined);
        }
    }
    async getSchemaRows(pool) {
        const result = await pool.request().query(`
      SELECT
        s.name AS schema_name,
        o.name AS table_name,
        CASE o.type WHEN 'V' THEN 'view' ELSE 'table' END AS table_type,
        c.name AS column_name,
        t.name AS data_type,
        c.is_nullable,
        d.definition AS column_default,
        CASE WHEN ic.object_id IS NOT NULL THEN 1 ELSE 0 END AS is_primary_key
      FROM sys.columns c
      JOIN sys.objects o ON o.object_id = c.object_id
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      JOIN sys.types t ON t.user_type_id = c.user_type_id
      LEFT JOIN sys.default_constraints d ON d.object_id = c.default_object_id
      LEFT JOIN (
        SELECT ic.object_id, ic.column_id
        FROM sys.index_columns ic
        JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        WHERE i.is_primary_key = 1
      ) ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
      WHERE o.type IN ('U', 'V')
        AND s.name NOT IN ('sys', 'INFORMATION_SCHEMA')
      ORDER BY s.name, o.name, c.column_id
    `);
        return (result.recordset || []).map((row) => ({
            schema: row.schema_name,
            table: row.table_name,
            type: row.table_type,
            column: row.column_name,
            dataType: row.data_type,
            nullable: row.is_nullable === 1 || row.is_nullable === true,
            defaultValue: row.column_default ?? null,
            primaryKey: row.is_primary_key === 1,
        }));
    }
    async getTableColumns(pool, schema, table) {
        const request = pool.request();
        request.input('schema', schema);
        request.input('table', table);
        const result = await request.query(`
      SELECT
        c.name AS column_name,
        t.name AS data_type,
        c.is_nullable,
        d.definition AS column_default,
        CASE WHEN ic.object_id IS NOT NULL THEN 1 ELSE 0 END AS is_primary_key
      FROM sys.columns c
      JOIN sys.objects o ON o.object_id = c.object_id
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      JOIN sys.types t ON t.user_type_id = c.user_type_id
      LEFT JOIN sys.default_constraints d ON d.object_id = c.default_object_id
      LEFT JOIN (
        SELECT ic.object_id, ic.column_id
        FROM sys.index_columns ic
        JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        WHERE i.is_primary_key = 1
      ) ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
      WHERE s.name = @schema
        AND o.name = @table
      ORDER BY c.column_id
    `);
        return (result.recordset || []).map((row) => ({
            name: row.column_name,
            type: row.data_type,
            nullable: row.is_nullable === 1 || row.is_nullable === true,
            defaultValue: row.column_default ?? null,
            primaryKey: row.is_primary_key === 1,
        }));
    }
    buildSearchFilter(columns, filter) {
        const normalizedFilter = filter.trim();
        if (!normalizedFilter || columns.length === 0) {
            return { searchClause: '', params: [] };
        }
        const params = [];
        const clauses = columns.map((column, index) => {
            params.push(`%${normalizedFilter}%`);
            return `CAST(${(0, utils_1.escapeIdentifier)('mssql', column.name)} AS NVARCHAR(MAX)) LIKE @f${index + 1}`;
        });
        return {
            searchClause: clauses.join(' OR '),
            params,
        };
    }
}
exports.MssqlAdapter = MssqlAdapter;
