"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserAutomationError = void 0;
exports.throwIfBrowserAutomationAborted = throwIfBrowserAutomationAborted;
exports.validateBrowserNavigationUrl = validateBrowserNavigationUrl;
exports.parseBrowserKeyChord = parseBrowserKeyChord;
exports.waitForBrowserDelay = waitForBrowserDelay;
exports.browserAutomationErrorPayload = browserAutomationErrorPayload;
class BrowserAutomationError extends Error {
    code;
    retryable;
    details;
    constructor(code, message, options = {}) {
        super(message);
        this.name = 'BrowserAutomationError';
        this.code = code;
        this.retryable = options.retryable === true;
        this.details = options.details;
    }
}
exports.BrowserAutomationError = BrowserAutomationError;
function throwIfBrowserAutomationAborted(signal) {
    if (signal.aborted) {
        throw new BrowserAutomationError('cancelled', 'Browser automation request was cancelled');
    }
}
function validateBrowserNavigationUrl(value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new BrowserAutomationError('action_blocked', 'A non-empty URL is required');
    }
    let url;
    try {
        url = new URL(value.trim());
    }
    catch {
        throw new BrowserAutomationError('action_blocked', `Invalid browser URL: ${value}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new BrowserAutomationError('action_blocked', `Browser MCP navigation only permits http: and https: URLs (received ${url.protocol})`);
    }
    return url.toString();
}
const KEY_ALIASES = {
    esc: 'Escape',
    escape: 'Escape',
    enter: 'Enter',
    return: 'Enter',
    tab: 'Tab',
    backspace: 'Backspace',
    delete: 'Delete',
    space: 'Space',
    arrowup: 'Up',
    up: 'Up',
    arrowdown: 'Down',
    down: 'Down',
    arrowleft: 'Left',
    left: 'Left',
    arrowright: 'Right',
    right: 'Right',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pagedown: 'PageDown',
};
function parseBrowserKeyChord(value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new BrowserAutomationError('action_blocked', 'key is required');
    }
    const parts = value.split('+').map((part) => part.trim()).filter(Boolean);
    const modifiers = {
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
    };
    let keyCode = '';
    for (const part of parts) {
        const lower = part.toLowerCase();
        if (lower === 'alt' || lower === 'option')
            modifiers.altKey = true;
        else if (lower === 'control' || lower === 'ctrl')
            modifiers.ctrlKey = true;
        else if (lower === 'meta' || lower === 'cmd' || lower === 'command')
            modifiers.metaKey = true;
        else if (lower === 'shift')
            modifiers.shiftKey = true;
        else if (!keyCode)
            keyCode = KEY_ALIASES[lower] ?? (part.length === 1 ? part : '');
        else
            throw new BrowserAutomationError('action_blocked', `Invalid key chord: ${value}`);
    }
    if (!keyCode) {
        throw new BrowserAutomationError('action_blocked', `Unsupported key chord: ${value}`);
    }
    return { keyCode, ...modifiers };
}
function waitForBrowserDelay(ms, signal) {
    throwIfBrowserAutomationAborted(signal);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            reject(new BrowserAutomationError('cancelled', 'Browser automation request was cancelled'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
function browserAutomationErrorPayload(error) {
    if (error instanceof BrowserAutomationError) {
        return {
            error: error.message,
            code: error.code,
            retryable: error.retryable,
            ...(error.details ? { details: error.details } : {}),
        };
    }
    return {
        error: error instanceof Error ? error.message : String(error),
        code: 'navigation_failed',
        retryable: false,
    };
}
