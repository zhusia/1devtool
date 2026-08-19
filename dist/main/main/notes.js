"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotesManager = void 0;
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const DEFAULT_COLOR = '#93C5FD';
const DEFAULT_FONT_SIZE = 13;
const DEFAULT_FONT_FAMILY = '"Caveat", "Comic Sans MS", system-ui, sans-serif';
class NotesManager {
    db = null;
    getDb() {
        if (!this.db) {
            const dbPath = path_1.default.join(electron_1.app.getPath('userData'), 'sticky-notes.db');
            this.db = new better_sqlite3_1.default(dbPath);
            this.db.pragma('journal_mode = WAL');
            this.db.exec(`
        CREATE TABLE IF NOT EXISTS sticky_notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL,
          project_name TEXT NOT NULL,
          source TEXT NOT NULL,
          file_path TEXT,
          terminal_id TEXT,
          content TEXT NOT NULL DEFAULT '',
          color TEXT NOT NULL DEFAULT '${DEFAULT_COLOR}',
          font_size REAL NOT NULL DEFAULT ${DEFAULT_FONT_SIZE},
          font_family TEXT NOT NULL DEFAULT '${DEFAULT_FONT_FAMILY}',
          pos_x REAL NOT NULL DEFAULT 0,
          pos_y REAL NOT NULL DEFAULT 0,
          width REAL NOT NULL DEFAULT 200,
          height REAL NOT NULL DEFAULT 200,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
            // Migrate older databases that predate note presentation columns
            const cols = this.db.prepare(`PRAGMA table_info(sticky_notes)`).all();
            const hasWidth = cols.some((c) => c.name === 'width');
            const hasHeight = cols.some((c) => c.name === 'height');
            const hasFontSize = cols.some((c) => c.name === 'font_size');
            const hasFontFamily = cols.some((c) => c.name === 'font_family');
            if (!hasFontSize)
                this.db.exec(`ALTER TABLE sticky_notes ADD COLUMN font_size REAL NOT NULL DEFAULT ${DEFAULT_FONT_SIZE}`);
            if (!hasFontFamily)
                this.db.exec(`ALTER TABLE sticky_notes ADD COLUMN font_family TEXT NOT NULL DEFAULT '${DEFAULT_FONT_FAMILY}'`);
            if (!hasWidth)
                this.db.exec(`ALTER TABLE sticky_notes ADD COLUMN width REAL NOT NULL DEFAULT 200`);
            if (!hasHeight)
                this.db.exec(`ALTER TABLE sticky_notes ADD COLUMN height REAL NOT NULL DEFAULT 200`);
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_project_id ON sticky_notes(project_id)`);
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_file_path ON sticky_notes(file_path)`);
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_terminal_id ON sticky_notes(terminal_id)`);
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON sticky_notes(updated_at)`);
        }
        return this.db;
    }
    create(params) {
        const db = this.getDb();
        const stmt = db.prepare(`INSERT INTO sticky_notes (project_id, project_name, source, file_path, terminal_id, content, color, font_size, font_family, pos_x, pos_y, width, height)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const info = stmt.run(params.projectId, params.projectName, params.source, params.filePath ?? null, params.terminalId ?? null, params.content ?? '', params.color ?? DEFAULT_COLOR, params.fontSize ?? DEFAULT_FONT_SIZE, params.fontFamily ?? DEFAULT_FONT_FAMILY, params.posX ?? 0, params.posY ?? 0, params.width ?? 200, params.height ?? 200);
        return db.prepare(`SELECT * FROM sticky_notes WHERE id = ?`).get(info.lastInsertRowid);
    }
    update(params) {
        const db = this.getDb();
        const sets = [];
        const values = [];
        if (params.content !== undefined) {
            sets.push('content = ?');
            values.push(params.content);
        }
        if (params.color !== undefined) {
            sets.push('color = ?');
            values.push(params.color);
        }
        if (params.fontSize !== undefined) {
            sets.push('font_size = ?');
            values.push(params.fontSize);
        }
        if (params.fontFamily !== undefined) {
            sets.push('font_family = ?');
            values.push(params.fontFamily);
        }
        if (params.posX !== undefined) {
            sets.push('pos_x = ?');
            values.push(params.posX);
        }
        if (params.posY !== undefined) {
            sets.push('pos_y = ?');
            values.push(params.posY);
        }
        if (params.width !== undefined) {
            sets.push('width = ?');
            values.push(params.width);
        }
        if (params.height !== undefined) {
            sets.push('height = ?');
            values.push(params.height);
        }
        if (sets.length === 0)
            return;
        sets.push(`updated_at = datetime('now')`);
        values.push(params.id);
        db.prepare(`UPDATE sticky_notes SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    }
    delete(id) {
        const db = this.getDb();
        db.prepare(`DELETE FROM sticky_notes WHERE id = ?`).run(id);
    }
    /** Notes scoped to a single context (project + file or terminal). Used by overlay. */
    listForContext(params) {
        const db = this.getDb();
        const conditions = ['project_id = ?', 'source = ?'];
        const values = [params.projectId, params.source];
        if (params.source === 'manual') {
            // Manual notes hang off the project alone — no file or terminal binding.
        }
        else if (params.source === 'markdown') {
            if (params.filePath) {
                conditions.push('file_path = ?');
                values.push(params.filePath);
            }
            else {
                conditions.push('file_path IS NULL');
            }
        }
        else {
            if (params.terminalId) {
                conditions.push('terminal_id = ?');
                values.push(params.terminalId);
            }
            else {
                conditions.push('terminal_id IS NULL');
            }
        }
        return db
            .prepare(`SELECT * FROM sticky_notes WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`)
            .all(...values);
    }
    search(params) {
        const db = this.getDb();
        const conditions = [];
        const values = [];
        if (params.query) {
            conditions.push(`content LIKE ?`);
            values.push(`%${params.query}%`);
        }
        if (params.projectId) {
            conditions.push(`project_id = ?`);
            values.push(params.projectId);
        }
        if (params.source) {
            conditions.push(`source = ?`);
            values.push(params.source);
        }
        if (params.filePath) {
            conditions.push(`file_path = ?`);
            values.push(params.filePath);
        }
        if (params.terminalId) {
            conditions.push(`terminal_id = ?`);
            values.push(params.terminalId);
        }
        if (params.dateFrom) {
            conditions.push(`updated_at >= ?`);
            values.push(params.dateFrom);
        }
        if (params.dateTo) {
            conditions.push(`updated_at <= ?`);
            values.push(params.dateTo);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const limit = params.limit || 50;
        const offset = params.offset || 0;
        const countRow = db.prepare(`SELECT COUNT(*) as total FROM sticky_notes ${where}`).get(...values);
        const rows = db
            .prepare(`SELECT * FROM sticky_notes ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
            .all(...values, limit, offset);
        return { notes: rows, total: countRow.total };
    }
    getDistinctProjects() {
        const db = this.getDb();
        return db
            .prepare(`SELECT DISTINCT project_id as id, project_name as name FROM sticky_notes ORDER BY project_name`)
            .all();
    }
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}
exports.NotesManager = NotesManager;
