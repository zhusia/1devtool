"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.scanDeployProject = scanDeployProject;
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
async function scanDeployProject(project) {
    const root = project.rootPath;
    const notes = [];
    const packageJson = await readPackageJson(root);
    const packageManager = await detectPackageManager(root);
    const framework = detectFramework(packageJson, root);
    const nextStaticExport = framework === 'Next.js' ? await isNextStaticExport(root) : false;
    const hasNextApiRoutes = framework === 'Next.js' ? await hasNextApiRouteHandlers(root) : false;
    const buildCommand = packageJson?.scripts?.build ? buildCommandFor(packageManager) : '';
    const outputDir = await detectOutputDir(root, framework, packageJson, nextStaticExport);
    const gitBranch = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const productionBranch = await detectProductionBranch(root);
    const folderName = path_1.default.basename(root);
    const vercel = await scanVercel(root, {
        framework,
        packageManager,
        buildCommand,
        outputDir,
        folderName,
    });
    const cloudflare = await scanCloudflare(root, {
        framework,
        packageManager,
        buildCommand,
        outputDir,
        folderName,
        gitBranch,
        productionBranch,
        nextStaticExport,
        hasNextApiRoutes,
    });
    if (!packageJson) {
        notes.push('No package.json found. Deploy settings were inferred from the folder name and provider config files only.');
    }
    if (framework) {
        notes.push(`Detected ${framework}.`);
    }
    const recommendedProvider = cloudflare.confidence === 'high' && vercel.confidence !== 'high'
        ? 'cloudflare'
        : 'vercel';
    return {
        projectId: project.id,
        detectedAt: Date.now(),
        framework,
        packageManager,
        gitBranch,
        recommendedProvider,
        providers: {
            vercel,
            cloudflare,
        },
        notes,
    };
}
async function scanVercel(root, context) {
    const sources = [];
    const warnings = [];
    const config = {
        provider: 'vercel',
        deployCwd: '',
        target: 'preview',
    };
    const projectJson = await readJsonFile(path_1.default.join(root, '.vercel', 'project.json'));
    if (projectJson) {
        sources.push('.vercel/project.json');
        if (typeof projectJson.projectId === 'string')
            config.projectId = projectJson.projectId;
        if (typeof projectJson.orgId === 'string')
            config.teamId = projectJson.orgId;
    }
    const vercelJson = await readJsonFile(path_1.default.join(root, 'vercel.json'));
    if (vercelJson) {
        sources.push('vercel.json');
        if (typeof vercelJson.buildCommand === 'string')
            config.buildCommand = vercelJson.buildCommand;
        if (typeof vercelJson.outputDirectory === 'string')
            config.outputDir = vercelJson.outputDirectory;
        if (typeof vercelJson.name === 'string')
            config.projectName = vercelJson.name;
    }
    // Vercel source deploys should usually let Vercel run framework defaults.
    // Only fill local build/output when the project explicitly declares them in vercel.json.
    if (sources.length === 0) {
        sources.push('package.json inference');
    }
    const confidence = projectJson || vercelJson ? 'high' : context.framework ? 'medium' : 'low';
    return {
        provider: 'vercel',
        confidence,
        summary: projectJson
            ? 'Linked Vercel project found.'
            : context.framework
                ? `${context.framework} project ready for Vercel CLI deploy.`
                : 'Vercel settings inferred from the project folder.',
        config,
        sources,
        warnings,
    };
}
async function scanCloudflare(root, context) {
    const sources = [];
    const warnings = [];
    const config = {
        provider: 'cloudflare',
        target: 'preview',
        deployCwd: '',
        buildCommand: context.buildCommand,
        outputDir: context.outputDir || '',
        projectName: context.folderName,
        branch: context.gitBranch || '',
        productionBranch: context.productionBranch || 'main',
    };
    const wrangler = await readWranglerConfig(root);
    if (wrangler) {
        sources.push(wrangler.fileName);
        if (wrangler.values.name)
            config.projectName = wrangler.values.name;
        if (wrangler.values.account_id)
            config.accountId = wrangler.values.account_id;
        if (wrangler.values.pages_build_output_dir)
            config.outputDir = wrangler.values.pages_build_output_dir;
    }
    const packageJson = await readPackageJson(root);
    const deployScript = packageJson?.scripts
        ? Object.values(packageJson.scripts).find((script) => script.includes('wrangler pages deploy'))
        : undefined;
    if (deployScript) {
        sources.push('package.json deploy script');
        const output = deployScript.match(/wrangler\s+pages\s+deploy\s+([^\s]+)/)?.[1];
        const projectName = deployScript.match(/--project-name(?:=|\s+)([^\s]+)/)?.[1];
        if (output && !output.startsWith('-'))
            config.outputDir = output;
        if (projectName)
            config.projectName = projectName;
    }
    if (!config.accountId) {
        warnings.push('Cloudflare Account ID cannot be read from most projects. Testing the token can auto-fill it when the token has access to one account.');
    }
    if (context.framework === 'Next.js' && !context.nextStaticExport) {
        warnings.push('This Next.js project is not configured for static export. Cloudflare Direct Upload needs `output: \"export\"` and a static output directory such as `out`.');
    }
    if (context.framework === 'Next.js' && context.hasNextApiRoutes) {
        warnings.push('This project contains Next.js route handlers under `app/api`, which are not supported by Cloudflare Direct Upload.');
    }
    if (sources.length === 0) {
        sources.push('package.json inference');
    }
    const confidence = wrangler ? 'high' : deployScript ? 'medium' : 'low';
    return {
        provider: 'cloudflare',
        confidence,
        summary: wrangler
            ? 'Cloudflare Wrangler config found.'
            : deployScript
                ? 'Cloudflare Pages deploy script found.'
                : context.framework === 'Next.js' && (!context.nextStaticExport || context.hasNextApiRoutes)
                    ? 'This Next.js app is not compatible with Cloudflare Direct Upload in its current form.'
                    : 'Cloudflare Pages settings inferred from framework defaults.',
        config,
        sources,
        warnings,
    };
}
async function readPackageJson(root) {
    const json = await readJsonFile(path_1.default.join(root, 'package.json'));
    return json;
}
async function readJsonFile(filePath) {
    try {
        const raw = await promises_1.default.readFile(filePath, 'utf8');
        return JSON.parse(stripJsonComments(raw));
    }
    catch {
        return null;
    }
}
async function detectPackageManager(root) {
    if (await exists(path_1.default.join(root, 'pnpm-lock.yaml')))
        return 'pnpm';
    if (await exists(path_1.default.join(root, 'yarn.lock')))
        return 'yarn';
    if (await exists(path_1.default.join(root, 'bun.lockb')) || await exists(path_1.default.join(root, 'bun.lock')))
        return 'bun';
    return 'npm';
}
function detectFramework(packageJson, root) {
    const deps = {
        ...(packageJson?.dependencies || {}),
        ...(packageJson?.devDependencies || {}),
    };
    if (deps.next)
        return 'Next.js';
    if (deps.astro)
        return 'Astro';
    if (deps.nuxt)
        return 'Nuxt';
    if (deps['@sveltejs/kit'])
        return 'SvelteKit';
    if (deps['@remix-run/dev'])
        return 'Remix';
    if (deps.vite)
        return 'Vite';
    if (deps.vue)
        return 'Vue';
    if (deps.react)
        return 'React';
    if (root)
        return undefined;
    return undefined;
}
async function detectOutputDir(root, framework, packageJson, nextStaticExport = false) {
    if (framework === 'Next.js') {
        return nextStaticExport ? 'out' : '';
    }
    if (framework === 'Nuxt')
        return '.output/public';
    if (framework === 'Remix')
        return 'build/client';
    if (framework === 'SvelteKit')
        return 'build';
    if (framework === 'Astro' || framework === 'Vite' || framework === 'Vue' || framework === 'React')
        return 'dist';
    if (packageJson?.scripts?.build)
        return 'dist';
    return '';
}
async function isNextStaticExport(root) {
    const nextConfig = await readTextIfExists(path_1.default.join(root, 'next.config.js'))
        || await readTextIfExists(path_1.default.join(root, 'next.config.mjs'))
        || await readTextIfExists(path_1.default.join(root, 'next.config.ts'));
    return Boolean(nextConfig && /output\s*:\s*['"]export['"]/.test(nextConfig));
}
async function hasNextApiRouteHandlers(root) {
    return (await exists(path_1.default.join(root, 'src', 'app', 'api'))) || (await exists(path_1.default.join(root, 'app', 'api')));
}
function buildCommandFor(packageManager) {
    if (packageManager === 'npm')
        return 'npm run build';
    if (packageManager === 'bun')
        return 'bun run build';
    return `${packageManager} build`;
}
async function readWranglerConfig(root) {
    const candidates = ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'];
    for (const fileName of candidates) {
        const filePath = path_1.default.join(root, fileName);
        const raw = await readTextIfExists(filePath);
        if (!raw)
            continue;
        if (fileName.endsWith('.toml')) {
            return { fileName, values: parseSimpleToml(raw) };
        }
        try {
            const json = JSON.parse(stripJsonComments(raw));
            return {
                fileName,
                values: Object.fromEntries(Object.entries(json).filter(([, value]) => typeof value === 'string')),
            };
        }
        catch {
            return null;
        }
    }
    return null;
}
function parseSimpleToml(raw) {
    const values = {};
    for (const line of raw.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?([^"'\n#]+)["']?/);
        if (match)
            values[match[1]] = match[2].trim();
    }
    return values;
}
async function detectProductionBranch(root) {
    const remoteHead = await runGit(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
    if (remoteHead?.startsWith('origin/'))
        return remoteHead.slice('origin/'.length);
    if (await runGit(root, ['rev-parse', '--verify', 'main']))
        return 'main';
    if (await runGit(root, ['rev-parse', '--verify', 'master']))
        return 'master';
    return null;
}
function runGit(cwd, args) {
    return new Promise((resolve) => {
        (0, child_process_1.execFile)('git', args, { cwd, windowsHide: true }, (error, stdout) => {
            if (error) {
                resolve(null);
                return;
            }
            resolve(stdout.trim() || null);
        });
    });
}
async function exists(filePath) {
    try {
        await promises_1.default.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
async function readTextIfExists(filePath) {
    try {
        return await promises_1.default.readFile(filePath, 'utf8');
    }
    catch {
        return null;
    }
}
function stripJsonComments(raw) {
    return raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}
