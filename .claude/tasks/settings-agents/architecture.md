# Settings → Agents (project-scoped persona configuration)

## Bounded contexts touched
- `personas` (existing) — read baseline persona slugs as the catalog
- `projects` (existing) — anchor for tenant-scoped, project-scoped overrides
- `worker_runs` (existing) — joined with project_personas for cost rollup
- new: `project_personas` table — per-project persona enablement/model/budget/prompt override

## Aggregate boundaries
- `project_personas` is a child of `projects`. PK (tenant_id, project_id, persona_slug). No FK (DSQL discipline; soft refs).
- Append/upsert semantics. No version history (this isn't audit-grade — reverts go through edit).

## Event flow
- No new domain events. The orchestrator persona-routing layer reads `project_personas` at story-claim time (out-of-scope to wire here; just expose).
- UI updates are immediate writes; tRPC mutation returns the updated row.

## IAM diff
- None. Lambda already has SELECT/INSERT/UPDATE on project-scoped tables via the existing api-lambda role.

## Schema diff (migration 0047)
```sql
CREATE TABLE IF NOT EXISTS project_personas (
  tenant_id              UUID    NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  project_id             UUID    NOT NULL,
  persona_slug           TEXT    NOT NULL,
  enabled                BOOLEAN NOT NULL DEFAULT TRUE,
  model                  TEXT    NOT NULL DEFAULT 'claude-sonnet-4-6',
  budget_usd_cents       INTEGER NOT NULL DEFAULT 500,
  system_prompt_override TEXT,
  ordering               INTEGER NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, persona_slug)
);
CREATE INDEX IF NOT EXISTS project_personas_project_idx ON project_personas (project_id);
```

## tRPC surface
- `projectPersonas.list({ projectId })` — returns merged baseline + override rows (auto-seeded on first read)
- `projectPersonas.update({ projectId, personaSlug, patch })` — upsert
- `projectPersonas.reorder({ projectId, ordering })` — array of slugs in order
- `cost.byPersona({ projectId, range })` — sums worker_runs.cost_usd_cents grouped by persona_slug for date range

## Blast radius
- Additive table only. No shipped readers depend on it; orchestrator will pick it up at next sprint when persona routing is wired through.
- Fallback: missing rows return baseline defaults — no NPE risk.

## Rollback strategy
- `DROP TABLE project_personas;` — additive only. Drop migration 0047. No downstream consumers in this PR.

## Risk tier
- Medium. New DDL on a multi-tenant table. No security-critical data; system-prompt overrides are user-supplied and rendered as plain text only.
