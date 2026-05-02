/**
 * Unit tests for skill-loader.
 *
 * Verifies:
 *   - Persona's referenced skills are copied as {slug}.md to .orbital/skills/
 *   - Aliased slugs (e.g. 'tdd-cycle' → 'tdd-workflow.md') resolve correctly
 *   - Missing skills are recorded but never throw
 *   - The bundled skills directory contains the 6 starter files
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  bundleSkillsForWorker,
  _getSkillsRootForTests,
} from '../../../src/personas/skill-loader.js'
import type { Persona } from '../../../src/personas/types.js'

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-skill-loader-'))
})

afterEach(async () => {
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

function fakePersona(slug: string, skills: Array<{ slug: string; ordering: number; required?: boolean }>): Persona {
  return {
    personaId: 'persona-' + slug,
    personaVersionId: 'pv-' + slug,
    slug,
    displayName: slug,
    origin: 'baseline',
    versionNumber: 1,
    roleBriefMd: '# role',
    definitionHash: 'h',
    defaultCapabilityProfile: {
      filesRead: [],
      filesWrite: [],
      boardRead: [],
      boardMutate: [],
      channelRead: [],
      channelPost: [],
      secrets: [],
      networkEgress: [],
      spawnSubagent: false,
      gitCommit: null,
      ceremonyRole: 'none',
    },
    modelAffinity: [],
    escalationPolicy: { maxRetries: 0, rules: [], defaultAction: 'post_blocker' },
    skills: skills.map((s) => ({ slug: s.slug, required: s.required ?? true, ordering: s.ordering })),
    metadata: { tags: [], description: 'test' },
    isArchived: false,
  }
}

describe('skill-loader — bundled starter skills exist on disk', () => {
  it('ships all 6 starter skill files', async () => {
    const root = _getSkillsRootForTests()
    const required = [
      'tdd-workflow.md',
      'monday-update-on-status-change.md',
      'commit-message-conventions.md',
      'react-tailwind-v4.md',
      'aws-dsql-constraints.md',
      'pr-template.md',
    ]
    for (const f of required) {
      const stat = await fs.stat(path.join(root, f))
      expect(stat.isFile()).toBe(true)
    }
  })
})

describe('skill-loader — bundleSkillsForWorker', () => {
  it('copies skills referenced by slug into the worktree', async () => {
    const persona = fakePersona('test', [
      { slug: 'monday-update-on-status-change', ordering: 10 },
      { slug: 'pr-template', ordering: 20 },
    ])
    const result = await bundleSkillsForWorker(persona, tmpRoot)
    expect(result.copied.sort()).toEqual([
      'monday-update-on-status-change.md',
      'pr-template.md',
    ])
    expect(result.missing).toEqual([])
    expect(result.skillsDir).toBe(path.join(tmpRoot, '.orbital', 'skills'))

    const pr = await fs.readFile(
      path.join(result.skillsDir, 'pr-template.md'),
      'utf-8',
    )
    expect(pr).toContain('PR description')
  })

  it('resolves aliased slugs (tdd-cycle -> tdd-workflow.md, copied as tdd-cycle.md)', async () => {
    const persona = fakePersona('test', [
      { slug: 'tdd-cycle', ordering: 10 },
      { slug: 'conventional-commits', ordering: 20 },
    ])
    const result = await bundleSkillsForWorker(persona, tmpRoot)
    // The file is copied with the *referenced* slug as the name so the
    // persona brief's references resolve directly.
    expect(result.copied.sort()).toEqual(['conventional-commits.md', 'tdd-cycle.md'])
    const tdd = await fs.readFile(
      path.join(result.skillsDir, 'tdd-cycle.md'),
      'utf-8',
    )
    expect(tdd).toContain('TDD Workflow')
  })

  it('records missing slugs without throwing', async () => {
    const persona = fakePersona('test', [
      { slug: 'pr-template', ordering: 10 },
      { slug: 'definitely-not-a-real-skill', ordering: 20 },
    ])
    const result = await bundleSkillsForWorker(persona, tmpRoot)
    expect(result.copied).toEqual(['pr-template.md'])
    expect(result.missing).toEqual(['definitely-not-a-real-skill'])
  })

  it('creates the skills directory even when persona has no skills', async () => {
    const persona = fakePersona('test', [])
    const result = await bundleSkillsForWorker(persona, tmpRoot)
    expect(result.copied).toEqual([])
    expect(result.missing).toEqual([])
    const stat = await fs.stat(result.skillsDir)
    expect(stat.isDirectory()).toBe(true)
  })

  it('orders the copy by skill.ordering', async () => {
    const persona = fakePersona('test', [
      { slug: 'pr-template', ordering: 30 },
      { slug: 'monday-update-on-status-change', ordering: 10 },
      { slug: 'aws-dsql-constraints', ordering: 20 },
    ])
    const result = await bundleSkillsForWorker(persona, tmpRoot)
    expect(result.copied).toEqual([
      'monday-update-on-status-change.md',
      'aws-dsql-constraints.md',
      'pr-template.md',
    ])
  })
})
