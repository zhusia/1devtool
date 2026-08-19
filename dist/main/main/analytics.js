"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initAnalytics = initAnalytics;
exports.attachAnalyticsStore = attachAnalyticsStore;
exports.trackEvent = trackEvent;
const main_1 = require("@aptabase/electron/main");
const APTABASE_APP_KEY = 'A-US-8956024532';
let storeRef = null;
let initialized = false;
/**
 * Calls Aptabase's `initialize()`. Must be invoked synchronously at module
 * load time, BEFORE `app.whenReady()` resolves — the SDK refuses to init
 * once `app.isReady()` is true and silently disables tracking.
 */
function initAnalytics() {
    if (initialized)
        return;
    (0, main_1.initialize)(APTABASE_APP_KEY);
    initialized = true;
}
/**
 * Wires the StoreManager so trackEvent can read the user's opt-out
 * preference. Called after the store is constructed in setupIpcHandlers.
 */
function attachAnalyticsStore(store) {
    storeRef = store;
}
function isOptedIn() {
    if (!storeRef)
        return false;
    try {
        const privacy = storeRef.getPreferences().privacy;
        // Drop everything until the user has explicitly answered the first-run
        // consent dialog. consentShown=false means they haven't seen it yet.
        return privacy.consentShown === true && privacy.analyticsEnabled !== false;
    }
    catch {
        return false;
    }
}
function trackEvent(name, props) {
    if (!initialized || !isOptedIn())
        return;
    if (process.env.NODE_ENV !== 'production') {
        console.log('[analytics:main]', name, props || '');
    }
    try {
        (0, main_1.trackEvent)(name, props);
    }
    catch {
        // Aptabase failures must never break the app.
    }
}
