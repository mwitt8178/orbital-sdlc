# Architecture — Round 3 Pivot: CLI to Web Admin UI

**Author:** Engineer-Principal
**Risk tier:** High (architectural pivot, surface-area expansion, security-sensitive endpoints)
**Estimate:** XL
**Status:** Implementation in progress

## Goal

Transition Orbital's primary operator surface from `orbital <cmd>` shell binary to:
1. Standard `npm run <script>` for fresh-install + emergency restore + reset.
2. A capability-gated `/admin` web UI for everything else (health, workers, keys, backups, verify, reset).

The CLI binary is no longer advertised. The `cli/*` source files remain (unowned by this task) so existing flows that import from them continue to work; we just stop registering `bin: { orbital }` in `packages/orchestrator/package.json`.

## Bounded contexts touched

| Context | Modification |
|---|---|
| `cli` | Read-only — we import `runInit`, `runReset`, `runRestore`, `runKeysRotate`, `runVerify`, etc. from existing modules. We do NOT modify CLI source. |
| `trpc/routers` | Add `admin` router (sibling to `onboarding`, `audit`, etc.), additive merge into `appRouter`. |
| `admin` (NEW) | New folder `packages/orchestrator/src/admin/` with auth middleware + types. |
| `audit-export` | Read-only — call `ExportGenerator` from admin.backup.export. |
| `capabilities` | Read-only — query `signing_keys` + `key_history` tables; call `KeyManager.rotate()`. |
| `db.agent_workers` | Read-only — query for workers list; PID for kill. |
| `metrics` | Read-only — fetch `/metrics` Prometheus endpoint internally and parse. |
| Frontend `pages/` | Add `Admin.tsx` page + nested feature components under `components/features/admin/`. |
| Root scripts | New `scripts/setup.mjs`, `scripts/restore.mjs`, `scripts/reset.mjs`. |

## Aggregate boundaries

**Admin operations** are NOT a new aggregate; they orchestrate side-effects across existing aggregates (workers, signing_keys, audit_exports, install). Each admin action emits an audit event of type `Admin*` with actor `{ type: 'human', source: 'admin_ui', ... }` so attestation is preserved.

## Event flow

New event types emitted via `EventStore.append`:
- `AdminWorkerKilled` — payload `{ worker_id, pid, terminated_at, reason }` — emitted before SIGTERM.
- `AdminKeyRotationRequested` — payload `{ sprint_id, requested_at }` — emitted before calling `KeyManager.rotate()`. The downstream `KeyRotated` event remains as-is.
- `AdminBackupRequested` — payload `{ requested_at, range_start, range_end }` — emitted before `ExportGenerator.generate()`. Downstream `AuditExportStarted/Completed` remain as-is.
- `AdminResetRequested` — payload `{ confirmation_phrase_hash, requested_at }` — emitted before reset; reset wipes the events table so this row exists only briefly.

`KeyRotated`, `AuditExportStarted/Completed`, `WorkerSpawned`, etc. remain unchanged — admin actions piggy-back on existing event chains.

## IAM diff

V1 simplification (per task spec): admin endpoints are gated by an `x-orbital-admin-token` header validated against:
1. Keychain entry `admin.api_token` (preferred; rotatable via the same admin UI in v2)
2. Env var `ADMIN_TOKEN` (fallback for dev / first-boot)
3. Open dev mode: when `NODE_ENV=development` AND neither keychain entry nor env var are set, the admin endpoints are open. Logged loudly at startup.

This is NOT the full capability-bundle gate (which is for agent worker traffic). User sessions don't currently carry capability bundles in this codebase, so we emulate the gate at the tRPC middleware layer. Documenting this clearly in `admin/auth.ts`.

## DSQL schema diff

None. We query existing tables (`signing_keys`, `key_history`, `agent_workers`, `evidence_packages`, `audit_exports`). No new tables, no migrations.

## Blast radius

- **Worker kill** — sends SIGTERM to a single PID. Worker self-recovery is the expected path; no orchestrator-wide impact.
- **Key rotation** — already exercised by the existing `orbital keys rotate` CLI; no new code path beyond the tRPC wrapper.
- **Backup export** — read-only on the DB (pg_dump), writes a new tarball file. No data mutation.
- **Reset** — most destructive. Mutation path is unchanged from existing `runReset`; we wrap with confirmation gate identical to the CLI's `--yes-i-understand`.

The `npm run reset` script uses env var `RESET_PHRASE = "I understand"` rather than a CLI flag. Anyone with shell access already has full DB access, so this gate is a guardrail not a security control.

## Rollback strategy

The `cli/*` folder is intentionally untouched. If the admin UI proves problematic:
1. Revert `packages/orchestrator/package.json` to re-add `bin: { orbital }`.
2. Revert `package.json` (root) script changes.
3. Delete the new `scripts/`, `admin/`, frontend `admin/` folders, and `admin.ts` router.
4. Existing `orbital init`, `orbital up`, etc. invocations still work because the source files remain.

## Test coverage

- Unit tests for admin auth middleware (token-present, token-mismatch, dev-mode).
- Integration test for the admin tRPC router against real Postgres (verify procedure, health, workers list, key rotate, backup export). Reset is exercised by the existing reset integration test; we add one that calls reset via the router.
- E2E Playwright spec for `/admin` UI — verifies all six tabs render and call real procedures.

## Confidence

confidence: 96 — All four aggregates are well-mapped; existing CLI implementations are reusable; no schema changes; new event types are additive. Risk concentrated in the reset endpoint and the open-dev-mode default which is documented explicitly.
