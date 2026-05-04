# Architecture — /settings/general (project-scoped)

[Engineer-Principal · Opus · run-settings-general]

## Bounded contexts touched

- **projects** (orchestrator + domain) — extend ProjectsService with `update(slug,color,description,name)`, `reset`, `delete`, `metadata`.
- **events** — read-side join for last activity (latest event with `aggregate_id = projectId` OR `payload.project_id = projectId`).
- **ui** — extend `Settings.tsx` GeneralPage with 5 new sections.

## Aggregate boundaries

`projects` aggregate stays the single owner. `reset` cascades writes into child aggregate tables (epics/stories/sprints/channels/ceremonies/retros/uat/tasks) and emits a `ProjectReset` event for audit. `delete` is admin-only hard delete (post-archive).

## Event flow

| Action | Event |
|---|---|
| Update name/slug/desc/color | `ProjectUpdated` |
| Archive | `ProjectArchived` (existing) |
| Reset | `ProjectReset` (NEW) — payload includes counts of rows cleared per child table |
| Delete (hard) | `ProjectDeleted` (NEW) — payload includes recovery_email for audit chain |

All emitted via existing `EventStore.append`.

## DSQL/Aurora schema diff (migration 0045)

Additive only:

```sql
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS color text,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by_event_id uuid;
```

`archived_at` already exists in 0015. `color` is new. `deleted_at` distinguishes hard-delete tombstone from soft-archive (we keep the row briefly for audit, then a sweeper can purge — out of scope here).

No new tables, no FK, no triggers, no constraint flips. Compatible with both Aurora Serverless v2 and DSQL.

## IAM diff

None. Procedures use existing `tenantProcedure` with the `requireRole('admin')` middleware that already exists for delete-class actions; reuses the same audit identity.

## Blast radius

- **Read**: low — additive UI only.
- **Update**: low — narrow column set, OCC-safe via `updated_at` check.
- **Reset**: MEDIUM — clears child rows for one project. Tenant-scoped + projectId-scoped DELETE; protected by typed-confirm.
- **Delete (hard)**: HIGH — drops aggregate row. Admin-only + typed-confirm + recovery-email-record. No cross-tenant exposure: every WHERE includes `tenant_id`.

## Rollback strategy

- Migration 0045 is additive (no data destroyed) → rollback = `ALTER TABLE projects DROP COLUMN color, deleted_at, deleted_by_event_id`.
- Lambda `:live` alias flip is the single deploy gate. If walk-deep regresses, re-point alias to v51.
- UI is S3+CF; previous build is one `aws s3 sync` + invalidate away.

## Procedures (tRPC contracts)

```
projects.update({ projectId, patch: { name?, slug?, description?, color? } })       -> ProjectClientShape
projects.archive({ projectId, confirmName })                                         -> { ok: true }
projects.reset({ projectId, confirmName })                                           -> { ok: true, cleared: {...} }
projects.delete({ projectId, confirmName, recoveryEmail })                           -> { ok: true }   [admin only]
projects.metadata({ projectId })                                                     -> { createdAt, createdByEmail, lastActivityAt, eventCount, tenantId }
```

`update.patch.slug` runs reserved-list check (`['admin','api','app','settings','login','signup','oauth','health']`) + tenant-scoped duplicate name/slug check.

## Confidence

confidence: 96 — additive migration, narrow procedures, OCC-safe writes, every mutation tenant-scoped + emits an event, destructive actions gated by typed confirm + admin role for hard-delete. Risk concentrated in `reset` which is bounded to a single projectId scope.
