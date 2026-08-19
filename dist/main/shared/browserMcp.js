"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BROWSER_PANEL_CAPABILITIES = exports.BROWSER_MCP_DIRECT_USE_RULE = exports.BROWSER_MCP_MAX_SCREENSHOT_BYTES = exports.BROWSER_MCP_MAX_SNAPSHOT_CHARS = exports.BROWSER_MCP_DEFAULT_URL = void 0;
exports.isExplicitBrowserMcpAutomationRequest = isExplicitBrowserMcpAutomationRequest;
exports.appendBrowserMcpDirectUseGuard = appendBrowserMcpDirectUseGuard;
exports.getPersistedBrowserTabs = getPersistedBrowserTabs;
exports.getPersistedActiveBrowserTabId = getPersistedActiveBrowserTabId;
exports.getReusableBrowserAutomationTab = getReusableBrowserAutomationTab;
exports.BROWSER_MCP_DEFAULT_URL = 'https://1devtool.com/';
exports.BROWSER_MCP_MAX_SNAPSHOT_CHARS = 80_000;
exports.BROWSER_MCP_MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024;
/**
 * Keep the native BrowserPanel capability distinct from orchestration's generic
 * browser route. This sentence is emitted by both the MCP server and the
 * installed orchestration skill so hosts cannot reinterpret "1DevTool browser
 * MCP" as permission to launch another agent through /chrome.
 */
exports.BROWSER_MCP_DIRECT_USE_RULE = 'Treat an explicit request for the "1DevTool browser MCP", "onedevtool browser MCP", or the ' +
    'in-app BrowserPanel as a direct MCP capability request, never as generic browser-category ' +
    'routing. Unless the user separately asks another named agent to do the work, call the current ' +
    'agent\'s onedevtool browser_* MCP tools, starting with mcp__onedevtool__browser_list_tabs ' +
    '(shown by some clients as onedevtool.browser_list_tabs or browser_list_tabs). Keep testing in ' +
    'one tab: reuse the returned tabId; browser_open_tab reuses the project automation tab unless ' +
    'newTab is explicitly true because the user requested another tab. Do not activate ' +
    'the bundled browser:control-in-app-browser or chrome:control-chrome skill, call node_repl or ' +
    'agent.browsers, invoke 1devtool-agent, spawn another agent terminal, or use /chrome. If the user explicitly delegates ' +
    'that MCP task, use a visible terminal without /chrome and preserve the instruction to call the ' +
    'onedevtool browser_* tools. /chrome is only for generic delegated Chrome work that did not ' +
    'request the in-app Browser MCP.';
/**
 * Exact intent gate for Agent Input. Keep code-change discussions such as
 * "fix the onedevtool browser MCP" untouched; inject only when the user asks
 * to operate a browser through that named capability.
 */
function isExplicitBrowserMcpAutomationRequest(text) {
    const productBrowserMcp = '(?:(?:1\\s*dev\\s*tool|one\\s*dev\\s*tool|onedevtool)\\s+browser\\s+mcp)';
    const operation = '(?:open|navigate|browse|inspect|test|check|verify|click|fill|type|submit|screenshot|automate|control|run)';
    return new RegExp(`(?:^|[.!?;:\\n]\\s*)(?:please\\s+)?use\\s+(?:the\\s+)?${productBrowserMcp}\\b|` +
        `\\b${productBrowserMcp}\\s+(?:to|for)\\s+${operation}\\b|` +
        `\\b${operation}\\b[^\\n.!?]{0,80}\\b(?:with|via|through)\\s+(?:the\\s+)?${productBrowserMcp}\\b`, 'i').test(text);
}
/** Append a deterministic capability-selection guard without changing the
 * user's requested browser operation. Safe to call repeatedly. */
function appendBrowserMcpDirectUseGuard(text) {
    if (!isExplicitBrowserMcpAutomationRequest(text))
        return text;
    if (text.includes(exports.BROWSER_MCP_DIRECT_USE_RULE))
        return text;
    return `${text.trim()}\n\n1DevTool Browser MCP routing (required): ${exports.BROWSER_MCP_DIRECT_USE_RULE}`;
}
exports.BROWSER_PANEL_CAPABILITIES = {
    snapshot: true,
    screenshot: true,
    nativeInput: true,
    sameOriginFrames: true,
    crossOriginFrames: false,
    fullPageScreenshot: false,
};
/**
 * Older projects have one browser URL and no explicit tab array. Treat that
 * legacy shape as one stable synthetic tab in every process that needs to
 * resolve browser identity.
 */
function getPersistedBrowserTabs(project) {
    const tabs = project.outputPanel?.browser?.tabs;
    if (tabs?.length)
        return tabs;
    return [{
            id: 'default',
            url: project.outputPanel?.browser?.url || exports.BROWSER_MCP_DEFAULT_URL,
            title: 'New Tab',
        }];
}
function getPersistedActiveBrowserTabId(project) {
    return project.outputPanel?.browser?.activeTabId
        || getPersistedBrowserTabs(project)[0]?.id
        || 'default';
}
/**
 * Resolve the one project-owned tab used by Browser MCP open calls. A valid
 * persisted lease wins; older/stale projects adopt the active tab instead of
 * creating another tab on every retry or app restart.
 */
function getReusableBrowserAutomationTab(project) {
    const tabs = getPersistedBrowserTabs(project);
    const leasedTabId = project.outputPanel?.browser?.automationTabId;
    return tabs.find((tab) => tab.id === leasedTabId)
        ?? tabs.find((tab) => tab.id === getPersistedActiveBrowserTabId(project))
        ?? tabs[0]
        ?? null;
}
