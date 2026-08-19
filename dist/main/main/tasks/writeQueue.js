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
exports.TaskWriteQueue = void 0;
const fs_1 = require("fs");
const path = __importStar(require("path"));
const frontmatter_1 = require("./frontmatter");
class TaskWriteQueue {
    queues = new Map();
    /** Serialize `fn` after all previously enqueued work for the same task id. */
    enqueue(taskId, fn) {
        const prev = this.queues.get(taskId) ?? Promise.resolve();
        const next = prev.then(fn, fn);
        // Keep the chain alive regardless of individual outcomes; prune when idle.
        const tail = next.then(() => undefined, () => undefined);
        this.queues.set(taskId, tail);
        void tail.finally(() => {
            if (this.queues.get(taskId) === tail)
                this.queues.delete(taskId);
        });
        return next;
    }
    /**
     * CAS write. `expectedHash` is the hash of the content this writer last
     * read; pass `null` for create (fails if the file already exists).
     */
    write(taskId, absPath, content, expectedHash) {
        return this.enqueue(taskId, async () => {
            try {
                let current = null;
                try {
                    current = await fs_1.promises.readFile(absPath, 'utf8');
                }
                catch {
                    current = null;
                }
                if (expectedHash === null) {
                    if (current !== null) {
                        return { ok: false, conflict: true, currentHash: (0, frontmatter_1.contentHash)(current) };
                    }
                }
                else {
                    if (current === null) {
                        return { ok: false, error: 'file missing — deleted since last read' };
                    }
                    const currentHash = (0, frontmatter_1.contentHash)(current);
                    if (currentHash !== expectedHash) {
                        return { ok: false, conflict: true, currentHash };
                    }
                }
                // Window: an external write landing between the check above and the
                // rename below is lost. See module comment — this is the documented
                // limit of the writer model, not an oversight.
                const tmp = `${absPath}.${process.pid}.${Date.now()}.tmp`;
                await fs_1.promises.mkdir(path.dirname(absPath), { recursive: true });
                await fs_1.promises.writeFile(tmp, content, 'utf8');
                await fs_1.promises.rename(tmp, absPath);
                return { ok: true, hash: (0, frontmatter_1.contentHash)(content) };
            }
            catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
        });
    }
    delete(taskId, absPath, expectedHash) {
        return this.enqueue(taskId, async () => {
            try {
                let current;
                try {
                    current = await fs_1.promises.readFile(absPath, 'utf8');
                }
                catch {
                    return { ok: true, hash: '' }; // already gone — deletion is idempotent
                }
                const currentHash = (0, frontmatter_1.contentHash)(current);
                if (currentHash !== expectedHash) {
                    return { ok: false, conflict: true, currentHash };
                }
                await fs_1.promises.unlink(absPath);
                return { ok: true, hash: '' };
            }
            catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) };
            }
        });
    }
}
exports.TaskWriteQueue = TaskWriteQueue;
