"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENGINE_REGISTRY = void 0;
exports.getEngineGroups = getEngineGroups;
const STANDARD_SQL_FIELDS = [
    { key: 'host', label: 'Host', type: 'text', placeholder: 'localhost', required: true },
    { key: 'port', label: 'Port', type: 'number', required: true },
    { key: 'database', label: 'Database', type: 'text', required: true },
    { key: 'user', label: 'User', type: 'text', required: true },
    { key: 'password', label: 'Password', type: 'password', required: true },
    { key: 'ssl', label: 'SSL', type: 'toggle', defaultValue: false },
];
const SQLITE_FIELDS = [
    { key: 'database', label: 'Database File', type: 'text', placeholder: '/path/to/database.sqlite', required: true },
];
const MONGODB_FIELDS = [
    { key: 'connectionUri', label: 'Connection URI', type: 'text', placeholder: 'mongodb://localhost:27017' },
    { key: 'host', label: 'Host', type: 'text', placeholder: 'localhost' },
    { key: 'port', label: 'Port', type: 'number', defaultValue: 27017 },
    { key: 'database', label: 'Database', type: 'text', required: true },
    { key: 'user', label: 'User', type: 'text' },
    { key: 'password', label: 'Password', type: 'password' },
    { key: 'authDatabase', label: 'Auth Database', type: 'text', placeholder: 'admin' },
    { key: 'ssl', label: 'SSL/TLS', type: 'toggle', defaultValue: false },
];
const REDIS_FIELDS = [
    { key: 'host', label: 'Host', type: 'text', placeholder: 'localhost', required: true },
    { key: 'port', label: 'Port', type: 'number', required: true },
    { key: 'password', label: 'Password', type: 'password' },
    { key: 'database', label: 'Database (0-15)', type: 'number', defaultValue: 0 },
    { key: 'ssl', label: 'TLS', type: 'toggle', defaultValue: false },
];
const ELASTICSEARCH_FIELDS = [
    { key: 'host', label: 'Host', type: 'text', placeholder: 'localhost', required: true },
    { key: 'port', label: 'Port', type: 'number', required: true },
    { key: 'user', label: 'User', type: 'text' },
    { key: 'password', label: 'Password', type: 'password' },
    { key: 'apiKey', label: 'API Key', type: 'password' },
    { key: 'ssl', label: 'SSL/TLS', type: 'toggle', defaultValue: false },
];
const COUCHDB_FIELDS = [
    { key: 'host', label: 'Host', type: 'text', placeholder: 'localhost', required: true },
    { key: 'port', label: 'Port', type: 'number', required: true },
    { key: 'database', label: 'Database', type: 'text', required: true },
    { key: 'user', label: 'User', type: 'text' },
    { key: 'password', label: 'Password', type: 'password' },
    { key: 'ssl', label: 'SSL', type: 'toggle', defaultValue: false },
];
const KAFKA_FIELDS = [
    { key: 'kafkaBrokers', label: 'Brokers', type: 'text', placeholder: 'localhost:9092', required: true },
    { key: 'user', label: 'SASL Username', type: 'text' },
    { key: 'password', label: 'SASL Password', type: 'password' },
    { key: 'ssl', label: 'SSL', type: 'toggle', defaultValue: false },
];
const INFLUXDB_FIELDS = [
    { key: 'host', label: 'Host', type: 'text', placeholder: 'localhost', required: true },
    { key: 'port', label: 'Port', type: 'number', required: true },
    { key: 'influxOrg', label: 'Organization', type: 'text', required: true },
    { key: 'influxBucket', label: 'Bucket', type: 'text', required: true },
    { key: 'influxToken', label: 'API Token', type: 'password', required: true },
    { key: 'ssl', label: 'SSL', type: 'toggle', defaultValue: false },
];
const SURREALDB_FIELDS = [
    { key: 'host', label: 'Host', type: 'text', placeholder: 'localhost', required: true },
    { key: 'port', label: 'Port', type: 'number', required: true },
    { key: 'surrealNamespace', label: 'Namespace', type: 'text', required: true },
    { key: 'surrealDatabase', label: 'Database', type: 'text', required: true },
    { key: 'user', label: 'User', type: 'text' },
    { key: 'password', label: 'Password', type: 'password' },
];
const WEAVIATE_FIELDS = [
    { key: 'host', label: 'Host', type: 'text', placeholder: 'localhost', required: true },
    { key: 'port', label: 'Port', type: 'number', required: true },
    { key: 'apiKey', label: 'API Key', type: 'password' },
    { key: 'ssl', label: 'HTTPS', type: 'toggle', defaultValue: false },
];
exports.ENGINE_REGISTRY = {
    // PostgreSQL-compatible
    postgres: { engine: 'postgres', label: 'PostgreSQL', family: 'sql', group: 'SQL', driverFamily: 'pg', defaultPort: 5432, queryLanguage: 'sql', monacoLanguage: 'sql', supportsSchema: true, supportsPreview: true, supportsUpdate: true, supportsImportExport: true, connectionFields: STANDARD_SQL_FIELDS },
    cockroachdb: { engine: 'cockroachdb', label: 'CockroachDB', family: 'sql', group: 'SQL', driverFamily: 'pg', defaultPort: 26257, queryLanguage: 'sql', monacoLanguage: 'sql', supportsSchema: true, supportsPreview: true, supportsUpdate: true, supportsImportExport: true, connectionFields: STANDARD_SQL_FIELDS },
    redshift: { engine: 'redshift', label: 'Amazon Redshift', family: 'sql', group: 'SQL', driverFamily: 'pg', defaultPort: 5439, queryLanguage: 'sql', monacoLanguage: 'sql', supportsSchema: true, supportsPreview: true, supportsUpdate: true, supportsImportExport: true, connectionFields: STANDARD_SQL_FIELDS },
    timescaledb: { engine: 'timescaledb', label: 'TimescaleDB', family: 'sql', group: 'SQL', driverFamily: 'pg', defaultPort: 5432, queryLanguage: 'sql', monacoLanguage: 'sql', supportsSchema: true, supportsPreview: true, supportsUpdate: true, supportsImportExport: true, connectionFields: STANDARD_SQL_FIELDS },
    neon: { engine: 'neon', label: 'Neon', family: 'sql', group: 'SQL', driverFamily: 'pg', defaultPort: 5432, queryLanguage: 'sql', monacoLanguage: 'sql', supportsSchema: true, supportsPreview: true, supportsUpdate: true, supportsImportExport: true, connectionFields: [...STANDARD_SQL_FIELDS.map((f) => f.key === 'ssl' ? { ...f, defaultValue: true } : f)] },
    hydra: { engine: 'hydra', label: 'Hydra', family: 'sql', group: 'SQL', driverFamily: 'pg', defaultPort: 5432, queryLanguage: 'sql', monacoLanguage: 'sql', supportsSchema: true, supportsPreview: true, supportsUpdate: true, supportsImportExport: true, connectionFields: STANDARD_SQL_FIELDS },
    supabase: { engine: 'supabase', label: 'Supabase', family: 'sql', group: 'SQL', driverFamily: 'pg', defaultPort: 5432, queryLanguage: 'sql', monacoLanguage: 'sql', supportsSchema: true, supportsPreview: true, supportsUpdate: true, supportsImportExport: true, connectionFields: [...STANDARD_SQL_FIELDS.map((f) => f.key === 'ssl' ? { ...f, defaultValue: true } : f)] },
    // MySQL-compatible
    mysql: { engine: 'mysql', label: 'MySQL', family: 'sql', group: 'SQL', driverFamily: 'mysql2', defaultPort: 3306, queryLanguage: 'sql', monacoLanguage: 'sql', supportsSchema: true, supportsPreview: true, supportsUpdate: true, supportsImportExport: true, connectionFields: STANDARD_SQL_FIELDS },
    mariadb: { engine: 'mariadb', label: 'MariaDB', family: 'sql', group: 'SQL', driverFamily: 'mysql2', defaultPort: 3306, queryLanguage: 'sql', monacoLanguage: 'sql', supportsSchema: true, supportsPreview: true, supportsUpdate: true, supportsImportExport: true, connectionFields: STANDARD_SQL_FIELDS },
    // Additional SQL
    mssql: { engine: 'mssql', label: 'SQL Server', family: 'sql', group: 'SQL', driverFamily: 'mssql', defaultPort: 1433, queryLanguage: 'sql', monacoLanguage: 'sql', supportsSchema: true, supportsPreview: true, supportsUpdate: true, supportsImportExport: true, connectionFields: STANDARD_SQL_FIELDS },
    clickhouse: { engine: 'clickhouse', label: 'ClickHouse', family: 'sql', group: 'SQL', driverFamily: 'clickhouse', defaultPort: 8123, queryLanguage: 'sql', monacoLanguage: 'sql', supportsSchema: true, supportsPreview: true, supportsUpdate: false, supportsImportExport: true, connectionFields: STANDARD_SQL_FIELDS },
    sqlite: { engine: 'sqlite', label: 'SQLite', family: 'sql', group: 'SQL', driverFamily: 'better-sqlite3', defaultPort: 0, queryLanguage: 'sql', monacoLanguage: 'sql', supportsSchema: true, supportsPreview: true, supportsUpdate: true, supportsImportExport: true, connectionFields: SQLITE_FIELDS },
    // NoSQL document
    mongodb: { engine: 'mongodb', label: 'MongoDB', family: 'nosql', group: 'NoSQL', driverFamily: 'mongodb', defaultPort: 27017, queryLanguage: 'mql', monacoLanguage: 'javascript', supportsSchema: true, supportsPreview: true, supportsUpdate: true, supportsImportExport: true, connectionFields: MONGODB_FIELDS },
    elasticsearch: { engine: 'elasticsearch', label: 'Elasticsearch', family: 'nosql', group: 'NoSQL', driverFamily: 'elasticsearch', defaultPort: 9200, queryLanguage: 'elasticsearch-dsl', monacoLanguage: 'json', supportsSchema: true, supportsPreview: true, supportsUpdate: false, supportsImportExport: true, connectionFields: ELASTICSEARCH_FIELDS },
    couchdb: { engine: 'couchdb', label: 'CouchDB', family: 'nosql', group: 'NoSQL', driverFamily: 'couchdb', defaultPort: 5984, queryLanguage: 'mql', monacoLanguage: 'json', supportsSchema: true, supportsPreview: true, supportsUpdate: true, supportsImportExport: true, connectionFields: COUCHDB_FIELDS },
    // NoSQL wide-column
    cassandra: { engine: 'cassandra', label: 'Cassandra', family: 'nosql', group: 'NoSQL', driverFamily: 'cassandra', defaultPort: 9042, queryLanguage: 'cql', monacoLanguage: 'sql', supportsSchema: true, supportsPreview: true, supportsUpdate: true, supportsImportExport: true, connectionFields: STANDARD_SQL_FIELDS },
    // Multi-model / vector
    surrealdb: { engine: 'surrealdb', label: 'SurrealDB', family: 'nosql', group: 'Multi-Model', driverFamily: 'surrealdb', defaultPort: 8000, queryLanguage: 'surrealql', monacoLanguage: 'sql', supportsSchema: true, supportsPreview: true, supportsUpdate: true, supportsImportExport: true, connectionFields: SURREALDB_FIELDS },
    weaviate: { engine: 'weaviate', label: 'Weaviate', family: 'nosql', group: 'Vector', driverFamily: 'weaviate', defaultPort: 8080, queryLanguage: 'graphql', monacoLanguage: 'plaintext', supportsSchema: true, supportsPreview: true, supportsUpdate: false, supportsImportExport: false, connectionFields: WEAVIATE_FIELDS },
    // Cache (Redis-compatible)
    redis: { engine: 'redis', label: 'Redis', family: 'cache', group: 'Cache', driverFamily: 'redis', defaultPort: 6379, queryLanguage: 'redis-cli', monacoLanguage: 'plaintext', supportsSchema: true, supportsPreview: true, supportsUpdate: true, supportsImportExport: false, connectionFields: REDIS_FIELDS },
    valkey: { engine: 'valkey', label: 'Valkey', family: 'cache', group: 'Cache', driverFamily: 'redis', defaultPort: 6379, queryLanguage: 'redis-cli', monacoLanguage: 'plaintext', supportsSchema: true, supportsPreview: true, supportsUpdate: true, supportsImportExport: false, connectionFields: REDIS_FIELDS },
    keydb: { engine: 'keydb', label: 'KeyDB', family: 'cache', group: 'Cache', driverFamily: 'redis', defaultPort: 6379, queryLanguage: 'redis-cli', monacoLanguage: 'plaintext', supportsSchema: true, supportsPreview: true, supportsUpdate: true, supportsImportExport: false, connectionFields: REDIS_FIELDS },
    // Specialized
    influxdb: { engine: 'influxdb', label: 'InfluxDB', family: 'specialized', group: 'Specialized', driverFamily: 'influxdb', defaultPort: 8086, queryLanguage: 'flux', monacoLanguage: 'plaintext', supportsSchema: true, supportsPreview: true, supportsUpdate: false, supportsImportExport: true, connectionFields: INFLUXDB_FIELDS },
    kafka: { engine: 'kafka', label: 'Apache Kafka', family: 'specialized', group: 'Specialized', driverFamily: 'kafka', defaultPort: 9092, queryLanguage: 'kafka-cli', monacoLanguage: 'plaintext', supportsSchema: true, supportsPreview: true, supportsUpdate: false, supportsImportExport: false, connectionFields: KAFKA_FIELDS },
};
/** Engines grouped by their UI group label, in display order */
function getEngineGroups() {
    const groups = new Map();
    const order = ['SQL', 'NoSQL', 'Multi-Model', 'Vector', 'Cache', 'Specialized'];
    for (const def of Object.values(exports.ENGINE_REGISTRY)) {
        const list = groups.get(def.group) || [];
        list.push(def);
        groups.set(def.group, list);
    }
    return order
        .filter((g) => groups.has(g))
        .map((g) => ({ group: g, engines: groups.get(g) }));
}
