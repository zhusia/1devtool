"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.federatedLinkKey = federatedLinkKey;
function federatedLinkKey(fromTerminalId, deviceId, toTerminalId) {
    return `${fromTerminalId}|${deviceId}|${toTerminalId}`;
}
