"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.observeTerminalConnection = observeTerminalConnection;
/**
 * Read-only main-internal adapter for orchestration/readiness consumers.
 * It applies each raw snapshot/frame synchronously before acknowledging it and
 * never requests dimensions, input, launch, task, or remote authority.
 */
const node_crypto_1 = require("node:crypto");
// Terminal hotspot: read docs/common-errors/terminals/INDEX.md before editing.
const connectionProtocol_1 = require("../../shared/terminal/connectionProtocol");
function rawContent(result) {
    if (result.payload.kind !== 'raw')
        return '';
    return result.payload.rawFallback.content + result.payload.rawFallback.unbufferedOverlap
        .sort((left, right) => left.cursor.streamSeq - right.cursor.streamSeq)
        .map((fragment) => fragment.data)
        .join('');
}
async function observeTerminalConnection(options) {
    const principal = {
        origin: 'orchestration-observer',
        subjectId: options.subjectId,
        permissions: new Set(['read']),
    };
    let disposed = false;
    let connectionId = null;
    const applyFrame = (frame) => {
        if (disposed || frame.connectionId !== connectionId)
            return;
        if (frame.event.type === 'output')
            options.onOutput(frame.event.data);
        else if (frame.event.type === 'exit')
            options.onExit?.(frame.event.code);
        else if (frame.event.type === 'resync-required') {
            void options.service.resync(frame.connectionId, principal).then((result) => {
                if (disposed)
                    return;
                options.onSnapshot(rawContent(result), true);
                options.service.ack(result.connectionId, result.syncGeneration, result.attachFrameId, principal);
            }).catch(() => { });
            return;
        }
        options.service.ack(frame.connectionId, frame.syncGeneration, frame.frameId, principal);
    };
    const result = await options.service.attach({
        terminalId: options.terminalId,
        clientRequestId: (0, node_crypto_1.randomUUID)(),
        capabilities: [...connectionProtocol_1.RAW_V2_CAPABILITIES],
        historyMode: 'normal',
    }, principal, applyFrame);
    connectionId = result.connectionId;
    options.onSnapshot(rawContent(result), true);
    options.service.ack(result.connectionId, result.syncGeneration, result.attachFrameId, principal);
    return {
        identity: result.session.identity,
        dispose() {
            if (disposed)
                return;
            disposed = true;
            options.service.detach(result.connectionId, principal);
        },
    };
}
