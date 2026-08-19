"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.gitlabClient = exports.githubClient = void 0;
exports.getGitHostClient = getGitHostClient;
const github_1 = require("./github");
const gitlab_1 = require("./gitlab");
var github_2 = require("./github");
Object.defineProperty(exports, "githubClient", { enumerable: true, get: function () { return github_2.githubClient; } });
var gitlab_2 = require("./gitlab");
Object.defineProperty(exports, "gitlabClient", { enumerable: true, get: function () { return gitlab_2.gitlabClient; } });
// Resolve the REST client for a provider. Defaults to GitHub for any unknown
// value so an out-of-range provider string can never crash the IPC layer.
function getGitHostClient(provider) {
    return provider === 'gitlab' ? gitlab_1.gitlabClient : github_1.githubClient;
}
