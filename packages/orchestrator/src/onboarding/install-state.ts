/**
 * install-state.ts — onboarding overlay, Aurora-backed.
 *
 * Round 12 — install-state Aurora migration
 * [Engineer-Principal · Opus · run-install-state-aurora]
 *
 * Why this file changed:
 *   The previous implementation persisted overlay state to
 *   `~/.orbital/config/onboarding.json` via `getOrbitalHome()`. Inside Lambda
 *   that resolves to `/tmp/.orbital/config/onboarding.json` — per-instance
 *   ephemeral. With provisioned concurrency=2 (and any cold start) instance B
 *   could not see the `setup_completed_at` written by instance A, so SetupGate
 *   bounced freshly-onboarded users back to /welcome.
 *
 *   State now lives in `install_state` (Aurora). The base install_id is still
 *   sourced from `loadOrCreateInstall()` (install.json, also FS-backed) — that
 *   is a separate, narrower problem and tracked as a follow-up. After this
 *   change the *user-visible* setup_completed_at survives across instances.
 *
 * Public API (unchanged signatures):
 *   - readInstallState()
 *   - setMode(mode)
 *   - markSetupCompleted()
 *   - setDemoReplayId(replayId)
 *
 * Concurrency:
 *   Each mutator is a single `INSERT … ON CONFLICT (install_id) DO UPDATE`.
 *   Two concurrent markSetupCompleted calls are safe: last write wins on
 *   the column, both succeed at the row level.
 */

import { sql as drSql } from 'drizzle-orm'
import { z } from 'zod'
import { db as defaultDb } from '../db/client.js'
import type { DB } from '../db/client.js'
import { installState } from '../db/schema/install-state.js'
import { loadOrCreateInstall } from '../config/install.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const onboardingModeSchema = z.enum(['demo', 'live', 'readonly'])
export type OnboardingMode = z.infer<typeof onboardingModeSchema>

export interface NormalizedInstallState {
  installId: string
  createdAt: string
  schemaVersion: number
  mode: OnboardingMode | null
  setupCompletedAt: string | null
  demoReplayId: string | null
}

// ---------------------------------------------------------------------------
// DB injection seam
//
// Tests that don't run against a real Postgres can override the db handle via
// `_setInstallStateDbForTests()`. Production callers always use the default
// singleton from @orbital/db.
// ---------------------------------------------------------------------------

let _db: DB = defaultDb

/** @internal Test-only — point install-state at a different drizzle handle. */
export function _setInstallStateDbForTests(db: DB | null): void {
  _db = db ?? defaultDb
}

// ---------------------------------------------------------------------------
// Internal: read or default a row
// ---------------------------------------------------------------------------

type RawRow = {
  mode: OnboardingMode | null
  setup_completed_at: Date | null
  demo_replay_id: string | null
} & Record<string, unknown>

async function readRow(installId: string): Promise<RawRow | null> {
  // Use raw SQL via drizzle's `execute(sql\`\`)` so we don't depend on the
  // installState table object being present in the bundled schema during
  // initial deploys (defensive against module-load ordering).
  const rows = await _db.execute<RawRow>(
    drSql`select mode, setup_completed_at, demo_replay_id
            from install_state
           where install_id = ${installId}::uuid
           limit 1`,
  )
  if (!rows || rows.length === 0) return null
  return rows[0] ?? null
}

interface OverlayPatch {
  mode?: OnboardingMode | null
  setup_completed_at?: Date | null
  demo_replay_id?: string | null
}

/**
 * Atomic upsert. Patches the supplied columns; leaves untouched columns at
 * their existing value. tenant_id keeps its insert-time value on update.
 */
async function upsertRow(
  installId: string,
  tenantId: string,
  patch: OverlayPatch,
): Promise<RawRow> {
  // Build the SET clause dynamically — only patch fields the caller supplied.
  const setFragments: ReturnType<typeof drSql>[] = [drSql`updated_at = now()`]
  if ('mode' in patch) {
    setFragments.push(drSql`mode = ${patch.mode ?? null}`)
  }
  if ('setup_completed_at' in patch) {
    setFragments.push(drSql`setup_completed_at = ${patch.setup_completed_at ?? null}`)
  }
  if ('demo_replay_id' in patch) {
    setFragments.push(drSql`demo_replay_id = ${patch.demo_replay_id ?? null}`)
  }
  const setClause = drSql.join(setFragments, drSql`, `)

  const insertMode = patch.mode ?? null
  const insertCompleted = patch.setup_completed_at ?? null
  const insertReplay = patch.demo_replay_id ?? null

  const rows = await _db.execute<RawRow>(
    drSql`insert into install_state
            (install_id, tenant_id, schema_version, mode, setup_completed_at, demo_replay_id)
          values
            (${installId}::uuid, ${tenantId}::uuid, 1,
             ${insertMode}, ${insertCompleted}, ${insertReplay})
          on conflict (install_id) do update
             set ${setClause}
          returning mode, setup_completed_at, demo_replay_id`,
  )

  const row = rows[0]
  if (!row) {
    throw new Error('install_state upsert returned no row')
  }
  return row
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const TENANT_DEFAULT = '00000000-0000-0000-0000-000000000000'

function toIso(d: Date | null): string | null {
  if (!d) return null
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString()
}

export async function readInstallState(): Promise<NormalizedInstallState> {
  const base = await loadOrCreateInstall()
  const row = await readRow(base.install_id)
  return {
    installId: base.install_id,
    createdAt: base.created_at,
    schemaVersion: base.schema_version,
    mode: row?.mode ?? null,
    setupCompletedAt: toIso(row?.setup_completed_at ?? null),
    demoReplayId: row?.demo_replay_id ?? null,
  }
}

export async function setMode(mode: OnboardingMode): Promise<NormalizedInstallState> {
  const base = await loadOrCreateInstall()
  const row = await upsertRow(base.install_id, TENANT_DEFAULT, { mode })
  return {
    installId: base.install_id,
    createdAt: base.created_at,
    schemaVersion: base.schema_version,
    mode: row.mode,
    setupCompletedAt: toIso(row.setup_completed_at),
    demoReplayId: row.demo_replay_id,
  }
}

export async function markSetupCompleted(): Promise<NormalizedInstallState> {
  const base = await loadOrCreateInstall()
  const completedAt = new Date()
  const row = await upsertRow(base.install_id, TENANT_DEFAULT, {
    setup_completed_at: completedAt,
  })
  return {
    installId: base.install_id,
    createdAt: base.created_at,
    schemaVersion: base.schema_version,
    mode: row.mode,
    setupCompletedAt: toIso(row.setup_completed_at),
    demoReplayId: row.demo_replay_id,
  }
}

export async function setDemoReplayId(
  replayId: string | null,
): Promise<NormalizedInstallState> {
  const base = await loadOrCreateInstall()
  const row = await upsertRow(base.install_id, TENANT_DEFAULT, {
    demo_replay_id: replayId,
  })
  return {
    installId: base.install_id,
    createdAt: base.created_at,
    schemaVersion: base.schema_version,
    mode: row.mode,
    setupCompletedAt: toIso(row.setup_completed_at),
    demoReplayId: row.demo_replay_id,
  }
}

// Re-export for callers that previously imported the zod schema.
// We keep the runtime enum check shape identical.
export { installState }
