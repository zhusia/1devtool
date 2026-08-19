"use strict";
/**
 * Command sequences: turn a one-command-per-line block into the single shell
 * line that 1DevTool types into a terminal at startup.
 *
 * The terminal engine runs a startup command by writing `${command}\r` into the
 * shell — i.e. exactly as if the user typed the line and pressed Enter (see
 * src/main/pty.ts). So "run several commands in order in the same session" is
 * just a compound shell line; the only subtlety is the separator, which differs
 * by shell:
 *
 *   stop-on-error : `a && b && c`  — works in cmd.exe, bash, zsh, PowerShell 7.
 *                                    (Windows PowerShell 5.1 has no `&&`.)
 *   run-all       : `a & b & c`    on win32 (cmd.exe: `;` is NOT a separator)
 *                   `a ; b ; c`    on mac/linux (bash/zsh/pwsh)
 *
 * We keep the whole thing on ONE line on purpose: a single line has no interior
 * newline, so on Windows it can't be split at a `\n` chunk boundary by ConPTY
 * (the truncation/early-submit class of bug). Writing each command on its own
 * raw line would reintroduce that risk.
 *
 * Known limitation (documented, intentionally unsupported): a terminal whose
 * shell is overridden to legacy Windows PowerShell 5.1 cannot run `&&`. Use
 * PowerShell 7 (pwsh) or the default cmd.exe.
 *
 * WSL target (win32 only): the joined line is wrapped in `wsl -- bash -lc "…"`.
 * `-l` (login shell) is load-bearing — `wsl -- bash -c` skips the user's login
 * environment, so anything on a profile-managed PATH (nvm, npm globals) is
 * "command not found". Because bash executes the joined line, separators follow
 * POSIX rules regardless of the Windows host (`run-all` is `;`, never cmd's `&`).
 *
 * No renderer/main-only imports — safe to use from both processes and tests.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSequenceLines = parseSequenceLines;
exports.isMultiCommandSource = isMultiCommandSource;
exports.joinSequenceLines = joinSequenceLines;
exports.wrapCommandForWsl = wrapCommandForWsl;
exports.collapseCommandSequence = collapseCommandSequence;
exports.detectLinuxOnlyCommands = detectLinuxOnlyCommands;
exports.usesNonLoginBash = usesNonLoginBash;
/**
 * Split a raw multi-line command block into the runnable command lines:
 * trims each line, drops blank lines and `#`-prefixed comment lines.
 */
function parseSequenceLines(source) {
    if (!source)
        return [];
    return source
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));
}
/** True when the raw source resolves to more than one runnable command. */
function isMultiCommandSource(source) {
    return parseSequenceLines(source).length > 1;
}
/**
 * Join runnable command lines into a single shell line using the correct
 * separator for the target platform's default shell. A single line (or empty)
 * is returned unchanged.
 */
function joinSequenceLines(lines, mode, isWindows) {
    const runnable = lines.map((line) => line.trim()).filter(Boolean);
    if (runnable.length <= 1)
        return runnable[0] ?? '';
    const separator = mode === 'stop-on-error' ? ' && ' : isWindows ? ' & ' : ' ; ';
    return runnable.join(separator);
}
/**
 * Wrap a shell line so it runs inside the default WSL distro through a LOGIN
 * shell. The line is typed into cmd.exe, so the wrapper must be one
 * double-quoted argument (bare `&&`/`&` would be eaten by cmd itself); embedded
 * double quotes are escaped for the cmd → wsl.exe argv boundary.
 */
function wrapCommandForWsl(command) {
    return `wsl -- bash -lc "${command.replace(/"/g, '\\"')}"`;
}
/**
 * Convenience: parse a raw block and collapse it to the single startup line.
 * `isWindows` should reflect the machine the command will RUN on (for local
 * presets that is the authoring machine). With `target: 'wsl'`, bash executes
 * the joined line, so separators are POSIX and even a single command is wrapped
 * (the wrap is what fixes the WSL login PATH).
 */
function collapseCommandSequence(source, mode, isWindows, target = 'default') {
    if (target === 'wsl') {
        const joined = joinSequenceLines(parseSequenceLines(source), mode, false);
        return joined ? wrapCommandForWsl(joined) : '';
    }
    return joinSequenceLines(parseSequenceLines(source), mode, isWindows);
}
// First-token commands that only exist inside a Linux environment. Kept
// conservative on purpose: a false positive nags users, a miss just skips the
// hint. `bash` is NOT listed — bash.exe on Windows is the WSL launcher itself.
const LINUX_ONLY_COMMANDS = new Set([
    'sudo',
    'systemctl',
    'service',
    'journalctl',
    'apt',
    'apt-get',
    'dnf',
    'yum',
    'pacman',
    'zypper',
    'snap',
]);
/**
 * Linux-only commands a sequence would try to run directly in a Windows shell.
 * Looks at each line's first token (and the token after `sudo`); used to warn
 * before a `systemctl …` line silently fails in cmd.exe.
 */
function detectLinuxOnlyCommands(lines) {
    const found = [];
    for (const line of lines) {
        const tokens = line.trim().split(/\s+/);
        const first = tokens[0]?.toLowerCase() ?? '';
        const candidates = first === 'sudo' ? [first, tokens[1]?.toLowerCase() ?? ''] : [first];
        for (const candidate of candidates) {
            if (LINUX_ONLY_COMMANDS.has(candidate) && !found.includes(candidate))
                found.push(candidate);
        }
    }
    return found;
}
/**
 * True when a command invokes bash with `-c` but neither `-l` nor `-i` — a
 * non-login, non-interactive shell that skips the user's profile, so the WSL
 * PATH (nvm, npm globals) is missing. The classic trap is `wsl -- bash -c "…"`.
 */
function usesNonLoginBash(command) {
    const match = command.match(/\bbash(?:\.exe)?((?:\s+-[A-Za-z]+)+)/);
    if (!match)
        return false;
    const letters = new Set((match[1].match(/-[A-Za-z]+/g) ?? []).flatMap((flag) => flag.slice(1).split('')));
    return letters.has('c') && !letters.has('l') && !letters.has('i');
}
