"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApplicationMenuController = createApplicationMenuController;
const electron_1 = require("electron");
const settingsTabs_1 = require("../shared/settingsTabs");
const types_1 = require("../shared/types");
function createApplicationMenuController({ getMainWindow, sendToRenderer, isDev, isMac, }) {
    function focusMainWindow() {
        const mainWindow = getMainWindow();
        if (!mainWindow || mainWindow.isDestroyed())
            return;
        if (mainWindow.isMinimized())
            mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }
    function sendMenuCommand(command) {
        if (sendToRenderer('app:menu-command', command)) {
            focusMainWindow();
        }
    }
    function openSettings(tab) {
        if (sendToRenderer('app:open-settings', tab ? { tab } : undefined)) {
            focusMainWindow();
        }
    }
    function commandMenuItem(label, command, accelerator) {
        return {
            label,
            ...(accelerator ? { accelerator } : {}),
            click: () => sendMenuCommand(command),
        };
    }
    function settingsMenuTemplate() {
        const tab = (tabId, label) => {
            const settingsTab = settingsTabs_1.SETTINGS_TABS.find((candidate) => candidate.id === tabId);
            return {
                label: label ?? `${settingsTab?.label ?? tabId}...`,
                click: () => openSettings(tabId),
            };
        };
        return [
            {
                label: 'All Settings...',
                click: () => openSettings(),
            },
            { type: 'separator' },
            tab('general'),
            tab('appearance'),
            tab('layout'),
            tab('shortcuts'),
            { type: 'separator' },
            tab('terminal'),
            tab('ide'),
            tab('browser'),
            tab('fileTree'),
            { type: 'separator' },
            tab('git'),
            tab('remote'),
            tab('mcp'),
            tab('lib'),
            { type: 'separator' },
            tab('license'),
            tab('about'),
        ];
    }
    function createApplicationMenu() {
        const defaultShellAgentType = process.platform === 'win32' ? 'powershell' : isMac ? 'zsh' : 'bash';
        const template = [
            // App menu (macOS only)
            ...(isMac ? [{
                    label: electron_1.app.name,
                    submenu: [
                        { role: 'about' },
                        { type: 'separator' },
                        {
                            label: 'Check for Updates...',
                            click: () => {
                                sendToRenderer('app:open-updates');
                            },
                        },
                        { type: 'separator' },
                        {
                            label: 'Settings...',
                            accelerator: 'CmdOrCtrl+,',
                            click: () => {
                                openSettings();
                            },
                        },
                        {
                            label: 'Settings Sections',
                            submenu: settingsMenuTemplate(),
                        },
                        { type: 'separator' },
                        { role: 'services' },
                        { type: 'separator' },
                        { role: 'hide' },
                        { role: 'hideOthers' },
                        { role: 'unhide' },
                        { type: 'separator' },
                        { role: 'quit' },
                    ],
                }] : []),
            // File menu
            {
                label: 'File',
                submenu: [
                    commandMenuItem('New Project...', { type: 'new-project' }, 'CmdOrCtrl+Shift+N'),
                    commandMenuItem('New Terminal...', { type: 'add-terminal-dialog' }),
                    commandMenuItem('New Browser Tab', { type: 'new-browser-tab' }),
                    { type: 'separator' },
                    commandMenuItem('Quick Open...', { type: 'open-dialog', dialog: 'quick-open' }, 'CmdOrCtrl+P'),
                    commandMenuItem('Quick Commands...', { type: 'open-dialog', dialog: 'quick-commands' }, 'CmdOrCtrl+Shift+R'),
                    commandMenuItem('Templates...', { type: 'open-dialog', dialog: 'templates' }),
                    { type: 'separator' },
                    commandMenuItem('Save', { type: 'save-file' }, 'CmdOrCtrl+S'),
                    { type: 'separator' },
                    commandMenuItem('Close Terminal', { type: 'close-terminal' }),
                    ...(!isMac ? [
                        { type: 'separator' },
                        {
                            label: 'Settings...',
                            accelerator: 'CmdOrCtrl+,',
                            click: () => openSettings(),
                        },
                        { type: 'separator' },
                        { role: 'quit' },
                    ] : []),
                ],
            },
            // Edit menu
            {
                label: 'Edit',
                submenu: [
                    { role: 'undo' },
                    { role: 'redo' },
                    { type: 'separator' },
                    { role: 'cut' },
                    { role: 'copy' },
                    { role: 'paste' },
                    { role: 'selectAll' },
                ],
            },
            // View menu
            {
                label: 'View',
                submenu: [
                    commandMenuItem('Command Palette...', { type: 'open-dialog', dialog: 'command-palette' }, 'CmdOrCtrl+Shift+P'),
                    { type: 'separator' },
                    commandMenuItem('Toggle File Explorer', { type: 'toggle-sidebar' }, 'CmdOrCtrl+B'),
                    commandMenuItem('Toggle Output Panel', { type: 'toggle-output' }, 'CmdOrCtrl+\\'),
                    { type: 'separator' },
                    {
                        label: 'Layout',
                        submenu: [
                            commandMenuItem('Grid', { type: 'layout', layout: 'grid' }, 'CmdOrCtrl+1'),
                            commandMenuItem('Columns', { type: 'layout', layout: 'columns' }, 'CmdOrCtrl+2'),
                            commandMenuItem('Single', { type: 'layout', layout: 'single' }, 'CmdOrCtrl+3'),
                            commandMenuItem('Vertical Tabs', { type: 'layout', layout: 'vertical-tabs' }, 'CmdOrCtrl+5'),
                            commandMenuItem('Canvas', { type: 'layout', layout: 'canvas' }, 'CmdOrCtrl+6'),
                            commandMenuItem('Chat Interface', { type: 'layout', layout: 'chat' }, 'CmdOrCtrl+7'),
                            { type: 'separator' },
                            commandMenuItem('Default Preset', { type: 'layout-preset', presetId: 'default' }),
                            commandMenuItem('Chat Interface Preset', { type: 'layout-preset', presetId: 'chat-interface' }),
                            commandMenuItem('Terminal Center Preset', { type: 'layout-preset', presetId: 'terminal-center' }),
                            commandMenuItem('Terminal Right Preset', { type: 'layout-preset', presetId: 'terminal-right' }),
                        ],
                    },
                    { type: 'separator' },
                    { label: 'Reload App', accelerator: 'CmdOrCtrl+Alt+R', click: () => getMainWindow()?.webContents.reload() },
                    ...(isDev ? [{ role: 'toggleDevTools' }] : []),
                    { type: 'separator' },
                    // Page-level zoom removed — each panel (terminal, browser) handles its own zoom.
                    // Cmd+/-/0 reach the renderer as keydown events because webFrame.setZoomFactor(1)
                    // in the preload blocks Chromium's built-in zoom accelerators.
                    { type: 'separator' },
                    { role: 'togglefullscreen' },
                ],
            },
            // Navigate menu
            {
                label: 'Navigate',
                submenu: [
                    commandMenuItem('Projects', { type: 'focus-panel', panelId: 'projects' }),
                    commandMenuItem('Files', { type: 'focus-panel', panelId: 'editor' }),
                    commandMenuItem('Tasks...', { type: 'open-dialog', dialog: 'tasks' }),
                    commandMenuItem('Editor', { type: 'focus-panel', panelId: 'editor' }),
                    commandMenuItem('Terminals', { type: 'focus-panel', panelId: 'terminals' }),
                    { type: 'separator' },
                    commandMenuItem('Browser', { type: 'focus-panel', panelId: 'browser' }),
                    commandMenuItem('HTTP Client', { type: 'focus-panel', panelId: 'httpClient' }),
                    commandMenuItem('Database', { type: 'focus-panel', panelId: 'database' }),
                    commandMenuItem('Mobile Emulator', { type: 'focus-panel', panelId: 'mobileEmulator' }),
                    commandMenuItem('AI Diff', { type: 'focus-panel', panelId: 'aiDiff' }),
                    commandMenuItem('ToolBox', { type: 'focus-panel', panelId: 'toolBox' }),
                    commandMenuItem('Quota Center', { type: 'focus-panel', panelId: 'quotaCenter' }),
                    { type: 'separator' },
                    commandMenuItem('Terminal List...', { type: 'open-dialog', dialog: 'terminals' }),
                ],
            },
            // Terminal menu
            {
                label: 'Terminal',
                submenu: [
                    commandMenuItem('Dashboard', { type: 'toggle-dashboard' }, 'CmdOrCtrl+D'),
                    commandMenuItem('List...', { type: 'open-dialog', dialog: 'terminals' }),
                    { type: 'separator' },
                    commandMenuItem('New Terminal...', { type: 'add-terminal-dialog' }, 'CmdOrCtrl+T'),
                    {
                        label: 'New Agent Terminal',
                        submenu: [
                            commandMenuItem(types_1.AGENT_CONFIG.claude.name, { type: 'new-terminal', agentType: 'claude' }),
                            commandMenuItem(types_1.AGENT_CONFIG.codex.name, { type: 'new-terminal', agentType: 'codex' }),
                            commandMenuItem(types_1.AGENT_CONFIG.gemini.name, { type: 'new-terminal', agentType: 'gemini' }),
                            commandMenuItem(types_1.AGENT_CONFIG.amp.name, { type: 'new-terminal', agentType: 'amp' }),
                            commandMenuItem(types_1.AGENT_CONFIG.opencode.name, { type: 'new-terminal', agentType: 'opencode' }),
                            commandMenuItem(types_1.AGENT_CONFIG.qwen.name, { type: 'new-terminal', agentType: 'qwen' }),
                            commandMenuItem(types_1.AGENT_CONFIG.grok.name, { type: 'new-terminal', agentType: 'grok' }),
                            commandMenuItem(types_1.AGENT_CONFIG.hermes.name, { type: 'new-terminal', agentType: 'hermes' }),
                            commandMenuItem(types_1.AGENT_CONFIG.cursor.name, { type: 'new-terminal', agentType: 'cursor' }),
                            commandMenuItem(types_1.AGENT_CONFIG.pi.name, { type: 'new-terminal', agentType: 'pi' }),
                            { type: 'separator' },
                            commandMenuItem(types_1.AGENT_CONFIG[defaultShellAgentType].name, { type: 'new-terminal', agentType: defaultShellAgentType }),
                        ],
                    },
                    { type: 'separator' },
                    commandMenuItem('Next Terminal', { type: 'next-terminal' }, 'CmdOrCtrl+]'),
                    commandMenuItem('Previous Terminal', { type: 'previous-terminal' }, 'CmdOrCtrl+['),
                    commandMenuItem('Hide Terminal', { type: 'hide-terminal' }, 'CmdOrCtrl+Shift+H'),
                    commandMenuItem('Clear Terminal', { type: 'clear-terminal' }, 'CmdOrCtrl+K'),
                    { type: 'separator' },
                    commandMenuItem('Close Terminal', { type: 'close-terminal' }, 'CmdOrCtrl+W'),
                ],
            },
            // Tools menu
            {
                label: 'Tools',
                submenu: [
                    {
                        label: 'Settings',
                        submenu: settingsMenuTemplate(),
                    },
                    { type: 'separator' },
                    commandMenuItem('Git Client...', { type: 'open-dialog', dialog: 'git-client' }),
                    commandMenuItem('Templates...', { type: 'open-dialog', dialog: 'templates' }),
                    commandMenuItem('Skills...', { type: 'open-dialog', dialog: 'skills' }),
                    commandMenuItem('Terminal List...', { type: 'open-dialog', dialog: 'terminals' }),
                    { type: 'separator' },
                    commandMenuItem('Design Tool...', { type: 'open-dialog', dialog: 'design-tool' }),
                    commandMenuItem('Prototype Tool...', { type: 'open-dialog', dialog: 'prototype-tool' }),
                    commandMenuItem('Prompt History...', { type: 'open-dialog', dialog: 'prompts' }),
                    commandMenuItem('Resume AI Sessions...', { type: 'open-dialog', dialog: 'resume' }),
                    { type: 'separator' },
                    commandMenuItem('Docker...', { type: 'open-dialog', dialog: 'docker' }),
                    commandMenuItem('SSH...', { type: 'open-dialog', dialog: 'ssh' }),
                    commandMenuItem('Ports...', { type: 'open-dialog', dialog: 'ports' }),
                    commandMenuItem('Environment Variables...', { type: 'open-dialog', dialog: 'env' }),
                    { type: 'separator' },
                    commandMenuItem('Agent Output Diff...', { type: 'open-dialog', dialog: 'agent-diff' }),
                    commandMenuItem('Capture Browser Screenshot', { type: 'capture-browser-screenshot' }, 'CmdOrCtrl+Shift+X'),
                ],
            },
            // Window menu
            {
                label: 'Window',
                submenu: [
                    { role: 'minimize' },
                    { role: 'zoom' },
                    ...(isMac ? [
                        { type: 'separator' },
                        { role: 'front' },
                    ] : [
                        { role: 'close' },
                    ]),
                ],
            },
            // Help menu
            {
                label: 'Help',
                submenu: [
                    {
                        label: 'Learn More',
                        click: () => {
                            electron_1.shell.openExternal('https://1devtool.com/');
                        },
                    },
                    {
                        label: 'Tutorials',
                        click: () => {
                            electron_1.shell.openExternal('https://1devtool.com/tutorials');
                        },
                    },
                    {
                        label: 'Report Bugs and Feature Requests',
                        click: () => {
                            electron_1.shell.openExternal('https://feedback.stoicsoft.com/');
                        },
                    },
                    {
                        label: 'Join Discord',
                        click: () => {
                            electron_1.shell.openExternal('https://discord.gg/JjZjqbxeus');
                        },
                    },
                    ...(!isMac ? [
                        { type: 'separator' },
                        {
                            label: 'Check for Updates...',
                            click: () => {
                                sendToRenderer('app:open-updates');
                            },
                        },
                    ] : []),
                ],
            },
        ];
        const menu = electron_1.Menu.buildFromTemplate(template);
        electron_1.Menu.setApplicationMenu(menu);
    }
    return {
        focusMainWindow,
        sendMenuCommand,
        createApplicationMenu,
    };
}
