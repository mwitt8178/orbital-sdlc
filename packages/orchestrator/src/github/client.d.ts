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
import { type CreateRepoParams, type GithubBranch, type GithubPullRequest, type GithubRepo, type CreatePullRequestParams, type AddLabelsParams, type MergePullRequestParams, type ListPRsByLabelParams, type GetPullRequestParams } from './types.js';
export interface GithubClientOptions {
    /** Override token; bypasses keychain + env. */
    token?: string;
    /** Override API base URL (test). Default https://api.github.com. */
    apiUrl?: string;
    /** Max retries before surfacing rate-limit error. Default 5. */
    maxRetries?: number;
    /** Base backoff (ms). Default 1000. */
    baseBackoffMs?: number;
    /** Max backoff cap (ms). Default 60000. */
    maxBackoffMs?: number;
    fetchImpl?: typeof fetch;
    sleepFn?: (ms: number) => Promise<void>;
}
export interface GithubClient {
    /** Authenticated user's login (used for token validation). */
    getAuthenticatedUser(): Promise<{
        login: string;
    }>;
    getRepo(owner: string, repo: string): Promise<GithubRepo | null>;
    /**
     * Create a repo for the authenticated user OR for an org.
     * If params.org is set, uses /orgs/{org}/repos; else /user/repos.
     */
    createRepo(params: CreateRepoParams): Promise<GithubRepo>;
    listBranches(owner: string, repo: string): Promise<GithubBranch[]>;
    getBranch(owner: string, repo: string, branch: string): Promise<GithubBranch | null>;
    /** Create a branch off an existing sha (uses git refs API). */
    createBranch(owner: string, repo: string, name: string, sha: string): Promise<GithubBranch>;
    /** Open a pull request. Returns pr_number + html_url. */
    createPullRequest(params: CreatePullRequestParams): Promise<{
        pr_number: number;
        html_url: string;
    }>;
    /** Add labels to a PR. Idempotent — existing labels are preserved. */
    addLabels(params: AddLabelsParams): Promise<void>;
    /** Merge a pull request. Returns the merge commit sha. */
    mergePullRequest(params: MergePullRequestParams): Promise<{
        sha: string;
    }>;
    /** List open PRs that carry a given label. */
    listOpenPullRequestsByLabel(params: ListPRsByLabelParams): Promise<GithubPullRequest[]>;
    /** Get a single pull request. */
    getPullRequest(params: GetPullRequestParams): Promise<GithubPullRequest | null>;
    /**
     * List all check runs for a commit SHA.
     * GET /repos/{owner}/{repo}/commits/{ref}/check-runs
     */
    listCheckRuns(owner: string, repo: string, headSha: string): Promise<Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        html_url: string;
        started_at: string | null;
        completed_at: string | null;
    }>>;
    /**
     * Re-run a single check run by id.
     * POST /repos/{owner}/{repo}/check-runs/{check_run_id}/rerequest
     */
    rerunCheckRun(owner: string, repo: string, checkRunId: number): Promise<void>;
    /**
     * Create an inline review comment on a PR diff.
     * POST /repos/{owner}/{repo}/pulls/{pull_number}/comments
     */
    createReviewComment(params: {
        owner: string;
        repo: string;
        pr_number: number;
        path: string;
        line: number;
        body: string;
    }): Promise<{
        id: number;
    }>;
    /**
     * Submit a pull request review (APPROVED / CHANGES_REQUESTED / COMMENTED).
     * POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews
     */
    submitPRReview(params: {
        owner: string;
        repo: string;
        pr_number: number;
        state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
        body: string;
        comments?: Array<{
            path: string;
            line: number;
            body: string;
        }>;
    }): Promise<{
        id: number;
    }>;
    /**
     * Generic authenticated GitHub REST request — used by the onboarding
     * github-provisioner to call Contents API, labels, hooks, etc. without
     * widening the high-level interface for each new endpoint.
     */
    rawRequest<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown, options?: {
        allow404?: boolean;
    }): Promise<T | null>;
}
export declare class DefaultGithubClient implements GithubClient {
    private resolvedToken;
    private readonly apiUrl;
    private readonly maxRetries;
    private readonly baseBackoffMs;
    private readonly maxBackoffMs;
    private readonly fetchImpl;
    private readonly sleepFn;
    private readonly explicitToken?;
    constructor(options?: GithubClientOptions);
    private resolveToken;
    private request;
    private computeBackoff;
    getAuthenticatedUser(): Promise<{
        login: string;
    }>;
    getRepo(owner: string, repo: string): Promise<GithubRepo | null>;
    createRepo(params: CreateRepoParams): Promise<GithubRepo>;
    listBranches(owner: string, repo: string): Promise<GithubBranch[]>;
    getBranch(owner: string, repo: string, branch: string): Promise<GithubBranch | null>;
    createBranch(owner: string, repo: string, name: string, sha: string): Promise<GithubBranch>;
    createPullRequest(params: CreatePullRequestParams): Promise<{
        pr_number: number;
        html_url: string;
    }>;
    addLabels(params: AddLabelsParams): Promise<void>;
    mergePullRequest(params: MergePullRequestParams): Promise<{
        sha: string;
    }>;
    listOpenPullRequestsByLabel(params: ListPRsByLabelParams): Promise<GithubPullRequest[]>;
    getPullRequest(params: GetPullRequestParams): Promise<GithubPullRequest | null>;
    listCheckRuns(owner: string, repo: string, headSha: string): Promise<Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        html_url: string;
        started_at: string | null;
        completed_at: string | null;
    }>>;
    rerunCheckRun(owner: string, repo: string, checkRunId: number): Promise<void>;
    /**
     * Generic authenticated GitHub REST request. Public so the onboarding
     * provisioner can call Contents API / Labels / Hooks endpoints without
     * each-method boilerplate. Returns the parsed JSON body, null for
     * 204 / 404 (with allow404), throws OrbitalError otherwise.
     */
    rawRequest<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown, options?: {
        allow404?: boolean;
    }): Promise<T | null>;
    /**
     * PUT support — the Contents API requires PUT for create/update file. We
     * implement it inline (the bulk of request() is GET/POST/PATCH paths and
     * we don't want to invasively touch that). Token resolution + headers are
     * shared via the same fetch pipeline.
     */
    private requestPut;
    createReviewComment(params: {
        owner: string;
        repo: string;
        pr_number: number;
        path: string;
        line: number;
        body: string;
    }): Promise<{
        id: number;
    }>;
    submitPRReview(params: {
        owner: string;
        repo: string;
        pr_number: number;
        state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
        body: string;
        comments?: Array<{
            path: string;
            line: number;
            body: string;
        }>;
    }): Promise<{
        id: number;
    }>;
}
export declare function createGithubClient(options?: GithubClientOptions): GithubClient;
//# sourceMappingURL=client.d.ts.map