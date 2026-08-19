"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRendererGuards = createRendererGuards;
/**
 * Renderer trust guards — THE security boundary for renderer-only IPC
 * (docs/tasks_v2.md §8.1a).
 *
 * THE ONLY COPY, as of P2. `src/main/ipc/orchestration.ts` and
 * `src/main/ipc/tasks.ts` both import from here; the duplicate that used to
 * live in orchestration.ts — and the source-reading drift test that watched it
 * — are gone. A security check with two definitions eventually has two
 * behaviours, so if a third consumer appears, it imports this too.
 *
 * - `isMainRenderer`: is this Electron IPC from the trusted main renderer at
 *   all (sender-boundary check).
 * - `hasMainRendererGesture`: additionally, is there a live Chromium user
 *   activation (synthetic DOM events cannot create one), optionally bound to
 *   the DOM terminal that owns focus. Chromium's transient activation is the
 *   proof; `BrowserWindow.isFocused()` is deliberately not a second gate.
 *   macOS can update Electron's focus bit after delivering the trusted click,
 *   which made the first real click fail and made the security lane depend on
 *   whichever app happened to be frontmost.
 */
function createRendererGuards(getMainWindow) {
    const isMainRenderer = (event) => {
        const window = getMainWindow?.();
        return Boolean(window &&
            !window.isDestroyed() &&
            event.sender.id === window.webContents.id);
    };
    const hasMainRendererGesture = async (event, expectedTerminalId) => {
        if (!isMainRenderer(event))
            return false;
        try {
            // Chromium owns this state: synthetic DOM events do not create a
            // transient user activation. Main reads it itself instead of trusting a
            // renderer-supplied `isTrusted` boolean. Mention-created links also bind
            // the proof to the DOM terminal that actually owns focus.
            const terminalCheck = expectedTerminalId
                ? `document.activeElement?.closest?.('[data-terminal-id]')?.getAttribute('data-terminal-id') === ${JSON.stringify(expectedTerminalId)}`
                : 'true';
            return await event.sender.executeJavaScript(`navigator.userActivation?.isActive === true && (${terminalCheck})`) === true;
        }
        catch {
            return false;
        }
    };
    return { isMainRenderer, hasMainRendererGesture };
}
