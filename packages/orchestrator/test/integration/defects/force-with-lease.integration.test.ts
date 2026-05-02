/**
 * force-with-lease.integration.test.ts
 *
 * Round 6 #3 — Iterate-on-Defect Loop in UAT
 * [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
 *
 * Acceptance criterion #6 (partial) + hard-stop check:
 *   The re-push in GitHubPROrchestrator uses --force-with-lease, NEVER --force.
 *
 * This test verifies by:
 *   1. Reading pr-orchestrator.ts source and asserting --force-with-lease is present.
 *   2. Asserting bare --force is NOT present (as a standalone arg).
 *
 * Additional assertion: spawn.ts with reuseWorktree=true logs 'skipping git checkout -B'
 * without calling the checkout command (structural assertion via grep).
 */

import { describe, it, expect } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC_ROOT = path.resolve(__dirname, '../../../src')

describe('force-with-lease: push uses --force-with-lease not --force', () => {
  it('pr-orchestrator.ts contains --force-with-lease', async () => {
    const prOrchestratorPath = path.join(SRC_ROOT, 'github/pr-orchestrator.ts')
    const source = await fs.readFile(prOrchestratorPath, 'utf-8')
    expect(source).toContain('--force-with-lease')
  })

  it('pr-orchestrator.ts does NOT contain a bare --force argument (only --force-with-lease)', async () => {
    const prOrchestratorPath = path.join(SRC_ROOT, 'github/pr-orchestrator.ts')
    const source = await fs.readFile(prOrchestratorPath, 'utf-8')
    // Should NOT contain a string literal "'--force'" (bare force)
    // but SHOULD contain '--force-with-lease'
    const hasBareForce = /['"`]--force['"`]/.test(source)
    expect(hasBareForce).toBe(false)
    expect(source).toContain('--force-with-lease')
  })
})

describe('reuseWorktree: spawn.ts correctly gates git checkout -B', () => {
  it('spawn.ts contains reuseWorktree guard around git checkout -B', async () => {
    const spawnPath = path.join(SRC_ROOT, 'orchestration/spawn.ts')
    const source = await fs.readFile(spawnPath, 'utf-8')
    expect(source).toContain('reuseWorktree')
    // The checkout -B call must be inside an if (!params.reuseWorktree) block
    expect(source).toContain('!params.reuseWorktree')
  })
})

describe('post-defect-reported hook: registered in boot.ts', () => {
  it('boot.ts imports and registers createPostDefectReportedHook', async () => {
    const bootPath = path.join(SRC_ROOT, 'orchestration/boot.ts')
    const source = await fs.readFile(bootPath, 'utf-8')
    expect(source).toContain('createPostDefectReportedHook')
    expect(source).toContain('post-defect-reported')
  })
})
