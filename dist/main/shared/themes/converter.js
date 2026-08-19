"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.convertVSCodeTheme = convertVSCodeTheme;
exports.parseVSCodeThemeFile = parseVSCodeThemeFile;
const types_1 = require("./types");
// ── Color helpers ──
function hexToRgb(hex) {
    const match = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (!match)
        return null;
    return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}
function luminance(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb)
        return 0;
    const [r, g, b] = rgb.map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function lighten(hex, amount) {
    const rgb = hexToRgb(hex);
    if (!rgb)
        return hex;
    const result = rgb.map((c) => Math.min(255, Math.round(c + (255 - c) * amount)));
    return `#${result.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}
function darken(hex, amount) {
    const rgb = hexToRgb(hex);
    if (!rgb)
        return hex;
    const result = rgb.map((c) => Math.max(0, Math.round(c * (1 - amount))));
    return `#${result.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}
function adjustAlpha(hex, alpha) {
    const rgb = hexToRgb(hex);
    if (!rgb)
        return hex;
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}
function normalizeHex(value) {
    if (!value)
        return undefined;
    // Handle #RRGGBBAA format — strip alpha, reject fully transparent
    if (value.length === 9 && value.startsWith('#')) {
        const alpha = parseInt(value.slice(7, 9), 16);
        if (alpha === 0)
            return undefined; // fully transparent → treat as missing
        return value.slice(0, 7);
    }
    if (value.length === 7 && value.startsWith('#')) {
        return value;
    }
    return undefined;
}
// ── Converter ──
function pick(colors, ...keys) {
    for (const key of keys) {
        const val = normalizeHex(colors[key]);
        if (val)
            return val;
    }
    return undefined;
}
function convertColors(colors, type) {
    const background = pick(colors, 'editor.background') ?? (type === 'dark' ? '#1e1e1e' : '#ffffff');
    const surface = pick(colors, 'sideBar.background', 'panel.background')
        ?? (type === 'dark' ? darken(background, 0.1) : lighten(background, 0.03));
    const surfaceHover = pick(colors, 'list.hoverBackground')
        ?? (type === 'dark' ? lighten(surface, 0.08) : darken(surface, 0.05));
    const border = pick(colors, 'panel.border', 'sideBar.border', 'contrastBorder')
        ?? (type === 'dark' ? lighten(background, 0.15) : darken(background, 0.15));
    const textPrimary = pick(colors, 'editor.foreground', 'foreground')
        ?? (type === 'dark' ? '#cccccc' : '#333333');
    const textSecondary = pick(colors, 'descriptionForeground', 'sideBar.foreground')
        ?? (type === 'dark' ? adjustAlpha(textPrimary, 0.7) : adjustAlpha(textPrimary, 0.7));
    const textMuted = pick(colors, 'disabledForeground')
        ?? (type === 'dark' ? adjustAlpha(textPrimary, 0.45) : adjustAlpha(textPrimary, 0.45));
    const accent = pick(colors, 'focusBorder', 'button.background', 'textLink.foreground')
        ?? '#3B82F6';
    const accentHover = darken(accent, 0.1);
    const scrollbarTrack = pick(colors, 'scrollbar.shadow') ?? surface;
    const scrollbarThumb = pick(colors, 'scrollbarSlider.background')
        ?? (type === 'dark' ? lighten(surface, 0.12) : darken(surface, 0.12));
    const scrollbarThumbHover = pick(colors, 'scrollbarSlider.hoverBackground')
        ?? (type === 'dark' ? lighten(scrollbarThumb, 0.1) : darken(scrollbarThumb, 0.1));
    const contextMenuBg = pick(colors, 'menu.background', 'dropdown.background') ?? surface;
    const contextMenuBorder = pick(colors, 'menu.border', 'dropdown.border') ?? border;
    const contextMenuHover = pick(colors, 'menu.selectionBackground', 'list.hoverBackground') ?? surfaceHover;
    const inputBg = pick(colors, 'input.background') ?? background;
    const inputBorder = pick(colors, 'input.border') ?? border;
    const inputText = pick(colors, 'input.foreground') ?? textPrimary;
    const btnSecondaryBg = pick(colors, 'button.secondaryBackground')
        ?? (type === 'dark' ? lighten(background, 0.1) : darken(background, 0.08));
    const btnSecondaryHover = pick(colors, 'button.secondaryHoverBackground')
        ?? (type === 'dark' ? lighten(btnSecondaryBg, 0.08) : darken(btnSecondaryBg, 0.06));
    const btnSecondaryText = pick(colors, 'button.secondaryForeground') ?? textPrimary;
    const derived = (0, types_1.deriveThemeFields)({ accent, background }, type);
    return {
        background, surface, surfaceHover, border,
        textPrimary, textSecondary, textMuted,
        accent, accentHover,
        scrollbarTrack, scrollbarThumb, scrollbarThumbHover,
        contextMenuBg, contextMenuBorder, contextMenuHover,
        inputBg, inputBorder, inputText,
        btnSecondaryBg, btnSecondaryHover, btnSecondaryText,
        ...derived,
    };
}
function convertTerminalColors(colors, type) {
    const bg = pick(colors, 'terminal.background', 'editor.background')
        ?? (type === 'dark' ? '#1e1e1e' : '#ffffff');
    const fg = pick(colors, 'terminal.foreground', 'editor.foreground')
        ?? (type === 'dark' ? '#cccccc' : '#333333');
    return {
        background: bg,
        foreground: fg,
        cursor: pick(colors, 'terminalCursor.foreground') ?? fg,
        cursorAccent: pick(colors, 'terminalCursor.background') ?? bg,
        selectionBackground: colors['terminal.selectionBackground']
            ? normalizeHex(colors['terminal.selectionBackground'])
                ? adjustAlpha(normalizeHex(colors['terminal.selectionBackground']), 0.3)
                : 'rgba(59, 130, 246, 0.3)'
            : 'rgba(59, 130, 246, 0.3)',
        black: pick(colors, 'terminal.ansiBlack') ?? (type === 'dark' ? '#000000' : '#000000'),
        red: pick(colors, 'terminal.ansiRed') ?? (type === 'dark' ? '#cd3131' : '#cd3131'),
        green: pick(colors, 'terminal.ansiGreen') ?? (type === 'dark' ? '#0dbc79' : '#00bc00'),
        yellow: pick(colors, 'terminal.ansiYellow') ?? (type === 'dark' ? '#e5e510' : '#949800'),
        blue: pick(colors, 'terminal.ansiBlue') ?? (type === 'dark' ? '#2472c8' : '#0451a5'),
        magenta: pick(colors, 'terminal.ansiMagenta') ?? (type === 'dark' ? '#bc3fbc' : '#bc05bc'),
        cyan: pick(colors, 'terminal.ansiCyan') ?? (type === 'dark' ? '#11a8cd' : '#0598bc'),
        white: pick(colors, 'terminal.ansiWhite') ?? (type === 'dark' ? '#e5e5e5' : '#555555'),
        brightBlack: pick(colors, 'terminal.ansiBrightBlack') ?? (type === 'dark' ? '#666666' : '#666666'),
        brightRed: pick(colors, 'terminal.ansiBrightRed') ?? (type === 'dark' ? '#f14c4c' : '#cd3131'),
        brightGreen: pick(colors, 'terminal.ansiBrightGreen') ?? (type === 'dark' ? '#23d18b' : '#14ce14'),
        brightYellow: pick(colors, 'terminal.ansiBrightYellow') ?? (type === 'dark' ? '#f5f543' : '#b5ba00'),
        brightBlue: pick(colors, 'terminal.ansiBrightBlue') ?? (type === 'dark' ? '#3b8eea' : '#0451a5'),
        brightMagenta: pick(colors, 'terminal.ansiBrightMagenta') ?? (type === 'dark' ? '#d670d6' : '#bc05bc'),
        brightCyan: pick(colors, 'terminal.ansiBrightCyan') ?? (type === 'dark' ? '#29b8db' : '#0598bc'),
        brightWhite: pick(colors, 'terminal.ansiBrightWhite') ?? (type === 'dark' ? '#e5e5e5' : '#a5a5a5'),
    };
}
/** Monaco-relevant key prefixes from VS Code. Anything matching is passed
 *  through verbatim (after hex normalization) so Monaco renders it. */
const MONACO_PASSTHROUGH_PREFIXES = [
    'editor',
    'editorActiveLineNumber',
    'editorBracketMatch',
    'editorBracketHighlight',
    'editorBracketPairGuide',
    'editorCodeLens',
    'editorCursor',
    'editorError',
    'editorWarning',
    'editorInfo',
    'editorHint',
    'editorGroup',
    'editorGroupHeader',
    'editorGutter',
    'editorHoverWidget',
    'editorIndentGuide',
    'editorInlayHint',
    'editorLightBulb',
    'editorLineNumber',
    'editorLink',
    'editorMarkerNavigation',
    'editorOverviewRuler',
    'editorRuler',
    'editorStickyScroll',
    'editorSuggestWidget',
    'editorUnicodeHighlight',
    'editorWhitespace',
    'editorWidget',
    'diffEditor',
    'peekView',
    'peekViewEditor',
    'peekViewResult',
    'peekViewTitle',
];
function convertEditorColors(colors, type) {
    const bg = pick(colors, 'editor.background') ?? (type === 'dark' ? '#1e1e1e' : '#ffffff');
    const fg = pick(colors, 'editor.foreground') ?? (type === 'dark' ? '#cccccc' : '#333333');
    // Start with the required core fields (with sensible fallbacks so imports
    // that omit these still render correctly).
    const result = {
        'editor.background': bg,
        'editorLineNumber.foreground': pick(colors, 'editorLineNumber.foreground')
            ?? (type === 'dark' ? '#858585' : '#999999'),
        'editorLineNumber.activeForeground': pick(colors, 'editorLineNumber.activeForeground') ?? fg,
        'editorGutter.background': pick(colors, 'editorGutter.background') ?? bg,
        'editorIndentGuide.background1': pick(colors, 'editorIndentGuide.background1', 'editorIndentGuide.background')
            ?? (type === 'dark' ? '#404040' : '#d3d3d3'),
        'editorIndentGuide.activeBackground1': pick(colors, 'editorIndentGuide.activeBackground1', 'editorIndentGuide.activeBackground')
            ?? (type === 'dark' ? '#707070' : '#939393'),
        'editor.selectionBackground': pick(colors, 'editor.selectionBackground')
            ?? (type === 'dark' ? '#264f78' : '#add6ff'),
        'editor.inactiveSelectionBackground': pick(colors, 'editor.inactiveSelectionBackground')
            ?? (type === 'dark' ? '#3a3d41' : '#e5ebf1'),
        'editorCursor.foreground': pick(colors, 'editorCursor.foreground')
            ?? (type === 'dark' ? '#aeafad' : '#000000'),
        'editorSuggestWidget.background': pick(colors, 'editorSuggestWidget.background')
            ?? (type === 'dark' ? '#252526' : '#f3f3f3'),
        'editorSuggestWidget.selectedBackground': pick(colors, 'editorSuggestWidget.selectedBackground')
            ?? (type === 'dark' ? '#04395e' : '#d6ebff'),
        'editorHoverWidget.background': pick(colors, 'editorHoverWidget.background')
            ?? (type === 'dark' ? '#252526' : '#f3f3f3'),
    };
    // Pass through every additional Monaco-relevant key so imports keep things
    // like editor.lineHighlightBackground, editor.findMatchBackground,
    // editorBracketMatch.*, editorError.foreground, editorWhitespace.foreground,
    // etc. — all 50+ keys Monaco supports. Without this they'd be silently
    // dropped and imports would look washed-out.
    for (const [key, raw] of Object.entries(colors)) {
        if (key in result)
            continue;
        const prefix = key.split('.')[0];
        if (!MONACO_PASSTHROUGH_PREFIXES.includes(prefix))
            continue;
        // Monaco accepts alpha-suffixed hex (#RRGGBBAA); preserve it as-is instead
        // of running through normalizeHex which drops the alpha channel.
        if (raw.startsWith('#') && (raw.length === 7 || raw.length === 9)) {
            result[key] = raw;
        }
    }
    return result;
}
/**
 * Convert a VS Code theme JSON file into an AppTheme.
 * Handles color mapping with intelligent fallbacks for unmapped keys.
 */
function convertVSCodeTheme(json, themeId) {
    const colors = json.colors ?? {};
    // Detect type from explicit field, or by analyzing background luminance
    let type = json.type ?? 'dark';
    if (!json.type) {
        const bg = normalizeHex(colors['editor.background']);
        if (bg) {
            type = luminance(bg) > 0.5 ? 'light' : 'dark';
        }
    }
    const name = json.name ?? 'Imported Theme';
    return {
        id: themeId,
        name,
        type,
        source: 'vscode-import',
        colors: convertColors(colors, type),
        terminal: convertTerminalColors(colors, type),
        editor: convertEditorColors(colors, type),
        tokenColors: json.tokenColors,
        semanticTokenColors: json.semanticTokenColors,
    };
}
/**
 * Strip JSONC features (comments and trailing commas) to produce valid JSON.
 * VS Code theme files commonly use trailing commas and sometimes line comments.
 */
function stripJsonc(content) {
    // Remove $schema lines (vscode:// URLs can confuse parsers)
    let result = content.replace(/"\$schema"\s*:\s*"[^"]*"\s*,?\s*/g, '');
    // Remove single-line comments (// ...)
    result = result.replace(/\/\/.*$/gm, '');
    // Remove multi-line comments (/* ... */)
    result = result.replace(/\/\*[\s\S]*?\*\//g, '');
    // Remove trailing commas before } or ]
    result = result.replace(/,(\s*[}\]])/g, '$1');
    return result;
}
/**
 * Parse and validate a VS Code theme JSON string.
 * Handles JSONC format (trailing commas, comments) used by VS Code.
 * Returns the parsed theme or throws with a descriptive error.
 */
function parseVSCodeThemeFile(content) {
    const json = JSON.parse(stripJsonc(content));
    if (typeof json !== 'object' || json === null) {
        throw new Error('Invalid theme file: expected a JSON object');
    }
    if (json.colors && typeof json.colors !== 'object') {
        throw new Error('Invalid theme file: "colors" must be an object');
    }
    if (json.tokenColors && !Array.isArray(json.tokenColors)) {
        throw new Error('Invalid theme file: "tokenColors" must be an array');
    }
    return json;
}
