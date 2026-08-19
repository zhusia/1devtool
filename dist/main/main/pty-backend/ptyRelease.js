"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.releasePty = releasePty;
exports.releaseExitedPty = releaseExitedPty;
/**
 * Close a PTY's master file descriptor.
 *
 * `IPty.kill()` ONLY signals the child (`process.kill(pid, 'SIGHUP')`) — it never
 * closes the master fd. node-pty closes that fd from exactly one place,
 * `destroy()`, because its own `_socket` 'error' handler returns early on the EIO
 * a dying child produces, after setting `_emittedClose` — which also cancels the
 * 200 ms destroy fallback its exit path would otherwise schedule.
 *
 * So `kill()` followed by dropping the instance strands the fd for the lifetime of
 * the process: the last reference is gone and Node never closes raw fds on GC.
 * Pseudo-terminals are a MACHINE-WIDE resource (macOS `kern.tty.ptmx_max`, 511 by
 * default), so a long multi-project session burns the whole machine's PTY budget
 * and every other app — tmux, Terminal.app, iTerm — starts failing to open a
 * terminal until 1DevTool quits.
 *
 * See docs/common-errors/terminals/pty-master-fd-leak.md.
 */
function closePtyMaster(ptyProcess) {
    // ConPTY has no separate master fd to reclaim: WindowsTerminal.destroy() is an
    // alias for kill(), so calling both would tear the agent down twice.
    if (process.platform === 'win32')
        return;
    const closable = ptyProcess;
    if (typeof closable.destroy !== 'function')
        return;
    try {
        closable.destroy();
    }
    catch {
        // Socket already torn down — the fd is released either way.
    }
}
/**
 * Terminate a PTY we own: signal the child, then release the master fd.
 * Every teardown path must use this — never a bare `pty.kill()`. Closing the
 * master also frees the pty unit when the child ignores SIGHUP (AI agent CLIs
 * that trap it, or grandchildren still holding the slave open).
 */
function releasePty(ptyProcess) {
    try {
        ptyProcess.kill();
    }
    catch {
        // ESRCH — already exited. The fd still needs closing.
    }
    closePtyMaster(ptyProcess);
}
/**
 * Release the master fd of a PTY whose child has already exited. Never signals:
 * the pid may have been recycled by the OS, and SIGHUP would hit a stranger.
 */
function releaseExitedPty(ptyProcess) {
    closePtyMaster(ptyProcess);
}
