"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PromptHistoryManager = void 0;
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const agentIdentity_1 = require("../shared/agentIdentity");
class PromptHistoryManager {
    db = null;
    getDb() {
        if (!this.db) {
            const dbPath = path_1.default.join(electron_1.app.getPath('userData'), 'prompt-history.db');
            this.db = new better_sqlite3_1.default(dbPath);
            this.db.pragma('journal_mode = WAL');
            this.db.exec(`
        CREATE TABLE IF NOT EXISTS prompts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL,
          project_name TEXT NOT NULL,
          terminal_id TEXT NOT NULL,
          agent_type TEXT NOT NULL,
          prompt_text TEXT NOT NULL,
          source_key TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
            this.ensureColumn('prompts', 'source_key', 'TEXT');
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_prompts_created_at ON prompts(created_at)`);
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_prompts_project_id ON prompts(project_id)`);
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_prompts_agent_type ON prompts(agent_type)`);
            // Needed so dashboard's per-terminal "latest prompt" lookup is O(log n)
            // instead of a full table scan. The (terminal_id, id) composite means
            // SQLite can satisfy `MAX(id) WHERE terminal_id = ?` from the index alone.
            this.db.exec(`CREATE INDEX IF NOT EXISTS idx_prompts_terminal_id ON prompts(terminal_id, id)`);
            this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_prompts_source_key ON prompts(source_key) WHERE source_key IS NOT NULL`);
            // Older Antigravity prompts were stored under the runtime-kind name,
            // while Startup Commands and AGENT_CONFIG use `agy`.
            const storedAgents = this.db.prepare(`SELECT DISTINCT agent_type FROM prompts`).all();
            const normalizeStoredAgent = this.db.prepare(`UPDATE prompts SET agent_type = ? WHERE agent_type = ?`);
            const normalizeTransaction = this.db.transaction(() => {
                for (const { agent_type } of storedAgents) {
                    const normalized = (0, agentIdentity_1.normalizeAgentId)(agent_type);
                    if (normalized && normalized !== agent_type)
                        normalizeStoredAgent.run(normalized, agent_type);
                }
            });
            normalizeTransaction();
        }
        return this.db;
    }
    ensureColumn(tableName, columnName, columnDefinition) {
        const db = this.db;
        if (!db)
            return;
        const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
        if (!columns.some((column) => column.name === columnName)) {
            db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
        }
    }
    save(params) {
        const db = this.getDb();
        const stmt = db.prepare(`INSERT INTO prompts (project_id, project_name, terminal_id, agent_type, prompt_text)
       VALUES (?, ?, ?, ?, ?)`);
        stmt.run(params.projectId, params.projectName, params.terminalId, (0, agentIdentity_1.normalizeAgentId)(params.agentType) || 'custom', params.promptText);
    }
    search(params) {
        const db = this.getDb();
        const conditions = [];
        const values = [];
        if (params.query) {
            conditions.push(`prompt_text LIKE ?`);
            values.push(`%${params.query}%`);
        }
        if (params.projectId) {
            conditions.push(`project_id = ?`);
            values.push(params.projectId);
        }
        if (params.agentType) {
            conditions.push(`agent_type = ?`);
            values.push((0, agentIdentity_1.normalizeAgentId)(params.agentType));
        }
        if (params.dateFrom) {
            conditions.push(`created_at >= ?`);
            values.push(params.dateFrom);
        }
        if (params.dateTo) {
            conditions.push(`created_at <= ?`);
            values.push(params.dateTo);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const limit = params.limit || 50;
        const offset = params.offset || 0;
        const countRow = db.prepare(`SELECT COUNT(*) as total FROM prompts ${where}`).get(...values);
        const rows = db.prepare(`SELECT * FROM prompts ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...values, limit, offset);
        return { prompts: rows, total: countRow.total };
    }
    delete(id) {
        const db = this.getDb();
        db.prepare(`DELETE FROM prompts WHERE id = ?`).run(id);
    }
    importLocalPrompts(records, scanStats) {
        const db = this.getDb();
        const stmt = db.prepare(`INSERT OR IGNORE INTO prompts (
        project_id,
        project_name,
        terminal_id,
        agent_type,
        prompt_text,
        source_key,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`);
        const transaction = db.transaction((items) => {
            let imported = 0;
            const importedByAgent = {};
            for (const record of items) {
                const agentType = (0, agentIdentity_1.normalizeAgentId)(record.agentType);
                const result = stmt.run(record.projectId, record.projectName, record.terminalId, agentType, record.promptText, record.sourceKey, record.createdAt);
                imported += result.changes;
                if (result.changes > 0) {
                    importedByAgent[agentType] = (importedByAgent[agentType] || 0) + result.changes;
                }
            }
            return { imported, importedByAgent };
        });
        const { imported, importedByAgent } = transaction(records);
        const agents = {};
        for (const [agentType, stats] of Object.entries(scanStats.agents)) {
            const typedAgent = agentType;
            agents[typedAgent] = {
                sessions: stats.sessions,
                prompts: stats.prompts,
                imported: importedByAgent[typedAgent] || 0,
            };
        }
        return {
            scannedSessions: scanStats.scannedSessions,
            scannedPrompts: records.length,
            imported,
            skipped: records.length - imported,
            agents,
        };
    }
    /**
     * Return the most recently saved prompt for each of the given terminals.
     * Used by the dashboard to show "what the user last asked" — much cheaper
     * than scanning each terminal's live PTY buffer, and the text is stable
     * (the user's own prompt) instead of a moving render-frame snapshot.
     *
     * One round-trip for N terminals via `WHERE id IN (SELECT MAX(id)…)`.
     * The composite index on (terminal_id, id) lets SQLite resolve the
     * inner aggregate without touching the table heap.
     */
    getLatestPromptsByTerminals(terminalIds) {
        if (terminalIds.length === 0)
            return {};
        const db = this.getDb();
        const placeholders = terminalIds.map(() => '?').join(',');
        const rows = db.prepare(`SELECT terminal_id, prompt_text, created_at
       FROM prompts
       WHERE id IN (
         SELECT MAX(id) FROM prompts
         WHERE terminal_id IN (${placeholders})
         GROUP BY terminal_id
       )`).all(...terminalIds);
        const result = {};
        for (const row of rows) {
            result[row.terminal_id] = { promptText: row.prompt_text, createdAt: row.created_at };
        }
        return result;
    }
    getDistinctProjects() {
        const db = this.getDb();
        return db.prepare(`SELECT DISTINCT project_id as id, project_name as name FROM prompts ORDER BY project_name`).all();
    }
    getDistinctAgents() {
        const db = this.getDb();
        const rows = db.prepare(`SELECT DISTINCT agent_type FROM prompts ORDER BY agent_type`).all();
        return [...new Set(rows.map((row) => (0, agentIdentity_1.normalizeAgentId)(row.agent_type)).filter(Boolean))];
    }
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}
exports.PromptHistoryManager = PromptHistoryManager;
