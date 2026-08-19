"use strict";
/**
 * Terminal session-ownership hotspot. Read docs/common-errors/terminals/INDEX.md
 * before changing submitted-prompt capture or retention.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubmittedPromptTracker = void 0;
const DEFAULT_MAX_PROMPTS = 20;
const DEFAULT_MAX_PENDING_CHARS = 64 * 1024;
/**
 * Small input-stream mirror used only as positive session-ownership evidence.
 * It intentionally gives up on complicated editor behavior instead of trying
 * to reconstruct a TUI composer from screen state: an imperfect read may delay
 * binding, but must never authorize a wrong terminal/session claim.
 */
class SubmittedPromptTracker {
    maxPrompts;
    maxPendingChars;
    pending = new Map();
    submitted = new Map();
    constructor(maxPrompts = DEFAULT_MAX_PROMPTS, maxPendingChars = DEFAULT_MAX_PENDING_CHARS) {
        this.maxPrompts = maxPrompts;
        this.maxPendingChars = maxPendingChars;
    }
    reset(terminalId) {
        this.pending.delete(terminalId);
        this.submitted.delete(terminalId);
    }
    read(terminalId) {
        return [...(this.submitted.get(terminalId) ?? [])];
    }
    feed(terminalId, data) {
        let pending = this.pending.get(terminalId) ?? '';
        for (let i = 0; i < data.length; i++) {
            const ch = data[i];
            if (ch === '\r') {
                const prompt = pending.trim();
                if (prompt) {
                    const prompts = this.submitted.get(terminalId) ?? [];
                    prompts.push(prompt);
                    if (prompts.length > this.maxPrompts) {
                        prompts.splice(0, prompts.length - this.maxPrompts);
                    }
                    this.submitted.set(terminalId, prompts);
                }
                pending = '';
                continue;
            }
            // Interior newlines are literal prompt content when a programmatic write
            // is bracketed-paste wrapped. The final submit is always a separate CR.
            if (ch === '\n') {
                pending += '\n';
                continue;
            }
            if (ch === '\x7f' || ch === '\b') {
                pending = pending.slice(0, -1);
                continue;
            }
            if (ch === '\x15' || ch === '\x03') {
                pending = '';
                continue;
            }
            if (ch === '\x1b') {
                const next = data[i + 1];
                if (next === '[') {
                    // CSI: skip through its final byte. This removes bracketed-paste
                    // markers as well as navigation keys without copying control text.
                    i += 2;
                    while (i < data.length) {
                        const code = data.charCodeAt(i);
                        if (code >= 0x40 && code <= 0x7e)
                            break;
                        i++;
                    }
                }
                else if (next === ']') {
                    // OSC: BEL or ST terminated.
                    i += 2;
                    while (i < data.length) {
                        if (data[i] === '\x07')
                            break;
                        if (data[i] === '\x1b' && data[i + 1] === '\\') {
                            i++;
                            break;
                        }
                        i++;
                    }
                }
                else if (next !== undefined) {
                    i++;
                }
                continue;
            }
            if (ch >= ' ')
                pending += ch;
            if (pending.length > this.maxPendingChars) {
                // Losing the beginning makes the value unusable for exact ownership
                // matching, so discard it instead of retaining a misleading suffix.
                pending = '';
            }
        }
        this.pending.set(terminalId, pending);
    }
}
exports.SubmittedPromptTracker = SubmittedPromptTracker;
