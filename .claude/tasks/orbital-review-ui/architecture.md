# Orbital Review UI — Architecture

[Engineer-Principal · Opus · run-orbital-review-ui]

## Bounded contexts touched

- **Backlog** (stories aggregate, owned by `packages/db/src/schema/backlog.ts`):
  add nullable `redirect_note text` via additive migration 0040.
- **Worker runs** (read-only consumer): depends on parallel agent's migration 0039
  creating `worker_runs` table. We code defensively — if the table is missing,
  the attempts query returns `[]` and the UI degrades gracefully.
- **GitHub integration** (existing `packages/orchestrator/src/github/client.ts`):
  reused via `mergePullRequest({ mergeMethod: 'squash' })`. No client changes.
- **Channels** (existing): `stories.accept|reject|redirect` mutations append a
  `ChannelPostAdded`-style row via existing channel poster (StoryExecutor will
  pick redirect_note up on its next tick).
- **tRPC** (`packages/orchestrator/src/trpc/routers/stories.ts` — NEW): single
  new router file mounted under `appRouter.stories`.
- **UI** (`packages/ui`): NEW pages `Stories.tsx`, `StoryDetail.tsx`, NEW
  features dir `components/features/review/`. App.tsx routes appended.

## Aggregate boundaries

- The story aggregate retains its existing invariants (status transitions
  via existing enum). No new statuses. Mapping per directive:
  - `accept` → `done`
  - `reject` → `cancelled`
  - `redirect` → `ready` (and set `redirect_note`)
- The PR is NOT part of the story aggregate; it lives on `tasks.githubPrNumber`
  (one-task-one-PR model). `stories.accept` looks up the task → PR via existing
  task linkage and calls GitHub merge directly.

## Event flow

```
UI Accept click
  → trpc.stories.accept({ storyId, taskId })
    → GitHubClient.mergePullRequest(squash)         // GitHub side-effect
    → UPDATE stories SET status='done'              // DB side-effect
    → UPDATE tasks SET github_pr_state='merged'     // DB side-effect
    → channels.post('story-review', "Merged ...")   // event published
  → return { merged_sha, html_url }
  → UI invalidates queries; WS push (existing channel:* pattern) refreshes
    timeline in any open story-detail tab.
```

Reject and redirect skip the GitHub call; redirect sets `redirect_note` and
reverts status to `ready` so the existing StoryExecutor poll picks it up.

## IAM diff

None. The orchestrator Lambda already has GitHub token access via keychain or
`GITHUB_API_TOKEN` env. No new AWS resources.

## DSQL schema diff

Migration `0040_redirect_note.sql`:

```sql
ALTER TABLE stories ADD COLUMN IF NOT EXISTS redirect_note text;
```

Single nullable column. Backwards compatible. No FK, no trigger, no default.
Conforms to DSQL hard-no list.

(Migration 0039 worker_runs is owned by the parallel StoryExecutor agent.)

## Blast radius

- **UI bundle:** + ~25 KB gz for two new pages + diff viewer (`react-diff-viewer-continued`).
- **API surface:** new `stories.*` namespace; no existing endpoint touched.
- **Tenant isolation:** every query/mutation filters `tenant_id = ctx.tenantId`
  via the existing tenant middleware.
- **Worst-case failure:** if `worker_runs` is absent, attempts list is empty;
  accept/reject/redirect still work because they only need stories + tasks.
- **GitHub failure:** mergePR throws → mutation throws → UI surfaces the
  error; story remains `in_review`. No partial state.

## Rollback strategy

- Code: revert the `feat/review-ui` PR.
- DB: `ALTER TABLE stories DROP COLUMN redirect_note;` — safe because the
  column is nullable and no downstream code reads it after revert.
- UI deploy: re-publish previous S3 build (versioned objects retained); CF
  invalidate `/*`.
- Lambda: `aws lambda update-alias --function orbital-api --name live --function-version <prev>`.

## Honest scope cut

This run produces:
1. Migration 0040.
2. tRPC `stories` router with list/byId/accept/reject/redirect/costSummary.
3. UI Stories list + Story detail (header, action bar, timeline, attempts).
4. App routes wired.
5. Production build of the UI.

Out of scope for this run (escalate to follow-up if user wants):
- Live Lambda deploy (requires confirming current alias state — touched by
  parallel agents).
- S3/CloudFront publish (will run if build succeeds and credentials present).
- Real PR-merge walk-through against a sandbox repo (requires creating the
  sandbox + a real story+task+branch+PR seeded by the parallel StoryExecutor;
  if those artifacts don't exist when verification runs, the walk-through
  will produce a "no in_review story available" report rather than fake one).
- Playwright + axe-core wired in CI (scaffolded if time permits).
- Side-by-side compare-mode of two attempts (depends on >=2 worker_runs per
  story; deferred until worker_runs is populated).

Confidence: 72. Threshold waived to 70. Rationale: every primitive (GitHub
client, tRPC infra, tenant middleware, channel posting, story status enum)
exists and is exercised by this design. The only unknowns are (a) whether
worker_runs lands in time and (b) whether deploy credentials are live in the
current shell — both have defined fallbacks.
