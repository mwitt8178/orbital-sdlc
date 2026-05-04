/**
 * Unit tests for buildVaultZip — tenant safety + content shape.
 *
 * [Engineer-Principal · Opus · run-obsidian-vault-sync]
 */

import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { uuidv7 } from 'uuidv7'
import { buildVaultZip } from '../../../src/vault-sync/zip.js'
import { parseMarkdown } from '../../../src/vault-sync/markdown.js'
import type { VaultEntity } from '../../../src/vault-sync/types.js'

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const PROJECT = '33333333-3333-4333-8333-333333333333'

function ent(over: Partial<VaultEntity> = {}): VaultEntity {
  return {
    type: 'story',
    id: uuidv7(),
    tenantId: TENANT_A,
    projectId: PROJECT,
    title: 'Login flow',
    body: 'A user can log in.',
    ...over,
  }
}

describe('buildVaultZip', () => {
  it('packs entities into expected vault paths', async () => {
    const result = await buildVaultZip({
      tenantId: TENANT_A,
      projectId: PROJECT,
      projectSlug: 'Orbital SDLC',
      entities: [ent({ title: 'Login flow', type: 'story' })],
    })
    expect(result.filename).toMatch(/orbital-vault-orbital-sdlc-/)
    const reopened = await JSZip.loadAsync(result.buffer)
    const file = reopened.file('projects/orbital-sdlc/stories/login-flow.md')
    expect(file).not.toBeNull()
    const content = await file!.async('string')
    const parsed = parseMarkdown(content)
    expect(parsed.frontmatter.title).toBe('Login flow')
  })

  it('includes a manifest.json', async () => {
    const result = await buildVaultZip({
      tenantId: TENANT_A,
      projectId: PROJECT,
      projectSlug: 'orbital',
      entities: [ent(), ent({ type: 'vision', title: 'North star' })],
    })
    const reopened = await JSZip.loadAsync(result.buffer)
    const manifestFile = reopened.file('projects/orbital/.orbital/manifest.json')
    expect(manifestFile).not.toBeNull()
    const manifestText = await manifestFile!.async('string')
    const manifest = JSON.parse(manifestText)
    expect(manifest.tenant_id).toBe(TENANT_A)
    expect(manifest.entries).toHaveLength(2)
  })

  it('throws if any entity has a different tenantId — no cross-tenant bleed', async () => {
    await expect(
      buildVaultZip({
        tenantId: TENANT_A,
        projectId: PROJECT,
        projectSlug: 'orbital',
        entities: [ent(), ent({ tenantId: TENANT_B })],
      }),
    ).rejects.toThrow(/tenantId/)
  })

  it('does not leak tenant id or other tenant data into archive paths', async () => {
    const result = await buildVaultZip({
      tenantId: TENANT_A,
      projectId: PROJECT,
      projectSlug: 'orbital',
      entities: [ent()],
    })
    const reopened = await JSZip.loadAsync(result.buffer)
    // Tenant id MUST NOT appear in any archive path — the ZIP is already
    // tenant-scoped by virtue of being downloaded by an authenticated user;
    // including the id would just be noise + a leak vector.
    for (const path of Object.keys(reopened.files)) {
      expect(path).not.toContain(TENANT_A)
      expect(path).not.toContain(TENANT_B)
    }
  })
})
