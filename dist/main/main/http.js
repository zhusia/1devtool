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
exports.HttpClient = void 0;
const axios_1 = __importStar(require("axios"));
// Convert enabled form fields to application/x-www-form-urlencoded payload.
function encodeUrlEncoded(fields) {
    const params = new URLSearchParams();
    for (const f of fields) {
        if (!f.enabled || !f.key)
            continue;
        params.append(f.key, f.value);
    }
    return params.toString();
}
// Inject API key auth into headers or query string, per user's addTo choice.
function applyApiKeyAuth(url, headers, auth) {
    const name = auth.apiKeyName || '';
    const value = auth.apiKeyValue || '';
    if (!name)
        return url;
    if (auth.apiKeyAddTo === 'query') {
        const sep = url.includes('?') ? '&' : '?';
        return `${url}${sep}${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
    }
    headers[name] = value;
    return url;
}
class HttpClient {
    async request(params) {
        const { method, headers, body, auth, bodyType, formBody } = params;
        let { url } = params;
        const startTime = Date.now();
        // Build headers with auth
        const requestHeaders = { ...headers };
        if (auth) {
            if (auth.type === 'bearer' && auth.token) {
                requestHeaders['Authorization'] = `Bearer ${auth.token}`;
            }
            else if (auth.type === 'basic' && auth.username && auth.password) {
                const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
                requestHeaders['Authorization'] = `Basic ${credentials}`;
            }
            else if (auth.type === 'apiKey') {
                url = applyApiKeyAuth(url, requestHeaders, auth);
            }
        }
        // Encode body per declared body type. Falls back to the legacy "try JSON,
        // else raw text" heuristic when bodyType is missing (old tabs).
        let requestBody = undefined;
        const bodyMethodAllowed = !['GET', 'HEAD'].includes(String(method).toUpperCase());
        if (bodyMethodAllowed) {
            if (bodyType === 'form-urlencoded' && formBody) {
                requestBody = encodeUrlEncoded(formBody);
                if (!requestHeaders['Content-Type']) {
                    requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
                }
            }
            else if (bodyType === 'form-data' && formBody) {
                // URLSearchParams + multipart boundary is complex; use FormData + let
                // axios build the multipart body. Files aren't supported yet (UI is
                // text-only), so the field map is always string→string.
                const form = {};
                for (const f of formBody) {
                    if (!f.enabled || !f.key)
                        continue;
                    form[f.key] = f.value;
                }
                const params = new URLSearchParams(form);
                requestBody = params.toString();
                if (!requestHeaders['Content-Type']) {
                    requestHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
                }
            }
            else if (bodyType === 'json' && body) {
                try {
                    requestBody = JSON.parse(body);
                }
                catch {
                    requestBody = body;
                }
                if (!requestHeaders['Content-Type']) {
                    requestHeaders['Content-Type'] = 'application/json';
                }
            }
            else if (bodyType === 'xml' && body) {
                requestBody = body;
                if (!requestHeaders['Content-Type']) {
                    requestHeaders['Content-Type'] = 'application/xml';
                }
            }
            else if (bodyType === 'text' && body) {
                requestBody = body;
                if (!requestHeaders['Content-Type']) {
                    requestHeaders['Content-Type'] = 'text/plain';
                }
            }
            else if (bodyType === 'none') {
                requestBody = undefined;
            }
            else if (body) {
                // Legacy path: detect JSON automatically.
                try {
                    requestBody = JSON.parse(body);
                    if (!requestHeaders['Content-Type']) {
                        requestHeaders['Content-Type'] = 'application/json';
                    }
                }
                catch {
                    requestBody = body;
                }
            }
        }
        try {
            const response = await (0, axios_1.default)({
                method: method.toLowerCase(),
                url,
                headers: requestHeaders,
                data: requestBody,
                timeout: 30000,
                validateStatus: () => true, // Don't throw on any status
            });
            const latency = Date.now() - startTime;
            // Serialize response body
            let responseBody;
            if (typeof response.data === 'object') {
                responseBody = JSON.stringify(response.data, null, 2);
            }
            else {
                responseBody = String(response.data);
            }
            // Convert headers to simple object
            const responseHeaders = {};
            for (const [key, value] of Object.entries(response.headers)) {
                if (typeof value === 'string') {
                    responseHeaders[key] = value;
                }
                else if (Array.isArray(value)) {
                    responseHeaders[key] = value.join(', ');
                }
            }
            return {
                status: response.status,
                statusText: response.statusText,
                headers: responseHeaders,
                body: responseBody,
                latency,
            };
        }
        catch (error) {
            const latency = Date.now() - startTime;
            if (error instanceof axios_1.AxiosError) {
                return {
                    status: 0,
                    statusText: error.message,
                    headers: {},
                    body: error.message,
                    latency,
                };
            }
            return {
                status: 0,
                statusText: 'Unknown error',
                headers: {},
                body: String(error),
                latency,
            };
        }
    }
}
exports.HttpClient = HttpClient;
