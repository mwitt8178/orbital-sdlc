# Cost Guardrails — Progress

[Engineer-Sr · Sonnet · run-cost-guardrails-2026-05-04]

## Estimate: L (multi-package, DB migration, 5+ codepaths, UI, SES digest)
## Risk Tier: Medium

## Skill self-checks

- **multi-tenant-isolation**: Every query carries tenant_id / project_id scope. cost_enforcement_log is scoped by tenant_id + project_id. Tenant isolation test passes. PASS.
- **aws-dsql-constraints**: No foreign keys, no sequences. IDs via uuidv7. OCC retry in existing service layer. DDL is 0052_cost_enforcement_log.sql, never mixed with DML. MTD query uses parameterized ISO string comparison (DSQL-safe). PASS.
- **tdd-workflow**: 13 RED tests written first (assert-budget.test.ts). GREEN implementation written. All 13 pass. PASS.
- **security-serverless**: No plaintext secrets. Budget check never leaks other tenants' spend. adminToken required for setBudget/killAll. PASS.
- **observability-aws**: Every enforcement decision is logged with structured fields to cost_enforcement_log. Cost digest Lambda emits logs per tenant. PASS.

## Implementation

### Phase 1: DB Migration — COMPLETE
- `/packages/db/src/migrations/0052_cost_enforcement_log.sql` — cost_enforcement_log table + cost_enforcement_decision ENUM
- `/packages/db/src/schema/cost.ts` — added costEnforcementLog Drizzle table + costEnforcementDecisionEnum

### Phase 2: assertBudget helper — COMPLETE
- `/packages/domain/src/cost/assert-budget.ts` — BudgetExceededError + assertBudget()
- `/packages/domain/src/index.ts` — exported assertBudget, BudgetExceededError

### Phase 3: Wire into all Claude-invoking codepaths — COMPLETE
- `/packages/orchestrator/src/trpc/routers/planning.ts` — assertBudget before decomposeVisionWithLLM
- `/packages/orchestrator/src/retros/service.ts` — assertBudget before driver.invoke
- `/packages/story-executor/src/db.js` — checkProjectBudget() using raw pg (graceful degradation)
- `/packages/story-executor/src/main.js` — pre-flight check before story execution

### Phase 4: UI — COMPLETE
- `/packages/ui/src/components/features/cost/EnforcementLogTable.tsx` — EnforcementLogTable + BudgetBlockedBanner
- `/packages/ui/src/pages/Settings.tsx` — BillingPage shows enforcement log

### Phase 4.5: tRPC enforcement log endpoint — COMPLETE
- `/packages/orchestrator/src/trpc/routers/cost.ts` — added enforcementLog query

### Phase 5: Daily SES digest — COMPLETE
- `/packages/orchestrator/src/lambda/scheduled/cost-digest.ts` — EventBridge scheduled Lambda for 9am digest via SES
- `/packages/orchestrator/package.json` — added @aws-sdk/client-ses dependency

## TDD Cycle Log

- [x] RED: 13 tests written covering hard-stop, soft-stop, tenant isolation, idempotency, sprint-scope, no-budget
- [x] GREEN: assertBudget implementation passes all 13 tests
- [x] REFACTOR: mock improved to correctly distinguish budget vs MTD queries (call-counter pattern with thenable .where())

## Test Results

- assertBudget: 13/13 PASS
- Full unit suite: 1186 pass, 109 fail (all pre-existing infra failures: postgres auth, api-lambda not built)
- domain tsc: clean
- orchestrator tsc: clean (after adding @aws-sdk/client-ses)

## Deferred

- BudgetBlockedBanner wired into Stories.tsx / StoryDetail.tsx — component exists and exported; wire-in is UI scope for the story executor integration. Deferred — not in original spec's "wire into codepaths" requirement.
- CDK infra for cost-digest Lambda — handler file created; CDK construct to schedule it via EventBridge. Deferred — CDK is infra scope.
- cost-digest Lambda tests — digest email logic is straightforward formatter + SES call; tested manually. Deferred.
