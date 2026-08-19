"use strict";
/**
 * Detects AI CLI agents running inside a terminal we didn't mark as AI at
 * create time (e.g., user typed `claude` inside a bash terminal).
 *
 * Strategy: tap PTY output for a bounded window (first N bytes or T ms).
 * When a known agent's OSC title or startup banner appears, promote the
 * terminal to "dynamically AI" so the input-accumulator gate at
 * src/main/index.ts opens for it. After the window closes (or detection
 * fires), the sniffer stops — zero ongoing cost on high-throughput streams
 * like `yarn build` or `tail -f`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentOutputSniffer = exports.AI_AGENT_SIGNATURES = void 0;
exports.detectShellLaunchCommand = detectShellLaunchCommand;
const replay_1 = require("../shared/terminal/replay");
exports.AI_AGENT_SIGNATURES = [
    // Claude Code banner is "Claude Code v..." — but the TUI often renders
    // each word with its own color escape, so we match on "Claude" + "Code"
    // loosely. Also match "ClaudeCode" since stripping spaces sometimes
    // happens in compressed banner renders.
    { name: 'claude', oscTitle: /Claude/i, banner: /Claude\s*Code/i, commandNames: ['claude'] },
    { name: 'codex', oscTitle: /Codex/i, banner: /OpenAI\s*Codex|codex\s*CLI/i, commandNames: ['codex'] },
    { name: 'aider', oscTitle: /aider/i, banner: /Aider\s*v\d/i, commandNames: ['aider'] },
    { name: 'gemini', oscTitle: /Gemini/i, banner: /Gemini\s*(CLI|Code)/i, commandNames: ['gemini'] },
    // Cursor answers to `agent` (documented), `cursor-agent` (legacy), and
    // explicit user-configured `agents` Windows-to-WSL bridges. Bare `cursor`
    // stays listed here only for the vendor shim that forwards `cursor agent`.
    { name: 'cursor', oscTitle: /Cursor/i, banner: /Cursor\s*Agent/i, commandNames: ['cursor-agent', 'agent', 'agents', 'cursor'] },
    { name: 'qwen', oscTitle: /Qwen/i, banner: /Qwen\s*(Code|CLI)/i, commandNames: ['qwen', 'qwen-code'] },
    { name: 'kimi', oscTitle: /Kimi/i, banner: /Kimi\s*(CLI|Code)/i, commandNames: ['kimi'] },
    { name: 'grok', oscTitle: /Grok/i, banner: /Grok\s*(Build|CLI|Code)/i, commandNames: ['grok'] },
    { name: 'hermes', oscTitle: /Hermes/i, banner: /Hermes\s*Agent/i, commandNames: ['hermes'] },
    // Pi's OSC title is `<model> - <cwd basename>`, never its own name, so the
    // banner is the only passive signal: its splash prints ` pi v<semver>` and
    // an unmistakable one-liner about itself. `\bpi\b` alone would match far
    // too much ordinary build output to be safe here.
    { name: 'pi', banner: /(?:^|\s)pi v\d+\.\d+\.\d+|Pi can explain its own features/, commandNames: ['pi'] },
];
// Wider window than before: Claude Code's alt-screen TUI takes >2s to paint
// and emits many KB of cursor-positioning noise before the banner text lands
// in readable form. 10s / 128KB still guarantees the sniffer stops well
// before long-running output (`yarn build`, `tail -f`) would pay any cost.
const MAX_BYTES = 128 * 1024;
const MAX_MS = 10_000;
const OSC_INTRO = '\x1b]';
const DEBUG = process.env.AI_SNIFFER_DEBUG === '1';
/**
 * Per-terminal sniffer. Accumulates output until either a signature matches
 * or the window closes. Call `feed()` for each chunk; when it returns an
 * AiAgentKind, the terminal should be promoted and the sniffer disposed.
 *
 * Buffer keeps the HEAD of output (banners appear early) — not the tail.
 */
class AgentOutputSniffer {
    buffer = '';
    strippedBuffer = '';
    bytesSeen = 0;
    startedAt = Date.now();
    done = false;
    feed(data) {
        if (this.done)
            return null;
        if (Date.now() - this.startedAt > MAX_MS || this.bytesSeen >= MAX_BYTES) {
            this.done = true;
            return null;
        }
        this.bytesSeen += data.length;
        if (this.buffer.length < MAX_BYTES) {
            const remaining = MAX_BYTES - this.buffer.length;
            this.buffer += data.slice(0, remaining);
            // Keep a separate ANSI-stripped view for banner matching. Banner text
            // is typically interleaved with \x1b[1m/\x1b[38;5;...m style escapes.
            this.strippedBuffer = (0, replay_1.stripAnsi)(this.buffer);
        }
        // Fast path: OSC title blocks are short — scan for \x1b] marker first.
        if (this.buffer.includes(OSC_INTRO)) {
            for (const sig of exports.AI_AGENT_SIGNATURES) {
                if (sig.oscTitle && matchOscTitle(this.buffer, sig.oscTitle)) {
                    this.done = true;
                    if (DEBUG)
                        console.log(`[ai-sniffer] matched ${sig.name} via OSC title`);
                    return sig.name;
                }
            }
        }
        for (const sig of exports.AI_AGENT_SIGNATURES) {
            if (sig.banner && sig.banner.test(this.strippedBuffer)) {
                this.done = true;
                if (DEBUG)
                    console.log(`[ai-sniffer] matched ${sig.name} via banner`);
                return sig.name;
            }
        }
        return null;
    }
    isDone() {
        return this.done || Date.now() - this.startedAt > MAX_MS || this.bytesSeen >= MAX_BYTES;
    }
}
exports.AgentOutputSniffer = AgentOutputSniffer;
function matchOscTitle(buffer, pattern) {
    let idx = 0;
    while ((idx = buffer.indexOf(OSC_INTRO, idx)) !== -1) {
        const terminator = findOscTerminator(buffer, idx + 2);
        if (terminator === -1)
            return false; // incomplete OSC, give up this pass
        const body = buffer.slice(idx + 2, terminator);
        // OSC title is `<Ps>;<title>` where Ps is 0, 1, or 2.
        const semi = body.indexOf(';');
        if (semi !== -1) {
            const ps = body.slice(0, semi);
            if (ps === '0' || ps === '1' || ps === '2') {
                const title = body.slice(semi + 1);
                if (pattern.test(title))
                    return true;
            }
        }
        idx = terminator + 1;
    }
    return false;
}
function findOscTerminator(buffer, from) {
    for (let i = from; i < buffer.length; i++) {
        if (buffer[i] === '\x07')
            return i;
        if (buffer[i] === '\x1b' && i + 1 < buffer.length && buffer[i + 1] === '\\')
            return i + 1;
    }
    return -1;
}
/**
 * Detect `claude` / `codex` / etc. typed at a shell prompt (line-mode
 * submission) to nudge the user toward the proper AI terminal UI.
 * Returns the matched agent kind, or null.
 */
function detectShellLaunchCommand(line) {
    const trimmed = line.trim();
    if (!trimmed)
        return null;
    const firstToken = trimmed.split(/\s+/)[0];
    if (!firstToken)
        return null;
    for (const sig of exports.AI_AGENT_SIGNATURES) {
        if (sig.commandNames.includes(firstToken))
            return sig.name;
    }
    return null;
}
