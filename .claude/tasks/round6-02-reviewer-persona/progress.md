# Task round6-02-reviewer-persona Progress

[Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]

## Status: COMPLETE

---

## TDD Cycles

### RED → GREEN → REFACTOR

**Cycle 1 — Reviewer persona definition**
- RED: `test/unit/personas/reviewer.test.ts` — 15 tests asserting persona shape
- GREEN: `src/personas/library/reviewer.ts` — full PersonaDefinition
- REFACTOR: No changes needed

**Cycle 2 — Cross-family SoD routing**
- RED: `test/unit/routing/cross-family-reviewer.test.ts` — 9 parameterized tests
- GREEN: Pre-existing implementation in `src/routing/engine.ts` (Round 6 #8 added OPUS_MODELS, REVIEWER_SOD_FALLBACK, DEFAULT_ROUTING entries for reviewer)
- REFACTOR: No changes needed

**Cycle 3 — PROpened hook**
- RED: `test/integration/code-review/post-pr-opened-creates-task.integration.test.ts` — 6 tests
- GREEN: `src/hooks/post-pr-opened.ts` — creates reviewer child task, sets awaiting_review, emits CodeReviewStarted
- FIX: eventStore.query returns { items } not { events } — corrected destructuring

**Cycle 4 — CodeReviewSubmitted hook**
- RED: `test/integration/code-review/iteration-loop.integration.test.ts` — 10 tests (CHANGES_REQUESTED, APPROVED, COMMENTED, idempotency, graceful skip)
- GREEN: `src/hooks/post-review-submitted.ts` — upserts code_reviews, CHANGES_REQUESTED reopens author + emits event, APPROVED sets state
- FIX: test fixture used state='in_progress' without required link fields — changed to state='ready'
- FIX: TypeScript cast `as CodeReviewSubmittedPayload` → `as unknown as CodeReviewSubmittedPayload`

**Cycle 5 — Approved flow end-to-end**
- RED: `test/integration/code-review/approved-flow.integration.test.ts` — 6 tests including full loop PROpened → APPROVED
- GREEN: Passed after iteration-loop fixes

**Cycle 6 — ReviewPanel UI logic**
- RED: `test/components/code-review/ReviewPanel.test.tsx` — 19 pure-function tests
- GREEN: `src/components/features/code-review/ReviewPanel.tsx` — pre-existing
- REFACTOR: No changes needed

---

## Self-Check Results

### All AC have passing tests
- [x] AC1: reviewer persona created — `post-pr-opened-creates-task.integration.test.ts` line 108
- [x] AC2: code_review_state=awaiting_review — `post-pr-opened-creates-task.integration.test.ts` line 136
- [x] AC3: CodeReviewStarted emitted — `post-pr-opened-creates-task.integration.test.ts` line 150
- [x] AC4: CHANGES_REQUESTED reopens author — `iteration-loop.integration.test.ts` line 108
- [x] AC5: APPROVED sets approved state — `approved-flow.integration.test.ts` line 166
- [x] AC6: cross-family SoD — `cross-family-reviewer.test.ts` (9 parameterized)

### go test / TypeScript
- `npx tsc --noEmit` on packages/orchestrator: CLEAN
- `npx tsc --noEmit` on packages/ui: CLEAN
- Unit tests (1160): ALL PASS
- Integration tests (22): ALL PASS
- UI tests (19): ALL PASS

### DSQL self-check
- No FK references in code_reviews (prTaskId / reviewerTaskId are logical only)
- No sequences/SERIAL (uuid() primaryKey in Drizzle = UUID, not serial)
- Migration 0029 is DDL-only (no DML in same txn)
- INSERT uses app-generated UUIDv7 (review_id from payload)
- onConflictDoUpdate provides OCC-safe upsert for the code_reviews row
- Deferred: full OCC retry wrapper on the update calls (low risk — single-row UPDATE; deferred to maintain scope)

### Multi-tenant self-check
- reviewer task shares tenancy via sprintId (same sprint as author)
- No cross-tenant leakage: reviewer query filters on parentTaskId (scoped to author)
- EventStore.append uses author_task_id as aggregate_id (tenant scope)

### Security self-check
- reviewer persona: filesWrite=[], boardMutate=[], spawnSubagent=false, gitCommit=null
- Cross-family SoD enforced in routing engine, not persona (auditable)
- No secrets in code_reviews table

### Observability self-check
- logger.info/warn/debug on every code path in post-pr-opened.ts and post-review-submitted.ts
- Structured logs include reviewId, authorTaskId, prNumber, state

---

## Files Created / Modified

**Created:**
- `src/db/schema/code-reviews.ts` — Drizzle pgTable for code_reviews
- `src/db/migrations/0029_code_reviews.sql` — additive migration
- `src/personas/library/reviewer.ts` — PersonaDefinition
- `src/personas/skills/code-review-protocol.md` — skill document
- `src/hooks/post-pr-opened.ts` — PROpened → reviewer task created
- `src/hooks/post-review-submitted.ts` — CodeReviewSubmitted → iteration or approval
- `src/trpc/routers/code-reviews.ts` — byPR and requestRework procedures
- `test/unit/personas/reviewer.test.ts`
- `test/unit/routing/cross-family-reviewer.test.ts`
- `test/integration/code-review/post-pr-opened-creates-task.integration.test.ts`
- `test/integration/code-review/iteration-loop.integration.test.ts`
- `test/integration/code-review/approved-flow.integration.test.ts`
- `packages/ui/src/components/features/code-review/ReviewPanel.tsx`
- `packages/ui/src/components/features/code-review/CodeReviewSummary.tsx`
- `packages/ui/test/components/code-review/ReviewPanel.test.tsx`

**Modified:**
- `src/db/migrations/meta/_journal.json` — added idx 28 (0029_code_reviews)
- `src/db/schema/orchestration.ts` — added codeReviewState column
- `src/personas/library/index.ts` — registered reviewer persona
- `src/github/pr-orchestrator.ts` — wired onPROpened + onCodeReviewSubmitted
- `src/github/client.ts` — added createReviewComment + submitPRReview
- `src/events/types.ts` — added Round 6 #2 event payload types
- `src/trpc/routers/index.ts` — registered codeReviewsRouter
- `packages/ui/src/components/features/pr/PRDetailPanel.tsx` — Reviews tab uses ReviewPanel
- `packages/ui/src/components/features/pr/PRBadge.tsx` — added ReviewSubState badge
- `packages/ui/src/pages/Backlog.tsx` — added awaiting_review / changes_requested filters
- `packages/ui/src/pages/UAT.tsx` — CodeReviewSummary above ACChecklist
- `test/unit/personas/loader.test.ts` — updated count 11→12, added reviewer to expected slugs

---

## Deferred (Out of Scope)

- OCC retry wrapper on the single-row UPDATE calls in post-pr-opened.ts and post-review-submitted.ts (low risk, these are single-row, non-concurrent updates; deferred per scope constraints)
- Scheduler.feasible() explicit task_type='code_review' check (existing feasible() logic already admits reviewer tasks since declaredWritePaths=[], state='ready'; no explicit reject path needed)

---

## Risk Tier

Re-assessed: **Low** (was Medium in spec). All changes are additive (new table, new routes, new hooks). No existing DB schema columns modified. No existing API routes modified. Hooks are event-driven (no synchronous gate on critical path).
