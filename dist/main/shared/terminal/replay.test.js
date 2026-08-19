"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const replay_1 = require("./replay");
// Regression: OSC color queries (OSC 10/11/12 fg/bg/cursor, OSC 4/104 palette)
// must be stripped from the REPLAY/RECORDING buffer. Replaying a buffered
// `\x1b]11;?` into a fresh xterm makes it re-emit a `\x1b]11;rgb:...` report to
// a PTY whose original app has exited; the shell echoes it as visible garbage
// (`]11;rgb:0d0d/1111/1717` — the OSC-11 encoding of #0D1117, xterm's own bg).
// See docs/common-errors/terminals/osc-color-query-replay-garbage.md.
(0, node_test_1.test)('replay buffer strips OSC color queries (bg/fg/cursor/palette, BEL + ST)', () => {
    strict_1.default.equal((0, replay_1.sanitizeReplayBuffer)('a\x1b]11;?\x07b'), 'ab');
    strict_1.default.equal((0, replay_1.sanitizeReplayBuffer)('a\x1b]11;?\x1b\\b'), 'ab');
    strict_1.default.equal((0, replay_1.sanitizeReplayBuffer)('\x1b]10;?\x07'), '');
    strict_1.default.equal((0, replay_1.sanitizeReplayBuffer)('\x1b]12;?\x07'), '');
    strict_1.default.equal((0, replay_1.sanitizeReplayBuffer)('\x1b]4;1;?\x07'), '');
});
(0, node_test_1.test)('replay buffer strips the repeated-query repro (three bg queries)', () => {
    const repro = '❯ \x1b]11;?\x07\x1b]11;?\x07\x1b]11;?\x07';
    strict_1.default.equal((0, replay_1.sanitizeReplayBuffer)(repro), '❯ ');
});
(0, node_test_1.test)('recording chunk strips OSC color queries too', () => {
    strict_1.default.equal((0, replay_1.sanitizeRecordingChunk)('x\x1b]11;?\x07y'), 'xy');
});
(0, node_test_1.test)('OSC color SET commands are preserved (only queries are stripped)', () => {
    // A real color SET (no trailing '?') is syntactically identical to xterm's
    // report; never strip it or remount would lose app-set colors.
    const setBg = '\x1b]11;rgb:0d0d/1111/1717\x07';
    strict_1.default.equal((0, replay_1.sanitizeReplayBuffer)(setBg), setBg);
    const setPalette = '\x1b]4;1;rgb:ff/00/00\x07';
    strict_1.default.equal((0, replay_1.sanitizeReplayBuffer)(setPalette), setPalette);
});
(0, node_test_1.test)('LIVE path leaves OSC color queries intact (running app needs the report)', () => {
    // On the live path a running app must still receive its theme-detection
    // report, so the query must reach xterm. Only the replay path strips it.
    const query = 'a\x1b]11;?\x07b';
    strict_1.default.equal((0, replay_1.sanitizeLivePtyChunk)(query), query);
});
