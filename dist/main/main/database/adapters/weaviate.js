"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WeaviateAdapter = void 0;
/* eslint-disable @typescript-eslint/no-explicit-any */
const axios_1 = __importDefault(require("axios"));
class WeaviateAdapter {
    async testConnection(conn) {
        const client = this.createClient(conn);
        await client.get('/v1/.well-known/ready');
    }
    async query(conn, text) {
        const client = this.createClient(conn);
        const startedAt = Date.now();
        const trimmed = text.trim();
        // Support REST-style queries: GET /v1/path
        if (/^GET\s+\//i.test(trimmed)) {
            const urlPath = trimmed.replace(/^GET\s+/i, '').trim();
            const response = await client.get(urlPath);
            const durationMs = Date.now() - startedAt;
            const data = response.data;
            const documents = Array.isArray(data) ? data : (data?.classes || data?.objects || [data]);
            return [{
                    statement: trimmed,
                    rowCount: documents.length,
                    rows: documents.map((doc) => this.flattenDocument(doc)),
                    columns: documents.length > 0
                        ? Object.keys(this.flattenDocument(documents[0])).map((name) => ({
                            name,
                            type: typeof documents[0][name] === 'number' ? 'number' : 'string',
                        }))
                        : [],
                    durationMs,
                    source: { type: 'query' },
                    resultFormat: 'document',
                    documents,
                    rawOutput: JSON.stringify(data, null, 2),
                }];
        }
        // Default: GraphQL query
        const response = await client.post('/v1/graphql', { query: trimmed });
        const durationMs = Date.now() - startedAt;
        const data = response.data;
        if (data.errors && data.errors.length > 0) {
            const messages = data.errors.map((e) => e.message).join('; ');
            throw new Error(`GraphQL error: ${messages}`);
        }
        const documents = this.extractDocuments(data.data);
        return [{
                statement: trimmed,
                rowCount: documents.length,
                rows: documents.map((doc) => this.flattenDocument(doc)),
                columns: documents.length > 0
                    ? Object.keys(this.flattenDocument(documents[0])).map((name) => ({
                        name,
                        type: typeof documents[0][name] === 'number' ? 'number' : 'string',
                    }))
                    : [],
                durationMs,
                source: { type: 'query' },
                resultFormat: 'document',
                documents,
            }];
    }
    async schema(conn) {
        const client = this.createClient(conn);
        const response = await client.get('/v1/schema');
        const classes = response.data.classes || [];
        const tables = [];
        for (const cls of classes) {
            let documentCount;
            try {
                const countResponse = await client.get(`/v1/objects`, {
                    params: { class: cls.class, limit: 0 },
                });
                documentCount = countResponse.data.totalResults ?? countResponse.data.total ?? undefined;
            }
            catch {
                // count not available, leave undefined
            }
            const columns = (cls.properties || []).map((prop) => ({
                name: prop.name,
                type: Array.isArray(prop.dataType) ? prop.dataType.join(', ') : String(prop.dataType || 'unknown'),
                nullable: true,
                defaultValue: null,
            }));
            tables.push({
                schema: 'default',
                name: cls.class,
                type: 'collection',
                columns,
                documentCount,
            });
        }
        return tables;
    }
    async previewTable(conn, _schema, table, options) {
        const client = this.createClient(conn);
        // First, get the class properties to know which fields to query
        const schemaResponse = await client.get('/v1/schema');
        const classes = schemaResponse.data.classes || [];
        const cls = classes.find((c) => c.class === table);
        if (!cls) {
            throw new Error(`Class "${table}" not found in Weaviate schema`);
        }
        const propertyNames = (cls.properties || []).map((p) => p.name);
        if (propertyNames.length === 0) {
            return {
                statement: `Get { ${table} }`,
                rowCount: 0,
                rows: [],
                columns: [],
                durationMs: 0,
                source: { type: 'table', schema: 'default', table },
                resultFormat: 'document',
                documents: [],
            };
        }
        const propsQuery = propertyNames.join(' ');
        const limit = Math.min(options.limit || 100, 1000);
        const offset = Math.max(0, Math.floor(options.offset || 0));
        const graphqlQuery = `{ Get { ${table}(limit: ${limit}, offset: ${offset}) { ${propsQuery} } } }`;
        const startedAt = Date.now();
        const response = await client.post('/v1/graphql', { query: graphqlQuery });
        const durationMs = Date.now() - startedAt;
        if (response.data.errors && response.data.errors.length > 0) {
            const messages = response.data.errors.map((e) => e.message).join('; ');
            throw new Error(`GraphQL error: ${messages}`);
        }
        const documents = response.data?.data?.Get?.[table] || [];
        return {
            statement: graphqlQuery,
            rowCount: offset + documents.length + (documents.length === limit ? 1 : 0),
            rows: documents.map((doc) => this.flattenDocument(doc)),
            columns: propertyNames.map((name) => ({
                name,
                type: documents.length > 0 ? this.inferType(documents[0][name]) : 'string',
            })),
            durationMs,
            source: { type: 'table', schema: 'default', table },
            resultFormat: 'document',
            documents,
        };
    }
    async updateRow(_conn, _schema, _table, _nextRow, _originalRow, _primaryKeys) {
        throw new Error('Weaviate does not support row-level updates through SQL. Use the REST API directly.');
    }
    createClient(conn) {
        const protocol = conn.ssl ? 'https' : 'http';
        const baseURL = `${protocol}://${conn.host}:${conn.port}`;
        const headers = {
            'Content-Type': 'application/json',
        };
        if (conn.apiKey) {
            headers['Authorization'] = `Bearer ${conn.apiKey}`;
        }
        return axios_1.default.create({
            baseURL,
            headers,
            timeout: 30000,
        });
    }
    extractDocuments(data) {
        if (!data)
            return [];
        // GraphQL responses are nested: data.Get.ClassName or data.Aggregate.ClassName
        for (const operationKey of Object.keys(data)) {
            const operation = data[operationKey];
            if (typeof operation === 'object' && operation !== null) {
                for (const classKey of Object.keys(operation)) {
                    const value = operation[classKey];
                    if (Array.isArray(value)) {
                        return value;
                    }
                }
            }
        }
        return [];
    }
    flattenDocument(doc) {
        const result = {};
        if (!doc || typeof doc !== 'object')
            return result;
        for (const [key, value] of Object.entries(doc)) {
            if (value === null || value === undefined) {
                result[key] = null;
            }
            else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                result[key] = value;
            }
            else {
                result[key] = JSON.stringify(value);
            }
        }
        return result;
    }
    inferType(value) {
        if (value === null || value === undefined)
            return 'string';
        if (typeof value === 'number')
            return 'number';
        if (typeof value === 'boolean')
            return 'boolean';
        if (Array.isArray(value))
            return 'array';
        if (typeof value === 'object')
            return 'object';
        return 'string';
    }
}
exports.WeaviateAdapter = WeaviateAdapter;
