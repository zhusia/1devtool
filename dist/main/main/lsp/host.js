"use strict";
/**
 * LSPHost — per-project Language Server Protocol child process manager.
 *
 * ## What this file owns
 *
 * - Spawning language-server child processes (`typescript-language-server`,
 *   `gopls`, `pyright-langserver`, etc.) per `(projectId, languageId)` pair.
 * - Wrapping each child's stdio in `vscode-jsonrpc`'s `StreamMessageReader` /
 *   `StreamMessageWriter` so the byte framing (`Content-Length: …\r\n\r\n…`)
 *   is parsed into structured `Message` objects.
 * - Forwarding each parsed message *verbatim* across an Electron
 *   `MessageChannelMain` port pair to the renderer. Main is a **pure byte
 *   transport** — it does NOT build a `MessageConnection`, does NOT send
 *   `initialize`, does NOT register handlers, does NOT interpret message
 *   contents. The renderer owns the LSP protocol entirely (Decision 2 in
 *   docs/product/proposals/multi-language-lsp-support.md). This asymmetry is deliberate:
 *   answers to server-to-client requests like `workspace/configuration` and
 *   `workspace/applyEdit` depend on renderer-side state (open editor models,
 *   undo stacks), so putting the protocol in the renderer eliminates an
 *   entire class of init-time race conditions.
 *
 * ## What this file does NOT own
 *
 * - LSP protocol semantics (renderer's job).
 * - Auto-spawn / auto-eviction. The user explicitly enables LSP per project
 *   via the sidebar context menu. There is no `MemoryBudgetController` and
 *   no LRU eviction — the user is the budget controller. They opted in,
 *   they pay the RSS, they explicitly disable to free it.
 * - Crash respawn. If a child dies, we mark the instance `crashed`, surface
 *   it to the renderer, and stop. The user manually clicks "Restart language
 *   servers" if they want it back. This deliberately avoids the respawn-loop
 *   class of bug that the original plan's `crashRefusal` map exists to
 *   prevent.
 * - Multi-instance routing across projects. The renderer keys clients by
 *   `${projectId}::${languageId}` and routes by file → owning project. There
 *   is no `resolveWorkspaceRoot` marker walking — `workspaceRoot ===
 *   project.rootPath`, always.
 *
 * ## Lifecycle invariants
 *
 * 1. `enableForProject` is idempotent: calling it twice for the same project
 *    is a no-op for already-running languages, and only spawns ones that are
 *    in `languageIds` but not yet in `instances`. This makes "Restart language
 *    servers" a clean disable + enable, and makes app-startup respawn for
 *    sticky `lspEnabled` projects safe.
 * 2. `disableForProject` waits for child exit before resolving. Callers can
 *    rely on "after this resolves, no PIDs from this project are still
 *    alive."
 * 3. `child.on('exit')` is the **only** path that removes an instance from
 *    `instances`. Both `disableForProject` and child crashes funnel through
 *    it. This guarantees the renderer's `lsp:crashed` notification fires
 *    exactly once per child death (whether intentional or unexpected) and
 *    that `instances` cannot leak references to dead PIDs.
 * 4. After `enableForProject` returns, the renderer is guaranteed to have
 *    received an `lsp:port` message for every spawned instance — because we
 *    `await` the port post until each one resolves before returning.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LSPHost = void 0;
exports.detectLanguagesInProject = detectLanguagesInProject;
const child_process_1 = require("child_process");
const electron_1 = require("electron");
const node_1 = require("vscode-jsonrpc/node");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const env_1 = require("../utils/env");
const registry_1 = require("./registry");
const installer_1 = require("./installer");
const STDERR_TAIL_BYTES = 4 * 1024;
function makeInstanceId(projectId, languageId) {
    return `${projectId}::${languageId}`;
}
class LSPHost {
    instances = new Map();
    window = null;
    /**
     * Wire up the host to the main `BrowserWindow`. Called once after window
     * creation. Subsequent `webContents.postMessage('lsp:port', …)` calls land
     * in the renderer.
     */
    attachWindow(window) {
        this.window = window;
    }
    /**
     * Spawn (or no-op) the requested language servers for the given project.
     *
     * - Idempotent per (projectId, languageId): existing healthy instances are
     *   left alone, only missing ones are spawned.
     * - Resolves once each spawn either succeeds (port posted, status `starting`)
     *   or fails (binary missing, spawn error). Failures are reported in the
     *   result, not thrown — partial-success is the normal case (e.g., TS works,
     *   Python server not installed).
     */
    async enableForProject(options) {
        const result = {
            projectId: options.projectId,
            spawned: [],
            failed: [],
        };
        for (const languageId of options.languageIds) {
            const instanceId = makeInstanceId(options.projectId, languageId);
            if (this.instances.has(instanceId)) {
                // Already running — idempotent no-op.
                result.spawned.push({ languageId, instanceId });
                continue;
            }
            try {
                await this.spawnInstance({
                    projectId: options.projectId,
                    projectRoot: options.projectRoot,
                    languageId,
                });
                result.spawned.push({ languageId, instanceId });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                result.failed.push({ languageId, error: message });
            }
        }
        return result;
    }
    /**
     * Cleanly shut down all language servers for a project. Resolves after the
     * last child has exited (the `child.on('exit')` handler does the actual
     * cleanup).
     */
    async disableForProject(projectId) {
        const projectInstances = [...this.instances.values()].filter((instance) => instance.projectId === projectId);
        if (projectInstances.length === 0)
            return;
        await Promise.all(projectInstances.map((instance) => this.shutdownInstance(instance, 'stopped')));
    }
    /**
     * Get the current status of all instances for one project (or all projects
     * if `projectId` is undefined). Used by the status bar indicator and the
     * settings tab.
     */
    getProjectStatus(projectId) {
        const byProject = new Map();
        for (const instance of this.instances.values()) {
            if (projectId && instance.projectId !== projectId)
                continue;
            const list = byProject.get(instance.projectId) ?? [];
            list.push({
                instanceId: instance.instanceId,
                projectId: instance.projectId,
                languageId: instance.languageId,
                status: instance.status,
                serverBinaryPath: instance.serverBinaryPath,
                startedAt: instance.startedAt,
                errorMessage: instance.errorMessage,
            });
            byProject.set(instance.projectId, list);
        }
        if (projectId && !byProject.has(projectId)) {
            return [{ projectId, enabled: false, instances: [] }];
        }
        return [...byProject.entries()].map(([pid, instances]) => ({
            projectId: pid,
            enabled: instances.length > 0,
            instances,
        }));
    }
    /**
     * Called from `app.before-quit` to ensure no LSP children outlive the app.
     * Synchronous best-effort: we send SIGTERM to every child and don't wait,
     * because main is in the process of exiting anyway.
     */
    shutdownAll() {
        for (const instance of this.instances.values()) {
            try {
                instance.child.kill('SIGTERM');
            }
            catch {
                // Ignore — process may already be dead.
            }
        }
        this.instances.clear();
    }
    /**
     * Mark the renderer as having attached its end of the MessagePort and
     * actually parsed the `lsp:port` message. The renderer fires this back via
     * IPC after wiring up its `MessageConnection`. Used to flip status from
     * `starting` → `ready` once the renderer's `initialize` round-trips
     * successfully — but for v0 we just trust the renderer to manage its own
     * client state and only flip on `notifyInitialized`.
     */
    notifyInitialized(instanceId) {
        const instance = this.instances.get(instanceId);
        if (!instance)
            return;
        instance.status = 'ready';
    }
    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------
    async spawnInstance(args) {
        const definition = (0, registry_1.getLspLanguageDefinition)(args.languageId);
        if (!definition) {
            throw new Error(`Unknown LSP language: ${args.languageId}`);
        }
        // Resolve the binary via the existing detection helper. This handles the
        // configured-path → system PATH fallback chain. We do NOT walk into the
        // project's node_modules to find a project-local binary in v0 — that's a
        // future enhancement (per-project node_modules/.bin/typescript-language-server
        // is more correct than a system one for monorepos with version skew).
        const status = await (0, installer_1.detectLanguageStatus)(args.languageId, {
            // Empty preferences — we just want the detection result, not the user's
            // enable list. The detection helper only reads `installPaths`.
            enabled: [],
            installPaths: {},
            installedVersions: {},
            autoStart: false,
            preferSystemBinaries: true,
            diagnosticsEnabled: true,
        });
        if (!status.detected || !status.binaryPath) {
            throw new Error(`${definition.displayName} server not detected. Install with: ${definition.install.systemHint ?? definition.install.command ?? '(see docs)'}`);
        }
        // Spawn args. Most LSP servers default to stdio when invoked with `--stdio`
        // or no transport flag. typescript-language-server and pyright both use
        // `--stdio`. gopls and rust-analyzer default to stdio. clangd defaults to
        // stdio. solargraph uses `stdio`. intelephense uses `--stdio`. We hardcode
        // a sensible per-language list here rather than trying to plumb arbitrary
        // args through the registry — keeps the registry simple and the spawn
        // command predictable.
        const spawnArgs = stdioArgsForLanguage(args.languageId);
        const child = (0, child_process_1.spawn)(status.binaryPath, spawnArgs, {
            cwd: args.projectRoot,
            // Cap Node-based LSP heap (typescript-language-server, vscode-langservers-extracted)
            // to 512MB. Default Node heap is ~4GB — unbounded ts servers have been observed
            // to balloon to 1-2GB on medium projects. Native servers (gopls, rust-analyzer,
            // clangd) ignore NODE_OPTIONS, so this is safe to apply globally.
            env: (0, env_1.getEnrichedEnv)({ NODE_OPTIONS: '--max-old-space-size=512' }),
            stdio: ['pipe', 'pipe', 'pipe'],
            // On Windows, npm-installed binaries (typescript-language-server, etc.)
            // are .cmd scripts — spawn needs shell: true to execute them.
            shell: process.platform === 'win32',
        });
        // If the binary itself is missing or unexecutable, the error fires
        // asynchronously after spawn. Catch it and rethrow with context so the
        // caller surfaces a useful message.
        let spawnError = null;
        child.once('error', (err) => {
            spawnError = err;
        });
        // Give the OS a microtask to surface ENOENT before we proceed.
        await new Promise((resolve) => setImmediate(resolve));
        if (spawnError) {
            throw new Error(`Failed to spawn ${definition.displayName} server (${status.binaryPath}): ${spawnError.message}`);
        }
        // Build the byte-transport readers/writers around the child's stdio.
        const reader = new node_1.StreamMessageReader(child.stdout);
        const writer = new node_1.StreamMessageWriter(child.stdin);
        // Build the MessageChannelMain port pair. `port1` (mainPort) lives in
        // main and is used to forward bytes between child stdio and the renderer.
        // `port2` (rendererPort) is transferred to the renderer via
        // `webContents.postMessage`.
        const { port1: mainPort, port2: rendererPort } = new electron_1.MessageChannelMain();
        const instance = {
            instanceId: makeInstanceId(args.projectId, args.languageId),
            projectId: args.projectId,
            projectRoot: args.projectRoot,
            languageId: args.languageId,
            serverBinaryPath: status.binaryPath,
            child,
            reader,
            writer,
            rendererPort,
            mainPort,
            status: 'starting',
            startedAt: Date.now(),
            errorMessage: null,
            stderrTail: '',
        };
        // Wire child.stdout (parsed messages) → mainPort.postMessage → renderer.
        // We send the message *as a structured object*. Electron's structured
        // clone handles the JSON-RPC `Message` shape natively (it's plain JSON-
        // compatible), no extra serialization needed.
        reader.listen((message) => {
            try {
                instance.mainPort.postMessage(message);
            }
            catch (error) {
                // Port may be closed if the renderer disposed; that's a renderer bug
                // but it shouldn't crash main. Just stop forwarding.
                console.warn(`[lsp-host] failed to forward message to renderer for ${instance.instanceId}:`, error);
            }
        });
        // Wire mainPort.on('message') (from renderer) → writer.write → child.stdin.
        instance.mainPort.on('message', (event) => {
            const message = event.data;
            writer.write(message).catch((error) => {
                console.warn(`[lsp-host] failed to write to child stdin for ${instance.instanceId}:`, error);
            });
        });
        instance.mainPort.start();
        // Capture stderr for crash diagnostics. The tail is bounded so a chatty
        // server doesn't blow up main's heap.
        child.stderr.on('data', (chunk) => {
            const piece = chunk.toString('utf8');
            instance.stderrTail = (instance.stderrTail + piece).slice(-STDERR_TAIL_BYTES);
        });
        // The single source of truth for instance removal. Both intentional
        // shutdown (via `shutdownInstance`) and unexpected death funnel through
        // here.
        child.on('exit', (code, signal) => {
            this.handleChildExit(instance, code, signal);
        });
        // Add to the registry. Important: do this BEFORE posting the port to the
        // renderer, so any IPC the renderer fires back lands in a known instance.
        this.instances.set(instance.instanceId, instance);
        // Hand the renderer end of the port over via webContents.postMessage. The
        // renderer's `lsp:port` listener will pick it up, build a
        // `RendererLSPClient` around it, and send `initialize`.
        if (!this.window || this.window.isDestroyed()) {
            // Window is gone — clean up the instance we just created.
            this.handleChildExit(instance, null, null);
            throw new Error('Main window not available — cannot post LSP port to renderer');
        }
        const portMessage = {
            instanceId: instance.instanceId,
            projectId: instance.projectId,
            projectRoot: instance.projectRoot,
            languageId: instance.languageId,
            serverBinaryPath: instance.serverBinaryPath,
        };
        this.window.webContents.postMessage('lsp:port', portMessage, [instance.rendererPort]);
    }
    /**
     * Initiate a clean shutdown for one instance. Sends SIGTERM and resolves
     * once the `child.on('exit')` handler has run cleanup. The `reason` is
     * stored on the instance so the exit handler knows whether this was
     * user-initiated (`stopped`) or unexpected (`crashed`).
     */
    shutdownInstance(instance, reason) {
        return new Promise((resolve) => {
            instance.status = reason;
            // Hook the exit event we already attached — but capture our own resolve
            // here so we know cleanup ran.
            const onExit = () => resolve();
            instance.child.once('exit', onExit);
            try {
                instance.child.kill('SIGTERM');
            }
            catch {
                // Already dead — fire the resolve manually.
                instance.child.removeListener('exit', onExit);
                this.handleChildExit(instance, null, 'SIGTERM');
                resolve();
            }
        });
    }
    /**
     * The single cleanup point. Removes the instance from the map, closes
     * ports, and notifies the renderer. Idempotent — safe to call multiple
     * times for the same instance (subsequent calls are no-ops because the
     * instance is already gone from the map).
     */
    handleChildExit(instance, code, signal) {
        if (!this.instances.has(instance.instanceId)) {
            // Already cleaned up.
            return;
        }
        this.instances.delete(instance.instanceId);
        // Close ports. Wrap each in try/catch since they may be in any state.
        try {
            instance.mainPort.close();
        }
        catch { /* ignore */ }
        try {
            instance.reader.dispose?.();
        }
        catch { /* ignore */ }
        // Determine the final status: if shutdownInstance was called, status is
        // already `'stopped'`. Otherwise this was an unexpected death.
        const wasIntentional = instance.status === 'stopped';
        const finalStatus = wasIntentional ? 'stopped' : 'crashed';
        // Notify the renderer. Even on intentional shutdown we send this so the
        // renderer can dispose its client and clear markers.
        if (this.window && !this.window.isDestroyed()) {
            const message = {
                instanceId: instance.instanceId,
                projectId: instance.projectId,
                languageId: instance.languageId,
                exitCode: code,
                signal,
                stderrTail: instance.stderrTail,
            };
            // We use the same channel name (`lsp:crashed`) for both intentional and
            // unexpected exits — the renderer treats both as "tear down this client."
            // The status field on subsequent `getProjectStatus` calls reflects the
            // distinction.
            this.window.webContents.send('lsp:crashed', { ...message, status: finalStatus });
        }
    }
}
exports.LSPHost = LSPHost;
/**
 * Per-language stdio invocation arguments. Adding a new language usually means
 * adding a row here AND a registry entry. Most servers accept `--stdio` or
 * default to stdio with no flag.
 */
function stdioArgsForLanguage(languageId) {
    switch (languageId) {
        case 'typescript':
            return ['--stdio'];
        case 'python':
            return ['--stdio'];
        case 'go':
            return []; // gopls defaults to stdio
        case 'rust':
            return []; // rust-analyzer defaults to stdio
        case 'cpp':
            return []; // clangd defaults to stdio
        case 'ruby':
            return ['stdio']; // solargraph
        case 'php':
            return ['--stdio'];
        case 'swift':
            return []; // sourcekit-lsp defaults to stdio
        case 'csharp':
            return []; // csharp-ls defaults to stdio
        default:
            return ['--stdio'];
    }
}
/**
 * Helper used by the project-detection IPC handler to walk a project root and
 * count files matching each language's extensions. We cap the walk at a
 * generous file budget so detection doesn't hang on huge monorepos. node_modules,
 * .git, and other heavy-but-irrelevant directories are skipped.
 */
const SKIP_DIRS = new Set([
    'node_modules',
    '.git',
    '.next',
    '.nuxt',
    'dist',
    'build',
    'target', // rust
    '.venv',
    'venv',
    '__pycache__',
    '.cache',
    '.turbo',
    'coverage',
]);
const MAX_FILES_TO_SCAN = 5000;
function detectLanguagesInProject(projectRoot) {
    const counts = new Map();
    let scanned = 0;
    function walk(dir) {
        if (scanned >= MAX_FILES_TO_SCAN)
            return;
        let entries;
        try {
            entries = fs_1.default.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (scanned >= MAX_FILES_TO_SCAN)
                return;
            if (entry.name.startsWith('.') && entry.name !== '.clangd') {
                // Skip dotfiles and dot-directories (except .clangd which is a marker).
                if (entry.isDirectory())
                    continue;
            }
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name))
                    continue;
                walk(path_1.default.join(dir, entry.name));
                continue;
            }
            if (!entry.isFile())
                continue;
            scanned++;
            const ext = path_1.default.extname(entry.name).toLowerCase();
            const languageId = languageIdForExtension(ext);
            if (languageId) {
                counts.set(languageId, (counts.get(languageId) ?? 0) + 1);
            }
        }
    }
    walk(projectRoot);
    return counts;
}
function languageIdForExtension(ext) {
    switch (ext) {
        case '.ts':
        case '.tsx':
        case '.js':
        case '.jsx':
        case '.mjs':
        case '.cjs':
            return 'typescript';
        case '.py':
        case '.pyi':
            return 'python';
        case '.go':
            return 'go';
        case '.rs':
            return 'rust';
        case '.c':
        case '.cc':
        case '.cpp':
        case '.cxx':
        case '.h':
        case '.hpp':
            return 'cpp';
        case '.rb':
            return 'ruby';
        case '.php':
            return 'php';
        case '.swift':
            return 'swift';
        case '.cs':
        case '.csx':
            return 'csharp';
        default:
            return null;
    }
}
