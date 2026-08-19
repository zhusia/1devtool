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
exports.InfluxDBAdapter = void 0;
class InfluxDBAdapter {
    async testConnection(conn) {
        const { queryApi } = await this.createQueryApi(conn);
        try {
            await queryApi.collectRows('buckets()');
        }
        catch (err) {
            throw new Error(`InfluxDB connection failed: ${err.message || err}`);
        }
    }
    async query(conn, text) {
        const { queryApi } = await this.createQueryApi(conn);
        const startedAt = Date.now();
        const rows = await queryApi.collectRows(text);
        const durationMs = Date.now() - startedAt;
        const serializedRows = rows.map((row) => this.serializeRow(row));
        const columns = serializedRows.length > 0
            ? Object.keys(serializedRows[0]).map((name) => ({
                name,
                type: this.inferType(serializedRows[0][name]),
            }))
            : [];
        return [{
                statement: text,
                rowCount: serializedRows.length,
                rows: serializedRows,
                columns,
                durationMs,
                source: { type: 'query' },
                resultFormat: 'tabular',
            }];
    }
    async schema(conn) {
        const { queryApi } = await this.createQueryApi(conn);
        const bucket = conn.influxBucket || conn.database;
        // Get measurements
        const measurementQuery = `import "influxdata/influxdb/schema"\nschema.measurements(bucket: "${this.escapeFluxString(bucket)}")`;
        const measurementRows = await queryApi.collectRows(measurementQuery);
        const tables = [];
        for (const mRow of measurementRows) {
            const measurement = mRow._value || mRow.name || String(mRow);
            const columns = [];
            // Get field keys for this measurement
            try {
                const fieldQuery = `import "influxdata/influxdb/schema"\nschema.measurementFieldKeys(bucket: "${this.escapeFluxString(bucket)}", measurement: "${this.escapeFluxString(measurement)}")`;
                const fieldRows = await queryApi.collectRows(fieldQuery);
                for (const fRow of fieldRows) {
                    columns.push({
                        name: fRow._value || String(fRow),
                        type: 'field',
                        nullable: true,
                        defaultValue: null,
                    });
                }
            }
            catch {
                // field keys unavailable
            }
            // Get tag keys for this measurement
            try {
                const tagQuery = `import "influxdata/influxdb/schema"\nschema.measurementTagKeys(bucket: "${this.escapeFluxString(bucket)}", measurement: "${this.escapeFluxString(measurement)}")`;
                const tagRows = await queryApi.collectRows(tagQuery);
                for (const tRow of tagRows) {
                    const tagName = tRow._value || String(tRow);
                    // Skip internal tag keys
                    if (tagName.startsWith('_'))
                        continue;
                    columns.push({
                        name: tagName,
                        type: 'tag',
                        nullable: true,
                        defaultValue: null,
                    });
                }
            }
            catch {
                // tag keys unavailable
            }
            // Always include the _time column
            columns.unshift({
                name: '_time',
                type: 'timestamp',
                nullable: false,
                defaultValue: null,
            });
            tables.push({
                schema: bucket,
                name: measurement,
                type: 'bucket',
                columns,
            });
        }
        return tables;
    }
    async previewTable(conn, _schema, table, options) {
        const { queryApi } = await this.createQueryApi(conn);
        const bucket = conn.influxBucket || conn.database;
        const safeLimit = Math.min(Math.max((options.limit || 100) + (options.offset || 0), 1), 1000);
        const fluxQuery = `from(bucket: "${this.escapeFluxString(bucket)}") |> range(start: -1h) |> filter(fn: (r) => r._measurement == "${this.escapeFluxString(table)}") |> limit(n: ${safeLimit})`;
        const startedAt = Date.now();
        const rows = await queryApi.collectRows(fluxQuery);
        const durationMs = Date.now() - startedAt;
        const offset = Math.max(0, Math.floor(options.offset || 0));
        const pageLimit = Math.min(Math.max(options.limit || 100, 1), 1000);
        const serializedRows = rows.map((row) => this.serializeRow(row)).slice(offset, offset + pageLimit);
        const columns = serializedRows.length > 0
            ? Object.keys(serializedRows[0]).map((name) => ({
                name,
                type: this.inferType(serializedRows[0][name]),
            }))
            : [];
        return {
            statement: fluxQuery,
            rowCount: offset + serializedRows.length + (serializedRows.length === pageLimit ? 1 : 0),
            rows: serializedRows,
            columns,
            durationMs,
            source: { type: 'table', schema: bucket, table },
            resultFormat: 'tabular',
        };
    }
    async updateRow(_conn, _schema, _table, _nextRow, _originalRow, _primaryKeys) {
        throw new Error('InfluxDB is append-only and does not support row updates');
    }
    async createQueryApi(conn) {
        const { InfluxDB } = await Promise.resolve().then(() => __importStar(require('@influxdata/influxdb-client')));
        const url = `${conn.ssl ? 'https' : 'http'}://${conn.host}:${conn.port}`;
        const token = conn.influxToken || conn.password;
        const org = conn.influxOrg || conn.user || '';
        const influxDB = new InfluxDB({ url, token });
        const queryApi = influxDB.getQueryApi(org);
        return { queryApi };
    }
    serializeRow(row) {
        const result = {};
        if (!row || typeof row !== 'object')
            return result;
        for (const [key, value] of Object.entries(row)) {
            if (value === null || value === undefined) {
                result[key] = null;
            }
            else if (value instanceof Date) {
                result[key] = value.toISOString();
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
        return 'string';
    }
    escapeFluxString(value) {
        return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }
}
exports.InfluxDBAdapter = InfluxDBAdapter;
