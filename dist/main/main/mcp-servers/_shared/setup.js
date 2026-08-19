"use strict";
/**
 * Unified MCP setup — manages the single 1DevTool MCP server entry in Claude,
 * Gemini, Codex, OpenCode, Grok, and Hermes client configs.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerMcpNodePathProvider = registerMcpNodePathProvider;
exports.invalidateResolvedNode = invalidateResolvedNode;
exports.resolveNodeCommand = resolveNodeCommand;
exports.autoDetectNodePath = autoDetectNodePath;
exports.install = install;
exports.uninstall = uninstall;
exports.getMcpConfigJson = getMcpConfigJson;
exports.getFeatureServerPath = getFeatureServerPath;
exports.getExpectedMcpEntry = getExpectedMcpEntry;
exports.getCodexConfigPathForDiagnostics = getCodexConfigPathForDiagnostics;
exports.getGrokConfigPathForDiagnostics = getGrokConfigPathForDiagnostics;
exports.getOpenCodeConfigPathForDiagnostics = getOpenCodeConfigPathForDiagnostics;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const child_process_1 = require("child_process");
const electron_1 = require("electron");
const yaml_1 = require("yaml");
const env_1 = require("../../utils/env");
const hermesPaths_1 = require("../../hermesPaths");
const kimiPaths_1 = require("../../kimiPaths");
const UNIFIED_SERVER_SUBPATH = 'mcp-servers/server.js';
// Grok prefixes tool names with the configured server key and rejects the
// resulting functions when that key begins with a digit. Keep the shared key
// alphabetic so the same entry works in Grok and in clients Grok imports.
const UNIFIED_CONFIG_KEY = 'onedevtool';
const LEGACY_CONFIG_KEYS = ['1devtool', '1devtool-design', '1devtool-database', '1devtool-http', '1devtool-channels'];
function getClaudeConfigPath() {
    return path_1.default.join(os_1.default.homedir(), '.claude.json');
}
function getGeminiConfigPath() {
    return path_1.default.join(os_1.default.homedir(), '.gemini', 'settings.json');
}
function getKimiConfigPath() {
    return path_1.default.join((0, kimiPaths_1.getKimiHome)(), 'mcp.json');
}
function getCodexConfigPath() {
    return path_1.default.join(os_1.default.homedir(), '.codex', 'config.toml');
}
function getGrokConfigPath() {
    return path_1.default.join(os_1.default.homedir(), '.grok', 'config.toml');
}
function getCursorConfigPath() {
    return path_1.default.join(os_1.default.homedir(), '.cursor', 'mcp.json');
}
function getHermesConfigPath() {
    return path_1.default.join((0, hermesPaths_1.getHermesHome)(), 'config.yaml');
}
function getOpenCodeConfigPath() {
    if (process.platform === 'win32') {
        return path_1.default.join(process.env.APPDATA ?? path_1.default.join(os_1.default.homedir(), 'AppData', 'Roaming'), 'opencode', 'opencode.json');
    }
    return path_1.default.join(process.env.XDG_CONFIG_HOME ?? path_1.default.join(os_1.default.homedir(), '.config'), 'opencode', 'opencode.json');
}
function getServerScriptPath() {
    if (electron_1.app.isPackaged) {
        return path_1.default.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'main', 'main', UNIFIED_SERVER_SUBPATH);
    }
    return path_1.default.join(electron_1.app.getAppPath(), 'dist', 'main', 'main', UNIFIED_SERVER_SUBPATH);
}
/**
 * Runtime used by external MCP clients to execute the bundled server.
 *
 * Packaged installs use the app executable with ELECTRON_RUN_AS_NODE=1 so the
 * MCP subprocess uses the Node runtime shipped with 1DevTool instead of a
 * user-managed Homebrew/nvm/Volta Node. This mirrors 1AIVault's packaged MCP
 * strategy and keeps installs independent of the user's PATH.
 */
function getMcpRuntimeCommand() {
    if (electron_1.app.isPackaged && process.platform === 'linux' && process.env.APPIMAGE) {
        return process.env.APPIMAGE;
    }
    return process.execPath;
}
function getMcpNodeModulesPath() {
    if (electron_1.app.isPackaged) {
        return path_1.default.join(process.resourcesPath, 'app.asar', 'node_modules');
    }
    return path_1.default.join(electron_1.app.getAppPath(), 'node_modules');
}
let resolvedNodeCommand = null;
let mcpNodePathProvider = () => '';
/** Register a provider that reads the user's mcpNodePath preference. */
function registerMcpNodePathProvider(provider) {
    mcpNodePathProvider = provider;
}
/** Clear cached result so the next install() re-resolves (e.g. after PATH change). */
function invalidateResolvedNode() {
    resolvedNodeCommand = null;
}
function execFileAsync(cmd, args, options) {
    return new Promise((resolve, reject) => {
        (0, child_process_1.execFile)(cmd, args, { ...options, encoding: 'utf-8' }, (err, stdout) => {
            if (err)
                reject(err);
            else
                resolve(stdout);
        });
    });
}
/**
 * Resolve the absolute path to `node` so MCP configs work even when the
 * spawning process (Claude Code, Codex, etc.) has a minimal PATH that
 * doesn't include /usr/local/bin, /opt/homebrew/bin, nvm/fnm/volta dirs.
 */
let resolveInFlight = null;
/**
 * Pure detection logic shared by both the cached resolve and the
 * cache-bypassing auto-detect. Returns the first valid absolute path
 * to a `node` binary, or bare `'node'` as a last resort.
 */
async function detectNodePath(opts) {
    const isWin = process.platform === 'win32';
    const nodeExe = isWin ? 'node.exe' : 'node';
    const home = os_1.default.homedir();
    // 0. User override from Settings → MCP → Node Fallback
    if (opts.checkUserOverride) {
        try {
            const override = mcpNodePathProvider().trim();
            if (override && fs_1.default.existsSync(override))
                return override;
        }
        catch { /* continue */ }
    }
    // 1. Shell-based lookup — most reliable, catches all version managers
    try {
        if (isWin) {
            const raw = (await execFileAsync('cmd.exe', ['/c', 'where', 'node'], {
                timeout: 5000,
                windowsHide: true,
            })).trim();
            for (const line of raw.split(/\r?\n/)) {
                const p = line.trim();
                if (p && fs_1.default.existsSync(p))
                    return p;
            }
        }
        else {
            const shell = process.env.SHELL || '/bin/zsh';
            const result = (await execFileAsync(shell, ['-l', '-c', 'which node'], {
                timeout: 5000,
            })).trim();
            if (result && fs_1.default.existsSync(result))
                return result;
        }
    }
    catch { /* continue */ }
    // 2. Well-known paths per platform
    const candidates = isWin
        ? [
            path_1.default.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', nodeExe),
            path_1.default.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'nodejs', nodeExe),
            path_1.default.join(process.env.NVM_SYMLINK ?? path_1.default.join(process.env.APPDATA ?? path_1.default.join(home, 'AppData', 'Roaming'), 'nvm'), nodeExe),
            path_1.default.join(process.env.FNM_MULTISHELL_PATH ?? path_1.default.join(home, '.fnm', 'aliases', 'default'), nodeExe),
            path_1.default.join(process.env.LOCALAPPDATA ?? path_1.default.join(home, 'AppData', 'Local'), 'fnm_multishells', nodeExe),
            path_1.default.join(home, '.volta', 'bin', nodeExe),
            path_1.default.join(home, 'scoop', 'shims', nodeExe),
            path_1.default.join(home, 'scoop', 'apps', 'nodejs', 'current', nodeExe),
            path_1.default.join(process.env.ChocolateyInstall ?? 'C:\\ProgramData\\chocolatey', 'bin', nodeExe),
            path_1.default.join(home, '.proto', 'shims', nodeExe),
        ]
        : [
            '/opt/homebrew/bin/node',
            '/usr/local/bin/node',
            '/usr/bin/node',
            '/snap/bin/node',
            path_1.default.join(home, '.nvm', 'current', 'bin', 'node'),
            path_1.default.join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'node'),
            path_1.default.join(home, '.fnm', 'aliases', 'default', 'bin', 'node'),
            path_1.default.join(home, '.volta', 'bin', 'node'),
            path_1.default.join(home, '.asdf', 'shims', 'node'),
            path_1.default.join(home, '.local', 'share', 'mise', 'shims', 'node'),
            path_1.default.join(home, '.proto', 'shims', 'node'),
            path_1.default.join(home, '.local', 'bin', 'node'),
        ];
    for (const candidate of candidates) {
        try {
            if (fs_1.default.existsSync(candidate))
                return candidate;
        }
        catch { /* continue */ }
    }
    // 3. Scan enriched PATH (includes user's Settings → System → Extra PATH entries)
    for (const dir of (0, env_1.getEnrichedPath)().split(path_1.default.delimiter)) {
        if (!dir)
            continue;
        const candidate = path_1.default.join(dir, nodeExe);
        try {
            if (fs_1.default.existsSync(candidate))
                return candidate;
        }
        catch { /* continue */ }
    }
    return 'node';
}
/**
 * Resolve the absolute path to `node` so MCP configs work even when the
 * spawning process (Claude Code, Codex, etc.) has a minimal PATH that
 * doesn't include /usr/local/bin, /opt/homebrew/bin, nvm/fnm/volta dirs.
 *
 * Results are cached. Use `invalidateResolvedNode()` before calling to
 * force a fresh scan.
 */
async function resolveNodeCommand() {
    if (resolvedNodeCommand)
        return resolvedNodeCommand;
    // Deduplicate concurrent calls so only one shell spawn happens
    if (resolveInFlight)
        return resolveInFlight;
    resolveInFlight = detectNodePath({ checkUserOverride: true }).then((result) => {
        resolvedNodeCommand = result;
        resolveInFlight = null;
        return result;
    }).catch(() => {
        resolveInFlight = null;
        resolvedNodeCommand = 'node';
        return 'node';
    });
    return resolveInFlight;
}
/**
 * Run detection without the user override and without touching the cache.
 * Used by the "Auto-detect" UI button.
 */
async function autoDetectNodePath() {
    return detectNodePath({ checkUserOverride: false });
}
async function buildMcpConfig() {
    return {
        command: getMcpRuntimeCommand(),
        args: [getServerScriptPath()],
        env: {
            ELECTRON_RUN_AS_NODE: '1',
            NODE_PATH: getMcpNodeModulesPath(),
            NODE_OPTIONS: '--max-old-space-size=64',
        },
    };
}
function ensureWritableParent(filePath) {
    fs_1.default.mkdirSync(path_1.default.dirname(filePath), { recursive: true });
    fs_1.default.accessSync(path_1.default.dirname(filePath), fs_1.default.constants.W_OK);
}
function readJsonConfig(configPath) {
    if (!fs_1.default.existsSync(configPath))
        return {};
    try {
        return JSON.parse(fs_1.default.readFileSync(configPath, 'utf-8'));
    }
    catch {
        return {};
    }
}
function writeJsonConfig(configPath, config) {
    ensureWritableParent(configPath);
    fs_1.default.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}
function upsertJsonMcpServer(configPath, configKey, configValue) {
    const config = readJsonConfig(configPath);
    const mcpServers = (config.mcpServers ?? {});
    mcpServers[configKey] = configValue;
    config.mcpServers = mcpServers;
    writeJsonConfig(configPath, config);
}
function removeJsonMcpServer(configPath, configKey) {
    const config = readJsonConfig(configPath);
    const mcpServers = config.mcpServers;
    if (!mcpServers)
        return;
    delete mcpServers[configKey];
    config.mcpServers = mcpServers;
    writeJsonConfig(configPath, config);
}
function tomlString(value) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function removeTomlMcpServer(raw, configKey) {
    // Skip lines belonging to either the main table `[mcp_servers.<key>]` or any
    // sub-table `[mcp_servers.<key>.<sub>]`. **Exact-prefix match** (codex r5):
    // naive `startsWith('[mcp_servers.<key>')` would also match siblings like
    // `[mcp_servers.<key>2]`, swallowing neighboring entries on re-install.
    const mainHeader = `[mcp_servers.${configKey}]`;
    const subPrefix = `[mcp_servers.${configKey}.`;
    const lines = raw.split('\n');
    const next = [];
    let skipping = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === mainHeader || trimmed.startsWith(subPrefix)) {
            skipping = true;
            continue;
        }
        if (skipping && /^\s*\[/.test(line)) {
            skipping = false;
        }
        if (!skipping)
            next.push(line);
    }
    return next.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}
function upsertTomlMcpServer(configPath, configKey, configValue) {
    ensureWritableParent(configPath);
    const raw = fs_1.default.existsSync(configPath) ? fs_1.default.readFileSync(configPath, 'utf-8') : '';
    const base = removeTomlMcpServer(raw, configKey);
    const blockLines = [
        `[mcp_servers.${configKey}]`,
        `command = ${tomlString(configValue.command)}`,
        `args = [ ${configValue.args.map(tomlString).join(', ')} ]`,
    ];
    // Emit `[mcp_servers.<key>.env]` sub-table (Codex 0.134.0's TOML loader
    // treats this as the env map). The existing tomlString quoting handles
    // Windows backslashes and embedded quotes; control chars are not expected
    // in env values we emit. See Phase 4 of using_skills_plan.md.
    if (configValue.env && Object.keys(configValue.env).length > 0) {
        blockLines.push('', `[mcp_servers.${configKey}.env]`);
        for (const [k, v] of Object.entries(configValue.env)) {
            blockLines.push(`${k} = ${tomlString(v)}`);
        }
    }
    const block = blockLines.join('\n');
    const next = `${base ? `${base}\n\n` : ''}${block}\n`;
    fs_1.default.writeFileSync(configPath, next, 'utf-8');
}
function removeTomlMcpServerFromFile(configPath, configKey) {
    if (!fs_1.default.existsSync(configPath))
        return;
    const raw = fs_1.default.readFileSync(configPath, 'utf-8');
    fs_1.default.writeFileSync(configPath, `${removeTomlMcpServer(raw, configKey)}\n`, 'utf-8');
}
function toOpenCodeMcpServer(configValue) {
    const entry = {
        type: 'local',
        command: [configValue.command, ...configValue.args],
        enabled: true,
    };
    if (configValue.env && Object.keys(configValue.env).length > 0) {
        entry.environment = configValue.env;
    }
    return entry;
}
function upsertOpenCodeMcpServer(configPath, configKey, configValue) {
    const config = readJsonConfig(configPath);
    if (!config.$schema) {
        config.$schema = 'https://opencode.ai/config.json';
    }
    const mcp = (config.mcp ?? {});
    mcp[configKey] = toOpenCodeMcpServer(configValue);
    config.mcp = mcp;
    writeJsonConfig(configPath, config);
}
function removeOpenCodeMcpServer(configPath, configKey) {
    const config = readJsonConfig(configPath);
    const mcp = config.mcp;
    if (!mcp)
        return;
    delete mcp[configKey];
    config.mcp = mcp;
    writeJsonConfig(configPath, config);
}
function editHermesMcpServer(configPath, configKey, configValue) {
    if (configValue === null && !fs_1.default.existsSync(configPath))
        return;
    ensureWritableParent(configPath);
    const raw = fs_1.default.existsSync(configPath) ? fs_1.default.readFileSync(configPath, 'utf-8') : '{}\n';
    const document = (0, yaml_1.parseDocument)(raw);
    if (document.errors.length > 0) {
        throw new Error(`Hermes config is invalid YAML: ${document.errors[0].message}`);
    }
    if (configValue === null) {
        document.deleteIn(['mcp_servers', configKey]);
    }
    else {
        document.setIn(['mcp_servers', configKey], configValue);
    }
    fs_1.default.writeFileSync(configPath, document.toString(), 'utf-8');
}
function removeLegacyEntries() {
    for (const key of LEGACY_CONFIG_KEYS) {
        try {
            removeJsonMcpServer(getClaudeConfigPath(), key);
            removeJsonMcpServer(getGeminiConfigPath(), key);
            removeJsonMcpServer(getKimiConfigPath(), key);
            removeTomlMcpServerFromFile(getCodexConfigPath(), key);
            removeTomlMcpServerFromFile(getGrokConfigPath(), key);
            removeOpenCodeMcpServer(getOpenCodeConfigPath(), key);
            editHermesMcpServer(getHermesConfigPath(), key, null);
        }
        catch {
            // Non-fatal
        }
    }
}
/** Install the unified 1DevTool MCP server entry in all supported client configs. */
async function install() {
    invalidateResolvedNode();
    const serverPath = getServerScriptPath();
    const configPath = getClaudeConfigPath();
    const configureHermes = fs_1.default.existsSync((0, hermesPaths_1.getHermesHome)());
    const configPaths = [getClaudeConfigPath(), getGeminiConfigPath(), getKimiConfigPath(), getCodexConfigPath(), getOpenCodeConfigPath(), getGrokConfigPath(), getCursorConfigPath()];
    if (configureHermes)
        configPaths.push(getHermesConfigPath());
    const diagnostics = {
        platform: process.platform,
        homeDir: os_1.default.homedir(),
        configPath,
        serverPath,
        serverExists: false,
        configExists: false,
        configWritable: false,
        nodeVersion: process.version,
        isPackaged: electron_1.app.isPackaged,
    };
    try {
        diagnostics.serverExists = fs_1.default.existsSync(serverPath);
        diagnostics.configExists = configPaths.some((candidate) => fs_1.default.existsSync(candidate));
        try {
            for (const candidate of configPaths)
                ensureWritableParent(candidate);
            diagnostics.configWritable = true;
        }
        catch {
            diagnostics.configWritable = false;
        }
        if (!diagnostics.serverExists) {
            const error = `Server script not found at: ${serverPath}`;
            console.error(`[mcp-setup] ${error}`);
            return { ok: false, error, diagnostics };
        }
        if (!diagnostics.configWritable) {
            const error = `No write permission to config directory: ${path_1.default.dirname(configPath)}`;
            console.error(`[mcp-setup] ${error}`);
            return { ok: false, error, diagnostics };
        }
        removeLegacyEntries();
        const mcpConfig = await buildMcpConfig();
        upsertJsonMcpServer(getClaudeConfigPath(), UNIFIED_CONFIG_KEY, mcpConfig);
        upsertJsonMcpServer(getGeminiConfigPath(), UNIFIED_CONFIG_KEY, mcpConfig);
        upsertJsonMcpServer(getKimiConfigPath(), UNIFIED_CONFIG_KEY, mcpConfig);
        upsertTomlMcpServer(getCodexConfigPath(), UNIFIED_CONFIG_KEY, mcpConfig);
        upsertTomlMcpServer(getGrokConfigPath(), UNIFIED_CONFIG_KEY, mcpConfig);
        upsertOpenCodeMcpServer(getOpenCodeConfigPath(), UNIFIED_CONFIG_KEY, mcpConfig);
        // Cursor CLI and the Cursor editor share ~/.cursor/mcp.json (`mcpServers`).
        upsertJsonMcpServer(getCursorConfigPath(), UNIFIED_CONFIG_KEY, mcpConfig);
        if (configureHermes)
            editHermesMcpServer(getHermesConfigPath(), UNIFIED_CONFIG_KEY, mcpConfig);
        console.log(`[mcp-setup] Installed 1DevTool MCP → ${serverPath} (Claude, Gemini, Kimi, Codex, OpenCode, Grok, Cursor${configureHermes ? ', Hermes' : ''})`);
        return { ok: true, diagnostics };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[mcp-setup] Failed to install:', error);
        return { ok: false, error: message, diagnostics };
    }
}
/** Remove the 1DevTool MCP server entry from all supported client configs. */
function uninstall() {
    try {
        removeJsonMcpServer(getClaudeConfigPath(), UNIFIED_CONFIG_KEY);
        removeJsonMcpServer(getGeminiConfigPath(), UNIFIED_CONFIG_KEY);
        removeJsonMcpServer(getKimiConfigPath(), UNIFIED_CONFIG_KEY);
        removeTomlMcpServerFromFile(getCodexConfigPath(), UNIFIED_CONFIG_KEY);
        removeTomlMcpServerFromFile(getGrokConfigPath(), UNIFIED_CONFIG_KEY);
        removeOpenCodeMcpServer(getOpenCodeConfigPath(), UNIFIED_CONFIG_KEY);
        removeJsonMcpServer(getCursorConfigPath(), UNIFIED_CONFIG_KEY);
        editHermesMcpServer(getHermesConfigPath(), UNIFIED_CONFIG_KEY, null);
        removeLegacyEntries();
        console.log('[mcp-setup] Removed 1DevTool MCP');
    }
    catch {
        // Non-fatal
    }
}
/** Get JSON config snippet for manual copy/paste */
async function getMcpConfigJson() {
    const configs = {
        [UNIFIED_CONFIG_KEY]: await buildMcpConfig(),
    };
    return JSON.stringify(configs, null, 2);
}
/** Resolved on-disk server script path. Used by diagnostics. */
function getFeatureServerPath() {
    return getServerScriptPath();
}
/** Expected MCP entry that should appear in a client config. */
async function getExpectedMcpEntry() {
    return { configKey: UNIFIED_CONFIG_KEY, config: await buildMcpConfig() };
}
function getCodexConfigPathForDiagnostics() {
    return getCodexConfigPath();
}
function getGrokConfigPathForDiagnostics() {
    return getGrokConfigPath();
}
function getOpenCodeConfigPathForDiagnostics() {
    return getOpenCodeConfigPath();
}
