"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createDeepLinkRouter = createDeepLinkRouter;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
function createDeepLinkRouter({ getMainWindow, sendToRenderer, }) {
    // ── Custom URL protocol (deep links) ──
    const DEEP_LINK_PROTOCOL = 'onedevtool';
    const LEGACY_INVALID_DEEP_LINK_PROTOCOL = '1devtool';
    const DEEP_LINK_PROTOCOLS = [DEEP_LINK_PROTOCOL, LEGACY_INVALID_DEEP_LINK_PROTOCOL];
    let pendingDeepLink = null;
    const pendingOpenFilePaths = [];
    function normalizePathForKey(filePath) {
        const normalized = path_1.default.normalize(filePath);
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    }
    function addPendingOpenFile(filePath) {
        const normalized = path_1.default.normalize(filePath);
        const normalizedKey = normalizePathForKey(normalized);
        const alreadyPending = pendingOpenFilePaths.some((existing) => normalizePathForKey(existing) === normalizedKey);
        if (!alreadyPending) {
            pendingOpenFilePaths.push(normalized);
        }
    }
    function normalizeOpenFileCandidate(rawPath) {
        if (typeof rawPath !== 'string')
            return null;
        const trimmed = rawPath.trim();
        if (!trimmed || trimmed.startsWith('-') || isDeepLinkUrl(trimmed)) {
            return null;
        }
        const resolved = path_1.default.isAbsolute(trimmed) ? trimmed : path_1.default.resolve(trimmed);
        try {
            const stats = fs_1.default.statSync(resolved);
            if (!stats.isFile()) {
                return null;
            }
        }
        catch {
            return null;
        }
        return path_1.default.normalize(resolved);
    }
    function extractOpenFilesFromArgv(argv) {
        const startIndex = process.defaultApp ? 2 : 1;
        const paths = [];
        for (const candidate of argv.slice(startIndex)) {
            const normalized = normalizeOpenFileCandidate(candidate);
            if (normalized) {
                paths.push(normalized);
            }
        }
        return paths;
    }
    function routeOpenFiles(filePaths) {
        if (filePaths.length === 0)
            return;
        const mainWindow = getMainWindow();
        for (const filePath of filePaths) {
            addPendingOpenFile(filePath);
        }
        const delivered = sendToRenderer('app:file-open-available');
        if (delivered && mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized())
                mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    }
    function getDeepLinkProtocol(rawUrl) {
        if (typeof rawUrl !== 'string')
            return null;
        return DEEP_LINK_PROTOCOLS.find((protocol) => rawUrl.startsWith(`${protocol}://`)) ?? null;
    }
    function isDeepLinkUrl(rawUrl) {
        return getDeepLinkProtocol(rawUrl) !== null;
    }
    function parseDeepLink(rawUrl) {
        const protocol = getDeepLinkProtocol(rawUrl);
        if (!protocol)
            return null;
        const afterScheme = rawUrl.slice(`${protocol}://`.length);
        const [pathPart, queryPart = ''] = afterScheme.split('?');
        const segments = pathPart.split('/').filter(Boolean);
        const params = new URLSearchParams(queryPart);
        if (segments[0] === 'templates' && segments[1] === 'install') {
            const templateId = params.get('id')?.trim();
            return { type: 'templates-install', templateId: templateId || undefined };
        }
        return null;
    }
    function routeDeepLink(rawUrl) {
        const mainWindow = getMainWindow();
        const parsed = parseDeepLink(rawUrl);
        if (!parsed)
            return;
        pendingDeepLink = parsed;
        const delivered = sendToRenderer('app:deeplink-available');
        if (delivered && mainWindow && !mainWindow.isDestroyed()) {
            if (mainWindow.isMinimized())
                mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    }
    if (process.defaultApp) {
        if (process.argv.length >= 2) {
            electron_1.app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL, process.execPath, [path_1.default.resolve(process.argv[1])]);
        }
    }
    else {
        electron_1.app.setAsDefaultProtocolClient(DEEP_LINK_PROTOCOL);
    }
    electron_1.app.on('open-url', (event, url) => {
        event.preventDefault();
        routeDeepLink(url);
    });
    electron_1.app.on('open-file', (event, filePath) => {
        event.preventDefault();
        const normalized = normalizeOpenFileCandidate(filePath);
        if (normalized) {
            routeOpenFiles([normalized]);
        }
    });
    const argvDeepLink = process.argv.find(isDeepLinkUrl);
    if (argvDeepLink) {
        const parsed = parseDeepLink(argvDeepLink);
        if (parsed)
            pendingDeepLink = parsed;
    }
    for (const filePath of extractOpenFilesFromArgv(process.argv)) {
        addPendingOpenFile(filePath);
    }
    function consumePendingDeepLink() {
        const parsed = pendingDeepLink;
        pendingDeepLink = null;
        return parsed;
    }
    function consumePendingOpenFiles() {
        const filePaths = [...pendingOpenFilePaths];
        pendingOpenFilePaths.length = 0;
        return filePaths;
    }
    return {
        consumePendingDeepLink,
        consumePendingOpenFiles,
        extractOpenFilesFromArgv,
        isDeepLinkUrl,
        parseDeepLink,
        routeDeepLink,
        routeOpenFiles,
    };
}
