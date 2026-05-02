/**
 * install-state.ts — onboarding-aware overlay over install.json.
 *
 * The base `loadOrCreateInstall()` (in src/config/install.ts) strictly
 * enforces schema_version=1 and we are forbidden from modifying it. Instead,
 * the onboarding wizard's per-install state lives in a SEPARATE file at
 * `~/.orbital/config/onboarding.json` (mode 0600), keyed by install_id, with
 * its own schema_version.
 *
 * Fields:
 *   - mode: 'demo' | 'live' | 'readonly' | null
 *   - setup_completed_at: ISO datetime | null
 *   - demo_replay_id: string | null
 *
 * On first read, if the overlay file is absent, we synthesize an empty
 * record. Writes are atomic (tmp-rename + chmod 0600).
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { getOrbitalHome } from '../config/env.js'
import { loadOrCreateInstall } from '../config/install.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const onboardingModeSchema = z.enum(['demo', 'live', 'readonly'])
export type OnboardingMode = z.infer<typeof onboardingModeSchema>

const overlaySchema = z.object({
  install_id: z.string().uuid(),
  schema_version: z.literal(1),
  mode: onboardingModeSchema.nullable(),
  setup_completed_at: z.string().datetime().nullable(),
  demo_replay_id: z.string().nullable(),
})

type OverlayFile = z.infer<typeof overlaySchema>

export interface NormalizedInstallState {
  installId: string
  createdAt: string
  schemaVersion: number
  mode: OnboardingMode | null
  setupCompletedAt: string | null
  demoReplayId: string | null
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function overlayPath(): string {
  return path.join(getOrbitalHome(), 'config', 'onboarding.json')
}

// ---------------------------------------------------------------------------
// Read overlay
// ---------------------------------------------------------------------------

async function readOverlay(installId: string): Promise<OverlayFile> {
  try {
    const raw = await fs.readFile(overlayPath(), 'utf-8')
    const parsed = overlaySchema.parse(JSON.parse(raw))
    // Ensure the overlay belongs to the current install. If a stale overlay
    // for a different install is present, treat it as empty (the wizard
    // should run fresh).
    if (parsed.install_id !== installId) {
      return emptyOverlay(installId)
    }
    return parsed
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      return emptyOverlay(installId)
    }
    throw err
  }
}

function emptyOverlay(installId: string): OverlayFile {
  return {
    install_id: installId,
    schema_version: 1,
    mode: null,
    setup_completed_at: null,
    demo_replay_id: null,
  }
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

async function writeOverlay(state: OverlayFile): Promise<void> {
  const dest = overlayPath()
  const dir = path.dirname(dest)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const tmp = `${dest}.tmp.${process.pid}`
  const json = JSON.stringify(state, null, 2)
  await fs.writeFile(tmp, json, { mode: 0o600 })
  await fs.rename(tmp, dest)
  await fs.chmod(dest, 0o600)
}

// ---------------------------------------------------------------------------
// Public read
// ---------------------------------------------------------------------------

export async function readInstallState(): Promise<NormalizedInstallState> {
  const base = await loadOrCreateInstall()
  const overlay = await readOverlay(base.install_id)
  return {
    installId: base.install_id,
    createdAt: base.created_at,
    schemaVersion: base.schema_version,
    mode: overlay.mode,
    setupCompletedAt: overlay.setup_completed_at,
    demoReplayId: overlay.demo_replay_id,
  }
}

// ---------------------------------------------------------------------------
// Mutators
// ---------------------------------------------------------------------------

export async function setMode(mode: OnboardingMode): Promise<NormalizedInstallState> {
  const base = await loadOrCreateInstall()
  const overlay = await readOverlay(base.install_id)
  overlay.mode = mode
  await writeOverlay(overlay)
  return {
    installId: base.install_id,
    createdAt: base.created_at,
    schemaVersion: base.schema_version,
    mode,
    setupCompletedAt: overlay.setup_completed_at,
    demoReplayId: overlay.demo_replay_id,
  }
}

export async function markSetupCompleted(): Promise<NormalizedInstallState> {
  const base = await loadOrCreateInstall()
  const overlay = await readOverlay(base.install_id)
  const completedAt = new Date().toISOString()
  overlay.setup_completed_at = completedAt
  await writeOverlay(overlay)
  return {
    installId: base.install_id,
    createdAt: base.created_at,
    schemaVersion: base.schema_version,
    mode: overlay.mode,
    setupCompletedAt: completedAt,
    demoReplayId: overlay.demo_replay_id,
  }
}

export async function setDemoReplayId(
  replayId: string | null,
): Promise<NormalizedInstallState> {
  const base = await loadOrCreateInstall()
  const overlay = await readOverlay(base.install_id)
  overlay.demo_replay_id = replayId
  await writeOverlay(overlay)
  return {
    installId: base.install_id,
    createdAt: base.created_at,
    schemaVersion: base.schema_version,
    mode: overlay.mode,
    setupCompletedAt: overlay.setup_completed_at,
    demoReplayId: replayId,
  }
}
