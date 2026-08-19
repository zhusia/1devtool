"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSystemMetricsIpcHandlers = registerSystemMetricsIpcHandlers;
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const child_process_1 = require("child_process");
const electron_1 = require("electron");
const systemMetrics_1 = require("../systemMetrics");
function registerSystemMetricsIpcHandlers({ getPtyBackend, ptyBackendReady, sendToRenderer, shouldStopPollingOnBeforeQuit, }) {
    // System metrics — 30s polling, push to renderer only on pressure change.
    //
    // os.freemem() on macOS only counts wholly-unused pages, excluding the file
    // cache / inactive / purgeable / compressed pool the kernel can reclaim on
    // demand. That made a healthy Mac always read 95-98% "used". We now probe
    // the kernel's own accounting: vm_stat on macOS, /proc/meminfo on Linux.
    let lastPressure = 'low';
    let memoryInfoCache = null;
    const NATIVE_MEM_CACHE_TTL_MS = 3000;
    function getNativeMemoryInfo() {
        if (memoryInfoCache && memoryInfoCache.expiresAt > Date.now()) {
            return memoryInfoCache.value;
        }
        let value;
        try {
            if (process.platform === 'darwin')
                value = probeMacMemory();
            else if (process.platform === 'linux')
                value = probeLinuxMemory();
            else
                value = probeFallbackMemory();
        }
        catch {
            value = probeFallbackMemory();
        }
        memoryInfoCache = { value, expiresAt: Date.now() + NATIVE_MEM_CACHE_TTL_MS };
        return value;
    }
    function probeFallbackMemory() {
        const fallback = {
            availableBytes: os_1.default.freemem(),
            swapUsedBytes: 0,
            swapTotalBytes: 0,
        };
        // Electron exposes swap counters on Linux/Windows; macOS returns 0s here
        // and we read sysctl in probeMacMemory() instead.
        try {
            const sys = process.getSystemMemoryInfo();
            if (typeof sys.swapTotal === 'number' && sys.swapTotal > 0) {
                fallback.swapTotalBytes = sys.swapTotal * 1024;
                fallback.swapUsedBytes = Math.max(0, (sys.swapTotal - (sys.swapFree ?? 0)) * 1024);
            }
        }
        catch { /* best-effort */ }
        return fallback;
    }
    function probeMacMemory() {
        const out = (0, child_process_1.execFileSync)('/usr/bin/vm_stat', [], { encoding: 'utf8', timeout: 1500 });
        const pageSizeMatch = out.match(/page size of (\d+) bytes/);
        const pageSize = pageSizeMatch ? parseInt(pageSizeMatch[1], 10) : 4096;
        const pages = (label) => {
            const m = out.match(new RegExp(`^${label}:\\s+(\\d+)\\.?`, 'm'));
            return m ? parseInt(m[1], 10) : 0;
        };
        // Activity Monitor's "Memory Used" = active + wired + compressed_occupied.
        // Everything else (free, inactive, speculative, purgeable, clean file-backed)
        // is reclaimable on demand → counts as available.
        const usedPages = pages('Pages active') +
            pages('Pages wired down') +
            pages('Pages occupied by compressor');
        const totalBytes = os_1.default.totalmem();
        const availableBytes = Math.max(0, totalBytes - usedPages * pageSize);
        let swapUsedBytes = 0;
        let swapTotalBytes = 0;
        try {
            const swap = (0, child_process_1.execFileSync)('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], {
                encoding: 'utf8',
                timeout: 1000,
            });
            // "total = 4096.00M  used = 2048.00M  free = 2048.00M  (encrypted)"
            const totalM = swap.match(/total\s*=\s*([\d.]+)M/i);
            const usedM = swap.match(/used\s*=\s*([\d.]+)M/i);
            if (totalM)
                swapTotalBytes = parseFloat(totalM[1]) * 1024 * 1024;
            if (usedM)
                swapUsedBytes = parseFloat(usedM[1]) * 1024 * 1024;
        }
        catch { /* swap stats are best-effort */ }
        return { availableBytes, swapUsedBytes, swapTotalBytes };
    }
    function probeLinuxMemory() {
        const meminfo = fs_1.default.readFileSync('/proc/meminfo', 'utf8');
        const get = (key) => {
            const m = meminfo.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'));
            return m ? parseInt(m[1], 10) * 1024 : 0;
        };
        // MemAvailable is the kernel's own estimate of how much can be allocated
        // without swapping. Falls back to free + buffers + cached on old kernels.
        const memAvailable = get('MemAvailable') || (get('MemFree') + get('Buffers') + get('Cached'));
        const swapTotal = get('SwapTotal');
        const swapFree = get('SwapFree');
        return {
            availableBytes: memAvailable || os_1.default.freemem(),
            swapUsedBytes: Math.max(0, swapTotal - swapFree),
            swapTotalBytes: swapTotal,
        };
    }
    function getSystemMetrics() {
        const totalMemoryBytes = os_1.default.totalmem();
        const native = getNativeMemoryInfo();
        const mainProcessRssBytes = process.memoryUsage().rss;
        const appMemoryBytes = (0, systemMetrics_1.getElectronAppMemoryBytes)(electron_1.app.getAppMetrics(), mainProcessRssBytes);
        const usedPercent = ((totalMemoryBytes - native.availableBytes) / totalMemoryBytes) * 100;
        // Swap activity is the strongest user-facing lag signal: even when
        // "available" looks fine, any swap usage means the compressor has
        // started paging out and the user will feel it.
        const ONE_GB = 1024 * 1024 * 1024;
        const pressure = usedPercent > 90 || native.swapUsedBytes > ONE_GB
            ? 'high'
            : usedPercent > 75 || native.swapUsedBytes > 0
                ? 'medium'
                : 'low';
        return {
            totalMemoryBytes,
            availableMemoryBytes: native.availableBytes,
            appMemoryBytes,
            swapUsedBytes: native.swapUsedBytes,
            swapTotalBytes: native.swapTotalBytes,
            pressure,
            loadAvg1m: os_1.default.loadavg()[0],
            cpuCores: os_1.default.cpus().length,
        };
    }
    const metricsInterval = setInterval(() => {
        const metrics = getSystemMetrics();
        if (metrics.pressure !== lastPressure) {
            lastPressure = metrics.pressure;
            sendToRenderer('system:metrics-update', metrics);
        }
    }, 30_000);
    electron_1.app.on('before-quit', () => {
        if (shouldStopPollingOnBeforeQuit()) {
            clearInterval(metricsInterval);
        }
    });
    electron_1.ipcMain.handle('system:get-metrics', () => getSystemMetrics());
    electron_1.ipcMain.handle('system:cleanup-buffers', async () => {
        await ptyBackendReady;
        const count = await getPtyBackend().clearAllBuffers();
        return { cleared: count };
    });
}
