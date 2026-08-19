"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deriveThemeFields = deriveThemeFields;
/**
 * Derive non-editable theme fields from editable values.
 * Runs inside applyTheme() on every call to keep live preview correct.
 */
function deriveThemeFields(colors, type) {
    // Parse accent hex to rgba for blending
    const r = parseInt(colors.accent.slice(1, 3), 16);
    const g = parseInt(colors.accent.slice(3, 5), 16);
    const b = parseInt(colors.accent.slice(5, 7), 16);
    if (type === 'dark') {
        return {
            agentModalShadow: `0 24px 80px rgba(0,0,0,0.45), 0 8px 24px rgba(${r},${g},${b},0.12)`,
            agentHeaderBg: `linear-gradient(to right, rgba(${r},${g},${b},0.1), transparent 50%), ${colors.background}`,
        };
    }
    return {
        agentModalShadow: '0 24px 80px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.06)',
        agentHeaderBg: `linear-gradient(to right, rgba(${r},${g},${b},0.08), transparent 50%), ${colors.background}`,
    };
}
