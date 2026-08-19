"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPreloadPath = getPreloadPath;
exports.getRendererHtmlPath = getRendererHtmlPath;
/*
 * ⚠ Renderer asset paths for every BrowserWindow (main, popout terminal,
 * sub-agent history, cron manager) resolve HERE and nowhere else.
 *
 * The `../../` hops are correct only from this module's compiled location
 * (dist/main/main/). A `path.join(__dirname, '../../preload/…')` copied into a
 * deeper file (e.g. src/main/ipc/* → dist/main/main/ipc/) resolves inside
 * dist/main/ where nothing exists: the window then loads with NO preload,
 * `window.api` is undefined, the renderer entry throws before React mounts,
 * and the window stays a solid backgroundColor blank
 * (docs/common-errors/terminals/popout-blank-window.md / C15).
 *
 * If this file moves, fix the hops AND keep
 * tests/unit/terminal-popout-blank-window.test.mjs passing — it maps every
 * such join onto the dist/ layout.
 */
const path_1 = __importDefault(require("path"));
/** Absolute path to the compiled preload script for any BrowserWindow. */
function getPreloadPath() {
    return path_1.default.join(__dirname, '../../preload/preload/index.js');
}
/** Absolute path to the built renderer index.html (production loads). */
function getRendererHtmlPath() {
    return path_1.default.join(__dirname, '../../renderer/index.html');
}
