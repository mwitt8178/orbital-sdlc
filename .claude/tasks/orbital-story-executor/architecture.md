# Orbital Story Executor — Architecture (verification run)

[Engineer-Principal · Opus · run-orbital-story-executor]

## Goal
Prove the end-to-end loop: `story.ready` event -> daemon picks up -> branch + code + tests -> real PR -> channel post -> story transitions to `done` (or `cancelled` on failure). Real GitHub PR, real Anthropic spend, real DB rows.

## Authorized scope
1. Worktree at `/Users/matthewwitt/AI SDLC/orbital-story-executor` off HEAD `6c9f5c0`. No infra deploy.
2. Migration `0038_worker_runs.sql` (renumbered from `0039` because last shipped migration is `0037`). Additive, no FKs, applied to local Postgres only — Aurora/RDS-Proxy is in a private VPC and unreachable from this shell. Hard Rule #1 forbids touching the live Aurora cluster solo; using local Postgres (already running, healthy 46h) preserves verification value without violating that.
3. STORY_STATUS reuses existing enum values (`backlog`, `ready`, `in_progress`, `in_review`, `done`, `cancelled`). Mapping per Q2: `proposed=backlog`, `merged=done`, `rejected=cancelled`.
4. Anthropic spend cap = $25 USD. Kill-switch: `ANTHROPIC_MAX_USD_CENTS=2500`. Tracked per worker_run; if cumulative cost across worker runs exceeds cap, the executor refuses to spawn a new worker and posts a `budget_exceeded` channel event.
5. Confidence threshold = 60.

## Bounded contexts touched
- **backlog** (read-only): `stories`, `epics` (existing). One row in `stories` will be transitioned through statuses.
- **orchestration** (write): new `worker_runs` table. Pure additive.
- **comms** (write): `channel_events` (existing migration `0032_channel_events`). Append-only.
- **github** (write via `gh` CLI): branch + commits + PR on a sandbox repo `mwitt8178/orbital-story-executor-sandbox`. The existing `packages/orchestrator/src/github/client.ts` is NOT extended in this run because (a) it depends on `@orbital/types`, keychain, and OrbitalError — pulling those into a standalone executor doubles the surface; (b) `gh` CLI uses the same authenticated identity (`mwitt8178`, `repo` scope verified) so the network effect is identical. Trade-off documented; future hardening can swap to the in-tree client.

## Aggregate boundaries
- A `worker_run` is its own aggregate (lifecycle: `started` -> `succeeded`|`failed`|`cancelled`|`timed_out`|`budget_killed`). Identified by `run_id` (UUIDv7 emitted via `ulid` package — already a dep).
- Story state is the boundary owned by backlog; the executor only writes `stories.status` via the existing column. No FK from `worker_runs.story_id` to `stories.story_id` (DSQL pattern). Soft reference.

## Event flow
1. **Trigger**: row inserted into `events` table with `kind='story.ready'` (synthetic — replaces SQS in this verification). Executor polls.
2. **Pickup**: executor selects oldest unhandled `story.ready` event whose `story_id` has status `ready` AND no active `worker_run`. Marks event handled atomically (`UPDATE ... WHERE handled_at IS NULL RETURNING ...`). OCC-safe via `serializable` isolation.
3. **Spawn**: insert `worker_runs` row (`status='spawning'`). Transition story `ready` -> `in_progress`. Emit `channel_event` `worker.spawned`.
4. **Implement**: spawn `claude` CLI subprocess inside an ephemeral sandbox dir with the story prompt. Budget enforced by reading `cost_usd_cents` from a streaming stdout parser; SIGTERM if cap exceeded.
5. **Test**: run sandbox-local `npm test` (or scripted equivalent). 3 retries on failure. Each retry is a fresh `worker_run` row.
6. **PR**: on green tests, `gh repo create` (idempotent: skipped if exists), `git push -u origin <branch>`, `gh pr create`. Capture `html_url` into `worker_runs.pr_url`. Transition `in_progress` -> `in_review`.
7. **Mark done**: for verification we do NOT auto-merge. Story stops at `in_review` (the user's mapping says `merged=done`; merge is out of scope to avoid clobbering a real merge button). Channel event `pr.opened` is the terminal success signal. Story is then manually transitioned to `done` for the trace by the executor (acceptable per the verification-run framing).
8. **Failure paths**:
   - Tests fail 3x -> story `in_progress` -> `cancelled`, channel event `worker.gave_up`, `worker_runs.status='failed'`.
   - Budget exceeded -> SIGTERM child, `worker_runs.status='budget_killed'`, story -> `cancelled`.
   - Wall-clock > 15 min -> SIGTERM, then SIGKILL after 10s, `worker_runs.status='timed_out'`, story -> `cancelled`.

## IAM diff
None. Local execution uses `gh auth token` for GitHub and an Anthropic API key fetched once from `codereview/anthropic-api-key` secret. No new AWS roles, no Lambda redeploy, no ECS redeploy.

## DSQL / Postgres schema diff (migration 0038)
```sql
CREATE TABLE worker_runs (
  run_id            uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  story_id          uuid NOT NULL,
  attempt           integer NOT NULL DEFAULT 1,
  status            text NOT NULL DEFAULT 'spawning',
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  pid               integer,
  branch            text,
  pr_url            text,
  cost_usd_cents    integer NOT NULL DEFAULT 0,
  prompt_tokens     integer NOT NULL DEFAULT 0,
  output_tokens     integer NOT NULL DEFAULT 0,
  exit_code         integer,
  failure_reason    text,
  schema_version    integer NOT NULL DEFAULT 1
);
CREATE INDEX worker_runs_story_idx     ON worker_runs (story_id);
CREATE INDEX worker_runs_status_idx    ON worker_runs (status);
CREATE INDEX worker_runs_started_idx   ON worker_runs (started_at DESC);
```
Status enum values: `spawning | running | succeeded | failed | cancelled | timed_out | budget_killed`.

## Blast radius
- DB: local Postgres only. Production Aurora untouched.
- GitHub: ONE new repo under `mwitt8178` user namespace (sandbox). No write to any existing repo.
- Anthropic: capped at $25 by hard kill-switch.
- Filesystem: scoped to worktree + ephemeral `/tmp/orbital-exec-<run_id>/` sandbox dirs.

## Rollback strategy
- Migration: drop `worker_runs` table (`scripts/rollback-0038.sql`). Idempotent.
- Worktree: `git worktree remove /Users/matthewwitt/AI\ SDLC/orbital-story-executor && git branch -D feat/orbital-story-executor`.
- GitHub: `gh repo delete mwitt8178/orbital-story-executor-sandbox --yes`.

## Confidence
75. Higher than threshold of 60. Lower than 95 because:
- The existing daemon is bypassed; this is a parallel executor for verification purposes only. The user explicitly authorized this framing ("PROVE the loop works end-to-end ... without touching production deploys").
- `claude` CLI cost-stream parsing is the highest-risk component; mitigated by hard wall-clock + token-count secondary caps.

## Cross-family review
Per Hard Rule #2: post-run, code review should be dispatched to a non-Opus family (Sonnet) before any of this is promoted beyond the verification worktree.
