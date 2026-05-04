---
task: story-pr-pipeline
persona: Engineer-Principal
model: Opus 4.7
risk_tier: High
estimate: XL
spec_link: see Monday ticket (this file is the Spec Link evidence)
---

# Story → PR pipeline — architecture

[Engineer-Principal · Opus · run-story-pr-pipeline]

## Goal

End-to-end: the reviewer clicks **Run agent** on a story → the orchestrator clones the project repo into a per-run worktree → invokes the engineer persona (Real Claude Daemon, with `fake-claude` fallback when `ANTHROPIC_API_KEY` is missing) → commits with a Conventional Commit message → pushes the branch → opens a PR via the existing `ScmClient` → writes the PR URL back to `story_pr_runs` and `stories.pr_url`. The Story Detail UI shows a **Run agent** button, live status while running, and a **PR link + diff stats** when finished.

## Bounded contexts touched

| Context | Touch | Reason |
|---|---|---|
| `backlog` (stories) | additive col `stories.pr_url TEXT` | denormalized convenience for fast UI render; canonical record stays in `story_pr_runs` |
| **new** `story-pr-runs` | new table + new domain service `storyExecutor.run()` | new aggregate: a run is the entity, story is its parent reference |
| `orchestrator/scm` | reuse existing `ScmClient` factory | no provider coupling; CodeCommit + GitHub both work |
| `orchestrator-daemon` | new SQS handler kind `story.run_requested` + worker spawn | run-loop owner; off the API hot path |
| `orchestrator/trpc/routers/stories` | new `stories.run` mutation + `stories.runStatus` query | UI entry-points |
| `ui` | StoryDetail.tsx — add Run button + live status block | reviewer surface |

No FK changes; `story_pr_runs.story_id` and `.project_id` are nullable-uuid logical pointers per the project's TRD-01 §4.5 convention.

## Aggregate boundaries

- **Aggregate root**: `story_pr_run` (id = UUIDv7).
- **State machine**: `queued → cloning → branching → running_agent → committing → pushing → opening_pr → succeeded | failed | cancelled`.
- Each transition is a single-row update in DSQL with `updated_at = NOW()`. OCC retry (`serialization_failure → backoff + retry`) on every mutation per `aws-dsql-constraints`.
- Story status side-effects are **separate transactions** (DDL ≠ DML separation principle, and stories are a different aggregate). `stories.pr_url` is updated when the run reaches `succeeded` and the PR URL is known.

## Event flow

```
[UI: click Run]
    └─→ tRPC stories.run(storyId)
          ├─ tenantProcedure: tenantId scoped
          ├─ INSERT story_pr_runs (status=queued)
          ├─ enqueue SQS DAEMON_WORK_QUEUE_URL { kind: 'story.run_requested', tenant_id, run_id, story_id }
          └─ return { run_id }

[Daemon SQS consumer]
    └─→ handler 'story.run_requested'
          ├─ load run, story, project
          ├─ guard: project.scm_provider != 'internal' → use real ScmClient; project.repo_id required
          ├─ status=cloning  → ScmClient.cloneUrl + git clone --depth=1 into /tmp/orbital-run-<run_id>
          ├─ status=branching → ScmClient.createBranch('orbital/story-<storyId8>', defaultBranch)
          │                     local: git checkout -B that branch
          ├─ status=running_agent
          │     ├─ if ANTHROPIC_API_KEY set → spawn real-claude-daemon worker (cwd=worktree)
          │     └─ else                     → throw 'agent_disabled: ANTHROPIC_API_KEY not configured'
          │                                    (NO silent fake — surface the blocker per real-impl rule)
          │     ├─ stream agent events to worker_runs (existing) for live UI
          │     └─ on agent exit: git status --porcelain to detect changes
          ├─ status=committing
          │     ├─ build conventional commit msg: 'feat(story-<storyId8>): <title>\n\nCloses story <id>\n\nCo-Authored-By: Orbital <noreply@orbital.local>'
          │     ├─ collect ScmFile[] from working tree (UTF-8 + binary detection)
          │     └─ ScmClient.commitFiles(repoId, branch, files, msg) → commitSha
          ├─ status=pushing  (no-op for ScmClient — commitFiles already pushes; tracked for UI clarity)
          ├─ status=opening_pr
          │     ├─ body = 'Closes story <id>\n\n## Acceptance criteria\n<rendered AC checklist>\n\n## Cost\n$<sum cost_ledger for run task>'
          │     └─ ScmClient.openPullRequest(repoId, branch, defaultBranch, title, body) → { prId, url }
          ├─ ScmClient.getDifferences(defaultBranch, branch) → reduce → diff_stats {files,additions,deletions}
          ├─ Tx-1: UPDATE story_pr_runs SET status='succeeded', pr_url, commit_sha, diff_stats, finished_at=NOW()
          ├─ Tx-2: UPDATE stories SET pr_url=$pr_url, updated_at=NOW() WHERE story_id AND tenant_id
          └─ post channel event 'story.pr_run.succeeded' with { run_id, pr_url, diff_stats }

[UI: stories.runStatus poll @ 3s OR WS push on story:<id>]
    └─→ shows status string, on succeeded swaps to PR card with diff stats
```

Failure paths: any thrown error → Tx-1 with `status='failed'`, `finished_at=NOW()`, error in `diff_stats.error`. The branch and partial commit (if any) are intentionally **left in place** — reviewer can inspect via the existing Attempts diff UI. Worktree at `/tmp/orbital-run-<id>` is removed in `finally`.

## IAM diff

Daemon task role gains:
- `codecommit:GitPull`, `codecommit:GitPush` on `arn:aws:codecommit:*:<acct>:*` (already had Get/Put commands; explicit Git* needed for actual git push from the worktree clone path, even though we use ScmClient.commitFiles for the actual write — the clone uses `git-remote-codecommit`).
- No new KMS, no new S3, no new SecretsManager.

For **GitHub** projects: requires `GITHUB_API_TOKEN` already in Secrets Manager. The token's repo:write scope already covers branch + commit + PR.

> **Stateful-resource gate (per rules §1):** This adds `codecommit:GitPush` to the daemon task role. **Surface to human before deploy** — push permission is a privilege escalation on shared CodeCommit. Provided in the deploy script as a separate plan output; *do not auto-apply*.

## DSQL schema diff (migration 0046)

```sql
-- 0046_story_pr_runs.sql
CREATE TABLE IF NOT EXISTS story_pr_runs (
  id            UUID         NOT NULL,                 -- UUIDv7 from app
  tenant_id     UUID         NOT NULL,
  project_id    UUID,                                  -- logical FK
  story_id      UUID         NOT NULL,                 -- logical FK
  branch        TEXT         NOT NULL,
  pr_url        TEXT,
  status        TEXT         NOT NULL DEFAULT 'queued',
  started_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  commit_sha    TEXT,
  diff_stats    JSONB,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS story_pr_runs_story_idx
  ON story_pr_runs (tenant_id, story_id, started_at DESC);
CREATE INDEX IF NOT EXISTS story_pr_runs_status_idx
  ON story_pr_runs (status) WHERE status IN ('queued','cloning','branching','running_agent','committing','pushing','opening_pr');

ALTER TABLE stories
  ADD COLUMN IF NOT EXISTS pr_url TEXT;
```

Constraints honoured:
- No FK / no triggers / no sequences / no SERIAL — all UUIDs from app.
- DDL only (no DML) → applied by migration-runner Lambda in its own transaction(s).
- Composite PK `(tenant_id, id)` matches the project's tenancy convention and gives DSQL a clean partition key.

Migration-runner picks this up automatically because it iterates the `migrations/` directory in lexicographic order and tracks applied hashes in `__drizzle_migrations`. **Idempotent on re-run.**

## Blast radius

- **Daemon**: a bug here will only fail individual runs; `story_pr_runs.status='failed'` and the SQS message goes to the existing DLQ after maxReceiveCount. No story-status corruption — story stays whatever it was; pipeline does **not** force `in_review` until succeeded.
- **DSQL**: additive only; cannot break any existing read path. `__drizzle_migrations` skip on repeat.
- **API**: two new procedures behind `tenantProcedure`. No shared write paths touched.
- **UI**: bounded to StoryDetail header + a new run-status block. Existing accept/redirect/reject flows untouched.
- **CodeCommit / GitHub**: branches named `orbital/story-<8charId>` — namespaced; cannot collide with reviewer-created `feat/*` or `fix/*` branches.

## Rollback strategy

1. Revert the daemon image (previous tag in ECR).
2. UI rollback: revert `feat/story-pr-pipeline` merge; CloudFront invalidate.
3. DSQL: `DROP TABLE story_pr_runs; ALTER TABLE stories DROP COLUMN pr_url;` — emitted as `0046_rollback.sql` shipped in `migrations/_rollback/` (NOT auto-applied).
4. SQS messages of kind `story.run_requested` are drained by the new daemon if rolled back; old daemon will see `kind=unknown` and ack-out-of-band — no poison-message risk because the consumer's default branch returns OK after logging.

## Key decisions / why-not

- **Why not have the API write the commit directly?** API-Lambda is a 30s budget, the agent spawn is minutes. SQS → daemon is the only sustainable surface.
- **Why not store the worktree path in the DB?** Worktrees are ephemeral on-host. We track `run_id`-derived `/tmp/orbital-run-<id>` and let the daemon recreate on resume. Crash recovery sees `running_agent` rows older than 30 min and marks `failed: 'orphaned'`.
- **Why surface a clear error when ANTHROPIC_API_KEY is missing?** Per the project's "Real Implementations Only" rule: no silent degrade to fake. The fake-claude path stays available behind an explicit `RUN_MODE=fake` env on the daemon (used only by the integration test).
- **Why nullable `project_id`?** Match the existing `tasks` / cost_ledger fallback pattern — some legacy stories have no project linkage; we degrade gracefully.

## TDD plan (integration-first per Engineer-Principal protocol)

1. **`packages/orchestrator/src/story-runs/run.integration.test.ts`** — spans the new boundary end-to-end against a real CodeCommit fixture repo (uses `verify-scm-codecommit.mjs` pattern). Asserts: row inserted, branch created, files committed, PR opened, `pr_url` propagated to story.
2. Drill down to unit tests:
   - `storyExecutor.run.test.ts` — state machine transitions.
   - `commit-message.test.ts` — Conventional Commit construction.
   - `diff-stats.test.ts` — reducer over `getDifferences`.
3. UI test (vitest + RTL): clicking Run posts mutation; status block re-renders on poll change; PR link visible on succeeded.

## Confidence

`confidence: 78` — Below the 95 threshold for High/Critical. Drivers:
- Real Claude Daemon worker spawn surface is on a parallel branch (`feat/real-claude-daemon`); coordination contract is assumed (`spawn-worker.js` from story-executor as the seam). Will surface as BLOCK if that interface drifts.
- Daemon IAM `codecommit:GitPush` change is a stateful-resource modification. Per Hard Rule §1, **not auto-applied**; deploy script will print and stop.
- DSQL migration is straightforward but the deployed `__drizzle_migrations` table version is unverified from this worktree — checked at runtime by the migration runner itself.

## Human-attention checkpoints (will not proceed without explicit ack)

1. Apply migration 0046 to the live Aurora cluster.
2. Push new daemon image to ECR with `codecommit:GitPush` IAM expansion.
3. Bump `api-lambda` version with new tRPC procedures.
4. CloudFront invalidation for UI.

These four are flagged in the `pre-deploy-validate.sh` output and **will not run autonomously**.
