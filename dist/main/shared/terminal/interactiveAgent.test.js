"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const interactiveAgent_1 = require("./interactiveAgent");
(0, node_test_1.test)('holds CSI sequences with intermediate bytes until the final byte arrives', () => {
    strict_1.default.deepEqual((0, interactiveAgent_1.splitTrailingIncompleteEscapeSequence)('prefix\x1b[?25 '), { complete: 'prefix', pending: '\x1b[?25 ' });
    strict_1.default.deepEqual((0, interactiveAgent_1.splitTrailingIncompleteEscapeSequence)('prefix\x1b[?25 q'), { complete: 'prefix\x1b[?25 q', pending: '' });
});
(0, node_test_1.test)('holds partial DCS control strings until ST arrives', () => {
    strict_1.default.deepEqual((0, interactiveAgent_1.splitTrailingIncompleteEscapeSequence)('prefix\x1bP$qmstatus'), { complete: 'prefix', pending: '\x1bP$qmstatus' });
    strict_1.default.deepEqual((0, interactiveAgent_1.splitTrailingIncompleteEscapeSequence)('prefix\x1bP$qmstatus\x1b\\'), { complete: 'prefix\x1bP$qmstatus\x1b\\', pending: '' });
});
(0, node_test_1.test)('holds partial OSC control strings until ST arrives', () => {
    strict_1.default.deepEqual((0, interactiveAgent_1.splitTrailingIncompleteEscapeSequence)('prefix\x1b]52;c;clipboard'), { complete: 'prefix', pending: '\x1b]52;c;clipboard' });
    strict_1.default.deepEqual((0, interactiveAgent_1.splitTrailingIncompleteEscapeSequence)('prefix\x1b]52;c;clipboard\x1b\\'), { complete: 'prefix\x1b]52;c;clipboard\x1b\\', pending: '' });
});
(0, node_test_1.test)('holds partial 8-bit CSI sequences until the final byte arrives', () => {
    strict_1.default.deepEqual((0, interactiveAgent_1.splitTrailingIncompleteEscapeSequence)('prefix\x9b31'), { complete: 'prefix', pending: '\x9b31' });
    strict_1.default.deepEqual((0, interactiveAgent_1.splitTrailingIncompleteEscapeSequence)('prefix\x9b31m'), { complete: 'prefix\x9b31m', pending: '' });
});
(0, node_test_1.test)('does not split prematurely on nested ESC bytes inside OSC and DCS payloads', () => {
    strict_1.default.deepEqual((0, interactiveAgent_1.splitTrailingIncompleteEscapeSequence)('prefix\x1b]0;title \x1b[31m still title'), { complete: 'prefix', pending: '\x1b]0;title \x1b[31m still title' });
    strict_1.default.deepEqual((0, interactiveAgent_1.splitTrailingIncompleteEscapeSequence)('prefix\x1bPpayload \x1b[31m still payload'), { complete: 'prefix', pending: '\x1bPpayload \x1b[31m still payload' });
    strict_1.default.deepEqual((0, interactiveAgent_1.splitTrailingIncompleteEscapeSequence)('prefix\x1b]0;title \x1b[31m\x1b\\suffix'), { complete: 'prefix\x1b]0;title \x1b[31m\x1b\\suffix', pending: '' });
});
