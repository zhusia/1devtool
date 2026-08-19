"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_BROWSER_AUTOMATION_POLICY = void 0;
exports.DEFAULT_BROWSER_AUTOMATION_POLICY = {
    allowExternalNetwork: true,
    allowDownloads: false,
    allowUploads: false,
    allowFileWrites: false,
    maxPages: 8,
    maxArtifactBytes: 20 * 1024 * 1024,
    leaseTtlMs: 60 * 60_000,
};
