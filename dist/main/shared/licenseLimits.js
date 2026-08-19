"use strict";
/**
 * Free-tier usage limits.
 *
 * Imported by both main (LicenseService) and renderer (LicenseDialog UI copy)
 * so the displayed number always matches the enforced number. Change values
 * here to adjust caps.
 *
 * The previous lifetime-message cap (`FREE_TIER_MESSAGE_LIMIT`) was removed
 * intentionally — it was anti-onboarding and didn't protect a real cost
 * (inference is BYOK). Conversion is now driven by structural caps below
 * plus visible Pro-only features in the UI.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FREE_TIER_LIMITS = void 0;
exports.FREE_TIER_LIMITS = {
    /** Number of projects a free user can have. */
    projects: 1,
    /** Terminals per project. */
    terminalsPerProject: 4,
    /** Browser tabs across all projects (currently per-project enforcement). */
    browserTabs: 1,
    /** Channels across all projects (global cap). */
    channelsGlobal: 3,
    /** Saved DB connections within a single project. */
    dbConnectionsPerProject: 1,
    /** Saved DB connections shared across all projects. */
    dbConnectionsGlobal: 1,
    /** Saved HTTP requests in collections. */
    httpSavedRequests: 5,
    /** Git worktrees within a single project. */
    gitWorktreesPerProject: 1,
    /** Projects a free user can bind into one workspace (Workspace Control). */
    workspaceProjects: 1,
    /** AI Diff invocations allowed per local-day. Resets at local midnight. */
    aiDiffPerDay: 5,
    /** Days of prompt-history retention on free. */
    promptHistoryRetentionDays: 7,
    /** Days of resume-session retention on free. */
    resumeSessionsRetentionDays: 7,
    /** Days of AI memory retention on free. */
    aiMemoryRetentionDays: 7,
};
