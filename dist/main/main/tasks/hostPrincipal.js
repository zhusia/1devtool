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
exports.TasksHostPrincipal = exports.isTasksHostPrincipalId = void 0;
const fs_1 = require("fs");
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const tasks_1 = require("../../shared/tasks");
Object.defineProperty(exports, "isTasksHostPrincipalId", { enumerable: true, get: function () { return tasks_1.isTasksHostPrincipalId; } });
class TasksHostPrincipal {
    baseDir;
    id = null;
    loading = null;
    constructor(baseDir) {
        this.baseDir = baseDir;
    }
    get filePath() {
        return path.join(this.baseDir, 'tasks-host-principal.json');
    }
    /** The stable sentinel id, minted on first use and reused forever after. */
    async id_() {
        if (this.id)
            return this.id;
        if (!this.loading)
            this.loading = this.load();
        this.id = await this.loading;
        return this.id;
    }
    async load() {
        try {
            const raw = JSON.parse(await fs_1.promises.readFile(this.filePath, 'utf8'));
            if (typeof raw.hostPrincipalId === 'string' && (0, tasks_1.isTasksHostPrincipalId)(raw.hostPrincipalId)) {
                return raw.hostPrincipalId;
            }
        }
        catch { /* first run, or unreadable — mint a new one below */ }
        const minted = `${tasks_1.TASKS_HOST_PRINCIPAL_PREFIX}${(0, crypto_1.randomUUID)()}`;
        await fs_1.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.${process.pid}.tmp`;
        await fs_1.promises.writeFile(tmp, JSON.stringify({ hostPrincipalId: minted }), 'utf8');
        await fs_1.promises.rename(tmp, this.filePath);
        return minted;
    }
    /**
     * The principal Tasks passes to every controller call. `renderer-user`
     * because the authority behind it is a human gesture in the main renderer —
     * never an agent, never a terminal.
     */
    async principal(projectId) {
        return { terminalId: await this.id_(), projectId, kind: 'renderer-user', depth: 0 };
    }
}
exports.TasksHostPrincipal = TasksHostPrincipal;
