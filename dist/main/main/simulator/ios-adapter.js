"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.iOSSimulatorAdapter = void 0;
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const http_1 = require("http");
const os_1 = require("os");
const path_1 = __importDefault(require("path"));
const util_1 = require("util");
const electron_1 = require("electron");
const idb_1 = require("./idb");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
let focusGuardUntil = 0;
let focusGuardTimer = null;
// Simulator.app can self-activate after it receives the posted CGEvent. Keep a short
// reclaim window open around mobile input so the main Electron app remains frontmost.
function scheduleFocusReclaim(durationMs = 1500) {
    focusGuardUntil = Math.max(focusGuardUntil, Date.now() + durationMs);
    const win = electron_1.BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    const reclaim = () => {
        try {
            electron_1.app.focus({ steal: true });
            if (win && !win.isDestroyed())
                win.focus();
        }
        catch {
            // ignore
        }
    };
    reclaim();
    if (focusGuardTimer)
        return;
    focusGuardTimer = setInterval(() => {
        if (Date.now() > focusGuardUntil) {
            if (focusGuardTimer)
                clearInterval(focusGuardTimer);
            focusGuardTimer = null;
            return;
        }
        reclaim();
    }, 80);
}
function parseSimulatorWindow(stdout) {
    const parts = stdout.trim().split(',');
    if (parts.length < 4 || parts[0] === 'not_found')
        return null;
    const [x, y, width, height] = parts.slice(0, 4).map((value) => Number.parseInt(value, 10));
    if ([x, y, width, height].some((value) => Number.isNaN(value)))
        return null;
    return { x, y, width, height };
}
function intersectsDisplay(window) {
    if (window.width <= 64 || window.height <= 64)
        return false;
    return electron_1.screen.getAllDisplays().some((display) => {
        const bounds = display.bounds;
        const intersectionWidth = Math.max(0, Math.min(window.x + window.width, bounds.x + bounds.width) - Math.max(window.x, bounds.x));
        const intersectionHeight = Math.max(0, Math.min(window.y + window.height, bounds.y + bounds.height) - Math.max(window.y, bounds.y));
        return intersectionWidth >= Math.min(96, window.width * 0.25)
            && intersectionHeight >= Math.min(96, window.height * 0.25);
    });
}
function restorePosition() {
    const primary = electron_1.screen.getPrimaryDisplay();
    const area = primary.workArea;
    return {
        x: Math.round(area.x + Math.min(96, Math.max(24, area.width * 0.06))),
        y: Math.round(area.y + Math.min(96, Math.max(24, area.height * 0.06))),
    };
}
function getWDAHost() {
    return (process.env.ONEDEVTOOL_WDA_HOST || process.env.SIMULATOR_WDA_HOST || 'http://127.0.0.1:8100').replace(/\/$/, '');
}
function getWDAPort(host) {
    try {
        const url = new URL(host);
        return url.port || (url.protocol === 'https:' ? '443' : '80');
    }
    catch {
        return '8100';
    }
}
function parsePngSize(buffer) {
    if (buffer.byteLength < 24)
        return null;
    if (buffer.readUInt32BE(0) !== 0x89504e47
        || buffer.readUInt32BE(4) !== 0x0d0a1a0a
        || buffer.toString('ascii', 12, 16) !== 'IHDR') {
        return null;
    }
    return {
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20),
    };
}
class iOSSimulatorAdapter {
    streamServers = new Map();
    wdaSessions = new Map();
    wdaHost = getWDAHost();
    wdaProcess = null;
    wdaStarting = null;
    async detect() {
        try {
            await execFileAsync('xcrun', ['simctl', 'list', 'devices', '--json'], {
                timeout: 5000,
            });
            return { available: true };
        }
        catch {
            return { available: false, reason: 'Xcode and Simulator are required. Install Xcode from the App Store.' };
        }
    }
    async list() {
        const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', '--json'], {
            maxBuffer: 10 * 1024 * 1024,
        });
        const data = JSON.parse(stdout);
        const devices = [];
        for (const [runtime, deviceList] of Object.entries(data.devices)) {
            const runtimeName = runtime
                .replace('com.apple.CoreSimulator.SimRuntime.', '')
                .replace(/-/g, ' ')
                .replace(/(\d+)\s/, '$1.');
            for (const device of deviceList) {
                if (!device.isAvailable)
                    continue;
                devices.push({
                    id: device.udid,
                    name: device.name,
                    platform: 'ios',
                    runtime: runtimeName,
                    state: device.state === 'Booted' ? 'booted' : 'shutdown',
                });
            }
        }
        return devices;
    }
    async boot(deviceId) {
        try {
            await execFileAsync('xcrun', ['simctl', 'boot', deviceId], { timeout: 30000 });
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.includes('current state: Booted'))
                return; // already booted
            throw new Error(`Failed to boot simulator: ${msg}`);
        }
    }
    async shutdown(deviceId) {
        try {
            await execFileAsync('xcrun', ['simctl', 'shutdown', deviceId], { timeout: 10000 });
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.includes('current state: Shutdown'))
                return; // already shutdown
            throw new Error(`Failed to shutdown simulator: ${msg}`);
        }
    }
    async install(deviceId, appPath) {
        try {
            await execFileAsync('xcrun', ['simctl', 'install', deviceId, appPath], { timeout: 60000 });
        }
        catch (error) {
            throw new Error(`Failed to install app: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async uninstall(deviceId, bundleId) {
        try {
            await execFileAsync('xcrun', ['simctl', 'uninstall', deviceId, bundleId], { timeout: 10000 });
        }
        catch (error) {
            throw new Error(`Failed to uninstall app: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async openUrl(deviceId, url) {
        await execFileAsync('xcrun', ['simctl', 'openurl', deviceId, url], { timeout: 10000 });
    }
    // Cached screenshot dimensions for coordinate normalization
    screenshotDimensions = new Map();
    setScreenshotDimensions(deviceId, width, height) {
        this.screenshotDimensions.set(deviceId, { width, height });
    }
    simInputPath = null;
    getSimInputPath() {
        if (this.simInputPath)
            return this.simInputPath;
        const path = require('path');
        const fs = require('fs');
        // Try multiple locations
        const candidates = [
            path.join(__dirname, '..', '..', '..', 'src', 'main', 'simulator', 'sim-input'),
            path.join(__dirname, 'sim-input'),
            path.resolve('src', 'main', 'simulator', 'sim-input'),
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) {
                console.log('[ios-input] Found sim-input at:', p);
                this.simInputPath = p;
                return p;
            }
        }
        console.error('[ios-input] sim-input binary NOT FOUND. Tried:', candidates);
        return candidates[0]; // will fail with a clear error
    }
    async sendTap(deviceId, x, y) {
        this.lastInputDeviceId = deviceId;
        const point = this.toNormalizedPoint(deviceId, x, y);
        if (await this.sendWDATap(deviceId, point.x, point.y))
            return;
        await this.sendNormalizedTap(point.x, point.y);
    }
    async sendText(_deviceId, _text) {
        // Keyboard goes directly to the Simulator window (anchored mode)
    }
    async sendSwipe(deviceId, x1, y1, x2, y2) {
        this.lastInputDeviceId = deviceId;
        const start = this.toNormalizedPoint(deviceId, x1, y1);
        const end = this.toNormalizedPoint(deviceId, x2, y2);
        if (await this.sendWDASwipe(deviceId, start.x, start.y, end.x, end.y))
            return;
        await this.sendNormalizedSwipe(start.x, start.y, end.x, end.y);
    }
    // ── Anchor mode: position the real Simulator window over the panel ──
    async anchorWindow(x, y) {
        const binPath = this.getSimInputPath();
        try {
            // First open Simulator.app so the device window appears
            const { execFile: ef } = require('child_process');
            const { promisify: p } = require('util');
            const execAsync = p(ef);
            await execAsync('open', ['-a', 'Simulator'], { timeout: 5000 });
            // Wait for device window to appear
            await new Promise((r) => setTimeout(r, 500));
            // Get window info
            const { stdout: winInfo } = await execFileAsync(binPath, ['window'], { timeout: 3000 });
            const parts = winInfo.trim().split(',');
            if (parts.length < 5 || parts[0] === 'not_found') {
                return { ok: false };
            }
            const width = parseInt(parts[2]);
            const height = parseInt(parts[3]);
            const name = parts.slice(4).join(',');
            // Move window to the target position
            await execFileAsync(binPath, ['position', String(Math.round(x)), String(Math.round(y))], { timeout: 3000 });
            // Float above other windows
            await execFileAsync(binPath, ['float'], { timeout: 3000 });
            return { ok: true, width, height, name };
        }
        catch (err) {
            console.error('[ios-anchor] Failed:', err instanceof Error ? err.message : err);
            return { ok: false };
        }
    }
    async repositionWindow(x, y) {
        try {
            await execFileAsync(this.getSimInputPath(), ['position', String(Math.round(x)), String(Math.round(y))], { timeout: 2000 });
        }
        catch {
            // Ignore positioning errors
        }
    }
    async hideWindow() {
        try {
            await execFileAsync(this.getSimInputPath(), ['hide'], { timeout: 2000 });
        }
        catch { /* ignore */ }
    }
    async showWindow() {
        try {
            await execFileAsync(this.getSimInputPath(), ['show'], { timeout: 2000 });
        }
        catch { /* ignore */ }
    }
    async unfloatWindow() {
        try {
            await execFileAsync(this.getSimInputPath(), ['unfloat'], { timeout: 2000 });
        }
        catch { /* ignore */ }
    }
    toNormalizedPoint(deviceId, x, y) {
        if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
            return { x, y };
        }
        const dimensions = this.screenshotDimensions.get(deviceId);
        if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
            return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
        }
        return {
            x: Math.max(0, Math.min(1, x / dimensions.width)),
            y: Math.max(0, Math.min(1, y / dimensions.height)),
        };
    }
    async sendNormalizedTap(x, y) {
        await this.ensureSimulatorRunning();
        if (await this.sendIdbTap(x, y))
            return;
        scheduleFocusReclaim();
        await execFileAsync(this.getSimInputPath(), ['tap', String(x), String(y)], { timeout: 5000 });
        scheduleFocusReclaim();
    }
    async sendNormalizedSwipe(x1, y1, x2, y2) {
        await this.ensureSimulatorRunning();
        if (await this.sendIdbSwipe(x1, y1, x2, y2))
            return;
        scheduleFocusReclaim();
        await execFileAsync(this.getSimInputPath(), ['swipe', String(x1), String(y1), String(x2), String(y2)], { timeout: 8000 });
        scheduleFocusReclaim();
    }
    idbAvailable = null;
    idbPath = null;
    idbCompanionPath = null;
    async hasIdb() {
        if (this.idbAvailable !== null)
            return this.idbAvailable;
        const diag = (0, idb_1.diagnoseIdb)();
        this.idbPath = diag.path;
        this.idbCompanionPath = diag.companionPath;
        this.idbAvailable = diag.installed;
        return this.idbAvailable;
    }
    idbArgs(args) {
        return this.idbCompanionPath ? ['--companion-path', this.idbCompanionPath, ...args] : args;
    }
    async sendIdbTap(x, y) {
        if (!(await this.hasIdb()))
            return false;
        const point = this.toScreenshotPixelPoint(x, y);
        if (!point)
            return false;
        try {
            await execFileAsync(this.idbPath || 'idb', this.idbArgs([
                'ui',
                'tap',
                String(point.x),
                String(point.y),
                '--udid',
                point.deviceId,
            ]), { timeout: 5000 });
            return true;
        }
        catch (error) {
            console.warn('[ios-input] idb tap failed, falling back to sim-input:', error instanceof Error ? error.message : error);
            return false;
        }
    }
    async sendIdbSwipe(x1, y1, x2, y2) {
        if (!(await this.hasIdb()))
            return false;
        const start = this.toScreenshotPixelPoint(x1, y1);
        const end = this.toScreenshotPixelPoint(x2, y2);
        if (!start || !end || start.deviceId !== end.deviceId)
            return false;
        try {
            await execFileAsync(this.idbPath || 'idb', this.idbArgs([
                'ui',
                'swipe',
                String(start.x),
                String(start.y),
                String(end.x),
                String(end.y),
                '0.35',
                '--udid',
                start.deviceId,
            ]), { timeout: 8000 });
            return true;
        }
        catch (error) {
            console.warn('[ios-input] idb swipe failed, falling back to sim-input:', error instanceof Error ? error.message : error);
            return false;
        }
    }
    lastInputDeviceId = null;
    toScreenshotPixelPoint(x, y) {
        const deviceId = this.lastInputDeviceId;
        if (!deviceId)
            return null;
        const dimensions = this.screenshotDimensions.get(deviceId);
        if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0)
            return null;
        return {
            deviceId,
            x: Math.round(Math.max(0, Math.min(1, x)) * dimensions.width),
            y: Math.round(Math.max(0, Math.min(1, y)) * dimensions.height),
        };
    }
    // Make sure Simulator.app is running so `findSimulatorDeviceWindow` can resolve the window.
    // We keep the native window on a real display because CGEvent.postToPid drops events when the
    // target window has been moved far off-screen. Focus reclaim keeps 1DevTool frontmost.
    simulatorEnsured = false;
    async ensureSimulatorRunning() {
        try {
            if (!this.simulatorEnsured) {
                // -g: launch in background without activating.
                await execFileAsync('open', ['-g', '-a', 'Simulator'], { timeout: 5000 });
                scheduleFocusReclaim(800);
                await new Promise((resolve) => setTimeout(resolve, 300));
            }
            await this.ensureSimulatorWindowVisible();
            this.simulatorEnsured = true;
        }
        catch {
            // ignore — the following sim-input call surfaces the concrete error.
        }
    }
    async ensureSimulatorWindowVisible() {
        const binPath = this.getSimInputPath();
        let win = null;
        try {
            const { stdout } = await execFileAsync(binPath, ['window'], { timeout: 3000 });
            win = parseSimulatorWindow(stdout);
        }
        catch {
            return;
        }
        if (!win || intersectsDisplay(win))
            return;
        const position = restorePosition();
        console.warn('[ios-input] Simulator window was off-screen; restoring to', position);
        await execFileAsync(binPath, ['position', String(position.x), String(position.y)], { timeout: 3000 });
        await execFileAsync(binPath, ['unfloat'], { timeout: 3000 }).catch(() => undefined);
        scheduleFocusReclaim(1000);
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    async wdaFetch(session, path, init) {
        const { timeoutMs, ...fetchInit } = init ?? {};
        const effectiveTimeout = timeoutMs ?? 5000;
        let response;
        try {
            response = await fetch(`${session.host}${path}`, {
                ...fetchInit,
                headers: {
                    ...(fetchInit?.body ? { 'Content-Type': 'application/json' } : {}),
                    ...(fetchInit?.headers ?? {}),
                },
                signal: AbortSignal.timeout(effectiveTimeout),
            });
        }
        catch (error) {
            if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
                throw new Error(`WDA ${path} timed out after ${effectiveTimeout}ms`);
            }
            throw error;
        }
        if (!response.ok) {
            throw new Error(`WDA ${path} failed: HTTP ${response.status}`);
        }
        return await response.json();
    }
    async isWDAReachable() {
        try {
            const response = await fetch(`${this.wdaHost}/status`, {
                signal: AbortSignal.timeout(1200),
            });
            return response.ok;
        }
        catch {
            return false;
        }
    }
    getWDAProjectPath() {
        const candidates = [
            process.env.ONEDEVTOOL_WDA_PROJECT,
            process.env.SIMULATOR_WDA_PROJECT,
            path_1.default.join((0, os_1.homedir)(), 'Downloads', 'sim-test', 'WebDriverAgent'),
            path_1.default.resolve('WebDriverAgent'),
            path_1.default.resolve('..', 'sim-test', 'WebDriverAgent'),
        ].filter(Boolean);
        return candidates.find((candidate) => (0, fs_1.existsSync)(path_1.default.join(candidate, 'WebDriverAgent.xcodeproj'))) ?? null;
    }
    async ensureWDAServer(deviceId) {
        if (await this.isWDAReachable())
            return;
        if (this.wdaStarting)
            return this.wdaStarting;
        this.wdaStarting = this.startWDAServer(deviceId).finally(() => {
            this.wdaStarting = null;
        });
        return this.wdaStarting;
    }
    async startWDAServer(deviceId) {
        const wdaPath = this.getWDAProjectPath();
        if (!wdaPath) {
            throw new Error('WebDriverAgent project not found. Set ONEDEVTOOL_WDA_PROJECT or install it at ~/Downloads/sim-test/WebDriverAgent.');
        }
        if (this.wdaProcess && !this.wdaProcess.killed) {
            this.wdaProcess.kill('SIGTERM');
            this.wdaProcess = null;
        }
        const port = getWDAPort(this.wdaHost);
        const args = [
            'test',
            '-project',
            'WebDriverAgent.xcodeproj',
            '-scheme',
            'WebDriverAgentRunner',
            '-destination',
            `platform=iOS Simulator,id=${deviceId}`,
            '-derivedDataPath',
            '/tmp/1devtool-wda-dd',
        ];
        console.log(`[ios-wda] Starting WebDriverAgent from ${wdaPath} on ${this.wdaHost}`);
        const proc = (0, child_process_1.spawn)('xcodebuild', args, {
            cwd: wdaPath,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, USE_PORT: port },
        });
        this.wdaProcess = proc;
        let stderrTail = '';
        const appendOutput = (chunk) => {
            const text = chunk.toString();
            stderrTail = `${stderrTail}${text}`.slice(-4000);
            if (text.includes('ServerURLHere') || text.includes('error:')) {
                console.log(`[ios-wda] ${text.trim()}`);
            }
        };
        proc.stdout?.on('data', appendOutput);
        proc.stderr?.on('data', appendOutput);
        proc.on('exit', (code, signal) => {
            if (this.wdaProcess === proc)
                this.wdaProcess = null;
            console.log(`[ios-wda] xcodebuild exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
        });
        const startedAt = Date.now();
        while (Date.now() - startedAt < 60_000) {
            if (proc.exitCode !== null) {
                throw new Error(`WebDriverAgent exited before startup: ${stderrTail || `code ${proc.exitCode}`}`);
            }
            if (await this.isWDAReachable())
                return;
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        throw new Error(`Timed out waiting for WebDriverAgent at ${this.wdaHost}`);
    }
    async getWDASize(session) {
        const endpoints = [
            `/session/${session.sessionId}/window/size`,
            `/session/${session.sessionId}/window/rect`,
        ];
        for (const endpoint of endpoints) {
            try {
                const data = await this.wdaFetch(session, endpoint);
                const value = data.value;
                if (value?.width && value?.height) {
                    return { width: value.width, height: value.height };
                }
            }
            catch {
                // Try the next WDA endpoint.
            }
        }
        return null;
    }
    async connectWDA(deviceId) {
        const existing = this.wdaSessions.get(deviceId);
        if (existing)
            return existing;
        try {
            await this.ensureWDAServer(deviceId);
            const host = this.wdaHost;
            const response = await fetch(`${host}/session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    capabilities: { alwaysMatch: { platformName: 'iOS' } },
                }),
                signal: AbortSignal.timeout(3500),
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const data = await response.json();
            const sessionId = data.sessionId || data.value?.sessionId;
            if (!sessionId) {
                throw new Error('WDA did not return a session id');
            }
            const session = {
                host,
                sessionId,
                width: 0,
                height: 0,
            };
            const size = await this.getWDASize(session);
            if (size) {
                session.width = size.width;
                session.height = size.height;
                this.setScreenshotDimensions(deviceId, size.width, size.height);
            }
            this.wdaSessions.set(deviceId, session);
            console.log(`[ios-wda] Connected to ${host} for ${deviceId} (${sessionId})`);
            return session;
        }
        catch (error) {
            console.warn('[ios-wda] WDA unavailable, using simctl stream fallback:', error instanceof Error ? error.message : error);
            return null;
        }
    }
    setWDAHost(host) {
        const nextHost = host.trim().replace(/\/$/, '');
        if (!nextHost || nextHost === this.wdaHost)
            return;
        this.wdaHost = nextHost;
        for (const [deviceId] of this.wdaSessions) {
            this.disableWDA(deviceId);
        }
    }
    getWDAHost() {
        return this.wdaHost;
    }
    async disconnectWDA(deviceId) {
        const session = this.wdaSessions.get(deviceId);
        if (!session)
            return;
        this.wdaSessions.delete(deviceId);
        try {
            await fetch(`${session.host}/session/${session.sessionId}`, {
                method: 'DELETE',
                signal: AbortSignal.timeout(2000),
            });
        }
        catch {
            // WDA may already be gone.
        }
    }
    stopWDAServer() {
        if (this.wdaProcess && !this.wdaProcess.killed) {
            this.wdaProcess.kill('SIGTERM');
        }
        this.wdaProcess = null;
    }
    disableWDA(deviceId, session) {
        const active = this.wdaSessions.get(deviceId);
        if (!session || active?.sessionId === session.sessionId) {
            this.wdaSessions.delete(deviceId);
        }
        const serverState = this.streamServers.get(deviceId);
        if (serverState && (!session || serverState.wda?.sessionId === session.sessionId)) {
            serverState.wda = undefined;
            serverState.streamMode = 'simctl';
        }
    }
    async captureWDAFrame(deviceId, session) {
        const data = await this.wdaFetch(session, '/screenshot');
        if (!data.value) {
            throw new Error('WDA screenshot response did not include an image');
        }
        const frame = Buffer.from(data.value, 'base64');
        if ((!session.width || !session.height) && frame.byteLength > 0) {
            const pngSize = parsePngSize(frame);
            if (pngSize) {
                session.width = pngSize.width;
                session.height = pngSize.height;
                this.setScreenshotDimensions(deviceId, pngSize.width, pngSize.height);
            }
        }
        return frame;
    }
    async sendWDAActions(deviceId, actions) {
        const session = this.wdaSessions.get(deviceId);
        if (!session)
            return false;
        try {
            await this.wdaFetch(session, `/session/${session.sessionId}/actions`, {
                method: 'POST',
                body: JSON.stringify({
                    actions: [{
                            type: 'pointer',
                            id: 'finger1',
                            parameters: { pointerType: 'touch' },
                            actions,
                        }],
                }),
            });
            return true;
        }
        catch (error) {
            console.warn('[ios-wda] Input failed, falling back:', error instanceof Error ? error.message : error);
            this.disableWDA(deviceId, session);
            return false;
        }
    }
    toWDAPoint(session, x, y) {
        const width = session.width || 1;
        const height = session.height || 1;
        return {
            x: Math.round(Math.max(0, Math.min(1, x)) * width),
            y: Math.round(Math.max(0, Math.min(1, y)) * height),
        };
    }
    async sendWDATap(deviceId, x, y) {
        const session = this.wdaSessions.get(deviceId);
        if (!session)
            return false;
        const point = this.toWDAPoint(session, x, y);
        return this.sendWDAActions(deviceId, [
            { type: 'pointerMove', x: point.x, y: point.y, duration: 0 },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 50 },
            { type: 'pointerUp', button: 0 },
        ]);
    }
    async sendWDASwipe(deviceId, x1, y1, x2, y2) {
        const session = this.wdaSessions.get(deviceId);
        if (!session)
            return false;
        const start = this.toWDAPoint(session, x1, y1);
        const end = this.toWDAPoint(session, x2, y2);
        return this.sendWDAActions(deviceId, [
            { type: 'pointerMove', x: start.x, y: start.y, duration: 0 },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerMove', x: end.x, y: end.y, duration: 350 },
            { type: 'pointerUp', button: 0 },
        ]);
    }
    async getOrConnectWDA(deviceId) {
        const session = this.wdaSessions.get(deviceId) || await this.connectWDA(deviceId);
        if (!session) {
            throw new Error(`WebDriverAgent is not connected at ${this.wdaHost}`);
        }
        return session;
    }
    async pressHome(deviceId) {
        const session = await this.getOrConnectWDA(deviceId);
        await this.wdaFetch(session, `/session/${session.sessionId}/wda/pressButton`, {
            method: 'POST',
            body: JSON.stringify({ name: 'home' }),
            timeoutMs: 15000,
        });
    }
    async pressLock(deviceId) {
        const session = await this.getOrConnectWDA(deviceId);
        await this.wdaFetch(session, `/session/${session.sessionId}/wda/lock`, {
            method: 'POST',
            timeoutMs: 15000,
        });
    }
    async launchApp(deviceId, bundleId) {
        const session = await this.getOrConnectWDA(deviceId);
        await this.wdaFetch(session, `/session/${session.sessionId}/wda/apps/launch`, {
            method: 'POST',
            body: JSON.stringify({ bundleId }),
            timeoutMs: 20000,
        });
    }
    async getSource(deviceId) {
        const session = await this.getOrConnectWDA(deviceId);
        const data = await this.wdaFetch(session, `/session/${session.sessionId}/source`, { timeoutMs: 25000 });
        return data.value || '';
    }
    async readJsonBody(request) {
        const chunks = [];
        for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            if (Buffer.concat(chunks).byteLength > 64 * 1024) {
                throw new Error('Request body too large');
            }
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        return raw ? JSON.parse(raw) : null;
    }
    sendResponse(response, statusCode, body = '') {
        response.statusCode = statusCode;
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Allow-Headers', 'content-type');
        response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        response.end(body);
    }
    serveViewer(response) {
        response.statusCode = 200;
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #000; }
    body { display: flex; align-items: center; justify-content: center; }
    img { width: 100%; height: 100%; object-fit: contain; background: #000; outline: none; user-select: none; -webkit-user-drag: none; }
    #error { position: fixed; left: 8px; right: 8px; bottom: 8px; padding: 8px 10px; border-radius: 6px; background: rgba(185,28,28,.92); color: white; font: 12px -apple-system, BlinkMacSystemFont, sans-serif; display: none; }
  </style>
</head>
<body>
  <img id="stream" src="/stream" alt="iOS Simulator stream" />
  <div id="error"></div>
  <script>
    const stream = document.getElementById('stream')
    const error = document.getElementById('error')
    let start = null

    function streamPoint(event) {
      const rect = stream.getBoundingClientRect()
      const naturalWidth = stream.naturalWidth || rect.width
      const naturalHeight = stream.naturalHeight || rect.height
      const videoRatio = naturalWidth / naturalHeight
      const rectRatio = rect.width / rect.height
      let width = rect.width
      let height = rect.height
      let left = rect.left
      let top = rect.top

      if (rectRatio > videoRatio) {
        width = rect.height * videoRatio
        left = rect.left + (rect.width - width) / 2
      } else {
        height = rect.width / videoRatio
        top = rect.top + (rect.height - height) / 2
      }

      return {
        x: Math.max(0, Math.min(1, (event.clientX - left) / width)),
        y: Math.max(0, Math.min(1, (event.clientY - top) / height)),
      }
    }

    function send(event) {
      fetch('/input', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      }).then(async response => {
        if (response.ok) {
          error.style.display = 'none'
          error.textContent = ''
          return
        }
        error.textContent = await response.text() || 'Input failed'
        error.style.display = 'block'
      }).catch((err) => {
        error.textContent = String(err?.message || err || 'Input failed')
        error.style.display = 'block'
      })
    }

    stream.addEventListener('pointerdown', (event) => {
      stream.setPointerCapture(event.pointerId)
      start = streamPoint(event)
      event.preventDefault()
    })

    stream.addEventListener('pointerup', (event) => {
      if (!start) return
      const end = streamPoint(event)
      const dx = end.x - start.x
      const dy = end.y - start.y
      if (Math.hypot(dx, dy) > 0.025) {
        send({ type: 'swipe', x1: start.x, y1: start.y, x2: end.x, y2: end.y })
      } else {
        send({ type: 'tap', x: end.x, y: end.y })
      }
      start = null
      event.preventDefault()
    })

    stream.addEventListener('pointercancel', () => {
      start = null
    })

    stream.addEventListener('error', () => {
      setTimeout(() => {
        stream.src = '/stream?restart=' + Date.now()
      }, 750)
    })
  </script>
</body>
</html>`);
    }
    captureScreenshotFrame(deviceId, serverState) {
        return new Promise((resolve, reject) => {
            const proc = (0, child_process_1.spawn)('xcrun', [
                'simctl',
                'io',
                deviceId,
                'screenshot',
                '--type=png',
                '-',
            ], { stdio: ['ignore', 'pipe', 'pipe'] });
            serverState?.processes.add(proc);
            const chunks = [];
            let stderr = '';
            proc.stdout?.on('data', (chunk) => chunks.push(chunk));
            proc.stderr?.on('data', (chunk) => {
                stderr += chunk.toString();
            });
            proc.on('error', reject);
            proc.on('close', (code) => {
                serverState?.processes.delete(proc);
                if (code === 0) {
                    resolve(Buffer.concat(chunks));
                }
                else {
                    reject(new Error(stderr || `screenshot exited with code ${code}`));
                }
            });
        });
    }
    startMultipartImageStream(deviceId, response, serverState) {
        response.statusCode = 200;
        response.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=1devtool-sim-frame');
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        response.setHeader('Pragma', 'no-cache');
        response.setHeader('Connection', 'close');
        let running = true;
        let currentProc = null;
        const writeFrame = (frame) => {
            if (!running || response.writableEnded)
                return;
            response.write('--1devtool-sim-frame\r\n');
            response.write('Content-Type: image/png\r\n');
            response.write(`Content-Length: ${frame.byteLength}\r\n\r\n`);
            response.write(frame);
            response.write('\r\n');
        };
        const loop = async () => {
            while (running && !response.writableEnded) {
                const startedAt = Date.now();
                try {
                    const framePromise = this.captureScreenshotFrame(deviceId, serverState);
                    const processes = Array.from(serverState.processes);
                    currentProc = processes[processes.length - 1] ?? null;
                    const frame = await framePromise;
                    currentProc = null;
                    if (frame.byteLength > 0) {
                        writeFrame(frame);
                    }
                }
                catch (error) {
                    if (!running)
                        return;
                    console.error('[ios-stream] Screenshot frame failed:', error instanceof Error ? error.message : error);
                    await new Promise((resolve) => setTimeout(resolve, 500));
                    continue;
                }
                const elapsed = Date.now() - startedAt;
                const delayMs = Math.max(0, 250 - elapsed);
                if (delayMs > 0) {
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                }
            }
        };
        response.on('close', () => {
            running = false;
            if (currentProc && !currentProc.killed) {
                currentProc.kill('SIGTERM');
            }
        });
        loop().catch((error) => {
            if (!response.writableEnded) {
                response.end(error instanceof Error ? error.message : String(error));
            }
        });
    }
    startWDAImageStream(deviceId, response, serverState) {
        const session = serverState.wda;
        if (!session) {
            this.sendResponse(response, 503, 'WDA stream is not connected');
            return;
        }
        response.statusCode = 200;
        response.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=1devtool-wda-frame');
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        response.setHeader('Pragma', 'no-cache');
        response.setHeader('Connection', 'close');
        let running = true;
        const writeFrame = (frame) => {
            if (!running || response.writableEnded)
                return;
            response.write('--1devtool-wda-frame\r\n');
            response.write('Content-Type: image/png\r\n');
            response.write(`Content-Length: ${frame.byteLength}\r\n\r\n`);
            response.write(frame);
            response.write('\r\n');
        };
        const loop = async () => {
            while (running && !response.writableEnded) {
                const startedAt = Date.now();
                try {
                    const frame = await this.captureWDAFrame(deviceId, session);
                    if (frame.byteLength > 0)
                        writeFrame(frame);
                }
                catch (error) {
                    if (!running)
                        return;
                    console.error('[ios-wda] Screenshot frame failed:', error instanceof Error ? error.message : error);
                    this.disableWDA(deviceId, session);
                    void this.ensureSimulatorRunning();
                    response.end();
                    return;
                }
                const elapsed = Date.now() - startedAt;
                const delayMs = Math.max(0, 33 - elapsed);
                if (delayMs > 0) {
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                }
            }
        };
        response.on('close', () => {
            running = false;
        });
        loop().catch((error) => {
            if (!response.writableEnded) {
                response.end(error instanceof Error ? error.message : String(error));
            }
        });
    }
    async createLocalStreamServer(deviceId, wda) {
        const existing = this.streamServers.get(deviceId);
        if (existing) {
            existing.wda = wda ?? undefined;
            existing.streamMode = wda ? 'wda' : 'simctl';
            return existing;
        }
        const placeholderState = { processes: new Set() };
        const server = (0, http_1.createServer)((request, response) => {
            const serverState = this.streamServers.get(deviceId);
            if (!serverState) {
                this.sendResponse(response, 503, 'Stream server stopped');
                return;
            }
            const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
            if (request.method === 'OPTIONS') {
                this.sendResponse(response, 204);
                return;
            }
            if (request.method === 'GET' && url.pathname === '/') {
                this.serveViewer(response);
                return;
            }
            if (request.method === 'GET' && url.pathname === '/stream') {
                if (serverState.wda) {
                    this.startWDAImageStream(deviceId, response, serverState);
                }
                else {
                    this.startMultipartImageStream(deviceId, response, serverState);
                }
                return;
            }
            if (request.method === 'GET' && url.pathname === '/screenshot') {
                const framePromise = serverState.wda
                    ? this.captureWDAFrame(deviceId, serverState.wda)
                    : this.captureScreenshotFrame(deviceId);
                framePromise
                    .then((frame) => {
                    response.statusCode = 200;
                    response.setHeader('Content-Type', 'image/png');
                    response.setHeader('Access-Control-Allow-Origin', '*');
                    response.setHeader('Cache-Control', 'no-store');
                    response.end(frame);
                })
                    .catch((error) => {
                    this.sendResponse(response, 500, error instanceof Error ? error.message : 'Screenshot failed');
                });
                return;
            }
            if (request.method === 'POST' && url.pathname === '/input') {
                this.readJsonBody(request)
                    .then(async (event) => {
                    const input = event;
                    if (input?.type === 'tap') {
                        if (!serverState.wda || !(await this.sendWDATap(deviceId, input.x, input.y))) {
                            await this.sendTap(deviceId, input.x, input.y);
                        }
                    }
                    else if (input?.type === 'swipe') {
                        if (!serverState.wda || !(await this.sendWDASwipe(deviceId, input.x1, input.y1, input.x2, input.y2))) {
                            await this.sendSwipe(deviceId, input.x1, input.y1, input.x2, input.y2);
                        }
                    }
                    else if (input?.type === 'text') {
                        await this.sendText(deviceId, input.text);
                    }
                    this.sendResponse(response, 204);
                })
                    .catch((error) => {
                    this.sendResponse(response, 400, error instanceof Error ? error.message : 'Invalid input');
                });
                return;
            }
            this.sendResponse(response, 404, 'Not found');
        });
        const port = await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.off('error', reject);
                const address = server.address();
                if (typeof address === 'object' && address) {
                    resolve(address.port);
                }
                else {
                    reject(new Error('Failed to bind local simulator stream server'));
                }
            });
        });
        const serverState = {
            server,
            port,
            processes: placeholderState.processes,
            wda: wda ?? undefined,
            streamMode: wda ? 'wda' : 'simctl',
        };
        this.streamServers.set(deviceId, serverState);
        return serverState;
    }
    async startStream(deviceId) {
        let dataCallback = null;
        let errorCallback = null;
        let exitCallback = null;
        // Prefer the headless WDA bridge from sim-test when it is already running.
        // If WDA is unavailable, fall back to the existing Simulator.app/simctl path.
        const wda = await this.connectWDA(deviceId);
        if (!wda) {
            // Launch Simulator.app in the background so findSimulatorDeviceWindow resolves before the
            // user's first tap.
            await this.ensureSimulatorRunning();
        }
        const serverState = await this.createLocalStreamServer(deviceId, wda);
        return {
            process: null,
            streamUrl: `http://127.0.0.1:${serverState.port}/`,
            streamMode: 'mjpeg',
            onData: (cb) => { dataCallback = cb; },
            onError: (cb) => { errorCallback = cb; },
            onExit: (cb) => { exitCallback = cb; },
            destroy: () => {
                const state = this.streamServers.get(deviceId);
                if (state) {
                    for (const proc of state.processes) {
                        if (!proc.killed)
                            proc.kill('SIGTERM');
                    }
                    state.processes.clear();
                    state.server.close();
                    this.streamServers.delete(deviceId);
                }
                void this.disconnectWDA(deviceId);
                this.stopWDAServer();
                this.simulatorEnsured = false;
                exitCallback?.(0);
            },
        };
    }
    stopStream(handle) {
        handle.destroy();
    }
}
exports.iOSSimulatorAdapter = iOSSimulatorAdapter;
