"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cancelPrototypeGeneration = cancelPrototypeGeneration;
exports.generatePrototype = generatePrototype;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
let activeProcess = null;
function cancelPrototypeGeneration() {
    if (activeProcess) {
        activeProcess.kill('SIGTERM');
        activeProcess = null;
    }
}
async function generatePrototype(request, onProgress, onSpec) {
    const { agent } = request;
    const fullPrompt = buildPrototypePrompt(request);
    onProgress?.('Starting AI generation...');
    const agentCommand = getAgentCommand(agent, request.skipPermissions);
    if (!agentCommand) {
        return { ok: false, error: `Agent "${agent}" CLI not found. Install it first.` };
    }
    try {
        onProgress?.(`Calling ${agent}...`);
        const output = await runAgentCLI(agentCommand, fullPrompt, onProgress);
        onProgress?.('Parsing response...');
        const parsed = parseSpecFromOutput(output, request.currentSpec ?? null);
        if (!parsed.spec) {
            return {
                ok: false,
                error: parsed.validationError
                    ? `AI returned an invalid prototype spec: ${parsed.validationError}`
                    : 'AI returned no valid prototype spec',
            };
        }
        onSpec?.(parsed.spec);
        onProgress?.('Prototype generated');
        return { ok: true, spec: parsed.spec };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'AI generation failed',
        };
    }
}
function buildPrototypePrompt(request) {
    const promptParts = [
        'You generate polished desktop app prototypes as valid JSON specs using the shadcn component catalog.',
        '',
        'Return ONLY one valid JSON object. No markdown, no prose, no code fences.',
        '',
        'The response must match this shape:',
        '{',
        '  "root": "main",',
        '  "elements": {',
        '    "main": {',
        '      "type": "Card",',
        '      "props": {},',
        '      "children": []',
        '    }',
        '  },',
        '  "state": {}',
        '}',
        '',
        'Use only these component types:',
        'Card, Stack, Grid, Separator, Tabs, Accordion, Collapsible, Dialog, Drawer, Carousel, Table, Heading, Text, Image, Avatar, Badge, Alert, Progress, Skeleton, Spinner, Tooltip, Popover, Input, Textarea, Select, Checkbox, Radio, Switch, Slider, Button, Link, DropdownMenu, Toggle, ToggleGroup, ButtonGroup, Pagination.',
        '',
        'Use these exact prop names and enum values when relevant:',
        '- Card: title?, description?, maxWidth? sm|md|lg|full, centered?, className?',
        '- Stack: direction? horizontal|vertical, gap? none|sm|md|lg|xl, align? start|center|end|stretch, justify? start|center|end|between|around',
        '- Grid: columns?, gap? sm|md|lg|xl, className?',
        '- Tabs: tabs [{ label, value }], defaultValue?, value?',
        '- Table: columns string[], rows string[][], caption?',
        '- Heading: text, level? h1|h2|h3|h4',
        '- Text: text, variant? body|caption|muted|lead|code',
        '- Avatar: src?, name, size? sm|md|lg',
        '- Badge: text, variant? default|secondary|destructive|outline',
        '- Alert: title, message?, type? success|info|warning|error',
        '- Progress: value, max?, label?',
        '- Button: label, variant? primary|secondary|danger, disabled?',
        '- Link: label, href',
        '- Input: label, name, type? text|email|password|number, placeholder?, value?',
        '- Textarea: label, name, placeholder?, rows?, value?',
        '- Select: label, name, options string[], placeholder?, value?',
        '- Checkbox: label, name, checked?',
        '- Radio: label, name, options string[], value?',
        '- Switch: label, name, checked?',
        '- Slider: label?, min?, max?, step?, value?',
        '',
        'Rules:',
        '- Every element must include type, props, and children. Leaf elements use children: [].',
        '- root must point to an existing element key.',
        '- Build IDE layouts from Card, Stack, Grid, Tabs, Table, Badge, Button, Input, Text, Heading, and Separator. Do not invent custom panel or terminal component types.',
        '- Use state for interactive values. Read with { "$state": "/path" } and bind inputs with { "$bindState": "/path" }.',
        '- If you use repeated list content, use the top-level repeat field with statePath and optional key.',
        '- Populate the screen with realistic sample data.',
    ];
    if (request.currentSpec) {
        promptParts.push('');
        promptParts.push('Current prototype JSON:');
        promptParts.push(JSON.stringify(request.currentSpec, null, 2));
        promptParts.push('');
        promptParts.push('Modify the current prototype and return the full updated JSON object, not a patch.');
    }
    promptParts.push('');
    promptParts.push(`User request: ${request.prompt}`);
    if (request.fileContents && request.fileContents.length > 0) {
        promptParts.push('');
        promptParts.push('FILE CONTEXT');
        promptParts.push('Use these files as context for the prototype. Do not quote them back unless needed.');
        for (const file of request.fileContents) {
            promptParts.push('');
            promptParts.push(`--- ${file.path} ---`);
            promptParts.push(file.content);
        }
    }
    return promptParts.join('\n');
}
function getAgentCommand(agent, skipPermissions) {
    switch (agent) {
        case 'claude':
            return { cmd: 'claude', args: skipPermissions ? ['-p', '--dangerously-skip-permissions'] : ['-p'] };
        case 'codex':
            return {
                cmd: 'codex',
                args: skipPermissions
                    ? ['exec', '--skip-git-repo-check', '--color', 'never', '--full-auto']
                    : ['exec', '--skip-git-repo-check', '--color', 'never'],
                outputFileMode: 'last-message',
            };
        case 'gemini':
            return { cmd: 'gemini', args: [] };
        case 'kimi':
            return { cmd: 'kimi', args: ['-p'], promptAsArgument: true };
        case 'hermes':
            return { cmd: 'hermes', args: ['-z'], promptAsArgument: true };
        default:
            return null;
    }
}
function runAgentCLI(command, prompt, onProgress) {
    return new Promise((resolve, reject) => {
        const tempDir = command.outputFileMode === 'last-message'
            ? fs_1.default.mkdtempSync(path_1.default.join(os_1.default.tmpdir(), 'prototype-codex-'))
            : null;
        const outputPath = tempDir ? path_1.default.join(tempDir, 'last-message.txt') : null;
        const baseArgs = outputPath ? [...command.args, '--output-last-message', outputPath] : command.args;
        const args = command.promptAsArgument ? [...baseArgs, prompt] : baseArgs;
        // Pass prompt via stdin instead of CLI arg — avoids issues with
        // special characters, newlines, and argument length limits.
        const child = (0, child_process_1.spawn)(command.cmd, args, {
            stdio: [command.promptAsArgument ? 'ignore' : 'pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                PATH: getEnrichedPath(),
            },
            timeout: 120000,
        });
        // Write prompt to stdin and close
        if (!command.promptAsArgument) {
            child.stdin?.write(prompt);
            child.stdin?.end();
        }
        activeProcess = child;
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (data) => {
            const chunk = data.toString();
            stdout += chunk;
            if (chunk.includes('Thinking') || chunk.includes('thinking') || chunk.length > 50) {
                onProgress?.('AI is generating prototype...');
            }
        });
        child.stderr?.on('data', (data) => {
            stderr += data.toString();
        });
        child.on('error', (error) => {
            activeProcess = null;
            cleanupTempDir(tempDir);
            if (error.code === 'ENOENT') {
                reject(new Error(`Command "${command.cmd}" not found. Make sure it's installed and in your PATH.`));
            }
            else {
                reject(error);
            }
        });
        child.on('close', (code) => {
            activeProcess = null;
            const finalOutput = outputPath && fs_1.default.existsSync(outputPath)
                ? fs_1.default.readFileSync(outputPath, 'utf8')
                : stdout;
            cleanupTempDir(tempDir);
            if (code === 0 || finalOutput.length > 0) {
                resolve(finalOutput);
            }
            else {
                reject(new Error(stderr || `${command.cmd} exited with code ${code}`));
            }
        });
    });
}
function cleanupTempDir(tempDir) {
    if (!tempDir)
        return;
    try {
        fs_1.default.rmSync(tempDir, { recursive: true, force: true });
    }
    catch {
        // Ignore temp cleanup issues.
    }
}
function parseSpecFromOutput(output, currentSpec) {
    const streamedSpec = parsePatchSpec(output, currentSpec);
    if (streamedSpec.spec) {
        return streamedSpec;
    }
    const jsonMatch = output.match(/\{[\s\S]*\}/g);
    let validationError = streamedSpec.validationError;
    if (jsonMatch) {
        const sorted = jsonMatch.sort((a, b) => b.length - a.length);
        for (const candidate of sorted) {
            try {
                const parsed = validatePrototypeSpec(JSON.parse(candidate));
                if (parsed)
                    return { spec: parsed };
                validationError ||= 'the generated JSON did not match the expected prototype spec format';
            }
            catch {
                continue;
            }
        }
    }
    // Strategy 2: Code block
    const codeBlockMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
        try {
            const parsed = validatePrototypeSpec(JSON.parse(codeBlockMatch[1].trim()));
            if (parsed)
                return { spec: parsed };
            validationError ||= 'the generated JSON inside the code block did not match the expected prototype spec format';
        }
        catch { /* */ }
    }
    // Strategy 3: Whole output
    try {
        const parsed = validatePrototypeSpec(JSON.parse(output.trim()));
        if (parsed)
            return { spec: parsed };
        validationError ||= 'the generated JSON response did not match the expected prototype spec format';
    }
    catch { /* */ }
    return { spec: null, validationError };
}
function parsePatchSpec(_output, _currentSpec) {
    // Patch-based streaming removed (json-render dependency removed)
    return { spec: null };
}
function validatePrototypeSpec(candidate) {
    const sanitized = sanitizePrototypeSpec(candidate);
    if (!sanitized || typeof sanitized !== 'object')
        return null;
    const spec = sanitized;
    // Basic structure check: must have root and elements
    if (typeof spec.root !== 'string' || !spec.elements || typeof spec.elements !== 'object')
        return null;
    return spec;
}
function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}
function sanitizePrototypeSpec(candidate) {
    if (!candidate || typeof candidate !== 'object') {
        return candidate;
    }
    const spec = cloneJson(candidate);
    const elements = spec.elements;
    if (!elements || typeof elements !== 'object') {
        return spec;
    }
    for (const [key, rawElement] of Object.entries(elements)) {
        if (!rawElement || typeof rawElement !== 'object')
            continue;
        const element = rawElement;
        const props = element.props && typeof element.props === 'object'
            ? { ...element.props }
            : {};
        const type = normalizeComponentType(element.type);
        element.type = type;
        if (!Array.isArray(element.children)) {
            element.children = [];
        }
        switch (type) {
            case 'Heading':
                props.text = stringOrFallback(props.text, props.label, humanizeKey(key));
                props.level = normalizeHeadingLevel(props.level);
                break;
            case 'Text':
                props.text = stringOrFallback(props.text, props.label, props.children, humanizeKey(key));
                break;
            case 'Button':
                props.label = stringOrFallback(props.label, props.text, humanizeKey(key));
                props.variant = normalizeButtonVariant(props.variant);
                break;
            case 'Link':
                props.label = stringOrFallback(props.label, props.text, props.href, humanizeKey(key));
                props.href = typeof props.href === 'string' && props.href.trim() ? props.href : '#';
                break;
            case 'Badge':
                props.text = stringOrFallback(props.text, props.label, humanizeKey(key));
                props.variant = normalizeBadgeVariant(props.variant);
                break;
            case 'Alert':
                props.title = stringOrFallback(props.title, humanizeKey(key));
                props.message = stringOrFallback(props.message, props.description);
                props.type = normalizeAlertType(props.type ?? props.variant);
                break;
            case 'Avatar':
                props.name = stringOrFallback(props.name, props.fallback, humanizeKey(key));
                props.size = normalizeAvatarSize(props.size);
                break;
            case 'Stack':
                props.gap = normalizeGap(props.gap, true);
                break;
            case 'Grid':
                props.gap = normalizeGap(props.gap, false);
                break;
            case 'Table':
                if (!Array.isArray(props.columns) && Array.isArray(props.headers)) {
                    props.columns = props.headers;
                }
                break;
            case 'Select':
                props.name = stringOrFallback(props.name, slugifyKey(key));
                props.label = stringOrFallback(props.label, props.placeholder, humanizeKey(key));
                if (Array.isArray(props.options)) {
                    props.options = props.options.map((option) => {
                        if (typeof option === 'string')
                            return option;
                        if (option && typeof option === 'object') {
                            const value = option;
                            return stringOrFallback(value.label, value.value, 'Option');
                        }
                        return 'Option';
                    });
                }
                break;
            case 'Input':
            case 'Textarea':
                props.name = stringOrFallback(props.name, slugifyKey(key));
                props.label = stringOrFallback(props.label, props.placeholder, humanizeKey(key));
                break;
            case 'Checkbox':
            case 'Radio':
            case 'Switch':
                props.name = stringOrFallback(props.name, slugifyKey(key));
                props.label = stringOrFallback(props.label, humanizeKey(key));
                break;
            case 'Image':
                props.alt = stringOrFallback(props.alt, humanizeKey(key));
                break;
            default:
                break;
        }
        element.props = props;
    }
    return spec;
}
function normalizeComponentType(type) {
    const value = typeof type === 'string' ? type : '';
    switch (value) {
        case 'Container':
        case 'Section':
            return 'Stack';
        case 'Panel':
            return 'Card';
        case 'Paragraph':
        case 'Label':
            return 'Text';
        default:
            return value;
    }
}
function normalizeHeadingLevel(value) {
    if (typeof value === 'string' && /^h[1-4]$/.test(value)) {
        return value;
    }
    const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
    if (Number.isFinite(numeric)) {
        return `h${Math.min(4, Math.max(1, numeric))}`;
    }
    return 'h2';
}
function normalizeButtonVariant(value) {
    if (value === null || value === undefined || value === '')
        return null;
    const variant = String(value);
    if (variant === 'primary' || variant === 'secondary' || variant === 'danger') {
        return variant;
    }
    if (variant === 'destructive')
        return 'danger';
    return 'secondary';
}
function normalizeBadgeVariant(value) {
    if (value === null || value === undefined || value === '')
        return null;
    const variant = String(value);
    if (variant === 'default' || variant === 'secondary' || variant === 'destructive' || variant === 'outline') {
        return variant;
    }
    return 'default';
}
function normalizeAlertType(value) {
    if (value === null || value === undefined || value === '')
        return null;
    const alertType = String(value);
    if (alertType === 'success' || alertType === 'info' || alertType === 'warning' || alertType === 'error') {
        return alertType;
    }
    if (alertType === 'destructive' || alertType === 'danger')
        return 'error';
    return 'info';
}
function normalizeAvatarSize(value) {
    if (value === null || value === undefined || value === '')
        return null;
    if (value === 'sm' || value === 'md' || value === 'lg')
        return value;
    const numeric = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    if (!Number.isFinite(numeric))
        return 'md';
    if (numeric <= 32)
        return 'sm';
    if (numeric >= 56)
        return 'lg';
    return 'md';
}
function normalizeGap(value, allowNone) {
    if (value === null || value === undefined || value === '')
        return null;
    const asString = String(value);
    const allowed = allowNone ? new Set(['none', 'sm', 'md', 'lg', 'xl']) : new Set(['sm', 'md', 'lg', 'xl']);
    if (allowed.has(asString)) {
        return asString;
    }
    const numeric = typeof value === 'number' ? value : Number.parseInt(asString, 10);
    if (!Number.isFinite(numeric)) {
        return allowNone ? 'md' : 'md';
    }
    if (allowNone && numeric <= 0)
        return 'none';
    if (numeric <= 2)
        return 'sm';
    if (numeric <= 4)
        return 'md';
    if (numeric <= 8)
        return 'lg';
    return 'xl';
}
function stringOrFallback(...values) {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) {
            return value;
        }
    }
    return 'Untitled';
}
function humanizeKey(key) {
    return key
        .replace(/[-_]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (char) => char.toUpperCase()) || 'Untitled';
}
function slugifyKey(key) {
    const slug = key
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
    return slug || 'field';
}
function getEnrichedPath() {
    const existing = process.env.PATH || '';
    const extras = [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/opt/homebrew/sbin',
        `${process.env.HOME}/.local/bin`,
        `${process.env.HOME}/.cargo/bin`,
        `${process.env.HOME}/.nvm/versions/node`,
    ];
    return [...extras, existing].join(':');
}
