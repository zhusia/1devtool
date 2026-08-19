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
exports.MongoDBAdapter = void 0;
function buildUri(conn) {
    if (conn.connectionUri)
        return conn.connectionUri;
    const credentials = conn.user && conn.password
        ? `${encodeURIComponent(conn.user)}:${encodeURIComponent(conn.password)}@`
        : conn.user
            ? `${encodeURIComponent(conn.user)}@`
            : '';
    const host = conn.host || 'localhost';
    const port = conn.port || 27017;
    const authDb = conn.authDatabase ? `?authSource=${encodeURIComponent(conn.authDatabase)}` : '';
    return `mongodb://${credentials}${host}:${port}/${conn.database || 'test'}${authDb}`;
}
async function lazyMongoClient() {
    return Promise.resolve().then(() => __importStar(require('mongodb')));
}
function serializeMongoValue(value) {
    if (value === null || value === undefined)
        return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        return value;
    if (value instanceof Date)
        return value.toISOString();
    if (Buffer.isBuffer(value))
        return value.toString('utf-8');
    if (typeof value === 'object' && value !== null && 'toHexString' in value) {
        return value.toHexString();
    }
    return JSON.stringify(value);
}
function serializeMongoRows(docs) {
    return docs.map((doc) => {
        const row = {};
        for (const [key, value] of Object.entries(doc)) {
            row[key] = serializeMongoValue(value);
        }
        return row;
    });
}
function inferMongoType(value) {
    if (value === null || value === undefined)
        return 'null';
    if (typeof value === 'string')
        return 'string';
    if (typeof value === 'number')
        return Number.isInteger(value) ? 'int' : 'double';
    if (typeof value === 'boolean')
        return 'bool';
    if (value instanceof Date)
        return 'date';
    if (Array.isArray(value))
        return 'array';
    if (Buffer.isBuffer(value))
        return 'binary';
    if (typeof value === 'object' && value !== null && 'toHexString' in value)
        return 'ObjectId';
    if (typeof value === 'object')
        return 'object';
    return 'unknown';
}
function parseMongoCommand(input) {
    // Match: db.collectionName.method(args)
    const match = input.match(/^db\.(\w+)\.(\w+)\(([\s\S]*)\)$/s);
    if (!match) {
        throw new Error('Invalid MongoDB command. Use: db.collection.method(...)\n' +
            'Supported methods: find, aggregate, insertOne, insertMany, updateOne, updateMany, deleteOne, deleteMany, countDocuments, distinct');
    }
    return {
        collection: match[1],
        method: match[2],
        argsStr: match[3].trim(),
    };
}
function parseArgs(argsStr) {
    if (!argsStr)
        return [];
    try {
        // Wrap in array brackets so we can parse comma-separated args
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const fn = new Function('return [' + argsStr + ']');
        return fn();
    }
    catch {
        throw new Error(`Failed to parse arguments: ${argsStr}`);
    }
}
class MongoDBAdapter {
    async testConnection(conn) {
        await this.withClient(conn, async (client) => {
            const db = client.db(conn.database || undefined);
            await db.command({ ping: 1 });
        });
    }
    async query(conn, sql) {
        const input = sql.trim();
        const { collection, method, argsStr } = parseMongoCommand(input);
        const args = parseArgs(argsStr);
        return this.withClient(conn, async (client) => {
            const db = client.db(conn.database || undefined);
            const coll = db.collection(collection);
            const startedAt = Date.now();
            switch (method) {
                case 'find': {
                    const filter = args[0] || {};
                    const options = args[1] || {};
                    let cursor = coll.find(filter);
                    if (options.sort)
                        cursor = cursor.sort(options.sort);
                    if (options.limit)
                        cursor = cursor.limit(options.limit);
                    if (options.skip)
                        cursor = cursor.skip(options.skip);
                    if (options.projection)
                        cursor = cursor.project(options.projection);
                    if (!options.limit)
                        cursor = cursor.limit(1000);
                    const docs = (await cursor.toArray());
                    const columns = this.extractColumns(docs);
                    return [{
                            statement: input,
                            rowCount: docs.length,
                            rows: serializeMongoRows(docs),
                            columns,
                            durationMs: Date.now() - startedAt,
                            source: { type: 'query' },
                            resultFormat: 'document',
                            documents: docs,
                        }];
                }
                case 'findOne': {
                    const filter = args[0] || {};
                    const doc = await coll.findOne(filter);
                    const docs = doc ? [doc] : [];
                    const columns = this.extractColumns(docs);
                    return [{
                            statement: input,
                            rowCount: docs.length,
                            rows: serializeMongoRows(docs),
                            columns,
                            durationMs: Date.now() - startedAt,
                            source: { type: 'query' },
                            resultFormat: 'document',
                            documents: docs,
                        }];
                }
                case 'aggregate': {
                    const pipeline = args[0] || [];
                    const docs = (await coll.aggregate(pipeline).toArray());
                    const columns = this.extractColumns(docs);
                    return [{
                            statement: input,
                            rowCount: docs.length,
                            rows: serializeMongoRows(docs),
                            columns,
                            durationMs: Date.now() - startedAt,
                            source: { type: 'query' },
                            resultFormat: 'document',
                            documents: docs,
                        }];
                }
                case 'insertOne': {
                    const doc = args[0] || {};
                    const result = await coll.insertOne(doc);
                    return [{
                            statement: input,
                            rowCount: 1,
                            rows: [{ insertedId: String(result.insertedId), acknowledged: result.acknowledged }],
                            columns: [
                                { name: 'insertedId', type: 'string' },
                                { name: 'acknowledged', type: 'boolean' },
                            ],
                            durationMs: Date.now() - startedAt,
                            source: { type: 'query' },
                            notice: `Inserted 1 document`,
                        }];
                }
                case 'insertMany': {
                    const docs = args[0] || [];
                    const result = await coll.insertMany(docs);
                    const insertedCount = result.insertedCount ?? Object.keys(result.insertedIds).length;
                    return [{
                            statement: input,
                            rowCount: insertedCount,
                            rows: [{ insertedCount, acknowledged: result.acknowledged }],
                            columns: [
                                { name: 'insertedCount', type: 'number' },
                                { name: 'acknowledged', type: 'boolean' },
                            ],
                            durationMs: Date.now() - startedAt,
                            source: { type: 'query' },
                            notice: `Inserted ${insertedCount} documents`,
                        }];
                }
                case 'updateOne': {
                    const filter = args[0] || {};
                    const update = args[1] || {};
                    const result = await coll.updateOne(filter, update);
                    return [{
                            statement: input,
                            rowCount: result.modifiedCount,
                            rows: [{
                                    matchedCount: result.matchedCount,
                                    modifiedCount: result.modifiedCount,
                                    acknowledged: result.acknowledged,
                                }],
                            columns: [
                                { name: 'matchedCount', type: 'number' },
                                { name: 'modifiedCount', type: 'number' },
                                { name: 'acknowledged', type: 'boolean' },
                            ],
                            durationMs: Date.now() - startedAt,
                            source: { type: 'query' },
                            notice: `Matched ${result.matchedCount}, modified ${result.modifiedCount}`,
                        }];
                }
                case 'updateMany': {
                    const filter = args[0] || {};
                    const update = args[1] || {};
                    const result = await coll.updateMany(filter, update);
                    return [{
                            statement: input,
                            rowCount: result.modifiedCount,
                            rows: [{
                                    matchedCount: result.matchedCount,
                                    modifiedCount: result.modifiedCount,
                                    acknowledged: result.acknowledged,
                                }],
                            columns: [
                                { name: 'matchedCount', type: 'number' },
                                { name: 'modifiedCount', type: 'number' },
                                { name: 'acknowledged', type: 'boolean' },
                            ],
                            durationMs: Date.now() - startedAt,
                            source: { type: 'query' },
                            notice: `Matched ${result.matchedCount}, modified ${result.modifiedCount}`,
                        }];
                }
                case 'deleteOne': {
                    const filter = args[0] || {};
                    const result = await coll.deleteOne(filter);
                    return [{
                            statement: input,
                            rowCount: result.deletedCount,
                            rows: [{
                                    deletedCount: result.deletedCount,
                                    acknowledged: result.acknowledged,
                                }],
                            columns: [
                                { name: 'deletedCount', type: 'number' },
                                { name: 'acknowledged', type: 'boolean' },
                            ],
                            durationMs: Date.now() - startedAt,
                            source: { type: 'query' },
                            notice: `Deleted ${result.deletedCount} document(s)`,
                        }];
                }
                case 'deleteMany': {
                    const filter = args[0] || {};
                    const result = await coll.deleteMany(filter);
                    return [{
                            statement: input,
                            rowCount: result.deletedCount,
                            rows: [{
                                    deletedCount: result.deletedCount,
                                    acknowledged: result.acknowledged,
                                }],
                            columns: [
                                { name: 'deletedCount', type: 'number' },
                                { name: 'acknowledged', type: 'boolean' },
                            ],
                            durationMs: Date.now() - startedAt,
                            source: { type: 'query' },
                            notice: `Deleted ${result.deletedCount} document(s)`,
                        }];
                }
                case 'countDocuments': {
                    const filter = args[0] || {};
                    const count = await coll.countDocuments(filter);
                    return [{
                            statement: input,
                            rowCount: 1,
                            rows: [{ count }],
                            columns: [{ name: 'count', type: 'number' }],
                            durationMs: Date.now() - startedAt,
                            source: { type: 'query' },
                        }];
                }
                case 'distinct': {
                    const field = args[0];
                    const filter = args[1] || {};
                    const values = await coll.distinct(field, filter);
                    const rows = values.map((v) => ({ value: serializeMongoValue(v) }));
                    return [{
                            statement: input,
                            rowCount: rows.length,
                            rows,
                            columns: [{ name: 'value', type: 'string' }],
                            durationMs: Date.now() - startedAt,
                            source: { type: 'query' },
                        }];
                }
                default:
                    throw new Error(`Unsupported method: ${method}. ` +
                        'Supported: find, findOne, aggregate, insertOne, insertMany, updateOne, updateMany, deleteOne, deleteMany, countDocuments, distinct');
            }
        });
    }
    async schema(conn) {
        return this.withClient(conn, async (client) => {
            const db = client.db(conn.database || undefined);
            const collections = await db.listCollections().toArray();
            const tables = [];
            for (const collInfo of collections) {
                const coll = db.collection(collInfo.name);
                const sampleDoc = await coll.findOne();
                const docCount = await coll.estimatedDocumentCount();
                const columns = [];
                if (sampleDoc) {
                    for (const [key, value] of Object.entries(sampleDoc)) {
                        columns.push({
                            name: key,
                            type: inferMongoType(value),
                            nullable: true,
                            defaultValue: null,
                            primaryKey: key === '_id',
                        });
                    }
                }
                else {
                    // Always include _id even when collection is empty
                    columns.push({
                        name: '_id',
                        type: 'ObjectId',
                        nullable: false,
                        defaultValue: null,
                        primaryKey: true,
                    });
                }
                tables.push({
                    schema: conn.database || 'default',
                    name: collInfo.name,
                    type: 'collection',
                    columns,
                    sampleDocument: sampleDoc ? sampleDoc : undefined,
                    documentCount: docCount,
                });
            }
            return tables;
        });
    }
    async previewTable(conn, _schema, table, options) {
        return this.withClient(conn, async (client) => {
            const db = client.db(conn.database || undefined);
            const coll = db.collection(table);
            const clampedLimit = Math.max(1, Math.min(500, Math.floor(options.limit || 100)));
            const offset = Math.max(0, Math.floor(options.offset || 0));
            const filter = options.filter || options.search || '';
            const startedAt = Date.now();
            let mongoFilter = {};
            if (filter && filter.trim()) {
                try {
                    // Try parsing as JSON filter
                    // eslint-disable-next-line @typescript-eslint/no-implied-eval
                    mongoFilter = new Function('return ' + filter.trim())();
                }
                catch {
                    // Fall back to text search across string fields — sample a doc to find fields
                    const sample = await coll.findOne();
                    if (sample) {
                        const orClauses = [];
                        for (const [key, value] of Object.entries(sample)) {
                            if (typeof value === 'string') {
                                orClauses.push({ [key]: { $regex: filter.trim(), $options: 'i' } });
                            }
                        }
                        if (orClauses.length > 0) {
                            mongoFilter = { $or: orClauses };
                        }
                    }
                }
            }
            const sort = options.sortColumn
                ? { [options.sortColumn]: options.sortDirection === 'desc' ? -1 : 1 }
                : undefined;
            const total = await coll.countDocuments(mongoFilter);
            const docs = (await coll
                .find(mongoFilter)
                .sort(sort || {})
                .skip(offset)
                .limit(clampedLimit)
                .toArray());
            const columns = this.extractColumns(docs);
            return {
                statement: `db.${table}.find(${JSON.stringify(mongoFilter)})${sort ? `.sort(${JSON.stringify(sort)})` : ''}.skip(${offset}).limit(${clampedLimit})`,
                rowCount: total,
                rows: serializeMongoRows(docs),
                columns,
                durationMs: Date.now() - startedAt,
                source: { type: 'table', schema: _schema, table, primaryKeys: ['_id'] },
                resultFormat: 'document',
                documents: docs,
            };
        });
    }
    async updateRow(conn, _schema, table, nextRow, originalRow, _primaryKeys) {
        const changedColumns = Object.keys(nextRow).filter((col) => nextRow[col] !== originalRow[col]);
        if (changedColumns.length === 0)
            return;
        return this.withClient(conn, async (client) => {
            const db = client.db(conn.database || undefined);
            const coll = db.collection(table);
            // Build the _id filter — try ObjectId first, fall back to raw value
            const rawId = originalRow['_id'];
            let idFilter = rawId;
            if (typeof rawId === 'string' && /^[0-9a-f]{24}$/i.test(rawId)) {
                const { ObjectId } = await lazyMongoClient();
                idFilter = new ObjectId(rawId);
            }
            const $set = {};
            for (const col of changedColumns) {
                $set[col] = nextRow[col];
            }
            const result = await coll.updateOne({ _id: idFilter }, { $set });
            if (result.matchedCount === 0) {
                throw new Error('No document matched the given _id. The row may have been deleted.');
            }
        });
    }
    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------
    async withClient(conn, cb) {
        const { MongoClient } = await lazyMongoClient();
        const uri = buildUri(conn);
        const client = new MongoClient(uri, {
            connectTimeoutMS: 10000,
            serverSelectionTimeoutMS: 10000,
            ...(conn.ssl ? { tls: true, tlsAllowInvalidCertificates: true } : {}),
        });
        await client.connect();
        try {
            return await cb(client);
        }
        finally {
            await client.close().catch(() => undefined);
        }
    }
    extractColumns(docs) {
        const columnMap = new Map();
        for (const doc of docs) {
            for (const [key, value] of Object.entries(doc)) {
                if (!columnMap.has(key)) {
                    columnMap.set(key, inferMongoType(value));
                }
            }
        }
        // Ensure _id comes first
        const columns = [];
        if (columnMap.has('_id')) {
            columns.push({ name: '_id', type: columnMap.get('_id') });
            columnMap.delete('_id');
        }
        for (const [name, type] of columnMap) {
            columns.push({ name, type });
        }
        return columns;
    }
}
exports.MongoDBAdapter = MongoDBAdapter;
