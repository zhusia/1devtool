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
const database_engines_1 = require("../../shared/database-engines");
const utils_1 = require("./utils");
const ADAPTER_MAP = {
    postgres: () => Promise.resolve().then(() => __importStar(require('./adapters/postgres'))).then((m) => new m.PostgresAdapter()),
    cockroachdb: () => Promise.resolve().then(() => __importStar(require('./adapters/postgres'))).then((m) => new m.PostgresAdapter()),
    redshift: () => Promise.resolve().then(() => __importStar(require('./adapters/postgres'))).then((m) => new m.PostgresAdapter()),
    timescaledb: () => Promise.resolve().then(() => __importStar(require('./adapters/postgres'))).then((m) => new m.PostgresAdapter()),
    neon: () => Promise.resolve().then(() => __importStar(require('./adapters/postgres'))).then((m) => new m.PostgresAdapter()),
    hydra: () => Promise.resolve().then(() => __importStar(require('./adapters/postgres'))).then((m) => new m.PostgresAdapter()),
    supabase: () => Promise.resolve().then(() => __importStar(require('./adapters/postgres'))).then((m) => new m.PostgresAdapter()),
    mysql: () => Promise.resolve().then(() => __importStar(require('./adapters/mysql'))).then((m) => new m.MysqlAdapter()),
    mariadb: () => Promise.resolve().then(() => __importStar(require('./adapters/mysql'))).then((m) => new m.MysqlAdapter()),
    mssql: () => Promise.resolve().then(() => __importStar(require('./adapters/mssql'))).then((m) => new m.MssqlAdapter()),
    clickhouse: () => Promise.resolve().then(() => __importStar(require('./adapters/clickhouse'))).then((m) => new m.ClickHouseAdapter()),
    sqlite: () => Promise.resolve().then(() => __importStar(require('./adapters/sqlite'))).then((m) => new m.SqliteAdapter()),
    mongodb: () => Promise.resolve().then(() => __importStar(require('./adapters/mongodb'))).then((m) => new m.MongoDBAdapter()),
    redis: () => Promise.resolve().then(() => __importStar(require('./adapters/redis'))).then((m) => new m.RedisAdapter()),
    valkey: () => Promise.resolve().then(() => __importStar(require('./adapters/redis'))).then((m) => new m.RedisAdapter()),
    keydb: () => Promise.resolve().then(() => __importStar(require('./adapters/redis'))).then((m) => new m.RedisAdapter()),
    elasticsearch: () => Promise.resolve().then(() => __importStar(require('./adapters/elasticsearch'))).then((m) => new m.ElasticsearchAdapter()),
    couchdb: () => Promise.resolve().then(() => __importStar(require('./adapters/couchdb'))).then((m) => new m.CouchDBAdapter()),
    cassandra: () => Promise.resolve().then(() => __importStar(require('./adapters/cassandra'))).then((m) => new m.CassandraAdapter()),
    surrealdb: () => Promise.resolve().then(() => __importStar(require('./adapters/surrealdb'))).then((m) => new m.SurrealDBAdapter()),
    weaviate: () => Promise.resolve().then(() => __importStar(require('./adapters/weaviate'))).then((m) => new m.WeaviateAdapter()),
    influxdb: () => Promise.resolve().then(() => __importStar(require('./adapters/influxdb'))).then((m) => new m.InfluxDBAdapter()),
    kafka: () => Promise.resolve().then(() => __importStar(require('./adapters/kafka'))).then((m) => new m.KafkaAdapter()),
};
const adapterCache = new Map();
class DatabaseManager {
    async getAdapter(engine) {
        const cached = adapterCache.get(engine);
        if (cached) {
            return cached;
        }
        const factory = ADAPTER_MAP[engine];
        if (!factory) {
            throw new Error(`Unsupported database engine: ${engine}`);
        }
        const adapter = await factory();
        adapterCache.set(engine, adapter);
        return adapter;
    }
    async testConnection(connection) {
        const adapter = await this.getAdapter(connection.engine);
        await adapter.testConnection(connection);
    }
    async query(connection, sql) {
        // Safe mode check only applies to SQL-like engines
        const engineDef = database_engines_1.ENGINE_REGISTRY[connection.engine];
        const isSqlLike = engineDef && (engineDef.queryLanguage === 'sql' || engineDef.queryLanguage === 'cql' || engineDef.queryLanguage === 'surrealql');
        if (isSqlLike) {
            const statements = (0, utils_1.splitSqlStatements)(sql);
            if (statements.length === 0) {
                return [];
            }
            for (const statement of statements) {
                if (connection.safeMode && !(0, utils_1.isReadOnlyStatement)(statement)) {
                    throw new Error('Safe Mode is enabled for this connection. Disable it before running write queries.');
                }
            }
        }
        const adapter = await this.getAdapter(connection.engine);
        return adapter.query(connection, sql);
    }
    async schema(connection) {
        const adapter = await this.getAdapter(connection.engine);
        return adapter.schema(connection);
    }
    async previewTable(connection, schema, table, optionsOrFilter = '', limit = 100) {
        const adapter = await this.getAdapter(connection.engine);
        return adapter.previewTable(connection, schema, table, (0, utils_1.normalizeTablePreviewOptions)(optionsOrFilter, limit));
    }
    async updateRow(connection, schema, table, nextRow, originalRow, primaryKeys = []) {
        if (connection.safeMode) {
            throw new Error('Safe Mode is enabled for this connection. Disable it before editing rows.');
        }
        const changedColumns = Object.keys(nextRow).filter((col) => nextRow[col] !== originalRow[col]);
        if (changedColumns.length === 0) {
            return;
        }
        const keyColumns = primaryKeys.filter((col) => col in originalRow);
        const whereColumns = keyColumns.length > 0 ? keyColumns : Object.keys(originalRow);
        const adapter = await this.getAdapter(connection.engine);
        await adapter.updateRow(connection, schema, table, nextRow, originalRow, whereColumns);
    }
}
exports.DatabaseManager = DatabaseManager;
