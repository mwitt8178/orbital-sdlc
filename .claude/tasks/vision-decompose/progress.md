# Vision Decompose Task Progress

[Engineer-Sr · Sonnet · run-vision-decompose]

## Status: COMPLETE

## Self-checks

### DSQL/multi-tenant discipline
- [x] No FK constraints in migration (DSQL hard-no)
- [x] No triggers, sequences, or extensions
- [x] DDL only — no DML in migration
- [x] IDs: UUID, written by app as uuidv7
- [x] OCC retry helper used in insertProposalAsBacklog (withOccRetry)
- [x] tenant_id sentinel default on new table
- [x] clock_timestamp() not needed — timestamps written by app code

### Multi-tenant isolation
- [x] tenant_id column on vision_decomposition_runs
- [x] All router procedures filter on tenantId
- [x] generatePlan, approvePlan, discardPlan, runStatus all scope by tenantId
- [x] Tenant-bleed tests: VD1 assertions (5 cases)

### Security/observability
- [x] ANTHROPIC_API_KEY missing surfaces clear error message pointing to /admin/integrations
- [x] logger.info/warn on key events (generatePlan completed, discardPlan)
- [x] No secrets logged

### TDD loop
- RED: wrote vision-decomposition-runs.test.ts (20 tests) first
- GREEN: implemented schema + router procedures
- All 20 tests pass
- Pre-existing occ.test.ts failure: @orbital/domain package not built in worktree (deferred — not caused by this change)

## AC coverage
- [x] New table vision_decomposition_runs — migration 0047, Drizzle schema, barrel export
- [x] Trigger: "Generate plan" button in PlanningPanel calls planning.generatePlan
- [x] Planning agent: reads vision text, returns structured JSON via Anthropic tool-use
- [x] Insert into epics + stories tables under proper tenant_id — insertProposalAsBacklog()
- [x] UI: PlanningPanel shows Generate plan → spinner → epics/stories → Approve/Discard
- [x] Approve persists backlog rows + navigates to /backlog
- [x] Discard stamps run as discarded without writing backlog rows
- [x] Tests: tenant isolation (VD1), JSON schema validation (VD2), idempotency (VD3)
- [x] Real Claude API — createAnthropicDriver() called in generatePlan
- [x] Missing ANTHROPIC_API_KEY surfaces clear error

## Deferred
- Planning router 0040 `planning_runs` rows are also created per generatePlan call for
  full token/cost audit trail. The vision_decomposition_runs table holds the user-facing
  lifecycle status (pending/approved/discarded). These two tables co-exist intentionally.
- The old regenerate/commit procedures are kept for backwards compatibility.
  New UI code uses generatePlan/approvePlan/discardPlan.

## Risk Tier: Low-Medium (no infra changes, additive migration, no FK changes)
