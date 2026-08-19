"use strict";
/**
 * Unified MCP Bridge — Single local HTTP server in the Electron main process.
 * All MCP servers (design, channels, etc.) communicate through this one bridge
 * to read/write app state.
 *
 * Features can be enabled/disabled at runtime. Disabled features return 404.
 * Binds to 127.0.0.1 only — never exposed to the network.
 *
 * Discovery (Pillar 2):
 * - Each Electron instance writes ~/.1devtool/bridges/<instance-id>.json with
 *   { port, pid, version, startedAt, host }. On startup we scan the dir and
 *   prune entries whose PID is dead so MCP servers never connect to a
 *   ghost port.
 * - We also keep writing the legacy single ~/.1devtool/mcp-bridge-port for
 *   backwards-compat with MCP server binaries from older installs.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.McpBridge = void 0;
const http_1 = __importDefault(require("http"));
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const toolRegistry_1 = require("./toolRegistry");
const interactiveDelegation_1 = require("../../../shared/interactiveDelegation");
const orchestrationRuns_1 = require("../../../shared/orchestrationRuns");
function isPidAlive(pid) {
    if (!pid || pid <= 0)
        return false;
    try {
        // Signal 0 doesn't kill, just probes. Throws ESRCH if dead, EPERM if alive but unowned.
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === 'EPERM';
    }
}
function getBridgesDir() {
    return path_1.default.join(os_1.default.homedir(), '.1devtool', 'bridges');
}
function getLegacyPortFile() {
    return path_1.default.join(os_1.default.homedir(), '.1devtool', 'mcp-bridge-port');
}
function toPositiveInteger(value) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0)
        return undefined;
    return value;
}
class McpBridge {
    server = null;
    port = 0;
    routes = new Map();
    toolRegistry = new toolRegistry_1.ToolRegistry();
    enabledFeatures = new Set();
    enabledFeaturesArray = [];
    disabledTools = new Set();
    instanceId = crypto_1.default.randomBytes(6).toString('hex');
    appVersion = '0.0.0';
    startedAt = Date.now();
    peerAuthEndpoint = null;
    replyMailboxEndpoint = null;
    onToolStart = null;
    onToolEnd = null;
    onToolDisabled = null;
    onSubAgentStart = null;
    onSubAgentEnd = null;
    onInteractiveDelegation = null;
    onAgentOrchestration = null;
    onStop = null;
    resolveTerminalId = null;
    /**
     * Force one attribution refresh and await it (Windows: rebuild the process
     * snapshot; POSIX: drop memoized nulls). Wired by the host app; used only
     * by {@link resolveTerminalIdWithRefresh} for authorization decisions.
     */
    refreshTerminalAttribution = null;
    /**
     * Attribution with one bounded refresh retry — for AUTHORIZATION sites only.
     *
     * Windows resolves ancestry from a 5s-TTL whole-process snapshot; a
     * synchronous miss while that snapshot is stale is a timing artifact, not
     * an ownership verdict. Without the retry, the first orchestration or
     * interactive-delegation verb after any idle gap hard-403s on Windows
     * ("does not own the calling terminal") even though the caller IS a PTY
     * descendant. Advisory sites (tool badges, sub-agent lifecycle) stay on the
     * synchronous lookup by design — an absent badge is preferable to a stalled
     * tool call, but an absent authorization is a hard failure the caller
     * cannot distinguish from a real refusal.
     */
    async resolveTerminalIdWithRefresh(hint) {
        const first = this.resolveTerminalId?.(hint);
        const claimed = hint.terminalId;
        if (first && (!claimed || claimed === first))
            return first;
        if (!this.refreshTerminalAttribution)
            return first;
        try {
            await this.refreshTerminalAttribution();
        }
        catch {
            return first;
        }
        return this.resolveTerminalId?.(hint);
    }
    setAppVersion(version) {
        this.appVersion = version;
    }
    setPeerAuthEndpoint(endpoint) {
        this.peerAuthEndpoint = endpoint;
        if (this.server && this.port > 0)
            this.writeInstanceFile();
    }
    setReplyMailboxEndpoint(endpoint) {
        this.replyMailboxEndpoint = endpoint;
        if (this.server && this.port > 0)
            this.writeInstanceFile();
    }
    /** Register a route under a feature namespace */
    addRoute(feature, urlPath, method, handler) {
        this.routes.set(`${method}:${urlPath}`, { method, handler, feature });
    }
    /** Register multiple routes for a feature at once */
    addRoutes(feature, routes) {
        for (const r of routes) {
            this.addRoute(feature, r.path, r.method, r.handler);
        }
    }
    getToolRegistry() {
        return this.toolRegistry;
    }
    listTools() {
        return this.toolRegistry.listTools(this.enabledFeatures).map((tool) => {
            const userEnabled = !this.disabledTools.has(tool.name);
            return {
                ...tool,
                profileEnabled: tool.enabled,
                userEnabled,
                enabled: tool.enabled && userEnabled,
            };
        });
    }
    setDisabledTools(toolNames) {
        this.disabledTools = new Set(toolNames);
    }
    getDisabledTools() {
        return [...this.disabledTools].sort();
    }
    setToolEnabled(toolName, enabled) {
        if (!this.toolRegistry.get(toolName))
            return false;
        if (enabled)
            this.disabledTools.delete(toolName);
        else
            this.disabledTools.add(toolName);
        return true;
    }
    enableFeature(feature) {
        this.enabledFeatures.add(feature);
        this.enabledFeaturesArray = [...this.enabledFeatures];
    }
    disableFeature(feature) {
        this.enabledFeatures.delete(feature);
        this.enabledFeaturesArray = [...this.enabledFeatures];
    }
    isFeatureEnabled(feature) {
        return this.enabledFeatures.has(feature);
    }
    getEnabledFeatures() {
        return this.enabledFeaturesArray;
    }
    async start() {
        return new Promise((resolve, reject) => {
            this.server = http_1.default.createServer(async (req, res) => {
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Content-Type', 'application/json');
                if (req.method === 'OPTIONS') {
                    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
                    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
                    res.writeHead(200);
                    res.end();
                    return;
                }
                try {
                    const body = await readBody(req);
                    const params = body ? JSON.parse(body) : {};
                    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
                    const url = requestUrl.pathname;
                    // Health endpoint is always available
                    if (url === '/health') {
                        res.writeHead(200);
                        res.end(JSON.stringify({
                            ok: true,
                            service: '1devtool-mcp-bridge',
                            features: this.getEnabledFeatures(),
                            registryVersion: this.toolRegistry.version,
                            toolCount: this.listTools().filter((tool) => tool.enabled).length,
                        }));
                        return;
                    }
                    // Features endpoint — MCP servers query this to know what's enabled
                    if (url === '/features') {
                        res.writeHead(200);
                        res.end(JSON.stringify({ features: this.getEnabledFeatures() }));
                        return;
                    }
                    if (url === '/registry/tools' && req.method === 'GET') {
                        const tools = this
                            .listTools()
                            .filter((tool) => tool.enabled);
                        res.writeHead(200);
                        res.end(JSON.stringify({ version: this.toolRegistry.version, tools }));
                        return;
                    }
                    if (url === '/registry/call' && req.method === 'POST') {
                        const payload = params;
                        if (typeof payload.toolName !== 'string') {
                            res.writeHead(400);
                            res.end(JSON.stringify({ error: 'toolName is required' }));
                            return;
                        }
                        const tool = this.toolRegistry.get(payload.toolName);
                        if (!tool) {
                            res.writeHead(404);
                            res.end(JSON.stringify({ error: `Unknown tool: ${payload.toolName}` }));
                            return;
                        }
                        if (tool.profile !== 'core' && !this.enabledFeatures.has(tool.profile)) {
                            res.writeHead(403);
                            res.end(JSON.stringify({ error: `Feature '${tool.profile}' is not enabled` }));
                            return;
                        }
                        const mcpCallId = (typeof payload.callId === 'string' ? payload.callId : null) ?? crypto_1.default.randomUUID();
                        const claimedTerminalId = typeof payload.terminalId === 'string' && payload.terminalId.trim()
                            ? payload.terminalId.trim()
                            : undefined;
                        const sourcePid = toPositiveInteger(payload.sourcePid);
                        const sourcePpid = toPositiveInteger(payload.sourcePpid);
                        if (this.disabledTools.has(payload.toolName)) {
                            // A disabled tool is rejected before normal start/end activity,
                            // but the actionable recovery badge still needs explicit PTY
                            // ownership. Prefer process ancestry and use the MCP child's
                            // inherited terminal id only as the same advisory fallback used
                            // by ordinary badges. Missing attribution remains unbadged.
                            const resolvedTerminalId = this.resolveTerminalId?.({
                                terminalId: claimedTerminalId,
                                sourcePid,
                                sourcePpid,
                            }) ?? claimedTerminalId;
                            this.onToolDisabled?.({
                                callId: mcpCallId,
                                toolName: payload.toolName,
                                profile: tool.profile,
                                rejectedAt: Date.now(),
                                terminalId: resolvedTerminalId,
                            });
                            res.writeHead(403);
                            res.end(JSON.stringify({ error: `Tool '${payload.toolName}' is disabled in 1DevTool` }));
                            return;
                        }
                        const mcpStartedAt = Date.now();
                        // IDENTITY (docs/tasks_v2.md §6.2). Until this change the line here
                        // was `claimed ?? ancestry` — a caller-supplied id won outright and
                        // was never checked, so any local process could act as any terminal
                        // simply by naming it. Ancestry is now resolved authoritatively and
                        // the claim is checked against it. Two ids come out, deliberately:
                        //   - `attributedTerminalId` is PROVEN and drives authorization.
                        //   - `terminalId` stays ADVISORY for badges and result routing,
                        //     preferring the proven answer and falling back to the claim
                        //     only where ancestry cannot answer (a claim-only caller keeps
                        //     the attribution it has always had; it just gains no rights).
                        const attributedTerminalId = await this.resolveTerminalIdWithRefresh({
                            terminalId: claimedTerminalId,
                            sourcePid,
                            sourcePpid,
                        });
                        const identityMismatch = Boolean(claimedTerminalId && attributedTerminalId && claimedTerminalId !== attributedTerminalId);
                        const resolvedTerminalId = attributedTerminalId ?? claimedTerminalId;
                        this.onToolStart?.({
                            callId: mcpCallId,
                            toolName: payload.toolName,
                            profile: tool.profile,
                            startedAt: mcpStartedAt,
                            args: isRecord(payload.args) ? payload.args : {},
                            terminalId: resolvedTerminalId,
                            sourcePid,
                            sourcePpid,
                        });
                        let result;
                        try {
                            result = await this.toolRegistry.call(payload.toolName, isRecord(payload.args) ? payload.args : {}, {
                                threadId: typeof payload.threadId === 'string' ? payload.threadId : undefined,
                                callId: mcpCallId,
                                terminalId: resolvedTerminalId,
                                ...(attributedTerminalId && !identityMismatch
                                    ? { attributedTerminalId }
                                    : {}),
                                ...(identityMismatch ? { identityMismatch: true } : {}),
                                ...(sourcePid ? { sourcePid } : {}),
                                ...(sourcePpid ? { sourcePpid } : {}),
                            }, {
                                callId: mcpCallId,
                                enabledProfiles: this.enabledFeatures,
                            });
                        }
                        catch (callError) {
                            this.onToolEnd?.({ callId: mcpCallId, toolName: payload.toolName, profile: tool.profile, status: 'error', endedAt: Date.now(), error: callError instanceof Error ? callError.message : String(callError) });
                            throw callError;
                        }
                        this.onToolEnd?.({ callId: mcpCallId, toolName: payload.toolName, profile: tool.profile, status: 'done', endedAt: Date.now(), result });
                        res.writeHead(200);
                        res.end(JSON.stringify({ result }));
                        return;
                    }
                    // Sub-agent delegation lifecycle, reported by the standalone
                    // `1devtool-agent` CLI. Authoritative signal for SubAgentBadge —
                    // host TUIs collapse multi-line commands, so transcript scanning
                    // can't see the delegated target (see SubAgentDelegationStartEvent).
                    if (url === '/subagent/start' && req.method === 'POST') {
                        const payload = params;
                        if (typeof payload.callId !== 'string' || typeof payload.target !== 'string') {
                            res.writeHead(400);
                            res.end(JSON.stringify({ error: 'callId and target are required' }));
                            return;
                        }
                        const sourcePid = toPositiveInteger(payload.sourcePid);
                        const sourcePpid = toPositiveInteger(payload.sourcePpid);
                        const terminalId = typeof payload.terminalId === 'string' && payload.terminalId.trim()
                            ? payload.terminalId.trim()
                            : this.resolveTerminalId?.({ sourcePid, sourcePpid });
                        this.onSubAgentStart?.({
                            callId: payload.callId,
                            target: payload.target,
                            command: typeof payload.command === 'string' ? payload.command.slice(0, 200) : `run --to=${payload.target}`,
                            startedAt: typeof payload.startedAt === 'number' ? payload.startedAt : Date.now(),
                            timeoutSeconds: typeof payload.timeoutSeconds === 'number' ? payload.timeoutSeconds : 120,
                            terminalId,
                            sourcePid,
                            sourcePpid,
                        });
                        res.writeHead(200);
                        res.end(JSON.stringify({ ok: true, attributed: Boolean(terminalId) }));
                        return;
                    }
                    if (url === '/subagent/end' && req.method === 'POST') {
                        const payload = params;
                        if (typeof payload.callId !== 'string') {
                            res.writeHead(400);
                            res.end(JSON.stringify({ error: 'callId is required' }));
                            return;
                        }
                        this.onSubAgentEnd?.({
                            callId: payload.callId,
                            status: payload.status === 'error' ? 'error' : 'done',
                            endedAt: typeof payload.endedAt === 'number' ? payload.endedAt : Date.now(),
                            exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : undefined,
                        });
                        res.writeHead(200);
                        res.end(JSON.stringify({ ok: true }));
                        return;
                    }
                    // Visible-terminal handoff for capabilities that cannot run in a
                    // print/headless CLI (notably interactive slash skills such as
                    // /chrome). Unlike lifecycle notifications, this mutates desktop
                    // state, so accept it only when the main process proves which live
                    // PTY owns the caller. A claimed terminal id alone is never
                    // sufficient (tmux callers are rooted at the verified pane PID).
                    if (url === '/subagent/interactive' && req.method === 'POST') {
                        const payload = params;
                        if (typeof payload.callId !== 'string' || !(0, orchestrationRuns_1.isValidRunCallId)(payload.callId)) {
                            res.writeHead(400);
                            res.end(JSON.stringify({ error: 'A valid callId is required' }));
                            return;
                        }
                        if (typeof payload.target !== 'string' || !payload.target.trim()) {
                            res.writeHead(400);
                            res.end(JSON.stringify({ error: 'target is required' }));
                            return;
                        }
                        if (typeof payload.prompt !== 'string' || !payload.prompt.trim()) {
                            res.writeHead(400);
                            res.end(JSON.stringify({ error: 'prompt is required' }));
                            return;
                        }
                        if (payload.prompt.length > interactiveDelegation_1.INTERACTIVE_DELEGATION_PROMPT_MAX_CHARS) {
                            res.writeHead(413);
                            res.end(JSON.stringify({ error: `prompt exceeds ${interactiveDelegation_1.INTERACTIVE_DELEGATION_PROMPT_MAX_CHARS} characters` }));
                            return;
                        }
                        if (payload.category !== undefined && (typeof payload.category !== 'string' || !(0, orchestrationRuns_1.isValidRunCategory)(payload.category))) {
                            res.writeHead(400);
                            res.end(JSON.stringify({ error: 'category is invalid' }));
                            return;
                        }
                        if (payload.activationCommand !== undefined && (typeof payload.activationCommand !== 'string' ||
                            !(0, interactiveDelegation_1.isValidInteractiveSkillCommand)(payload.activationCommand))) {
                            res.writeHead(400);
                            res.end(JSON.stringify({ error: 'activationCommand must be a slash command such as /chrome' }));
                            return;
                        }
                        const sourcePid = toPositiveInteger(payload.sourcePid);
                        const sourcePpid = toPositiveInteger(payload.sourcePpid);
                        const claimedTerminalId = typeof payload.terminalId === 'string' && payload.terminalId.trim()
                            ? payload.terminalId.trim()
                            : undefined;
                        const attributedTerminalId = await this.resolveTerminalIdWithRefresh({
                            terminalId: claimedTerminalId,
                            sourcePid,
                            sourcePpid,
                        });
                        if (!attributedTerminalId || (claimedTerminalId && claimedTerminalId !== attributedTerminalId)) {
                            res.writeHead(409);
                            res.end(JSON.stringify({ error: 'This 1DevTool instance does not own the calling terminal' }));
                            return;
                        }
                        if (!this.onInteractiveDelegation) {
                            res.writeHead(503);
                            res.end(JSON.stringify({ error: 'Interactive delegation is not available in this 1DevTool instance' }));
                            return;
                        }
                        const result = await this.onInteractiveDelegation({
                            callId: payload.callId,
                            target: payload.target,
                            ...(payload.category ? { category: payload.category } : {}),
                            ...(typeof payload.model === 'string' && payload.model ? { model: payload.model } : {}),
                            prompt: payload.prompt,
                            cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
                            ...(payload.activationCommand ? { activationCommand: payload.activationCommand } : {}),
                            terminalId: attributedTerminalId,
                            sourcePid,
                            sourcePpid,
                        });
                        res.writeHead(result.ok ? 200 : 409);
                        res.end(JSON.stringify(result));
                        return;
                    }
                    // Authenticated Agent Teams / Swarms control plane. All verbs use
                    // the same PTY-ancestry proof as interactive delegation; a claimed
                    // terminal id is only a hint and can never authorize mutation or
                    // project-scoped reads by itself.
                    const orchestrationRoutes = {
                        '/orchestration/team/start': 'team-start',
                        '/orchestration/team/list': 'team-list',
                        '/orchestration/team/members': 'team-members',
                        '/orchestration/team/connections': 'team-connections',
                        '/orchestration/team/send': 'team-send',
                        '/orchestration/team/ask': 'team-ask',
                        '/orchestration/team/reply': 'team-reply',
                        '/orchestration/team/messages': 'team-messages',
                        '/orchestration/swarm/start': 'swarm-start',
                        '/orchestration/send': 'send',
                        '/orchestration/status': 'status',
                        '/orchestration/collect/run': 'collect-run',
                        '/orchestration/collect/swarm': 'collect-swarm',
                        '/orchestration/swarm/pause': 'set-swarm-paused',
                        '/orchestration/confirm-submit': 'confirm-submit',
                        '/orchestration/resolve-confirmation': 'resolve-confirmation',
                        '/orchestration/resolve-fallback': 'resolve-fallback',
                        '/orchestration/promote-worker': 'promote-worker',
                        '/orchestration/hook-event': 'hook-event',
                        '/orchestration/stop': 'stop',
                        '/orchestration/whoami': 'whoami',
                        '/orchestration/link/send': 'link-send',
                        '/orchestration/link/request': 'link-request',
                        '/orchestration/link/status': 'link-status',
                        '/orchestration/report': 'hierarchy-report',
                        '/orchestration/link/broadcast': 'link-broadcast',
                        '/orchestration/link/vote': 'link-vote',
                        '/orchestration/link/decisions': 'link-decisions',
                        '/orchestration/terminal-hook-event': 'terminal-hook-event',
                        '/orchestration/workspace/roster': 'workspace-roster',
                        '/orchestration/workspace/send': 'workspace-send',
                        '/orchestration/workspace/broadcast': 'workspace-broadcast',
                        '/orchestration/workspace/collect': 'workspace-collect',
                        '/orchestration/workspace/operation': 'workspace-operation-get',
                    };
                    const orchestrationAction = orchestrationRoutes[url];
                    if (orchestrationAction && req.method === 'POST') {
                        const payload = isRecord(params) ? params : {};
                        const sourcePid = toPositiveInteger(payload.sourcePid);
                        const sourcePpid = toPositiveInteger(payload.sourcePpid);
                        const claimedTerminalId = typeof payload.terminalId === 'string' && payload.terminalId.trim()
                            ? payload.terminalId.trim()
                            : undefined;
                        const attributedTerminalId = await this.resolveTerminalIdWithRefresh({
                            terminalId: claimedTerminalId,
                            sourcePid,
                            sourcePpid,
                        });
                        // Reply-token fallback, link-send ONLY: daemon-hosted agents
                        // (e.g. Cline's hub, whose exec shells parent to launchd) can
                        // never be attributed by PTY ancestry. Possession of the
                        // single-use token delivered INSIDE the recipient terminal's
                        // envelope is the attribution; main validates it against the
                        // durable message record and scopes the send to exactly that
                        // message's sender. Every other orchestration route keeps the
                        // ancestry gate.
                        const replyToken = orchestrationAction === 'link-send' &&
                            typeof payload.replyToken === 'string' &&
                            payload.replyToken.trim()
                            ? payload.replyToken.trim()
                            : undefined;
                        const tokenAttributed = (!attributedTerminalId || (claimedTerminalId && claimedTerminalId !== attributedTerminalId)) &&
                            replyToken !== undefined;
                        if (!attributedTerminalId || (claimedTerminalId && claimedTerminalId !== attributedTerminalId)) {
                            if (!tokenAttributed) {
                                res.writeHead(403);
                                res.end(JSON.stringify({ ok: false, error: 'This 1DevTool instance does not own the calling terminal' }));
                                return;
                            }
                        }
                        if (!this.onAgentOrchestration) {
                            res.writeHead(503);
                            res.end(JSON.stringify({ ok: false, error: 'Agent orchestration is unavailable' }));
                            return;
                        }
                        const cleanPayload = { ...payload };
                        delete cleanPayload.terminalId;
                        delete cleanPayload.sourcePid;
                        delete cleanPayload.sourcePpid;
                        const result = await this.onAgentOrchestration({
                            action: tokenAttributed ? 'link-send-by-token' : orchestrationAction,
                            payload: cleanPayload,
                            terminalId: tokenAttributed ? '' : attributedTerminalId,
                            sourcePid,
                            sourcePpid,
                        });
                        res.writeHead(200);
                        res.end(JSON.stringify(result));
                        return;
                    }
                    if (url === '/registry/cancel' && req.method === 'POST') {
                        const payload = params;
                        if (typeof payload.callId !== 'string') {
                            res.writeHead(400);
                            res.end(JSON.stringify({ error: 'callId is required' }));
                            return;
                        }
                        res.writeHead(200);
                        res.end(JSON.stringify({ ok: this.toolRegistry.cancel(payload.callId) }));
                        return;
                    }
                    if (url.startsWith('/registry/handle/') && req.method === 'GET') {
                        res.writeHead(404);
                        res.end(JSON.stringify({ error: 'Result handles are not implemented yet' }));
                        return;
                    }
                    const routeKey = `${req.method}:${url}`;
                    const route = this.routes.get(routeKey);
                    if (!route) {
                        res.writeHead(404);
                        res.end(JSON.stringify({ error: 'Not found' }));
                        return;
                    }
                    if (!this.enabledFeatures.has(route.feature)) {
                        res.writeHead(404);
                        res.end(JSON.stringify({ error: `Feature '${route.feature}' is not enabled` }));
                        return;
                    }
                    const result = await route.handler(params);
                    res.writeHead(200);
                    res.end(JSON.stringify(result));
                }
                catch (error) {
                    const structured = error && typeof error === 'object'
                        ? error
                        : null;
                    res.writeHead(500);
                    res.end(JSON.stringify({
                        error: error instanceof Error ? error.message : 'Internal server error',
                        ...(typeof structured?.code === 'string' ? { code: structured.code } : {}),
                        ...(typeof structured?.retryable === 'boolean' ? { retryable: structured.retryable } : {}),
                        ...(structured?.details && typeof structured.details === 'object' ? { details: structured.details } : {}),
                    }));
                }
            });
            this.server.listen(0, '127.0.0.1', () => {
                const addr = this.server.address();
                if (typeof addr === 'object' && addr) {
                    this.port = addr.port;
                    this.pruneDeadInstances();
                    this.writeInstanceFile();
                    this.writeLegacyPortFile();
                    console.log(`[mcp-bridge] Listening on http://127.0.0.1:${this.port} (instance ${this.instanceId})`);
                    resolve(this.port);
                }
                else {
                    reject(new Error('Failed to get bridge port'));
                }
            });
            this.server.on('error', reject);
        });
    }
    stop() {
        this.onStop?.();
        this.server?.close();
        this.server = null;
        this.removeInstanceFile();
        this.removeLegacyPortFileIfMine();
    }
    getPort() {
        return this.port;
    }
    getInstanceId() {
        return this.instanceId;
    }
    /**
     * Snapshot of every live bridge instance on this machine. Used by the
     * diagnostic UI to detect multi-instance races and stale port files.
     */
    static listLiveInstances() {
        const dir = getBridgesDir();
        if (!fs_1.default.existsSync(dir))
            return [];
        const records = [];
        for (const file of fs_1.default.readdirSync(dir)) {
            if (!file.endsWith('.json'))
                continue;
            try {
                const raw = fs_1.default.readFileSync(path_1.default.join(dir, file), 'utf-8');
                const record = JSON.parse(raw);
                if (isPidAlive(record.pid))
                    records.push(record);
            }
            catch {
                // Skip corrupt files
            }
        }
        return records;
    }
    pruneDeadInstances() {
        const dir = getBridgesDir();
        if (!fs_1.default.existsSync(dir))
            return;
        for (const file of fs_1.default.readdirSync(dir)) {
            if (!file.endsWith('.json'))
                continue;
            const full = path_1.default.join(dir, file);
            try {
                const record = JSON.parse(fs_1.default.readFileSync(full, 'utf-8'));
                if (typeof record.pid !== 'number' || !isPidAlive(record.pid)) {
                    fs_1.default.unlinkSync(full);
                }
            }
            catch {
                // Corrupt file — remove
                try {
                    fs_1.default.unlinkSync(full);
                }
                catch { /* ignore */ }
            }
        }
    }
    writeInstanceFile() {
        try {
            const dir = getBridgesDir();
            if (!fs_1.default.existsSync(dir))
                fs_1.default.mkdirSync(dir, { recursive: true });
            const record = {
                instanceId: this.instanceId,
                port: this.port,
                pid: process.pid,
                version: this.appVersion,
                startedAt: this.startedAt,
                host: '127.0.0.1',
                ...(this.peerAuthEndpoint ? { peerAuth: this.peerAuthEndpoint } : {}),
                ...(this.replyMailboxEndpoint ? { replyMailbox: this.replyMailboxEndpoint } : {}),
            };
            fs_1.default.writeFileSync(path_1.default.join(dir, `${this.instanceId}.json`), JSON.stringify(record, null, 2), 'utf-8');
        }
        catch {
            // Non-fatal
        }
    }
    removeInstanceFile() {
        try {
            fs_1.default.unlinkSync(path_1.default.join(getBridgesDir(), `${this.instanceId}.json`));
        }
        catch {
            // Non-fatal
        }
    }
    /**
     * Back-compat: existing installed MCP server binaries from older 1DevTool
     * versions only know about the single port file. Keep writing it so they
     * don't break after upgrading the desktop app.
     */
    writeLegacyPortFile() {
        try {
            const dir = path_1.default.join(os_1.default.homedir(), '.1devtool');
            if (!fs_1.default.existsSync(dir))
                fs_1.default.mkdirSync(dir, { recursive: true });
            fs_1.default.writeFileSync(getLegacyPortFile(), String(this.port), 'utf-8');
        }
        catch {
            // Non-fatal
        }
    }
    removeLegacyPortFileIfMine() {
        // Only remove the legacy port file if it still points at our port. In
        // multi-instance setups, another live bridge might have rewritten it.
        try {
            const raw = fs_1.default.readFileSync(getLegacyPortFile(), 'utf-8').trim();
            if (parseInt(raw, 10) === this.port) {
                fs_1.default.unlinkSync(getLegacyPortFile());
            }
        }
        catch {
            // Non-fatal
        }
    }
}
exports.McpBridge = McpBridge;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
        req.on('error', () => resolve(''));
    });
}
