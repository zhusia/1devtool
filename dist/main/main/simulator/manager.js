"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SimulatorManager = void 0;
const ADAPTER_MAP = {
    ios: () => Promise.resolve().then(() => __importStar(require('./ios-adapter'))).then((m) => new m.iOSSimulatorAdapter()),
    android: () => Promise.resolve().then(() => __importStar(require('./android-adapter'))).then((m) => new m.AndroidEmulatorAdapter()),
};
const adapterCache = new Map();
// Track active streams for cleanup
const activeStreams = new Map();
// Health check interval for active streams
const healthIntervals = new Map();
class SimulatorManager {
    async getAdapter(platform) {
        const cached = adapterCache.get(platform);
        if (cached)
            return cached;
        const factory = ADAPTER_MAP[platform];
        if (!factory)
            throw new Error(`Unsupported platform: ${platform}`);
        const adapter = await factory();
        adapterCache.set(platform, adapter);
        return adapter;
    }
    async detectToolchains() {
        const [ios, android] = await Promise.allSettled([
            this.getAdapter('ios').then((a) => a.detect()),
            this.getAdapter('android').then((a) => a.detect()),
        ]);
        return {
            ios: ios.status === 'fulfilled' ? ios.value : { available: false, reason: 'Detection failed' },
            android: android.status === 'fulfilled' ? android.value : { available: false, reason: 'Detection failed' },
        };
    }
    async list(platform) {
        const adapter = await this.getAdapter(platform);
        return adapter.list();
    }
    async boot(platform, deviceId) {
        const adapter = await this.getAdapter(platform);
        await adapter.boot(deviceId);
    }
    async shutdown(platform, deviceId) {
        // Stop any active stream first
        this.stopStream(deviceId);
        const adapter = await this.getAdapter(platform);
        await adapter.shutdown(deviceId);
    }
    async install(platform, deviceId, appPath) {
        const adapter = await this.getAdapter(platform);
        await adapter.install(deviceId, appPath);
    }
    async uninstall(platform, deviceId, bundleId) {
        const adapter = await this.getAdapter(platform);
        await adapter.uninstall(deviceId, bundleId);
    }
    async openUrl(platform, deviceId, url) {
        const adapter = await this.getAdapter(platform);
        await adapter.openUrl(deviceId, url);
    }
    setScreenshotDimensions(platform, deviceId, width, height) {
        const adapter = adapterCache.get(platform);
        if (adapter?.setScreenshotDimensions) {
            adapter.setScreenshotDimensions(deviceId, width, height);
        }
    }
    async sendInput(platform, deviceId, event) {
        const adapter = await this.getAdapter(platform);
        switch (event.type) {
            case 'tap':
                await adapter.sendTap(deviceId, event.x, event.y);
                break;
            case 'text':
                await adapter.sendText(deviceId, event.text);
                break;
            case 'swipe':
                await adapter.sendSwipe(deviceId, event.x1, event.y1, event.x2, event.y2);
                break;
        }
    }
    async startStream(platform, deviceId, onData, onError, onExit) {
        // Stop existing stream for this device
        this.stopStream(deviceId);
        const adapter = adapterCache.get(platform);
        if (!adapter) {
            onError(new Error(`Adapter not loaded for platform: ${platform}`));
            return {};
        }
        const handle = await adapter.startStream(deviceId);
        activeStreams.set(deviceId, handle);
        handle.onData(onData);
        handle.onError((err) => {
            this.stopStream(deviceId);
            onError(err);
        });
        handle.onExit((code) => {
            activeStreams.delete(deviceId);
            clearInterval(healthIntervals.get(deviceId));
            healthIntervals.delete(deviceId);
            onExit(code);
        });
        // Health heartbeat: check stream process is alive every 5s
        const interval = setInterval(() => {
            const h = activeStreams.get(deviceId);
            if (!h || (h.process && h.process.killed)) {
                this.stopStream(deviceId);
                onError(new Error('Stream process died unexpectedly'));
            }
        }, 5000);
        healthIntervals.set(deviceId, interval);
        return {
            streamUrl: handle.streamUrl,
            captureSourceId: handle.captureSourceId,
            captureSourceName: handle.captureSourceName,
            streamMode: handle.streamMode,
        };
    }
    stopStream(deviceId) {
        const handle = activeStreams.get(deviceId);
        if (handle) {
            handle.destroy();
            activeStreams.delete(deviceId);
        }
        const interval = healthIntervals.get(deviceId);
        if (interval) {
            clearInterval(interval);
            healthIntervals.delete(deviceId);
        }
    }
    dispose() {
        for (const [deviceId] of activeStreams) {
            this.stopStream(deviceId);
        }
    }
}
exports.SimulatorManager = SimulatorManager;
