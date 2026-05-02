# Round 4 — Vision intake + Sprint Dashboard fixes

## Bounded contexts touched

- **vision (UI only)** — VisionChat, VisionDocumentDisplay, new VisionHistoryPanel,
  new OpenQuestionsPanel; shared audit-metadata helper.
- **dashboard (UI only)** — KpiCards, SprintProgressBar, new SprintControls;
  Dashboard page integration.
- **services (UI only)** — new `audit-metadata.ts` helper.

## Aggregate boundaries

- vision/* operations are read/write through tRPC against the existing
  `vision.*` and `sprint.*` routers. No new orchestrator code is required:
  `sprint.pause/resume/complete` already exist.
- Sprint state machine remains owned by `SprintService`; UI only invokes
  the existing mutations.

## Event flow (no new events; UI consumes existing ones)

- VisionLocked / VisionRevised → drive history panel refresh via
  `vision.history` query invalidation.
- SprintStarted / SprintPaused / SprintResumed / SprintCompleted →
  drive the SprintControls button affordances via `sprint.list` query
  invalidation.
- TaskStarted / TaskCompleted / VerifierPassed / VerifierFailed /
  EscalationRaised / CapabilityDenied → KpiCards aggregates client-side
  from the events store + tasks query.

## IAM diff

- None. UI uses the same publicProcedure surface.

## DSQL schema diff

- None.

## Blast radius

- UI-only changes; orchestrator is untouched.
- If audit_metadata helper has a bug, every UI mutation that uses it could
  fail. Mitigation: helper is < 30 LOC, types match the orchestrator
  `AuditMetadataInputSchema` exactly, and existing callsites with a literal
  audit_metadata still work (helper only adds a thin convenience wrapper).

## Rollback strategy

- All changes are additive UI components or thin modifications to existing
  components. Reverting individual files is safe; no migrations or contract
  changes.

## Risk

- Tier: Medium (UI surface area, no schema/IAM changes).

## Cross-agent file boundaries respected

- channels/*, ceremonies/*, uat/* (Comms agent) — untouched.
- ui/Toast.tsx, ui/CommandPalette.tsx, Settings.tsx, audit/*, retro/RollbackPanel.tsx
  (UX agent) — untouched.
- services/ws.ts and orchestrator/src/ws/* (WS agent) — untouched.
- pages/Welcome.tsx, onboarding/* (onboarding agent) — untouched. Note the
  pre-existing render-time `navigate()` in Welcome.tsx triggering the React
  warning is left for the onboarding-agent to fix; App.tsx uses `<Navigate>`
  correctly already.

## Bug fix verification plan

1. Boot orchestrator + UI in dev mode.
2. POST `/trpc/vision.start` with the new audit_metadata-bearing payload —
   expect 200, not 400.
3. Click Lock from a draft → confirm modal opens, locks succeed.
4. Click Pause/Resume/Complete from the sprint header → confirm modals
   open, mutations succeed.
