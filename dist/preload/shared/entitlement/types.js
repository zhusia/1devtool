"use strict";
// Signed-entitlement types — Workstream A / roadmap #8, phase P0.
// See docs/product/strategy/licensing-updates-monetization.md §4.1 for the wire shape.
//
// The server (Worker, P1) mints a `SignedEntitlement`: the `entitlement` payload
// plus an Ed25519 `signature` computed over the CANONICAL bytes of `entitlement`
// (see ./canonicalize.ts). The app stores payload + signature and verifies on boot
// with the embedded public key. The private key never ships.
Object.defineProperty(exports, "__esModule", { value: true });
