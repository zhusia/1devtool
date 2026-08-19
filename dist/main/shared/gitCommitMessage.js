"use strict";
/**
 * Pure helpers for the git client's "Generate Commit Message" feature (the
 * sparkle button next to the commit summary input). The main process gathers
 * the diff and spawns a headless AI CLI; everything string-shaped lives here
 * so it stays unit-testable and renderer-safe (no Node globals).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMMIT_DIFF_CHAR_MIN = exports.COMMIT_DIFF_CHAR_CAP = exports.COMMIT_MESSAGE_AGENT_ORDER = void 0;
exports.clampDiffCharLimit = clampDiffCharLimit;
exports.buildCommitMessagePrompt = buildCommitMessagePrompt;
exports.parseCommitMessageOutput = parseCommitMessageOutput;
/**
 * Agents tried in order when the caller doesn't pin one. Every id must be a
 * HEADLESS_SPECS key; the CLI registry narrows this to the ones installed.
 */
exports.COMMIT_MESSAGE_AGENT_ORDER = [
    'claude',
    'codex',
    'gemini',
    'opencode',
    'cursor',
    'qwen',
    'grok',
    'amp',
    'agy',
    'cline',
    'hermes',
    'pi',
    'aider',
];
/**
 * Most headless CLIs take the prompt as an argv value, and Windows caps the
 * whole CreateProcess command line at ~32,767 chars. The diff body is capped
 * here; the per-file `--stat` summary is never truncated, so large diffs
 * still describe every touched file. This is a hard ceiling — the user's
 * configurable limit clamps to it, never past it.
 */
exports.COMMIT_DIFF_CHAR_CAP = 24_000;
exports.COMMIT_DIFF_CHAR_MIN = 1_000;
function clampDiffCharLimit(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return exports.COMMIT_DIFF_CHAR_CAP;
    return Math.min(Math.max(Math.round(value), exports.COMMIT_DIFF_CHAR_MIN), exports.COMMIT_DIFF_CHAR_CAP);
}
const STYLE_RULES = {
    conventional: [
        '- Conventional Commits: `type(scope): subject` or `type: subject`, with type one of feat, fix, refactor, perf, docs, test, build, ci, chore, style.',
        '- First line: imperative mood, at most 72 characters, no trailing period.',
    ],
    plain: [
        '- Plain style: a short imperative summary with NO type prefix (no `feat:`/`fix:`) and no emoji.',
        '- First line: imperative mood, at most 72 characters, no trailing period.',
    ],
    gitmoji: [
        '- Gitmoji style: start the first line with one fitting emoji (e.g. ✨ 🐛 ♻️ 📝 ✅ 🔧), then a short imperative summary.',
        '- First line: at most 72 characters total, no trailing period.',
    ],
};
function buildCommitMessagePrompt(input) {
    const parts = [
        'Write a git commit message for the change below.',
        '',
        'Rules:',
        ...STYLE_RULES[input.style ?? 'conventional'],
        '- If the change needs explanation, add a blank line and a short body (what changed and why), wrapped at 72 columns. Skip the body for trivial changes.',
        '- Output ONLY the raw commit message. No markdown, no code fences, no commentary, no surrounding quotes.',
    ];
    const avoid = (input.avoidSummaries ?? []).map((s) => s.trim()).filter(Boolean);
    if (avoid.length > 0) {
        parts.push('- The user asked to regenerate: write a message meaningfully different from these earlier suggestions:');
        for (const s of avoid)
            parts.push(`  - ${s}`);
    }
    const stat = input.diffStat?.trim();
    if (stat)
        parts.push('', 'Changed files:', stat);
    const untracked = (input.untrackedFiles ?? []).filter(Boolean);
    if (untracked.length > 0) {
        parts.push('', 'New (untracked) files this commit will add:', ...untracked.map((f) => `- ${f}`));
    }
    const diff = input.diff.trim();
    if (diff) {
        const cap = clampDiffCharLimit(input.diffCharLimit);
        parts.push('', 'Diff:', diff.length > cap
            ? `${diff.slice(0, cap)}\n[diff truncated — the full change list is in "Changed files" above]`
            : diff);
    }
    return parts.join('\n');
}
const CONVENTIONAL_SUBJECT = /^[a-z]+(\([^)]*\))?!?: \S/;
/**
 * Extract `{ summary, description }` from a headless CLI's stdout. Tolerates
 * the common deviations from "raw message only": wrapping code fences, a
 * chatty prose preamble, surrounding quotes, and CRLF line endings.
 */
function parseCommitMessageOutput(raw) {
    let text = raw
        .replace(/\[[0-9;]*[A-Za-z]/g, '')
        .replace(/\r\n/g, '\n')
        .trim();
    // Prefer the first fenced block when the CLI wrapped the message anyway.
    const fenced = text.match(/```[a-zA-Z-]*\n([\s\S]*?)\n?```/);
    if (fenced && fenced[1].trim())
        text = fenced[1].trim();
    const lines = text.split('\n');
    // Chatty CLIs sometimes prefix prose ("Here is a commit message:"). When
    // any line looks like a Conventional Commits subject, start there.
    let start = lines.findIndex((line) => CONVENTIONAL_SUBJECT.test(line.trim()));
    if (start === -1)
        start = lines.findIndex((line) => line.trim().length > 0);
    if (start === -1)
        return null;
    const summary = lines[start].trim().replace(/^["'`]+|["'`]+$/g, '');
    if (!summary)
        return null;
    const description = lines
        .slice(start + 1)
        .join('\n')
        .trim();
    return { summary, description };
}
