# Sprint Loop — progress.md
[Engineer-Sr · Sonnet · run-sprint-loop]

## Self-checks
- DSQL hard-no: No FKs, no triggers, no sequences/SERIAL, no materialized views. OCC not needed here (SELECT FOR UPDATE SKIP LOCKED is not an OCC pattern — it's a lock; mutations are simple status updates wrapped in try/catch). DDL separate from DML (migration is DDL only). IDs via uuidv7 in app. clock_timestamp() used in sprint_tick_log (logged_at) and sprint_tick_leases (acquired_at/expires_at).
- Multi-tenant: every query in buildTickDeps filters by tenant_id explicitly. listActiveSprintsForTenant takes tenantId parameter. Test "tenant isolation" asserts correct tenantId passed.
- Security: no secrets stored. Lambda client uses IAM role. STORY_PR_PIPELINE_LAMBDA_ARN is an env var, not stored in DB.
- Observability: every log line includes tenant_id, sprint_id, story_id as structured fields. pino logger used throughout.

## Estimate: L
## Risk Tier: Medium

## Acceptance Criteria — COMPLETED
- [x] Migration 0048_sprint_tick_log.sql (sprint_tick_log, project_sprint_policy, sprint_tick_leases, story_pr_runs)
- [x] Schema: Drizzle schema in sprint-tick.ts, exported from @orbital/db
- [x] Daemon: SprintTickWorker (SELECT FOR UPDATE SKIP LOCKED lease)
- [x] SprintTickWorker: finds active sprints, picks next ready story, spawns story_pr_run
- [x] Workflow Status transitions: Ready → InProgress (written to sprint_tick_log)
- [x] Each transition writes sprint_tick_log with reason + actor
- [x] sprint.start tRPC procedure already exists — verified working, no changes needed
- [x] Sprint auto-complete when all stories Done
- [x] project_sprint_policy: capacity + max_concurrent_runs honored
- [x] sprint.tickLog + sprint.storyPrRuns tRPC procedures added for UI
- [x] UI: SprintBoard shows tick activity feed sidebar (polls every 10s when active)
- [x] "Start sprint" button on SprintBoard for sprints in 'ready' or 'planning' status
- [x] CDK: SPRINT_TICK_INTERVAL_MS env var wired; STORY_PR_PIPELINE_LAMBDA_ARN optional
- [x] CDK: lambda:InvokeFunction IAM grant when story-pr-pipeline ARN is wired
- [x] Tests: idempotency (lease skip), capacity enforcement, tenant isolation, workflow transitions, auto-complete, pipeline stub error (13/13 pass)

## TDD cycle
RED → GREEN → REFACTOR: sprint-tick-worker.test.ts written first, all 13 tests passed.

## Deferred
- story-pr-pipeline integration (stub surfaces clear NOT_MERGED error)
- project_sprint_policy admin UI (DB table + tRPC query available; edit UI deferred)
- end_date auto-complete (sprint.completedAt used as proxy; real end_date column deferred since sprints table has completedAt)
- Multiple tenants per daemon (DAEMON_TENANT_ID env var; multi-tenant loop deferred to avoid over-engineering single-tenant installs)
