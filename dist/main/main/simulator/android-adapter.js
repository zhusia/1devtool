"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AndroidEmulatorAdapter = void 0;
const child_process_1 = require("child_process");
const util_1 = require("util");
const env_1 = require("../utils/env");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
function getAndroidEnv() {
    const home = process.env.HOME || '';
    const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || `${home}/Library/Android/sdk`;
    return (0, env_1.getEnrichedEnv)({
        ANDROID_HOME: androidHome,
        ANDROID_SDK_ROOT: androidHome,
    }, {
        extraPaths: [
            `${androidHome}/emulator`,
            `${androidHome}/platform-tools`,
            `${androidHome}/cmdline-tools/latest/bin`,
            `${androidHome}/tools`,
            `${androidHome}/tools/bin`,
        ],
    });
}
class AndroidEmulatorAdapter {
    async detect() {
        try {
            await execFileAsync('emulator', ['-list-avds'], { timeout: 5000, env: getAndroidEnv() });
            return { available: true };
        }
        catch {
            return { available: false, reason: 'Android SDK with emulator is required. Install Android Studio or the command-line tools.' };
        }
    }
    async list() {
        const devices = [];
        // List configured AVDs
        try {
            const { stdout } = await execFileAsync('emulator', ['-list-avds'], {
                maxBuffer: 10 * 1024 * 1024,
                env: getAndroidEnv(),
            });
            const avdNames = stdout.trim().split('\n').filter(Boolean);
            // Check which are currently running via adb
            let runningSerials = [];
            try {
                const { stdout: adbOut } = await execFileAsync('adb', ['devices'], {
                    timeout: 5000,
                    env: getAndroidEnv(),
                });
                runningSerials = adbOut
                    .split('\n')
                    .filter((line) => line.includes('device') && line.startsWith('emulator-'))
                    .map((line) => line.split('\t')[0]);
            }
            catch {
                // adb not running, all emulators are shutdown
            }
            // Get AVD name for each running emulator
            const runningAvdNames = new Set();
            for (const serial of runningSerials) {
                try {
                    const { stdout: nameOut } = await execFileAsync('adb', ['-s', serial, 'emu', 'avd', 'name'], {
                        timeout: 3000,
                        env: getAndroidEnv(),
                    });
                    const name = nameOut.trim().split('\n')[0];
                    if (name)
                        runningAvdNames.add(name);
                }
                catch {
                    // ignore
                }
            }
            for (const name of avdNames) {
                devices.push({
                    id: name,
                    name,
                    platform: 'android',
                    state: runningAvdNames.has(name) ? 'booted' : 'shutdown',
                });
            }
        }
        catch (error) {
            throw new Error(`Failed to list AVDs: ${error instanceof Error ? error.message : String(error)}`);
        }
        return devices;
    }
    async boot(deviceId) {
        // Check if already running
        const devices = await this.list();
        const device = devices.find((d) => d.id === deviceId);
        if (device?.state === 'booted')
            return;
        // Launch emulator in background (no window, headless for embedding)
        const proc = (0, child_process_1.spawn)('emulator', [`@${deviceId}`, '-no-window', '-no-audio', '-no-boot-anim'], {
            detached: true,
            stdio: 'ignore',
            env: getAndroidEnv(),
        });
        proc.unref();
        // Wait for the emulator to register with adb, then wait for boot completion.
        const maxWait = 60000;
        const start = Date.now();
        while (Date.now() - start < maxWait) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
                const serial = await this.getSerialForAvd(deviceId);
                if (!serial)
                    continue;
                const { stdout } = await execFileAsync('adb', ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], {
                    timeout: 3000,
                    env: getAndroidEnv(),
                });
                if (stdout.trim() === '1')
                    return;
            }
            catch {
                // not ready yet
            }
        }
        throw new Error(`Emulator ${deviceId} did not boot within ${maxWait / 1000}s`);
    }
    async shutdown(deviceId) {
        // Find the serial for this AVD
        const serial = await this.getSerialForAvd(deviceId);
        if (!serial)
            return; // not running
        try {
            await execFileAsync('adb', ['-s', serial, 'emu', 'kill'], {
                timeout: 10000,
                env: getAndroidEnv(),
            });
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to shutdown emulator: ${msg}`);
        }
    }
    async install(deviceId, appPath) {
        const serial = await this.getSerialForAvd(deviceId);
        if (!serial)
            throw new Error('Emulator is not running');
        try {
            await execFileAsync('adb', ['-s', serial, 'install', '-r', appPath], {
                timeout: 60000,
                env: getAndroidEnv(),
            });
        }
        catch (error) {
            throw new Error(`Failed to install APK: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async uninstall(deviceId, bundleId) {
        const serial = await this.getSerialForAvd(deviceId);
        if (!serial)
            throw new Error('Emulator is not running');
        await execFileAsync('adb', ['-s', serial, 'uninstall', bundleId], {
            timeout: 10000,
            env: getAndroidEnv(),
        });
    }
    async openUrl(deviceId, url) {
        const serial = await this.getSerialForAvd(deviceId);
        if (!serial)
            throw new Error('Emulator is not running');
        await execFileAsync('adb', ['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url], {
            timeout: 10000,
            env: getAndroidEnv(),
        });
    }
    async sendTap(deviceId, x, y) {
        const serial = await this.getSerialForAvd(deviceId);
        if (!serial)
            throw new Error('Emulator is not running');
        await execFileAsync('adb', ['-s', serial, 'shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))], {
            timeout: 5000,
            env: getAndroidEnv(),
        });
    }
    async sendText(deviceId, text) {
        const serial = await this.getSerialForAvd(deviceId);
        if (!serial)
            throw new Error('Emulator is not running');
        // Escape special characters for adb shell input
        const escaped = text.replace(/([\\'"$`!])/g, '\\$1').replace(/ /g, '%s');
        await execFileAsync('adb', ['-s', serial, 'shell', 'input', 'text', escaped], {
            timeout: 5000,
            env: getAndroidEnv(),
        });
    }
    async sendSwipe(deviceId, x1, y1, x2, y2) {
        const serial = await this.getSerialForAvd(deviceId);
        if (!serial)
            throw new Error('Emulator is not running');
        await execFileAsync('adb', [
            '-s', serial, 'shell', 'input', 'swipe',
            String(Math.round(x1)), String(Math.round(y1)),
            String(Math.round(x2)), String(Math.round(y2)),
            '300', // duration ms
        ], { timeout: 5000, env: getAndroidEnv() });
    }
    async pressHome(deviceId) {
        await this.runKeyEvent(deviceId, '3');
    }
    async pressBack(deviceId) {
        await this.runKeyEvent(deviceId, '4');
    }
    async pressOverview(deviceId) {
        await this.runKeyEvent(deviceId, '187');
    }
    async pressLock(deviceId) {
        await this.runKeyEvent(deviceId, '26');
    }
    async launchApp(deviceId, packageName, activityName) {
        const serial = await this.getSerialForAvd(deviceId);
        if (!serial)
            throw new Error('Emulator is not running');
        if (!packageName?.trim())
            throw new Error('Android package name is required');
        const pkg = packageName.trim();
        const env = getAndroidEnv();
        if (activityName?.trim()) {
            const trimmed = activityName.trim();
            const component = trimmed.includes('/')
                ? trimmed
                : `${pkg}/${trimmed.startsWith('.') ? trimmed : trimmed.includes('.') ? trimmed : `.${trimmed}`}`;
            await execFileAsync('adb', ['-s', serial, 'shell', 'am', 'start', '-n', component], {
                timeout: 15000,
                env,
            });
            return;
        }
        await execFileAsync('adb', ['-s', serial, 'shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], {
            timeout: 15000,
            env,
        });
    }
    startStream(deviceId) {
        let proc = null;
        let dataCallback = null;
        let errorCallback = null;
        let exitCallback = null;
        // Use screencap polling via adb as the streaming approach
        // Each frame: adb exec-out screencap -p → PNG data
        let running = true;
        let lastFrameTime = 0;
        const MIN_FRAME_INTERVAL = 100; // adaptive: start at ~10fps
        const pollLoop = async () => {
            const serial = await this.getSerialForAvd(deviceId);
            if (!serial) {
                errorCallback?.(new Error('Emulator is not running'));
                return;
            }
            while (running) {
                const frameStart = Date.now();
                try {
                    // exec-out gives raw binary output (no line-ending translation)
                    const screencapProc = (0, child_process_1.spawn)('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], {
                        env: getAndroidEnv(),
                    });
                    proc = screencapProc;
                    const chunks = [];
                    screencapProc.stdout?.on('data', (chunk) => {
                        chunks.push(chunk);
                    });
                    await new Promise((resolve, reject) => {
                        screencapProc.on('close', (code) => {
                            proc = null;
                            if (code === 0) {
                                const frame = Buffer.concat(chunks);
                                dataCallback?.(frame);
                                resolve();
                            }
                            else {
                                reject(new Error(`screencap exited with code ${code}`));
                            }
                        });
                        screencapProc.on('error', (error) => {
                            proc = null;
                            reject(error);
                        });
                    });
                }
                catch (err) {
                    if (running) {
                        errorCallback?.(err instanceof Error ? err : new Error(String(err)));
                    }
                }
                // Adaptive frame rate: measure how long the capture took
                const elapsed = Date.now() - frameStart;
                lastFrameTime = elapsed;
                const targetInterval = elapsed > 200 ? 333 : MIN_FRAME_INTERVAL; // drop to ~3fps if slow
                const wait = Math.max(0, targetInterval - elapsed);
                if (running && wait > 0) {
                    await new Promise((r) => setTimeout(r, wait));
                }
            }
        };
        pollLoop().catch((err) => {
            errorCallback?.(err instanceof Error ? err : new Error(String(err)));
        });
        return {
            process: proc,
            onData: (cb) => { dataCallback = cb; },
            onError: (cb) => { errorCallback = cb; },
            onExit: (cb) => { exitCallback = cb; },
            destroy: () => {
                running = false;
                if (proc && !proc.killed) {
                    proc.kill('SIGTERM');
                }
                exitCallback?.(0);
            },
        };
    }
    stopStream(handle) {
        handle.destroy();
    }
    async getSerialForAvd(avdName) {
        try {
            const { stdout } = await execFileAsync('adb', ['devices'], { timeout: 3000, env: getAndroidEnv() });
            const emulatorLines = stdout
                .split('\n')
                .filter((line) => line.startsWith('emulator-') && line.includes('device'));
            for (const line of emulatorLines) {
                const serial = line.split('\t')[0];
                try {
                    const { stdout: nameOut } = await execFileAsync('adb', ['-s', serial, 'emu', 'avd', 'name'], {
                        timeout: 3000,
                        env: getAndroidEnv(),
                    });
                    if (nameOut.trim().split('\n')[0] === avdName)
                        return serial;
                }
                catch {
                    // ignore
                }
            }
            if (emulatorLines.length === 1) {
                return emulatorLines[0].split('\t')[0] || null;
            }
        }
        catch {
            // adb not available
        }
        return null;
    }
    async runKeyEvent(deviceId, keyCode) {
        const serial = await this.getSerialForAvd(deviceId);
        if (!serial)
            throw new Error('Emulator is not running');
        await execFileAsync('adb', ['-s', serial, 'shell', 'input', 'keyevent', keyCode], {
            timeout: 10000,
            env: getAndroidEnv(),
        });
    }
}
exports.AndroidEmulatorAdapter = AndroidEmulatorAdapter;
