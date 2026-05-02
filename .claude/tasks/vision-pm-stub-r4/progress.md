# Task: vision-pm-stub-r4 — Fix Vision Intake "send accepted but nothing happens"

## Status: COMPLETE

## Self-checks

### DSQL/multi-tenant/security/observability
- No DSQL constraints touched (Postgres only, no Aurora DSQL patterns used).
- No tenant isolation concerns: vision sessions are per-install, install_id is already scoped.
- No IAM changes.
- All DB writes go through Drizzle ORM with parameterised queries.
- Logger redacts credentials per existing pino config.

### TDD loop
- RED: identified failing scenario — user sends message → no PM reply appears.
- GREEN: implemented VisionPMStub + subscriber + UI thinking indicator.
- REFACTOR: removed dynamic imports, cleaned to static imports throughout.

### Risk Tier
- S (Small) — additive files only; no mutations to existing DB schema; service.ts untouched.
- Risk remains Low/Medium. No escalation needed.

## Files created/modified

### New files (orchestrator)
- `packages/orchestrator/src/vision/pm-stub.ts` — VisionPMStub class
- `packages/orchestrator/src/vision/pm-stub-subscriber.ts` — EventStore subscriber
- `packages/orchestrator/test/integration/vision/pm-stub.integration.test.ts` — integration test

### Modified (orchestrator)
- `packages/orchestrator/src/orchestration/boot.ts` — wire registerVisionPMStub at step 14b

### New files (UI)
- `packages/ui/src/components/features/vision/PMThinkingIndicator.tsx` — animated thinking dots

### Modified (UI)
- `packages/ui/src/components/features/vision/VisionChat.tsx` — optimistic messages, thinking indicator, demo-mode banner

## Build status
- `tsc --noEmit` on orchestrator: CLEAN (0 errors)
- `tsc --noEmit` on UI vision files: CLEAN (0 errors in owned files)
- `vitest run` on unit tests: 724/724 PASS

## Deferred
- WS push of PM messages to UI: the pm-stub writes real VisionMessageSent events
  which the WS agent's event stream will pick up. The thinking indicator also
  clears on store update from any source (WS or polling). Full WS integration
  tested by WS agent.
- `replaceOptimistic` Zustand helper: deferred — current approach of filtering
  by temp id and appending confirmed is functionally correct.
