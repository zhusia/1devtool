"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GSTACK_DEFAULT_PATH = exports.GSTACK_REPO_URL = exports.GSTACK_PHASES_ORDERED = exports.GSTACK_PHASE_LABELS = exports.GSTACK_PHASE_COLORS = exports.GSTACK_CHAIN_CONNECTIONS = exports.GSTACK_PHASE_MAP = void 0;
exports.GSTACK_PHASE_MAP = {
    'office-hours': { phase: 'think', specialist: 'YC Office Hours' },
    'plan-ceo-review': { phase: 'plan', specialist: 'CEO / Founder' },
    'plan-eng-review': { phase: 'plan', specialist: 'Eng Manager' },
    'plan-design-review': { phase: 'plan', specialist: 'Senior Designer' },
    'design-consultation': { phase: 'plan', specialist: 'Design Partner' },
    'design-review': { phase: 'build', specialist: 'Designer Who Codes' },
    'review': { phase: 'review', specialist: 'Staff Engineer' },
    'investigate': { phase: 'review', specialist: 'Debugger' },
    'codex': { phase: 'review', specialist: 'Second Opinion' },
    'qa': { phase: 'test', specialist: 'QA Lead' },
    'qa-only': { phase: 'test', specialist: 'QA Reporter' },
    'browse': { phase: 'test', specialist: 'QA Engineer' },
    'setup-browser-cookies': { phase: 'test', specialist: 'Session Manager' },
    'benchmark': { phase: 'test', specialist: 'Benchmark Runner' },
    'ship': { phase: 'ship', specialist: 'Release Engineer' },
    'land-and-deploy': { phase: 'ship', specialist: 'Deploy Engineer' },
    'canary': { phase: 'ship', specialist: 'Canary Deployer' },
    'setup-deploy': { phase: 'ship', specialist: 'Deploy Setup' },
    'document-release': { phase: 'reflect', specialist: 'Technical Writer' },
    'retro': { phase: 'reflect', specialist: 'Eng Manager' },
    'careful': { phase: 'safety', specialist: 'Safety Guardrails' },
    'freeze': { phase: 'safety', specialist: 'Edit Lock' },
    'guard': { phase: 'safety', specialist: 'Full Safety' },
    'unfreeze': { phase: 'safety', specialist: 'Unlock' },
    'gstack-upgrade': { phase: 'safety', specialist: 'Self-Updater' },
};
exports.GSTACK_CHAIN_CONNECTIONS = [
    { from: 'office-hours', to: 'plan-ceo-review', label: 'design doc' },
    { from: 'office-hours', to: 'plan-eng-review', label: 'design doc' },
    { from: 'office-hours', to: 'plan-design-review', label: 'design doc' },
    { from: 'plan-eng-review', to: 'qa', label: 'test plan' },
    { from: 'review', to: 'ship', label: 'findings verified' },
    { from: 'ship', to: 'document-release', label: 'auto-invoke' },
];
exports.GSTACK_PHASE_COLORS = {
    think: '#8B5CF6',
    plan: '#3B82F6',
    build: '#10B981',
    review: '#F59E0B',
    test: '#06B6D4',
    ship: '#EC4899',
    reflect: '#6B7280',
    safety: '#EF4444',
};
exports.GSTACK_PHASE_LABELS = {
    think: 'Think',
    plan: 'Plan',
    build: 'Build',
    review: 'Review',
    test: 'Test',
    ship: 'Ship',
    reflect: 'Reflect',
    safety: 'Safety',
};
exports.GSTACK_PHASES_ORDERED = [
    'think', 'plan', 'build', 'review', 'test', 'ship', 'reflect', 'safety',
];
exports.GSTACK_REPO_URL = 'https://github.com/garrytan/gstack.git';
exports.GSTACK_DEFAULT_PATH = '~/.claude/skills/gstack';
