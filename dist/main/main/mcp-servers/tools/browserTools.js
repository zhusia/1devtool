"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerBrowserTools = registerBrowserTools;
const toolRegistry_1 = require("../_shared/toolRegistry");
const projectSelector = {
    projectId: {
        type: 'string',
        description: 'Required for unattributed MCP clients; terminal-attributed calls use the terminal project',
    },
};
const tabSelector = {
    ...projectSelector,
    tabId: { type: 'string', description: 'Stable tab id returned by browser.list_tabs or browser.open_tab' },
};
const refSelector = {
    ...tabSelector,
    snapshotId: { type: 'string', description: 'Snapshot id returned by the latest browser.snapshot/action result' },
    ref: { type: 'string', description: 'Element ref from the matching snapshot tree' },
};
function registerBrowserTools(bridge, deps) {
    const registry = bridge.getToolRegistry();
    registry.register({
        name: 'browser.list_tabs',
        profile: 'browser',
        description: 'List persisted in-app browser tabs, the reusable automation tab, and live guest readiness for one project.',
        inputSchema: (0, toolRegistry_1.objectSchema)(projectSelector),
        outputKind: 'json',
        execute: (ctx, args) => deps.browserAutomation.listTabs(args, ctx),
    });
    registry.register({
        name: 'browser.open_tab',
        profile: 'browser',
        description: 'Open a URL in the project automation tab, reusing the same tab by default; create another tab only when newTab is true.',
        inputSchema: (0, toolRegistry_1.objectSchema)({
            ...projectSelector,
            url: { type: 'string' },
            focus: { type: 'boolean', default: true },
            newTab: { type: 'boolean', default: false },
        }),
        outputKind: 'json',
        mutates: true,
        longRunning: true,
        timeoutMs: 30_000,
        execute: (ctx, args, signal) => deps.browserAutomation.openTab(args, ctx, signal),
    });
    registry.register({
        name: 'browser.select_tab',
        profile: 'browser',
        description: 'Select an in-app browser tab and focus its panel.',
        inputSchema: (0, toolRegistry_1.objectSchema)({ ...tabSelector, focusPanel: { type: 'boolean', default: true } }, ['tabId']),
        outputKind: 'json',
        mutates: true,
        timeoutMs: 15_000,
        execute: (ctx, args, signal) => deps.browserAutomation.selectTab(args, ctx, signal),
    });
    registry.register({
        name: 'browser.close_tab',
        profile: 'browser',
        description: 'Close a persisted in-app browser tab. The final tab cannot be closed.',
        inputSchema: (0, toolRegistry_1.objectSchema)(tabSelector, ['tabId']),
        outputKind: 'json',
        mutates: true,
        timeoutMs: 15_000,
        execute: (ctx, args, signal) => deps.browserAutomation.closeTab(args, ctx, signal),
    });
    registry.register({
        name: 'browser.snapshot',
        profile: 'browser',
        description: 'Return a bounded accessibility-oriented snapshot and exact element refs from the live in-app tab.',
        inputSchema: (0, toolRegistry_1.objectSchema)(tabSelector, ['tabId']),
        outputKind: 'text',
        longRunning: true,
        timeoutMs: 20_000,
        execute: (ctx, args, signal) => deps.browserAutomation.snapshot(args, ctx, signal),
    });
    registry.register({
        name: 'browser.navigate',
        profile: 'browser',
        description: 'Navigate the live in-app browser tab to an HTTP(S) URL and return a fresh snapshot.',
        inputSchema: (0, toolRegistry_1.objectSchema)({ ...tabSelector, url: { type: 'string' } }, ['tabId', 'url']),
        outputKind: 'text',
        mutates: true,
        longRunning: true,
        timeoutMs: 30_000,
        execute: (ctx, args, signal) => deps.browserAutomation.navigate(args, ctx, signal),
    });
    for (const [name, direction, description] of [
        ['browser.go_back', 'back', 'Go back in the live in-app tab and return a fresh snapshot.'],
        ['browser.go_forward', 'forward', 'Go forward in the live in-app tab and return a fresh snapshot.'],
        ['browser.reload', 'reload', 'Reload the live in-app tab and return a fresh snapshot.'],
    ]) {
        registry.register({
            name,
            profile: 'browser',
            description,
            inputSchema: (0, toolRegistry_1.objectSchema)(tabSelector, ['tabId']),
            outputKind: 'text',
            mutates: true,
            longRunning: true,
            timeoutMs: 30_000,
            execute: (ctx, args, signal) => deps.browserAutomation.history(direction, args, ctx, signal),
        });
    }
    registry.register({
        name: 'browser.click',
        profile: 'browser',
        description: 'Click an exact ref from the latest snapshot using Chromium native input, then return a fresh snapshot.',
        inputSchema: (0, toolRegistry_1.objectSchema)(refSelector, ['tabId', 'snapshotId', 'ref']),
        outputKind: 'text',
        mutates: true,
        longRunning: true,
        timeoutMs: 30_000,
        execute: (ctx, args, signal) => deps.browserAutomation.click(args, ctx, signal),
    });
    registry.register({
        name: 'browser.type',
        profile: 'browser',
        description: 'Replace the content of an editable ref using native text input. Password and file fields are blocked.',
        inputSchema: (0, toolRegistry_1.objectSchema)({
            ...refSelector,
            text: { type: 'string', maxLength: 20_000 },
            submit: { type: 'boolean', default: false },
        }, ['tabId', 'snapshotId', 'ref', 'text']),
        outputKind: 'text',
        mutates: true,
        longRunning: true,
        timeoutMs: 30_000,
        execute: (ctx, args, signal) => deps.browserAutomation.type(args, ctx, signal),
    });
    registry.register({
        name: 'browser.select_option',
        profile: 'browser',
        description: 'Select one or more options on an exact select ref, then return a fresh snapshot.',
        inputSchema: (0, toolRegistry_1.objectSchema)({
            ...refSelector,
            value: { type: 'string' },
            values: { type: 'array', items: { type: 'string' }, maxItems: 50 },
        }, ['tabId', 'snapshotId', 'ref']),
        outputKind: 'text',
        mutates: true,
        timeoutMs: 20_000,
        execute: (ctx, args, signal) => deps.browserAutomation.selectOption(args, ctx, signal),
    });
    registry.register({
        name: 'browser.press_key',
        profile: 'browser',
        description: 'Send a constrained key chord to the live tab or a focused snapshot ref, then return a fresh snapshot.',
        inputSchema: (0, toolRegistry_1.objectSchema)({
            ...tabSelector,
            key: { type: 'string' },
            snapshotId: { type: 'string' },
            ref: { type: 'string' },
        }, ['tabId', 'key']),
        outputKind: 'text',
        mutates: true,
        timeoutMs: 20_000,
        execute: (ctx, args, signal) => deps.browserAutomation.pressKey(args, ctx, signal),
    });
    registry.register({
        name: 'browser.paste_image',
        profile: 'browser',
        description: 'Paste or attach an image into a snapshot ref with a definitive acknowledgement (BUG-78). ' +
            'Prefer this over browser.press_key Control+V for attachments — returns pasteStatus ' +
            '(attached only when attachmentDelta > 0), method, attachmentDelta, fileName, byteSize. ' +
            'Provide absolute filePath (must be under the project root unless allowOutsideProject) or base64. ' +
            'Bytes are magic-sniffed as png/jpeg/gif/webp/avif (max 2 MB); caller mimeType is ignored.',
        inputSchema: (0, toolRegistry_1.objectSchema)({
            ...refSelector,
            filePath: { type: 'string', description: 'Absolute path to an image file under the project root' },
            base64: { type: 'string', description: 'Raw base64 image bytes (no data: URL prefix)' },
            fileName: { type: 'string', description: 'Optional filename for the synthetic File' },
            allowOutsideProject: {
                type: 'boolean',
                description: 'Allow filePath outside the project root — only with explicit user consent',
                default: false,
            },
        }, ['tabId', 'snapshotId', 'ref']),
        outputKind: 'json',
        mutates: true,
        longRunning: true,
        timeoutMs: 30_000,
        execute: (ctx, args, signal) => deps.browserAutomation.pasteImage(args, ctx, signal),
    });
    registry.register({
        name: 'browser.wait',
        profile: 'browser',
        description: 'Wait for bounded text, URL, or document readiness conditions and return a fresh snapshot.',
        inputSchema: (0, toolRegistry_1.objectSchema)({
            ...tabSelector,
            text: { type: 'string' },
            textGone: { type: 'string' },
            urlContains: { type: 'string' },
            loadState: { type: 'string', enum: ['domcontentloaded', 'complete'] },
            timeoutMs: { type: 'number', minimum: 100, maximum: 30_000 },
        }, ['tabId']),
        outputKind: 'text',
        longRunning: true,
        timeoutMs: 35_000,
        execute: (ctx, args, signal) => deps.browserAutomation.wait(args, ctx, signal),
    });
    registry.register({
        name: 'browser.take_screenshot',
        profile: 'browser',
        description: 'Capture the visible viewport of the exact live in-app browser guest.',
        inputSchema: (0, toolRegistry_1.objectSchema)(tabSelector, ['tabId']),
        outputKind: 'image',
        longRunning: true,
        timeoutMs: 20_000,
        execute: (ctx, args, signal) => deps.browserAutomation.screenshot(args, ctx, signal),
    });
    registry.register({
        name: 'browser.get_console_logs',
        profile: 'browser',
        description: 'Read bounded passive console messages from the live guest without enabling page instrumentation.',
        inputSchema: (0, toolRegistry_1.objectSchema)({
            ...tabSelector,
            limit: { type: 'number', minimum: 1, maximum: 500 },
        }, ['tabId']),
        outputKind: 'json',
        execute: (ctx, args, signal) => deps.browserAutomation.consoleLogs(args, ctx, signal),
    });
}
