/**
 * github/client.ts — Real Github REST API client.
 *
 * Per Round 4 Projects Feature spec.
 *
 * Mirrors backlog/monday-client.ts in shape so the same operational patterns
 * apply (token resolution, retry/backoff, error codes).
 *
 * We use native fetch (Node 18+) intentionally instead of @octokit/rest:
 *   1. The codebase already uses native fetch for Monday + Anthropic.
 *   2. octokit pulls in a deep dependency tree we don't need.
 *   3. The errors we care about (401, 403 with X-RateLimit-Remaining=0, 404,
 *      5xx) are trivial to handle from raw HTTP.
 *
 * Token resolution order:
 *   1. Constructor-injected `token` option (test surrogate)
 *   2. Keychain account 'github.api_token' (production)
 *   3. process.env.GITHUB_API_TOKEN (dev fallback)
 *   4. Throw STARTUP_ERROR
 */
import { OrbitalError } from '@orbital/types';
import { logger } from '../config/logger.js';
import { getKeychain } from '../capabilities/keychain.js';
import { GITHUB_ERROR_CODES, } from './types.js';
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
const KEYCHAIN_ACCOUNT_GITHUB_TOKEN = 'github.api_token';
const ENV_VAR_GITHUB_TOKEN = 'GITHUB_API_TOKEN';
export class DefaultGithubClient {
    resolvedToken = null;
    apiUrl;
    maxRetries;
    baseBackoffMs;
    maxBackoffMs;
    fetchImpl;
    sleepFn;
    explicitToken;
    constructor(options = {}) {
        this.apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
        this.maxRetries = options.maxRetries ?? 5;
        this.baseBackoffMs = options.baseBackoffMs ?? 1000;
        this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
        this.sleepFn = options.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
        if (options.token)
            this.explicitToken = options.token;
    }
    // -------------------------------------------------------------------------
    // Token resolution
    // -------------------------------------------------------------------------
    async resolveToken() {
        if (this.resolvedToken)
            return this.resolvedToken;
        if (this.explicitToken) {
            this.resolvedToken = this.explicitToken;
            return this.resolvedToken;
        }
        try {
            const kc = await getKeychain();
            const stored = await kc.getPassword(KEYCHAIN_ACCOUNT_GITHUB_TOKEN);
            if (stored && stored.length > 0) {
                this.resolvedToken = stored;
                return stored;
            }
        }
        catch (err) {
            logger.debug({ err }, 'GithubClient: keychain lookup failed; falling back to env');
        }
        const envToken = process.env[ENV_VAR_GITHUB_TOKEN];
        if (envToken && envToken.length > 0) {
            this.resolvedToken = envToken;
            return envToken;
        }
        throw new OrbitalError(GITHUB_ERROR_CODES.STARTUP_ERROR, `${ENV_VAR_GITHUB_TOKEN} is not set; set it in env or store under keychain account ${KEYCHAIN_ACCOUNT_GITHUB_TOKEN}`);
    }
    // -------------------------------------------------------------------------
    // Generic request with retry
    // -------------------------------------------------------------------------
    async request(method, path, body, options = {}) {
        const token = await this.resolveToken();
        const url = `${this.apiUrl}${path}`;
        let lastErr = null;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                const res = await this.fetchImpl(url, {
                    method,
                    headers: {
                        Accept: 'application/vnd.github+json',
                        'X-GitHub-Api-Version': '2022-11-28',
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'User-Agent': 'orbital-orchestrator',
                    },
                    body: body !== undefined ? JSON.stringify(body) : undefined,
                });
                // Auth: 401 always; 403 only if it's not a rate-limit (handled below)
                if (res.status === 401) {
                    throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_AUTH, `Github auth failed: HTTP 401`, { status: 401 });
                }
                if (res.status === 403) {
                    const remaining = res.headers.get('x-ratelimit-remaining');
                    if (remaining === '0') {
                        const reset = res.headers.get('x-ratelimit-reset');
                        const resetMs = reset ? Math.max(0, Number(reset) * 1000 - Date.now()) : undefined;
                        if (attempt >= this.maxRetries) {
                            throw new OrbitalError(GITHUB_ERROR_CODES.RATE_LIMIT_GITHUB_API, `Github primary rate limit exhausted after ${this.maxRetries} retries`, { retry_after_ms: resetMs });
                        }
                        const backoff = this.computeBackoff(attempt, resetMs);
                        logger.warn({ attempt, backoff_ms: backoff }, 'GithubClient: primary rate limit; retrying');
                        await this.sleepFn(backoff);
                        continue;
                    }
                    // Non-rate-limit 403 = auth/scope issue
                    throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_AUTH, `Github 403 (insufficient scope or permission)`, { status: 403 });
                }
                if (res.status === 429) {
                    // Secondary rate limit
                    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
                    if (attempt >= this.maxRetries) {
                        throw new OrbitalError(GITHUB_ERROR_CODES.RATE_LIMIT_GITHUB_API, `Github secondary rate limit exhausted after ${this.maxRetries} retries`, { retry_after_ms: retryAfter });
                    }
                    const backoff = this.computeBackoff(attempt, retryAfter);
                    logger.warn({ attempt, backoff_ms: backoff }, 'GithubClient: secondary rate limit; retrying');
                    await this.sleepFn(backoff);
                    continue;
                }
                if (res.status === 404) {
                    if (options.allow404)
                        return null;
                    throw new OrbitalError(GITHUB_ERROR_CODES.NOT_FOUND_GITHUB, `Github resource not found: ${method} ${path}`, { status: 404 });
                }
                if (res.status >= 500) {
                    if (attempt >= this.maxRetries) {
                        throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, `Github ${res.status} after ${this.maxRetries} retries`, { status: res.status });
                    }
                    const backoff = this.computeBackoff(attempt);
                    logger.warn({ attempt, status: res.status, backoff_ms: backoff }, 'GithubClient: 5xx; retrying');
                    await this.sleepFn(backoff);
                    continue;
                }
                if (!res.ok) {
                    const text = await res.text().catch(() => '');
                    throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, `Github request failed: HTTP ${res.status} ${text || ''}`.trim(), { status: res.status, retryable: false });
                }
                // 204 No Content
                if (res.status === 204)
                    return null;
                const json = (await res.json());
                return json;
            }
            catch (err) {
                lastErr = err;
                // Re-throw terminal OrbitalError (do not retry on auth / rate-limit
                // exhaustion / startup / 404 / GraphQL-style retryable=false)
                if (err instanceof OrbitalError) {
                    if (err.code === GITHUB_ERROR_CODES.INTEGRATION_GITHUB_AUTH ||
                        err.code === GITHUB_ERROR_CODES.RATE_LIMIT_GITHUB_API ||
                        err.code === GITHUB_ERROR_CODES.STARTUP_ERROR ||
                        err.code === GITHUB_ERROR_CODES.NOT_FOUND_GITHUB) {
                        throw err;
                    }
                    if (err.code === GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN &&
                        err.details?.['retryable'] === false) {
                        throw err;
                    }
                }
                // Network error → retry
                if (attempt >= this.maxRetries) {
                    throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, `Github request failed after ${this.maxRetries} retries: ${err.message}`, { cause: err.message });
                }
                const backoff = this.computeBackoff(attempt);
                logger.warn({ attempt, err, backoff_ms: backoff }, 'GithubClient: network error; retrying');
                await this.sleepFn(backoff);
            }
        }
        throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, `Github request loop exited unexpectedly: ${lastErr?.message ?? 'unknown'}`);
    }
    computeBackoff(attempt, retryAfterMs) {
        if (retryAfterMs !== undefined && retryAfterMs >= 0) {
            return Math.min(retryAfterMs, this.maxBackoffMs);
        }
        const exp = this.baseBackoffMs * Math.pow(2, attempt);
        return Math.min(exp, this.maxBackoffMs);
    }
    // -------------------------------------------------------------------------
    // High-level API
    // -------------------------------------------------------------------------
    async getAuthenticatedUser() {
        const data = await this.request('GET', '/user');
        if (!data) {
            throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, 'Github /user returned no body');
        }
        return { login: data.login };
    }
    async getRepo(owner, repo) {
        const data = await this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, undefined, { allow404: true });
        if (!data)
            return null;
        return mapRepo(data);
    }
    async createRepo(params) {
        const path = params.org
            ? `/orgs/${encodeURIComponent(params.org)}/repos`
            : '/user/repos';
        const body = {
            name: params.name,
            private: params.private ?? false,
            description: params.description,
            // Github user-repo create endpoint does not accept default_branch on
            // creation; set after creation if needed. Org endpoint also ignores it.
        };
        const data = await this.request('POST', path, body);
        if (!data) {
            throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, 'Github createRepo returned no body');
        }
        return mapRepo(data);
    }
    async listBranches(owner, repo) {
        const data = await this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`);
        if (!data)
            return [];
        return data.map((b) => ({
            name: b.name,
            commitSha: b.commit.sha,
            protected: b.protected,
        }));
    }
    async getBranch(owner, repo, branch) {
        const data = await this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`, undefined, { allow404: true });
        if (!data)
            return null;
        return {
            name: data.name,
            commitSha: data.commit.sha,
            protected: data.protected,
        };
    }
    async createBranch(owner, repo, name, sha) {
        // Use git refs API: POST /repos/{owner}/{repo}/git/refs
        const data = await this.request('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/refs`, { ref: `refs/heads/${name}`, sha });
        if (!data) {
            throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, 'Github createBranch returned no body');
        }
        return {
            name,
            commitSha: data.object.sha,
            protected: false,
        };
    }
    // ---------------------------------------------------------------------------
    // Pull-request methods (Round 5D)
    // ---------------------------------------------------------------------------
    async createPullRequest(params) {
        const { owner, repo, head, base, title, body } = params;
        const data = await this.request('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, { head, base, title, body });
        if (!data) {
            throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, 'Github createPullRequest returned no body');
        }
        return { pr_number: data.number, html_url: data.html_url };
    }
    async addLabels(params) {
        const { owner, repo, pr_number, labels } = params;
        await this.request('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${pr_number}/labels`, { labels });
    }
    async mergePullRequest(params) {
        const { owner, repo, pr_number, mergeMethod } = params;
        const data = await this.request('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pr_number}/merge`, { merge_method: mergeMethod });
        if (!data) {
            throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, 'Github mergePullRequest returned no body');
        }
        return { sha: data.sha };
    }
    async listOpenPullRequestsByLabel(params) {
        const { owner, repo, label } = params;
        const data = await this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&labels=${encodeURIComponent(label)}&per_page=100`);
        if (!data)
            return [];
        return data.map(mapPullRequest);
    }
    async getPullRequest(params) {
        const { owner, repo, pr_number } = params;
        const data = await this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pr_number}`, undefined, { allow404: true });
        if (!data)
            return null;
        return mapPullRequest(data);
    }
    // ---------------------------------------------------------------------------
    // Check runs (Round 6 #6 — CI/CD Bridge)
    // [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
    // ---------------------------------------------------------------------------
    async listCheckRuns(owner, repo, headSha) {
        const data = await this.request('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`);
        return data?.check_runs ?? [];
    }
    async rerunCheckRun(owner, repo, checkRunId) {
        await this.request('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs/${checkRunId}/rerequest`);
    }
    // ---------------------------------------------------------------------------
    // Round 9 — Low-level passthrough for the onboarding github-provisioner.
    // [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
    //
    // The provisioner needs endpoints (Contents API, labels, hooks) that the
    // high-level interface does not expose. Rather than widening the interface
    // and impacting every caller, we expose a thin generic request method that
    // reuses this client's auth + retry pipeline.
    // ---------------------------------------------------------------------------
    /**
     * Generic authenticated GitHub REST request. Public so the onboarding
     * provisioner can call Contents API / Labels / Hooks endpoints without
     * each-method boilerplate. Returns the parsed JSON body, null for
     * 204 / 404 (with allow404), throws OrbitalError otherwise.
     */
    async rawRequest(method, path, body, options = {}) {
        // The private request method only handles GET/POST/PATCH/DELETE; PUT is
        // additive for the Contents API. Forward via a small adapter.
        if (method === 'PUT') {
            return this.requestPut(path, body);
        }
        return this.request(method, path, body, options);
    }
    /**
     * PUT support — the Contents API requires PUT for create/update file. We
     * implement it inline (the bulk of request() is GET/POST/PATCH paths and
     * we don't want to invasively touch that). Token resolution + headers are
     * shared via the same fetch pipeline.
     */
    async requestPut(path, body) {
        const token = await this.resolveToken();
        const url = `${this.apiUrl}${path}`;
        let lastErr = null;
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                const res = await this.fetchImpl(url, {
                    method: 'PUT',
                    headers: {
                        Accept: 'application/vnd.github+json',
                        'X-GitHub-Api-Version': '2022-11-28',
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        'User-Agent': 'orbital-orchestrator',
                    },
                    body: body !== undefined ? JSON.stringify(body) : undefined,
                });
                if (res.status === 401 || res.status === 403) {
                    throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_AUTH, `Github auth failed: HTTP ${res.status}`, { status: res.status });
                }
                if (res.status >= 500) {
                    if (attempt >= this.maxRetries) {
                        throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, `Github ${res.status} after ${this.maxRetries} retries`, { status: res.status });
                    }
                    await this.sleepFn(this.computeBackoff(attempt));
                    continue;
                }
                if (!res.ok) {
                    const text = await res.text().catch(() => '');
                    throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, `Github PUT failed: HTTP ${res.status} ${text || ''}`.trim(), { status: res.status, retryable: false });
                }
                if (res.status === 204)
                    return null;
                const json = (await res.json());
                return json;
            }
            catch (err) {
                lastErr = err;
                if (err instanceof OrbitalError) {
                    if (err.code === GITHUB_ERROR_CODES.INTEGRATION_GITHUB_AUTH ||
                        err.code === GITHUB_ERROR_CODES.STARTUP_ERROR ||
                        err.code === GITHUB_ERROR_CODES.RATE_LIMIT_GITHUB_API) {
                        throw err;
                    }
                    if (err.code === GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN &&
                        err.details?.['retryable'] === false) {
                        throw err;
                    }
                }
                if (attempt >= this.maxRetries) {
                    throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, `Github PUT failed after ${this.maxRetries} retries: ${err.message}`, { cause: err.message });
                }
                await this.sleepFn(this.computeBackoff(attempt));
            }
        }
        throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, `Github PUT loop exited unexpectedly: ${lastErr?.message ?? 'unknown'}`);
    }
    // ---------------------------------------------------------------------------
    // PR review surface (Round 6 #2 — Code-Review Persona)
    // [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
    // ---------------------------------------------------------------------------
    async createReviewComment(params) {
        const { owner, repo, pr_number, path, line, body } = params;
        const data = await this.request('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pr_number}/comments`, { path, line, body, side: 'RIGHT' });
        if (!data) {
            throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, 'Github createReviewComment returned no body');
        }
        return { id: data.id };
    }
    async submitPRReview(params) {
        const { owner, repo, pr_number, state, body, comments = [] } = params;
        const data = await this.request('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pr_number}/reviews`, {
            body,
            event: state,
            comments: comments.map((c) => ({
                path: c.path,
                line: c.line,
                body: c.body,
                side: 'RIGHT',
            })),
        });
        if (!data) {
            throw new OrbitalError(GITHUB_ERROR_CODES.INTEGRATION_GITHUB_DOWN, 'Github submitPRReview returned no body');
        }
        return { id: data.id };
    }
}
function mapPullRequest(data) {
    const state = data.merged
        ? 'merged'
        : data.state === 'closed'
            ? 'closed'
            : 'open';
    return {
        pr_number: data.number,
        html_url: data.html_url,
        state,
        merged: data.merged,
        merged_at: data.merged_at,
        title: data.title,
        body: data.body,
        head: data.head.ref,
        base: data.base.ref,
        labels: data.labels.map((l) => l.name),
    };
}
function mapRepo(data) {
    return {
        id: data.id,
        name: data.name,
        fullName: data.full_name,
        owner: { login: data.owner.login },
        private: data.private,
        defaultBranch: data.default_branch,
        htmlUrl: data.html_url,
    };
}
function parseRetryAfter(header) {
    if (!header)
        return undefined;
    const asInt = Number.parseInt(header, 10);
    if (Number.isFinite(asInt) && asInt >= 0)
        return asInt * 1000;
    const asDate = Date.parse(header);
    if (Number.isFinite(asDate)) {
        const diff = asDate - Date.now();
        return diff > 0 ? diff : 0;
    }
    return undefined;
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createGithubClient(options = {}) {
    return new DefaultGithubClient(options);
}
//# sourceMappingURL=client.js.map