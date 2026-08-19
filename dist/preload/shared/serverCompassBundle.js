"use strict";
// Mirrors Server Compass v1 bundle schema. Keep in sync with
// the upstream repo at electron/ipc/types/bundle-import-schemas.ts.
//
// We don't validate with Zod on this side — Server Compass re-validates
// everything anyway. We just need the type to construct payloads correctly.
Object.defineProperty(exports, "__esModule", { value: true });
exports.SERVER_COMPASS_BUNDLE_VERSION = void 0;
exports.SERVER_COMPASS_BUNDLE_VERSION = 1;
