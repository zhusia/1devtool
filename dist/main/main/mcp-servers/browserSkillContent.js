"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BROWSER_MCP_SKILL_NAME = void 0;
exports.buildBrowserMcpSkill = buildBrowserMcpSkill;
const browserMcp_1 = require("../../shared/browserMcp");
exports.BROWSER_MCP_SKILL_NAME = '1devtool-browser-mcp';
/**
 * A narrowly triggered Codex skill that disambiguates 1DevTool's native MCP
 * surface from OpenAI's generic Browser/Chrome plugins. It deliberately has
 * no scripts or references: the MCP server remains the implementation owner.
 */
function buildBrowserMcpSkill() {
    return `---
name: ${exports.BROWSER_MCP_SKILL_NAME}
description: Use when the user explicitly asks to use the 1DevTool browser MCP, onedevtool browser MCP, or BrowserPanel for browser automation. Operate the live 1DevTool BrowserPanel through the onedevtool browser_* MCP tools in the current Codex session. Do not use for generic browser requests, code changes about the Browser MCP, delegation, the bundled Browser or Chrome plugins, or external Chrome.
---

# Use the 1DevTool Browser MCP

${browserMcp_1.BROWSER_MCP_DIRECT_USE_RULE}

1. Use the MCP tools from the server named \`onedevtool\`. If MCP tools are deferred, search specifically for \`onedevtool browser_list_tabs\`.
2. Call \`mcp__onedevtool__browser_list_tabs\` first and reuse its explicit \`tabId\`. If \`browser_open_tab\` is needed, it reuses one project automation tab by default; pass \`newTab: true\` only when the user explicitly requests another tab.
3. Continue only with \`mcp__onedevtool__browser_*\` tools for navigation, snapshots, actions, screenshots, console reads, and tab lifecycle.
4. If the onedevtool MCP tools are missing or fail to connect, stop and report that exact problem. Never silently substitute \`browser:control-in-app-browser\`, \`chrome:control-chrome\`, \`node_repl\`, \`agent.browsers\`, \`/chrome\`, or another terminal.
`;
}
