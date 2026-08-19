"use strict";
/**
 * Curated registry of CLIs the app knows how to detect and version.
 * See docs/features/channels/cli-subprocess.md §3.6.
 *
 * Adding a new CLI: append to KNOWN_CLIS. Keep entries narrow — version-check
 * args must be cheap (no network, no project scan). Binaries list .cmd shims
 * first on Windows so the scanner finds them before unsuffixed lookups.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.KNOWN_CLIS = void 0;
exports.findKnownCli = findKnownCli;
exports.defaultSpawnLabel = defaultSpawnLabel;
exports.KNOWN_CLIS = [
    // ── AI agents ────────────────────────────────────────────────────────────
    // Fallback paths verified from each agent's official docs (see commit msg
    // for source URLs). Order is "most common first" so a quick fs.access
    // finds the binary on the first probe.
    {
        id: 'claude',
        displayName: 'Claude Code',
        category: 'ai-agent',
        binaries: ['claude', 'claude.cmd'],
        versionArgs: ['--version'],
        defaultSpawnArgs: ['--dangerously-skip-permissions'],
        installHint: { mac: 'https://claude.com/install', linux: 'https://claude.com/install', win: 'https://claude.com/install' },
        // Native installer drops the binary in `~/.local/bin/claude` (with a
        // symlink in `~/.claude/bin/`); npm-global users land elsewhere.
        fallbackPaths: {
            mac: [
                '~/.local/bin/claude',
                '~/.claude/bin/claude',
                '~/.claude/local/claude',
                '/opt/homebrew/bin/claude',
                '/usr/local/bin/claude',
                '~/.npm-global/bin/claude',
            ],
            linux: [
                '~/.local/bin/claude',
                '~/.claude/bin/claude',
                '~/.claude/local/claude',
                '/usr/local/bin/claude',
                '~/.npm-global/bin/claude',
            ],
            win: [
                '%USERPROFILE%\\.local\\bin\\claude.exe',
                '%USERPROFILE%\\.claude\\bin\\claude.exe',
                '%APPDATA%\\npm\\claude.cmd',
            ],
        },
    },
    {
        id: 'codex',
        displayName: 'OpenAI Codex',
        category: 'ai-agent',
        binaries: ['codex', 'codex.cmd'],
        versionArgs: ['--version'],
        defaultSpawnArgs: ['--dangerously-bypass-approvals-and-sandbox'],
        installHint: { mac: 'https://github.com/openai/codex', linux: 'https://github.com/openai/codex', win: 'https://github.com/openai/codex' },
        // Codex stores config + sessions under `~/.codex/` but the binary itself
        // typically lives in npm-global or homebrew (per OpenAI docs).
        fallbackPaths: {
            mac: [
                '/opt/homebrew/bin/codex',
                '/usr/local/bin/codex',
                '~/.codex/bin/codex',
                '~/.local/bin/codex',
                '~/.npm-global/bin/codex',
            ],
            linux: [
                '/usr/local/bin/codex',
                '~/.local/bin/codex',
                '~/.codex/bin/codex',
                '~/.npm-global/bin/codex',
            ],
            win: [
                '%APPDATA%\\npm\\codex.cmd',
                '%USERPROFILE%\\.codex\\bin\\codex.exe',
                '%LOCALAPPDATA%\\Programs\\codex\\codex.exe',
            ],
        },
    },
    {
        id: 'gemini',
        displayName: 'Gemini CLI',
        category: 'ai-agent',
        binaries: ['gemini', 'gemini.cmd'],
        versionArgs: ['--version'],
        defaultSpawnArgs: ['-y'],
        installHint: { mac: 'https://github.com/google-gemini/gemini-cli', linux: 'https://github.com/google-gemini/gemini-cli', win: 'https://github.com/google-gemini/gemini-cli' },
        // `npm install -g @google/gemini-cli` is the only documented install path.
        fallbackPaths: {
            mac: [
                '/opt/homebrew/bin/gemini',
                '/usr/local/bin/gemini',
                '~/.npm-global/bin/gemini',
                '~/.local/bin/gemini',
            ],
            linux: [
                '/usr/local/bin/gemini',
                '~/.npm-global/bin/gemini',
                '~/.local/bin/gemini',
            ],
            win: [
                '%APPDATA%\\npm\\gemini.cmd',
                '%USERPROFILE%\\.npm-global\\gemini.cmd',
            ],
        },
    },
    {
        id: 'agy',
        displayName: 'Antigravity',
        category: 'ai-agent',
        binaries: ['agy', 'agy.cmd'],
        versionArgs: ['--version'],
        // Verified against agy 1.1.10 --help. Without it a delegated agy stalls
        // invisibly on its "Requesting permission for:" dialog (field report).
        defaultSpawnArgs: ['--dangerously-skip-permissions'],
        fallbackPaths: {
            mac: [
                '~/.local/bin/agy',
                '/opt/homebrew/bin/agy',
                '/usr/local/bin/agy',
            ],
            linux: [
                '~/.local/bin/agy',
                '/usr/local/bin/agy',
            ],
            win: [
                '%USERPROFILE%\\.local\\bin\\agy.exe',
                '%APPDATA%\\npm\\agy.cmd',
            ],
        },
    },
    {
        id: 'kimi',
        displayName: 'Kimi Code',
        category: 'ai-agent',
        binaries: ['kimi', 'kimi.cmd', 'kimi.exe'],
        versionArgs: ['--version'],
        installHint: { mac: 'https://github.com/MoonshotAI/kimi-code', linux: 'https://github.com/MoonshotAI/kimi-code', win: 'https://github.com/MoonshotAI/kimi-code' },
        fallbackPaths: {
            mac: [
                '~/.local/bin/kimi',
                '~/.kimi-code/bin/kimi',
                '/opt/homebrew/bin/kimi',
                '/usr/local/bin/kimi',
            ],
            linux: [
                '~/.local/bin/kimi',
                '~/.kimi-code/bin/kimi',
                '/usr/local/bin/kimi',
            ],
            win: [
                '%USERPROFILE%\\.local\\bin\\kimi.exe',
                '%USERPROFILE%\\.kimi-code\\bin\\kimi.exe',
                '%APPDATA%\\npm\\kimi.cmd',
            ],
        },
    },
    {
        id: 'amp',
        displayName: 'Amp',
        category: 'ai-agent',
        binaries: ['amp', 'amp.cmd'],
        versionArgs: ['--version'],
        defaultSpawnArgs: ['--dangerously-allow-all'],
        installHint: { mac: 'https://ampcode.com/manual', linux: 'https://ampcode.com/manual', win: 'https://ampcode.com/manual' },
        // `npm install -g @sourcegraph/amp` is the canonical install method;
        // config lives at `~/.config/amp/settings.json`.
        fallbackPaths: {
            mac: [
                '/opt/homebrew/bin/amp',
                '/usr/local/bin/amp',
                '~/.npm-global/bin/amp',
                '~/.local/bin/amp',
            ],
            linux: [
                '/usr/local/bin/amp',
                '~/.npm-global/bin/amp',
                '~/.local/bin/amp',
            ],
            win: [
                '%APPDATA%\\npm\\amp.cmd',
            ],
        },
    },
    {
        id: 'opencode',
        displayName: 'OpenCode',
        category: 'ai-agent',
        binaries: ['opencode', 'opencode.cmd'],
        versionArgs: ['--version'],
        defaultSpawnArgs: ['--dangerously-skip-permissions'],
        installHint: { mac: 'https://opencode.ai/docs/troubleshooting/', linux: 'https://opencode.ai/docs/troubleshooting/', win: 'https://opencode.ai/docs/troubleshooting/' },
        // Install-script priority per https://opencode.ai/docs/:
        //   $OPENCODE_INSTALL_DIR → $XDG_BIN_DIR → ~/bin → ~/.opencode/bin
        // Default install script lands at `~/.local/bin/opencode`. Windows users
        // typically run via WSL, Scoop, or Chocolatey.
        fallbackPaths: {
            mac: [
                '~/.local/bin/opencode',
                '~/.opencode/bin/opencode',
                '~/bin/opencode',
                '/opt/homebrew/bin/opencode',
                '/usr/local/bin/opencode',
                '~/.npm-global/bin/opencode',
            ],
            linux: [
                '~/.local/bin/opencode',
                '~/.opencode/bin/opencode',
                '~/bin/opencode',
                '/usr/local/bin/opencode',
                '~/.npm-global/bin/opencode',
            ],
            win: [
                '%USERPROFILE%\\scoop\\apps\\opencode\\current\\opencode.exe',
                '%USERPROFILE%\\.opencode\\bin\\opencode.exe',
                '%LOCALAPPDATA%\\opencode\\bin\\opencode.exe',
                '%APPDATA%\\npm\\opencode.cmd',
                // WSL — accessed from Windows as a fallback if scanner runs in WSL.
                '%USERPROFILE%\\.local\\bin\\opencode.exe',
            ],
        },
    },
    {
        id: 'qwen',
        displayName: 'Qwen Code',
        category: 'ai-agent',
        binaries: ['qwen', 'qwen.cmd'],
        versionArgs: ['--version'],
        defaultSpawnArgs: ['--yolo'],
        installHint: { mac: 'https://github.com/QwenLM/qwen-code', linux: 'https://github.com/QwenLM/qwen-code', win: 'https://github.com/QwenLM/qwen-code' },
        // `npm install -g @qwen-code/qwen-code` or `brew install qwen-code`.
        fallbackPaths: {
            mac: [
                '/opt/homebrew/bin/qwen',
                '/usr/local/bin/qwen',
                '~/.npm-global/bin/qwen',
                '~/.local/bin/qwen',
            ],
            linux: [
                '/usr/local/bin/qwen',
                '~/.npm-global/bin/qwen',
                '~/.local/bin/qwen',
            ],
            win: [
                '%APPDATA%\\npm\\qwen.cmd',
            ],
        },
    },
    {
        id: 'grok',
        displayName: 'Grok CLI',
        category: 'ai-agent',
        binaries: ['grok', 'grok.cmd'],
        versionArgs: ['--version'],
        defaultSpawnArgs: ['--always-approve'],
        installHint: { mac: 'https://docs.x.ai/build/overview', linux: 'https://docs.x.ai/build/overview', win: 'https://docs.x.ai/build/overview' },
        // Grok Build (xAI's agent CLI) installs to `~/.grok/bin/grok` by default
        // (GROK_HOME overrides the base dir); npm/homebrew users land elsewhere.
        fallbackPaths: {
            mac: [
                '~/.grok/bin/grok',
                '/opt/homebrew/bin/grok',
                '/usr/local/bin/grok',
                '~/.local/bin/grok',
                '~/.npm-global/bin/grok',
            ],
            linux: [
                '~/.grok/bin/grok',
                '/usr/local/bin/grok',
                '~/.local/bin/grok',
                '~/.npm-global/bin/grok',
            ],
            win: [
                '%USERPROFILE%\\.grok\\bin\\grok.exe',
                '%APPDATA%\\npm\\grok.cmd',
                '%LOCALAPPDATA%\\Programs\\grok\\grok.exe',
            ],
        },
    },
    {
        id: 'cline',
        displayName: 'Cline',
        category: 'ai-agent',
        binaries: ['cline', 'cline.cmd', 'cline.exe'],
        versionArgs: ['--version'],
        defaultSpawnArgs: ['--auto-approve', 'true'],
        installHint: { mac: 'https://docs.cline.bot', linux: 'https://docs.cline.bot', win: 'https://docs.cline.bot' },
        // Cline commonly installs as an npm-style global binary. Probe the same
        // locations 1AIVault uses, including stale Electron PATH misses.
        fallbackPaths: {
            mac: [
                '/opt/homebrew/bin/cline',
                '/usr/local/bin/cline',
                '/usr/bin/cline',
                '~/.local/bin/cline',
                '~/.npm-global/bin/cline',
                '~/.bun/bin/cline',
                '~/.volta/bin/cline',
                '~/Library/pnpm/cline',
            ],
            linux: [
                '/usr/local/bin/cline',
                '/usr/bin/cline',
                '~/.local/bin/cline',
                '~/.npm-global/bin/cline',
                '~/.bun/bin/cline',
                '~/.volta/bin/cline',
                '~/.local/share/pnpm/cline',
            ],
            win: [
                '%PNPM_HOME%\\cline.cmd',
                '%NVM_SYMLINK%\\cline.cmd',
                '%APPDATA%\\npm\\cline.cmd',
                '%APPDATA%\\npm\\cline.exe',
                'C:\\Program Files\\nodejs\\cline.cmd',
                'C:\\Program Files\\nodejs\\cline.exe',
                '%USERPROFILE%\\.local\\bin\\cline.exe',
                '%USERPROFILE%\\.bun\\bin\\cline.exe',
                '%LOCALAPPDATA%\\pnpm\\cline.cmd',
                '%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\cline.exe',
                '%LOCALAPPDATA%\\Volta\\bin\\cline.cmd',
                '%LOCALAPPDATA%\\mise\\shims\\cline.cmd',
                '%USERPROFILE%\\scoop\\shims\\cline.exe',
                '%ProgramData%\\chocolatey\\bin\\cline.exe',
            ],
        },
    },
    {
        id: 'hermes',
        displayName: 'Hermes Agent',
        category: 'ai-agent',
        binaries: ['hermes', 'hermes.cmd', 'hermes.exe'],
        versionArgs: ['--version'],
        defaultSpawnArgs: ['--yolo'],
        installHint: {
            mac: 'https://github.com/NousResearch/hermes-agent',
            linux: 'https://github.com/NousResearch/hermes-agent',
            win: 'https://github.com/NousResearch/hermes-agent',
        },
        fallbackPaths: {
            mac: [
                '~/.local/bin/hermes',
                '/opt/homebrew/bin/hermes',
                '/usr/local/bin/hermes',
            ],
            linux: [
                '~/.local/bin/hermes',
                '/usr/local/bin/hermes',
            ],
            win: [
                '%USERPROFILE%\\.local\\bin\\hermes.exe',
                '%USERPROFILE%\\.local\\bin\\hermes.cmd',
                '%APPDATA%\\Python\\Scripts\\hermes.exe',
            ],
        },
    },
    {
        // id is the delegate/HEADLESS_SPECS key; `binaries` holds the real
        // executables. Never add bare `cursor` here — that is the editor launcher.
        //
        // Cursor renamed the user-facing command to `agent`
        // (https://cursor.com/docs/cli/overview) but kept shipping the executable
        // as `cursor-agent`: the installer now creates BOTH `~/.local/bin/agent`
        // (primary) and `~/.local/bin/cursor-agent` (explicitly labelled legacy),
        // and on Windows copies `cursor-agent.exe` to `agent.exe`. Detect either
        // spelling so neither the legacy alias disappearing nor a docs-following
        // install can make an installed Cursor read as missing.
        id: 'cursor',
        displayName: 'Cursor CLI',
        category: 'ai-agent',
        binaries: [
            'cursor-agent', 'cursor-agent.cmd', 'cursor-agent.exe',
            'agent', 'agent.cmd', 'agent.exe',
        ],
        // `agent` is not Cursor's alone — xAI's Grok CLI installs `~/.grok/bin/agent`,
        // and whichever PATH entry comes first wins the lookup. Require proof:
        // Cursor's --version is a calver build id (`2026.07.23-e383d2b`), and its
        // `agent` symlink resolves into `.../cursor-agent/versions/<v>/cursor-agent`.
        sharedBinaries: ['agent'],
        identityPattern: '^\\s*\\d{4}\\.\\d{2}\\.\\d{2}\\b|cursor',
        identityPathPattern: 'cursor-agent',
        versionArgs: ['--version'],
        // `-f, --force  Force allow commands unless explicitly denied` (verified
        // against the installed CLI; `--yolo` is its alias) — same unattended-
        // delegation posture as every other agent's defaultSpawnArgs.
        defaultSpawnArgs: ['--force'],
        installHint: {
            mac: 'curl https://cursor.com/install -fsS | bash',
            linux: 'curl https://cursor.com/install -fsS | bash',
            win: 'https://cursor.com/docs/cli/installation',
        },
        fallbackPaths: {
            mac: [
                '~/.local/bin/cursor-agent',
                '~/.local/bin/agent',
                '/opt/homebrew/bin/cursor-agent',
                '/usr/local/bin/cursor-agent',
            ],
            linux: [
                '~/.local/bin/cursor-agent',
                '~/.local/bin/agent',
                '/usr/local/bin/cursor-agent',
            ],
            // The Windows installer unpacks into %LOCALAPPDATA%\cursor-agent and puts
            // that directory on PATH; it never writes to %USERPROFILE%\.local\bin,
            // which is where this list used to look (so a Windows user whose PATH
            // hadn't refreshed yet was never found at all).
            win: [
                '%LOCALAPPDATA%\\cursor-agent\\cursor-agent.exe',
                '%LOCALAPPDATA%\\cursor-agent\\agent.exe',
                '%LOCALAPPDATA%\\cursor-agent\\cursor-agent.cmd',
                '%LOCALAPPDATA%\\cursor-agent\\agent.cmd',
            ],
        },
    },
    {
        // Pi (@earendil-works/pi-coding-agent). Both supported installs — `npm
        // install -g` and `curl -fsSL https://pi.dev/install.sh | sh` — land the
        // binary in the npm global prefix's bin dir (the installer literally
        // resolves `npm_global_prefix()/bin`), so the fallbacks are the usual
        // npm-global locations rather than a vendor-specific directory. `~/.pi`
        // holds config/sessions only; no binary ever lives there.
        id: 'pi',
        displayName: 'Pi',
        category: 'ai-agent',
        binaries: ['pi', 'pi.cmd', 'pi.exe'],
        versionArgs: ['--version'],
        // Pi has no approval prompts to bypass, and `--approve` is deliberately
        // not a default: it trusts project-local extensions/skills, which can run
        // code. Nothing to add.
        installHint: {
            mac: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
            linux: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
            win: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
        },
        fallbackPaths: {
            mac: [
                '/opt/homebrew/bin/pi',
                '/usr/local/bin/pi',
                '~/.local/bin/pi',
                '~/.npm-global/bin/pi',
                '~/.bun/bin/pi',
                '~/.volta/bin/pi',
                '~/Library/pnpm/pi',
            ],
            linux: [
                '/usr/local/bin/pi',
                '/home/linuxbrew/.linuxbrew/bin/pi',
                '~/.local/bin/pi',
                '~/.npm-global/bin/pi',
                '~/.bun/bin/pi',
            ],
            win: [
                '%APPDATA%\\npm\\pi.cmd',
                '%LOCALAPPDATA%\\npm\\pi.cmd',
            ],
        },
    },
    {
        id: 'qoder',
        displayName: 'Qoder',
        category: 'ai-agent',
        binaries: ['qoder', 'qoder.cmd', 'qoder.exe'],
        versionArgs: ['--version'],
        fallbackPaths: {
            mac: [
                '/opt/homebrew/bin/qoder',
                '/usr/local/bin/qoder',
                '~/.local/bin/qoder',
                '~/.npm-global/bin/qoder',
                '~/.bun/bin/qoder',
                '~/.volta/bin/qoder',
                '~/Library/pnpm/qoder',
            ],
            linux: [
                '/usr/local/bin/qoder',
                '~/.local/bin/qoder',
                '~/.npm-global/bin/qoder',
                '~/.bun/bin/qoder',
                '~/.volta/bin/qoder',
                '~/.local/share/pnpm/qoder',
            ],
            win: [
                '%PNPM_HOME%\\qoder.cmd',
                '%NVM_SYMLINK%\\qoder.cmd',
                '%APPDATA%\\npm\\qoder.cmd',
                '%APPDATA%\\npm\\qoder.exe',
                'C:\\Program Files\\nodejs\\qoder.cmd',
                'C:\\Program Files\\nodejs\\qoder.exe',
                '%USERPROFILE%\\.local\\bin\\qoder.exe',
                '%USERPROFILE%\\.bun\\bin\\qoder.exe',
                '%LOCALAPPDATA%\\pnpm\\qoder.cmd',
                '%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\qoder.exe',
                '%LOCALAPPDATA%\\Volta\\bin\\qoder.cmd',
                '%LOCALAPPDATA%\\mise\\shims\\qoder.cmd',
                '%USERPROFILE%\\scoop\\shims\\qoder.exe',
                '%ProgramData%\\chocolatey\\bin\\qoder.exe',
            ],
        },
    },
    {
        id: 'aider',
        displayName: 'Aider',
        category: 'ai-agent',
        binaries: ['aider', 'aider.cmd'],
        versionArgs: ['--version'],
        defaultSpawnArgs: ['--yes-always'],
        installHint: { mac: 'https://aider.chat', linux: 'https://aider.chat', win: 'https://aider.chat' },
        // pipx is the documented install method → `~/.local/bin/aider` on POSIX,
        // `%USERPROFILE%\.local\bin\aider.exe` on Windows. pip --user same dir.
        fallbackPaths: {
            mac: [
                '~/.local/bin/aider',
                '/opt/homebrew/bin/aider',
                '/usr/local/bin/aider',
            ],
            linux: [
                '~/.local/bin/aider',
                '/usr/local/bin/aider',
            ],
            win: [
                '%USERPROFILE%\\.local\\bin\\aider.exe',
                '%APPDATA%\\Python\\Scripts\\aider.exe',
                '%LOCALAPPDATA%\\Programs\\Python\\Python*\\Scripts\\aider.exe',
            ],
        },
    },
    // ── Runtimes ─────────────────────────────────────────────────────────────
    { id: 'node', displayName: 'Node.js', category: 'runtime', binaries: ['node', 'node.exe'], versionArgs: ['--version'] },
    { id: 'deno', displayName: 'Deno', category: 'runtime', binaries: ['deno', 'deno.exe'], versionArgs: ['--version'] },
    { id: 'bun', displayName: 'Bun', category: 'runtime', binaries: ['bun', 'bun.exe'], versionArgs: ['--version'] },
    { id: 'python', displayName: 'Python', category: 'runtime', binaries: ['python3', 'python', 'python.exe'], versionArgs: ['--version'] },
    { id: 'ruby', displayName: 'Ruby', category: 'runtime', binaries: ['ruby', 'ruby.exe'], versionArgs: ['--version'] },
    { id: 'go', displayName: 'Go', category: 'runtime', binaries: ['go', 'go.exe'], versionArgs: ['version'] },
    { id: 'rust', displayName: 'Rust (rustc)', category: 'runtime', binaries: ['rustc', 'rustc.exe'], versionArgs: ['--version'] },
    { id: 'java', displayName: 'Java', category: 'runtime', binaries: ['java', 'java.exe'], versionArgs: ['--version'] },
    // ── Package managers ─────────────────────────────────────────────────────
    { id: 'npm', displayName: 'npm', category: 'package-manager', binaries: ['npm', 'npm.cmd'], versionArgs: ['--version'] },
    { id: 'pnpm', displayName: 'pnpm', category: 'package-manager', binaries: ['pnpm', 'pnpm.cmd'], versionArgs: ['--version'] },
    { id: 'yarn', displayName: 'Yarn', category: 'package-manager', binaries: ['yarn', 'yarn.cmd'], versionArgs: ['--version'] },
    { id: 'pip', displayName: 'pip', category: 'package-manager', binaries: ['pip3', 'pip', 'pip.exe'], versionArgs: ['--version'] },
    { id: 'poetry', displayName: 'Poetry', category: 'package-manager', binaries: ['poetry', 'poetry.exe'], versionArgs: ['--version'] },
    { id: 'uv', displayName: 'uv', category: 'package-manager', binaries: ['uv', 'uv.exe'], versionArgs: ['--version'] },
    { id: 'cargo', displayName: 'Cargo', category: 'package-manager', binaries: ['cargo', 'cargo.exe'], versionArgs: ['--version'] },
    // ── Dev tools ────────────────────────────────────────────────────────────
    { id: 'git', displayName: 'Git', category: 'dev-tool', binaries: ['git', 'git.exe'], versionArgs: ['--version'] },
    { id: 'gh', displayName: 'GitHub CLI', category: 'dev-tool', binaries: ['gh', 'gh.exe'], versionArgs: ['--version'] },
    { id: 'docker', displayName: 'Docker', category: 'dev-tool', binaries: ['docker', 'docker.exe'], versionArgs: ['--version'] },
    { id: 'kubectl', displayName: 'kubectl', category: 'dev-tool', binaries: ['kubectl', 'kubectl.exe'], versionArgs: ['version', '--client', '--short'] },
    { id: 'terraform', displayName: 'Terraform', category: 'dev-tool', binaries: ['terraform', 'terraform.exe'], versionArgs: ['version'] },
    // ── Database CLIs ────────────────────────────────────────────────────────
    { id: 'psql', displayName: 'psql', category: 'database', binaries: ['psql', 'psql.exe'], versionArgs: ['--version'] },
    { id: 'mysql', displayName: 'mysql', category: 'database', binaries: ['mysql', 'mysql.exe'], versionArgs: ['--version'] },
    { id: 'redis-cli', displayName: 'redis-cli', category: 'database', binaries: ['redis-cli', 'redis-cli.exe'], versionArgs: ['--version'] },
    { id: 'mongosh', displayName: 'mongosh', category: 'database', binaries: ['mongosh', 'mongosh.exe'], versionArgs: ['--version'] },
];
function findKnownCli(id) {
    return exports.KNOWN_CLIS.find((c) => c.id === id);
}
/** Default spawn-block label shown in the channels palette. */
function defaultSpawnLabel(cli) {
    const args = (cli.defaultSpawnArgs ?? []).join(' ');
    return args ? `spawn ${cli.id} ${args}` : `spawn ${cli.id}`;
}
