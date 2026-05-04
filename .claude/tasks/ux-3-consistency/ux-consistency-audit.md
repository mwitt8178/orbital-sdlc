# UX Consistency Audit — UX-3

**Agent:** Engineer-Principal · Opus · run-ux-3-consistency
**Branch:** `feat/ux-3-consistency`
**Base:** `origin/consolidated/main-2026-05-04` @ `26f2374`
**Date:** 2026-05-03

## Scope

Terminology, visual consistency, button styles, spacing, copy, dead affordances, unintuitive flows
across the entire app. Excludes areas owned by parallel agents UX-1 (create-project), UX-2
(/settings/*), UX-4 (TopBar/AppShell), UX-5 (forms/modals/drawers), UX-6 (empty/loading states).

## Severity counts

| Severity | Count |
|---|---|
| Blocker | 2 |
| High | 8 |
| Medium | 9 |
| Low | 6 |
| **Total** | **25** |

---

## Blockers (must-fix this run)

### B1 — `/stories` and `/stories/:id` routes are missing
`StoryDetail.tsx` calls `navigate('/stories')` and `<Link to="/stories">` 5 times, but `App.tsx`
registers neither `/stories` nor any `/stories/:id` path. The page exists (`pages/Stories.tsx`,
`pages/StoryDetail.tsx`), is fully implemented, but is unreachable from the running app.
Anyone who lands on a deep link 404s, and the back-link dead-ends. **Highest-impact dead
affordance in the codebase.**

### B2 — Duplicate `vision/vision/` directory (dead code)
`packages/ui/src/components/features/vision/vision/` mirrors its parent and contains 6 stale
copies of `VisionChat.tsx`, `VisionDocumentDisplay.tsx`, `OpenQuestionsPanel.tsx`,
`PlanningPanel.tsx`, `VisionHistoryPanel.tsx`, `PMThinkingIndicator.tsx`. None are imported
anywhere. They drift from the live copies (a future "fix in vision/" will leave the dupes stale
and the next person debugging will follow the wrong file). Delete.

---

## High

### H1 — User-facing copy oscillates between "ticket" and "story"
Data layer is canonically **Story** (`stories.create` RPC, `StoryRow`, `story-state-machine`,
`StoryDrawer`). User-facing copy mixes:
- `Glossary.tsx`: "tickets the orchestrator executes"
- `TourButton.tsx`: "All in-flight tickets"
- `NLTicketCreator.tsx`: aria-label "Add a ticket from natural language"
- `FirstSprintStep.tsx`: "draft a 4–6 ticket sprint"
- `Channels.tsx`: "auto-created per sprint and per ticket"
- `ConnectToolsStep.tsx` / `ModeStep.tsx`: "$0.20 per ticket"

Resolution: keep `TicketProvider` type (vendor noun for Monday/internal), rename user-facing
copy to **Story** consistently. Update glossary + tour to use Story.

### H2 — Page H1 typography drift
`text-2xl font-bold` is the dominant pattern, but:
- `Stories.tsx`: `font-semibold tracking-tight` (semibold, not bold)
- `Settings.tsx`: `text-display-lg` (correct token, but lonely — no other page uses it)

Resolution: Stories → align to `text-2xl font-bold`. Leave Settings as the canonical token form
for UX-2 to consider.

### H3 — Page H1 capitalization drift
- Title Case: "Cost Governance", "User Acceptance Testing", "Project Memory",
  "Sprint Dashboard", "Audit Log", "Tool integrations" (mixed!)
- Sentence case: "Review queue", "Operations console"

Resolution: pick **Title Case** (matches sidebar nav labels which are all Title Case). Fix:
"Review queue" → "Review Queue", "Operations console" → "Operations Console",
"Tool integrations" → "Tool Integrations".

### H4 — `max-w` page-shell drift
Dominant: `mx-auto max-w-[1400px] px-8 py-6` (8 pages). Outliers:
- Backlog / ProjectBacklog / SprintBoard → `max-w-[1600px]` — **kept** (board surfaces need
  more grid space; documented).
- `admin/Integrations.tsx` → `max-w-[1200px] px-6 py-8` — **fix** to 1400 / px-8 / py-6.
- `Admin.tsx` / `HubAdmin.tsx` headers use `py-5`, mains use `py-6` — **fix** to py-6 throughout.

### H5 — Status / state colour drift
Same semantic uses different palette:
- "success/done" → both `bg-emerald-*` (5x) and `bg-green-*` (multiple).
- "in-review" → both `bg-violet-*` and `bg-purple-*`.
- "blocked/warn" → both `bg-amber-*` and `bg-yellow-*`.

Theme already exports `--color-state-done`, `--color-state-review`, `--color-state-blocked`,
`--color-state-pending`, `--color-state-working`. Adoption is near-zero outside of one or two
files.

Resolution: standardize raw Tailwind on `emerald` (success), `violet` (review),
`amber` (blocked/warn), `rose` (danger/defect), `slate` (neutral). Replace `green`/`purple`/
`yellow` instances. Full migration to `state-*` tokens is a follow-up (annotated low).

### H6 — Action verb drift on confirms
"Confirm lock" / "Confirm mapping" / "Discard" / "Cancel" / "Close" used inconsistently inside
modals. Cancel = always "Cancel" (good — already 13 of them). But the closing of read-only
overlays uses both "Cancel" and "Close". Resolution: "Cancel" for any overlay that has unsaved
input; "Close" for read-only / informational overlays.

### H7 — Side-nav order vs. visual hierarchy
Side-nav: Dashboard, Agents, Backlog, Channels, UAT, Ceremonies, Retro, Vision, Audit, Memory,
Cost, Settings.
**Vision** comes after **Retro** — but Vision is the *first* thing a project does, before any
sprint exists. This is the literal opposite of the user's mental flow.

Resolution: re-order to: Dashboard → Vision → Backlog → Agents → Channels → Ceremonies →
UAT → Retro → Memory → Audit → Cost → Settings. (UX-4 owns the side-nav component itself; this
is a content-order change which is in our scope per the instructions: "where things aren't
intuitive". Coordinated by leaving the structural component alone and only re-ordering item
declarations.)

### H8 — "+ New entry" / "+ New" / "+ New project" / "+ New sprint" — leading-plus drift
Some primary CTAs lead with `+`, others don't. Convention should be: leading `+` only for
"create a new $resource" buttons in list views. Fixed: align "Create epic", "Create sprint" to
match.

---

## Medium

### M1 — `Stories` page has no nav entry
Even after B1 routes it, the Stories page has no link in SideNav. Add a "Review" entry.

### M2 — Raw `<button>` outnumber the `<Button>` primitive 88:63
~25 raw buttons could be migrated to the primitive. Many are intentional (filter chips,
icon-only toolbar buttons) and don't need migration. Fix the obvious primary/secondary CTAs only.

### M3 — Channels page deep h1 has `sr-only`
That's deliberate (the channel header replaces the page title visually) but is inconsistent
with every other page surfacing a real h1 in the layout. Document the exception.

### M4 — `SprintBoard.tsx` has two different `Sprint Dashboard` h1s in different branches
Lines 151 and 167 both render `<h1>Sprint Dashboard</h1>` in different render paths, plus a
third at 154 renders the active sprint name as h1. The active sprint name should be the only h1
when a sprint is selected; the other two are loading/error fallbacks and should be `Sprint`
or `Loading sprint…` (UX-6 also touches loading states; keep changes minimal).

### M5 — Project breadcrumb (`Project › X`) is on Memory only
Memory page header includes a `Project › Memory` mini-breadcrumb. No other project-scoped page
does. Either add to all or remove (we remove — UX-4 owns true breadcrumbs).

### M6 — `IntegrationsGitHub.tsx` page-shell width
Same as H4 — page is `max-w-[1200px] px-6 py-8`. Align to standard.

### M7 — Toast / Snackbar / inline-error drift
Some success/failure feedback uses `Toast`, some inline `<div className="bg-red-50 ...">`, some
nothing. Inventory: `Toast` import in 3 files, inline red banner in 11. Triage: the inline form
is fine for inline-validation context (UX-5 territory), but mutation success/failure should use
Toast. Logging only — UX-5 will fix.

### M8 — `Welcome.tsx` is in route table but has no link from inside the app
Once the user dismisses Welcome they can never reach it again (only via the SetupGate redirect).
Acceptable; documented.

### M9 — Filter chip pattern reimplemented per-page
Memory, Backlog, Stories, Audit each declare their own `FilterChip` component locally. Same
visual, different files. Candidate for `components/ui/FilterChip.tsx`. Not done in this PR
(scope creep — UX-3 promises consistency, not refactor).

---

## Low (documented, not fixed)

- L1 Sentence-final ellipsis drift (`…` vs `...`). 4 occurrences of `...`; the rest use `…`.
- L2 Inconsistent `aria-label` sentence case ("Lock vision document" vs "create a new vision document").
- L3 `clsx({...})` vs ternary string drift inside Button-like components.
- L4 `text-slate-500` vs `text-gray-500` — only 2 `gray` references remain.
- L5 Raw `console.log` calls in 3 components (UX-3 doesn't enforce logging policy; flagged).
- L6 Mixed singular/plural in section headings ("Memory entries" vs "Sprints" vs "Memory").

---

## Plan

1. Delete `components/features/vision/vision/` (B2).
2. Wire `/stories` and `/stories/:id` routes; add SideNav "Review" link (B1, M1).
3. Re-order SideNav declarations (H7).
4. Replace user-facing "ticket(s)" with "story/stories" in copy only — keep `TicketProvider`
   type and per-ticket cost copy where literal vendor pricing is meant (H1).
5. Normalize page H1 to `text-2xl font-bold text-slate-900` (H2) and Title Case (H3).
6. Fix `admin/Integrations.tsx` and `IntegrationsGitHub.tsx` shell widths (H4, M6).
7. Replace `green-*`, `purple-*`, `yellow-*` status uses with `emerald`, `violet`, `amber` (H5).
8. Build, deploy, walk, push.

## Out of scope (other agents)

| Agent | Owns | We do not touch |
|---|---|---|
| UX-1 | Create-project flow | `OnboardingProjectStep`, `CreateProjectModal`, `NewProjectFlow` |
| UX-2 | Settings IA | `pages/Settings.tsx`, `components/features/settings/*` |
| UX-4 | Header / nav / breadcrumbs | `TopBar`, `AppShell`, `SideNav` *structure* (we may re-order data declared inside it but not the rendering shell) |
| UX-5 | Forms / modals / drawers | Validation + save-state patterns; we leave Modal/StoryDrawer logic alone |
| UX-6 | Empty / loading states | `EmptyState`, `Skeleton`, all loading branches |
