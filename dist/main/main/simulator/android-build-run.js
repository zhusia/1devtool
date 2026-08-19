"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildAndRunAndroidApp = buildAndRunAndroidApp;
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
    '.next',
    'androidTest',
    'build',
    'dist',
    'node_modules',
    'out',
    'Pods',
]);
async function detectJavaHome() {
    const directCandidates = [
        process.env.JAVA_HOME,
        '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
        '/Applications/Android Studio.app/Contents/jre/Contents/Home',
        '/Applications/Android Studio Preview.app/Contents/jbr/Contents/Home',
        '/Applications/Android Studio Preview.app/Contents/jre/Contents/Home',
    ].filter(Boolean);
    for (const candidate of directCandidates) {
        if (await pathExists(path_1.default.join(candidate, 'bin', 'java'))) {
            return candidate;
        }
    }
    try {
        const { stdout } = await execFileAsync('/usr/libexec/java_home', [], {
            timeout: 3000,
            maxBuffer: 1024 * 1024,
        });
        const javaHome = stdout.trim();
        if (javaHome && await pathExists(path_1.default.join(javaHome, 'bin', 'java'))) {
            return javaHome;
        }
    }
    catch {
        // Ignore and try filesystem candidates below.
    }
    const roots = [
        '/Library/Java/JavaVirtualMachines',
        path_1.default.join(process.env.HOME || '', 'Library', 'Java', 'JavaVirtualMachines'),
    ];
    for (const root of roots) {
        if (!root)
            continue;
        let entries;
        try {
            entries = await (0, promises_1.readdir)(root, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const candidate = path_1.default.join(root, entry.name, 'Contents', 'Home');
            if (await pathExists(path_1.default.join(candidate, 'bin', 'java'))) {
                return candidate;
            }
        }
    }
    return null;
}
async function buildEnv() {
    const home = process.env.HOME || '';
    const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path_1.default.join(home, 'Library', 'Android', 'sdk');
    const javaHome = await detectJavaHome();
    return (0, env_1.getEnrichedEnv)({
        ANDROID_HOME: androidHome,
        ANDROID_SDK_ROOT: androidHome,
        ...(javaHome ? { JAVA_HOME: javaHome, JDK_HOME: javaHome } : {}),
    }, {
        extraPaths: [
            ...(javaHome ? [path_1.default.join(javaHome, 'bin')] : []),
            path_1.default.join(androidHome, 'emulator'),
            path_1.default.join(androidHome, 'platform-tools'),
            path_1.default.join(androidHome, 'cmdline-tools', 'latest', 'bin'),
            path_1.default.join(androidHome, 'tools'),
            path_1.default.join(androidHome, 'tools', 'bin'),
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
function resolveUserPath(rootPath, userPath) {
    const trimmed = userPath?.trim();
    if (!trimmed)
        return null;
    const resolved = path_1.default.isAbsolute(trimmed) ? trimmed : path_1.default.resolve(rootPath, trimmed);
    return path_1.default.basename(resolved) === 'gradlew' ? path_1.default.dirname(resolved) : resolved;
}
async function findGradleProjects(rootPath, maxDepth = 4) {
    const results = [];
    async function walk(dir, depth) {
        let entries;
        try {
            entries = await (0, promises_1.readdir)(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        if (entries.some((entry) => entry.isFile() && entry.name === 'gradlew')) {
            results.push(dir);
            return;
        }
        if (depth >= maxDepth)
            return;
        for (const entry of entries) {
            if (!entry.isDirectory() || SKIP_DIRS.has(entry.name))
                continue;
            await walk(path_1.default.join(dir, entry.name), depth + 1);
        }
    }
    await walk(rootPath, 0);
    return results.sort((a, b) => {
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
async function findTextFile(rootPath, relativeCandidates, regex) {
    for (const candidate of relativeCandidates) {
        const filePath = path_1.default.join(rootPath, candidate);
        if (!await pathExists(filePath))
            continue;
        try {
            const content = await (0, promises_1.readFile)(filePath, 'utf8');
            const match = content.match(regex);
            if (match?.[1])
                return match[1].trim();
        }
        catch {
            // ignore
        }
    }
    return null;
}
async function detectPackageName(projectDir) {
    return findTextFile(projectDir, [
        path_1.default.join('app', 'build.gradle'),
        path_1.default.join('app', 'build.gradle.kts'),
        path_1.default.join('app', 'src', 'main', 'AndroidManifest.xml'),
    ], /(?:applicationId|package)\s*[= ]\s*["']([^"']+)["']/);
}
async function detectLaunchActivity(projectDir) {
    const manifestPath = path_1.default.join(projectDir, 'app', 'src', 'main', 'AndroidManifest.xml');
    if (!await pathExists(manifestPath))
        return null;
    try {
        const content = await (0, promises_1.readFile)(manifestPath, 'utf8');
        const activityMatch = content.match(/<activity[^>]*android:name\s*=\s*"([^"]+)"[\s\S]*?<intent-filter>[\s\S]*?android\.intent\.action\.MAIN[\s\S]*?android\.intent\.category\.LAUNCHER[\s\S]*?<\/intent-filter>[\s\S]*?<\/activity>/m);
        return activityMatch?.[1]?.trim() || null;
    }
    catch {
        return null;
    }
}
function normalizeComponentName(packageName, activityName) {
    const trimmed = activityName.trim();
    if (!trimmed)
        return packageName;
    if (trimmed.includes('/'))
        return trimmed;
    if (trimmed.startsWith('.'))
        return `${packageName}/${trimmed}`;
    if (trimmed.includes('.'))
        return `${packageName}/${trimmed}`;
    return `${packageName}/.${trimmed}`;
}
async function getTargetDeviceSerial(deviceId, env) {
    const { stdout } = await execFileAsync('adb', ['devices'], { timeout: 5000, env, maxBuffer: 1024 * 1024 });
    const deviceLines = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && line.includes('\tdevice'));
    const serials = deviceLines.map((line) => line.split('\t')[0]).filter(Boolean);
    if (serials.length === 0)
        return null;
    for (const serial of serials) {
        if (!serial.startsWith('emulator-'))
            continue;
        try {
            const { stdout: avdOut } = await execFileAsync('adb', ['-s', serial, 'emu', 'avd', 'name'], {
                timeout: 5000,
                env,
                maxBuffer: 1024 * 1024,
            });
            if (avdOut.trim().split('\n')[0] === deviceId)
                return serial;
        }
        catch {
            // ignore and keep trying
        }
    }
    const emulatorSerials = serials.filter((serial) => serial.startsWith('emulator-'));
    return emulatorSerials.length === 1 ? emulatorSerials[0] : null;
}
async function buildAndRunAndroidApp(projectRoot, deviceId, options = {}) {
    if (!projectRoot || !await pathExists(projectRoot)) {
        return { ok: false, error: 'The active project path is not available on disk.' };
    }
    if (!deviceId) {
        return { ok: false, error: 'Select an Android emulator before building.' };
    }
    try {
        const env = await buildEnv();
        if (!env.JAVA_HOME) {
            return {
                ok: false,
                error: 'Java runtime not found. Install a JDK or use the Android Studio bundled runtime.',
            };
        }
        const requestedProjectPath = resolveUserPath(projectRoot, options.projectPath);
        let androidProjectPath;
        if (requestedProjectPath) {
            if (!await pathExists(requestedProjectPath)) {
                return { ok: false, error: `Android project not found: ${requestedProjectPath}` };
            }
            androidProjectPath = requestedProjectPath;
        }
        else {
            const gradleProjects = await findGradleProjects(projectRoot);
            if (gradleProjects.length === 0) {
                return { ok: false, error: `No Gradle Android project was found under ${projectRoot}.` };
            }
            androidProjectPath = gradleProjects[0];
        }
        const gradlewPath = path_1.default.join(androidProjectPath, 'gradlew');
        if (!await pathExists(gradlewPath)) {
            return { ok: false, error: `Gradle wrapper not found: ${gradlewPath}` };
        }
        const assembleTask = options.assembleTask?.trim() || 'assembleDebug';
        const installTask = options.installTask?.trim() || 'installDebug';
        await runCommand('bash', [gradlewPath, assembleTask], { cwd: androidProjectPath, env });
        const deviceSerial = await getTargetDeviceSerial(deviceId, env);
        if (!deviceSerial) {
            return {
                ok: false,
                error: `The selected emulator "${deviceId}" is not connected through adb. Boot it first, then retry Build & Run.`,
            };
        }
        await runCommand('bash', [gradlewPath, installTask, `-Pandroid.injected.device.serial=${deviceSerial}`], {
            cwd: androidProjectPath,
            env,
        });
        const packageName = options.packageName?.trim() || await detectPackageName(androidProjectPath);
        if (!packageName) {
            return {
                ok: false,
                error: 'Build and install succeeded, but the Android package name could not be detected. Enter it explicitly before launching.',
            };
        }
        const activityName = options.activityName?.trim() || await detectLaunchActivity(androidProjectPath) || undefined;
        if (activityName) {
            await runCommand('adb', ['-s', deviceSerial, 'shell', 'am', 'start', '-n', normalizeComponentName(packageName, activityName)], {
                cwd: androidProjectPath,
                env,
            });
        }
        else {
            await runCommand('adb', ['-s', deviceSerial, 'shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], {
                cwd: androidProjectPath,
                env,
            });
        }
        return {
            ok: true,
            projectPath: androidProjectPath,
            assembleTask,
            installTask,
            packageName,
            activityName,
            deviceSerial,
        };
    }
    catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Android build and run failed.',
        };
    }
}
