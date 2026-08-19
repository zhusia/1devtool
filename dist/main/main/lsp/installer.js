"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectLanguageStatus = detectLanguageStatus;
exports.detectAllLanguageStatuses = detectAllLanguageStatuses;
exports.installLanguage = installLanguage;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const util_1 = require("util");
const env_1 = require("../utils/env");
const registry_1 = require("./registry");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const DOTNET_SDK_DOWNLOAD_URL = 'https://dotnet.microsoft.com/download';
async function runProcess(command, args = [], options = {}) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)(command, args, {
            env: (0, env_1.getEnrichedEnv)(),
            shell: options.shell ?? (process.platform === 'win32'),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timeout = null;
        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', (error) => {
            if (settled)
                return;
            settled = true;
            if (timeout)
                clearTimeout(timeout);
            reject(error);
        });
        child.on('close', (code) => {
            if (settled)
                return;
            settled = true;
            if (timeout)
                clearTimeout(timeout);
            resolve({ code: code ?? 1, stdout, stderr });
        });
        if (options.timeoutMs && options.timeoutMs > 0) {
            timeout = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                child.kill();
                reject(new Error(`Command timed out after ${options.timeoutMs}ms`));
            }, options.timeoutMs);
        }
    });
}
async function resolveCommandOnPath(command) {
    const resolver = process.platform === 'win32' ? 'where' : 'which';
    try {
        const { stdout } = await execFileAsync(resolver, [command], {
            env: (0, env_1.getEnrichedEnv)(),
            timeout: 10000,
            maxBuffer: 512 * 1024,
        });
        const resolved = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
        return resolved ?? null;
    }
    catch {
        return null;
    }
}
async function validateBinary(binaryPath, detectArgs) {
    if (detectArgs.length === 0) {
        try {
            const stats = await fs_1.default.promises.stat(binaryPath);
            if (!stats.isFile()) {
                return { ok: false, version: null };
            }
            await fs_1.default.promises.access(binaryPath, process.platform === 'win32' ? fs_1.default.constants.F_OK : fs_1.default.constants.X_OK);
            return { ok: true, version: null };
        }
        catch {
            return { ok: false, version: null };
        }
    }
    try {
        const result = await runProcess(binaryPath, detectArgs, { timeoutMs: 10000 });
        if (result.code !== 0) {
            return { ok: false, version: null };
        }
        const versionOutput = `${result.stdout}\n${result.stderr}`.trim();
        return {
            ok: true,
            version: versionOutput.split('\n').find(Boolean) ?? null,
        };
    }
    catch {
        return { ok: false, version: null };
    }
}
async function resolvePythonScriptsBinary(binaryName) {
    const pythonCommands = process.platform === 'win32'
        ? [
            { command: 'py', argsPrefix: ['-3'] },
            { command: 'python', argsPrefix: [] },
            { command: 'python3', argsPrefix: [] },
        ]
        : [
            { command: 'python3', argsPrefix: [] },
            { command: 'python', argsPrefix: [] },
        ];
    const scriptDirectoryProbe = [
        'import os, site, sysconfig',
        'user_base = getattr(site, "USER_BASE", None)',
        'print(sysconfig.get_path("scripts") or "")',
        'print(os.path.join(user_base, "Scripts" if os.name == "nt" else "bin") if user_base else "")',
    ].join('; ');
    for (const pythonCommand of pythonCommands) {
        const pythonPath = await resolveCommandOnPath(pythonCommand.command);
        if (!pythonPath) {
            continue;
        }
        try {
            const result = await runProcess(pythonPath, [...pythonCommand.argsPrefix, '-c', scriptDirectoryProbe], { shell: false, timeoutMs: 10000 });
            if (result.code !== 0) {
                continue;
            }
            const directories = [...new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
            const executableNames = process.platform === 'win32'
                ? [binaryName, `${binaryName}.exe`, `${binaryName}.cmd`, `${binaryName}.bat`]
                : [binaryName];
            for (const directory of directories) {
                for (const executableName of executableNames) {
                    const candidate = path_1.default.join(directory, executableName);
                    const validated = await validateBinary(candidate, []);
                    if (validated.ok) {
                        return candidate;
                    }
                }
            }
        }
        catch {
            // Try the next available Python launcher.
        }
    }
    return null;
}
async function hasDotnetSdk(dotnetPath) {
    try {
        const result = await runProcess(dotnetPath, ['--list-sdks'], { shell: false, timeoutMs: 10000 });
        return result.code === 0 && result.stdout.trim().length > 0;
    }
    catch {
        return false;
    }
}
async function getDotnetSdkStatus() {
    const dotnetPath = await resolveCommandOnPath('dotnet');
    if (!dotnetPath) {
        return {
            ok: false,
            message: `.NET SDK not found. Install the .NET SDK from ${DOTNET_SDK_DOWNLOAD_URL}, then rescan and install csharp-ls.`,
        };
    }
    if (!(await hasDotnetSdk(dotnetPath))) {
        return {
            ok: false,
            message: `.NET runtime detected at ${dotnetPath}, but no .NET SDK was found. Install the .NET SDK from ${DOTNET_SDK_DOWNLOAD_URL}, then rescan and install csharp-ls.`,
        };
    }
    return { ok: true, dotnetPath };
}
async function detectLanguageStatus(languageId, preferences) {
    const definition = (0, registry_1.getLspLanguageDefinition)(languageId);
    if (!definition) {
        throw new Error(`Unknown LSP language: ${languageId}`);
    }
    const enabled = preferences.enabled.includes(languageId);
    const configuredPath = preferences.installPaths[languageId];
    if (configuredPath && fs_1.default.existsSync(configuredPath)) {
        const validated = await validateBinary(configuredPath, definition.detectArgs);
        if (validated.ok) {
            return {
                languageId,
                detected: true,
                enabled,
                binaryPath: configuredPath,
                source: 'configured',
                version: validated.version,
                message: `Manual path configured: ${configuredPath}`,
            };
        }
    }
    let systemPath = await resolveCommandOnPath(definition.serverBinary);
    if (!systemPath && languageId === 'python') {
        // `python -m pip` can work even when the Python scripts directory is not
        // inherited by the Electron app. Discover that directory through the same
        // interpreter so a successful quick install is immediately detectable.
        systemPath = await resolvePythonScriptsBinary(definition.serverBinary);
    }
    if (systemPath) {
        const validated = await validateBinary(systemPath, definition.detectArgs);
        if (validated.ok) {
            return {
                languageId,
                detected: true,
                enabled,
                binaryPath: systemPath,
                source: 'system',
                version: validated.version,
                message: `System install detected: ${systemPath}`,
            };
        }
    }
    if (languageId === 'csharp') {
        const dotnetStatus = await getDotnetSdkStatus();
        if (!dotnetStatus.ok) {
            return {
                languageId,
                detected: false,
                enabled,
                binaryPath: null,
                source: 'missing',
                version: null,
                message: dotnetStatus.message,
            };
        }
    }
    return {
        languageId,
        detected: false,
        enabled,
        binaryPath: null,
        source: 'missing',
        version: null,
        message: definition.install.systemHint ?? 'Code Intelligence engine not detected',
    };
}
async function detectAllLanguageStatuses(preferences) {
    return Promise.all((0, registry_1.getLspLanguageRegistry)().map((language) => detectLanguageStatus(language.id, preferences)));
}
async function installLanguage(languageId, preferences) {
    const definition = (0, registry_1.getLspLanguageDefinition)(languageId);
    if (!definition) {
        return { ok: false, languageId, error: `Unknown LSP language: ${languageId}` };
    }
    const command = definition.install.command?.trim();
    if (!command) {
        return {
            ok: false,
            languageId,
            error: 'Quick install is not available for this language on this platform.',
        };
    }
    if (languageId === 'csharp') {
        return installCSharpLanguageServer(preferences);
    }
    try {
        const result = await runProcess(command, [], { shell: true, timeoutMs: 15 * 60 * 1000 });
        if (result.code !== 0) {
            return {
                ok: false,
                languageId,
                error: result.stderr.trim() || result.stdout.trim() || `Install command exited with code ${result.code}`,
                output: `${result.stdout}\n${result.stderr}`.trim(),
            };
        }
        const status = await detectLanguageStatus(languageId, preferences);
        return {
            ok: status.detected,
            languageId,
            status,
            output: `${result.stdout}\n${result.stderr}`.trim(),
            error: status.detected ? undefined : 'Install command completed but the Code Intelligence engine is still missing.',
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            ok: false,
            languageId,
            error: message,
            output: message,
        };
    }
}
async function installCSharpLanguageServer(preferences) {
    const languageId = 'csharp';
    const dotnetStatus = await getDotnetSdkStatus();
    if (!dotnetStatus.ok) {
        return {
            ok: false,
            languageId,
            error: dotnetStatus.message,
            output: dotnetStatus.message,
        };
    }
    try {
        let result = await runProcess(dotnetStatus.dotnetPath, ['tool', 'install', '--global', 'csharp-ls'], { shell: false, timeoutMs: 15 * 60 * 1000 });
        let output = `${result.stdout}\n${result.stderr}`.trim();
        if (result.code !== 0 && /already installed/i.test(output)) {
            result = await runProcess(dotnetStatus.dotnetPath, ['tool', 'update', '--global', 'csharp-ls'], { shell: false, timeoutMs: 15 * 60 * 1000 });
            output = `${output}\n${result.stdout}\n${result.stderr}`.trim();
        }
        if (result.code !== 0) {
            return {
                ok: false,
                languageId,
                error: result.stderr.trim() || result.stdout.trim() || `Install command exited with code ${result.code}`,
                output,
            };
        }
        const status = await detectLanguageStatus(languageId, preferences);
        return {
            ok: status.detected,
            languageId,
            status,
            output,
            error: status.detected
                ? undefined
                : 'csharp-ls installed, but 1DevTool could not find it. Make sure your .NET global tools directory is available, then rescan.',
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            ok: false,
            languageId,
            error: message,
            output: message,
        };
    }
}
