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
exports.DatabaseManager = void 0;
class DatabaseManager {
    async testConnection(connection) {
        if (this.getEngineFamily(connection.engine) === 'postgres') {
            await this.withPostgres(connection, async (client) => {
                await client.query('select 1');
            });
            return;
        }
        await this.withMysql(connection, async (client) => {
            await client.query('select 1');
        });
    }
    async query(connection, sql) {
        const statements = splitSqlStatements(sql);
        if (statements.length === 0) {
            return [];
        }
        for (const statement of statements) {
            if (connection.safeMode && !isReadOnlyStatement(statement)) {
                throw new Error('Safe Mode is enabled for this connection. Disable it before running write queries.');
            }
        }
        if (this.getEngineFamily(connection.engine) === 'postgres') {
            return this.withPostgres(connection, async (client) => {
                const results = [];
                for (const statement of statements) {
                    const startedAt = Date.now();
                    const result = await client.query(statement);
                    results.push({
                        statement,
                        rowCount: result.rowCount ?? result.rows.length,
                        rows: serializeRows(result.rows),
                        columns: result.fields.map((field) => ({
                            name: field.name,
                            type: inferColumnType(field.name, result.rows),
                        })),
                        durationMs: Date.now() - startedAt,
                        source: { type: 'query' },
                    });
                }
                return results;
            });
        }
        return this.withMysql(connection, async (client) => {
            const results = [];
            for (const statement of statements) {
                const startedAt = Date.now();
                const [rows, fields] = await client.query(statement);
                results.push(this.normalizeMysqlQueryResult(statement, rows, fields, Date.now() - startedAt));
            }
            return results;
        });
    }
    async schema(connection) {
        if (this.getEngineFamily(connection.engine) === 'postgres') {
            return this.withPostgres(connection, async (client) => {
                const rows = await this.getPostgresSchemaRows(client);
                return groupSchemaRows(rows);
            });
        }
        return this.withMysql(connection, async (client) => {
            const rows = await this.getMysqlSchemaRows(client);
            return groupSchemaRows(rows);
        });
    }
    async previewTable(connection, schema, table, filter = '', limit = 100) {
        if (this.getEngineFamily(connection.engine) === 'postgres') {
            return this.withPostgres(connection, async (client) => {
                const columns = await this.getPostgresTableColumns(client, schema, table);
                const primaryKeys = columns.filter((column) => column.primaryKey).map((column) => column.name);
                const { whereClause, params } = buildPostgresFilter(columns, filter);
                const statement = `select * from ${qualifyTable('postgres', schema, table)}${whereClause} limit ${clampLimit(limit)}`;
                const startedAt = Date.now();
                const result = await client.query(statement, params);
                return {
                    statement,
                    rowCount: result.rows.length,
                    rows: serializeRows(result.rows),
                    columns: columns.map((column) => ({ name: column.name, type: column.type })),
                    durationMs: Date.now() - startedAt,
                    source: {
                        type: 'table',
                        schema,
                        table,
                        primaryKeys,
                    },
                };
            });
        }
        return this.withMysql(connection, async (client) => {
            const columns = await this.getMysqlTableColumns(client, schema, table);
            const primaryKeys = columns.filter((column) => column.primaryKey).map((column) => column.name);
            const { whereClause, params } = buildMysqlFilter(columns, filter);
            const statement = `select * from ${qualifyTable('mysql', schema, table)}${whereClause} limit ${clampLimit(limit)}`;
            const startedAt = Date.now();
            const [rows] = await client.query(statement, params);
            return {
                statement,
                rowCount: rows.length,
                rows: serializeRows(rows),
                columns: columns.map((column) => ({ name: column.name, type: column.type })),
                durationMs: Date.now() - startedAt,
                source: {
                    type: 'table',
                    schema,
                    table,
                    primaryKeys,
                },
            };
        });
    }
    async updateRow(connection, schema, table, nextRow, originalRow, primaryKeys = []) {
        if (connection.safeMode) {
            throw new Error('Safe Mode is enabled for this connection. Disable it before editing rows.');
        }
        const changedColumns = Object.keys(nextRow).filter((columnName) => nextRow[columnName] !== originalRow[columnName]);
        if (changedColumns.length === 0) {
            return;
        }
        const keyColumns = primaryKeys.filter((columnName) => columnName in originalRow);
        const whereColumns = keyColumns.length > 0 ? keyColumns : Object.keys(originalRow);
        if (this.getEngineFamily(connection.engine) === 'postgres') {
            return this.withPostgres(connection, async (client) => {
                const { sql, values } = buildPostgresUpdate(schema, table, changedColumns, whereColumns, nextRow, originalRow);
                await client.query(sql, values);
            });
        }
        return this.withMysql(connection, async (client) => {
            const { sql, values } = buildMysqlUpdate(schema, table, changedColumns, whereColumns, nextRow, originalRow);
            await client.execute(sql, values);
        });
    }
    normalizeMysqlQueryResult(statement, rows, fields, durationMs) {
        if (Array.isArray(rows)) {
            return {
                statement,
                rowCount: rows.length,
                rows: serializeRows(rows),
                columns: mapMysqlColumns(rows, fields),
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
    getEngineFamily(engine) {
        switch (engine) {
            case 'mariadb':
            case 'mysql':
                return 'mysql';
            case 'cockroachdb':
            case 'redshift':
            case 'postgres':
            default:
                return 'postgres';
        }
    }
    async withPostgres(connection, callback) {
        // Lazy-load pg module only when needed
        const { Client: PgClient } = await Promise.resolve().then(() => __importStar(require('pg')));
        const client = new PgClient({
            host: connection.host,
            port: connection.port,
            database: connection.database,
            user: connection.user,
            password: connection.password,
            ssl: connection.ssl ? { rejectUnauthorized: false } : undefined,
        });
        await client.connect();
        try {
            return await callback(client);
        }
        finally {
            await client.end().catch(() => undefined);
        }
    }
    async withMysql(connection, callback) {
        // Lazy-load mysql2 module only when needed
        const { createConnection } = await Promise.resolve().then(() => __importStar(require('mysql2/promise')));
        const client = await createConnection({
            host: connection.host,
            port: connection.port,
            database: connection.database,
            user: connection.user,
            password: connection.password,
            ssl: connection.ssl ? { rejectUnauthorized: false } : undefined,
        });
        try {
            return await callback(client);
        }
        finally {
            await client.end().catch(() => undefined);
        }
    }
    async getPostgresSchemaRows(client) {
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
    async getMysqlSchemaRows(client) {
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
            schema: row.schema_name,
            table: row.table_name,
            type: row.table_type === 'VIEW' ? 'view' : 'table',
            column: row.column_name,
            dataType: row.data_type,
            nullable: row.is_nullable === 'YES',
            defaultValue: row.column_default,
            primaryKey: row.is_primary_key === 1,
        }));
    }
    async getPostgresTableColumns(client, schema, table) {
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
    async getMysqlTableColumns(client, schema, table) {
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
            name: row.column_name,
            type: row.data_type,
            nullable: row.is_nullable === 'YES',
            defaultValue: row.column_default,
            primaryKey: row.is_primary_key === 1,
        }));
    }
}
exports.DatabaseManager = DatabaseManager;
function groupSchemaRows(rows) {
    const grouped = new Map();
    for (const row of rows) {
        const key = `${row.schema}:${row.table}:${row.type}`;
        const existing = grouped.get(key) || {
            schema: row.schema,
            name: row.table,
            type: row.type,
            columns: [],
        };
        existing.columns.push({
            name: row.column,
            type: row.dataType,
            nullable: row.nullable,
            defaultValue: row.defaultValue,
            primaryKey: row.primaryKey,
        });
        grouped.set(key, existing);
    }
    return [...grouped.values()];
}
function splitSqlStatements(sql) {
    const statements = [];
    let current = '';
    let quote = null;
    for (let index = 0; index < sql.length; index += 1) {
        const char = sql[index];
        const previous = sql[index - 1];
        if ((char === '\'' || char === '"' || char === '`') && previous !== '\\') {
            if (quote === char) {
                quote = null;
            }
            else if (!quote) {
                quote = char;
            }
        }
        if (char === ';' && !quote) {
            const statement = current.trim();
            if (statement) {
                statements.push(statement);
            }
            current = '';
            continue;
        }
        current += char;
    }
    const trailing = current.trim();
    if (trailing) {
        statements.push(trailing);
    }
    return statements;
}
function isReadOnlyStatement(statement) {
    const normalized = statement.trim().toLowerCase();
    if (!normalized) {
        return true;
    }
    if (normalized.startsWith('with')) {
        return !/\b(insert|update|delete|merge)\b/i.test(normalized);
    }
    return /^(select|show|describe|desc|explain)\b/i.test(normalized);
}
function serializeRows(rows) {
    return rows.map((row) => {
        const nextRow = {};
        for (const [key, value] of Object.entries(row)) {
            if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                nextRow[key] = value;
            }
            else if (value instanceof Date) {
                nextRow[key] = value.toISOString();
            }
            else if (Buffer.isBuffer(value)) {
                nextRow[key] = value.toString('utf-8');
            }
            else {
                nextRow[key] = JSON.stringify(value);
            }
        }
        return nextRow;
    });
}
function inferColumnType(columnName, rows) {
    const sample = rows.find((row) => row[columnName] !== null && row[columnName] !== undefined);
    if (!sample) {
        return 'unknown';
    }
    const value = sample[columnName];
    if (value instanceof Date) {
        return 'datetime';
    }
    if (Buffer.isBuffer(value)) {
        return 'binary';
    }
    return typeof value;
}
function mapMysqlColumns(rows, fields) {
    if (fields && fields.length > 0) {
        return fields.map((field) => ({
            name: field.name,
            type: field.columnType ? String(field.columnType) : inferColumnType(field.name, rows),
        }));
    }
    const sample = rows[0];
    if (!sample) {
        return [];
    }
    return Object.keys(sample).map((key) => ({
        name: key,
        type: inferColumnType(key, rows),
    }));
}
function buildPostgresFilter(columns, filter) {
    const normalizedFilter = filter.trim();
    if (!normalizedFilter || columns.length === 0) {
        return { whereClause: '', params: [] };
    }
    const params = [];
    const clauses = columns.map((column, index) => {
        const paramIndex = index + 1;
        params.push(`%${normalizedFilter}%`);
        return `cast(${escapeIdentifier('postgres', column.name)} as text) ilike $${paramIndex}`;
    });
    return {
        whereClause: ` where ${clauses.join(' or ')}`,
        params,
    };
}
function buildMysqlFilter(columns, filter) {
    const normalizedFilter = filter.trim();
    if (!normalizedFilter || columns.length === 0) {
        return { whereClause: '', params: [] };
    }
    const clauses = columns.map((column) => `cast(${escapeIdentifier('mysql', column.name)} as char) like ?`);
    return {
        whereClause: ` where ${clauses.join(' or ')}`,
        params: columns.map(() => `%${normalizedFilter}%`),
    };
}
function buildPostgresUpdate(schema, table, changedColumns, whereColumns, nextRow, originalRow) {
    const values = [];
    const setClauses = changedColumns.map((columnName) => {
        values.push(nextRow[columnName]);
        return `${escapeIdentifier('postgres', columnName)} = $${values.length}`;
    });
    const whereClauses = whereColumns.map((columnName) => {
        const value = originalRow[columnName];
        if (value === null) {
            return `${escapeIdentifier('postgres', columnName)} is null`;
        }
        values.push(value);
        return `${escapeIdentifier('postgres', columnName)} = $${values.length}`;
    });
    return {
        sql: `update ${qualifyTable('postgres', schema, table)} set ${setClauses.join(', ')} where ${whereClauses.join(' and ')}`,
        values,
    };
}
function buildMysqlUpdate(schema, table, changedColumns, whereColumns, nextRow, originalRow) {
    const values = [];
    const setClauses = changedColumns.map((columnName) => {
        values.push(nextRow[columnName]);
        return `${escapeIdentifier('mysql', columnName)} = ?`;
    });
    const whereClauses = whereColumns.map((columnName) => {
        const value = originalRow[columnName];
        if (value === null) {
            return `${escapeIdentifier('mysql', columnName)} is null`;
        }
        values.push(value);
        return `${escapeIdentifier('mysql', columnName)} = ?`;
    });
    return {
        sql: `update ${qualifyTable('mysql', schema, table)} set ${setClauses.join(', ')} where ${whereClauses.join(' and ')}`,
        values,
    };
}
function qualifyTable(family, schema, table) {
    if (!schema) {
        return escapeIdentifier(family, table);
    }
    return `${escapeIdentifier(family, schema)}.${escapeIdentifier(family, table)}`;
}
function escapeIdentifier(family, identifier) {
    if (family === 'postgres') {
        return `"${identifier.replace(/"/g, '""')}"`;
    }
    return `\`${identifier.replace(/`/g, '``')}\``;
}
function clampLimit(limit) {
    return Math.max(1, Math.min(500, Math.floor(limit || 100)));
}
