"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrapMultilineForBracketedPaste = wrapMultilineForBracketedPaste;
exports.supportsAgentBracketedPaste = supportsAgentBracketedPaste;
exports.userPasteNeedsBracketedFraming = userPasteNeedsBracketedFraming;
exports.submitAgentPrompt = submitAgentPrompt;
const contracts_1 = require("./contracts");
/**
 * Submit a prompt to a terminal with the carriage return sequenced for the
 * terminal's agent kind. Shared by the remote (phone) handlers, the desktop
 * "Change AI" / Resume flows, and anywhere else that injects a prompt into a
 * terminal it doesn't own keystroke-by-keystroke.
 *
 * Why this exists: bundling the text with the Enter as ONE write (`text + '\r'`
 * / `text + '\n'`) defeats interactive AI TUIs (Claude, Codex, OpenCode, …).
 * Slash commands (`/compact`, `/model`, …) never register because the `\r` is
 * consumed in the same paste burst as the `/` text, and TUIs like OpenCode
 * simply drop a paste whose newline arrives in the same chunk — the text never
 * lands in the input. The desktop never bundles: it writes the text, then the
 * `\r` separately, and gives Claude a tuned ESC/delay sequence (see
 * src/renderer/stores/claudePromptDispatch.ts and TerminalView.handleAgentInputSubmit).
 *
 * - Claude: optionally ESC, ESC to clear an existing native composer draft,
 *   then text, \r — each step delayed so the TUI keeps up. Never send the
 *   clearing ESC/ESC when the native Claude composer is empty: on an empty
 *   composer that shortcut opens Rewind.
 * - Other interactive AI agents (codex/gemini/amp/opencode/… or forceAiAgent
 *   custom wrappers): write the text, then \r after a short gap. Native OpenTUI
 *   agents bracket multi-line text even if a renderer has not observed their
 *   `CSI ?2004h` yet.
 * - Plain shells: text + \r in a single write (preserves shell paste semantics).
 *
 * Full rule set: docs/common-errors/terminals/INDEX.md (B1–B4).
 */
const ESC = '\u001b';
const BRACKETED_PASTE_START = `${ESC}[200~`;
const BRACKETED_PASTE_END = `${ESC}[201~`;
const CLAUDE_SECOND_ESC_DELAY_MS = 120;
const CLAUDE_TEXT_WRITE_DELAY_MS = 240;
const CLAUDE_SUBMIT_AFTER_TEXT_DELAY_MS = 120;
// Generic AI agents: let the TUI render the typed text (and any slash-command
// menu) before the Enter submits it.
const GENERIC_AGENT_SUBMIT_DELAY_MS = 150;
const defaultSchedule = (callback, delayMs) => {
    setTimeout(callback, delayMs);
};
/**
 * Wrap a multi-line prompt body in bracketed-paste markers (CSI 200~ / 201~) so
 * a paste-aware TUI treats the interior newlines as literal text rather than
 * Enter presses.
 *
 * Why: custom AI wrappers launched via `forceAiAgent` (e.g. Hermes) read stdin
 * line-by-line, so a raw multi-line write is split into one *message per line*.
 * Each line then arrives as a fresh message that interrupts the previous one
 * still mid-flight — the agent prints "New message detected, interrupting…"
 * followed by "Interrupted during API call." Bracketing the body makes the
 * whole prompt land as a single message. The submit `\r` is always written
 * SEPARATELY, outside the markers, so it still triggers exactly one send.
 *
 * No-op for single-line text (nothing to protect). It is used for custom
 * wrappers and for native OpenTUI agents whose input parser guarantees this
 * framing; transcript-style recognised agents keep their existing sequencing.
 */
function wrapMultilineForBracketedPaste(text) {
    if (!text.includes('\n') && !text.includes('\r'))
        return text;
    return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}
/**
 * Whether prompt text can safely use bracketed-paste framing.
 *
 * An observed `CSI ?2004h` is authoritative for every TUI. OpenCode, Cline,
 * and Grok additionally have a shared OpenTUI input contract: they enable and
 * parse bracketed paste as part of startup. Trust that contract during the
 * startup/remount gap where xterm's mode mirror can still be false; otherwise
 * ConPTY can turn an interior newline into Enter and split the prompt into
 * Cline's queued messages.
 *
 * Codex and Kimi carry the same declared contract: their TUIs enable/parse
 * `200~`/`201~` paste regions on every platform. Relying on the
 * observed bit alone shipped a Windows bug — after a remount trimmed the
 * mode-set from the replayed buffer, a multi-line Agent Input/link prompt was
 * written raw, ConPTY re-chunked it, Codex's heuristic paste-burst collapsed
 * it into `[Pasted Content N chars]`, and the separately scheduled submit
 * `\r` was absorbed as burst content — the prompt sat staged in the composer
 * forever (windows-codex-paste-burst-staged-prompt.md). Kimi's pi-tui has the
 * same failure shape on long fenced writes: its non-bracketed paste fallback
 * suppresses Enter for 120 ms after the final fast character, so a link
 * envelope can remain staged until a person presses Enter
 * (kimi-paste-burst-staged-link.md). Qwen Code joined the contract at 0.21
 * with its alternate-buffer virtual viewport: it sets `?2004h` at startup,
 * and a framed two-line write lands as a two-line composer draft with no
 * markers leaking and no submit (verified against qwen 0.21.10 —
 * qwen-virtual-viewport-alt-screen.md). Gemini/Amp/… stay observed-mode-gated:
 * no verified contract, markers must never leak.
 */
function supportsAgentBracketedPaste(kind, pasteModeOn = false) {
    return pasteModeOn || (0, contracts_1.isNativeTuiAgentKind)(kind) || kind === 'codex' || kind === 'kimi';
}
/**
 * Whether a USER clipboard paste must be pre-framed in bracketed-paste markers
 * by the renderer before it reaches xterm.
 *
 * xterm frames a paste in `200~`/`201~` only when its mode mirror observed
 * `CSI ?2004h`. That mirror can be stale-false while the TUI's real paste mode
 * is on: the main-process pipe-buffer tail trim preserves mode state only for
 * OpenTUI replays, so a long session plus a pane remount replays a buffer
 * whose `?2004h` was trimmed away. An unframed multi-line paste then reaches
 * the TUI as `\r`-separated lines — the first line submits immediately and
 * the rest submit one by one
 * (docs/common-errors/terminals/paste-line-split-stale-mode-mirror.md).
 *
 * Claude is trusted here beyond supportsAgentBracketedPaste: its composer
 * arms `?2004h` at launch and parses paste framing for the TUI's whole
 * lifetime — every ordinary mirrored-mode paste already exercises exactly
 * this framing. Claude stays OUT of supportsAgentBracketedPaste on purpose:
 * the programmatic submit paths (dispatch sequencing, Windows quiet-wait)
 * are tuned around observed mode and must not change. Gemini/Amp and
 * unknown kinds stay observed-mode-gated — with paste mode genuinely off,
 * markers would leak into the input as literal text.
 */
function userPasteNeedsBracketedFraming(kind, pasteModeOn, text) {
    if (pasteModeOn)
        return false;
    if (!text.includes('\n') && !text.includes('\r'))
        return false;
    return supportsAgentBracketedPaste(kind) || kind === 'claude-command';
}
function submitAgentPrompt(write, text, target, scheduleOrOptions = defaultSchedule, maybeOptions = {}) {
    const schedule = typeof scheduleOrOptions === 'function'
        ? scheduleOrOptions
        : defaultSchedule;
    const options = typeof scheduleOrOptions === 'function'
        ? maybeOptions
        : scheduleOrOptions;
    const clearExisting = options.clearExisting ?? true;
    const interactive = (0, contracts_1.isInteractiveAgentTerminal)(target.agentType, target.startupCommand, target.forceAiAgent);
    // Plain shell: the carriage return belongs in the same write so the shell
    // sees a single submitted line (and bracketed-paste stays intact).
    if (!interactive) {
        write(text + '\r');
        return;
    }
    const kind = (0, contracts_1.getDeclaredAgentKind)(target.agentType, target.startupCommand);
    if (kind === 'claude-command') {
        if (clearExisting) {
            write(ESC);
            schedule(() => write(ESC), CLAUDE_SECOND_ESC_DELAY_MS);
        }
        if (text) {
            // Multi-line bodies must be bracketed-paste-wrapped or Claude reads each
            // interior '\n' as Enter and submits the prompt line-by-line, leaving only
            // the last line — the "only sends the last word" split. Claude Code always
            // enables bracketed paste while it owns the terminal, so this is safe even
            // though the remote/Change-AI/Resume callers can't observe `?2004h`. No-op
            // for single-line text (slash commands stay raw). See
            // docs/common-errors/terminals/agent-input-prompt-split-last-words.md.
            schedule(() => write(wrapMultilineForBracketedPaste(text)), CLAUDE_TEXT_WRITE_DELAY_MS);
        }
        schedule(() => write('\r'), CLAUDE_TEXT_WRITE_DELAY_MS + CLAUDE_SUBMIT_AFTER_TEXT_DELAY_MS);
        return;
    }
    // Other interactive agents (codex, gemini, amp, opencode, qwen, …) and
    // forceAiAgent custom wrappers: type the text, then submit after a beat.
    // Custom wrappers reach here with kind === null (they're interactive only via
    // forceAiAgent). Those read stdin line-by-line, so a multi-line body must be
    // bracketed-pasted or each interior newline submits as its own message.
    // Native OpenTUI agents, Codex, and Kimi get the same protection even though
    // they are known kinds: their parsers guarantee bracketed-paste support, while a
    // raw body can be re-chunked by ConPTY into one queued message per interior
    // newline — or, for Codex, collapsed by its paste-burst heuristic into a
    // staged `[Pasted Content]` placeholder that then eats the submit '\r'.
    if (text) {
        write(kind === null || supportsAgentBracketedPaste(kind)
            ? wrapMultilineForBracketedPaste(text)
            : text);
    }
    schedule(() => write('\r'), GENERIC_AGENT_SUBMIT_DELAY_MS);
}
