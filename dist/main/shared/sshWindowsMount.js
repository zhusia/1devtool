"use strict";
/**
 * Pure Windows SSHFS-Win helpers (no Electron / Node process APIs).
 *
 * SSHFS-Win `svc` mounts use a drive letter and a long-lived process tree.
 * Unmount cannot rely on `net use X: /delete` alone — see
 * docs/common-errors/ssh/windows-sshfs-svc-unmount.md.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeWindowsDriveSpec = normalizeWindowsDriveSpec;
exports.windowsSshfsCommandMentionsDrive = windowsSshfsCommandMentionsDrive;
/** Normalize `Z:\` / `z:` / `Z:/` to the `Z:` form used by net use and sshfs-win. */
function normalizeWindowsDriveSpec(mountPath) {
    const match = /^([A-Za-z]):/.exec(String(mountPath || '').trim());
    if (!match) {
        const stripped = String(mountPath || '').replace(/[\\/]+$/, '');
        return stripped || mountPath;
    }
    return `${match[1].toUpperCase()}:`;
}
/**
 * True when an sshfs-win command line mounts the given drive letter as a
 * standalone argument (not merely contains the letter somewhere in a path).
 *
 * Typical argv: `sshfs-win.exe svc \sshfs\user@host Z: DOMAIN\User -o …`
 */
function windowsSshfsCommandMentionsDrive(commandLine, driveSpec) {
    const drive = normalizeWindowsDriveSpec(driveSpec);
    const letter = drive.replace(/:$/, '');
    if (!/^[A-Za-z]$/.test(letter))
        return false;
    return new RegExp(`(?:^|[\\s"])${letter}:(?=$|[\\s"])`, 'i').test(commandLine || '');
}
