/**
 * Unit tests for install-state — the onboarding overlay over install.json.
 *
 * Uses ORBITAL_HOME=tmp dir to isolate per-test, so we never touch the user's
 * real ~/.orbital.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { uuidv7 } from 'uuidv7'
import { resetInstallCache } from '../../../src/config/install.js'
import { resetEnvCache } from '../../../src/config/env.js'
import {
  readInstallState,
  setMode,
  markSetupCompleted,
  setDemoReplayId,
} from '../../../src/onboarding/install-state.js'

let tmpHome: string
let originalHome: string | undefined

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-onboarding-'))
  originalHome = process.env['ORBITAL_HOME']
  process.env['ORBITAL_HOME'] = tmpHome
  resetInstallCache()
  resetEnvCache()
})

afterEach(async () => {
  if (originalHome !== undefined) {
    process.env['ORBITAL_HOME'] = originalHome
  } else {
    delete process.env['ORBITAL_HOME']
  }
  resetInstallCache()
  resetEnvCache()
  await fs.rm(tmpHome, { recursive: true, force: true })
})

describe('install-state', () => {
  it('readInstallState returns null overlay fields on a fresh install', async () => {
    const state = await readInstallState()
    expect(state.installId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(state.mode).toBeNull()
    expect(state.setupCompletedAt).toBeNull()
    expect(state.demoReplayId).toBeNull()
    expect(state.schemaVersion).toBe(1)
  })

  it('setMode persists the mode and round-trips', async () => {
    await readInstallState()
    const next = await setMode('demo')
    expect(next.mode).toBe('demo')
    const reread = await readInstallState()
    expect(reread.mode).toBe('demo')
  })

  it('markSetupCompleted writes a fresh ISO timestamp', async () => {
    await readInstallState()
    const before = Date.now()
    const next = await markSetupCompleted()
    expect(next.setupCompletedAt).not.toBeNull()
    const ts = new Date(next.setupCompletedAt!).getTime()
    expect(ts).toBeGreaterThanOrEqual(before - 1000)
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('setDemoReplayId persists and round-trips', async () => {
    await readInstallState()
    const replayId = uuidv7()
    await setDemoReplayId(replayId)
    const reread = await readInstallState()
    expect(reread.demoReplayId).toBe(replayId)
  })

  it('does NOT modify install.json — base file remains v1', async () => {
    await setMode('live')
    const baseRaw = await fs.readFile(path.join(tmpHome, 'config', 'install.json'), 'utf-8')
    const base = JSON.parse(baseRaw) as Record<string, unknown>
    expect(base['schema_version']).toBe(1)
    expect(base['mode']).toBeUndefined()
    expect(base['setup_completed_at']).toBeUndefined()
  })

  it('writes the onboarding overlay file with mode 0600', async () => {
    await setMode('live')
    const stat = await fs.stat(path.join(tmpHome, 'config', 'onboarding.json'))
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('returns null fields when overlay is for a different install_id', async () => {
    await setMode('live')
    // Tamper: rewrite the overlay with a different install_id.
    const overlayPath = path.join(tmpHome, 'config', 'onboarding.json')
    const overlay = JSON.parse(await fs.readFile(overlayPath, 'utf-8')) as Record<string, unknown>
    overlay['install_id'] = '01938265-d3a1-7000-8000-aaaaaaaaaaaa'
    await fs.writeFile(overlayPath, JSON.stringify(overlay), { mode: 0o600 })
    const state = await readInstallState()
    expect(state.mode).toBeNull()
  })
})
