# Phase D — Internal Ticket Surface as First-Class

## Bounded contexts touched
- **backlog** (read+write): epics, stories, sprints, story_acceptance_criteria
- **projects** (read): ticket_provider toggle drives conditional rendering
- **comms/channels** (read+write): channel_posts story-tagged for comments
- **orchestration** (read): tasks for showing PR/attempt summary on story cards

## Aggregate boundaries
- Story aggregate already enforced via `BacklogService.updateStory` / `createStory` (single tx + OCC-friendly via Aurora; we use serializable retry already wired in service layer).
- Epics aggregate: `backlogService.createEpic` exists.
- Sprint board column transitions: `backlog.stories.update` mutation taking `{ story_id, status }` already supports backlog→ready→in_progress→in_review→done per `STORY_TRANSITIONS`.

## Event flow
No new events. Reuse:
- `StoryCreated`, `StoryStatusChanged` (backlog.service emits these).
- `EpicCreated` for inline epic creation.
WS subscription already invalidates queries via `useBacklogLiveSync` (already in Backlog.tsx).

## IAM diff
None. Same Lambda role; same DSQL/Aurora access. UI is anon-in-CloudFront/SigV4-out (already wired).

## DSQL/Aurora schema diff
**No migration required.** All columns exist:
- `epics(epic_id, project_id, title, rationale, status, priority, ...)`
- `stories(story_id, project_id, epic_id, title, description, status, story_points, priority, persona_of_record, redirect_note, ...)`
- `story_acceptance_criteria(criterion_id, story_id, text, verifier_hint, ...)`
- `sprints(sprint_id, project_id, status, ...)`
- `tasks` (for board cards' attempt+PR badge)
- `projects.ticket_provider` already in migration 0042.

## Blast radius
- **UI-only addition**: net new pages `/projects/:projectId/backlog` and `/projects/:projectId/sprints/:sprintId/board`.
- Existing `/backlog` page unchanged (still works against the active project).
- Existing Monday-backed flow untouched.
- New tRPC procs are *additive*: `backlog.stories.delete`, `backlog.stories.bulkTransition`, `backlog.epics.list({project_id})`, `backlog.epics.update` (nullable patch). All tenant-scoped.
- DnD library `@dnd-kit/core` added (≈ 25kB gz) — leaf import only on board page.

## Rollback strategy
- Lambda: alias :live currently v21 → updateAlias FunctionVersion=21 reverts.
- UI: previous bundle hash `index-DxVuSZpF.js` retained in S3 until next sync; revert via re-uploading prior `index.html` (kept locally as `index.prev.html` before sync) + CF invalidation.
- DB: zero schema changes → no rollback needed.

## Confidence: 70
Existing infrastructure (services, schema, mutations, WS sync) covers ~70% of the work. The remaining 30% is UI composition + two new mutations (`delete`, `bulkTransition`) + one new query (`epics.list({projectId})`). Lower than 95 only because the "promote to first-class" includes per-project routing (`/projects/:projectId/...`) which requires a project-context provider that doesn't currently exist as a route param shape — extending PROJECT_ID lookup from "active project from install config" to URL param. Risk Tier = Medium (no stateful-resource changes, no auth boundary changes).

Per orchestrator rules — **MEDIUM** risk + **L** estimate (not XL); this work is acceptable for Engineer-Sr but I'm executing because the user invoked Engineer-Principal directly and the auto-mode mandate is "act, don't ask."
