"use strict";
/**
 * Terminal notification/dashboard preview extraction.
 *
 * Terminal minefield: read docs/common-errors/terminals/INDEX.md before editing.
 * A hidden native TUI's active xterm buffer is a rendered UI frame, not a
 * transcript. Preview callers must pass the effective agent type and filter
 * composer/footer chrome before treating those rows as result content
 * (cline-completion-notification-composer-chrome.md).
 *
 * No renderer-only imports (xterm, react, DOM).
 * No main-only imports (node-pty, electron, fs).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isClineComposerChromeLine = isClineComposerChromeLine;
exports.containsClineComposerChrome = containsClineComposerChrome;
exports.buildTerminalPreviewFromLines = buildTerminalPreviewFromLines;
exports.buildTerminalPreview = buildTerminalPreview;
const contracts_1 = require("./contracts");
const replay_1 = require("./replay");
// Lines that are purely TUI chrome (status bar, prompt-box border, footer,
// model banner). Shared by pipe-buffer and rendered-headless previews so the
// two backends cannot drift into showing different notification bodies.
function isAiTuiChromeLine(line, agentType) {
    const stripped = line.replace(/\*{1,2}/g, '').trim();
    if (!stripped)
        return false;
    // Ink/OpenTUI can position words with cursor motion instead of literal
    // whitespace. Rendered screen rows retain the gaps; pipe-buffer extraction
    // uses stripAnsiPreservingLayout(). Test both forms for older captures.
    const compact = stripped.replace(/\s+/g, '');
    const matches = (...patterns) => patterns.some((pattern) => pattern.test(stripped) || pattern.test(compact));
    // Pure box-drawing / separator lines (top/bottom of prompt boxes, dividers).
    // U+2500–U+257F = Box Drawing, U+2580–U+259F = Block Elements.
    if (/^[─-╿▀-▟\s\-_=—–―‾⎯⎺⎻⎼⎽]+$/u.test(stripped))
        return true;
    if (/^[>❯›⏵▸▶➤»]\s*$/.test(stripped))
        return true;
    if (matches(/\b\d+\s*tokens?\b/i))
        return true;
    if (matches(/●\s*(?:high|low|auto|medium)\b/i))
        return true;
    if (matches(/\/effort\b/))
        return true;
    if (agentType === 'claude') {
        if (matches(/^Claude\s*Code\s*v[\d.]/i))
            return true;
        if (matches(/(?:Opus|Sonnet|Haiku)\s*[\d.]+\s*\(?\s*[\d]+[KM]?\s*context\s*\)?/i))
            return true;
        if (matches(/^(?:Opus|Sonnet|Haiku)\s*[\d.]+\b.*\bClaude\b/i))
            return true;
        if (matches(/(?:accept|reject)\s*edits?\b/i))
            return true;
        if (matches(/bypass\s*permissions?\b/i))
            return true;
        if (matches(/shift\+tab\s*to\s*cycle\b/i))
            return true;
        if (matches(/esc\s*to\s*interrupt\b/i))
            return true;
        if (matches(/ctrl\+t\s*to\s*(?:hide|show|toggle)\b/i))
            return true;
        if (matches(/ctrl\+r\s*to\s*(?:show|hide)\s*(?:reasoning|thinking)\b/i))
            return true;
        if (/^[~/]/.test(stripped) && !stripped.includes(' '))
            return true;
        if (matches(/MCP\s*servers?\s*(?:·)?\s*(?:failed|connected|enabled|disabled)/i))
            return true;
        if (matches(/Claude\s*in\s*Chrome\s*(?:enabled|disabled|connected)/i))
            return true;
        if (matches(/^[✻✢✳·✦◐◑◒◓⠁-⠿]*\s*[A-Z][a-z]+(?:ing|ed)(?:\s*(?:for\s*\d+\s*s?|…\s*\d+\s*s?))\s*$/i))
            return true;
        if (matches(/[←→↑↓]\s*for\s*\w+\b/i))
            return true;
    }
    if (agentType === 'codex') {
        if (matches(/^(?:OpenAI\s*)?Codex(?:\s*CLI)?\b/i))
            return true;
        if (matches(/bypass\s*permissions?\s*on\b/i))
            return true;
        if (matches(/shift\+tab\s*to\s*cycle\b/i))
            return true;
        if (matches(/esc\s*to\s*interrupt\b/i))
            return true;
        if (matches(/ctrl\+v\s*to\s*paste\b/i))
            return true;
        if (matches(/^(?:gpt|o\d|codex|openai)[\w.-]*\s*(?:low|medium|high|xhigh|auto)\s*[•·]/i))
            return true;
        if (/·.*\bleft\b.*(?:~\/|\/Users\/|\/[A-Za-z0-9._-]+\/)/i.test(stripped))
            return true;
    }
    if (agentType === 'cline') {
        // Cline 3.x idle composer. The provider/model/context meter and Plan/Act
        // control may occupy one xterm row and then wrap into several OS-notification
        // lines, which is why either marker rejects the complete source row.
        if (isClineComposerChromeLine(stripped))
            return true;
        if (/^[\s@*.]{6,}$/.test(stripped))
            return true; // welcome-screen logo art
        if (matches(/^Use\s*\/\s*for\s*slash\s*commands?.*Ctrl\+P\s*for\s*menu/i))
            return true;
        if (matches(/^.+\([^)]+\)\s*\|\s*\d+\s*files?\b/i))
            return true;
        if (matches(/auto-approve\s*all\s*(?:enabled|disabled).*shift\+tab/i))
            return true;
    }
    // Hint lines common across agents.
    if (matches(/^\(?use\s*\/[\w-]+\b/i))
        return true;
    if (matches(/^\(?type\s*(?:a\s*)?message\b/i))
        return true;
    if (matches(/^\(?press\s*(?:enter|return)\b/i))
        return true;
    return false;
}
/** Cline-specific composer/footer rows visible in completion screenshots. */
function isClineComposerChromeLine(line) {
    const stripped = line.replace(/\*{1,2}/g, '').trim();
    if (!stripped)
        return false;
    const compact = stripped.replace(/\s+/g, '');
    const matches = (pattern) => pattern.test(stripped) || pattern.test(compact);
    if (matches(/^(?:[>❯›]\s*)?(?:Ask\s*anything|What\s*can\s*I\s*do\s*for\s*you)\??(?:…|\.\.\.)?$/i))
        return true;
    if (matches(/\b(?:○|◯|●)?\s*Plan\s*(?:○|◯|●|•|·)\s*Act\s*\(Tab\)\s*$/i))
        return true;
    // Raw OpenTUI repaint bytes position each control at an absolute column;
    // layout-preserving extraction may therefore put the three controls on
    // separate lines. The rendered headless path keeps them on one row.
    if (/^[○◯●]\s*(?:Plan|Act)$/i.test(stripped))
        return true;
    if (/^\(Tab\)$/i.test(stripped))
        return true;
    if (/^ClinePass\s*:/i.test(stripped))
        return true;
    if (/^[\w .-]+:\s+.+\((?:low|medium|high|xhigh)\)\s*[▀-▟█░▒▓■□]*\s*\([\d,]+\)/i.test(stripped))
        return true;
    return false;
}
/** Whether an untyped notification body looks like a flattened Cline frame. */
function containsClineComposerChrome(lines) {
    return lines.some((line) => isClineComposerChromeLine(line));
}
/**
 * Build a bounded plain-text preview from already-rendered screen rows.
 * `lines` may be an xterm headless viewport or ANSI-stripped pipe-buffer rows.
 */
function buildTerminalPreviewFromLines(lines, maxChars, agentType) {
    const isAi = (0, contracts_1.isInteractiveAgentType)(agentType);
    const meaningful = [];
    let chars = 0;
    for (let index = lines.length - 1; index >= 0 && chars < maxChars; index--) {
        let line = lines[index] ?? '';
        if (isAi) {
            line = line.replace(/^[\s│┃|─-╿]+/, '').replace(/[\s│┃|─-╿]+$/, '');
        }
        line = line.trim();
        if (!line)
            continue;
        if (/^[\s*+·•]*thinking[\s*+·•thinking]*$/i.test(line))
            continue;
        if (/^[$>%#❯›]\s*$/.test(line))
            continue;
        if (/^\[[\d;?]*[A-Za-z]/.test(line))
            continue;
        if (isAi && isAiTuiChromeLine(line, agentType))
            continue;
        meaningful.unshift(line);
        chars += line.length;
    }
    return meaningful.join('\n').slice(-maxChars).trim() || null;
}
/** Build a preview directly from raw PTY/tmux output. */
function buildTerminalPreview(raw, maxChars, agentType) {
    const rendered = (0, contracts_1.isInteractiveAgentType)(agentType)
        ? (0, replay_1.stripAnsiPreservingLayout)(raw)
        : (0, replay_1.stripAnsi)(raw);
    return buildTerminalPreviewFromLines(rendered.split(/\r?\n/), maxChars, agentType);
}
