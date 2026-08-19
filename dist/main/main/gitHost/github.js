"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.githubClient = void 0;
// GitHub REST client. This is the exact behaviour that previously lived inline
// in the `github:*` ipcMain handlers (same endpoints, headers, auth, and error
// parsing) — moved here verbatim so the IPC layer can delegate and so the
// provider registry is symmetric. Do NOT change the GitHub behaviour here.
const GITHUB_API = 'https://api.github.com';
function githubHeaders(token) {
    return {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token.trim()}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': '1DevTool',
    };
}
async function readGithubError(response) {
    let detail = `HTTP ${response.status}`;
    try {
        const errBody = (await response.json());
        if (errBody.message)
            detail = errBody.message;
        if (errBody.errors?.length) {
            detail += ': ' + errBody.errors.map((e) => e.message).filter(Boolean).join(', ');
        }
    }
    catch {
        // Body wasn't JSON; stick with the status code.
    }
    return detail;
}
exports.githubClient = {
    async getViewer(token) {
        const trimmed = token?.trim();
        if (!trimmed) {
            throw new Error('No GitHub token.');
        }
        let response;
        try {
            response = await fetch(`${GITHUB_API}/user`, {
                method: 'GET',
                headers: githubHeaders(trimmed),
            });
        }
        catch (networkError) {
            throw new Error(`Network error contacting GitHub: ${networkError.message}`);
        }
        if (!response.ok) {
            throw new Error(`GitHub API error: ${await readGithubError(response)}`);
        }
        const data = (await response.json());
        // Classic PATs report their scopes in `X-OAuth-Scopes` (comma-separated;
        // empty string = zero scopes). Fine-grained tokens omit the header → null
        // (unknown), which the UI treats as "can't tell" rather than warning.
        const scopesHeader = response.headers.get('x-oauth-scopes');
        const scopes = scopesHeader != null
            ? scopesHeader.split(',').map((s) => s.trim()).filter(Boolean)
            : null;
        return {
            provider: 'github',
            login: data.login || '',
            name: data.name || null,
            avatarUrl: data.avatar_url || null,
            scopes,
        };
    },
    async listRepositories(token) {
        const trimmed = token?.trim();
        if (!trimmed) {
            throw new Error('No GitHub token.');
        }
        let response;
        try {
            response = await fetch(`${GITHUB_API}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member`, {
                method: 'GET',
                headers: githubHeaders(trimmed),
            });
        }
        catch (networkError) {
            throw new Error(`Network error contacting GitHub: ${networkError.message}`);
        }
        if (!response.ok) {
            throw new Error(`GitHub API error: ${await readGithubError(response)}`);
        }
        const data = (await response.json());
        return data.map((repo) => ({
            provider: 'github',
            name: repo.name || '',
            fullName: repo.full_name || '',
            cloneUrl: repo.clone_url || '',
            sshUrl: repo.ssh_url || '',
            htmlUrl: repo.html_url || '',
            isPrivate: !!repo.private,
            description: repo.description || null,
            updatedAt: repo.updated_at || null,
        }));
    },
    async createRepository(token, opts) {
        const trimmed = token?.trim();
        if (!trimmed) {
            throw new Error('No GitHub token. Add a Personal Access Token to your git account in Settings → Git.');
        }
        if (!opts.name?.trim()) {
            throw new Error('Repository name is required.');
        }
        // GitHub: namespaceId is the org login (or empty/null → personal account).
        const org = opts.namespaceId?.trim() || '';
        const url = org
            ? `${GITHUB_API}/orgs/${encodeURIComponent(org)}/repos`
            : `${GITHUB_API}/user/repos`;
        const body = JSON.stringify({
            name: opts.name.trim(),
            description: opts.description?.trim() || undefined,
            private: !!opts.isPrivate,
            auto_init: false,
        });
        let response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: { ...githubHeaders(trimmed), 'Content-Type': 'application/json' },
                body,
            });
        }
        catch (networkError) {
            throw new Error(`Network error contacting GitHub: ${networkError.message}`);
        }
        if (!response.ok) {
            throw new Error(`GitHub API error: ${await readGithubError(response)}`);
        }
        const data = (await response.json());
        return {
            sshUrl: data.ssh_url || '',
            cloneUrl: data.clone_url || '',
            htmlUrl: data.html_url || '',
            fullName: data.full_name || '',
        };
    },
    async checkRepoAccess(token, fullPath) {
        const trimmed = token?.trim();
        const parts = (fullPath || '').split('/').filter(Boolean);
        const owner = parts[0]?.trim();
        const repo = parts[1]?.trim();
        if (!trimmed || !owner || !repo) {
            return { exists: false, push: false };
        }
        let response;
        try {
            response = await fetch(`${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
                method: 'GET',
                headers: githubHeaders(trimmed),
            });
        }
        catch {
            return { exists: false, push: false };
        }
        if (response.status === 404 || response.status === 401 || response.status === 403) {
            return { exists: false, push: false };
        }
        if (!response.ok) {
            return { exists: false, push: false };
        }
        try {
            const data = (await response.json());
            return { exists: true, push: !!data.permissions?.push };
        }
        catch {
            return { exists: true, push: false };
        }
    },
    async listNamespaces(token) {
        const trimmed = token?.trim();
        if (!trimmed) {
            throw new Error('No GitHub token.');
        }
        let response;
        try {
            response = await fetch(`${GITHUB_API}/user/orgs?per_page=100`, {
                method: 'GET',
                headers: githubHeaders(trimmed),
            });
        }
        catch (networkError) {
            throw new Error(`Network error contacting GitHub: ${networkError.message}`);
        }
        if (!response.ok) {
            throw new Error(`GitHub API error: ${await readGithubError(response)}`);
        }
        const data = (await response.json());
        return data
            .filter((org) => !!org.login)
            .map((org) => ({
            id: org.login, // GitHub uses the login as the URL path segment
            name: org.login,
            path: org.login,
            kind: 'organization',
        }));
    },
};
