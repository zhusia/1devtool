"use strict";
// Crontab schedule parsing/validation shared by the main-process CronManager
// and the renderer's cron job UI so both sides accept exactly the same lines.
Object.defineProperty(exports, "__esModule", { value: true });
exports.CRON_MACROS = void 0;
exports.validateCronSchedule = validateCronSchedule;
exports.validateCronCommand = validateCronCommand;
exports.parseCronJobLine = parseCronJobLine;
exports.CRON_MACROS = [
    '@yearly',
    '@annually',
    '@monthly',
    '@weekly',
    '@daily',
    '@midnight',
    '@hourly',
    '@reboot',
];
const MONTH_NAMES = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const DOW_NAMES = 'sun|mon|tue|wed|thu|fri|sat';
// One schedule field: comma list of [* | atom | atom-atom] with optional /step.
// Atoms are numeric, plus the name forms cron accepts for month/weekday.
// Deliberately strict — a prose word must never validate, or plain crontab
// comments would be misread as disabled jobs.
function fieldPattern(names) {
    const atom = names ? `(?:\\d+|${names})` : '\\d+';
    const item = `(?:\\*|${atom}(?:-${atom})?)(?:/\\d+)?`;
    return new RegExp(`^${item}(?:,${item})*$`, 'i');
}
// minute, hour, day-of-month, month, day-of-week
const FIELD_RES = [
    fieldPattern(),
    fieldPattern(),
    fieldPattern(),
    fieldPattern(MONTH_NAMES),
    fieldPattern(DOW_NAMES),
];
function validateCronSchedule(schedule) {
    const trimmed = schedule.trim();
    if (!trimmed)
        return 'Schedule is required';
    if (trimmed.startsWith('@')) {
        return exports.CRON_MACROS.includes(trimmed.toLowerCase())
            ? null
            : `Unknown schedule macro "${trimmed}"`;
    }
    const fields = trimmed.split(/\s+/);
    if (fields.length !== 5) {
        return 'Schedule needs 5 fields (minute hour day month weekday) or a @macro like @daily';
    }
    if (!fields.every((f, i) => FIELD_RES[i].test(f))) {
        return 'Schedule contains an invalid field';
    }
    return null;
}
function validateCronCommand(command) {
    const trimmed = command.trim();
    if (!trimmed)
        return 'Command is required';
    if (/[\r\n]/.test(trimmed))
        return 'Command must be a single line';
    return null;
}
// Parses one crontab line into schedule + command, or null when the line is
// not a job (blank, env assignment, plain comment). The command is sliced
// from the raw text after the 5th field so interior spacing survives.
function parseCronJobLine(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return null;
    if (trimmed.startsWith('@')) {
        const space = trimmed.search(/\s/);
        if (space === -1)
            return null;
        const macro = trimmed.slice(0, space);
        if (!exports.CRON_MACROS.includes(macro.toLowerCase()))
            return null;
        const command = trimmed.slice(space).trim();
        if (!command)
            return null;
        return { schedule: macro, command };
    }
    const re = /\S+/g;
    const fields = [];
    let commandStart = -1;
    let match;
    while (fields.length < 5 && (match = re.exec(trimmed))) {
        fields.push(match[0]);
        commandStart = re.lastIndex;
    }
    if (fields.length < 5)
        return null;
    if (!fields.every((f, i) => FIELD_RES[i].test(f)))
        return null;
    const command = trimmed.slice(commandStart).trim();
    if (!command)
        return null;
    return { schedule: fields.join(' '), command };
}
