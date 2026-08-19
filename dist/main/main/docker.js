"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listContainers = listContainers;
exports.listImages = listImages;
exports.startContainer = startContainer;
exports.stopContainer = stopContainer;
exports.restartContainer = restartContainer;
exports.removeContainer = removeContainer;
exports.removeImage = removeImage;
exports.isDockerAvailable = isDockerAvailable;
exports.inspectContainer = inspectContainer;
exports.getContainerLogs = getContainerLogs;
exports.getContainerStats = getContainerStats;
exports.pauseContainer = pauseContainer;
exports.unpauseContainer = unpauseContainer;
exports.inspectImage = inspectImage;
exports.getImageHistory = getImageHistory;
exports.getContainersUsingImage = getContainersUsingImage;
exports.listVolumes = listVolumes;
exports.inspectVolume = inspectVolume;
exports.removeVolume = removeVolume;
exports.streamContainerLogs = streamContainerLogs;
exports.stopLogStream = stopLogStream;
const child_process_1 = require("child_process");
const util_1 = require("util");
const env_1 = require("./utils/env");
const execPromise = (0, util_1.promisify)(child_process_1.exec);
/**
 * Electron apps launched from Dock/Finder don't inherit the user's shell PATH,
 * so docker (typically at /usr/local/bin/docker) isn't found.
 * Also set DOCKER_HOST for macOS Docker Desktop socket.
 */
function getDockerEnv() {
    const home = process.env.HOME || '';
    const env = (0, env_1.getEnrichedEnv)({}, {
        extraPaths: [
            `${home}/.docker/bin`,
            `${home}/.local/bin`,
        ],
    });
    // Docker Desktop on macOS uses a user-specific socket
    if (process.platform === 'darwin' && !process.env.DOCKER_HOST) {
        env.DOCKER_HOST = `unix://${home}/.docker/run/docker.sock`;
    }
    return env;
}
function execAsync(cmd) {
    return execPromise(cmd, { env: getDockerEnv(), maxBuffer: 10 * 1024 * 1024 });
}
async function listContainers() {
    try {
        const { stdout } = await execAsync('docker ps -a --format "{{.ID}}\\t{{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.State}}\\t{{.Ports}}\\t{{.CreatedAt}}"');
        if (!stdout.trim()) {
            return [];
        }
        return stdout
            .trim()
            .split('\n')
            .map((line) => {
            const [id, name, image, status, state, ports, created] = line.split('\t');
            return {
                id: id || '',
                name: name || '',
                image: image || '',
                status: status || '',
                state: (state || 'created'),
                ports: ports || '',
                created: created || '',
            };
        });
    }
    catch (error) {
        // Docker not installed or not running
        console.error('Failed to list containers:', error);
        return [];
    }
}
async function listImages() {
    try {
        const { stdout } = await execAsync('docker images --format "{{.ID}}\\t{{.Repository}}\\t{{.Tag}}\\t{{.Size}}\\t{{.CreatedAt}}"');
        if (!stdout.trim()) {
            return [];
        }
        return stdout
            .trim()
            .split('\n')
            .map((line) => {
            const [id, repository, tag, size, created] = line.split('\t');
            return {
                id: id || '',
                repository: repository || '',
                tag: tag || '',
                size: size || '',
                created: created || '',
            };
        });
    }
    catch (error) {
        console.error('Failed to list images:', error);
        return [];
    }
}
/** Docker IDs are hex strings (sha256) — reject anything else to prevent command injection */
function sanitizeId(id) {
    const clean = id.replace(/[^a-zA-Z0-9:._-]/g, '');
    if (!clean)
        throw new Error('Invalid Docker ID');
    return clean;
}
async function startContainer(containerId) {
    try {
        await execAsync(`docker start ${sanitizeId(containerId)}`);
        return { ok: true };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Failed to start container' };
    }
}
async function stopContainer(containerId) {
    try {
        await execAsync(`docker stop ${sanitizeId(containerId)}`);
        return { ok: true };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Failed to stop container' };
    }
}
async function restartContainer(containerId) {
    try {
        await execAsync(`docker restart ${sanitizeId(containerId)}`);
        return { ok: true };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Failed to restart container' };
    }
}
async function removeContainer(containerId) {
    try {
        await execAsync(`docker rm -f ${sanitizeId(containerId)}`);
        return { ok: true };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Failed to remove container' };
    }
}
async function removeImage(imageId) {
    try {
        await execAsync(`docker rmi ${sanitizeId(imageId)}`);
        return { ok: true };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Failed to remove image' };
    }
}
async function isDockerAvailable() {
    try {
        await execAsync('docker info');
        return { available: true };
    }
    catch (err) {
        const e = err;
        const stderr = (e.stderr || '').trim();
        const message = (e.message || '').trim();
        const text = stderr || message || 'docker info failed';
        // CLI not found: ENOENT on POSIX, 'is not recognized' on Windows cmd.exe
        const cliNotFound = e.code === 'ENOENT' ||
            /is not recognized as an internal or external command/i.test(text) ||
            /command not found/i.test(text) ||
            /'docker' is not recognized/i.test(text);
        // Daemon unreachable: named pipe / unix socket connection failure
        const daemonDown = /Cannot connect to the Docker daemon/i.test(text) ||
            /error during connect/i.test(text) ||
            /open \/\/\.\/pipe\/docker_engine/i.test(text) ||
            /The system cannot find the file specified/i.test(text);
        const reason = cliNotFound
            ? 'cli-not-found'
            : daemonDown
                ? 'daemon-not-running'
                : 'unknown';
        return { available: false, error: text, reason };
    }
}
// --- New helper functions ---
function parseDockerSize(sizeStr) {
    const match = sizeStr.trim().match(/^([\d.]+)\s*([A-Za-z]+)$/);
    if (!match)
        return 0;
    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    const multipliers = {
        b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4,
        kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4,
    };
    return value * (multipliers[unit] || 1);
}
function parseLabels(labelsStr) {
    if (!labelsStr)
        return {};
    const labels = {};
    labelsStr.split(',').forEach(pair => {
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) {
            labels[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
        }
    });
    return labels;
}
// --- New exported functions ---
async function inspectContainer(containerId) {
    const id = sanitizeId(containerId);
    const { stdout } = await execAsync(`docker inspect ${id}`);
    const data = JSON.parse(stdout)[0];
    const portBindings = data.HostConfig?.PortBindings || {};
    const ports = {};
    for (const [key, val] of Object.entries(portBindings)) {
        ports[key] = val ? val.map(b => ({
            hostIp: b.HostIp || '0.0.0.0',
            hostPort: b.HostPort || '',
        })) : null;
    }
    const networks = {};
    const netData = data.NetworkSettings?.Networks || {};
    for (const [name, net] of Object.entries(netData)) {
        const n = net;
        networks[name] = {
            ipAddress: n.IPAddress || '',
            gateway: n.Gateway || '',
            macAddress: n.MacAddress || '',
        };
    }
    return {
        id: data.Id || '',
        name: (data.Name || '').replace(/^\//, ''),
        state: {
            status: data.State?.Status || '',
            running: data.State?.Running || false,
            paused: data.State?.Paused || false,
            startedAt: data.State?.StartedAt || '',
            finishedAt: data.State?.FinishedAt || '',
            exitCode: data.State?.ExitCode ?? 0,
            pid: data.State?.Pid ?? 0,
        },
        config: {
            image: data.Config?.Image || '',
            hostname: data.Config?.Hostname || '',
            cmd: data.Config?.Cmd || [],
            entrypoint: data.Config?.Entrypoint || [],
            workingDir: data.Config?.WorkingDir || '',
            labels: data.Config?.Labels || {},
        },
        env: data.Config?.Env || [],
        network: { ports, networks },
        mounts: (data.Mounts || []).map((m) => ({
            type: m.Type || '',
            source: m.Source || '',
            destination: m.Destination || '',
            mode: m.Mode || '',
            rw: m.RW !== false,
        })),
        rawJson: data,
    };
}
async function getContainerLogs(containerId, tail = 500) {
    const id = sanitizeId(containerId);
    try {
        const { stdout, stderr } = await execAsync(`docker logs --tail ${tail} --timestamps ${id}`);
        return stdout + stderr;
    }
    catch (error) {
        if (error instanceof Error && 'stderr' in error) {
            return error.stderr || '';
        }
        return '';
    }
}
async function getContainerStats(containerId) {
    const id = sanitizeId(containerId);
    const { stdout } = await execAsync(`docker stats ${id} --no-stream --format "{{json .}}"`);
    const data = JSON.parse(stdout.trim());
    // Parse CPU percentage
    const cpuPercent = parseFloat(data.CPUPerc?.replace('%', '') || '0');
    // Parse memory
    const memParts = (data.MemUsage || '').split(' / ');
    const memoryUsage = parseDockerSize(memParts[0] || '0B');
    const memoryLimit = parseDockerSize(memParts[1] || '0B');
    const memoryPercent = parseFloat(data.MemPerc?.replace('%', '') || '0');
    // Parse network I/O
    const netParts = (data.NetIO || '').split(' / ');
    const netInput = parseDockerSize(netParts[0] || '0B');
    const netOutput = parseDockerSize(netParts[1] || '0B');
    // Parse block I/O
    const blockParts = (data.BlockIO || '').split(' / ');
    const blockRead = parseDockerSize(blockParts[0] || '0B');
    const blockWrite = parseDockerSize(blockParts[1] || '0B');
    return {
        cpuPercent,
        memoryUsage,
        memoryLimit,
        memoryPercent,
        netInput,
        netOutput,
        blockRead,
        blockWrite,
        pids: parseInt(data.PIDs || '0', 10),
    };
}
async function pauseContainer(containerId) {
    try {
        await execAsync(`docker pause ${sanitizeId(containerId)}`);
        return { ok: true };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Failed to pause container' };
    }
}
async function unpauseContainer(containerId) {
    try {
        await execAsync(`docker unpause ${sanitizeId(containerId)}`);
        return { ok: true };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Failed to unpause container' };
    }
}
async function inspectImage(imageId) {
    const id = sanitizeId(imageId);
    const { stdout } = await execAsync(`docker inspect ${id}`);
    const data = JSON.parse(stdout)[0];
    const exposedPorts = Object.keys(data.Config?.ExposedPorts || {});
    return {
        id: data.Id || '',
        tags: data.RepoTags || [],
        created: data.Created || '',
        size: data.Size || 0,
        config: {
            cmd: data.Config?.Cmd || [],
            entrypoint: data.Config?.Entrypoint || [],
            env: data.Config?.Env || [],
            workingDir: data.Config?.WorkingDir || '',
            exposedPorts,
            labels: data.Config?.Labels || {},
        },
        rootFs: {
            type: data.RootFS?.Type || '',
            layers: data.RootFS?.Layers || [],
        },
        rawJson: data,
    };
}
async function getImageHistory(imageId) {
    const id = sanitizeId(imageId);
    const { stdout } = await execAsync(`docker history ${id} --no-trunc --format "{{json .}}"`);
    if (!stdout.trim())
        return [];
    return stdout.trim().split('\n').map(line => {
        const data = JSON.parse(line);
        return {
            id: data.ID || '',
            createdBy: data.CreatedBy || '',
            size: typeof data.Size === 'number' ? data.Size : parseDockerSize(data.Size || '0B'),
            created: data.CreatedAt || data.CreatedSince || '',
            comment: data.Comment || '',
        };
    });
}
async function getContainersUsingImage(imageId) {
    const id = sanitizeId(imageId);
    try {
        const { stdout } = await execAsync(`docker ps -a --filter "ancestor=${id}" --format "{{.Names}}"`);
        if (!stdout.trim())
            return [];
        return stdout.trim().split('\n');
    }
    catch {
        return [];
    }
}
async function listVolumes() {
    try {
        const { stdout } = await execAsync('docker volume ls --format "{{json .}}"');
        if (!stdout.trim())
            return [];
        return stdout.trim().split('\n').map(line => {
            const data = JSON.parse(line);
            return {
                name: data.Name || '',
                driver: data.Driver || '',
                mountpoint: data.Mountpoint || '',
                created: data.CreatedAt || '',
                scope: data.Scope || '',
                labels: parseLabels(data.Labels || ''),
            };
        });
    }
    catch (error) {
        console.error('Failed to list volumes:', error);
        return [];
    }
}
async function inspectVolume(name) {
    const safeName = sanitizeId(name);
    const { stdout } = await execAsync(`docker volume inspect ${safeName}`);
    const data = JSON.parse(stdout)[0];
    // Find containers using this volume
    let usedByContainers = [];
    try {
        const { stdout: psOut } = await execAsync(`docker ps -a --filter "volume=${safeName}" --format "{{.Names}}"`);
        if (psOut.trim()) {
            usedByContainers = psOut.trim().split('\n');
        }
    }
    catch { /* ignore */ }
    return {
        name: data.Name || '',
        driver: data.Driver || '',
        mountpoint: data.Mountpoint || '',
        created: data.CreatedAt || '',
        scope: data.Scope || '',
        labels: data.Labels || {},
        options: data.Options || {},
        usedByContainers,
        rawJson: data,
    };
}
async function removeVolume(name) {
    try {
        await execAsync(`docker volume rm ${sanitizeId(name)}`);
        return { ok: true };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Failed to remove volume' };
    }
}
// --- Log streaming ---
const activeLogStreams = new Map();
function streamContainerLogs(containerId, onData, onError) {
    const id = sanitizeId(containerId);
    // Stop existing stream for this container
    const existing = activeLogStreams.get(id);
    if (existing) {
        existing.kill();
        activeLogStreams.delete(id);
    }
    const child = (0, child_process_1.spawn)('docker', ['logs', '--follow', '--tail', '200', '--timestamps', id], {
        env: getDockerEnv(),
    });
    activeLogStreams.set(id, child);
    child.stdout?.on('data', (data) => onData(data.toString()));
    child.stderr?.on('data', (data) => onData(data.toString()));
    child.on('error', (err) => onError(err.message));
    child.on('close', () => {
        activeLogStreams.delete(id);
    });
    return () => {
        child.kill();
        activeLogStreams.delete(id);
    };
}
function stopLogStream(containerId) {
    const id = sanitizeId(containerId);
    const child = activeLogStreams.get(id);
    if (child) {
        child.kill();
        activeLogStreams.delete(id);
    }
}
