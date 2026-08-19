"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureSecretsGitignored = ensureSecretsGitignored;
const fs_1 = require("fs");
const files_1 = require("./files");
const SECRETS_LINE = 'secrets.local.json';
/**
 * Ensure `.1devtool/.gitignore` excludes `secrets.local.json` so an encrypted
 * secret value can never be committed. Idempotent: appends the line only when
 * it isn't already present. Must run before any secret is written to disk.
 * Creates the `.1devtool/` folder first — this may run before any domain file
 * (which is what otherwise mkdir's the folder) has been written.
 */
async function ensureSecretsGitignored(rootPath) {
    await fs_1.promises.mkdir((0, files_1.settingsDir)(rootPath), { recursive: true });
    const file = (0, files_1.gitignorePath)(rootPath);
    let existing = '';
    try {
        existing = await fs_1.promises.readFile(file, 'utf8');
    }
    catch (err) {
        if (err.code !== 'ENOENT')
            throw err;
    }
    const hasLine = existing
        .split(/\r?\n/)
        .some((line) => line.trim() === SECRETS_LINE);
    if (hasLine)
        return;
    const prefix = existing.length && !existing.endsWith('\n') ? '\n' : '';
    await fs_1.promises.writeFile(file, `${existing}${prefix}${SECRETS_LINE}\n`, 'utf8');
}
