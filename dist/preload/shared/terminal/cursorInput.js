"use strict";
/*
 * Cursor CLI input compatibility.
 *
 * Cursor Agent can leave SGR mouse reporting enabled without consuming the
 * reports from stdin, especially through Windows ConPTY. xterm emits each
 * browser mouse event through onData as a complete report; forwarding it
 * makes Cursor insert the printable tail (for example `[<35;53;14M`) into its
 * composer. See docs/common-errors/terminals/cursor-cli-sgr-mouse-garbage.md.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isCursorSgrMouseInput = isCursorSgrMouseInput;
const SGR_MOUSE_INPUT_RE = /^(?:\x1b\[<\d+;\d+;\d+[Mm])+$/;
/** True only for xterm-generated SGR mouse input targeting Cursor Agent. */
function isCursorSgrMouseInput(kind, data) {
    return kind === 'cursor' && SGR_MOUSE_INPUT_RE.test(data);
}
