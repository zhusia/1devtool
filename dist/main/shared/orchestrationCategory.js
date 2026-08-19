"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ORCHESTRATION_CATEGORY_RE = void 0;
/**
 * Category slug shape shared by `--category` validation (CLI, run records)
 * and custom routing-category ids (policy, dashboard). Kept in its own pure
 * module so renderer bundles can import policy values without dragging the
 * run-record module's node:fs dependency in.
 */
exports.ORCHESTRATION_CATEGORY_RE = /^[a-z][a-z0-9-]{1,23}$/;
