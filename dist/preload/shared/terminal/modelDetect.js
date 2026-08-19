"use strict";
/**
 * AI model detection from agent TUI output and startup commands.
 *
 * Feeds the model chip next to the agent logo in TerminalTabs. Detection is
 * layered:
 *   1. `parseModelFromCommand` — zero-cost initial value from `--model X` /
 *      `--model=X` / `-m X` launch args.
 *   2. `extractModelFromOutput` — live per-chunk scan of PTY output, so a
 *      `/model` switch inside the TUI updates the label. Patterns are anchored
 *      to each CLI's own confirmation/footer strings (never bare model names —
 *      pickers and transcript prose list model names constantly) and scoped by
 *      agent kind so one CLI's phrasing can't mislabel another's terminal.
 *
 * Hot-path contract: callers MUST gate with `mightContainModelInfo(raw)`
 * (a few substring checks on the raw chunk) before paying for stripAnsi +
 * regex. See docs "hotpath-perf": indexOf before regex.
 *
 * Shared module rules apply: no renderer/main-only imports.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.mightContainModelInfo = mightContainModelInfo;
exports.extractModelFromOutput = extractModelFromOutput;
exports.createModelScanState = createModelScanState;
exports.scanChunkForModel = scanChunkForModel;
exports.extractModelFromReplayBuffer = extractModelFromReplayBuffer;
exports.parseModelFromCommand = parseModelFromCommand;
exports.formatModelLabel = formatModelLabel;
const replay_1 = require("./replay");
// Cheap raw-chunk gate. Every extractable pattern below contains one of these
// substrings *contiguously*: Ink-style painters position each WORD separately
// (inter-word gaps arrive as cursor jumps, handled by
// stripAnsiPreservingLayout), but a single word is always written as one run,
// so one-word gate substrings survive in the raw bytes. "context" covers the
// Claude/Gemini/Qwen footers; "model"/"Model" covers every confirmation line;
// "Claude" covers the Claude Code session header ("Haiku 4.5 · Claude Max").
//
// OpenCode never prints the word "model" outside the typed `/models` echo:
// its footer paints `Build · Qwen3.7 Max OpenCode Go` (mode · model provider,
// captured from opencode 1.17.15). The mode word and the middot are each a
// single contiguous run, so an opencode-scoped branch gates on both being
// present — that fires on the boot frame and on every full footer repaint
// (model switch, mode toggle) and stays quiet for ordinary transcript chunks.
function mightContainModelInfo(raw, kind) {
    if (raw.includes('model') ||
        raw.includes('Model') ||
        raw.includes('context') ||
        raw.includes('Claude')) {
        return true;
    }
    if (kind === 'opencode') {
        return raw.includes('·') && (raw.includes('Build') || raw.includes('Plan'));
    }
    return false;
}
const MODEL_ID_SHAPE = /^(?:gpt-|o\d|codex|claude|gemini|qwen|glm|grok|kimi|deepseek|llama|mistral)[\w.:/-]*$/i;
// Ordered by trust: explicit switch confirmations first, then startup
// banners, then footer repaints. First matching pattern wins; within a
// pattern the LAST match in the chunk wins (footers repaint in bulk chunks).
const MODEL_PATTERNS = [
    // Claude Code `/model` result — "Set model to Fable 5 and saved as your
    // default…", "Kept model as Fable 5", "Set model to opus (claude-opus-4-1…)".
    // Case-sensitive on purpose: transcript prose says "set the model to…" in
    // lowercase; the CLI's own confirmation starts the phrase capitalized.
    {
        kinds: ['claude-command', null],
        re: /(?:Set model to|Kept model as)\s+([^\n]+)/g,
    },
    // Codex / generic switch confirmations.
    {
        kinds: ['codex', null],
        re: /(?:Model changed to|Switched model to|Switched to|Now using)[:\s]+((?:gpt-|o\d|codex)[\w.:/-]*)/g,
    },
    // Aider startup + `/model` switch: "Main model: gpt-4o with diff edit format".
    {
        kinds: [null],
        re: /Main model:\s+([^\s,]+)/g,
    },
    // Codex banner/status: "model:  gpt-5.1-codex-max" — loose anchor, so the
    // captured token must look like an OpenAI model id.
    {
        kinds: ['codex', null],
        re: /\bmodel:\s*([A-Za-z0-9][\w.:/-]*)/gi,
        validate: (c) => /^(?:gpt-|o\d|codex)/i.test(c),
    },
    // Claude status/config lines: "model: claude-sonnet-4-5…".
    {
        kinds: ['claude-command', null],
        re: /\bmodel:\s*(claude-[\w.-]+)/gi,
    },
    // Claude footer banner: "Sonnet 4.5 (200K context)" — same shape pty.ts
    // already recognizes as TUI chrome (src/main/pty.ts:171).
    {
        kinds: ['claude-command', null],
        re: /\b((?:Opus|Sonnet|Haiku|Fable)\s?\d[\d.]*)\s*\(?\s*\d+[KM]?\s*context/gi,
    },
    // Claude Code session header: "Opus 4.8 with xhigh effort · Claude Max",
    // "Haiku 4.5 · Claude Max" — printed on every launch/resume, so a restart
    // that comes back on a different model relabels the tab even when the
    // /model confirmation itself is buried in an unscanned old session.
    {
        kinds: ['claude-command', null],
        re: /\b((?:Opus|Sonnet|Haiku|Fable)\s?\d[\d.]*)\s*(?:with\s+\S+\s+effort\s*)?·\s*Claude\b/g,
    },
    // OpenCode TUI footer: `Build · Qwen3.7 Max OpenCode Go` (mode · model
    // provider). Each segment is painted with an absolute CUP jump (captured
    // from opencode 1.17.15), so stripAnsiPreservingLayout renders one segment
    // per line: "Build\n \n·\n \nQwen3.7 Max\n \nOpenCode Go". Anchoring on the
    // default mode names plus the standalone middot line keeps picker rows and
    // prose from capturing; the provider lands on the next line and is excluded.
    // The value must be newline-terminated: a PTY flush that ends mid-value
    // ("Qw") must NOT capture — the raw carry completes it on the next chunk.
    // Custom opencode modes won't anchor — the /models armed window still
    // catches the repaint via this same pattern when the mode is Build/Plan.
    {
        kinds: ['opencode', null],
        re: /\b(?:Build|Plan)\n ?\n?·\n ?\n?([^\n·]{2,})\n/g,
        validate: (c) => /^[A-Za-z0-9]/.test(c),
    },
    // Gemini CLI / Qwen Code footer: "gemini-2.5-pro (98% context left)",
    // "qwen3-coder-plus (100% context left)". The "% context left" suffix is
    // unique to that footer, so the token capture is safe.
    {
        kinds: ['gemini', 'qwen', null],
        re: /(\S{2,})\s+\(\d{1,3}% context left\)/g,
        validate: (c) => /[a-z]/i.test(c) && !c.startsWith('('),
    },
    // Codex inline footer (no parens): "gpt-5.5 71% context left". Requires a
    // model-id-shaped token so prose like "50% context left" can't capture.
    {
        kinds: ['codex', null],
        re: /\b((?:gpt-|o\d|codex)[\w.:/-]*)\s+\d{1,3}% context left/gi,
    },
];
// Long enough for provider-prefixed ids ("openrouter/anthropic/claude-3.5-…");
// anything longer is almost certainly prose, not a model name.
const MAX_MODEL_LABEL_LENGTH = 48;
function cleanModelCapture(raw) {
    let value = raw.replace(/\r/g, ' ').trim();
    // "Set model to opus (claude-opus-4-1-20250805)" — the parenthesized id is
    // the precise answer; prefer it when it looks like a model id.
    const paren = value.match(/\(([^)]+)\)/);
    if (paren && MODEL_ID_SHAPE.test(paren[1].trim())) {
        value = paren[1].trim();
    }
    else {
        // Cut trailing clauses: "… and saved as your default for new sessions".
        value = value.split(' and ')[0];
        const parenIdx = value.indexOf(' (');
        if (parenIdx > 0)
            value = value.slice(0, parenIdx);
    }
    // Trailing '%' is zsh's partial-line marker (output without a final
    // newline), never part of a model name.
    value = value
        .replace(/^[`'"]+|[`'".,;:!…%]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    // No real model label contains a semicolon or a control char — but SGR/CUP
    // params ("48;2;30;30;30") do, and they leak into stripped text when a PTY
    // chunk boundary splits an escape sequence. Never let one become the chip.
    if (/[;\x00-\x1f\x9b]/.test(value))
        return null;
    if (value.length < 2 || value.length > MAX_MODEL_LABEL_LENGTH)
        return null;
    return value;
}
/**
 * Extract the current model from an ANSI-stripped output chunk.
 * `kind` scopes which CLIs' patterns apply; pass null for unknown/custom
 * agents (all patterns apply). Returns null when nothing trustworthy matched.
 */
function extractModelFromOutput(stripped, kind) {
    const text = stripped.replace(/\r/g, '\n');
    for (const pattern of MODEL_PATTERNS) {
        if (!pattern.kinds.includes(kind))
            continue;
        pattern.re.lastIndex = 0;
        let lastCapture = null;
        let match;
        while ((match = pattern.re.exec(text)) !== null) {
            // Zero-length match safety for global regexes.
            if (match.index === pattern.re.lastIndex)
                pattern.re.lastIndex++;
            const capture = match[1];
            if (!capture)
                continue;
            if (pattern.validate && !pattern.validate(capture.trim()))
                continue;
            lastCapture = capture;
        }
        if (lastCapture) {
            const cleaned = cleanModelCapture(lastCapture);
            if (cleaned)
                return cleaned;
        }
    }
    return null;
}
// Raw bytes, so ANSI overhead counts against it: the OpenCode footer run from
// "Build" to the model text is ~230 raw bytes, Claude's /model confirmation
// with its CHA jumps is similar. 512 spans anchor→value across any boundary.
const MODEL_SCAN_CARRY_CHARS = 512;
const MODEL_SCAN_PENDING_CHUNKS = 3;
const MODEL_SWITCH_ARM_WINDOW_MS = 30_000;
// `/model` (claude/codex/gemini/qwen), `/models` (opencode), or a picker
// title. Matched against stripped text of already-gated chunks only.
const ARM_TRIGGER_RE = /\/models?\b|Select model|Switch AI model|Choose model/i;
function createModelScanState() {
    return { carry: '', pending: 0, armedUntil: 0 };
}
/**
 * Scan one raw PTY chunk for the current model, carrying a bounded RAW tail
 * across chunk boundaries. Mutates `state` in place (it lives on the
 * terminal instance). Returns the detected model or null. Cost when the gate
 * misses and nothing is pending/armed: a few substring checks only.
 */
function scanChunkForModel(state, rawChunk, kind, now = Date.now()) {
    const armed = now < state.armedUntil;
    const gated = mightContainModelInfo(rawChunk, kind);
    if (!gated && !armed && state.pending === 0)
        return null;
    // Layout-preserving strip: Claude/Codex paint inter-word gaps as cursor
    // jumps ("Set\x1b[10Gmodel\x1b[16Gto…"); bare stripAnsi would glue the
    // anchor phrase into "Setmodelto" and nothing below could ever match.
    // Strip carry+chunk TOGETHER: the carry is raw, so an escape sequence split
    // by the previous chunk boundary reassembles before stripping (see the
    // section comment above — stripping the halves separately leaked SGR params
    // like "48;2;30;30;30" into the text, which once shipped as a model chip).
    const combined = state.carry + rawChunk;
    const text = (0, replay_1.stripAnsiPreservingLayout)(combined);
    // User is opening/inside the model picker — watch the next chunks closely.
    if (ARM_TRIGGER_RE.test(text)) {
        state.armedUntil = now + MODEL_SWITCH_ARM_WINDOW_MS;
    }
    const model = extractModelFromOutput(text, kind);
    if (model) {
        state.carry = '';
        state.pending = 0;
        state.armedUntil = 0;
        return model;
    }
    state.pending = gated ? MODEL_SCAN_PENDING_CHUNKS : Math.max(0, state.pending - 1);
    // Keep the RAW tail (a front cut mid-sequence only ever damages text before
    // the anchor, never the anchor→value span, which stays contiguous).
    state.carry = state.pending > 0 || armed ? combined.slice(-MODEL_SCAN_CARRY_CHARS) : '';
    return null;
}
/**
 * One-shot scan of a replayed/saved transcript buffer (remount, app-restart
 * hydration). Replays bypass the live chunk path, so the latest historical
 * model statement must be recovered here. Only the tail is inspected.
 */
const REPLAY_SCAN_TAIL_CHARS = 32768;
function extractModelFromReplayBuffer(buffer, kind) {
    if (!buffer)
        return null;
    const tail = buffer.length > REPLAY_SCAN_TAIL_CHARS ? buffer.slice(-REPLAY_SCAN_TAIL_CHARS) : buffer;
    if (!mightContainModelInfo(tail, kind))
        return null;
    return extractModelFromOutput((0, replay_1.stripAnsiPreservingLayout)(tail), kind);
}
/**
 * Parse the launch model from a startup command: `--model X`, `--model=X`,
 * `-m X`. Gives the tab an initial label before the TUI prints anything.
 */
function parseModelFromCommand(command) {
    if (!command || !command.includes('-m'))
        return null;
    const tokens = command.trim().split(/\s+/);
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === '--model' || token === '-m') {
            const next = tokens[i + 1];
            if (next && !next.startsWith('-'))
                return cleanModelCapture(next);
            return null;
        }
        if (token.startsWith('--model=')) {
            return cleanModelCapture(token.slice('--model='.length));
        }
    }
    return null;
}
/**
 * Short display label for a detected model. Raw ids get compacted
 * ("claude-opus-4-8" → "Opus 4.8", "anthropic/claude-sonnet-4-5" →
 * "Sonnet 4.5"); already-human names ("Fable 5") pass through.
 */
function formatModelLabel(model) {
    // opencode/aider style provider-prefixed ids: keep the model segment.
    let value = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
    // claude-opus-4-8 / claude-sonnet-4-5-20250929 → "Opus 4.8" / "Sonnet 4.5"
    const claude = value.match(/^claude-(opus|sonnet|haiku|fable)-(\d+)(?:[.-](\d+))?/i);
    if (claude) {
        const family = claude[1].charAt(0).toUpperCase() + claude[1].slice(1).toLowerCase();
        return claude[3] ? `${family} ${claude[2]}.${claude[3]}` : `${family} ${claude[2]}`;
    }
    // Bare picker aliases: "opus", "sonnet[1m]" etc.
    const alias = value.match(/^(opus|sonnet|haiku|fable)$/i);
    if (alias) {
        return alias[1].charAt(0).toUpperCase() + alias[1].slice(1).toLowerCase();
    }
    return value;
}
