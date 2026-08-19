"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.GstackManager = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const gstack_constants_1 = require("../shared/gstack-constants");
const agentPaths_1 = require("./agentPaths");
function resolveGstackPath(overrides = {}) {
    return path.join((0, agentPaths_1.getAgentRoot)('claude', overrides), 'skills', 'gstack');
}
function parseFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match)
        return {};
    const result = {};
    for (const line of match[1].split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1)
            continue;
        const key = line.slice(0, colonIdx).trim();
        let value = line.slice(colonIdx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        result[key] = value;
    }
    return result;
}
function commandExists(cmd) {
    try {
        const { execSync } = require('child_process');
        execSync(`which ${cmd}`, { stdio: 'ignore' });
        return true;
    }
    catch {
        return false;
    }
}
class GstackManager {
    getOverrides;
    constructor(getOverrides = () => ({})) {
        this.getOverrides = getOverrides;
    }
    get gstackPath() {
        return resolveGstackPath(this.getOverrides());
    }
    getStatus() {
        const gstackPath = this.gstackPath;
        const versionFile = path.join(gstackPath, 'VERSION');
        if (!fs.existsSync(gstackPath)) {
            return { installed: false, version: null, path: null, updateAvailable: false };
        }
        let version = null;
        if (fs.existsSync(versionFile)) {
            try {
                version = fs.readFileSync(versionFile, 'utf-8').trim();
            }
            catch { /* ignore */ }
        }
        // If no VERSION file, check if directory exists with skills
        if (!version) {
            // Check for package.json or any skill files as indicator
            const hasSkills = fs.existsSync(path.join(gstackPath, 'skills')) ||
                fs.existsSync(path.join(gstackPath, 'commands'));
            if (!hasSkills) {
                return { installed: false, version: null, path: null, updateAvailable: false };
            }
            version = 'unknown';
        }
        return { installed: true, version, path: gstackPath, updateAvailable: false };
    }
    checkPrerequisites() {
        return {
            git: commandExists('git'),
            bun: commandExists('bun'),
        };
    }
    async install(onLog) {
        const gstackPath = this.gstackPath;
        const parentDir = path.dirname(gstackPath);
        // Ensure parent directory exists
        if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
        }
        try {
            // Step 1: Clone
            onLog('$ git clone ' + gstack_constants_1.GSTACK_REPO_URL + ' ' + gstackPath + '\n');
            await this.runCommand('git', ['clone', gstack_constants_1.GSTACK_REPO_URL, gstackPath], parentDir, onLog);
            // Step 2: Run setup if it exists
            const setupScript = path.join(gstackPath, 'setup');
            if (fs.existsSync(setupScript)) {
                onLog('\n$ cd ' + gstackPath + ' && ./setup\n');
                await this.runCommand('./setup', [], gstackPath, onLog);
            }
            onLog('\ngstack installed successfully!\n');
            return { ok: true };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Installation failed';
            onLog('\nError: ' + message + '\n');
            return { ok: false, error: message };
        }
    }
    async update(onLog) {
        const gstackPath = this.gstackPath;
        if (!fs.existsSync(gstackPath)) {
            return { ok: false, error: 'gstack not installed' };
        }
        try {
            onLog('$ cd ' + gstackPath + ' && git pull\n');
            await this.runCommand('git', ['pull'], gstackPath, onLog);
            const setupScript = path.join(gstackPath, 'setup');
            if (fs.existsSync(setupScript)) {
                onLog('\n$ ./setup\n');
                await this.runCommand('./setup', [], gstackPath, onLog);
            }
            onLog('\ngstack updated successfully!\n');
            return { ok: true };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Update failed';
            onLog('\nError: ' + message + '\n');
            return { ok: false, error: message };
        }
    }
    getSkills() {
        const gstackPath = this.gstackPath;
        if (!fs.existsSync(gstackPath))
            return [];
        const skills = [];
        // Build reverse chain map for fedBy
        const fedByMap = new Map();
        for (const conn of gstack_constants_1.GSTACK_CHAIN_CONNECTIONS) {
            const arr = fedByMap.get(conn.to) || [];
            arr.push(conn.from);
            fedByMap.set(conn.to, arr);
        }
        // Scan skills/ directory
        const skillsDir = path.join(gstackPath, 'skills');
        if (fs.existsSync(skillsDir)) {
            try {
                for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
                    if (!entry.isDirectory())
                        continue;
                    const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
                    const skill = this.parseGstackSkill(entry.name, skillMd, fedByMap);
                    if (skill)
                        skills.push(skill);
                }
            }
            catch { /* unreadable */ }
        }
        // Scan commands/ directory
        const commandsDir = path.join(gstackPath, 'commands');
        if (fs.existsSync(commandsDir)) {
            try {
                for (const entry of fs.readdirSync(commandsDir, { withFileTypes: true })) {
                    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.md')
                        continue;
                    const name = path.basename(entry.name, '.md');
                    const filePath = path.join(commandsDir, entry.name);
                    const skill = this.parseGstackSkill(name, filePath, fedByMap);
                    if (skill)
                        skills.push(skill);
                }
            }
            catch { /* unreadable */ }
        }
        return skills;
    }
    async checkForUpdate() {
        const status = this.getStatus();
        if (!status.installed || !status.path) {
            return { hasUpdate: false };
        }
        try {
            // Fetch remote tags/version without pulling
            const gstackPath = status.path;
            const { execSync } = require('child_process');
            execSync('git fetch --tags', { cwd: gstackPath, stdio: 'ignore', timeout: 10000 });
            const local = execSync('git rev-parse HEAD', { cwd: gstackPath, encoding: 'utf-8' }).trim();
            const remote = execSync('git rev-parse origin/main', { cwd: gstackPath, encoding: 'utf-8' }).trim();
            return {
                hasUpdate: local !== remote,
                currentVersion: status.version || undefined,
            };
        }
        catch {
            return { hasUpdate: false, currentVersion: status.version || undefined };
        }
    }
    parseGstackSkill(name, filePath, fedByMap) {
        if (!fs.existsSync(filePath))
            return null;
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const fm = parseFrontmatter(content);
            const meta = gstack_constants_1.GSTACK_PHASE_MAP[name];
            const phase = meta?.phase || 'safety';
            const specialist = meta?.specialist || fm.name || name;
            // Get chain connections for this skill
            const feedsInto = gstack_constants_1.GSTACK_CHAIN_CONNECTIONS
                .filter(c => c.from === name)
                .map(c => c.to);
            const fedBy = fedByMap.get(name) || [];
            // Read version from the gstack VERSION file
            const gstackPath = this.gstackPath;
            let version = 'unknown';
            const versionFile = path.join(gstackPath, 'VERSION');
            if (fs.existsSync(versionFile)) {
                try {
                    version = fs.readFileSync(versionFile, 'utf-8').trim();
                }
                catch { /* */ }
            }
            return {
                name,
                slashCommand: `/${name}`,
                description: fm.description || '',
                version,
                phase,
                specialist,
                filePath,
                feedsInto,
                fedBy,
            };
        }
        catch {
            return null;
        }
    }
    runCommand(cmd, args, cwd, onLog) {
        return new Promise((resolve, reject) => {
            const child = (0, child_process_1.spawn)(cmd, args, {
                cwd,
                shell: true,
                env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin' },
            });
            child.stdout?.on('data', (data) => onLog(data.toString()));
            child.stderr?.on('data', (data) => onLog(data.toString()));
            child.on('close', (code) => {
                if (code === 0)
                    resolve();
                else
                    reject(new Error(`Command exited with code ${code}`));
            });
            child.on('error', (err) => reject(err));
        });
    }
}
exports.GstackManager = GstackManager;
