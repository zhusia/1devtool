"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultProbe = void 0;
exports.classifyHost = classifyHost;
exports.endpointsFromHosts = endpointsFromHosts;
exports.endpointsFromUrls = endpointsFromUrls;
exports.isSafeAdvertisedEndpoint = isSafeAdvertisedEndpoint;
exports.orderEndpoints = orderEndpoints;
exports.pickReachableEndpoint = pickReachableEndpoint;
const protocol_1 = require("../../shared/device/protocol");
/** Tailscale CGNAT 100.64/10; everything else private is treated as LAN. */
function classifyHost(host) {
    const normalized = host.toLowerCase();
    if (normalized === 'trycloudflare.com' || normalized.endsWith('.trycloudflare.com'))
        return 'cloudflare';
    if (normalized === 'relay.1devtool.com' || normalized.endsWith('.relay.1devtool.com'))
        return 'relay';
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host))
        return 'tailscale';
    if (host.startsWith('192.168.') ||
        host.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
        return 'lan';
    }
    return 'relay';
}
function endpointsFromHosts(hosts, port) {
    return hosts.map((host) => ({ kind: classifyHost(host), url: `http://${host}:${port}` }));
}
/** Build endpoint records from base URLs, marking the one that answered. */
function endpointsFromUrls(urls, successUrl, now = Date.now()) {
    const seen = new Set();
    const endpoints = [];
    for (const url of urls) {
        if (typeof url !== 'string' || !url.startsWith('http') || seen.has(url))
            continue;
        seen.add(url);
        let host = '';
        try {
            host = new URL(url).hostname;
        }
        catch {
            continue;
        }
        endpoints.push({
            kind: classifyHost(host),
            url,
            ...(url === successUrl ? { lastSuccessAt: now } : {}),
        });
    }
    return endpoints;
}
/** Endpoint advertisements become future server-side probe targets. Keep the
 * accepted shape narrow so a paired peer cannot turn reconnect into arbitrary
 * localhost/link-local HTTP requests. Public routes must be HTTPS. */
function isSafeAdvertisedEndpoint(value) {
    if (typeof value !== 'string' || value.length > 2048)
        return false;
    try {
        const url = new URL(value);
        if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
            return false;
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
            return false;
        const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
        if (host === 'localhost' || host === '0.0.0.0' || host === '::' || host === '::1' ||
            host.startsWith('127.') || host.startsWith('169.254.') ||
            /^fe[89ab][0-9a-f]:/i.test(host) ||
            /^::ffff:(127\.|169\.254\.)/i.test(host))
            return false;
        const kind = classifyHost(host);
        if ((kind === 'cloudflare' || kind === 'relay') && url.protocol !== 'https:')
            return false;
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Order endpoints best-first: previously-successful ones lead (most recent
 * first), then the stored order. Keeps a working VPN route sticky instead of
 * re-probing a dead LAN address every reconnect.
 */
function orderEndpoints(endpoints) {
    return [...endpoints].sort((a, b) => (b.lastSuccessAt ?? 0) - (a.lastSuccessAt ?? 0));
}
const defaultProbe = async (url, timeoutMs) => {
    try {
        const res = await fetch(`${url}${protocol_1.DEVICE_HEALTH_PATH}`, { signal: AbortSignal.timeout(timeoutMs) });
        return res.ok;
    }
    catch {
        return false;
    }
};
exports.defaultProbe = defaultProbe;
/**
 * First endpoint that answers. Probes run sequentially in preference order —
 * a peer usually answers on its first candidate, and a parallel burst would
 * wake every interface for nothing.
 */
async function pickReachableEndpoint(endpoints, opts = {}) {
    const probe = opts.probe ?? exports.defaultProbe;
    const timeoutMs = opts.timeoutMs ?? 2_500;
    for (const endpoint of orderEndpoints(endpoints)) {
        if (await probe(endpoint.url, timeoutMs))
            return endpoint;
    }
    return null;
}
