"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RELAXED_MIN_PTY_AGE_MS = exports.STRICT_INPUT_LOOKBACK_MS = exports.STRICT_LAUNCH_WINDOW_MS = exports.DETECT_TIME_GRACE_MS = void 0;
exports.normalizeComparablePath = normalizeComparablePath;
exports.normalizePromptForSessionOwnership = normalizePromptForSessionOwnership;
exports.selectSessionForTerminal = selectSessionForTerminal;
/**
 * Pure session-selection logic for terminal session detection.
 *
 * Extracted from ResumeManager so the matching rules (strict/relaxed passes,
 * claim arbitration, path normalization) are unit-testable without pulling in
 * electron/better-sqlite3. ResumeManager owns scanning and the claims map;
 * this module only decides which scanned session a terminal should bind to.
 *
 * Ownership guards (see
 * docs/common-errors/terminals/session-detect-remount-disarm-steal.md):
 * detection re-arms on every pane remount with the ORIGINAL PTY spawn time, so
 * a long-lived idle terminal would otherwise strict-match every session born
 * after its spawn — including a neighbor terminal's brand-new conversation.
 * The strict pass therefore also requires plausibility that THIS terminal
 * originated the session (born at launch, or the user submitted input here
 * near the session's start). The relaxed pass requires a minimum PTY age: a
 * seconds-old terminal cannot have user-resumed an older conversation yet, so
 * without the age gate it would steal the still-streaming session of whichever
 * terminal hadn't claimed its own yet.
 *
 * Timestamp/cwd evidence still cannot distinguish sessions launched together
 * in 1DevTool and an external shell. Strict claims therefore also match the
 * session's first prompt against prompts captured from this exact PTY (see
 * session-detect-external-title-collision.md). Missing/ambiguous attribution
 * yields no strict claim; a default tab name is safer than a wrong binding.
 */
/**
 * Sessions may be written up to 10s BEFORE pty.create() captures ptyStartedAt
 * (the CLI stamps session_meta first), so all time comparisons allow this grace.
 */
exports.DETECT_TIME_GRACE_MS = 10_000;
/**
 * Strict pass: a session counts as "born at launch" when it starts within this
 * window of the PTY spawn — covers `claude "initial prompt"` startup commands
 * and users who type immediately, with headroom for slow CLI boots.
 */
exports.STRICT_LAUNCH_WINDOW_MS = 120_000;
/**
 * Strict pass: otherwise the terminal must have received Enter-bearing user
 * input no earlier than this long before the session started. The first
 * prompt's submit and the session file's birth are near-simultaneous; the
 * window absorbs clock skew and agents that stamp session_meta early.
 */
exports.STRICT_INPUT_LOOKBACK_MS = 120_000;
/**
 * Relaxed pass: minimum PTY age before a terminal may bind an OLDER session it
 * has no prior claim on (i.e. "the user resumed an old conversation inside
 * this terminal"). Booting a TUI and picking a session takes longer than this;
 * a younger terminal matching an actively-written old session is almost
 * certainly looking at another terminal's live conversation.
 */
exports.RELAXED_MIN_PTY_AGE_MS = 30_000;
/** Normalize a path for comparison: forward slashes, no trailing separators, lowercase on Windows. */
function normalizeComparablePath(p, isWindows = false) {
    let normalized = p.replace(/[\\/]+$/, '').replace(/\\/g, '/');
    if (isWindows) {
        normalized = normalized.toLowerCase();
    }
    return normalized;
}
const OWNERSHIP_PROMPT_TRUNCATION_FLOOR = 240;
/** Normalize agent transport wrappers without applying display-only title formatting. */
function normalizePromptForSessionOwnership(value) {
    const withoutSystemTags = value
        .replace(/<(?:system-reminder|local-command-caveat|local-command-stdout|command-name|command-message|command-args)[^>]*>[\s\S]*?<\/(?:system-reminder|local-command-caveat|local-command-stdout|command-name|command-message|command-args)>/gi, ' ')
        .replace(/<(?:system-reminder|local-command-caveat|local-command-stdout|command-name|command-message|command-args)[^>]*\/>/gi, ' ');
    const wrapped = withoutSystemTags.match(/<(?:user_input|user_query)\b[^>]*>([\s\S]*?)<\/(?:user_input|user_query)>/i);
    return (wrapped?.[1] ?? withoutSystemTags)
        .replace(/<\/?(?:user_input|user_query)\b[^>]*>/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function promptMatchesSessionFirstPrompt(firstPrompt, submittedPrompt) {
    const sessionPrompt = normalizePromptForSessionOwnership(firstPrompt);
    const terminalPrompt = normalizePromptForSessionOwnership(submittedPrompt);
    if (!sessionPrompt || !terminalPrompt)
        return false;
    if (sessionPrompt === terminalPrompt)
        return true;
    // Session scanners intentionally cap firstPrompt (normally at 300 chars).
    // Accept only a long capped prefix; short prefix matching is too weak for
    // ownership and can collide across neighboring/external sessions.
    return (sessionPrompt.length >= OWNERSHIP_PROMPT_TRUNCATION_FLOOR && terminalPrompt.startsWith(sessionPrompt))
        || (terminalPrompt.length >= OWNERSHIP_PROMPT_TRUNCATION_FLOOR && sessionPrompt.startsWith(terminalPrompt));
}
function isExplicitResumeIntent(prompt) {
    const normalized = normalizePromptForSessionOwnership(prompt);
    return /^\/resume(?:\s|$)/i.test(normalized)
        || /^(?:claude|codex|gemini|qwen|opencode|cline|grok|hermes)\s+(?:resume|--resume|--id)(?:\s|$)/i.test(normalized)
        || /^pi\s+(?:-r|--resume|--session|--continue|-c)(?:\s|$)/i.test(normalized)
        || /^kimi\s+(?:--session|-S|-r|--resume)(?:\s|$)/i.test(normalized);
}
function selectSessionForTerminal(args) {
    const { terminalId, agentType, projectPath, startedAfter, sessions, claims, isWindows = false, geminiProjectName = null, lastSubmitAt = null, submittedPrompts = [], now = Date.now(), } = args;
    const grace = startedAfter - exports.DETECT_TIME_GRACE_MS;
    const pp = projectPath ? normalizeComparablePath(projectPath, isWindows) : '';
    const exactCwdMatch = (s) => {
        if (!pp)
            return true;
        const sCwd = s.cwd ? normalizeComparablePath(s.cwd, isWindows) : '';
        const sProject = s.projectPath ? normalizeComparablePath(s.projectPath, isWindows) : '';
        if (sCwd === pp || sProject === pp)
            return true;
        if (geminiProjectName && s.projectPath === geminiProjectName)
            return true;
        return false;
    };
    // Relaxed-only: the user may have cd'd into a subfolder before launching the
    // agent, so the session cwd sits below the terminal cwd.
    const subdirCwdMatch = (s) => {
        if (!pp)
            return false;
        const sCwd = s.cwd ? normalizeComparablePath(s.cwd, isWindows) : '';
        return Boolean(sCwd && sCwd.startsWith(pp + '/'));
    };
    const claimKeyOf = (session) => `${agentType}:${session.id}`;
    const isClaimedByThisTerminal = (session) => claims.get(claimKeyOf(session)) === terminalId;
    const claimIfFree = (session) => {
        const claimKey = claimKeyOf(session);
        const existing = claims.get(claimKey);
        if (existing && existing !== terminalId)
            return false;
        claims.set(claimKey, terminalId);
        return true;
    };
    // Strict-only ownership plausibility: could THIS terminal have originated
    // the session? Either it was born at launch (startup-command prompt /
    // immediate typing), or the user submitted input here around its birth.
    // Without this, every unbound terminal strict-matches every session younger
    // than its own spawn — first scanner wins, wrong tab gets the name.
    const plausiblyOriginatedHere = (s) => {
        if (s.startedAt <= startedAfter + exports.STRICT_LAUNCH_WINDOW_MS)
            return true;
        return lastSubmitAt != null && lastSubmitAt >= s.startedAt - exports.STRICT_INPUT_LOOKBACK_MS;
    };
    // Strict pass: fresh sessions this terminal plausibly originated, closest to
    // the terminal's own input activity (fallback: its spawn) first.
    const strictAnchor = lastSubmitAt ?? startedAfter;
    const strict = sessions
        .filter((s) => exactCwdMatch(s) && s.startedAt >= grace && plausiblyOriginatedHere(s))
        .sort((a, b) => Math.abs(a.startedAt - strictAnchor) - Math.abs(b.startedAt - strictAnchor));
    // A seeded/self claim is already authoritative (native auto-resume/re-read).
    const selfClaimedStrict = strict.find(isClaimedByThisTerminal);
    if (selfClaimedStrict)
        return { session: selfClaimedStrict, pass: 'strict' };
    // Cwd + broad timestamp windows are not identity: an external Claude/Codex
    // launched beside several app terminals satisfies them too. Require the
    // first prompt to be one this exact PTY submitted. If two sessions have the
    // same first prompt, refuse both rather than guessing by milliseconds.
    const promptMatchedStrict = strict.filter((session) => !claims.has(claimKeyOf(session)) &&
        submittedPrompts.some((prompt) => promptMatchesSessionFirstPrompt(session.firstPrompt, prompt)));
    if (promptMatchedStrict.length === 1 && claimIfFree(promptMatchedStrict[0])) {
        return { session: promptMatchedStrict[0], pass: 'strict' };
    }
    if (promptMatchedStrict.length > 1) {
        return null;
    }
    // Relaxed pass: old sessions with fresh writes, most recently active first.
    // `startedAt < grace` keeps the two candidate sets disjoint. A terminal
    // younger than RELAXED_MIN_PTY_AGE_MS may only re-bind a session it already
    // owns (auto-resume relaunch) — never adopt an unclaimed one. An unclaimed
    // relaxed adoption also requires an explicit resume command captured from
    // this PTY; age + generic Enter activity can still describe an external
    // live session after the user sends a normal first prompt here.
    const ptyAgeOk = now - startedAfter >= exports.RELAXED_MIN_PTY_AGE_MS;
    const hasExplicitResumeIntent = submittedPrompts.some(isExplicitResumeIntent);
    const relaxed = sessions
        .filter((s) => s.startedAt < grace &&
        s.lastActivityAt >= grace &&
        (exactCwdMatch(s) || subdirCwdMatch(s)) &&
        (isClaimedByThisTerminal(s) || (ptyAgeOk && lastSubmitAt != null && hasExplicitResumeIntent)))
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    for (const session of relaxed) {
        if (claimIfFree(session))
            return { session, pass: 'relaxed' };
    }
    return null;
}
