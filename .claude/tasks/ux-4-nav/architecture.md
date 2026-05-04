# UX-4 — Header / Nav / Breadcrumb / Project-Switcher Consistency

[Engineer-Principal · Opus · run-ux-4-nav]

## Bounded contexts touched

- `packages/ui` only. No backend/tRPC schema change. No DSQL change. No IAM diff.

## Current state (ground truth from source read)

- `useActiveProjectStore` (Zustand) — already reactive. localStorage-persisted.
- `useActiveProject()` composite hook — wraps store + `projects.list` query, auto-selects first.
- `getActiveProjectId()` — synchronous snapshot reader; **only** used by tRPC header link in `services/trpc.ts` (correct — must NOT subscribe).
- All other consumers (`TopBar.LiveBurnWidget`, `Cost`, `BoardTab`, `BudgetTab`, `LocalOnlyDataPanel`, `SprintPlanSummary`, `ProjectSwitcher`) subscribe via Zustand selector → already reactive.
- `<ProjectBreadcrumb />` — pulls from reactive hook, already correct.
- `<UserMenu />` — sign-out wired to `AuthContext.signOut()` + redirect to `/login`.
- `<SideNav />` — uses `NavLink` + `aria-current="page"`. Active route highlighting works.
- `<ProjectSwitcher />` — search, archived toggle, switch, "+ New project" all wired.
- `⌘K` palette — `useCommandRegistry` exists (verified by import in TopBar).

## Drift identified

| Issue | Where | Severity |
|---|---|---|
| Breadcrumb missing | Cost, Channels, Memory, SprintBoard, Stories, ProjectBacklog, StoryDetail, Settings, AgentInspector, IntegrationsGitHub | Medium |
| Inline manual breadcrumb instead of `<ProjectBreadcrumb />` | Vision.tsx:30-41 | Low (inconsistent) |
| No URL deep-link for active project | global | Medium — task spec requires `?project=<id>` |
| `useActiveProject()` re-runs `projects.list` per-mount | Vision.tsx:31 calls hook inline inside JSX | Low (re-computes but cached by RQ) |

Auth pages (Login/Signup/Forgot/Reset/Verify), Welcome, Admin, HubAdmin are intentionally outside the project context and do NOT need breadcrumbs.

## Design decisions

### 1. URL sync for active project — `?project=<id>`

Add a small `<ActiveProjectUrlSync />` component mounted inside `<AppShell />`. Responsibilities:

- On mount + on every `activeProjectId` change → write `?project=<id>` into the URL via `useSearchParams` (replace, not push, to avoid history spam).
- On mount → if URL has `?project=<id>` AND it differs from store, call `setActiveProject(urlId)` (URL wins on deep-link).
- Validate against the loaded `projects.list` — only adopt if id is in the list (multi-tenant: prevents URL-injection of foreign project ids; tRPC `tenantContext` middleware will already reject, but we want a clean UX, not a 403).

### 2. Breadcrumb backfill

Add `<ProjectBreadcrumb /> › <Section>` header block to each missing page using the existing pattern (matches Dashboard/Backlog/Audit). Replace Vision's inline breadcrumb with the standard component.

### 3. Reactivity verification

No code change needed — already correct. Document for future maintainers (in store-level comment) that subscribing components MUST use the Zustand selector form, not `getActiveProjectId()`.

## Event flow (active-project switch)

```
User clicks project in ProjectSwitcher
  → setActiveProject(id)
    → writePersisted(id) [localStorage]
    → set({ activeProjectId: id }) [Zustand]
      → all subscribers re-render (TopBar widgets, breadcrumb, page bodies)
      → ActiveProjectUrlSync effect fires
        → URL becomes ?project=<id>
      → tRPC queries with `enabled: !!activeProjectId` re-fetch with new header
```

## Multi-tenant safety

- ProjectSwitcher list comes from `projects.list` — already scoped to JWT (server-side). Cannot leak across tenants.
- URL deep-link validates against loaded list before adopting. Foreign id is ignored.
- tRPC header injection still reads via `getActiveProjectId()` snapshot — unchanged.

## Blast radius

- 10 page files touched (breadcrumb additions only)
- 1 new tiny component (`ActiveProjectUrlSync`) mounted once in `AppShell`
- No state shape changes
- No API changes
- No tests broken (hook contract unchanged)

## Rollback

Revert `feat/ux-4-nav` branch. No data migration. No infra change. Previous `:live` Lambda alias unchanged (UI-only).

## Risk classification

- Tier: **Medium**. No stateful-resource change. No security-boundary change. UI-only, multi-tenant-aware via existing primitives.
- Confidence: **96** — code already largely correct; this is gap-filling + URL-sync addition.

## Out of scope

- ⌘K palette content audit (separate task)
- Sidebar reordering by usage (no telemetry input yet)
- Profile page (link target) — Settings already serves this
