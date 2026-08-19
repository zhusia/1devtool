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
exports.KafkaAdapter = void 0;
class KafkaAdapter {
    async testConnection(conn) {
        const { admin } = await this.createAdmin(conn);
        try {
            await admin.connect();
            await admin.listTopics();
        }
        finally {
            await admin.disconnect().catch(() => undefined);
        }
    }
    async query(conn, text) {
        const trimmed = text.trim();
        const upper = trimmed.toUpperCase();
        if (upper === 'TOPICS' || upper === 'LIST TOPICS') {
            return this.listTopics(conn);
        }
        const describeMatch = trimmed.match(/^DESCRIBE\s+(.+)$/i);
        if (describeMatch) {
            return this.describeTopic(conn, describeMatch[1].trim());
        }
        const consumeMatch = trimmed.match(/^CONSUME\s+(\S+)(?:\s+(\d+))?$/i);
        if (consumeMatch) {
            const topic = consumeMatch[1];
            const count = consumeMatch[2] ? parseInt(consumeMatch[2], 10) : 10;
            return this.consumeMessages(conn, topic, count);
        }
        throw new Error('Unsupported Kafka command. Supported commands:\n' +
            '  TOPICS / LIST TOPICS - List all topics\n' +
            '  DESCRIBE <topic_name> - Show topic metadata\n' +
            '  CONSUME <topic_name> [count] - Consume messages from topic');
    }
    async schema(conn) {
        const { admin } = await this.createAdmin(conn);
        try {
            await admin.connect();
            const topics = await admin.listTopics();
            const metadata = await admin.fetchTopicMetadata({ topics });
            return metadata.topics.map((topic) => {
                const partitions = topic.partitions || [];
                return {
                    schema: 'kafka',
                    name: topic.name,
                    type: 'topic',
                    columns: partitions.map((p) => ({
                        name: `partition-${p.partitionId}`,
                        type: `leader: ${p.leader}, replicas: ${(p.replicas || []).join(',')}`,
                        nullable: false,
                        defaultValue: null,
                    })),
                };
            });
        }
        finally {
            await admin.disconnect().catch(() => undefined);
        }
    }
    async previewTable(conn, _schema, table, options) {
        const safeLimit = Math.min(Math.max(options.limit || 100, 1), 100);
        const results = await this.consumeMessages(conn, table, safeLimit);
        return results[0];
    }
    async updateRow(_conn, _schema, _table, _nextRow, _originalRow, _primaryKeys) {
        throw new Error('Kafka is append-only and does not support row updates');
    }
    async listTopics(conn) {
        const { admin } = await this.createAdmin(conn);
        try {
            await admin.connect();
            const startedAt = Date.now();
            const topics = await admin.listTopics();
            const durationMs = Date.now() - startedAt;
            const rows = topics.map((name, index) => ({
                '#': index + 1,
                topic: name,
            }));
            return [{
                    statement: 'LIST TOPICS',
                    rowCount: rows.length,
                    rows,
                    columns: [
                        { name: '#', type: 'number' },
                        { name: 'topic', type: 'string' },
                    ],
                    durationMs,
                    source: { type: 'query' },
                    resultFormat: 'tabular',
                }];
        }
        finally {
            await admin.disconnect().catch(() => undefined);
        }
    }
    async describeTopic(conn, topicName) {
        const { admin } = await this.createAdmin(conn);
        try {
            await admin.connect();
            const startedAt = Date.now();
            const metadata = await admin.fetchTopicMetadata({ topics: [topicName] });
            const durationMs = Date.now() - startedAt;
            const topic = metadata.topics[0];
            if (!topic) {
                throw new Error(`Topic "${topicName}" not found`);
            }
            const partitions = topic.partitions || [];
            const rows = partitions.map((p) => ({
                partition: p.partitionId,
                leader: p.leader,
                replicas: (p.replicas || []).join(', '),
                isr: (p.isr || []).join(', '),
            }));
            return [{
                    statement: `DESCRIBE ${topicName}`,
                    rowCount: rows.length,
                    rows,
                    columns: [
                        { name: 'partition', type: 'number' },
                        { name: 'leader', type: 'number' },
                        { name: 'replicas', type: 'string' },
                        { name: 'isr', type: 'string' },
                    ],
                    durationMs,
                    source: { type: 'query' },
                    resultFormat: 'tabular',
                }];
        }
        finally {
            await admin.disconnect().catch(() => undefined);
        }
    }
    async consumeMessages(conn, topic, count) {
        const { kafka } = await this.createKafka(conn);
        const groupId = `1devtool-preview-${Date.now()}`;
        const consumer = kafka.consumer({ groupId });
        const messages = [];
        try {
            await consumer.connect();
            await consumer.subscribe({ topic, fromBeginning: true });
            const startedAt = Date.now();
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => resolve(), 10000);
                consumer.run({
                    eachMessage: async ({ partition, message }) => {
                        messages.push({
                            partition,
                            offset: Number(message.offset),
                            key: message.key ? message.key.toString() : null,
                            value: message.value ? message.value.toString() : null,
                            timestamp: message.timestamp || null,
                        });
                        if (messages.length >= count) {
                            clearTimeout(timeout);
                            resolve();
                        }
                    },
                }).catch(reject);
            });
            const durationMs = Date.now() - startedAt;
            return [{
                    statement: `CONSUME ${topic} ${count}`,
                    rowCount: messages.length,
                    rows: messages,
                    columns: [
                        { name: 'partition', type: 'number' },
                        { name: 'offset', type: 'number' },
                        { name: 'key', type: 'string' },
                        { name: 'value', type: 'string' },
                        { name: 'timestamp', type: 'string' },
                    ],
                    durationMs,
                    source: { type: 'table', schema: 'kafka', table: topic },
                    resultFormat: 'raw',
                }];
        }
        finally {
            await consumer.disconnect().catch(() => undefined);
        }
    }
    async createKafka(conn) {
        const { Kafka } = await Promise.resolve().then(() => __importStar(require('kafkajs')));
        const brokers = (conn.kafkaBrokers || `${conn.host}:${conn.port}`)
            .split(',')
            .map((b) => b.trim())
            .filter(Boolean);
        const config = {
            clientId: '1devtool',
            brokers,
        };
        if (conn.user && conn.password) {
            config.sasl = {
                mechanism: 'plain',
                username: conn.user,
                password: conn.password,
            };
        }
        if (conn.ssl) {
            config.ssl = true;
        }
        const kafka = new Kafka(config);
        return { kafka };
    }
    async createAdmin(conn) {
        const { kafka } = await this.createKafka(conn);
        const admin = kafka.admin();
        return { admin, kafka };
    }
}
exports.KafkaAdapter = KafkaAdapter;
