#!/usr/bin/env node
"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// dist/main/shared/headlessMode.js
var require_headlessMode = __commonJS({
  "dist/main/shared/headlessMode.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.HEADLESS_SPECS = void 0;
    exports2.buildHeadlessCommand = buildHeadlessCommand;
    exports2.buildHeadlessInvocation = buildHeadlessInvocation;
    exports2.parseCliCommand = parseCliCommand;
    exports2.HEADLESS_SPECS = {
      claude: { cliId: "claude", headlessFlag: "-p", promptPosition: "after-flag" },
      codex: { cliId: "codex", headlessFlag: "exec", promptPosition: "end", promptDelivery: "stdin", stdinPromptArg: "-", defaultFlags: ["--dangerously-bypass-approvals-and-sandbox", "--ephemeral", "--skip-git-repo-check"] },
      gemini: { cliId: "gemini", headlessFlag: "-p", promptPosition: "after-flag" },
      // `kimi -p` is already non-interactive and uses its automatic approval
      // policy; the CLI rejects combining --prompt with --yolo/--auto/--plan.
      kimi: { cliId: "kimi", headlessFlag: "-p", promptPosition: "after-flag", defaultFlags: [] },
      // Field evidence (Windows 1.59.0 logs): `agy --print -` with the prompt on
      // stdin treats the argv `-` as the user message ("empty or a placeholder
      // (`-`)") and never reads stdin. Deliver the prompt as an argv value, same
      // as claude/gemini. Long prompts stay under Windows' CreateProcess limit in
      // practice for headless orchestration; app-owned spawn quoting (buildSpawnSpec)
      // keeps metacharacters out of a shell.
      agy: { cliId: "agy", headlessFlag: "--print", promptPosition: "after-flag" },
      // cline takes the prompt as a positional argv (`cline [options] [prompt]`).
      // Do NOT switch it to stdin delivery: cline sniffs stdin to pick its mode,
      // and under execFile (pipe stdin, data written post-spawn) that sniff races
      // and it exits with "interactive mode requires a TTY". Argv via execFile is
      // shell-free, so the no-prompt-in-shell-args contract still holds.
      cline: { cliId: "cline", promptPosition: "end", defaultFlags: ["--auto-approve", "true"] },
      amp: { cliId: "amp", headlessFlag: "-x", promptPosition: "after-flag" },
      // `opencode run` rejects permission requests when no interactive UI can
      // answer them. `--auto` is the documented single-run approval mode.
      opencode: { cliId: "opencode", headlessFlag: "run", promptPosition: "after-flag", defaultFlags: ["--auto"] },
      qwen: { cliId: "qwen", headlessFlag: "-p", promptPosition: "after-flag" },
      // `grok -p` (alias --single): single-turn, prints to stdout and exits.
      grok: { cliId: "grok", headlessFlag: "-p", promptPosition: "after-flag", defaultFlags: ["--always-approve"] },
      hermes: { cliId: "hermes", headlessFlag: "-z", promptPosition: "after-flag", defaultFlags: [] },
      // Cursor takes the prompt as a positional argv (`agent [options] [prompt...]`),
      // so the prompt must come last — a trailing flag would be swallowed as more
      // prompt words. `--trust` only works alongside --print and is what keeps a
      // headless run from blocking on the workspace-trust prompt. `cliId` is the
      // binary (`cursor-agent`), NOT the key: `cursor` is the editor launcher.
      cursor: { cliId: "cursor-agent", headlessFlag: "-p", promptPosition: "end", defaultFlags: ["--force", "--trust"] },
      // Pi takes its prompt as positional argv, so it must come last or a
      // trailing flag is swallowed as prompt words. No approval flag exists to
      // add: pi has no permission prompts, and its project-trust selector is
      // skipped outright in non-interactive mode (dist/cli/project-trust.js
      // returns undefined when mode !== 'interactive'), so a headless run in an
      // untrusted project proceeds with project-local resources simply unloaded
      // rather than blocking. `--approve` is deliberately NOT a default: it
      // would silently trust project-local extensions/skills that can execute
      // code.
      pi: { cliId: "pi", headlessFlag: "-p", promptPosition: "end", defaultFlags: [] },
      aider: { cliId: "aider", headlessFlag: "--message", promptPosition: "after-flag" }
    };
    function buildHeadlessCommand(agentId, prompt, extraFlags) {
      const spec = exports2.HEADLESS_SPECS[agentId];
      const invocation = buildHeadlessInvocation(agentId, prompt, extraFlags);
      if (!spec || !invocation)
        return null;
      const command = [spec.cliId, ...invocation.args].map(shellQuote).join(" ");
      if (invocation.stdin !== void 0) {
        return `printf '%s' ${shellQuote(invocation.stdin)} | ${command}`;
      }
      return command;
    }
    function buildHeadlessInvocation(cliId, prompt, extraFlags) {
      const spec = exports2.HEADLESS_SPECS[cliId];
      if (!spec)
        return null;
      const headlessArgs = spec.headlessFlag ? [spec.headlessFlag] : [];
      const promptArgs = spec.promptDelivery === "stdin" ? spec.stdinPromptArg !== void 0 ? [spec.stdinPromptArg] : [] : [prompt];
      if (spec.promptPosition === "after-flag") {
        const args2 = [...headlessArgs, ...promptArgs, ...extraFlags];
        return spec.promptDelivery === "stdin" ? { args: args2, stdin: prompt } : { args: args2 };
      }
      const args = [...headlessArgs, ...extraFlags, ...promptArgs];
      return spec.promptDelivery === "stdin" ? { args, stdin: prompt } : { args };
    }
    function parseCliCommand(command) {
      const parts = command.trim().split(/\s+/);
      return { binary: parts[0], flags: parts.slice(1) };
    }
    function shellQuote(value) {
      if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value))
        return value;
      return `'${value.replace(/'/g, `'\\''`)}'`;
    }
  }
});

// dist/main/shared/mcpTerminalIdentity.js
var require_mcpTerminalIdentity = __commonJS({
  "dist/main/shared/mcpTerminalIdentity.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.ONEDEVTOOL_TERMINAL_ID_ENV = void 0;
    exports2.readOneDevToolTerminalId = readOneDevToolTerminalId;
    exports2.withOneDevToolTerminalEnv = withOneDevToolTerminalEnv;
    exports2.ONEDEVTOOL_TERMINAL_ID_ENV = "ONEDEVTOOL_TERMINAL_ID";
    function readOneDevToolTerminalId(env) {
      const terminalId = env[exports2.ONEDEVTOOL_TERMINAL_ID_ENV]?.trim();
      return terminalId || void 0;
    }
    function withOneDevToolTerminalEnv(env, terminalId) {
      return {
        ...env,
        [exports2.ONEDEVTOOL_TERMINAL_ID_ENV]: terminalId
      };
    }
  }
});

// dist/main/shared/orchestrationCategory.js
var require_orchestrationCategory = __commonJS({
  "dist/main/shared/orchestrationCategory.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.ORCHESTRATION_CATEGORY_RE = void 0;
    exports2.ORCHESTRATION_CATEGORY_RE = /^[a-z][a-z0-9-]{1,23}$/;
  }
});

// dist/main/shared/orchestrationRuns.js
var require_orchestrationRuns = __commonJS({
  "dist/main/shared/orchestrationRuns.js"(exports2) {
    "use strict";
    var __importDefault2 = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.RUN_INTERRUPTED_GRACE_MS = exports2.DEFAULT_ORCHESTRATION_CONFIG = exports2.STORED_RUN_STATUSES = exports2.CLI_WRITABLE_RUN_STATUSES = exports2.RUN_CATEGORY_RE = exports2.RUN_CALL_ID_RE = exports2.RUN_STDERR_CAP_BYTES = exports2.RUN_OUTPUT_CAP_CHARS = exports2.RUN_PROMPT_CAP_BYTES = exports2.RUN_CONTENT_FILES = exports2.RUN_META_FILE = void 0;
    exports2.getOrchestrationRootDir = getOrchestrationRootDir;
    exports2.getOrchestrationRunsDir = getOrchestrationRunsDir;
    exports2.getOrchestrationConfigPath = getOrchestrationConfigPath;
    exports2.getRunDir = getRunDir;
    exports2.getRunContentFileName = getRunContentFileName;
    exports2.isValidRunCallId = isValidRunCallId;
    exports2.isValidRunCategory = isValidRunCategory;
    exports2.normalizeOrchestrationConfig = normalizeOrchestrationConfig;
    exports2.readOrchestrationConfig = readOrchestrationConfig;
    exports2.writeOrchestrationConfig = writeOrchestrationConfig;
    exports2.ensureDir = ensureDir;
    exports2.writeRunMeta = writeRunMeta;
    exports2.readRunMeta = readRunMeta;
    exports2.truncateUtf8Bytes = truncateUtf8Bytes;
    exports2.truncateChars = truncateChars;
    exports2.deriveServedStatus = deriveServedStatus;
    var node_fs_12 = __importDefault2(require("node:fs"));
    var node_os_12 = __importDefault2(require("node:os"));
    var node_path_12 = __importDefault2(require("node:path"));
    var orchestrationCategory_1 = require_orchestrationCategory();
    function getOrchestrationRootDir(homeDir = node_os_12.default.homedir()) {
      return node_path_12.default.join(homeDir, ".1devtool", "orchestration");
    }
    function getOrchestrationRunsDir(homeDir = node_os_12.default.homedir()) {
      return node_path_12.default.join(getOrchestrationRootDir(homeDir), "runs");
    }
    function getOrchestrationConfigPath(homeDir = node_os_12.default.homedir()) {
      return node_path_12.default.join(getOrchestrationRootDir(homeDir), "config.json");
    }
    function getRunDir(callId, homeDir = node_os_12.default.homedir()) {
      return node_path_12.default.join(getOrchestrationRunsDir(homeDir), callId);
    }
    exports2.RUN_META_FILE = "meta.json";
    exports2.RUN_CONTENT_FILES = ["prompt", "output", "stderr"];
    function getRunContentFileName(file) {
      return `${file}.txt`;
    }
    exports2.RUN_PROMPT_CAP_BYTES = 64 * 1024;
    exports2.RUN_OUTPUT_CAP_CHARS = 1e5;
    exports2.RUN_STDERR_CAP_BYTES = 16 * 1024;
    exports2.RUN_CALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    exports2.RUN_CATEGORY_RE = orchestrationCategory_1.ORCHESTRATION_CATEGORY_RE;
    function isValidRunCallId(callId) {
      return exports2.RUN_CALL_ID_RE.test(callId);
    }
    function isValidRunCategory(category) {
      return exports2.RUN_CATEGORY_RE.test(category);
    }
    exports2.CLI_WRITABLE_RUN_STATUSES = [
      "running",
      "done",
      "error",
      "timeout",
      "not-installed"
    ];
    exports2.STORED_RUN_STATUSES = [
      ...exports2.CLI_WRITABLE_RUN_STATUSES,
      "interrupted"
    ];
    exports2.DEFAULT_ORCHESTRATION_CONFIG = {
      captureContent: false,
      retention: { maxRuns: 500, maxAgeDays: 30 },
      scheduling: { maxConcurrentAgents: 8 }
    };
    function normalizeOrchestrationConfig(raw) {
      const cfg = raw && typeof raw === "object" ? raw : {};
      const retention = cfg.retention && typeof cfg.retention === "object" ? cfg.retention : {};
      const scheduling = cfg.scheduling && typeof cfg.scheduling === "object" ? cfg.scheduling : {};
      const maxRuns = typeof retention.maxRuns === "number" && Number.isFinite(retention.maxRuns) ? Math.min(Math.max(Math.floor(retention.maxRuns), 10), 5e3) : exports2.DEFAULT_ORCHESTRATION_CONFIG.retention.maxRuns;
      const maxAgeDays = typeof retention.maxAgeDays === "number" && Number.isFinite(retention.maxAgeDays) ? Math.min(Math.max(Math.floor(retention.maxAgeDays), 1), 365) : exports2.DEFAULT_ORCHESTRATION_CONFIG.retention.maxAgeDays;
      const maxConcurrentAgents = typeof scheduling.maxConcurrentAgents === "number" && Number.isFinite(scheduling.maxConcurrentAgents) ? Math.min(Math.max(Math.floor(scheduling.maxConcurrentAgents), 1), 8) : exports2.DEFAULT_ORCHESTRATION_CONFIG.scheduling.maxConcurrentAgents;
      return {
        captureContent: cfg.captureContent === true,
        retention: { maxRuns, maxAgeDays },
        scheduling: { maxConcurrentAgents }
      };
    }
    function readOrchestrationConfig(homeDir = node_os_12.default.homedir()) {
      try {
        const raw = node_fs_12.default.readFileSync(getOrchestrationConfigPath(homeDir), "utf-8");
        return normalizeOrchestrationConfig(JSON.parse(raw));
      } catch {
        return {
          ...exports2.DEFAULT_ORCHESTRATION_CONFIG,
          retention: { ...exports2.DEFAULT_ORCHESTRATION_CONFIG.retention },
          scheduling: { ...exports2.DEFAULT_ORCHESTRATION_CONFIG.scheduling }
        };
      }
    }
    function writeOrchestrationConfig(config, homeDir = node_os_12.default.homedir()) {
      const normalized = normalizeOrchestrationConfig(config);
      const configPath = getOrchestrationConfigPath(homeDir);
      ensureDir(node_path_12.default.dirname(configPath), 448);
      const tmpPath = `${configPath}.${process.pid}.tmp`;
      node_fs_12.default.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2), { encoding: "utf-8", mode: 384 });
      node_fs_12.default.renameSync(tmpPath, configPath);
    }
    function ensureDir(dir, mode) {
      node_fs_12.default.mkdirSync(dir, { recursive: true, mode });
    }
    function writeRunMeta(runDir, record) {
      const metaPath = node_path_12.default.join(runDir, exports2.RUN_META_FILE);
      const tmpPath = `${metaPath}.${process.pid}.tmp`;
      node_fs_12.default.writeFileSync(tmpPath, JSON.stringify(record, null, 2), { encoding: "utf-8", mode: 384 });
      node_fs_12.default.renameSync(tmpPath, metaPath);
    }
    function readRunMeta(runDir) {
      try {
        const raw = node_fs_12.default.readFileSync(node_path_12.default.join(runDir, exports2.RUN_META_FILE), "utf-8");
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object")
          return null;
        if (typeof parsed.callId !== "string" || !isValidRunCallId(parsed.callId))
          return null;
        if (typeof parsed.target !== "string" || !parsed.target)
          return null;
        if (typeof parsed.startedAt !== "number" || !Number.isFinite(parsed.startedAt))
          return null;
        if (typeof parsed.status !== "string")
          return null;
        if (!exports2.STORED_RUN_STATUSES.includes(parsed.status))
          return null;
        if (typeof parsed.timeoutSeconds !== "number" || !Number.isFinite(parsed.timeoutSeconds))
          return null;
        return parsed;
      } catch {
        return null;
      }
    }
    function truncateUtf8Bytes(text, maxBytes) {
      if (Buffer.byteLength(text, "utf-8") <= maxBytes)
        return { text, truncated: false };
      const sliced = Buffer.from(text, "utf-8").subarray(0, maxBytes).toString("utf-8");
      return { text: sliced.replace(/�+$/, ""), truncated: true };
    }
    function truncateChars(text, maxChars) {
      if (text.length <= maxChars)
        return { text, truncated: false };
      return { text: text.slice(0, maxChars), truncated: true };
    }
    exports2.RUN_INTERRUPTED_GRACE_MS = 6e4;
    function deriveServedStatus(record, nowMs) {
      if (record.status !== "running")
        return record.status;
      const anchor = Math.max(record.startedAt, record.heartbeatAt ?? 0);
      const deadline = anchor + record.timeoutSeconds * 1e3 + exports2.RUN_INTERRUPTED_GRACE_MS;
      return nowMs > deadline ? "interrupted" : "running";
    }
  }
});

// dist/main/main/utils/env.js
var require_env = __commonJS({
  "dist/main/main/utils/env.js"(exports2) {
    "use strict";
    var __importDefault2 = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.registerUserExtraPathsProvider = registerUserExtraPathsProvider;
    exports2.getEnrichedPath = getEnrichedPath;
    exports2.getEnrichedEnv = getEnrichedEnv;
    var os_1 = __importDefault2(require("os"));
    var path_1 = __importDefault2(require("path"));
    var userExtraPathsProvider = () => [];
    function registerUserExtraPathsProvider(provider) {
      userExtraPathsProvider = provider;
    }
    function dedupeSegments(values) {
      const seen = /* @__PURE__ */ new Set();
      const output = [];
      for (const value of values) {
        for (const segment of (value || "").split(path_1.default.delimiter)) {
          const key = process.platform === "win32" ? segment.toLowerCase() : segment;
          if (!segment || seen.has(key)) {
            continue;
          }
          seen.add(key);
          output.push(segment);
        }
      }
      return output;
    }
    function getEnrichedPath(extraPaths = [], baseEnv = process.env) {
      const home = baseEnv.HOME || baseEnv.USERPROFILE || os_1.default.homedir();
      const basePath = baseEnv.PATH || baseEnv.Path;
      const appData = baseEnv.APPDATA || (home ? path_1.default.join(home, "AppData", "Roaming") : "");
      const programFiles = baseEnv.ProgramFiles || "C:\\Program Files";
      const programFilesX86 = baseEnv["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
      const localAppData = baseEnv.LOCALAPPDATA || (home ? path_1.default.join(home, "AppData", "Local") : "");
      const programData = baseEnv.ProgramData || "C:\\ProgramData";
      const chocolatey = baseEnv.ChocolateyInstall || path_1.default.join(programData, "chocolatey");
      const defaults = process.platform === "win32" ? [
        basePath,
        baseEnv.PNPM_HOME,
        baseEnv.NVM_SYMLINK,
        appData ? path_1.default.join(appData, "npm") : "",
        path_1.default.join(programFiles, "nodejs"),
        path_1.default.join(programFilesX86, "nodejs"),
        path_1.default.join(programFiles, "dotnet"),
        path_1.default.join(programFilesX86, "dotnet"),
        home ? path_1.default.join(home, ".local", "bin") : "",
        home ? path_1.default.join(home, ".dotnet", "tools") : "",
        home ? path_1.default.join(home, ".bun", "bin") : "",
        home ? path_1.default.join(home, ".opencode", "bin") : "",
        home ? path_1.default.join(home, ".claude", "bin") : "",
        home ? path_1.default.join(home, ".codex", "bin") : "",
        localAppData ? path_1.default.join(localAppData, "pnpm") : "",
        home ? path_1.default.join(home, "scoop", "shims") : "",
        path_1.default.join(programData, "scoop", "shims"),
        path_1.default.join(chocolatey, "bin"),
        localAppData ? path_1.default.join(localAppData, "Microsoft", "WinGet", "Links") : "",
        localAppData ? path_1.default.join(localAppData, "Volta", "bin") : "",
        localAppData ? path_1.default.join(localAppData, "mise", "shims") : "",
        localAppData ? path_1.default.join(localAppData, "Yarn", "bin") : "",
        localAppData ? path_1.default.join(localAppData, "Yarn", "Data", "global", "node_modules", ".bin") : "",
        localAppData ? path_1.default.join(localAppData, "Microsoft", "WindowsApps") : "",
        // Docker Desktop v29+ layout — docker.exe sometimes lands here, plugins live one level up
        path_1.default.join(programFiles, "Docker"),
        path_1.default.join(programFiles, "Docker", "cli-plugins"),
        path_1.default.join(programData, "Docker", "cli-plugins"),
        // Classic Docker Desktop layout (v20–v28)
        path_1.default.join(programFiles, "Docker", "Docker", "resources", "bin"),
        path_1.default.join(programFiles, "Docker", "Docker", "resources", "cli-plugins"),
        localAppData ? path_1.default.join(localAppData, "Programs", "Docker", "Docker", "resources", "bin") : "",
        path_1.default.join(programFilesX86, "Docker", "Docker", "resources", "bin"),
        // SSHFS-Win (WinFsp) — not always on PATH after MSI install
        path_1.default.join(programFiles, "SSHFS-Win", "bin"),
        path_1.default.join(programFilesX86, "SSHFS-Win", "bin"),
        path_1.default.join(programFilesX86, "WinFsp", "bin"),
        path_1.default.join(programFiles, "WinFsp", "bin")
      ] : [
        basePath,
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/local/share/dotnet",
        "/usr/share/dotnet",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        home ? path_1.default.join(home, "bin") : "",
        home ? path_1.default.join(home, ".local/bin") : "",
        home ? path_1.default.join(home, ".dotnet") : "",
        home ? path_1.default.join(home, ".dotnet/tools") : "",
        home ? path_1.default.join(home, ".npm-global/bin") : "",
        home ? path_1.default.join(home, ".yarn/bin") : "",
        home ? path_1.default.join(home, ".config/yarn/global/node_modules/.bin") : "",
        home ? path_1.default.join(home, ".pnpm") : "",
        home && process.platform === "darwin" ? path_1.default.join(home, "Library/pnpm") : "",
        home ? path_1.default.join(home, ".local/share/pnpm") : "",
        home ? path_1.default.join(home, ".bun/bin") : "",
        home ? path_1.default.join(home, ".volta/bin") : "",
        home ? path_1.default.join(home, ".cargo/bin") : "",
        home ? path_1.default.join(home, "go/bin") : "",
        home ? path_1.default.join(home, ".opencode/bin") : "",
        home ? path_1.default.join(home, ".claude/bin") : "",
        home ? path_1.default.join(home, ".codex/bin") : "",
        home ? path_1.default.join(home, ".rbenv/shims") : "",
        home ? path_1.default.join(home, ".pyenv/shims") : ""
      ];
      let userExtras = [];
      try {
        userExtras = userExtraPathsProvider().filter((p) => typeof p === "string" && p.trim().length > 0);
      } catch {
        userExtras = [];
      }
      return dedupeSegments([...userExtras, ...extraPaths, ...defaults]).join(path_1.default.delimiter);
    }
    function getEnrichedEnv(extra = {}, options = {}) {
      const baseEnv = options.baseEnv ?? process.env;
      return {
        ...baseEnv,
        ...extra,
        PATH: getEnrichedPath(options.extraPaths ?? [], { ...baseEnv, ...extra })
      };
    }
  }
});

// dist/main/main/utils/spawnSpec.js
var require_spawnSpec = __commonJS({
  "dist/main/main/utils/spawnSpec.js"(exports2) {
    "use strict";
    var __importDefault2 = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.resolveWindowsExecutablePath = resolveWindowsExecutablePath;
    exports2.buildSpawnSpec = buildSpawnSpec;
    var fs_1 = __importDefault2(require("fs"));
    var path_1 = __importDefault2(require("path"));
    function quoteCmdArg(arg) {
      return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
    }
    function resolveWindowsExecutablePath(binPath, existsSync = fs_1.default.existsSync) {
      const ext = path_1.default.win32.extname(binPath).toLowerCase();
      if (ext)
        return binPath;
      for (const candidateExt of [".cmd", ".exe", ".bat", ".com"]) {
        const sibling = binPath + candidateExt;
        if (existsSync(sibling))
          return sibling;
      }
      return binPath;
    }
    function buildSpawnSpec(binPath, args, env = process.env, isWin = process.platform === "win32", existsSync = fs_1.default.existsSync) {
      if (isWin) {
        const resolved = resolveWindowsExecutablePath(binPath, existsSync);
        const ext = path_1.default.win32.extname(resolved).toLowerCase();
        if (ext === ".cmd" || ext === ".bat") {
          return {
            file: env.ComSpec ?? "cmd.exe",
            args: ["/d", "/s", "/c", `""${resolved}" ${args.map(quoteCmdArg).join(" ")}"`],
            windowsVerbatimArguments: true
          };
        }
        if (ext === ".ps1") {
          return {
            file: "powershell.exe",
            args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolved, ...args]
          };
        }
        return { file: resolved, args };
      }
      return { file: binPath, args };
    }
  }
});

// dist/main/main/orchestration/runHeadlessAgent.js
var require_runHeadlessAgent = __commonJS({
  "dist/main/main/orchestration/runHeadlessAgent.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.UnknownAgentError = exports2.HEADLESS_MAX_OUTPUT_CHARS = exports2.HEADLESS_MIN_TIMEOUT_S = exports2.HEADLESS_MAX_TIMEOUT_S = exports2.HEADLESS_DEFAULT_TIMEOUT_S = void 0;
    exports2.runHeadlessAgent = runHeadlessAgent;
    var child_process_1 = require("child_process");
    var headlessMode_12 = require_headlessMode();
    var mcpTerminalIdentity_1 = require_mcpTerminalIdentity();
    var orchestrationRuns_12 = require_orchestrationRuns();
    var env_1 = require_env();
    var spawnSpec_1 = require_spawnSpec();
    exports2.HEADLESS_DEFAULT_TIMEOUT_S = 120;
    exports2.HEADLESS_MAX_TIMEOUT_S = 600;
    exports2.HEADLESS_MIN_TIMEOUT_S = 5;
    exports2.HEADLESS_MAX_OUTPUT_CHARS = 1e5;
    var UnknownAgentError = class extends Error {
      constructor(agentId) {
        super(`Unknown agent "${agentId}". Available: ${Object.keys(headlessMode_12.HEADLESS_SPECS).join(", ")}`);
        this.name = "UnknownAgentError";
      }
    };
    exports2.UnknownAgentError = UnknownAgentError;
    async function runHeadlessAgent(input) {
      const { agentId, prompt, cwd, binaryPath, signal, terminalId } = input;
      if (!agentId || !prompt)
        throw new Error("agent and prompt are required");
      const spec = headlessMode_12.HEADLESS_SPECS[agentId];
      if (!spec)
        throw new UnknownAgentError(agentId);
      const defaultFlags = input.defaultFlags ?? spec.defaultFlags ?? [];
      const extraFlags = (input.flags ?? []).filter((f) => typeof f === "string");
      const allFlags = [...defaultFlags, ...extraFlags];
      const headlessInvocation = (0, headlessMode_12.buildHeadlessInvocation)(agentId, prompt, allFlags);
      if (!headlessInvocation)
        throw new Error(`No headless mode spec for agent "${agentId}"`);
      const requested = typeof input.timeoutSeconds === "number" ? input.timeoutSeconds : exports2.HEADLESS_DEFAULT_TIMEOUT_S;
      const timeoutS = Math.min(Math.max(requested, exports2.HEADLESS_MIN_TIMEOUT_S), exports2.HEADLESS_MAX_TIMEOUT_S);
      const startedAt = Date.now();
      const enrichedEnv = (0, env_1.getEnrichedEnv)({ NO_COLOR: "1", FORCE_COLOR: "0" });
      const childEnv = terminalId ? (0, mcpTerminalIdentity_1.withOneDevToolTerminalEnv)(enrichedEnv, terminalId) : enrichedEnv;
      const { stdout, stderr, stderrTail, exitCode, timedOut, outputTruncated, stderrTruncated } = await new Promise((resolve) => {
        const spec2 = (0, spawnSpec_1.buildSpawnSpec)(binaryPath, headlessInvocation.args);
        const child = (0, child_process_1.spawn)(spec2.file, spec2.args, {
          cwd,
          // Match terminal/tool spawns: retain the app/caller PATH and add the
          // shared Homebrew, user-toolchain, and configured extra locations.
          env: childEnv,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          ...spec2.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}
        });
        let stdout2 = "";
        let stderr2 = "";
        let stderrTail2 = "";
        let outputTruncated2 = false;
        let stderrTruncated2 = false;
        let didTimeOut = false;
        let settled = false;
        let spawnError = null;
        let hardKillTimer;
        const tap = (stream, chunk) => {
          if (!input.onChunk)
            return;
          try {
            input.onChunk(stream, chunk);
          } catch {
          }
        };
        child.stdout.setEncoding("utf-8");
        child.stderr.setEncoding("utf-8");
        child.stdout.on("data", (chunk) => {
          tap("stdout", chunk);
          if (stdout2.length < exports2.HEADLESS_MAX_OUTPUT_CHARS) {
            const remaining = exports2.HEADLESS_MAX_OUTPUT_CHARS - stdout2.length;
            stdout2 += chunk.slice(0, remaining);
            if (chunk.length > remaining)
              outputTruncated2 = true;
          } else {
            outputTruncated2 = true;
          }
        });
        child.stderr.on("data", (chunk) => {
          tap("stderr", chunk);
          stderrTail2 = (stderrTail2 + chunk).slice(-2e3);
          if (Buffer.byteLength(stderr2, "utf-8") < orchestrationRuns_12.RUN_STDERR_CAP_BYTES) {
            const capped = (0, orchestrationRuns_12.truncateUtf8Bytes)(stderr2 + chunk, orchestrationRuns_12.RUN_STDERR_CAP_BYTES);
            stderr2 = capped.text;
            if (capped.truncated)
              stderrTruncated2 = true;
          } else {
            stderrTruncated2 = true;
          }
        });
        const finish = (code) => {
          if (settled)
            return;
          settled = true;
          clearTimeout(timeout);
          if (hardKillTimer)
            clearTimeout(hardKillTimer);
          signal.removeEventListener("abort", abort);
          resolve({
            stdout: stdout2,
            stderr: stderr2,
            stderrTail: stderrTail2,
            // A process closed by a signal reports a null exit code. Never turn a
            // timeout or cancellation into a successful orchestration result.
            exitCode: didTimeOut ? 124 : typeof code === "number" ? code : spawnError ? 1 : 130,
            timedOut: didTimeOut,
            outputTruncated: outputTruncated2,
            stderrTruncated: stderrTruncated2
          });
        };
        const abort = () => {
          try {
            child.kill("SIGTERM");
          } catch {
          }
          hardKillTimer ??= setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
            }
          }, 2e3);
          hardKillTimer.unref?.();
        };
        const timeout = setTimeout(() => {
          didTimeOut = true;
          abort();
        }, timeoutS * 1e3);
        timeout.unref?.();
        child.on("error", (error) => {
          spawnError = error;
          finish(1);
        });
        child.on("close", (code) => finish(code));
        if (headlessInvocation.stdin !== void 0) {
          child.stdin?.end(headlessInvocation.stdin);
        } else {
          child.stdin?.end();
        }
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted)
          abort();
      });
      const durationMs = Date.now() - startedAt;
      const output = stdout;
      return {
        agent: agentId,
        output: output || stderrTail || "(no output)",
        exitCode,
        durationSeconds: Math.round(durationMs / 1e3),
        ...exitCode !== 0 && stderrTail ? { stderr: stderrTail } : {},
        ...timedOut ? { timedOut } : {},
        ...stderr ? { rawStderr: stderr } : {},
        ...outputTruncated || stderrTruncated ? {
          truncated: {
            ...outputTruncated ? { output: true } : {},
            ...stderrTruncated ? { stderr: true } : {}
          }
        } : {}
      };
    }
  }
});

// dist/main/shared/agentModels.js
var require_agentModels = __commonJS({
  "dist/main/shared/agentModels.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.CODEX_REASONING_EFFORTS = exports2.MODEL_ID_RE = exports2.AGENT_MODEL_SPECS = void 0;
    exports2.isValidModelId = isValidModelId;
    exports2.splitCodexModelEffort = splitCodexModelEffort;
    exports2.buildModelFlags = buildModelFlags;
    exports2.parseModelListOutput = parseModelListOutput;
    exports2.parsePiModelListOutput = parsePiModelListOutput;
    exports2.parseCodexModelsCache = parseCodexModelsCache;
    exports2.parseClineProvidersConfig = parseClineProvidersConfig;
    exports2.parseAnthropicModelsResponse = parseAnthropicModelsResponse;
    exports2.parseGeminiModelsResponse = parseGeminiModelsResponse;
    exports2.parseModelsDevProvider = parseModelsDevProvider;
    exports2.AGENT_MODEL_SPECS = {
      claude: {
        modelFlag: "--model",
        // Aliases resolve to the latest model of each family (per `claude --help`),
        // so this list never goes stale the way full ids would.
        staticModels: [
          { id: "fable", label: "Fable (latest)" },
          { id: "opus", label: "Opus" },
          { id: "sonnet", label: "Sonnet" },
          { id: "haiku", label: "Haiku" }
        ]
      },
      codex: {
        // Real models come from Codex's own account-entitlement cache
        // (`<codexHome>/models_cache.json`, parsed by parseCodexModelsCache) —
        // the main catalog reads it on every request. This static list is only
        // the fallback when that cache doesn't exist yet (codex never run).
        modelFlag: "--model",
        staticModels: [
          { id: "gpt-5.5" },
          { id: "gpt-5.4" },
          { id: "gpt-5.4-mini" }
        ]
      },
      gemini: {
        modelFlag: "--model",
        staticModels: [
          { id: "gemini-3.1-pro" },
          { id: "gemini-3.5-flash" },
          { id: "gemini-3-flash" }
        ]
      },
      kimi: {
        modelFlag: "--model",
        // Kimi also accepts provider/model aliases from its config. Keep the
        // official coding model as the safe default and allow manual ids.
        staticModels: [
          { id: "kimi-code/kimi-for-coding", label: "Kimi for Coding" }
        ]
      },
      agy: {
        // Antigravity CLI 1.1.10 validates --model in both print and interactive
        // modes ("invalid model selection" + the model list on a garbage id —
        // verified live), reversing the older builds that silently ignored it in
        // print mode. Ids are the slugs `agy models` prints one per line (effort
        // is baked into the slug: gemini-3.6-flash-high); the live probe replaces
        // this curated fallback.
        modelFlag: "--model",
        staticModels: [
          { id: "gemini-3.6-flash-high" },
          { id: "gemini-3.1-pro-high" },
          { id: "claude-sonnet-4-6" },
          { id: "claude-opus-4-6-thinking" }
        ],
        listArgs: ["models"]
      },
      cline: {
        // No curated list — cline's model space depends on the authenticated
        // provider. The main catalog surfaces the models the user configured in
        // `<clineData>/settings/providers.json` (parseClineProvidersConfig).
        modelFlag: "--model",
        staticModels: []
      },
      opencode: {
        modelFlag: "--model",
        // `opencode models` prints one `provider/model` per line; the probed list
        // replaces these few well-known ids.
        staticModels: [
          { id: "opencode/claude-sonnet-5" },
          { id: "opencode/gpt-5.5" },
          { id: "opencode/qwen3-coder" }
        ],
        listArgs: ["models"]
      },
      qwen: {
        // qwen-code has no CLI enumeration. Catalog matches @qwen-code/qwen-code
        // generateCodingPlanTemplate (china + international) plus the vision model
        // (qwen3-vl-plus) and coder-model / qwen3-coder-flash aliases that still
        // exist outside the plan templates. vision-model was removed upstream —
        // do not reintroduce it. qwen3.7-plus does not exist in the package.
        modelFlag: "--model",
        staticModels: [
          { id: "coder-model", label: "Coder (default alias)" },
          { id: "qwen3.5-plus" },
          { id: "qwen3.6-plus" },
          { id: "qwen3-vl-plus", label: "Vision (qwen3-vl-plus)" },
          { id: "qwen3-coder-plus" },
          { id: "qwen3-coder-next" },
          { id: "qwen3-coder-flash" },
          { id: "qwen3-max-2026-01-23" },
          { id: "glm-5" },
          { id: "glm-4.7" },
          { id: "kimi-k2.5" },
          { id: "MiniMax-M2.5" }
        ]
      },
      grok: {
        modelFlag: "--model",
        staticModels: [
          { id: "grok-4.5" },
          { id: "grok-code-fast-1" }
        ],
        // `grok models` prints a bulleted, annotated list — handled by the
        // tolerant parseModelListOutput.
        listArgs: ["models"]
      },
      hermes: {
        modelFlag: "--model",
        // Hermes accepts provider/model ids. The configured provider determines
        // which ids are valid, so keep this user-entered instead of guessing.
        staticModels: []
      },
      cursor: {
        modelFlag: "--model",
        // Plain ids only. Cursor also accepts bracket overrides
        // (`claude-opus-4-8[context=1m,effort=high]`), but those characters are
        // deliberately outside MODEL_ID_RE — widening it to pass them through to
        // argv would weaken the smuggling guard for every agent.
        staticModels: [
          { id: "auto", label: "Auto" }
        ],
        // `cursor-agent --list-models` prints `<id> - <Label>` under an
        // `Available models` banner (needs an authed account; probing just yields
        // the static fallback when logged out).
        listArgs: ["--list-models"]
      },
      pi: {
        modelFlag: "--model",
        // Pi resolves `--model` against the providers the user has actually
        // configured, so a curated list would name ids this install may not be
        // entitled to. `pi --list-models` prints the real, per-install set as a
        // whitespace-aligned TABLE (not one id per line), so it is probed through
        // parsePiModelListOutput rather than the generic line parser — and the ids
        // are emitted as `provider/model`, the disambiguated form pi's own
        // `--model` accepts.
        staticModels: [],
        listArgs: ["--list-models"]
      },
      aider: {
        modelFlag: "--model",
        staticModels: []
      }
    };
    exports2.MODEL_ID_RE = /^[A-Za-z0-9][\w.:/-]{0,127}$/;
    function isValidModelId(id) {
      return exports2.MODEL_ID_RE.test(id);
    }
    exports2.CODEX_REASONING_EFFORTS = /* @__PURE__ */ new Set([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra"
    ]);
    function splitCodexModelEffort(modelId) {
      const idx = modelId.lastIndexOf(":");
      if (idx <= 0)
        return null;
      const effort = modelId.slice(idx + 1);
      if (!exports2.CODEX_REASONING_EFFORTS.has(effort))
        return null;
      return { slug: modelId.slice(0, idx), effort };
    }
    function buildModelFlags(agentId, modelId) {
      const spec = exports2.AGENT_MODEL_SPECS[agentId];
      if (!spec || !modelId || !isValidModelId(modelId))
        return null;
      if (agentId === "codex") {
        const split = splitCodexModelEffort(modelId);
        if (split) {
          return [spec.modelFlag, split.slug, "--config", `model_reasoning_effort=${split.effort}`];
        }
      }
      return [spec.modelFlag, modelId];
    }
    function parseModelListOutput(stdout) {
      const seen = /* @__PURE__ */ new Set();
      const out = [];
      for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim().replace(/^[-*•·]\s+/, "").replace(/\s*\([^)]*\)\s*$/, "");
        if (!line)
          continue;
        const annotated = /^(\S+)(?:\s+[-–—]\s+|:\s+)(\S.*)$/.exec(line);
        const id = annotated ? annotated[1] : line;
        const label = annotated ? annotated[2].trim() : "";
        if (id.includes(" ") || !isValidModelId(id))
          continue;
        if (seen.has(id))
          continue;
        seen.add(id);
        out.push(label && label !== id ? { id, label } : { id });
      }
      return out;
    }
    function parsePiModelListOutput(stdout) {
      const seen = /* @__PURE__ */ new Set();
      const out = [];
      for (const rawLine of stdout.split(/\r?\n/)) {
        const columns = rawLine.trim().split(/\s{2,}/);
        if (columns.length < 2)
          continue;
        const [provider, model] = columns;
        if (!provider || !model)
          continue;
        if (provider === "provider" && model === "model")
          continue;
        const id = `${provider}/${model}`;
        if (!isValidModelId(id))
          continue;
        if (seen.has(id))
          continue;
        seen.add(id);
        out.push({ id });
      }
      return out;
    }
    function parseCodexModelsCache(raw) {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.models))
        return [];
      const visible = parsed.models.filter((m) => typeof m.slug === "string" && isValidModelId(m.slug) && (m.visibility ?? "list") === "list").sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
      const out = [];
      for (const model of visible) {
        const slug = model.slug;
        const label = model.display_name || slug;
        out.push({ id: slug, label });
        for (const level of model.supported_reasoning_levels ?? []) {
          const effort = level.effort;
          if (!effort || effort === model.default_reasoning_level || !exports2.CODEX_REASONING_EFFORTS.has(effort))
            continue;
          out.push({ id: `${slug}:${effort}`, label: `${label} \xB7 ${effort}` });
        }
      }
      return out;
    }
    function parseClineProvidersConfig(raw) {
      const parsed = JSON.parse(raw);
      if (!parsed.providers || typeof parsed.providers !== "object")
        return [];
      const seen = /* @__PURE__ */ new Set();
      const out = [];
      for (const [providerKey, provider] of Object.entries(parsed.providers)) {
        const model = provider?.settings?.model;
        if (typeof model !== "string" || !isValidModelId(model) || seen.has(model))
          continue;
        seen.add(model);
        out.push({ id: model, label: `configured in cline (${providerKey})` });
      }
      return out;
    }
    function parseAnthropicModelsResponse(raw) {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.data))
        return [];
      const seen = /* @__PURE__ */ new Set();
      const out = [];
      for (const model of parsed.data) {
        const id = model?.id;
        if (typeof id !== "string" || !isValidModelId(id) || seen.has(id))
          continue;
        seen.add(id);
        out.push({ id, ...model.display_name ? { label: model.display_name } : {} });
      }
      return out;
    }
    function parseGeminiModelsResponse(raw) {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.models))
        return [];
      const seen = /* @__PURE__ */ new Set();
      const out = [];
      for (const model of parsed.models) {
        if (typeof model?.name !== "string")
          continue;
        if (!model.supportedGenerationMethods?.includes("generateContent"))
          continue;
        const id = model.name.replace(/^models\//, "");
        if (!id.startsWith("gemini") || !isValidModelId(id) || seen.has(id))
          continue;
        seen.add(id);
        out.push({ id, ...model.displayName ? { label: model.displayName } : {} });
      }
      return out;
    }
    function parseModelsDevProvider(raw, providerId, opts = {}) {
      const parsed = JSON.parse(raw);
      const models = parsed?.[providerId]?.models;
      if (!models || typeof models !== "object")
        return [];
      const seen = /* @__PURE__ */ new Set();
      const rows = [];
      for (const [key, model] of Object.entries(models)) {
        const id = typeof model?.id === "string" && model.id ? model.id : key;
        if (!isValidModelId(id) || seen.has(id))
          continue;
        if (opts.idPrefix && !id.startsWith(opts.idPrefix))
          continue;
        if (opts.requireToolCall && model?.tool_call !== true)
          continue;
        seen.add(id);
        rows.push({
          option: { id, ...model?.name ? { label: model.name } : {} },
          releasedAt: typeof model?.release_date === "string" ? model.release_date : ""
        });
      }
      rows.sort((a, b) => b.releasedAt.localeCompare(a.releasedAt));
      return rows.map((r) => r.option);
    }
  }
});

// dist/main/shared/orchestrationReplyMailbox.js
var require_orchestrationReplyMailbox = __commonJS({
  "dist/main/shared/orchestrationReplyMailbox.js"(exports2) {
    "use strict";
    var __importDefault2 = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.LINK_REPLY_MAILBOX_REQUEST_ID_RE = exports2.LINK_REPLY_MAILBOX_MAX_WAIT_MS = exports2.LINK_REPLY_MAILBOX_MAX_RESPONSE_BYTES = exports2.LINK_REPLY_MAILBOX_MAX_REQUEST_BYTES = exports2.LINK_REPLY_MAILBOX_PROTOCOL_VERSION = void 0;
    exports2.linkReplyMailboxRoot = linkReplyMailboxRoot;
    exports2.createLinkReplyMailboxEndpoint = createLinkReplyMailboxEndpoint;
    exports2.isLinkReplyMailboxEndpoint = isLinkReplyMailboxEndpoint;
    exports2.parseLinkReplyMailboxRequest = parseLinkReplyMailboxRequest;
    var node_os_12 = __importDefault2(require("node:os"));
    var node_path_12 = __importDefault2(require("node:path"));
    exports2.LINK_REPLY_MAILBOX_PROTOCOL_VERSION = 1;
    exports2.LINK_REPLY_MAILBOX_MAX_REQUEST_BYTES = 256 * 1024;
    exports2.LINK_REPLY_MAILBOX_MAX_RESPONSE_BYTES = 256 * 1024;
    exports2.LINK_REPLY_MAILBOX_MAX_WAIT_MS = 135e3;
    var INSTANCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
    exports2.LINK_REPLY_MAILBOX_REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    function userScope() {
      const uid = typeof process.getuid === "function" ? process.getuid() : null;
      return uid === null ? "user" : `uid-${uid}`;
    }
    function linkReplyMailboxRoot(instanceId) {
      if (!INSTANCE_ID_RE.test(instanceId))
        throw new Error("invalid reply-mailbox instance id");
      return node_path_12.default.join(node_os_12.default.tmpdir(), "1devtool-link-reply-mailbox", userScope(), instanceId);
    }
    function createLinkReplyMailboxEndpoint(instanceId) {
      const root = linkReplyMailboxRoot(instanceId);
      return {
        transport: "file-reply-mailbox",
        protocolVersion: exports2.LINK_REPLY_MAILBOX_PROTOCOL_VERSION,
        requestDir: node_path_12.default.join(root, "requests"),
        responseDir: node_path_12.default.join(root, "responses")
      };
    }
    function isLinkReplyMailboxEndpoint(value, instanceId) {
      if (typeof value !== "object" || value === null || Array.isArray(value) || typeof instanceId !== "string" || !INSTANCE_ID_RE.test(instanceId)) {
        return false;
      }
      const endpoint = value;
      if (endpoint.transport !== "file-reply-mailbox" || endpoint.protocolVersion !== exports2.LINK_REPLY_MAILBOX_PROTOCOL_VERSION || typeof endpoint.requestDir !== "string" || typeof endpoint.responseDir !== "string") {
        return false;
      }
      const expected = createLinkReplyMailboxEndpoint(instanceId);
      return node_path_12.default.resolve(endpoint.requestDir) === node_path_12.default.resolve(expected.requestDir) && node_path_12.default.resolve(endpoint.responseDir) === node_path_12.default.resolve(expected.responseDir);
    }
    function parseLinkReplyMailboxRequest(value) {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return null;
      const request = value;
      const keys = Object.keys(value);
      if (keys.some((key) => ![
        "protocolVersion",
        "requestId",
        "action",
        "replyToken",
        "body",
        "createdAt",
        "waitMs",
        "gateDecision"
      ].includes(key))) {
        return null;
      }
      if (request.protocolVersion !== exports2.LINK_REPLY_MAILBOX_PROTOCOL_VERSION || request.action !== "link-send-by-token" || typeof request.requestId !== "string" || !exports2.LINK_REPLY_MAILBOX_REQUEST_ID_RE.test(request.requestId) || typeof request.replyToken !== "string" || !/^[0-9a-f]{24}$/i.test(request.replyToken) || typeof request.body !== "string" || request.body.length === 0 || request.body.length > 64e3 || typeof request.createdAt !== "number" || !Number.isFinite(request.createdAt) || Math.abs(Date.now() - request.createdAt) > exports2.LINK_REPLY_MAILBOX_MAX_WAIT_MS) {
        return null;
      }
      if (request.gateDecision !== void 0 && request.gateDecision !== "accept" && request.gateDecision !== "reject") {
        return null;
      }
      if (request.waitMs !== void 0 && (!Number.isInteger(request.waitMs) || request.waitMs < 0 || request.waitMs > 12e4)) {
        return null;
      }
      return request;
    }
  }
});

// dist/main/cli/bridgeNotify.js
var require_bridgeNotify = __commonJS({
  "dist/main/cli/bridgeNotify.js"(exports2) {
    "use strict";
    var __importDefault2 = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.requestInteractiveDelegation = requestInteractiveDelegation;
    exports2.requestPeerAuthenticatedOrchestration = requestPeerAuthenticatedOrchestration;
    exports2.requestReplyTokenThroughMailboxes = requestReplyTokenThroughMailboxes;
    exports2.requestSandboxCompatibleAgentOrchestration = requestSandboxCompatibleAgentOrchestration;
    exports2.requestAgentOrchestration = requestAgentOrchestration;
    exports2.createDelegationNotifier = createDelegationNotifier;
    var node_fs_12 = __importDefault2(require("node:fs"));
    var node_http_1 = __importDefault2(require("node:http"));
    var node_os_12 = __importDefault2(require("node:os"));
    var node_path_12 = __importDefault2(require("node:path"));
    var node_crypto_12 = __importDefault2(require("node:crypto"));
    var node_child_process_12 = require("node:child_process");
    var orchestrationReplyMailbox_1 = require_orchestrationReplyMailbox();
    var REQUEST_TIMEOUT_MS = 400;
    var INTERACTIVE_REQUEST_TIMEOUT_MS = 2e4;
    var ORCHESTRATION_REQUEST_TIMEOUT_MS = 10 * 6e4;
    function isPidAlive(pid) {
      if (!pid || pid <= 0)
        return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return err.code === "EPERM";
      }
    }
    function discoverBridges() {
      const records = [];
      const seenPorts = /* @__PURE__ */ new Set();
      try {
        const dir = node_path_12.default.join(node_os_12.default.homedir(), ".1devtool", "bridges");
        for (const file of node_fs_12.default.readdirSync(dir)) {
          if (!file.endsWith(".json"))
            continue;
          try {
            const record = JSON.parse(node_fs_12.default.readFileSync(node_path_12.default.join(dir, file), "utf-8"));
            if (typeof record.port !== "number" || typeof record.pid !== "number")
              continue;
            if (!isPidAlive(record.pid) || seenPorts.has(record.port))
              continue;
            seenPorts.add(record.port);
            records.push(record);
          } catch {
          }
        }
      } catch {
      }
      return records.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    }
    function peerAuthRecord(record) {
      const endpoint = record.peerAuth;
      if (process.platform !== "darwin" || endpoint?.transport !== "mach" || endpoint.protocolVersion !== 1 || typeof endpoint.serviceName !== "string" || !/^com\.stoicsoft\.1devtool\.peer\.[A-Za-z0-9.-]+$/.test(endpoint.serviceName) || typeof endpoint.helperPath !== "string" || !node_path_12.default.isAbsolute(endpoint.helperPath) || node_path_12.default.basename(endpoint.helperPath) !== "1devtool-peer-auth") {
        return null;
      }
      try {
        const stat = node_fs_12.default.statSync(endpoint.helperPath);
        if (!stat.isFile())
          return null;
      } catch {
        return null;
      }
      return {
        serviceName: endpoint.serviceName,
        helperPath: endpoint.helperPath
      };
    }
    function replyMailboxRecord(record) {
      if (!(0, orchestrationReplyMailbox_1.isLinkReplyMailboxEndpoint)(record.replyMailbox, record.instanceId))
        return null;
      return { endpoint: (0, orchestrationReplyMailbox_1.createLinkReplyMailboxEndpoint)(record.instanceId) };
    }
    function callPeerAuth(endpoint, body, timeoutMs) {
      return new Promise((resolve) => {
        const child = (0, node_child_process_12.spawn)(endpoint.helperPath, ["client", endpoint.serviceName], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true
        });
        let settled = false;
        let stdout = "";
        let stderr = "";
        const finish = (value) => {
          if (settled)
            return;
          settled = true;
          clearTimeout(timeout);
          resolve(value);
        };
        const timeout = setTimeout(() => {
          try {
            child.kill();
          } catch {
          }
          finish({ ok: false, error: "Timed out waiting for peer-authenticated orchestration" });
        }, timeoutMs);
        timeout.unref?.();
        child.stdout.on("data", (chunk) => {
          if (Buffer.byteLength(stdout) >= 256 * 1024)
            return;
          stdout += chunk.toString("utf8");
          if (Buffer.byteLength(stdout) > 256 * 1024)
            stdout = stdout.slice(0, 256 * 1024);
        });
        child.stderr.on("data", (chunk) => {
          stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16 * 1024);
        });
        child.once("error", (error) => {
          finish({ ok: false, error: `Could not start the peer-auth helper: ${error.message}` });
        });
        child.once("exit", (code) => {
          if (settled)
            return;
          if (code !== 0) {
            finish({
              ok: false,
              error: stderr.trim() || `Peer-auth helper exited with code ${code ?? "unknown"}`
            });
            return;
          }
          try {
            const parsed = JSON.parse(stdout || "{}");
            finish(isRecord(parsed) ? parsed : { ok: false, error: "Peer-auth helper returned invalid JSON" });
          } catch {
            finish({ ok: false, error: "Peer-auth helper returned invalid JSON" });
          }
        });
        child.stdin.end(JSON.stringify(body));
      });
    }
    function isRecord(value) {
      return typeof value === "object" && value !== null && !Array.isArray(value);
    }
    function postJson(record, urlPath, body) {
      return new Promise((resolve) => {
        const payload = JSON.stringify(body);
        const req = node_http_1.default.request({
          host: record.host || "127.0.0.1",
          port: record.port,
          path: urlPath,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
          timeout: REQUEST_TIMEOUT_MS
        }, (res) => {
          res.resume();
          res.on("end", resolve);
          res.on("error", () => resolve());
        });
        req.on("timeout", () => req.destroy());
        req.on("error", () => resolve());
        req.on("close", resolve);
        req.end(payload);
      });
    }
    function postJsonForResult(record, urlPath, body, timeoutMs) {
      return new Promise((resolve) => {
        const payload = JSON.stringify(body);
        let settled = false;
        const finish = (result) => {
          if (settled)
            return;
          settled = true;
          resolve(result);
        };
        const req = node_http_1.default.request({
          host: record.host || "127.0.0.1",
          port: record.port,
          path: urlPath,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
          timeout: timeoutMs
        }, (res) => {
          let responseBody = "";
          res.setEncoding("utf-8");
          res.on("data", (chunk) => {
            if (responseBody.length < 64e3)
              responseBody += chunk;
          });
          res.on("end", () => {
            try {
              const parsed = JSON.parse(responseBody || "{}");
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300 && parsed.ok === true && typeof parsed.terminalId === "string") {
                finish({ ok: true, terminalId: parsed.terminalId, ...typeof parsed.message === "string" ? { message: parsed.message } : {} });
                return;
              }
              finish({
                ok: false,
                error: typeof parsed.error === "string" ? parsed.error : `1DevTool bridge returned HTTP ${res.statusCode ?? 500}`
              });
            } catch {
              finish({ ok: false, error: "1DevTool bridge returned an invalid response" });
            }
          });
          res.on("error", () => finish({ ok: false, error: "1DevTool bridge response failed" }));
        });
        req.on("timeout", () => {
          req.destroy();
          finish({ ok: false, error: "Timed out waiting for 1DevTool to open the interactive terminal" });
        });
        req.on("error", () => finish({ ok: false, error: "Could not reach this 1DevTool bridge instance" }));
        req.end(payload);
      });
    }
    function requestInteractiveDelegation(args) {
      const bridges = discoverBridges();
      if (bridges.length === 0) {
        return Promise.resolve({
          ok: false,
          error: "No running 1DevTool instance was found. Interactive delegation must be launched from a live 1DevTool terminal."
        });
      }
      const payload = {
        ...args,
        terminalId: process.env.ONEDEVTOOL_TERMINAL_ID || void 0,
        sourcePid: process.pid,
        sourcePpid: process.ppid
      };
      return new Promise((resolve) => {
        let remaining = bridges.length;
        const errors = [];
        for (const bridge of bridges) {
          void postJsonForResult(bridge, "/subagent/interactive", payload, INTERACTIVE_REQUEST_TIMEOUT_MS).then((result) => {
            if (result.ok) {
              resolve(result);
              return;
            }
            errors.push(result.error);
            remaining -= 1;
            if (remaining === 0) {
              resolve({
                ok: false,
                error: errors.find((error) => !error.includes("does not own")) ?? errors[0] ?? "No 1DevTool instance accepted the interactive delegation."
              });
            }
          });
        }
      });
    }
    function postJsonForEnvelope(record, urlPath, body, timeoutMs) {
      return new Promise((resolve) => {
        const payload = JSON.stringify(body);
        const req = node_http_1.default.request({
          host: record.host || "127.0.0.1",
          port: record.port,
          path: urlPath,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
          timeout: timeoutMs
        }, (res) => {
          let text = "";
          res.setEncoding("utf-8");
          res.on("data", (chunk) => {
            if (text.length < 2 * 1024 * 1024)
              text += chunk;
          });
          res.on("end", () => {
            try {
              const parsed = JSON.parse(text || "{}");
              resolve({ status: res.statusCode ?? 500, body: parsed && typeof parsed === "object" ? parsed : {} });
            } catch {
              resolve({ status: res.statusCode ?? 500, body: { ok: false, error: "1DevTool bridge returned invalid JSON" } });
            }
          });
        });
        req.on("timeout", () => {
          req.destroy();
          resolve({ status: 504, body: { ok: false, error: "Timed out waiting for Agent Orchestration" } });
        });
        req.on("error", () => resolve({ status: 503, body: { ok: false, error: "Could not reach this 1DevTool bridge instance" } }));
        req.end(payload);
      });
    }
    function requestPeerAuthenticatedOrchestration(action, payload, timeoutMs = 11e4) {
      if ("terminalId" in payload || "sourcePid" in payload || "sourcePpid" in payload || "fromMemberId" in payload) {
        return Promise.resolve({ ok: false, error: "Caller identity is not accepted on the peer-authenticated wire" });
      }
      const endpoints = discoverBridges().map(peerAuthRecord).filter((endpoint) => endpoint !== null);
      if (endpoints.length === 0) {
        return Promise.resolve({
          ok: false,
          error: process.platform === "darwin" ? "No running 1DevTool instance exposes the peer-authenticated orchestration transport" : "Pull context reads (link read / screen / peers) are not available on this OS. Only macOS has the connection-bound peer-auth transport today; Windows and Linux can still use link send/ask when the target is ready. Granting full read permissions in the UI does not enable pull reads here \u2014 that is a platform limit, not a missing consent grant."
        });
      }
      return new Promise((resolve) => {
        let remaining = endpoints.length;
        const errors = [];
        for (const endpoint of endpoints) {
          void callPeerAuth(endpoint, { action, payload }, timeoutMs).then((result) => {
            const error = typeof result.error === "string" ? result.error : "";
            const ownershipMiss = error.includes("does not own the calling terminal");
            const unsupportedAction = error.includes("Unsupported peer-auth orchestration action");
            const transientFailure = error.includes("peer-auth helper") || error.includes("transport stopped") || error.includes("Timed out");
            if (!ownershipMiss && !unsupportedAction && !transientFailure) {
              resolve(result);
              return;
            }
            if (error && !ownershipMiss && !unsupportedAction)
              errors.push(error);
            remaining -= 1;
            if (remaining === 0) {
              resolve({
                ok: false,
                error: errors[0] ?? "No peer-authenticated 1DevTool instance owns the calling terminal"
              });
            }
          });
        }
      });
    }
    function isDefinitivePeerAuthMiss(error) {
      return error.includes("No running 1DevTool instance exposes the peer-authenticated orchestration transport") || error.includes("No peer-authenticated 1DevTool instance owns the calling terminal");
    }
    function replyMailboxOwnershipMiss(result) {
      return typeof result.error === "string" && result.error.includes("does not own the calling terminal") || // Compatibility with an app that predates the normalized ownership-miss
      // response. A process that knows the federated message but not its paired
      // admission cannot own this reply capability, so another live mailbox must
      // still get a chance to answer.
      result.error === "no-link" && result.detail === "federated admission is missing";
    }
    function replyMailboxProcessingRejection(result) {
      return typeof result.error === "string" && result.error.includes("Invalid 1DevTool reply-mailbox request");
    }
    function unlinkBestEffort(filePath) {
      try {
        node_fs_12.default.unlinkSync(filePath);
      } catch {
      }
    }
    async function requestReplyTokenThroughMailboxes(payload, timeoutMs) {
      const replyToken = typeof payload.replyToken === "string" ? payload.replyToken.trim() : "";
      const body = typeof payload.body === "string" ? payload.body : "";
      const waitMs = typeof payload.waitMs === "number" ? payload.waitMs : void 0;
      const gateDecision = payload.gateDecision === "accept" || payload.gateDecision === "reject" ? payload.gateDecision : void 0;
      if (!/^[0-9a-f]{24}$/i.test(replyToken) || !body || body.length > 64e3) {
        return { ok: false, error: "Invalid token-attributed link reply" };
      }
      if (waitMs !== void 0 && (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 12e4)) {
        return { ok: false, error: "Invalid token-attributed link reply wait time" };
      }
      const mailboxes = discoverBridges().map(replyMailboxRecord).filter((record) => record !== null);
      if (mailboxes.length === 0)
        return null;
      const requestId = node_crypto_12.default.randomUUID();
      const request = {
        protocolVersion: orchestrationReplyMailbox_1.LINK_REPLY_MAILBOX_PROTOCOL_VERSION,
        requestId,
        action: "link-send-by-token",
        replyToken,
        body,
        createdAt: Date.now(),
        ...waitMs !== void 0 ? { waitMs } : {},
        ...gateDecision ? { gateDecision } : {}
      };
      const serialized = JSON.stringify(request);
      const published = [];
      for (const { endpoint } of mailboxes) {
        const requestPath = node_path_12.default.join(endpoint.requestDir, `${requestId}.json`);
        const responsePath = node_path_12.default.join(endpoint.responseDir, `${requestId}.json`);
        const tempPath = `${requestPath}.${process.pid}.tmp`;
        try {
          await node_fs_12.default.promises.writeFile(tempPath, serialized, { mode: 384, flag: "wx" });
          await node_fs_12.default.promises.rename(tempPath, requestPath);
          published.push({ requestPath, responsePath });
        } catch {
          unlinkBestEffort(tempPath);
        }
      }
      if (published.length === 0)
        return null;
      const deadline = Date.now() + Math.max(1, Math.min(timeoutMs, 135e3));
      const completed = /* @__PURE__ */ new Set();
      let rejection = null;
      try {
        while (Date.now() < deadline) {
          for (const entry of published) {
            if (completed.has(entry.responsePath))
              continue;
            try {
              const stat = await node_fs_12.default.promises.stat(entry.responsePath);
              if (!stat.isFile() || stat.size <= 0 || stat.size > orchestrationReplyMailbox_1.LINK_REPLY_MAILBOX_MAX_RESPONSE_BYTES) {
                return { ok: false, error: "1DevTool reply mailbox returned an invalid response" };
              }
              const parsed = JSON.parse(await node_fs_12.default.promises.readFile(entry.responsePath, "utf8"));
              const result = isRecord(parsed) ? parsed : { ok: false, error: "1DevTool reply mailbox returned an invalid response" };
              completed.add(entry.responsePath);
              if (replyMailboxProcessingRejection(result)) {
                rejection = result;
                continue;
              }
              if (!replyMailboxOwnershipMiss(result))
                return result;
            } catch (error) {
              if (error.code !== "ENOENT") {
                return { ok: false, error: "Could not read the 1DevTool reply-mailbox response" };
              }
            }
          }
          if (completed.size === published.length) {
            return rejection ?? { ok: false, error: "No running 1DevTool instance owns this reply token" };
          }
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        return {
          ok: false,
          error: "Timed out waiting for the 1DevTool reply mailbox; delivery status is uncertain"
        };
      } finally {
        for (const entry of published) {
          unlinkBestEffort(entry.requestPath);
          unlinkBestEffort(entry.responsePath);
        }
      }
    }
    async function requestSandboxCompatibleAgentOrchestration(action, urlPath, payload, timeoutMs = ORCHESTRATION_REQUEST_TIMEOUT_MS) {
      if (action === "link-send-by-token") {
        const mailboxResult = await requestReplyTokenThroughMailboxes(payload, timeoutMs);
        if (mailboxResult)
          return mailboxResult;
      }
      if (process.platform !== "darwin") {
        return requestAgentOrchestration(urlPath, payload, timeoutMs);
      }
      const peerResult = await requestPeerAuthenticatedOrchestration(action, payload, timeoutMs);
      if (peerResult.ok === true)
        return peerResult;
      const error = typeof peerResult.error === "string" ? peerResult.error : "";
      if (!isDefinitivePeerAuthMiss(error))
        return peerResult;
      return requestAgentOrchestration(urlPath, payload, timeoutMs);
    }
    function requestAgentOrchestration(urlPath, payload, timeoutMs = ORCHESTRATION_REQUEST_TIMEOUT_MS) {
      const bridges = discoverBridges();
      if (bridges.length === 0) {
        return Promise.resolve({ ok: false, error: "No running 1DevTool instance was found" });
      }
      const body = {
        ...payload,
        terminalId: process.env.ONEDEVTOOL_TERMINAL_ID || void 0,
        sourcePid: process.pid,
        sourcePpid: process.ppid
      };
      return new Promise((resolve) => {
        let remaining = bridges.length;
        const errors = [];
        for (const bridge of bridges) {
          void postJsonForEnvelope(bridge, urlPath, body, timeoutMs).then((result) => {
            const error = typeof result.body.error === "string" ? result.body.error : "";
            const ownershipMiss = error.includes("does not own the calling terminal");
            const unsupportedRoute = result.status === 404 || error.trim().toLowerCase() === "not found";
            const transientFailure = result.status >= 500;
            if (!ownershipMiss && !unsupportedRoute && !transientFailure) {
              resolve(result.body);
              return;
            }
            if (error && !ownershipMiss && !unsupportedRoute)
              errors.push(error);
            remaining -= 1;
            if (remaining === 0) {
              resolve({
                ok: false,
                error: errors[0] ?? "No compatible 1DevTool instance owns the calling terminal"
              });
            }
          });
        }
      });
    }
    function createDelegationNotifier(args) {
      const bridges = discoverBridges();
      const base = {
        callId: args.callId,
        terminalId: process.env.ONEDEVTOOL_TERMINAL_ID || void 0,
        sourcePid: process.pid,
        sourcePpid: process.ppid
      };
      return {
        start: async () => {
          if (bridges.length === 0)
            return;
          await Promise.all(bridges.map((b) => postJson(b, "/subagent/start", {
            ...base,
            target: args.target,
            command: args.command,
            startedAt: Date.now(),
            timeoutSeconds: args.timeoutSeconds
          })));
        },
        end: async (status, exitCode) => {
          if (bridges.length === 0)
            return;
          await Promise.all(bridges.map((b) => postJson(b, "/subagent/end", {
            callId: args.callId,
            status,
            endedAt: Date.now(),
            exitCode
          })));
        }
      };
    }
  }
});

// dist/main/shared/orchestrationShim.js
var require_orchestrationShim = __commonJS({
  "dist/main/shared/orchestrationShim.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.ORCHESTRATOR_SHIM_NAME_WIN = exports2.ORCHESTRATOR_SHIM_NAME_UNIX = exports2.ORCHESTRATOR_SHIM_GENERATION = void 0;
    exports2.buildOrchestratorShimContent = buildOrchestratorShimContent;
    exports2.ORCHESTRATOR_SHIM_GENERATION = 9;
    exports2.ORCHESTRATOR_SHIM_NAME_UNIX = `1devtool-agent-v${exports2.ORCHESTRATOR_SHIM_GENERATION}`;
    exports2.ORCHESTRATOR_SHIM_NAME_WIN = `1devtool-agent-v${exports2.ORCHESTRATOR_SHIM_GENERATION}.cmd`;
    function buildOrchestratorShimContent(target, isWindows) {
      if (isWindows) {
        return target.runAsNode ? `@echo off\r
set ELECTRON_RUN_AS_NODE=1\r
"${target.runtime}" "${target.cliPath}" %*\r
` : `@echo off\r
"${target.runtime}" "${target.cliPath}" %*\r
`;
      }
      return target.runAsNode ? `#!/usr/bin/env sh
ELECTRON_RUN_AS_NODE=1 exec "${target.runtime}" "${target.cliPath}" "$@"
` : `#!/usr/bin/env sh
exec "${target.runtime}" "${target.cliPath}" "$@"
`;
    }
  }
});

// dist/main/shared/orchestrationCommand.js
var require_orchestrationCommand = __commonJS({
  "dist/main/shared/orchestrationCommand.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.isWindowsOrchestrationShim = isWindowsOrchestrationShim;
    exports2.agentToolShellPrefersPosix = agentToolShellPrefersPosix;
    exports2.quotePosixShellArg = quotePosixShellArg;
    exports2.quotePowerShellArg = quotePowerShellArg;
    exports2.buildOrchestrationCommandSnippet = buildOrchestrationCommandSnippet;
    exports2.buildOrchestrationManifestSnippet = buildOrchestrationManifestSnippet;
    exports2.buildLinkSendCommandSnippet = buildLinkSendCommandSnippet;
    exports2.buildReportCommandSnippet = buildReportCommandSnippet;
    exports2.indentOrchestrationSnippet = indentOrchestrationSnippet;
    function isWindowsOrchestrationShim(shimPath) {
      return /\.cmd$/i.test(shimPath.trim());
    }
    function agentToolShellPrefersPosix(agentKind) {
      return agentKind === "claude-command" || agentKind === "claude";
    }
    function quotePosixShellArg(value) {
      return `'${value.replace(/'/g, `'"'"'`)}'`;
    }
    function quotePowerShellArg(value) {
      return `'${value.replace(/'/g, "''")}'`;
    }
    function buildOrchestrationCommandSnippet(shimPath, target, model) {
      const modelArg = model ? ` --model=${model}` : "";
      if (!isWindowsOrchestrationShim(shimPath)) {
        return `printf '%s' "$TASK" | ${quotePosixShellArg(shimPath)} run --to=${target}${modelArg} --prompt-stdin`;
      }
      const quotedShim = quotePowerShellArg(shimPath);
      return [
        "$previousOutputEncoding = $OutputEncoding",
        "try {",
        "  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        `  $TASK | & ${quotedShim} run --to=${target}${modelArg} --prompt-stdin`,
        "} finally {",
        "  $OutputEncoding = $previousOutputEncoding",
        "}"
      ].join("\n");
    }
    function buildOrchestrationManifestSnippet(shimPath, topology) {
      if (!isWindowsOrchestrationShim(shimPath)) {
        return `printf '%s' "$MANIFEST" | ${quotePosixShellArg(shimPath)} ${topology} start --manifest-stdin`;
      }
      return [
        "$previousOutputEncoding = $OutputEncoding",
        "try {",
        "  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        `  $MANIFEST | & ${quotePowerShellArg(shimPath)} ${topology} start --manifest-stdin`,
        "} finally {",
        "  $OutputEncoding = $previousOutputEncoding",
        "}"
      ].join("\n");
    }
    function buildLinkSendCommandSnippet(shimPath, terminalId, inputVariable = "$MSG", options = {}) {
      const replyFlag = options.replyToMessageId ? ` --reply-to=${options.replyToMessageId}` : "";
      const tokenFlag = options.replyToken ? ` --reply-token=${options.replyToken}` : "";
      const gateFlag = options.gateDecision ? ` --gate=${options.gateDecision}` : "";
      if (options.posixShell === true || !isWindowsOrchestrationShim(shimPath)) {
        return `printf '%s' "${inputVariable}" | ${quotePosixShellArg(shimPath)} link send --to=${terminalId}${replyFlag}${tokenFlag}${gateFlag} --prompt-stdin --wait`;
      }
      return [
        "$previousOutputEncoding = $OutputEncoding",
        "try {",
        "  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        `  ${inputVariable} | & ${quotePowerShellArg(shimPath)} link send --to=${terminalId}${replyFlag}${tokenFlag}${gateFlag} --prompt-stdin --wait`,
        "} finally {",
        "  $OutputEncoding = $previousOutputEncoding",
        "}"
      ].join("\n");
    }
    function buildReportCommandSnippet(shimPath, options = {}) {
      const blockedFlag = options.blocked ? " --blocked" : "";
      const continueFlag = options.continueFromMessageId ? ` --continue=${options.continueFromMessageId}` : "";
      const completeFlag = options.complete ? " --complete" : "";
      if (options.posixShell === true || !isWindowsOrchestrationShim(shimPath)) {
        if (options.complete)
          return `${quotePosixShellArg(shimPath)} report --complete`;
        return `printf '%s' "$MSG" | ${quotePosixShellArg(shimPath)} report${blockedFlag}${continueFlag} --prompt-stdin --wait`;
      }
      return [
        "$previousOutputEncoding = $OutputEncoding",
        "try {",
        "  $OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        ...options.complete ? [`  & ${quotePowerShellArg(shimPath)} report --complete`] : [`  $MSG | & ${quotePowerShellArg(shimPath)} report${blockedFlag}${continueFlag} --prompt-stdin --wait`],
        "} finally {",
        "  $OutputEncoding = $previousOutputEncoding",
        "}"
      ].join("\n");
    }
    function indentOrchestrationSnippet(snippet, spaces = 4) {
      const prefix = " ".repeat(spaces);
      return snippet.split("\n").map((line) => `${prefix}${line}`).join("\n");
    }
  }
});

// dist/main/cli/linkGuard.js
var require_linkGuard = __commonJS({
  "dist/main/cli/linkGuard.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.findLinkedPeerForAgent = findLinkedPeerForAgent;
    exports2.findLinkedPeersForAgent = findLinkedPeersForAgent;
    exports2.formatLinkGuardError = formatLinkGuardError;
    var orchestrationCommand_1 = require_orchestrationCommand();
    var AGENT_KIND_ALIASES = {
      "claude-command": "claude",
      antigravity: "agy"
    };
    function normalizeKind(kind) {
      if (!kind)
        return null;
      const lower = kind.toLowerCase();
      return AGENT_KIND_ALIASES[lower] ?? lower;
    }
    function findLinkedPeerForAgent(whoami, targetAgentId) {
      const peers = findLinkedPeersForAgent(whoami, targetAgentId);
      return peers.length === 1 ? peers[0] : null;
    }
    function findLinkedPeersForAgent(whoami, targetAgentId) {
      if (!whoami?.ok || !Array.isArray(whoami.links?.outbound))
        return [];
      const target = normalizeKind(targetAgentId);
      if (!target)
        return [];
      return whoami.links.outbound.filter((row) => row.state === "active" && row.permissions?.includes("send") && normalizeKind(row.agent) === target);
    }
    function formatLinkGuardError(rowOrRows, targetAgentId, shimPath) {
      const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
      const targets = rows.map((row) => `"${row.peerName}" (${row.peerTerminalId}):
` + (0, orchestrationCommand_1.indentOrchestrationSnippet)((0, orchestrationCommand_1.buildLinkSendCommandSnippet)(shimPath, row.peerTerminalId), 2)).join("\n\n");
      const destination = rows.length === 1 ? `the open ${targetAgentId} terminal ` : `${rows.length} open ${targetAgentId} terminals; choose the intended terminal explicitly:

`;
      const targetText = rows.length === 1 ? `"${rows[0].peerName}" (${rows[0].peerTerminalId}). Deliver over the link instead \u2014 it uses the live session (approvals, context, visible to the user):

${targets}` : `${targets}

Do not choose a peer from ordering alone.`;
      return `active links already connect you to ${destination}${targetText}

A fresh headless ${targetAgentId} cannot answer permission prompts and cannot see that terminal's context. Pass --no-link only if you intentionally want a separate headless run.`;
    }
  }
});

// dist/main/cli/runLog.js
var require_runLog = __commonJS({
  "dist/main/cli/runLog.js"(exports2) {
    "use strict";
    var __importDefault2 = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.startRunLog = startRunLog;
    var node_fs_12 = __importDefault2(require("node:fs"));
    var node_path_12 = __importDefault2(require("node:path"));
    var orchestrationRuns_12 = require_orchestrationRuns();
    var NOOP_RUN_LOG_BASE = { captureContent: false, finalize: () => {
    } };
    function startRunLog(args) {
      let config;
      try {
        config = (0, orchestrationRuns_12.readOrchestrationConfig)();
      } catch {
        config = {
          ...orchestrationRuns_12.DEFAULT_ORCHESTRATION_CONFIG,
          retention: { ...orchestrationRuns_12.DEFAULT_ORCHESTRATION_CONFIG.retention },
          scheduling: { ...orchestrationRuns_12.DEFAULT_ORCHESTRATION_CONFIG.scheduling }
        };
      }
      let runDir;
      const truncation = {};
      let record;
      try {
        const runsDir = (0, orchestrationRuns_12.getOrchestrationRunsDir)();
        runDir = (0, orchestrationRuns_12.getRunDir)(args.callId);
        (0, orchestrationRuns_12.ensureDir)(runsDir, 448);
        (0, orchestrationRuns_12.ensureDir)(runDir, 448);
        record = {
          callId: args.callId,
          target: args.target,
          ...args.category ? { category: args.category } : {},
          ...args.model ? { model: args.model } : {},
          command: args.command,
          cwd: args.cwd,
          ...args.hostTerminalId ? { hostTerminalId: args.hostTerminalId } : {},
          startedAt: args.startedAt,
          timeoutSeconds: args.timeoutSeconds,
          status: "running",
          promptChars: args.prompt.length,
          contentCaptured: config.captureContent
        };
        if (config.captureContent) {
          const capped = (0, orchestrationRuns_12.truncateUtf8Bytes)(args.prompt, orchestrationRuns_12.RUN_PROMPT_CAP_BYTES);
          if (capped.truncated)
            truncation.prompt = true;
          writeContentFile(runDir, "prompt", capped.text);
        }
        if (truncation.prompt)
          record.truncated = { ...truncation };
        (0, orchestrationRuns_12.writeRunMeta)(runDir, record);
        warnPastRetention(runsDir, config);
      } catch {
        return { callId: args.callId, ...NOOP_RUN_LOG_BASE };
      }
      let finalized = false;
      return {
        callId: args.callId,
        captureContent: config.captureContent,
        finalize: (final) => {
          if (finalized)
            return;
          finalized = true;
          try {
            const merged = { ...truncation, ...final.truncated ?? {} };
            if (config.captureContent) {
              if (typeof final.output === "string" && final.output.length > 0) {
                const capped = (0, orchestrationRuns_12.truncateChars)(final.output, orchestrationRuns_12.RUN_OUTPUT_CAP_CHARS);
                if (capped.truncated)
                  merged.output = true;
                writeContentFile(runDir, "output", capped.text);
              }
              if (typeof final.stderr === "string" && final.stderr.length > 0) {
                const capped = (0, orchestrationRuns_12.truncateUtf8Bytes)(final.stderr, orchestrationRuns_12.RUN_STDERR_CAP_BYTES);
                if (capped.truncated)
                  merged.stderr = true;
                writeContentFile(runDir, "stderr", capped.text);
              }
            }
            const finalRecord = {
              ...record,
              status: final.status,
              endedAt: final.endedAt,
              durationSeconds: Math.max(0, Math.round((final.endedAt - record.startedAt) / 1e3)),
              ...typeof final.exitCode === "number" ? { exitCode: final.exitCode } : {},
              ...typeof final.output === "string" ? { outputChars: final.output.length } : {},
              ...Object.keys(merged).length > 0 ? { truncated: merged } : {}
            };
            (0, orchestrationRuns_12.writeRunMeta)(runDir, finalRecord);
          } catch {
          }
        }
      };
    }
    function writeContentFile(runDir, file, text) {
      try {
        node_fs_12.default.writeFileSync(node_path_12.default.join(runDir, (0, orchestrationRuns_12.getRunContentFileName)(file)), text, { encoding: "utf-8", mode: 384 });
      } catch {
      }
    }
    function warnPastRetention(runsDir, config) {
      try {
        const count = node_fs_12.default.readdirSync(runsDir).length;
        if (count > config.retention.maxRuns * 2) {
          process.stderr.write(`1devtool-agent: ${count} orchestration run records under ${runsDir} (open 1DevTool to prune, or delete the directory)
`);
        }
      } catch {
      }
    }
  }
});

// dist/main/shared/types.js
var require_types = __commonJS({
  "dist/main/shared/types.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.PROJECT_COLORS = exports2.DEFAULT_PREFERENCES = exports2.RECOMMENDED_HIDDEN_STARTUP_AGENTS = exports2.DEFAULT_TERMINAL_SCROLLBACK_LINES = exports2.TERMINAL_SCROLLBACK_MAX_LINES = exports2.TERMINAL_SCROLLBACK_MIN_LINES = exports2.DEFAULT_SHORTCUTS = exports2.DEFAULT_STARTUP_COMMAND_PRESETS = exports2.PROJECT_SETTINGS_FILE_VERSION = exports2.EXECUTABLE_PROJECT_SETTINGS_DOMAINS = exports2.DEFAULT_OUTPUT_CAPTURE = exports2.DEFAULT_PIPE_SETTINGS = exports2.AGENT_CONFIG = void 0;
    exports2.mergeShortcutsWithDefaults = mergeShortcutsWithDefaults;
    exports2.clampTerminalScrollback = clampTerminalScrollback;
    exports2.AGENT_CONFIG = {
      claude: { name: "Claude Code", color: "#F59E0B", icon: "claude", command: "claude" },
      codex: { name: "Codex", color: "#10B981", icon: "codex", command: "codex" },
      gemini: { name: "Gemini CLI", color: "#8B5CF6", icon: "gemini", command: "gemini" },
      kimi: { name: "Kimi Code", color: "#1677FF", icon: "kimi", command: "kimi" },
      agy: { name: "Antigravity", color: "#64748B", icon: "antigravity", command: "agy" },
      amp: { name: "Amp", color: "#EC4899", icon: "amp", command: "amp" },
      opencode: { name: "OpenCode", color: "#3B82F6", icon: "terminal", command: "opencode" },
      cline: { name: "Cline", color: "#06B6D4", icon: "terminal", command: "cline" },
      qoder: { name: "Qoder", color: "#F97316", icon: "terminal", command: "qoder" },
      qwen: { name: "Qwen Code", color: "#6366F1", icon: "terminal", command: "qwen" },
      grok: { name: "Grok CLI", color: "#71767B", icon: "grok", command: "grok" },
      hermes: { name: "Hermes Agent", color: "#8B5CF6", icon: "hermes", command: "hermes" },
      // Cursor's docs teach `agent`, but the executable is `cursor-agent` and only
      // post-rename installs have the `agent` symlink — `cursor-agent` is the
      // spelling every install still ships, so it stays the default we type. Both
      // are recognized on the way back in (getDeclaredAgentKind). `cursor` alone
      // is the editor launcher and is never the agent.
      cursor: { name: "Cursor CLI", color: "#14B8A6", icon: "cursor", command: "cursor-agent" },
      // Pi (@earendil-works/pi-coding-agent). The color is the accent its own
      // TUI paints the `pi` wordmark in; the mark itself is monochrome.
      pi: { name: "Pi", color: "#8ABEB7", icon: "pi", command: "pi" },
      bash: { name: "bash", color: "#64748B", icon: "terminal", command: void 0 },
      zsh: { name: "zsh", color: "#64748B", icon: "terminal", command: void 0 },
      powershell: { name: "PowerShell", color: "#0078D4", icon: "powershell", command: void 0 },
      custom: { name: "Custom", color: "#6B7280", icon: "terminal", command: void 0 }
    };
    exports2.DEFAULT_PIPE_SETTINGS = {
      maxIterations: 10,
      globalTimeout: 5 * 60 * 1e3,
      onError: "stop",
      retryCount: 1,
      retryDelayMs: 1500,
      notifications: true
    };
    exports2.DEFAULT_OUTPUT_CAPTURE = {
      mode: "full",
      waitFor: {
        type: "idle",
        idleMs: 3e3
      }
    };
    exports2.EXECUTABLE_PROJECT_SETTINGS_DOMAINS = [
      "agents",
      "channels",
      "skills",
      "tasks"
    ];
    exports2.PROJECT_SETTINGS_FILE_VERSION = 1;
    exports2.DEFAULT_STARTUP_COMMAND_PRESETS = [
      // Development Servers
      { id: "npm-dev", name: "npm run dev", command: "npm run dev", category: "Dev Servers" },
      { id: "npm-start", name: "npm start", command: "npm start", category: "Dev Servers" },
      { id: "yarn-dev", name: "yarn dev", command: "yarn dev", category: "Dev Servers" },
      { id: "pnpm-dev", name: "pnpm dev", command: "pnpm dev", category: "Dev Servers" },
      { id: "vite", name: "Vite Dev", command: "npx vite", category: "Dev Servers" },
      { id: "next-dev", name: "Next.js Dev", command: "npx next dev", category: "Dev Servers" },
      { id: "nuxt-dev", name: "Nuxt Dev", command: "npx nuxi dev", category: "Dev Servers" },
      { id: "remix-dev", name: "Remix Dev", command: "npx remix dev", category: "Dev Servers" },
      { id: "astro-dev", name: "Astro Dev", command: "npx astro dev", category: "Dev Servers" },
      // Build & Test
      { id: "npm-build", name: "npm run build", command: "npm run build", category: "Build & Test" },
      { id: "npm-test", name: "npm test", command: "npm test", category: "Build & Test" },
      { id: "npm-test-watch", name: "npm test (watch)", command: "npm test -- --watch", category: "Build & Test" },
      { id: "vitest", name: "Vitest", command: "npx vitest", category: "Build & Test" },
      { id: "jest", name: "Jest", command: "npx jest", category: "Build & Test" },
      { id: "playwright", name: "Playwright Test", command: "npx playwright test", category: "Build & Test" },
      { id: "tsc-watch", name: "TypeScript Watch", command: "npx tsc --watch", category: "Build & Test" },
      // Docker
      { id: "docker-compose-up", name: "Docker Compose Up", command: "docker compose up", category: "Docker" },
      { id: "docker-compose-up-d", name: "Docker Compose Up -d", command: "docker compose up -d", category: "Docker" },
      { id: "docker-compose-down", name: "Docker Compose Down", command: "docker compose down", category: "Docker" },
      { id: "docker-ps", name: "Docker PS", command: "docker ps", category: "Docker" },
      { id: "docker-logs", name: "Docker Logs", command: "docker compose logs -f", category: "Docker" },
      // Database
      { id: "prisma-studio", name: "Prisma Studio", command: "npx prisma studio", category: "Database" },
      { id: "prisma-migrate", name: "Prisma Migrate Dev", command: "npx prisma migrate dev", category: "Database" },
      { id: "drizzle-studio", name: "Drizzle Studio", command: "npx drizzle-kit studio", category: "Database" },
      // Backend
      { id: "python-server", name: "Python HTTP Server", command: "python -m http.server 8000", category: "Backend" },
      { id: "flask-run", name: "Flask Run", command: "flask run", category: "Backend" },
      { id: "uvicorn", name: "Uvicorn (FastAPI)", command: "uvicorn main:app --reload", category: "Backend" },
      { id: "rails-server", name: "Rails Server", command: "rails server", category: "Backend" },
      { id: "go-run", name: "Go Run", command: "go run .", category: "Backend" },
      { id: "cargo-run", name: "Cargo Run", command: "cargo run", category: "Backend" },
      { id: "cargo-watch", name: "Cargo Watch", command: "cargo watch -x run", category: "Backend" },
      // Git
      { id: "git-status", name: "Git Status", command: "git status", category: "Git" },
      { id: "git-log", name: "Git Log", command: "git log --oneline -20", category: "Git" },
      { id: "git-diff", name: "Git Diff", command: "git diff", category: "Git" },
      // AI Agents
      { id: "claude-skip-permissions", name: "Claude (Skip Permissions)", command: "claude --dangerously-skip-permissions", category: "AI Agents" },
      { id: "codex-bypass-approvals", name: "Codex (Bypass Approvals)", command: "codex --dangerously-bypass-approvals-and-sandbox", category: "AI Agents" },
      // Utilities
      { id: "watch-files", name: "Watch Files", command: "watch -n 1 ls -la", category: "Utilities" },
      { id: "htop", name: "htop", command: "htop", category: "Utilities" },
      { id: "tail-logs", name: "Tail Logs", command: "tail -f logs/*.log", category: "Utilities" }
    ];
    var IS_MAC_PLATFORM = (() => {
      if (typeof process !== "undefined" && process.platform)
        return process.platform === "darwin";
      const runtimeNavigator = globalThis.navigator;
      if (runtimeNavigator?.platform)
        return runtimeNavigator.platform.toUpperCase().includes("MAC");
      return true;
    })();
    exports2.DEFAULT_SHORTCUTS = [
      // General
      { id: "settings", label: "Open Settings", keys: "cmd+,", category: "general" },
      { id: "commandPalette", label: "Command Palette", keys: "cmd+shift+p", category: "general" },
      { id: "quickOpen", label: "Quick Open", keys: "cmd+p", category: "general" },
      { id: "quickCommands", label: "Quick Commands", keys: "cmd+shift+r", category: "general" },
      { id: "missionControl", label: "Mission Control", keys: "ctrl+up", category: "general" },
      { id: "quotaCenter", label: "AI Quota Center", description: "Open the Spend & Quota Center panel.", keys: "cmd+shift+u", category: "general" },
      { id: "shortcutGuide", label: "Keyboard Shortcuts", keys: "cmd+/", category: "general" },
      // Layout
      { id: "toggleSidebar", label: "Toggle Sidebar", keys: "cmd+b", category: "layout" },
      { id: "toggleEditor", label: "Toggle Editor", keys: "cmd+j", category: "layout" },
      { id: "toggleTerminal", label: "Toggle Terminal", description: "Collapse or expand the terminal section below the editor.", keys: "cmd+shift+j", category: "layout" },
      { id: "toggleOutput", label: "Toggle Output Panel", keys: "cmd+\\", category: "layout" },
      // Mosaic (tiling layout). Every binding below was checked against the rest
      // of this table; the one deliberate omission is plain Cmd+M, which the
      // application menu's `role: 'minimize'` owns on macOS — a renderer handler
      // for it would never fire, so magnify takes Ctrl+Cmd+M.
      { id: "layoutMosaic", label: "Mosaic Layout", description: "Switch this project to the tiling layout.", keys: "cmd+alt+7", category: "layout" },
      { id: "mosaicAddTile", label: "Add Tile", description: "Open the Mosaic tile palette.", keys: "cmd+shift+n", category: "layout" },
      { id: "mosaicCloseTile", label: "Close Tile", description: "Close the focused Mosaic tile (the terminal keeps running).", keys: "cmd+shift+w", category: "layout" },
      { id: "mosaicMagnify", label: "Magnify Tile", description: "Expand the focused Mosaic tile over its siblings, or restore it.", keys: "cmd+ctrl+m", category: "layout" },
      { id: "mosaicSplitRight", label: "Split Tile Right", description: "Add a tile to the right of the focused one.", keys: "cmd+alt+right", category: "layout" },
      { id: "mosaicSplitDown", label: "Split Tile Down", description: "Add a tile below the focused one.", keys: "cmd+alt+down", category: "layout" },
      { id: "mosaicFocusLeft", label: "Focus Tile Left", keys: "ctrl+shift+left", category: "layout" },
      { id: "mosaicFocusRight", label: "Focus Tile Right", keys: "ctrl+shift+right", category: "layout" },
      { id: "mosaicFocusUp", label: "Focus Tile Up", keys: "ctrl+shift+up", category: "layout" },
      { id: "mosaicFocusDown", label: "Focus Tile Down", keys: "ctrl+shift+down", category: "layout" },
      // Terminal
      { id: "selectTerminal1", label: "Select Terminal 1", description: "Switch to and focus the 1st visible terminal.", keys: "cmd+1", category: "terminal" },
      { id: "selectTerminal2", label: "Select Terminal 2", description: "Switch to and focus the 2nd visible terminal.", keys: "cmd+2", category: "terminal" },
      { id: "selectTerminal3", label: "Select Terminal 3", description: "Switch to and focus the 3rd visible terminal.", keys: "cmd+3", category: "terminal" },
      { id: "selectTerminal4", label: "Select Terminal 4", description: "Switch to and focus the 4th visible terminal.", keys: "cmd+4", category: "terminal" },
      { id: "selectTerminal5", label: "Select Terminal 5", description: "Switch to and focus the 5th visible terminal.", keys: "cmd+5", category: "terminal" },
      { id: "selectTerminal6", label: "Select Terminal 6", description: "Switch to and focus the 6th visible terminal.", keys: "cmd+6", category: "terminal" },
      { id: "selectTerminal7", label: "Select Terminal 7", description: "Switch to and focus the 7th visible terminal.", keys: "cmd+7", category: "terminal" },
      { id: "selectTerminal8", label: "Select Terminal 8", description: "Switch to and focus the 8th visible terminal.", keys: "cmd+8", category: "terminal" },
      { id: "selectTerminal9", label: "Select Terminal 9", description: "Switch to and focus the 9th visible terminal.", keys: "cmd+9", category: "terminal" },
      { id: "layoutGrid", label: "Grid Layout", keys: "cmd+alt+1", category: "terminal" },
      { id: "layoutColumns", label: "Columns Layout", keys: "cmd+alt+2", category: "terminal" },
      { id: "layoutSingle", label: "Single Layout", keys: "cmd+alt+3", category: "terminal" },
      { id: "layoutVerticalTabs", label: "Vertical Tabs Layout", keys: "cmd+alt+4", category: "terminal" },
      { id: "layoutCanvas", label: "Canvas Layout", keys: "cmd+alt+5", category: "terminal" },
      { id: "layoutChat", label: "Chat Interface Layout", keys: "cmd+alt+6", category: "terminal" },
      { id: "newTerminal", label: "New Terminal", keys: "cmd+t", category: "terminal" },
      { id: "closeTerminal", label: "Close Terminal", keys: "cmd+w", category: "terminal" },
      { id: "nextTerminal", label: "Next Terminal", keys: "cmd+]", category: "terminal" },
      { id: "prevTerminal", label: "Previous Terminal", keys: "cmd+[", category: "terminal" },
      { id: "clearTerminal", label: "Clear Terminal", keys: "cmd+k", category: "terminal" },
      { id: "hideTerminal", label: "Hide Terminal", description: "Hide the active terminal until you reopen it.", keys: "cmd+shift+h", category: "terminal" },
      // On Windows/Linux `cmd+i` resolves to Ctrl+I, which is a literal Tab in
      // terminals — default to Ctrl+Alt+I there instead. Saved customizations
      // always win over this default (mergeShortcutsWithDefaults keeps saved keys).
      { id: "toggleAgentInput", label: "Toggle Agent Input", description: "Open or close the agent input overlay on AI terminals.", keys: IS_MAC_PLATFORM ? "cmd+i" : "ctrl+alt+i", category: "terminal" },
      { id: "clearAgentInput", label: "Clear Agent Input", description: "Clear all text, file attachments, and images in the agent input overlay.", keys: "cmd+shift+backspace", category: "terminal" },
      { id: "terminalReaderMode", label: "Terminal Reader Mode", description: "Open a fullscreen reading view of the terminal output.", keys: "cmd+shift+e", category: "terminal" },
      { id: "openTerminalsDashboard", label: "Open Terminal Dashboard", description: "Open the cross-project terminal dashboard.", keys: "cmd+shift+d", category: "terminal" },
      { id: "openTerminalsList", label: "Open Terminal List", description: "Open the cross-project terminal list.", keys: "cmd+shift+l", category: "terminal" },
      { id: "openTerminalsCanvas", label: "Open Terminal Canvas", description: "Open the cross-project terminal canvas.", keys: "cmd+shift+c", category: "terminal" },
      // Editor
      { id: "saveFile", label: "Save File", keys: "cmd+s", category: "editor" },
      // Browser
      {
        id: "browserFullscreen",
        label: "Toggle Browser Fullscreen",
        description: "Expand the browser panel to fullscreen and use the same shortcut again to restore it.",
        keys: "cmd+shift+f",
        category: "browser"
      },
      {
        id: "browserExitFullscreen",
        label: "Exit Browser Fullscreen",
        description: "Restore the browser panel from fullscreen.",
        keys: "escape",
        category: "browser"
      },
      {
        id: "captureBrowserScreenshot",
        label: "Capture Browser Screenshot",
        description: "Take a screenshot and open the annotator.",
        keys: "cmd+shift+x",
        category: "browser"
      },
      // Tasks
      { id: "tasksQuickAdd", label: "Quick Add", description: "Focus the task quick-add input when the Tasks panel is active.", keys: "cmd+n", category: "tasks" },
      { id: "tasksSendSelected", label: "Send Selected", description: "Open the send dialog for the selected task.", keys: "cmd+enter", category: "tasks" },
      { id: "tasksSendLast", label: "Send to Last Terminal", description: "Send the selected task to the last used terminal.", keys: "cmd+shift+enter", category: "tasks" },
      { id: "tasksToggleDone", label: "Toggle Done", description: "Mark the selected task done or move it back to todo.", keys: "cmd+d", category: "tasks" }
    ];
    function mergeShortcutsWithDefaults(saved = []) {
      const savedIds = new Set(saved.map((shortcut) => shortcut.id));
      const defaultById = new Map(exports2.DEFAULT_SHORTCUTS.map((shortcut) => [shortcut.id, shortcut]));
      const merged = saved.map((shortcut) => {
        const defaultShortcut = defaultById.get(shortcut.id);
        if (!defaultShortcut)
          return shortcut;
        return {
          ...defaultShortcut,
          ...shortcut,
          label: defaultShortcut.label,
          description: defaultShortcut.description,
          category: defaultShortcut.category
        };
      });
      const usedKeys = new Set(merged.map((shortcut) => shortcut.keys).filter(Boolean));
      const newDefaults = exports2.DEFAULT_SHORTCUTS.filter((shortcut) => !savedIds.has(shortcut.id)).map((shortcut) => {
        if (!shortcut.keys || !usedKeys.has(shortcut.keys)) {
          usedKeys.add(shortcut.keys);
          return shortcut;
        }
        return { ...shortcut, keys: "" };
      });
      return [...merged, ...newDefaults];
    }
    exports2.TERMINAL_SCROLLBACK_MIN_LINES = 1e3;
    exports2.TERMINAL_SCROLLBACK_MAX_LINES = 5e3;
    exports2.DEFAULT_TERMINAL_SCROLLBACK_LINES = exports2.TERMINAL_SCROLLBACK_MAX_LINES;
    function clampTerminalScrollback(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return exports2.DEFAULT_TERMINAL_SCROLLBACK_LINES;
      }
      return Math.min(exports2.TERMINAL_SCROLLBACK_MAX_LINES, Math.max(exports2.TERMINAL_SCROLLBACK_MIN_LINES, Math.trunc(value)));
    }
    exports2.RECOMMENDED_HIDDEN_STARTUP_AGENTS = ["gemini"];
    exports2.DEFAULT_PREFERENCES = {
      workspace: {
        sidebarWidth: 220,
        sidebarCollapsed: false
      },
      ide: {
        aiDiffEnabled: false,
        // Default to 'syntax-only' so users opening cross-project files don't get
        // hammered by Monaco's project-unaware false positives (Cannot find module,
        // JSX element implicitly any, react/jsx-runtime missing, etc.). Users who
        // want full type-checking can opt into 'full' from Settings → IDE.
        // When the LSP runtime ships (docs/product/proposals/multi-language-lsp-support.md, Phase 4)
        // this default should be revisited — at that point 'full' becomes accurate
        // because a real typescript-language-server provides project-aware diagnostics.
        editorDiagnostics: "syntax-only",
        readerMode: {
          background: "sepia",
          font: "serif",
          fontSize: 18,
          contentWidth: 720,
          customBackground: "#2d2d3f",
          customText: "#e0e0e0",
          stickyNoteColor: "#93C5FD",
          stickyNoteFontFamily: '"Caveat", "Comic Sans MS", system-ui, sans-serif',
          stickyNoteFontSize: 13,
          stickyNoteWidth: 200,
          stickyNoteHeight: 200
        }
      },
      languages: {
        enabled: [],
        installPaths: {},
        installedVersions: {},
        autoStart: false,
        preferSystemBinaries: true,
        diagnosticsEnabled: true
      },
      appearance: {
        theme: "dark",
        terminalFontFamily: "JetBrainsMono Nerd Font",
        terminalFontSize: 13,
        terminalLineHeight: 1.2,
        unfocusedTerminalOpacity: 0.6,
        terminalScrollbar: "auto",
        customFonts: [],
        uiScale: 1,
        agentInputFontOverride: false
      },
      behavior: {
        defaultEditor: "code",
        terminalScrollback: exports2.DEFAULT_TERMINAL_SCROLLBACK_LINES,
        copyOnSelect: true,
        restoreSession: true,
        showHiddenFiles: true,
        respectGitignore: false,
        quickOpenSearchAllProjects: false,
        notifyOnCommandFinish: true,
        notifyOnCommandFinishAfter: 10,
        notifyOnAgentIdle: true,
        notifyOnAgentIdleAfter: 15,
        playNotificationSound: true,
        fileOpenMode: "normal"
      },
      defaults: {
        terminalType: "bash",
        outputPanelMode: "http",
        browserUrlTemplate: "https://1devtool.com/"
      },
      browser: {
        persistState: true
      },
      terminal: {
        showRunTimer: true,
        tmuxMouseBehavior: "native-selection",
        hiddenLayouts: [],
        activityLogEnabled: true,
        activityLogFileExtensions: [".md"],
        activityLogAutoDismissSeconds: 300,
        funAnimation: "none",
        sidebarHoverPreview: true,
        showSubAgentBadges: true,
        showMcpToolBadges: true,
        showAgentInputComposer: true,
        dashboardPollSeconds: 10,
        localTerminalAttachCli: false
      },
      git: {
        accounts: [],
        activeAccountId: null
      },
      draw: {},
      ssh: {
        connections: [],
        scanPaths: []
      },
      startupCommands: {
        customPresets: [],
        hiddenAgents: [...exports2.RECOMMENDED_HIDDEN_STARTUP_AGENTS]
      },
      aiAgentPaths: {},
      shortcuts: exports2.DEFAULT_SHORTCUTS,
      updates: {
        skippedVersion: null,
        autoDownload: true,
        autoInstallOnQuit: true,
        notify: "pill",
        checkIntervalHours: 6
      },
      privacy: {
        analyticsEnabled: true,
        consentShown: false
      },
      onboarding: {
        firstLaunchVersion: null,
        firstLaunchAt: null,
        completedSteps: [],
        dismissedSteps: [],
        welcomeDismissed: false,
        checklistDismissed: false
      },
      system: {
        extraPathEntries: [],
        mcpNodePath: ""
      },
      orchestration: {
        draft: {
          assignments: {},
          customCategories: [],
          mode: "on-generic-delegate",
          defaultSubstrate: "auto",
          updatedAt: 0
        },
        applied: null
      },
      orchestrationSetups: {
        presets: []
      }
    };
    exports2.PROJECT_COLORS = [
      "#EF4444",
      // red
      "#F97316",
      // orange
      "#F59E0B",
      // amber
      "#EAB308",
      // yellow
      "#84CC16",
      // lime
      "#22C55E",
      // green
      "#10B981",
      // emerald
      "#14B8A6",
      // teal
      "#06B6D4",
      // cyan
      "#0EA5E9",
      // sky
      "#3B82F6",
      // blue
      "#6366F1",
      // indigo
      "#8B5CF6",
      // violet
      "#A855F7",
      // purple
      "#D946EF",
      // fuchsia
      "#EC4899"
      // pink
    ];
  }
});

// dist/main/shared/orchestration/teamMessages.js
var require_teamMessages = __commonJS({
  "dist/main/shared/orchestration/teamMessages.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.TEAM_MESSAGE_MAX_HOPS = exports2.TEAM_MESSAGE_MAX_IN_FLIGHT = exports2.TEAM_MESSAGE_MAX_PER_TEAM = exports2.TEAM_MESSAGE_MAX_BODY_CHARS = exports2.TEAM_READ_PERMISSIONS = void 0;
    exports2.isTeamReadPermission = isTeamReadPermission;
    exports2.teamConnectionKey = teamConnectionKey;
    exports2.isTeamMessageTerminal = isTeamMessageTerminal;
    exports2.TEAM_READ_PERMISSIONS = [
      "read-transcript",
      "read-transcript-full",
      "read-screen",
      "read-artifact"
    ];
    function isTeamReadPermission(permission) {
      return exports2.TEAM_READ_PERMISSIONS.includes(permission);
    }
    exports2.TEAM_MESSAGE_MAX_BODY_CHARS = 64e3;
    exports2.TEAM_MESSAGE_MAX_PER_TEAM = 2e3;
    exports2.TEAM_MESSAGE_MAX_IN_FLIGHT = 32;
    exports2.TEAM_MESSAGE_MAX_HOPS = 8;
    function teamConnectionKey(connection) {
      return `${connection.fromMemberId}\0${connection.toMemberId}`;
    }
    function isTeamMessageTerminal(state) {
      return state === "answered" || state === "failed" || state === "cancelled";
    }
  }
});

// dist/main/shared/orchestration/hierarchy.js
var require_hierarchy = __commonJS({
  "dist/main/shared/orchestration/hierarchy.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.EFFECTIVE_TO_HEADLESS_AGENT_KIND = exports2.MAX_PIPELINE_STAGES = exports2.MAX_PIPELINE_GATE_ROUNDS = exports2.MIN_PIPELINE_GATE_ROUNDS = exports2.DEFAULT_PIPELINE_GATE_ROUNDS = exports2.DEFAULT_HIERARCHY_CHAIN_DEPTH = exports2.HIERARCHY_QUALITY_GATE_MAX_CHARS = exports2.HIERARCHY_BRIEF_MAX_CHARS = exports2.HIERARCHY_LABEL_MAX_CHARS = exports2.HIERARCHY_NODE_ID_RE = exports2.MAX_HIERARCHY_EDGES = exports2.MAX_HIERARCHY_NODES = void 0;
    exports2.hierarchyManagesEdges = hierarchyManagesEdges;
    exports2.hierarchyDirectManagers = hierarchyDirectManagers;
    exports2.hierarchyDirectSubordinates = hierarchyDirectSubordinates;
    exports2.hierarchySkipLevelTargets = hierarchySkipLevelTargets;
    exports2.hierarchyRootIds = hierarchyRootIds;
    exports2.hierarchyIsManagesAncestor = hierarchyIsManagesAncestor;
    exports2.findHierarchyNode = findHierarchyNode;
    exports2.deriveHierarchyTiers = deriveHierarchyTiers;
    exports2.hierarchyChartDepth = hierarchyChartDepth;
    exports2.hierarchyChartHasStructure = hierarchyChartHasStructure;
    exports2.headlessAgentKindForEffectiveKind = headlessAgentKindForEffectiveKind;
    exports2.hierarchyNodeRole = hierarchyNodeRole;
    exports2.hierarchyTaskSourceIds = hierarchyTaskSourceIds;
    exports2.emptyHierarchyChart = emptyHierarchyChart;
    exports2.normalizeHierarchyChart = normalizeHierarchyChart;
    exports2.canonicalHierarchyProjection = canonicalHierarchyProjection;
    var headlessMode_12 = require_headlessMode();
    var agentModels_12 = require_agentModels();
    var orchestrationPolicy_1 = require_orchestrationPolicy();
    var teamMessages_1 = require_teamMessages();
    exports2.MAX_HIERARCHY_NODES = 12;
    exports2.MAX_HIERARCHY_EDGES = 24;
    exports2.HIERARCHY_NODE_ID_RE = /^[a-z][a-z0-9-]{1,23}$/;
    exports2.HIERARCHY_LABEL_MAX_CHARS = 40;
    exports2.HIERARCHY_BRIEF_MAX_CHARS = 200;
    exports2.HIERARCHY_QUALITY_GATE_MAX_CHARS = 160;
    exports2.DEFAULT_HIERARCHY_CHAIN_DEPTH = 5;
    exports2.DEFAULT_PIPELINE_GATE_ROUNDS = 2;
    exports2.MIN_PIPELINE_GATE_ROUNDS = 1;
    exports2.MAX_PIPELINE_GATE_ROUNDS = 4;
    exports2.MAX_PIPELINE_STAGES = Math.min(exports2.MAX_HIERARCHY_NODES, teamMessages_1.TEAM_MESSAGE_MAX_HOPS + 1);
    function hierarchyManagesEdges(chart) {
      return chart.edges.filter((edge) => edge.kind === "manages");
    }
    function hierarchyDirectManagers(chart, nodeId) {
      return hierarchyManagesEdges(chart).filter((edge) => edge.to === nodeId).map((edge) => edge.from);
    }
    function hierarchyDirectSubordinates(chart, nodeId) {
      return hierarchyManagesEdges(chart).filter((edge) => edge.from === nodeId).map((edge) => edge.to);
    }
    function hierarchySkipLevelTargets(chart, nodeId) {
      return chart.edges.filter((edge) => edge.kind === "skip-level" && edge.from === nodeId).map((edge) => edge.to);
    }
    function hierarchyRootIds(chart) {
      const managed = new Set(hierarchyManagesEdges(chart).map((edge) => edge.to));
      return chart.nodes.map((node) => node.nodeId).filter((nodeId) => !managed.has(nodeId));
    }
    function hierarchyIsManagesAncestor(chart, ancestorId, nodeId) {
      if (ancestorId === nodeId)
        return false;
      const queue = [ancestorId];
      const visited = /* @__PURE__ */ new Set();
      while (queue.length > 0) {
        const current = queue.shift();
        if (visited.has(current))
          continue;
        visited.add(current);
        for (const next of hierarchyDirectSubordinates(chart, current)) {
          if (next === nodeId)
            return true;
          queue.push(next);
        }
      }
      return false;
    }
    function findHierarchyNode(chart, nodeId) {
      return chart.nodes.find((node) => node.nodeId === nodeId);
    }
    function deriveHierarchyTiers(chart) {
      const tiers = {};
      const indegree = /* @__PURE__ */ new Map();
      for (const node of chart.nodes)
        indegree.set(node.nodeId, 0);
      for (const edge of hierarchyManagesEdges(chart)) {
        if (!indegree.has(edge.from) || !indegree.has(edge.to))
          continue;
        indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
      }
      const queue = [...indegree.entries()].filter(([, count]) => count === 0).map(([nodeId]) => nodeId);
      for (const nodeId of queue)
        tiers[nodeId] = 0;
      while (queue.length > 0) {
        const current = queue.shift();
        for (const next of hierarchyDirectSubordinates(chart, current)) {
          if (!indegree.has(next))
            continue;
          tiers[next] = Math.max(tiers[next] ?? 0, (tiers[current] ?? 0) + 1);
          const remaining = (indegree.get(next) ?? 0) - 1;
          indegree.set(next, remaining);
          if (remaining === 0)
            queue.push(next);
        }
      }
      return tiers;
    }
    function hierarchyChartDepth(chart) {
      return Object.values(deriveHierarchyTiers(chart)).reduce((max, tier) => Math.max(max, tier), 0);
    }
    function hierarchyChartHasStructure(chart) {
      return !!chart && chart.nodes.length >= 2 && hierarchyManagesEdges(chart).length >= 1;
    }
    exports2.EFFECTIVE_TO_HEADLESS_AGENT_KIND = {
      "claude-command": "claude",
      antigravity: "agy"
    };
    function headlessAgentKindForEffectiveKind(effectiveAgentKind) {
      return exports2.EFFECTIVE_TO_HEADLESS_AGENT_KIND[effectiveAgentKind] ?? effectiveAgentKind;
    }
    function hierarchyNodeRole(chart, nodeId) {
      const isRoot = hierarchyDirectManagers(chart, nodeId).length === 0;
      if (isRoot)
        return "director";
      return hierarchyDirectSubordinates(chart, nodeId).length > 0 ? "manager" : "worker";
    }
    function hierarchyTaskSourceIds(chart, nodeId) {
      const sources = new Set(hierarchyDirectManagers(chart, nodeId));
      for (const edge of chart.edges) {
        if (edge.kind === "skip-level" && edge.to === nodeId)
          sources.add(edge.from);
      }
      return [...sources];
    }
    function findManagesCycle(chart) {
      const WHITE = 0;
      const GRAY = 1;
      const BLACK = 2;
      const color = /* @__PURE__ */ new Map();
      for (const node of chart.nodes)
        color.set(node.nodeId, WHITE);
      const stack = [];
      let cycle = null;
      const visit = (nodeId) => {
        color.set(nodeId, GRAY);
        stack.push(nodeId);
        for (const next of hierarchyDirectSubordinates(chart, nodeId)) {
          if (!color.has(next))
            continue;
          if (color.get(next) === GRAY) {
            const start = stack.indexOf(next);
            cycle = [...stack.slice(start), next];
            return true;
          }
          if (color.get(next) === WHITE && visit(next))
            return true;
        }
        stack.pop();
        color.set(nodeId, BLACK);
        return false;
      };
      for (const node of chart.nodes) {
        if (color.get(node.nodeId) === WHITE && visit(node.nodeId))
          return cycle;
      }
      return null;
    }
    function emptyHierarchyChart() {
      return {
        chartId: "default",
        name: "default",
        nodes: [],
        edges: [],
        maxChainDepth: exports2.DEFAULT_HIERARCHY_CHAIN_DEPTH,
        updatedAt: 0
      };
    }
    function normalizeSelector(raw, where, errors) {
      const src = raw && typeof raw === "object" ? raw : {};
      const agentKind = typeof src.agentKind === "string" ? src.agentKind.trim() : "";
      if (!agentKind) {
        errors.push(`${where}: selector needs an agentKind`);
        return null;
      }
      if (!Object.keys(headlessMode_12.HEADLESS_SPECS).includes(agentKind)) {
        errors.push(`${where}: unknown agent "${agentKind}"`);
        return null;
      }
      const selector = { agentKind };
      if (typeof src.model === "string" && src.model.trim()) {
        const model = src.model.trim();
        if (!agentModels_12.AGENT_MODEL_SPECS[agentKind]) {
          errors.push(`${where}: agent "${agentKind}" does not support a model \u2014 clear the model field`);
        } else if (!(0, agentModels_12.isValidModelId)(model)) {
          errors.push(`${where}: "${model}" is not a valid model id`);
        } else {
          selector.model = model;
        }
      }
      return selector;
    }
    function normalizeHierarchyChart(raw) {
      const errors = [];
      const src = raw && typeof raw === "object" ? raw : {};
      const pipelineTopology = src.topology === "pipeline";
      const nodes = [];
      const seenIds = /* @__PURE__ */ new Set();
      const srcNodes = Array.isArray(src.nodes) ? src.nodes : [];
      if (srcNodes.length > exports2.MAX_HIERARCHY_NODES) {
        errors.push(`too many nodes (max ${exports2.MAX_HIERARCHY_NODES})`);
      }
      for (const rawNode of srcNodes.slice(0, exports2.MAX_HIERARCHY_NODES)) {
        if (!rawNode || typeof rawNode !== "object")
          continue;
        const n = rawNode;
        const nodeId = typeof n.nodeId === "string" ? n.nodeId : "";
        if (!exports2.HIERARCHY_NODE_ID_RE.test(nodeId)) {
          errors.push(`node id "${nodeId}" must match ^[a-z][a-z0-9-]{1,23}$`);
          continue;
        }
        if (seenIds.has(nodeId)) {
          errors.push(`node id "${nodeId}" is duplicated`);
          continue;
        }
        const selector = normalizeSelector(n.selector, `node "${nodeId}"`, errors);
        if (!selector)
          continue;
        seenIds.add(nodeId);
        const label = (0, orchestrationPolicy_1.sanitizeRoutingText)(typeof n.label === "string" ? n.label : "", exports2.HIERARCHY_LABEL_MAX_CHARS);
        const brief = typeof n.brief === "string" ? (0, orchestrationPolicy_1.sanitizeRoutingText)(n.brief, exports2.HIERARCHY_BRIEF_MAX_CHARS) : "";
        const qualityGate = typeof n.qualityGate === "string" ? (0, orchestrationPolicy_1.sanitizeRoutingText)(n.qualityGate, exports2.HIERARCHY_QUALITY_GATE_MAX_CHARS) : "";
        const reportsTo = typeof n.reportsTo === "string" && n.reportsTo.trim() ? n.reportsTo.trim() : void 0;
        nodes.push({
          nodeId,
          label: label || nodeId,
          selector,
          ...reportsTo ? { reportsTo } : {},
          ...brief ? { brief } : {},
          ...n.suppressReport === true ? { suppressReport: true } : {},
          ...pipelineTopology && qualityGate ? { qualityGate } : {}
        });
      }
      const edges = [];
      const seenEdges = /* @__PURE__ */ new Set();
      const srcEdges = Array.isArray(src.edges) ? src.edges : [];
      if (srcEdges.length > exports2.MAX_HIERARCHY_EDGES) {
        errors.push(`too many edges (max ${exports2.MAX_HIERARCHY_EDGES})`);
      }
      for (const rawEdge of srcEdges.slice(0, exports2.MAX_HIERARCHY_EDGES)) {
        if (!rawEdge || typeof rawEdge !== "object")
          continue;
        const e = rawEdge;
        const from = typeof e.from === "string" ? e.from : "";
        const to = typeof e.to === "string" ? e.to : "";
        const kind = e.kind;
        if (kind !== "manages" && kind !== "skip-level") {
          errors.push(`edge ${from || "?"} \u2192 ${to || "?"}: unknown kind "${String(kind)}"`);
          continue;
        }
        if (!seenIds.has(from) || !seenIds.has(to)) {
          errors.push(`edge ${from || "?"} \u2192 ${to || "?"}: both ends must be chart nodes`);
          continue;
        }
        if (from === to) {
          errors.push(`edge ${from} \u2192 ${to}: a node cannot manage itself`);
          continue;
        }
        const key = `${from}\0${to}\0${kind}`;
        if (seenEdges.has(key)) {
          errors.push(`edge ${from} \u2192 ${to} (${kind}) is duplicated`);
          continue;
        }
        seenEdges.add(key);
        edges.push({ from, to, kind });
      }
      const draft = {
        chartId: typeof src.chartId === "string" && src.chartId.trim() ? src.chartId.trim() : "default",
        name: (0, orchestrationPolicy_1.sanitizeRoutingText)(typeof src.name === "string" ? src.name : "", exports2.HIERARCHY_LABEL_MAX_CHARS) || "default",
        nodes,
        edges,
        maxChainDepth: exports2.DEFAULT_HIERARCHY_CHAIN_DEPTH,
        updatedAt: typeof src.updatedAt === "number" && Number.isFinite(src.updatedAt) ? src.updatedAt : 0,
        ...pipelineTopology ? { topology: "pipeline" } : {}
      };
      const cycle = findManagesCycle(draft);
      if (cycle) {
        errors.push(`hierarchy contains a cycle: ${cycle.join(" \u2192 ")}`);
      }
      const tiers = cycle ? {} : deriveHierarchyTiers(draft);
      for (const node of draft.nodes) {
        const managers = hierarchyDirectManagers(draft, node.nodeId);
        if (managers.length === 0) {
          if (node.reportsTo) {
            errors.push(`root node "${node.nodeId}" reports to the human \u2014 remove reportsTo`);
            delete node.reportsTo;
          }
          continue;
        }
        if (!node.reportsTo) {
          if (managers.length === 1) {
            node.reportsTo = managers[0];
          } else {
            errors.push(`node "${node.nodeId}" has several managers (${managers.join(", ")}) \u2014 pick one reportsTo`);
          }
          continue;
        }
        if (!managers.includes(node.reportsTo)) {
          errors.push(`node "${node.nodeId}" reportsTo "${node.reportsTo}" is not one of its direct managers (${managers.join(", ")})`);
        }
      }
      for (const edge of draft.edges) {
        if (edge.kind !== "skip-level")
          continue;
        if (seenEdges.has(`${edge.from}\0${edge.to}\0manages`)) {
          errors.push(`skip-level ${edge.from} \u2192 ${edge.to} duplicates a manages edge \u2014 a direct manager needs no skip-level`);
          continue;
        }
        if (!cycle && !hierarchyIsManagesAncestor(draft, edge.from, edge.to)) {
          errors.push(`skip-level ${edge.from} \u2192 ${edge.to}: "${edge.from}" is not an ancestor of "${edge.to}" through manages edges`);
        }
      }
      let maxChainDepth = exports2.DEFAULT_HIERARCHY_CHAIN_DEPTH;
      if (!pipelineTopology) {
        const rawDepth = src.maxChainDepth;
        if (rawDepth !== void 0) {
          if (typeof rawDepth !== "number" || !Number.isInteger(rawDepth) || rawDepth < 1) {
            errors.push("maxChainDepth must be a positive integer");
          } else if (rawDepth > teamMessages_1.TEAM_MESSAGE_MAX_HOPS) {
            errors.push(`maxChainDepth must be \u2264 ${teamMessages_1.TEAM_MESSAGE_MAX_HOPS}`);
          } else {
            maxChainDepth = rawDepth;
          }
        }
      }
      const depth = cycle ? 0 : hierarchyChartDepth(draft);
      if (draft.topology !== "pipeline" && maxChainDepth < depth) {
        errors.push(`maxChainDepth ${maxChainDepth} is below the chart depth ${depth} \u2014 the bottom tier could never be tasked`);
      }
      draft.maxChainDepth = maxChainDepth;
      if (draft.topology === "pipeline") {
        if (draft.nodes.length < 2)
          errors.push("pipeline needs at least two stages");
        if (draft.nodes.length > exports2.MAX_PIPELINE_STAGES) {
          errors.push(`pipeline has too many stages (max ${exports2.MAX_PIPELINE_STAGES})`);
        }
        if (draft.edges.some((edge) => edge.kind !== "manages")) {
          errors.push("pipeline may contain only adjacent manages edges");
        }
        const manages = hierarchyManagesEdges(draft);
        if (manages.length !== Math.max(0, draft.nodes.length - 1)) {
          errors.push("pipeline stages must form one connected linear chain");
        }
        for (const node of draft.nodes) {
          if (hierarchyDirectManagers(draft, node.nodeId).length > 1 || hierarchyDirectSubordinates(draft, node.nodeId).length > 1) {
            errors.push(`pipeline stage "${node.nodeId}" branches; stages must be linear`);
          }
          if (node.suppressReport) {
            errors.push(`pipeline stage "${node.nodeId}" cannot suppress its handoff`);
            delete node.suppressReport;
          }
        }
        const roots = hierarchyRootIds(draft);
        const leaves = draft.nodes.filter((node) => hierarchyDirectSubordinates(draft, node.nodeId).length === 0);
        if (draft.nodes.length > 0 && (roots.length !== 1 || leaves.length !== 1)) {
          errors.push("pipeline must have one first stage and one final stage");
        }
        const finalNode = roots.length === 1 ? findHierarchyNode(draft, roots[0]) : void 0;
        if (finalNode?.qualityGate) {
          errors.push(`final pipeline stage "${finalNode.nodeId}" cannot define a quality gate`);
          delete finalNode.qualityGate;
        }
        const rawRounds = src.maxGateRounds;
        let maxGateRounds = exports2.DEFAULT_PIPELINE_GATE_ROUNDS;
        if (rawRounds !== void 0) {
          if (typeof rawRounds !== "number" || !Number.isInteger(rawRounds) || rawRounds < exports2.MIN_PIPELINE_GATE_ROUNDS || rawRounds > exports2.MAX_PIPELINE_GATE_ROUNDS) {
            errors.push(`maxGateRounds must be an integer from ${exports2.MIN_PIPELINE_GATE_ROUNDS} to ${exports2.MAX_PIPELINE_GATE_ROUNDS}`);
          } else {
            maxGateRounds = rawRounds;
          }
        }
        draft.maxGateRounds = maxGateRounds;
        draft.maxChainDepth = Math.max(1, draft.nodes.length - 1);
      }
      return { normalized: draft, errors, tiers };
    }
    function canonicalHierarchyProjection(chart) {
      if (!chart || chart.nodes.length === 0)
        return null;
      return {
        chartId: chart.chartId,
        name: chart.name,
        maxChainDepth: chart.maxChainDepth,
        nodes: [...chart.nodes].sort((a, b) => a.nodeId.localeCompare(b.nodeId)).map((node) => [
          node.nodeId,
          node.label,
          node.selector.agentKind,
          node.selector.model ?? "",
          node.reportsTo ?? "",
          node.brief ?? "",
          // Appended only when set so every pre-existing chart keeps its hash.
          ...node.suppressReport ? ["no-report"] : [],
          ...node.qualityGate ? ["gate", node.qualityGate] : []
        ]),
        edges: [...chart.edges].sort((a, b) => `${a.from}\0${a.to}\0${a.kind}`.localeCompare(`${b.from}\0${b.to}\0${b.kind}`)).map((edge) => [edge.from, edge.to, edge.kind]),
        ...chart.topology === "pipeline" ? {
          topology: "pipeline",
          maxGateRounds: chart.maxGateRounds ?? exports2.DEFAULT_PIPELINE_GATE_ROUNDS
        } : {}
      };
    }
  }
});

// dist/main/shared/orchestrationPolicy.js
var require_orchestrationPolicy = __commonJS({
  "dist/main/shared/orchestrationPolicy.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.ROUTING_MODES = exports2.CUSTOM_INSTRUCTIONS_MAX_BYTES = exports2.ROUTING_SECTION_MAX_BYTES = exports2.ROUTING_LABEL_MAX_CHARS = exports2.ROUTING_NOTES_MAX_CHARS = exports2.CUSTOM_CATEGORY_ID_RE = exports2.MAX_CUSTOM_CATEGORIES = exports2.INTRINSIC_TERMINAL_SKILLS = exports2.ORCHESTRATION_SKILL_COMMAND_RE = exports2.ORCHESTRATION_SUBSTRATES = exports2.ROUTED_TASK_FAILURE_RULE = exports2.ROUTED_TASK_OWNERSHIP_RULE = exports2.ROUTING_CATEGORIES = void 0;
    exports2.utf8ByteLength = utf8ByteLength;
    exports2.sanitizeRoutingText = sanitizeRoutingText;
    exports2.sanitizeCustomInstructions = sanitizeCustomInstructions;
    exports2.emptyPolicyDraft = emptyPolicyDraft;
    exports2.defaultOrchestrationPolicyState = defaultOrchestrationPolicyState;
    exports2.normalizePolicyDraft = normalizePolicyDraft;
    exports2.normalizeOrchestrationPolicyState = normalizeOrchestrationPolicyState;
    exports2.enabledRoutingRows = enabledRoutingRows;
    exports2.resolveRoutingSubstrate = resolveRoutingSubstrate;
    exports2.hasActiveRouting = hasActiveRouting;
    exports2.canonicalPolicyHash = canonicalPolicyHash;
    var headlessMode_12 = require_headlessMode();
    var agentModels_12 = require_agentModels();
    var orchestrationCategory_1 = require_orchestrationCategory();
    var hierarchy_1 = require_hierarchy();
    function utf8ByteLength(text) {
      return new TextEncoder().encode(text).length;
    }
    exports2.ROUTING_CATEGORIES = [
      "plan",
      "implement",
      "test",
      "review",
      "browser",
      "docs",
      "research",
      "debug"
    ];
    exports2.ROUTED_TASK_OWNERSHIP_RULE = "Routing does not begin until the user authorizes delegation. Once authorized, enabled assignments are exclusive task ownership, not soft preferences. A host that is not the assigned agent must not perform that part with its own tools or send it to another agent.";
    exports2.ROUTED_TASK_FAILURE_RULE = "Routing remains binding after delegation. If the assigned agent is unavailable or cannot complete its assigned part for any reason\u2014including a missing agent, a failed or timed-out call, refusal, an incomplete result, or a report that a required tool or capability is unavailable\u2014do not reclaim that part, use your own tools, or silently reroute it, even if you have the needed capability. Stop and ask the user how to proceed unless the user already explicitly authorized fallback for that part.";
    exports2.ORCHESTRATION_SUBSTRATES = ["auto", "headless", "terminal"];
    exports2.ORCHESTRATION_SKILL_COMMAND_RE = /^\/[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/;
    exports2.INTRINSIC_TERMINAL_SKILLS = {
      browser: "/chrome"
    };
    exports2.MAX_CUSTOM_CATEGORIES = 8;
    exports2.CUSTOM_CATEGORY_ID_RE = orchestrationCategory_1.ORCHESTRATION_CATEGORY_RE;
    exports2.ROUTING_NOTES_MAX_CHARS = 120;
    exports2.ROUTING_LABEL_MAX_CHARS = 40;
    exports2.ROUTING_SECTION_MAX_BYTES = 8 * 1024;
    exports2.CUSTOM_INSTRUCTIONS_MAX_BYTES = 2 * 1024;
    exports2.ROUTING_MODES = ["on-generic-delegate", "suggest"];
    function sanitizeRoutingText(text, maxChars) {
      return text.replace(/[\u0000-\u001F\u007F|]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxChars).trim();
    }
    function sanitizeCustomInstructions(text) {
      let out = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<!--/g, "").replace(/-->/g, "").split("\n").map((line) => /^\s*---+\s*$/.test(line) ? "" : line).join("\n").replace(/\r/g, "").trim();
      while (utf8ByteLength(out) > exports2.CUSTOM_INSTRUCTIONS_MAX_BYTES) {
        out = out.slice(0, -1);
      }
      return out.trim();
    }
    function emptyPolicyDraft() {
      return {
        assignments: {},
        customCategories: [],
        mode: "on-generic-delegate",
        defaultSubstrate: "auto",
        updatedAt: 0
      };
    }
    function defaultOrchestrationPolicyState() {
      return { draft: emptyPolicyDraft(), applied: null };
    }
    function normalizeAssignment(raw, where, errors, categoryId) {
      if (!raw || typeof raw !== "object")
        return null;
      const a = raw;
      if (typeof a.agent !== "string" || !a.agent)
        return null;
      if (!Object.keys(headlessMode_12.HEADLESS_SPECS).includes(a.agent)) {
        errors.push(`${where}: unknown agent "${a.agent}"`);
        return null;
      }
      const out = {
        agent: a.agent,
        enabled: a.enabled === true
      };
      if (typeof a.model === "string" && a.model.trim()) {
        const model = a.model.trim();
        if (!agentModels_12.AGENT_MODEL_SPECS[a.agent]) {
          errors.push(`${where}: agent "${a.agent}" does not support a model \u2014 clear the model field`);
        } else if (!(0, agentModels_12.isValidModelId)(model)) {
          errors.push(`${where}: "${model}" is not a valid model id`);
        } else {
          out.model = model;
        }
      }
      if (typeof a.notes === "string") {
        const notes = sanitizeRoutingText(a.notes, exports2.ROUTING_NOTES_MAX_CHARS);
        if (notes)
          out.notes = notes;
      }
      if (a.substrate !== void 0) {
        if (!exports2.ORCHESTRATION_SUBSTRATES.includes(a.substrate)) {
          errors.push(`${where}: substrate must be auto, headless, or terminal`);
        } else {
          out.substrate = a.substrate;
        }
      }
      if (typeof a.skill === "string" && a.skill.trim()) {
        const skill = a.skill.trim();
        if (!exports2.ORCHESTRATION_SKILL_COMMAND_RE.test(skill)) {
          errors.push(`${where}: skill must be a slash command such as /chrome`);
        } else if (out.substrate !== "terminal") {
          errors.push(`${where}: a skill requires substrate "terminal"`);
        } else {
          out.skill = skill;
        }
      }
      const intrinsicSkill = categoryId ? exports2.INTRINSIC_TERMINAL_SKILLS[categoryId] : void 0;
      if (intrinsicSkill && out.substrate === "headless") {
        errors.push(`${where}: ${categoryId} requires ${intrinsicSkill} in a real terminal`);
      }
      return out;
    }
    function normalizePolicyDraft(raw) {
      const errors = [];
      const src = raw && typeof raw === "object" ? raw : {};
      const assignments = {};
      const srcAssignments = src.assignments && typeof src.assignments === "object" ? src.assignments : {};
      for (const category of exports2.ROUTING_CATEGORIES) {
        const normalized2 = normalizeAssignment(srcAssignments[category], `category "${category}"`, errors, category);
        if (normalized2)
          assignments[category] = normalized2;
      }
      const customCategories = [];
      const seenIds = new Set(exports2.ROUTING_CATEGORIES);
      const srcCustoms = Array.isArray(src.customCategories) ? src.customCategories : [];
      if (srcCustoms.length > exports2.MAX_CUSTOM_CATEGORIES) {
        errors.push(`too many custom categories (max ${exports2.MAX_CUSTOM_CATEGORIES})`);
      }
      for (const rawCustom of srcCustoms.slice(0, exports2.MAX_CUSTOM_CATEGORIES)) {
        if (!rawCustom || typeof rawCustom !== "object")
          continue;
        const c = rawCustom;
        const id = typeof c.id === "string" ? c.id : "";
        if (!exports2.CUSTOM_CATEGORY_ID_RE.test(id)) {
          errors.push(`custom category id "${id}" must match ^[a-z][a-z0-9-]{1,23}$`);
          continue;
        }
        if (seenIds.has(id)) {
          errors.push(`custom category id "${id}" duplicates an existing category`);
          continue;
        }
        const assignment = normalizeAssignment(c, `custom category "${id}"`, errors, id);
        if (!assignment)
          continue;
        seenIds.add(id);
        const label = sanitizeRoutingText(typeof c.label === "string" ? c.label : "", exports2.ROUTING_LABEL_MAX_CHARS);
        customCategories.push({ id, label: label || id, ...assignment });
      }
      const mode = exports2.ROUTING_MODES.includes(src.mode) ? src.mode : "on-generic-delegate";
      const defaultSubstrate = exports2.ORCHESTRATION_SUBSTRATES.includes(src.defaultSubstrate) ? src.defaultSubstrate : "auto";
      const customInstructions = typeof src.customInstructions === "string" ? sanitizeCustomInstructions(src.customInstructions) : "";
      let hierarchy;
      if (src.hierarchy !== void 0 && src.hierarchy !== null) {
        const chart = (0, hierarchy_1.normalizeHierarchyChart)(src.hierarchy);
        errors.push(...chart.errors.map((entry) => `hierarchy: ${entry}`));
        if (chart.normalized.nodes.length > 0)
          hierarchy = chart.normalized;
      }
      const normalized = {
        assignments,
        customCategories,
        mode,
        defaultSubstrate,
        ...customInstructions ? { customInstructions } : {},
        ...hierarchy ? { hierarchy } : {},
        updatedAt: typeof src.updatedAt === "number" && Number.isFinite(src.updatedAt) ? src.updatedAt : 0
      };
      return { normalized, errors };
    }
    function normalizeOrchestrationPolicyState(raw) {
      const src = raw && typeof raw === "object" ? raw : {};
      const draft = normalizePolicyDraft(src.draft).normalized;
      const applied = src.applied ? normalizePolicyDraft(src.applied).normalized : null;
      const lastInstallResults = Array.isArray(src.lastInstallResults) ? src.lastInstallResults.filter((r) => !!r && typeof r === "object" && typeof r.target === "string" && typeof r.status === "string" && typeof r.at === "number") : void 0;
      return {
        draft,
        applied,
        ...typeof src.appliedAt === "number" ? { appliedAt: src.appliedAt } : {},
        ...typeof src.appliedPolicyHash === "string" ? { appliedPolicyHash: src.appliedPolicyHash } : {},
        ...lastInstallResults && lastInstallResults.length > 0 ? { lastInstallResults } : {}
      };
    }
    function enabledRoutingRows(policy) {
      const rows = [];
      for (const category of exports2.ROUTING_CATEGORIES) {
        const a = policy.assignments[category];
        if (a?.enabled && a.agent) {
          rows.push({
            id: category,
            label: category,
            agent: a.agent,
            model: a.model,
            notes: a.notes,
            substrate: resolveRoutingSubstrate(category, a, policy.defaultSubstrate),
            skill: a.skill ?? exports2.INTRINSIC_TERMINAL_SKILLS[category]
          });
        }
      }
      for (const custom of policy.customCategories) {
        if (custom.enabled && custom.agent) {
          rows.push({
            id: custom.id,
            label: custom.label || custom.id,
            agent: custom.agent,
            model: custom.model,
            notes: custom.notes,
            substrate: resolveRoutingSubstrate(custom.id, custom, policy.defaultSubstrate),
            skill: custom.skill ?? exports2.INTRINSIC_TERMINAL_SKILLS[custom.id]
          });
        }
      }
      return rows;
    }
    function resolveRoutingSubstrate(categoryId, assignment, defaultSubstrate = "auto") {
      if (assignment.skill || exports2.INTRINSIC_TERMINAL_SKILLS[categoryId])
        return "terminal";
      return assignment.substrate ?? defaultSubstrate;
    }
    function hasActiveRouting(policy) {
      return !!policy && enabledRoutingRows(policy).length > 0;
    }
    function canonicalPolicyHash(policy) {
      const hierarchy = (0, hierarchy_1.canonicalHierarchyProjection)(policy.hierarchy);
      const projection = {
        mode: policy.mode,
        defaultSubstrate: policy.defaultSubstrate,
        assignments: exports2.ROUTING_CATEGORIES.filter((c) => policy.assignments[c]).map((c) => {
          const a = policy.assignments[c];
          return [c, a.agent, a.model ?? "", a.notes ?? "", a.substrate ?? "", a.skill ?? "", a.enabled];
        }),
        customCategories: [...policy.customCategories].sort((a, b) => a.id.localeCompare(b.id)).map((c) => [c.id, c.label, c.agent, c.model ?? "", c.notes ?? "", c.substrate ?? "", c.skill ?? "", c.enabled]),
        customInstructions: policy.customInstructions ?? "",
        // Only when configured — a chart-less policy must hash exactly as it did
        // before v5, or every existing install reports skill drift on update.
        ...hierarchy ? { hierarchy } : {}
      };
      return fnv1a64(JSON.stringify(projection));
    }
    function fnv1a64(input) {
      let h = BigInt("14695981039346656037");
      const prime = BigInt("1099511628211");
      const mask = (BigInt(1) << BigInt(64)) - BigInt(1);
      for (let i = 0; i < input.length; i++) {
        h ^= BigInt(input.charCodeAt(i) & 65535);
        h = h * prime & mask;
      }
      return h.toString(16).padStart(16, "0");
    }
  }
});

// dist/main/shared/terminal/contracts.js
var require_contracts = __commonJS({
  "dist/main/shared/terminal/contracts.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.PI_OUTPUT_MARKERS = exports2.CURSOR_OUTPUT_MARKERS = exports2.ANTIGRAVITY_OUTPUT_MARKERS = exports2.HERMES_OUTPUT_MARKERS = exports2.GROK_OUTPUT_MARKERS = exports2.QWEN_OUTPUT_MARKERS = exports2.QODER_OUTPUT_MARKERS = exports2.CLINE_OUTPUT_MARKERS = exports2.OPENCODE_OUTPUT_MARKERS = exports2.AMP_OUTPUT_MARKERS = exports2.KIMI_OUTPUT_MARKERS = exports2.GEMINI_OUTPUT_MARKERS = exports2.CODEX_OUTPUT_MARKERS = exports2.CLAUDE_OUTPUT_MARKERS = exports2.CODEX_INLINE_MODE_FLAG = void 0;
    exports2.isNativeTuiAgentKind = isNativeTuiAgentKind;
    exports2.usesNativeTuiScroll = usesNativeTuiScroll;
    exports2.ensureCodexInlineMode = ensureCodexInlineMode;
    exports2.getDeclaredAgentKind = getDeclaredAgentKind;
    exports2.getAgentKindFromOutput = getAgentKindFromOutput;
    exports2.inferAgentKind = inferAgentKind;
    exports2.mapToResumeAgentType = mapToResumeAgentType;
    exports2.isInteractiveAgentType = isInteractiveAgentType;
    exports2.isInteractiveAgentCommand = isInteractiveAgentCommand;
    exports2.isInteractiveAgentTerminal = isInteractiveAgentTerminal;
    exports2.allowsTmux = allowsTmux;
    exports2.allowsSavedBufferRestore = allowsSavedBufferRestore;
    exports2.getAgentContinuityCapabilities = getAgentContinuityCapabilities;
    exports2.getTerminalProfile = getTerminalProfile;
    var INTERACTIVE_AGENT_EXECUTABLES = /* @__PURE__ */ new Set(["claude", "codex", "gemini", "kimi", "amp", "opencode", "cline", "qoder", "qwen", "grok", "hermes", "agy", "cursor-agent", "agent", "agents", "pi"]);
    exports2.CODEX_INLINE_MODE_FLAG = "--no-alt-screen";
    exports2.CLAUDE_OUTPUT_MARKERS = ["Claude Code", "What should Claude do instead?", "bypass permissions on"];
    exports2.CODEX_OUTPUT_MARKERS = ["OpenAI Codex", "Codex CLI"];
    exports2.GEMINI_OUTPUT_MARKERS = ["Gemini CLI"];
    exports2.KIMI_OUTPUT_MARKERS = ["Kimi Code"];
    exports2.AMP_OUTPUT_MARKERS = [" Amp ", "\nAmp\n", "\rAmp\r"];
    exports2.OPENCODE_OUTPUT_MARKERS = ["opencode", "OpenCode"];
    exports2.CLINE_OUTPUT_MARKERS = ["Cline"];
    exports2.QODER_OUTPUT_MARKERS = ["Qoder", "qoder"];
    exports2.QWEN_OUTPUT_MARKERS = ["Qwen Code", "qwen"];
    exports2.GROK_OUTPUT_MARKERS = ["Grok Build", "Grok CLI"];
    exports2.HERMES_OUTPUT_MARKERS = ["Hermes Agent", "\u2695 Hermes Agent"];
    exports2.ANTIGRAVITY_OUTPUT_MARKERS = ["Antigravity", "Models & Quota"];
    exports2.CURSOR_OUTPUT_MARKERS = ["Cursor Agent"];
    exports2.PI_OUTPUT_MARKERS = ["Pi can explain its own features", "ctrl+o to show full startup help"];
    function isNativeTuiAgentKind(kind) {
      return kind === "opencode" || kind === "cline" || kind === "grok" || kind === "hermes" || kind === "qwen";
    }
    function usesNativeTuiScroll(kind, isWindows) {
      return Boolean(kind) && (isNativeTuiAgentKind(kind) || isWindows && kind !== "codex" && kind !== "pi");
    }
    function ensureCodexInlineMode(command) {
      const trimmed = command?.trim();
      if (!trimmed)
        return trimmed;
      if (!/^codex(?:\s|$)/.test(trimmed))
        return trimmed;
      if (new RegExp(`(?:^|\\s)${exports2.CODEX_INLINE_MODE_FLAG}(?:\\s|$)`).test(trimmed))
        return trimmed;
      return trimmed.replace(/^codex(?:\s+|$)/, (match) => match.includes(" ") ? `codex ${exports2.CODEX_INLINE_MODE_FLAG} ` : `codex ${exports2.CODEX_INLINE_MODE_FLAG}`);
    }
    function getDeclaredAgentKind(agentType, command) {
      const executable = command?.trim().split(/\s+/)[0];
      if (executable === "claude") {
        return "claude-command";
      }
      if (executable === "codex") {
        return "codex";
      }
      if (executable === "gemini") {
        return "gemini";
      }
      if (executable === "kimi") {
        return "kimi";
      }
      if (executable === "agy") {
        return "antigravity";
      }
      if (executable === "amp") {
        return "amp";
      }
      if (executable === "opencode") {
        return "opencode";
      }
      if (executable === "cline") {
        return "cline";
      }
      if (executable === "qoder") {
        return "qoder";
      }
      if (executable === "qwen") {
        return "qwen";
      }
      if (executable === "grok") {
        return "grok";
      }
      if (executable === "hermes" || executable?.startsWith("hermes-")) {
        return "hermes";
      }
      if (executable === "cursor-agent" || executable === "agent" || executable === "agents") {
        return "cursor";
      }
      if (executable === "pi") {
        return "pi";
      }
      if (agentType === "claude")
        return "claude-command";
      if (agentType === "codex")
        return "codex";
      if (agentType === "gemini")
        return "gemini";
      if (agentType === "kimi")
        return "kimi";
      if (agentType === "agy")
        return "antigravity";
      if (agentType === "amp")
        return "amp";
      if (agentType === "opencode")
        return "opencode";
      if (agentType === "cline")
        return "cline";
      if (agentType === "qoder")
        return "qoder";
      if (agentType === "qwen")
        return "qwen";
      if (agentType === "grok")
        return "grok";
      if (agentType === "hermes")
        return "hermes";
      if (agentType === "cursor")
        return "cursor";
      if (agentType === "pi")
        return "pi";
      return null;
    }
    function getAgentKindFromOutput(strippedText) {
      if (!strippedText)
        return null;
      const text = strippedText.replace(/\r/g, "\n");
      if (exports2.CLAUDE_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return "claude-command";
      if (exports2.CODEX_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return "codex";
      if (exports2.GEMINI_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return "gemini";
      if (exports2.KIMI_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return "kimi";
      if (exports2.PI_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return "pi";
      if (exports2.AMP_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return "amp";
      if (exports2.OPENCODE_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return "opencode";
      if (exports2.CLINE_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return "cline";
      if (exports2.QODER_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return "qoder";
      if (exports2.QWEN_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return "qwen";
      if (exports2.GROK_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return "grok";
      if (exports2.HERMES_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return "hermes";
      if (exports2.ANTIGRAVITY_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return "antigravity";
      if (exports2.CURSOR_OUTPUT_MARKERS.some((marker) => text.includes(marker)))
        return "cursor";
      return null;
    }
    function inferAgentKind(agentType, command, strippedData) {
      return getDeclaredAgentKind(agentType, command) ?? getAgentKindFromOutput(strippedData);
    }
    function mapToResumeAgentType(agentType, command) {
      const kind = getDeclaredAgentKind(agentType, command);
      if (!kind)
        return null;
      switch (kind) {
        case "claude-command":
          return "claude";
        case "codex":
          return "codex";
        case "gemini":
          return "gemini";
        case "kimi":
          return "kimi";
        case "amp":
          return "amp";
        case "qwen":
          return "qwen";
        case "grok":
          return "grok";
        case "hermes":
          return "hermes";
        case "opencode":
          return "opencode";
        case "cline":
          return "cline";
        case "antigravity":
          return "agy";
        case "cursor":
          return "cursor";
        case "pi":
          return "pi";
        default:
          return null;
      }
    }
    function isInteractiveAgentType(agentType) {
      return agentType === "claude" || agentType === "codex" || agentType === "gemini" || agentType === "kimi" || agentType === "agy" || agentType === "amp" || agentType === "opencode" || agentType === "cline" || agentType === "qoder" || agentType === "qwen" || agentType === "grok" || agentType === "hermes" || agentType === "cursor" || agentType === "pi";
    }
    function isInteractiveAgentCommand(command) {
      const executable = command?.trim().split(/\s+/)[0];
      return Boolean(executable && (INTERACTIVE_AGENT_EXECUTABLES.has(executable) || executable.startsWith("hermes-")));
    }
    function isInteractiveAgentTerminal(agentType, command, forceAi) {
      return forceAi === true || isInteractiveAgentType(agentType) || isInteractiveAgentCommand(command);
    }
    function allowsTmux(agentType, command, forceAi) {
      return !isInteractiveAgentTerminal(agentType, command, forceAi);
    }
    function allowsSavedBufferRestore(agentType, command, forceAi) {
      return !forceAi && !getDeclaredAgentKind(agentType, command);
    }
    function getAgentContinuityCapabilities(agentType, command, forceAiAgent) {
      const kind = getDeclaredAgentKind(agentType, command);
      if (!kind && forceAiAgent)
        return { canDetectSession: false, canAutoResume: false, canRestoreTranscript: true };
      if (!kind)
        return { canDetectSession: false, canAutoResume: false, canRestoreTranscript: false };
      switch (kind) {
        case "claude-command":
          return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        case "codex":
          return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        case "amp":
          return { canDetectSession: false, canAutoResume: true, canRestoreTranscript: true };
        case "gemini":
          return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        case "kimi":
          return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        case "qwen":
          return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        case "cline":
          return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        case "grok":
          return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        case "hermes":
          return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        case "antigravity":
          return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        case "opencode":
          return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        case "cursor":
          return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        case "pi":
          return { canDetectSession: true, canAutoResume: true, canRestoreTranscript: true };
        default:
          return { canDetectSession: false, canAutoResume: false, canRestoreTranscript: true };
      }
    }
    function getTerminalProfile(agentType, command, forceAi) {
      const declaredKind = getDeclaredAgentKind(agentType, command);
      const interactive = forceAi === true || Boolean(declaredKind);
      return {
        kind: declaredKind ?? agentType ?? "bash",
        interactive,
        allowTmux: !interactive,
        allowSavedBufferRestore: !declaredKind,
        promptStrategy: interactive ? "interactive-draft-sync" : "plain-shell"
      };
    }
  }
});

// dist/main/shared/terminal/skillInvocation.js
var require_skillInvocation = __commonJS({
  "dist/main/shared/terminal/skillInvocation.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.getAgentSkillInvocationPrefix = getAgentSkillInvocationPrefix;
    exports2.formatAgentInvocation = formatAgentInvocation;
    exports2.formatAgentSkillInvocation = formatAgentSkillInvocation;
    function getAgentSkillInvocationPrefix(agentKind) {
      if (agentKind === "codex")
        return "$";
      if (agentKind === "kimi")
        return "/skill:";
      return "/";
    }
    function formatAgentInvocation(name, prefix) {
      return `${prefix}${name.trim().replace(/^[$/]/, "")} `;
    }
    function formatAgentSkillInvocation(skillName, agentKind) {
      return formatAgentInvocation(skillName, getAgentSkillInvocationPrefix(agentKind));
    }
  }
});

// dist/main/shared/interactiveDelegation.js
var require_interactiveDelegation = __commonJS({
  "dist/main/shared/interactiveDelegation.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.INTERACTIVE_SKILL_COMMAND_RE = exports2.INTERACTIVE_DELEGATION_PROMPT_MAX_CHARS = exports2.SUBSTRATE_DECISION_RULE = exports2.BROWSER_INTERACTIVE_ROUTING_RULE = exports2.DEFAULT_BROWSER_SKILL_COMMAND = exports2.BROWSER_ROUTING_CATEGORY = void 0;
    exports2.composeFullPermissionNudge = composeFullPermissionNudge;
    exports2.buildInteractiveAgentLaunchSpec = buildInteractiveAgentLaunchSpec;
    exports2.isValidInteractiveSkillCommand = isValidInteractiveSkillCommand;
    exports2.buildInteractiveDelegationPrompt = buildInteractiveDelegationPrompt;
    var types_1 = require_types();
    var agentModels_12 = require_agentModels();
    var orchestrationPolicy_1 = require_orchestrationPolicy();
    var contracts_1 = require_contracts();
    var skillInvocation_1 = require_skillInvocation();
    exports2.BROWSER_ROUTING_CATEGORY = "browser";
    exports2.DEFAULT_BROWSER_SKILL_COMMAND = "/chrome";
    exports2.BROWSER_INTERACTIVE_ROUTING_RULE = "Generic browser-category delegations that do not request the 1DevTool/onedevtool Browser MCP must add `--terminal --wait --skill=/chrome`. The CLI opens a visible 1DevTool terminal for the assigned agent, invokes its target-specific Chrome skill (`$chrome` in Codex, `/chrome` in other supported agents) with the routed task, and waits for the correlated result; never downgrade the browser task to headless execution.";
    exports2.SUBSTRATE_DECISION_RULE = "Choosing headless vs a real terminal: capability comes first. Use `--terminal --wait` whenever the work needs a slash skill, plugin/MCP tool, an approval the user must answer, or live steering. Use headless execution for a self-contained prompt-to-answer task. A required interactive capability must be reduced, batched, or refused when live capacity is full; it must never be silently downgraded.";
    exports2.INTERACTIVE_DELEGATION_PROMPT_MAX_CHARS = 1e5;
    exports2.INTERACTIVE_SKILL_COMMAND_RE = orchestrationPolicy_1.ORCHESTRATION_SKILL_COMMAND_RE;
    var NATIVE_INTERACTIVE_TARGETS = /* @__PURE__ */ new Set([
      "claude",
      "codex",
      "gemini",
      "kimi",
      "agy",
      "amp",
      "opencode",
      "cline",
      "qwen",
      "grok",
      "hermes",
      "cursor",
      "pi"
    ]);
    function composeFullPermissionNudge(target, startupCommand, defaultSpawnArgs) {
      const flag = defaultSpawnArgs?.[0];
      if (!flag || !flag.startsWith("-"))
        return "";
      const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(?:^|\\s)${escaped}(?:\\s|=|$)`).test(startupCommand ?? ""))
        return "";
      return ` \u2014 tip: for unattended delegation, launch ${target} with ${defaultSpawnArgs.join(" ")}`;
    }
    function shellQuoteArg(value) {
      if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value))
        return value;
      return `'${value.replace(/'/g, `'\\''`)}'`;
    }
    function buildInteractiveAgentLaunchSpec(target, model, category, defaultSpawnArgs = [], _isWindows = false) {
      const modelFlags = model ? (0, agentModels_12.buildModelFlags)(target, model) : [];
      if (model && !modelFlags)
        return null;
      const suffix = category ? ` \xB7 ${category}` : "";
      if (target === "aider") {
        const args2 = ["aider", ...defaultSpawnArgs, ...modelFlags ?? []];
        return {
          agentType: "custom",
          name: `Aider${suffix}`,
          command: args2.map(shellQuoteArg).join(" "),
          forceAiAgent: true
        };
      }
      if (!NATIVE_INTERACTIVE_TARGETS.has(target))
        return null;
      const agentType = target;
      const config = types_1.AGENT_CONFIG[agentType];
      const binary = config.command ?? target;
      const args = [binary, ...defaultSpawnArgs, ...modelFlags ?? []];
      const command = args.map(shellQuoteArg).join(" ");
      return {
        agentType,
        name: `${config.name}${suffix}`,
        // Codex's own inline mode is the terminal contract on every platform. It
        // gives Windows real xterm scrollback instead of merely forwarding wheel
        // bytes into an alternate buffer with no history.
        command: agentType === "codex" ? (0, contracts_1.ensureCodexInlineMode)(command) ?? command : command
      };
    }
    function isValidInteractiveSkillCommand(value) {
      return exports2.INTERACTIVE_SKILL_COMMAND_RE.test(value);
    }
    function buildInteractiveDelegationPrompt(prompt, target, activationCommand = exports2.DEFAULT_BROWSER_SKILL_COMMAND) {
      const task = prompt.trim();
      const targetKind = (0, contracts_1.getDeclaredAgentKind)(target);
      const invocation = (0, skillInvocation_1.formatAgentSkillInvocation)(activationCommand, targetKind).trimEnd();
      return task ? `${invocation} ${task}` : invocation;
    }
  }
});

// dist/main/main/orchestration/hookCapability.js
var require_hookCapability = __commonJS({
  "dist/main/main/orchestration/hookCapability.js"(exports2) {
    "use strict";
    var __importDefault2 = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.writeHookCapability = writeHookCapability;
    exports2.readHookCapability = readHookCapability;
    exports2.clearHookCapability = clearHookCapability;
    var node_crypto_12 = __importDefault2(require("node:crypto"));
    var node_fs_12 = __importDefault2(require("node:fs"));
    var node_path_12 = __importDefault2(require("node:path"));
    var orchestrationRuns_12 = require_orchestrationRuns();
    function capabilityPath(homeDir, terminalId) {
      const key = node_crypto_12.default.createHash("sha256").update(terminalId).digest("hex");
      return node_path_12.default.join((0, orchestrationRuns_12.getOrchestrationRootDir)(homeDir), "control", "hooks", `${key}.json`);
    }
    function writeHookCapability(homeDir, record) {
      const target = capabilityPath(homeDir, record.terminalId);
      (0, orchestrationRuns_12.ensureDir)(node_path_12.default.dirname(target), 448);
      const tmp = `${target}.${process.pid}.tmp`;
      node_fs_12.default.writeFileSync(tmp, JSON.stringify(record), { encoding: "utf-8", mode: 384 });
      node_fs_12.default.renameSync(tmp, target);
    }
    function readHookCapability(homeDir, terminalId) {
      try {
        const value = JSON.parse(node_fs_12.default.readFileSync(capabilityPath(homeDir, terminalId), "utf-8"));
        if (value.terminalId !== terminalId || typeof value.runId !== "string" || typeof value.capabilityToken !== "string" || typeof value.expiresAt !== "number" || value.expiresAt < Date.now())
          return null;
        return value;
      } catch {
        return null;
      }
    }
    function clearHookCapability(homeDir, terminalId, runId) {
      const target = capabilityPath(homeDir, terminalId);
      try {
        const current = JSON.parse(node_fs_12.default.readFileSync(target, "utf-8"));
        if (current.runId === runId)
          node_fs_12.default.unlinkSync(target);
      } catch {
      }
    }
  }
});

// dist/main/shared/terminal/localAttachProtocol.js
var require_localAttachProtocol = __commonJS({
  "dist/main/shared/terminal/localAttachProtocol.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.LOCAL_TERMINAL_ATTACH_DESCRIPTOR_FILE = exports2.LOCAL_TERMINAL_ATTACH_PROTOCOL_VERSION = void 0;
    exports2.LOCAL_TERMINAL_ATTACH_PROTOCOL_VERSION = 1;
    exports2.LOCAL_TERMINAL_ATTACH_DESCRIPTOR_FILE = "terminal-attach.json";
  }
});

// dist/main/cli/terminalAttachClient.js
var require_terminalAttachClient = __commonJS({
  "dist/main/cli/terminalAttachClient.js"(exports2) {
    "use strict";
    var __importDefault2 = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.listLocalTerminals = listLocalTerminals;
    exports2.submitLocalTerminalPrompt = submitLocalTerminalPrompt;
    exports2.attachLocalTerminal = attachLocalTerminal;
    var node_fs_12 = __importDefault2(require("node:fs"));
    var node_net_1 = __importDefault2(require("node:net"));
    var node_os_12 = __importDefault2(require("node:os"));
    var node_path_12 = __importDefault2(require("node:path"));
    var localAttachProtocol_1 = require_localAttachProtocol();
    var CONNECT_TIMEOUT_MS = 2e3;
    var REQUEST_TIMEOUT_MS = 1e4;
    function descriptorPath() {
      return node_path_12.default.join(node_os_12.default.homedir(), ".1devtool", "state", localAttachProtocol_1.LOCAL_TERMINAL_ATTACH_DESCRIPTOR_FILE);
    }
    function readDescriptor() {
      const filePath = descriptorPath();
      let stat;
      let parsed;
      try {
        stat = node_fs_12.default.statSync(filePath);
        parsed = JSON.parse(node_fs_12.default.readFileSync(filePath, "utf8"));
      } catch {
        throw new Error("Local terminal attach is disabled or 1DevTool is not running. Enable it in Settings \u2192 Terminal \u2192 Advance.");
      }
      if (process.platform !== "win32") {
        if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
          throw new Error("Local terminal descriptor is owned by another OS user");
        }
        if ((stat.mode & 63) !== 0)
          throw new Error("Local terminal descriptor permissions are unsafe");
      }
      if (parsed.protocolVersion !== localAttachProtocol_1.LOCAL_TERMINAL_ATTACH_PROTOCOL_VERSION || !parsed.socketPath || !parsed.token) {
        throw new Error("Local terminal descriptor uses an unsupported protocol");
      }
      return parsed;
    }
    var LocalTerminalClient = class _LocalTerminalClient {
      socket;
      token;
      pending = /* @__PURE__ */ new Map();
      nextId = 1;
      buffer = "";
      closed = false;
      onEvent;
      onDisconnect;
      constructor(socket, token) {
        this.socket = socket;
        this.token = token;
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => this.onData(chunk));
        socket.on("error", (error) => this.fail(error));
        socket.on("close", () => this.fail(new Error("Local terminal socket closed")));
      }
      static async connect() {
        const descriptor = readDescriptor();
        const socket = node_net_1.default.createConnection(descriptor.socketPath);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error("Timed out connecting to the local terminal socket"));
          }, CONNECT_TIMEOUT_MS);
          socket.once("connect", () => {
            clearTimeout(timer);
            resolve();
          });
          socket.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
        });
        return new _LocalTerminalClient(socket, descriptor.token);
      }
      request(method, payload = {}) {
        if (this.closed)
          return Promise.reject(new Error("Local terminal socket is closed"));
        const id = String(this.nextId++);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`Local terminal ${method} request timed out`));
          }, REQUEST_TIMEOUT_MS);
          this.pending.set(id, { resolve, reject, timer });
          this.socket.write(`${JSON.stringify({ id, token: this.token, method, ...payload })}
`);
        }).then((response) => {
          if (!response.ok)
            throw new Error(response.error?.message || "Local terminal request failed");
          return response;
        });
      }
      notify(method, payload = {}) {
        if (this.closed)
          return;
        const id = `notify-${this.nextId++}`;
        this.socket.write(`${JSON.stringify({ id, token: this.token, method, ...payload })}
`);
      }
      close() {
        if (this.closed)
          return;
        this.closed = true;
        this.socket.end();
      }
      onData(chunk) {
        this.buffer += chunk;
        while (true) {
          const newline = this.buffer.indexOf("\n");
          if (newline < 0)
            return;
          const line = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          if (!line)
            continue;
          let value;
          try {
            value = JSON.parse(line);
          } catch {
            this.socket.destroy();
            this.fail(new Error("Local terminal socket returned invalid JSON"));
            return;
          }
          if ("id" in value) {
            const waiter = this.pending.get(value.id);
            if (waiter) {
              this.pending.delete(value.id);
              clearTimeout(waiter.timer);
              waiter.resolve(value);
            }
          } else {
            this.onEvent?.(value);
          }
        }
      }
      fail(error) {
        if (this.closed)
          return;
        this.closed = true;
        for (const waiter of this.pending.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(error);
        }
        this.pending.clear();
        this.onDisconnect?.(error);
      }
    };
    function rawAttachContent(result) {
      if (result.payload.kind !== "raw")
        return "";
      return result.payload.rawFallback.content + result.payload.rawFallback.unbufferedOverlap.sort((left, right) => left.cursor.streamSeq - right.cursor.streamSeq).map((fragment) => fragment.data).join("");
    }
    function writeStdout(data) {
      if (!data || process.stdout.write(data))
        return Promise.resolve();
      return new Promise((resolve) => process.stdout.once("drain", resolve));
    }
    function ackFrame(client, frame) {
      client.notify("ack", {
        connectionId: frame.connectionId,
        syncGeneration: frame.syncGeneration,
        frameId: frame.frameId
      });
    }
    async function listLocalTerminals(json = false) {
      const client = await LocalTerminalClient.connect();
      try {
        const response = await client.request("list");
        const rows = response.result ?? [];
        if (json) {
          process.stdout.write(`${JSON.stringify(rows, null, 2)}
`);
          return;
        }
        if (rows.length === 0) {
          process.stdout.write("No terminals.\n");
          return;
        }
        for (const row of rows) {
          process.stdout.write(`${row.live ? "live " : "idle "} ${row.id}  ${row.projectName} / ${row.name}  (${row.agentType})
`);
        }
      } finally {
        client.close();
      }
    }
    async function submitLocalTerminalPrompt(terminalId, prompt) {
      const client = await LocalTerminalClient.connect();
      try {
        await client.request("submit", { terminalId, prompt });
      } finally {
        client.close();
      }
    }
    async function attachLocalTerminal(terminalId) {
      const client = await LocalTerminalClient.connect();
      let connectionId = "";
      let applyTail = Promise.resolve();
      let finished = false;
      let resolveFinished;
      const done = new Promise((resolve) => {
        resolveFinished = resolve;
      });
      const finish = () => {
        if (finished)
          return;
        finished = true;
        resolveFinished();
      };
      const applyAttach = async (attach) => {
        connectionId = attach.connectionId;
        await writeStdout(rawAttachContent(attach));
        client.notify("ack", {
          connectionId: attach.connectionId,
          syncGeneration: attach.syncGeneration,
          frameId: attach.attachFrameId
        });
      };
      client.onEvent = (event) => {
        if (event.type === "closed") {
          process.stderr.write(`
terminal viewer closed: ${event.reason}
`);
          finish();
          return;
        }
        const frame = event.frame;
        applyTail = applyTail.then(async () => {
          if (frame.event.type === "output") {
            await writeStdout(frame.event.data);
            ackFrame(client, frame);
          } else if (frame.event.type === "resync-required") {
            const response = await client.request("resync", { connectionId: frame.connectionId });
            const attach = response.result.attach;
            await writeStdout("\x1Bc");
            await applyAttach(attach);
          } else {
            ackFrame(client, frame);
            if (frame.event.type === "exit" || frame.event.type === "engine-closed")
              finish();
          }
        }).catch((error) => {
          process.stderr.write(`
terminal viewer error: ${error instanceof Error ? error.message : String(error)}
`);
          finish();
        });
      };
      client.onDisconnect = (error) => {
        if (!finished)
          process.stderr.write(`
terminal viewer disconnected: ${error.message}
`);
        finish();
      };
      const interrupt = () => finish();
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
      try {
        const response = await client.request("attach", {
          terminalId,
          clientRequestId: `onedevtool-${process.pid}-${Date.now()}`
        });
        await applyAttach(response.result.attach);
        await done;
        await applyTail;
      } finally {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", interrupt);
        if (connectionId)
          client.notify("detach", { connectionId });
        client.close();
      }
    }
  }
});

// dist/main/shared/terminal/connectionProtocol.js
var require_connectionProtocol = __commonJS({
  "dist/main/shared/terminal/connectionProtocol.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.TerminalV2AnsiSplitter = exports2.TerminalConnectionError = exports2.RAW_V2_CAPABILITIES = exports2.TERMINAL_CONNECTION_REMOTE_ATTACH_DEADLINE_MS = exports2.TERMINAL_CONNECTION_DESKTOP_ATTACH_DEADLINE_MS = exports2.TERMINAL_CONNECTION_MAX_QUERY_QUIET_RETRIES = exports2.TERMINAL_CONNECTION_QUERY_QUIET_WINDOW_MS = exports2.TERMINAL_CONNECTION_REMOTE_BACKGROUND_GRACE_MS = exports2.TERMINAL_CONNECTION_MAX_PENDING_FRAMES = exports2.TERMINAL_CONNECTION_REMOTE_WINDOW_BYTES = exports2.TERMINAL_CONNECTION_MAX_FRAGMENT_BYTES = exports2.TERMINAL_CONNECTION_PROTOCOL_VERSION = void 0;
    exports2.terminalCheckpointCacheKey = terminalCheckpointCacheKey;
    exports2.isBenignTerminalResyncFailure = isBenignTerminalResyncFailure;
    exports2.sameTerminalOwner = sameTerminalOwner;
    exports2.negotiateTerminalCapabilities = negotiateTerminalCapabilities;
    exports2.terminalAttachFingerprint = terminalAttachFingerprint;
    exports2.TERMINAL_CONNECTION_PROTOCOL_VERSION = 2;
    exports2.TERMINAL_CONNECTION_MAX_FRAGMENT_BYTES = 64 * 1024;
    exports2.TERMINAL_CONNECTION_REMOTE_WINDOW_BYTES = 256 * 1024;
    exports2.TERMINAL_CONNECTION_MAX_PENDING_FRAMES = 2048;
    exports2.TERMINAL_CONNECTION_REMOTE_BACKGROUND_GRACE_MS = 2500;
    exports2.TERMINAL_CONNECTION_QUERY_QUIET_WINDOW_MS = 200;
    exports2.TERMINAL_CONNECTION_MAX_QUERY_QUIET_RETRIES = 3;
    exports2.TERMINAL_CONNECTION_DESKTOP_ATTACH_DEADLINE_MS = 2e3;
    exports2.TERMINAL_CONNECTION_REMOTE_ATTACH_DEADLINE_MS = 5e3;
    exports2.RAW_V2_CAPABILITIES = [
      "raw-output-v1",
      "frame-ack-v1",
      "resync-v1"
    ];
    function terminalCheckpointCacheKey(key) {
      return JSON.stringify([
        key.engineEpoch,
        key.terminalGeneration,
        key.displayProfileRevision,
        key.screenVersion,
        key.cols,
        key.rows,
        key.codecVersion,
        key.historySpan
      ]);
    }
    var TerminalConnectionError = class extends Error {
      code;
      constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "TerminalConnectionError";
      }
    };
    exports2.TerminalConnectionError = TerminalConnectionError;
    function isBenignTerminalResyncFailure(code) {
      return code === "connection-not-found" || code === "stale-frame";
    }
    function sameTerminalOwner(left, right) {
      return Boolean(left && right && left.engineEpoch === right.engineEpoch && left.terminalGeneration === right.terminalGeneration);
    }
    function negotiateTerminalCapabilities(requested, supported = exports2.RAW_V2_CAPABILITIES) {
      const allowed = new Set(supported);
      return [...new Set(requested)].filter((capability) => allowed.has(capability));
    }
    function terminalAttachFingerprint(request) {
      return JSON.stringify({
        terminalId: request.terminalId,
        capabilities: [...new Set(request.capabilities)].sort(),
        requestedSize: request.requestedSize ?? null,
        after: request.after ?? null,
        historyLines: request.historyLines ?? null,
        maxSnapshotChars: request.maxSnapshotChars ?? null,
        historyMode: request.historyMode ?? "normal"
      });
    }
    var textEncoder = new TextEncoder();
    function utf8Chunks(value, maxBytes) {
      if (!value)
        return [];
      if (textEncoder.encode(value).byteLength <= maxBytes)
        return [value];
      const chunks = [];
      let start = 0;
      let offset = 0;
      let bytes = 0;
      while (offset < value.length) {
        const point = value.codePointAt(offset);
        const codeUnits = point > 65535 ? 2 : 1;
        const size = point <= 127 ? 1 : point <= 2047 ? 2 : point <= 65535 ? 3 : 4;
        if (offset > start && bytes + size > maxBytes) {
          chunks.push(value.slice(start, offset));
          start = offset;
          bytes = 0;
        }
        bytes += size;
        offset += codeUnits;
      }
      if (start < value.length)
        chunks.push(value.slice(start));
      return chunks;
    }
    function oscRequestsReply(sequence) {
      const body = sequence.endsWith("\x07") ? sequence.slice(2, -1) : sequence.endsWith("\x1B\\") ? sequence.slice(2, -2) : sequence.slice(2);
      return body.split(";").some((parameter) => parameter === "?");
    }
    function classifyEscape(sequence) {
      if (sequence === "\x1BZ")
        return "client-processing-required";
      if (sequence.startsWith("\x1B[")) {
        const final = sequence.charAt(sequence.length - 1);
        if (final === "c" || final === "n" || final === "t" || sequence.includes("$p")) {
          return "client-processing-required";
        }
      }
      if (sequence.startsWith("\x1B]") && oscRequestsReply(sequence)) {
        return "client-processing-required";
      }
      if (sequence.startsWith("\x1BP") && (sequence.includes("$q") || sequence.includes("+q"))) {
        return "client-processing-required";
      }
      return "screen-replaceable";
    }
    function escapeEnd(text, start) {
      if (start + 1 >= text.length)
        return null;
      const marker = text[start + 1];
      if (marker === "[") {
        for (let index = start + 2; index < text.length; index += 1) {
          const code = text.charCodeAt(index);
          if (code >= 64 && code <= 126)
            return index + 1;
        }
        return null;
      }
      if (marker === "]" || marker === "P" || marker === "^" || marker === "_") {
        for (let index = start + 2; index < text.length; index += 1) {
          if (text[index] === "\x07")
            return index + 1;
          if (text[index] === "\x1B" && text[index + 1] === "\\")
            return index + 2;
        }
        return null;
      }
      return marker === "(" || marker === ")" || marker === "*" || marker === "+" ? start + 2 < text.length ? start + 3 : null : start + 2;
    }
    var TerminalV2AnsiSplitter = class {
      maxFragmentBytes;
      maxEscapeCarryBytes;
      pending = null;
      constructor(maxFragmentBytes = exports2.TERMINAL_CONNECTION_MAX_FRAGMENT_BYTES, maxEscapeCarryBytes = 4 * 1024) {
        this.maxFragmentBytes = maxFragmentBytes;
        this.maxEscapeCarryBytes = maxEscapeCarryBytes;
      }
      feed(data, bufferSeq) {
        const prefix = this.pending;
        const combined = (prefix?.data ?? "") + data;
        const combinedBufferSeq = prefix ? prefix.bufferSeq !== void 0 && bufferSeq !== void 0 ? Math.max(prefix.bufferSeq, bufferSeq) : void 0 : bufferSeq;
        this.pending = null;
        const logical = [];
        const logicalBytes = [];
        let offset = 0;
        let textStart = 0;
        const push = (value, delivery, seq = combinedBufferSeq) => {
          for (const chunk of utf8Chunks(value, this.maxFragmentBytes)) {
            const bytes = textEncoder.encode(chunk).byteLength;
            const previous = logical.at(-1);
            const previousBytes = logicalBytes.at(-1) ?? 0;
            if (previous && previous.delivery === delivery && previous.bufferSeq === seq && previousBytes + bytes <= this.maxFragmentBytes) {
              previous.data += chunk;
              logicalBytes[logicalBytes.length - 1] = previousBytes + bytes;
              continue;
            }
            logical.push(seq === void 0 ? { data: chunk, delivery } : { data: chunk, delivery, bufferSeq: seq });
            logicalBytes.push(bytes);
          }
        };
        while (offset < combined.length) {
          const esc = combined.indexOf("\x1B", offset);
          if (esc < 0)
            break;
          if (esc > textStart)
            push(combined.slice(textStart, esc), "screen-replaceable");
          const end = escapeEnd(combined, esc);
          if (end === null) {
            const carry = combined.slice(esc);
            if (textEncoder.encode(carry).byteLength > this.maxEscapeCarryBytes) {
              push(carry, "client-processing-required", combinedBufferSeq);
            } else {
              this.pending = { data: carry, bufferSeq: combinedBufferSeq };
            }
            return logical;
          }
          const sequence = combined.slice(esc, end);
          push(sequence, classifyEscape(sequence));
          offset = end;
          textStart = end;
        }
        if (textStart < combined.length)
          push(combined.slice(textStart), "screen-replaceable");
        return logical;
      }
      /** Flush only at terminal teardown. A partial control sequence is not
       * replaceable display data. */
      finish() {
        const pending = this.pending;
        this.pending = null;
        if (!pending?.data)
          return [];
        return utf8Chunks(pending.data, this.maxFragmentBytes).map((data) => ({
          data,
          delivery: "client-processing-required",
          ...pending.bufferSeq === void 0 ? {} : { bufferSeq: pending.bufferSeq }
        }));
      }
    };
    exports2.TerminalV2AnsiSplitter = TerminalV2AnsiSplitter;
  }
});

// dist/main/main/pty-backend/ptyRelease.js
var require_ptyRelease = __commonJS({
  "dist/main/main/pty-backend/ptyRelease.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.releasePty = releasePty;
    exports2.releaseExitedPty = releaseExitedPty;
    function closePtyMaster(ptyProcess) {
      if (process.platform === "win32")
        return;
      const closable = ptyProcess;
      if (typeof closable.destroy !== "function")
        return;
      try {
        closable.destroy();
      } catch {
      }
    }
    function releasePty(ptyProcess) {
      try {
        ptyProcess.kill();
      } catch {
      }
      closePtyMaster(ptyProcess);
    }
    function releaseExitedPty(ptyProcess) {
      closePtyMaster(ptyProcess);
    }
  }
});

// dist/main/cli/sshTerminalHost.js
var require_sshTerminalHost = __commonJS({
  "dist/main/cli/sshTerminalHost.js"(exports2) {
    "use strict";
    var __createBinding = exports2 && exports2.__createBinding || (Object.create ? function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      var desc = Object.getOwnPropertyDescriptor(m, k);
      if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function() {
          return m[k];
        } };
      }
      Object.defineProperty(o, k2, desc);
    } : function(o, m, k, k2) {
      if (k2 === void 0) k2 = k;
      o[k2] = m[k];
    });
    var __setModuleDefault = exports2 && exports2.__setModuleDefault || (Object.create ? function(o, v) {
      Object.defineProperty(o, "default", { enumerable: true, value: v });
    } : function(o, v) {
      o["default"] = v;
    });
    var __importStar = exports2 && exports2.__importStar || /* @__PURE__ */ function() {
      var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function(o2) {
          var ar = [];
          for (var k in o2) if (Object.prototype.hasOwnProperty.call(o2, k)) ar[ar.length] = k;
          return ar;
        };
        return ownKeys(o);
      };
      return function(mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) {
          for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        }
        __setModuleDefault(result, mod);
        return result;
      };
    }();
    var __importDefault2 = exports2 && exports2.__importDefault || function(mod) {
      return mod && mod.__esModule ? mod : { "default": mod };
    };
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.runSshTerminalHost = runSshTerminalHost;
    var node_crypto_12 = __importDefault2(require("node:crypto"));
    var connectionProtocol_1 = require_connectionProtocol();
    var ptyRelease_1 = require_ptyRelease();
    var MAX_SESSIONS = 16;
    var MAX_REQUEST_BYTES = 1024 * 1024;
    var MAX_WRITE_BYTES = 64 * 1024;
    var MAX_STDOUT_QUEUE_BYTES = 256 * 1024;
    var MAX_PTY_INPUT_BUFFER_BYTES = 1024 * 1024;
    var MAX_GENERATION_ENTRIES = 512;
    var CLOSE_ESCALATION_WINDOW_MS = 500;
    function validDimension(value) {
      return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 1e3;
    }
    async function loadNodePty() {
      try {
        const moduleName = "node-pty";
        return await Promise.resolve(`${moduleName}`).then((s) => __importStar(require(s)));
      } catch {
        throw new Error("node-pty is unavailable on this host; install the signed Node helper package explicitly");
      }
    }
    async function runSshTerminalHost() {
      if (process.stdin.isTTY) {
        throw new Error("ssh-host requires an NDJSON stdin pipe; it never opens an interactive daemon");
      }
      const pty = await loadNodePty();
      const engineEpoch = node_crypto_12.default.randomUUID();
      const generations = /* @__PURE__ */ new Map();
      const sessions = /* @__PURE__ */ new Map();
      let outputBlocked = false;
      let hostClosing = false;
      let queuedOutputBytes = 0;
      const outputQueue = [];
      let closeInput = () => {
        process.stdin.destroy();
      };
      const abortHost = (note) => {
        if (hostClosing)
          return;
        hostClosing = true;
        process.exitCode = 1;
        process.stderr.write(note);
        for (const hosted of sessions.values())
          hosted.process.pause();
        closeInput();
      };
      const pauseOutput = () => {
        if (outputBlocked)
          return;
        outputBlocked = true;
        for (const hosted of sessions.values())
          hosted.process.pause();
      };
      const flushOutput = () => {
        if (outputBlocked || hostClosing)
          return;
        while (outputQueue.length > 0) {
          const line = outputQueue.shift();
          queuedOutputBytes -= Buffer.byteLength(line);
          if (!process.stdout.write(line)) {
            pauseOutput();
            return;
          }
        }
      };
      const respond = (value) => {
        if (hostClosing)
          return;
        const line = `${JSON.stringify(value)}
`;
        const bytes = Buffer.byteLength(line);
        if (queuedOutputBytes + bytes > MAX_STDOUT_QUEUE_BYTES) {
          abortHost("ssh-host stdout remained blocked; closing bounded terminal sessions\n");
          return;
        }
        outputQueue.push(line);
        queuedOutputBytes += bytes;
        flushOutput();
      };
      const resumeOutput = () => {
        if (!outputBlocked)
          return;
        outputBlocked = false;
        flushOutput();
        if (!outputBlocked && !hostClosing) {
          for (const hosted of sessions.values())
            hosted.process.resume();
        }
      };
      process.stdout.on("drain", resumeOutput);
      process.stdout.on("error", () => {
        abortHost("ssh-host stdout pipe failed; closing bounded terminal sessions\n");
      });
      const emitFragments = (terminalId, hosted, data) => {
        const fragments = hosted.splitter.feed(data).map((fragment) => ({
          cursor: {
            engineEpoch,
            terminalGeneration: hosted.generation,
            streamSeq: ++hosted.streamSeq
          },
          delivery: fragment.delivery,
          data: fragment.data
        }));
        for (const fragment of fragments)
          respond({ type: "output", terminalId, fragment });
      };
      const closeSession = (terminalId) => {
        const hosted = sessions.get(terminalId);
        if (!hosted)
          return false;
        sessions.delete(terminalId);
        if (!hosted.released) {
          hosted.released = true;
          if (hosted.exited)
            (0, ptyRelease_1.releaseExitedPty)(hosted.process);
          else
            (0, ptyRelease_1.releasePty)(hosted.process);
        }
        return true;
      };
      const handle = async (request) => {
        if (hostClosing)
          return;
        const id = typeof request?.id === "string" ? request.id : "";
        try {
          switch (request.method) {
            case "hello":
              respond({ id, ok: true, result: {
                protocolVersion: connectionProtocol_1.TERMINAL_CONNECTION_PROTOCOL_VERSION,
                capabilities: [...connectionProtocol_1.RAW_V2_CAPABILITIES],
                engineEpoch,
                runtime: "node-pty-stdio"
              } });
              return;
            case "list":
              respond({ id, ok: true, result: [...sessions].map(([terminalId, hosted]) => ({
                terminalId,
                terminalGeneration: hosted.generation,
                pid: hosted.process.pid
              })) });
              return;
            case "start": {
              if (!request.terminalId || !request.file || !request.cwd || !validDimension(request.cols) || !validDimension(request.rows)) {
                throw new Error("start requires terminalId, file, cwd, cols and rows");
              }
              const terminalId = request.terminalId;
              if (sessions.has(terminalId))
                throw new Error("terminalId is already live");
              if (sessions.size >= MAX_SESSIONS)
                throw new Error(`session limit is ${MAX_SESSIONS}`);
              const generation = (generations.get(terminalId) ?? 0) + 1;
              generations.delete(terminalId);
              generations.set(terminalId, generation);
              if (generations.size > MAX_GENERATION_ENTRIES) {
                for (const knownId of generations.keys()) {
                  if (generations.size <= MAX_GENERATION_ENTRIES)
                    break;
                  if (!sessions.has(knownId))
                    generations.delete(knownId);
                }
              }
              const environment = Object.fromEntries(Object.entries({ ...process.env, ...request.env ?? {} }).filter((entry) => typeof entry[1] === "string"));
              const child = pty.spawn(request.file, request.args ?? [], {
                cwd: request.cwd,
                cols: request.cols,
                rows: request.rows,
                name: "xterm-256color",
                env: environment
              });
              const hosted = {
                process: child,
                generation,
                streamSeq: 0,
                splitter: new connectionProtocol_1.TerminalV2AnsiSplitter(),
                exited: false,
                released: false
              };
              sessions.set(terminalId, hosted);
              if (outputBlocked)
                child.pause();
              child.onData((data) => emitFragments(terminalId, hosted, data));
              child.onExit(({ exitCode }) => {
                hosted.exited = true;
                for (const fragment of hosted.splitter.finish()) {
                  respond({
                    type: "output",
                    terminalId,
                    fragment: {
                      cursor: { engineEpoch, terminalGeneration: generation, streamSeq: ++hosted.streamSeq },
                      delivery: fragment.delivery,
                      data: fragment.data
                    }
                  });
                }
                if (sessions.get(terminalId) === hosted)
                  sessions.delete(terminalId);
                if (!hosted.released) {
                  hosted.released = true;
                  (0, ptyRelease_1.releaseExitedPty)(child);
                }
                respond({ type: "exit", terminalId, terminalGeneration: generation, code: exitCode });
              });
              respond({ id, ok: true, result: { engineEpoch, terminalGeneration: generation, pid: child.pid } });
              return;
            }
            case "write": {
              const hosted = request.terminalId ? sessions.get(request.terminalId) : void 0;
              if (!hosted || typeof request.data !== "string" || Buffer.byteLength(request.data) > MAX_WRITE_BYTES) {
                throw new Error("write requires a live terminal and at most 64 KiB");
              }
              const inputSocket = hosted.process._socket;
              const bufferedInput = inputSocket?.writableLength;
              if (typeof bufferedInput === "number" && bufferedInput > MAX_PTY_INPUT_BUFFER_BYTES) {
                respond({ id, ok: false, error: { code: "write-backpressure", message: "terminal input buffer is full; write dropped" } });
                return;
              }
              hosted.process.write(request.data);
              respond({ id, ok: true });
              return;
            }
            case "resize": {
              const hosted = request.terminalId ? sessions.get(request.terminalId) : void 0;
              if (!hosted || !validDimension(request.cols) || !validDimension(request.rows)) {
                throw new Error("resize requires a live terminal and valid cols/rows");
              }
              hosted.process.resize(request.cols, request.rows);
              respond({ id, ok: true });
              return;
            }
            case "close":
              respond({ id, ok: closeSession(request.terminalId ?? "") });
              return;
            default:
              throw new Error("unknown ssh-host method");
          }
        } catch (error) {
          respond({ id, ok: false, error: { code: "request-failed", message: error instanceof Error ? error.message : String(error) } });
        }
      };
      process.stdin.setEncoding("utf8");
      let inputBuffer = "";
      try {
        input: for await (const chunk of process.stdin) {
          inputBuffer += typeof chunk === "string" ? chunk : String(chunk);
          while (true) {
            if (hostClosing)
              break input;
            const newline = inputBuffer.indexOf("\n");
            if (newline < 0) {
              if (Buffer.byteLength(inputBuffer) > MAX_REQUEST_BYTES) {
                respond({ id: "", ok: false, error: { code: "request-too-large", message: "NDJSON request exceeds 1 MiB" } });
                process.exitCode = 1;
                break input;
              }
              break;
            }
            const line = inputBuffer.slice(0, newline).replace(/\r$/, "");
            inputBuffer = inputBuffer.slice(newline + 1);
            if (!line.trim())
              continue;
            if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) {
              respond({ id: "", ok: false, error: { code: "request-too-large", message: "NDJSON request exceeds 1 MiB" } });
              process.exitCode = 1;
              break input;
            }
            try {
              await handle(JSON.parse(line));
            } catch {
              respond({ id: "", ok: false, error: { code: "invalid-json", message: "Invalid NDJSON request" } });
            }
          }
        }
      } catch (error) {
        const code = error?.code;
        if (!hostClosing && code !== "ERR_STREAM_PREMATURE_CLOSE")
          throw error;
      } finally {
        const closing = [...sessions.values()];
        for (const terminalId of [...sessions.keys()])
          closeSession(terminalId);
        const deadline = Date.now() + CLOSE_ESCALATION_WINDOW_MS;
        while (closing.some((hosted) => !hosted.exited) && Date.now() < deadline) {
          await new Promise((resolve) => {
            setTimeout(resolve, 25);
          });
        }
        if (process.platform !== "win32") {
          for (const hosted of closing) {
            if (hosted.exited)
              continue;
            try {
              process.kill(hosted.process.pid, "SIGKILL");
            } catch {
            }
          }
        }
        process.stdout.off("drain", resumeOutput);
      }
    }
  }
});

// dist/main/cli/agent.js
var __importDefault = exports && exports.__importDefault || function(mod) {
  return mod && mod.__esModule ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
var node_util_1 = require("node:util");
var node_crypto_1 = __importDefault(require("node:crypto"));
var node_fs_1 = __importDefault(require("node:fs"));
var node_os_1 = __importDefault(require("node:os"));
var node_path_1 = __importDefault(require("node:path"));
var node_child_process_1 = require("node:child_process");
var runHeadlessAgent_1 = require_runHeadlessAgent();
var headlessMode_1 = require_headlessMode();
var agentModels_1 = require_agentModels();
var bridgeNotify_1 = require_bridgeNotify();
var orchestrationRuns_1 = require_orchestrationRuns();
var orchestrationShim_1 = require_orchestrationShim();
var linkGuard_1 = require_linkGuard();
var runLog_1 = require_runLog();
var interactiveDelegation_1 = require_interactiveDelegation();
var hookCapability_1 = require_hookCapability();
var terminalAttachClient_1 = require_terminalAttachClient();
var sshTerminalHost_1 = require_sshTerminalHost();
var KNOWN_AGENT_IDS = Object.keys(headlessMode_1.HEADLESS_SPECS);
var CACHE_PATH = node_path_1.default.join(node_os_1.default.homedir(), ".1devtool", "state", "cli-registry.json");
var CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
function readCache() {
  try {
    if (!node_fs_1.default.existsSync(CACHE_PATH))
      return null;
    const raw = node_fs_1.default.readFileSync(CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.writtenAt > CACHE_MAX_AGE_MS)
      return null;
    return parsed;
  } catch {
    return null;
  }
}
function slimResolveBinary(agentId, cache) {
  const spec = headlessMode_1.HEADLESS_SPECS[agentId];
  if (!spec)
    return null;
  const known = cache?.knownClis.find((c) => c.id === agentId);
  const candidates = (known?.binaries?.length ? known.binaries : [spec.cliId]).filter((v, i, a) => a.indexOf(v) === i);
  const isWin = process.platform === "win32";
  for (const bin of candidates) {
    try {
      const which = isWin ? (0, node_child_process_1.execFileSync)("cmd.exe", ["/c", "where", bin], { encoding: "utf-8", timeout: 5e3, windowsHide: true }) : (0, node_child_process_1.execFileSync)(process.env.SHELL || "/bin/sh", ["-lc", `command -v ${bin}`], { encoding: "utf-8", timeout: 5e3 });
      const lines = which.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const ranked = isWin ? [...lines].sort((a, b) => windowsBinaryRank(a) - windowsBinaryRank(b)) : lines;
      for (const line of ranked) {
        if (node_fs_1.default.existsSync(line)) {
          return { path: line, version: null };
        }
      }
    } catch {
    }
  }
  return null;
}
function windowsBinaryRank(filePath) {
  const ext = node_path_1.default.extname(filePath).toLowerCase();
  if (ext === ".exe" || ext === ".com")
    return 0;
  if (ext === ".cmd" || ext === ".bat")
    return 1;
  if (ext === ".ps1")
    return 2;
  return 3;
}
function resolveBinaryPath(agentId) {
  const cache = readCache();
  if (cache) {
    const reg = cache.registrations.find((r) => r.cliId === agentId);
    if (reg && (reg.state === "detected" || reg.state === "override") && reg.selectedPath) {
      return { path: reg.selectedPath, version: reg.version };
    }
  }
  return slimResolveBinary(agentId, cache);
}
function listAgents(jsonOut) {
  const cache = readCache();
  const rows = [];
  if (cache) {
    for (const reg of cache.registrations) {
      const known = cache.knownClis.find((c) => c.id === reg.cliId);
      if (known?.category && known.category !== "ai-agent")
        continue;
      rows.push({ id: reg.cliId, status: reg.state, version: reg.version, path: reg.selectedPath });
    }
  } else {
    for (const id of KNOWN_AGENT_IDS) {
      const resolved = slimResolveBinary(id, cache);
      rows.push({
        id,
        status: resolved ? "detected" : "not-found",
        version: resolved?.version ?? null,
        path: resolved?.path ?? null
      });
    }
  }
  if (jsonOut) {
    process.stdout.write(JSON.stringify({ agents: rows }, null, 2) + "\n");
    return;
  }
  for (const row of rows) {
    const ver = row.version ? `  v${row.version}` : "";
    const where = row.path ? `  ${row.path}` : "";
    process.stdout.write(`${row.status.padEnd(10)}  ${row.id}${ver}${where}
`);
  }
}
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}
function isAbsolutePath(p) {
  if (!p)
    return false;
  return p.startsWith("/") || /^[A-Z]:[\\/]/i.test(p);
}
async function readPromptFile(filePath) {
  const resolved = node_path_1.default.resolve(filePath);
  const lstat = node_fs_1.default.lstatSync(resolved);
  if (lstat.isSymbolicLink()) {
    throw new Error("--prompt-file refuses symlinks");
  }
  const cwd = node_path_1.default.resolve(process.cwd());
  const tmp = node_path_1.default.resolve(node_os_1.default.tmpdir());
  if (!resolved.startsWith(cwd) && !resolved.startsWith(tmp)) {
    throw new Error("--prompt-file must be inside cwd or $TMPDIR");
  }
  return node_fs_1.default.readFileSync(resolved, "utf-8");
}
async function runAgentCommand(opts) {
  const to = opts.to;
  if (!to || !KNOWN_AGENT_IDS.includes(to)) {
    process.stderr.write(`error: --to must be one of: ${KNOWN_AGENT_IDS.join(", ")}
`);
    process.exit(2);
  }
  if (!opts.promptStdin && !opts.promptFile) {
    process.stderr.write(`error: prompt input is required
  use --prompt-stdin to pipe the prompt:  printf '%s' "$TASK" | 1devtool-agent run --to=` + to + " --prompt-stdin\n  or --prompt-file=<path> to read from a file (must be in cwd or $TMPDIR; symlinks rejected)\n\n  there is no --prompt=<text> flag \u2014 argv prompts are unsafe because\n  shell substitution happens before this CLI sees them.\n");
    process.exit(2);
  }
  if (opts.promptStdin && opts.promptFile) {
    process.stderr.write("error: pass either --prompt-stdin or --prompt-file, not both\n");
    process.exit(2);
  }
  const prompt = opts.promptStdin ? await readStdin() : await readPromptFile(opts.promptFile);
  if (!prompt.trim()) {
    process.stderr.write("error: prompt is empty\n");
    process.exit(2);
  }
  let modelFlags = [];
  if (opts.model) {
    if (!agentModels_1.AGENT_MODEL_SPECS[to]) {
      process.stderr.write(`error: agent "${to}" does not support --model
`);
      process.exit(2);
    }
    if (!(0, agentModels_1.isValidModelId)(opts.model)) {
      process.stderr.write(`error: --model value "${opts.model}" is not a valid model id
`);
      process.exit(2);
    }
    modelFlags = (0, agentModels_1.buildModelFlags)(to, opts.model) ?? [];
  }
  if (opts.category !== void 0 && !(0, orchestrationRuns_1.isValidRunCategory)(opts.category)) {
    process.stderr.write("error: --category must match ^[a-z][a-z0-9-]{1,23}$\n");
    process.exit(2);
  }
  if (opts.skill && !opts.interactive && !opts.terminal) {
    process.stderr.write("error: --skill requires --terminal (or legacy --interactive)\n");
    process.exit(2);
  }
  if (opts.skill && !(0, interactiveDelegation_1.isValidInteractiveSkillCommand)(opts.skill)) {
    process.stderr.write("error: --skill must be a slash command such as /chrome\n");
    process.exit(2);
  }
  if ((opts.interactive || opts.terminal) && (opts.flag?.length ?? 0) > 0) {
    process.stderr.write("error: --flag is not accepted with --interactive; configure interactive startup flags in Terminal Settings instead\n");
    process.exit(2);
  }
  if (opts.interactive && opts.terminal) {
    process.stderr.write("error: pass either --terminal or --interactive, not both\n");
    process.exit(2);
  }
  if (opts.wait && !opts.terminal) {
    process.stderr.write("error: --wait requires --terminal\n");
    process.exit(2);
  }
  const cwd = opts.cwd && isAbsolutePath(opts.cwd) ? opts.cwd : process.cwd();
  const timeoutSeconds = opts.timeout ? Number(opts.timeout) : runHeadlessAgent_1.HEADLESS_DEFAULT_TIMEOUT_S;
  if (Number.isNaN(timeoutSeconds)) {
    process.stderr.write("error: --timeout must be a number\n");
    process.exit(2);
  }
  const normalizedTimeoutS = Math.min(Math.max(timeoutSeconds, runHeadlessAgent_1.HEADLESS_MIN_TIMEOUT_S), runHeadlessAgent_1.HEADLESS_MAX_TIMEOUT_S);
  const displayCommand = `1devtool-agent run --to=${to}` + (opts.model ? ` --model=${opts.model}` : "") + (opts.category ? ` --category=${opts.category}` : "") + (opts.interactive ? " --interactive" : "") + (opts.terminal ? " --terminal" : "") + (opts.wait ? " --wait" : "") + (opts.skill ? ` --skill=${opts.skill}` : "");
  const callId = node_crypto_1.default.randomUUID();
  const runLog = (0, runLog_1.startRunLog)({
    callId,
    target: to,
    category: opts.category,
    model: opts.model,
    command: displayCommand,
    cwd,
    hostTerminalId: process.env.ONEDEVTOOL_TERMINAL_ID,
    startedAt: Date.now(),
    timeoutSeconds: normalizedTimeoutS,
    prompt
  });
  const resolved = resolveBinaryPath(to);
  if (!resolved) {
    runLog.finalize({ status: "not-installed", endedAt: Date.now(), exitCode: 3 });
    process.stderr.write(`error: agent "${to}" is not installed or not found on this system.
       run \`1devtool-agent list\` to see what's available.
`);
    process.exit(3);
  }
  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  process.on("SIGINT", () => controller.abort());
  if (!opts.terminal && !opts.interactive && !opts.noLink && process.env.ONEDEVTOOL_TERMINAL_ID) {
    let whoami = null;
    try {
      whoami = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/whoami", {}, 3e3);
    } catch {
    }
    const linked = (0, linkGuard_1.findLinkedPeersForAgent)(whoami, to);
    if (linked.length > 0) {
      const shimPath = node_path_1.default.join(node_os_1.default.homedir(), ".1devtool", "bin", process.platform === "win32" ? orchestrationShim_1.ORCHESTRATOR_SHIM_NAME_WIN : orchestrationShim_1.ORCHESTRATOR_SHIM_NAME_UNIX);
      const message = (0, linkGuard_1.formatLinkGuardError)(linked, to, shimPath);
      runLog.finalize({ status: "error", endedAt: Date.now(), exitCode: 1, stderr: message });
      if (opts.json) {
        process.stdout.write(JSON.stringify({
          agent: to,
          ok: false,
          error: message,
          linkedTerminalIds: linked.map((row) => row.peerTerminalId)
        }, null, 2) + "\n");
      } else {
        process.stderr.write(`error: ${message}
`);
      }
      process.exit(1);
    }
  }
  const notifier = (0, bridgeNotify_1.createDelegationNotifier)({
    callId,
    target: to,
    command: displayCommand,
    timeoutSeconds: normalizedTimeoutS
  });
  await notifier.start();
  try {
    if (opts.terminal) {
      const activationSkill = opts.skill ?? (opts.category === interactiveDelegation_1.BROWSER_ROUTING_CATEGORY ? interactiveDelegation_1.DEFAULT_BROWSER_SKILL_COMMAND : void 0);
      const started = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/team/start", {
        clientRequestId: callId,
        members: [{
          target: to,
          prompt,
          ...opts.category ? { category: opts.category } : {},
          ...opts.model ? { model: opts.model } : {},
          substrate: "terminal",
          ...activationSkill ? { skill: activationSkill } : {}
        }],
        defaultSubstrate: "terminal"
      });
      if (started.ok !== true) {
        const error = typeof started.error === "string" ? started.error : "1DevTool could not start the terminal delegate";
        await notifier.end("error", 1);
        runLog.finalize({ status: "error", endedAt: Date.now(), exitCode: 1, stderr: error });
        process.stderr.write(`error: ${error}
`);
        process.exit(1);
      }
      const runs = Array.isArray(started.runs) ? started.runs : [];
      const runId = typeof runs[0]?.runId === "string" ? runs[0].runId : "";
      if (!runId) {
        await notifier.end("error", 1);
        runLog.finalize({ status: "error", endedAt: Date.now(), exitCode: 1, stderr: "Controller returned no runId" });
        process.stderr.write("error: Agent Team controller returned no runId\n");
        process.exit(1);
      }
      if (!opts.wait) {
        const output2 = `Opened ${to} in Agent Team run ${runId}. Use collect --run=${runId} to retrieve the result.`;
        await notifier.end("done", 0);
        runLog.finalize({ status: "done", endedAt: Date.now(), exitCode: 0, output: output2 });
        process.stdout.write(opts.json ? JSON.stringify({ ok: true, terminal: true, runId, output: output2 }, null, 2) + "\n" : output2 + "\n");
        process.exit(0);
      }
      const collected = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/collect/run", {
        runId,
        timeoutMs: normalizedTimeoutS * 1e3
      }, normalizedTimeoutS * 1e3 + 5e3);
      const output = typeof collected.output === "string" ? collected.output : collected.stillRunning === true ? `Agent Team run ${runId} is still running. Re-run collect --run=${runId}.` : typeof collected.error === "string" ? collected.error : "(no output)";
      const ok = collected.ok === true || collected.stillRunning === true;
      await notifier.end(ok ? "done" : "error", ok ? 0 : 1);
      runLog.finalize({
        // This CLI wrapper invocation is complete even when the durable
        // controller run continues; the controller owns that run's record.
        status: ok ? "done" : "error",
        endedAt: Date.now(),
        exitCode: ok ? 0 : 1,
        output
      });
      process.stdout.write(opts.json ? JSON.stringify({ ...collected, runId }, null, 2) + "\n" : output + (output.endsWith("\n") ? "" : "\n"));
      process.exit(ok ? 0 : 1);
    }
    if (opts.interactive) {
      const activationCommand = opts.skill ?? (opts.category === interactiveDelegation_1.BROWSER_ROUTING_CATEGORY ? interactiveDelegation_1.DEFAULT_BROWSER_SKILL_COMMAND : void 0);
      const handoff = await (0, bridgeNotify_1.requestInteractiveDelegation)({
        callId,
        target: to,
        category: opts.category,
        model: opts.model,
        prompt,
        cwd,
        activationCommand
      });
      if (!handoff.ok) {
        await notifier.end("error", 1);
        runLog.finalize({ status: "error", endedAt: Date.now(), exitCode: 1, stderr: handoff.error });
        if (opts.json) {
          process.stdout.write(JSON.stringify({ agent: to, interactive: true, ...handoff }, null, 2) + "\n");
        } else {
          process.stderr.write(`error: ${handoff.error}
`);
        }
        process.exit(1);
      }
      const output = handoff.message ?? `Opened ${to} in interactive 1DevTool terminal ${handoff.terminalId}.`;
      await notifier.end("done", 0);
      runLog.finalize({ status: "done", endedAt: Date.now(), exitCode: 0, output });
      if (opts.json) {
        process.stdout.write(JSON.stringify({
          agent: to,
          interactive: true,
          terminalId: handoff.terminalId,
          output,
          exitCode: 0
        }, null, 2) + "\n");
      } else {
        process.stdout.write(output + "\n");
      }
      process.exit(0);
    }
    const result = await (0, runHeadlessAgent_1.runHeadlessAgent)({
      agentId: to,
      prompt,
      flags: [...modelFlags, ...opts.flag ?? []],
      timeoutSeconds,
      cwd,
      binaryPath: resolved.path,
      signal: controller.signal,
      terminalId: process.env.ONEDEVTOOL_TERMINAL_ID
    });
    await notifier.end(result.exitCode === 0 ? "done" : "error", result.exitCode);
    runLog.finalize({
      status: result.timedOut ? "timeout" : result.exitCode === 0 ? "done" : "error",
      endedAt: Date.now(),
      exitCode: result.exitCode,
      output: result.output,
      stderr: result.rawStderr ?? result.stderr,
      truncated: result.truncated
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      process.stdout.write(result.output);
      if (!result.output.endsWith("\n"))
        process.stdout.write("\n");
      if (result.exitCode !== 0 && result.stderr) {
        process.stderr.write(result.stderr + "\n");
      }
    }
    process.exit(typeof result.exitCode === "number" ? result.exitCode : 1);
  } catch (error) {
    await notifier.end("error");
    const message = error instanceof Error ? error.message : String(error);
    runLog.finalize({ status: "error", endedAt: Date.now(), stderr: message });
    process.stderr.write(`error: ${message}
`);
    process.exit(1);
  }
}
async function readStructuredInput(opts) {
  if (Boolean(opts.manifestStdin) === Boolean(opts.manifestFile)) {
    throw new Error("pass exactly one of --manifest-stdin or --manifest-file");
  }
  const text = opts.manifestStdin ? await readStdin() : await readPromptFile(opts.manifestFile);
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("manifest must be a JSON object");
  return parsed;
}
function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}
async function runControlCommand(subcommand, rest) {
  if (subcommand === "hook-event") {
    const { values, positionals } = (0, node_util_1.parseArgs)({
      args: rest,
      options: {
        event: { type: "string" },
        "payload-stdin": { type: "boolean" },
        "payload-argv": { type: "boolean" }
      },
      allowPositionals: true,
      strict: true
    });
    const event = values.event;
    if (event !== "done" && event !== "needs-input")
      return true;
    const terminalId = process.env.ONEDEVTOOL_TERMINAL_ID;
    if (!terminalId)
      return true;
    const capability = (0, hookCapability_1.readHookCapability)(node_os_1.default.homedir(), terminalId);
    const raw = values["payload-stdin"] === true ? await readStdin() : values["payload-argv"] === true ? positionals[positionals.length - 1] ?? "{}" : "{}";
    let payload = {};
    try {
      const parsed = JSON.parse(raw || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        payload = parsed;
    } catch {
      return true;
    }
    const notificationType = payload.type ?? payload.event;
    if (notificationType && !["agent-turn-complete", "Stop", "stop"].includes(String(notificationType)))
      return true;
    const sessionId = payload.session_id ?? payload["thread-id"] ?? payload.thread_id;
    const output = payload.last_assistant_message ?? payload["last-assistant-message"];
    if (!capability) {
      if (event === "done") {
        try {
          await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/terminal-hook-event", {
            event,
            ...typeof sessionId === "string" ? { sessionId } : {},
            ...typeof output === "string" ? { output } : {}
          }, 3e3);
        } catch {
        }
      }
      return true;
    }
    await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/hook-event", {
      runId: capability.runId,
      capabilityToken: capability.capabilityToken,
      event,
      ...typeof sessionId === "string" ? { sessionId } : {},
      ...typeof output === "string" ? { output } : {}
    }, 5e3);
    return true;
  }
  if (subcommand === "team" || subcommand === "swarm") {
    const action = rest[0];
    const args = rest.slice(1);
    if (action === "start") {
      const { values } = (0, node_util_1.parseArgs)({
        args,
        options: {
          "manifest-stdin": { type: "boolean" },
          "manifest-file": { type: "string" },
          "client-request-id": { type: "string" }
        },
        allowPositionals: false,
        strict: true
      });
      const manifest = await readStructuredInput({
        manifestStdin: values["manifest-stdin"] === true,
        manifestFile: values["manifest-file"]
      });
      if (typeof manifest.clientRequestId !== "string" || !manifest.clientRequestId) {
        manifest.clientRequestId = values["client-request-id"] ?? node_crypto_1.default.randomUUID();
      }
      const result = await (0, bridgeNotify_1.requestAgentOrchestration)(subcommand === "team" ? "/orchestration/team/start" : "/orchestration/swarm/start", manifest);
      printJson(result);
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (action === "status") {
      const optionName = subcommand === "team" ? "team" : "swarm";
      const { values } = (0, node_util_1.parseArgs)({
        args,
        options: { [optionName]: { type: "string" } },
        allowPositionals: false,
        strict: true
      });
      const orchestrationId = values[optionName];
      if (!orchestrationId)
        throw new Error(`--${optionName}=<id> is required`);
      const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/status", { orchestrationId });
      printJson(result);
      process.exitCode = result.ok === true && result.orchestration ? 0 : 1;
      return true;
    }
    if (subcommand === "swarm" && (action === "pause" || action === "resume")) {
      const { values } = (0, node_util_1.parseArgs)({
        args,
        options: { swarm: { type: "string" } },
        allowPositionals: false,
        strict: true
      });
      if (!values.swarm)
        throw new Error("--swarm=<id> is required");
      const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/swarm/pause", {
        swarmId: values.swarm,
        paused: action === "pause"
      });
      printJson(result);
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (subcommand === "team" && action === "list") {
      (0, node_util_1.parseArgs)({ args, options: {}, allowPositionals: false, strict: true });
      const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/team/list", {});
      printJson(result);
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (subcommand === "team" && action === "peers") {
      const { values } = (0, node_util_1.parseArgs)({
        args,
        options: { team: { type: "string" }, json: { type: "boolean" } },
        allowPositionals: false,
        strict: true
      });
      if (!values.team)
        throw new Error("--team=<id> is required");
      const result = await (0, bridgeNotify_1.requestPeerAuthenticatedOrchestration)("team-peers", {
        teamId: values.team
      });
      void values.json;
      printJson(result);
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (subcommand === "team" && action === "read") {
      const { values } = (0, node_util_1.parseArgs)({
        args,
        options: {
          team: { type: "string" },
          from: { type: "string" },
          lines: { type: "string" },
          full: { type: "boolean" },
          json: { type: "boolean" }
        },
        allowPositionals: false,
        strict: true
      });
      if (!values.team || !values.from) {
        throw new Error("--team=<id> and --from=<memberId> are required (see `1devtool-agent team peers`)");
      }
      if (values.full === true && values.lines !== void 0) {
        throw new Error("--lines cannot be combined with --full");
      }
      const maxLines = values.lines === void 0 ? void 0 : Number(values.lines);
      if (maxLines !== void 0 && (!Number.isInteger(maxLines) || maxLines < 1)) {
        throw new Error("--lines must be a positive integer");
      }
      const result = await (0, bridgeNotify_1.requestPeerAuthenticatedOrchestration)("team-read", {
        teamId: values.team,
        targetMemberId: values.from,
        ...maxLines !== void 0 ? { maxLines } : {},
        ...values.full === true ? { full: true } : {}
      });
      if (values.json === true || result.ok !== true || typeof result.body !== "string") {
        printJson(result);
      } else {
        process.stdout.write(result.body + (result.body.endsWith("\n") ? "" : "\n"));
      }
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (subcommand === "team" && action === "screen") {
      const { values } = (0, node_util_1.parseArgs)({
        args,
        options: {
          team: { type: "string" },
          from: { type: "string" },
          rows: { type: "string" },
          json: { type: "boolean" }
        },
        allowPositionals: false,
        strict: true
      });
      if (!values.team || !values.from) {
        throw new Error("--team=<id> and --from=<memberId> are required (see `1devtool-agent team peers`)");
      }
      const rows = values.rows === void 0 ? void 0 : Number(values.rows);
      if (rows !== void 0 && (!Number.isInteger(rows) || rows < 1)) {
        throw new Error("--rows must be a positive integer");
      }
      const result = await (0, bridgeNotify_1.requestPeerAuthenticatedOrchestration)("team-screen", {
        teamId: values.team,
        targetMemberId: values.from,
        ...rows !== void 0 ? { rows } : {}
      });
      if (values.json === true || result.ok !== true || typeof result.body !== "string") {
        printJson(result);
      } else {
        process.stdout.write(result.body + (result.body.endsWith("\n") ? "" : "\n"));
      }
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (subcommand === "team" && action === "notes") {
      const { values } = (0, node_util_1.parseArgs)({
        args,
        options: {
          team: { type: "string" },
          from: { type: "string" },
          lines: { type: "string" },
          json: { type: "boolean" }
        },
        allowPositionals: false,
        strict: true
      });
      if (!values.team || !values.from) {
        throw new Error("--team=<id> and --from=<memberId> are required (see `1devtool-agent team peers`)");
      }
      const maxLines = values.lines === void 0 ? void 0 : Number(values.lines);
      if (maxLines !== void 0 && (!Number.isInteger(maxLines) || maxLines < 1)) {
        throw new Error("--lines must be a positive integer");
      }
      const result = await (0, bridgeNotify_1.requestPeerAuthenticatedOrchestration)("team-notes", {
        teamId: values.team,
        targetMemberId: values.from,
        ...maxLines !== void 0 ? { maxLines } : {}
      });
      if (values.json === true || result.ok !== true || typeof result.body !== "string") {
        printJson(result);
      } else {
        process.stdout.write(result.body + (result.body.endsWith("\n") ? "" : "\n"));
      }
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (subcommand === "team" && action === "peek") {
      const { values } = (0, node_util_1.parseArgs)({
        args,
        options: {
          team: { type: "string" },
          from: { type: "string" },
          "changed-since": { type: "string" },
          json: { type: "boolean" }
        },
        allowPositionals: false,
        strict: true
      });
      if (!values.team || !values.from) {
        throw new Error("--team=<id> and --from=<memberId> are required (see `1devtool-agent team peers`)");
      }
      const result = await (0, bridgeNotify_1.requestPeerAuthenticatedOrchestration)("team-peek", {
        teamId: values.team,
        targetMemberId: values.from,
        ...values["changed-since"] ? { changedSince: values["changed-since"] } : {}
      });
      printJson(result);
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (subcommand === "team" && (action === "members" || action === "connections")) {
      const { values } = (0, node_util_1.parseArgs)({
        args,
        options: { team: { type: "string" } },
        allowPositionals: false,
        strict: true
      });
      if (!values.team)
        throw new Error("--team=<id> is required");
      const result = await (0, bridgeNotify_1.requestAgentOrchestration)(`/orchestration/team/${action}`, { teamId: values.team });
      printJson(result);
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (subcommand === "team" && (action === "send" || action === "ask")) {
      const { values } = (0, node_util_1.parseArgs)({
        args,
        options: {
          team: { type: "string" },
          to: { type: "string" },
          "submission-id": { type: "string" },
          timeout: { type: "string" },
          "prompt-stdin": { type: "boolean" },
          "prompt-file": { type: "string" }
        },
        allowPositionals: false,
        strict: true
      });
      if (!values.team || !values.to)
        throw new Error("--team=<id> and --to=<memberId> are required");
      const promptStdin = values["prompt-stdin"] === true;
      const promptFile = values["prompt-file"];
      if (promptStdin === (promptFile !== void 0))
        throw new Error("pass exactly one of --prompt-stdin or --prompt-file");
      const body = promptStdin ? await readStdin() : await readPromptFile(promptFile);
      if (!body.trim())
        throw new Error("prompt is empty");
      const timeoutS = Math.min(Math.max(Number(values.timeout ?? 0) || 0, 0), runHeadlessAgent_1.HEADLESS_MAX_TIMEOUT_S);
      const result = await (0, bridgeNotify_1.requestAgentOrchestration)(`/orchestration/team/${action}`, {
        teamId: values.team,
        toMemberId: values.to,
        clientSubmissionId: values["submission-id"] ?? node_crypto_1.default.randomUUID(),
        body,
        ...action === "ask" ? { timeoutMs: timeoutS * 1e3 } : {}
      }, action === "ask" ? timeoutS * 1e3 + 5e3 : void 0);
      printJson(result);
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (subcommand === "team" && action === "reply") {
      const { values } = (0, node_util_1.parseArgs)({
        args,
        options: {
          message: { type: "string" },
          "submission-id": { type: "string" },
          "prompt-stdin": { type: "boolean" },
          "prompt-file": { type: "string" }
        },
        allowPositionals: false,
        strict: true
      });
      if (!values.message)
        throw new Error("--message=<messageId> is required");
      const promptStdin = values["prompt-stdin"] === true;
      const promptFile = values["prompt-file"];
      if (promptStdin === (promptFile !== void 0))
        throw new Error("pass exactly one of --prompt-stdin or --prompt-file");
      const body = promptStdin ? await readStdin() : await readPromptFile(promptFile);
      if (!body.trim())
        throw new Error("prompt is empty");
      const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/team/reply", {
        messageId: values.message,
        clientSubmissionId: values["submission-id"] ?? node_crypto_1.default.randomUUID(),
        body
      });
      printJson(result);
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (subcommand === "team" && action === "messages") {
      const { values } = (0, node_util_1.parseArgs)({
        args,
        options: { team: { type: "string" }, cursor: { type: "string" }, limit: { type: "string" } },
        allowPositionals: false,
        strict: true
      });
      if (!values.team)
        throw new Error("--team=<id> is required");
      const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/team/messages", {
        teamId: values.team,
        cursor: Math.max(0, Number(values.cursor ?? 0) || 0),
        limit: Math.min(Math.max(Number(values.limit ?? 50) || 50, 1), 100)
      });
      printJson(result);
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    throw new Error(`${subcommand} requires "start", "status"${subcommand === "swarm" ? ', "pause", or "resume"' : ', "peers", "read", "screen", "notes", or "peek"'}`);
  }
  if (subcommand === "whoami") {
    (0, node_util_1.parseArgs)({ args: rest, options: {}, allowPositionals: false, strict: true });
    if (!process.env.ONEDEVTOOL_TERMINAL_ID) {
      printJson({
        ok: true,
        session: false,
        message: "not a 1DevTool session \u2014 nothing to report"
      });
      process.exitCode = 0;
      return true;
    }
    const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/whoami", {});
    printJson(result);
    process.exitCode = result.ok === true ? 0 : 1;
    return true;
  }
  if (subcommand === "report" || subcommand === "handoff") {
    const { values } = (0, node_util_1.parseArgs)({
      args: rest,
      options: {
        blocked: { type: "boolean" },
        continue: { type: "string" },
        complete: { type: "boolean" },
        "prompt-stdin": { type: "boolean" },
        "prompt-file": { type: "string" },
        wait: { type: "boolean" },
        timeout: { type: "string" }
      },
      allowPositionals: false,
      strict: true
    });
    const promptStdin = values["prompt-stdin"] === true;
    const promptFile = values["prompt-file"];
    const complete = values.complete === true;
    if (complete && subcommand === "handoff")
      throw new Error("handoff --complete is invalid because no handoff occurs");
    if (complete && (promptStdin || promptFile !== void 0 || values.blocked === true || values.continue)) {
      throw new Error("--complete is mutually exclusive with prompt input, --continue, and --blocked");
    }
    if (!complete && promptStdin === (promptFile !== void 0))
      throw new Error("pass exactly one of --prompt-stdin or --prompt-file");
    const body = complete ? "" : promptStdin ? await readStdin() : await readPromptFile(promptFile);
    const timeoutS = Math.min(Math.max(Number(values.timeout ?? 30) || 30, 0), 120);
    const waitMs = values.wait === true ? timeoutS * 1e3 : 0;
    const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/report", {
      body,
      ...values.blocked === true ? { blocked: true } : {},
      ...typeof values.continue === "string" ? { continueFromMessageId: values.continue } : {},
      ...complete ? { complete: true } : {},
      ...waitMs > 0 ? { waitMs } : {}
    }, waitMs + 15e3);
    printJson(result);
    process.exitCode = result.ok === true ? 0 : 1;
    return true;
  }
  if (subcommand === "link") {
    const action = rest[0];
    const linkRest = rest.slice(1);
    if (action === "peers") {
      const { values } = (0, node_util_1.parseArgs)({
        args: linkRest,
        options: { json: { type: "boolean" } },
        allowPositionals: false,
        strict: true
      });
      const result = await (0, bridgeNotify_1.requestPeerAuthenticatedOrchestration)("link-peers", {});
      void values.json;
      printJson(result);
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (action === "read") {
      const { values } = (0, node_util_1.parseArgs)({
        args: linkRest,
        options: {
          from: { type: "string" },
          lines: { type: "string" },
          full: { type: "boolean" },
          json: { type: "boolean" }
        },
        allowPositionals: false,
        strict: true
      });
      const targetTerminalId = values.from;
      if (!targetTerminalId)
        throw new Error("--from=<terminalId> is required (see `1devtool-agent link peers`)");
      if (values.full === true && values.lines !== void 0) {
        throw new Error("--lines cannot be combined with --full");
      }
      const maxLines = values.lines === void 0 ? void 0 : Number(values.lines);
      if (maxLines !== void 0 && (!Number.isInteger(maxLines) || maxLines < 1)) {
        throw new Error("--lines must be a positive integer");
      }
      const result = await (0, bridgeNotify_1.requestPeerAuthenticatedOrchestration)("link-read", {
        targetTerminalId,
        ...maxLines !== void 0 ? { maxLines } : {},
        ...values.full === true ? { full: true } : {}
      });
      if (values.json === true || result.ok !== true || typeof result.body !== "string") {
        printJson(result);
      } else {
        process.stdout.write(result.body + (result.body.endsWith("\n") ? "" : "\n"));
      }
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (action === "screen") {
      const { values } = (0, node_util_1.parseArgs)({
        args: linkRest,
        options: {
          from: { type: "string" },
          rows: { type: "string" },
          json: { type: "boolean" }
        },
        allowPositionals: false,
        strict: true
      });
      const targetTerminalId = values.from;
      if (!targetTerminalId)
        throw new Error("--from=<terminalId> is required (see `1devtool-agent link peers`)");
      const rows = values.rows === void 0 ? void 0 : Number(values.rows);
      if (rows !== void 0 && (!Number.isInteger(rows) || rows < 1)) {
        throw new Error("--rows must be a positive integer");
      }
      const result = await (0, bridgeNotify_1.requestPeerAuthenticatedOrchestration)("link-screen", {
        targetTerminalId,
        ...rows !== void 0 ? { rows } : {}
      });
      if (values.json === true || result.ok !== true || typeof result.body !== "string") {
        printJson(result);
      } else {
        process.stdout.write(result.body + (result.body.endsWith("\n") ? "" : "\n"));
      }
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (action === "notes") {
      const { values } = (0, node_util_1.parseArgs)({
        args: linkRest,
        options: {
          from: { type: "string" },
          lines: { type: "string" },
          json: { type: "boolean" }
        },
        allowPositionals: false,
        strict: true
      });
      const targetTerminalId = values.from;
      if (!targetTerminalId)
        throw new Error("--from=<terminalId> is required (see `1devtool-agent link peers`)");
      const maxLines = values.lines === void 0 ? void 0 : Number(values.lines);
      if (maxLines !== void 0 && (!Number.isInteger(maxLines) || maxLines < 1)) {
        throw new Error("--lines must be a positive integer");
      }
      const result = await (0, bridgeNotify_1.requestPeerAuthenticatedOrchestration)("link-notes", {
        targetTerminalId,
        ...maxLines !== void 0 ? { maxLines } : {}
      });
      if (values.json === true || result.ok !== true || typeof result.body !== "string") {
        printJson(result);
      } else {
        process.stdout.write(result.body + (result.body.endsWith("\n") ? "" : "\n"));
      }
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (action === "peek") {
      const { values } = (0, node_util_1.parseArgs)({
        args: linkRest,
        options: {
          from: { type: "string" },
          "changed-since": { type: "string" },
          json: { type: "boolean" }
        },
        allowPositionals: false,
        strict: true
      });
      const targetTerminalId = values.from;
      if (!targetTerminalId)
        throw new Error("--from=<terminalId> is required (see `1devtool-agent link peers`)");
      const result = await (0, bridgeNotify_1.requestPeerAuthenticatedOrchestration)("link-peek", {
        targetTerminalId,
        ...typeof values["changed-since"] === "string" ? { changedSince: values["changed-since"] } : {}
      });
      if (values.json === true || result.ok !== true) {
        printJson(result);
      } else {
        process.stdout.write(`${result.changed === true ? "changed" : "unchanged"} ${String(result.lastActivityAt ?? 0)} ${String(result.cursor ?? "")}
`);
      }
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (action === "publish") {
      const { values } = (0, node_util_1.parseArgs)({
        args: linkRest,
        options: {
          title: { type: "string" },
          "prompt-stdin": { type: "boolean" },
          "prompt-file": { type: "string" }
        },
        allowPositionals: false,
        strict: true
      });
      const title = values.title;
      if (!title)
        throw new Error("--title=<title> is required");
      const promptStdin = values["prompt-stdin"] === true;
      const promptFile = values["prompt-file"];
      if (promptStdin === (promptFile !== void 0)) {
        throw new Error("pass exactly one of --prompt-stdin or --prompt-file");
      }
      const body = promptStdin ? await readStdin() : await readPromptFile(promptFile);
      if (!body.trim())
        throw new Error("artifact is empty");
      const result = await (0, bridgeNotify_1.requestPeerAuthenticatedOrchestration)("link-publish-artifact", { title, body });
      printJson(result);
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (action === "request") {
      const { values } = (0, node_util_1.parseArgs)({
        args: linkRest,
        options: {
          to: { type: "string" },
          permissions: { type: "string" }
        },
        allowPositionals: false,
        strict: true
      });
      const toTerminalId = values.to;
      if (!toTerminalId)
        throw new Error("--to=<terminalId> is required");
      const permissions = typeof values.permissions === "string" ? values.permissions.split(",").map((permission) => permission.trim()).filter(Boolean) : ["send", "ask"];
      const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/link/request", {
        toTerminalId,
        permissions,
        delivery: "confirm"
      });
      printJson(result);
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (action === "send") {
      const { values } = (0, node_util_1.parseArgs)({
        args: linkRest,
        options: {
          to: { type: "string" },
          "reply-to": { type: "string" },
          // Single-use reply capability from the delivered envelope. Agents
          // whose shells are not PTY descendants (Cline's hub daemon) cannot
          // pass the ancestry gate — the token is their only attribution.
          "reply-token": { type: "string" },
          gate: { type: "string" },
          "prompt-stdin": { type: "boolean" },
          "prompt-file": { type: "string" },
          wait: { type: "boolean" },
          timeout: { type: "string" }
        },
        allowPositionals: false,
        strict: true
      });
      const toTerminalId = values.to;
      if (!toTerminalId)
        throw new Error("--to=<terminalId> is required (see `1devtool-agent whoami` for your links)");
      const promptStdin = values["prompt-stdin"] === true;
      const promptFile = values["prompt-file"];
      if (promptStdin === (promptFile !== void 0))
        throw new Error("pass exactly one of --prompt-stdin or --prompt-file");
      const body = promptStdin ? await readStdin() : await readPromptFile(promptFile);
      const timeoutS = Math.min(Math.max(Number(values.timeout ?? 30) || 30, 0), 120);
      const waitMs = values.wait === true ? timeoutS * 1e3 : 0;
      const replyToMessageId = values["reply-to"];
      const replyToken = values["reply-token"];
      const gateDecision = values.gate;
      if (gateDecision && gateDecision !== "accept" && gateDecision !== "reject") {
        throw new Error("--gate must be accept or reject");
      }
      if (gateDecision && !replyToMessageId && !replyToken) {
        throw new Error("--gate requires --reply-to or --reply-token");
      }
      const result = await (0, bridgeNotify_1.requestSandboxCompatibleAgentOrchestration)(replyToken ? "link-send-by-token" : "link-send", "/orchestration/link/send", {
        toTerminalId,
        body,
        ...waitMs > 0 ? { waitMs } : {},
        ...replyToMessageId ? { replyToMessageId } : {},
        ...replyToken ? { replyToken } : {},
        ...gateDecision ? { gateDecision } : {}
      }, waitMs + 15e3);
      printJson(result);
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (action === "status") {
      const { values } = (0, node_util_1.parseArgs)({
        args: linkRest,
        options: { message: { type: "string" } },
        allowPositionals: false,
        strict: true
      });
      const messageId = values.message;
      const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/link/status", messageId ? { messageId } : {});
      printJson(result);
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (action === "broadcast") {
      const { values } = (0, node_util_1.parseArgs)({
        args: linkRest,
        options: {
          "prompt-stdin": { type: "boolean" },
          "prompt-file": { type: "string" },
          vote: { type: "string" },
          options: { type: "string" },
          quorum: { type: "string" }
        },
        allowPositionals: false,
        strict: true
      });
      const promptStdin = values["prompt-stdin"] === true;
      const promptFile = values["prompt-file"];
      if (promptStdin === (promptFile !== void 0))
        throw new Error("pass exactly one of --prompt-stdin or --prompt-file");
      const body = promptStdin ? await readStdin() : await readPromptFile(promptFile);
      const question = values.vote;
      const optionList = typeof values.options === "string" ? values.options.split(",").map((option) => option.trim()).filter(Boolean) : void 0;
      const quorum = values.quorum !== void 0 ? Number(values.quorum) : void 0;
      if (quorum !== void 0 && !Number.isInteger(quorum))
        throw new Error("--quorum must be an integer");
      const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/link/broadcast", {
        body,
        ...question ? { vote: { question, ...optionList ? { options: optionList } : {}, ...quorum !== void 0 ? { quorum } : {} } } : {}
      }, 6e4);
      printJson(result);
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (action === "vote") {
      const { values } = (0, node_util_1.parseArgs)({
        args: linkRest,
        options: { on: { type: "string" }, value: { type: "string" }, reason: { type: "string" } },
        allowPositionals: false,
        strict: true
      });
      const decisionId = values.on;
      const value = values.value;
      if (!decisionId)
        throw new Error("--on=<decisionId> is required (see `1devtool-agent link decisions`)");
      if (!value)
        throw new Error("--value=<option> is required");
      const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/link/vote", {
        decisionId,
        value,
        ...typeof values.reason === "string" ? { reason: values.reason } : {}
      });
      printJson(result);
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (action === "decisions") {
      const { values } = (0, node_util_1.parseArgs)({
        args: linkRest,
        options: { open: { type: "boolean" } },
        allowPositionals: false,
        strict: true
      });
      const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/link/decisions", {});
      if (values.open === true && Array.isArray(result.decisions)) {
        result.decisions = result.decisions.filter((row) => row.state === "open");
      }
      printJson(result);
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    throw new Error("link supports: peers, read, screen, notes, peek, publish, request, send, status, broadcast, vote, decisions");
  }
  if (subcommand === "workspace") {
    const action = rest[0];
    const workspaceRest = rest.slice(1);
    if (action === "roster") {
      const { values } = (0, node_util_1.parseArgs)({
        args: workspaceRest,
        options: { workspace: { type: "string" }, json: { type: "boolean" } },
        allowPositionals: false,
        strict: true
      });
      const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/workspace/roster", {
        ...values.workspace ? { workspaceId: values.workspace } : {}
      });
      printJson(result);
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (action === "send") {
      const { values } = (0, node_util_1.parseArgs)({
        args: workspaceRest,
        options: {
          workspace: { type: "string" },
          to: { type: "string" },
          "prompt-stdin": { type: "boolean" },
          "prompt-file": { type: "string" },
          json: { type: "boolean" }
        },
        allowPositionals: false,
        strict: true
      });
      const to = values.to;
      if (!to)
        throw new Error("--to=<terminalId|name|project:<id|name>> is required (see `workspace roster`)");
      const promptStdin = values["prompt-stdin"] === true;
      const promptFile = values["prompt-file"];
      if (promptStdin === (promptFile !== void 0))
        throw new Error("pass exactly one of --prompt-stdin or --prompt-file");
      const message = promptStdin ? await readStdin() : await readPromptFile(promptFile);
      const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/workspace/send", {
        to,
        message,
        ...values.workspace ? { workspaceId: values.workspace } : {}
      });
      printJson(result);
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (action === "broadcast") {
      const { values } = (0, node_util_1.parseArgs)({
        args: workspaceRest,
        options: {
          workspace: { type: "string" },
          "prompt-stdin": { type: "boolean" },
          "prompt-file": { type: "string" },
          "include-self": { type: "boolean" },
          limit: { type: "string" },
          json: { type: "boolean" }
        },
        allowPositionals: false,
        strict: true
      });
      const promptStdin = values["prompt-stdin"] === true;
      const promptFile = values["prompt-file"];
      if (promptStdin === (promptFile !== void 0))
        throw new Error("pass exactly one of --prompt-stdin or --prompt-file");
      const message = promptStdin ? await readStdin() : await readPromptFile(promptFile);
      const limit = values.limit !== void 0 ? Number(values.limit) : void 0;
      if (limit !== void 0 && (!Number.isInteger(limit) || limit < 1))
        throw new Error("--limit must be a positive integer");
      const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/workspace/broadcast", {
        message,
        ...values.workspace ? { workspaceId: values.workspace } : {},
        ...values["include-self"] === true ? { excludeSelf: false } : {},
        ...limit !== void 0 ? { limit } : {}
      });
      printJson(result);
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (action === "collect") {
      const { values } = (0, node_util_1.parseArgs)({
        args: workspaceRest,
        options: {
          operation: { type: "string" },
          timeout: { type: "string" },
          json: { type: "boolean" }
        },
        allowPositionals: false,
        strict: true
      });
      const operationId = values.operation;
      if (!operationId)
        throw new Error("--operation=<wop-\u2026> is required \u2014 collect correlates strictly by the operation id printed by send/broadcast");
      const timeoutS = values.timeout !== void 0 ? Number(values.timeout) : void 0;
      if (timeoutS !== void 0 && (!Number.isFinite(timeoutS) || timeoutS < 0))
        throw new Error("--timeout must be seconds \u2265 0");
      const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/workspace/collect", {
        operationId,
        ...timeoutS !== void 0 ? { timeoutSeconds: timeoutS } : {}
      }, Math.min(timeoutS ?? 0, 300) * 1e3 + 15e3);
      printJson(result);
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    if (action === "operation") {
      const { values } = (0, node_util_1.parseArgs)({
        args: workspaceRest,
        options: { id: { type: "string" }, json: { type: "boolean" } },
        allowPositionals: false,
        strict: true
      });
      const operationId = values.id;
      if (!operationId)
        throw new Error("--id=<wop-\u2026> is required");
      const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/workspace/operation", { operationId });
      printJson(result);
      process.exitCode = result.ok === true ? 0 : 1;
      return true;
    }
    throw new Error("workspace supports: roster, send, broadcast, collect, operation");
  }
  if (subcommand === "send") {
    const { values } = (0, node_util_1.parseArgs)({
      args: rest,
      options: {
        team: { type: "string" },
        member: { type: "string" },
        "submission-id": { type: "string" },
        "prompt-stdin": { type: "boolean" },
        "prompt-file": { type: "string" }
      },
      allowPositionals: false,
      strict: true
    });
    const teamId = values.team;
    const memberId = values.member;
    if (!teamId || !memberId)
      throw new Error("--team and --member are required");
    const submissionId = values["submission-id"] ?? node_crypto_1.default.randomUUID();
    const promptStdin = values["prompt-stdin"] === true;
    const promptFile = values["prompt-file"];
    if (promptStdin === (promptFile !== void 0))
      throw new Error("pass exactly one of --prompt-stdin or --prompt-file");
    const prompt = promptStdin ? await readStdin() : await readPromptFile(promptFile);
    const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/send", { teamId, memberId, submissionId, prompt });
    printJson(result);
    process.exitCode = result.ok === true ? 0 : 1;
    return true;
  }
  if (subcommand === "collect") {
    const { values } = (0, node_util_1.parseArgs)({
      args: rest,
      options: {
        run: { type: "string" },
        swarm: { type: "string" },
        timeout: { type: "string" },
        cursor: { type: "string" },
        limit: { type: "string" },
        json: { type: "boolean" }
      },
      allowPositionals: false,
      strict: true
    });
    const runId = values.run;
    const swarmId = values.swarm;
    if (!!runId === !!swarmId)
      throw new Error("pass exactly one of --run or --swarm");
    const timeoutS = Math.min(Math.max(Number(values.timeout ?? 0) || 0, 0), runHeadlessAgent_1.HEADLESS_MAX_TIMEOUT_S);
    const result = runId ? await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/collect/run", { runId, timeoutMs: timeoutS * 1e3 }, timeoutS * 1e3 + 5e3) : await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/collect/swarm", {
      swarmId,
      cursor: Math.max(0, Number(values.cursor ?? 0) || 0),
      limit: Math.min(Math.max(Number(values.limit ?? 20) || 20, 1), 50)
    });
    if (values.json === true || swarmId || typeof result.output !== "string")
      printJson(result);
    else
      process.stdout.write(result.output + (result.output.endsWith("\n") ? "" : "\n"));
    process.exitCode = result.ok === true ? 0 : result.stillRunning === true ? 0 : 1;
    return true;
  }
  if (subcommand === "stop") {
    const { values } = (0, node_util_1.parseArgs)({
      args: rest,
      options: {
        team: { type: "string" },
        swarm: { type: "string" },
        "close-terminals": { type: "boolean" },
        "finish-running": { type: "boolean" }
      },
      allowPositionals: false,
      strict: true
    });
    const id = values.team ?? values.swarm;
    if (!id || !!values.team && !!values.swarm)
      throw new Error("pass exactly one of --team or --swarm");
    if (values["finish-running"] === true && !values.swarm)
      throw new Error("--finish-running requires --swarm=<id>");
    if (values["finish-running"] === true && values["close-terminals"] === true) {
      throw new Error("choose either --finish-running or --close-terminals");
    }
    const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/stop", {
      orchestrationId: id,
      closeTerminals: values["close-terminals"] === true,
      finishRunning: values["finish-running"] === true
    });
    printJson(result);
    process.exitCode = result.ok === true ? 0 : 1;
    return true;
  }
  if (subcommand === "fallback") {
    const { values } = (0, node_util_1.parseArgs)({
      args: rest,
      options: { run: { type: "string" }, action: { type: "string" }, target: { type: "string" } },
      allowPositionals: false,
      strict: true
    });
    const action = String(values.action ?? "");
    if (!values.run || !["retry", "headless", "reassign", "skip", "close"].includes(action)) {
      throw new Error("--run=<id> and --action=retry|headless|reassign|skip|close are required");
    }
    if (action === "reassign" && !values.target)
      throw new Error("--target=<agent> is required for reassign");
    const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/resolve-fallback", {
      runId: values.run,
      action,
      ...values.target ? { target: values.target } : {}
    });
    printJson(result);
    process.exitCode = result.ok === true ? 0 : 1;
    return true;
  }
  if (subcommand === "promote") {
    const { values } = (0, node_util_1.parseArgs)({
      args: rest,
      options: { swarm: { type: "string" }, worker: { type: "string" } },
      allowPositionals: false,
      strict: true
    });
    if (!values.swarm || !values.worker)
      throw new Error("--swarm=<id> and --worker=<id> are required");
    const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/promote-worker", {
      swarmId: values.swarm,
      workerId: values.worker
    });
    printJson(result);
    process.exitCode = result.ok === true ? 0 : 1;
    return true;
  }
  if (subcommand === "confirm-submit") {
    const { values } = (0, node_util_1.parseArgs)({ args: rest, options: { run: { type: "string" } }, allowPositionals: false, strict: true });
    if (!values.run)
      throw new Error("--run=<id> is required");
    const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/confirm-submit", { runId: values.run });
    printJson(result);
    process.exitCode = result.ok === true ? 0 : 1;
    return true;
  }
  if (subcommand === "resolve") {
    const { values } = (0, node_util_1.parseArgs)({
      args: rest,
      options: { run: { type: "string" }, outcome: { type: "string" } },
      allowPositionals: false,
      strict: true
    });
    if (!values.run || !["done", "error", "cancelled"].includes(String(values.outcome))) {
      throw new Error("--run=<id> and --outcome=done|error|cancelled are required");
    }
    const result = await (0, bridgeNotify_1.requestAgentOrchestration)("/orchestration/resolve-confirmation", {
      runId: values.run,
      outcome: values.outcome
    });
    printJson(result);
    process.exitCode = result.ok === true ? 0 : 1;
    return true;
  }
  return false;
}
async function runTerminalCommand(args) {
  const action = args[0];
  const rest = args.slice(1);
  if (action === "ssh-host") {
    if (rest.length > 0)
      throw new Error("ssh-host accepts no flags; transport requests over stdin");
    await (0, sshTerminalHost_1.runSshTerminalHost)();
    return;
  }
  if (action === "list") {
    const { values } = (0, node_util_1.parseArgs)({
      args: rest,
      options: { json: { type: "boolean" } },
      allowPositionals: false,
      strict: true
    });
    await (0, terminalAttachClient_1.listLocalTerminals)(values.json === true);
    return;
  }
  if (action === "view" || action === "attach") {
    const { values } = (0, node_util_1.parseArgs)({
      args: rest,
      options: { id: { type: "string" } },
      allowPositionals: false,
      strict: true
    });
    if (!values.id)
      throw new Error("terminal id is required (`--id=<terminalId>`)");
    await (0, terminalAttachClient_1.attachLocalTerminal)(values.id);
    return;
  }
  if (action === "submit") {
    const { values } = (0, node_util_1.parseArgs)({
      args: rest,
      options: {
        id: { type: "string" },
        "prompt-stdin": { type: "boolean" }
      },
      allowPositionals: false,
      strict: true
    });
    if (!values.id)
      throw new Error("terminal id is required (`--id=<terminalId>`)");
    if (values["prompt-stdin"] !== true)
      throw new Error("semantic submit requires --prompt-stdin");
    const prompt = await readStdin();
    if (!prompt)
      throw new Error("prompt stdin is empty");
    await (0, terminalAttachClient_1.submitLocalTerminalPrompt)(values.id, prompt);
    return;
  }
  throw new Error("usage: onedevtool terminal list|view|attach|submit");
}
function printHelp() {
  process.stdout.write(`1devtool-agent \u2014 delegate prompts to other AI coding CLIs

Usage:
  onedevtool terminal list [--json]
  onedevtool terminal view --id=<terminalId>
  onedevtool terminal attach --id=<terminalId>  # view-only alias
  onedevtool terminal submit --id=<terminalId> --prompt-stdin
  onedevtool terminal ssh-host  # explicit Node + node-pty NDJSON helper
  1devtool-agent list [--json]
  1devtool-agent run --to=<agent> --prompt-stdin [options]
  1devtool-agent run --to=<agent> --prompt-file=<path> [options]
  1devtool-agent team start --manifest-stdin
  1devtool-agent team status --team=<id>
  1devtool-agent team list
  1devtool-agent team members --team=<id>
  1devtool-agent team connections --team=<id>
  1devtool-agent team peers --team=<id> [--json]
  1devtool-agent team read --team=<id> --from=<memberId> [--lines=40|--full] [--json]
  1devtool-agent team screen --team=<id> --from=<memberId> [--rows=200] [--json]
  1devtool-agent team notes --team=<id> --from=<memberId> [--lines=80] [--json]
  1devtool-agent team peek --team=<id> --from=<memberId> [--changed-since=<cursor>] [--json]
  1devtool-agent team send --team=<id> --to=<memberId> --submission-id=<uuid> --prompt-stdin
  1devtool-agent team ask --team=<id> --to=<memberId> --submission-id=<uuid> --prompt-stdin [--timeout=<seconds>]
  1devtool-agent team reply --message=<id> --submission-id=<uuid> --prompt-stdin
  1devtool-agent team messages --team=<id> [--cursor=0 --limit=50]
  1devtool-agent swarm start --manifest-stdin
  1devtool-agent swarm status --swarm=<id>
  1devtool-agent swarm pause --swarm=<id>
  1devtool-agent swarm resume --swarm=<id>
  1devtool-agent send --team=<id> --member=<id> --submission-id=<uuid> --prompt-stdin
  1devtool-agent whoami
  1devtool-agent link peers [--json]
  1devtool-agent link read --from=<terminalId> [--lines=40|--full] [--json]
  1devtool-agent link screen --from=<terminalId> [--rows=200] [--json]
  1devtool-agent link notes --from=<terminalId> [--lines=80] [--json]
  1devtool-agent link peek --from=<terminalId> [--changed-since=<cursor>] [--json]
  1devtool-agent link publish --title=<title> --prompt-stdin
  1devtool-agent link request --to=<terminalId> [--permissions=send,ask]
                              (kinds: send, ask, share-artifact, read-transcript,
                               read-transcript-full, read-screen, read-artifact;
                               read-* needs the user's consent review at approval)
  1devtool-agent link send --to=<terminalId> --prompt-stdin [--reply-to=<messageId>] [--reply-token=<token>] [--gate=accept|reject] [--wait] [--timeout=<seconds>]
  1devtool-agent link status [--message=<id>]
  1devtool-agent report --prompt-stdin [--continue=<accepted-input-message-id>] [--blocked] [--wait] [--timeout=<seconds>]
  1devtool-agent handoff --prompt-stdin [--continue=<accepted-input-message-id>] [--blocked] [--wait] [--timeout=<seconds>]
  1devtool-agent report --complete
                              (hierarchy: reports upward; Pipeline: typed forward handoff,
                               bounded gate escalation, or final-stage completion)
  1devtool-agent link broadcast --prompt-stdin [--vote=<question>] [--options=a,b] [--quorum=<n>]
  1devtool-agent link vote --on=<decisionId> --value=<option> [--reason=<text>]
  1devtool-agent link decisions [--open]
  1devtool-agent workspace roster [--workspace=<id>] [--json]
  1devtool-agent workspace send --to=<terminalId|name|project:<id|name>> --prompt-stdin [--workspace=<id>]
  1devtool-agent workspace broadcast --prompt-stdin [--workspace=<id>] [--include-self] [--limit=16]
  1devtool-agent workspace collect --operation=<wop-id> [--timeout=<seconds>]
  1devtool-agent workspace operation --id=<wop-id>
  1devtool-agent collect --run=<id> [--timeout=<seconds>]
  1devtool-agent collect --swarm=<id> [--cursor=0 --limit=20]
  1devtool-agent fallback --run=<id> --action=retry|headless|reassign|skip|close
  1devtool-agent promote --swarm=<id> --worker=<id>
  1devtool-agent stop --team=<id>|--swarm=<id> [--close-terminals|--finish-running]

Agents:
  ${KNOWN_AGENT_IDS.join(", ")}

Run options:
  --to=<agent>           Target agent (required)
  --prompt-stdin         Read prompt from stdin (required, or use --prompt-file)
  --prompt-file=<path>   Read prompt from file (must be in cwd or $TMPDIR; no symlinks)
  --timeout=<seconds>    Max wait, 5..600 (default ${runHeadlessAgent_1.HEADLESS_DEFAULT_TIMEOUT_S})
  --cwd=<dir>            Working dir for the target agent (default: current cwd)
  --model=<id>           Model for the target agent (mapped to its own model
                         flag, e.g. claude: sonnet | opus; codex: gpt-5.6-sol
                         or gpt-5.6-sol:xhigh; opencode: provider/model)
  --category=<slug>      Task category for run attribution (e.g. test, plan);
                         lowercase slug, recorded in the local run history
  --interactive          Open a visible 1DevTool agent terminal and return once
                         the task is handed off instead of running headlessly
  --terminal             Run in a visible, controller-owned Agent Team terminal
  --wait                 With --terminal, wait for the correlated result
  --skill=/<name>        Slash skill invoked with the task in that terminal;
                         requires --terminal (browser routes use /chrome)
  --flag=<f>             Extra flag passed to the target CLI; repeatable
  --json                 Emit JSON envelope instead of plain text
  --no-link              Force a fresh headless run even when an active link
                         to an open terminal of the target agent exists
                         (default: run fails fast with the link send command)

Safety: there is no --prompt=<text> flag. Always pipe the prompt to stdin.
`);
}
async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    return;
  }
  const subcommand = argv[0];
  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    printHelp();
    return;
  }
  if (subcommand === "list") {
    const { values } = (0, node_util_1.parseArgs)({
      args: rest,
      options: { json: { type: "boolean" } },
      allowPositionals: false,
      strict: true
    });
    listAgents(values.json === true);
    return;
  }
  if (subcommand === "terminal") {
    await runTerminalCommand(rest);
    return;
  }
  if (subcommand === "run") {
    let values;
    try {
      ({ values } = (0, node_util_1.parseArgs)({
        args: rest,
        options: {
          to: { type: "string" },
          "prompt-stdin": { type: "boolean" },
          "prompt-file": { type: "string" },
          timeout: { type: "string" },
          cwd: { type: "string" },
          model: { type: "string" },
          category: { type: "string" },
          flag: { type: "string", multiple: true },
          interactive: { type: "boolean" },
          terminal: { type: "boolean" },
          wait: { type: "boolean" },
          skill: { type: "string" },
          json: { type: "boolean" },
          "no-link": { type: "boolean" }
        },
        allowPositionals: false,
        strict: true
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`error: ${message}
`);
      process.stderr.write("run `1devtool-agent --help` for accepted options.\n");
      if (message.includes("'--")) {
        process.stderr.write('if this option is documented but rejected, this 1devtool-agent build may be\nolder than the orchestration skill \u2014 update 1DevTool or use Settings \u2192 AI \u2192\nOrchestration \u2192 "Reinstall orchestration". Unrecognized target-CLI flags can\nbe passed through as `--flag=<f>` (repeatable).\n');
      }
      process.exit(2);
    }
    await runAgentCommand({
      to: values.to,
      promptStdin: values["prompt-stdin"] === true,
      promptFile: values["prompt-file"],
      timeout: values.timeout,
      cwd: values.cwd,
      model: values.model,
      category: values.category,
      flag: values.flag,
      interactive: values.interactive === true,
      terminal: values.terminal === true,
      noLink: values["no-link"] === true,
      wait: values.wait === true,
      skill: values.skill,
      json: values.json === true
    });
    return;
  }
  try {
    if (await runControlCommand(subcommand, rest))
      return;
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}
`);
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`unknown subcommand: ${subcommand}
`);
  printHelp();
  process.exit(2);
}
main().catch((error) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}
`);
  process.exit(1);
});
void node_child_process_1.execFile;
