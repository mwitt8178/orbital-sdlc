# Remove sample/demo onboarding flow — architecture

[Engineer-Principal · Opus · run-remove-sample-flow]

## Goal

Excise the demo/sample onboarding flow end-to-end. No feature flag, no stubs.
The flow is broken UX, not a meaningful evaluation path, and clutters the codebase.

## Bounded contexts touched

- **onboarding** (orchestrator): drop `sample-loader`, `demo-replay`, `sample-data`,
  `sample-data/*` fixtures, `loadSample`, `startDemo`, `resetDemo`, `loadSampleSandbox`
  procedures, `sample_data` flow enum, `demo_replay_id` overlay field, `hasSampleData`
  status field, `demo` mode value.
- **drivers** (orchestrator): drop `drivers/mock.ts` (`MockDriver`, `isSampleModeEnabled`,
  `createMockDriverIfSampleMode`, `ORBITAL_SAMPLE_MODE`).
- **ui/onboarding**: drop `SampleDataFlow`, sample-flow card on `/welcome`,
  `Demo mode` card in `ModeStep`, demo-mode banner in `VisionChat`.
- **db schema**: enum `flow` on `onboarding_sessions` loses `'sample_data'`. Done via
  additive migration that recreates the CHECK constraint without `'sample_data'`.

## Aggregate boundaries / event flow

No new aggregates. Event types `SampleDatasetLoaded`, `DemoReplayCompleted` were
emitted by the deleted code paths only — no consumers exist (verified by ripgrep:
the strings only appear in the producing files). Deleting the producers is sufficient;
historical events in the event store remain (immutable audit trail) but no code
references their schema.

## DSQL schema diff

```sql
-- 0049_drop_sample_data_flow.sql (new migration)
-- Round 11 — sample-flow removal
-- Phase 1 (additive): replace the CHECK constraint to drop 'sample_data'.
-- No existing rows use sample_data on the mwitt install (verified out-of-band);
-- if any do, this migration will fail loudly and the operator must clean them.
ALTER TABLE onboarding_sessions
  DROP CONSTRAINT IF EXISTS onboarding_sessions_flow_check;
ALTER TABLE onboarding_sessions
  ADD CONSTRAINT onboarding_sessions_flow_check
  CHECK (flow IN ('new_project','existing_repo','join_hub'));
```

`install.json` overlay's `demo_replay_id` field is just dropped from the schema
(zod). Existing JSON files with the field present become forward-compat noise —
zod will reject if `.parse()` strict mode is on. Check: `overlaySchema` uses
`z.object` which is non-strict by default — extra keys are silently dropped on parse.
Confirmed safe.

## IAM diff

None. No new IAM, no removed IAM. The api-lambda router auto-loses these procedures
because it imports the orchestrator's `onboardingRouter()`.

## Blast radius

- `api-lambda/handler.mjs`: rebuilt + redeployed; alias `:live` updated.
- UI bundle: rebuilt + invalidated on CloudFront.
- Existing install state with `demo_replay_id` set: no migration needed; field
  read no longer exists in code; zod silently drops the unknown key on next parse.
- Hygiene scan still cleans `[DEMO]%` prefix rows — kept as defensive cleanup
  for the existing mwitt install which has stale demo rows.

## Rollback strategy

`git revert` the commit; the api-lambda redeploy is reversible by pointing
`:live` alias back at the prior version. The DSQL CHECK-constraint migration
is forward-only but idempotent — re-adding `'sample_data'` to the enum is a
trivial follow-up migration if rollback is ever required.

## Coordination

Another agent owns `packages/ui/src/auth/` and `packages/ui/src/pages/Login*`.
Confirmed via Bash: `auth/` does not exist; no `Login*` files exist. No conflict.

## Confidence: 96

Risk Tier: Medium-High (cross-cutting, cross-package, hits prod Lambda + CloudFront).
Threshold cleared (95) for High risk. Single human-supplied scope; deletion-only
in source code; deploy is reversible.
