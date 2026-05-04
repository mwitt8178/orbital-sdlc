# Architecture — /settings/billing — Real Cost Surface Per Project

[Engineer-Principal · Opus · run-settings-billing]

## Bounded contexts touched

- **Cost governance** (orchestrator/domain/cost) — extend CostService with `dailySeries`, `byCategory`, `topExpensive`, `projection`, `monthCostUsd`. Extend BudgetService with `monthlyCapUsd`, `hardStop`, `digestEmails`.
- **API surface** (api-lambda + orchestrator/trpc/routers/cost.ts) — new procedures: `cost.dailySeries`, `cost.byCategory`, `cost.topExpensive`, `cost.projection`, `cost.exportCsv`, plus extension of `cost.summary` with month spend, `cost.setBudget` with monthly cap fields.
- **UI** (packages/ui/src/pages/Settings.tsx) — replace `BillingPage` ComingSoonState with a real `BillingPage` route component. Add new components under `components/features/billing/`.

## Aggregate boundaries

`cost_ledger` is the sole source of truth for spend. `worker_runs.cost_usd_cents` and `planning_runs.usd_cents` are write-side audit; the ledger row is the canonical financial event already emitted by both pipelines (CostService.appendLedger). We aggregate exclusively from `cost_ledger` to avoid double-counting.

`cost_budgets` owns budget configuration. The existing schema covers `hardCapUsd` for project scope; we extend it additively with three nullable columns:
- `monthly_cap_usd` numeric(10,2) NULL
- `hard_stop` boolean NOT NULL DEFAULT false (drives pause vs warn semantics distinct from existing on_hard)
- `digest_emails` text[] NOT NULL DEFAULT '{}'

Migration is additive only — no destructive change to cost_budgets.

## Categorisation

`category` is derived at query time from `cost_ledger.persona_id`:
- `story-execution` — persona_id IN ('engineer-sr','engineer-principal','engineer-jr') OR persona_id IS NULL AND task_id IS NOT NULL
- `planning` — persona_id IN ('product','planner','architect')
- `code-review` — persona_id IN ('reviewer','qa','security')
- `other` — fallback

This avoids a schema change while remaining explicit and testable. Category logic lives in `domain/cost/categories.ts` so it can be unit-tested.

## Event flow

No new events. `CostLedgerAppended` (existing) already invalidates the UI via React Query refetchInterval. Live burn already streams via WebSocket — we reuse the daily series query with a 30s refetch.

## IAM diff

None. New procedures are public-read like existing `cost.summary` / `cost.ledger`. `cost.setBudget` (extended) and `cost.exportCsv` follow the same admin-token pattern as the existing setBudget.

## DSQL schema diff

Migration `0045_cost_budgets_monthly.sql` (additive ALTER TABLE):
```sql
ALTER TABLE cost_budgets ADD COLUMN IF NOT EXISTS monthly_cap_usd numeric(10,2);
ALTER TABLE cost_budgets ADD COLUMN IF NOT EXISTS hard_stop boolean NOT NULL DEFAULT false;
ALTER TABLE cost_budgets ADD COLUMN IF NOT EXISTS digest_emails text[] NOT NULL DEFAULT '{}';
```

DDL-only, no DML, separate from data writes — DSQL safe. No FKs, triggers, or sequences. Backwards compatible: existing reads ignore the new columns.

## Blast radius

- Read procedures: read-only, additive. Worst case: 500 on a new procedure. No write paths affected.
- Migration: additive ALTER TABLE. Rollback = `ALTER TABLE ... DROP COLUMN IF EXISTS` (data loss limited to monthly cap config which has no upstream consumers yet).
- UI: new route mounted under existing `/settings/billing` path which currently shows ComingSoon — pure surface upgrade.
- BudgetTab on `/settings/sprints` keeps working because the existing `cost.setBudget` shape is preserved (new fields are optional).

## Rollback strategy

1. Revert UI bundle by re-pushing prior `dist/` to S3 (CloudFront cache invalidation).
2. Lambda alias `:live` rolls back to v51 (1 click in console).
3. Migration rollback: `ALTER TABLE cost_budgets DROP COLUMN monthly_cap_usd, DROP COLUMN hard_stop, DROP COLUMN digest_emails;` — non-destructive to existing budget rows.

## CSV export

Streamed in-memory (max 50k rows × ~200 bytes = ~10MB; well within Lambda response budget). Returns base64-encoded CSV in tRPC payload. UI converts to Blob and triggers download. No S3 round-trip needed for v1.

## Test strategy

- Unit test for `categories.ts` — every persona_id maps to a category.
- Unit test for `dailySeries` — fills zero-buckets across the date range.
- Unit test for `projection` — uses 7-day rolling avg × days remaining.
- Component test for `BillingPage` — renders empty state when no ledger rows; renders hero number when rows exist.
- Integration walk: navigate to /settings/billing, edit monthly cap → blur → reload → persisted; CSV downloads.

## Confidence

confidence: 96 — The work extends an established pattern (cost router + service), uses an additive DDL change, and follows the dependency-free SVG chart precedent already in the codebase. Risk is bounded: read-only procedures + additive migration + UI-only route swap.
