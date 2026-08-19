"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOrchestrationRuntimeFoundation = createOrchestrationRuntimeFoundation;
const node_path_1 = __importDefault(require("node:path"));
const headlessMode_1 = require("../../../shared/headlessMode");
const orchestrationRuns_1 = require("../../../shared/orchestrationRuns");
const BrowserAutomationService_1 = require("../../browserAutomation/BrowserAutomationService");
const PlaywrightBrowserProvider_1 = require("../../browserAutomation/PlaywrightBrowserProvider");
const ToolGateway_1 = require("../../tools/ToolGateway");
const registerBrowserAutomationTools_1 = require("../../tools/registerBrowserAutomationTools");
const AgentRuntimeManager_1 = require("./AgentRuntimeManager");
const HarnessRegistry_1 = require("./HarnessRegistry");
const AcpHarness_1 = require("./adapters/AcpHarness");
const CodexAppServerHarness_1 = require("./adapters/CodexAppServerHarness");
const HeadlessCliHarness_1 = require("./adapters/HeadlessCliHarness");
function createOrchestrationRuntimeFoundation(cliRegistry, homeDir) {
    const root = node_path_1.default.join((0, orchestrationRuns_1.getOrchestrationRootDir)(homeDir), 'runtime');
    const browserAutomation = new BrowserAutomationService_1.BrowserAutomationService(new PlaywrightBrowserProvider_1.PlaywrightBrowserProvider(), node_path_1.default.join((0, orchestrationRuns_1.getOrchestrationRootDir)(homeDir), 'browser-artifacts'));
    const toolGateway = new ToolGateway_1.ToolGateway();
    (0, registerBrowserAutomationTools_1.registerBrowserAutomationTools)(toolGateway, browserAutomation);
    const registry = new HarnessRegistry_1.HarnessRegistry(node_path_1.default.join(root, 'probe-cache.json'));
    const binary = (agentId) => async () => {
        const resolved = await cliRegistry.getCliBinary(agentId);
        return resolved.ok ? { path: resolved.path, version: resolved.version ?? undefined } : null;
    };
    for (const [agentId, spec] of Object.entries(headlessMode_1.HEADLESS_SPECS)) {
        registry.register(new HeadlessCliHarness_1.HeadlessCliHarness({
            agentId,
            binaryPath: binary(agentId),
            defaultFlags: spec.defaultFlags,
            structured: true,
        }));
    }
    registry.register(new CodexAppServerHarness_1.CodexAppServerHarness({ binaryPath: binary('codex'), toolGateway }));
    registry.register(new AcpHarness_1.AcpHarness({ agentId: 'opencode', binaryPath: binary('opencode'), args: ['acp'] }));
    registry.register(new AcpHarness_1.AcpHarness({
        agentId: 'cline',
        binaryPath: binary('cline'),
        // Cline's CLI default is global tool auto-approval. Structured
        // orchestration must mediate sensitive requests through ACP instead.
        args: ['--acp', '--auto-approve', 'false'],
    }));
    registry.register(new AcpHarness_1.AcpHarness({ agentId: 'gemini', binaryPath: binary('gemini'), args: ['--acp'] }));
    const manager = new AgentRuntimeManager_1.AgentRuntimeManager(registry, node_path_1.default.join(root, 'sessions.json'));
    manager.initialize();
    return { registry, manager, browserAutomation, toolGateway };
}
