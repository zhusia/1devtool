"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cancelDesignGeneration = cancelDesignGeneration;
exports.generateDesign = generateDesign;
const child_process_1 = require("child_process");
const design_prompts_1 = require("./design-prompts");
let activeProcess = null;
function cancelDesignGeneration() {
    if (activeProcess) {
        activeProcess.kill('SIGTERM');
        activeProcess = null;
    }
}
async function generateDesign(request, onProgress, onComponent) {
    const { prompt, agent, canvasState } = request;
    const systemPrompt = design_prompts_1.DESIGN_SYSTEM_PROMPT;
    const canvasContext = (0, design_prompts_1.buildCanvasContext)(canvasState);
    const promptParts = [
        systemPrompt,
        canvasContext,
        '',
        '## User Request',
        prompt,
        '',
        '## Response Format',
        'Respond with ONLY a JSON array of components to create. No markdown, no explanation, just the JSON array.',
        'Each object must have: type, props, position (x, y), size (width, height).',
        '',
        'Valid types: container, separator, heading, paragraph, link, text-input, checkbox, select, toggle, button, navbar, tabbar, breadcrumb, table, list, card, alert, progress-bar, image, icon, avatar',
        '',
        'Example:',
        '[',
        '  {"type":"navbar","props":{"title":"My App","showBack":false,"showMenu":true},"position":{"x":0,"y":0},"size":{"width":' + canvasState.screenWidth + ',"height":56}},',
        '  {"type":"heading","props":{"text":"Welcome","level":1,"align":"center"},"position":{"x":48,"y":80},"size":{"width":280,"height":40}}',
        ']',
    ];
    // Append referenced file contents if provided
    if (request.fileContents && request.fileContents.length > 0) {
        promptParts.push('');
        promptParts.push('## Referenced Files');
        promptParts.push('The user has attached these files for context. Use them to inform the design:');
        for (const file of request.fileContents) {
            promptParts.push(`\n--- ${file.path} ---`);
            promptParts.push(file.content);
        }
    }
    const fullPrompt = promptParts.join('\n');
    onProgress?.('Starting AI generation...');
    const agentCommand = getAgentCommand(agent, request.skipPermissions);
    if (!agentCommand) {
        return { ok: false, error: `Agent "${agent}" CLI not found. Install it first.` };
    }
    try {
        onProgress?.(`Calling ${agent}...`);
        const allComponents = [];
        const output = await runAgentCLI(agentCommand.cmd, agentCommand.args, fullPrompt, (msg) => onProgress?.(msg), (comp) => {
            // Stream each component to the renderer in real-time
            allComponents.push(comp);
            onComponent?.(comp);
        });
        if (allComponents.length === 0) {
            // Fallback: try parsing the full output if streaming didn't extract any
            onProgress?.('Parsing response...');
            const parsed = parseComponentsFromOutput(output);
            if (parsed && parsed.length > 0) {
                for (const comp of parsed) {
                    allComponents.push(comp);
                    onComponent?.(comp);
                }
            }
        }
        if (allComponents.length === 0) {
            return { ok: false, error: 'AI returned no valid components', message: output.slice(0, 500) };
        }
        onProgress?.(`Generated ${allComponents.length} components`);
        return { ok: true, components: allComponents, message: `Created ${allComponents.length} components` };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'AI generation failed',
        };
    }
}
function getAgentCommand(agent, skipPermissions) {
    switch (agent) {
        case 'claude':
            return { cmd: 'claude', args: skipPermissions ? ['-p', '--dangerously-skip-permissions'] : ['-p'] };
        case 'codex':
            return { cmd: 'codex', args: skipPermissions ? ['exec', '--full-auto'] : ['exec'] };
        case 'gemini':
            return { cmd: 'gemini', args: [] };
        case 'kimi':
            return { cmd: 'kimi', args: ['-p'] };
        case 'hermes':
            return { cmd: 'hermes', args: ['-z'] };
        default:
            return null;
    }
}
/**
 * Incremental JSON parser — extracts complete JSON objects from a growing buffer.
 * As the AI streams output, we detect complete {...} objects and emit them immediately.
 */
class StreamingJsonExtractor {
    buffer = '';
    inArray = false;
    braceDepth = 0;
    objectStart = -1;
    onObject;
    constructor(onObject) {
        this.onObject = onObject;
    }
    feed(chunk) {
        for (let i = 0; i < chunk.length; i++) {
            const ch = chunk[i];
            this.buffer += ch;
            if (ch === '[' && !this.inArray) {
                this.inArray = true;
                continue;
            }
            if (ch === '{' && this.inArray) {
                if (this.braceDepth === 0) {
                    this.objectStart = this.buffer.length - 1;
                }
                this.braceDepth++;
            }
            if (ch === '}' && this.inArray) {
                this.braceDepth--;
                if (this.braceDepth === 0 && this.objectStart >= 0) {
                    const objStr = this.buffer.slice(this.objectStart);
                    this.objectStart = -1;
                    try {
                        const parsed = JSON.parse(objStr);
                        const validated = validateSingleComponent(parsed);
                        if (validated) {
                            this.onObject(validated);
                        }
                    }
                    catch {
                        // incomplete or malformed — skip
                    }
                }
            }
        }
    }
}
function runAgentCLI(cmd, baseArgs, prompt, onProgress, onComponent) {
    return new Promise((resolve, reject) => {
        const args = [...baseArgs, prompt];
        const child = (0, child_process_1.spawn)(cmd, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                PATH: getEnrichedPath(),
            },
            timeout: 120000,
        });
        activeProcess = child;
        let stdout = '';
        let stderr = '';
        let componentCount = 0;
        // Stream parser — emits components as they arrive
        const extractor = new StreamingJsonExtractor((comp) => {
            componentCount++;
            onProgress?.(`Rendering component ${componentCount}...`);
            onComponent?.(comp);
        });
        child.stdout?.on('data', (data) => {
            const chunk = data.toString();
            stdout += chunk;
            // Feed into streaming parser
            extractor.feed(chunk);
            // Progress feedback
            if (componentCount === 0 && (chunk.includes('Thinking') || chunk.includes('thinking') || chunk.length > 50)) {
                onProgress?.('AI is generating design...');
            }
        });
        child.stderr?.on('data', (data) => {
            stderr += data.toString();
        });
        child.on('error', (error) => {
            activeProcess = null;
            if (error.code === 'ENOENT') {
                reject(new Error(`Command "${cmd}" not found. Make sure it's installed and in your PATH.`));
            }
            else {
                reject(error);
            }
        });
        child.on('close', (code) => {
            activeProcess = null;
            if (code === 0 || stdout.length > 0) {
                resolve(stdout);
            }
            else {
                reject(new Error(stderr || `${cmd} exited with code ${code}`));
            }
        });
    });
}
function parseComponentsFromOutput(output) {
    // Strategy 1: Find JSON array
    const jsonMatch = output.match(/\[[\s\S]*\]/g);
    if (jsonMatch) {
        const sorted = jsonMatch.sort((a, b) => b.length - a.length);
        for (const candidate of sorted) {
            try {
                const parsed = JSON.parse(candidate);
                if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].type) {
                    return validateComponents(parsed);
                }
            }
            catch {
                continue;
            }
        }
    }
    // Strategy 2: Whole output
    try {
        const parsed = JSON.parse(output.trim());
        if (Array.isArray(parsed))
            return validateComponents(parsed);
    }
    catch { /* */ }
    // Strategy 3: Code block
    const codeBlockMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
        try {
            const parsed = JSON.parse(codeBlockMatch[1].trim());
            if (Array.isArray(parsed))
                return validateComponents(parsed);
        }
        catch { /* */ }
    }
    return null;
}
const VALID_TYPES = new Set([
    'container', 'separator', 'heading', 'paragraph', 'link',
    'text-input', 'checkbox', 'select', 'toggle', 'button',
    'navbar', 'tabbar', 'breadcrumb', 'table', 'list', 'card',
    'alert', 'progress-bar', 'image', 'icon', 'avatar',
]);
function validateSingleComponent(obj) {
    if (typeof obj !== 'object' || obj === null)
        return null;
    const o = obj;
    if (!VALID_TYPES.has(o.type))
        return null;
    if (!o.position || typeof o.position !== 'object')
        return null;
    if (!o.size || typeof o.size !== 'object')
        return null;
    const pos = o.position;
    const size = o.size;
    return {
        type: o.type,
        props: (typeof o.props === 'object' && o.props !== null ? o.props : {}),
        position: { x: Math.max(0, Number(pos.x) || 0), y: Math.max(0, Number(pos.y) || 0) },
        size: { width: Math.max(16, Number(size.width) || 100), height: Math.max(16, Number(size.height) || 40) },
    };
}
function validateComponents(raw) {
    return raw.map(validateSingleComponent).filter((c) => c !== null);
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
