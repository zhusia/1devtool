"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.remoteSizeAuthority = exports.RemoteSizeAuthorityRegistry = void 0;
exports.decideMirrorSize = decideMirrorSize;
exports.resolveEffectiveSize = resolveEffectiveSize;
exports.createTerminalSizeBroadcaster = createTerminalSizeBroadcaster;
/**
 * Decide whether a Remote Control mirror may resize the shared PTY.
 *
 * Size authority is tmux-style (docs/common-errors/remote/
 * remote-phone-size-authority.md): while at least one operator phone is
 * actively viewing the terminal, the phones own PTY dims (smallest-wins
 * across viewers) — a desktop-locked grid is both wider and taller than the
 * phone slot, which made the mirror unreadable (horizontal pan to read every
 * line, tail rows clipped under the composer). When the last phone viewer
 * detaches, the PTY heals back to the recorded desktop dims.
 *
 * Without an active phone claim, desktop dims stay authoritative for the
 * terminal's WHOLE lifetime once any desktop pane has sized it — not merely
 * while one is mounted. Gating on the live attachment count alone left a
 * hole: the count drops to 0 on every tab/project switch (and transiently
 * during every remount), and a stray fit in that window resized the shared
 * PTY to phone columns with nobody watching
 * (docs/common-errors/remote/remote-resize-desktop-layout.md).
 *
 * Terminals no desktop pane has ever sized (true remote-only terminals)
 * always fit to the phone viewport.
 */
function decideMirrorSize(input) {
    const { desktopAttached, desktopSize, liveSize, remoteAuthority } = input;
    if (remoteAuthority) {
        return { locked: false, size: liveSize, healTo: null };
    }
    if (!desktopAttached && !desktopSize) {
        return { locked: false, size: liveSize, healTo: null };
    }
    // Unmounted desktop owner + live PTY at different dims: the PTY was
    // respawned at its default since the desktop pane last sized it. Restore
    // the desktop dims so the TUI paints at the owned width from the start.
    // While a pane IS attached its own fit is the freshest truth — never
    // fight it from the mirror path.
    if (desktopSize &&
        !desktopAttached &&
        liveSize &&
        (liveSize.cols !== desktopSize.cols || liveSize.rows !== desktopSize.rows)) {
        return { locked: true, size: desktopSize, healTo: desktopSize };
    }
    return { locked: true, size: liveSize ?? desktopSize, healTo: null };
}
/**
 * Smallest-wins arbiter across the active phone viewers of one terminal:
 * every viewer must be able to read every column and reach every row, so the
 * effective grid is the per-axis minimum (the tmux multi-client policy).
 */
function resolveEffectiveSize(desires) {
    const valid = desires.filter((d) => Number.isFinite(d.cols) && Number.isFinite(d.rows) && d.cols > 0 && d.rows > 0);
    if (valid.length === 0)
        return null;
    return {
        cols: Math.min(...valid.map((d) => d.cols)),
        rows: Math.min(...valid.map((d) => d.rows)),
    };
}
/**
 * Which remote viewers currently hold size authority over which terminals.
 *
 * An operator phone claims a terminal when it subscribes to the terminal
 * detail screen and releases it on unsubscribe/disconnect. While ≥1 claim is
 * live, phone fits resize the shared PTY (smallest-wins across claims) and
 * desktop `pty:resize` requests are recorded as the heal target but NOT
 * applied — otherwise the desktop pane's ResizeObserver fit and the 5s
 * dims-desync probe would stomp the phone's grid every few seconds.
 *
 * One instance is shared by the socket handlers (claim/release/resize), the
 * desktop `pty:resize` IPC gate, and — via `onChange` — the renderer's
 * per-terminal "Sized for phone" status badge (see `remoteSizeAuthority`
 * below).
 */
class RemoteSizeAuthorityRegistry {
    /** terminalId -> viewerId (socket id) -> that viewer's claim. */
    claims = new Map();
    listeners = new Set();
    /** Register a viewer. Size arrives later via `setViewerSize`. */
    claim(terminalId, viewerId, label = null) {
        let viewers = this.claims.get(terminalId);
        if (!viewers) {
            viewers = new Map();
            this.claims.set(terminalId, viewers);
        }
        const existing = viewers.get(viewerId);
        if (!existing) {
            viewers.set(viewerId, { size: null, label });
        }
        else if (label !== null && existing.label !== label) {
            existing.label = label;
        }
        else {
            return; // no state change — don't notify
        }
        this.emit(terminalId);
    }
    setViewerSize(terminalId, viewerId, size) {
        this.claim(terminalId, viewerId);
        this.claims.get(terminalId).get(viewerId).size = size;
    }
    /** Drop one viewer's claim. Returns true when the LAST claim was released. */
    release(terminalId, viewerId) {
        const viewers = this.claims.get(terminalId);
        if (!viewers || !viewers.delete(viewerId))
            return false;
        const last = viewers.size === 0;
        if (last)
            this.claims.delete(terminalId);
        this.emit(terminalId);
        return last;
    }
    /** Disconnect cleanup: returns the terminalIds that lost their last claim. */
    releaseViewer(viewerId) {
        const freed = [];
        for (const terminalId of Array.from(this.claims.keys())) {
            if (this.release(terminalId, viewerId))
                freed.push(terminalId);
        }
        return freed;
    }
    hasAuthority(terminalId) {
        return (this.claims.get(terminalId)?.size ?? 0) > 0;
    }
    /**
     * Display name of the claiming device — the most recently claimed viewer
     * with a known label (usually there is exactly one phone).
     */
    deviceLabel(terminalId) {
        const viewers = this.claims.get(terminalId);
        if (!viewers)
            return null;
        let label = null;
        for (const claim of viewers.values()) {
            if (claim.label)
                label = claim.label;
        }
        return label;
    }
    /**
     * Drop every claim. Called on remote-server stop as a backstop: normal
     * teardown releases via each socket's `disconnect` handler, but a stale
     * claim surviving an abnormal teardown would gate desktop `pty:resize`
     * forever with no phone attached. After the clear, the desktop pane's next
     * fit (or the 5s dims-desync probe) restores desktop dims on its own.
     */
    clear() {
        const terminalIds = Array.from(this.claims.keys());
        this.claims.clear();
        for (const terminalId of terminalIds)
            this.emit(terminalId);
    }
    /** Sizes of all claiming viewers that have reported one. */
    viewerSizes(terminalId) {
        const viewers = this.claims.get(terminalId);
        if (!viewers)
            return [];
        return Array.from(viewers.values())
            .map((claim) => claim.size)
            .filter((s) => s !== null);
    }
    /**
     * Follow authority transitions (badge feed). Fired on claim, release, and
     * clear with the terminal's recomputed state; listeners must treat events
     * as idempotent snapshots.
     */
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    emit(terminalId) {
        if (this.listeners.size === 0)
            return;
        const change = {
            terminalId,
            hasAuthority: this.hasAuthority(terminalId),
            deviceLabel: this.deviceLabel(terminalId),
        };
        for (const listener of this.listeners) {
            try {
                listener(change);
            }
            catch {
                // A broken badge feed must never break size arbitration.
            }
        }
    }
}
exports.RemoteSizeAuthorityRegistry = RemoteSizeAuthorityRegistry;
/**
 * Process-wide singleton — imported by both the remote socket handlers and
 * the desktop `pty:resize` IPC gate. Holding it here (a dependency-free
 * module) keeps `src/main/ipc/terminal.ts` decoupled from the remote server
 * lifecycle: when Remote Control is off the registry is simply empty.
 */
exports.remoteSizeAuthority = new RemoteSizeAuthorityRegistry();
/**
 * Debounced `terminal:size` broadcaster for one terminal's room.
 *
 * The subscribe/resize acks carry dims exactly once; when the desktop refits
 * the shared PTY afterwards (window resize, pane drag, reformat, heal), the
 * mirror must re-lock to the new grid — the TUI's relative-cursor redraws are
 * emitted for those dims, and parsing them on a stale grid overlaps old rows
 * (docs/common-errors/remote/remote-mirror-stale-size-ghosting.md).
 *
 * A desktop drag-resize fires a burst of pty:resize calls; only the settled
 * dims matter to a phone mirror, so `schedule()` coalesces the burst with a
 * trailing debounce and the decision is re-read at fire time (freshest
 * truth). Output batched at the OLD dims is flushed before the emit so the
 * mirror never adopts the new grid ahead of bytes meant for the old one.
 */
function createTerminalSizeBroadcaster(options) {
    let timer = null;
    const fire = () => {
        timer = null;
        const decision = options.readDecision();
        if (!decision.size)
            return;
        options.flushPendingOutput();
        options.emit({
            cols: decision.size.cols,
            rows: decision.size.rows,
            desktopAttached: decision.locked,
        });
    };
    return {
        schedule() {
            if (timer)
                clearTimeout(timer);
            timer = setTimeout(fire, options.debounceMs);
        },
        dispose() {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        },
    };
}
