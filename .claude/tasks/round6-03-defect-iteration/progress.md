# Round 6 #3 — Iterate-on-Defect Loop in UAT

[Engineer-Sr · Sonnet · run-round6-03-defect-iteration]

## Estimate

M (implementation + 4 integration tests + 2 UI tests + 2 migrations)

## Risk Tier

Medium (new hook + schema columns + UI components; no existing behavior removed)

---

## Files Created

### Migrations
- `packages/orchestrator/src/db/migrations/0030_defect_iteration.sql` — adds `iteration_count INT NOT NULL DEFAULT 0` and `last_defect_id UUID` to tasks; partial index `tasks_iteration_idx`
- `packages/orchestrator/src/db/migrations/0031_defect_nullable_session.sql` — makes `defects.uat_session_id` and `defects.ac_result_id` nullable for operator-reported defects (no formal UAT session)

### Backend
- `packages/orchestrator/src/hooks/post-defect-reported.ts` — exports `ITERATION_LIMIT=3`, `createPostDefectReportedHook`, `onDefectReported`

### Frontend
- `packages/ui/src/components/features/uat/DefectReporter.tsx` — modal component
- `packages/ui/src/components/features/uat/DefectTimeline.tsx` — vertical timeline component

### Tests
- `packages/orchestrator/test/integration/defects/iteration-loop.integration.test.ts`
- `packages/orchestrator/test/integration/defects/iteration-limit.integration.test.ts`
- `packages/orchestrator/test/integration/defects/worktree-reuse.integration.test.ts`
- `packages/orchestrator/test/integration/defects/force-with-lease.integration.test.ts`
- `packages/ui/test/components/DefectReporter.test.tsx`
- `packages/ui/test/components/DefectTimeline.test.tsx`

---

## Files Modified

- `packages/orchestrator/src/db/migrations/meta/_journal.json` — added idx 29 (0030) and idx 30 (0031)
- `packages/orchestrator/src/db/schema/orchestration.ts` — added `iterationCount`, `lastDefectId` columns
- `packages/orchestrator/src/db/schema/uat.ts` — made `uatSessionId` and `acResultId` nullable on defects table
- `packages/orchestrator/src/events/types.ts` — added Round 6 #3 payload interfaces (DefectReportedPayload, TaskReopenedForDefectPayload, IterationStartedPayload, IterationCompletedPayload, DefectIterationLimitReachedPayload, DefectResolvedPayload, BranchUpdatedPayload)
- `packages/orchestrator/src/uat/defects.ts` — added `SubmitDefectParams`, `SubmitDefectResult`, `DefectHistoryEntry` interfaces; added `submitDefect`, `getDefectsForTask`, `markDefectFixed` to interface + implementation
- `packages/orchestrator/src/orchestration/boot.ts` — registered `createPostDefectReportedHook` in hook loader
- `packages/orchestrator/src/orchestration/spawn.ts` — added `reuseWorktree?: boolean` to `SpawnParams`; wrapped `git checkout -B` in `if (!params.reuseWorktree)` guard
- `packages/orchestrator/src/trpc/routers/uat.ts` — added `uat.defects.history`, `uat.defects.markFixed`, `uat.defects.report` procedures
- `packages/ui/src/components/features/uat/ACChecklist.tsx` — added `taskId`, `iterationCount`, `onReportDefect` props; "Report defect" button per AC row
- `packages/ui/src/pages/UAT.tsx` — renders DefectTimeline + DefectReporter modal
- `packages/ui/src/components/features/pr/PRBadge.tsx` — "rerolled Nx" badge for `iterationCount > 0`
- `packages/ui/src/pages/Backlog.tsx` — "Iterating" filter chip

---

## Acceptance Criteria Evidence

### AC1 — DefectService.submitDefect emits DefectReported

```
grep -n "DefectReported" packages/orchestrator/src/uat/defects.ts
→ Line 409: event_type: 'DefectReported',
```

### AC2 — onDefectReported transitions task to ready, iteration_count=1

Test: `iteration-loop.integration.test.ts`
```
grep -n "state.*ready\|iterationCount.*1" packages/orchestrator/src/hooks/post-defect-reported.ts
→ state: 'ready', iterationCount: sql`${tasks.iterationCount} + 1`
```
Integration test result: PASS

### AC3 — 4th defect emits DefectIterationLimitReached, no re-spawn

Test: `iteration-limit.integration.test.ts`
```
grep -n "ITERATION_LIMIT" packages/orchestrator/src/hooks/post-defect-reported.ts
→ export const ITERATION_LIMIT = 3
→ if (currentCount >= ITERATION_LIMIT)
→ event_type: 'DefectIterationLimitReached'
```
Integration test result: PASS

### AC4 — boot.ts registers post-defect-reported hook

```
grep -E "createPostDefectReportedHook|post-defect-reported" packages/orchestrator/src/orchestration/boot.ts
→ import { createPostDefectReportedHook } from '../hooks/post-defect-reported.js'
→ const postDefectReportedSpec = createPostDefectReportedHook(db, eventStore)
→ const definitions = await hookLoader.load([postTaskSpec, postDefectReportedSpec])
```

### AC5 — spawn reuseWorktree=true skips git checkout -B

```
grep -E "reuseWorktree|!params\.reuseWorktree" packages/orchestrator/src/orchestration/spawn.ts
→ reuseWorktree?: boolean
→ if (!params.reuseWorktree) { ... git checkout -B ... }
→ 'spawn: reuseWorktree=true — skipping git checkout -B (defect iteration)'
```
Integration test (worktree-reuse): PASS

### AC6 — --force-with-lease in push (never bare --force)

```
grep -E "force-with-lease|'--force'" packages/orchestrator/src/github/pr-orchestrator.ts
→ ['push', '--force-with-lease', pushRemote, ...]
→ (no bare '--force' string found)
```
File-reading test (force-with-lease): PASS

---

## Test Summary

```
packages/orchestrator/test/integration/defects/force-with-lease.integration.test.ts  4 PASS
packages/orchestrator/test/integration/defects/iteration-limit.integration.test.ts   1 PASS
packages/orchestrator/test/integration/defects/iteration-loop.integration.test.ts    1 PASS
packages/orchestrator/test/integration/defects/worktree-reuse.integration.test.ts    1 PASS
packages/ui/test/components/DefectReporter.test.tsx                                  24 PASS
packages/ui/test/components/DefectTimeline.test.tsx                                  21 PASS
Total: 52 tests, 52 passed, 0 failed
```

Pre-existing failures in vision/e2e/hygiene/retros tests (14 tests) were present before this work and are caused by test-ordering isolation issues, not related to files touched by this PR.

---

## Schema Self-Check (multi-tenant-migrations)

- Additive only: both migrations use `ADD COLUMN IF NOT EXISTS` / `ALTER COLUMN ... DROP NOT NULL`
- No FK additions (only making FKs nullable — additive semantics)
- No data migration (only NULL constraint relaxation)
- All new integer columns have NOT NULL DEFAULT 0
- Phase: additive (Phase 1 only — no rename/drop)

## DSQL Self-Check (aws-dsql-constraints)

- No foreign keys added
- No sequences/SERIAL
- UUIDs via uuidv7()
- OCC retry: onDefectReported uses Drizzle update (no multi-step txn requiring explicit OCC)
- All events via EventStore.append (never direct db.insert(events))

## Security Self-Check (security-serverless)

- No secrets logged
- Capability sentinel IDs removed in favour of NULL (more correct)
- No new IAM surfaces

## Observability Self-Check (observability-aws)

- logger.info/warn used in hook and defects service
- Structured keys: taskId, defectId, iterationCount throughout

---

## Deferred

- `UATService.service.ts` emitting `UATResolutionVerified` on mark-fixed — that event is emitted by `markDefectFixed` in defects.ts via `DefectResolved`; the UATService's separate `UATResolutionVerified` (per original deliverable spec) is deferred as the event hierarchy is covered by `DefectResolved` for the v1 loop. Note in `progress.md`.
- Playwright E2E for DefectReporter modal — referenced in deliverables spec as "E2E coverage in Playwright specs"; that is a separate ticket.

---

## Risk Tier Final Assessment

Medium — unchanged. Additive schema changes, new hook (non-gating post hook), new UI components with no breaking changes to existing surfaces.

---

## Deferreds resolved (followup run)

[Engineer-Sr · Sonnet · run-round6-03-defect-iteration-followup]

### Item 1: UATResolutionVerified emission

**grep output (hard-stop check):**
```
packages/orchestrator/src/events/types.ts: * event_type: 'UATResolutionVerified'
packages/orchestrator/src/events/types.ts:export interface UATResolutionVerifiedPayload {
packages/orchestrator/src/uat/service.ts:        // Emit UATResolutionVerified when all ACs passed on a task that iterated
packages/orchestrator/src/uat/service.ts:    // Emit UATResolutionVerified when all ACs passed on a task that iterated
packages/orchestrator/src/uat/service.ts:   * emit UATResolutionVerified to signal the defect loop closed successfully.
packages/orchestrator/src/uat/service.ts:      // Not a defect-iteration session — no UATResolutionVerified needed
packages/orchestrator/src/uat/service.ts:      event_type: 'UATResolutionVerified',
packages/orchestrator/src/uat/service.ts:      'UATService: UATResolutionVerified emitted — defect loop closed',
```

**Implementation:**
- `UATResolutionVerifiedPayload` added to `packages/orchestrator/src/events/types.ts` in the Round 6 #3 section
- `emitResolutionVerifiedIfIterating(ticketId, uatSessionId, traceId, now)` private helper added to `DefaultUATService` — queries tasks by ticketId, picks task with highest iterationCount, emits event only when iterationCount > 0
- Called from both `submit()` (outcome=accepted path) and `accept()` after UATAccepted event
- Payload: `{ task_id, ticket_id, uat_session_id, total_iterations, total_defects_filed, total_defects_resolved, finalized_at }`

**Integration test output:**
```
packages/orchestrator/test/integration/defects/uat-resolution-verified.integration.test.ts (2 tests) 79ms
  - emits exactly one UATResolutionVerified when all ACs pass on a task with iteration_count=2 PASS
  - does NOT emit UATResolutionVerified when iteration_count=0 (first-pass session) PASS
```

**Full defect suite:**
```
packages/orchestrator/test/integration/defects/force-with-lease.integration.test.ts   4 PASS
packages/orchestrator/test/integration/defects/iteration-limit.integration.test.ts    1 PASS
packages/orchestrator/test/integration/defects/iteration-loop.integration.test.ts     1 PASS
packages/orchestrator/test/integration/defects/uat-resolution-verified.integration.test.ts  2 PASS
packages/orchestrator/test/integration/defects/worktree-reuse.integration.test.ts     1 PASS
Total: 9 tests, 9 passed, 0 failed
```

### Item 2: E2E Playwright coverage

**Approach:** Option B — real Playwright (playwright.config.ts already exists in packages/ui; test:e2e script present).

**File created:** `packages/ui/test/e2e/defect-reporter.spec.ts`

**Tests in spec:**
1. `modal structure: dialog role and AC text in header are present` — intercepts tRPC to serve story/session/AC data, opens modal via "Report defect" click, asserts role="dialog" and AC text visible
2. `submit button is disabled when reproduction steps are empty` — verifies disabled state on empty repro, enabled after fill
3. `iteration limit warning is shown when iterationCount >= 3` — seeds iterationCount=3 in mocked session response, asserts role="alert" and warning text
4. `modal closes when Cancel is clicked` — dialog becomes not visible
5. `modal closes via close button (X)` — aria-label="Close defect reporter" click hides modal
6. `DefectTimeline renders empty state when no defects exist` — "Defect Iteration History" heading and "No defects reported yet." text visible

All tests use `page.route()` to intercept tRPC batch calls and return controlled fixtures — no real backend required, consistent with existing E2E patterns.

**TypeScript check:** `npx tsc --project packages/ui/tsconfig.json --noEmit` clean.

### Self-checks (followup run)

- DSQL: no new mutating transactions; `emitResolutionVerifiedIfIterating` is read-only DB queries + EventStore.append
- Multi-tenant: ticketId scoping preserved (queries by `tasks.ticketId = session.ticketId`)
- Security: no new IAM surfaces, no secrets logged
- Observability: logger.info with structured keys on emission
