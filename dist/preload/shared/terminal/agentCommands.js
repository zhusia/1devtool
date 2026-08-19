"use strict";
/**
 * Shared built-in slash-command registry for AI terminal agents.
 *
 * Pure data + a lookup, with no renderer- or main-only imports, so BOTH the
 * renderer (AgentInputOverlay's `/` autocomplete) and the main process (the
 * remote server's `terminal:slash-commands` handler) can use one source.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBuiltinAgentCommands = getBuiltinAgentCommands;
const CLAUDE_COMMANDS = [
    // General / help
    ['help', 'Show available commands', 'general'],
    ['status', 'Show version, model, account, tool status', 'general'],
    ['version', 'Print the running version', 'general'],
    ['doctor', 'Diagnose installation and settings', 'general'],
    ['cost', 'Show token usage and cost', 'general'],
    ['usage', 'Show plan usage limits', 'general'],
    ['stats', 'Show usage statistics and activity', 'general'],
    ['context', 'Visualize current context usage', 'general'],
    ['files', 'List files currently in context', 'general'],
    ['powerup', 'Discover features through lessons', 'general'],
    ['statusline', 'Configure status line UI', 'general'],
    // Model & effort
    ['model', 'Switch AI model', 'model'],
    ['fast', 'Toggle fast mode', 'model'],
    ['effort', 'Set effort level (low/medium/high/max/auto)', 'model'],
    ['advisor', 'Consult a stronger model at key moments', 'model'],
    // Conversation
    ['clear', 'Clear conversation history', 'conversation'],
    ['compact', 'Compact conversation to save context', 'conversation'],
    ['autocompact', 'Configure auto-compact window size', 'conversation'],
    ['resume', 'Resume a previous conversation', 'conversation'],
    ['rename', 'Rename the current conversation', 'conversation'],
    ['export', 'Export conversation to file or clipboard', 'conversation'],
    ['copy', 'Copy last response to clipboard', 'conversation'],
    ['btw', 'Ask a side question without interrupting', 'conversation'],
    ['brief', 'Toggle brief-only mode', 'conversation'],
    // Auth & account
    ['login', 'Sign in with Anthropic account', 'auth'],
    ['logout', 'Sign out', 'auth'],
    ['upgrade', 'Upgrade to Max for higher limits', 'auth'],
    ['extra-usage', 'Configure extra usage when limits hit', 'auth'],
    // Configuration
    ['config', 'Open config panel', 'config'],
    ['permissions', 'Manage tool permission rules', 'config'],
    ['memory', 'Edit memory files', 'config'],
    ['toggle-memory', 'Toggle automemory for this session', 'config'],
    ['hooks', 'View hook configurations', 'config'],
    ['stop-hook', 'Set a session-only Stop hook', 'config'],
    ['keybindings', 'Open keybindings config', 'config'],
    ['theme', 'Change the theme', 'config'],
    ['color', 'Set prompt bar color for this session', 'config'],
    ['privacy-settings', 'View and update privacy settings', 'config'],
    ['add-dir', 'Add a new working directory', 'config'],
    // Tools & integrations
    ['mcp', 'Manage MCP servers', 'tools'],
    ['ide', 'Manage IDE integrations', 'tools'],
    ['chrome', 'Claude in Chrome settings', 'tools'],
    ['agents', 'Manage agent configurations', 'tools'],
    ['plugin', 'Manage plugins', 'tools'],
    ['reload-plugins', 'Activate pending plugin changes', 'tools'],
    ['skills', 'List available skills', 'tools'],
    ['alias', 'Create or list command aliases', 'tools'],
    // Git & code
    ['commit', 'Create a git commit', 'git'],
    ['commit-push-pr', 'Commit, push, and open a PR', 'git'],
    ['diff', 'View uncommitted changes', 'git'],
    ['review', 'Review a pull request', 'git'],
    ['simplify', 'Review changed code for quality', 'git'],
    ['security-review', 'Security review of pending changes', 'git'],
    // Project setup
    ['init', 'Initialize CLAUDE.md', 'setup'],
    ['init-verifiers', 'Create verifier skills', 'setup'],
    ['install-github-app', 'Set up GitHub Actions', 'setup'],
    ['install-slack-app', 'Install Slack app', 'setup'],
    ['install', 'Install native build', 'setup'],
    ['web-setup', 'Setup on the web', 'setup'],
    ['setup-bedrock', 'Configure AWS Bedrock', 'setup'],
    // Advanced & automation
    ['plan', 'Enable plan mode or view plan', 'advanced'],
    ['batch', 'Parallel worktree agents for large changes', 'advanced'],
    ['loop', 'Run command on recurring interval', 'advanced'],
    ['schedule', 'Manage scheduled remote agents', 'advanced'],
    ['teleport', 'Resume session from claude.ai', 'advanced'],
    ['remote-env', 'Configure remote environment', 'advanced'],
    ['voice', 'Toggle voice mode', 'advanced'],
    // Debug
    ['debug', 'Enable debug logging', 'debug'],
    ['feedback', 'Submit feedback', 'debug'],
    ['insights', 'Analyze session reports', 'debug'],
];
const CODEX_COMMANDS = [
    ['help', 'Show help', 'general'],
    ['status', 'Show session config and token usage', 'general'],
    ['statusline', 'Configure status line items', 'general'],
    ['model', 'Choose model and reasoning effort', 'model'],
    ['fast', 'Toggle fast mode', 'model'],
    ['clear', 'Clear the terminal UI', 'conversation'],
    ['compact', 'Summarize conversation history', 'conversation'],
    ['diff', 'Show diff of changes', 'git'],
    ['review', 'Review changes and find issues', 'git'],
    ['init', 'Create AGENTS.md', 'setup'],
    ['permissions', 'Choose approval policy', 'config'],
    ['mcp', 'List configured MCP tools', 'tools'],
    ['skills', 'List available skills', 'tools'],
    ['personality', 'Customize communication style', 'config'],
    ['feedback', 'Report an issue / send logs', 'debug'],
    ['fork', 'Branch chat into a new thread', 'conversation'],
    ['rename', 'Rename thread for easier resuming', 'conversation'],
    ['plan', 'View or create a plan', 'advanced'],
    ['resume', 'Resume a previous session', 'conversation'],
    ['agent', 'Manage agents', 'tools'],
    ['memory', 'Memory management', 'config'],
    ['undo', 'Undo the last change', 'git'],
];
const GEMINI_COMMANDS = [
    ['help', 'Help on Gemini CLI', 'general'],
    ['about', 'Show version info', 'general'],
    ['stats', 'Check session stats', 'general'],
    ['model', 'Manage model configuration', 'model'],
    ['clear', 'Clear screen and conversation', 'conversation'],
    ['compress', 'Compress context with summary', 'conversation'],
    ['copy', 'Copy last result to clipboard', 'conversation'],
    ['chat', 'Browse auto-saved conversations', 'conversation'],
    ['resume', 'Resume a conversation', 'conversation'],
    ['restore', 'Restore a tool call state', 'conversation'],
    ['rewind', 'Jump back to specific message', 'conversation'],
    ['plan', 'Switch to Plan Mode', 'advanced'],
    ['init', 'Create GEMINI.md', 'setup'],
    ['auth', 'Manage authentication', 'auth'],
    ['permissions', 'Manage folder trust', 'config'],
    ['memory', 'Memory commands', 'config'],
    ['settings', 'View and edit settings', 'config'],
    ['theme', 'Change the theme', 'config'],
    ['footer', 'Configure footer items', 'config'],
    ['privacy', 'Display privacy notice', 'config'],
    ['editor', 'Set external editor preference', 'config'],
    ['vim', 'Toggle vim mode', 'config'],
    ['mcp', 'Manage MCP servers', 'tools'],
    ['tools', 'Manage tools', 'tools'],
    ['agents', 'Manage agents', 'tools'],
    ['extensions', 'Manage extensions', 'tools'],
    ['skills', 'List and manage agent skills', 'tools'],
    ['hooks', 'Manage hooks', 'tools'],
    ['ide', 'Manage IDE integration', 'tools'],
    ['commands', 'Manage custom slash commands', 'tools'],
    ['directory', 'Manage workspace directories', 'config'],
    ['shortcuts', 'Toggle shortcuts panel', 'config'],
    ['shells', 'Toggle background shells view', 'config'],
    ['terminal-setup', 'Configure terminal keybindings', 'config'],
    ['docs', 'Open documentation in browser', 'general'],
    ['bug', 'Submit a bug report', 'debug'],
    ['policies', 'Manage policies', 'config'],
    ['setup-github', 'Set up GitHub Actions', 'setup'],
    ['upgrade', 'Upgrade tier', 'auth'],
    ['quit', 'Exit the CLI', 'general'],
    ['corgi', 'Toggle corgi mode', 'general'],
];
// OpenCode TUI built-in slash commands.
// Source: https://opencode.ai/docs/tui/ ("all available slash commands").
const OPENCODE_COMMANDS = [
    ['help', 'Show the help dialog', 'general'],
    ['models', 'List available models', 'model'],
    ['themes', 'List available themes', 'config'],
    ['init', 'Guided setup to create or update AGENTS.md', 'config'],
    ['connect', 'Add a provider and enter its API key', 'auth'],
    ['editor', 'Open external $EDITOR to compose a message', 'general'],
    ['new', 'Start a new session', 'conversation'],
    ['clear', 'Start a new session (alias of /new)', 'conversation'],
    ['compact', 'Compact the current session', 'conversation'],
    ['summarize', 'Compact the current session (alias of /compact)', 'conversation'],
    ['sessions', 'List and switch between sessions', 'conversation'],
    ['resume', 'List and switch between sessions (alias of /sessions)', 'conversation'],
    ['continue', 'List and switch between sessions (alias of /sessions)', 'conversation'],
    ['undo', 'Undo last message and revert file changes via Git', 'conversation'],
    ['redo', 'Redo a previously undone message', 'conversation'],
    ['export', 'Export current conversation to Markdown', 'conversation'],
    ['share', 'Share current session', 'conversation'],
    ['unshare', 'Unshare current session', 'conversation'],
    ['details', 'Toggle tool execution details', 'debug'],
    ['thinking', 'Toggle visibility of thinking blocks', 'debug'],
    ['exit', 'Exit OpenCode', 'general'],
    ['quit', 'Exit OpenCode (alias of /exit)', 'general'],
    ['q', 'Exit OpenCode (alias of /exit)', 'general'],
];
// Kimi Code built-ins from the official command reference. User-installed
// plugins and skills can contribute additional commands at runtime.
const KIMI_COMMANDS = [
    ['help', 'Show available commands', 'general'],
    ['new', 'Start a new session', 'conversation'],
    ['clear', 'Start a new session', 'conversation'],
    ['sessions', 'Browse and switch sessions', 'conversation'],
    ['resume', 'Browse and switch sessions', 'conversation'],
    ['fork', 'Fork the current session', 'conversation'],
    ['title', 'Rename the current session', 'conversation'],
    ['compact', 'Compact conversation context', 'conversation'],
    ['model', 'Switch model', 'model'],
    ['plan', 'Enter plan mode', 'advanced'],
    ['login', 'Sign in', 'auth'],
    ['logout', 'Sign out', 'auth'],
    ['mcp-config', 'Configure MCP servers', 'tools'],
    ['plugins', 'Manage plugins', 'tools'],
    ['skills', 'List available skills', 'tools'],
    ['export', 'Export the session', 'conversation'],
];
const HERMES_COMMANDS = [
    ['help', 'Show available commands', 'general'],
    ['status', 'Show session, model, token, and context info', 'general'],
    ['usage', 'Show token usage and rate limits', 'general'],
    ['new', 'Start a new session', 'conversation'],
    ['resume', 'Resume a previous session', 'conversation'],
    ['sessions', 'Browse and resume previous sessions', 'conversation'],
    ['history', 'Show conversation history', 'conversation'],
    ['branch', 'Branch the current session', 'conversation'],
    ['compress', 'Compress conversation context', 'conversation'],
    ['undo', 'Back up and re-prompt from an earlier turn', 'conversation'],
    ['model', 'Switch model or provider', 'model'],
    ['reasoning', 'Manage reasoning effort and display', 'model'],
    ['yolo', 'Toggle dangerous-command auto approval', 'config'],
    ['memory', 'Review memory writes and approval settings', 'tools'],
    ['skills', 'Search, install, inspect, or manage skills', 'tools'],
    ['tools', 'List, enable, or disable tools', 'tools'],
    ['agents', 'Show active agents and running tasks', 'tools'],
    ['goal', 'Set or manage a standing goal', 'advanced'],
];
const PI_COMMANDS = [
    // Mirrors BUILTIN_SLASH_COMMANDS in pi's own
    // dist/core/slash-commands.js (v0.82.0), verbatim descriptions.
    ['settings', 'Open settings menu', 'config'],
    ['hotkeys', 'Show all keyboard shortcuts', 'general'],
    ['changelog', 'Show changelog entries', 'general'],
    ['session', 'Show session info and stats', 'general'],
    ['quit', 'Quit pi', 'general'],
    ['model', 'Select model (opens selector UI)', 'model'],
    ['scoped-models', 'Enable/disable models for Ctrl+P cycling', 'model'],
    ['new', 'Start a new session', 'conversation'],
    ['resume', 'Resume a different session', 'conversation'],
    ['name', 'Set session display name', 'conversation'],
    ['compact', 'Manually compact the session context', 'conversation'],
    ['tree', 'Navigate session tree (switch branches)', 'conversation'],
    ['fork', 'Create a new fork from a previous user message', 'conversation'],
    ['clone', 'Duplicate the current session at the current position', 'conversation'],
    ['copy', 'Copy last agent message to clipboard', 'conversation'],
    ['export', 'Export session (HTML default, or specify path: .html/.jsonl)', 'conversation'],
    ['import', 'Import and resume a session from a JSONL file', 'conversation'],
    ['share', 'Share session as a secret GitHub gist', 'conversation'],
    ['login', 'Configure provider authentication', 'config'],
    ['logout', 'Remove provider authentication', 'config'],
    ['trust', 'Save project trust decision for future sessions', 'config'],
    ['reload', 'Reload keybindings, extensions, skills, prompts, themes, and context files', 'config'],
];
const MINIMAL_COMMANDS = [
    ['help', 'Show help', 'general'],
    ['clear', 'Clear conversation', 'general'],
];
function buildCommands(tuples) {
    return tuples.map(([command, description, category]) => ({ command, description, category }));
}
/** Map InteractiveAgentKind -> built-in commands. */
const AGENT_BUILTIN_COMMANDS = {
    'claude-command': buildCommands(CLAUDE_COMMANDS),
    codex: buildCommands(CODEX_COMMANDS),
    gemini: buildCommands(GEMINI_COMMANDS),
    kimi: buildCommands(KIMI_COMMANDS),
    amp: buildCommands(MINIMAL_COMMANDS),
    opencode: buildCommands(OPENCODE_COMMANDS),
    cline: buildCommands(MINIMAL_COMMANDS),
    qoder: buildCommands(MINIMAL_COMMANDS),
    antigravity: buildCommands(MINIMAL_COMMANDS),
    hermes: buildCommands(HERMES_COMMANDS),
    // Cursor's TUI command palette is built at runtime (its ACP surface calls
    // loadCommands()), so there is no static list to mirror here without
    // inventing one. Its own in-TUI autocomplete still handles `/`.
    cursor: buildCommands(MINIMAL_COMMANDS),
    pi: buildCommands(PI_COMMANDS),
};
/** Built-in slash commands for an agent kind (empty for unknown/null). */
function getBuiltinAgentCommands(kind) {
    if (!kind)
        return [];
    return AGENT_BUILTIN_COMMANDS[kind] ?? [];
}
