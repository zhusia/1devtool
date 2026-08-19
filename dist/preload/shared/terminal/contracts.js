"use strict";
/**
 * Shared terminal contract module.
 *
 * This is the ONLY place allowed to answer:
 *   - what kind of terminal this is
 *   - whether it is an interactive AI terminal
 *   - whether tmux is allowed
 *   - whether savedBuffer may be restored
 *   - what prompt sync strategy applies
 *
 * Gotcha (docs/common-errors/terminals/INDEX.md rule A2): getDeclaredAgentKind()
 * returns 'claude-command' — comparing its result to 'claude' is dead code.
 * Detect AI terminals by BOTH agentType AND startup command (rule A1).
 *
 * No renderer-only imports (xterm, react, DOM).
 * No main-only imports (node-pty, electron, fs).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PI_OUTPUT_MARKERS = exports.CURSOR_OUTPUT_MARKERS = exports.ANTIGRAVITY_OUTPUT_MARKERS = exports.HERMES_OUTPUT_MARKERS = exports.GROK_OUTPUT_MARKERS = exports.QWEN_OUTPUT_MARKERS = exports.QODER_OUTPUT_MARKERS = exports.CLINE_OUTPUT_MARKERS = exports.OPENCODE_OUTPUT_MARKERS = exports.AMP_OUTPUT_MARKERS = exports.KIMI_OUTPUT_MARKERS = exports.GEMINI_OUTPUT_MARKERS = exports.CODEX_OUTPUT_MARKERS = exports.CLAUDE_OUTPUT_MARKERS = exports.CODEX_INLINE_MODE_FLAG = void 0;
exports.isNativeTuiAgentKind = isNativeTuiAgentKind;
exports.usesNativeTuiScroll = usesNativeTuiScroll;
exports.ensureCodexInlineMode = ensureCodexInlineMode;
exports.getDeclaredAgentKind = getDeclaredAgentKind;
exports.getAgentKindFromOutput = getAgentKindFromOutput;
exports.inferAgentKind = inferAgentKind;
exports.mapToResumeAgentType = mapToResumeAgentType;
exports.isInteractiveAgentType = isInteractiveAgentType;
exports.isInteractiveAgentCommand = isInteractiveAgentCommand;
exports.isInteractiveAgentTerminal = isInteractiveAgentTerminal;
exports.allowsTmux = allowsTmux;
exports.allowsSavedBufferRestore = allowsSavedBufferRestore;
exports.getAgentContinuityCapabilities = getAgentContinuityCapabilities;
exports.getTerminalProfile = getTerminalProfile;
// The set of agent executables that launch an interactive AI session.
// Cursor answers to `agent` (documented) and `cursor-agent` (legacy).
// `agents` is a user-configured Windows-to-WSL bridge that launches Cursor.
// Bare `cursor` is deliberately absent — that one is the editor launcher.
const INTERACTIVE_AGENT_EXECUTABLES = new Set(['claude', 'codex', 'gemini', 'kimi', 'amp', 'opencode', 'cline', 'qoder', 'qwen', 'grok', 'hermes', 'agy', 'cursor-agent', 'agent', 'agents', 'pi']);
exports.CODEX_INLINE_MODE_FLAG = '--no-alt-screen';
// Codex's TUI would otherwise flood the replay pipeline with fullscreen redraw
// frames (ghost composer cards — see codex-ghost-composer-frames.md). Launching
// it inline routes finalized output into the shared transcript pipeline. Cline
// and Grok use OpenTUI and must keep their native alternate-screen behavior.
// Output markers used to infer agent kind from buffer content
exports.CLAUDE_OUTPUT_MARKERS = ['Claude Code', 'What should Claude do instead?', 'bypass permissions on'];
exports.CODEX_OUTPUT_MARKERS = ['OpenAI Codex', 'Codex CLI'];
exports.GEMINI_OUTPUT_MARKERS = ['Gemini CLI'];
exports.KIMI_OUTPUT_MARKERS = ['Kimi Code'];
exports.AMP_OUTPUT_MARKERS = [' Amp ', '\nAmp\n', '\rAmp\r'];
exports.OPENCODE_OUTPUT_MARKERS = ['opencode', 'OpenCode'];
exports.CLINE_OUTPUT_MARKERS = ['Cline'];
exports.QODER_OUTPUT_MARKERS = ['Qoder', 'qoder'];
exports.QWEN_OUTPUT_MARKERS = ['Qwen Code', 'qwen'];
exports.GROK_OUTPUT_MARKERS = ['Grok Build', 'Grok CLI'];
exports.HERMES_OUTPUT_MARKERS = ['Hermes Agent', '⚕ Hermes Agent'];
exports.ANTIGRAVITY_OUTPUT_MARKERS = ['Antigravity', 'Models & Quota'];
exports.CURSOR_OUTPUT_MARKERS = ['Cursor Agent'];
// Pi's persistent chrome is a version header (` pi v0.82.0`) and a two-line
// footer (`~/path (branch)` + `<stats> 0.0%/262k (auto)   (provider) model`) —
// none of which contains a version-independent literal that is pi's alone. So
// output inference uses the two startup rows it always prints instead; a
// declared `pi` executable/agentType is the primary signal either way.
exports.PI_OUTPUT_MARKERS = ['Pi can explain its own features', 'ctrl+o to show full startup help'];
/**
 * Agents that own a full-screen TUI, mouse tracking, and wheel scrolling.
 *
 * Qwen Code joined this set in 0.21: its "virtual viewport" (`ui.useTerminalBuffer`,
 * default ON) renders the whole session inside the alternate buffer and owns
 * scrolling through SGR mouse reports — the OpenTUI shape, not the inline-Ink
 * shape Gemini CLI still uses. Captured from qwen 0.21.10 at 120x30:
 * `?1049h ?1002h ?1006h ?1004h ?2004h` plus `?2026h/l` frames, versus gemini
 * 0.16 which emits `?1002l ?1006l` and never leaves the normal buffer.
 * Classifying it as a transcript agent blocked 47/1047/1049 and stripped its
 * mouse modes, so its full-screen repaints landed in xterm's normal buffer and
 * scrolled duplicated frame fragments into scrollback while nothing could be
 * scrolled (qwen-virtual-viewport-alt-screen.md).
 */
function isNativeTuiAgentKind(kind) {
    return kind === 'opencode' || kind === 'cline' || kind === 'grok' || kind === 'hermes' || kind === 'qwen';
}
/**
 * Native OpenTUI agents own scrolling on every platform. On Windows, other
 * interactive agents keep the ConPTY/full-screen policy, but Codex is launched
 * with --no-alt-screen and therefore uses xterm transcript scrollback. Pi is
 * exempt for the same reason without needing a flag: it never enters the
 * alternate buffer at all — it streams its transcript as ordinary lines and
 * repaints only the composer/footer via cursor-up, so xterm accumulates real
 * scrollback (verified: baseY 37 after one long turn at 120x30).
 */
function usesNativeTuiScroll(kind, isWindows) {
    return Boolean(kind) && (isNativeTuiAgentKind(kind) || (isWindows && kind !== 'codex' && kind !== 'pi'));
}
function ensureCodexInlineMode(command) {
    const trimmed = command?.trim();
    if (!trimmed)
        return trimmed;
    if (!/^codex(?:\s|$)/.test(trimmed))
        return trimmed;
    if (new RegExp(`(?:^|\\s)${exports.CODEX_INLINE_MODE_FLAG}(?:\\s|$)`).test(trimmed))
        return trimmed;
    return trimmed.replace(/^codex(?:\s+|$)/, (match) => match.includes(' ')
        ? `codex ${exports.CODEX_INLINE_MODE_FLAG} `
        : `codex ${exports.CODEX_INLINE_MODE_FLAG}`);
}
/**
 * Resolve the interactive agent kind from declared agentType and/or startup command.
 * This does NOT look at output — only at explicit declaration.
 */
function getDeclaredAgentKind(agentType, command) {
    const executable = command?.trim().split(/\s+/)[0];
    // The startup executable is the process we will actually launch. Prefer it
    // when it names a known agent, even if stale preset metadata still names a
    // different one. Otherwise one agent's readiness and prompt contracts can
    // be applied to another agent's live TUI.
    if (executable === 'claude') {
        return 'claude-command';
    }
    if (executable === 'codex') {
        return 'codex';
    }
    if (executable === 'gemini') {
        return 'gemini';
    }
    if (executable === 'kimi') {
        return 'kimi';
    }
    if (executable === 'agy') {
        return 'antigravity';
    }
    if (executable === 'amp') {
        return 'amp';
    }
    if (executable === 'opencode') {
        return 'opencode';
    }
    if (executable === 'cline') {
        return 'cline';
    }
    if (executable === 'qoder') {
        return 'qoder';
    }
    if (executable === 'qwen') {
        return 'qwen';
    }
    if (executable === 'grok') {
        return 'grok';
    }
    // Hermes profiles install alias binaries named `hermes-<profile>`
    // (hermes-opencode, hermes-cline, …) that exec the same TUI with another
    // backend — the composer/status chrome is identical, so they are hermes.
    if (executable === 'hermes' || executable?.startsWith('hermes-')) {
        return 'hermes';
    }
    // `agent` (documented), `cursor-agent` (legacy), and the explicit `agents`
    // Windows-to-WSL wrapper all launch Cursor. Bare `cursor` is the editor.
    if (executable === 'cursor-agent' || executable === 'agent' || executable === 'agents') {
        return 'cursor';
    }
    if (executable === 'pi') {
        return 'pi';
    }
    if (agentType === 'claude')
        return 'claude-command';
    if (agentType === 'codex')
        return 'codex';
    if (agentType === 'gemini')
        return 'gemini';
    if (agentType === 'kimi')
        return 'kimi';
    if (agentType === 'agy')
        return 'antigravity';
    if (agentType === 'amp')
        return 'amp';
    if (agentType === 'opencode')
        return 'opencode';
    if (agentType === 'cline')
        return 'cline';
    if (agentType === 'qoder')
        return 'qoder';
    if (agentType === 'qwen')
        return 'qwen';
    if (agentType === 'grok')
        return 'grok';
    if (agentType === 'hermes')
        return 'hermes';
    if (agentType === 'cursor')
        return 'cursor';
    if (agentType === 'pi')
        return 'pi';
    return null;
}
/**
 * Infer the interactive agent kind from terminal output content.
 * Used when agentType/command don't declare an agent but the output reveals one.
 * Requires pre-stripped (ANSI-free) text.
 */
function getAgentKindFromOutput(strippedText) {
    if (!strippedText)
        return null;
    const text = strippedText.replace(/\r/g, '\n');
    if (exports.CLAUDE_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return 'claude-command';
    if (exports.CODEX_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return 'codex';
    if (exports.GEMINI_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return 'gemini';
    if (exports.KIMI_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return 'kimi';
    // Pi is checked BEFORE opencode on purpose. Pi paints its PROVIDER in the
    // persistent footer (`(opencode-go) kimi-k2.7-code • medium`), so the bare
    // `opencode` substring marker below would otherwise claim every pi terminal
    // whose user is on an opencode-backed provider. Pi's own markers are full
    // sentences no other agent prints, so moving them up cannot steal a match.
    if (exports.PI_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return 'pi';
    if (exports.AMP_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return 'amp';
    if (exports.OPENCODE_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return 'opencode';
    if (exports.CLINE_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return 'cline';
    if (exports.QODER_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return 'qoder';
    if (exports.QWEN_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return 'qwen';
    if (exports.GROK_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return 'grok';
    if (exports.HERMES_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return 'hermes';
    if (exports.ANTIGRAVITY_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return 'antigravity';
    if (exports.CURSOR_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return 'cursor';
    return null;
}
/**
 * Infer the interactive agent kind from all available signals.
 * Checks declared agentType/command first, then falls back to output inference.
 * `strippedData` must be ANSI-stripped text (use stripAnsi from replay module).
 */
function inferAgentKind(agentType, command, strippedData) {
    return getDeclaredAgentKind(agentType, command) ?? getAgentKindFromOutput(strippedData);
}
/**
 * Map an agentType/command to the ResumeAgentType used for session detection
 * and resume. Returns null for terminals with no declared interactive agent
 * (plain shells, custom wrappers) and for agents without session detection.
 */
function mapToResumeAgentType(agentType, command) {
    const kind = getDeclaredAgentKind(agentType, command);
    if (!kind)
        return null;
    switch (kind) {
        case 'claude-command': return 'claude';
        case 'codex': return 'codex';
        case 'gemini': return 'gemini';
        case 'kimi': return 'kimi';
        case 'amp': return 'amp';
        case 'qwen': return 'qwen';
        case 'grok': return 'grok';
        case 'hermes': return 'hermes';
        case 'opencode': return 'opencode';
        case 'cline': return 'cline';
        case 'antigravity': return 'agy';
        case 'cursor': return 'cursor';
        case 'pi': return 'pi';
        default: return null;
    }
}
/**
 * Check if an agentType represents an interactive AI terminal.
 */
function isInteractiveAgentType(agentType) {
    return agentType === 'claude' || agentType === 'codex' || agentType === 'gemini' || agentType === 'kimi' || agentType === 'agy' || agentType === 'amp' || agentType === 'opencode' || agentType === 'cline' || agentType === 'qoder' || agentType === 'qwen' || agentType === 'grok' || agentType === 'hermes' || agentType === 'cursor' || agentType === 'pi';
}
/**
 * Check if a startup command launches an interactive AI agent.
 */
function isInteractiveAgentCommand(command) {
    const executable = command?.trim().split(/\s+/)[0];
    // `hermes-<profile>` alias binaries are hermes (see getDeclaredAgentKind).
    return Boolean(executable && (INTERACTIVE_AGENT_EXECUTABLES.has(executable) || executable.startsWith('hermes-')));
}
/**
 * Check if a terminal should be treated as interactive AI (by agentType OR command OR user override).
 */
function isInteractiveAgentTerminal(agentType, command, forceAi) {
    return forceAi === true || isInteractiveAgentType(agentType) || isInteractiveAgentCommand(command);
}
/**
 * Whether tmux persistence is allowed for this terminal.
 * AI interactive terminals must skip tmux.
 */
function allowsTmux(agentType, command, forceAi) {
    return !isInteractiveAgentTerminal(agentType, command, forceAi);
}
/**
 * Whether savedBuffer restore is allowed.
 * Declared interactive agents must not restore stale saved buffers.
 */
function allowsSavedBufferRestore(agentType, command, forceAi) {
    return !forceAi && !getDeclaredAgentKind(agentType, command);
}
/**
 * Determine session continuity capabilities for a terminal.
 * Pure function — no runtime state, no side effects.
 */
function getAgentContinuityCapabilities(agentType, command, forceAiAgent) {
    const kind = getDeclaredAgentKind(agentType, command);
    // Custom AI wrappers (forceAiAgent=true) can't detect/resume but CAN restore transcript
    if (!kind && forceAiAgent)
        return { canDetectSession: false, canAutoResume: false, canRestoreTranscript: true };
    if (!kind)
        return { canDetectSession: false, canAutoResume: false, canRestoreTranscript: false };
    switch (kind) {
        case 'claude-command': return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        case 'codex': return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        case 'amp': return { canDetectSession: false, canAutoResume: true, canRestoreTranscript: true };
        case 'gemini': return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        // Kimi Code stores indexed session metadata plus a wire.jsonl transcript
        // under KIMI_CODE_HOME and resumes with `kimi --session <id>`.
        case 'kimi': return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        case 'qwen': return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        // Cline stores exact metadata/transcript pairs in ~/.cline/data/sessions
        // and resumes through `cline --id <session-id>`.
        case 'cline': return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        // Grok stores per-cwd sessions under ~/.grok/sessions/<url-encoded-cwd>/<uuid>/
        // (summary.json + chat_history.jsonl) and resumes via `grok --resume <id>`.
        case 'grok': return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        // Hermes stores sessions in ~/.hermes/state.db and resumes with
        // `hermes --resume <session-id>`.
        case 'hermes': return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        // Antigravity CLI stores renderable transcripts under
        // ~/.gemini/antigravity-cli/brain and resumes with --conversation.
        case 'antigravity': return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        // OpenCode sessions live in ~/.local/share/opencode/opencode.db with exact
        // launch directory + epoch-ms timestamps, so filesystem detection works;
        // resumeManager filters out zero-message drafts and subagent child rows.
        case 'opencode': return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        // Current cursor-agent builds persist chats locally under
        // ~/.cursor/chats/<md5(cwd)>/<chat-uuid>/ (meta.json + store.db), so
        // filesystem detection works (parsed by resumeManager's cursor scanner).
        // Resume: `cursor-agent --resume <chat-id>`.
        case 'cursor': return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        // Pi writes one JSONL per session under
        // ~/.pi/agent/sessions/--<cwd with separators as dashes>--/ whose first
        // line is a `{type:'session', id, cwd}` header, and resumes with
        // `pi --session <id>`.
        case 'pi': return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        default: return { canDetectSession: false, canAutoResume: false, canRestoreTranscript: true };
    }
}
/**
 * Build a full runtime profile for a terminal from its declaration.
 */
function getTerminalProfile(agentType, command, forceAi) {
    const declaredKind = getDeclaredAgentKind(agentType, command);
    const interactive = forceAi === true || Boolean(declaredKind);
    return {
        kind: declaredKind ?? agentType ?? 'bash',
        interactive,
        allowTmux: !interactive,
        allowSavedBufferRestore: !declaredKind,
        promptStrategy: interactive ? 'interactive-draft-sync' : 'plain-shell',
    };
}
