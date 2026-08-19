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
exports.PostgresAdapter = void 0;
const utils_1 = require("../utils");
class PostgresAdapter {
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
                const result = await client.query(statement);
                results.push({
                    statement,
                    rowCount: result.rowCount ?? result.rows.length,
                    rows: (0, utils_1.serializeRows)(result.rows),
                    columns: result.fields.map((field) => ({
                        name: field.name,
                        type: (0, utils_1.inferColumnType)(field.name, result.rows),
                    })),
                    durationMs: Date.now() - startedAt,
                    source: { type: 'query' },
                });
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
            const orderClause = (0, utils_1.buildOrderClause)('postgres', columns, options.sortColumn, options.sortDirection);
            const limit = (0, utils_1.clampLimit)(options.limit || 100);
            const offset = (0, utils_1.clampOffset)(options.offset);
            const qualifiedTable = (0, utils_1.qualifyTable)('postgres', schema, table);
            const countStatement = `select count(*) as total from ${qualifiedTable}${whereClause}`;
            const statement = `select * from ${qualifiedTable}${whereClause}${orderClause} limit ${limit} offset ${offset}`;
            const startedAt = Date.now();
            const countResult = await client.query(countStatement, params);
            const result = await client.query(statement, params);
            const total = Number(countResult.rows[0]?.total ?? result.rows.length);
            return {
                statement,
                rowCount: Number.isFinite(total) ? total : result.rows.length,
                rows: (0, utils_1.serializeRows)(result.rows),
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
            const { sql, values } = (0, utils_1.buildGenericUpdate)('postgres', schema, table, changedColumns, whereColumns, nextRow, originalRow, 'dollar');
            await client.query(sql, values);
        });
    }
    async withClient(conn, cb) {
        const { Client: PgClient } = await Promise.resolve().then(() => __importStar(require('pg')));
        const client = new PgClient({
            host: conn.host,
            port: conn.port,
            database: conn.database,
            user: conn.user,
            password: conn.password,
            ssl: conn.ssl ? { rejectUnauthorized: false } : undefined,
        });
        await client.connect();
        try {
            return await cb(client);
        }
        finally {
            await client.end().catch(() => undefined);
        }
    }
    async getSchemaRows(client) {
        const result = await client.query(`
      select
        c.table_schema as schema_name,
        c.table_name,
        case when t.table_type = 'VIEW' then 'view' else 'table' end as table_type,
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default,
        exists (
          select 1
          from information_schema.table_constraints tc
          join information_schema.key_column_usage kcu
            on tc.constraint_name = kcu.constraint_name
           and tc.table_schema = kcu.table_schema
           and tc.table_name = kcu.table_name
          where tc.constraint_type = 'PRIMARY KEY'
            and tc.table_schema = c.table_schema
            and tc.table_name = c.table_name
            and kcu.column_name = c.column_name
        ) as is_primary_key
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema
       and t.table_name = c.table_name
      where c.table_schema not in ('information_schema', 'pg_catalog')
        and t.table_type in ('BASE TABLE', 'VIEW')
      order by c.table_schema, c.table_name, c.ordinal_position
    `);
        return result.rows.map((row) => ({
            schema: row.schema_name,
            table: row.table_name,
            type: row.table_type,
            column: row.column_name,
            dataType: row.data_type,
            nullable: row.is_nullable === 'YES',
            defaultValue: row.column_default,
            primaryKey: row.is_primary_key,
        }));
    }
    async getTableColumns(client, schema, table) {
        const result = await client.query(`
      select
        c.table_schema as schema_name,
        c.table_name,
        case when t.table_type = 'VIEW' then 'view' else 'table' end as table_type,
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default,
        exists (
          select 1
          from information_schema.table_constraints tc
          join information_schema.key_column_usage kcu
            on tc.constraint_name = kcu.constraint_name
           and tc.table_schema = kcu.table_schema
           and tc.table_name = kcu.table_name
          where tc.constraint_type = 'PRIMARY KEY'
            and tc.table_schema = c.table_schema
            and tc.table_name = c.table_name
            and kcu.column_name = c.column_name
        ) as is_primary_key
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema
       and t.table_name = c.table_name
      where c.table_schema = $1
        and c.table_name = $2
      order by c.ordinal_position
    `, [schema, table]);
        return result.rows.map((row) => ({
            name: row.column_name,
            type: row.data_type,
            nullable: row.is_nullable === 'YES',
            defaultValue: row.column_default,
            primaryKey: row.is_primary_key,
        }));
    }
    buildSearchFilter(columns, filter) {
        const normalizedFilter = filter.trim();
        if (!normalizedFilter || columns.length === 0) {
            return { searchClause: '', params: [] };
        }
        const params = [];
        const clauses = columns.map((column, index) => {
            const paramIndex = index + 1;
            params.push(`%${normalizedFilter}%`);
            return `cast(${(0, utils_1.escapeIdentifier)('postgres', column.name)} as text) ilike $${paramIndex}`;
        });
        return {
            searchClause: clauses.join(' or '),
            params,
        };
    }
}
exports.PostgresAdapter = PostgresAdapter;
