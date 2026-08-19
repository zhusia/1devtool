"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.testVercelToken = testVercelToken;
exports.deployVercel = deployVercel;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const secretStore_1 = require("../secretStore");
const build_1 = require("../build");
const env_1 = require("../../utils/env");
const semver = require('semver');
const SUPPORTED_VERCEL_NODE_MAJORS = [22, 20, 18];
async function testVercelToken(request) {
    const token = request.token.trim();
    const errors = [];
    const result = {
        ok: false,
        provider: 'vercel',
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
        errors.push('Paste a Vercel token first.');
        return result;
    }
    const userResponse = await vercelFetch('/v2/user', token);
    if (!userResponse.ok) {
        errors.push(`Vercel rejected this token (${userResponse.status}).`);
        return result;
    }
    const userJson = await userResponse.json().catch(() => ({}));
    const user = userJson?.user || userJson;
    const label = user?.email || user?.username || user?.name || user?.id || 'Vercel user';
    result.identity = {
        label,
        id: user?.id,
        email: user?.email,
    };
    result.capabilities.identity = true;
    const teamId = request.teamId?.trim();
    const projectName = request.projectName?.trim();
    if (teamId || projectName) {
        const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : '';
        const targetResponse = projectName
            ? await vercelFetch(`/v9/projects/${encodeURIComponent(projectName)}${query}`, token)
            : await vercelFetch(`/v9/projects${query}`, token);
        if (!targetResponse.ok) {
            if (projectName && targetResponse.status === 404) {
                if (teamId) {
                    const teamResponse = await vercelFetch(`/v2/teams/${encodeURIComponent(teamId)}`, token);
                    if (!teamResponse.ok) {
                        errors.push(`Token works, but cannot access Vercel team "${teamId}" (${teamResponse.status}).`);
                        result.target = { label: teamId, id: teamId };
                        result.capabilities.targetAccess = false;
                        return result;
                    }
                }
                result.target = {
                    label: `Project "${projectName}" will be created on first deploy.`,
                    id: projectName,
                };
                result.capabilities.targetAccess = false;
                result.capabilities.deployPermission = true;
                result.ok = true;
                return result;
            }
            errors.push(`Token works, but cannot access the selected Vercel ${projectName ? 'project' : 'team'} (${targetResponse.status}).`);
            result.target = {
                label: projectName || teamId || 'Vercel target',
                id: projectName || teamId,
            };
            result.capabilities.targetAccess = false;
            return result;
        }
        const targetJson = await targetResponse.json().catch(() => ({}));
        result.target = {
            label: projectName || targetJson?.name || teamId || 'Vercel target',
            id: targetJson?.id || projectName || teamId,
        };
    }
    else {
        const defaultScope = await resolveVercelDefaultScope(token, user);
        result.target = defaultScope
            ? {
                label: defaultScope.label,
                id: defaultScope.id,
            }
            : {
                label: user?.username || user?.email || 'Personal account',
                id: user?.username || user?.id,
            };
    }
    result.capabilities.targetAccess = true;
    result.ok = true;
    return result;
}
async function deployVercel(context) {
    const { project, config, token, signal, onLog } = context;
    const deployCwd = (0, build_1.resolveDeployCwd)(project.rootPath, config.deployCwd);
    const isProd = config.target === 'production';
    const environment = isProd ? 'production' : 'preview';
    const nodeRuntime = await resolveSupportedVercelNodeRuntime(deployCwd, config.nodeVersion);
    if (!nodeRuntime.selected) {
        const detected = nodeRuntime.detected?.version || 'unknown';
        throw new Error(`Vercel CLI needs Node 18, 20, or 22. This machine resolves \`node\` to ${detected}, and 1DevTool could not find a supported fallback under PATH, ~/.nvm, ~/.volta, ~/.asdf, or ~/.local/share/fnm. Install Node 22 or 20, or change PATH before deploying to Vercel.`);
    }
    if (nodeRuntime.selectionNote) {
        onLog('system', `${nodeRuntime.selectionNote}\n`);
    }
    const scopeArgs = [];
    const scopeMode = config.vercelScopeMode || 'auto';
    if (scopeMode === 'team') {
        const explicitScope = config.teamId?.trim();
        if (!explicitScope) {
            throw new Error('Vercel team mode requires a team slug or team ID.');
        }
        onLog('system', `Using explicit Vercel team scope ${explicitScope}.\n`);
        scopeArgs.push('--scope', explicitScope);
    }
    else if (scopeMode === 'auto') {
        const resolvedScope = (await resolveVercelDefaultScope(token))?.id || '';
        if (resolvedScope) {
            onLog('system', `Using auto-detected Vercel scope ${resolvedScope}.\n`);
            scopeArgs.push('--scope', resolvedScope);
        }
        else {
            onLog('system', 'No Vercel team scope detected; using personal account.\n');
        }
    }
    else {
        onLog('system', 'Using Vercel personal account.\n');
    }
    const spawnOpts = {
        cwd: deployCwd,
        env: (0, build_1.envVarsToRecord)(config.envVars),
        extraPaths: nodeRuntime.selected.binDir ? [nodeRuntime.selected.binDir] : [],
        signal,
        redact: [token],
        onLog,
    };
    if (config.buildCommand?.trim()) {
        const build = await (0, build_1.runProjectBuild)(config.buildCommand, deployCwd, spawnOpts);
        if (build.exitCode !== 0) {
            throw new Error(`Build failed with exit code ${build.exitCode}.`);
        }
    }
    const alreadyLinked = await isVercelLinked(deployCwd);
    if (!alreadyLinked) {
        const explicitName = (config.projectName || config.projectId || '').trim();
        const linkArgs = ['vercel', 'link', '--yes', '--token', token, ...scopeArgs];
        if (explicitName)
            linkArgs.push('--project', explicitName);
        onLog('system', explicitName
            ? `Linking to Vercel project "${explicitName}" (creating it if needed).\n`
            : 'No linked Vercel project found; Vercel CLI will create one from the folder name.\n');
        const link = await (0, build_1.runCli)('npx', linkArgs, spawnOpts);
        if (link.exitCode !== 0) {
            throw new Error(summarizeVercelFailure(link.stdout, link.stderr, link.exitCode));
        }
    }
    const pull = await (0, build_1.runCli)('npx', ['vercel', 'pull', '--yes', '--environment', environment, '--token', token, ...scopeArgs], spawnOpts);
    if (pull.exitCode !== 0) {
        throw new Error(summarizeVercelFailure(pull.stdout, pull.stderr, pull.exitCode));
    }
    const buildArgs = ['vercel', 'build', '--token', token, ...scopeArgs];
    if (isProd)
        buildArgs.push('--prod');
    const build = await (0, build_1.runCli)('npx', buildArgs, spawnOpts);
    if (build.exitCode !== 0) {
        throw new Error(summarizeVercelFailure(build.stdout, build.stderr, build.exitCode));
    }
    const deployArgs = ['vercel', 'deploy', '--prebuilt', '--yes', '--token', token, ...scopeArgs];
    if (isProd)
        deployArgs.push('--prod');
    const deploy = await (0, build_1.runCli)('npx', deployArgs, spawnOpts);
    if (deploy.exitCode !== 0) {
        const inspection = await inspectFailedDeployment(findDeploymentUrl(`${deploy.stdout}\n${deploy.stderr}`), token, scopeArgs, spawnOpts);
        throw new Error(summarizeVercelFailure(deploy.stdout, deploy.stderr, deploy.exitCode, inspection));
    }
    const url = findDeploymentUrl(deploy.stdout) || findDeploymentUrl(deploy.stderr);
    return {
        url,
    };
}
async function isVercelLinked(deployCwd) {
    try {
        const raw = await fs_1.default.promises.readFile(path_1.default.join(deployCwd, '.vercel', 'project.json'), 'utf8');
        const parsed = JSON.parse(raw);
        return typeof parsed.projectId === 'string' && parsed.projectId.length > 0;
    }
    catch {
        return false;
    }
}
async function vercelFetch(path, token) {
    return fetch(`https://api.vercel.com${path}`, {
        headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': '1DevTool',
        },
    });
}
async function resolveVercelDefaultScope(token, existingUser) {
    const user = existingUser || await fetchVercelUser(token);
    if (!user)
        return null;
    const defaultTeamId = typeof user.defaultTeamId === 'string' ? user.defaultTeamId : '';
    if (defaultTeamId) {
        const team = await fetchVercelTeam(token, defaultTeamId);
        if (team) {
            return {
                id: team.slug || team.id || defaultTeamId,
                label: team.name || team.slug || defaultTeamId,
            };
        }
        return { id: defaultTeamId, label: defaultTeamId };
    }
    const username = typeof user.username === 'string' ? user.username : '';
    if (username) {
        return { id: username, label: username };
    }
    return null;
}
async function fetchVercelUser(token) {
    const response = await vercelFetch('/v2/user', token);
    if (!response.ok)
        return null;
    const json = await response.json().catch(() => ({}));
    return (json?.user || json);
}
async function fetchVercelTeam(token, teamId) {
    const response = await vercelFetch(`/v2/teams/${encodeURIComponent(teamId)}`, token);
    if (!response.ok)
        return null;
    return await response.json().catch(() => ({}));
}
function findDeploymentUrl(output) {
    const matches = output.match(/https:\/\/[^\s"')]+/g) || [];
    return matches.find((url) => url.includes('.vercel.app') || url.includes('vercel.app')) || matches[0] || null;
}
function findInspectUrl(output) {
    const match = output.match(/Inspect:\s*(https:\/\/vercel\.com\/[^\s"')]+)/i);
    return match?.[1] || null;
}
function summarizeVercelFailure(stdout, stderr, exitCode, inspection) {
    const combined = `${stdout}\n${stderr}`;
    const fairUse = combined.match(/fair use limits.*blocked/i);
    if (fairUse) {
        return 'Vercel rejected the deploy because the selected team is blocked for fair-use limits.';
    }
    const missingScope = combined.match(/missing_scope|Provide --scope or --team explicitly/i);
    if (missingScope) {
        return 'Vercel requires an explicit scope for non-interactive deploys.';
    }
    const inspectUrl = findInspectUrl(stdout) || findInspectUrl(stderr);
    if (inspection?.explicitReason) {
        return inspectUrl ? `${inspection.explicitReason} Open build logs: ${inspectUrl}` : inspection.explicitReason;
    }
    if (/Unexpected error\. Please try again later/i.test(combined)) {
        const suffix = inspectUrl ? ` Open build logs: ${inspectUrl}` : '';
        return [
            'Vercel server-side post-processing failed with a generic error.',
            'Common causes: (1) Vercel blocked the deployment after upload because of Git/private-repo access checks or other policy checks,',
            '(2) the Vercel project is in a wedged state — delete it from the Vercel dashboard and retry to create a fresh one,',
            '(3) Vercel infra hiccup — retry in a few minutes.' + suffix,
        ].join(' ');
    }
    const explicitError = combined.match(/Error:\s*(.+)/);
    if (explicitError?.[1]) {
        const base = explicitError[1].trim();
        return inspectUrl ? `${base} Build logs: ${inspectUrl}` : base;
    }
    return `Vercel deploy failed with exit code ${exitCode}.`;
}
async function resolveSupportedVercelNodeRuntime(projectDir, requestedVersion) {
    const detected = await readNodeRuntime('node');
    const candidates = dedupeNodeRuntimes([
        ...(detected && isSupportedVercelNodeRuntime(detected) ? [detected] : []),
        ...await findSupportedNodeCandidates(),
    ]);
    const override = requestedVersion?.trim() || '';
    if (override) {
        const selected = findRequestedNodeRuntime(candidates, override);
        if (!selected) {
            const available = candidates.map((candidate) => candidate.version).join(', ') || 'none';
            throw new Error(`Requested Vercel Node version "${override}" is not installed. Available supported versions: ${available}.`);
        }
        return {
            detected,
            selected,
            usingFallback: !isSameRuntime(selected, detected),
            selectionNote: describeRequestedNodeSelection(detected, selected, override),
        };
    }
    const requirements = await readProjectNodeRequirements(projectDir);
    const selected = pickBestNodeRuntime(candidates, requirements, detected);
    return {
        detected,
        selected: selected?.runtime || null,
        usingFallback: Boolean(selected && !isSameRuntime(selected.runtime, detected)),
        selectionNote: selected ? describeAutoNodeSelection(detected, selected, requirements) : null,
    };
}
async function findSupportedNodeCandidates() {
    const binDirs = await findCandidateNodeBinDirs();
    const runtimes = [];
    const seen = new Set();
    for (const binDir of binDirs) {
        if (!binDir || seen.has(binDir))
            continue;
        seen.add(binDir);
        const executable = path_1.default.join(binDir, process.platform === 'win32' ? 'node.exe' : 'node');
        const runtime = await readNodeRuntime(executable);
        if (!runtime)
            continue;
        if (!isSupportedVercelNodeRuntime(runtime))
            continue;
        runtimes.push({ ...runtime, binDir });
    }
    runtimes.sort(compareNodeRuntime);
    return runtimes;
}
async function findCandidateNodeBinDirs() {
    const home = os_1.default.homedir();
    const roots = [
        [process.env.NVM_DIR || path_1.default.join(home, '.nvm'), 'versions', 'node'],
        [process.env.VOLTA_HOME || path_1.default.join(home, '.volta'), 'tools', 'image', 'node'],
        [process.env.ASDF_DATA_DIR || path_1.default.join(home, '.asdf'), 'installs', 'nodejs'],
        [process.env.FNM_DIR || path_1.default.join(home, '.local', 'share', 'fnm'), 'node-versions'],
    ];
    const found = [];
    for (const [root, ...segments] of roots) {
        const baseDir = path_1.default.join(root, ...segments);
        const entries = await readDirectories(baseDir);
        for (const entry of entries) {
            found.push(path_1.default.join(entry, 'bin'));
            found.push(path_1.default.join(entry, 'installation', 'bin'));
        }
    }
    return found;
}
async function readDirectories(root) {
    try {
        const entries = await fs_1.default.promises.readdir(root, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => path_1.default.join(root, entry.name));
    }
    catch {
        return [];
    }
}
async function readNodeRuntime(command) {
    const version = await readCommandVersion(command);
    if (!version)
        return null;
    const major = parseNodeMajor(version);
    if (!major)
        return null;
    const hasExplicitPath = command.includes('/') || command.includes('\\') || path_1.default.isAbsolute(command);
    return {
        version,
        major,
        binDir: hasExplicitPath ? path_1.default.dirname(command) : null,
    };
}
async function readCommandVersion(command) {
    return new Promise((resolve) => {
        let stdout = '';
        let settled = false;
        try {
            const child = (0, child_process_1.spawn)(command, ['-v'], {
                env: (0, env_1.getEnrichedEnv)(),
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true,
            });
            child.stdout.on('data', (chunk) => {
                stdout += chunk.toString('utf8');
            });
            child.on('error', () => {
                if (settled)
                    return;
                settled = true;
                resolve(null);
            });
            child.on('close', (code) => {
                if (settled)
                    return;
                settled = true;
                resolve(code === 0 ? stdout.trim() || null : null);
            });
        }
        catch {
            resolve(null);
        }
    });
}
function parseNodeMajor(version) {
    const match = version.match(/v?(\d+)\.\d+\.\d+/);
    return match ? Number(match[1]) : null;
}
function compareNodeRuntime(a, b) {
    const rankA = SUPPORTED_VERCEL_NODE_MAJORS.indexOf(a.major);
    const rankB = SUPPORTED_VERCEL_NODE_MAJORS.indexOf(b.major);
    if (rankA !== rankB)
        return rankA - rankB;
    return compareSemverDesc(a.version, b.version);
}
function compareSemverDesc(a, b) {
    const partsA = a.replace(/^v/, '').split('.').map((part) => Number(part) || 0);
    const partsB = b.replace(/^v/, '').split('.').map((part) => Number(part) || 0);
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i += 1) {
        const diff = (partsB[i] || 0) - (partsA[i] || 0);
        if (diff !== 0)
            return diff;
    }
    return 0;
}
function isSupportedVercelNodeRuntime(runtime) {
    return SUPPORTED_VERCEL_NODE_MAJORS.includes(runtime.major);
}
function dedupeNodeRuntimes(runtimes) {
    const seen = new Set();
    return runtimes.filter((runtime) => {
        const key = `${runtime.version}|${runtime.binDir || ''}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
function isSameRuntime(a, b) {
    if (!a || !b)
        return false;
    return a.version === b.version && (a.binDir || '') === (b.binDir || '');
}
function normalizeSemverVersion(version) {
    return semver.coerce(version)?.version || version.replace(/^v/, '');
}
function rangeSatisfied(version, range) {
    const normalizedRange = semver.validRange(range, { loose: true });
    if (!normalizedRange)
        return true;
    return semver.satisfies(normalizeSemverVersion(version), normalizedRange, { includePrerelease: true });
}
function findRequestedNodeRuntime(candidates, requestedVersion) {
    const normalizedRange = normalizeRequestedNodeRange(requestedVersion);
    if (!normalizedRange)
        return null;
    const matches = candidates.filter((candidate) => rangeSatisfied(candidate.version, normalizedRange));
    matches.sort(compareNodeRuntime);
    return matches[0] || null;
}
function normalizeRequestedNodeRange(requestedVersion) {
    const trimmed = requestedVersion.trim().replace(/^v/, '');
    if (!trimmed)
        return null;
    if (/^\d+$/.test(trimmed))
        return `^${trimmed}.0.0`;
    if (/^\d+\.\d+$/.test(trimmed))
        return `^${trimmed}.0`;
    if (/^\d+\.\d+\.\d+$/.test(trimmed))
        return trimmed;
    return semver.validRange(trimmed, { loose: true });
}
async function readProjectNodeRequirements(projectDir) {
    const packageJson = await readJsonFile(path_1.default.join(projectDir, 'package.json'));
    const lockfile = await readJsonFile(path_1.default.join(projectDir, 'package-lock.json'));
    const dependencyRanges = new Set();
    for (const entry of Object.values(lockfile?.packages || {})) {
        const range = entry?.engines?.node?.trim();
        if (!range)
            continue;
        const normalized = semver.validRange(range, { loose: true });
        if (!normalized)
            continue;
        dependencyRanges.add(normalized);
    }
    return {
        packageRange: packageJson?.engines?.node?.trim() || null,
        dependencyRanges: Array.from(dependencyRanges),
    };
}
async function readJsonFile(filePath) {
    try {
        return JSON.parse(await fs_1.default.promises.readFile(filePath, 'utf8'));
    }
    catch {
        return null;
    }
}
function pickBestNodeRuntime(candidates, requirements, detected) {
    const scored = candidates.map((runtime) => evaluateNodeRuntime(runtime, requirements, detected));
    scored.sort((a, b) => compareNodeRuntimeCandidateScore(a, b));
    return scored[0] || null;
}
function evaluateNodeRuntime(runtime, requirements, detected) {
    const packageSatisfied = !requirements.packageRange || rangeSatisfied(runtime.version, requirements.packageRange);
    const unsatisfiedDependencyCount = requirements.dependencyRanges.reduce((count, range) => (rangeSatisfied(runtime.version, range) ? count : count + 1), 0);
    return {
        runtime,
        isDetected: isSameRuntime(runtime, detected),
        packageSatisfied,
        unsatisfiedDependencyCount,
    };
}
function compareNodeRuntimeCandidateScore(a, b) {
    if (a.packageSatisfied !== b.packageSatisfied)
        return a.packageSatisfied ? -1 : 1;
    if (a.unsatisfiedDependencyCount !== b.unsatisfiedDependencyCount) {
        return a.unsatisfiedDependencyCount - b.unsatisfiedDependencyCount;
    }
    if (a.isDetected !== b.isDetected)
        return a.isDetected ? -1 : 1;
    return compareNodeRuntime(a.runtime, b.runtime);
}
function describeRequestedNodeSelection(detected, selected, requestedVersion) {
    if (isSameRuntime(detected, selected)) {
        return `Using requested Vercel Node version ${selected.version}.`;
    }
    if (detected) {
        return `Current PATH resolves node to ${detected.version}; using requested Vercel Node version ${selected.version} from ${selected.binDir || 'PATH'}.`;
    }
    return `Using requested Vercel Node version ${selected.version} from ${selected.binDir || 'PATH'}.`;
}
function describeAutoNodeSelection(detected, selected, requirements) {
    const lockfileReason = selected.unsatisfiedDependencyCount === 0 && requirements.dependencyRanges.length > 0
        ? ' It satisfies the project lockfile Node engine constraints.'
        : selected.unsatisfiedDependencyCount > 0
            ? ` It still misses ${selected.unsatisfiedDependencyCount} lockfile engine constraint${selected.unsatisfiedDependencyCount === 1 ? '' : 's'}.`
            : '';
    if (!detected) {
        return `Using ${selected.runtime.version} from ${selected.runtime.binDir || 'PATH'} for the Vercel CLI.${lockfileReason}`;
    }
    if (isSameRuntime(detected, selected.runtime)) {
        return null;
    }
    if (!isSupportedVercelNodeRuntime(detected)) {
        return `Vercel CLI needs Node 18/20/22. Current PATH resolves node to ${detected.version}; using ${selected.runtime.version} from ${selected.runtime.binDir || 'PATH'}.${lockfileReason}`;
    }
    return `Current PATH resolves node to ${detected.version}; using ${selected.runtime.version} from ${selected.runtime.binDir || 'PATH'} because it matches this project better.${lockfileReason}`;
}
async function inspectFailedDeployment(deploymentUrl, token, scopeArgs, spawnOpts) {
    if (!deploymentUrl)
        return { explicitReason: null };
    const inspect = await (0, build_1.runCli)('npx', ['vercel', 'inspect', deploymentUrl, '--timeout=20s', '--token', token, ...scopeArgs], spawnOpts);
    const combined = `${inspect.stdout}\n${inspect.stderr}`;
    const explicitReason = extractDeploymentBlockedReason(combined);
    if (explicitReason) {
        return { explicitReason };
    }
    const inspectLogs = await (0, build_1.runCli)('npx', ['vercel', 'inspect', deploymentUrl, '--logs', '--timeout=20s', '--token', token, ...scopeArgs], spawnOpts);
    return {
        explicitReason: extractDeploymentBlockedReason(`${inspectLogs.stdout}\n${inspectLogs.stderr}`),
    };
}
function extractDeploymentBlockedReason(output) {
    const commitEmailMatch = output.match(/commit email\s+([^\s]+)\s+could not be matched to a GitHub account/i);
    if (commitEmailMatch?.[1]) {
        return `Vercel blocked this deployment because commit email ${commitEmailMatch[1]} could not be matched to a GitHub account linked to Vercel. Update the commit author email to match your GitHub account, then redeploy.`;
    }
    if (/git author .*access to (the )?project/i.test(output) || /deployment blocked/i.test(output)) {
        return 'Vercel blocked this deployment because the commit author is not authorized for this Git-connected private repository. Make sure the commit author email matches the GitHub account linked to Vercel and that account has access to the target project/team.';
    }
    return null;
}
