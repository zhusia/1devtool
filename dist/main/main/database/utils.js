"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.splitSqlStatements = splitSqlStatements;
exports.isReadOnlyStatement = isReadOnlyStatement;
exports.serializeRows = serializeRows;
exports.inferColumnType = inferColumnType;
exports.groupSchemaRows = groupSchemaRows;
exports.qualifyTable = qualifyTable;
exports.escapeIdentifier = escapeIdentifier;
exports.clampLimit = clampLimit;
exports.clampOffset = clampOffset;
exports.normalizeTablePreviewOptions = normalizeTablePreviewOptions;
exports.normalizeSqlFilter = normalizeSqlFilter;
exports.buildOrderClause = buildOrderClause;
exports.joinWhereClauses = joinWhereClauses;
exports.buildGenericUpdate = buildGenericUpdate;
function splitSqlStatements(sql) {
    const statements = [];
    let current = '';
    let quote = null;
    for (let index = 0; index < sql.length; index += 1) {
        const char = sql[index];
        const previous = sql[index - 1];
        if ((char === '\'' || char === '"' || char === '`') && previous !== '\\') {
            if (quote === char) {
                quote = null;
            }
            else if (!quote) {
                quote = char;
            }
        }
        if (char === ';' && !quote) {
            const statement = current.trim();
            if (statement) {
                statements.push(statement);
            }
            current = '';
            continue;
        }
        current += char;
    }
    const trailing = current.trim();
    if (trailing) {
        statements.push(trailing);
    }
    return statements;
}
function isReadOnlyStatement(statement) {
    const normalized = statement.trim().toLowerCase();
    if (!normalized) {
        return true;
    }
    if (normalized.startsWith('with')) {
        return !/\b(insert|update|delete|merge)\b/i.test(normalized);
    }
    if (normalized.startsWith('pragma')) {
        return !/=/.test(normalized);
    }
    return /^(select|show|describe|desc|explain|return|info|let)\b/i.test(normalized);
}
function serializeRows(rows) {
    return rows.map((row) => {
        const nextRow = {};
        for (const [key, value] of Object.entries(row)) {
            if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                nextRow[key] = value;
            }
            else if (value instanceof Date) {
                nextRow[key] = value.toISOString();
            }
            else if (Buffer.isBuffer(value)) {
                nextRow[key] = value.toString('utf-8');
            }
            else {
                nextRow[key] = JSON.stringify(value);
            }
        }
        return nextRow;
    });
}
function inferColumnType(columnName, rows) {
    const sample = rows.find((row) => row[columnName] !== null && row[columnName] !== undefined);
    if (!sample) {
        return 'unknown';
    }
    const value = sample[columnName];
    if (value instanceof Date) {
        return 'datetime';
    }
    if (Buffer.isBuffer(value)) {
        return 'binary';
    }
    return typeof value;
}
function groupSchemaRows(rows) {
    const grouped = new Map();
    for (const row of rows) {
        const key = `${row.schema}:${row.table}:${row.type}`;
        const existing = grouped.get(key) || {
            schema: row.schema,
            name: row.table,
            type: row.type,
            columns: [],
        };
        existing.columns.push({
            name: row.column,
            type: row.dataType,
            nullable: row.nullable,
            defaultValue: row.defaultValue,
            primaryKey: row.primaryKey,
        });
        grouped.set(key, existing);
    }
    return [...grouped.values()];
}
function qualifyTable(family, schema, table) {
    if (!schema) {
        return escapeIdentifier(family, table);
    }
    return `${escapeIdentifier(family, schema)}.${escapeIdentifier(family, table)}`;
}
function escapeIdentifier(family, identifier) {
    switch (family) {
        case 'mysql':
            return `\`${identifier.replace(/`/g, '``')}\``;
        case 'mssql':
            return `[${identifier.replace(/\]/g, ']]')}]`;
        case 'clickhouse':
        case 'postgres':
        case 'cassandra':
        case 'surrealdb':
        default:
            return `"${identifier.replace(/"/g, '""')}"`;
    }
}
function clampLimit(limit) {
    return Math.max(1, Math.min(500, Math.floor(limit || 100)));
}
function clampOffset(offset) {
    return Math.max(0, Math.floor(offset || 0));
}
function normalizeTablePreviewOptions(optionsOrFilter, legacyLimit) {
    if (typeof optionsOrFilter === 'string') {
        return {
            search: optionsOrFilter,
            filter: '',
            limit: clampLimit(legacyLimit || 100),
            offset: 0,
            sortColumn: '',
            sortDirection: 'asc',
        };
    }
    const options = optionsOrFilter || {};
    return {
        search: options.search?.trim() || '',
        filter: normalizeSqlFilter(options.filter || ''),
        limit: clampLimit(options.limit || legacyLimit || 100),
        offset: clampOffset(options.offset),
        sortColumn: options.sortColumn || '',
        sortDirection: options.sortDirection === 'desc' ? 'desc' : 'asc',
    };
}
function normalizeSqlFilter(filter) {
    const trimmed = filter.trim().replace(/;+\s*$/, '');
    return trimmed.replace(/^where\s+/i, '').trim();
}
function buildOrderClause(family, columns, sortColumn, sortDirection) {
    if (!sortColumn)
        return '';
    const column = columns.find((candidate) => candidate.name === sortColumn);
    if (!column)
        return '';
    return ` order by ${escapeIdentifier(family, column.name)} ${sortDirection === 'desc' ? 'desc' : 'asc'}`;
}
function joinWhereClauses(clauses) {
    const normalized = clauses.map((clause) => clause.trim()).filter(Boolean);
    if (normalized.length === 0)
        return '';
    return ` where ${normalized.map((clause) => `(${clause})`).join(' and ')}`;
}
function buildGenericUpdate(family, schema, table, changedColumns, whereColumns, nextRow, originalRow, paramStyle) {
    const values = [];
    const paramRef = (index) => {
        switch (paramStyle) {
            case 'dollar': return `$${index}`;
            case 'at': return `@p${index}`;
            case 'question':
            default: return '?';
        }
    };
    const setClauses = changedColumns.map((columnName) => {
        values.push(nextRow[columnName]);
        return `${escapeIdentifier(family, columnName)} = ${paramRef(values.length)}`;
    });
    const whereClauses = whereColumns.map((columnName) => {
        const value = originalRow[columnName];
        if (value === null) {
            return `${escapeIdentifier(family, columnName)} is null`;
        }
        values.push(value);
        return `${escapeIdentifier(family, columnName)} = ${paramRef(values.length)}`;
    });
    return {
        sql: `update ${qualifyTable(family, schema, table)} set ${setClauses.join(', ')} where ${whereClauses.join(' and ')}`,
        values,
    };
}
