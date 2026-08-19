"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isHttpImportCandidatePath = isHttpImportCandidatePath;
exports.detectHttpImportFormat = detectHttpImportFormat;
const HTTP_IMPORT_FILE_PATTERNS = [
    /\.bru$/i,
    /\.postman_collection\.json$/i,
    /\.postman_environment\.json$/i,
    /\.insomnia(?:_v4)?\.json$/i,
    /\.insomnia\.ya?ml$/i,
    /^insomnia\.ya?ml$/i,
    /^definition\.ya?ml$/i,
    /\.request\.ya?ml$/i,
];
function basename(filePath) {
    return filePath.split(/[\\/]/).pop() || filePath;
}
function isHttpImportCandidatePath(filePath) {
    const name = basename(filePath);
    return HTTP_IMPORT_FILE_PATTERNS.some((pattern) => pattern.test(name));
}
function detectHttpImportFormat(filePath, contentSniff) {
    const name = basename(filePath).toLowerCase();
    if (!isHttpImportCandidatePath(filePath))
        return null;
    const text = contentSniff.trimStart();
    const firstMeaningfulLine = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith('#') && !line.startsWith('//')) ?? '';
    if (name.endsWith('.bru')) {
        return /^(meta|vars|headers|query|body|auth|script|tests|docs|assert|settings)\s*(?::[\w-]+)?\s*[{\[]/.test(text)
            ? 'bruno'
            : null;
    }
    if (name.endsWith('.postman_collection.json')) {
        if (/schema\.getpostman\.com\/json\/collection\/v2\.\d\.0/i.test(text) && /"item"\s*:/.test(text)) {
            return 'postman-collection';
        }
        if (/"requests"\s*:/.test(text) && /"order"\s*:/.test(text)) {
            return 'postman-collection';
        }
        return null;
    }
    if (name.endsWith('.postman_environment.json')) {
        return /"_postman_variable_scope"\s*:\s*"(environment|globals)"/i.test(text)
            ? 'postman-environment'
            : null;
    }
    if (name.endsWith('.insomnia.json') || name.endsWith('.insomnia_v4.json')) {
        return /"_type"\s*:\s*"export"/.test(text) && /"__export_format"\s*:\s*4/.test(text)
            ? 'insomnia-v4'
            : null;
    }
    if (name === 'insomnia.yaml' || name === 'insomnia.yml' || name.endsWith('.insomnia.yaml') || name.endsWith('.insomnia.yml')) {
        return /^type:\s*[\w.-]+\.insomnia\.rest\/5\.0\b/i.test(firstMeaningfulLine)
            ? 'insomnia-v5'
            : null;
    }
    if (name === 'definition.yaml' || name === 'definition.yml') {
        return /postman/i.test(text) && /(^|\n)\s*(type|schema|schema_version|collection|item)\s*:/i.test(text)
            ? 'postman-v3'
            : null;
    }
    if (name.endsWith('.request.yaml') || name.endsWith('.request.yml')) {
        return /(^|\n)\s*(method|url|request)\s*:/i.test(text)
            ? 'postman-v3'
            : null;
    }
    return null;
}
