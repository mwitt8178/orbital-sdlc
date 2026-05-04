# SCM Abstraction + CodeCommit Provider — Architecture

[Engineer-Principal · Opus · run-scm-codecommit]

## Goal

Make Orbital independent of GitHub by introducing an `ScmClient` abstraction
with a real CodeCommit implementation. Every Orbital project ships with its
own private CodeCommit repo by default. The existing GitHub path remains
intact behind a thin adapter.

## Bounded contexts touched

- **orchestrator/scm** (NEW) — the abstraction lives here. ScmClient
  interface + factory + two providers (CodeCommit + GitHub adapter).
- **orchestrator/projects** (domain) — project creation now talks to
  the SCM factory rather than the GitHub client directly. New columns:
  `scm_provider`, `ticket_provider`, `repo_id`, `repo_url`.
- **api-lambda** — IAM grants on the execution role to talk to CodeCommit.
- **db** — additive migration `0038_projects_scm_columns.sql`.

## Aggregate boundaries

The `Project` aggregate gains four optional fields. The
`ScmClient` is a downstream port; the domain stays SCM-agnostic.
The factory is the composition root.

## Event flow

`ProjectCreated` event payload extended with `scmProvider`, `repoId`,
`repoUrl`. Existing consumers tolerate unknown fields (additive).

No new event types — repo provisioning is synchronous in the
project-create command path. PR/branch operations are call-time only,
not event-sourced.

## IAM diff

The api-lambda execution role gains:

```
codecommit:CreateRepository
codecommit:GetRepository
codecommit:CreateBranch
codecommit:GetBranch
codecommit:CreatePullRequest
codecommit:GetPullRequest
codecommit:UpdatePullRequestStatus
codecommit:MergePullRequestByThreeWay
codecommit:MergePullRequestBySquash
codecommit:MergePullRequestByFastForward
codecommit:GetDifferences
codecommit:CreateCommit
codecommit:PutFile
codecommit:GitPush
codecommit:GitPull
codecommit:PostCommentForPullRequest
```

Resource scoped to `arn:aws:codecommit:us-east-1:403001214246:orbital-*`.

## DSQL/Aurora schema diff

Migration `0038_projects_scm_columns.sql`:

```sql
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS scm_provider TEXT NOT NULL DEFAULT 'github',
  ADD COLUMN IF NOT EXISTS ticket_provider TEXT NOT NULL DEFAULT 'monday',
  ADD COLUMN IF NOT EXISTS repo_id TEXT,
  ADD COLUMN IF NOT EXISTS repo_url TEXT;
```

Aurora Serverless v2 — additive, idempotent, no FK changes, no constraint
flips. Backwards compatible (default `github` preserves current behaviour).

## Blast radius

- **Code**: new package subdir `packages/orchestrator/src/scm/`. Only
  the projects router/service touches the new factory at create time; all
  read paths unchanged.
- **Data**: migration is additive with safe defaults. Rollback = drop the
  4 columns (no data loss for existing projects).
- **IAM**: new permission scope is bounded to `orbital-*` repos in a
  single account/region. No widening of existing privileges.
- **Runtime**: existing GitHub flow goes through the adapter, but the
  underlying GithubClient is untouched. If the adapter has a bug, only
  new project provisioning is affected — existing project work continues.

## Rollback strategy

1. Revert lambda alias `live` to v14 (current).
2. Roll back the migration: `ALTER TABLE projects DROP COLUMN scm_provider, DROP COLUMN ticket_provider, DROP COLUMN repo_id, DROP COLUMN repo_url`.
3. Pull IAM grants by reverting the CDK stack one revision.
4. CodeCommit repos created during the rollout are inert — they cost
   nothing if empty/idle and can be deleted manually.

## Out of scope (explicit gaps)

- Story-executor refactor across worktrees — only the `orchestrator-daemon`
  package in the main repo gets the abstraction; the
  `/Users/matthewwitt/AI SDLC/orbital-story-executor/` worktree is a
  separate branch and will need its own port (tracked as TODO).
- Self-hosted git option — interface supports it but no provider yet.
- Switching providers post-creation — error if attempted; future work.
- UI work on the project settings page is descoped to a follow-up; the
  data is exposed via the existing `projects.get` procedure for now.

## Confidence

confidence: 70 — interface + CodeCommit client + IAM grants are mechanical
and well-bounded. Risk is in the live verify (CodeCommit branch creation
requires an initial commit; IAM propagation can take seconds).
Threshold for High/Critical work is 95 — this work is sized Medium-High;
acceptable to proceed in auto mode and surface any live failures honestly.
