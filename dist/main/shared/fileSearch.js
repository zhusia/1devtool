"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_WORKSPACE_SEARCH_EXCLUDE_GLOBS = void 0;
exports.escapeSearchRegExp = escapeSearchRegExp;
exports.compileWorkspaceSearchQuery = compileWorkspaceSearchQuery;
exports.getWorkspaceSearchQueryError = getWorkspaceSearchQueryError;
exports.findWorkspaceSearchMatches = findWorkspaceSearchMatches;
exports.parseWorkspaceSearchGlobList = parseWorkspaceSearchGlobList;
exports.normalizeWorkspaceSearchPath = normalizeWorkspaceSearchPath;
exports.getWorkspaceRelativePath = getWorkspaceRelativePath;
exports.joinWorkspaceSearchPath = joinWorkspaceSearchPath;
exports.createWorkspaceSearchPathFilter = createWorkspaceSearchPathFilter;
exports.DEFAULT_WORKSPACE_SEARCH_EXCLUDE_GLOBS = [
    '**/.git/**',
    '**/node_modules/**',
    '**/bower_components/**',
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/.next/**',
    '**/.nuxt/**',
    '**/.cache/**',
    '**/.turbo/**',
    '**/coverage/**',
    '**/__pycache__/**',
    '**/target/**',
    '**/vendor/**',
    '**/playwright-report/**',
    '**/test-results/**',
    '**/release/**',
];
function escapeSearchRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function compileWorkspaceSearchQuery(query, options, global = false) {
    let pattern = options.useRegex ? query : escapeSearchRegExp(query);
    if (options.wholeWord) {
        pattern = `\\b(?:${pattern})\\b`;
    }
    return new RegExp(pattern, `${options.caseSensitive ? '' : 'i'}${global ? 'g' : ''}`);
}
function getWorkspaceSearchQueryError(query, options) {
    if (!query.trim() || !options.useRegex)
        return null;
    try {
        compileWorkspaceSearchQuery(query, options);
        return null;
    }
    catch (error) {
        return error instanceof Error ? error.message : 'Invalid regular expression';
    }
}
function findWorkspaceSearchMatches(line, matcher, limit) {
    const matches = [];
    const globalMatcher = matcher.global
        ? matcher
        : new RegExp(matcher.source, `${matcher.flags}g`);
    globalMatcher.lastIndex = 0;
    let match;
    while (matches.length < limit && (match = globalMatcher.exec(line)) !== null) {
        matches.push({ start: match.index, end: match.index + match[0].length });
        // A user regex may match an empty string. Advance manually so the search
        // cannot loop forever in either the main-process fallback or tests.
        if (match[0].length === 0) {
            globalMatcher.lastIndex += 1;
        }
    }
    return matches;
}
function parseWorkspaceSearchGlobList(input) {
    const patterns = [];
    let start = 0;
    let braceDepth = 0;
    let bracketDepth = 0;
    for (let index = 0; index < input.length; index += 1) {
        const character = input[index];
        if (character === '{')
            braceDepth += 1;
        if (character === '}' && braceDepth > 0)
            braceDepth -= 1;
        if (character === '[')
            bracketDepth += 1;
        if (character === ']' && bracketDepth > 0)
            bracketDepth -= 1;
        if (character === ',' && braceDepth === 0 && bracketDepth === 0) {
            const pattern = input.slice(start, index).trim();
            if (pattern)
                patterns.push(pattern);
            start = index + 1;
        }
    }
    const finalPattern = input.slice(start).trim();
    if (finalPattern)
        patterns.push(finalPattern);
    return patterns;
}
function normalizeWorkspaceSearchPath(value) {
    return value
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '')
        .replace(/\/{2,}/g, '/')
        .replace(/\/$/, '');
}
function getWorkspaceRelativePath(filePath, rootPath) {
    const normalizedFile = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedRoot = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
    const caseInsensitive = /^[A-Za-z]:\/?/.test(normalizedRoot) || normalizedRoot.startsWith('//');
    const comparableFile = caseInsensitive ? normalizedFile.toLowerCase() : normalizedFile;
    const comparableRoot = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
    if (comparableFile === comparableRoot)
        return '';
    if (!comparableFile.startsWith(comparableRoot + '/'))
        return null;
    return normalizedFile.slice(normalizedRoot.length + 1);
}
function joinWorkspaceSearchPath(basePath, childName) {
    const windowsPath = /^[A-Za-z]:[\\/]?/.test(basePath) || /^[\\/]{2}[^\\/]/.test(basePath);
    if (windowsPath) {
        const normalizedBase = basePath.replace(/\//g, '\\').replace(/\\+$/, '');
        const normalizedChild = childName.replace(/[\\/]+/g, '\\').replace(/^\\+/, '');
        return `${normalizedBase}\\${normalizedChild}`;
    }
    return `${basePath.replace(/\/+$/, '')}/${childName.replace(/^\/+/, '')}`;
}
function createWorkspaceSearchPathFilter(includeGlobs, excludeGlobs) {
    const includeMatchers = compileGlobMatchers(includeGlobs);
    const excludeMatchers = compileGlobMatchers(excludeGlobs);
    const excludes = (relativePath) => {
        const normalized = normalizeWorkspaceSearchPath(relativePath);
        if (!normalized)
            return false;
        return pathOrAncestorMatches(normalized, excludeMatchers);
    };
    return {
        excludes,
        accepts: (relativePath) => {
            const normalized = normalizeWorkspaceSearchPath(relativePath);
            if (!normalized || excludes(normalized))
                return false;
            if (includeMatchers.length === 0)
                return true;
            return pathOrAncestorMatches(normalized, includeMatchers);
        },
    };
}
function compileGlobMatchers(patterns) {
    const matchers = [];
    for (const pattern of patterns) {
        const matcher = workspaceGlobToRegExp(pattern);
        if (matcher)
            matchers.push(matcher);
    }
    return matchers;
}
function pathOrAncestorMatches(relativePath, matchers) {
    if (matchers.length === 0)
        return false;
    let candidate = relativePath;
    while (candidate) {
        for (const matcher of matchers) {
            if (matcher.test(candidate))
                return true;
        }
        const separatorIndex = candidate.lastIndexOf('/');
        if (separatorIndex < 0)
            break;
        candidate = candidate.slice(0, separatorIndex);
    }
    return false;
}
function workspaceGlobToRegExp(input) {
    let pattern = input.trim().replace(/\\/g, '/');
    if (!pattern)
        return null;
    pattern = pattern.replace(/^\.\//, '');
    const rooted = pattern.startsWith('/');
    pattern = pattern.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
    const hasPathSeparator = pattern.includes('/');
    try {
        const prefix = rooted || hasPathSeparator ? '^' : '(?:^|/)';
        return new RegExp(`${prefix}${globFragmentToRegExp(pattern)}$`);
    }
    catch {
        return null;
    }
}
function globFragmentToRegExp(pattern) {
    let output = '';
    for (let index = 0; index < pattern.length;) {
        const character = pattern[index];
        if (character === '/' && pattern.slice(index + 1) === '**') {
            output += '(?:/.*)?';
            break;
        }
        if (character === '*' && pattern[index + 1] === '*') {
            if (pattern[index + 2] === '/') {
                output += '(?:.*/)?';
                index += 3;
            }
            else {
                output += '.*';
                index += 2;
            }
            continue;
        }
        if (character === '*') {
            output += '[^/]*';
            index += 1;
            continue;
        }
        if (character === '?') {
            output += '[^/]';
            index += 1;
            continue;
        }
        if (character === '{') {
            const closingIndex = findClosingToken(pattern, index, '{', '}');
            if (closingIndex > index) {
                const alternatives = splitBraceAlternatives(pattern.slice(index + 1, closingIndex));
                output += `(?:${alternatives.map(globFragmentToRegExp).join('|')})`;
                index = closingIndex + 1;
                continue;
            }
        }
        if (character === '[') {
            const closingIndex = pattern.indexOf(']', index + 1);
            if (closingIndex > index + 1) {
                const rawClass = pattern.slice(index + 1, closingIndex);
                const characterClass = rawClass.startsWith('!')
                    ? `^${rawClass.slice(1)}`
                    : rawClass;
                output += `[${characterClass}]`;
                index = closingIndex + 1;
                continue;
            }
        }
        output += escapeSearchRegExp(character);
        index += 1;
    }
    return output;
}
function findClosingToken(value, start, opening, closing) {
    let depth = 0;
    for (let index = start; index < value.length; index += 1) {
        if (value[index] === opening)
            depth += 1;
        if (value[index] === closing) {
            depth -= 1;
            if (depth === 0)
                return index;
        }
    }
    return -1;
}
function splitBraceAlternatives(value) {
    const alternatives = [];
    let start = 0;
    let depth = 0;
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] === '{')
            depth += 1;
        if (value[index] === '}' && depth > 0)
            depth -= 1;
        if (value[index] === ',' && depth === 0) {
            alternatives.push(value.slice(start, index));
            start = index + 1;
        }
    }
    alternatives.push(value.slice(start));
    return alternatives;
}
