"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fileContentHash = fileContentHash;
exports.isApproved = isApproved;
exports.recordApproval = recordApproval;
exports.pendingFor = pendingFor;
const files_1 = require("./files");
/**
 * trust — executable-file approval. A `.1devtool/` folder that arrived via
 * `git clone` is untrusted input, so files that can cause a process to run
 * (agents.json, channels.json, skills/**) are held until the user approves them
 * in the apply-review sheet. Approval is a content hash per file kept in
 * electron-store meta (never in the folder — a clone can't pre-approve itself);
 * a later `git pull` that changes the file yields a new hash and re-prompts for
 * that file only. Unchanged files never re-prompt.
 */
function fileContentHash(text) {
    return (0, files_1.contentHash)(text);
}
function isApproved(meta, fileName, hash) {
    return meta.approvals[fileName] === hash;
}
function recordApproval(meta, fileName, hash) {
    return { ...meta, approvals: { ...meta.approvals, [fileName]: hash } };
}
/** File names in `files` that are not currently approved at their present hash. */
function pendingFor(meta, files) {
    return files.filter(({ file, hash }) => !isApproved(meta, file, hash)).map(({ file }) => file);
}
