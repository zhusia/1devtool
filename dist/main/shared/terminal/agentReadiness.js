"use strict";
/**
 * Shared current-screen agent readiness rules.
 *
 * Terminal safety rules: docs/common-errors/terminals/INDEX.md (B11, B13).
 * Readiness requires current marker + cursor-owned empty-composer evidence;
 * placeholder text alone is never enough.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AGENT_CURSOR_COMPOSER_PREFIX = exports.AGENT_READY_MARKERS = void 0;
exports.evaluateAgentComposerReadiness = evaluateAgentComposerReadiness;
exports.hasKnownReadyMarker = hasKnownReadyMarker;
const promptGhostText_1 = require("./promptGhostText");
exports.AGENT_READY_MARKERS = {
    'claude-command': [
        { marker: /(?:\? for shortcuts|bypass permissions on)/i },
    ],
    codex: [
        // Current Codex paints its model in the footer even after the splash has
        // scrolled away. The empty-composer proof still comes from the cursor row.
        { marker: /(?:OpenAI Codex|\bgpt-[A-Za-z0-9_.-]+\b)/i },
    ],
    gemini: [
        { marker: /(?:type your message|enter a prompt|ask gemini)/i, empty: /(?:type your message|enter a prompt|ask gemini)\s*$/i },
    ],
    kimi: [
        {
            // Kimi Code's pi-tui editor is a bordered box whose first content row
            // starts with `│ > `. Its two-line footer persists across turns and
            // always paints `context: N%`, while the welcome banner may scroll out.
            // Kimi user transcript rows use the `✨` bullet, never a bare boxed `>`.
            marker: /(?:^|\n).*context:\s*\d+%/i,
            composerLine: /^\s*[│┃|]\s*>(?:\s|$)/u,
            emptyLine: /^\s*[│┃|]\s*>\s*(?:[│┃|])?\s*$/u,
        },
    ],
    opencode: [
        // OpenCode 1.18 paints a bordered composer with the muted
        // `Ask anything... "<example>"` placeholder AFTER the cursor, followed
        // by model/footer chrome. The cursor-prefix path below owns the empty
        // proof; an end-of-screen placeholder regex can never match this layout.
        { marker: /ask anything/i },
        // The placeholder exists exactly once per session: the first accepted
        // turn scrolls it away, and every later screen paints only the persistent
        // `Build · <model> … OpenCode` composer status (verbatim captures:
        // 1.17.4 Windows ConPTY, 1.18.18 darwin post-turn — Ink can wrap
        // `OpenCode` across physical rows). Without this marker, every link/Team
        // delivery after OpenCode's first turn sat queued as waiting-for-readiness
        // until the redelivery window failed it
        // (docs/common-errors/orchestration/opentui-link-delivery-never-ready.md).
        // Marker only — the cursor-prefix path still owns the empty-composer
        // proof, so a typed draft can never be overwritten.
        { marker: /\bBuild\s*[·•][\s\S]{0,192}\bOpenC(?:ode|[\s│┃|]+ode)\b/i },
    ],
    // Cline and Grok are OpenTUI apps: the composer is a bordered box with a
    // `❯` glyph, the placeholder is muted ghost text INSIDE it, and persistent
    // footer chrome is painted BELOW it — so a `…\s*$` end-of-screen empty
    // regex can never match. Their empty-composer proof is the cursor-prefix
    // path (AGENT_CURSOR_COMPOSER_PREFIX below); the marker only proves the
    // TUI is the thing on screen. Field failure: the old "ask anything" /
    // "what would you like" markers matched neither current build, so link
    // deliveries to Grok/Cline sat queued forever
    // (docs/common-errors/orchestration/opentui-link-delivery-never-ready.md).
    cline: [
        { marker: /(?:what would you like|type your task|ask anything|what can i do for you|act \(tab\)|auto-approve)/i },
    ],
    grok: [
        // Splash chrome ("Grok Build 0.2.112") scrolls away after the FIRST turn;
        // every later screen paints the model + approval mode in the composer's
        // bottom border instead ("Grok 4.5 (high) · always-approve"). Field
        // failure: the link notice delivered against the splash, then every task
        // message sat queued because no splash-era marker existed anymore — a
        // marker must match the chrome that persists across turns, never only
        // the welcome screen. Cline uses the cursor-prefix proof. Grok uses the
        // bottom-most composer-row proof because packaged Windows can park its VT
        // cursor on the footer after a completed turn.
        {
            marker: /(?:ask anything|grok build|grok cli|grok \d+(?:\.\d+)* ?\(|always-approve)/i,
            // Grok 1.0 on packaged Windows can park the VT cursor on its footer
            // after a completed turn or after the pane loses focus. The visible
            // bottom-most bordered `❯` row still owns the composer. Transcript
            // previews may also contain `❯`, but a non-empty bottom-most candidate
            // cannot satisfy emptyLine, and TerminalScreenModel separately vetoes
            // Grok's live Windows spinner/title state.
            composerLine: /^[\s│┃|]*[>❯›](?:\s|$)/u,
            emptyLine: /^[\s│┃|]*[>❯›]\s*(?:[│┃|])?\s*$/u,
            allowMutedGhostLine: true,
        },
    ],
    qwen: [
        { marker: /(?:type your message|enter a prompt)/i, empty: /(?:type your message|enter a prompt)\s*$/i },
    ],
    // Hermes 0.17 (Textual): welcome says "Welcome to Hermes Agent! Type your
    // message…"; after the splash scrolls away the status bar + YOLO chrome
    // persist above a bordered `❯` composer. The old "Ask me anything / Try …"
    // empty regex never matched current builds, so every link/Team delivery to
    // Hermes sat queued forever (same class of failure as Grok/Cline in
    // docs/common-errors/orchestration/opentui-link-delivery-never-ready.md).
    // Empty-composer proof is the ROW proof: profile launches (hermes-opencode,
    // hermes -p cline) paint the PROFILE NAME before the glyph (`opencode ❯`),
    // and on captured sessions the VT cursor parks on the border row below the
    // composer, so a cursor-prefix rule can neither allow the prefix nor find
    // the glyph on the cursor row. Verified against real hermes 0.17 default +
    // opencode-profile sessions (tests/fixtures/terminal/hermes-0.17-*.b64):
    // the bottom-most `[profile] ❯` row is the live composer; transcript
    // renders past prompts as `● …` bubbles, never bare `❯` rows.
    hermes: [
        {
            // `⚕` is the persistent status-bar glyph Hermes paints every turn (with
            // or without YOLO). Splash-only phrases stay as alternates so a mid-turn
            // screen that still has the welcome banner also matches.
            marker: /(?:Welcome to Hermes Agent|Type your message|Hermes Agent|⚕|⚠\s*YOLO|\bYOLO\b|Ask me anything|Try "(?:explain|write|refactor|fix|how)|Try "\/help")/i,
            composerLine: /^[\s│┃|]*(?:[\w.-]+\s+)?[>❯›](?:\s|$)/u,
            emptyLine: /^[\s│┃|]*(?:[\w.-]+\s+)?[>❯›]\s*$/u,
        },
    ],
    // Antigravity CLI (`agy` 1.1.10, captured PTY bytes — tests/fixtures/
    // terminal/agy-1.1-*.b64): fixed alt-screen layout whose `Antigravity CLI`
    // header persists across turns and whose `? for shortcuts` footer returns
    // after every turn (busy swaps it for `esc to cancel`, and the header still
    // proves the marker). The old "type your message / ask anything" rules
    // matched nothing this TUI ever paints. Like Cursor, agy parks the VT
    // cursor on the composer box's BOTTOM BORDER row — never on the `>` row —
    // so a cursor-prefix rule can never match and the row proof is the only
    // positive evidence: the bottom-most `>` row is the live composer, while
    // transcript echoes (`> reply with…`) sit above it and always carry text,
    // so they can never prove the composer empty.
    antigravity: [
        {
            marker: /(?:Antigravity CLI|Antigravity Starter Quota|\? for shortcuts)/i,
            composerLine: /^\s*>(?:\s|$)/u,
            emptyLine: /^\s*>\s*$/u,
        },
    ],
    amp: [
        { marker: /(?:what do you want|type a message|ask anything)/i, empty: /(?:what do you want|type a message|ask anything)\s*$/i },
    ],
    // Pi (@earendil-works/pi-coding-agent) — VERBATIM node-pty captures at
    // 120x30 (tests/fixtures/terminal/pi-0.82-*.b64: idle / typed draft /
    // completed turn / mid-turn spinner / model selector). Pi is an INLINE TUI:
    // it streams the transcript as ordinary lines and repaints only a bordered
    // composer plus a two-line footer via cursor-up.
    //
    // The composer has NO prompt glyph — an empty one is a blank row between two
    // `────` borders, with the caret drawn as a reverse-video cell — so there is
    // nothing for a composerLine/emptyLine row rule to anchor on. Pi does keep
    // the VT cursor inside the composer on every captured state, so the
    // cursor-prefix proof (below) is the one that applies here.
    //
    // The marker must survive the splash scrolling away, so it matches the
    // footer's context ratio (`0.0%/262k (auto)`, `?/262k` right after a
    // compaction) as well as the ` pi v0.82.0` header.
    //
    // Busy is NOT special-cased: pi keeps its empty composer mounted while a
    // turn runs, but its Loader repaints a spinner every 80ms, so the shared
    // screen-quiet gate (350ms) can never see a busy screen as settled.
    pi: [
        { marker: /(?:\bpi v\d+\.\d+|(?:\d+(?:\.\d+)?%|\?)\/\d+(?:\.\d+)?[kM]?\b)/i },
    ],
    cursor: [
        // Cursor Agent's welcome composer and its post-turn composer use
        // different ghost placeholders.
        //
        // Cursor is the one supported agent that HIDES the terminal cursor: its
        // stream ends with DECTCEM `ESC[?25l`, never re-shows it, and uses zero
        // absolute positioning (it repaints relatively with CR/LF), so the VT
        // cursor is left parked on the row below the footer. `cursorBefore` is
        // therefore always '' and a cursor-prefix rule can NEVER match — which is
        // why every link delivery to Cursor sat queued forever while Claude,
        // Codex, Cline and Grok (all of which keep the real cursor in their
        // composer) delivered fine.
        //
        // The row proof is also strictly safer here: typing replaces the ghost
        // placeholder outright (`→ remember to buy milk`), so a draft cannot look
        // empty — verified against a live cursor-agent PTY.
        {
            marker: /(?:Plan, search, build anything|Add a follow-up)/i,
            composerLine: /→/u,
            emptyLine: /^\s*→\s+(?:Plan, search, build anything|Add a follow-up)\s*$/i,
        },
    ],
};
exports.AGENT_CURSOR_COMPOSER_PREFIX = {
    'claude-command': /^\s*[>❯]\s*$/u,
    codex: /^\s*[›]\s*$/u,
    // OpenCode's cursor row starts with only the left box border (`┃  `).
    // Unlike Cline/Grok, this composer has no prompt glyph.
    opencode: /^[\s│┃|]*$/u,
    // OpenTUI composers: box border glyphs may precede the prompt glyph on the
    // cursor row (`│ ❯ `). Mirrors the renderer's PROMPT_MARKER_RE, which is
    // the proven shape for these TUIs (terminalStore native prompt reads).
    cline: /^[\s│┃|]*[>❯›]\s*$/u,
    // Grok uses the bottom-most composer-row proof above because packaged
    // Windows does not consistently leave the VT cursor inside the composer.
    // No `hermes` rule: profile launches paint `opencode ❯` (profile name
    // before the glyph) and park the VT cursor on the border row below the
    // composer, so hermes's proof is the composerLine/emptyLine pair above.
    // No `cursor` rule: Cursor hides the terminal cursor, so there is no cursor
    // row to read. Its proof is the composerLine/emptyLine pair above.
    //
    // Pi's composer row carries no prompt glyph at all, so an empty composer is
    // a cursor parked at column 0 of a blank row. That is only safe because pi
    // also parks the cursor on a NON-blank row for every other focus target it
    // owns — the `/` slash popup and the `/model` selector both put it after a
    // typed search glyph (`/`, `>`), which this rule rejects — and because the
    // footer marker above must be on screen at the same time.
    pi: /^\s*$/u,
};
/**
 * Box-drawing chrome (U+2500–U+257F): an OpenTUI composer paints its RIGHT
 * border on the cursor row too, so the after-cursor scan must treat border
 * glyphs as chrome, never as typed content. ASCII '|' is deliberately NOT
 * here — a user can type it.
 */
const BOX_DRAWING_ONLY_RE = /^[\u2500-\u257F]+$/u;
/**
 * Evaluate positive, generation-current composer evidence.
 *
 * The caller owns VT reconstruction and supplies only the current screen and
 * current cursor row. Old transcript text, a configured regex, and a timeout
 * never become readiness by themselves.
 */
function evaluateAgentComposerReadiness(kind, evidence) {
    const markers = kind ? exports.AGENT_READY_MARKERS[kind] : undefined;
    if (!markers?.length)
        return { ready: false, markerKnown: false };
    const applicable = markers.filter(({ marker }) => marker.test(evidence.screen));
    if (applicable.length === 0)
        return { ready: false, markerKnown: false };
    // Composer-row proof first: an agent that hides the terminal cursor has no
    // cursor row to read, so this is its ONLY positive evidence.
    const rowRules = applicable.filter((rule) => rule.composerLine && rule.emptyLine);
    if (rowRules.length > 0) {
        const rows = evidence.screenRows ?? evidence.screen.split('\n').map((text) => ({
            text,
            cells: [],
        }));
        const ready = rowRules.some(({ composerLine, emptyLine, allowMutedGhostLine }) => {
            // Bottom-most candidate row is the live composer; anything above it is
            // scrollback and must not be able to prove the current composer empty.
            for (let index = rows.length - 1; index >= 0; index -= 1) {
                const row = rows[index];
                if (!composerLine.test(row.text))
                    continue;
                if (emptyLine.test(row.text))
                    return true;
                if (!allowMutedGhostLine || row.cells.length === 0)
                    return false;
                let sawPrompt = false;
                for (const cell of row.cells) {
                    if (!cell)
                        continue;
                    const chars = cell.getChars();
                    if (!sawPrompt) {
                        if (/[>❯›]/u.test(chars))
                            sawPrompt = true;
                        continue;
                    }
                    if (!chars || /^\s*$/u.test(chars))
                        continue;
                    if (BOX_DRAWING_ONLY_RE.test(chars))
                        continue;
                    if (!(0, promptGhostText_1.isMutedGhostCell)(cell))
                        return false;
                }
                return sawPrompt;
            }
            return false;
        });
        return { ready, markerKnown: true };
    }
    const cursorPrefix = kind ? exports.AGENT_CURSOR_COMPOSER_PREFIX[kind] : undefined;
    if (cursorPrefix) {
        if (evidence.cursorBefore === undefined || !cursorPrefix.test(evidence.cursorBefore)) {
            return { ready: false, markerKnown: true };
        }
        for (const cell of evidence.cursorAfter ?? []) {
            const chars = cell.getChars();
            if (!chars || /^\s*$/u.test(chars))
                continue;
            if (BOX_DRAWING_ONLY_RE.test(chars))
                continue;
            if (!(0, promptGhostText_1.isMutedGhostCell)(cell))
                return { ready: false, markerKnown: true };
        }
        return { ready: true, markerKnown: true };
    }
    return {
        ready: applicable.some(({ empty }) => empty?.test(evidence.screen) === true),
        markerKnown: true,
    };
}
function hasKnownReadyMarker(kind) {
    return !!kind && !!exports.AGENT_READY_MARKERS[kind]?.length;
}
