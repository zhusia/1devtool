"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAndRunIOSApp = buildAndRunIOSApp;
const child_process_1 = require("child_process");
const promises_1 = require("fs/promises");
const path_1 = __importDefault(require("path"));
const util_1 = require("util");
const env_1 = require("../utils/env");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const SKIP_DIRS = new Set([
    '.git',
    '.hg',
    '.svn',
    'build',
    'DerivedData',
    'node_modules',
    'Pods',
    '.next',
    'dist',
]);
function buildEnv() {
    return (0, env_1.getEnrichedEnv)({}, {
        extraPaths: [
            '/Applications/Xcode.app/Contents/Developer/usr/bin',
            '/Library/Developer/CommandLineTools/usr/bin',
        ],
    });
}
async function pathExists(filePath) {
    try {
        await (0, promises_1.stat)(filePath);
        return true;
    }
    catch {
        return false;
    }
}
async function findXcodeProjects(rootPath, maxDepth = 4) {
    const projects = [];
    async function walk(dir, depth) {
        let entries;
        try {
            entries = await (0, promises_1.readdir)(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const fullPath = path_1.default.join(dir, entry.name);
            if (entry.name.endsWith('.xcodeproj')) {
                projects.push(fullPath);
                continue;
            }
            if (depth >= maxDepth || SKIP_DIRS.has(entry.name))
                continue;
            await walk(fullPath, depth + 1);
        }
    }
    await walk(rootPath, 0);
    return projects.sort((a, b) => {
        const depthDelta = a.split(path_1.default.sep).length - b.split(path_1.default.sep).length;
        return depthDelta || a.localeCompare(b);
    });
}
async function runCommand(command, args, options) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)(command, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const stdoutChunks = [];
        const stderrChunks = [];
        child.stdout?.on('data', (chunk) => stdoutChunks.push(chunk));
        child.stderr?.on('data', (chunk) => stderrChunks.push(chunk));
        child.on('error', reject);
        child.on('close', (code) => {
            const stdout = Buffer.concat(stdoutChunks).toString('utf8');
            const stderr = Buffer.concat(stderrChunks).toString('utf8');
            if (code === 0) {
                resolve({ stdout, stderr });
                return;
            }
            const message = stderr.trim() || stdout.trim() || `${command} exited with code ${code ?? 'unknown'}`;
            reject(new Error(message));
        });
    });
}
async function detectScheme(projectPath, projectRoot, fallbackScheme, env) {
    try {
        const { stdout } = await runCommand('xcodebuild', ['-list', '-json', '-project', projectPath], {
            cwd: projectRoot,
            env,
        });
        const parsed = JSON.parse(stdout);
        const schemes = parsed.project?.schemes ?? [];
        if (schemes.includes(fallbackScheme))
            return fallbackScheme;
        return schemes.find((scheme) => !/tests?$/i.test(scheme) && !/uitests?$/i.test(scheme)) ?? schemes[0] ?? fallbackScheme;
    }
    catch {
        return fallbackScheme;
    }
}
function resolveUserPath(rootPath, userPath) {
    const trimmed = userPath?.trim();
    if (!trimmed)
        return null;
    return path_1.default.isAbsolute(trimmed) ? trimmed : path_1.default.resolve(rootPath, trimmed);
}
async function findBuiltApp(derivedDataPath, configuration, preferredNames) {
    const productsDir = path_1.default.join(derivedDataPath, 'Build', 'Products', `${configuration}-iphonesimulator`);
    for (const name of preferredNames) {
        const appPath = path_1.default.join(productsDir, `${name}.app`);
        if (await pathExists(appPath))
            return appPath;
    }
    let entries;
    try {
        entries = await (0, promises_1.readdir)(productsDir, { withFileTypes: true });
    }
    catch {
        return null;
    }
    const appEntries = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith('.app'));
    if (appEntries.length === 0)
        return null;
    const candidates = await Promise.all(appEntries.map(async (entry) => {
        const appPath = path_1.default.join(productsDir, entry.name);
        const appStat = await (0, promises_1.stat)(appPath);
        return { appPath, mtimeMs: appStat.mtimeMs };
    }));
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return candidates[0]?.appPath ?? null;
}
async function readBundleId(appPath, env) {
    const infoPlistPath = path_1.default.join(appPath, 'Info.plist');
    try {
        const { stdout } = await execFileAsync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlistPath], {
            env,
            maxBuffer: 1024 * 1024,
        });
        const bundleId = stdout.trim();
        if (bundleId)
            return bundleId;
    }
    catch {
        // Fall back to PlistBuddy below for older Xcode/macOS toolchains.
    }
    const { stdout } = await execFileAsync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', infoPlistPath], {
        env,
        maxBuffer: 1024 * 1024,
    });
    const bundleId = stdout.trim();
    if (!bundleId)
        throw new Error(`Could not read CFBundleIdentifier from ${infoPlistPath}`);
    return bundleId;
}
async function buildAndRunIOSApp(projectRoot, deviceId, options = {}) {
    if (process.platform !== 'darwin') {
        return { ok: false, error: 'iOS simulator builds require macOS and Xcode.' };
    }
    if (!projectRoot || !await pathExists(projectRoot)) {
        return { ok: false, error: 'The active project path is not available on disk.' };
    }
    if (!deviceId) {
        return { ok: false, error: 'Select an iOS simulator before building.' };
    }
    try {
        const env = buildEnv();
        const requestedProjectPath = resolveUserPath(projectRoot, options.projectPath);
        let xcodeProjectPath;
        if (requestedProjectPath) {
            if (!requestedProjectPath.endsWith('.xcodeproj') || !await pathExists(requestedProjectPath)) {
                return { ok: false, error: `Xcode project not found: ${requestedProjectPath}` };
            }
            xcodeProjectPath = requestedProjectPath;
        }
        else {
            const xcodeProjects = await findXcodeProjects(projectRoot);
            if (xcodeProjects.length === 0) {
                return { ok: false, error: `No .xcodeproj was found under ${projectRoot}.` };
            }
            xcodeProjectPath = xcodeProjects[0];
        }
        const projectName = path_1.default.basename(xcodeProjectPath, '.xcodeproj');
        const scheme = options.scheme?.trim() || await detectScheme(xcodeProjectPath, projectRoot, projectName, env);
        const configuration = options.configuration?.trim() || 'Debug';
        const destination = options.destination?.trim() || `id=${deviceId}`;
        const derivedDataPath = resolveUserPath(projectRoot, options.derivedDataPath) || path_1.default.join(projectRoot, 'build');
        await runCommand('xcodebuild', [
            '-project',
            xcodeProjectPath,
            '-scheme',
            scheme,
            '-configuration',
            configuration,
            '-destination',
            destination,
            '-derivedDataPath',
            derivedDataPath,
            'build',
        ], {
            cwd: projectRoot,
            env,
        });
        const appPath = await findBuiltApp(derivedDataPath, configuration, [scheme, projectName]);
        if (!appPath) {
            return { ok: false, error: `Build completed, but no .app was found in ${path_1.default.join(derivedDataPath, 'Build', 'Products', `${configuration}-iphonesimulator`)}.` };
        }
        const bundleId = await readBundleId(appPath, env);
        await runCommand('xcrun', ['simctl', 'boot', deviceId], { cwd: projectRoot, env }).catch(() => undefined);
        await runCommand('xcrun', ['simctl', 'bootstatus', deviceId, '-b'], { cwd: projectRoot, env }).catch(() => undefined);
        await runCommand('open', ['-a', 'Simulator'], { cwd: projectRoot, env }).catch(() => undefined);
        await runCommand('xcrun', ['simctl', 'install', deviceId, appPath], { cwd: projectRoot, env });
        await runCommand('xcrun', ['simctl', 'launch', deviceId, bundleId], { cwd: projectRoot, env });
        return {
            ok: true,
            projectPath: xcodeProjectPath,
            scheme,
            configuration,
            destination,
            derivedDataPath,
            appPath,
            bundleId,
        };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Failed to build and run iOS app.' };
    }
}
