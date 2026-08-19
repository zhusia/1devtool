"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SurrealDBAdapter = void 0;
const axios_1 = __importDefault(require("axios"));
const utils_1 = require("../utils");
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Serialize a SurrealDB value to a DatabasePrimitive.
 */
function toDbPrimitive(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        return value;
    return JSON.stringify(value);
}
/**
 * Flatten a SurrealDB record into a row of primitives for tabular display.
 */
function flattenRecord(record) {
    const row = {};
    for (const [key, value] of Object.entries(record)) {
        row[key] = toDbPrimitive(value);
    }
    return row;
}
/**
 * Infer columns from an array of row objects.
 */
function inferColumnsFromRows(rows) {
    const columnMap = new Map();
    for (const row of rows) {
        for (const [key, value] of Object.entries(row)) {
            if (!columnMap.has(key)) {
                if (value === null || value === undefined) {
                    columnMap.set(key, 'unknown');
                }
                else if (typeof value === 'object') {
                    columnMap.set(key, Array.isArray(value) ? 'array' : 'object');
                }
                else {
                    columnMap.set(key, typeof value);
                }
            }
        }
    }
    // Ensure 'id' appears first
    const columns = [];
    if (columnMap.has('id')) {
        columns.push({ name: 'id', type: columnMap.get('id') });
        columnMap.delete('id');
    }
    for (const [name, type] of Array.from(columnMap.entries())) {
        columns.push({ name, type });
    }
    return columns;
}
/**
 * Escape a SurrealQL identifier by wrapping in backticks.
 */
function escSurreal(identifier) {
    return '`' + identifier.replace(/`/g, '\\`') + '`';
}
/**
 * Format a SurrealQL literal value for inline use in queries.
 */
function surrealLiteral(value) {
    if (value === null)
        return 'NONE';
    if (typeof value === 'boolean')
        return value ? 'true' : 'false';
    if (typeof value === 'number')
        return String(value);
    // String — escape single quotes
    return `'${String(value).replace(/'/g, "\\'")}'`;
}
class SurrealDBAdapter {
    async testConnection(conn) {
        const client = this.createClient(conn);
        await this.executeSql(client, conn, 'RETURN 1');
    }
    async query(conn, text) {
        const client = this.createClient(conn);
        const startedAt = Date.now();
        const responseEntries = await this.executeSql(client, conn, text);
        const results = [];
        for (const entry of responseEntries) {
            if (entry.status === 'ERR') {
                throw new Error(entry.detail || entry.result || 'SurrealDB query error');
            }
            const rawResult = entry.result;
            const durationMs = Date.now() - startedAt;
            if (Array.isArray(rawResult)) {
                const rows = rawResult.map((r) => flattenRecord(r));
                const columns = inferColumnsFromRows(rawResult);
                results.push({
                    statement: text,
                    rowCount: rows.length,
                    rows,
                    columns,
                    durationMs,
                    resultFormat: 'tabular',
                    source: { type: 'query' },
                });
            }
            else if (rawResult !== null && rawResult !== undefined) {
                // Single value or object result
                const doc = typeof rawResult === 'object' ? rawResult : { value: rawResult };
                const rows = [flattenRecord(doc)];
                const columns = inferColumnsFromRows([doc]);
                results.push({
                    statement: text,
                    rowCount: 1,
                    rows,
                    columns,
                    durationMs,
                    resultFormat: 'tabular',
                    source: { type: 'query' },
                });
            }
            else {
                results.push({
                    statement: text,
                    rowCount: 0,
                    rows: [],
                    columns: [],
                    durationMs,
                    notice: 'Query executed successfully',
                    source: { type: 'query' },
                });
            }
        }
        // If the query returned no result entries, return a single empty result
        if (results.length === 0) {
            results.push({
                statement: text,
                rowCount: 0,
                rows: [],
                columns: [],
                durationMs: Date.now() - startedAt,
                notice: 'Query executed successfully',
                source: { type: 'query' },
            });
        }
        return results;
    }
    async schema(conn) {
        const client = this.createClient(conn);
        // Get database info (lists tables)
        const dbInfoEntries = await this.executeSql(client, conn, 'INFO FOR DB');
        const dbInfo = dbInfoEntries[0]?.result;
        if (!dbInfo || typeof dbInfo !== 'object') {
            return [];
        }
        // Extract table names from the tb (tables) section
        const tablesSection = dbInfo.tables || dbInfo.tb || {};
        const tableNames = Object.keys(tablesSection);
        const tables = [];
        for (const tableName of tableNames) {
            try {
                const tableInfoEntries = await this.executeSql(client, conn, `INFO FOR TABLE ${escSurreal(tableName)}`);
                const tableInfo = tableInfoEntries[0]?.result;
                if (!tableInfo || typeof tableInfo !== 'object') {
                    tables.push({
                        schema: conn.surrealDatabase || conn.database || '',
                        name: tableName,
                        type: 'table',
                        columns: [
                            { name: 'id', type: 'record', nullable: false, defaultValue: null, primaryKey: true },
                        ],
                    });
                    continue;
                }
                // Parse field definitions
                const fieldsSection = tableInfo.fields || tableInfo.fd || {};
                const columns = [];
                // Always include id as first column
                columns.push({
                    name: 'id',
                    type: 'record',
                    nullable: false,
                    defaultValue: null,
                    primaryKey: true,
                });
                for (const [fieldName, fieldDef] of Object.entries(fieldsSection)) {
                    if (fieldName === 'id')
                        continue; // already added
                    // fieldDef is a string like "DEFINE FIELD fieldName ON tableName TYPE string"
                    const fieldStr = String(fieldDef);
                    const typeMatch = fieldStr.match(/TYPE\s+(\S+)/i);
                    const fieldType = typeMatch ? typeMatch[1] : 'any';
                    const isFlexible = /FLEXIBLE/i.test(fieldStr);
                    columns.push({
                        name: fieldName,
                        type: fieldType,
                        nullable: isFlexible || /option/i.test(fieldType),
                        defaultValue: null,
                        primaryKey: false,
                    });
                }
                // If no fields defined, sample data to infer columns
                if (columns.length <= 1) {
                    try {
                        const sampleEntries = await this.executeSql(client, conn, `SELECT * FROM ${escSurreal(tableName)} LIMIT 10`);
                        const sampleRows = sampleEntries[0]?.result;
                        if (Array.isArray(sampleRows) && sampleRows.length > 0) {
                            const inferredCols = inferColumnsFromRows(sampleRows);
                            for (const col of inferredCols) {
                                if (col.name === 'id')
                                    continue;
                                columns.push({
                                    name: col.name,
                                    type: col.type,
                                    nullable: true,
                                    defaultValue: null,
                                    primaryKey: false,
                                });
                            }
                        }
                    }
                    catch {
                        // Sampling failed, continue with id-only columns
                    }
                }
                tables.push({
                    schema: conn.surrealDatabase || conn.database || '',
                    name: tableName,
                    type: 'table',
                    columns,
                });
            }
            catch {
                // If INFO FOR TABLE fails for a table, include it with minimal info
                tables.push({
                    schema: conn.surrealDatabase || conn.database || '',
                    name: tableName,
                    type: 'table',
                    columns: [
                        { name: 'id', type: 'record', nullable: false, defaultValue: null, primaryKey: true },
                    ],
                });
            }
        }
        return tables;
    }
    async previewTable(conn, _schema, table, options) {
        const client = this.createClient(conn);
        const size = (0, utils_1.clampLimit)(options.limit || 100);
        const offset = (0, utils_1.clampOffset)(options.offset);
        const filter = options.search || options.filter || '';
        const orderClause = options.sortColumn
            ? ` ORDER BY ${escSurreal(options.sortColumn)} ${options.sortDirection === 'desc' ? 'DESC' : 'ASC'}`
            : '';
        const pageClause = ` LIMIT ${size}${offset > 0 ? ` START ${offset}` : ''}`;
        const startedAt = Date.now();
        let statement;
        if (filter && filter.trim()) {
            // SurrealDB string contains filter using string::contains or WHERE field CONTAINS
            // Use a broad filter approach: convert all fields to string and check
            statement = `SELECT * FROM ${escSurreal(table)} WHERE string::join(' ', *) CONTAINS '${filter.trim().replace(/'/g, "\\'")}'${orderClause}${pageClause}`;
        }
        else {
            statement = `SELECT * FROM ${escSurreal(table)}${orderClause}${pageClause}`;
        }
        let responseEntries;
        try {
            responseEntries = await this.executeSql(client, conn, statement);
        }
        catch {
            // If the string filter syntax fails, fall back to unfiltered
            statement = `SELECT * FROM ${escSurreal(table)}${pageClause}`;
            responseEntries = await this.executeSql(client, conn, statement);
        }
        const entry = responseEntries[0];
        if (entry?.status === 'ERR') {
            throw new Error(entry.detail || entry.result || 'SurrealDB query error');
        }
        const rawRows = Array.isArray(entry?.result) ? entry.result : [];
        const rows = rawRows.map((r) => flattenRecord(r));
        const columns = inferColumnsFromRows(rawRows);
        return {
            statement,
            rowCount: offset + rows.length + (rows.length === size ? 1 : 0),
            rows,
            columns,
            durationMs: Date.now() - startedAt,
            resultFormat: 'tabular',
            source: { type: 'table', table, primaryKeys: ['id'] },
        };
    }
    async updateRow(conn, _schema, table, nextRow, originalRow, _primaryKeys) {
        const changedColumns = Object.keys(nextRow).filter((col) => nextRow[col] !== originalRow[col]);
        if (changedColumns.length === 0)
            return;
        const recordId = originalRow.id;
        if (!recordId || typeof recordId !== 'string') {
            throw new Error('Cannot update record: missing id field');
        }
        // Build SET clauses
        const setClauses = changedColumns
            .map((col) => `${escSurreal(col)} = ${surrealLiteral(nextRow[col])}`)
            .join(', ');
        // SurrealDB record IDs already include the table prefix (e.g. "users:abc123")
        // Use UPDATE with the full record ID
        const statement = `UPDATE ${recordId} SET ${setClauses}`;
        const client = this.createClient(conn);
        const responseEntries = await this.executeSql(client, conn, statement);
        const entry = responseEntries[0];
        if (entry?.status === 'ERR') {
            throw new Error(entry.detail || entry.result || 'SurrealDB update error');
        }
    }
    /**
     * Create an axios client configured for the SurrealDB HTTP API.
     */
    createClient(conn) {
        const protocol = conn.ssl ? 'https' : 'http';
        const baseURL = `${protocol}://${conn.host}:${conn.port || 8000}`;
        const headers = {
            'Content-Type': 'text/plain',
            Accept: 'application/json',
        };
        // SurrealDB namespace and database headers
        if (conn.surrealNamespace) {
            headers['Surreal-NS'] = conn.surrealNamespace;
        }
        else {
            headers['Surreal-NS'] = 'default';
        }
        if (conn.surrealDatabase) {
            headers['Surreal-DB'] = conn.surrealDatabase;
        }
        else if (conn.database) {
            headers['Surreal-DB'] = conn.database;
        }
        else {
            headers['Surreal-DB'] = 'default';
        }
        const clientConfig = {
            baseURL,
            headers,
            timeout: 30000,
        };
        // Auth: Basic auth with user/password
        if (conn.user && conn.password) {
            clientConfig.auth = {
                username: conn.user,
                password: conn.password,
            };
        }
        if (conn.ssl) {
            // Node.js: disable strict SSL for self-signed certs
            const https = require('https');
            clientConfig.httpsAgent = new https.Agent({ rejectUnauthorized: false });
        }
        return axios_1.default.create(clientConfig);
    }
    /**
     * Execute a SurrealQL statement via the HTTP /sql endpoint.
     * Returns the array of result entries from the response.
     */
    async executeSql(client, _conn, sql) {
        const response = await client.post('/sql', sql);
        const data = response.data;
        // SurrealDB returns an array of result entries
        if (Array.isArray(data)) {
            return data;
        }
        // Some versions wrap in an object
        if (data && Array.isArray(data.results)) {
            return data.results;
        }
        // Single result
        if (data && typeof data === 'object' && 'result' in data) {
            return [data];
        }
        return [{ status: 'OK', result: data }];
    }
}
exports.SurrealDBAdapter = SurrealDBAdapter;
