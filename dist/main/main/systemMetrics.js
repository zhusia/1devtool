"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getElectronAppMemoryBytes = getElectronAppMemoryBytes;
/**
 * Sum the resident working sets for every Electron-owned process.
 *
 * `process.memoryUsage().rss` only describes the main process, which made the
 * status-bar "1DevTool" value omit renderer, GPU, utility, and webview guest
 * processes. Keep the main RSS as a fallback for early startup or platforms
 * where Electron has not produced process metrics yet.
 */
function getElectronAppMemoryBytes(metrics, mainProcessRssBytes) {
    let totalKiB = 0;
    for (const metric of metrics) {
        const workingSetKiB = metric.memory?.workingSetSize;
        if (typeof workingSetKiB === 'number' && Number.isFinite(workingSetKiB) && workingSetKiB > 0) {
            totalKiB += workingSetKiB;
        }
    }
    return totalKiB > 0 ? totalKiB * 1024 : mainProcessRssBytes;
}
