"use strict";
/**
 * Lemon Squeezy Configuration (Main Process)
 *
 * Open-source build: no LemonSqueezy store/product/checkout config is shipped.
 * The app is fully unlocked and does not call the LemonSqueezy API.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.LEMONSQUEEZY_CONFIG = void 0;
exports.LEMONSQUEEZY_CONFIG = {
    storeId: null,
    productId: 0,
    variants: {
        singleDevice: 0,
        threeDevices: 0,
        fiveDevices: 0,
    },
    checkoutUrls: {
        singleDevice: '',
        threeDevices: '',
        fiveDevices: '',
    },
    api: {
        baseUrl: '',
        rateLimit: 60,
    },
};
