"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TMUX_UNAVAILABLE_RUNTIME = exports.StaticTmuxRuntime = void 0;
/** A TmuxRuntime seeded from already-resolved values. */
class StaticTmuxRuntime {
    available;
    path;
    envFlag;
    constructor(available, path, envFlag) {
        this.available = available;
        this.path = path;
        this.envFlag = envFlag;
    }
    isAvailable() {
        return this.available;
    }
    getPath() {
        return this.path;
    }
    supportsEnvFlag() {
        return this.envFlag;
    }
}
exports.StaticTmuxRuntime = StaticTmuxRuntime;
exports.TMUX_UNAVAILABLE_RUNTIME = new StaticTmuxRuntime(false, null, false);
