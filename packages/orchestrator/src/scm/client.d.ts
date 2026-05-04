/**
 * scm/client.ts — Provider-agnostic SCM port.
 *
 * [Engineer-Principal · Opus · run-scm-codecommit]
 *
 * Domain-level interface that both the GitHub adapter and the CodeCommit
 * client implement. The factory at scm/factory.ts is the composition root
 * — domain code never imports a concrete provider.
 *
 * Identifiers:
 *   - `repoId` — opaque provider-scoped repo handle. For CodeCommit this
 *     is the repo *name* (CodeCommit identifies repos by name within an
 *     account+region). For GitHub it is `${owner}/${repo}`. Treat as
 *     opaque from the domain's perspective.
 *   - `prId` — opaque provider PR handle. CodeCommit uses a string id;
 *     GitHub uses an integer pr_number serialised as string here.
 */
export interface ScmFile {
    /** Repo-relative path. Forward slashes only. */
    path: string;
    /** UTF-8 text content. Mutually exclusive with content_base64. */
    content_utf8?: string;
    /** Pre-encoded base64 binary content. Mutually exclusive with content_utf8. */
    content_base64?: string;
}
export interface ScmRepoHandle {
    repoId: string;
    repoUrl: string;
    cloneUrlHttp: string;
}
export interface ScmDifferenceFile {
    path: string;
    oldBlob: string | null;
    newBlob: string | null;
    additions: number;
    deletions: number;
    changeType: 'A' | 'M' | 'D' | 'R';
}
export interface ScmPullRequestStatus {
    state: 'open' | 'closed' | 'merged';
    mergeable: boolean | null;
    title: string;
    body: string | null;
    head: string;
    base: string;
}
export type ScmMergeMethod = 'merge' | 'squash' | 'rebase';
export interface ScmClient {
    /** Provider name — 'codecommit' | 'github'. */
    readonly provider: 'codecommit' | 'github';
    /** Create a new repository. Idempotent — if the repo already exists, returns its handle. */
    createRepo(name: string, description?: string): Promise<ScmRepoHandle>;
    /** Get the canonical web URL for the repo. */
    getRepoUrl(repoId: string): Promise<string>;
    /** Get the HTTPS clone URL. */
    cloneUrl(repoId: string): Promise<string>;
    /** Create a branch off an existing ref (branch name or commit sha). */
    createBranch(repoId: string, name: string, fromRef: string): Promise<{
        name: string;
        commitSha: string;
    }>;
    /**
     * Commit one or more files to a branch in a single commit. If the branch
     * does not exist yet (e.g. fresh repo seeding), the implementation will
     * create the initial commit on the default branch.
     */
    commitFiles(repoId: string, branch: string, files: ScmFile[], message: string): Promise<{
        commitSha: string;
    }>;
    /** Open a pull request. Returns the provider PR id and web URL. */
    openPullRequest(repoId: string, head: string, base: string, title: string, body: string): Promise<{
        prId: string;
        url: string;
    }>;
    getPullRequestStatus(repoId: string, prId: string): Promise<ScmPullRequestStatus>;
    addPRComment(repoId: string, prId: string, body: string): Promise<void>;
    mergePR(repoId: string, prId: string, method?: ScmMergeMethod): Promise<{
        commitSha: string;
    }>;
    getDifferences(repoId: string, fromRef: string, toRef: string): Promise<{
        files: ScmDifferenceFile[];
    }>;
}
//# sourceMappingURL=client.d.ts.map