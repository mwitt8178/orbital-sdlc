# Post-onboarding fixes — architecture

[Engineer-Principal · Opus · run-post-onboarding]

## Bounded contexts touched
- onboarding (orchestrator/onboarding) — completeSession side-effects
- projects (domain/projects) — idempotent create from session state
- ui/web — Welcome.finalize, active-project store wiring

## Aggregate boundaries
- `onboarding_sessions` (existing) → on complete, materialise a `projects` aggregate
- `vision_documents` — deferred (PM persona spawn is daemon-shaped). The vision page's empty state is acceptable post-onboarding; the wizard already captures intent into `state_json` so an asynchronous seed can land later without blocking the user.

## Event flow
- `OnboardingCompleted` is already emitted (install-level)
- After this fix: `ProjectCreated` is emitted as part of completeSession (via projectsService.create)
- `onboarding_sessions.project_id` is patched with the canonical id

## IAM diff
- None — Lambda role already has read/write on `projects` table

## DSQL schema diff
- None — Aurora Serverless v2; uses existing `projects` schema

## Blast radius
- Server: completeSession path now writes 1 row to `projects` plus events; failure is contained — wizard can retry, idempotent on slug
- UI: active-project store hydration happens client-side; failure mode is "switcher empty" (current state)

## Rollback strategy
- Revert the worktree branch; no schema changes; existing sessions unaffected

## Confidence: 92
Rationale: the data plumbing is straightforward, projectsService.create is well-tested, and the worst case is that the create fails and the user sees the same broken state as today.
