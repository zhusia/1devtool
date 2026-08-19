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
exports.MysqlAdapter = void 0;
const utils_1 = require("../utils");
class MysqlAdapter {
    async testConnection(conn) {
        await this.withClient(conn, async (client) => {
            await client.query('select 1');
        });
    }
    async query(conn, sql) {
        const statements = (0, utils_1.splitSqlStatements)(sql);
        return this.withClient(conn, async (client) => {
            const results = [];
            for (const statement of statements) {
                const startedAt = Date.now();
                const [rows, fields] = await client.query(statement);
                results.push(this.normalizeResult(statement, rows, fields, Date.now() - startedAt));
            }
            return results;
        });
    }
    async schema(conn) {
        return this.withClient(conn, async (client) => {
            const rows = await this.getSchemaRows(client);
            return (0, utils_1.groupSchemaRows)(rows);
        });
    }
    async previewTable(conn, schema, table, options) {
        return this.withClient(conn, async (client) => {
            const columns = await this.getTableColumns(client, schema, table);
            const primaryKeys = columns.filter((c) => c.primaryKey).map((c) => c.name);
            const { searchClause, params } = this.buildSearchFilter(columns, options.search || '');
            const whereClause = (0, utils_1.joinWhereClauses)([options.filter || '', searchClause]);
            const orderClause = (0, utils_1.buildOrderClause)('mysql', columns, options.sortColumn, options.sortDirection);
            const limit = (0, utils_1.clampLimit)(options.limit || 100);
            const offset = (0, utils_1.clampOffset)(options.offset);
            const qualifiedTable = (0, utils_1.qualifyTable)('mysql', schema, table);
            const countStatement = `select count(*) as total from ${qualifiedTable}${whereClause}`;
            const statement = `select * from ${qualifiedTable}${whereClause}${orderClause} limit ${limit} offset ${offset}`;
            const startedAt = Date.now();
            const [countRows] = await client.query(countStatement, params);
            const [rows] = await client.query(statement, params);
            const total = Number(countRows[0]?.total ?? rows.length);
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
        return this.withClient(conn, async (client) => {
            const { sql, values } = (0, utils_1.buildGenericUpdate)('mysql', schema, table, changedColumns, whereColumns, nextRow, originalRow, 'question');
            await client.execute(sql, values);
        });
    }
    async withClient(conn, cb) {
        const { createConnection } = await Promise.resolve().then(() => __importStar(require('mysql2/promise')));
        const client = await createConnection({
            host: conn.host,
            port: conn.port,
            database: conn.database,
            user: conn.user,
            password: conn.password,
            ssl: conn.ssl ? { rejectUnauthorized: false } : undefined,
        });
        try {
            return await cb(client);
        }
        finally {
            await client.end().catch(() => undefined);
        }
    }
    normalizeResult(statement, rows, fields, durationMs) {
        if (Array.isArray(rows)) {
            return {
                statement,
                rowCount: rows.length,
                rows: (0, utils_1.serializeRows)(rows),
                columns: this.mapColumns(rows, fields),
                durationMs,
                source: { type: 'query' },
            };
        }
        const header = rows;
        return {
            statement,
            rowCount: header?.affectedRows ?? 0,
            rows: [],
            columns: [],
            durationMs,
            notice: `${header?.affectedRows ?? 0} row(s) affected`,
            source: { type: 'query' },
        };
    }
    mapColumns(rows, fields) {
        if (fields && fields.length > 0) {
            return fields.map((field) => ({
                name: field.name,
                type: field.columnType ? String(field.columnType) : (0, utils_1.inferColumnType)(field.name, rows),
            }));
        }
        const sample = rows[0];
        if (!sample)
            return [];
        return Object.keys(sample).map((key) => ({
            name: key,
            type: (0, utils_1.inferColumnType)(key, rows),
        }));
    }
    async getSchemaRows(client) {
        const [rows] = await client.query(`
      select
        c.table_schema as schema_name,
        c.table_name,
        t.table_type,
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default,
        case when kcu.constraint_name = 'PRIMARY' then 1 else 0 end as is_primary_key
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema
       and t.table_name = c.table_name
      left join information_schema.key_column_usage kcu
        on kcu.table_schema = c.table_schema
       and kcu.table_name = c.table_name
       and kcu.column_name = c.column_name
       and kcu.constraint_name = 'PRIMARY'
      where c.table_schema = database()
        and t.table_type in ('BASE TABLE', 'VIEW')
      order by c.table_name, c.ordinal_position
    `);
        return (rows || []).map((row) => ({
            schema: this.getSchemaValue(row, 'schema_name', 'SCHEMA_NAME') ?? '',
            table: this.getSchemaValue(row, 'table_name', 'TABLE_NAME') ?? '',
            type: this.getSchemaValue(row, 'table_type', 'TABLE_TYPE') === 'VIEW' ? 'view' : 'table',
            column: this.getSchemaValue(row, 'column_name', 'COLUMN_NAME') ?? '',
            dataType: this.getSchemaValue(row, 'data_type', 'DATA_TYPE') ?? 'unknown',
            nullable: this.getSchemaValue(row, 'is_nullable', 'IS_NULLABLE') === 'YES',
            defaultValue: this.getSchemaValue(row, 'column_default', 'COLUMN_DEFAULT') ?? null,
            primaryKey: Number(this.getSchemaValue(row, 'is_primary_key', 'IS_PRIMARY_KEY') ?? 0) === 1,
        }));
    }
    async getTableColumns(client, schema, table) {
        const [rows] = await client.query(`
      select
        c.table_schema as schema_name,
        c.table_name,
        t.table_type,
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default,
        case when kcu.constraint_name = 'PRIMARY' then 1 else 0 end as is_primary_key
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema
       and t.table_name = c.table_name
      left join information_schema.key_column_usage kcu
        on kcu.table_schema = c.table_schema
       and kcu.table_name = c.table_name
       and kcu.column_name = c.column_name
       and kcu.constraint_name = 'PRIMARY'
      where c.table_schema = ?
        and c.table_name = ?
      order by c.ordinal_position
    `, [schema, table]);
        return (rows || []).map((row) => ({
            name: this.getSchemaValue(row, 'column_name', 'COLUMN_NAME') ?? '',
            type: this.getSchemaValue(row, 'data_type', 'DATA_TYPE') ?? 'unknown',
            nullable: this.getSchemaValue(row, 'is_nullable', 'IS_NULLABLE') === 'YES',
            defaultValue: this.getSchemaValue(row, 'column_default', 'COLUMN_DEFAULT') ?? null,
            primaryKey: Number(this.getSchemaValue(row, 'is_primary_key', 'IS_PRIMARY_KEY') ?? 0) === 1,
        }));
    }
    getSchemaValue(row, lowerKey, upperKey) {
        return row[lowerKey] ?? row[upperKey];
    }
    buildSearchFilter(columns, filter) {
        const normalizedFilter = filter.trim();
        if (!normalizedFilter || columns.length === 0) {
            return { searchClause: '', params: [] };
        }
        const clauses = columns.map((column) => `cast(${(0, utils_1.escapeIdentifier)('mysql', column.name)} as char) like ?`);
        return {
            searchClause: clauses.join(' or '),
            params: columns.map(() => `%${normalizedFilter}%`),
        };
    }
}
exports.MysqlAdapter = MysqlAdapter;
