"use strict";
/**
 * Lemon Squeezy Service
 *
 * Open-source build: all LemonSqueezy API calls are neutralized. The app is
 * fully unlocked locally; no license activation/validation/deactivation is ever
 * sent to LemonSqueezy.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.lemonSqueezyService = exports.LemonSqueezyService = void 0;
const lemonsqueezy_1 = require("../config/lemonsqueezy");
class LemonSqueezyService {
    static BASE_URL = 'https://api.lemonsqueezy.com';
    async activateLicense(licenseKey, instanceName) {
        throw new Error('License activation is not required in the open-source build.');
    }
    async validateLicense(licenseKey, instanceId) {
        throw new Error('License validation is not required in the open-source build.');
    }
    async deactivateLicense(licenseKey, instanceId) {
        throw new Error('License deactivation is not required in the open-source build.');
    }
    validateLicenseMeta(meta) {
        // No-op: cross-product validation is irrelevant in the open-source build.
    }
    canReceiveUpdates(expiresAt, status) {
        return true;
    }
    getDaysRemaining(expiresAt) {
        return null;
    }
}
exports.LemonSqueezyService = LemonSqueezyService;
// Export singleton instance
exports.lemonSqueezyService = new LemonSqueezyService();
