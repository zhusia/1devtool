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
exports.watchTasksDir = watchTasksDir;
const chokidar = __importStar(require("chokidar"));
/**
 * Tasks-directory watcher (docs/tasks_v2.md §4.4): a debounced HINT that
 * schedules reconciliation. It never establishes truth — the readdir
 * reconcile does — which is also what makes partially-written external edits
 * harmless (they parse as an error row until the next reconcile sees the
 * final fingerprint).
 *
 * Scoped to `.1devtool/tasks/` only — never repo-wide. Windows uses polling
 * per the house chokidar rule, with no `awaitWriteFinish`.
 */
const DEBOUNCE_MS = 400;
function watchTasksDir(tasksDir, onHint) {
    let timer = null;
    const hint = () => {
        if (timer)
            clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            onHint();
        }, DEBOUNCE_MS);
    };
    const watcher = chokidar.watch(tasksDir, {
        ignoreInitial: true,
        depth: 0,
        usePolling: process.platform === 'win32',
        // No awaitWriteFinish: the reconcile owns truth; a half-written file is a
        // visible error row until the next pass, never a hang here.
    });
    watcher.on('add', hint);
    watcher.on('change', hint);
    watcher.on('unlink', hint);
    return {
        async close() {
            if (timer)
                clearTimeout(timer);
            await watcher.close();
        },
    };
}
