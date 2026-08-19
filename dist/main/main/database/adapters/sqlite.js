"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SqliteAdapter = void 0;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const utils_1 = require("../utils");
class SqliteAdapter {
    async testConnection(conn) {
        const db = this.open(conn, true);
        try {
            db.pragma('quick_check(1)');
        }
        finally {
            db.close();
        }
    }
    async query(conn, sql) {
        const statements = (0, utils_1.splitSqlStatements)(sql);
        const readonly = statements.every(utils_1.isReadOnlyStatement);
        return this.withDatabase(conn, readonly, async (db) => {
            const results = [];
            for (const statement of statements) {
                const startedAt = Date.now();
                const prepared = db.prepare(statement);
                if (prepared.reader) {
                    const rows = prepared.all();
                    results.push({
                        statement,
                        rowCount: rows.length,
                        rows: serializeSqliteRows(rows),
                        columns: prepared.columns().map((column) => ({
                            name: column.name,
                            type: column.type || (0, utils_1.inferColumnType)(column.name, rows),
                        })),
                        durationMs: Date.now() - startedAt,
                        source: { type: 'query' },
                    });
                    continue;
                }
                const result = prepared.run();
                results.push({
                    statement,
                    rowCount: result.changes,
                    rows: [],
                    columns: [],
                    durationMs: Date.now() - startedAt,
                    notice: `${result.changes} row(s) affected`,
                    source: { type: 'query' },
                });
            }
            return results;
        });
    }
    async schema(conn) {
        return this.withDatabase(conn, true, async (db) => {
            const tables = db.prepare(`
        select name, type
        from sqlite_master
        where type in ('table', 'view')
          and name not like 'sqlite_%'
        order by name
      `).all();
            const rowCountEstimates = this.getRowCountEstimates(db);
            return tables.map((table) => {
                const columns = this.getTableColumns(db, 'main', table.name);
                const rowCount = rowCountEstimates.get(table.name);
                return {
                    schema: 'main',
                    name: table.name,
                    type: table.type,
                    rowCount,
                    columns,
                };
            });
        });
    }
    async previewTable(conn, schema, table, options) {
        return this.withDatabase(conn, true, async (db) => {
            const columns = this.getTableColumns(db, schema, table);
            const primaryKeys = columns.filter((c) => c.primaryKey).map((c) => c.name);
            const { searchClause, params } = this.buildSearchFilter(columns, options.search || '');
            const whereClause = (0, utils_1.joinWhereClauses)([options.filter || '', searchClause]);
            const orderClause = (0, utils_1.buildOrderClause)('sqlite', columns, options.sortColumn, options.sortDirection);
            const limit = (0, utils_1.clampLimit)(options.limit || 100);
            const offset = (0, utils_1.clampOffset)(options.offset);
            const qualifiedTable = (0, utils_1.qualifyTable)('sqlite', schema, table);
            const countStatement = `select count(*) as total from ${qualifiedTable}${whereClause}`;
            const statement = `select * from ${qualifiedTable}${whereClause}${orderClause} limit ${limit} offset ${offset}`;
            const startedAt = Date.now();
            const countRow = db.prepare(countStatement).get(...params);
            const rows = db.prepare(statement).all(...params);
            const total = Number(countRow?.total ?? rows.length);
            return {
                statement,
                rowCount: Number.isFinite(total) ? total : rows.length,
                rows: serializeSqliteRows(rows),
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
        return this.withDatabase(conn, false, async (db) => {
            const { sql, values } = (0, utils_1.buildGenericUpdate)('sqlite', schema, table, changedColumns, whereColumns, nextRow, originalRow, 'question');
            db.prepare(sql).run(...values);
        });
    }
    open(conn, readonly) {
        if (!conn.database) {
            throw new Error('SQLite database file path is required');
        }
        return new better_sqlite3_1.default(conn.database, {
            readonly,
            fileMustExist: true,
        });
    }
    async withDatabase(conn, readonly, cb) {
        const db = this.open(conn, readonly);
        try {
            return await cb(db);
        }
        finally {
            db.close();
        }
    }
    getTableColumns(db, schema, table) {
        const pragmaTarget = schema && schema !== 'main'
            ? `${(0, utils_1.escapeIdentifier)('sqlite', schema)}.table_info(${(0, utils_1.escapeIdentifier)('sqlite', table)})`
            : `table_info(${(0, utils_1.escapeIdentifier)('sqlite', table)})`;
        const rows = db.prepare(`pragma ${pragmaTarget}`).all();
        return rows.map((column) => ({
            name: column.name,
            type: column.type || 'TEXT',
            nullable: column.notnull === 0,
            defaultValue: column.dflt_value == null ? null : String(column.dflt_value),
            primaryKey: column.pk > 0,
        }));
    }
    getRowCountEstimates(db) {
        const estimates = new Map();
        try {
            const rows = db.prepare(`
        select tbl, stat
        from sqlite_stat1
      `).all();
            for (const row of rows) {
                if (estimates.has(row.tbl))
                    continue;
                const estimate = Number.parseInt(String(row.stat).split(/\s+/)[0] || '', 10);
                if (Number.isFinite(estimate)) {
                    estimates.set(row.tbl, estimate);
                }
            }
        }
        catch {
            // sqlite_stat1 only exists after ANALYZE; absence is normal.
        }
        return estimates;
    }
    buildSearchFilter(columns, filter) {
        const normalizedFilter = filter.trim();
        if (!normalizedFilter || columns.length === 0) {
            return { searchClause: '', params: [] };
        }
        const params = [];
        const clauses = columns.map((column) => {
            params.push(`%${normalizedFilter.toLowerCase()}%`);
            return `lower(cast(${(0, utils_1.escapeIdentifier)('sqlite', column.name)} as text)) like ?`;
        });
        return {
            searchClause: clauses.join(' or '),
            params,
        };
    }
}
exports.SqliteAdapter = SqliteAdapter;
function serializeSqliteRows(rows) {
    return rows.map((row) => {
        const nextRow = {};
        for (const [key, value] of Object.entries(row)) {
            if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                nextRow[key] = value;
            }
            else if (typeof value === 'bigint') {
                nextRow[key] = value <= Number.MAX_SAFE_INTEGER && value >= Number.MIN_SAFE_INTEGER
                    ? Number(value)
                    : value.toString();
            }
            else if (Buffer.isBuffer(value)) {
                nextRow[key] = `[BLOB: ${formatBytes(value.byteLength)}]`;
            }
            else if (value instanceof Date) {
                nextRow[key] = value.toISOString();
            }
            else {
                nextRow[key] = JSON.stringify(value);
            }
        }
        return nextRow;
    });
}
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
