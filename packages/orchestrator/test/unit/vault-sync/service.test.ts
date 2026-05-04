/**
 * vault-sync service tests — round-trip + idempotency + tenant isolation.
 *
 * [Engineer-Principal · Opus · run-obsidian-vault-sync]
 *
 * Uses an in-memory store + an in-memory repo to exercise the service
 * without a Postgres dependency. The DB-backed repo is exercised in
 * the integration suite (separate file, requires PG).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { createInMemoryVaultStore } from '../../../src/vault-sync/store.js'
import { createVaultSyncService } from '../../../src/vault-sync/service.js'
import { parseMarkdown } from '../../../src/vault-sync/markdown.js'
import type {
  VaultEntity,
  VaultEntityType,
} from '../../../src/vault-sync/types.js'
import type {
  VaultLinkRepo,
  VaultLinkUpsertInput,
} from '../../../src/vault-sync/repo.js'

// In-memory repo for unit tests.
interface InMemRow extends VaultLinkUpsertInput {
  lastSyncedAt: Date
}

function createInMemoryRepo(): VaultLinkRepo & { _rows: Map<string, InMemRow> } {
  const rows = new Map<string, InMemRow>()
  const keyOf = (t: string, p: string, et: string, ei: string) => `${t}|${p}|${et}|${ei}`
  return {
    _rows: rows,
    async findByEntity({ tenantId, projectId, entityType, entityId }) {
      const r = rows.get(keyOf(tenantId, projectId, entityType, entityId))
      if (!r) return null
      return {
        id: r.id,
        tenantId: r.tenantId,
        projectId: r.projectId,
        entityType: r.entityType,
        entityId: r.entityId,
        vaultPath: r.vaultPath,
        frontmatter: r.frontmatter,
        contentHash: r.contentHash,
        lastSyncedAt: r.lastSyncedAt,
        createdAt: r.lastSyncedAt,
        updatedAt: r.lastSyncedAt,
      }
    },
    async upsert(input) {
      const k = keyOf(input.tenantId, input.projectId, input.entityType, input.entityId)
      const row: InMemRow = { ...input, lastSyncedAt: new Date() }
      rows.set(k, row)
      return {
        id: row.id,
        tenantId: row.tenantId,
        projectId: row.projectId,
        entityType: row.entityType,
        entityId: row.entityId,
        vaultPath: row.vaultPath,
        frontmatter: row.frontmatter,
        contentHash: row.contentHash,
        lastSyncedAt: row.lastSyncedAt,
        createdAt: row.lastSyncedAt,
        updatedAt: row.lastSyncedAt,
      }
    },
    async listByProject({ tenantId, projectId }) {
      const out: ReturnType<VaultLinkRepo['listByProject']> extends Promise<infer T> ? T : never = []
      for (const r of rows.values()) {
        if (r.tenantId === tenantId && r.projectId === projectId) {
          out.push({
            id: r.id,
            tenantId: r.tenantId,
            projectId: r.projectId,
            entityType: r.entityType,
            entityId: r.entityId,
            vaultPath: r.vaultPath,
            frontmatter: r.frontmatter,
            contentHash: r.contentHash,
            lastSyncedAt: r.lastSyncedAt,
            createdAt: r.lastSyncedAt,
            updatedAt: r.lastSyncedAt,
          })
        }
      }
      return out
    },
    async deleteByEntity({ tenantId, projectId, entityType, entityId }) {
      rows.delete(keyOf(tenantId, projectId, entityType, entityId))
    },
  }
}

const TENANT_A = '11111111-1111-4111-8111-111111111111'
const TENANT_B = '22222222-2222-4222-8222-222222222222'
const PROJECT_A = '33333333-3333-4333-8333-333333333333'

function entity(over: Partial<VaultEntity> = {}): VaultEntity {
  return {
    type: 'story',
    id: uuidv7(),
    tenantId: TENANT_A,
    projectId: PROJECT_A,
    title: 'Login flow',
    body: 'A user can log in.',
    status: 'in_progress',
    links: ['Auth epic'],
    tags: ['auth'],
    ...over,
  }
}

describe('VaultSyncService — round-trip', () => {
  let store = createInMemoryVaultStore()
  let repo = createInMemoryRepo()
  let svc = createVaultSyncService({ store, repo })

  beforeEach(() => {
    store = createInMemoryVaultStore()
    repo = createInMemoryRepo()
    svc = createVaultSyncService({ store, repo })
  })

  it('writes a markdown file you can read back into the same entity', async () => {
    const e = entity()
    const result = await svc.syncEntity(e, 'orbital')
    expect(result.written).toBe(true)

    const obj = await store.get(`${TENANT_A}/projects/orbital/stories/login-flow.md`)
    expect(obj).not.toBeNull()
    const parsed = parseMarkdown(obj!.body)
    expect(parsed.frontmatter.orbital_id).toBe(e.id)
    expect(parsed.frontmatter.tenant_id).toBe(TENANT_A)
    expect(parsed.frontmatter.title).toBe('Login flow')
    expect(parsed.frontmatter.tags).toEqual(['auth'])
    expect(parsed.frontmatter.links).toEqual(['Auth epic'])
    expect(parsed.body).toContain('A user can log in.')
  })

  it('is idempotent — second sync with same content does NOT re-write', async () => {
    const e = entity()
    const first = await svc.syncEntity(e, 'orbital')
    expect(first.written).toBe(true)

    const second = await svc.syncEntity(e, 'orbital')
    expect(second.written).toBe(false)
    expect(second.contentHash).toBe(first.contentHash)
  })

  it('re-writes when body changes', async () => {
    const e = entity()
    await svc.syncEntity(e, 'orbital')
    const updated = { ...e, body: 'A different body.' }
    const result = await svc.syncEntity(updated, 'orbital')
    expect(result.written).toBe(true)
  })
})

describe('VaultSyncService — tenant isolation', () => {
  it('refuses to sync an entity whose tenantId does not match input.tenantId', async () => {
    const store = createInMemoryVaultStore()
    const repo = createInMemoryRepo()
    const svc = createVaultSyncService({ store, repo })

    await expect(
      svc.syncProject({
        tenantId: TENANT_A,
        projectId: PROJECT_A,
        projectSlug: 'orbital',
        entities: [entity({ tenantId: TENANT_B })],
      }),
    ).rejects.toThrow(/tenantId/)
  })

  it('keys are tenant-prefixed — tenant A cannot see tenant B writes', async () => {
    const store = createInMemoryVaultStore()
    const repo = createInMemoryRepo()
    const svc = createVaultSyncService({ store, repo })

    await svc.syncEntity(entity({ tenantId: TENANT_A, title: 'A doc' }), 'orbital')
    await svc.syncEntity(entity({ tenantId: TENANT_B, title: 'B doc' }), 'orbital')

    const aKeys = await store.list(`${TENANT_A}/`)
    const bKeys = await store.list(`${TENANT_B}/`)
    expect(aKeys.every((k) => k.startsWith(`${TENANT_A}/`))).toBe(true)
    expect(bKeys.every((k) => k.startsWith(`${TENANT_B}/`))).toBe(true)
    expect(aKeys.some((k) => k.includes('a-doc.md'))).toBe(true)
    expect(bKeys.some((k) => k.includes('b-doc.md'))).toBe(true)
    // No tenant A key should appear in tenant B prefix scan.
    expect(aKeys.some((k) => k.startsWith(`${TENANT_B}/`))).toBe(false)
  })
})

describe('VaultSyncService — manifest', () => {
  it('writes a per-project manifest with one entry per synced entity', async () => {
    const store = createInMemoryVaultStore()
    const repo = createInMemoryRepo()
    const svc = createVaultSyncService({ store, repo })

    const types: VaultEntityType[] = ['vision', 'epic', 'story', 'ac', 'retro', 'memory']
    const entities = types.map((t) =>
      entity({ type: t, title: `${t} doc`, id: uuidv7() }),
    )

    const result = await svc.syncProject({
      tenantId: TENANT_A,
      projectId: PROJECT_A,
      projectSlug: 'orbital',
      entities,
    })

    expect(result.results).toHaveLength(6)
    expect(result.manifest.entries).toHaveLength(6)
    expect(result.manifestKey).toBe(`${TENANT_A}/projects/orbital/.orbital/manifest.json`)
    const manifestObj = await store.get(result.manifestKey)
    expect(manifestObj).not.toBeNull()
    const parsedManifest = JSON.parse(manifestObj!.body)
    expect(parsedManifest.tenant_id).toBe(TENANT_A)
    expect(parsedManifest.entries).toHaveLength(6)
  })
})
