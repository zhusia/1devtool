"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runProjectBuild = runProjectBuild;
exports.runCli = runCli;
exports.resolveDeployCwd = resolveDeployCwd;
exports.resolveOutputDir = resolveOutputDir;
exports.envVarsToRecord = envVarsToRecord;
exports.redactValue = redactValue;
const child_process_1 = require("child_process");
const path_1 = __importDefault(require("path"));
const env_1 = require("../utils/env");
async function runProjectBuild(buildCommand, cwd, options) {
    const command = buildCommand.trim();
    if (!command)
        return { stdout: '', stderr: '', exitCode: 0 };
    options.onLog?.('system', `$ ${command}\n`);
    return runShellCommand(command, {
        ...options,
        cwd,
    });
}
async function runCli(command, args, options) {
    const printable = [command, ...args.map((arg) => redactValue(arg, options.redact || []))].join(' ');
    options.onLog?.('system', `$ ${printable}\n`);
    return runSpawn(command, args, { ...options, shell: options.shell ?? process.platform === 'win32' });
}
function resolveDeployCwd(projectRoot, deployCwd) {
    const trimmed = deployCwd?.trim();
    if (!trimmed)
        return projectRoot;
    return path_1.default.isAbsolute(trimmed) ? trimmed : path_1.default.resolve(projectRoot, trimmed);
}
function resolveOutputDir(deployCwd, outputDir) {
    const trimmed = outputDir?.trim();
    if (!trimmed)
        return deployCwd;
    return path_1.default.isAbsolute(trimmed) ? trimmed : path_1.default.resolve(deployCwd, trimmed);
}
function envVarsToRecord(envVars) {
    const result = {};
    for (const item of envVars || []) {
        const key = item.key?.trim();
        if (!key)
            continue;
        result[key] = item.value ?? '';
    }
    return result;
}
function runShellCommand(command, options) {
    if (process.platform === 'win32') {
        return runSpawn('cmd.exe', ['/d', '/s', '/c', command], options);
    }
    const shell = process.env.SHELL || '/bin/sh';
    return runSpawn(shell, ['-lc', command], options);
}
function runSpawn(command, args, options) {
    return new Promise((resolve, reject) => {
        let child = null;
        const stdoutChunks = [];
        const stderrChunks = [];
        const redact = options.redact || [];
        const handleAbort = () => {
            if (child && !child.killed) {
                child.kill('SIGTERM');
            }
        };
        try {
            child = (0, child_process_1.spawn)(command, args, {
                cwd: options.cwd,
                env: (0, env_1.getEnrichedEnv)(options.env, { extraPaths: options.extraPaths }),
                windowsHide: true,
                shell: options.shell ?? false,
            });
        }
        catch (error) {
            reject(error);
            return;
        }
        if (options.signal?.aborted) {
            handleAbort();
        }
        options.signal?.addEventListener('abort', handleAbort, { once: true });
        child.stdout.on('data', (chunk) => {
            const text = redactValue(chunk.toString('utf8'), redact);
            stdoutChunks.push(text);
            options.onLog?.('stdout', text);
        });
        child.stderr.on('data', (chunk) => {
            const text = redactValue(chunk.toString('utf8'), redact);
            stderrChunks.push(text);
            options.onLog?.('stderr', text);
        });
        child.on('error', (error) => {
            options.signal?.removeEventListener('abort', handleAbort);
            reject(error);
        });
        child.on('close', (code, signal) => {
            options.signal?.removeEventListener('abort', handleAbort);
            const exitCode = typeof code === 'number' ? code : signal ? 130 : 1;
            resolve({
                stdout: stdoutChunks.join(''),
                stderr: stderrChunks.join(''),
                exitCode,
            });
        });
    });
}
function redactValue(value, secrets) {
    let result = value;
    for (const secret of secrets) {
        const trimmed = secret?.trim();
        if (!trimmed)
            continue;
        result = result.split(trimmed).join('***');
    }
    result = result.replace(/Authorization:\s*Bearer\s+[^\s"']+/gi, 'Authorization: Bearer ***');
    result = result.replace(/(CLOUDFLARE_API_TOKEN|VERCEL_TOKEN|NETLIFY_AUTH_TOKEN|FLY_API_TOKEN|RENDER_API_KEY)=([^\s]+)/gi, '$1=***');
    return result;
}
