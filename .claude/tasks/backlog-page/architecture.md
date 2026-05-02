# /backlog page — Architecture

**Persona:** Engineer-Principal · Opus
**Date:** 2026-05-01
**Risk tier:** Medium — UI-only feature, no schema/IAM/DSQL changes. Touches 17 new files plus a single additive route in App.tsx.

## Goals

Build the heart of Orbital's daily workflow: a comprehensive working surface where the user manages epics, stories, sprints, and bugs end-to-end. Layout per spec — vision summary header, two-column body (epics/stories left, sprints right), top-right "+ New" menu, slide-in story drawer.

## Bounded contexts touched

- **Backlog** (read+write via `backlog.epics.*`, `backlog.stories.*`, `backlog.groom`).
- **Sprint** (read+write via `sprint.list/get/create/start/pause/resume/complete/commit`).
- **Vision** (read-only via `vision.get` for the summary header).
- **UAT/Defects** (read-only via `uat.defects.list`; bug filing happens through the existing `backlog.stories.create` path with `defective` status — see "Bug intake" below).

No new bounded contexts. No new event schemas.

## Key architectural decisions

### 1. Data flow: react-query is source of truth, Zustand is UI state only

- Server data (epics, stories, sprints) lives in react-query cache via tRPC hooks.
- Zustand store (`store/backlog.ts`) holds **only UI state**: filter selection, currently-open drawer, drag-source story, expanded epic IDs.
- Mutations write through tRPC, then call `utils.backlog.*.invalidate()` to re-fetch. Optimistic updates use react-query `onMutate` / `onError` rollback patterns.
- WebSocket dispatch already feeds `useEventsStore` and `useSprintsStore`. Story-status changes from other tabs/agents will trigger react-query invalidation via a `useEffect` watching the events ring (additive — existing dispatchers untouched).

### 2. Vision document resolution (the active project's vision)

`vision.get` requires `vision_document_id`. There is no `vision.list` endpoint and the active-project record does not store the vision_document_id directly. **Resolution strategy:**

1. Read `useVisionStore.currentDocumentId` (set by VisionChat when the user starts/resumes a session).
2. If null, render the "Lock your vision first" CTA — blocking the rest of the page.
3. If set, query `vision.get({ vision_document_id })` to get title + lifecycle_state + current_version_number. The locked version_number is what we surface as "v1 / v2 / etc."

This avoids adding a new tRPC procedure. **Trade-off:** if the user lands on /backlog before ever visiting /vision, currentDocumentId is null and the page will request they lock a vision first. That's the correct UX given the workflow constraint ("vision before backlog"). Once the IA agent's Settings/Vision integration lands, the active project will surface its document and we can hydrate the store on app load.

### 3. Drag-and-drop vs click-to-assign

**Decision: implement click-to-assign as primary, drag-and-drop as a stretch enhancement.**

Rationale:
- A `<select>` dropdown on the story row ("Assign sprint") is keyboard-accessible by default, screen-reader friendly, and adds zero bundle weight.
- The drawer also has a "Sprint assignment" dropdown (per spec).
- Drag-and-drop with `@dnd-kit/core` (~10kb gzipped) is layered on top — story rows become drag sources, sprint cards become drop zones. If `@dnd-kit` is not yet installed, the click-to-assign path keeps the feature complete.
- Both paths call the same `sprint.commit` mutation under the hood.

If `@dnd-kit/core` isn't available in node_modules, we fall back to plain HTML5 drag events (zero deps).

### 4. Sprint commitment semantics

`sprint.commit` writes a single commitment row per sprint with the entire selected_story_ids array. Adding a single story to a sprint requires a read-modify-write of the existing commitment (or creating one if none exists). The wrapper `assignStoryToSprint(storyId, sprintId)` in our store/service helper:
1. Reads `sprint.get(sprintId)` to find the existing commitment + capacity.
2. Calls `sprint.commit` with the merged story list and updated `capacity_used_points`.
3. On error, rolls back the optimistic UI update.

**Note on `is_partial`:** when the user adds stories incrementally (rather than via planning ceremony), we set `is_partial: true` so the orchestrator does not treat the commitment as ceremony-complete.

### 5. Bug filing path

The "Report Bug" modal creates a story in `defective` state with a fresh defect_id. **Mechanism:**
1. We need an active epic to attach the bug to. UI prompts the user to pick a target epic (preferred) or creates a "Bugs" catch-all epic on first use (idempotent — checked by epic title prefix).
2. Call `backlog.stories.create` with: title (short), description (combined observed + expected behavior), one AC ("Bug should not reproduce after fix"), `defect_id: crypto.randomUUID()`, `persona_of_record: 'qa'`, and the epic_id.
3. The created story is in `backlog` state by default. Per spec it should be `defective` — but the state machine only allows `defective` from `done`. **Resolution:** create in `backlog`, then immediately call `backlog.stories.update` with `status: 'defective'`. That fails the state-machine check (`backlog → defective` is not allowed). **Final decision:** leave the bug in `backlog` state with a "bug" pulse-dot tag in the UI; the schema's defect_id column is what marks it as a bug. This matches the existing UAT defect-creation path (which routes through `done → defective`). We document this in the modal copy so the user understands.

### 6. State machine awareness in the drawer

The drawer's status dropdown only shows valid next states for the current state, computed via `getValidNextStatuses(current)` which mirrors the server-side `STORY_TRANSITIONS` map. We hardcode the transition map in a UI-side helper (`utils/story-state-machine.ts`) so the drawer is responsive without a server round-trip.

## Aggregate boundaries

- Each `EpicAccordion` instance owns the open/closed state of one epic group.
- `StoryDrawer` is mounted at the page root with `storyId` derived from the Zustand store; reading from the store keeps the drawer decoupled from any specific row component (single source of truth).
- `SprintPanel` reads from `useSprintsStore` (already populated by WebSocket dispatch + initial `sprint.list` query).

## Event flow

- Mutations: UI → trpc client → orchestrator route → BacklogService/SprintService → EventStore + DB → response.
- Reads: tRPC queries with `staleTime: 30_000` (matches Dashboard).
- Live updates: WebSocket → `useEventsStore.appendEvent` → custom `useBacklogLiveSync` hook on /backlog watches the event ring for `StoryStatusChanged` / `StoryCreated` / `EpicCreated` / `SprintStarted` / etc. and calls `utils.backlog.*.invalidate()`. This is a thin shim — it does not duplicate state in Zustand.

## IAM diff

None. All procedures already exist as `publicProcedure` and run in single-tenant local mode.

## DSQL schema diff

None. No migrations.

## Blast radius

- New page at /backlog. Existing routes untouched.
- App.tsx receives a single additive `<Route>`. Coordinated minimal-change merge-strategy with IA agent (they touch the same file). My change is a single line add inside the Routes block.
- 17 new component/store/test files in `packages/ui/src/components/features/backlog/`, `pages/Backlog.tsx`, `store/backlog.ts`, plus tests.
- Zero changes to orchestrator code.

## Rollback strategy

- Revert: delete `packages/ui/src/components/features/backlog/`, `pages/Backlog.tsx`, `store/backlog.ts`, `test/e2e/backlog.spec.ts`, and remove the route line in App.tsx. No DB/migration revert needed.
- Feature gate: not gated — the page renders empty states gracefully if the user has no vision/epics/stories/sprints.

## TDD strategy

Two-tier:
1. **Unit tests** (Vitest):
   - `store/backlog.test.ts` — Zustand store: filter mutations, drawer open/close, drag-source state.
   - `utils/story-state-machine.test.ts` — `getValidNextStatuses` round-trip with the server map.
2. **Integration / E2E** (Playwright):
   - `test/e2e/backlog.spec.ts` — page renders, filter UI present, "+ New" menu opens, modal forms submit, drawer opens on row click. Runs against a live UI but tolerates a dead orchestrator (mirrors dashboard.spec.ts approach).

## Confidence

`confidence: 92` — high but not 95. Justification:
- Core flow well-understood; existing patterns (Modal, Toast, useMutationWithToast, audit-metadata) are in place.
- Slight uncertainty on bug-filing path (state-machine constraint forces `backlog`-state instead of `defective` — see §5). Documented in the modal copy.
- Drag-and-drop strategy hedged: ship click-to-assign first, layer DnD on top if `@dnd-kit/core` is available.
- IA-agent App.tsx merge is the riskiest mechanical change but limited to one line.

This is a Medium-risk feature, not High/Critical, so the 95 threshold doesn't apply.
