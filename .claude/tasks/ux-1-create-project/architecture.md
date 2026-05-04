# UX-1 — Consolidate Create-Project Flows

[Engineer-Principal · Opus · run-ux-1-create-project]

## Problem

Three create-project surfaces exist, two of them dead/redundant:

1. **`/welcome` → NewProjectFlow.tsx** — first-run onboarding wizard. Creates a project AND configures system memory + completes onboarding session. Right tool for first-time setup. KEEP.
2. **TopBar `ProjectSwitcher` → `CreateProjectModal.tsx`** — six-stage modal (Basics → Monday → GitHub → Review → Vision → Epics) launched from "+ New project" inside the app. The Monday/GitHub credential capture is now obsolete (admin/integrations owns provider creds since the integrations split). Kept but heavily simplified.
3. **`OnboardingProjectStep.tsx`** — drop-in step for the *original* onboarding wizard, never wired into the new `NewProjectFlow`. ZERO imports outside its own file. Pure dead code. DELETE.

Additionally, `VisionInterviewStep.tsx` and `InitialEpicsStep.tsx` are only consumed by the now-bloated `CreateProjectModal`. They duplicate vision/epic flows that already exist as standalone routes (`/vision`, backlog) and shouldn't be jammed into a 6-stage modal that an already-onboarded user has to swim through to add a 2nd project. DELETE.

## Decision

**For an already-onboarded user clicking "+ New project" in the project switcher:** show a leaner 2-step "quick create" modal that:

- **Step 1 — Basics:** name + slug + description
- **Step 2 — Review + Create:** confirm; on submit, call `projects.create`, set the new project as active, close, navigate to `/` (dashboard for the new project)

Vision-locking and epic-creation become first-class destinations *after* the project exists (the user can hit `/vision` from the sidebar) — they do NOT belong in the create modal.

Re-launching `NewProjectFlow` (the onboarding wizard) for project N+1 is wrong — that flow runs configureSystem/completeSession side-effects that only make sense once per install.

## Bounded contexts touched

- `packages/ui/src/components/features/projects/` — UI only. No API change.
- No tRPC schema change. No DB migration. No IAM change.

## Aggregate boundaries

- Project (existing). `projects.create` already returns `{ projectId, name, slug }`.
- Active-project store (Zustand) — already exists, just need to call `setActiveProject(newId)` after create.

## Event flow

- `projects.create` → emits `ProjectCreated` (existing). No new events.

## IAM diff

None.

## DSQL schema diff

None. Aurora Serverless v2 — no migration needed.

## Blast radius

- ProjectSwitcher → opens new modal (visual change only).
- Onboarding wizard at `/welcome` UNCHANGED.
- Removed files: `OnboardingProjectStep.tsx` (dead), `VisionInterviewStep.tsx`, `InitialEpicsStep.tsx` (only used by the bloated modal).
- `CreateProjectModal.tsx` rewritten in-place (smaller).

## Rollback strategy

Revert the single commit on `feat/ux-1-create-project`. The Lambda has no API surface change so a UI-only rollback is sufficient.

## Confidence

92 — risk is contained to UI; the failure mode is "button does nothing" which the walk-deep harness will catch on the new-route walk.
