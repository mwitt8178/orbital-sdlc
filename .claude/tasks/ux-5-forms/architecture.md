# UX-5 — Forms / Modals / Drawers Consistency

## Bounded contexts touched
UI only. No service/lambda/DSQL changes. No IAM diff.

## New primitives
- `packages/ui/src/components/ui/FormField.tsx` — label + control + inline error/help, aria wired.
- `packages/ui/src/components/ui/ConfirmDialog.tsx` — Modal-backed confirm with optional `confirmText` (typed-confirm) or `requireAcknowledge` ("I understand" checkbox).

## Targeted fixes (8)
1. StoryDrawer — RHF + Zod, inline errors, Enter submits, save-disabled-when-clean.
2. CreateProjectModal Basics — inline error text under slug field; show "Name is required" inline; focus handling.
3. CreateEpicModal — RHF + Zod; replace ad-hoc useState validation; inline errors per field.
4. CreateSprintModal — RHF + Zod; per-field errors; Enter submits.
5. KeysPanel rotate confirm — wrap with ConfirmDialog + `requireAcknowledge` ("I understand this retires the active sub-key").
6. InstallsTable revoke — replace `window.confirm` with ConfirmDialog typed-confirm requiring the install label.
7. BackupPanel trigger backup — replace `window.confirm` with ConfirmDialog (lighter, no acknowledge needed).
8. ScheduleCeremonyModal — RHF + Zod consistency pass.

## Validation pattern
`react-hook-form` + `@hookform/resolvers/zod`, `mode: 'onBlur'` so errors render on blur not keystroke. `aria-invalid`, `aria-describedby` wired through `FormField`.

## Submit pattern
- Drawer/Modal forms: explicit Save button, `formState.isSubmitting` disables button, button label shows "Saving…".
- Server error → `setServerError` → renders inline above submit button. User input preserved (form not reset on error).

## Keyboard
- Enter inside `<form>` triggers submit (default browser behavior; ensure all dialogs wrap in `<form>`).
- Escape closes Modal/Drawer (already implemented in Modal primitive; StoryDrawer already does it).

## Destructive confirms
ConfirmDialog `variant="danger"` + `requireAcknowledge` (checkbox) OR `confirmText` (user must type a token). No raw `window.confirm`.

## Blast radius
UI bundle only. Existing Button/Input/Modal primitives unchanged. New components additive.

## Rollback
`git revert` the squash commit on `feat/ux-5-forms`. CF invalidation re-points to prior bundle.

## Risk tier
Low (UI-only, additive). No data-classification or IAM impact.
