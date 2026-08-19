"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.exportTableData = exportTableData;
async function exportTableData(manager, options) {
    const { connection, schema, table, format, limit = 10000, onProgress } = options;
    // Fetch data
    onProgress?.(10);
    const result = await manager.previewTable(connection, schema, table, '', limit);
    onProgress?.(60);
    // Convert to format
    let output;
    switch (format) {
        case 'csv':
            output = resultToCsv(result);
            break;
        case 'json':
            output = JSON.stringify(result.rows, null, 2);
            break;
        case 'ndjson':
            output = result.rows.map((row) => JSON.stringify(row)).join('\n');
            break;
        default:
            throw new Error(`Unsupported export format: ${format}`);
    }
    onProgress?.(100);
    return output;
}
function resultToCsv(result) {
    if (result.columns.length === 0)
        return '';
    const header = result.columns.map((c) => escapeCsv(c.name)).join(',');
    const rows = result.rows.map((row) => result.columns.map((c) => {
        const val = row[c.name];
        if (val === null || val === undefined)
            return '';
        return escapeCsv(String(val));
    }).join(','));
    return [header, ...rows].join('\n');
}
function escapeCsv(value) {
    if (/[",\n\r]/.test(value)) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}
