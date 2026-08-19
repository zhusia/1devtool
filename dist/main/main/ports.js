"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortManager = void 0;
const child_process_1 = require("child_process");
const util_1 = require("util");
const execAsync = (0, util_1.promisify)(child_process_1.exec);
class PortManager {
    async listPorts() {
        const platform = process.platform;
        if (platform === 'darwin' || platform === 'linux') {
            return this.listPortsUnix();
        }
        else if (platform === 'win32') {
            return this.listPortsWindows();
        }
        return [];
    }
    async listPortsUnix() {
        const ports = [];
        try {
            // Use lsof to get listening ports with process info
            const { stdout } = await execAsync('lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null || true', { maxBuffer: 10 * 1024 * 1024 });
            const lines = stdout.trim().split('\n');
            if (lines.length <= 1)
                return ports;
            // Skip header line
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i];
                const parts = line.split(/\s+/);
                if (parts.length < 9)
                    continue;
                const processName = parts[0];
                const pid = parseInt(parts[1], 10);
                const user = parts[2];
                const name = parts[8]; // e.g., "*:3000" or "127.0.0.1:8080"
                // Extract port from name
                const portMatch = name.match(/:(\d+)$/);
                if (!portMatch)
                    continue;
                const port = parseInt(portMatch[1], 10);
                // Get full command path
                const command = await this.getCommandPath(pid);
                ports.push({
                    port,
                    pid,
                    process: processName,
                    command,
                    user,
                    protocol: 'tcp',
                    state: 'LISTEN',
                });
            }
            // Deduplicate by port (same process may listen on multiple interfaces)
            const seen = new Map();
            for (const p of ports) {
                if (!seen.has(p.port)) {
                    seen.set(p.port, p);
                }
            }
            return Array.from(seen.values()).sort((a, b) => a.port - b.port);
        }
        catch {
            return ports;
        }
    }
    async listPortsWindows() {
        const ports = [];
        try {
            // Use netstat on Windows
            const { stdout } = await execAsync('netstat -ano -p TCP | findstr LISTENING', { maxBuffer: 10 * 1024 * 1024 });
            const lines = stdout.trim().split('\n');
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                if (parts.length < 5)
                    continue;
                const localAddress = parts[1];
                const pid = parseInt(parts[4], 10);
                // Extract port from address (e.g., "0.0.0.0:3000")
                const portMatch = localAddress.match(/:(\d+)$/);
                if (!portMatch)
                    continue;
                const port = parseInt(portMatch[1], 10);
                // Get process name
                const processInfo = await this.getWindowsProcessInfo(pid);
                ports.push({
                    port,
                    pid,
                    process: processInfo.name,
                    command: processInfo.path,
                    user: '',
                    protocol: 'tcp',
                    state: 'LISTENING',
                });
            }
            // Deduplicate by port
            const seen = new Map();
            for (const p of ports) {
                if (!seen.has(p.port)) {
                    seen.set(p.port, p);
                }
            }
            return Array.from(seen.values()).sort((a, b) => a.port - b.port);
        }
        catch {
            return ports;
        }
    }
    async getCommandPath(pid) {
        try {
            if (process.platform === 'darwin') {
                const { stdout } = await execAsync(`ps -p ${pid} -o command= 2>/dev/null || true`);
                return stdout.trim() || 'Unknown';
            }
            else if (process.platform === 'linux') {
                const { stdout } = await execAsync(`readlink -f /proc/${pid}/exe 2>/dev/null || ps -p ${pid} -o command= 2>/dev/null || true`);
                return stdout.trim() || 'Unknown';
            }
        }
        catch {
            // Ignore errors
        }
        return 'Unknown';
    }
    async getWindowsProcessInfo(pid) {
        try {
            const { stdout } = await execAsync(`wmic process where ProcessId=${pid} get Name,ExecutablePath /format:csv 2>nul`, { maxBuffer: 1024 * 1024 });
            const lines = stdout.trim().split('\n');
            if (lines.length >= 2) {
                const parts = lines[1].split(',');
                if (parts.length >= 3) {
                    return {
                        path: parts[1] || 'Unknown',
                        name: parts[2] || 'Unknown',
                    };
                }
            }
        }
        catch {
            // Ignore errors
        }
        return { name: 'Unknown', path: 'Unknown' };
    }
    async getProcessDetail(pid) {
        if (process.platform === 'win32') {
            return this.getProcessDetailWindows(pid);
        }
        return this.getProcessDetailUnix(pid);
    }
    async getProcessDetailUnix(pid) {
        const detail = { pid, command: '' };
        try {
            // ps fields: ppid, user, %cpu, %mem, rss (KB), lstart, state, command
            const { stdout } = await execAsync(`ps -p ${pid} -o ppid=,user=,%cpu=,%mem=,rss=,lstart=,state=,command= 2>/dev/null || true`, { maxBuffer: 1024 * 1024 });
            const line = stdout.trim();
            if (!line) {
                detail.error = `Process ${pid} not found (it may have exited)`;
                return detail;
            }
            // lstart is 5 whitespace-separated tokens (e.g. "Tue May 20 10:23:45 2026").
            // Parse from the left for fixed-count fields, then split lstart by token count.
            const parts = line.split(/\s+/);
            if (parts.length < 12) {
                detail.error = 'Failed to parse process info';
                return detail;
            }
            detail.ppid = parseInt(parts[0], 10);
            detail.user = parts[1];
            detail.cpuPercent = parseFloat(parts[2]);
            detail.memoryPercent = parseFloat(parts[3]);
            const rssKb = parseInt(parts[4], 10);
            if (!isNaN(rssKb))
                detail.rssBytes = rssKb * 1024;
            detail.startedAt = parts.slice(5, 10).join(' ');
            detail.state = parts[10];
            detail.command = parts.slice(11).join(' ');
            // Working directory via lsof (macOS) or /proc (Linux)
            if (process.platform === 'darwin') {
                try {
                    const { stdout: cwdOut } = await execAsync(`lsof -p ${pid} -a -d cwd -Fn 2>/dev/null | grep '^n' | head -1 || true`, { maxBuffer: 1024 * 1024 });
                    const cwd = cwdOut.trim().replace(/^n/, '');
                    if (cwd)
                        detail.workingDirectory = cwd;
                }
                catch {
                    // ignore
                }
            }
            else if (process.platform === 'linux') {
                try {
                    const { stdout: cwdOut } = await execAsync(`readlink -f /proc/${pid}/cwd 2>/dev/null || true`);
                    const cwd = cwdOut.trim();
                    if (cwd)
                        detail.workingDirectory = cwd;
                }
                catch {
                    // ignore
                }
            }
            return detail;
        }
        catch (err) {
            detail.error = err instanceof Error ? err.message : 'Failed to read process detail';
            return detail;
        }
    }
    async getProcessDetailWindows(pid) {
        const detail = { pid, command: '' };
        try {
            const { stdout } = await execAsync(`wmic process where ProcessId=${pid} get ParentProcessId,CommandLine,ExecutablePath,WorkingSetSize,ThreadCount,CreationDate /format:list 2>nul`, { maxBuffer: 1024 * 1024 });
            const fields = {};
            for (const raw of stdout.split('\n')) {
                const line = raw.trim();
                const eq = line.indexOf('=');
                if (eq <= 0)
                    continue;
                fields[line.slice(0, eq)] = line.slice(eq + 1);
            }
            if (!Object.keys(fields).length) {
                detail.error = `Process ${pid} not found`;
                return detail;
            }
            detail.ppid = fields.ParentProcessId ? parseInt(fields.ParentProcessId, 10) : undefined;
            detail.command = fields.CommandLine || fields.ExecutablePath || '';
            const rss = parseInt(fields.WorkingSetSize, 10);
            if (!isNaN(rss))
                detail.rssBytes = rss;
            const threads = parseInt(fields.ThreadCount, 10);
            if (!isNaN(threads))
                detail.threads = threads;
            // CreationDate format: yyyymmddHHMMSS.ffffff+UUU
            if (fields.CreationDate && fields.CreationDate.length >= 14) {
                const d = fields.CreationDate;
                detail.startedAt = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${d.slice(8, 10)}:${d.slice(10, 12)}:${d.slice(12, 14)}`;
            }
            return detail;
        }
        catch (err) {
            detail.error = err instanceof Error ? err.message : 'Failed to read process detail';
            return detail;
        }
    }
    async killProcess(pid) {
        try {
            if (process.platform === 'win32') {
                await execAsync(`taskkill /PID ${pid} /F`);
            }
            else {
                await execAsync(`kill -9 ${pid}`);
            }
            return { ok: true };
        }
        catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : 'Failed to kill process',
            };
        }
    }
}
exports.PortManager = PortManager;
