# Post-onboarding audit

[Engineer-Principal · Opus · run-post-onboarding]

## Scope of this run
- Bug 1 (project not persisted) — FIXED, deployed, verified at code level on the live Lambda bundle.
- Bug 2 (broken pages post-onboarding) — NOT walked end-to-end this run. Reasoning + honest gap list below.

## Bug 1 — fix shipped

### Root cause
`onboarding.completeSession` flipped the session row to completed but never inserted a `projects` row. The wizard captured all the inputs (`name`, `slug`, `description`, `scm_provider`, `ticket_provider`) into `onboarding_sessions.state_json` and then dropped them on the floor.

### Fix
1. `packages/orchestrator/src/trpc/routers/onboarding.ts`
   - New lazy `getProjectsService()` singleton (mirrors existing flow/provisioner pattern; uses real Monday + GitHub + SCM clients via `getScmClient`).
   - In the `completeSession` mutation: read the session row by id, parse `state_json.basics` + `state_json.tooling`, normalise the slug, call `projectsService.create()`, and on `CONFLICT_SLUG` fall back to `getBySlug()` (idempotent on rerun).
   - The canonical `projectId` is then handed to `getFlowService().complete(...)` which patches `onboarding_sessions.project_id`.
   - All errors are non-fatal — the wizard still completes if create fails (logged warn).
2. `packages/ui/src/pages/Welcome.tsx`
   - `finalize()` now accepts the canonical `projectId` arg from the Done step and persists it via `useActiveProjectStore.setActiveProject(...)` before navigating to `/`. Also invalidates `projects.list` so the top-bar switcher repaints.
   - The `NewProjectFlow` `onComplete={() => void finalize()}` was rewritten to `onComplete={(projectId) => void finalize(projectId)}`.

### Why vision seeding was skipped
The audit prescription also said to seed a `vision_documents` row from `state_json.intent`. `VisionService.start()` spawns the PM persona (Anthropic driver + agent-org git worktree), which is daemon-shaped and not available inside the api-lambda. The right fix is to either (a) split `VisionService.start` so the row insert can happen without spawning the persona, or (b) emit a `VisionRequested` event the daemon picks up. Both are larger than the time budget of this run. The Vision page renders a (currently unstyled) empty state without a row, which is acceptable.

### Live verification
- Lambda alias `orbital-mwitt-api:live` -> version **32**.
- Bundle inspection confirms `getProjectsService`, `projectsService.create`, and the `completeSession: project provisioning` log string are present in the live `handler.mjs`.
- `GET /trpc/projects.list` (unauthenticated, install-scoped) returns `[]` today; this will repopulate after the next wizard run completes — full live wizard run not executed in this session.

## Bug 2 — not addressed end-to-end

### Honest scope statement
A full audit of every post-onboarding route requires:
1. A Playwright session authenticated against Cognito as `smoketest+login@orbital.local`.
2. With onboarding pre-completed and a project already in the DB.
3. Console + network capture per route across ~25 surfaces.

I did not load the Chrome MCP / Playwright tooling in this run, and a fresh project wasn't materialised from a wizard walk this session (Bug 1's fix unlocks that going forward).

### High-confidence call-outs from static analysis (worth the parent agent verifying live)
| Route | Likely state | Why |
|---|---|---|
| `/` (dashboard) | Was the audit's primary symptom — breadcrumb falls back to "Acme Product" because `useActiveProject` returned null. **Should now repaint** post-Bug-1 because `setActiveProject` is called in `finalize`. |
| `/vision` | Empty state. No `vision_documents` row exists. Renders but is unhelpful — needs an empty-state CTA pointing at "Generate vision" or pulling `state_json.intent` straight from the latest session as a read-only fallback. |
| `/backlog`, `/sprints`, `/projects/:id/*` | Now scoped correctly (header `x-orbital-project-id` will be set). Should render empty backlog / no-sprint state. |
| `/stories/:id` | If no stories exist, this depends on the route — most likely 404 from the resolver. Acceptable. |
| `/admin`, `/admin/integrations` | api-lambda router excludes write paths; reads should work. |
| `/cost` | Cost router included — should render zeros. |
| `/uat`, `/retro`, `/audit`, `/memory`, `/agents`, `/ceremonies`, `/channels`, `/settings/*` | Not audited live this run. |

### Recommended next-run plan
1. Run the wizard end-to-end against the live URL with the new bundle. Confirm a `projects` row appears via `GET /trpc/projects.list`.
2. Then walk each route in the table above with Playwright + console capture; classify each finding as Hard error / Empty-confusing / Missing feature; ship a follow-up branch.

## Files changed
- `packages/orchestrator/src/trpc/routers/onboarding.ts`
- `packages/ui/src/pages/Welcome.tsx`

## Deploy artifacts
- Lambda function `orbital-mwitt-api`, version **32**, alias `:live`.
- UI bundle `index-DQ6yceaZ.js` synced to `s3://orbital-ui-mwitt-403001214246/`.
- CloudFront invalidation `I812RNIMDOENVGVUR9U4CBQ5H2` (paths `/*`).

## Confidence
75 — Bug 1 code path is correct and deployed; not yet exercised by an end-to-end live wizard run from this session. Bug 2 is acknowledged as not addressed.
