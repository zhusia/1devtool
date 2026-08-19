"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SKILLS_MANIFEST_BASENAME = exports.SKILL_STORE_DIRNAME = void 0;
exports.defaultSkillStoreRoot = defaultSkillStoreRoot;
exports.skillsManifestPath = skillsManifestPath;
exports.slugifySkillName = slugifySkillName;
exports.projectToolRoot = projectToolRoot;
exports.storeVersionDir = storeVersionDir;
exports.listStore = listStore;
exports.addDirToStore = addDirToStore;
exports.addContentToStore = addContentToStore;
exports.removeFromStore = removeFromStore;
exports.readStoreSkill = readStoreSkill;
exports.readManifest = readManifest;
exports.writeManifest = writeManifest;
exports.computePlan = computePlan;
exports.removeLink = removeLink;
exports.applyManifest = applyManifest;
/*
 * Control-plane skill store: install a skill once into a central, versioned,
 * machine-local store, and let each project select skill + version through a
 * git-shareable manifest that is applied as symlinks (junctions on Windows).
 *
 * Pure Node module — no Electron imports — so the plan/apply engine is
 * unit-testable directly (tests/unit/skills-control-plane.test.mjs).
 *
 * Layout:
 *   <storeRoot>/<slug>/v<N>/SKILL.md [+ assets]   — append-only versions
 *   <project>/.1devtool/skills-manifest.json      — { version, skills: [{name, version, tool}] }
 *   <project>/.claude/skills/<slug>  → symlink →  <storeRoot>/<slug>/v<N>
 *
 * Safety invariants:
 *   - apply() only ever deletes symlinks whose target resolves inside the
 *     store root; a real (copied) directory is a 'conflict' and is replaced
 *     only when the caller opted in per skill name.
 *   - store versions are append-only; adding identical content is a no-op.
 */
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
exports.SKILL_STORE_DIRNAME = 'skill-store';
exports.SKILLS_MANIFEST_BASENAME = 'skills-manifest.json';
/** Max SKILL.md size echoed back in listStore entries / manifest reads. */
const CONTENT_CAP = 256 * 1024;
const MANIFEST_CAP = 1024 * 1024;
function defaultSkillStoreRoot() {
    return node_path_1.default.join(node_os_1.default.homedir(), '.1devtool', exports.SKILL_STORE_DIRNAME);
}
function skillsManifestPath(projectPath) {
    return node_path_1.default.join(projectPath, '.1devtool', exports.SKILLS_MANIFEST_BASENAME);
}
function slugifySkillName(name) {
    return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
/** Project-level root dir a tool's skills live under (mirrors installSkill). */
function projectToolRoot(projectPath, tool) {
    switch (tool) {
        case 'cursor': return node_path_1.default.join(projectPath, '.cursor');
        case 'codex': return node_path_1.default.join(projectPath, '.codex');
        case 'kimi': return node_path_1.default.join(projectPath, '.kimi-code');
        default: return node_path_1.default.join(projectPath, '.claude');
    }
}
/** The tool roots plan/apply scans for managed links. */
const LINKABLE_TOOLS = ['claude', 'cursor', 'codex', 'kimi'];
function storeSkillDir(storeRoot, slug) {
    return node_path_1.default.join(storeRoot, slug);
}
function storeVersionDir(storeRoot, slug, version) {
    return node_path_1.default.join(storeRoot, slug, `v${version}`);
}
function isInsideDir(parent, child) {
    const rel = node_path_1.default.relative(node_path_1.default.resolve(parent), node_path_1.default.resolve(child));
    return rel !== '' && !rel.startsWith('..') && !node_path_1.default.isAbsolute(rel);
}
/** Sorted list of version numbers present for a slug (dirs `v<N>` with a SKILL.md). */
function listVersions(storeRoot, slug) {
    const dir = storeSkillDir(storeRoot, slug);
    let entries;
    try {
        entries = node_fs_1.default.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const versions = [];
    for (const e of entries) {
        if (!e.isDirectory())
            continue;
        const m = /^v(\d+)$/.exec(e.name);
        if (!m)
            continue;
        if (!node_fs_1.default.existsSync(node_path_1.default.join(dir, e.name, 'SKILL.md')))
            continue;
        versions.push(Number(m[1]));
    }
    return versions.sort((a, b) => a - b);
}
/** Content digest of a directory: sorted relative paths + file bytes. Symlinks skipped. */
function dirDigest(dir) {
    const files = [];
    const walk = (rel) => {
        const abs = node_path_1.default.join(dir, rel);
        for (const e of node_fs_1.default.readdirSync(abs, { withFileTypes: true })) {
            if (e.isSymbolicLink())
                continue;
            const childRel = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory())
                walk(childRel);
            else if (e.isFile())
                files.push(childRel);
        }
    };
    walk('');
    files.sort();
    const hash = node_crypto_1.default.createHash('sha256');
    for (const rel of files) {
        hash.update(rel);
        hash.update('\0');
        hash.update(node_fs_1.default.readFileSync(node_path_1.default.join(dir, rel)));
        hash.update('\0');
    }
    return hash.digest('hex');
}
function copyDirSkippingLinks(src, dest) {
    node_fs_1.default.mkdirSync(dest, { recursive: true });
    for (const e of node_fs_1.default.readdirSync(src, { withFileTypes: true })) {
        if (e.isSymbolicLink())
            continue;
        const from = node_path_1.default.join(src, e.name);
        const to = node_path_1.default.join(dest, e.name);
        if (e.isDirectory())
            copyDirSkippingLinks(from, to);
        else if (e.isFile())
            node_fs_1.default.copyFileSync(from, to);
    }
}
function parseDescription(content) {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (fm) {
        const m = /^description:\s*(.+)$/m.exec(fm[1]);
        if (m)
            return m[1].trim().replace(/^["']|["']$/g, '');
    }
    const body = fm ? content.slice(fm[0].length) : content;
    for (const line of body.split('\n')) {
        const t = line.trim();
        if (t && !t.startsWith('#'))
            return t.slice(0, 200);
    }
    return '';
}
// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
function listStore(storeRoot) {
    let entries;
    try {
        entries = node_fs_1.default.readdirSync(storeRoot, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const result = [];
    for (const e of entries) {
        if (!e.isDirectory())
            continue;
        const versions = listVersions(storeRoot, e.name);
        if (versions.length === 0)
            continue;
        const versionInfos = versions.map(v => {
            const md = node_path_1.default.join(storeVersionDir(storeRoot, e.name, v), 'SKILL.md');
            try {
                const st = node_fs_1.default.statSync(md);
                return { version: v, addedAt: st.mtime.toISOString(), size: st.size };
            }
            catch {
                return { version: v, addedAt: new Date(0).toISOString(), size: 0 };
            }
        });
        const latest = versions[versions.length - 1];
        let content = '';
        try {
            const md = node_path_1.default.join(storeVersionDir(storeRoot, e.name, latest), 'SKILL.md');
            if (node_fs_1.default.statSync(md).size <= CONTENT_CAP)
                content = node_fs_1.default.readFileSync(md, 'utf-8');
        }
        catch { /* unreadable */ }
        result.push({
            name: e.name,
            description: parseDescription(content),
            latestVersion: latest,
            versions: versionInfos,
            path: storeSkillDir(storeRoot, e.name),
            content,
        });
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
}
/** Add a full skill directory (SKILL.md + assets) as a new store version. */
function addDirToStore(storeRoot, name, sourceDir) {
    const slug = slugifySkillName(name);
    if (!slug)
        throw new Error(`Invalid skill name "${name}"`);
    if (!node_fs_1.default.existsSync(node_path_1.default.join(sourceDir, 'SKILL.md'))) {
        throw new Error(`"${sourceDir}" has no SKILL.md`);
    }
    const versions = listVersions(storeRoot, slug);
    const latest = versions[versions.length - 1];
    if (latest != null && dirDigest(storeVersionDir(storeRoot, slug, latest)) === dirDigest(sourceDir)) {
        return { name: slug, version: latest, added: false };
    }
    const next = (latest ?? 0) + 1;
    copyDirSkippingLinks(sourceDir, storeVersionDir(storeRoot, slug, next));
    return { name: slug, version: next, added: true };
}
/** Add a content-only skill (e.g. a remote listing or flat command file). */
function addContentToStore(storeRoot, name, content) {
    const slug = slugifySkillName(name);
    if (!slug)
        throw new Error(`Invalid skill name "${name}"`);
    const versions = listVersions(storeRoot, slug);
    const latest = versions[versions.length - 1];
    if (latest != null) {
        const latestDir = storeVersionDir(storeRoot, slug, latest);
        try {
            const existing = node_fs_1.default.readFileSync(node_path_1.default.join(latestDir, 'SKILL.md'), 'utf-8');
            if (existing === content && node_fs_1.default.readdirSync(latestDir).length === 1) {
                return { name: slug, version: latest, added: false };
            }
        }
        catch { /* fall through to write */ }
    }
    const next = (latest ?? 0) + 1;
    const dir = storeVersionDir(storeRoot, slug, next);
    node_fs_1.default.mkdirSync(dir, { recursive: true });
    node_fs_1.default.writeFileSync(node_path_1.default.join(dir, 'SKILL.md'), content, 'utf-8');
    return { name: slug, version: next, added: true };
}
/** Remove one version, or the whole skill when no version is given. */
function removeFromStore(storeRoot, name, version) {
    const slug = slugifySkillName(name);
    const target = version != null ? storeVersionDir(storeRoot, slug, version) : storeSkillDir(storeRoot, slug);
    if (!isInsideDir(storeRoot, target))
        return false;
    if (!node_fs_1.default.existsSync(target))
        return false;
    node_fs_1.default.rmSync(target, { recursive: true, force: true });
    // Removing the last version removes the skill dir too.
    if (version != null && listVersions(storeRoot, slug).length === 0) {
        node_fs_1.default.rmSync(storeSkillDir(storeRoot, slug), { recursive: true, force: true });
    }
    return true;
}
function readStoreSkill(storeRoot, name, version) {
    const md = node_path_1.default.join(storeVersionDir(storeRoot, slugifySkillName(name), version), 'SKILL.md');
    try {
        return node_fs_1.default.readFileSync(md, 'utf-8');
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
function readManifest(projectPath) {
    const file = skillsManifestPath(projectPath);
    try {
        const st = node_fs_1.default.statSync(file);
        if (!st.isFile() || st.size > MANIFEST_CAP)
            return null;
        const raw = JSON.parse(node_fs_1.default.readFileSync(file, 'utf-8'));
        const skills = [];
        if (Array.isArray(raw.skills)) {
            for (const s of raw.skills) {
                if (!s || typeof s.name !== 'string' || !s.name.trim())
                    continue;
                const version = Number(s.version);
                if (!Number.isInteger(version) || version < 1)
                    continue;
                const entry = { name: slugifySkillName(s.name), version };
                if (typeof s.tool === 'string' && LINKABLE_TOOLS.includes(s.tool)) {
                    entry.tool = s.tool;
                }
                skills.push(entry);
            }
        }
        return { version: 1, skills };
    }
    catch {
        return null;
    }
}
function writeManifest(projectPath, manifest) {
    const file = skillsManifestPath(projectPath);
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(file), { recursive: true });
    const out = JSON.stringify({ version: 1, skills: manifest.skills.map(s => ({ name: slugifySkillName(s.name), version: s.version, ...(s.tool ? { tool: s.tool } : {}) })) }, null, 2) + '\n';
    const tmp = `${file}.tmp-${process.pid}`;
    node_fs_1.default.writeFileSync(tmp, out, 'utf-8');
    node_fs_1.default.renameSync(tmp, file);
}
// ---------------------------------------------------------------------------
// Plan / apply
// ---------------------------------------------------------------------------
/** Resolve a symlink's target against its own directory; null when not a symlink. */
function linkTarget(linkPath) {
    try {
        const target = node_fs_1.default.readlinkSync(linkPath);
        return node_path_1.default.resolve(node_path_1.default.dirname(linkPath), target);
    }
    catch {
        return null;
    }
}
function versionFromStorePath(storeRoot, target) {
    if (!isInsideDir(storeRoot, target))
        return undefined;
    const m = /[\\/]v(\d+)$/.exec(target);
    return m ? Number(m[1]) : undefined;
}
function computePlan(storeRoot, projectPath, manifest) {
    const items = [];
    // Keyed by `<skillsDir>|<slug>` so a tool change orphans the old root's link.
    const manifestLinks = new Set(manifest.skills.map(s => `${node_path_1.default.join(projectToolRoot(projectPath, s.tool ?? 'claude'), 'skills')}|${slugifySkillName(s.name)}`));
    for (const entry of manifest.skills) {
        const slug = slugifySkillName(entry.name);
        const tool = entry.tool ?? 'claude';
        const linkPath = node_path_1.default.join(projectToolRoot(projectPath, tool), 'skills', slug);
        const versions = listVersions(storeRoot, slug);
        const desired = storeVersionDir(storeRoot, slug, entry.version);
        const base = { name: slug, linkPath, tool, desiredVersion: entry.version };
        if (versions.length === 0) {
            items.push({ ...base, action: 'missing-skill', detail: 'Not in the store' });
            continue;
        }
        if (!versions.includes(entry.version)) {
            items.push({ ...base, action: 'missing-version', detail: `v${entry.version} not in the store (has ${versions.map(v => `v${v}`).join(', ')})` });
            continue;
        }
        let lst = null;
        try {
            lst = node_fs_1.default.lstatSync(linkPath);
        }
        catch { /* absent */ }
        if (!lst) {
            items.push({ ...base, action: 'link' });
            continue;
        }
        if (lst.isSymbolicLink()) {
            const target = linkTarget(linkPath);
            if (target && node_path_1.default.resolve(target) === node_path_1.default.resolve(desired)) {
                items.push({ ...base, action: 'ok', currentVersion: entry.version });
            }
            else if (target && isInsideDir(storeRoot, target)) {
                items.push({ ...base, action: 'relink', currentVersion: versionFromStorePath(storeRoot, target) });
            }
            else {
                items.push({ ...base, action: 'conflict', detail: 'Symlink points outside the store' });
            }
            continue;
        }
        items.push({ ...base, action: 'conflict', detail: 'A local copy exists at this path' });
    }
    // Orphaned managed links: symlinks into the store whose slug left the manifest.
    const seenRoots = new Set();
    for (const tool of LINKABLE_TOOLS) {
        const skillsDir = node_path_1.default.join(projectToolRoot(projectPath, tool), 'skills');
        if (seenRoots.has(skillsDir))
            continue;
        seenRoots.add(skillsDir);
        let entries;
        try {
            entries = node_fs_1.default.readdirSync(skillsDir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const e of entries) {
            if (!e.isSymbolicLink())
                continue;
            if (manifestLinks.has(`${skillsDir}|${e.name}`))
                continue;
            const linkPath = node_path_1.default.join(skillsDir, e.name);
            const target = linkTarget(linkPath);
            if (!target || !isInsideDir(storeRoot, target))
                continue;
            items.push({
                name: e.name,
                action: 'unlink',
                linkPath,
                tool,
                currentVersion: versionFromStorePath(storeRoot, target),
                detail: 'No longer in the manifest',
            });
        }
    }
    return { projectPath, items };
}
function makeLink(target, linkPath) {
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(linkPath), { recursive: true });
    node_fs_1.default.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}
/** Remove a symlink (junction-safe). Never follows into the target. */
function removeLink(linkPath) {
    try {
        node_fs_1.default.unlinkSync(linkPath);
    }
    catch {
        node_fs_1.default.rmdirSync(linkPath);
    }
}
function applyManifest(storeRoot, projectPath, manifest, opts) {
    const replace = new Set(opts?.replaceConflicts ?? []);
    // `only` scopes execution to named entries so a row-level action's blast
    // radius is exactly its label — the header Apply omits it and runs the plan.
    const only = opts?.only ? new Set(opts.only) : null;
    const plan = computePlan(storeRoot, projectPath, manifest);
    const result = { ok: true, linked: [], unlinked: [], skipped: [], errors: [] };
    for (const item of plan.items) {
        if (only && !only.has(item.name))
            continue;
        try {
            switch (item.action) {
                case 'ok':
                    break;
                case 'link': {
                    makeLink(storeVersionDir(storeRoot, item.name, item.desiredVersion), item.linkPath);
                    result.linked.push(item.name);
                    break;
                }
                case 'relink': {
                    // Managed link (plan verified its target is inside the store) — swap it.
                    removeLink(item.linkPath);
                    makeLink(storeVersionDir(storeRoot, item.name, item.desiredVersion), item.linkPath);
                    result.linked.push(item.name);
                    break;
                }
                case 'conflict': {
                    if (!replace.has(item.name)) {
                        result.skipped.push({ name: item.name, reason: item.detail || 'Conflict' });
                        break;
                    }
                    // Explicit opt-in: replace the local copy/foreign link with a managed link.
                    node_fs_1.default.rmSync(item.linkPath, { recursive: true, force: true });
                    makeLink(storeVersionDir(storeRoot, item.name, item.desiredVersion), item.linkPath);
                    result.linked.push(item.name);
                    break;
                }
                case 'unlink': {
                    // Re-verify at execution time: only ever remove a link into the store.
                    const target = linkTarget(item.linkPath);
                    if (target && isInsideDir(storeRoot, target)) {
                        removeLink(item.linkPath);
                        result.unlinked.push(item.name);
                    }
                    else {
                        result.skipped.push({ name: item.name, reason: 'Not a managed link anymore' });
                    }
                    break;
                }
                case 'missing-skill':
                case 'missing-version':
                    result.skipped.push({ name: item.name, reason: item.detail || item.action });
                    break;
            }
        }
        catch (err) {
            result.errors.push({ name: item.name, error: err.message });
        }
    }
    result.ok = result.errors.length === 0;
    return result;
}
