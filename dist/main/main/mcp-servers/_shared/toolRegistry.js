"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emptyObjectSchema = exports.ToolRegistry = void 0;
exports.objectSchema = objectSchema;
class ToolRegistry {
    tools = new Map();
    activeCalls = new Map();
    revision = 0;
    register(def) {
        if (this.tools.has(def.name)) {
            throw new Error(`Tool already registered: ${def.name}`);
        }
        this.tools.set(def.name, def);
        this.revision += 1;
    }
    get version() {
        return this.revision;
    }
    get(name) {
        return this.tools.get(name);
    }
    listTools(enabledProfiles) {
        const enabled = enabledProfiles ? new Set(enabledProfiles) : null;
        return [...this.tools.values()]
            .sort((a, b) => a.profile.localeCompare(b.profile) || a.name.localeCompare(b.name))
            .map((tool) => {
            const isEnabled = tool.profile === 'core' || !enabled || enabled.has(tool.profile);
            return {
                name: tool.name,
                profile: tool.profile,
                description: tool.description,
                inputSchema: tool.inputSchema,
                outputKind: tool.outputKind,
                mutates: tool.mutates === true,
                longRunning: tool.longRunning === true,
                timeoutMs: tool.timeoutMs,
                legacy: tool.legacy === true,
                enabled: isEnabled,
            };
        });
    }
    toolsForProfile(profile, enabledProfiles) {
        return this.listTools(enabledProfiles).filter((tool) => tool.profile === profile && tool.enabled);
    }
    async call(name, args, ctx = {}, options = {}) {
        const tool = this.tools.get(name);
        if (!tool) {
            throw new Error(`Unknown tool: ${name}`);
        }
        const enabled = options.enabledProfiles ? new Set(options.enabledProfiles) : null;
        if (tool.profile !== 'core' && enabled && !enabled.has(tool.profile)) {
            throw new Error(`Feature '${tool.profile}' is not enabled`);
        }
        const callId = options.callId ?? ctx.callId;
        const controller = new AbortController();
        const timeout = tool.timeoutMs
            ? setTimeout(() => controller.abort(), tool.timeoutMs)
            : null;
        if (callId) {
            this.activeCalls.set(callId, controller);
        }
        try {
            return await tool.execute({ ...ctx, callId }, args, controller.signal);
        }
        finally {
            if (timeout)
                clearTimeout(timeout);
            if (callId)
                this.activeCalls.delete(callId);
        }
    }
    cancel(callId) {
        const controller = this.activeCalls.get(callId);
        if (!controller)
            return false;
        controller.abort();
        this.activeCalls.delete(callId);
        return true;
    }
}
exports.ToolRegistry = ToolRegistry;
exports.emptyObjectSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false,
};
function objectSchema(properties, required = []) {
    return {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
    };
}
