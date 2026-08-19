"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DownloadError = void 0;
exports.readMeta = readMeta;
exports.isInstalled = isInstalled;
exports.removeBinary = removeBinary;
exports.cancelDownload = cancelDownload;
exports.downloadBinary = downloadBinary;
const fs_1 = __importDefault(require("fs"));
const https_1 = __importDefault(require("https"));
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const child_process_1 = require("child_process");
const events_1 = require("events");
const version_1 = require("./version");
const paths_1 = require("./paths");
class DownloadError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'DownloadError';
    }
}
exports.DownloadError = DownloadError;
let active = null;
function readMeta() {
    try {
        const metaPath = (0, paths_1.getMetaPath)();
        if (!fs_1.default.existsSync(metaPath))
            return null;
        const raw = fs_1.default.readFileSync(metaPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!fs_1.default.existsSync((0, paths_1.getBinaryPath)()))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
function isInstalled() {
    return readMeta() !== null;
}
function removeBinary() {
    const binPath = (0, paths_1.getBinaryPath)();
    const metaPath = (0, paths_1.getMetaPath)();
    for (const p of [binPath, metaPath, binPath + '.partial']) {
        try {
            fs_1.default.unlinkSync(p);
        }
        catch { /* ignore */ }
    }
}
function cancelDownload() {
    active?.cancel();
}
function downloadBinary() {
    if (active) {
        const emitter = active.emitter;
        return {
            emitter,
            promise: new Promise((resolve, reject) => {
                emitter.once('done', resolve);
                emitter.once('error', reject);
            }),
        };
    }
    const emitter = new events_1.EventEmitter();
    let cancelled = false;
    const cleanup = [];
    active = {
        emitter,
        cancel: () => {
            cancelled = true;
            for (const fn of cleanup) {
                try {
                    fn();
                }
                catch { /* ignore */ }
            }
        },
    };
    const promise = (async () => {
        const asset = (0, paths_1.resolvePlatformAsset)();
        const installDir = (0, paths_1.getInstallDir)();
        fs_1.default.mkdirSync(installDir, { recursive: true });
        // Step 1 — download asset to .partial while hashing on the fly. The
        // redirect chain reveals the resolved tag (e.g. .../releases/download/
        // 2026.6.0/cloudflared-darwin-arm64.tgz) which we record.
        const partialPath = (asset.isTarball
            ? path_1.default.join(installDir, asset.assetName)
            : (0, paths_1.getBinaryPath)()) + '.partial';
        try {
            fs_1.default.unlinkSync(partialPath);
        }
        catch { /* ignore */ }
        const dl = await downloadToFile(asset.downloadUrl, partialPath, emitter, () => cancelled, cleanup);
        if (cancelled) {
            try {
                fs_1.default.unlinkSync(partialPath);
            }
            catch { /* ignore */ }
            throw new DownloadError('cancelled', 'Download cancelled.');
        }
        const resolvedVersion = parseVersionFromUrl(dl.finalUrl) ?? version_1.CLOUDFLARED_VERSION_FALLBACK;
        // Step 2 — verify against published checksums if Cloudflare provided any.
        // cloudflared releases are inconsistent about ship sha256sums.txt and
        // per-asset .sha256 files. Try both; fall back to HTTPS-only trust if
        // neither exists for this release.
        emitter.emit('progress', { phase: 'verify', bytes: 1, total: 1 });
        const expectedSha = await tryFetchExpectedSha(asset.assetName, resolvedVersion, () => cancelled);
        if (expectedSha && expectedSha.toLowerCase() !== dl.sha.toLowerCase()) {
            try {
                fs_1.default.unlinkSync(partialPath);
            }
            catch { /* ignore */ }
            throw new DownloadError('checksum-mismatch', `Checksum mismatch for ${asset.assetName}. Expected ${expectedSha}, got ${dl.sha}.`);
        }
        if (!expectedSha) {
            console.warn(`[cloudflared] No checksums published for release ${resolvedVersion}; ` +
                `relying on HTTPS-only integrity for ${asset.assetName}.`);
        }
        // Step 3 — extract if tarball, otherwise rename.
        const finalPath = (0, paths_1.getBinaryPath)();
        if (asset.isTarball) {
            emitter.emit('progress', { phase: 'extract', bytes: 0, total: 1 });
            await extractTarball(partialPath, installDir, asset.binaryName);
            try {
                fs_1.default.unlinkSync(partialPath);
            }
            catch { /* ignore */ }
            emitter.emit('progress', { phase: 'extract', bytes: 1, total: 1 });
        }
        else {
            fs_1.default.renameSync(partialPath, finalPath);
        }
        if (process.platform !== 'win32') {
            try {
                fs_1.default.chmodSync(finalPath, 0o755);
            }
            catch { /* ignore */ }
        }
        const stat = fs_1.default.statSync(finalPath);
        const meta = {
            version: resolvedVersion,
            sha256: expectedSha,
            assetName: asset.assetName,
            installedAt: Date.now(),
            sizeBytes: stat.size,
        };
        fs_1.default.writeFileSync((0, paths_1.getMetaPath)(), JSON.stringify(meta, null, 2));
        return meta;
    })();
    promise
        .then((meta) => emitter.emit('done', meta))
        .catch((err) => emitter.emit('error', err))
        .finally(() => { active = null; });
    return { emitter, promise };
}
// ---------- HTTP layer ----------
/**
 * Open an HTTP(S) connection following redirects. Error and timeout listeners
 * are attached to EVERY request in the chain — the previous implementation
 * only listened on the first request, so failures on a redirected request
 * (e.g. objects.githubusercontent.com unreachable) were swallowed.
 */
function fetchResponse(url, timeoutMs, isCancelled) {
    return new Promise((resolve, reject) => {
        let redirectsLeft = 5;
        function attempt(currentUrl) {
            if (isCancelled()) {
                reject(new DownloadError('cancelled', 'Download cancelled.'));
                return;
            }
            const u = new URL(currentUrl);
            const lib = u.protocol === 'http:' ? http_1.default : https_1.default;
            const req = lib.get({
                hostname: u.hostname,
                port: u.port || (u.protocol === 'http:' ? 80 : 443),
                path: u.pathname + u.search,
                headers: { 'user-agent': '1DevTool-Desktop', accept: '*/*' },
            }, (res) => {
                const status = res.statusCode ?? 0;
                const location = res.headers.location;
                if (status >= 300 && status < 400 && location) {
                    res.resume();
                    redirectsLeft -= 1;
                    if (redirectsLeft < 0) {
                        reject(new DownloadError('network', `Too many redirects fetching ${url}`));
                        return;
                    }
                    attempt(new URL(location, currentUrl).toString());
                    return;
                }
                if (status >= 400) {
                    res.resume();
                    reject(new DownloadError('network', `HTTP ${status} from ${u.hostname}${u.pathname} (asset may not exist for this platform)`));
                    return;
                }
                resolve({ res, finalUrl: currentUrl });
            });
            req.on('error', (err) => {
                const code = err.code || 'ERROR';
                reject(new DownloadError('network', `${code}: ${err.message} (${u.hostname})`));
            });
            req.setTimeout(timeoutMs, () => {
                req.destroy();
                reject(new DownloadError('network', `Timed out connecting to ${u.hostname}`));
            });
        }
        attempt(url);
    });
}
async function fetchText(url, isCancelled) {
    const { res, finalUrl } = await fetchResponse(url, 30_000, isCancelled);
    return new Promise((resolve, reject) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
            if (isCancelled()) {
                reject(new DownloadError('cancelled', 'Download cancelled.'));
            }
            else {
                resolve({ text: Buffer.concat(chunks).toString('utf-8'), finalUrl });
            }
        });
        res.on('error', (err) => reject(new DownloadError('network', err.message)));
    });
}
async function downloadToFile(url, destPath, emitter, isCancelled, cleanup) {
    const { res, finalUrl } = await fetchResponse(url, 60_000, isCancelled);
    return new Promise((resolve, reject) => {
        const hash = crypto_1.default.createHash('sha256');
        const fileStream = fs_1.default.createWriteStream(destPath);
        const total = parseInt(String(res.headers['content-length'] || '0'), 10) || 0;
        let received = 0;
        const onCleanup = () => {
            try {
                res.destroy();
            }
            catch { /* ignore */ }
            try {
                fileStream.destroy();
            }
            catch { /* ignore */ }
            try {
                fs_1.default.unlinkSync(destPath);
            }
            catch { /* ignore */ }
        };
        cleanup.push(onCleanup);
        res.on('data', (chunk) => {
            if (isCancelled()) {
                onCleanup();
                reject(new DownloadError('cancelled', 'Download cancelled.'));
                return;
            }
            hash.update(chunk);
            received += chunk.length;
            fileStream.write(chunk);
            emitter.emit('progress', {
                phase: 'download',
                bytes: received,
                total,
            });
        });
        res.on('end', () => {
            fileStream.end(() => {
                if (isCancelled()) {
                    try {
                        fs_1.default.unlinkSync(destPath);
                    }
                    catch { /* ignore */ }
                    reject(new DownloadError('cancelled', 'Download cancelled.'));
                }
                else {
                    resolve({ sha: hash.digest('hex'), finalUrl });
                }
            });
        });
        res.on('error', (err) => {
            onCleanup();
            reject(new DownloadError('network', err.message));
        });
    });
}
/**
 * Try to find a SHA256 for the asset from any checksum source Cloudflare
 * publishes. Returns null if none are available (some cloudflared releases
 * don't ship checksum files at all).
 *
 *   1. Aggregated `sha256sums.txt` at the release root.
 *   2. Per-asset `<asset>.sha256` next to the binary.
 *
 * Pinned to the resolved version tag so we don't accidentally compare against
 * a different release if `latest` advanced between calls.
 */
async function tryFetchExpectedSha(assetName, resolvedVersion, isCancelled) {
    const versionedBase = `https://github.com/cloudflare/cloudflared/releases/download/${resolvedVersion}`;
    // Attempt 1 — aggregated sha256sums.txt
    try {
        const result = await fetchText(`${versionedBase}/sha256sums.txt`, isCancelled);
        const sha = parseSha256Sum(result.text, assetName);
        if (sha)
            return sha;
    }
    catch (err) {
        if (err instanceof DownloadError && err.code === 'cancelled')
            throw err;
        // 404 / missing — try next source
    }
    // Attempt 2 — per-asset .sha256
    try {
        const result = await fetchText(`${versionedBase}/${assetName}.sha256`, isCancelled);
        const match = result.text.trim().match(/^([0-9a-fA-F]{64})/);
        if (match)
            return match[1];
    }
    catch (err) {
        if (err instanceof DownloadError && err.code === 'cancelled')
            throw err;
    }
    // No checksum available for this release.
    return null;
}
/**
 * Parse a release tag out of a GitHub release-download URL.
 * .../releases/download/2025.4.1/sha256sums.txt → "2025.4.1"
 */
function parseVersionFromUrl(url) {
    const match = url.match(/\/releases\/download\/([^/]+)\//);
    return match ? match[1] : null;
}
function parseSha256Sum(text, assetName) {
    for (const line of text.split('\n')) {
        const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
        if (!match)
            continue;
        const [, hash, name] = match;
        if (name === assetName || name.endsWith('/' + assetName)) {
            return hash;
        }
    }
    return null;
}
function extractTarball(tgzPath, installDir, binaryName) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)('tar', ['-xzf', tgzPath, '-C', installDir], {
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (c) => { stderr += c.toString(); });
        child.on('error', (err) => {
            reject(new DownloadError('extract', `Failed to spawn tar: ${err.message}`));
        });
        child.on('exit', (code) => {
            if (code !== 0) {
                reject(new DownloadError('extract', `tar exited with code ${code}: ${stderr.trim()}`));
                return;
            }
            const expected = path_1.default.join(installDir, binaryName);
            if (fs_1.default.existsSync(expected)) {
                resolve();
                return;
            }
            try {
                const entries = fs_1.default.readdirSync(installDir, { withFileTypes: true });
                for (const ent of entries) {
                    if (!ent.isDirectory())
                        continue;
                    const candidate = path_1.default.join(installDir, ent.name, binaryName);
                    if (fs_1.default.existsSync(candidate)) {
                        fs_1.default.renameSync(candidate, expected);
                        try {
                            fs_1.default.rmSync(path_1.default.join(installDir, ent.name), { recursive: true, force: true });
                        }
                        catch { /* ignore */ }
                        resolve();
                        return;
                    }
                }
            }
            catch (err) {
                reject(new DownloadError('extract', err.message));
                return;
            }
            reject(new DownloadError('extract', `Tarball did not contain ${binaryName}.`));
        });
    });
}
