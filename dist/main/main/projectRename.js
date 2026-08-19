"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.renameProject = renameProject;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const WINDOWS_INVALID_FOLDER_CHARS = /[<>:"/\\|?*\x00]/;
const WINDOWS_RESERVED_FOLDER_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
/**
 * A project's display label is free-form: it is only ever shown in the
 * sidebar, so none of the folder-name restrictions below apply to it.
 */
function validateProjectLabel(rawName) {
    const name = rawName.trim();
    if (!name) {
        throw new Error('Project name cannot be empty.');
    }
    return name;
}
function validateProjectFolderName(rawName) {
    const name = rawName.trim();
    if (!name) {
        throw new Error('Project name cannot be empty.');
    }
    if (name === '.' || name === '..') {
        throw new Error('Project name cannot be "." or "..".');
    }
    if (WINDOWS_INVALID_FOLDER_CHARS.test(name)) {
        throw new Error('Project folder names cannot contain < > : " / \\ | ? * or null characters.');
    }
    if (/[. ]$/.test(name)) {
        throw new Error('Project folder names cannot end with a space or period.');
    }
    if (WINDOWS_RESERVED_FOLDER_NAMES.test(name)) {
        throw new Error(`"${name}" is reserved by Windows and cannot be used as a project folder name.`);
    }
    return name;
}
function comparablePath(value) {
    const resolved = path_1.default.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function pathsReferToSameEntry(a, b) {
    try {
        const aStat = fs_1.default.statSync(a);
        const bStat = fs_1.default.statSync(b);
        if (aStat.dev === bStat.dev && aStat.ino === bStat.ino && aStat.ino !== 0) {
            return true;
        }
    }
    catch {
        return false;
    }
    try {
        const aReal = fs_1.default.realpathSync.native(a);
        const bReal = fs_1.default.realpathSync.native(b);
        return comparablePath(aReal) === comparablePath(bReal);
    }
    catch {
        return false;
    }
}
function assertCanRenameLocalProject(oldRootPath, newRootPath) {
    if (!path_1.default.isAbsolute(oldRootPath)) {
        throw new Error(`Project root is not an absolute path: ${oldRootPath}`);
    }
    const parentPath = path_1.default.dirname(oldRootPath);
    if (comparablePath(parentPath) === comparablePath(oldRootPath)) {
        throw new Error('Cannot rename a filesystem root folder.');
    }
    if (!fs_1.default.existsSync(oldRootPath)) {
        if (!fs_1.default.existsSync(newRootPath)) {
            throw new Error(`Project folder does not exist: ${oldRootPath}`);
        }
        const newRootStats = fs_1.default.statSync(newRootPath);
        if (!newRootStats.isDirectory()) {
            throw new Error(`Project folder does not exist and target path is not a folder: ${newRootPath}`);
        }
        return 'rebase-only';
    }
    const stats = fs_1.default.statSync(oldRootPath);
    if (!stats.isDirectory()) {
        throw new Error(`Project root is not a folder: ${oldRootPath}`);
    }
    if (!fs_1.default.existsSync(newRootPath) || pathsReferToSameEntry(oldRootPath, newRootPath)) {
        return 'rename';
    }
    throw new Error(`A folder already exists at: ${newRootPath}`);
}
function rebasePath(value, oldRootPath, newRootPath) {
    if (!path_1.default.isAbsolute(value)) {
        return value;
    }
    const relative = path_1.default.relative(oldRootPath, value);
    if (relative === '') {
        return newRootPath;
    }
    if (relative && !relative.startsWith('..') && !path_1.default.isAbsolute(relative)) {
        return path_1.default.join(newRootPath, relative);
    }
    return value;
}
function rebaseOptionalPath(value, oldRootPath, newRootPath) {
    return typeof value === 'string'
        ? rebasePath(value, oldRootPath, newRootPath)
        : value;
}
function rebaseHttpFormBody(fields, oldRootPath, newRootPath) {
    return fields?.map((field) => ({
        ...field,
        filePath: rebaseOptionalPath(field.filePath, oldRootPath, newRootPath),
    }));
}
function rebaseHttpTab(tab, oldRootPath, newRootPath) {
    return {
        ...tab,
        formBody: rebaseHttpFormBody(tab.formBody, oldRootPath, newRootPath),
        sourceFilePath: rebaseOptionalPath(tab.sourceFilePath, oldRootPath, newRootPath),
        fileBodyPath: rebaseOptionalPath(tab.fileBodyPath, oldRootPath, newRootPath),
    };
}
function rebaseDatabaseState(database, oldRootPath, newRootPath) {
    if (!database)
        return undefined;
    return {
        ...database,
        activeConnectionId: database.activeConnectionId ?? null,
        query: database.query ?? 'select 1;',
        history: database.history ?? [],
        connections: (database.connections ?? []).map((connection) => connection.engine === 'sqlite'
            ? { ...connection, database: rebasePath(connection.database, oldRootPath, newRootPath) }
            : connection),
    };
}
function rebaseProjectPaths(project, oldRootPath, newRootPath) {
    const database = rebaseDatabaseState(project.outputPanel.database, oldRootPath, newRootPath);
    const worktreeColors = project.worktreeColors
        ? Object.fromEntries(Object.entries(project.worktreeColors).map(([worktreePath, color]) => [
            rebasePath(worktreePath, oldRootPath, newRootPath),
            color,
        ]))
        : undefined;
    return {
        ...project,
        rootPath: newRootPath,
        terminals: project.terminals.map((terminal) => ({
            ...terminal,
            cwd: rebasePath(terminal.cwd, oldRootPath, newRootPath),
            worktreePath: rebaseOptionalPath(terminal.worktreePath, oldRootPath, newRootPath),
        })),
        openFiles: project.openFiles.map((filePath) => rebasePath(filePath, oldRootPath, newRootPath)),
        activeFile: rebaseOptionalPath(project.activeFile, oldRootPath, newRootPath),
        fileTree: {
            ...project.fileTree,
            expandedPaths: project.fileTree.expandedPaths.map((expandedPath) => rebasePath(expandedPath, oldRootPath, newRootPath)),
        },
        outputPanel: {
            ...project.outputPanel,
            http: {
                ...project.outputPanel.http,
                tabs: project.outputPanel.http.tabs?.map((tab) => rebaseHttpTab(tab, oldRootPath, newRootPath)),
                importSources: project.outputPanel.http.importSources?.map((source) => ({
                    ...source,
                    sourcePath: rebasePath(source.sourcePath, oldRootPath, newRootPath),
                })),
            },
            ...(database ? { database } : {}),
        },
        prototypeSpec: project.prototypeSpec
            ? {
                ...project.prototypeSpec,
                root: rebasePath(project.prototypeSpec.root, oldRootPath, newRootPath),
            }
            : project.prototypeSpec,
        ...(worktreeColors ? { worktreeColors } : {}),
    };
}
/**
 * Turn a failed `fs.renameSync` into something the user can act on. The raw
 * errno message ("EBUSY: resource busy or locked, rename 'D:\…' -> 'D:\…'")
 * reads like a crash and says nothing about what to do next.
 */
function describeFolderRenameFailure(error, oldRootPath, newRootPath) {
    const code = error?.code;
    const move = `"${path_1.default.basename(oldRootPath)}" to "${path_1.default.basename(newRootPath)}"`;
    // Windows refuses to rename a directory while any process holds a handle
    // into it — including this app's own terminals, file watchers and language
    // servers. Nothing was changed, so the user can simply retry.
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        const reason = code === 'EBUSY' ? 'it is in use' : 'access to it was denied';
        return (`Could not rename the folder ${move} because ${reason}.\n\n` +
            `${oldRootPath}\n\n` +
            'Close the terminals, editors and other programs working inside that ' +
            'folder, then try again. Nothing was changed — use Rename if you only ' +
            'want to change the name shown in 1DevTool.');
    }
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not rename the folder ${move}.\n\n${detail}`;
}
function renameProject(project, rawName, options = {}) {
    const oldRootPath = project.rootPath;
    // Label-only rename (the default), and the only thing a rename can mean for
    // a remote project. Touches no filesystem, so no stored path moves and
    // nothing can fail because the folder happens to be busy.
    if (!options.renameFolder || project.sourceType === 'ssh') {
        return {
            project: { ...project, name: validateProjectLabel(rawName) },
            oldRootPath,
            newRootPath: oldRootPath,
        };
    }
    const name = validateProjectFolderName(rawName);
    const newRootPath = path_1.default.join(path_1.default.dirname(oldRootPath), name);
    const folderMode = assertCanRenameLocalProject(oldRootPath, newRootPath);
    if (folderMode === 'rename' && oldRootPath !== newRootPath) {
        try {
            fs_1.default.renameSync(oldRootPath, newRootPath);
        }
        catch (error) {
            throw new Error(describeFolderRenameFailure(error, oldRootPath, newRootPath));
        }
    }
    return {
        project: {
            ...rebaseProjectPaths(project, oldRootPath, newRootPath),
            name,
        },
        oldRootPath,
        newRootPath,
    };
}
