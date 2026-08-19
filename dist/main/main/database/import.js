"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.importTableData = importTableData;
async function importTableData(manager, options) {
    const { connection, schema, table, data, format, onProgress } = options;
    onProgress?.(5);
    // Parse data into rows
    let rows;
    switch (format) {
        case 'csv':
            rows = parseCsv(data);
            break;
        case 'json':
            rows = JSON.parse(data);
            if (!Array.isArray(rows))
                throw new Error('JSON data must be an array of objects');
            break;
        case 'ndjson':
            rows = data.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
            break;
        default:
            throw new Error(`Unsupported import format: ${format}`);
    }
    if (rows.length === 0) {
        return { rowsImported: 0 };
    }
    onProgress?.(20);
    // Build and execute INSERT statements in batches
    const columns = Object.keys(rows[0]);
    const batchSize = 100;
    let imported = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const values = batch.map((row) => `(${columns.map((col) => escapeValue(row[col])).join(', ')})`).join(',\n');
        const sql = `INSERT INTO ${schema ? `"${schema}".` : ''}"${table}" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES\n${values}`;
        await manager.query(connection, sql);
        imported += batch.length;
        onProgress?.(20 + Math.floor((imported / rows.length) * 80));
    }
    return { rowsImported: imported };
}
function escapeValue(value) {
    if (value === null || value === undefined)
        return 'NULL';
    if (typeof value === 'number')
        return String(value);
    if (typeof value === 'boolean')
        return value ? 'TRUE' : 'FALSE';
    return `'${String(value).replace(/'/g, "''")}'`;
}
function parseCsv(data) {
    const lines = data.split('\n').filter((line) => line.trim());
    if (lines.length < 2)
        return [];
    const headers = parseCsvLine(lines[0]);
    return lines.slice(1).map((line) => {
        const values = parseCsvLine(line);
        const row = {};
        headers.forEach((header, i) => {
            const val = values[i] ?? '';
            if (val === '' || val.toUpperCase() === 'NULL') {
                row[header] = null;
            }
            else if (!isNaN(Number(val)) && val !== '') {
                row[header] = Number(val);
            }
            else {
                row[header] = val;
            }
        });
        return row;
    });
}
function parseCsvLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (inQuotes) {
            if (char === '"') {
                if (i + 1 < line.length && line[i + 1] === '"') {
                    current += '"';
                    i++;
                }
                else {
                    inQuotes = false;
                }
            }
            else {
                current += char;
            }
        }
        else {
            if (char === '"') {
                inQuotes = true;
            }
            else if (char === ',') {
                result.push(current);
                current = '';
            }
            else {
                current += char;
            }
        }
    }
    result.push(current);
    return result;
}
