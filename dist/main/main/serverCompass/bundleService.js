"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.__test = exports.ServerCompassBundleService = void 0;
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const electron_1 = require("electron");
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const serverCompassBundle_1 = require("../../shared/serverCompassBundle");
const COMPOSE_NAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const DOCKERFILE_NAMES = ['Dockerfile'];
const ENV_FILE_NAMES = ['.env', '.env.production', '.env.local', '.env.development'];
const BUNDLE_DIR_NAME = '1devtool-sc';
const BUNDLE_TTL_MS = 24 * 60 * 60 * 1000;
const REFERENCED_FILE_LIMIT = 1024 * 1024; // 1 MB
const BUNDLE_FILE_LIMIT = 5 * 1024 * 1024; // 5 MB
const PUBLIC_CHECK_TIMEOUT_MS = 2000;
const COMPOSE_CONFIG_TIMEOUT_MS = 8000;
class ServerCompassBundleService {
    projectStore;
    constructor(projectStore) {
        this.projectStore = projectStore;
    }
    async detectAssets(projectId) {
        const project = this.requireProject(projectId);
        const root = project.rootPath;
        const dockerfilePath = await firstExisting(root, DOCKERFILE_NAMES);
        const composePath = await firstExisting(root, COMPOSE_NAMES);
        const envFilePaths = [];
        for (const name of ENV_FILE_NAMES) {
            if (await fileExists(path_1.default.join(root, name)))
                envFilePaths.push(name);
        }
        const [remoteUrl, branch, commit] = await Promise.all([
            runGit(root, ['remote', 'get-url', 'origin']),
            runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
            runGit(root, ['rev-parse', 'HEAD']),
        ]);
        const isPublic = remoteUrl ? await checkGitHubPublic(remoteUrl) : undefined;
        const dockerfileBytes = dockerfilePath ? await fileSize(path_1.default.join(root, dockerfilePath)) : -1;
        const composeBytes = composePath ? await fileSize(path_1.default.join(root, composePath)) : -1;
        return {
            projectId: project.id,
            projectName: project.name,
            rootPath: root,
            detectedAt: Date.now(),
            docker: {
                dockerfilePath,
                composePath,
                envFilePaths,
            },
            git: {
                remoteUrl,
                branch,
                commit,
                isPublic,
            },
            sizes: {
                dockerfileBytes,
                composeBytes,
            },
        };
    }
    async validateLocally(projectId) {
        const project = this.requireProject(projectId);
        const root = project.rootPath;
        const checks = [];
        const composePath = await firstExisting(root, COMPOSE_NAMES);
        const dockerfilePath = await firstExisting(root, DOCKERFILE_NAMES);
        const envFiles = [];
        for (const name of ENV_FILE_NAMES) {
            if (await fileExists(path_1.default.join(root, name)))
                envFiles.push(name);
        }
        const remoteUrl = await runGit(root, ['remote', 'get-url', 'origin']);
        if (composePath) {
            const result = await runDockerComposeConfig(root, composePath);
            checks.push({
                name: `docker compose config (${composePath})`,
                ok: result.ok,
                detail: result.ok
                    ? 'Compose file parsed successfully.'
                    : result.error || 'docker compose config failed.',
            });
        }
        if (dockerfilePath) {
            const dockerfileResult = await checkDockerfileShape(path_1.default.join(root, dockerfilePath));
            checks.push({
                name: `Dockerfile shape (${dockerfilePath})`,
                ok: dockerfileResult.ok,
                detail: dockerfileResult.detail,
            });
        }
        for (const envName of envFiles) {
            const envResult = await checkEnvFile(path_1.default.join(root, envName));
            checks.push({
                name: `${envName} format`,
                ok: envResult.ok,
                detail: envResult.detail,
            });
        }
        if (remoteUrl) {
            const repo = parseGitHubRepo(remoteUrl);
            checks.push({
                name: 'git remote URL',
                ok: Boolean(repo),
                detail: repo
                    ? `Parsed as ${repo.owner}/${repo.repo}.`
                    : `Remote "${remoteUrl}" is not a recognized GitHub URL. Server Compass's GitHub flow needs github.com SSH or HTTPS.`,
            });
        }
        if (checks.length === 0) {
            checks.push({
                name: 'deployable assets present',
                ok: false,
                detail: 'No Dockerfile, docker-compose, .env, or git remote found. Add at least one before sending to Server Compass.',
            });
        }
        return { ran: true, passed: checks.every((c) => c.ok), checks };
    }
    async createBundle(options) {
        const project = this.requireProject(options.projectId);
        const root = project.rootPath;
        const detection = await this.detectAssets(project.id);
        const docker = {};
        if (detection.docker.dockerfilePath) {
            const abs = path_1.default.join(root, detection.docker.dockerfilePath);
            const content = await readBoundedFile(abs, REFERENCED_FILE_LIMIT);
            docker.dockerfilePath = detection.docker.dockerfilePath;
            if (content !== null)
                docker.dockerfileContent = content;
        }
        if (detection.docker.composePath) {
            const abs = path_1.default.join(root, detection.docker.composePath);
            const content = await readBoundedFile(abs, REFERENCED_FILE_LIMIT);
            docker.composePath = detection.docker.composePath;
            if (content !== null)
                docker.composeContent = content;
        }
        if (detection.docker.envFilePaths.length) {
            docker.envFilePaths = detection.docker.envFilePaths;
        }
        const git = {};
        if (detection.git.remoteUrl)
            git.remoteUrl = detection.git.remoteUrl;
        if (detection.git.branch)
            git.branch = detection.git.branch;
        if (detection.git.commit)
            git.commit = detection.git.commit;
        if (typeof detection.git.isPublic === 'boolean')
            git.isPublic = detection.git.isPublic;
        // When the user explicitly picks 'upload', drop git from the bundle so
        // Server Compass's path-recommendation table doesn't fall back to GitHub.
        const includeGit = options.preferredSource !== 'upload' && Object.keys(git).length > 0;
        const requestId = (0, crypto_1.randomUUID)();
        const bundle = {
            version: serverCompassBundle_1.SERVER_COMPASS_BUNDLE_VERSION,
            sourceApp: '1devtool',
            createdAt: Date.now(),
            requestId,
            project: { name: project.name.slice(0, 100) || path_1.default.basename(root), rootPath: root },
            docker,
            git: includeGit ? git : undefined,
            localValidation: options.validation ?? { ran: false, passed: false, checks: [] },
            metadata: options.metadata,
            buildHint: options.buildHint,
        };
        const dir = path_1.default.join(electron_1.app.getPath('temp'), BUNDLE_DIR_NAME);
        await promises_1.default.mkdir(dir, { recursive: true });
        const bundlePath = path_1.default.join(dir, `${requestId}.json`);
        const json = JSON.stringify(bundle, null, 2);
        if (Buffer.byteLength(json, 'utf8') > BUNDLE_FILE_LIMIT) {
            throw new Error(`Bundle exceeds ${BUNDLE_FILE_LIMIT} bytes. Trim large compose / Dockerfile content.`);
        }
        await promises_1.default.writeFile(bundlePath, json, 'utf8');
        const bytes = Buffer.byteLength(json, 'utf8');
        return { bundlePath, requestId, bytes };
    }
    async openInServerCompass(input) {
        const scheme = sanitizeScheme(input.scheme) || 'servercompass';
        const url = `${scheme}://import/1devtool?bundle=${encodeURIComponent(input.bundlePath)}&requestId=${input.requestId}`;
        try {
            await electron_1.shell.openExternal(url);
            return { ok: true };
        }
        catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    }
    async cleanupOldBundles() {
        const dir = path_1.default.join(electron_1.app.getPath('temp'), BUNDLE_DIR_NAME);
        let removed = 0;
        try {
            const entries = await promises_1.default.readdir(dir);
            const cutoff = Date.now() - BUNDLE_TTL_MS;
            for (const name of entries) {
                if (!name.endsWith('.json'))
                    continue;
                const filePath = path_1.default.join(dir, name);
                try {
                    const stat = await promises_1.default.stat(filePath);
                    if (stat.mtimeMs < cutoff) {
                        await promises_1.default.unlink(filePath);
                        removed += 1;
                    }
                }
                catch {
                    // ignore — file gone or permission issue
                }
            }
        }
        catch {
            // dir doesn't exist yet — nothing to clean
        }
        return { removed };
    }
    requireProject(projectId) {
        const project = this.projectStore.getProjects().find((p) => p.id === projectId);
        if (!project)
            throw new Error(`Project not found: ${projectId}`);
        if (!project.rootPath)
            throw new Error(`Project has no rootPath: ${projectId}`);
        return project;
    }
}
exports.ServerCompassBundleService = ServerCompassBundleService;
function sanitizeScheme(scheme) {
    if (!scheme)
        return null;
    // RFC 3986 scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
    return /^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme) ? scheme : null;
}
async function firstExisting(root, names) {
    for (const name of names) {
        if (await fileExists(path_1.default.join(root, name)))
            return name;
    }
    return null;
}
async function fileExists(p) {
    try {
        const stat = await promises_1.default.stat(p);
        return stat.isFile();
    }
    catch {
        return false;
    }
}
async function fileSize(p) {
    try {
        const stat = await promises_1.default.stat(p);
        return stat.size;
    }
    catch {
        return -1;
    }
}
async function readBoundedFile(p, limit) {
    try {
        const stat = await promises_1.default.stat(p);
        if (stat.size > limit)
            return null;
        return await promises_1.default.readFile(p, 'utf8');
    }
    catch {
        return null;
    }
}
function runGit(cwd, args) {
    return new Promise((resolve) => {
        (0, child_process_1.execFile)('git', args, { cwd, windowsHide: true }, (error, stdout) => {
            if (error)
                return resolve(null);
            resolve(stdout.trim() || null);
        });
    });
}
function parseGitHubRepo(remoteUrl) {
    // Match git@github.com:owner/repo(.git)?
    const ssh = remoteUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
    if (ssh)
        return { owner: ssh[1], repo: ssh[2] };
    // Match https://github.com/owner/repo(.git)?
    const https = remoteUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
    if (https)
        return { owner: https[1], repo: https[2] };
    return null;
}
async function checkGitHubPublic(remoteUrl) {
    const repo = parseGitHubRepo(remoteUrl);
    if (!repo)
        return undefined;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PUBLIC_CHECK_TIMEOUT_MS);
        const res = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, {
            method: 'GET',
            headers: { Accept: 'application/vnd.github+json' },
            signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.status === 200)
            return true;
        if (res.status === 404)
            return false;
        return undefined;
    }
    catch {
        return undefined;
    }
}
async function checkDockerfileShape(filePath) {
    try {
        const stat = await promises_1.default.stat(filePath);
        if (stat.size > REFERENCED_FILE_LIMIT) {
            return {
                ok: false,
                detail: `Dockerfile is ${stat.size} bytes — exceeds 1 MB referenced-file cap.`,
            };
        }
        const text = await promises_1.default.readFile(filePath, 'utf8');
        const head = text.split(/\r?\n/).find((line) => {
            const t = line.trim();
            return t.length > 0 && !t.startsWith('#') ? true : t.startsWith('# syntax=');
        });
        if (!head) {
            return { ok: false, detail: 'Dockerfile is empty or only contains comments.' };
        }
        const trimmed = head.trim();
        const directive = trimmed.split(/\s+/)[0]?.toUpperCase() ?? '';
        if (directive !== 'FROM' && directive !== 'ARG' && !trimmed.startsWith('# syntax=')) {
            return {
                ok: false,
                detail: `First non-comment directive is "${directive}" — Dockerfile should start with FROM (or ARG / # syntax=).`,
            };
        }
        return { ok: true, detail: 'Starts with a valid Dockerfile directive.' };
    }
    catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
}
async function checkEnvFile(filePath) {
    try {
        const stat = await promises_1.default.stat(filePath);
        if (stat.size > REFERENCED_FILE_LIMIT) {
            return { ok: false, detail: `${stat.size} bytes — exceeds 1 MB cap.` };
        }
        const text = await promises_1.default.readFile(filePath, 'utf8');
        const lines = text.split(/\r?\n/);
        let count = 0;
        let invalid = 0;
        let firstBad = null;
        for (const raw of lines) {
            const line = raw.trim();
            if (!line || line.startsWith('#'))
                continue;
            count += 1;
            if (!/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) {
                invalid += 1;
                if (firstBad === null)
                    firstBad = line.length > 80 ? `${line.slice(0, 80)}…` : line;
            }
        }
        if (invalid > 0) {
            return {
                ok: false,
                detail: `${invalid} of ${count} entries don't match KEY=value (e.g. "${firstBad}").`,
            };
        }
        if (count === 0) {
            return { ok: true, detail: 'File is empty or only contains comments — nothing to import.' };
        }
        return { ok: true, detail: `${count} entries parsed cleanly.` };
    }
    catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
}
async function runDockerComposeConfig(cwd, composePath) {
    return new Promise((resolve) => {
        const child = (0, child_process_1.execFile)('docker', ['compose', '-f', composePath, 'config', '--quiet'], { cwd, windowsHide: true, timeout: COMPOSE_CONFIG_TIMEOUT_MS }, (error, _stdout, stderr) => {
            if (!error)
                return resolve({ ok: true });
            const message = (stderr || error.message || '').trim();
            resolve({ ok: false, error: message || 'docker compose config failed.' });
        });
        child.on('error', (err) => {
            resolve({ ok: false, error: err.message });
        });
    });
}
// Export for tests
exports.__test = {
    parseGitHubRepo,
    COMPOSE_NAMES,
    DOCKERFILE_NAMES,
    ENV_FILE_NAMES,
};
// Allow-listed roots note: Server Compass validates that bundlePath resolves
// inside os.tmpdir() / app.getPath('temp') / app.getPath('userData') / os.homedir().
// We always write into app.getPath('temp')/<dir> which is allow-listed.
void os_1.default; // keep the import in case future code branches need it
