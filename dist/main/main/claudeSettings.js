"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveClaudeSettingsTargets = resolveClaudeSettingsTargets;
exports.ensureClaudeScrollSettings = ensureClaudeScrollSettings;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const orchestrationShim_1 = require("../shared/orchestrationShim");
/** UTF-8 BOM codepoint (U+FEFF). Written as a numeric literal so no invisible
 *  character lives in this source file (an editor "fix encoding" pass can
 *  silently delete an embedded BOM and break the stripping below). */
const BOM_CODEPOINT = 0xfeff;
/**
 * The two keys we ensure in the user's global Claude Code settings.
 *
 *  - `tui: 'default'` selects the classic main-screen renderer instead of the
 *    newer `'fullscreen'` alt-screen renderer. Fullscreen relies on the
 *    terminal's alt-buffer (CSI 47/1047/1049) which 1DevTool's embedded xterm
 *    terminals deliberately block for AI sessions — leaving the user unable to
 *    scroll Claude's output. `'default'` keeps Claude on the normal buffer so
 *    xterm owns the scrollback.
 *  - `verbose: true` shows full tool output rather than truncated summaries,
 *    which reads better in the scrollable normal buffer.
 */
const DESIRED_SETTINGS = {
    verbose: true,
    tui: 'default',
};
const ORCHESTRATION_STOP_HOOK_MARKER = 'hook-event --event=done --payload-stdin';
function hookCommand(homeDir) {
    const shim = path_1.default.join(homeDir, '.1devtool', 'bin', process.platform === 'win32' ? orchestrationShim_1.ORCHESTRATOR_SHIM_NAME_WIN : orchestrationShim_1.ORCHESTRATOR_SHIM_NAME_UNIX);
    const quoted = process.platform === 'win32'
        ? `"${shim.replace(/\\/g, '/').replace(/"/g, '\\"')}"`
        : `'${shim.replace(/'/g, `'\\''`)}'`;
    return `${quoted} ${ORCHESTRATION_STOP_HOOK_MARKER}`;
}
function hasOrchestrationStopHook(settings, expectedCommand) {
    const hooks = settings.hooks;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks))
        return false;
    const stop = hooks.Stop;
    return Array.isArray(stop) && JSON.stringify(stop).includes(expectedCommand ?? ORCHESTRATION_STOP_HOOK_MARKER);
}
function alreadyCorrect(settings, orchestrationHookCommand) {
    return settings.verbose === DESIRED_SETTINGS.verbose && settings.tui === DESIRED_SETTINGS.tui &&
        (!orchestrationHookCommand || hasOrchestrationStopHook(settings, orchestrationHookCommand));
}
function mergeOrchestrationStopHook(settings, command) {
    const rawHooks = settings.hooks;
    if (rawHooks !== undefined && (!rawHooks || typeof rawHooks !== 'object' || Array.isArray(rawHooks))) {
        return { ok: false, error: 'settings.json hooks is not an object' };
    }
    const hooks = (rawHooks ?? {});
    const rawStop = hooks.Stop;
    if (rawStop !== undefined && !Array.isArray(rawStop)) {
        return { ok: false, error: 'settings.json hooks.Stop is not an array' };
    }
    let replaced = false;
    const stop = (rawStop ?? []).map((group) => {
        if (!group || typeof group !== 'object' || Array.isArray(group))
            return group;
        const rawGroupHooks = group.hooks;
        if (!Array.isArray(rawGroupHooks))
            return group;
        const nextGroupHooks = rawGroupHooks.map((hook) => {
            if (!hook || typeof hook !== 'object' || Array.isArray(hook))
                return hook;
            const rawCommand = hook.command;
            if (typeof rawCommand !== 'string' || !rawCommand.includes(ORCHESTRATION_STOP_HOOK_MARKER))
                return hook;
            replaced = true;
            return { ...hook, command };
        });
        return { ...group, hooks: nextGroupHooks };
    });
    return {
        ok: true,
        settings: {
            ...settings,
            hooks: {
                ...hooks,
                Stop: replaced
                    ? stop
                    : [...stop, {
                            matcher: '',
                            hooks: [{ type: 'command', command, timeout: 10 }],
                        }],
            },
        },
    };
}
/** Drop a leading UTF-8 BOM so JSON.parse doesn't throw on it. Windows editors
 *  (e.g. Notepad) prepend one; without this a perfectly valid settings file
 *  would be misread as malformed and never patched. */
function stripBom(text) {
    return text.charCodeAt(0) === BOM_CODEPOINT ? text.slice(1) : text;
}
/**
 * Every settings.json claude might actually read for this user, most
 * authoritative first, deduped (case-insensitively on Windows):
 *
 *  1. `$CLAUDE_CONFIG_DIR/settings.json` when the env sets it — claude's own
 *     override; when present this is the ONLY file claude reads.
 *  2. The 1DevTool AI-path override root, when configured in Settings → AI.
 *  3. The platform default `~/.claude/settings.json`.
 *
 * We patch all of them: the list is tiny, the ensure is idempotent, and each
 * entry is the effective location for some way of launching claude. Patching
 * only one (the old behavior) is exactly how the fix silently missed users —
 * e.g. an rc-file `export CLAUDE_CONFIG_DIR=…` redirected claude away from the
 * `~/.claude/settings.json` we had just written.
 */
function resolveClaudeSettingsTargets(overrides, options = {}) {
    const env = options.env ?? process.env;
    const homeDir = options.homeDir ?? os_1.default.homedir();
    const targets = [];
    const rawEnvDir = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
    if (rawEnvDir) {
        // Tolerate a literal leading `~` (e.g. a value set outside a shell, or an
        // unexpanded Windows profile path someone typed by hand).
        const expanded = rawEnvDir === '~'
            ? homeDir
            : /^~[\\/]/.test(rawEnvDir)
                ? path_1.default.join(homeDir, rawEnvDir.slice(2))
                : rawEnvDir;
        // A relative CLAUDE_CONFIG_DIR resolves against claude's cwd, which we
        // can't know here — skip it rather than guess and patch a wrong file.
        if (path_1.default.isAbsolute(expanded)) {
            targets.push(path_1.default.join(expanded, 'settings.json'));
        }
    }
    const rawOverride = overrides?.claude?.trim();
    if (rawOverride) {
        targets.push(path_1.default.join(rawOverride.replace(/[\\/]+$/, ''), 'settings.json'));
    }
    targets.push(path_1.default.join(homeDir, '.claude', 'settings.json'));
    const seen = new Set();
    const deduped = [];
    for (const target of targets) {
        const key = process.platform === 'win32' ? path_1.default.resolve(target).toLowerCase() : path_1.default.resolve(target);
        if (!seen.has(key)) {
            seen.add(key);
            deduped.push(target);
        }
    }
    return deduped;
}
/**
 * Ensure one settings.json contains the scroll-fix keys.
 *
 * Friendly + safe by design:
 *  - **Idempotent.** If both keys already match, we skip writing entirely — no
 *    redundant disk churn, and the common case (already configured) is a no-op.
 *  - **Non-destructive.** We only ever touch `verbose`/`tui`; every other key
 *    the user (or another tool) put there is preserved and re-emitted in place.
 *  - **Never clobbers.** If the file exists but is unreadable or not valid JSON,
 *    we leave it exactly as-is rather than risk destroying real settings. The
 *    exceptions are contentless files — empty/whitespace-only or a bare `null`
 *    (common after an interrupted write or a `touch`) — which hold no user data
 *    and previously wedged the fix forever in a silent skip.
 *  - **Symlink-aware.** Writes land on the realpath so a dotfiles-managed
 *    `settings.json → ~/dotfiles/…` symlink survives; a plain rename would
 *    replace the link itself. The original file's mode is preserved too.
 *  - **Atomic.** Writes go to a temp file and are renamed into place so a crash
 *    mid-write can't corrupt the user's settings. (`fs.rename` replaces an
 *    existing destination on Windows too — libuv uses MoveFileEx with
 *    MOVEFILE_REPLACE_EXISTING — and the temp file shares the target's
 *    directory so the rename stays on one volume.)
 */
async function ensureScrollSettingsFile(settingsPath, orchestrationHookCommand) {
    try {
        let existing = {};
        let fileExisted = false;
        try {
            const raw = await fs_1.promises.readFile(settingsPath, 'utf-8');
            fileExisted = true;
            const text = stripBom(raw).trim();
            if (text.length === 0) {
                // Empty or whitespace-only file: nothing to preserve, safe to patch.
                existing = {};
            }
            else {
                const parsed = JSON.parse(text);
                if (parsed === null) {
                    // A literal `null` carries no settings — treat like an empty file.
                    existing = {};
                }
                else if (typeof parsed === 'object' && !Array.isArray(parsed)) {
                    existing = parsed;
                }
                else {
                    // A non-object settings.json isn't something we understand — leave it be.
                    return { status: 'skip', path: settingsPath, error: 'settings.json is not a JSON object' };
                }
            }
        }
        catch (err) {
            const code = err?.code;
            if (code !== 'ENOENT') {
                // Exists but unreadable or malformed JSON — never overwrite user data.
                return {
                    status: 'skip',
                    path: settingsPath,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
            // ENOENT → no file yet; fall through to create one.
        }
        if (alreadyCorrect(existing, orchestrationHookCommand)) {
            return { status: 'skip', path: settingsPath };
        }
        // Spread preserves existing key order/values; our two keys are updated in
        // place if present, or appended if new.
        let next = { ...existing, ...DESIRED_SETTINGS };
        if (orchestrationHookCommand) {
            const merged = mergeOrchestrationStopHook(next, orchestrationHookCommand);
            if (!merged.ok)
                return { status: 'skip', path: settingsPath, error: merged.error };
            next = merged.settings;
        }
        // Write onto the symlink target (if any) and keep the original mode.
        let writeTarget = settingsPath;
        let mode;
        if (fileExisted) {
            writeTarget = await fs_1.promises.realpath(settingsPath).catch(() => settingsPath);
            mode = await fs_1.promises
                .stat(writeTarget)
                .then((st) => st.mode & 0o777)
                .catch(() => undefined);
        }
        await fs_1.promises.mkdir(path_1.default.dirname(writeTarget), { recursive: true });
        const tmpPath = `${writeTarget}.1dt-tmp-${process.pid}`;
        try {
            await fs_1.promises.writeFile(tmpPath, JSON.stringify(next, null, 2) + '\n', {
                encoding: 'utf-8',
                ...(mode !== undefined ? { mode } : {}),
            });
            await fs_1.promises.rename(tmpPath, writeTarget);
        }
        catch (writeErr) {
            // Best-effort cleanup so a failed rename (e.g. the destination is
            // momentarily locked by antivirus on Windows) doesn't litter .claude.
            // Swallow cleanup errors; report the original failure.
            await fs_1.promises.rm(tmpPath, { force: true }).catch(() => { });
            throw writeErr;
        }
        return { status: fileExisted ? 'patched' : 'created', path: settingsPath };
    }
    catch (error) {
        return {
            status: 'error',
            path: settingsPath,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
/**
 * Ensure claude's global settings disable the fullscreen TUI so Claude is
 * scrollable inside 1DevTool's embedded terminals — in every location claude
 * might read them from (see resolveClaudeSettingsTargets). Returns one result
 * per candidate file, most authoritative first.
 *
 * Cross-platform: all paths flow through `path.join(homeDir, …)`, so this
 * yields `C:\Users\<name>\.claude\settings.json` on Windows and
 * `~/.claude/settings.json` on POSIX without any string munging. Known limit:
 * claude running inside WSL keeps its settings in the WSL filesystem, which we
 * can't reach from the Windows side.
 */
async function ensureClaudeScrollSettings(overrides, options = {}) {
    const results = [];
    const command = options.installOrchestrationHook ? hookCommand(options.homeDir ?? os_1.default.homedir()) : undefined;
    for (const target of resolveClaudeSettingsTargets(overrides, options)) {
        results.push(await ensureScrollSettingsFile(target, command));
    }
    return results;
}
