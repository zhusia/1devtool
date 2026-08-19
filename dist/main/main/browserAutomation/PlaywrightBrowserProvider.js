"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PlaywrightBrowserProvider = void 0;
const node_path_1 = __importDefault(require("node:path"));
function safeName(value, fallback) {
    const normalized = (value ?? '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);
    return normalized || fallback;
}
class PlaywrightBrowserProvider {
    id = 'playwright';
    browser = null;
    contexts = new Map();
    async start() {
        if (this.browser?.isConnected())
            return;
        const { chromium } = await Promise.resolve().then(() => __importStar(require('playwright')));
        this.browser = await chromium.launch({ headless: true });
        this.browser.on('disconnected', () => {
            this.browser = null;
            this.contexts.clear();
        });
    }
    async stop() {
        const browser = this.browser;
        this.browser = null;
        this.contexts.clear();
        await browser?.close();
    }
    async createContext(args) {
        await this.start();
        if (this.contexts.has(args.contextId))
            return { contextId: args.contextId };
        const context = await this.browser.newContext({ acceptDownloads: true });
        this.contexts.set(args.contextId, {
            context,
            pages: new Map(),
            console: new Map(),
            networkFailures: new Map(),
        });
        return { contextId: args.contextId };
    }
    async closeContext(contextId) {
        const record = this.contexts.get(contextId);
        if (!record)
            return;
        this.contexts.delete(contextId);
        await record.context.close();
    }
    async createPage(contextId, pageId) {
        const record = this.requireContext(contextId);
        if (record.pages.has(pageId))
            return;
        const page = await record.context.newPage();
        const consoleLines = [];
        const failures = [];
        page.on('console', (message) => {
            consoleLines.push(`[${message.type()}] ${message.text()}`);
            if (consoleLines.length > 500)
                consoleLines.splice(0, consoleLines.length - 500);
        });
        page.on('requestfailed', (request) => {
            failures.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'failed'}`);
            if (failures.length > 500)
                failures.splice(0, failures.length - 500);
        });
        record.pages.set(pageId, page);
        record.console.set(pageId, consoleLines);
        record.networkFailures.set(pageId, failures);
    }
    async closePage(contextId, pageId) {
        const record = this.requireContext(contextId);
        const page = record.pages.get(pageId);
        record.pages.delete(pageId);
        record.console.delete(pageId);
        record.networkFailures.delete(pageId);
        await page?.close();
    }
    async perform(contextId, operation, artifactDir) {
        const record = this.requireContext(contextId);
        if (operation.type === 'trace-start') {
            await record.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
            return { ok: true };
        }
        if (operation.type === 'trace-stop') {
            const artifactPath = node_path_1.default.join(artifactDir, `${safeName(operation.name, 'trace')}.zip`);
            await record.context.tracing.stop({ path: artifactPath });
            return { ok: true, artifactPath };
        }
        if (operation.type === 'page-create' || operation.type === 'page-close') {
            return { ok: false, error: 'Page lifecycle is owned by BrowserAutomationService' };
        }
        const page = record.pages.get(operation.pageId);
        if (!page)
            return { ok: false, error: 'Unknown page' };
        switch (operation.type) {
            case 'navigate': {
                const response = await page.goto(operation.url, {
                    waitUntil: operation.waitUntil ?? 'domcontentloaded',
                    timeout: Math.min(Math.max(operation.timeoutMs ?? 30_000, 1_000), 120_000),
                });
                return { ok: true, value: { url: page.url(), status: response?.status() } };
            }
            case 'back':
                await page.goBack({ waitUntil: 'domcontentloaded' });
                return { ok: true, value: page.url() };
            case 'forward':
                await page.goForward({ waitUntil: 'domcontentloaded' });
                return { ok: true, value: page.url() };
            case 'reload':
                await page.reload({ waitUntil: 'domcontentloaded' });
                return { ok: true, value: page.url() };
            case 'snapshot':
                return { ok: true, value: await page.locator('body').ariaSnapshot({ timeout: 10_000 }) };
            case 'query': {
                const locator = page.locator(operation.selector);
                const count = Math.min(await locator.count(), Math.min(Math.max(operation.limit ?? 20, 1), 100));
                const rows = [];
                for (let index = 0; index < count; index++) {
                    const item = locator.nth(index);
                    rows.push({ text: (await item.innerText().catch(() => '')).slice(0, 2_000), visible: await item.isVisible().catch(() => false) });
                }
                return { ok: true, value: rows };
            }
            case 'click':
                await page.locator(operation.selector).click();
                return { ok: true };
            case 'type':
                await page.locator(operation.selector).fill(operation.text);
                return { ok: true };
            case 'select':
                return { ok: true, value: await page.locator(operation.selector).selectOption(operation.values) };
            case 'upload':
                await page.locator(operation.selector).setInputFiles(operation.paths);
                return { ok: true };
            case 'press':
                if (operation.selector)
                    await page.locator(operation.selector).press(operation.key);
                else
                    await page.keyboard.press(operation.key);
                return { ok: true };
            case 'drag':
                await page.locator(operation.source).dragTo(page.locator(operation.target));
                return { ok: true };
            case 'visible':
                return { ok: true, value: await page.locator(operation.selector).isVisible() };
            case 'url':
                return { ok: true, value: page.url() };
            case 'screenshot': {
                const artifactPath = node_path_1.default.join(artifactDir, `${safeName(operation.name, `screenshot-${Date.now()}`)}.png`);
                await page.screenshot({ path: artifactPath, fullPage: operation.fullPage === true });
                return { ok: true, artifactPath };
            }
            case 'console':
                return { ok: true, value: [...(record.console.get(operation.pageId) ?? [])] };
            case 'network-failures':
                return { ok: true, value: [...(record.networkFailures.get(operation.pageId) ?? [])] };
        }
    }
    requireContext(contextId) {
        const record = this.contexts.get(contextId);
        if (!record)
            throw new Error('Unknown Playwright context');
        return record;
    }
}
exports.PlaywrightBrowserProvider = PlaywrightBrowserProvider;
