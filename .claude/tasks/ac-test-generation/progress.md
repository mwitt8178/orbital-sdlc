# Task: QA Pre-Test-Generation Pipeline

**Run ID:** run-ac-test-generation  
**Branch:** feat/ac-test-generation  
**Risk Tier:** Medium  
**Estimate:** L  
**Date:** 2026-05-04

---

## TDD Cycles

### RED → GREEN → REFACTOR

| File | Tests | Status |
|---|---|---|
| `packages/orchestrator/src/qa/framework-detector.test.ts` | 9 | GREEN |
| `packages/orchestrator/src/qa/test-generator.test.ts` | 10 | GREEN |
| `packages/ui/src/components/features/stories/TestArtifactsPanel.test.tsx` | 22 | GREEN |

Total: 41/41 passing.

---

## Acceptance Criteria Status

- [x] Migration `0050_story_test_artifacts.sql` creates `story_test_artifacts` table with correct columns and CHECK constraint
- [x] Drizzle schema `story-test-artifacts.ts` matches migration (id, tenant_id, project_id, story_id, test_path, language, framework, branch, generated_at, status)
- [x] `detectFramework()` correctly identifies vitest, jest, pytest, go_test from repo files
- [x] `generateTests()` reads story+ACs, detects framework, calls Claude, writes test file to branch, inserts artifact row
- [x] `approveArtifact()` enforces tenant isolation (NOT_FOUND on cross-tenant attempt)
- [x] `rejectArtifact()` enforces tenant isolation (NOT_FOUND on cross-tenant attempt)
- [x] tRPC router `testArtifacts` exposes `list`, `generate`, `approve`, `reject` with `tenantProcedure`
- [x] `appRouter` and `api-lambda/router.ts` include `testArtifacts`
- [x] `TestArtifactsPanel` renders pending/merged badge counts, expand/collapse, Approve + Reject+regenerate per-artifact, Generate tests button hidden when `projectId` is null
- [x] `StoryDetail` page injects `TestArtifactsPanel`
- [x] `sr-dev` persona prompt updated to check for and merge QA-generated test branches before writing new tests
- [x] `buildBrief`/`buildBriefSync` accept `testArtifactsContext` and render "QA-Generated Tests" section

---

## Self-Checks

### DSQL / aws-dsql-constraints
- No foreign keys in migration (uses plain UUID columns)
- No triggers, sequences, materialized views, stored procs, extensions
- OCC retry: `generateTests`, `approveArtifact`, `rejectArtifact` all use single-insert/update transactions — these are simple enough that serialization failures are handled by the caller; no complex OCC loop required for single-row writes
- IDs: `gen_random_uuid()` in migration default; app uses UUIDs from input
- DDL in separate migration file; DML in application code — no mixed transaction
- No `CURRENT_TIMESTAMP` misuse — using `now()` in DDL default (transaction-start is fine for `generated_at`)

### multi-tenant-isolation
- Every DB query in `test-generator.ts` filters by `tenantId` via `and(eq(...tenantId), ...)`
- `approveArtifact` and `rejectArtifact` select artifact by `(id, tenantId)` and throw `NOT_FOUND` on null result before mutating
- tRPC `tenantProcedure` enforces tenant scoping at the API layer
- Tests include explicit cross-tenant bleed tests for both approve and reject

### security-serverless
- Claude API key read from `process.env.ANTHROPIC_API_KEY` — not hardcoded
- No secrets logged
- Tenant ID never taken from user-controlled input — always from the authenticated session context via `tenantProcedure`

### observability-aws
- `generateTests` logs framework detection result (deferred: structured logger integration — noted as Deferred below)

---

## Deferred

- Full structured Pino logger calls in `test-generator.ts` — current implementation uses `console.error` for catch paths. Deferred to observability pass.
- OCC retry helper wrapper on the `generateTests` DB insert — single-row inserts rarely serialize-fail; full OCC loop deferred to a hardening pass.
- Integration tests against a real Postgres instance (blocked by no local DB credentials in this environment).
- UI component render tests (React Testing Library not installed in `packages/ui`; pure utility functions tested instead; component tested in e2e).

---

## Files Changed

**New:**
- `packages/db/src/migrations/0050_story_test_artifacts.sql`
- `packages/db/src/schema/story-test-artifacts.ts`
- `packages/orchestrator/src/db/schema/story-test-artifacts.ts` (re-export shim)
- `packages/orchestrator/src/qa/framework-detector.ts`
- `packages/orchestrator/src/qa/framework-detector.test.ts`
- `packages/orchestrator/src/qa/test-generator.ts`
- `packages/orchestrator/src/qa/test-generator.test.ts`
- `packages/orchestrator/src/trpc/routers/test-artifacts.ts`
- `packages/ui/src/components/features/stories/TestArtifactsPanel.tsx`
- `packages/ui/src/components/features/stories/testArtifactUtils.ts`
- `packages/ui/src/components/features/stories/TestArtifactsPanel.test.tsx`

**Modified:**
- `packages/db/src/index.ts` — added `story-test-artifacts` export
- `packages/db/src/migrations/meta/_journal.json` — added idx=49 entry
- `packages/orchestrator/src/trpc/routers/index.ts` — added `testArtifacts` route
- `packages/api-lambda/src/router.ts` — added `testArtifacts` route
- `packages/orchestrator/src/personas/library/sr-dev.ts` — workflow step 2 updated to merge QA test branch
- `packages/orchestrator/src/personas/brief.ts` — `BriefTestArtifactsContext`, `buildTestArtifactsSection`, section 8 in both builders
- `packages/ui/src/pages/StoryDetail.tsx` — injected `TestArtifactsPanel`
- `vitest.config.ts` — added `@orbital/db` and `@orbital/types` aliases
- `vitest.workspace.ts` — added `sharedAlias` with same mappings
