# Phase 2 — Router Sweep Checklist

Phase 1 (this commit) lands the foundation: Drizzle schema mirrors migration 0015,
new migrations 0045/0046/0047, finalized `projectProcedure` middleware, and the
project-isolation integration test scaffold (with direct-DB assertions live and
tRPC-layer assertions as `.todo`).

Phase 2 must be done as one PR per bounded context so each PR is small enough
to review and the test scaffold gets converted from `.todo` to live assertion
incrementally.

## Per-router conversion recipe

For each project-scoped router file:

1. Replace import:
   ```diff
   - import { tenantProcedure } from '../middleware/tenant.js'
   + import { projectProcedure } from '../middleware/project.js'
   ```
2. Swap procedure usage `tenantProcedure` → `projectProcedure` for every
   read/write against project-scoped aggregates.
3. Add `eq(<table>.projectId, ctx.projectId!)` to every `where` clause that
   already has `eq(<table>.tenantId, ctx.tenantId!)`.
4. For input-id routers, cross-check `input.projectId === ctx.projectId`:
   ```ts
   if (input.projectId !== ctx.projectId) {
     throw new TRPCError({ code: 'BAD_REQUEST', message: 'projectId mismatch' })
   }
   ```
5. In the integration test, flip the corresponding `.todo` to a real
   assertion that goes through the router's caller (use the existing tRPC
   client helper in test/utils).

## Routers to convert (CRITICAL/HIGH per audit)

- [ ] **backlog.ts** — epics, stories, sprints. All list/get/update procedures.
- [ ] **channels.ts** — channels, channel_posts, channel_subscriptions.
- [ ] **code-reviews.ts** — code_reviews. Cross-references task/PR; project_id
  via the task row.
- [ ] **orchestration.ts** — tasks, retry_attempts, escalations, worktrees.
- [ ] **retros.ts** — retro_reports, retro_proposals, retro_outcomes.
- [ ] **stories.ts** — stories detail/redirect.
- [ ] **uat.ts** — uat_sessions, uat_ac_results, defects.
- [ ] **vision.ts** — vision_documents, vision_versions, vision_sessions.
- [ ] **audit.ts** — audit events list (filter by project via aggregate FK).
- [ ] **audit-export.ts** — same as audit; ensure export filters per project.
- [ ] **github.ts** — PR linkage; uses task.projectId via join.
- [ ] **memory.ts** — project_memory_entries already carries projectId; switch
  to projectProcedure and check `eq(entries.projectId, ctx.projectId)`.
- [ ] **planning.ts** — planning_runs; carry projectId via sprintId join.
- [ ] **replay.ts** — event replay scoped by project.
- [ ] **team.ts** — team membership scoped by project.

## Input-id routers (cross-check, do not switch to projectProcedure)

These already accept `projectId` as input and don't list across projects;
they need explicit cross-check of `input.projectId === ctx.projectId`:

- [ ] **cost.ts**
- [ ] **prs.ts**
- [ ] **boards.ts**
- [ ] **memory.ts** (write paths only)

## Acceptance per PR

- All edits compile (`npm run build -w @orbital/orchestrator`).
- All existing tests still pass.
- The integration-test `.todo` for the converted router(s) flipped to a
  real `it(...)` assertion that passes against the test Aurora cluster.
- No new lint warnings.

## Phase 3 — NOT NULL + Deploy

Only after every PR above merges and staging shows clean traffic for ≥24h:

1. Apply `0047_project_id_not_null.sql`.
2. Build + deploy api-lambda and ui.
3. Walk-deep verify two-tenant × two-project flow against staging.

## Out-of-scope from this remediation

- The orchestrator package has pre-existing unrelated build errors (missing
  `@orbital/domain` package, missing `EventStore` exports). Those are not
  caused by this remediation and must be resolved on `main` before any
  Lambda deploy succeeds. Confirmed by attempting `npm run build -w
  @orbital/orchestrator` on this branch BEFORE any of the schema changes —
  same failures. Tracked separately.
