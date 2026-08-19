"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.targetSupportsVibeModes = targetSupportsVibeModes;
exports.commandHasPermissionPosture = commandHasPermissionPosture;
exports.commandHasModelFlag = commandHasModelFlag;
exports.buildVibeLaunchCommand = buildVibeLaunchCommand;
const contracts_1 = require("./terminal/contracts");
const agentModels_1 = require("./agentModels");
const headlessMode_1 = require("./headlessMode");
/** True when this target supports the Build/Plan + Autonomy chips at all.
 *  Phase 0 proves the flag matrix for Claude only; other agents hide the
 *  Mode chip instead of faking flags. A base command that already bakes its
 *  own permission posture (custom presets like
 *  `claude --dangerously-skip-permissions …`) also opts out: the preset
 *  author chose the posture, and appending a second `--permission-mode`
 *  produces the conflicting-flags launch this guard exists to prevent. */
function targetSupportsVibeModes(target) {
    return ((0, contracts_1.getDeclaredAgentKind)(target.agentType, target.command) === 'claude-command' &&
        !commandHasPermissionPosture(target.command));
}
/** The base command already pins a permission posture of its own. */
function commandHasPermissionPosture(command) {
    return /(?:^|\s)--permission-mode(?:\s|=|$)/.test(command) ||
        /(?:^|\s)--dangerously-skip-permissions(?:\s|$)/.test(command);
}
/** The base command already pins a model of its own. */
function commandHasModelFlag(command) {
    return /(?:^|\s)(?:--model|-m)(?:\s|=|$)/.test(command);
}
/**
 * Launch command = agent base command + proved flags. `--permission-mode` is
 * single-valued, so Plan wins over the autonomy edit setting (a plan session
 * stays read-only until the user approves the plan inside the TUI).
 */
function buildVibeLaunchCommand(target, modelId, mode, autonomy) {
    let command = target.command;
    // A preset-baked `--model` wins over the chip: appending a second model
    // flag makes the launch depend on the CLI's last-flag-wins behavior, which
    // is not proved per agent.
    if (modelId && !commandHasModelFlag(command)) {
        const { binary } = (0, headlessMode_1.parseCliCommand)(command);
        const flags = (0, agentModels_1.buildModelFlags)(binary, modelId);
        if (flags)
            command = `${command} ${flags.join(' ')}`;
    }
    if (targetSupportsVibeModes(target)) {
        if (mode === 'plan') {
            command = `${command} --permission-mode plan`;
        }
        else if (autonomy === 'accept-edits') {
            command = `${command} --permission-mode acceptEdits`;
        }
        else if (autonomy === 'full') {
            command = `${command} --dangerously-skip-permissions`;
        }
    }
    return command;
}
