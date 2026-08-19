"use strict";
/*
 * ⚠ Terminal/process lifecycle guard — read
 * docs/common-errors/terminals/INDEX.md before editing.
 *
 * Electron main and the PTY utility host own several pipe-backed streams.
 * A peer closing one of those pipes reports the failed write asynchronously,
 * so try/catch around a write cannot prevent a fatal `write EPIPE` event.
 * See save-quit-conpty-epipe.md and windows-child-stdin-epipe.md.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EXPECTED_CLOSED_PROCESS_STREAM_CODES = void 0;
exports.isExpectedClosedProcessStreamError = isExpectedClosedProcessStreamError;
exports.isExpectedClosedPipeWriteException = isExpectedClosedPipeWriteException;
exports.installProcessStreamErrorGuards = installProcessStreamErrorGuards;
exports.installChildStdinErrorGuard = installChildStdinErrorGuard;
exports.installExpectedClosedPipeExceptionGuard = installExpectedClosedPipeExceptionGuard;
exports.EXPECTED_CLOSED_PROCESS_STREAM_CODES = Object.freeze([
    'EPIPE',
    'EIO',
    'ECONNRESET',
    'ERR_STREAM_DESTROYED',
    'ERR_SOCKET_CLOSED',
]);
function isExpectedClosedProcessStreamError(error) {
    const code = error?.code;
    return typeof code === 'string' && exports.EXPECTED_CLOSED_PROCESS_STREAM_CODES.includes(code);
}
function isExpectedClosedPipeWriteException(error) {
    const streamError = error;
    // libuv maps some Windows anonymous-pipe closes to EOF rather than EPIPE.
    // Keep that wider code at the write-shaped process backstop only; the
    // node-pty and inherited diagnostic-stream code lists remain exact.
    if (!isExpectedClosedProcessStreamError(error) && streamError?.code !== 'EOF')
        return false;
    return streamError.syscall === 'write' || /^write\b/i.test(streamError.message);
}
/**
 * Keep diagnostic stdout/stderr failures from becoming uncaught exceptions.
 * The optional reporter must not write back to either guarded stream.
 */
function installProcessStreamErrorGuards(options = {}) {
    const stdout = options.stdout ?? process.stdout;
    const stderr = options.stderr ?? process.stderr;
    const streams = stdout === stderr ? [stdout] : [stdout, stderr];
    const onError = (error) => {
        if (isExpectedClosedProcessStreamError(error))
            return;
        options.onUnexpected?.(error);
    };
    for (const stream of streams)
        stream.on('error', onError);
    return () => {
        for (const stream of streams)
            stream.removeListener('error', onError);
    };
}
/**
 * ChildProcess emits a failed stdin write on child.stdin, not on the child.
 * Keep this listener for the full stream lifetime; removing it at child `exit`
 * can reopen the exact late-error race it is meant to close.
 */
function installChildStdinErrorGuard(stdin, onError) {
    const listener = (error) => onError(error);
    stdin.on('error', listener);
    return () => stdin.removeListener('error', listener);
}
/**
 * Final process boundary for a closed pipe whose owning stream was missed.
 * Exact closed-transport codes are safe to consume. Any other exception is
 * rethrown after removing this listener so Electron/Node retains its normal
 * fatal-exception behavior.
 */
function installExpectedClosedPipeExceptionGuard(options = {}) {
    const target = options.target ?? process;
    const listener = (error) => {
        if (isExpectedClosedPipeWriteException(error)) {
            options.onExpected?.(error);
            return;
        }
        target.removeListener('uncaughtException', listener);
        throw error;
    };
    target.on('uncaughtException', listener);
    return () => target.removeListener('uncaughtException', listener);
}
