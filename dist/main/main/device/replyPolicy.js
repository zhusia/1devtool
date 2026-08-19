"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authorizeFederatedReply = authorizeFederatedReply;
const DENIED = {
    code: 'DEVICE_GRANT_MISSING',
    message: 'The originating federated edge or reply capability is missing or changed.',
};
/**
 * A reply is authorized by the exact capability the originator issued, not by
 * a broad peer grant. The originator already chose both terminal endpoints
 * when it created the link and sent the original message. Requiring the
 * active generation-bound edge plus that message's single-use secret keeps
 * the reverse path narrower than `orchestrationWrite`.
 */
function authorizeFederatedReply(input) {
    const request = input.request;
    if (!request || !request.originalReplyToken)
        return { ok: false, error: DENIED };
    const link = input.links.find((row) => row.state === 'active' &&
        row.linkId === request.linkId &&
        row.admissionId === request.admissionId &&
        row.to.deviceId === input.peerDeviceId &&
        row.to.terminalId === request.from?.terminalId &&
        row.to.terminalGeneration === request.from?.terminalGeneration &&
        row.from.terminalId === request.to?.terminalId &&
        row.from.terminalGeneration === request.to?.terminalGeneration);
    if (!link)
        return { ok: false, error: DENIED };
    const original = input.messages.find((row) => row.messageId === request.originalMessageId &&
        row.linkId === link.linkId &&
        row.admissionId === link.admissionId &&
        row.to.deviceId === input.peerDeviceId &&
        row.to.terminalId === request.from.terminalId &&
        row.to.terminalGeneration === request.from.terminalGeneration &&
        row.from.terminalId === link.from.terminalId &&
        row.from.terminalGeneration === link.from.terminalGeneration &&
        (row.state === 'delivered' || row.state === 'answered') &&
        row.replyToken === request.originalReplyToken);
    if (!original)
        return { ok: false, error: DENIED };
    return { ok: true, link, original };
}
