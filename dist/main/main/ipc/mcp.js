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
exports.registerMcpIpcHandlers = registerMcpIpcHandlers;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const yaml_1 = require("yaml");
const setup_1 = require("../mcp-servers/_shared/setup");
const hermesPaths_1 = require("../hermesPaths");
const kimiPaths_1 = require("../kimiPaths");
function registerMcpIpcHandlers({ storeManager, getMcpBridge, mcpActivityLog, restartMcpBridge, }) {
    // ── MCP Settings ──────────────────────────────────────────────────────
    // Helpers to read/write MCP configs for each AI tool
    function readJsonMcpServers(filePath, key = 'mcpServers') {
        const fs = require('fs');
        if (!fs.existsSync(filePath))
            return {};
        try {
            const config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            return (config[key] ?? {});
        }
        catch {
            return {};
        }
    }
    function writeJsonMcpServer(filePath, name, value, key = 'mcpServers') {
        const fs = require('fs');
        let config = {};
        if (fs.existsSync(filePath)) {
            try {
                config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            }
            catch { /* fresh */ }
        }
        const servers = (config[key] ?? {});
        if (value === null) {
            delete servers[name];
        }
        else {
            servers[name] = value;
        }
        config[key] = servers;
        fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
    }
    function readTomlMcpServers(filePath) {
        const fs = require('fs');
        if (!fs.existsSync(filePath))
            return {};
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const servers = {};
            let currentServer = null;
            for (const line of raw.split('\n')) {
                const headerMatch = line.match(/^\[mcp_servers\.(.+)\]/);
                if (headerMatch) {
                    currentServer = headerMatch[1];
                    servers[currentServer] = {};
                    continue;
                }
                if (currentServer && line.match(/^\[/)) {
                    currentServer = null;
                    continue;
                }
                if (currentServer) {
                    const kvMatch = line.match(/^(\w+)\s*=\s*"(.+)"/);
                    if (kvMatch)
                        servers[currentServer][kvMatch[1]] = kvMatch[2];
                }
            }
            return servers;
        }
        catch {
            return {};
        }
    }
    function removeTomlMcpServer(filePath, name) {
        const fs = require('fs');
        if (!fs.existsSync(filePath))
            return;
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const lines = raw.split('\n');
            const result = [];
            let skipping = false;
            const mainHeader = `[mcp_servers.${name}]`;
            const subTablePrefix = `[mcp_servers.${name}.`;
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed === mainHeader || trimmed.startsWith(subTablePrefix)) {
                    skipping = true;
                    continue;
                }
                if (skipping && line.match(/^\[/))
                    skipping = false;
                if (skipping)
                    continue;
                result.push(line);
            }
            fs.writeFileSync(filePath, result.join('\n'), 'utf-8');
        }
        catch { /* ignore */ }
    }
    function readHermesMcpServers(filePath) {
        if (!fs_1.default.existsSync(filePath))
            return {};
        try {
            const document = (0, yaml_1.parseDocument)(fs_1.default.readFileSync(filePath, 'utf-8'));
            if (document.errors.length > 0)
                return {};
            const config = document.toJS();
            return config?.mcp_servers ?? {};
        }
        catch {
            return {};
        }
    }
    function removeHermesMcpServer(filePath, name) {
        if (!fs_1.default.existsSync(filePath))
            return;
        const document = (0, yaml_1.parseDocument)(fs_1.default.readFileSync(filePath, 'utf-8'));
        if (document.errors.length > 0) {
            throw new Error(`Hermes config is invalid YAML: ${document.errors[0].message}`);
        }
        document.deleteIn(['mcp_servers', name]);
        fs_1.default.writeFileSync(filePath, document.toString(), 'utf-8');
    }
    function getMcpConfigPaths() {
        const path = require('path');
        const os = require('os');
        const home = os.homedir();
        const opencodeBase = process.platform === 'win32'
            ? (process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'))
            : (process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'));
        return {
            claude: path.join(home, '.claude.json'),
            gemini: path.join(home, '.gemini', 'settings.json'),
            kimi: path.join((0, kimiPaths_1.getKimiHome)(), 'mcp.json'),
            codex: path.join(home, '.codex', 'config.toml'),
            opencode: path.join(opencodeBase, 'opencode', 'opencode.json'),
            grok: path.join(home, '.grok', 'config.toml'),
            hermes: path.join((0, hermesPaths_1.getHermesHome)(), 'config.yaml'),
            // Cursor CLI reads the same `mcpServers` JSON shape the editor uses.
            cursor: path.join(home, '.cursor', 'mcp.json'),
        };
    }
    electron_1.ipcMain.handle('mcp:get-all-servers', async () => {
        const paths = getMcpConfigPaths();
        return {
            claude: readJsonMcpServers(paths.claude),
            gemini: readJsonMcpServers(paths.gemini),
            kimi: readJsonMcpServers(paths.kimi),
            codex: readTomlMcpServers(paths.codex),
            opencode: readJsonMcpServers(paths.opencode, 'mcp'),
            grok: readTomlMcpServers(paths.grok),
            hermes: readHermesMcpServers(paths.hermes),
            cursor: readJsonMcpServers(paths.cursor),
        };
    });
    electron_1.ipcMain.handle('mcp:remove-server', async (_, tool, name) => {
        try {
            const paths = getMcpConfigPaths();
            if (tool === 'claude') {
                writeJsonMcpServer(paths.claude, name, null);
            }
            else if (tool === 'gemini') {
                writeJsonMcpServer(paths.gemini, name, null);
            }
            else if (tool === 'kimi') {
                writeJsonMcpServer(paths.kimi, name, null);
            }
            else if (tool === 'codex') {
                removeTomlMcpServer(paths.codex, name);
            }
            else if (tool === 'opencode') {
                writeJsonMcpServer(paths.opencode, name, null, 'mcp');
            }
            else if (tool === 'grok') {
                removeTomlMcpServer(paths.grok, name);
            }
            else if (tool === 'hermes') {
                removeHermesMcpServer(paths.hermes, name);
            }
            else if (tool === 'cursor') {
                writeJsonMcpServer(paths.cursor, name, null);
            }
            return { ok: true };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    });
    electron_1.ipcMain.handle('mcp:install-feature', async (_, feature) => {
        const result = await (0, setup_1.install)();
        const bridge = getMcpBridge();
        if (result.ok && bridge) {
            bridge.enableFeature(feature);
        }
        return result;
    });
    electron_1.ipcMain.handle('mcp:remove-feature', (_, feature) => {
        try {
            const bridge = getMcpBridge();
            if (bridge) {
                bridge.disableFeature(feature);
            }
            return { ok: true };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    });
    electron_1.ipcMain.handle('mcp:get-enabled-features', () => {
        return getMcpBridge()?.getEnabledFeatures() ?? [];
    });
    electron_1.ipcMain.handle('mcp:list-tools', () => {
        const bridge = getMcpBridge();
        const registry = bridge?.getToolRegistry();
        if (!bridge || !registry)
            return { version: 0, tools: [] };
        return {
            version: registry.version,
            tools: bridge.listTools(),
        };
    });
    electron_1.ipcMain.handle('mcp:set-tool-enabled', (_, rawToolName, rawEnabled) => {
        if (typeof rawToolName !== 'string' || rawToolName.length === 0 || typeof rawEnabled !== 'boolean') {
            return { ok: false, error: 'A valid tool name and enabled state are required' };
        }
        const bridge = getMcpBridge();
        if (!bridge?.getToolRegistry().get(rawToolName)) {
            return { ok: false, error: `Unknown MCP tool: ${rawToolName}` };
        }
        try {
            const disabledTools = new Set(storeManager.getMcpDisabledTools());
            if (rawEnabled)
                disabledTools.delete(rawToolName);
            else
                disabledTools.add(rawToolName);
            storeManager.setMcpDisabledTools(disabledTools);
            bridge.setDisabledTools(disabledTools);
            const tool = bridge.listTools().find((entry) => entry.name === rawToolName);
            return { ok: true, tool };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    });
    // Group-level gate. Toggling a profile one tool at a time would be N store
    // writes + N bridge syncs (16 for `browser`), so the whole profile is applied
    // as a single atomic update and the caller gets every refreshed tool back.
    electron_1.ipcMain.handle('mcp:set-profile-enabled', (_, rawProfile, rawEnabled) => {
        if (typeof rawProfile !== 'string' || rawProfile.length === 0 || typeof rawEnabled !== 'boolean') {
            return { ok: false, error: 'A valid tool group and enabled state are required' };
        }
        const bridge = getMcpBridge();
        if (!bridge) {
            return { ok: false, error: 'The 1DevTool MCP bridge is not running' };
        }
        const profileTools = bridge.listTools().filter((tool) => tool.profile === rawProfile);
        if (profileTools.length === 0) {
            return { ok: false, error: `Unknown MCP tool group: ${rawProfile}` };
        }
        try {
            const disabledTools = new Set(storeManager.getMcpDisabledTools());
            for (const tool of profileTools) {
                if (rawEnabled)
                    disabledTools.delete(tool.name);
                else
                    disabledTools.add(tool.name);
            }
            storeManager.setMcpDisabledTools(disabledTools);
            bridge.setDisabledTools(disabledTools);
            return { ok: true, tools: bridge.listTools().filter((tool) => tool.profile === rawProfile) };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    });
    electron_1.ipcMain.handle('mcp:get-bridge-port', () => {
        return getMcpBridge()?.getPort() ?? null;
    });
    electron_1.ipcMain.handle('mcp:get-activity', (_, rawQuery) => {
        const value = rawQuery && typeof rawQuery === 'object'
            ? rawQuery
            : {};
        const allowedStatuses = new Set(['all', 'running', 'done', 'error', 'interrupted']);
        const query = {
            ...(typeof value.limit === 'number' ? { limit: value.limit } : {}),
            ...(typeof value.search === 'string' ? { search: value.search } : {}),
            ...(typeof value.status === 'string' && allowedStatuses.has(value.status)
                ? { status: value.status }
                : {}),
        };
        return mcpActivityLog.query(query);
    });
    electron_1.ipcMain.handle('mcp:clear-activity', () => {
        mcpActivityLog.clear();
        return { ok: true };
    });
    electron_1.ipcMain.handle('mcp:get-resolved-node-path', async () => {
        return (0, setup_1.resolveNodeCommand)();
    });
    electron_1.ipcMain.handle('mcp:auto-detect-node-path', async () => {
        return (0, setup_1.autoDetectNodePath)();
    });
    electron_1.ipcMain.handle('mcp:set-node-path', async (_, nodePath) => {
        const prefs = storeManager.getPreferences();
        storeManager.setPreferences({
            ...prefs,
            system: { ...prefs.system, mcpNodePath: nodePath },
        });
        (0, setup_1.invalidateResolvedNode)();
        const result = await (0, setup_1.install)();
        return { ok: result.ok, resolvedPath: await (0, setup_1.resolveNodeCommand)(), error: result.error };
    });
    /**
     * Health check used by the MCP settings UI. Hits the local bridge's
     * `/health` endpoint over HTTP so we report the same view the spawned MCP
     * server processes see — not just the in-process state.
     */
    electron_1.ipcMain.handle('mcp:health', async () => {
        const port = getMcpBridge()?.getPort() ?? null;
        if (!port) {
            return { ok: false, port: null, features: [], error: 'Bridge not started' };
        }
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 2000);
            const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
            clearTimeout(timer);
            if (!response.ok) {
                return { ok: false, port, features: [], error: `Bridge returned status ${response.status}` };
            }
            const parsed = (await response.json());
            return {
                ok: parsed.ok === true,
                port,
                features: parsed.features ?? [],
                registryVersion: parsed.registryVersion,
                toolCount: parsed.toolCount,
                error: undefined,
            };
        }
        catch (err) {
            return { ok: false, port, features: [], error: err instanceof Error ? err.message : String(err) };
        }
    });
    /**
     * Pillar 5 — end-to-end diagnostic. Returns a flat list of {id, label,
     * status, detail, fixActionId?}. The renderer renders this as a checklist
     * so users (and us in support) can self-diagnose any "MCP doesn't work"
     * report without reading docs.
     */
    electron_1.ipcMain.handle('mcp:diagnose', async () => {
        const checks = [];
        // 1) Bridge running in this process
        const bridgePort = getMcpBridge()?.getPort() ?? null;
        if (!bridgePort) {
            checks.push({
                id: 'bridge-process',
                label: 'Bridge running',
                status: 'fail',
                detail: 'Bridge is not started in this 1DevTool instance.',
                fixActionId: 'restart-bridge',
            });
        }
        else {
            checks.push({
                id: 'bridge-process',
                label: 'Bridge running',
                status: 'pass',
                detail: `Listening on 127.0.0.1:${bridgePort}.`,
            });
        }
        // 2) Bridge reachable over HTTP /health (same view MCP servers see)
        if (bridgePort) {
            try {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 2000);
                const response = await fetch(`http://127.0.0.1:${bridgePort}/health`, { signal: ctrl.signal });
                clearTimeout(timer);
                if (response.ok) {
                    checks.push({
                        id: 'bridge-health',
                        label: 'Bridge HTTP reachable',
                        status: 'pass',
                        detail: '/health returned 200.',
                    });
                }
                else {
                    checks.push({
                        id: 'bridge-health',
                        label: 'Bridge HTTP reachable',
                        status: 'fail',
                        detail: `/health returned status ${response.status}.`,
                        fixActionId: 'restart-bridge',
                    });
                }
            }
            catch (err) {
                checks.push({
                    id: 'bridge-health',
                    label: 'Bridge HTTP reachable',
                    status: 'fail',
                    detail: err instanceof Error ? err.message : String(err),
                    fixActionId: 'restart-bridge',
                });
            }
        }
        // 2b) Registry endpoint reachable and coherent with enabled features.
        if (bridgePort) {
            try {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 2000);
                const response = await fetch(`http://127.0.0.1:${bridgePort}/registry/tools`, { signal: ctrl.signal });
                clearTimeout(timer);
                if (!response.ok) {
                    checks.push({
                        id: 'registry-tools',
                        label: 'Registry handshake',
                        status: 'fail',
                        detail: `/registry/tools returned status ${response.status}.`,
                        fixActionId: 'restart-bridge',
                    });
                }
                else {
                    const parsed = (await response.json());
                    const tools = parsed.tools ?? [];
                    const enabled = new Set(getMcpBridge()?.getEnabledFeatures() ?? []);
                    const missing = [...enabled].filter((feature) => !tools.some((tool) => tool.profile === feature));
                    checks.push({
                        id: 'registry-tools',
                        label: 'Registry handshake',
                        status: missing.length === 0 ? 'pass' : 'warn',
                        detail: missing.length === 0
                            ? `/registry/tools returned ${tools.length} enabled tools.`
                            : `/registry/tools returned ${tools.length} tools, but no tools for enabled feature(s): ${missing.join(', ')}.`,
                    });
                }
            }
            catch (err) {
                checks.push({
                    id: 'registry-tools',
                    label: 'Registry handshake',
                    status: 'fail',
                    detail: err instanceof Error ? err.message : String(err),
                    fixActionId: 'restart-bridge',
                });
            }
        }
        // 3) Live instance records on disk (multi-instance / stale-file detection)
        try {
            const { McpBridge } = await Promise.resolve().then(() => __importStar(require('../mcp-servers/_shared/bridge')));
            const live = McpBridge.listLiveInstances();
            if (live.length === 0) {
                checks.push({
                    id: 'bridge-instances',
                    label: 'Bridge instance record on disk',
                    status: 'fail',
                    detail: 'No live bridge records found in ~/.1devtool/bridges/. MCP servers spawned by AI clients will fail to discover the bridge.',
                    fixActionId: 'restart-bridge',
                });
            }
            else if (live.length > 1) {
                checks.push({
                    id: 'bridge-instances',
                    label: 'Bridge instance record on disk',
                    status: 'warn',
                    detail: `${live.length} live instances detected. MCP servers will connect to the most recently started one (port ${live.sort((a, b) => b.startedAt - a.startedAt)[0].port}).`,
                });
            }
            else {
                checks.push({
                    id: 'bridge-instances',
                    label: 'Bridge instance record on disk',
                    status: 'pass',
                    detail: `1 live instance (PID ${live[0].pid}, port ${live[0].port}, v${live[0].version}).`,
                });
            }
        }
        catch (err) {
            checks.push({
                id: 'bridge-instances',
                label: 'Bridge instance record on disk',
                status: 'warn',
                detail: err instanceof Error ? err.message : String(err),
            });
        }
        // 4) Server script exists on disk
        {
            const serverPath = (0, setup_1.getFeatureServerPath)();
            const exists = fs_1.default.existsSync(serverPath);
            checks.push({
                id: 'server-script',
                label: '1DevTool server script on disk',
                status: exists ? 'pass' : 'fail',
                detail: exists ? serverPath : `Missing: ${serverPath}. Likely a stale path from a previous install.`,
                fixActionId: exists ? undefined : 'reinstall',
            });
        }
        // 5) Client config files: readable + parseable
        const configPaths = getMcpConfigPaths();
        for (const [client, configPath] of Object.entries(configPaths)) {
            if (!fs_1.default.existsSync(configPath)) {
                checks.push({
                    id: `client-config-${client}`,
                    label: `${client} config file`,
                    status: 'warn',
                    detail: `Not found at ${configPath}. Skipping — ${client} probably isn't installed.`,
                });
                continue;
            }
            try {
                const raw = fs_1.default.readFileSync(configPath, 'utf-8');
                if (client === 'codex' || client === 'grok') {
                    // TOML — we don't deep-parse here; just confirm readable.
                    checks.push({
                        id: `client-config-${client}`,
                        label: `${client} config file`,
                        status: 'pass',
                        detail: `${configPath} readable.`,
                    });
                }
                else if (client === 'hermes') {
                    const document = (0, yaml_1.parseDocument)(raw);
                    if (document.errors.length > 0)
                        throw document.errors[0];
                    checks.push({
                        id: `client-config-${client}`,
                        label: `${client} config file`,
                        status: 'pass',
                        detail: `${configPath} readable and valid YAML.`,
                    });
                }
                else {
                    JSON.parse(raw);
                    checks.push({
                        id: `client-config-${client}`,
                        label: `${client} config file`,
                        status: 'pass',
                        detail: `${configPath} readable and valid JSON.`,
                    });
                }
            }
            catch (err) {
                checks.push({
                    id: `client-config-${client}`,
                    label: `${client} config file`,
                    status: 'fail',
                    detail: `${configPath} is corrupt or unreadable: ${err instanceof Error ? err.message : String(err)}. Editing manually risks data loss.`,
                    fixActionId: `open-config:${client}`,
                });
            }
        }
        // 6) Client config entry matches what we'd install today
        {
            const expected = await (0, setup_1.getExpectedMcpEntry)();
            const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const tomlString = (value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
            const envMatches = (actual) => {
                const expectedEnv = expected.config.env ?? {};
                return Object.entries(expectedEnv).every(([key, value]) => actual?.[key] === value);
            };
            const jsonEntryMatches = (entry) => (entry?.command === expected.config.command &&
                Array.isArray(entry.args) &&
                entry.args[0] === expected.config.args[0] &&
                envMatches(entry.env));
            const clientChecks = [
                { client: 'claude', configPath: configPaths.claude },
                { client: 'gemini', configPath: configPaths.gemini },
                { client: 'kimi', configPath: configPaths.kimi },
                { client: 'cursor', configPath: configPaths.cursor },
            ];
            for (const { client, configPath: clientConfigPath } of clientChecks) {
                try {
                    const raw = fs_1.default.readFileSync(clientConfigPath, 'utf-8');
                    const parsed = JSON.parse(raw);
                    const entry = parsed.mcpServers?.[expected.configKey];
                    if (!entry) {
                        checks.push({ id: `${client}-entry`, label: `${client} config has 1DevTool entry`, status: 'warn', detail: `No "${expected.configKey}" entry. Install to add it.`, fixActionId: 'reinstall' });
                    }
                    else {
                        const ok = jsonEntryMatches(entry);
                        checks.push({
                            id: `${client}-entry`,
                            label: `${client} config has 1DevTool entry`,
                            status: ok ? 'pass' : 'fail',
                            detail: ok ? 'Points at the current install.' : 'Stale command, path, or runtime env.',
                            fixActionId: ok ? undefined : 'reinstall',
                        });
                    }
                }
                catch { /* Skip */ }
            }
            for (const { client, label, configPath } of [
                { client: 'codex', label: 'Codex', configPath: configPaths.codex },
                { client: 'grok', label: 'Grok', configPath: configPaths.grok },
            ]) {
                try {
                    const raw = fs_1.default.readFileSync(configPath, 'utf-8');
                    const sectionMatch = raw.match(new RegExp(`\\[mcp_servers\\.${escapeRegExp(expected.configKey)}\\]([\\s\\S]*?)(?=\\n\\[|$)`));
                    const envSectionMatch = raw.match(new RegExp(`\\[mcp_servers\\.${escapeRegExp(expected.configKey)}\\.env\\]([\\s\\S]*?)(?=\\n\\[|$)`));
                    if (!sectionMatch) {
                        checks.push({ id: `${client}-entry`, label: `${label} config has 1DevTool entry`, status: 'warn', detail: 'No entry. Install to add it.', fixActionId: 'reinstall' });
                    }
                    else {
                        const section = sectionMatch[1];
                        const envSection = envSectionMatch?.[1] ?? '';
                        const envMatch = Object.entries(expected.config.env ?? {})
                            .every(([key, value]) => envSection.includes(`${key} = ${tomlString(value)}`));
                        const ok = section.includes(`command = ${tomlString(expected.config.command)}`) &&
                            section.includes(tomlString(expected.config.args[0])) &&
                            envMatch;
                        checks.push({ id: `${client}-entry`, label: `${label} config has 1DevTool entry`, status: ok ? 'pass' : 'fail', detail: ok ? 'Points at the current install.' : 'Stale command, path, or runtime env.', fixActionId: ok ? undefined : 'reinstall' });
                    }
                }
                catch { /* Skip */ }
            }
            try {
                const raw = fs_1.default.readFileSync(configPaths.opencode, 'utf-8');
                const parsed = JSON.parse(raw);
                const entry = parsed.mcp?.[expected.configKey];
                if (!entry) {
                    checks.push({ id: 'opencode-entry', label: 'OpenCode config has 1DevTool entry', status: 'warn', detail: 'No entry. Install to add it.', fixActionId: 'reinstall' });
                }
                else {
                    const command = Array.isArray(entry.command) ? entry.command : [];
                    const ok = command[0] === expected.config.command &&
                        command[1] === expected.config.args[0] &&
                        envMatches(entry.environment) &&
                        entry.enabled !== false;
                    checks.push({ id: 'opencode-entry', label: 'OpenCode config has 1DevTool entry', status: ok ? 'pass' : 'fail', detail: ok ? 'Points at the current install.' : 'Stale command, path, runtime env, or disabled.', fixActionId: ok ? undefined : 'reinstall' });
                }
            }
            catch { /* Skip */ }
            try {
                const document = (0, yaml_1.parseDocument)(fs_1.default.readFileSync(configPaths.hermes, 'utf-8'));
                const config = document.toJS();
                const entry = config.mcp_servers?.[expected.configKey];
                if (!entry) {
                    checks.push({ id: 'hermes-entry', label: 'Hermes config has 1DevTool entry', status: 'warn', detail: 'No entry. Install to add it.', fixActionId: 'reinstall' });
                }
                else {
                    const ok = jsonEntryMatches(entry);
                    checks.push({ id: 'hermes-entry', label: 'Hermes config has 1DevTool entry', status: ok ? 'pass' : 'fail', detail: ok ? 'Points at the current install.' : 'Stale command, path, or runtime env.', fixActionId: ok ? undefined : 'reinstall' });
                }
            }
            catch { /* Skip */ }
        }
        // 7) Smoke-spawn: can we run the server script with the configured runtime?
        {
            const serverPath = (0, setup_1.getFeatureServerPath)();
            if (fs_1.default.existsSync(serverPath)) {
                const expected = await (0, setup_1.getExpectedMcpEntry)();
                try {
                    const spawned = await new Promise((resolve) => {
                        const { spawn } = require('child_process');
                        const proc = spawn(expected.config.command, expected.config.args, {
                            env: { ...process.env, ...(expected.config.env ?? {}) },
                            stdio: ['pipe', 'pipe', 'pipe'],
                        });
                        let stderr = '';
                        let spawnError = null;
                        const timer = setTimeout(() => {
                            try {
                                proc.kill();
                            }
                            catch { /* ignore */ }
                            resolve({ ok: true, detail: `Spawned successfully via ${expected.config.command}` });
                        }, 1500);
                        proc.on('error', (err) => {
                            spawnError = err;
                            clearTimeout(timer);
                            resolve({ ok: false, detail: err.code === 'ENOENT' ? `${expected.config.command} not found.` : err.message });
                        });
                        proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
                        proc.on('exit', (code) => {
                            if (spawnError)
                                return;
                            clearTimeout(timer);
                            if (code && code !== 0) {
                                resolve({ ok: false, detail: `Exited with code ${code}. stderr: ${stderr.slice(0, 400)}` });
                            }
                            else {
                                resolve({ ok: true, detail: `Started and exited cleanly via ${expected.config.command}` });
                            }
                        });
                        proc.stdin?.end();
                    });
                    checks.push({ id: 'spawn', label: `Spawn 1DevTool MCP via ${path_1.default.basename(expected.config.command)}`, status: spawned.ok ? 'pass' : 'fail', detail: spawned.detail });
                }
                catch (err) {
                    checks.push({ id: 'spawn', label: 'Spawn 1DevTool MCP runtime', status: 'fail', detail: err instanceof Error ? err.message : String(err) });
                }
            }
        }
        return { checks };
    });
    /**
     * Pillar 5 — fix actions invoked from the diagnostic UI. Each action
     * corresponds to a `fixActionId` returned by mcp:diagnose.
     */
    electron_1.ipcMain.handle('mcp:run-fix-action', async (_, actionId) => {
        try {
            if (actionId === 'restart-bridge') {
                getMcpBridge()?.stop();
                restartMcpBridge();
                return { ok: true, message: 'Bridge restarted.' };
            }
            if (actionId === 'reinstall') {
                const result = await (0, setup_1.install)();
                return result.ok
                    ? { ok: true, message: 'Reinstalled 1DevTool MCP.' }
                    : { ok: false, message: result.error || 'Reinstall failed' };
            }
            if (actionId.startsWith('open-config:')) {
                const client = actionId.slice('open-config:'.length);
                const paths = getMcpConfigPaths();
                const target = client === 'claude'
                    ? paths.claude
                    : client === 'gemini'
                        ? paths.gemini
                        : client === 'kimi'
                            ? paths.kimi
                            : client === 'codex'
                                ? paths.codex
                                : client === 'opencode'
                                    ? paths.opencode
                                    : client === 'grok'
                                        ? paths.grok
                                        : client === 'hermes'
                                            ? paths.hermes
                                            : client === 'cursor'
                                                ? paths.cursor
                                                : null;
                if (target) {
                    await electron_1.shell.openPath(target);
                    return { ok: true, message: `Opened ${target} in the default editor.` };
                }
            }
            return { ok: false, message: `Unknown action: ${actionId}` };
        }
        catch (err) {
            return { ok: false, message: err instanceof Error ? err.message : String(err) };
        }
    });
}
