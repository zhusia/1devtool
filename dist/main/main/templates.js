"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TemplateManager = void 0;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
class TemplateManager {
    manifestCache = null;
    CACHE_TTL_MS = 5 * 60 * 1000;
    REPO_RAW_BASE = 'https://raw.githubusercontent.com/stoicsoft/1devtool-templates/main';
    REPO_CLONE_URL = 'https://github.com/stoicsoft/1devtool-templates.git';
    REPO_TARBALL_URL = 'https://github.com/stoicsoft/1devtool-templates/archive/refs/heads/main.tar.gz';
    gitAvailable = null;
    checkGitAvailable() {
        if (this.gitAvailable !== null)
            return this.gitAvailable;
        try {
            (0, child_process_1.execFileSync)('git', ['--version'], {
                stdio: 'ignore',
                timeout: 5000,
                env: { ...process.env, PATH: `${process.env.PATH || ''}:/usr/local/bin:/opt/homebrew/bin` },
            });
            this.gitAvailable = true;
        }
        catch {
            this.gitAvailable = false;
        }
        return this.gitAvailable;
    }
    async fetchManifest() {
        const now = Date.now();
        if (this.manifestCache && now - this.manifestCache.fetchedAt < this.CACHE_TTL_MS) {
            return this.manifestCache.data;
        }
        try {
            const response = await fetch(`${this.REPO_RAW_BASE}/templates.json`);
            if (!response.ok) {
                throw new Error(`Template catalog request failed (${response.status})`);
            }
            const payload = await response.json();
            const manifest = this.validateManifest(payload);
            this.manifestCache = {
                data: manifest,
                fetchedAt: now,
            };
            return manifest;
        }
        catch (error) {
            if (this.manifestCache) {
                return this.manifestCache.data;
            }
            const message = error instanceof Error ? error.message : 'Template catalog is temporarily unavailable';
            throw new Error(message);
        }
    }
    getPreviewUrls(template) {
        return template.previews.map((p) => {
            const previewPath = p.replace(/^\/+/, '');
            return `${this.REPO_RAW_BASE}/${previewPath}`;
        });
    }
    async cloneTemplate(templateId, destinationPath, onProgress) {
        const progress = (step, message) => {
            onProgress?.({ step, message });
        };
        let tempRoot = null;
        try {
            const normalizedTemplateId = templateId?.trim();
            const normalizedDestination = destinationPath?.trim();
            if (!normalizedTemplateId) {
                return { ok: false, error: 'Template ID is required.' };
            }
            if (!normalizedDestination) {
                return { ok: false, error: 'Destination path is required.' };
            }
            if (fs.existsSync(normalizedDestination)) {
                return { ok: false, error: 'Directory already exists. Choose a different name.' };
            }
            progress('manifest', 'Fetching template catalog...');
            const manifest = await this.fetchManifest();
            const template = manifest.templates.find((item) => item.id === normalizedTemplateId);
            if (!template || template.status !== 'available') {
                return { ok: false, error: 'Template no longer available.' };
            }
            const destinationParent = path.dirname(normalizedDestination);
            if (!fs.existsSync(destinationParent)) {
                return { ok: false, error: 'Selected parent directory does not exist.' };
            }
            const hasGit = this.checkGitAvailable();
            progress('clone', 'Downloading template source...');
            tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), '1devtool-template-'));
            const cloneDir = path.join(tempRoot, 'repo');
            if (hasGit) {
                await this.runCommand('git', ['clone', '--depth', '1', '--single-branch', '--branch', 'main', this.REPO_CLONE_URL, cloneDir], tempRoot, 60_000);
            }
            else {
                await this.downloadAndExtractTarball(cloneDir, onProgress);
            }
            const templatesRoot = path.resolve(cloneDir, 'templates');
            const sourcePath = path.resolve(cloneDir, template.directory);
            if (!sourcePath.startsWith(`${templatesRoot}${path.sep}`)) {
                return { ok: false, error: 'Template source directory is invalid.' };
            }
            if (!fs.existsSync(sourcePath)) {
                return { ok: false, error: 'Template source directory is missing from repository.' };
            }
            progress('copy', 'Copying template files...');
            fs.cpSync(sourcePath, normalizedDestination, {
                recursive: true,
                force: false,
                errorOnExist: true,
            });
            if (hasGit) {
                progress('git', 'Initializing git repository...');
                await this.runCommand('git', ['init'], normalizedDestination, 15_000);
            }
            progress('done', 'Template created successfully.');
            return { ok: true, projectPath: normalizedDestination };
        }
        catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'EACCES') {
                return { ok: false, error: 'Permission denied. Choose a different location.' };
            }
            const message = error instanceof Error ? error.message : 'Failed to create project from template';
            return { ok: false, error: message };
        }
        finally {
            if (tempRoot && fs.existsSync(tempRoot)) {
                try {
                    fs.rmSync(tempRoot, { recursive: true, force: true });
                }
                catch {
                    // Ignore cleanup errors.
                }
            }
        }
    }
    validateManifest(input) {
        if (!input || typeof input !== 'object') {
            throw new Error('Template catalog is temporarily unavailable');
        }
        const manifest = input;
        if (typeof manifest.version !== 'number' || typeof manifest.repo !== 'string' || !Array.isArray(manifest.templates)) {
            throw new Error('Template catalog is temporarily unavailable');
        }
        const raw = manifest.templates.filter((template) => {
            return (!!template &&
                typeof template.id === 'string' &&
                (template.category === undefined || typeof template.category === 'string') &&
                typeof template.name === 'string' &&
                typeof template.description === 'string' &&
                (typeof template.preview === 'string' || Array.isArray(template.previews)) &&
                typeof template.directory === 'string' &&
                Array.isArray(template.tags) &&
                (template.status === 'available' || template.status === 'coming-soon'));
        });
        // Normalize: accept both legacy `preview: string` and new `previews: string[]`
        const templates = raw.map((t) => {
            const rec = t;
            const previews = Array.isArray(rec.previews)
                ? rec.previews
                : typeof rec.preview === 'string'
                    ? [rec.preview]
                    : [];
            return { ...t, previews };
        });
        return {
            version: manifest.version,
            repo: manifest.repo,
            templates,
        };
    }
    async downloadAndExtractTarball(destDir, onProgress) {
        onProgress?.({ step: 'download', message: 'Downloading template archive...' });
        const response = await fetch(this.REPO_TARBALL_URL, { redirect: 'follow' });
        if (!response.ok || !response.body) {
            throw new Error(`Failed to download template archive (${response.status})`);
        }
        const tarballPath = path.join(path.dirname(destDir), 'repo.tar.gz');
        const arrayBuffer = await response.arrayBuffer();
        fs.writeFileSync(tarballPath, Buffer.from(arrayBuffer));
        onProgress?.({ step: 'extract', message: 'Extracting template files...' });
        const extractDir = path.join(path.dirname(destDir), 'extract');
        fs.mkdirSync(extractDir, { recursive: true });
        // Use Node's built-in tar extraction via child process (tar is available
        // on macOS, Linux, and modern Windows 10+)
        await this.runCommand('tar', ['xzf', tarballPath, '-C', extractDir], extractDir, 30_000);
        // GitHub tarball extracts to <repo>-<branch>/ (e.g. 1devtool-templates-main/)
        const entries = fs.readdirSync(extractDir);
        const extractedRoot = entries.length === 1
            ? path.join(extractDir, entries[0])
            : extractDir;
        fs.renameSync(extractedRoot, destDir);
        // Clean up
        try {
            fs.unlinkSync(tarballPath);
        }
        catch { /* ignore */ }
        try {
            fs.rmSync(extractDir, { recursive: true, force: true });
        }
        catch { /* ignore */ }
    }
    runCommand(command, args, cwd, timeoutMs) {
        return new Promise((resolve, reject) => {
            const child = (0, child_process_1.spawn)(command, args, {
                cwd,
                shell: false,
                env: { ...process.env, PATH: `${process.env.PATH || ''}:/usr/local/bin:/opt/homebrew/bin` },
            });
            let stderr = '';
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                reject(new Error('Clone timed out. Repository may be temporarily unavailable.'));
            }, timeoutMs);
            child.stderr?.on('data', (chunk) => {
                stderr += chunk.toString();
            });
            child.on('error', (error) => {
                clearTimeout(timer);
                reject(error);
            });
            child.on('close', (code) => {
                clearTimeout(timer);
                if (code === 0) {
                    resolve();
                    return;
                }
                const trimmedStderr = stderr.trim();
                reject(new Error(trimmedStderr || `Command failed with exit code ${code}`));
            });
        });
    }
}
exports.TemplateManager = TemplateManager;
