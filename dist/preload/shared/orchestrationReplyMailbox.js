"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LINK_REPLY_MAILBOX_REQUEST_ID_RE = exports.LINK_REPLY_MAILBOX_MAX_WAIT_MS = exports.LINK_REPLY_MAILBOX_MAX_RESPONSE_BYTES = exports.LINK_REPLY_MAILBOX_MAX_REQUEST_BYTES = exports.LINK_REPLY_MAILBOX_PROTOCOL_VERSION = void 0;
exports.linkReplyMailboxRoot = linkReplyMailboxRoot;
exports.createLinkReplyMailboxEndpoint = createLinkReplyMailboxEndpoint;
exports.isLinkReplyMailboxEndpoint = isLinkReplyMailboxEndpoint;
exports.parseLinkReplyMailboxRequest = parseLinkReplyMailboxRequest;
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
exports.LINK_REPLY_MAILBOX_PROTOCOL_VERSION = 1;
exports.LINK_REPLY_MAILBOX_MAX_REQUEST_BYTES = 256 * 1024;
exports.LINK_REPLY_MAILBOX_MAX_RESPONSE_BYTES = 256 * 1024;
exports.LINK_REPLY_MAILBOX_MAX_WAIT_MS = 135_000;
const INSTANCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
exports.LINK_REPLY_MAILBOX_REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function userScope() {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    return uid === null ? 'user' : `uid-${uid}`;
}
function linkReplyMailboxRoot(instanceId) {
    if (!INSTANCE_ID_RE.test(instanceId))
        throw new Error('invalid reply-mailbox instance id');
    return node_path_1.default.join(node_os_1.default.tmpdir(), '1devtool-link-reply-mailbox', userScope(), instanceId);
}
function createLinkReplyMailboxEndpoint(instanceId) {
    const root = linkReplyMailboxRoot(instanceId);
    return {
        transport: 'file-reply-mailbox',
        protocolVersion: exports.LINK_REPLY_MAILBOX_PROTOCOL_VERSION,
        requestDir: node_path_1.default.join(root, 'requests'),
        responseDir: node_path_1.default.join(root, 'responses'),
    };
}
function isLinkReplyMailboxEndpoint(value, instanceId) {
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
        typeof instanceId !== 'string' || !INSTANCE_ID_RE.test(instanceId)) {
        return false;
    }
    const endpoint = value;
    if (endpoint.transport !== 'file-reply-mailbox' ||
        endpoint.protocolVersion !== exports.LINK_REPLY_MAILBOX_PROTOCOL_VERSION ||
        typeof endpoint.requestDir !== 'string' ||
        typeof endpoint.responseDir !== 'string') {
        return false;
    }
    const expected = createLinkReplyMailboxEndpoint(instanceId);
    return node_path_1.default.resolve(endpoint.requestDir) === node_path_1.default.resolve(expected.requestDir) &&
        node_path_1.default.resolve(endpoint.responseDir) === node_path_1.default.resolve(expected.responseDir);
}
function parseLinkReplyMailboxRequest(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return null;
    const request = value;
    const keys = Object.keys(value);
    if (keys.some((key) => ![
        'protocolVersion',
        'requestId',
        'action',
        'replyToken',
        'body',
        'createdAt',
        'waitMs',
        'gateDecision',
    ].includes(key))) {
        return null;
    }
    if (request.protocolVersion !== exports.LINK_REPLY_MAILBOX_PROTOCOL_VERSION ||
        request.action !== 'link-send-by-token' ||
        typeof request.requestId !== 'string' ||
        !exports.LINK_REPLY_MAILBOX_REQUEST_ID_RE.test(request.requestId) ||
        typeof request.replyToken !== 'string' ||
        !/^[0-9a-f]{24}$/i.test(request.replyToken) ||
        typeof request.body !== 'string' ||
        request.body.length === 0 ||
        request.body.length > 64_000 ||
        typeof request.createdAt !== 'number' ||
        !Number.isFinite(request.createdAt) ||
        Math.abs(Date.now() - request.createdAt) > exports.LINK_REPLY_MAILBOX_MAX_WAIT_MS) {
        return null;
    }
    if (request.gateDecision !== undefined && request.gateDecision !== 'accept' && request.gateDecision !== 'reject') {
        return null;
    }
    if (request.waitMs !== undefined &&
        (!Number.isInteger(request.waitMs) || request.waitMs < 0 || request.waitMs > 120_000)) {
        return null;
    }
    return request;
}
