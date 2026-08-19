"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_PROVIDER_CHAIN = exports.DEFAULT_POOL_POLICY = void 0;
exports.DEFAULT_POOL_POLICY = {
    mode: 'manual',
    strategy: 'headroom',
    rotateAtPercent: 80,
    hardStopPercent: 95,
    cooldownFallbackMinutes: 30,
    maxConcurrentLeases: 2,
    runningSessionAction: 'warn',
};
exports.DEFAULT_PROVIDER_CHAIN = { enabled: false, order: [] };
