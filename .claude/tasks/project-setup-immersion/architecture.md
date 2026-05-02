# Architecture: Immersive Project Setup with Vision Interview + Initial Epics

**Run ID:** project-setup-immersion-001
**Persona:** Engineer-Principal · Opus
**Estimate:** XL
**Risk Tier:** Medium (UI orchestration; new tRPC procedure; no DSQL or IAM changes)

## Problem

Today: project creation modal is 4 steps (Basics → Monday → Github → Review). After creation,
the user must navigate manually to /vision to start an interview, type a prompt, send messages,
and lock the doc. Then they must navigate to /backlog and manually add epics. This is
multi-step friction that breaks the flow at exactly the moment the user has the highest signal
about what they're building.

## Goal

Project creation transitions seamlessly into vision creation and initial epic capture, all
without leaving the same surface. The user goes from empty installation to "project exists,
vision locked, 3-5 epics ready" in one fluid motion.

## Bounded Contexts Touched

- **Project Setup** (UI; new) — owns the multi-stage flow shell + step coordination.
- **Vision Intake** (orchestrator) — existing; consumes the new vision.suggestEpics procedure.
- **Backlog** (orchestrator) — existing; receives epic.create calls per accepted epic.
- **Projects** (orchestrator) — existing; project creation + monday/github connect untouched.

## Aggregate Boundaries

| Aggregate | Mutations | Owner |
|---|---|---|
| Project | projects.create, projects.connectMonday, projects.connectGithub | Projects context (unchanged) |
| Vision Document | vision.start, vision.sendMessage, vision.lock | Vision context (unchanged) |
| Epic | backlog.epics.create | Backlog context (unchanged) |

The new `vision.suggestEpics` procedure is **read-only** — it computes a recommendation from
the vision content and returns it. It does NOT mutate state. Each accepted epic flows through
the existing `backlog.epics.create` mutation, preserving the existing audit + idempotency
guarantees.

## Event Flow

```
[user fills basics, monday, github, review]
        |
        v
projects.create  --> ProjectCreated event
        |
        v
projects.connectMonday  --> MondayBoardConnected event (if connected)
        |
        v
projects.connectGithub  --> GithubRepoConnected event (if connected)
        |
        v
[Stage 5: Vision Interview]
        |
        v
vision.start --> VisionSessionStarted + VisionMessageSent (auto from initial_prompt)
        |
        v
[user replies 3+ times in chat]
   PM stub responds via existing pm-stub-subscriber pipeline
        |
        v
vision.sendMessage  --> VisionMessageSent (per turn)
   PM stub writes draft after 3 messages --> VisionDrafted
        |
        v
[right pane polls vision.get every 2s — live update]
        |
        v
vision.reviewDraft  --> { confirmation_token, ready_to_lock, missing_required_fields }
        |
        v
vision.lock  --> VisionLocked
        |
        v
[Stage 6: Initial Epics]
        |
        v
vision.suggestEpics (NEW; read-only)  --> { epics: [{ title, description, story_titles }] }
        |
        v
[user accepts/edits/skips epics in card UI]
        |
        v
backlog.epics.create (per accepted epic)  --> EpicCreated
        |
        v
[navigate to /backlog]
```

## DSQL Schema Diff

**None.** The new vision.suggestEpics procedure is read-only and uses existing tables
(`vision_documents`, `vision_versions`). No new tables, columns, or indexes.

## IAM Diff

**None.** The new procedure is `publicProcedure` like the existing vision procedures. No new
capability scopes, no IAM policy changes. The existing audit_metadata envelope flows through.

## File Layout

### New files

```
packages/orchestrator/src/vision/epic-suggester.ts          (new, ~150 LOC)
packages/orchestrator/test/unit/vision/epic-suggester.test.ts  (new, ~200 LOC)
packages/ui/src/components/features/projects/VisionInterviewStep.tsx   (new, ~250 LOC)
packages/ui/src/components/features/projects/InitialEpicsStep.tsx       (new, ~280 LOC)
packages/ui/test/e2e/project-setup-immersion.spec.ts                    (new, ~180 LOC)
```

### Modified files

```
packages/orchestrator/src/trpc/routers/vision.ts        (additive: add suggestEpics procedure)
packages/ui/src/components/features/projects/CreateProjectModal.tsx
   (extend Step union to include vision-interview + initial-epics; preserve existing UX)
```

### Files NOT touched (other agents own these)

- packages/ui/src/pages/Backlog.tsx
- packages/ui/src/components/features/backlog/*
- packages/ui/src/components/layout/SideNav.tsx
- packages/ui/src/pages/Settings.tsx
- packages/ui/src/components/features/settings/VisionTab.tsx
- packages/orchestrator/src/vision/service.ts (preserve interface; add to epic-suggester.ts instead)
- packages/orchestrator/src/vision/pm-stub.ts, pm-stub-subscriber.ts

## UX Strategy: Modal Extension vs. Full-Page Route

**Choice: Extend the existing modal.** Rationale:

- The existing 4-step wizard is already implemented in `CreateProjectModal.tsx`; ripping it
  out for a full-page route doubles the change surface and risks regressions on the
  established Basics/Monday/Github flow.
- Increasing the modal width and height for the vision-interview stage gives us the
  immersion we need (the modal grows to ~max-w-5xl during stages 5/6, snapping back for
  earlier steps).
- The user's sense of "I'm in the middle of a flow, not navigating around the app" is
  preserved — the same modal frame holds them through all six stages.
- A future migration to a `/projects/new` page is non-breaking because the per-stage
  components are already pure components with explicit props.

The modal grows wider during the interview stage (max-w-5xl) and uses a 60/40 split.

## Epic Suggester Strategy: v1 Templated Heuristic

The vision content's `summary`, `title`, and `goals[].text` strings are scanned against a
keyword → epic-template mapping (~30-50 product patterns). The mapping covers common SaaS
product domains:

| Keyword (case-insensitive substring match) | Suggested epics |
|---|---|
| "billing", "subscription", "payment", "invoice" | Self-serve account, Subscription lifecycle, Invoicing & receipts |
| "auth", "login", "signup", "user", "account" | Authentication, Account management, Profile & settings |
| "dashboard", "report", "analytic", "metric", "insight" | Core dashboard, Reporting & exports, Metrics drill-down |
| "task", "project", "workflow", "kanban", "board" | Task creation, Workflow automation, Status tracking |
| "chat", "message", "comment", "thread", "conversation" | Real-time messaging, Notification preferences, Thread search |
| "file", "document", "upload", "storage", "asset" | Upload pipeline, File browser, Sharing & permissions |
| "schedule", "calendar", "appointment", "booking" | Calendar view, Scheduling rules, Reminders |
| "search", "filter", "discovery", "browse" | Search core, Filters & facets, Discovery surfaces |
| "team", "collaboration", "invite", "member", "role" | Team setup, Roles & permissions, Member invites |
| "ai", "llm", "gpt", "claude", "agent", "automat" | AI integration, Prompt UX, Output review |

Order: longest-keyword wins; max 5 epics suggested; if no keywords match, fall back to the
generic triple "Core experience / Account management / Reporting".

Each epic carries 2-4 suggested story titles to give the user an immediate feel for what
each epic contains. v1 stub does not create stories — only epics. Stories can be added in
the Backlog page later.

## Blast Radius

- **UI**: extends existing modal with two new stages. If any new code throws, the existing
  4-step path still works because the new stages are append-only.
- **Backend**: adds one read-only procedure. Existing procedures untouched.
- **Database**: zero schema change. Existing tables read-only-queried.
- **IAM/security**: unchanged.

## Rollback Strategy

- **Backend**: `vision.suggestEpics` is read-only; reverting the router file removes the
  procedure with no data impact. Templated mappings live in a single file
  (`epic-suggester.ts`) — delete and the procedure errors but no other code path breaks.
- **UI**: the new stages are gated by the user clicking "Continue" past the "Review" step.
  If a regression is found, gating the new stages off restores the old 4-step behavior:
  add a feature flag check `if (skipImmersiveSetup) onCreated(...)` after step 4 and the
  modal closes as it does today.
- **Tests**: new tests are append-only; reverting the spec files removes them with no
  side-effect on existing test runs.

## Test Plan

1. **Unit (orchestrator/epic-suggester):** keyword matching, ordering, fallback to generic,
   max-5 cap, empty-vision degenerate case. ~10 cases.
2. **Unit (UI, optional):** none added — relying on existing component tests. The new
   step components are mostly composition over the existing tRPC mutations.
3. **E2E (UI):** Playwright spec that walks the full flow:
   - Creates a new project, advances through Monday + Github (skip), reviews, enters
     vision interview, sends 3 messages, sees populated draft, clicks Continue, accepts
     suggested epics, lands on /backlog with the new project active.
   - "Skip & lock later" path: skip from interview stage, project exists, vision NOT locked.

## Hard-Rule Compliance Check

- [x] No DSQL cluster, KMS key, user pool, or S3 bucket changes — pure UI + read-only tRPC.
- [x] No DDL — uses existing tables.
- [x] No new IAM scopes — `publicProcedure` like all sibling vision procedures.
- [x] No solo decisions on stateful resources — none touched.
- [x] Cross-family review will be requested by orchestrator (UI agent family).
- [x] Audit metadata envelope used on every mutation (vision.start, vision.lock,
      backlog.epics.create).

## Confidence: 88

Rationale:
- Existing PM stub pipeline already produces the deterministic draft after 3 messages, so
  the live-update polling pattern is proven (used today in `/vision`).
- Vision lock + reviewDraft + confirmation_token flow is exercised by existing
  `VisionDocumentDisplay` component — re-using that logic in the modal is low-risk.
- Epic suggester is templated v1; logic is deterministic and unit-testable.
- The biggest risk is UI integration friction with the active-project context (the new
  project must become the active project before the vision interview starts — handled
  inline in the new modal flow).
- 88 < 95 threshold for High/Critical, which this is not (Medium tier, no stateful-resource
  changes). No human gate required by the rules; proceeding autonomously per Auto Mode.
