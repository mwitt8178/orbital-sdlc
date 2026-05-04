/**
 * Unit tests for vault-sync/markdown — render/parse round trip + hash stability.
 *
 * [Engineer-Principal · Opus · run-obsidian-vault-sync]
 */

import { describe, it, expect } from 'vitest'
import { renderMarkdown, parseMarkdown, contentHash } from '../../../src/vault-sync/markdown.js'
import type { VaultEntity } from '../../../src/vault-sync/types.js'

const SAMPLE: VaultEntity = {
  type: 'story',
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333',
  title: 'Login flow',
  status: 'in_progress',
  createdAt: '2026-05-04T12:00:00Z',
  updatedAt: '2026-05-04T13:00:00Z',
  body: '# Login flow\n\nUser can sign in with email + password.',
  links: ['Auth epic', 'Password reset'],
  tags: ['auth', 'mvp'],
}

describe('renderMarkdown / parseMarkdown round trip', () => {
  it('preserves all schema fields', () => {
    const md = renderMarkdown(SAMPLE)
    const parsed = parseMarkdown(md)
    expect(parsed.frontmatter.orbital_id).toBe(SAMPLE.id)
    expect(parsed.frontmatter.tenant_id).toBe(SAMPLE.tenantId)
    expect(parsed.frontmatter.project_id).toBe(SAMPLE.projectId)
    expect(parsed.frontmatter.type).toBe('story')
    expect(parsed.frontmatter.title).toBe('Login flow')
    expect(parsed.frontmatter.status).toBe('in_progress')
    expect(parsed.frontmatter.tags).toEqual(['auth', 'mvp'])
    expect(parsed.frontmatter.links).toEqual(['Auth epic', 'Password reset'])
    expect(parsed.body).toContain('User can sign in')
  })

  it('rendered output starts with --- fence', () => {
    expect(renderMarkdown(SAMPLE).startsWith('---\n')).toBe(true)
  })

  it('throws on missing fence', () => {
    expect(() => parseMarkdown('no fence here')).toThrow(/frontmatter fence/)
  })

  it('throws on missing closing fence', () => {
    expect(() => parseMarkdown('---\norbital_id: x\n')).toThrow(/closing/)
  })

  it('throws when frontmatter fails Zod validation (missing orbital_id)', () => {
    const bad = '---\ntype: story\ntitle: x\n---\n\nbody'
    expect(() => parseMarkdown(bad)).toThrow()
  })
})

describe('contentHash', () => {
  it('produces a stable hash for the same input', () => {
    const a = contentHash(renderMarkdown(SAMPLE))
    const b = contentHash(renderMarkdown(SAMPLE))
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when body changes', () => {
    const a = contentHash(renderMarkdown(SAMPLE))
    const b = contentHash(renderMarkdown({ ...SAMPLE, body: 'different body' }))
    expect(a).not.toBe(b)
  })

  it('changes when title changes', () => {
    const a = contentHash(renderMarkdown(SAMPLE))
    const b = contentHash(renderMarkdown({ ...SAMPLE, title: 'Different title' }))
    expect(a).not.toBe(b)
  })
})
