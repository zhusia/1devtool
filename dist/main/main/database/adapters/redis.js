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
exports.RedisAdapter = void 0;
function buildRedisOptions(conn) {
    const options = {
        host: conn.host || 'localhost',
        port: conn.port || 6379,
        connectTimeout: 10000,
        lazyConnect: true,
    };
    if (conn.password)
        options.password = conn.password;
    if (conn.user)
        options.username = conn.user;
    if (conn.database)
        options.db = parseInt(conn.database, 10) || 0;
    if (conn.ssl) {
        options.tls = { rejectUnauthorized: false };
    }
    return options;
}
async function createRedis(conn) {
    const IORedis = (await Promise.resolve().then(() => __importStar(require('ioredis')))).default;
    if (conn.connectionUri) {
        return new IORedis(conn.connectionUri, {
            connectTimeout: 10000,
            lazyConnect: true,
            ...(conn.ssl ? { tls: { rejectUnauthorized: false } } : {}),
        });
    }
    return new IORedis(buildRedisOptions(conn));
}
function formatRedisValue(value) {
    if (value === null || value === undefined)
        return '(nil)';
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number')
        return String(value);
    if (Array.isArray(value))
        return value.map((v, i) => `${i + 1}) ${formatRedisValue(v)}`).join('\n');
    if (typeof value === 'object')
        return JSON.stringify(value);
    return String(value);
}
const READ_COMMANDS = new Set([
    'get', 'mget', 'hget', 'hgetall', 'hmget', 'hkeys', 'hvals', 'hlen',
    'lrange', 'llen', 'lindex',
    'smembers', 'sismember', 'scard', 'srandmember',
    'zrange', 'zrangebyscore', 'zrank', 'zscore', 'zcard', 'zrangebylex',
    'type', 'ttl', 'pttl', 'exists', 'keys', 'scan', 'dbsize', 'info',
    'strlen', 'getrange', 'object',
    'xlen', 'xrange', 'xrevrange', 'xinfo',
    'ping', 'echo', 'time',
]);
const HASH_COMMANDS = new Set(['hgetall', 'hget', 'hmget', 'hkeys', 'hvals']);
const KV_COMMANDS = new Set(['get', 'mget', 'hgetall']);
function parseRedisLine(line) {
    const tokens = [];
    let current = '';
    let inQuote = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuote) {
            if (ch === inQuote) {
                inQuote = null;
            }
            else if (ch === '\\' && i + 1 < line.length) {
                i++;
                current += line[i];
            }
            else {
                current += ch;
            }
        }
        else if (ch === '"' || ch === "'") {
            inQuote = ch;
        }
        else if (ch === ' ' || ch === '\t') {
            if (current) {
                tokens.push(current);
                current = '';
            }
        }
        else {
            current += ch;
        }
    }
    if (current)
        tokens.push(current);
    return { command: tokens[0] || '', args: tokens.slice(1) };
}
class RedisAdapter {
    async testConnection(conn) {
        await this.withRedis(conn, async (redis) => {
            const result = await redis.ping();
            if (result !== 'PONG') {
                throw new Error(`Unexpected PING response: ${result}`);
            }
        });
    }
    async query(conn, text) {
        const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('//'));
        if (lines.length === 0)
            throw new Error('No commands to execute');
        return this.withRedis(conn, async (redis) => {
            const results = [];
            for (const line of lines) {
                const { command, args } = parseRedisLine(line);
                if (!command)
                    continue;
                const cmdLower = command.toLowerCase();
                const startedAt = Date.now();
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const rawResult = await redis.call(command.toUpperCase(), ...args);
                const durationMs = Date.now() - startedAt;
                // Format result based on command type
                if (KV_COMMANDS.has(cmdLower) && typeof rawResult === 'object' && rawResult !== null && !Array.isArray(rawResult)) {
                    // Hash result from HGETALL — object with key-value pairs
                    const entries = Object.entries(rawResult);
                    results.push({
                        statement: line,
                        rowCount: entries.length,
                        rows: entries.map(([key, value]) => ({ key, value: String(value) })),
                        columns: [
                            { name: 'key', type: 'string' },
                            { name: 'value', type: 'string' },
                        ],
                        durationMs,
                        source: { type: 'query' },
                        resultFormat: 'keyvalue',
                    });
                }
                else if (cmdLower === 'hgetall' && Array.isArray(rawResult)) {
                    // ioredis returns HGETALL as alternating key/value array sometimes
                    const rows = [];
                    for (let i = 0; i < rawResult.length; i += 2) {
                        rows.push({ key: String(rawResult[i]), value: String(rawResult[i + 1] ?? '(nil)') });
                    }
                    results.push({
                        statement: line,
                        rowCount: rows.length,
                        rows,
                        columns: [
                            { name: 'key', type: 'string' },
                            { name: 'value', type: 'string' },
                        ],
                        durationMs,
                        source: { type: 'query' },
                        resultFormat: 'keyvalue',
                    });
                }
                else if (cmdLower === 'get' || cmdLower === 'getrange' || cmdLower === 'echo') {
                    // Single string value
                    results.push({
                        statement: line,
                        rowCount: 1,
                        rows: [{ key: args[0] || command, value: rawResult === null ? null : String(rawResult) }],
                        columns: [
                            { name: 'key', type: 'string' },
                            { name: 'value', type: 'string' },
                        ],
                        durationMs,
                        source: { type: 'query' },
                        resultFormat: 'keyvalue',
                    });
                }
                else if (cmdLower === 'mget' && Array.isArray(rawResult)) {
                    // Multiple GET results
                    const rows = args.map((key, i) => ({
                        key,
                        value: rawResult[i] === null ? null : String(rawResult[i]),
                    }));
                    results.push({
                        statement: line,
                        rowCount: rows.length,
                        rows,
                        columns: [
                            { name: 'key', type: 'string' },
                            { name: 'value', type: 'string' },
                        ],
                        durationMs,
                        source: { type: 'query' },
                        resultFormat: 'keyvalue',
                    });
                }
                else if (Array.isArray(rawResult)) {
                    // List/set/sorted-set results
                    const rows = rawResult.map((item, index) => ({
                        index: index + 1,
                        value: formatRedisValue(item),
                    }));
                    results.push({
                        statement: line,
                        rowCount: rows.length,
                        rows,
                        columns: [
                            { name: 'index', type: 'number' },
                            { name: 'value', type: 'string' },
                        ],
                        durationMs,
                        source: { type: 'query' },
                        resultFormat: 'raw',
                    });
                }
                else if (cmdLower === 'info') {
                    // INFO returns a long multi-line string
                    results.push({
                        statement: line,
                        rowCount: 0,
                        rows: [],
                        columns: [],
                        durationMs,
                        source: { type: 'query' },
                        resultFormat: 'raw',
                        rawOutput: String(rawResult),
                    });
                }
                else {
                    // Scalar result (SET, DEL, EXISTS, TTL, DBSIZE, etc.)
                    const display = rawResult === null ? '(nil)' : String(rawResult);
                    results.push({
                        statement: line,
                        rowCount: 1,
                        rows: [{ result: display }],
                        columns: [{ name: 'result', type: typeof rawResult === 'number' ? 'number' : 'string' }],
                        durationMs,
                        source: { type: 'query' },
                        resultFormat: 'raw',
                        rawOutput: display,
                    });
                }
            }
            return results;
        });
    }
    async schema(conn) {
        return this.withRedis(conn, async (redis) => {
            const tables = [];
            // Get keyspace info
            const infoStr = await redis.info('keyspace');
            const dbName = conn.database || '0';
            // SCAN keys and group by prefix
            const prefixGroups = new Map();
            let cursor = '0';
            let totalScanned = 0;
            const maxScan = 5000; // Limit scan to avoid hanging on huge databases
            do {
                const [nextCursor, keys] = await redis.scan(cursor, 'COUNT', 200);
                cursor = nextCursor;
                for (const key of keys) {
                    totalScanned++;
                    const prefix = this.extractPrefix(key);
                    const group = prefixGroups.get(prefix) || { count: 0, sampleKeys: [], types: new Set() };
                    group.count++;
                    if (group.sampleKeys.length < 5) {
                        group.sampleKeys.push(key);
                    }
                    prefixGroups.set(prefix, group);
                }
            } while (cursor !== '0' && totalScanned < maxScan);
            // Get types for sample keys in each group
            for (const [prefix, group] of prefixGroups) {
                for (const sampleKey of group.sampleKeys.slice(0, 3)) {
                    try {
                        const keyType = await redis.type(sampleKey);
                        group.types.add(keyType);
                    }
                    catch {
                        // skip
                    }
                }
                const typeList = [...group.types];
                tables.push({
                    schema: `db${dbName}`,
                    name: prefix,
                    type: 'keyspace',
                    columns: [
                        { name: 'key', type: 'string', nullable: false, defaultValue: null, primaryKey: true },
                        { name: 'type', type: typeList.join(' | ') || 'unknown', nullable: false, defaultValue: null },
                        { name: 'value', type: 'string', nullable: true, defaultValue: null },
                        { name: 'ttl', type: 'number', nullable: true, defaultValue: null },
                    ],
                    documentCount: group.count,
                    sampleDocument: {
                        keys: group.sampleKeys,
                        types: typeList,
                        pattern: prefix.endsWith(':*') ? prefix : `${prefix}*`,
                    },
                });
            }
            // If no keys found, return empty with keyspace info
            if (tables.length === 0) {
                tables.push({
                    schema: `db${dbName}`,
                    name: '(empty)',
                    type: 'keyspace',
                    columns: [
                        { name: 'key', type: 'string', nullable: false, defaultValue: null, primaryKey: true },
                        { name: 'type', type: 'string', nullable: false, defaultValue: null },
                        { name: 'value', type: 'string', nullable: true, defaultValue: null },
                        { name: 'ttl', type: 'number', nullable: true, defaultValue: null },
                    ],
                    documentCount: 0,
                });
            }
            return tables;
        });
    }
    async previewTable(conn, _schema, table, options) {
        return this.withRedis(conn, async (redis) => {
            const clampedLimit = Math.max(1, Math.min(500, Math.floor(options.limit || 100)));
            const offset = Math.max(0, Math.floor(options.offset || 0));
            const startedAt = Date.now();
            // Build SCAN match pattern from the table (prefix group)
            let pattern = '*';
            if (table && table !== '(empty)') {
                if (table.endsWith(':*')) {
                    pattern = table;
                }
                else if (table.endsWith('*')) {
                    pattern = table;
                }
                else {
                    pattern = `${table}*`;
                }
            }
            // Apply filter if provided
            const search = options.search || options.filter || '';
            if (search && search.trim()) {
                pattern = `*${search.trim()}*`;
            }
            // SCAN for keys matching the pattern
            const keys = [];
            let cursor = '0';
            do {
                const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
                cursor = nextCursor;
                for (const key of batch) {
                    keys.push(key);
                    if (keys.length >= offset + clampedLimit)
                        break;
                }
            } while (cursor !== '0' && keys.length < offset + clampedLimit);
            const hasMore = cursor !== '0';
            // For each key, get type, value, and TTL
            const rows = [];
            for (const key of keys.slice(offset, offset + clampedLimit)) {
                const keyType = await redis.type(key);
                const ttl = await redis.ttl(key);
                let value;
                try {
                    switch (keyType) {
                        case 'string':
                            value = await redis.get(key) ?? '(nil)';
                            break;
                        case 'list': {
                            const items = await redis.lrange(key, 0, 49);
                            value = JSON.stringify(items);
                            break;
                        }
                        case 'set': {
                            const members = await redis.smembers(key);
                            value = JSON.stringify(members);
                            break;
                        }
                        case 'zset': {
                            const zMembers = await redis.zrange(key, 0, 49, 'WITHSCORES');
                            const pairs = [];
                            for (let i = 0; i < zMembers.length; i += 2) {
                                pairs.push({ member: zMembers[i], score: zMembers[i + 1] });
                            }
                            value = JSON.stringify(pairs);
                            break;
                        }
                        case 'hash': {
                            const hash = await redis.hgetall(key);
                            value = JSON.stringify(hash);
                            break;
                        }
                        case 'stream': {
                            const entries = await redis.xrange(key, '-', '+', 'COUNT', 10);
                            value = JSON.stringify(entries);
                            break;
                        }
                        default:
                            value = `(${keyType})`;
                    }
                }
                catch {
                    value = '(error reading value)';
                }
                // Truncate very long values for display
                if (value.length > 2000) {
                    value = value.slice(0, 2000) + '...';
                }
                rows.push({
                    key,
                    type: keyType,
                    value,
                    ttl: ttl === -1 ? null : ttl,
                });
            }
            return {
                statement: `SCAN ${pattern} (limit ${clampedLimit})`,
                rowCount: offset + rows.length + (hasMore || rows.length === clampedLimit ? 1 : 0),
                rows,
                columns: [
                    { name: 'key', type: 'string' },
                    { name: 'type', type: 'string' },
                    { name: 'value', type: 'string' },
                    { name: 'ttl', type: 'number' },
                ],
                durationMs: Date.now() - startedAt,
                source: { type: 'table', schema: _schema, table, primaryKeys: ['key'] },
            };
        });
    }
    async updateRow(conn, _schema, _table, nextRow, originalRow, _primaryKeys) {
        const key = originalRow['key'];
        if (!key || typeof key !== 'string') {
            throw new Error('Cannot update row: missing key');
        }
        const newValue = nextRow['value'];
        if (newValue === undefined) {
            throw new Error('Cannot update row: missing value');
        }
        return this.withRedis(conn, async (redis) => {
            const keyType = await redis.type(key);
            if (keyType === 'string') {
                await redis.set(key, newValue === null ? '' : String(newValue));
            }
            else if (keyType === 'none') {
                // Key was deleted — recreate as string
                await redis.set(key, newValue === null ? '' : String(newValue));
            }
            else {
                throw new Error(`Cannot directly update ${keyType} key "${key}" via row edit. ` +
                    'Use the query panel with the appropriate Redis command instead.');
            }
            // Preserve TTL if originally set
            const originalTtl = originalRow['ttl'];
            if (originalTtl !== null && originalTtl !== undefined && typeof originalTtl === 'number' && originalTtl > 0) {
                await redis.expire(key, originalTtl);
            }
        });
    }
    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------
    async withRedis(conn, cb) {
        const redis = await createRedis(conn);
        await redis.connect();
        try {
            return await cb(redis);
        }
        finally {
            await redis.quit().catch(() => undefined);
        }
    }
    extractPrefix(key) {
        const colonIndex = key.lastIndexOf(':');
        if (colonIndex > 0) {
            return key.slice(0, colonIndex + 1) + '*';
        }
        // No colon — group by first segment or the whole key
        return key;
    }
}
exports.RedisAdapter = RedisAdapter;
