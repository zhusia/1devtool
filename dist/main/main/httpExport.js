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
exports.exportToPostman = exportToPostman;
exports.exportToInsomnia = exportToInsomnia;
exports.buildBruFile = buildBruFile;
exports.exportToBrunoFolder = exportToBrunoFolder;
exports.exportCollection = exportCollection;
const promises_1 = require("fs/promises");
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
// Flattened tab name like "Posts / Create post" → folders=["Posts"], leaf="Create post".
function splitTabPath(name) {
    const parts = name.split(' / ').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0)
        return { folders: [], leaf: name || 'Request' };
    return { folders: parts.slice(0, -1), leaf: parts[parts.length - 1] };
}
function sanitizeFsName(name) {
    return name.replace(/[/\\:*?"<>|]/g, '_').trim() || 'Request';
}
function exportableTabs(tabs) {
    return tabs.filter((tab) => !tab.unsupported);
}
function scriptLines(source) {
    return source.split(/\r?\n/);
}
function postmanEvents(tab) {
    const events = [];
    if (tab.preRequest?.trim()) {
        events.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: scriptLines(tab.preRequest) } });
    }
    if (tab.tests?.trim()) {
        events.push({ listen: 'test', script: { type: 'text/javascript', exec: scriptLines(tab.tests) } });
    }
    return events.length ? events : undefined;
}
function postmanRawLanguage(bodyType) {
    if (bodyType === 'xml')
        return 'xml';
    if (bodyType === 'text')
        return 'text';
    return 'json';
}
function postmanBody(tab) {
    if (tab.fileBodyPath)
        return { mode: 'file', file: { src: tab.fileBodyPath } };
    if (tab.bodyType === 'form-urlencoded') {
        return {
            mode: 'urlencoded',
            urlencoded: (tab.formBody ?? [])
                .filter((field) => field.key)
                .map((field) => ({
                key: field.key,
                value: field.value,
                disabled: !field.enabled || undefined,
            })),
        };
    }
    if (tab.bodyType === 'form-data') {
        return {
            mode: 'formdata',
            formdata: (tab.formBody ?? [])
                .filter((field) => field.key)
                .map((field) => {
                if (field.type === 'file' || field.filePath) {
                    return {
                        key: field.key,
                        src: field.filePath || field.value,
                        type: 'file',
                        contentType: field.contentType,
                        disabled: !field.enabled || undefined,
                    };
                }
                return {
                    key: field.key,
                    value: field.value,
                    type: 'text',
                    disabled: !field.enabled || undefined,
                };
            }),
        };
    }
    if (!tab.body)
        return undefined;
    return {
        mode: 'raw',
        raw: tab.body,
        options: { raw: { language: postmanRawLanguage(tab.bodyType) } },
    };
}
function buildPostmanRequest(tab) {
    const node = {
        method: tab.method,
        header: Object.entries(tab.headers).map(([key, value]) => ({ key, value })),
        url: { raw: tab.url },
    };
    try {
        const parsed = new URL(tab.url);
        node.url.protocol = parsed.protocol.replace(/:$/, '');
        node.url.host = parsed.hostname.split('.');
        node.url.path = parsed.pathname.split('/').filter(Boolean);
        const query = tab.params?.length
            ? tab.params.filter((param) => param.key).map((param) => ({
                key: param.key,
                value: param.value,
                disabled: !param.enabled || undefined,
            }))
            : Array.from(parsed.searchParams.entries()).map(([key, value]) => ({ key, value }));
        if (query.length)
            node.url.query = query;
    }
    catch {
        // Non-URL (empty or template) — keep just the raw field.
        if (tab.params?.length) {
            node.url.query = tab.params.filter((param) => param.key).map((param) => ({
                key: param.key,
                value: param.value,
                disabled: !param.enabled || undefined,
            }));
        }
    }
    node.body = postmanBody(tab);
    if (tab.auth?.type === 'bearer' && tab.auth.token) {
        node.auth = {
            type: 'bearer',
            bearer: [{ key: 'token', value: tab.auth.token, type: 'string' }],
        };
    }
    else if (tab.auth?.type === 'basic') {
        node.auth = {
            type: 'basic',
            basic: [
                { key: 'username', value: tab.auth.username ?? '', type: 'string' },
                { key: 'password', value: tab.auth.password ?? '', type: 'string' },
            ],
        };
    }
    else if (tab.auth?.type === 'apiKey') {
        node.auth = {
            type: 'apikey',
            apikey: [
                { key: 'key', value: tab.auth.apiKeyName ?? '', type: 'string' },
                { key: 'value', value: tab.auth.apiKeyValue ?? '', type: 'string' },
                { key: 'in', value: tab.auth.apiKeyAddTo === 'query' ? 'query' : 'header', type: 'string' },
            ],
        };
    }
    return node;
}
function exportToPostman(tabs, collectionName) {
    const rootItems = [];
    const folderMap = new Map();
    for (const tab of exportableTabs(tabs)) {
        const { folders, leaf } = splitTabPath(tab.name);
        let container = rootItems;
        let pathKey = '';
        for (const folder of folders) {
            pathKey = pathKey ? `${pathKey}/${folder}` : folder;
            let node = folderMap.get(pathKey);
            if (!node) {
                node = { name: folder, item: [] };
                folderMap.set(pathKey, node);
                container.push(node);
            }
            container = node.item;
        }
        const node = { name: leaf, request: buildPostmanRequest(tab) };
        const events = postmanEvents(tab);
        if (events)
            node.event = events;
        container.push(node);
    }
    return JSON.stringify({
        info: {
            _postman_id: (0, crypto_1.randomUUID)(),
            name: collectionName,
            schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
        },
        item: rootItems,
    }, null, 2);
}
function insomniaId(prefix) {
    return `${prefix}_${(0, crypto_1.randomUUID)().replace(/-/g, '').slice(0, 32)}`;
}
function insomniaMimeType(bodyType) {
    if (bodyType === 'xml')
        return 'application/xml';
    if (bodyType === 'text')
        return 'text/plain';
    if (bodyType === 'form-urlencoded')
        return 'application/x-www-form-urlencoded';
    if (bodyType === 'form-data')
        return 'multipart/form-data';
    return 'application/json';
}
function insomniaBody(tab) {
    if (tab.fileBodyPath)
        return { mimeType: 'application/octet-stream', fileName: tab.fileBodyPath };
    if (tab.bodyType === 'form-urlencoded' || tab.bodyType === 'form-data') {
        return {
            mimeType: insomniaMimeType(tab.bodyType),
            params: (tab.formBody ?? [])
                .filter((field) => field.key)
                .map((field) => ({
                name: field.key,
                value: field.value,
                type: field.type,
                fileName: field.filePath,
                contentType: field.contentType,
                disabled: !field.enabled || undefined,
            })),
        };
    }
    if (!tab.body)
        return undefined;
    return { mimeType: insomniaMimeType(tab.bodyType), text: tab.body };
}
function exportToInsomnia(tabs, collectionName) {
    const now = Date.now();
    const workspaceId = insomniaId('wrk');
    const resources = [
        {
            _id: workspaceId,
            _type: 'workspace',
            name: collectionName,
            scope: 'collection',
            created: now,
            modified: now,
        },
    ];
    const folderMap = new Map();
    for (const tab of exportableTabs(tabs)) {
        const { folders, leaf } = splitTabPath(tab.name);
        let parentId = workspaceId;
        let pathKey = '';
        for (const folder of folders) {
            pathKey = pathKey ? `${pathKey}/${folder}` : folder;
            let folderId = folderMap.get(pathKey);
            if (!folderId) {
                folderId = insomniaId('fld');
                folderMap.set(pathKey, folderId);
                resources.push({
                    _id: folderId,
                    _type: 'request_group',
                    parentId,
                    name: folder,
                    created: now,
                    modified: now,
                });
            }
            parentId = folderId;
        }
        const resource = {
            _id: insomniaId('req'),
            _type: 'request',
            parentId,
            name: leaf,
            method: tab.method,
            url: tab.url,
            headers: Object.entries(tab.headers).map(([name, value]) => ({ name, value })),
            parameters: tab.params?.filter((param) => param.key).map((param) => ({
                name: param.key,
                value: param.value,
                disabled: !param.enabled || undefined,
            })),
            body: insomniaBody(tab),
            preRequestScript: tab.preRequest,
            afterResponseScript: tab.tests,
            description: tab.docs,
            created: now,
            modified: now,
        };
        if (tab.auth?.type === 'bearer' && tab.auth.token) {
            resource.authentication = { type: 'bearer', token: tab.auth.token };
        }
        else if (tab.auth?.type === 'basic') {
            resource.authentication = {
                type: 'basic',
                username: tab.auth.username,
                password: tab.auth.password,
            };
        }
        else if (tab.auth?.type === 'apiKey') {
            resource.authentication = {
                type: 'apikey',
                key: tab.auth.apiKeyName,
                value: tab.auth.apiKeyValue,
                addTo: tab.auth.apiKeyAddTo === 'query' ? 'queryParams' : 'header',
            };
        }
        resources.push(resource);
    }
    return JSON.stringify({
        _type: 'export',
        __export_format: 4,
        __export_date: new Date().toISOString(),
        __export_source: '1devtool.desktop',
        resources,
    }, null, 2);
}
// ---------- Bruno ----------
function indentBlock(text) {
    return text
        .split('\n')
        .map((line) => (line.length ? `  ${line}` : line))
        .join('\n');
}
function buildBruFile(tab, displayName, seq) {
    const methodLower = tab.method.toLowerCase();
    const blocks = [];
    const bodyMode = brunoBodyMode(tab);
    blocks.push(`meta {\n  name: ${displayName}\n  type: http\n  seq: ${seq}\n}`);
    blocks.push(`${methodLower} {\n  url: ${tab.url}\n  body: ${bodyMode}\n  auth: ${brunoAuthMode(tab)}\n}`);
    const headerEntries = Object.entries(tab.headers);
    if (headerEntries.length > 0) {
        const lines = headerEntries.map(([key, value]) => `  ${key}: ${value}`).join('\n');
        blocks.push(`headers {\n${lines}\n}`);
    }
    if (tab.auth?.type === 'bearer' && tab.auth.token) {
        blocks.push(`auth:bearer {\n  token: ${tab.auth.token}\n}`);
    }
    else if (tab.auth?.type === 'basic') {
        blocks.push(`auth:basic {\n  username: ${tab.auth.username ?? ''}\n  password: ${tab.auth.password ?? ''}\n}`);
    }
    else if (tab.auth?.type === 'apiKey') {
        blocks.push(`auth:apikey {\n  key: ${tab.auth.apiKeyName ?? ''}\n  value: ${tab.auth.apiKeyValue ?? ''}\n  placement: ${tab.auth.apiKeyAddTo === 'query' ? 'query' : 'header'}\n}`);
    }
    const paramEntries = tab.params?.filter((param) => param.key) ?? [];
    if (paramEntries.length) {
        const lines = paramEntries
            .filter((param) => param.enabled)
            .map((param) => `  ${param.key}: ${param.value}`)
            .join('\n');
        if (lines)
            blocks.push(`params:query {\n${lines}\n}`);
    }
    if (tab.bodyType === 'form-urlencoded' || tab.bodyType === 'form-data') {
        const fields = (tab.formBody ?? []).filter((field) => field.key && field.enabled);
        if (fields.length) {
            const lines = fields.map((field) => `  ${field.key}: ${brunoFormValue(field)}`).join('\n');
            blocks.push(`body:${tab.bodyType === 'form-data' ? 'multipart-form' : 'form-urlencoded'} {\n${lines}\n}`);
        }
    }
    else if (tab.fileBodyPath) {
        blocks.push(`body:file {\n  path: ${tab.fileBodyPath}\n}`);
    }
    else if (tab.body) {
        blocks.push(`body:${bodyMode === 'xml' ? 'xml' : bodyMode === 'text' ? 'text' : 'json'} {\n${indentBlock(tab.body)}\n}`);
    }
    if (tab.preRequest?.trim()) {
        blocks.push(`script:pre-request {\n${indentBlock(tab.preRequest)}\n}`);
    }
    if (tab.tests?.trim()) {
        blocks.push(`tests {\n${indentBlock(tab.tests)}\n}`);
    }
    if (tab.docs?.trim()) {
        blocks.push(`docs {\n${indentBlock(tab.docs)}\n}`);
    }
    return blocks.join('\n\n') + '\n';
}
function brunoBodyMode(tab) {
    if (tab.fileBodyPath)
        return 'file';
    if (tab.bodyType === 'form-urlencoded')
        return 'form-urlencoded';
    if (tab.bodyType === 'form-data')
        return 'multipart-form';
    if (tab.bodyType === 'xml')
        return 'xml';
    if (tab.bodyType === 'text')
        return 'text';
    if (tab.body)
        return 'json';
    return 'none';
}
function brunoAuthMode(tab) {
    if (tab.auth?.type === 'apiKey')
        return 'apikey';
    return tab.auth?.type ?? 'none';
}
function brunoFormValue(field) {
    if (field.type === 'file' || field.filePath) {
        return `@file(${field.filePath || field.value})`;
    }
    return field.value;
}
async function exportToBrunoFolder(tabs, collectionName, targetDir) {
    await (0, promises_1.mkdir)(targetDir, { recursive: true });
    await (0, promises_1.writeFile)(path.join(targetDir, 'bruno.json'), JSON.stringify({ version: '1', name: collectionName, type: 'collection' }, null, 2), 'utf8');
    let seq = 1;
    for (const tab of exportableTabs(tabs)) {
        const { folders, leaf } = splitTabPath(tab.name);
        const subDir = folders.length ? path.join(targetDir, ...folders.map(sanitizeFsName)) : targetDir;
        await (0, promises_1.mkdir)(subDir, { recursive: true });
        const fileName = `${sanitizeFsName(leaf)}.bru`;
        await (0, promises_1.writeFile)(path.join(subDir, fileName), buildBruFile(tab, leaf, seq++), 'utf8');
    }
}
// ---------- Dispatcher ----------
async function exportCollection(format, targetPath, tabs, collectionName) {
    const tabsToExport = exportableTabs(tabs);
    if (!tabsToExport.length) {
        throw new Error('No supported HTTP requests to export.');
    }
    if (format === 'postman') {
        await (0, promises_1.writeFile)(targetPath, exportToPostman(tabsToExport, collectionName), 'utf8');
    }
    else if (format === 'insomnia') {
        await (0, promises_1.writeFile)(targetPath, exportToInsomnia(tabsToExport, collectionName), 'utf8');
    }
    else {
        await exportToBrunoFolder(tabsToExport, collectionName, targetPath);
    }
}
