"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCandidateHosts = getCandidateHosts;
exports.getLanIp = getLanIp;
/**
 * LAN IPv4 discovery for the device pairing URL. Same interface preference
 * and VPN-skip policy as the phone Remote server (src/main/remote/index.ts).
 */
const os_1 = __importDefault(require("os"));
const VPN_PATTERNS = /^(utun|tun|tap|ppp|wg|tailscale|ipsec|gpd|vmnet|veth|docker|br-)/i;
const PREFERRED_NAMES = ['en0', 'eth0', 'en1', 'eth1', 'wlan0', 'Wi-Fi'];
function isLanAddress(addr) {
    return (addr.startsWith('192.168.') ||
        addr.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(addr));
}
function isUsable(info) {
    return (info.family === 'IPv4' &&
        !info.internal &&
        !info.address.startsWith('169.254.') &&
        !info.address.startsWith('127.'));
}
/**
 * Every address this host might be reachable on, best first: LAN, then
 * VPN/tunnel interfaces (Tailscale, WireGuard, utun…), then anything else
 * routable. Unlike the phone Remote server — which only ever advertises a LAN
 * address — peer desktops are frequently reachable ONLY over a VPN (laptop ↔
 * VPS), so the pairing code carries the whole list and the other side probes
 * them in order.
 *
 * Note Tailscale's CGNAT range (100.64/10) is not RFC1918, so it is picked up
 * by the tunnel pass rather than the LAN pass.
 */
function getCandidateHosts() {
    const interfaces = os_1.default.networkInterfaces();
    const hosts = [];
    const push = (addr) => {
        if (!hosts.includes(addr))
            hosts.push(addr);
    };
    const lan = getLanIp();
    if (lan !== '127.0.0.1')
        push(lan);
    // Tunnel interfaces that actually carry an IPv4 address.
    for (const [name, iface] of Object.entries(interfaces)) {
        if (!iface || !VPN_PATTERNS.test(name))
            continue;
        for (const info of iface) {
            if (isUsable(info))
                push(info.address);
        }
    }
    // Anything else routable (a non-RFC1918 LAN, a bridged network).
    for (const [name, iface] of Object.entries(interfaces)) {
        if (!iface || VPN_PATTERNS.test(name))
            continue;
        for (const info of iface) {
            if (isUsable(info))
                push(info.address);
        }
    }
    return hosts.length > 0 ? hosts : ['127.0.0.1'];
}
function getLanIp() {
    const interfaces = os_1.default.networkInterfaces();
    for (const name of PREFERRED_NAMES) {
        const iface = interfaces[name];
        if (!iface)
            continue;
        for (const info of iface) {
            if (isUsable(info) && isLanAddress(info.address))
                return info.address;
        }
    }
    for (const [name, iface] of Object.entries(interfaces)) {
        if (!iface || VPN_PATTERNS.test(name))
            continue;
        for (const info of iface) {
            if (isUsable(info) && isLanAddress(info.address))
                return info.address;
        }
    }
    for (const [name, iface] of Object.entries(interfaces)) {
        if (!iface || VPN_PATTERNS.test(name))
            continue;
        for (const info of iface) {
            if (isUsable(info))
                return info.address;
        }
    }
    return '127.0.0.1';
}
