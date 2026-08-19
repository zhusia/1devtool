"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolvePlatformAsset = resolvePlatformAsset;
exports.getInstallDir = getInstallDir;
exports.getBinaryPath = getBinaryPath;
exports.getMetaPath = getMetaPath;
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const version_1 = require("./version");
/**
 * Resolve the cloudflared asset for the current platform.
 * Throws if the platform isn't supported by upstream cloudflared releases.
 */
function resolvePlatformAsset() {
    const platform = process.platform;
    const arch = process.arch;
    if (platform === 'darwin') {
        // Cloudflare ships universal `cloudflared-darwin-amd64.tgz` which actually
        // contains a universal binary on recent versions, but pinning to per-arch
        // names is safer for older versions.
        const archSlug = arch === 'arm64' ? 'arm64' : 'amd64';
        const assetName = `cloudflared-darwin-${archSlug}.tgz`;
        return {
            assetName,
            downloadUrl: `${version_1.RELEASE_BASE}/${assetName}`,
            isTarball: true,
            binaryName: 'cloudflared',
        };
    }
    if (platform === 'linux') {
        let archSlug;
        if (arch === 'arm64')
            archSlug = 'arm64';
        else if (arch === 'arm')
            archSlug = 'arm';
        else if (arch === 'ia32')
            archSlug = '386';
        else
            archSlug = 'amd64';
        const assetName = `cloudflared-linux-${archSlug}`;
        return {
            assetName,
            downloadUrl: `${version_1.RELEASE_BASE}/${assetName}`,
            isTarball: false,
            binaryName: 'cloudflared',
        };
    }
    if (platform === 'win32') {
        const archSlug = arch === 'ia32' ? '386' : 'amd64';
        const assetName = `cloudflared-windows-${archSlug}.exe`;
        return {
            assetName,
            downloadUrl: `${version_1.RELEASE_BASE}/${assetName}`,
            isTarball: false,
            binaryName: 'cloudflared.exe',
        };
    }
    throw new Error(`Cloudflare Tunnel isn't available on ${platform}/${arch} yet.`);
}
/**
 * Installation directory under userData. Created lazily by the download step.
 */
function getInstallDir() {
    return path_1.default.join(electron_1.app.getPath('userData'), 'bin');
}
/**
 * Final on-disk path for the cloudflared binary.
 */
function getBinaryPath() {
    const { binaryName } = resolvePlatformAsset();
    return path_1.default.join(getInstallDir(), binaryName);
}
/**
 * Sidecar metadata file written at install time. Lets `install.status()` be a
 * sub-ms `fs.existsSync` + `JSON.parse` instead of spawning `cloudflared --version`.
 */
function getMetaPath() {
    return path_1.default.join(getInstallDir(), 'cloudflared.meta.json');
}
