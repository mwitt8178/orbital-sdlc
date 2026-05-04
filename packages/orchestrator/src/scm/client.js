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
export {};
//# sourceMappingURL=client.js.map