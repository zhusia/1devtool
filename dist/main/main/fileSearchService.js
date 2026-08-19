"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkspaceFileSearchService = exports.WorkspaceSearchCancelledError = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const fileSearch_1 = require("../shared/fileSearch");
const env_1 = require("./utils/env");
const MAX_SEARCH_FILE_BYTES = 256 * 1024;
const MAX_MATCHES_PER_FILE = 5;
const MAX_PATH_RESULT_LIMIT = 500;
const MAX_CONTENT_RESULT_LIMIT = 1000;
const RIPGREP_TIMEOUT_MS = 15_000;
const FALLBACK_READ_CONCURRENCY = 8;
const ALWAYS_VISIBLE_ENV_FILE = /^\.env(?:\..+)?$/;
const BINARY_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp', '.bmp', '.avif',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.avi', '.mov',
    '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.exe', '.dll', '.so', '.dylib', '.o', '.a',
    '.sqlite', '.sqlite3', '.db', '.lock',
    '.wasm', '.node',
]);
class WorkspaceSearchCancelledError extends Error {
    constructor() {
        super('Workspace search cancelled');
        this.name = 'WorkspaceSearchCancelledError';
    }
}
exports.WorkspaceSearchCancelledError = WorkspaceSearchCancelledError;
class WorkspaceFileSearchService {
    options;
    activeSearches = new Map();
    rgCommand;
    constructor(options) {
        this.options = options;
        this.rgCommand = options.rgCommand ?? 'rg';
    }
    async search(request) {
        this.cancel(request.scopeId);
        const active = {
            requestId: request.requestId,
            controller: new AbortController(),
            children: new Set(),
        };
        this.activeSearches.set(request.scopeId, active);
        try {
            const normalizedRequest = await this.normalizeRequest(request, active.controller.signal);
            let results;
            const [pathAttempt, contentAttempt] = await Promise.allSettled([
                this.searchPathsWithRipgrep(normalizedRequest, active),
                this.searchContentWithRipgrep(normalizedRequest, active),
            ]);
            throwIfAborted(active.controller.signal);
            if (pathAttempt.status === 'fulfilled' && contentAttempt.status === 'fulfilled') {
                results = {
                    pathResults: pathAttempt.value.results,
                    contentResults: contentAttempt.value.results,
                    pathLimitHit: pathAttempt.value.limitHit,
                    contentLimitHit: contentAttempt.value.limitHit,
                };
            }
            else {
                // `rg` is optional and is commonly absent on a clean Windows install.
                // Fall back only on process failure, never merely because there were
                // zero matches; zero-match fallback caused every miss to scan twice.
                results = await this.searchWithFileSystem(normalizedRequest, active.controller.signal);
            }
            return {
                requestId: request.requestId,
                ...results,
            };
        }
        finally {
            const current = this.activeSearches.get(request.scopeId);
            if (current === active) {
                this.activeSearches.delete(request.scopeId);
            }
            this.killChildren(active);
        }
    }
    cancel(scopeId, requestId) {
        const active = this.activeSearches.get(scopeId);
        if (!active || (requestId && active.requestId !== requestId))
            return;
        this.activeSearches.delete(scopeId);
        active.controller.abort();
        this.killChildren(active);
    }
    async normalizeRequest(request, signal) {
        const rootPath = path_1.default.resolve(request.rootPath);
        const query = request.query.trim();
        if (!query)
            throw new Error('Search query is empty');
        // Compile once up front so an invalid expression fails before any walk or
        // child process starts.
        (0, fileSearch_1.compileWorkspaceSearchQuery)(query, request);
        const stats = await fs_1.default.promises.stat(rootPath);
        throwIfAborted(signal);
        if (!stats.isDirectory()) {
            throw new Error(`Search root is not a directory: ${rootPath}`);
        }
        return {
            ...request,
            rootPath,
            query,
            maxPathResults: clampLimit(request.maxPathResults, 1, MAX_PATH_RESULT_LIMIT),
            maxContentResults: clampLimit(request.maxContentResults, 1, MAX_CONTENT_RESULT_LIMIT),
            pathFilter: (0, fileSearch_1.createWorkspaceSearchPathFilter)(request.includeGlobs, request.excludeGlobs),
        };
    }
    async searchPathsWithRipgrep(request, active) {
        const matcher = (0, fileSearch_1.compileWorkspaceSearchQuery)(request.query, request);
        const candidates = new Map();
        const candidateLimit = Math.max(request.maxPathResults + 1, request.maxPathResults * 4);
        let pending = Buffer.alloc(0);
        let stoppedAtLimit = false;
        const consumePath = (rawPath) => {
            const relativePath = (0, fileSearch_1.normalizeWorkspaceSearchPath)(rawPath);
            if (!relativePath)
                return false;
            const segments = relativePath.split('/');
            for (let index = 1; index < segments.length; index += 1) {
                const directoryPath = segments.slice(0, index).join('/');
                this.addPathCandidate(request, matcher, candidates, directoryPath, true);
            }
            this.addPathCandidate(request, matcher, candidates, relativePath, false);
            if (candidates.size >= candidateLimit) {
                stoppedAtLimit = true;
                return true;
            }
            return false;
        };
        await this.runRipgrep(request, active, this.buildRipgrepFileArgs(request), (chunk) => {
            pending = Buffer.concat([pending, chunk]);
            let separatorIndex = pending.indexOf(0);
            while (separatorIndex >= 0) {
                const entry = pending.subarray(0, separatorIndex).toString('utf8');
                pending = pending.subarray(separatorIndex + 1);
                if (consumePath(entry))
                    return true;
                separatorIndex = pending.indexOf(0);
            }
            return false;
        });
        if (pending.length > 0 && !stoppedAtLimit) {
            consumePath(pending.toString('utf8'));
        }
        const sorted = [...candidates.values()].sort((left, right) => comparePathResults(left, right, request.query, request.caseSensitive, request.useRegex));
        return {
            results: sorted.slice(0, request.maxPathResults),
            limitHit: stoppedAtLimit || sorted.length > request.maxPathResults,
        };
    }
    addPathCandidate(request, matcher, candidates, relativePath, isDirectory) {
        if (!request.pathFilter.accepts(relativePath, isDirectory))
            return;
        if (request.pathMatchMode === 'fuzzy') {
            if (!isFuzzyPathMatch(relativePath, request.query, request.caseSensitive))
                return;
        }
        else {
            matcher.lastIndex = 0;
            if (!matcher.test(relativePath))
                return;
        }
        const key = process.platform === 'win32' ? relativePath.toLowerCase() : relativePath;
        if (candidates.has(key))
            return;
        candidates.set(key, {
            path: path_1.default.resolve(request.rootPath, ...relativePath.split('/')),
            relativePath,
            name: relativePath.slice(relativePath.lastIndexOf('/') + 1),
            isDirectory,
        });
    }
    async searchContentWithRipgrep(request, active) {
        const results = [];
        const matchesPerFile = new Map();
        let pending = '';
        let stoppedAtLimit = false;
        const consumeLine = (line) => {
            if (!line)
                return false;
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                return false;
            }
            if (parsed.type !== 'match' || !parsed.data?.path?.text || !parsed.data.lines?.text) {
                return false;
            }
            const relativePath = (0, fileSearch_1.normalizeWorkspaceSearchPath)(parsed.data.path.text);
            if (!request.pathFilter.accepts(relativePath, false))
                return false;
            const filePath = path_1.default.resolve(request.rootPath, ...relativePath.split('/'));
            const lineContent = parsed.data.lines.text.replace(/\r?\n$/, '');
            const lineBuffer = Buffer.from(lineContent, 'utf8');
            let fileMatchCount = matchesPerFile.get(relativePath) ?? 0;
            for (const submatch of parsed.data.submatches ?? []) {
                if (fileMatchCount >= MAX_MATCHES_PER_FILE)
                    break;
                const matchStart = lineBuffer.subarray(0, submatch.start).toString('utf8').length;
                const matchEnd = lineBuffer.subarray(0, submatch.end).toString('utf8').length;
                results.push({
                    filePath,
                    lineNumber: parsed.data.line_number,
                    lineContent,
                    matchStart,
                    matchEnd,
                });
                fileMatchCount += 1;
                if (results.length >= request.maxContentResults) {
                    stoppedAtLimit = true;
                    break;
                }
            }
            matchesPerFile.set(relativePath, fileMatchCount);
            return stoppedAtLimit;
        };
        await this.runRipgrep(request, active, this.buildRipgrepContentArgs(request), (chunk) => {
            pending += chunk.toString('utf8');
            let lineBreakIndex = pending.indexOf('\n');
            while (lineBreakIndex >= 0) {
                const line = pending.slice(0, lineBreakIndex);
                pending = pending.slice(lineBreakIndex + 1);
                if (consumeLine(line))
                    return true;
                lineBreakIndex = pending.indexOf('\n');
            }
            return false;
        });
        if (pending && !stoppedAtLimit)
            consumeLine(pending);
        return { results, limitHit: stoppedAtLimit };
    }
    buildRipgrepFileArgs(request) {
        const args = ['--files', '--null', '--no-messages'];
        this.appendRipgrepTraversalArgs(args, request);
        return args;
    }
    buildRipgrepContentArgs(request) {
        const args = [
            '--json',
            '--line-number',
            '--max-count', String(MAX_MATCHES_PER_FILE),
            '--no-messages',
            request.caseSensitive ? '--case-sensitive' : '--ignore-case',
        ];
        if (request.useRegex) {
            args.push('--pcre2');
        }
        else {
            args.push('--fixed-strings');
        }
        if (request.wholeWord)
            args.push('--word-regexp');
        this.appendRipgrepTraversalArgs(args, request);
        args.push('--', request.query, '.');
        return args;
    }
    appendRipgrepTraversalArgs(args, request) {
        if (!request.respectGitignore) {
            args.push('--no-ignore', '--no-ignore-parent');
        }
        if (request.includeHidden)
            args.push('--hidden');
        for (const pattern of expandRipgrepExcludeGlobs(request.excludeGlobs)) {
            args.push('--glob', `!${pattern}`);
        }
    }
    runRipgrep(request, active, args, onStdout) {
        throwIfAborted(active.controller.signal);
        return new Promise((resolve, reject) => {
            const child = (0, child_process_1.spawn)(this.rgCommand, [...(this.options.rgArgsPrefix ?? []), ...args], {
                cwd: request.rootPath,
                env: { ...process.env, PATH: (0, env_1.getEnrichedPath)() },
                stdio: 'pipe',
                windowsHide: true,
            });
            active.children.add(child);
            let settled = false;
            let stoppedEarly = false;
            let stderr = '';
            const cleanup = () => {
                clearTimeout(timeout);
                active.controller.signal.removeEventListener('abort', handleAbort);
                active.children.delete(child);
            };
            const finish = (error) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                if (error)
                    reject(error);
                else
                    resolve();
            };
            const handleAbort = () => {
                child.kill();
                finish(new WorkspaceSearchCancelledError());
            };
            const timeout = setTimeout(() => {
                child.kill();
                finish(new Error(`ripgrep timed out after ${RIPGREP_TIMEOUT_MS}ms`));
            }, RIPGREP_TIMEOUT_MS);
            active.controller.signal.addEventListener('abort', handleAbort, { once: true });
            child.stdout.on('data', (chunk) => {
                if (settled || stoppedEarly)
                    return;
                try {
                    if (onStdout(chunk)) {
                        stoppedEarly = true;
                        child.kill();
                    }
                }
                catch (error) {
                    child.kill();
                    finish(error instanceof Error ? error : new Error(String(error)));
                }
            });
            child.stderr.on('data', (chunk) => {
                if (stderr.length < 4096)
                    stderr += chunk.toString('utf8');
            });
            child.on('error', (error) => finish(error));
            child.on('close', (code) => {
                if (active.controller.signal.aborted) {
                    finish(new WorkspaceSearchCancelledError());
                    return;
                }
                if (stoppedEarly || code === 0 || code === 1) {
                    finish();
                    return;
                }
                finish(new Error(stderr.trim() || `ripgrep exited with code ${code ?? 'unknown'}`));
            });
        });
    }
    async searchWithFileSystem(request, signal) {
        const ignoredPaths = request.respectGitignore
            ? await this.options.getIgnoredPaths(request.rootPath)
            : new Set();
        throwIfAborted(signal);
        const pathMatcher = (0, fileSearch_1.compileWorkspaceSearchQuery)(request.query, request);
        const pathCandidates = new Map();
        const pathCandidateLimit = Math.max(request.maxPathResults + 1, request.maxPathResults * 4);
        const contentResults = [];
        const directoryQueue = [request.rootPath];
        let directoryIndex = 0;
        let pathLimitHit = false;
        let contentLimitHit = false;
        while (directoryIndex < directoryQueue.length) {
            throwIfAborted(signal);
            if (pathLimitHit && contentLimitHit)
                break;
            const currentDirectory = directoryQueue[directoryIndex];
            directoryIndex += 1;
            let entries;
            try {
                entries = await fs_1.default.promises.readdir(currentDirectory, { withFileTypes: true });
            }
            catch {
                continue;
            }
            throwIfAborted(signal);
            const contentCandidates = [];
            for (const entry of entries) {
                throwIfAborted(signal);
                if (entry.isSymbolicLink())
                    continue;
                if (!request.includeHidden && entry.name.startsWith('.') && !ALWAYS_VISIBLE_ENV_FILE.test(entry.name)) {
                    continue;
                }
                const fullPath = path_1.default.join(currentDirectory, entry.name);
                const relativePath = (0, fileSearch_1.normalizeWorkspaceSearchPath)(path_1.default.relative(request.rootPath, fullPath));
                if (!relativePath || request.pathFilter.excludes(relativePath))
                    continue;
                if (request.respectGitignore && this.options.isIgnoredPath(fullPath, ignoredPaths))
                    continue;
                if (entry.isDirectory()) {
                    if (!pathLimitHit) {
                        this.addPathCandidate(request, pathMatcher, pathCandidates, relativePath, true);
                        if (pathCandidates.size >= pathCandidateLimit)
                            pathLimitHit = true;
                    }
                    directoryQueue.push(fullPath);
                    continue;
                }
                if (!entry.isFile())
                    continue;
                if (!pathLimitHit) {
                    this.addPathCandidate(request, pathMatcher, pathCandidates, relativePath, false);
                    if (pathCandidates.size >= pathCandidateLimit)
                        pathLimitHit = true;
                }
                if (!contentLimitHit && request.pathFilter.accepts(relativePath, false)) {
                    contentCandidates.push({ fullPath, relativePath });
                }
            }
            for (let index = 0; index < contentCandidates.length && !contentLimitHit; index += FALLBACK_READ_CONCURRENCY) {
                throwIfAborted(signal);
                const batch = contentCandidates.slice(index, index + FALLBACK_READ_CONCURRENCY);
                const batchMatches = await Promise.all(batch.map((candidate) => this.searchFileContent(candidate.fullPath, request, signal)));
                for (const matches of batchMatches) {
                    for (const match of matches) {
                        if (contentResults.length >= request.maxContentResults) {
                            contentLimitHit = true;
                            break;
                        }
                        contentResults.push(match);
                        if (contentResults.length >= request.maxContentResults) {
                            contentLimitHit = true;
                            break;
                        }
                    }
                    if (contentLimitHit)
                        break;
                }
            }
        }
        const sortedPaths = [...pathCandidates.values()].sort((left, right) => comparePathResults(left, right, request.query, request.caseSensitive, request.useRegex));
        return {
            pathResults: sortedPaths.slice(0, request.maxPathResults),
            contentResults,
            pathLimitHit: pathLimitHit || sortedPaths.length > request.maxPathResults,
            contentLimitHit,
        };
    }
    async searchFileContent(filePath, request, signal) {
        if (BINARY_EXTENSIONS.has(path_1.default.extname(filePath).toLowerCase()))
            return [];
        let handle = null;
        try {
            handle = await fs_1.default.promises.open(filePath, 'r');
            const stats = await handle.stat();
            throwIfAborted(signal);
            if (stats.size === 0 || stats.size > MAX_SEARCH_FILE_BYTES || !stats.isFile())
                return [];
            const buffer = await handle.readFile();
            throwIfAborted(signal);
            if (buffer.includes(0))
                return [];
            const matcher = (0, fileSearch_1.compileWorkspaceSearchQuery)(request.query, request, true);
            const results = [];
            const lines = buffer.toString('utf8').split(/\r?\n/);
            for (let lineIndex = 0; lineIndex < lines.length && results.length < MAX_MATCHES_PER_FILE; lineIndex += 1) {
                const line = lines[lineIndex];
                const matches = (0, fileSearch_1.findWorkspaceSearchMatches)(line, matcher, MAX_MATCHES_PER_FILE - results.length);
                for (const match of matches) {
                    results.push({
                        filePath,
                        lineNumber: lineIndex + 1,
                        lineContent: line,
                        matchStart: match.start,
                        matchEnd: match.end,
                    });
                }
            }
            return results;
        }
        catch (error) {
            if (error instanceof WorkspaceSearchCancelledError)
                throw error;
            return [];
        }
        finally {
            await handle?.close().catch(() => undefined);
        }
    }
    killChildren(active) {
        for (const child of active.children) {
            if (!child.killed)
                child.kill();
        }
        active.children.clear();
    }
}
exports.WorkspaceFileSearchService = WorkspaceFileSearchService;
function clampLimit(value, minimum, maximum) {
    if (!Number.isFinite(value))
        return minimum;
    return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
function throwIfAborted(signal) {
    if (signal.aborted)
        throw new WorkspaceSearchCancelledError();
}
function expandRipgrepExcludeGlobs(patterns) {
    const expanded = new Set();
    for (const rawPattern of patterns) {
        const pattern = (0, fileSearch_1.normalizeWorkspaceSearchPath)(rawPattern);
        if (!pattern)
            continue;
        expanded.add(pattern);
        const hasGlob = /[*?{[]/.test(pattern);
        if (hasGlob)
            continue;
        if (pattern.includes('/')) {
            expanded.add(`${pattern}/**`);
        }
        else {
            expanded.add(`**/${pattern}`);
            expanded.add(`**/${pattern}/**`);
        }
    }
    return [...expanded];
}
function comparePathResults(left, right, query, caseSensitive, useRegex) {
    const leftRank = rankPathResult(left, query, caseSensitive, useRegex);
    const rightRank = rankPathResult(right, query, caseSensitive, useRegex);
    if (leftRank !== rightRank)
        return leftRank - rightRank;
    const depthDifference = countPathSegments(left.relativePath) - countPathSegments(right.relativePath);
    if (depthDifference !== 0)
        return depthDifference;
    if (left.isDirectory !== right.isDirectory)
        return left.isDirectory ? -1 : 1;
    return left.relativePath.localeCompare(right.relativePath);
}
function rankPathResult(result, query, caseSensitive, useRegex) {
    if (useRegex)
        return 4;
    const name = caseSensitive ? result.name : result.name.toLowerCase();
    const relativePath = caseSensitive ? result.relativePath : result.relativePath.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    if (name === needle)
        return 0;
    if (name.startsWith(needle))
        return 1;
    if (name.includes(needle))
        return 2;
    if (relativePath.startsWith(needle))
        return 3;
    return 4;
}
function countPathSegments(relativePath) {
    let count = 1;
    for (const character of relativePath) {
        if (character === '/')
            count += 1;
    }
    return count;
}
function isFuzzyPathMatch(relativePath, query, caseSensitive) {
    const haystack = caseSensitive ? relativePath : relativePath.toLowerCase();
    const tokens = (caseSensitive ? query : query.toLowerCase()).split(/\s+/).filter(Boolean);
    return tokens.every((token) => {
        let tokenIndex = 0;
        for (const character of haystack) {
            if (character !== token[tokenIndex])
                continue;
            tokenIndex += 1;
            if (tokenIndex === token.length)
                return true;
        }
        return token.length === 0;
    });
}
