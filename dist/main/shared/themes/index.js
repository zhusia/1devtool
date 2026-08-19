"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUILTIN_THEMES = exports.deriveThemeFields = exports.stoicLightTheme = exports.stoicDarkTheme = exports.lightTheme = exports.darkTheme = void 0;
exports.getCanonicalThemeId = getCanonicalThemeId;
exports.getThemeById = getThemeById;
exports.getDefaultDarkTheme = getDefaultDarkTheme;
exports.getDefaultLightTheme = getDefaultLightTheme;
exports.resolveTheme = resolveTheme;
const dark_1 = require("./dark");
const light_1 = require("./light");
const stoicDark_1 = require("./stoicDark");
const stoicLight_1 = require("./stoicLight");
var dark_2 = require("./dark");
Object.defineProperty(exports, "darkTheme", { enumerable: true, get: function () { return dark_2.darkTheme; } });
var light_2 = require("./light");
Object.defineProperty(exports, "lightTheme", { enumerable: true, get: function () { return light_2.lightTheme; } });
var stoicDark_2 = require("./stoicDark");
Object.defineProperty(exports, "stoicDarkTheme", { enumerable: true, get: function () { return stoicDark_2.stoicDarkTheme; } });
var stoicLight_2 = require("./stoicLight");
Object.defineProperty(exports, "stoicLightTheme", { enumerable: true, get: function () { return stoicLight_2.stoicLightTheme; } });
var types_1 = require("./types");
Object.defineProperty(exports, "deriveThemeFields", { enumerable: true, get: function () { return types_1.deriveThemeFields; } });
// Order matters: first dark + first light are the system-resolution defaults.
exports.BUILTIN_THEMES = [
    stoicDark_1.stoicDarkTheme,
    stoicLight_1.stoicLightTheme,
    dark_1.darkTheme,
    light_1.lightTheme,
];
const THEME_ID_ALIASES = {
    // Soft Light was merged into Stoic Light. Canonicalizing here also
    // makes themeStore rewrite old localStorage + persisted preferences.
    'soft-spectrum-light': stoicLight_1.stoicLightTheme.id,
    'light-current-baseline': stoicLight_1.stoicLightTheme.id,
    'light-refined-blue': stoicLight_1.stoicLightTheme.id,
    'light-teal': stoicLight_1.stoicLightTheme.id,
    'light-graphite': stoicLight_1.stoicLightTheme.id,
};
function getCanonicalThemeId(id) {
    return THEME_ID_ALIASES[id] ?? id;
}
function getThemeById(id) {
    const canonicalId = getCanonicalThemeId(id);
    return exports.BUILTIN_THEMES.find((t) => t.id === canonicalId);
}
function getDefaultDarkTheme() {
    return stoicDark_1.stoicDarkTheme;
}
function getDefaultLightTheme() {
    return stoicLight_1.stoicLightTheme;
}
function resolveTheme(themeId, customThemes, getSystemTheme) {
    if (themeId === 'system') {
        const systemPref = getSystemTheme();
        return systemPref === 'dark' ? getDefaultDarkTheme() : getDefaultLightTheme();
    }
    return getThemeById(themeId) ?? customThemes.find((t) => t.id === themeId);
}
