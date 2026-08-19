"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stoicDarkTheme = void 0;
const converter_1 = require("./converter");
const stoic_dark_json_1 = __importDefault(require("./data/stoic-dark.json"));
const converted = (0, converter_1.convertVSCodeTheme)(stoic_dark_json_1.default, 'stoic-dark');
exports.stoicDarkTheme = {
    ...converted,
    id: 'stoic-dark',
    name: 'Stoic Dark',
    source: 'builtin',
};
