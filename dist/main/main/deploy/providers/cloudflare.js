"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.testCloudflareToken = testCloudflareToken;
exports.deployCloudflare = deployCloudflare;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const secretStore_1 = require("../secretStore");
const build_1 = require("../build");
async function testCloudflareToken(request) {
    const token = request.token.trim();
    const accountId = request.accountId?.trim();
    const projectName = request.projectName?.trim();
    const errors = [];
    const result = {
        ok: false,
        provider: 'cloudflare',
        errors,
        testedAt: Date.now(),
        tokenHash: (0, secretStore_1.hashToken)(token),
        tokenLast4: (0, secretStore_1.tokenLast4)(token),
        capabilities: {
            identity: false,
            targetAccess: false,
            deployPermission: null,
        },
    };
    if (!token) {
        errors.push('Paste a Cloudflare API token first.');
        return result;
    }
    const verifyResponse = await cloudflareFetch('/user/tokens/verify', token);
    const verifyJson = await verifyResponse.json().catch(() => ({}));
    if (!verifyResponse.ok || verifyJson?.success === false) {
        errors.push(`Cloudflare rejected this token (${verifyResponse.status}).`);
        return result;
    }
    result.identity = {
        label: verifyJson?.result?.status ? `Cloudflare token (${verifyJson.result.status})` : 'Cloudflare token',
        id: verifyJson?.result?.id,
    };
    result.capabilities.identity = true;
    const resolvedAccount = accountId
        ? { id: accountId }
        : await detectSingleCloudflareAccount(token);
    if (!resolvedAccount.id) {
        result.target = {
            label: resolvedAccount.error || 'Cloudflare account ID still required',
        };
        result.ok = true;
        return result;
    }
    const accountResponse = await cloudflareFetch(`/accounts/${encodeURIComponent(resolvedAccount.id)}`, token);
    const accountJson = await accountResponse.json().catch(() => ({}));
    if (!accountResponse.ok || accountJson?.success === false) {
        errors.push(`Token works, but cannot access this Cloudflare account (${accountResponse.status}).`);
        result.target = { label: resolvedAccount.id, id: resolvedAccount.id };
        return result;
    }
    const accountName = accountJson?.result?.name || resolvedAccount.name || resolvedAccount.id;
    result.target = {
        label: accountName,
        id: resolvedAccount.id,
    };
    const pagesPath = projectName
        ? `/accounts/${encodeURIComponent(resolvedAccount.id)}/pages/projects/${encodeURIComponent(projectName)}`
        : `/accounts/${encodeURIComponent(resolvedAccount.id)}/pages/projects`;
    const pagesResponse = await cloudflareFetch(pagesPath, token);
    const pagesJson = await pagesResponse.json().catch(() => ({}));
    if (!pagesResponse.ok || pagesJson?.success === false) {
        if (projectName) {
            const listResponse = await cloudflareFetch(`/accounts/${encodeURIComponent(resolvedAccount.id)}/pages/projects`, token);
            const listJson = await listResponse.json().catch(() => ({}));
            if (listResponse.ok && listJson?.success !== false) {
                result.capabilities.targetAccess = true;
                result.capabilities.deployPermission = true;
                result.ok = true;
                return result;
            }
        }
        errors.push(projectName
            ? `Token can access the account, but not Pages project "${projectName}" (${pagesResponse.status}).`
            : `Token can access the account, but not Cloudflare Pages projects (${pagesResponse.status}).`);
        return result;
    }
    result.capabilities.targetAccess = true;
    result.capabilities.deployPermission = true;
    result.ok = true;
    return result;
}
async function detectSingleCloudflareAccount(token) {
    const response = await cloudflareFetch('/accounts', token);
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json?.success === false) {
        return { id: null, error: `Token is valid, but account list failed (${response.status}).` };
    }
    const accounts = Array.isArray(json?.result) ? json.result : [];
    if (accounts.length === 1) {
        return { id: accounts[0]?.id || null, name: accounts[0]?.name };
    }
    if (accounts.length > 1) {
        return { id: null, error: 'Token can access multiple Cloudflare accounts. Paste the Account ID once, then test again.' };
    }
    return { id: null, error: 'Token is valid, but no Cloudflare accounts were returned.' };
}
async function deployCloudflare(context) {
    const { project, config, token, signal, onLog } = context;
    const deployCwd = (0, build_1.resolveDeployCwd)(project.rootPath, config.deployCwd);
    const accountId = config.accountId?.trim();
    const projectName = config.projectName?.trim();
    const explicitOutputDir = config.outputDir?.trim() || '';
    if (!accountId) {
        throw new Error('Cloudflare Account ID is required.');
    }
    if (!projectName) {
        throw new Error('Cloudflare Pages project name is required.');
    }
    if (config.buildCommand?.trim()) {
        const build = await (0, build_1.runProjectBuild)(config.buildCommand, deployCwd, {
            cwd: deployCwd,
            env: (0, build_1.envVarsToRecord)(config.envVars),
            signal,
            redact: [token],
            onLog,
        });
        if (build.exitCode !== 0) {
            throw new Error(`Build failed with exit code ${build.exitCode}.`);
        }
    }
    const outputDir = await resolveCloudflareOutputDir(deployCwd, explicitOutputDir);
    if (!fs_1.default.existsSync(outputDir)) {
        throw new Error(`Output directory does not exist: ${outputDir}`);
    }
    const args = ['wrangler', 'pages', 'deploy', outputDir, `--project-name=${projectName}`];
    const branch = config.target === 'production'
        ? (config.productionBranch?.trim() || config.branch?.trim())
        : config.branch?.trim();
    if (branch) {
        args.push(`--branch=${branch}`);
    }
    const deploy = await (0, build_1.runCli)('npx', args, {
        cwd: deployCwd,
        signal,
        redact: [token],
        env: {
            ...(0, build_1.envVarsToRecord)(config.envVars),
            CLOUDFLARE_ACCOUNT_ID: accountId,
            CLOUDFLARE_API_TOKEN: token,
        },
        onLog,
    });
    if (deploy.exitCode !== 0) {
        throw new Error(`Cloudflare Pages deploy failed with exit code ${deploy.exitCode}.`);
    }
    return {
        url: findPagesUrl(`${deploy.stdout}\n${deploy.stderr}`),
    };
}
async function cloudflareFetch(path, token) {
    return fetch(`https://api.cloudflare.com/client/v4${path}`, {
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': '1DevTool',
        },
    });
}
function findPagesUrl(output) {
    const matches = output.match(/https:\/\/[^\s"')]+/g) || [];
    return matches.find((url) => url.includes('.pages.dev')) || matches[0] || null;
}
async function resolveCloudflareOutputDir(deployCwd, explicitOutputDir) {
    if (explicitOutputDir) {
        return (0, build_1.resolveOutputDir)(deployCwd, explicitOutputDir);
    }
    const nextConfig = await readTextIfExists(deployCwd, 'next.config.js')
        || await readTextIfExists(deployCwd, 'next.config.mjs')
        || await readTextIfExists(deployCwd, 'next.config.ts');
    if (nextConfig) {
        if (/output\s*:\s*['"]export['"]/.test(nextConfig)) {
            return (0, build_1.resolveOutputDir)(deployCwd, 'out');
        }
        throw new Error('This Next.js project builds to `.next`, not a static export. Cloudflare Direct Upload only works with static output. Set `output: \"export\"` in Next.js to generate `out`, or deploy this project to Vercel instead.');
    }
    throw new Error('Output directory is required for Cloudflare Direct Upload. Set it in Advanced settings or configure a supported static framework output.');
}
async function readTextIfExists(root, fileName) {
    try {
        return await fs_1.default.promises.readFile(path_1.default.join(root, fileName), 'utf8');
    }
    catch {
        return null;
    }
}
