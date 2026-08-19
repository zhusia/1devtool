"use strict";
/**
 * HappyRemote wire protocol — the small, provider-agnostic envelope format the
 * desktop emits from an AI agent's JSONL transcript and the phone reduces into
 * renderable messages. Modeled on slopus/happy's `@slopus/happy-wire`.
 *
 * This is the SINGLE SOURCE OF TRUTH for the protocol on the desktop side. The
 * remote-ui (Preact, separate vite project) keeps a byte-identical copy at
 * `src/remote-ui/src/happy/wire.ts` — keep the two in sync. The format is tiny
 * on purpose so that staying in sync is cheap.
 *
 * Design notes:
 * - Unlike `resumeManager`'s `AISessionMessage` (which flattens everything to
 *   `{role, content:string}`), this PRESERVES tool calls / results / thinking as
 *   structured events so the phone can render per-tool cards (Bash, diff, todo…).
 * - Phase 1 is intentionally turn-less: we emit a flat ordered envelope stream
 *   and the reducer pairs tool-call-start/end by `call` id. Turn grouping is a
 *   Phase-2 nicety.
 */
Object.defineProperty(exports, "__esModule", { value: true });
