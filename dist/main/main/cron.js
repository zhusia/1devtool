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
exports.CronManager = void 0;
const child_process_1 = require("child_process");
const util_1 = require("util");
const fs = __importStar(require("fs"));
const cron_1 = require("../shared/cron");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const WINDOWS_ERROR = 'Cron is not available on Windows — use Task Scheduler instead.';
const LOG_WINDOW_HOURS = 6;
const MAX_LOG_LINES = 500;
class CronManager {
    async list() {
        if (process.platform === 'win32') {
            return { available: false, error: WINDOWS_ERROR, jobs: [] };
        }
        try {
            const content = await this.readCrontab();
            const jobs = [];
            content.split('\n').forEach((raw, index) => {
                const trimmed = raw.trim();
                if (!trimmed)
                    return;
                if (trimmed.startsWith('#')) {
                    // A commented-out line that still parses as a job is a disabled
                    // job (the same convention `crontab -e` users follow by hand).
                    const parsed = (0, cron_1.parseCronJobLine)(trimmed.replace(/^#+\s*/, ''));
                    if (parsed)
                        jobs.push({ line: index, raw, ...parsed, enabled: false });
                    return;
                }
                const parsed = (0, cron_1.parseCronJobLine)(trimmed);
                if (parsed)
                    jobs.push({ line: index, raw, ...parsed, enabled: true });
            });
            return { available: true, jobs };
        }
        catch (error) {
            if (error?.code === 'ENOENT') {
                return { available: false, error: 'The crontab command was not found on this system.', jobs: [] };
            }
            return {
                available: false,
                error: error instanceof Error ? error.message : 'Failed to read crontab',
                jobs: [],
            };
        }
    }
    async add(schedule, command) {
        const invalid = (0, cron_1.validateCronSchedule)(schedule) || (0, cron_1.validateCronCommand)(command);
        if (invalid)
            return { ok: false, error: invalid };
        return this.mutate((lines) => {
            // Drop a single trailing empty line (from the file's final newline) so
            // the new job appends directly after the last real line.
            if (lines.length > 0 && lines[lines.length - 1] === '')
                lines.pop();
            lines.push(`${schedule.trim()} ${command.trim()}`);
        });
    }
    async update(line, expectedRaw, schedule, command) {
        const invalid = (0, cron_1.validateCronSchedule)(schedule) || (0, cron_1.validateCronCommand)(command);
        if (invalid)
            return { ok: false, error: invalid };
        return this.mutateVerifiedLine(line, expectedRaw, (lines) => {
            const wasDisabled = lines[line].trim().startsWith('#');
            const job = `${schedule.trim()} ${command.trim()}`;
            lines[line] = wasDisabled ? `# ${job}` : job;
        });
    }
    async remove(line, expectedRaw) {
        return this.mutateVerifiedLine(line, expectedRaw, (lines) => {
            lines.splice(line, 1);
        });
    }
    async setEnabled(line, expectedRaw, enabled) {
        return this.mutateVerifiedLine(line, expectedRaw, (lines) => {
            const trimmed = lines[line].trim();
            if (enabled) {
                lines[line] = trimmed.replace(/^#+\s*/, '');
            }
            else if (!trimmed.startsWith('#')) {
                lines[line] = `# ${trimmed}`;
            }
        });
    }
    // Recent cron execution activity from the system's own log. Cron doesn't
    // keep job output here (that's mailed to the user); these lines show when
    // each job ran, which is what "did my schedule fire?" needs.
    async logs() {
        if (process.platform === 'win32') {
            return { available: false, error: WINDOWS_ERROR, lines: [] };
        }
        if (process.platform === 'darwin') {
            return this.darwinLogs();
        }
        return this.linuxLogs();
    }
    async darwinLogs() {
        try {
            const { stdout } = await execFileAsync('log', [
                'show',
                '--predicate', 'process == "cron"',
                '--style', 'syslog',
                '--info',
                '--last', `${LOG_WINDOW_HOURS}h`,
            ], { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
            // System-library chatter cron's fork emits around every job (user
            // lookups, XPC, analytics) — 3+ lines per run that bury the real
            // `(user) CMD (command)` execution lines.
            const noise = /cron\[\d+\]: \((?:lib[^)]*\.dylib|CoreAnalytics)\)/;
            const lines = stdout
                .split('\n')
                .filter((line) => {
                const trimmed = line.trim();
                if (!trimmed)
                    return false;
                // `log show` prints a filter banner and a column-header row.
                if (trimmed.startsWith('Filtering the log data'))
                    return false;
                if (trimmed.startsWith('Timestamp '))
                    return false;
                return !noise.test(line);
            });
            return {
                available: true,
                source: `macOS unified log — last ${LOG_WINDOW_HOURS} hours`,
                lines: lines.slice(-MAX_LOG_LINES),
            };
        }
        catch (error) {
            return {
                available: false,
                error: error instanceof Error ? error.message : 'Failed to read the system log',
                lines: [],
            };
        }
    }
    async linuxLogs() {
        // journalctl first (systemd distros), then the classic log files.
        try {
            const { stdout } = await execFileAsync('journalctl', ['-t', 'CRON', '-t', 'cron', '-t', 'crond', '-o', 'short-iso', '--no-pager', '-q', '-n', String(MAX_LOG_LINES)], { maxBuffer: 8 * 1024 * 1024, timeout: 15_000 });
            const lines = stdout.split('\n').filter((line) => line.trim());
            if (lines.length > 0) {
                return { available: true, source: 'journalctl (CRON)', lines };
            }
        }
        catch {
            // Fall through to the plain log files.
        }
        for (const file of ['/var/log/cron', '/var/log/syslog']) {
            try {
                if (!fs.existsSync(file))
                    continue;
                const { stdout } = await execFileAsync('tail', ['-n', '2000', file], {
                    maxBuffer: 8 * 1024 * 1024,
                    timeout: 15_000,
                });
                const lines = stdout
                    .split('\n')
                    .filter((line) => /\b(cron|crond|CRON)\b/.test(line))
                    .slice(-MAX_LOG_LINES);
                return { available: true, source: file, lines };
            }
            catch {
                continue;
            }
        }
        return {
            available: false,
            error: 'No readable cron log found — journalctl returned nothing (you may need to be in the systemd-journal group) and /var/log/cron / /var/log/syslog are missing or unreadable.',
            lines: [],
        };
    }
    // Read-modify-write with the target line verified against what the
    // renderer last saw — a crontab changed underneath us aborts the write.
    async mutateVerifiedLine(line, expectedRaw, apply) {
        return this.mutate((lines) => {
            if (line < 0 || line >= lines.length || lines[line] !== expectedRaw) {
                throw new Error('The crontab changed outside 1DevTool — refresh the list and try again.');
            }
            apply(lines);
        });
    }
    async mutate(apply) {
        if (process.platform === 'win32') {
            return { ok: false, error: WINDOWS_ERROR };
        }
        try {
            const lines = (await this.readCrontab()).split('\n');
            apply(lines);
            await this.writeCrontab(lines.join('\n'));
            return { ok: true };
        }
        catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : 'Failed to update crontab',
            };
        }
    }
    async readCrontab() {
        try {
            const { stdout } = await execFileAsync('crontab', ['-l'], { maxBuffer: 4 * 1024 * 1024 });
            return stdout;
        }
        catch (error) {
            // `crontab -l` exits 1 with "no crontab for <user>" when the user has
            // never had one — that's an empty crontab, not a failure.
            const err = error;
            const text = `${err?.stderr ?? ''} ${err?.message ?? ''}`;
            if (/no crontab for/i.test(text))
                return '';
            throw error;
        }
    }
    writeCrontab(content) {
        // cron requires the file to end with a newline; a missing one makes some
        // implementations reject the whole crontab.
        const body = content === '' || content.endsWith('\n') ? content : `${content}\n`;
        return new Promise((resolve, reject) => {
            const child = (0, child_process_1.spawn)('crontab', ['-'], { stdio: ['pipe', 'ignore', 'pipe'] });
            let stderr = '';
            child.stderr?.on('data', (chunk) => {
                stderr += String(chunk);
            });
            child.on('error', reject);
            child.on('close', (code) => {
                if (code === 0)
                    resolve();
                else
                    reject(new Error(stderr.trim() || `crontab exited with code ${code}`));
            });
            child.stdin.end(body);
        });
    }
}
exports.CronManager = CronManager;
