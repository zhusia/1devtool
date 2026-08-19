"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.gitlabClient = void 0;
// GitLab REST client (gitlab.com + self-hosted). Mirrors the GitHub client's
// shape and error handling, adapted to GitLab's /api/v4 surface:
//   - version lives in the URL path, not a header
//   - the current user's handle is `username`, not `login`
//   - projects use path_with_namespace (can be nested: group/subgroup/project)
//   - create takes a numeric namespace_id (resolved via /namespaces)
//   - push access is derived from access_level (>= 30 = Developer)
const DEFAULT_INSTANCE = 'https://gitlab.com';
// Normalise an instance URL → `<base>/api/v4` (trailing slashes trimmed).
function apiBase(instanceUrl) {
    const base = (instanceUrl?.trim().replace(/\/+$/, '')) || DEFAULT_INSTANCE;
    return `${base}/api/v4`;
}
function gitlabHeaders(token) {
    return {
        Authorization: `Bearer ${token.trim()}`,
        Accept: 'application/json',
        'User-Agent': '1DevTool',
    };
}
// Best-effort: read the PAT's granted scopes via token self-introspection.
// Available on GitLab ≥14.0 for personal access tokens; OAuth tokens and older
// instances return 404 here, in which case scopes stay unknown (null) and the
// UI simply skips the scope warning. Never throws — token identity (getViewer)
// must not depend on this call succeeding.
async function fetchTokenScopes(token, instanceUrl) {
    try {
        const response = await fetch(`${apiBase(instanceUrl)}/personal_access_tokens/self`, {
            method: 'GET',
            headers: gitlabHeaders(token),
        });
        if (!response.ok)
            return null;
        const data = (await response.json());
        return Array.isArray(data.scopes)
            ? data.scopes.filter((s) => typeof s === 'string')
            : null;
    }
    catch {
        return null;
    }
}
async function readGitlabError(response) {
    let detail = `HTTP ${response.status}`;
    try {
        const errBody = (await response.json());
        const pick = errBody.message ?? errBody.error ?? errBody.error_description;
        if (typeof pick === 'string' && pick.trim()) {
            detail = pick;
        }
        else if (pick && typeof pick === 'object') {
            // GitLab sometimes returns { message: { name: ["has already been taken"] } }
            try {
                const flat = Object.entries(pick)
                    .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(', ') : String(v)}`)
                    .join('; ');
                if (flat.trim())
                    detail = flat;
            }
            catch {
                // ignore
            }
        }
    }
    catch {
        // Body wasn't JSON; stick with the status code.
    }
    return detail;
}
function mapProject(p) {
    return {
        provider: 'gitlab',
        name: p.name || '',
        fullName: p.path_with_namespace || '',
        cloneUrl: p.http_url_to_repo || '',
        sshUrl: p.ssh_url_to_repo || '',
        htmlUrl: p.web_url || '',
        isPrivate: (p.visibility || 'private') !== 'public',
        description: p.description || null,
        updatedAt: p.last_activity_at || null,
    };
}
exports.gitlabClient = {
    async getViewer(token, instanceUrl) {
        const trimmed = token?.trim();
        if (!trimmed) {
            throw new Error('No GitLab token.');
        }
        let response;
        try {
            response = await fetch(`${apiBase(instanceUrl)}/user`, {
                method: 'GET',
                headers: gitlabHeaders(trimmed),
            });
        }
        catch (networkError) {
            throw new Error(`Network error contacting GitLab: ${networkError.message}`);
        }
        if (!response.ok) {
            throw new Error(`GitLab API error: ${await readGitlabError(response)}`);
        }
        const data = (await response.json());
        // Best-effort scope read so the publish dialog can warn when a token can
        // verify + read but lacks the `api` scope needed to create projects.
        const scopes = await fetchTokenScopes(trimmed, instanceUrl);
        return {
            provider: 'gitlab',
            login: data.username || '',
            name: data.name || null,
            avatarUrl: data.avatar_url || null,
            scopes,
        };
    },
    async listRepositories(token, instanceUrl) {
        const trimmed = token?.trim();
        if (!trimmed) {
            throw new Error('No GitLab token.');
        }
        let response;
        try {
            response = await fetch(`${apiBase(instanceUrl)}/projects?membership=true&per_page=100&order_by=last_activity_at`, {
                method: 'GET',
                headers: gitlabHeaders(trimmed),
            });
        }
        catch (networkError) {
            throw new Error(`Network error contacting GitLab: ${networkError.message}`);
        }
        if (!response.ok) {
            throw new Error(`GitLab API error: ${await readGitlabError(response)}`);
        }
        const data = (await response.json());
        return Array.isArray(data) ? data.map(mapProject) : [];
    },
    async createRepository(token, opts, instanceUrl) {
        const trimmed = token?.trim();
        if (!trimmed) {
            throw new Error('No GitLab token. Add a Personal Access Token to your git account in Settings → Git.');
        }
        if (!opts.name?.trim()) {
            throw new Error('Project name is required.');
        }
        const namespaceId = opts.namespaceId?.trim();
        const body = JSON.stringify({
            name: opts.name.trim(),
            description: opts.description?.trim() || undefined,
            visibility: opts.isPrivate ? 'private' : 'public',
            namespace_id: namespaceId ? Number(namespaceId) : undefined,
        });
        let response;
        try {
            response = await fetch(`${apiBase(instanceUrl)}/projects`, {
                method: 'POST',
                headers: { ...gitlabHeaders(trimmed), 'Content-Type': 'application/json' },
                body,
            });
        }
        catch (networkError) {
            throw new Error(`Network error contacting GitLab: ${networkError.message}`);
        }
        if (!response.ok) {
            const detail = await readGitlabError(response);
            // GitLab returns 403 `{ "error": "insufficient_scope" }` when the token
            // authenticates fine but lacks the `api` scope that POST /projects needs
            // (read-only / `write_repository`-only tokens hit this). The raw string
            // is cryptic, so translate it into the actual fix.
            if (response.status === 403 && /insufficient_scope/i.test(detail)) {
                throw new Error("This GitLab token can't create projects — it's missing the 'api' scope. " +
                    "Regenerate the token with the 'api' scope checked, then update it in Settings → Git.");
            }
            throw new Error(`GitLab API error: ${detail}`);
        }
        const data = (await response.json());
        return {
            sshUrl: data.ssh_url_to_repo || '',
            cloneUrl: data.http_url_to_repo || '',
            htmlUrl: data.web_url || '',
            fullName: data.path_with_namespace || '',
        };
    },
    async checkRepoAccess(token, fullPath, instanceUrl) {
        const trimmed = token?.trim();
        const path = (fullPath || '').replace(/^\/+|\/+$/g, '');
        if (!trimmed || !path) {
            return { exists: false, push: false };
        }
        let response;
        try {
            // GitLab takes the URL-encoded full path (namespace + subgroups + project)
            // as the project id. encodeURIComponent turns the `/`s into %2F.
            response = await fetch(`${apiBase(instanceUrl)}/projects/${encodeURIComponent(path)}`, {
                method: 'GET',
                headers: gitlabHeaders(trimmed),
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
            const projectLevel = data.permissions?.project_access?.access_level ?? 0;
            const groupLevel = data.permissions?.group_access?.access_level ?? 0;
            // GitLab access levels: 30 = Developer (can push to non-protected refs).
            const push = Math.max(projectLevel, groupLevel) >= 30;
            return { exists: true, push };
        }
        catch {
            return { exists: true, push: false };
        }
    },
    async listNamespaces(token, instanceUrl) {
        const trimmed = token?.trim();
        if (!trimmed) {
            throw new Error('No GitLab token.');
        }
        let response;
        try {
            response = await fetch(`${apiBase(instanceUrl)}/namespaces?per_page=100`, {
                method: 'GET',
                headers: gitlabHeaders(trimmed),
            });
        }
        catch (networkError) {
            throw new Error(`Network error contacting GitLab: ${networkError.message}`);
        }
        if (!response.ok) {
            throw new Error(`GitLab API error: ${await readGitlabError(response)}`);
        }
        const data = (await response.json());
        return (Array.isArray(data) ? data : [])
            .filter((ns) => ns.id != null)
            .map((ns) => ({
            id: String(ns.id),
            name: ns.name || ns.path || '',
            path: ns.full_path || ns.path || '',
            kind: ns.kind === 'user' ? 'user' : 'group',
        }));
    },
};
