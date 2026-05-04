/**
 * Unit tests for vault-sync/key — tenant-prefix invariants.
 *
 * [Engineer-Principal · Opus · run-obsidian-vault-sync]
 */

import { describe, it, expect } from 'vitest'
import {
  vaultS3Key,
  vaultS3Prefix,
  vaultRelativePath,
  vaultManifestKey,
  kebabify,
} from '../../../src/vault-sync/key.js'

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const TENANT_B = '22222222-2222-4222-8222-222222222222'

describe('kebabify', () => {
  it('lowercases + collapses non-alphanum', () => {
    expect(kebabify('Login Flow!')).toBe('login-flow')
  })
  it('strips leading + trailing dashes', () => {
    expect(kebabify('  --weird  __ thing-- ')).toBe('weird-thing')
  })
  it('returns "untitled" for empty input', () => {
    expect(kebabify('')).toBe('untitled')
    expect(kebabify('   ')).toBe('untitled')
    expect(kebabify('!!!')).toBe('untitled')
  })
  it('truncates long titles', () => {
    expect(kebabify('a'.repeat(200)).length).toBe(80)
  })
})

describe('vaultRelativePath', () => {
  it('places stories under projects/<slug>/stories/<basename>.md', () => {
    expect(
      vaultRelativePath({ projectSlug: 'orbital', type: 'story', basename: 'Login flow' }),
    ).toBe('projects/orbital/stories/login-flow.md')
  })
  it('uses entity-specific folders', () => {
    expect(vaultRelativePath({ projectSlug: 'p', type: 'vision', basename: 't' })).toBe(
      'projects/p/visions/t.md',
    )
    expect(vaultRelativePath({ projectSlug: 'p', type: 'epic', basename: 't' })).toBe(
      'projects/p/epics/t.md',
    )
    expect(vaultRelativePath({ projectSlug: 'p', type: 'ac', basename: 't' })).toBe(
      'projects/p/acs/t.md',
    )
    expect(vaultRelativePath({ projectSlug: 'p', type: 'retro', basename: 't' })).toBe(
      'projects/p/retros/t.md',
    )
    expect(vaultRelativePath({ projectSlug: 'p', type: 'memory', basename: 't' })).toBe(
      'projects/p/memory/t.md',
    )
  })
})

describe('vaultS3Key — tenant prefix is mandatory', () => {
  it('always begins with the tenant id', () => {
    const key = vaultS3Key({
      tenantId: TENANT_A,
      projectSlug: 'orbital',
      type: 'story',
      basename: 'login',
    })
    expect(key.startsWith(`${TENANT_A}/`)).toBe(true)
  })

  it('produces non-overlapping keys for different tenants', () => {
    const a = vaultS3Key({ tenantId: TENANT_A, projectSlug: 'orbital', type: 'story', basename: 'x' })
    const b = vaultS3Key({ tenantId: TENANT_B, projectSlug: 'orbital', type: 'story', basename: 'x' })
    expect(a).not.toBe(b)
    expect(a.startsWith(`${TENANT_A}/`)).toBe(true)
    expect(b.startsWith(`${TENANT_B}/`)).toBe(true)
  })

  it('throws on empty tenantId', () => {
    expect(() =>
      vaultS3Key({ tenantId: '', projectSlug: 'p', type: 'story', basename: 'x' }),
    ).toThrow(/tenantId/)
  })

  it('throws on malformed tenantId', () => {
    expect(() =>
      vaultS3Key({ tenantId: 'not-a-uuid', projectSlug: 'p', type: 'story', basename: 'x' }),
    ).toThrow(/UUID/)
  })

  it('rejects path traversal attempts via projectSlug or basename', () => {
    const key = vaultS3Key({
      tenantId: TENANT_A,
      projectSlug: '../etc/passwd',
      type: 'story',
      basename: '../../escape',
    })
    // kebabify strips the slashes + dots, so traversal is impossible
    expect(key).not.toContain('..')
    expect(key).not.toContain('//')
    expect(key.startsWith(`${TENANT_A}/projects/etc-passwd/`)).toBe(true)
  })
})

describe('vaultS3Prefix', () => {
  it('returns tenant-only prefix when project omitted', () => {
    expect(vaultS3Prefix({ tenantId: TENANT_A })).toBe(`${TENANT_A}/`)
  })
  it('returns tenant + project prefix when project given', () => {
    expect(vaultS3Prefix({ tenantId: TENANT_A, projectSlug: 'orbital' })).toBe(
      `${TENANT_A}/projects/orbital/`,
    )
  })
  it('throws on empty tenant', () => {
    expect(() => vaultS3Prefix({ tenantId: '' })).toThrow(/tenantId/)
  })
})

describe('vaultManifestKey', () => {
  it('places manifest at .orbital/manifest.json under the project', () => {
    expect(vaultManifestKey({ tenantId: TENANT_A, projectSlug: 'orbital' })).toBe(
      `${TENANT_A}/projects/orbital/.orbital/manifest.json`,
    )
  })
})
