"use strict";
/**
 * Pure helpers for the Draw tool's "Generate diagram" feature (the prompt bar
 * floating over the Excalidraw canvas). The main process spawns a headless AI
 * CLI and gates its output through `extractDiagramFromOutput`; the renderer
 * converts the extracted source into editable canvas elements. Everything
 * string-shaped lives here so it stays unit-testable and renderer-safe (no
 * Node globals).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DRAW_SKELETON_MAX_ELEMENTS = exports.DRAW_RETRY_ERROR_CHAR_CAP = exports.DRAW_RETRY_FEEDBACK_CHAR_CAP = exports.DRAW_USER_PROMPT_CHAR_CAP = exports.DRAW_DIAGRAM_AGENT_ORDER = void 0;
exports.buildDrawDiagramPrompt = buildDrawDiagramPrompt;
exports.extractDiagramFromOutput = extractDiagramFromOutput;
exports.validateSkeletonJson = validateSkeletonJson;
/**
 * Agents tried in order when the caller doesn't pin one. Every id must be a
 * HEADLESS_SPECS key; the CLI registry narrows this to the ones installed.
 */
exports.DRAW_DIAGRAM_AGENT_ORDER = [
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
 * whole CreateProcess command line at ~32,767 chars. The user's description
 * and the retry-feedback excerpt are the only unbounded inputs, so both are
 * capped; template + caps together stay far below the ceiling.
 */
exports.DRAW_USER_PROMPT_CHAR_CAP = 4_000;
exports.DRAW_RETRY_FEEDBACK_CHAR_CAP = 2_000;
exports.DRAW_RETRY_ERROR_CHAR_CAP = 300;
/** Upper bound on skeleton elements accepted from one generation. */
exports.DRAW_SKELETON_MAX_ELEMENTS = 200;
function buildDrawDiagramPrompt(input) {
    const parts = [
        'Convert the description below into a diagram for an infinite canvas.',
        '',
        'Reply with ONLY one fenced code block — no prose before or after it. Pick the format:',
        '- DEFAULT: a ```mermaid fence — for flows, processes, sequences, hierarchies, and data models.',
        '- ONLY when the description explicitly asks for free-form placement, specific colors, or a board/moodboard layout: a ```json fence containing an array of shape objects (schema below).',
        '',
        'Mermaid rules:',
        '- Default to `flowchart TD`. Use sequenceDiagram, classDiagram, stateDiagram-v2, or erDiagram only when the description clearly calls for one. Never any other diagram type.',
        '- Wrap every node label in double quotes, e.g. A["Create test"]. Keep node ids short (A, B, C1).',
        '- Label decision edges, e.g. -->|"pass"|.',
        '- Prefer 5-20 nodes; break long labels with <br/>.',
        '',
        'JSON shape schema (array items):',
        '- { "type": "rectangle"|"ellipse"|"diamond"|"arrow"|"line"|"text", "id": "n1", "x": 0, "y": 0, "width": 200, "height": 80 }',
        '- Shapes may add "label": {"text": "..."}, "backgroundColor": "#hex", "strokeColor": "#hex", "groupIds": ["g1"].',
        '- Arrows connect shapes by id — "start": {"id": "n1"}, "end": {"id": "n2"} — prefer ids over coordinates.',
        '- Text items use "text": "..." and optional "fontSize": 20.',
        '- Lay shapes out on a grid with no overlaps. At most 200 elements.',
    ];
    const retry = input.retry;
    if (retry) {
        parts.push('', 'Your previous attempt failed to convert with this error:', retry.error.slice(0, exports.DRAW_RETRY_ERROR_CHAR_CAP), 'Previous output (may be truncated):', retry.previousOutput.slice(0, exports.DRAW_RETRY_FEEDBACK_CHAR_CAP), 'Produce a corrected diagram following the same rules.');
    }
    parts.push('', 'Description:', input.userPrompt.slice(0, exports.DRAW_USER_PROMPT_CHAR_CAP));
    return parts.join('\n');
}
/** Matches a diagram-keyword LINE anywhere in a block (preamble recovery). */
const MERMAID_KEYWORD_LINE = /^\s*(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram)\b/m;
/** Start-anchored variant: "this text IS a diagram", not "contains one". */
const MERMAID_KEYWORD_START = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram)\b/;
function classifyFenceBody(body) {
    const trimmed = body.trim();
    if (!trimmed)
        return null;
    if (MERMAID_KEYWORD_START.test(trimmed))
        return 'mermaid';
    if (trimmed.startsWith('[')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed) && parsed.length > 0)
                return 'skeleton';
        }
        catch {
            // Not valid JSON — fall through.
        }
    }
    return null;
}
/**
 * Extract `{ format, source }` from a headless CLI's stdout. Tolerates the
 * common deviations from "one fenced block only": ANSI escapes, CRLF, a
 * chatty prose preamble, multiple fences, and a missing fence entirely.
 * Returns null for refusals/empty output — the caller maps that to a
 * user-facing "no usable diagram" error.
 */
function extractDiagramFromOutput(raw) {
    const text = raw
        .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
        .replace(/\r\n/g, '\n')
        .trim();
    if (!text)
        return null;
    // 1) Fenced blocks, in order. A tagged ```mermaid fence wins outright; any
    //    other fence is classified by its content.
    const fenceRe = /```([a-zA-Z-]*)[^\S\n]*\n([\s\S]*?)\n?```/g;
    let match;
    while ((match = fenceRe.exec(text)) !== null) {
        const tag = match[1].toLowerCase();
        const body = match[2].trim();
        if (!body)
            continue;
        if (tag === 'mermaid')
            return { format: 'mermaid', source: body };
        const classified = classifyFenceBody(body);
        if (classified)
            return { format: classified, source: body };
    }
    // 2) The whole output is the diagram (well-behaved CLI, no fence).
    const whole = classifyFenceBody(text);
    if (whole)
        return { format: whole, source: text };
    // 3) Chatty preamble before an unfenced mermaid diagram: start at the first
    //    diagram-keyword line. (No JSON equivalent — bare arrays after prose are
    //    indistinguishable from prose examples.)
    const lines = text.split('\n');
    const start = lines.findIndex((line) => MERMAID_KEYWORD_LINE.test(line));
    if (start !== -1) {
        const rest = lines.slice(start);
        const closing = rest.findIndex((line) => line.trim().startsWith('```'));
        const source = (closing === -1 ? rest : rest.slice(0, closing)).join('\n').trim();
        if (source)
            return { format: 'mermaid', source };
    }
    return null;
}
const SKELETON_SHAPE_TYPES = new Set(['rectangle', 'ellipse', 'diamond']);
const SKELETON_LINEAR_TYPES = new Set(['arrow', 'line']);
const SKELETON_ALL_TYPES = new Set([...SKELETON_SHAPE_TYPES, ...SKELETON_LINEAR_TYPES, 'text']);
const SKELETON_MIN_SIZE = 16;
const SKELETON_MAX_SIZE = 4_000;
const SKELETON_LABEL_CHAR_CAP = 300;
function finiteNumber(value) {
    const n = typeof value === 'string' ? Number(value) : value;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
function clampSize(value) {
    const n = finiteNumber(value) ?? 0;
    return Math.min(Math.max(n, SKELETON_MIN_SIZE), SKELETON_MAX_SIZE);
}
function sanitizeColor(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 32 ? value : undefined;
}
function sanitizeBinding(value, knownIds) {
    if (!value || typeof value !== 'object')
        return undefined;
    const id = value.id;
    return typeof id === 'string' && knownIds.has(id) ? { id } : undefined;
}
/**
 * Parse and sanitize an AI-emitted skeleton array. Model output is hostile
 * input: unknown types are dropped, numbers coerced and clamped, colors and
 * labels bounded, arrow bindings restricted to ids that survived validation,
 * and the element count capped. Fails (rather than inserting nothing) when no
 * element survives so the conversion-retry loop gets useful feedback.
 */
function validateSkeletonJson(source) {
    let parsed;
    try {
        parsed = JSON.parse(source);
    }
    catch (err) {
        return { ok: false, error: `Skeleton JSON did not parse: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!Array.isArray(parsed)) {
        return { ok: false, error: 'Skeleton JSON must be an array of shape objects.' };
    }
    const candidates = parsed.slice(0, exports.DRAW_SKELETON_MAX_ELEMENTS);
    // First pass: collect the ids of elements that will survive, so arrow
    // bindings can be restricted to real targets in the second pass.
    const knownIds = new Set();
    for (const el of candidates) {
        if (!el || typeof el !== 'object')
            continue;
        const { type, id } = el;
        if (typeof type === 'string' && SKELETON_ALL_TYPES.has(type) && typeof id === 'string') {
            knownIds.add(id);
        }
    }
    const skeletons = [];
    for (const el of candidates) {
        if (!el || typeof el !== 'object')
            continue;
        const src = el;
        const type = src.type;
        if (typeof type !== 'string' || !SKELETON_ALL_TYPES.has(type))
            continue;
        const start = sanitizeBinding(src.start, knownIds);
        const end = sanitizeBinding(src.end, knownIds);
        // Bound arrows may omit coordinates; everything else needs a position.
        const x = finiteNumber(src.x) ?? (start && end ? 0 : null);
        const y = finiteNumber(src.y) ?? (start && end ? 0 : null);
        if (x === null || y === null)
            continue;
        const out = { type, x, y };
        if (typeof src.id === 'string')
            out.id = src.id;
        if (SKELETON_SHAPE_TYPES.has(type)) {
            out.width = clampSize(src.width);
            out.height = clampSize(src.height);
        }
        else if (SKELETON_LINEAR_TYPES.has(type)) {
            const w = finiteNumber(src.width);
            const h = finiteNumber(src.height);
            if (w !== null)
                out.width = Math.min(Math.max(w, -SKELETON_MAX_SIZE), SKELETON_MAX_SIZE);
            if (h !== null)
                out.height = Math.min(Math.max(h, -SKELETON_MAX_SIZE), SKELETON_MAX_SIZE);
            if (start)
                out.start = start;
            if (end)
                out.end = end;
        }
        else {
            // text
            const textValue = src.text;
            if (typeof textValue !== 'string' || !textValue.trim())
                continue;
            out.text = textValue.slice(0, SKELETON_LABEL_CHAR_CAP);
            const fontSize = finiteNumber(src.fontSize);
            if (fontSize !== null)
                out.fontSize = Math.min(Math.max(fontSize, 8), 96);
        }
        const label = src.label;
        if (label && typeof label === 'object') {
            const labelText = label.text;
            if (typeof labelText === 'string' && labelText.trim()) {
                out.label = { text: labelText.slice(0, SKELETON_LABEL_CHAR_CAP) };
            }
        }
        const backgroundColor = sanitizeColor(src.backgroundColor);
        if (backgroundColor)
            out.backgroundColor = backgroundColor;
        const strokeColor = sanitizeColor(src.strokeColor);
        if (strokeColor)
            out.strokeColor = strokeColor;
        if (Array.isArray(src.groupIds)) {
            const groupIds = src.groupIds.filter((g) => typeof g === 'string').slice(0, 8);
            if (groupIds.length > 0)
                out.groupIds = groupIds;
        }
        skeletons.push(out);
    }
    if (skeletons.length === 0) {
        return { ok: false, error: 'No valid shape objects survived validation — use the documented schema.' };
    }
    return { ok: true, skeletons };
}
