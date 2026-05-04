# UX-2: Settings IA — global vs project vs user separation

## Problem
The user reported the Settings page is broken and explicitly called out: "Settings are global, vision is project level, but there are vision stuff in global settings page?" The root cause is IA pollution — `/settings/general` embeds `<VisionTab>` (a per-project surface) and `/settings/integrations` duplicates `/admin/integrations` (install-wide tool config).

## Bounded contexts
- **Install / Admin** — install_id, mode, Anthropic/Monday/GitHub credentials, hub federation, backups, health.
  Surface: `/admin/*`, `/admin/integrations` (already canonical).
- **Project** — vision, sprint policy, Monday board mapping, GitHub repo binding, per-project budget, persona roster.
  Surface: `/projects/:id/*` for first-class entities; `/settings/sprints`, `/settings/agents` use `useActiveProjectStore` and degrade to a "pick a project" hint when none selected.
- **User** — notification permissions, profile (UserMenu), sign-out.
  Surface: `UserMenu` (top bar) + `/settings/general` notifications panel.

## IA decision matrix

| Surface | Scope | Action |
|---|---|---|
| `/settings/general` Identity | install (read-only) | keep — informational |
| `/settings/general` Vision | project | **REMOVE** — pollution; replaced by a one-line link to `/vision` |
| `/settings/general` Notifications | user | keep |
| `/settings/general` Backups | admin | **REMOVE** — already at `/admin/backups`; replaced by link in Identity card |
| `/settings/integrations` dashboard | install/admin | **REPLACE** with read-only summary that defers to `/admin/integrations` |
| `/settings/integrations/anthropic` | install/admin | **REMOVE** — duplicates `/admin/integrations/anthropic` |
| `/settings/integrations/monday` | install/admin | **REMOVE** — duplicates `/admin/integrations/monday` |
| `/settings/integrations/github` | project (repo binding) | keep — this is per-project, not the install-wide GitHub App |
| `/settings/integrations/hub` | install/admin | keep for now (hub is install-wide but this is the only entry today) |
| `/settings/agents` Personas/Routing/Models/Hooks | install (read-only) | keep |
| `/settings/sprints` Ceremonies/Board/Budget | project | keep — already uses `useActiveProjectStore` |
| `/settings/team` | hub-team | keep `ComingSoonState` |
| `/settings/billing` | install | keep `ComingSoonState` |

## Event flow
None — pure UI re-shuffle. No backend procedures touched.

## IAM diff
None.

## DSQL diff
None.

## Blast radius
UI-only changes inside `packages/ui/src/pages/Settings.tsx`. The `VisionTab.tsx` component is preserved (still importable) but no longer rendered from Settings. Same for `IntegrationsDashboard` rendering inside `/settings/integrations` — the component stays (still used by `/admin/integrations`), the route just changes its content.

## Rollback strategy
Single-file UI revert: `git revert` on the `feat/ux-2-settings` PR. No data migrations. Lambda alias unchanged.

## Walk-deep contract
Must remain 20/20. Specifically:
- `/settings/general` body must NOT contain "Go to Vision" / "Blocked" / vision-document content.
- `/settings/integrations` must contain a clear summary + a link to `/admin/integrations`, no live integration cards.
- All six sub-pages (`general`, `integrations`, `agents`, `sprints`, `team`, `billing`) render content matching their label.

## Confidence
92 — implementation is mechanical. The 8-point gap is for the live deploy + walk-deep verification, which is the actual signal.
