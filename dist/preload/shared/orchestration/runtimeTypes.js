"use strict";
/**
 * Transport-independent Agent Orchestration v2 runtime contracts.
 *
 * This module is intentionally pure so main, preload, renderer, the bundled
 * CLI, and protocol fixtures can share one vocabulary without importing
 * Electron or Node process APIs.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_HARNESS_CAPABILITIES = exports.DEFAULT_ORCHESTRATION_RUNTIME_CONFIG = void 0;
exports.DEFAULT_ORCHESTRATION_RUNTIME_CONFIG = {
    preferredMode: 'auto',
    teamPresentation: 'terminal-workspace',
    flags: {
        orchestrationV2Runtime: true,
        terminalFirstTeams: true,
        teamMessageBus: true,
        codexAppServerHarness: true,
        acpHarness: true,
        // ACP rollout is adapter-specific: OpenCode passed the authenticated
        // create/tool/permission/cancel/resume lane. Cline and Gemini remain
        // behind independent gates even when the global ACP kill switch is on.
        opencodeAcpHarness: true,
        clineAcpHarness: false,
        geminiAcpHarness: false,
        playwrightToolGateway: false,
        orchestrationProductMcp: false,
    },
    browser: {
        provider: 'playwright',
        retentionHours: 24,
        realBrowserAttachment: false,
    },
};
exports.DEFAULT_HARNESS_CAPABILITIES = {
    transport: 'plain-cli',
    auth: 'vendor-owned',
    streaming: 'none',
    reasoning: false,
    toolEvents: false,
    approvals: 'none',
    questions: false,
    interrupt: false,
    steering: false,
    liveQueue: false,
    resume: 'none',
    multipleSessionsPerProcess: false,
    images: false,
    compaction: false,
    usage: 'none',
    dynamicTools: 'none',
    nativeTui: false,
};
