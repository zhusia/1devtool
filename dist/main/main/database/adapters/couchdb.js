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
exports.CouchDBAdapter = void 0;
const utils_1 = require("../utils");
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Flatten a document's fields into DatabasePrimitive values for tabular display.
 */
function flattenDocument(doc) {
    const result = {};
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
/**
 * Infer column definitions from an array of documents by sampling all keys.
 */
function inferColumnsFromDocs(docs) {
    const columnMap = new Map();
    for (const doc of docs) {
        for (const [key, value] of Object.entries(doc)) {
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
    // Ensure _id and _rev appear first
    const ordered = [];
    if (columnMap.has('_id')) {
        ordered.push({ name: '_id', type: 'string', nullable: false, defaultValue: null, primaryKey: true });
        columnMap.delete('_id');
    }
    if (columnMap.has('_rev')) {
        ordered.push({ name: '_rev', type: 'string', nullable: false, defaultValue: null, primaryKey: false });
        columnMap.delete('_rev');
    }
    for (const [name, type] of Array.from(columnMap.entries())) {
        ordered.push({ name, type, nullable: true, defaultValue: null, primaryKey: false });
    }
    return ordered;
}
class CouchDBAdapter {
    async testConnection(conn) {
        await this.withNano(conn, async (nano) => {
            await nano.db.list();
        });
    }
    async query(conn, text) {
        return this.withNano(conn, async (nano) => {
            const startedAt = Date.now();
            const db = nano.db.use(conn.database);
            // Parse input as Mango query JSON
            let mangoQuery;
            try {
                mangoQuery = JSON.parse(text.trim());
            }
            catch {
                throw new Error('Invalid CouchDB query. Provide a Mango query as JSON, e.g. { "selector": { "type": "user" }, "limit": 25 }');
            }
            // Ensure selector exists
            if (!mangoQuery.selector) {
                mangoQuery = { selector: mangoQuery };
            }
            const result = await db.find(mangoQuery);
            const docs = result.docs || [];
            const rows = docs.map((doc) => flattenDocument(doc));
            const columns = inferColumnsFromDocs(docs);
            return [{
                    statement: text,
                    rowCount: docs.length,
                    rows,
                    columns: columns.map((c) => ({ name: c.name, type: c.type })),
                    durationMs: Date.now() - startedAt,
                    resultFormat: 'document',
                    documents: docs,
                    notice: result.warning || undefined,
                    source: { type: 'query' },
                }];
        });
    }
    async schema(conn) {
        return this.withNano(conn, async (nano) => {
            const db = nano.db.use(conn.database);
            // Get database info for document count
            const dbInfo = await db.info();
            // Get a sample of documents to infer schema
            const sampleResult = await db.find({
                selector: {},
                limit: 100,
            });
            const docs = sampleResult.docs || [];
            // Group documents by "type" field if present, otherwise treat as single collection
            const typeGroups = new Map();
            for (const doc of docs) {
                // Skip design documents
                if (typeof doc._id === 'string' && doc._id.startsWith('_design/'))
                    continue;
                const typeName = doc.type || doc._type || conn.database;
                if (!typeGroups.has(typeName)) {
                    typeGroups.set(typeName, []);
                }
                typeGroups.get(typeName).push(doc);
            }
            // If no type grouping was meaningful, use database name as single collection
            if (typeGroups.size === 0) {
                return [{
                        schema: conn.database,
                        name: conn.database,
                        type: 'collection',
                        columns: [
                            { name: '_id', type: 'string', nullable: false, defaultValue: null, primaryKey: true },
                            { name: '_rev', type: 'string', nullable: false, defaultValue: null },
                        ],
                        documentCount: dbInfo.doc_count || 0,
                    }];
            }
            const tables = [];
            for (const [typeName, typeDocs] of Array.from(typeGroups.entries())) {
                const columns = inferColumnsFromDocs(typeDocs);
                const sampleDocument = typeDocs[0] ? { ...typeDocs[0] } : undefined;
                tables.push({
                    schema: conn.database,
                    name: typeName,
                    type: 'collection',
                    columns,
                    sampleDocument,
                    documentCount: typeName === conn.database ? (dbInfo.doc_count || 0) : typeDocs.length,
                });
            }
            return tables;
        });
    }
    async previewTable(conn, _schema, table, options) {
        return this.withNano(conn, async (nano) => {
            const startedAt = Date.now();
            const db = nano.db.use(conn.database);
            const size = (0, utils_1.clampLimit)(options.limit || 100);
            const offset = Math.max(0, Math.floor(options.offset || 0));
            const filter = options.search || options.filter || '';
            // Build selector: if table name differs from database name, filter by type
            let selector = {};
            if (table && table !== conn.database) {
                selector = { $or: [{ type: table }, { _type: table }] };
            }
            // Add text filter if provided
            if (filter && filter.trim()) {
                // Use $regex on common fields for basic filtering
                const filterRegex = `(?i)${filter.trim()}`;
                selector = {
                    $and: [
                        selector,
                        {
                            $or: [
                                { _id: { $regex: filterRegex } },
                            ],
                        },
                    ],
                };
            }
            // If selector is still empty, use match-all
            if (Object.keys(selector).length === 0) {
                selector = {};
            }
            const result = await db.find({
                selector,
                skip: offset,
                limit: size,
            });
            const docs = result.docs || [];
            const rows = docs.map((doc) => flattenDocument(doc));
            const columns = inferColumnsFromDocs(docs);
            return {
                statement: JSON.stringify({ selector, limit: size }),
                rowCount: offset + docs.length + (docs.length === size ? 1 : 0),
                rows,
                columns: columns.map((c) => ({ name: c.name, type: c.type })),
                durationMs: Date.now() - startedAt,
                resultFormat: 'document',
                documents: docs,
                source: { type: 'table', table, primaryKeys: ['_id'] },
            };
        });
    }
    async updateRow(conn, _schema, _table, nextRow, originalRow, _primaryKeys) {
        const docId = originalRow._id;
        if (!docId || typeof docId !== 'string') {
            throw new Error('Cannot update document: missing _id field');
        }
        return this.withNano(conn, async (nano) => {
            const db = nano.db.use(conn.database);
            // Get current document to obtain latest _rev
            const current = await db.get(docId);
            // Merge changes into the current document
            const updated = { ...current };
            for (const [key, value] of Object.entries(nextRow)) {
                if (key === '_id' || key === '_rev')
                    continue;
                // Try to parse JSON strings back to objects for nested fields
                if (typeof value === 'string') {
                    try {
                        const parsed = JSON.parse(value);
                        if (typeof parsed === 'object' && parsed !== null) {
                            updated[key] = parsed;
                            continue;
                        }
                    }
                    catch {
                        // Not JSON, keep as string
                    }
                }
                updated[key] = value;
            }
            await db.insert(updated);
        });
    }
    async withNano(conn, cb) {
        const nanoModule = await Promise.resolve().then(() => __importStar(require('nano')));
        const nanoFactory = (nanoModule.default || nanoModule);
        const protocol = conn.ssl ? 'https' : 'http';
        let url;
        if (conn.user && conn.password) {
            const encodedUser = encodeURIComponent(conn.user);
            const encodedPass = encodeURIComponent(conn.password);
            url = `${protocol}://${encodedUser}:${encodedPass}@${conn.host}:${conn.port || 5984}`;
        }
        else {
            url = `${protocol}://${conn.host}:${conn.port || 5984}`;
        }
        const nano = nanoFactory(url);
        return cb(nano);
    }
}
exports.CouchDBAdapter = CouchDBAdapter;
