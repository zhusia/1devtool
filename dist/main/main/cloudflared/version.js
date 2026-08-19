"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CLOUDFLARED_VERSION_FALLBACK = exports.SHA256SUMS_URL = exports.RELEASE_BASE = void 0;
// We always pull GitHub's `releases/latest/download/<asset>` URL, which 302s
// to whatever the current latest release is. Pinning a specific tag is
// brittle because: (a) we have to guess a version that exists, (b) cloudflared
// releases sometimes get yanked. The resolved tag is recorded in the install
// metadata so the UI shows what was actually installed.
exports.RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
exports.SHA256SUMS_URL = `${exports.RELEASE_BASE}/sha256sums.txt`;
// Displayed in the UI before the meta file records the real tag. Replaced
// post-install with the actual version parsed from the redirect chain.
exports.CLOUDFLARED_VERSION_FALLBACK = 'latest';
