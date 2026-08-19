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
exports.CassandraAdapter = void 0;
const utils_1 = require("../utils");
/* eslint-disable @typescript-eslint/no-explicit-any */
class CassandraAdapter {
    async testConnection(conn) {
        await this.withClient(conn, async (client) => {
            await client.execute('SELECT now() FROM system.local');
        });
    }
    async query(conn, text) {
        const statements = (0, utils_1.splitSqlStatements)(text);
        return this.withClient(conn, async (client) => {
            const results = [];
            for (const statement of statements) {
                const startedAt = Date.now();
                const result = await client.execute(statement, [], { prepare: true });
                const rows = result.rows || [];
                const columns = result.columns
                    ? result.columns.map((col) => ({
                        name: col.name,
                        type: col.type?.code !== undefined ? this.cassandraTypeName(col.type.code) : (0, utils_1.inferColumnType)(col.name, rows),
                    }))
                    : rows.length > 0
                        ? Object.keys(rows[0]).map((key) => ({
                            name: key,
                            type: (0, utils_1.inferColumnType)(key, rows),
                        }))
                        : [];
                results.push({
                    statement,
                    rowCount: rows.length,
                    rows: (0, utils_1.serializeRows)(rows),
                    columns,
                    durationMs: Date.now() - startedAt,
                    source: { type: 'query' },
                });
            }
            return results;
        });
    }
    async schema(conn) {
        return this.withClient(conn, async (client) => {
            const keyspace = conn.database;
            if (!keyspace) {
                throw new Error('No keyspace specified. Set the "database" field to your Cassandra keyspace.');
            }
            const result = await client.execute(`SELECT table_name, column_name, type, kind, position
         FROM system_schema.columns
         WHERE keyspace_name = ?`, [keyspace], { prepare: true });
            const schemaRows = (result.rows || []).map((row) => ({
                schema: keyspace,
                table: row.table_name,
                type: 'table',
                column: row.column_name,
                dataType: row.type,
                nullable: row.kind !== 'partition_key' && row.kind !== 'clustering',
                defaultValue: null,
                primaryKey: row.kind === 'partition_key' || row.kind === 'clustering',
            }));
            return (0, utils_1.groupSchemaRows)(schemaRows);
        });
    }
    async previewTable(conn, schema, table, options) {
        return this.withClient(conn, async (client) => {
            const keyspace = schema || conn.database;
            const size = (0, utils_1.clampLimit)((options.limit || 100) + (options.offset || 0));
            const filter = options.search || options.filter || '';
            // Get column metadata for this table
            const colResult = await client.execute(`SELECT column_name, type, kind
         FROM system_schema.columns
         WHERE keyspace_name = ? AND table_name = ?`, [keyspace, table], { prepare: true });
            const columnMeta = colResult.rows || [];
            const primaryKeys = columnMeta
                .filter((c) => c.kind === 'partition_key' || c.kind === 'clustering')
                .map((c) => c.column_name);
            // Build query
            let whereClause = '';
            const params = [];
            if (filter && filter.trim()) {
                // Cassandra has limited filtering — use ALLOW FILTERING with a token-based approach
                // For basic preview, we add ALLOW FILTERING with a contains-like filter on text columns
                const textColumns = columnMeta.filter((c) => ['text', 'varchar', 'ascii'].includes(c.type));
                if (textColumns.length > 0) {
                    const clauses = textColumns.map((c) => {
                        params.push(`%${filter.trim()}%`);
                        return `${(0, utils_1.escapeIdentifier)('cassandra', c.column_name)} LIKE ?`;
                    });
                    // Cassandra LIKE requires ALLOW FILTERING and only works on certain column types with SASI index
                    // Fall back to client-side filtering if LIKE isn't supported
                    whereClause = ` WHERE ${clauses.join(' OR ')} ALLOW FILTERING`;
                }
            }
            const qualifiedTable = (0, utils_1.qualifyTable)('cassandra', keyspace, table);
            let statement = `SELECT * FROM ${qualifiedTable}${whereClause} LIMIT ${size}`;
            const startedAt = Date.now();
            let result;
            try {
                result = await client.execute(statement, params, { prepare: true });
            }
            catch {
                // If LIKE/ALLOW FILTERING fails, fall back to unfiltered query
                statement = `SELECT * FROM ${qualifiedTable} LIMIT ${size}`;
                result = await client.execute(statement, [], { prepare: true });
            }
            const offset = Math.max(0, Math.floor(options.offset || 0));
            const pageLimit = (0, utils_1.clampLimit)(options.limit || 100);
            const rows = (result.rows || []).slice(offset, offset + pageLimit);
            const columns = columnMeta.map((c) => ({
                name: c.column_name,
                type: c.type,
            }));
            return {
                statement,
                rowCount: offset + rows.length + (rows.length === pageLimit ? 1 : 0),
                rows: (0, utils_1.serializeRows)(rows),
                columns,
                durationMs: Date.now() - startedAt,
                source: { type: 'table', schema: keyspace, table, primaryKeys },
            };
        });
    }
    async updateRow(conn, schema, table, nextRow, originalRow, whereColumns) {
        const changedColumns = Object.keys(nextRow).filter((col) => nextRow[col] !== originalRow[col]);
        if (changedColumns.length === 0)
            return;
        const keyspace = schema || conn.database;
        return this.withClient(conn, async (client) => {
            const { sql, values } = (0, utils_1.buildGenericUpdate)('cassandra', keyspace, table, changedColumns, whereColumns, nextRow, originalRow, 'question');
            await client.execute(sql, values, { prepare: true });
        });
    }
    async withClient(conn, cb) {
        const cassandra = await Promise.resolve().then(() => __importStar(require('cassandra-driver')));
        const Client = cassandra.Client;
        const contactPoints = [conn.host || 'localhost'];
        const port = conn.port || 9042;
        const clientOpts = {
            contactPoints: contactPoints.map((cp) => `${cp}:${port}`),
            localDataCenter: 'datacenter1',
            keyspace: conn.database || undefined,
        };
        // Auth
        if (conn.user && conn.password) {
            clientOpts.credentials = {
                username: conn.user,
                password: conn.password,
            };
        }
        // SSL
        if (conn.ssl) {
            clientOpts.sslOptions = { rejectUnauthorized: false };
        }
        const client = new Client(clientOpts);
        await client.connect();
        try {
            return await cb(client);
        }
        finally {
            await client.shutdown().catch(() => undefined);
        }
    }
    /**
     * Map Cassandra type codes to human-readable names.
     */
    cassandraTypeName(code) {
        const typeMap = {
            0x0000: 'custom',
            0x0001: 'ascii',
            0x0002: 'bigint',
            0x0003: 'blob',
            0x0004: 'boolean',
            0x0005: 'counter',
            0x0006: 'decimal',
            0x0007: 'double',
            0x0008: 'float',
            0x0009: 'int',
            0x000A: 'text',
            0x000B: 'timestamp',
            0x000C: 'uuid',
            0x000D: 'varchar',
            0x000E: 'varint',
            0x000F: 'timeuuid',
            0x0010: 'inet',
            0x0011: 'date',
            0x0012: 'time',
            0x0013: 'smallint',
            0x0014: 'tinyint',
            0x0020: 'list',
            0x0021: 'map',
            0x0022: 'set',
            0x0030: 'udt',
            0x0031: 'tuple',
        };
        return typeMap[code] || `type(${code})`;
    }
}
exports.CassandraAdapter = CassandraAdapter;
