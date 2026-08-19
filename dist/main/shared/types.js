"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROJECT_COLORS = exports.DEFAULT_PREFERENCES = exports.RECOMMENDED_HIDDEN_STARTUP_AGENTS = exports.DEFAULT_TERMINAL_SCROLLBACK_LINES = exports.TERMINAL_SCROLLBACK_MAX_LINES = exports.TERMINAL_SCROLLBACK_MIN_LINES = exports.DEFAULT_SHORTCUTS = exports.DEFAULT_STARTUP_COMMAND_PRESETS = exports.PROJECT_SETTINGS_FILE_VERSION = exports.EXECUTABLE_PROJECT_SETTINGS_DOMAINS = exports.DEFAULT_OUTPUT_CAPTURE = exports.DEFAULT_PIPE_SETTINGS = exports.AGENT_CONFIG = void 0;
exports.mergeShortcutsWithDefaults = mergeShortcutsWithDefaults;
exports.clampTerminalScrollback = clampTerminalScrollback;
exports.AGENT_CONFIG = {
    claude: { name: 'Claude Code', color: '#F59E0B', icon: 'claude', command: 'claude' },
    codex: { name: 'Codex', color: '#10B981', icon: 'codex', command: 'codex' },
    gemini: { name: 'Gemini CLI', color: '#8B5CF6', icon: 'gemini', command: 'gemini' },
    kimi: { name: 'Kimi Code', color: '#1677FF', icon: 'kimi', command: 'kimi' },
    agy: { name: 'Antigravity', color: '#64748B', icon: 'antigravity', command: 'agy' },
    amp: { name: 'Amp', color: '#EC4899', icon: 'amp', command: 'amp' },
    opencode: { name: 'OpenCode', color: '#3B82F6', icon: 'terminal', command: 'opencode' },
    cline: { name: 'Cline', color: '#06B6D4', icon: 'terminal', command: 'cline' },
    qoder: { name: 'Qoder', color: '#F97316', icon: 'terminal', command: 'qoder' },
    qwen: { name: 'Qwen Code', color: '#6366F1', icon: 'terminal', command: 'qwen' },
    grok: { name: 'Grok CLI', color: '#71767B', icon: 'grok', command: 'grok' },
    hermes: { name: 'Hermes Agent', color: '#8B5CF6', icon: 'hermes', command: 'hermes' },
    // Cursor's docs teach `agent`, but the executable is `cursor-agent` and only
    // post-rename installs have the `agent` symlink — `cursor-agent` is the
    // spelling every install still ships, so it stays the default we type. Both
    // are recognized on the way back in (getDeclaredAgentKind). `cursor` alone
    // is the editor launcher and is never the agent.
    cursor: { name: 'Cursor CLI', color: '#14B8A6', icon: 'cursor', command: 'cursor-agent' },
    // Pi (@earendil-works/pi-coding-agent). The color is the accent its own
    // TUI paints the `pi` wordmark in; the mark itself is monochrome.
    pi: { name: 'Pi', color: '#8ABEB7', icon: 'pi', command: 'pi' },
    bash: { name: 'bash', color: '#64748B', icon: 'terminal', command: undefined },
    zsh: { name: 'zsh', color: '#64748B', icon: 'terminal', command: undefined },
    powershell: { name: 'PowerShell', color: '#0078D4', icon: 'powershell', command: undefined },
    custom: { name: 'Custom', color: '#6B7280', icon: 'terminal', command: undefined },
};
exports.DEFAULT_PIPE_SETTINGS = {
    maxIterations: 10,
    globalTimeout: 5 * 60 * 1000,
    onError: 'stop',
    retryCount: 1,
    retryDelayMs: 1500,
    notifications: true,
};
exports.DEFAULT_OUTPUT_CAPTURE = {
    mode: 'full',
    waitFor: {
        type: 'idle',
        idleMs: 3000,
    },
};
/**
 * Domains whose config can widen what runs (a cloned repo is untrusted input,
 * so these are held behind the apply-review sheet until approved).
 * `deploy.buildCommand` is executable-on-run but its file is otherwise passive,
 * so it is surfaced in the sheet without blocking the rest of `deploy.json`.
 *
 * `tasks` does not spawn a process; it widens what ALREADY-RUNNING agents may
 * do — `crossProjectWrites: true`, approval gates off, timeout behaviour — which
 * is the same threat class (docs/tasks_v2.md §5.1). Until its file is approved
 * at its current hash, Tasks applies safe defaults: gates plan+done on,
 * `onTimeout: 'block'`, `crossProjectWrites: false`.
 */
exports.EXECUTABLE_PROJECT_SETTINGS_DOMAINS = [
    'agents',
    'channels',
    'skills',
    'tasks',
];
/** Current schema version stamped into every `.1devtool/*.json` file. */
exports.PROJECT_SETTINGS_FILE_VERSION = 1;
exports.DEFAULT_STARTUP_COMMAND_PRESETS = [
    // Development Servers
    { id: 'npm-dev', name: 'npm run dev', command: 'npm run dev', category: 'Dev Servers' },
    { id: 'npm-start', name: 'npm start', command: 'npm start', category: 'Dev Servers' },
    { id: 'yarn-dev', name: 'yarn dev', command: 'yarn dev', category: 'Dev Servers' },
    { id: 'pnpm-dev', name: 'pnpm dev', command: 'pnpm dev', category: 'Dev Servers' },
    { id: 'vite', name: 'Vite Dev', command: 'npx vite', category: 'Dev Servers' },
    { id: 'next-dev', name: 'Next.js Dev', command: 'npx next dev', category: 'Dev Servers' },
    { id: 'nuxt-dev', name: 'Nuxt Dev', command: 'npx nuxi dev', category: 'Dev Servers' },
    { id: 'remix-dev', name: 'Remix Dev', command: 'npx remix dev', category: 'Dev Servers' },
    { id: 'astro-dev', name: 'Astro Dev', command: 'npx astro dev', category: 'Dev Servers' },
    // Build & Test
    { id: 'npm-build', name: 'npm run build', command: 'npm run build', category: 'Build & Test' },
    { id: 'npm-test', name: 'npm test', command: 'npm test', category: 'Build & Test' },
    { id: 'npm-test-watch', name: 'npm test (watch)', command: 'npm test -- --watch', category: 'Build & Test' },
    { id: 'vitest', name: 'Vitest', command: 'npx vitest', category: 'Build & Test' },
    { id: 'jest', name: 'Jest', command: 'npx jest', category: 'Build & Test' },
    { id: 'playwright', name: 'Playwright Test', command: 'npx playwright test', category: 'Build & Test' },
    { id: 'tsc-watch', name: 'TypeScript Watch', command: 'npx tsc --watch', category: 'Build & Test' },
    // Docker
    { id: 'docker-compose-up', name: 'Docker Compose Up', command: 'docker compose up', category: 'Docker' },
    { id: 'docker-compose-up-d', name: 'Docker Compose Up -d', command: 'docker compose up -d', category: 'Docker' },
    { id: 'docker-compose-down', name: 'Docker Compose Down', command: 'docker compose down', category: 'Docker' },
    { id: 'docker-ps', name: 'Docker PS', command: 'docker ps', category: 'Docker' },
    { id: 'docker-logs', name: 'Docker Logs', command: 'docker compose logs -f', category: 'Docker' },
    // Database
    { id: 'prisma-studio', name: 'Prisma Studio', command: 'npx prisma studio', category: 'Database' },
    { id: 'prisma-migrate', name: 'Prisma Migrate Dev', command: 'npx prisma migrate dev', category: 'Database' },
    { id: 'drizzle-studio', name: 'Drizzle Studio', command: 'npx drizzle-kit studio', category: 'Database' },
    // Backend
    { id: 'python-server', name: 'Python HTTP Server', command: 'python -m http.server 8000', category: 'Backend' },
    { id: 'flask-run', name: 'Flask Run', command: 'flask run', category: 'Backend' },
    { id: 'uvicorn', name: 'Uvicorn (FastAPI)', command: 'uvicorn main:app --reload', category: 'Backend' },
    { id: 'rails-server', name: 'Rails Server', command: 'rails server', category: 'Backend' },
    { id: 'go-run', name: 'Go Run', command: 'go run .', category: 'Backend' },
    { id: 'cargo-run', name: 'Cargo Run', command: 'cargo run', category: 'Backend' },
    { id: 'cargo-watch', name: 'Cargo Watch', command: 'cargo watch -x run', category: 'Backend' },
    // Git
    { id: 'git-status', name: 'Git Status', command: 'git status', category: 'Git' },
    { id: 'git-log', name: 'Git Log', command: 'git log --oneline -20', category: 'Git' },
    { id: 'git-diff', name: 'Git Diff', command: 'git diff', category: 'Git' },
    // AI Agents
    { id: 'claude-skip-permissions', name: 'Claude (Skip Permissions)', command: 'claude --dangerously-skip-permissions', category: 'AI Agents' },
    { id: 'codex-bypass-approvals', name: 'Codex (Bypass Approvals)', command: 'codex --dangerously-bypass-approvals-and-sandbox', category: 'AI Agents' },
    // Utilities
    { id: 'watch-files', name: 'Watch Files', command: 'watch -n 1 ls -la', category: 'Utilities' },
    { id: 'htop', name: 'htop', command: 'htop', category: 'Utilities' },
    { id: 'tail-logs', name: 'Tail Logs', command: 'tail -f logs/*.log', category: 'Utilities' },
];
// Platform probe usable from both processes: main has process.platform, the
// renderer only has navigator. Vite may shim `process` as {env}, so a falsy
// process.platform falls through to the navigator check.
const IS_MAC_PLATFORM = (() => {
    if (typeof process !== 'undefined' && process.platform)
        return process.platform === 'darwin';
    const runtimeNavigator = globalThis.navigator;
    if (runtimeNavigator?.platform)
        return runtimeNavigator.platform.toUpperCase().includes('MAC');
    return true;
})();
// ShortcutGuideOverlay reads from shortcutStore automatically — new entries here appear in the guide overlay and Settings > Shortcuts.
// Wire the handler in useKeyboardShortcuts.ts if the shortcut triggers an action.
exports.DEFAULT_SHORTCUTS = [
    // General
    { id: 'settings', label: 'Open Settings', keys: 'cmd+,', category: 'general' },
    { id: 'commandPalette', label: 'Command Palette', keys: 'cmd+shift+p', category: 'general' },
    { id: 'quickOpen', label: 'Quick Open', keys: 'cmd+p', category: 'general' },
    { id: 'quickCommands', label: 'Quick Commands', keys: 'cmd+shift+r', category: 'general' },
    { id: 'missionControl', label: 'Mission Control', keys: 'ctrl+up', category: 'general' },
    { id: 'quotaCenter', label: 'AI Quota Center', description: 'Open the Spend & Quota Center panel.', keys: 'cmd+shift+u', category: 'general' },
    { id: 'shortcutGuide', label: 'Keyboard Shortcuts', keys: 'cmd+/', category: 'general' },
    // Layout
    { id: 'toggleSidebar', label: 'Toggle Sidebar', keys: 'cmd+b', category: 'layout' },
    { id: 'toggleEditor', label: 'Toggle Editor', keys: 'cmd+j', category: 'layout' },
    { id: 'toggleTerminal', label: 'Toggle Terminal', description: 'Collapse or expand the terminal section below the editor.', keys: 'cmd+shift+j', category: 'layout' },
    { id: 'toggleOutput', label: 'Toggle Output Panel', keys: 'cmd+\\', category: 'layout' },
    // Mosaic (tiling layout). Every binding below was checked against the rest
    // of this table; the one deliberate omission is plain Cmd+M, which the
    // application menu's `role: 'minimize'` owns on macOS — a renderer handler
    // for it would never fire, so magnify takes Ctrl+Cmd+M.
    { id: 'layoutMosaic', label: 'Mosaic Layout', description: 'Switch this project to the tiling layout.', keys: 'cmd+alt+7', category: 'layout' },
    { id: 'mosaicAddTile', label: 'Add Tile', description: 'Open the Mosaic tile palette.', keys: 'cmd+shift+n', category: 'layout' },
    { id: 'mosaicCloseTile', label: 'Close Tile', description: 'Close the focused Mosaic tile (the terminal keeps running).', keys: 'cmd+shift+w', category: 'layout' },
    { id: 'mosaicMagnify', label: 'Magnify Tile', description: 'Expand the focused Mosaic tile over its siblings, or restore it.', keys: 'cmd+ctrl+m', category: 'layout' },
    { id: 'mosaicSplitRight', label: 'Split Tile Right', description: 'Add a tile to the right of the focused one.', keys: 'cmd+alt+right', category: 'layout' },
    { id: 'mosaicSplitDown', label: 'Split Tile Down', description: 'Add a tile below the focused one.', keys: 'cmd+alt+down', category: 'layout' },
    { id: 'mosaicFocusLeft', label: 'Focus Tile Left', keys: 'ctrl+shift+left', category: 'layout' },
    { id: 'mosaicFocusRight', label: 'Focus Tile Right', keys: 'ctrl+shift+right', category: 'layout' },
    { id: 'mosaicFocusUp', label: 'Focus Tile Up', keys: 'ctrl+shift+up', category: 'layout' },
    { id: 'mosaicFocusDown', label: 'Focus Tile Down', keys: 'ctrl+shift+down', category: 'layout' },
    // Terminal
    { id: 'selectTerminal1', label: 'Select Terminal 1', description: 'Switch to and focus the 1st visible terminal.', keys: 'cmd+1', category: 'terminal' },
    { id: 'selectTerminal2', label: 'Select Terminal 2', description: 'Switch to and focus the 2nd visible terminal.', keys: 'cmd+2', category: 'terminal' },
    { id: 'selectTerminal3', label: 'Select Terminal 3', description: 'Switch to and focus the 3rd visible terminal.', keys: 'cmd+3', category: 'terminal' },
    { id: 'selectTerminal4', label: 'Select Terminal 4', description: 'Switch to and focus the 4th visible terminal.', keys: 'cmd+4', category: 'terminal' },
    { id: 'selectTerminal5', label: 'Select Terminal 5', description: 'Switch to and focus the 5th visible terminal.', keys: 'cmd+5', category: 'terminal' },
    { id: 'selectTerminal6', label: 'Select Terminal 6', description: 'Switch to and focus the 6th visible terminal.', keys: 'cmd+6', category: 'terminal' },
    { id: 'selectTerminal7', label: 'Select Terminal 7', description: 'Switch to and focus the 7th visible terminal.', keys: 'cmd+7', category: 'terminal' },
    { id: 'selectTerminal8', label: 'Select Terminal 8', description: 'Switch to and focus the 8th visible terminal.', keys: 'cmd+8', category: 'terminal' },
    { id: 'selectTerminal9', label: 'Select Terminal 9', description: 'Switch to and focus the 9th visible terminal.', keys: 'cmd+9', category: 'terminal' },
    { id: 'layoutGrid', label: 'Grid Layout', keys: 'cmd+alt+1', category: 'terminal' },
    { id: 'layoutColumns', label: 'Columns Layout', keys: 'cmd+alt+2', category: 'terminal' },
    { id: 'layoutSingle', label: 'Single Layout', keys: 'cmd+alt+3', category: 'terminal' },
    { id: 'layoutVerticalTabs', label: 'Vertical Tabs Layout', keys: 'cmd+alt+4', category: 'terminal' },
    { id: 'layoutCanvas', label: 'Canvas Layout', keys: 'cmd+alt+5', category: 'terminal' },
    { id: 'layoutChat', label: 'Chat Interface Layout', keys: 'cmd+alt+6', category: 'terminal' },
    { id: 'newTerminal', label: 'New Terminal', keys: 'cmd+t', category: 'terminal' },
    { id: 'closeTerminal', label: 'Close Terminal', keys: 'cmd+w', category: 'terminal' },
    { id: 'nextTerminal', label: 'Next Terminal', keys: 'cmd+]', category: 'terminal' },
    { id: 'prevTerminal', label: 'Previous Terminal', keys: 'cmd+[', category: 'terminal' },
    { id: 'clearTerminal', label: 'Clear Terminal', keys: 'cmd+k', category: 'terminal' },
    { id: 'hideTerminal', label: 'Hide Terminal', description: 'Hide the active terminal until you reopen it.', keys: 'cmd+shift+h', category: 'terminal' },
    // On Windows/Linux `cmd+i` resolves to Ctrl+I, which is a literal Tab in
    // terminals — default to Ctrl+Alt+I there instead. Saved customizations
    // always win over this default (mergeShortcutsWithDefaults keeps saved keys).
    { id: 'toggleAgentInput', label: 'Toggle Agent Input', description: 'Open or close the agent input overlay on AI terminals.', keys: IS_MAC_PLATFORM ? 'cmd+i' : 'ctrl+alt+i', category: 'terminal' },
    { id: 'clearAgentInput', label: 'Clear Agent Input', description: 'Clear all text, file attachments, and images in the agent input overlay.', keys: 'cmd+shift+backspace', category: 'terminal' },
    { id: 'terminalReaderMode', label: 'Terminal Reader Mode', description: 'Open a fullscreen reading view of the terminal output.', keys: 'cmd+shift+e', category: 'terminal' },
    { id: 'openTerminalsDashboard', label: 'Open Terminal Dashboard', description: 'Open the cross-project terminal dashboard.', keys: 'cmd+shift+d', category: 'terminal' },
    { id: 'openTerminalsList', label: 'Open Terminal List', description: 'Open the cross-project terminal list.', keys: 'cmd+shift+l', category: 'terminal' },
    { id: 'openTerminalsCanvas', label: 'Open Terminal Canvas', description: 'Open the cross-project terminal canvas.', keys: 'cmd+shift+c', category: 'terminal' },
    // Editor
    { id: 'saveFile', label: 'Save File', keys: 'cmd+s', category: 'editor' },
    // Browser
    {
        id: 'browserFullscreen',
        label: 'Toggle Browser Fullscreen',
        description: 'Expand the browser panel to fullscreen and use the same shortcut again to restore it.',
        keys: 'cmd+shift+f',
        category: 'browser',
    },
    {
        id: 'browserExitFullscreen',
        label: 'Exit Browser Fullscreen',
        description: 'Restore the browser panel from fullscreen.',
        keys: 'escape',
        category: 'browser',
    },
    {
        id: 'captureBrowserScreenshot',
        label: 'Capture Browser Screenshot',
        description: 'Take a screenshot and open the annotator.',
        keys: 'cmd+shift+x',
        category: 'browser',
    },
    // Tasks
    { id: 'tasksQuickAdd', label: 'Quick Add', description: 'Focus the task quick-add input when the Tasks panel is active.', keys: 'cmd+n', category: 'tasks' },
    { id: 'tasksSendSelected', label: 'Send Selected', description: 'Open the send dialog for the selected task.', keys: 'cmd+enter', category: 'tasks' },
    { id: 'tasksSendLast', label: 'Send to Last Terminal', description: 'Send the selected task to the last used terminal.', keys: 'cmd+shift+enter', category: 'tasks' },
    { id: 'tasksToggleDone', label: 'Toggle Done', description: 'Mark the selected task done or move it back to todo.', keys: 'cmd+d', category: 'tasks' },
];
function mergeShortcutsWithDefaults(saved = []) {
    const savedIds = new Set(saved.map((shortcut) => shortcut.id));
    const defaultById = new Map(exports.DEFAULT_SHORTCUTS.map((shortcut) => [shortcut.id, shortcut]));
    const merged = saved.map((shortcut) => {
        const defaultShortcut = defaultById.get(shortcut.id);
        if (!defaultShortcut)
            return shortcut;
        return {
            ...defaultShortcut,
            ...shortcut,
            label: defaultShortcut.label,
            description: defaultShortcut.description,
            category: defaultShortcut.category,
        };
    });
    const usedKeys = new Set(merged.map((shortcut) => shortcut.keys).filter(Boolean));
    const newDefaults = exports.DEFAULT_SHORTCUTS
        .filter((shortcut) => !savedIds.has(shortcut.id))
        .map((shortcut) => {
        if (!shortcut.keys || !usedKeys.has(shortcut.keys)) {
            usedKeys.add(shortcut.keys);
            return shortcut;
        }
        return { ...shortcut, keys: '' };
    });
    return [...merged, ...newDefaults];
}
/**
 * Keep terminal history bounded when many agents are active at once. Persisted
 * preferences from older releases may exceed this range, so callers that read
 * user-controlled values must clamp them before constructing an xterm.
 */
exports.TERMINAL_SCROLLBACK_MIN_LINES = 1000;
exports.TERMINAL_SCROLLBACK_MAX_LINES = 5000;
exports.DEFAULT_TERMINAL_SCROLLBACK_LINES = exports.TERMINAL_SCROLLBACK_MAX_LINES;
function clampTerminalScrollback(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return exports.DEFAULT_TERMINAL_SCROLLBACK_LINES;
    }
    return Math.min(exports.TERMINAL_SCROLLBACK_MAX_LINES, Math.max(exports.TERMINAL_SCROLLBACK_MIN_LINES, Math.trunc(value)));
}
/** Built-in agents kept available but omitted from recommended launcher surfaces. */
exports.RECOMMENDED_HIDDEN_STARTUP_AGENTS = ['gemini'];
exports.DEFAULT_PREFERENCES = {
    workspace: {
        sidebarWidth: 220,
        sidebarCollapsed: false,
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
        editorDiagnostics: 'syntax-only',
        readerMode: {
            background: 'sepia',
            font: 'serif',
            fontSize: 18,
            contentWidth: 720,
            customBackground: '#2d2d3f',
            customText: '#e0e0e0',
            stickyNoteColor: '#93C5FD',
            stickyNoteFontFamily: '"Caveat", "Comic Sans MS", system-ui, sans-serif',
            stickyNoteFontSize: 13,
            stickyNoteWidth: 200,
            stickyNoteHeight: 200,
        },
    },
    languages: {
        enabled: [],
        installPaths: {},
        installedVersions: {},
        autoStart: false,
        preferSystemBinaries: true,
        diagnosticsEnabled: true,
    },
    appearance: {
        theme: 'dark',
        terminalFontFamily: 'JetBrainsMono Nerd Font',
        terminalFontSize: 13,
        terminalLineHeight: 1.2,
        unfocusedTerminalOpacity: 0.6,
        terminalScrollbar: 'auto',
        customFonts: [],
        uiScale: 1,
        agentInputFontOverride: false,
    },
    behavior: {
        defaultEditor: 'code',
        terminalScrollback: exports.DEFAULT_TERMINAL_SCROLLBACK_LINES,
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
        fileOpenMode: 'normal',
    },
    defaults: {
        terminalType: 'bash',
        outputPanelMode: 'http',
        browserUrlTemplate: 'https://1devtool.com/',
    },
    browser: {
        persistState: true,
    },
    terminal: {
        showRunTimer: true,
        tmuxMouseBehavior: 'native-selection',
        hiddenLayouts: [],
        activityLogEnabled: true,
        activityLogFileExtensions: ['.md'],
        activityLogAutoDismissSeconds: 300,
        funAnimation: 'none',
        sidebarHoverPreview: true,
        showSubAgentBadges: true,
        showMcpToolBadges: true,
        showAgentInputComposer: true,
        dashboardPollSeconds: 10,
        localTerminalAttachCli: false,
    },
    git: {
        accounts: [],
        activeAccountId: null,
    },
    draw: {},
    ssh: {
        connections: [],
        scanPaths: [],
    },
    startupCommands: {
        customPresets: [],
        hiddenAgents: [...exports.RECOMMENDED_HIDDEN_STARTUP_AGENTS],
    },
    aiAgentPaths: {},
    shortcuts: exports.DEFAULT_SHORTCUTS,
    updates: {
        skippedVersion: null,
        autoDownload: true,
        autoInstallOnQuit: true,
        notify: 'pill',
        checkIntervalHours: 6,
    },
    privacy: {
        analyticsEnabled: true,
        consentShown: false,
    },
    onboarding: {
        firstLaunchVersion: null,
        firstLaunchAt: null,
        completedSteps: [],
        dismissedSteps: [],
        welcomeDismissed: false,
        checklistDismissed: false,
    },
    system: {
        extraPathEntries: [],
        mcpNodePath: '',
    },
    orchestration: {
        draft: {
            assignments: {},
            customCategories: [],
            mode: 'on-generic-delegate',
            defaultSubstrate: 'auto',
            updatedAt: 0,
        },
        applied: null,
    },
    orchestrationSetups: {
        presets: [],
    },
};
// Project colors palette
exports.PROJECT_COLORS = [
    '#EF4444', // red
    '#F97316', // orange
    '#F59E0B', // amber
    '#EAB308', // yellow
    '#84CC16', // lime
    '#22C55E', // green
    '#10B981', // emerald
    '#14B8A6', // teal
    '#06B6D4', // cyan
    '#0EA5E9', // sky
    '#3B82F6', // blue
    '#6366F1', // indigo
    '#8B5CF6', // violet
    '#A855F7', // purple
    '#D946EF', // fuchsia
    '#EC4899', // pink
];
