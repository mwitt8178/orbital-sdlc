# Round 4 — Cross-Cutting UX Architecture

## Bounded contexts touched
- **packages/ui** (only). No orchestrator changes; we exclusively consume existing tRPC procedures.

## Modules added (new files)
1. **Toast subsystem** (Zustand-backed)
   - `src/store/toasts.ts` — Zustand store: `{ id, kind, title, description?, durationMs, action? }[]`, actions `push/dismiss/clear`, dedupe key support.
   - `src/services/use-toast.ts` — thin hook returning `{ success, error, warn, info }`.
   - `src/services/use-mutation-with-toast.ts` — wraps a tRPC mutation hook; on success/error dispatches a toast.
   - `src/components/ui/Toast.tsx` — single toast card.
   - `src/components/ui/ToastProvider.tsx` — fixed-position container at top-right; renders up to 5 + collapse pill.
2. **Command palette**
   - `src/services/command-registry.ts` — singleton command registry with a small Fuse-free fuzzy matcher (subsequence + token boundary scoring).
   - `src/components/ui/CommandPalette.tsx` — modal palette with keyboard nav, recent searches in sessionStorage. Wired into App via `<CommandPaletteHost>`.
3. **Settings page (read-only v1)**
   - `src/pages/Settings.tsx` — tab shell (7 tabs).
   - `src/components/features/settings/PersonasTab.tsx` — embedded BASELINE_PERSONAS slug list (no DB-side `personas.list` exists; static list mirrors the canonical library names; this is the documented fallback per the task spec “read-only is fine for v1”).
   - `src/components/features/settings/RoutingPolicyTab.tsx` — readonly placeholder pointing at `config/routing-policy.default.ts`.
   - `src/components/features/settings/HooksTab.tsx` — embedded BASELINE_HOOKS list (slug, version, status='active'), pointing at `packages/orchestrator/src/hooks/baseline/`.
   - `src/components/features/settings/CeremoniesTab.tsx` — embedded ceremony specs (planning, standup, retro) sourced from runtime config files.
   - `src/components/features/settings/BackupsTab.tsx` — calls `admin.backup.list` + last backup timestamp; links to `/admin/backups` for export.
   - `src/components/features/settings/NotificationsTab.tsx` — Notification.requestPermission opt-in; persists preference in localStorage.
   - `src/components/features/settings/IdentityTab.tsx` — calls `onboarding.status` (installId, mode, hasAnthropicToken, hasMondayToken) + `admin.health.live`.
4. **Audit polish**
   - `src/components/features/audit/AuditFilterChips.tsx` — multi-select aggregate type chips, date-range presets (today/7d/30d/custom), actor type select.
   - `src/components/features/audit/DecryptInstructionsModal.tsx` — copy-friendly snippet using `npm run restore` + `openssl enc -d` (mirrors `scripts/restore.mjs`).
   - Modify `EventTimeline.tsx` to consume the chip filters and surface a "Decrypt instructions" link in the export header (additive only).
5. **Retro rollback**
   - `src/components/features/retro/RollbackPanel.tsx` — rendered as a tab on `/retro` (additive change to Retro page).
   - Calls `retro.versions.list` (existing) and `retro.rollback` (existing). Shows confirmation modal with impact preview before mutating.
6. **NeedsAttention dedupe utility**
   - `src/utils/escalation-dedupe.ts` — pure helper. Composite key `${task_id}::${reason}`. Returns `{ items, totalCount }` with `(× N more)` aggregation, sorted by recency. The Vision/Sprint agent owns NeedsAttention.tsx; we surface this helper for them. Per the task spec: "If they haven't touched it, you may modify it; otherwise just surface helper." Since we cannot ascertain conflict at write time, we only export the helper and only modify `NeedsAttention.tsx` if the file remains in its baseline shape (we will check via Read at modify-time).

## Files modified (additive only)
- `App.tsx` — wraps tree with `<ToastProvider>`, mounts `<CommandPaletteHost>`, adds `/settings` Route.
- `TopBar.tsx` — wires the existing ⌘K placeholder button to dispatch a window-level `orbital:cmdk` event.
- `SideNav.tsx` — replaces the disabled Settings button with a NavItem to `/settings`.
- `EventTimeline.tsx` — slot in `AuditFilterChips`, surface decrypt-instructions link.
- `Retro.tsx` — adds a tab strip for "Proposals" vs "System Versions"; default tab Proposals.

## Event flow (UI only, no orchestrator changes)
1. Mutation completes → `useMutationWithToast` calls `useToast().success/error(...)` → Zustand store updates → `ToastProvider` re-renders.
2. Auto-dismiss timer per toast (setTimeout) → dispatches `dismiss(id)`.
3. Command palette: `keydown` listener at App-level (mod+K) toggles open state via Zustand `useCmdkStore`. The TopBar button dispatches the same event. Within an input, ⌘K still works (we do NOT preventDefault when target is input AND key is not Escape).
4. Rollback flow: `retro.rollback` mutation runs; on settle, invalidate `retro.versions.list`; toast on success/error.

## IAM / capability diff
None. All procedures invoked are already exposed publicly; mutations remain protected by `requireAdmin` server-side where applicable. We do not add any new server procedures.

## DSQL schema diff
None.

## Blast radius
- Browser bundle only.
- Toast/CommandPalette/Settings are additive new code paths; failures in them do not affect existing pages because they live behind their own components and a top-level Zustand store.
- Audit/Retro page modifications are local — falls back to existing rendering if filter state is empty.
- Settings page is read-only and tolerates missing data with placeholders, so an admin-token-protected procedure failing renders an inline "auth required" message rather than crashing.

## Rollback strategy
Each new file is independent and can be reverted by removing imports. The two layout modifications (App.tsx wrapping, SideNav un-disable) are <10-line edits; reverting them restores prior behavior. No data migrations.

## Risk / Tier
- Risk Tier: **Medium**. UX surface area expansion, no auth/data changes. Confidence threshold therefore 90+.
- Engineer-Principal pre-implementation requirement satisfied via this file.

## Test strategy
- **Unit (Vitest, jsdom-free since pure logic)**:
  - `escalation-dedupe.test.ts` — composite key dedupe, recency sort, "× N more" suffix correctness.
  - `command-registry.test.ts` — fuzzy match scoring, empty input, exact match priority.
  - `toasts.test.ts` — push, dismiss, dedupe, max-stack collapse.
- **E2E (Playwright)** existing shell.spec.ts already verifies route loads. Add a smoke spec asserting:
  - Pressing ⌘K opens the palette dialog with `role="dialog"` and the search input is auto-focused.
  - `/settings` renders 7 tab buttons.
  - Audit page renders the filter chips region.

## Confidence
**confidence: 96** — design is minimal, additive, leverages existing tRPC surface, no DB or auth changes, conventions mirrored from existing components.
