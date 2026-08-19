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
exports.parsePostman = parsePostman;
exports.parsePostmanEnvironment = parsePostmanEnvironment;
exports.parseInsomnia = parseInsomnia;
exports.parseInsomniaV5 = parseInsomniaV5;
exports.parseBrunoFolder = parseBrunoFolder;
exports.parsePostmanV3 = parsePostmanV3;
exports.importCollection = importCollection;
exports.detectHttpImportFile = detectHttpImportFile;
exports.importHttpFile = importHttpFile;
const promises_1 = require("fs/promises");
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const yaml_1 = require("yaml");
const httpFile_1 = require("../shared/httpFile");
const STANDARD_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const BRUNO_METHODS = [...STANDARD_HTTP_METHODS, 'CONNECT', 'TRACE'];
const MAX_IMPORT_FILE_BYTES = 20 * 1024 * 1024;
const SNIFF_BYTES = 4096;
const DETECT_CACHE_LIMIT = 1000;
const detectCache = new Map();
function sha1(input) {
    return (0, crypto_1.createHash)('sha1').update(input).digest('hex');
}
function normalizeMethod(method) {
    const upper = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';
    return upper;
}
function cleanSegment(value, fallback = 'Untitled') {
    const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
    return raw.replace(/\//g, '∕');
}
function joinName(parts) {
    return parts.map((part) => cleanSegment(part)).filter(Boolean).join(' / ');
}
function makeTab(partial) {
    return {
        id: (0, crypto_1.randomUUID)(),
        name: partial.name,
        method: partial.method,
        url: partial.url,
        headers: partial.headers ?? {},
        body: partial.body ?? '',
        auth: partial.auth ?? { type: 'none' },
        response: null,
        bodyType: partial.bodyType,
        formBody: partial.formBody,
        params: partial.params,
        sourceItemId: partial.sourceItemId,
        sourceFilePath: partial.sourceFilePath,
        preRequest: partial.preRequest,
        unsupported: partial.unsupported,
        docs: partial.docs,
        fileBodyPath: partial.fileBodyPath,
        tests: partial.tests,
    };
}
function getObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
function getString(value) {
    if (typeof value === 'string')
        return value;
    if (value == null)
        return '';
    return String(value);
}
function readScript(script) {
    if (typeof script === 'string')
        return script;
    const obj = getObject(script);
    const exec = obj.exec;
    if (Array.isArray(exec))
        return exec.map(getString).join('\n');
    if (typeof exec === 'string')
        return exec;
    return '';
}
function concatScripts(...scripts) {
    const joined = scripts.map((s) => s?.trim()).filter(Boolean).join('\n\n');
    return joined || undefined;
}
function appendQueryParams(url, params) {
    const enabled = params.filter((p) => p.enabled && p.key);
    if (!enabled.length)
        return url;
    const query = enabled
        .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
        .join('&');
    if (!query)
        return url;
    return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}
function bodyTypeFromMime(mimeType) {
    const mime = getString(mimeType).toLowerCase();
    if (!mime)
        return 'none';
    if (mime.includes('json') || mime.includes('graphql'))
        return 'json';
    if (mime.includes('xml'))
        return 'xml';
    if (mime.includes('x-www-form-urlencoded'))
        return 'form-urlencoded';
    if (mime.includes('multipart/form-data'))
        return 'form-data';
    return 'text';
}
function authPairs(auth, key) {
    const entries = auth[key];
    if (Array.isArray(entries)) {
        return Object.fromEntries(entries
            .map((entry) => getObject(entry))
            .map((entry) => [getString(entry.key), entry.value])
            .filter(([entryKey]) => Boolean(entryKey)));
    }
    return getObject(entries);
}
function normalizeApiKeyLocation(value) {
    const location = getString(value).toLowerCase();
    return location.includes('query') || location === 'queryparams' ? 'query' : 'header';
}
function warnUnsupportedAuth(warnings, tabName, type) {
    const authType = getString(type) || 'unknown';
    warnings.push(`${tabName}: unsupported auth type "${authType}", imported as none`);
    return { type: 'none' };
}
async function readTextWithCap(filePath) {
    const info = await (0, promises_1.stat)(filePath);
    if (!info.isFile())
        throw new Error(`${filePath} is not a file`);
    if (info.size > MAX_IMPORT_FILE_BYTES) {
        throw new Error(`Import source is ${(info.size / (1024 * 1024)).toFixed(1)} MB; the limit is 20 MB.`);
    }
    return (0, promises_1.readFile)(filePath, 'utf8');
}
async function readHead(filePath) {
    const info = await (0, promises_1.stat)(filePath);
    if (!info.isFile())
        return '';
    if (info.size > MAX_IMPORT_FILE_BYTES)
        return '';
    const handle = await (0, promises_1.open)(filePath, 'r');
    try {
        const buffer = Buffer.alloc(Math.min(SNIFF_BYTES, info.size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).toString('utf8');
    }
    finally {
        await handle.close();
    }
}
async function pathExists(filePath) {
    try {
        await (0, promises_1.stat)(filePath);
        return true;
    }
    catch {
        return false;
    }
}
async function findAncestorWithFile(startPath, fileName) {
    let current = (await (0, promises_1.stat)(startPath)).isDirectory() ? startPath : path.dirname(startPath);
    while (true) {
        if (await pathExists(path.join(current, fileName)))
            return current;
        const parent = path.dirname(current);
        if (parent === current)
            return null;
        current = parent;
    }
}
async function contentFingerprint(targetPath) {
    const info = await (0, promises_1.stat)(targetPath);
    return sha1(`${path.resolve(targetPath)}:${Math.round(info.mtimeMs)}:${info.size}`);
}
function sourceKeyFor(format, sourcePath, stableSourceId) {
    return sha1(`${format}:${path.resolve(sourcePath)}:${stableSourceId ?? ''}`);
}
function tagImported(imported, sourceId) {
    return {
        tabs: imported.tabs.map((tab) => ({ ...tab, sourceId })),
        environments: imported.environments.map((environment) => ({ ...environment, sourceId })),
    };
}
function postmanEvents(events) {
    const preRequest = concatScripts(...(events ?? []).filter((event) => event.listen === 'prerequest').map((event) => readScript(event.script)));
    const tests = concatScripts(...(events ?? []).filter((event) => event.listen === 'test').map((event) => readScript(event.script)));
    return { preRequest, tests };
}
function postmanVariablesToEnvironment(name, variables) {
    const values = (variables ?? [])
        .filter((v) => (v.key || v.name) && !v.disabled)
        .map((v) => ({
        key: v.key || v.name || '',
        value: getString(v.value),
        enabled: true,
    }));
    if (!values.length)
        return null;
    return { id: (0, crypto_1.randomUUID)(), name, variables: values };
}
function postmanUrl(url) {
    if (!url)
        return { url: '' };
    if (typeof url === 'string')
        return { url };
    const params = (url.query ?? [])
        .filter((q) => q.key)
        .map((q) => ({ key: q.key ?? '', value: q.value ?? '', enabled: !q.disabled }));
    let base = url.raw?.split('?')[0];
    if (!base) {
        const protocol = url.protocol ? `${url.protocol}://` : '';
        const host = Array.isArray(url.host) ? url.host.join('.') : getString(url.host);
        const port = url.port ? `:${url.port}` : '';
        const pathParts = Array.isArray(url.path) ? url.path.join('/') : getString(url.path);
        const pathStr = pathParts ? `/${pathParts}` : '';
        base = `${protocol}${host}${port}${pathStr}`;
    }
    return {
        url: params.length ? appendQueryParams(base, params) : url.raw ?? base,
        params: params.length ? params : undefined,
    };
}
function postmanHeaders(headers, warnings, tabName) {
    const out = {};
    for (const header of headers ?? []) {
        if (typeof header === 'string') {
            const idx = header.indexOf(':');
            if (idx > 0)
                out[header.slice(0, idx).trim()] = header.slice(idx + 1).trim();
            continue;
        }
        if (!header.key)
            continue;
        if (header.disabled) {
            warnings.push(`${tabName}: disabled header "${header.key}" was skipped because the header editor stores enabled headers only`);
            continue;
        }
        out[header.key] = header.value ?? '';
    }
    return out;
}
function postmanAuth(auth, inherited, warnings, tabName) {
    if (auth == null)
        return inherited;
    const type = (auth.type ?? 'noauth').toLowerCase();
    if (type === 'noauth')
        return { type: 'none' };
    if (type === 'bearer') {
        const pairs = authPairs(auth, 'bearer');
        return { type: 'bearer', token: getString(pairs.token) };
    }
    if (type === 'basic') {
        const pairs = authPairs(auth, 'basic');
        return { type: 'basic', username: getString(pairs.username), password: getString(pairs.password) };
    }
    if (type === 'apikey') {
        const pairs = authPairs(auth, 'apikey');
        return {
            type: 'apiKey',
            apiKeyName: getString(pairs.key),
            apiKeyValue: getString(pairs.value),
            apiKeyAddTo: normalizeApiKeyLocation(pairs.in ?? pairs.addTo),
        };
    }
    return warnUnsupportedAuth(warnings, tabName, type);
}
function postmanBody(body, warnings, tabName) {
    if (!body)
        return { body: '', bodyType: 'none' };
    if (body.mode === 'raw') {
        const language = body.options?.raw?.language?.toLowerCase();
        const bodyType = language === 'xml' ? 'xml' : language === 'text' ? 'text' : 'json';
        return { body: body.raw ?? '', bodyType };
    }
    if (body.mode === 'urlencoded') {
        const formBody = (body.urlencoded ?? [])
            .filter((p) => p.key)
            .map((p) => ({ key: p.key ?? '', value: p.value ?? '', enabled: !p.disabled, type: 'text' }));
        return { body: '', bodyType: 'form-urlencoded', formBody };
    }
    if (body.mode === 'formdata') {
        const formBody = (body.formdata ?? [])
            .filter((p) => p.key)
            .map((p) => {
            const filePath = Array.isArray(p.src) ? p.src.filter(Boolean).join(', ') : p.src ?? '';
            if (p.type === 'file' || filePath)
                warnings.push(`${tabName}: file-backed multipart field "${p.key}" was referenced but not embedded`);
            return {
                key: p.key ?? '',
                value: p.type === 'file' ? filePath : p.value ?? '',
                enabled: !p.disabled,
                type: p.type === 'file' ? 'file' : 'text',
                filePath: filePath || undefined,
                contentType: p.contentType,
            };
        });
        return { body: '', bodyType: 'form-data', formBody };
    }
    if (body.mode === 'file') {
        const filePath = Array.isArray(body.file?.src) ? body.file?.src.filter(Boolean).join(', ') : body.file?.src ?? '';
        if (filePath)
            warnings.push(`${tabName}: file-backed body was referenced but not embedded`);
        return { body: '', bodyType: 'none', fileBodyPath: filePath || undefined };
    }
    if (body.mode === 'graphql') {
        warnings.push(`${tabName}: GraphQL body imported as JSON because the request panel does not have a GraphQL editor yet`);
        return {
            body: JSON.stringify({ query: body.graphql?.query ?? '', variables: body.graphql?.variables ?? '' }, null, 2),
            bodyType: 'json',
        };
    }
    return { body: '', bodyType: 'none' };
}
function flattenPostman(items, parentParts, inheritedAuth, inheritedEvents, warnings) {
    const out = [];
    for (const item of items) {
        const label = item.name ?? 'Untitled';
        const nextParts = [...parentParts, label];
        const itemEvents = postmanEvents(item.event);
        const nextEvents = {
            preRequest: concatScripts(inheritedEvents.preRequest, itemEvents.preRequest),
            tests: concatScripts(inheritedEvents.tests, itemEvents.tests),
        };
        const itemAuth = item.auth !== undefined
            ? postmanAuth(item.auth, inheritedAuth, warnings, joinName(nextParts))
            : inheritedAuth;
        if (item.item?.length) {
            out.push(...flattenPostman(item.item, nextParts, itemAuth, nextEvents, warnings));
            continue;
        }
        if (!item.request)
            continue;
        const req = typeof item.request === 'string' ? { url: item.request } : item.request;
        const name = joinName(nextParts);
        const url = postmanUrl(req.url);
        const body = postmanBody(req.body, warnings, name);
        out.push(makeTab({
            name,
            method: normalizeMethod(req.method),
            url: url.url,
            params: url.params,
            headers: postmanHeaders(req.header, warnings, name),
            auth: req.auth !== undefined ? postmanAuth(req.auth, itemAuth, warnings, name) : itemAuth,
            preRequest: nextEvents.preRequest,
            tests: nextEvents.tests,
            sourceItemId: item.id || name,
            ...body,
        }));
    }
    return out;
}
function parsePostman(content) {
    const json = JSON.parse(content);
    if (Array.isArray(json.requests) && Array.isArray(json.order) && !Array.isArray(json.item)) {
        throw new Error('Postman v1 detected. Re-export from Postman as v2.1 JSON or current Postman collection YAML.');
    }
    const warnings = [];
    const name = json.info?.name ?? 'Postman Collection';
    const collectionEvents = postmanEvents(json.event);
    const collectionAuth = postmanAuth(json.auth, { type: 'none' }, warnings, name);
    const tabs = flattenPostman(json.item ?? [], [], collectionAuth, collectionEvents, warnings);
    const environments = [
        postmanVariablesToEnvironment(`${name} Variables`, json.variable),
    ].filter((env) => Boolean(env));
    return {
        name,
        tabs,
        environments,
        warnings,
        stableSourceId: json.info?._postman_id ?? json.info?.postman_id,
    };
}
function parsePostmanEnvironment(content) {
    const json = JSON.parse(content);
    const name = json.name ?? 'Postman Environment';
    const isSecret = {};
    const variables = (json.values ?? [])
        .filter((v) => v.key)
        .map((v) => {
        if (v.type === 'secret' && v.key)
            isSecret[v.key] = true;
        return { key: v.key ?? '', value: getString(v.value), enabled: v.enabled !== false };
    });
    return {
        name,
        tabs: [],
        environments: [{ id: (0, crypto_1.randomUUID)(), name, variables, isSecret }],
        warnings: [],
        stableSourceId: json.id,
    };
}
function insomniaHeaders(headers, warnings, tabName) {
    const out = {};
    for (const header of headers ?? []) {
        if (!header.name)
            continue;
        if (header.disabled) {
            warnings.push(`${tabName}: disabled header "${header.name}" was skipped because the header editor stores enabled headers only`);
            continue;
        }
        out[header.name] = header.value ?? '';
    }
    return out;
}
function insomniaAuth(auth, warnings, tabName) {
    if (!auth || auth.disabled)
        return { type: 'none' };
    const type = getString(auth.type).toLowerCase();
    if (!type || type === 'none')
        return { type: 'none' };
    if (type === 'bearer' || type === 'singleToken') {
        return { type: 'bearer', token: getString(auth.token) };
    }
    if (type === 'basic') {
        return { type: 'basic', username: getString(auth.username), password: getString(auth.password) };
    }
    if (type === 'apikey') {
        return {
            type: 'apiKey',
            apiKeyName: getString(auth.key),
            apiKeyValue: getString(auth.value),
            apiKeyAddTo: normalizeApiKeyLocation(auth.addTo),
        };
    }
    return warnUnsupportedAuth(warnings, tabName, type);
}
function insomniaBody(body, warnings, tabName) {
    const bodyType = bodyTypeFromMime(body?.mimeType);
    if (!body || bodyType === 'none')
        return { body: '', bodyType: 'none' };
    if (bodyType === 'form-urlencoded' || bodyType === 'form-data') {
        const formBody = (body.params ?? [])
            .filter((p) => p.name)
            .map((p) => {
            const isFile = p.type === 'file' || Boolean(p.fileName);
            if (isFile)
                warnings.push(`${tabName}: file-backed form field "${p.name}" was referenced but not embedded`);
            return {
                key: p.name ?? '',
                value: isFile ? p.fileName ?? '' : p.value ?? '',
                enabled: !p.disabled,
                type: isFile ? 'file' : 'text',
                filePath: p.fileName,
                contentType: p.contentType,
            };
        });
        return { body: '', bodyType, formBody };
    }
    if (body.fileName) {
        warnings.push(`${tabName}: file-backed body was referenced but not embedded`);
        return { body: body.text ?? '', bodyType: bodyType === 'json' ? 'json' : 'text', fileBodyPath: body.fileName };
    }
    return { body: body.text ?? '', bodyType };
}
function insomniaEnvironments(resources, workspaceName) {
    return resources
        .filter((resource) => resource._type === 'environment' && resource.name)
        .map((resource) => ({
        id: (0, crypto_1.randomUUID)(),
        name: resource.name || workspaceName,
        variables: Object.entries(resource.data ?? {}).map(([key, value]) => ({
            key,
            value: getString(value),
            enabled: true,
        })),
        sourceItemId: resource._id,
    }));
}
function parseInsomnia(content) {
    const json = JSON.parse(content);
    const warnings = [];
    const resources = json.resources ?? [];
    const byId = new Map();
    for (const resource of resources)
        if (resource._id)
            byId.set(resource._id, resource);
    const workspace = resources.find((resource) => resource._type === 'workspace');
    const workspaceName = workspace?.name ?? 'Insomnia Collection';
    const pathMemo = new Map();
    const pathFor = (res) => {
        if (res._id && pathMemo.has(res._id))
            return pathMemo.get(res._id);
        const parts = [res.name ?? 'Untitled'];
        let parentId = res.parentId;
        while (parentId) {
            const parent = byId.get(parentId);
            if (!parent || parent._type === 'workspace')
                break;
            if (parent._type === 'request_group' && parent.name)
                parts.unshift(parent.name);
            parentId = parent.parentId ?? null;
        }
        const result = joinName(parts);
        if (res._id)
            pathMemo.set(res._id, result);
        return result;
    };
    const tabs = [];
    for (const res of resources) {
        if (res._type === 'grpc_request') {
            const name = pathFor(res);
            tabs.push(makeTab({ name, method: 'GET', url: '', headers: {}, body: '', auth: { type: 'none' }, unsupported: 'grpc', sourceItemId: res._id }));
            warnings.push(`${name}: gRPC request imported as unsupported placeholder`);
            continue;
        }
        if (res._type !== 'request')
            continue;
        const name = pathFor(res);
        const params = (res.parameters ?? [])
            .filter((p) => p.name)
            .map((p) => ({ key: p.name ?? '', value: p.value ?? '', enabled: !p.disabled }));
        const url = params.length ? appendQueryParams(res.url ?? '', params) : res.url ?? '';
        tabs.push(makeTab({
            name,
            method: normalizeMethod(res.method),
            url,
            params: params.length ? params : undefined,
            headers: insomniaHeaders(res.headers, warnings, name),
            auth: insomniaAuth(res.authentication, warnings, name),
            preRequest: res.preRequestScript || undefined,
            tests: res.afterResponseScript || undefined,
            sourceItemId: res._id,
            ...insomniaBody(res.body, warnings, name),
        }));
    }
    return {
        name: workspaceName,
        tabs,
        environments: insomniaEnvironments(resources, workspaceName),
        warnings,
        stableSourceId: workspace?._id,
    };
}
// ---------- Insomnia v5 YAML ----------
function insomniaV5Environments(root, fallbackName) {
    const envRoot = getObject(root.environments);
    const out = [];
    const pushEnv = (env, inheritedName) => {
        const name = getString(env.name) || inheritedName || fallbackName;
        const data = getObject(env.data);
        if (Object.keys(data).length) {
            out.push({
                id: (0, crypto_1.randomUUID)(),
                name,
                variables: Object.entries(data).map(([key, value]) => ({ key, value: getString(value), enabled: true })),
            });
        }
        const children = Array.isArray(env.subEnvironments) ? env.subEnvironments : [];
        for (const child of children)
            pushEnv(getObject(child), name);
    };
    if (Object.keys(envRoot).length)
        pushEnv(envRoot);
    return out;
}
function flattenInsomniaV5(items, parents, warnings) {
    const tabs = [];
    for (const raw of items) {
        const item = getObject(raw);
        const type = getString(item.type).toLowerCase();
        const name = getString(item.name) || 'Untitled';
        const nextParents = [...parents, name];
        if (Array.isArray(item.children)) {
            tabs.push(...flattenInsomniaV5(item.children, nextParents, warnings));
            continue;
        }
        if (type.includes('grpc')) {
            const tabName = joinName(nextParents);
            tabs.push(makeTab({ name: tabName, method: 'GET', url: '', headers: {}, body: '', auth: { type: 'none' }, unsupported: 'grpc', sourceItemId: getString(getObject(item.meta).id) || undefined }));
            warnings.push(`${tabName}: gRPC request imported as unsupported placeholder`);
            continue;
        }
        if (type.includes('websocket')) {
            const tabName = joinName(nextParents);
            tabs.push(makeTab({ name: tabName, method: 'GET', url: getString(item.url), headers: {}, body: '', auth: { type: 'none' }, unsupported: 'websocket', sourceItemId: getString(getObject(item.meta).id) || undefined }));
            warnings.push(`${tabName}: WebSocket request imported as unsupported placeholder`);
            continue;
        }
        if (type.includes('socketio')) {
            const tabName = joinName(nextParents);
            tabs.push(makeTab({ name: tabName, method: 'GET', url: getString(item.url), headers: {}, body: '', auth: { type: 'none' }, unsupported: 'socketio', sourceItemId: getString(getObject(item.meta).id) || undefined }));
            warnings.push(`${tabName}: Socket.IO request imported as unsupported placeholder`);
            continue;
        }
        const tabName = joinName(nextParents);
        const parameters = Array.isArray(item.parameters) ? item.parameters : [];
        const params = parameters
            .map((p) => getObject(p))
            .filter((p) => p.name)
            .map((p) => ({ key: getString(p.name), value: getString(p.value), enabled: p.disabled !== true }));
        const body = insomniaBody(getObject(item.body), warnings, tabName);
        tabs.push(makeTab({
            name: tabName,
            method: normalizeMethod(item.method),
            url: params.length ? appendQueryParams(getString(item.url), params) : getString(item.url),
            params: params.length ? params : undefined,
            headers: insomniaHeaders((Array.isArray(item.headers) ? item.headers : []), warnings, tabName),
            auth: insomniaAuth(getObject(item.authentication), warnings, tabName),
            preRequest: getString(item.preRequestScript) || undefined,
            tests: getString(item.afterResponseScript) || undefined,
            sourceItemId: getString(getObject(item.meta).id) || undefined,
            ...body,
        }));
    }
    return tabs;
}
function parseInsomniaV5(content) {
    const root = getObject((0, yaml_1.parse)(content));
    const type = getString(root.type);
    if (!type.includes('insomnia.rest/5.0')) {
        throw new Error('Insomnia v5 YAML expected a type ending in insomnia.rest/5.0');
    }
    const name = getString(root.name) || 'Insomnia Collection';
    const warnings = [];
    const collection = Array.isArray(root.collection) ? root.collection : [];
    return {
        name,
        tabs: flattenInsomniaV5(collection, [], warnings),
        environments: insomniaV5Environments(root, name),
        warnings,
        stableSourceId: getString(getObject(root.meta).id) || undefined,
    };
}
function parseBruBlocks(text) {
    const blocks = [];
    let i = 0;
    while (i < text.length) {
        while (i < text.length && /\s/.test(text[i]))
            i++;
        if (i >= text.length)
            break;
        const headerStart = i;
        while (i < text.length && text[i] !== '{' && text[i] !== '[')
            i++;
        if (i >= text.length)
            break;
        const header = text.slice(headerStart, i).trim();
        const opener = text[i];
        const closer = opener === '[' ? ']' : '}';
        const blockType = opener === '[' ? 'array' : 'dict';
        i++;
        let depth = 1;
        const contentStart = i;
        while (i < text.length && depth > 0) {
            const ch = text[i];
            if (ch === opener)
                depth++;
            else if (ch === closer)
                depth--;
            if (depth > 0)
                i++;
        }
        const content = text.slice(contentStart, i);
        i++;
        const [type, ...nameParts] = header.split(':').map((s) => s.trim());
        blocks.push({ type, name: nameParts.join(':'), content, blockType });
    }
    return blocks;
}
function parseBruKeyValues(content) {
    const out = {};
    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('//') || line.startsWith('#'))
            continue;
        const colon = line.indexOf(':');
        if (colon === -1)
            continue;
        const key = line.slice(0, colon).replace(/^~/, '').trim();
        const value = line.slice(colon + 1).trim();
        if (key)
            out[key] = value;
    }
    return out;
}
function parseBruArray(content) {
    return content
        .split(/\r?\n|,/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => ({ value: line.replace(/^~/, '').trim(), enabled: !line.startsWith('~') }))
        .filter((item) => Boolean(item.value));
}
function block(blocks, type, name) {
    return blocks.find((b) => b.type === type && (name === undefined || b.name === name));
}
function parseBruFile(name, text, warnings, filePath) {
    const blocks = parseBruBlocks(text);
    const metaKv = block(blocks, 'meta') ? parseBruKeyValues(block(blocks, 'meta').content) : {};
    const displayName = metaKv.name || name;
    const metaType = (metaKv.type || 'http').toLowerCase();
    if (metaType === 'grpc') {
        warnings.push(`${displayName}: gRPC request imported as unsupported placeholder`);
        return makeTab({ name: displayName, method: 'GET', url: '', headers: {}, body: '', auth: { type: 'none' }, unsupported: 'grpc', sourceItemId: metaKv.seq ? `${metaKv.seq}:${displayName}` : displayName, sourceFilePath: filePath });
    }
    if (metaType !== 'http' && metaType !== 'graphql')
        return null;
    const methodBlock = blocks.find((b) => BRUNO_METHODS.includes(b.type.toUpperCase()));
    if (!methodBlock)
        return null;
    const methodKv = parseBruKeyValues(methodBlock.content);
    const method = normalizeMethod(methodBlock.type);
    const queryBlock = block(blocks, 'query') ?? block(blocks, 'params', 'query');
    const params = queryBlock
        ? Object.entries(parseBruKeyValues(queryBlock.content)).map(([key, value]) => ({ key, value, enabled: true }))
        : undefined;
    const url = params?.length ? appendQueryParams(methodKv.url ?? '', params) : methodKv.url ?? '';
    const headers = block(blocks, 'headers') ? parseBruKeyValues(block(blocks, 'headers').content) : {};
    const authMode = (parseBruKeyValues(block(blocks, 'auth')?.content ?? '').mode || methodKv.auth || 'none').toLowerCase();
    let auth = { type: 'none' };
    if (authMode === 'bearer') {
        const kv = parseBruKeyValues(block(blocks, 'auth', 'bearer')?.content ?? '');
        auth = { type: 'bearer', token: kv.token ?? '' };
    }
    else if (authMode === 'basic') {
        const kv = parseBruKeyValues(block(blocks, 'auth', 'basic')?.content ?? '');
        auth = { type: 'basic', username: kv.username ?? '', password: kv.password ?? '' };
    }
    else if (authMode === 'apikey') {
        const kv = parseBruKeyValues(block(blocks, 'auth', 'apikey')?.content ?? '');
        auth = { type: 'apiKey', apiKeyName: kv.key ?? kv.name ?? '', apiKeyValue: kv.value ?? '', apiKeyAddTo: normalizeApiKeyLocation(kv.placement ?? kv.addTo) };
    }
    else if (authMode && authMode !== 'none') {
        warnings.push(`${displayName}: unsupported auth mode "${authMode}", imported as none`);
    }
    let body = '';
    let bodyType = 'none';
    let formBody;
    const jsonBody = block(blocks, 'body', 'json');
    const textBody = block(blocks, 'body', 'text');
    const xmlBody = block(blocks, 'body', 'xml');
    const urlEncodedBody = block(blocks, 'body', 'form-urlencoded');
    const multipartBody = block(blocks, 'body', 'multipart-form');
    const graphqlBody = block(blocks, 'body', 'graphql');
    if (jsonBody || graphqlBody) {
        body = (jsonBody ?? graphqlBody).content.trim();
        bodyType = 'json';
        if (graphqlBody)
            warnings.push(`${displayName}: GraphQL body imported as JSON because the request panel does not have a GraphQL editor yet`);
    }
    else if (xmlBody) {
        body = xmlBody.content.trim();
        bodyType = 'xml';
    }
    else if (textBody) {
        body = textBody.content.trim();
        bodyType = 'text';
    }
    else if (urlEncodedBody || multipartBody) {
        const kv = parseBruKeyValues((urlEncodedBody ?? multipartBody).content);
        bodyType = urlEncodedBody ? 'form-urlencoded' : 'form-data';
        formBody = Object.entries(kv).map(([key, value]) => {
            const fileMatch = value.match(/^@file\((.*)\)$/);
            if (fileMatch)
                warnings.push(`${displayName}: file-backed form field "${key}" was referenced but not embedded`);
            return { key, value: fileMatch ? fileMatch[1] : value, enabled: true, type: fileMatch ? 'file' : 'text', filePath: fileMatch?.[1] };
        });
    }
    return makeTab({
        name: displayName,
        method,
        url,
        params,
        headers,
        body,
        bodyType,
        formBody,
        auth,
        preRequest: block(blocks, 'script', 'pre-request')?.content.trim() || undefined,
        tests: (block(blocks, 'tests')?.content.trim() || block(blocks, 'script', 'post-response')?.content.trim()) || undefined,
        docs: block(blocks, 'docs')?.content.trim() || undefined,
        sourceItemId: metaKv.seq ? `${metaKv.seq}:${displayName}` : displayName,
        sourceFilePath: filePath,
    });
}
async function mapWithConcurrency(items, limit, mapper) {
    const results = [];
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await mapper(items[index]);
        }
    });
    await Promise.all(workers);
    return results;
}
async function walkBruFolder(dir, prefix, warnings) {
    const entries = await (0, promises_1.readdir)(dir, { withFileTypes: true });
    const visible = entries.filter((entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== 'environments');
    const nested = await mapWithConcurrency(visible, 16, async (entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const nextPrefix = prefix ? `${prefix} / ${cleanSegment(entry.name)}` : cleanSegment(entry.name);
            return walkBruFolder(full, nextPrefix, warnings);
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.bru'))
            return [];
        const text = await readTextWithCap(full);
        const tab = parseBruFile(entry.name.replace(/\.bru$/i, ''), text, warnings, full);
        if (!tab)
            return [];
        tab.name = prefix ? `${prefix} / ${tab.name}` : tab.name;
        return [tab];
    });
    return nested.flat();
}
async function parseBrunoEnvironments(folderPath) {
    const envDir = path.join(folderPath, 'environments');
    if (!(await pathExists(envDir)))
        return [];
    const entries = await (0, promises_1.readdir)(envDir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.bru'));
    return mapWithConcurrency(files, 16, async (entry) => {
        const text = await readTextWithCap(path.join(envDir, entry.name));
        const blocks = parseBruBlocks(text);
        const vars = parseBruKeyValues(block(blocks, 'vars')?.content ?? '');
        const secretNames = new Set(parseBruArray(block(blocks, 'vars', 'secret')?.content ?? '').map((item) => item.value));
        return {
            id: (0, crypto_1.randomUUID)(),
            name: entry.name.replace(/\.bru$/i, ''),
            variables: Object.entries(vars).map(([key, value]) => ({ key, value, enabled: true })),
            isSecret: Object.fromEntries([...secretNames].map((key) => [key, true])),
        };
    });
}
async function parseBrunoFolder(folderPath) {
    const warnings = [];
    let name = path.basename(folderPath);
    let stableSourceId;
    try {
        const bruno = JSON.parse(await readTextWithCap(path.join(folderPath, 'bruno.json')));
        if (bruno.name)
            name = bruno.name;
        stableSourceId = bruno.uid ?? bruno.id;
    }
    catch {
        // No bruno.json — fall back to folder name.
    }
    const stats = await (0, promises_1.stat)(folderPath);
    if (!stats.isDirectory())
        throw new Error('Bruno import expects a folder');
    const [tabs, environments] = await Promise.all([
        walkBruFolder(folderPath, '', warnings),
        parseBrunoEnvironments(folderPath),
    ]);
    return { name, tabs, environments, warnings, stableSourceId };
}
// ---------- Postman v3 YAML ----------
async function walkFiles(dir, shouldInclude) {
    const entries = await (0, promises_1.readdir)(dir, { withFileTypes: true });
    const nested = await mapWithConcurrency(entries.filter((entry) => !entry.name.startsWith('.') && entry.name !== 'node_modules'), 16, async (entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory())
            return walkFiles(full, shouldInclude);
        return entry.isFile() && shouldInclude(full) ? [full] : [];
    });
    return nested.flat();
}
function postmanV3RequestFromYaml(raw, parents, warnings, filePath) {
    const request = Object.keys(getObject(raw.request)).length ? getObject(raw.request) : raw;
    const name = getString(raw.name) || getString(request.name) || path.basename(filePath).replace(/\.request\.ya?ml$/i, '');
    const tabName = joinName([...parents, name]);
    const headersValue = request.headers ?? request.header;
    const headersArray = Array.isArray(headersValue)
        ? headersValue
        : Object.entries(getObject(headersValue)).map(([key, value]) => ({ key, value }));
    const headers = postmanHeaders(headersArray.map((h) => ({ key: getString(h.key ?? h.name), value: getString(h.value), disabled: h.disabled === true })), warnings, tabName);
    const bodyValue = getObject(request.body);
    const body = postmanBody(bodyValue, warnings, tabName);
    const urlValue = request.url;
    const url = typeof urlValue === 'string'
        ? { url: urlValue }
        : postmanUrl(getObject(urlValue));
    const auth = request.auth ? postmanAuth(getObject(request.auth), { type: 'none' }, warnings, tabName) : { type: 'none' };
    return makeTab({
        name: tabName,
        method: normalizeMethod(request.method),
        url: url.url,
        params: url.params,
        headers,
        auth,
        sourceItemId: getString(getObject(raw.meta).id) || getString(raw.id) || filePath,
        sourceFilePath: filePath,
        ...body,
    });
}
async function parsePostmanV3(rootPath) {
    const info = await (0, promises_1.stat)(rootPath);
    const rootDir = info.isDirectory() ? rootPath : path.dirname(rootPath);
    const yamlDefinitionPath = path.join(rootDir, 'definition.yaml');
    const ymlDefinitionPath = path.join(rootDir, 'definition.yml');
    const definitionPath = await pathExists(yamlDefinitionPath) ? yamlDefinitionPath : ymlDefinitionPath;
    let definition = {};
    if (await pathExists(definitionPath)) {
        definition = getObject((0, yaml_1.parse)(await readTextWithCap(definitionPath)));
    }
    const name = getString(definition.name) || getString(getObject(definition.info).name) || path.basename(rootDir);
    const warnings = [];
    const requestFiles = await walkFiles(rootDir, (filePath) => /\.request\.ya?ml$/i.test(filePath));
    const tabs = await mapWithConcurrency(requestFiles, 16, async (filePath) => {
        const raw = getObject((0, yaml_1.parse)(await readTextWithCap(filePath)));
        const relDir = path.relative(rootDir, path.dirname(filePath));
        const parents = relDir && relDir !== '.' ? relDir.split(path.sep).filter(Boolean) : [];
        return postmanV3RequestFromYaml(raw, parents, warnings, filePath);
    });
    return {
        name,
        tabs,
        environments: [],
        warnings,
        stableSourceId: getString(getObject(definition.info)._postman_id) || getString(getObject(definition.meta).id) || undefined,
    };
}
// ---------- Top-level entry ----------
async function importCollection(format, filePathOrFolder) {
    if (format === 'bruno')
        return parseBrunoFolder(filePathOrFolder);
    const content = await readTextWithCap(filePathOrFolder);
    if (format === 'postman') {
        const detected = (0, httpFile_1.detectHttpImportFormat)(filePathOrFolder, content.slice(0, SNIFF_BYTES));
        if (detected === 'postman-v3')
            return parsePostmanV3(filePathOrFolder);
        if (detected === 'postman-environment')
            return parsePostmanEnvironment(content);
        return parsePostman(content);
    }
    const detected = (0, httpFile_1.detectHttpImportFormat)(filePathOrFolder, content.slice(0, SNIFF_BYTES));
    if (detected === 'insomnia-v5')
        return parseInsomniaV5(content);
    return parseInsomnia(content);
}
async function detectHttpImportFile(filePath) {
    const info = await (0, promises_1.stat)(filePath);
    const resolvedPath = path.resolve(filePath);
    const cached = detectCache.get(resolvedPath);
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
        detectCache.delete(resolvedPath);
        detectCache.set(resolvedPath, cached);
        return cached.result;
    }
    const remember = (result) => {
        detectCache.set(resolvedPath, { mtimeMs: info.mtimeMs, size: info.size, result });
        if (detectCache.size > DETECT_CACHE_LIMIT) {
            const oldest = detectCache.keys().next().value;
            if (oldest)
                detectCache.delete(oldest);
        }
        return result;
    };
    if (info.isDirectory()) {
        if (await pathExists(path.join(resolvedPath, 'bruno.json'))) {
            return remember({ format: 'bruno', importPath: resolvedPath, sourcePath: resolvedPath });
        }
        if (await pathExists(path.join(resolvedPath, 'definition.yaml')) || await pathExists(path.join(resolvedPath, 'definition.yml'))) {
            return remember({ format: 'postman-v3', importPath: resolvedPath, sourcePath: resolvedPath });
        }
        return remember(null);
    }
    if (!(0, httpFile_1.isHttpImportCandidatePath)(resolvedPath))
        return remember(null);
    const sniff = await readHead(resolvedPath);
    const format = (0, httpFile_1.detectHttpImportFormat)(resolvedPath, sniff);
    if (!format)
        return remember(null);
    if (format === 'bruno') {
        const root = await findAncestorWithFile(resolvedPath, 'bruno.json');
        const sourcePath = root ?? path.dirname(resolvedPath);
        return remember({ format, importPath: sourcePath, sourcePath });
    }
    if (format === 'postman-v3') {
        const root = await findAncestorWithFile(resolvedPath, 'definition.yaml') ?? await findAncestorWithFile(resolvedPath, 'definition.yml') ?? path.dirname(resolvedPath);
        return remember({ format, importPath: root, sourcePath: root });
    }
    return remember({ format, importPath: resolvedPath, sourcePath: resolvedPath });
}
async function importHttpFile(filePath) {
    const target = await detectHttpImportFile(filePath);
    if (!target)
        throw new Error('This file is not a recognized Bruno, Postman, or Insomnia import source.');
    let imported;
    if (target.format === 'bruno')
        imported = await parseBrunoFolder(target.importPath);
    else if (target.format === 'postman-collection')
        imported = parsePostman(await readTextWithCap(target.importPath));
    else if (target.format === 'postman-environment')
        imported = parsePostmanEnvironment(await readTextWithCap(target.importPath));
    else if (target.format === 'postman-v3')
        imported = await parsePostmanV3(target.importPath);
    else if (target.format === 'insomnia-v5')
        imported = parseInsomniaV5(await readTextWithCap(target.importPath));
    else
        imported = parseInsomnia(await readTextWithCap(target.importPath));
    const sourceId = sourceKeyFor(target.format, target.sourcePath, imported.stableSourceId);
    const fingerprint = await contentFingerprint(target.sourcePath);
    const tagged = tagImported(imported, sourceId);
    return {
        format: target.format,
        collectionName: imported.name,
        tabs: tagged.tabs,
        environments: tagged.environments,
        warnings: imported.warnings,
        sourceKey: sourceId,
        contentFingerprint: fingerprint,
        sourcePath: target.sourcePath,
        importSource: {
            id: sourceId,
            format: target.format,
            sourcePath: target.sourcePath,
            contentFingerprint: fingerprint,
            importedAt: Date.now(),
        },
    };
}
