"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrapMultilineForBracketedPaste = exports.supportsAgentBracketedPaste = exports.submitAgentPrompt = void 0;
// Moved to src/shared/terminal so the desktop renderer (Change AI / Resume
// flows) can reuse the exact same agent-kind-aware prompt sequencing. This
// re-export keeps the remote handlers and unit test importing from here.
var agentPromptWrite_1 = require("../../shared/terminal/agentPromptWrite");
Object.defineProperty(exports, "submitAgentPrompt", { enumerable: true, get: function () { return agentPromptWrite_1.submitAgentPrompt; } });
Object.defineProperty(exports, "supportsAgentBracketedPaste", { enumerable: true, get: function () { return agentPromptWrite_1.supportsAgentBracketedPaste; } });
Object.defineProperty(exports, "wrapMultilineForBracketedPaste", { enumerable: true, get: function () { return agentPromptWrite_1.wrapMultilineForBracketedPaste; } });
