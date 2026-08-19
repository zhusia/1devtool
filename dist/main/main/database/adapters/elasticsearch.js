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
exports.ElasticsearchAdapter = void 0;
const utils_1 = require("../utils");
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Parses an Elasticsearch REST-style command.
 * Supported formats:
 *   GET /index/_search { ... }
 *   POST /index/_mapping { ... }
 *   { "query": { "match_all": {} } }           (bare JSON, defaults to _search)
 */
function parseEsCommand(text) {
    const trimmed = text.trim();
    // Bare JSON body -> default to GET _search
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        return { method: 'GET', path: '/_search', body: JSON.parse(trimmed) };
    }
    // REST-style: METHOD /path { optional body }
    const match = trimmed.match(/^(GET|POST|PUT|DELETE|HEAD)\s+(\/\S*)\s*([\s\S]*)?$/i);
    if (!match) {
        // Try treating entire input as JSON anyway
        try {
            return { method: 'GET', path: '/_search', body: JSON.parse(trimmed) };
        }
        catch {
            throw new Error('Invalid Elasticsearch query. Use REST format: GET /index/_search { body } or a JSON body.');
        }
    }
    const method = match[1].toUpperCase();
    const path = match[2];
    const rawBody = (match[3] || '').trim();
    let body = undefined;
    if (rawBody) {
        body = JSON.parse(rawBody);
    }
    return { method, path, body };
}
/**
 * Flatten a nested object into dot-notation keys for tabular display.
 * e.g. { a: { b: 1 } } -> { 'a.b': 1 }
 */
function flattenObject(obj, prefix = '') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (value === null || value === undefined) {
            result[fullKey] = null;
        }
        else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            result[fullKey] = value;
        }
        else if (typeof value === 'object' && !Array.isArray(value)) {
            Object.assign(result, flattenObject(value, fullKey));
        }
        else {
            result[fullKey] = JSON.stringify(value);
        }
    }
    return result;
}
/**
 * Extract column definitions from Elasticsearch mapping properties.
 */
function mappingPropertiesToColumns(properties, prefix = '') {
    const columns = [];
    for (const [key, value] of Object.entries(properties)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        const mapping = value;
        if (mapping.properties) {
            columns.push(...mappingPropertiesToColumns(mapping.properties, fullKey));
        }
        else {
            columns.push({
                name: fullKey,
                type: mapping.type || 'object',
                nullable: true,
                defaultValue: null,
                primaryKey: false,
            });
        }
    }
    return columns;
}
class ElasticsearchAdapter {
    async testConnection(conn) {
        await this.withClient(conn, async (client) => {
            const alive = await client.ping();
            if (alive === false) {
                throw new Error('Elasticsearch ping failed');
            }
        });
    }
    async query(conn, text) {
        return this.withClient(conn, async (client) => {
            const startedAt = Date.now();
            const { method, path, body } = parseEsCommand(text);
            // Determine index from path: /indexName/_search or /_cat/indices etc.
            const pathParts = path.split('/').filter(Boolean);
            // Handle _cat/indices
            if (path.startsWith('/_cat/indices') || path.startsWith('/_cat')) {
                const catResult = await client.cat.indices({ format: 'json' });
                const docs = Array.isArray(catResult) ? catResult : [];
                const rows = docs.map((d) => flattenObject(d));
                const columnSet = new Map();
                for (const row of rows) {
                    for (const key of Object.keys(row)) {
                        if (!columnSet.has(key))
                            columnSet.set(key, typeof row[key] === 'number' ? 'number' : 'string');
                    }
                }
                return [{
                        statement: text,
                        rowCount: rows.length,
                        rows,
                        columns: Array.from(columnSet.entries()).map(([name, type]) => ({ name, type })),
                        durationMs: Date.now() - startedAt,
                        resultFormat: 'document',
                        documents: docs,
                        source: { type: 'query' },
                    }];
            }
            // Handle _mapping
            if (path.includes('_mapping')) {
                const index = pathParts.length > 0 && !pathParts[0].startsWith('_') ? pathParts[0] : undefined;
                const mappingResult = await client.indices.getMapping(index ? { index } : {});
                const documents = [mappingResult];
                const rawOutput = JSON.stringify(mappingResult, null, 2);
                return [{
                        statement: text,
                        rowCount: 1,
                        rows: [],
                        columns: [],
                        durationMs: Date.now() - startedAt,
                        resultFormat: 'document',
                        documents,
                        rawOutput,
                        source: { type: 'query' },
                    }];
            }
            // Handle _search (default)
            const index = pathParts.length > 0 && !pathParts[0].startsWith('_') ? pathParts[0] : undefined;
            const searchParams = {};
            if (index)
                searchParams.index = index;
            if (body)
                searchParams.body = body;
            // For DELETE, PUT, etc. route to the generic transport
            if (method === 'DELETE') {
                const result = await client.transport.request({ method: 'DELETE', path }, {});
                return [{
                        statement: text,
                        rowCount: 0,
                        rows: [],
                        columns: [],
                        durationMs: Date.now() - startedAt,
                        resultFormat: 'document',
                        documents: [result],
                        rawOutput: JSON.stringify(result, null, 2),
                        source: { type: 'query' },
                    }];
            }
            if (method === 'PUT') {
                const result = await client.transport.request({ method: 'PUT', path, body }, {});
                return [{
                        statement: text,
                        rowCount: 0,
                        rows: [],
                        columns: [],
                        durationMs: Date.now() - startedAt,
                        resultFormat: 'document',
                        documents: [result],
                        rawOutput: JSON.stringify(result, null, 2),
                        source: { type: 'query' },
                    }];
            }
            // Default: search
            const searchResult = await client.search(searchParams);
            const hits = searchResult.hits?.hits || [];
            const documents = hits.map((hit) => ({
                _id: hit._id,
                _index: hit._index,
                _score: hit._score,
                ...hit._source,
            }));
            const rows = documents.map((doc) => flattenObject(doc));
            const columnSet = new Map();
            for (const row of rows) {
                for (const key of Object.keys(row)) {
                    if (!columnSet.has(key))
                        columnSet.set(key, typeof row[key] === 'number' ? 'number' : 'string');
                }
            }
            return [{
                    statement: text,
                    rowCount: searchResult.hits?.total?.value ?? hits.length,
                    rows,
                    columns: Array.from(columnSet.entries()).map(([name, type]) => ({ name, type })),
                    durationMs: Date.now() - startedAt,
                    resultFormat: 'document',
                    documents,
                    source: { type: 'query' },
                }];
        });
    }
    async schema(conn) {
        return this.withClient(conn, async (client) => {
            // Get all indices
            const catResult = await client.cat.indices({ format: 'json' });
            const indices = Array.isArray(catResult) ? catResult : [];
            // Get mappings for all indices
            const mappingResult = await client.indices.getMapping();
            const tables = [];
            for (const idx of indices) {
                const indexName = idx.index;
                if (!indexName || indexName.startsWith('.'))
                    continue; // skip internal indices
                const mapping = mappingResult[indexName];
                const properties = mapping?.mappings?.properties || {};
                const columns = mappingPropertiesToColumns(properties);
                // Add _id as first column
                columns.unshift({
                    name: '_id',
                    type: 'keyword',
                    nullable: false,
                    defaultValue: null,
                    primaryKey: true,
                });
                tables.push({
                    schema: '',
                    name: indexName,
                    type: 'index',
                    columns,
                    documentCount: parseInt(idx['docs.count'] || '0', 10) || 0,
                });
            }
            return tables;
        });
    }
    async previewTable(conn, _schema, table, options) {
        return this.withClient(conn, async (client) => {
            const startedAt = Date.now();
            const size = (0, utils_1.clampLimit)(options.limit || 100);
            const from = Math.max(0, Math.floor(options.offset || 0));
            const filter = options.search || options.filter || '';
            const searchParams = {
                index: table,
                body: { size, from },
            };
            // If filter is provided, use a query_string query
            if (filter && filter.trim()) {
                searchParams.body.query = {
                    query_string: { query: `*${filter.trim()}*`, default_operator: 'AND' },
                };
            }
            if (options.sortColumn) {
                searchParams.body.sort = [{ [options.sortColumn]: { order: options.sortDirection === 'desc' ? 'desc' : 'asc' } }];
            }
            const searchResult = await client.search(searchParams);
            const hits = searchResult.hits?.hits || [];
            const documents = hits.map((hit) => ({
                _id: hit._id,
                _index: hit._index,
                _score: hit._score,
                ...hit._source,
            }));
            const rows = documents.map((doc) => flattenObject(doc));
            const columnSet = new Map();
            for (const row of rows) {
                for (const key of Object.keys(row)) {
                    if (!columnSet.has(key))
                        columnSet.set(key, typeof row[key] === 'number' ? 'number' : 'string');
                }
            }
            return {
                statement: `GET /${table}/_search { "from": ${from}, "size": ${size} }`,
                rowCount: typeof searchResult.hits?.total === 'number'
                    ? searchResult.hits.total
                    : searchResult.hits?.total?.value ?? rows.length,
                rows,
                columns: Array.from(columnSet.entries()).map(([name, type]) => ({ name, type })),
                durationMs: Date.now() - startedAt,
                resultFormat: 'document',
                documents,
                source: { type: 'table', table, primaryKeys: ['_id'] },
            };
        });
    }
    async updateRow(_conn, _schema, _table, _nextRow, _originalRow, _primaryKeys) {
        throw new Error('Direct row updates are not supported for Elasticsearch. Use the query editor to issue update-by-query or index API calls.');
    }
    async withClient(conn, cb) {
        const { Client } = await Promise.resolve().then(() => __importStar(require('@elastic/elasticsearch')));
        const protocol = conn.ssl ? 'https' : 'http';
        const node = `${protocol}://${conn.host}:${conn.port || 9200}`;
        const clientOpts = { node };
        // Auth: prefer apiKey, fall back to basic auth
        if (conn.apiKey) {
            clientOpts.auth = { apiKey: conn.apiKey };
        }
        else if (conn.user && conn.password) {
            clientOpts.auth = { username: conn.user, password: conn.password };
        }
        if (conn.ssl) {
            clientOpts.tls = { rejectUnauthorized: false };
        }
        const client = new Client(clientOpts);
        try {
            return await cb(client);
        }
        finally {
            await client.close().catch(() => undefined);
        }
    }
}
exports.ElasticsearchAdapter = ElasticsearchAdapter;
