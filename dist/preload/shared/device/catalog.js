"use strict";
/**
 * Multi-Control Device — resource catalog schema (plan §6.3).
 *
 * A peer exposes a versioned snapshot of what it offers. P0 sections:
 * terminals + clis + projects, all read-only. Later sections (memories,
 * sessions, accounts, skills, orchestration) extend this file with new
 * optional fields — never repurpose existing ones without a protocol bump.
 *
 * INVARIANT: nothing in this schema may ever carry secret material
 * (auth keys, tokens, credential file contents). Enforced by unit test.
 */
Object.defineProperty(exports, "__esModule", { value: true });
