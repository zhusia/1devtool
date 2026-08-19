"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stoicLightTheme = void 0;
const converter_1 = require("./converter");
const stoic_light_json_1 = __importDefault(require("./data/stoic-light.json"));
const converted = (0, converter_1.convertVSCodeTheme)(stoic_light_json_1.default, 'stoic-light');
// Keep the familiar Stoic/VS Code syntax palette, but use a quieter neutral
// shell inspired by Codex: a warm off-white reading canvas, clearly darker
// navigation chrome, and white only for small raised controls. This replaces
// the former Soft Light theme, so there is one opinionated Stoic light option.
const stoicLightRamp = {
    background: '#F7F7F5',
    surface: '#E2E3E5',
    surfaceHover: '#D5D7DA',
    border: '#C7CACE',
    elevated: '#FDFDFC',
};
exports.stoicLightTheme = {
    ...converted,
    id: 'stoic-light',
    name: 'Stoic Light',
    source: 'builtin',
    colors: {
        background: stoicLightRamp.background,
        surface: stoicLightRamp.surface,
        surfaceHover: stoicLightRamp.surfaceHover,
        border: stoicLightRamp.border,
        textPrimary: '#242628',
        textSecondary: '#565E68',
        textMuted: '#737B85',
        accent: '#2563EB',
        accentHover: '#1D4ED8',
        scrollbarTrack: stoicLightRamp.surface,
        scrollbarThumb: '#B4B9C0',
        scrollbarThumbHover: '#9EA5AE',
        contextMenuBg: stoicLightRamp.elevated,
        contextMenuBorder: stoicLightRamp.border,
        contextMenuHover: '#ECEDEE',
        inputBg: stoicLightRamp.elevated,
        inputBorder: stoicLightRamp.border,
        inputText: '#242628',
        btnSecondaryBg: '#DADDE0',
        btnSecondaryHover: '#CED2D6',
        btnSecondaryText: '#242628',
        agentModalShadow: '0 24px 80px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.06)',
        agentHeaderBg: 'linear-gradient(to right, rgba(37,99,235,0.08), transparent 50%), #F7F7F5',
    },
    terminal: {
        background: stoicLightRamp.background,
        foreground: '#242628',
        cursor: '#2563EB',
        cursorAccent: stoicLightRamp.background,
        selectionBackground: 'rgba(37,99,235,0.22)',
        black: '#24292F',
        red: '#CF222E',
        green: '#116329',
        yellow: '#9A6700',
        blue: '#0969DA',
        magenta: '#8250DF',
        cyan: '#0E7490',
        white: '#6E7781',
        brightBlack: '#57606A',
        brightRed: '#A40E26',
        brightGreen: '#1A7F37',
        brightYellow: '#BF8700',
        brightBlue: '#218BFF',
        brightMagenta: '#A475F9',
        brightCyan: '#3192AA',
        brightWhite: '#8C959F',
    },
    editor: {
        ...converted.editor,
        'editor.background': stoicLightRamp.background,
        'editor.foreground': '#242628',
        'editorLineNumber.foreground': '#858E98',
        'editorLineNumber.activeForeground': '#242628',
        'editorGutter.background': stoicLightRamp.background,
        'editorIndentGuide.background1': '#E1E3E5',
        'editorIndentGuide.activeBackground1': stoicLightRamp.border,
        'editor.selectionBackground': '#BBD7F2',
        'editor.inactiveSelectionBackground': '#DDE6EE',
        'editorCursor.foreground': '#2563EB',
        'editor.lineHighlightBackground': '#EEEFEF',
        'editorGroup.background': stoicLightRamp.surface,
        'editorGroup.border': stoicLightRamp.border,
        'editorGroupHeader.tabsBackground': '#EEEFF0',
        'editorHoverWidget.background': stoicLightRamp.elevated,
        'editorHoverWidget.border': stoicLightRamp.border,
        'editorSuggestWidget.background': stoicLightRamp.elevated,
        'editorSuggestWidget.border': stoicLightRamp.border,
        'editorSuggestWidget.selectedBackground': stoicLightRamp.surface,
        'editorWidget.background': stoicLightRamp.elevated,
        'editorMarkerNavigation.background': stoicLightRamp.elevated,
        'editorRuler.foreground': '#D9DCDF',
        'peekViewEditor.background': stoicLightRamp.background,
        'peekViewResult.background': stoicLightRamp.surface,
    },
};
