"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RemoteAuditLog = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
/**
 * Ring-buffer audit log for remote control events.
 *
 * Keeps the last 1000 entries in memory and persists to a JSONL file
 * at ~/.1devtool/remote-audit.jsonl for post-incident review.
 */
class RemoteAuditLog {
    entries = [];
    filePath;
    MAX_ENTRIES = 1000;
    writeStream = null;
    constructor() {
        const userDataDir = this.getAuditDir();
        this.filePath = path_1.default.join(userDataDir, 'remote-audit.jsonl');
        // Ensure directory exists
        try {
            fs_1.default.mkdirSync(userDataDir, { recursive: true });
        }
        catch {
            // Directory may already exist
        }
        // Load existing entries from file (up to MAX_ENTRIES most recent)
        this.loadExisting();
        // Open write stream in append mode
        try {
            this.writeStream = fs_1.default.createWriteStream(this.filePath, { flags: 'a' });
        }
        catch {
            // If we can't open the file, audit still works in-memory
            this.writeStream = null;
        }
    }
    /**
     * Log an audit entry. Appends to in-memory ring buffer and to the JSONL file.
     */
    log(entry) {
        // Add to in-memory ring buffer
        this.entries.push(entry);
        if (this.entries.length > this.MAX_ENTRIES) {
            this.entries.shift();
        }
        // Append to file
        if (this.writeStream && !this.writeStream.destroyed) {
            try {
                this.writeStream.write(JSON.stringify(entry) + '\n');
            }
            catch {
                // File write failure is non-fatal
            }
        }
    }
    /**
     * Get the most recent audit entries.
     */
    getRecent(limit = 100) {
        const start = Math.max(0, this.entries.length - limit);
        return this.entries.slice(start);
    }
    /**
     * Close the write stream. Called during server shutdown.
     */
    close() {
        if (this.writeStream && !this.writeStream.destroyed) {
            this.writeStream.end();
            this.writeStream = null;
        }
    }
    /**
     * Get the directory for audit log storage.
     * Uses the Electron userData path, falling back to ~/.1devtool.
     */
    getAuditDir() {
        try {
            return electron_1.app.getPath('userData');
        }
        catch {
            // app may not be ready yet during testing
            return path_1.default.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.1devtool');
        }
    }
    /**
     * Load existing entries from the JSONL audit file into memory.
     * Only keeps the most recent MAX_ENTRIES to bound memory usage.
     */
    loadExisting() {
        try {
            if (!fs_1.default.existsSync(this.filePath)) {
                return;
            }
            const content = fs_1.default.readFileSync(this.filePath, 'utf-8');
            const lines = content.split('\n').filter((line) => line.trim().length > 0);
            // Take only the last MAX_ENTRIES lines
            const recentLines = lines.slice(-this.MAX_ENTRIES);
            for (const line of recentLines) {
                try {
                    const entry = JSON.parse(line);
                    this.entries.push(entry);
                }
                catch {
                    // Skip malformed lines
                }
            }
        }
        catch {
            // File read failure is non-fatal; start with empty log
        }
    }
}
exports.RemoteAuditLog = RemoteAuditLog;
