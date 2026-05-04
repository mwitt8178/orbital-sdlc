# /settings/sprints — Real Sprint Policy per Project

[Engineer-Principal · Opus · run-settings-sprints]

## Bounded contexts touched

- **projects** (read project_id only) — no schema change
- **backlog/sprint** (consumer of policy values; no contract change in this slice)
- **comms/ceremony-triggers** (future consumer of ceremony_rules; no migration in this slice)
- **NEW: project_sprint_policy** lives in the projects bounded context as a 1-1 row to projects.

## Aggregate boundary

`ProjectSprintPolicy` aggregate, keyed by `project_id` (PK). Single row per project. Save-on-blur upserts patches; full row read-back on every change.

## Schema diff (migration 0045)

```
CREATE TABLE IF NOT EXISTS project_sprint_policy (
  project_id                  uuid          PRIMARY KEY,
  tenant_id                   uuid          NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  length_weeks                integer       NOT NULL DEFAULT 2 CHECK (length_weeks IN (1,2,3,4)),
  start_dow                   integer       NOT NULL DEFAULT 1 CHECK (start_dow BETWEEN 0 AND 6),
  auto_advance                boolean       NOT NULL DEFAULT false,
  points_per_sprint           integer       NOT NULL DEFAULT 20 CHECK (points_per_sprint BETWEEN 0 AND 1000),
  budget_usd_cents_per_sprint bigint        NOT NULL DEFAULT 0 CHECK (budget_usd_cents_per_sprint >= 0),
  budget_usd_cents_per_week   bigint        NOT NULL DEFAULT 0 CHECK (budget_usd_cents_per_week  >= 0),
  ceremony_rules              jsonb         NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz   NOT NULL DEFAULT now(),
  updated_at                  timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS psp_tenant_idx ON project_sprint_policy (tenant_id);
```

DSQL-safe: no FKs, no triggers, no sequences, additive.

## tRPC contract

- `sprintPolicy.get({ projectId })` -> full row + defaults if absent.
- `sprintPolicy.update({ projectId, patch })` -> partial update; OCC-retried (3x w/ jitter on 40001); Zod validates; emits no event in slice (event hook noted in follow-up). Returns full updated row.
- `sprintPolicy.reset({ projectId })` -> hard reset to defaults (called from ConfirmDialog).

All three under `tenantProcedure` (tenant_id scoped). Read tied to ctx.tenantId match against project row.

## ceremony_rules JSON shape

```jsonc
{
  "planning":  { "enabled": true,  "dow": 1, "hour": 9 },
  "retro":     { "enabled": true,  "dow": 5, "hour": 16 },
  "auto_retro_on_complete":      true,
  "auto_create_next_sprint":     true,
  "auto_promote_ready_stories":  false
}
```

Validated via Zod at the API. UI exposes a JSON editor with live Zod feedback; structured fields are surfaced as native form controls above the JSON view.

## IAM diff

None. New table accessed via existing Aurora IAM token-generator path used by api-lambda + daemon. No new secrets.

## Blast radius

- **Read path:** new procedure used only by /settings/sprints page. Failure isolates to that one page.
- **Write path:** save-on-blur per-field upsert. No fan-out to schedulers/workers in this slice — values are read by future consumers (sprint creation, budget enforcer). No live-system effect on existing sprints.
- **Migration:** additive table, never read by existing code paths. Safe to roll forward and back.

## Rollback strategy

1. `DROP TABLE project_sprint_policy;` (migration 0045 is additive-only).
2. Revert `feat/settings-sprints` PR.
3. Lambda :live still runs prior code (no consumer of new procedures).

## Tenant isolation

- `tenant_id` column (sentinel default for local installs).
- Update/get procedures verify `projects.tenantId === ctx.tenantId` before touching the policy row. Cross-tenant access -> NOT_FOUND (not FORBIDDEN, to avoid existence leak).
- Tests: cross-tenant read/update returns 404.

## OCC discipline

- Mutating txn (upsert) wrapped in `withOccRetry` (max 3, expo backoff 50ms+jitter).
- DDL is in 0045 migration only; never co-mingled with DML.
- IDs: project_id is the natural PK (UUIDv7 from projects).

## Confidence

confidence: 96 — pattern (per-project additive table + tRPC + UI form) is well-trodden in this codebase (cost_budgets, project_memory, board_mapping). Only novel thing is JSON-validated ceremony_rules; mitigated by Zod parse on both ends.
