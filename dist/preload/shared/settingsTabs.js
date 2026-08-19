"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SETTINGS_TABS = void 0;
exports.isSettingsTabId = isSettingsTabId;
exports.SETTINGS_TABS = [
    { id: 'general', label: 'General' },
    { id: 'workspaces', label: 'Workspaces' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'layout', label: 'Layout' },
    { id: 'behavior', label: 'Notifications' },
    { id: 'fileTree', label: 'File Tree' },
    { id: 'browser', label: 'Browser' },
    { id: 'terminal', label: 'Terminal' },
    { id: 'ai', label: 'AI' },
    { id: 'ide', label: 'IDE' },
    { id: 'shortcuts', label: 'Shortcuts' },
    { id: 'git', label: 'Git' },
    { id: 'ssh', label: 'SSH' },
    { id: 'remote', label: 'Remote' },
    { id: 'devices', label: 'Devices' },
    { id: 'mcp', label: 'MCP' },
    { id: 'license', label: 'License' },
    { id: 'lib', label: 'Dependencies' },
    { id: 'updates', label: 'Updates' },
    { id: 'about', label: 'About' },
];
const SETTINGS_TAB_IDS = new Set(exports.SETTINGS_TABS.map((tab) => tab.id));
function isSettingsTabId(value) {
    return typeof value === 'string' && SETTINGS_TAB_IDS.has(value);
}
