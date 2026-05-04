# /settings/integrations — Per-project bindings

## Bounded contexts touched
- `projects` (orchestrator) — adds `testScmConnection`, `testTicketConnection` keyed by projectId
- `webhooks` (new sub-router) — `webhooks.list`, `webhooks.testDelivery`
- `ui/Settings.tsx integrations` — replaces install-wide IntegrationsDashboard with per-project ProjectIntegrationsDashboard for the active project; keeps install-wide list under /admin/integrations only.

## Flow
1. UI loads active project via `useActiveProject()`.
2. SCM card calls `projects.testScmConnection({ projectId })` which loads the project row, builds the appropriate ScmClient (CodeCommit/GitHub/Internal), invokes `getRepoUrl(repoId)`. Returns `{ ok, provider, repoUrl, message }`.
3. Ticket card calls `projects.testTicketConnection({ projectId })` — when `mondayBoardId` set, calls `mondayClient.getBoardItems(boardId)` to confirm connectivity. When internal, returns story counts via stories aggregate.
4. Webhooks card (only GitHub-bound projects) calls `webhooks.list({ projectId, limit: 10 })` — selects from `github_webhook_deliveries` filtered by tenant. `webhooks.testDelivery({ projectId })` POSTs a synthetic `pull_request.opened` payload to the webhook receiver lambda URL and records a synthetic delivery row.
5. Slack/Discord card — pure UI stub mutation `notifications.connectSlack` (TODO log). Marked "Not yet available".

## Data model (no DSQL schema diff)
Reuse existing `projects`, `github_webhook_deliveries`, `github_repo_bindings`. No migrations.

## IAM diff
None. The Lambda already has CodeCommit + GitHub + DSQL perms.

## Blast radius
- New tRPC procs are read-only (queries) plus one synthetic-delivery mutation that writes a single row. No production data mutation.
- UI scoped to /settings/integrations only.

## Rollback
- Revert branch. No data migrations to roll back.
- The new procs are additive; old `testMondayConnection` / `testGithubConnection` remain.

## Risk: Medium (was M before scope review). Per-project scope, no auth changes.

## Confidence: 92
Rationale: existing helpers (loadProjectScmForStory, buildScmClientForProject, mondayClient.getBoardItems, githubWebhookDeliveries table) cover everything needed. Only novelty is exposing them through a per-project test-connection facade and a webhook synthetic-delivery POST. Below 95 because the synthetic webhook delivery requires hitting the live webhook URL; will fall back to writing a `result='synthetic'` row directly if the URL env var is absent.
