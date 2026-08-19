"use strict";
/**
 * "Generate diagram" service for the Draw canvas prompt bar. Asks an installed
 * AI CLI in headless mode for a mermaid or skeleton-JSON diagram; the renderer
 * converts the returned source into editable Excalidraw elements (conversion
 * needs the DOM, so it cannot happen here). Never throws across IPC: every
 * outcome is a structured `GenerateDrawDiagramResult`.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cancelDrawDiagram = cancelDrawDiagram;
exports.generateDrawDiagram = generateDrawDiagram;
const os_1 = __importDefault(require("os"));
const drawGeneration_1 = require("../shared/drawGeneration");
const headlessMode_1 = require("../shared/headlessMode");
const chartMermaid_1 = require("../shared/orchestration/chartMermaid");
const runHeadlessAgent_1 = require("./orchestration/runHeadlessAgent");
// Diagrams need more reasoning than commit subjects; still bounded.
const GENERATE_TIMEOUT_S = 120;
// The Draw canvas is an app-global singleton, so one in-flight generation is
// enough: a newer request (regenerate) aborts the CLI still running for the
// previous one instead of stacking processes.
let inFlight = null;
let cancelledByUser = false;
/** Explicit user cancel (Cancel button, dialog close) — maps to a silent idle. */
function cancelDrawDiagram() {
    if (inFlight) {
        cancelledByUser = true;
        inFlight.abort();
    }
}
async function generateDrawDiagram(deps, request) {
    try {
        return await generate(deps, request);
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
async function generate(deps, request) {
    if (!request.prompt.trim()) {
        return { ok: false, error: 'Describe the diagram first.' };
    }
    const registry = deps.getCliRegistry();
    if (!registry) {
        return { ok: false, error: 'CLI detection has not finished yet — try again in a moment.' };
    }
    // A pinned agent is an explicit user choice — honor it or fail with its
    // name; never silently substitute another CLI.
    const settings = request.settings;
    const pinnedId = settings?.agentId && settings.agentId !== 'auto' ? settings.agentId : null;
    if (pinnedId && !headlessMode_1.HEADLESS_SPECS[pinnedId]) {
        return { ok: false, error: `"${pinnedId}" has no headless mode — pick another agent in the generate settings.` };
    }
    const registrations = new Map(registry.list().map((r) => [r.cliId, r]));
    const candidates = (pinnedId ? [pinnedId] : drawGeneration_1.DRAW_DIAGRAM_AGENT_ORDER).filter((id) => {
        if (!headlessMode_1.HEADLESS_SPECS[id])
            return false;
        if (pinnedId)
            return true;
        const reg = registrations.get(id);
        return !!reg?.selectedPath && (reg.state === 'detected' || reg.state === 'override');
    });
    let chosen = null;
    for (const id of candidates) {
        const binary = await registry.getCliBinary(id);
        if (binary.ok) {
            chosen = { id, binaryPath: binary.path };
            break;
        }
    }
    if (!chosen) {
        return pinnedId
            ? {
                ok: false,
                error: `"${pinnedId}" is selected in the generate settings but was not found — install it or pick another agent.`,
            }
            : {
                ok: false,
                error: 'No AI CLI found. Install Claude Code, Codex, Gemini CLI, or another supported agent, then retry.',
            };
    }
    // Same CLI selection, cancellation, and extraction for both callers — only
    // the instructions differ.
    const prompt = request.variant === 'orchestration-chart'
        ? (0, chartMermaid_1.buildOrchestrationChartPrompt)({
            userPrompt: request.prompt,
            topology: request.topology === 'pipeline' ? 'pipeline' : 'hierarchy',
            retry: request.retry,
        })
        : (0, drawGeneration_1.buildDrawDiagramPrompt)({ userPrompt: request.prompt, retry: request.retry });
    inFlight?.abort();
    const ctl = new AbortController();
    inFlight = ctl;
    cancelledByUser = false;
    try {
        const result = await (0, runHeadlessAgent_1.runHeadlessAgent)({
            agentId: chosen.id,
            prompt,
            cwd: request.projectPath || os_1.default.homedir(),
            binaryPath: chosen.binaryPath,
            signal: ctl.signal,
            timeoutSeconds: GENERATE_TIMEOUT_S,
        });
        if (ctl.signal.aborted && !result.timedOut) {
            return cancelledByUser
                ? { ok: false, error: 'Cancelled.', cancelled: true }
                : { ok: false, error: 'Superseded by a newer generate request.' };
        }
        if (result.timedOut) {
            return { ok: false, error: `${chosen.id} timed out generating the diagram.` };
        }
        if (result.exitCode !== 0) {
            const detail = result.stderr ? `: ${result.stderr.slice(0, 300)}` : '';
            return { ok: false, error: `${chosen.id} failed (exit ${result.exitCode})${detail}` };
        }
        const extracted = (0, drawGeneration_1.extractDiagramFromOutput)(result.output);
        if (!extracted) {
            return { ok: false, error: `${chosen.id} returned no usable diagram — try rephrasing.` };
        }
        return { ok: true, ...extracted, agent: chosen.id };
    }
    finally {
        if (inFlight === ctl)
            inFlight = null;
    }
}
