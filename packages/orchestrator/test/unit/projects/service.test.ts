/**
 * Unit tests for projects/service.ts against real Postgres.
 *
 * Validates ProjectsService.create / list / get / getBySlug / update / archive,
 * plus connectMonday + connectGithub with mocked clients.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { OrbitalError } from '@orbital/types'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import {
  DefaultProjectsService,
  createProjectsService,
} from '../../../src/projects/service.js'
import { projects } from '../../../src/db/schema/projects.js'
import { events } from '../../../src/db/schema/events.js'
import { PROJECTS_ERROR_CODES } from '../../../src/projects/types.js'
import type { MondayClient } from '../../../src/backlog/monday-client.js'
import type { GithubClient } from '../../../src/github/client.js'

let service: DefaultProjectsService
const ownedProjectIds: string[] = []

beforeAll(async () => {
  await sql`SELECT 1`
  const eventStore = createEventStore(db, sql)
  service = new DefaultProjectsService(db, eventStore, null, null)
})

beforeEach(() => {
  ownedProjectIds.length = 0
})

afterAll(async () => {
  if (ownedProjectIds.length > 0) {
    // Best-effort cleanup of events tied to our projects.
    await db
      .delete(events)
      .where(inArray(events.aggregateId, ownedProjectIds))
      .catch(() => undefined)
    await db
      .delete(projects)
      .where(inArray(projects.projectId, ownedProjectIds))
      .catch(() => undefined)
  }
  await closeDb().catch(() => undefined)
})

function uniqueSlug(prefix = 'unit'): string {
  // Keep slug pattern compliant: lowercase letters/digits/hyphens, no leading
  // hyphen, no trailing hyphen, length >= 2.
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 6)
  return `${prefix}-${ts}-${rand}`
}

// ---------------------------------------------------------------------------

describe('ProjectsService.create + list + get', () => {
  it('creates a project with all required fields and returns it', async () => {
    const slug = uniqueSlug('p')
    const row = await service.create({
      name: 'Acme Billing',
      slug,
      description: 'Billing service',
    })
    ownedProjectIds.push(row.projectId)
    expect(row.projectId).toMatch(/^[0-9a-f-]{36}$/)
    expect(row.name).toBe('Acme Billing')
    expect(row.slug).toBe(slug)
    expect(row.description).toBe('Billing service')
    expect(row.archivedAt).toBeNull()
    expect(row.githubDefaultBranch).toBe('main')
  })

  it('appends a ProjectCreated event', async () => {
    const slug = uniqueSlug('e')
    const row = await service.create({ name: 'Event check', slug })
    ownedProjectIds.push(row.projectId)
    const created = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, row.projectId))
    expect(created.length).toBeGreaterThanOrEqual(1)
    const types = created.map((c) => c.eventType)
    expect(types).toContain('ProjectCreated')
  })

  it('rejects duplicate slugs within the same install with CONFLICT_SLUG', async () => {
    const slug = uniqueSlug('dup')
    const a = await service.create({ name: 'A', slug })
    ownedProjectIds.push(a.projectId)
    try {
      await service.create({ name: 'B', slug })
      expect.fail('expected throw')
    } catch (err) {
      expect((err as OrbitalError).code).toBe(PROJECTS_ERROR_CODES.CONFLICT_SLUG)
    }
  })

  it('list() returns created projects ordered by createdAt asc', async () => {
    const a = await service.create({ name: 'A', slug: uniqueSlug('list-a') })
    const b = await service.create({ name: 'B', slug: uniqueSlug('list-b') })
    ownedProjectIds.push(a.projectId, b.projectId)
    const list = await service.list()
    const aIdx = list.findIndex((p) => p.projectId === a.projectId)
    const bIdx = list.findIndex((p) => p.projectId === b.projectId)
    expect(aIdx).toBeGreaterThanOrEqual(0)
    expect(bIdx).toBeGreaterThan(aIdx)
  })

  it('list({ archived: false }) excludes archived rows', async () => {
    const a = await service.create({ name: 'live', slug: uniqueSlug('live') })
    const b = await service.create({ name: 'old', slug: uniqueSlug('old') })
    ownedProjectIds.push(a.projectId, b.projectId)
    await service.archive(b.projectId)
    const active = await service.list({ archived: false })
    expect(active.some((p) => p.projectId === a.projectId)).toBe(true)
    expect(active.some((p) => p.projectId === b.projectId)).toBe(false)
  })

  it('list({ archived: true }) returns only archived rows', async () => {
    const a = await service.create({ name: 'still-live', slug: uniqueSlug('sl') })
    const b = await service.create({ name: 'arc', slug: uniqueSlug('arc') })
    ownedProjectIds.push(a.projectId, b.projectId)
    await service.archive(b.projectId)
    const archived = await service.list({ archived: true })
    expect(archived.some((p) => p.projectId === b.projectId)).toBe(true)
    expect(archived.every((p) => p.archivedAt !== null)).toBe(true)
  })

  it('get() returns null for a nonexistent id', async () => {
    expect(await service.get('00000000-0000-0000-0000-000000000000')).toBeNull()
  })
})

// ---------------------------------------------------------------------------

describe('ProjectsService.update', () => {
  it('updates name and description', async () => {
    const row = await service.create({ name: 'Old', slug: uniqueSlug('upd') })
    ownedProjectIds.push(row.projectId)
    const updated = await service.update({
      projectId: row.projectId,
      name: 'New',
      description: 'now described',
    })
    expect(updated.name).toBe('New')
    expect(updated.description).toBe('now described')
  })

  it('throws NOT_FOUND_PROJECT for a missing id', async () => {
    try {
      await service.update({
        projectId: '00000000-0000-0000-0000-000000000000',
        name: 'x',
      })
      expect.fail('expected throw')
    } catch (err) {
      expect((err as OrbitalError).code).toBe(PROJECTS_ERROR_CODES.NOT_FOUND_PROJECT)
    }
  })
})

// ---------------------------------------------------------------------------

describe('ProjectsService.archive', () => {
  it('sets archivedAt and emits ProjectArchived', async () => {
    const row = await service.create({ name: 'X', slug: uniqueSlug('arc2') })
    ownedProjectIds.push(row.projectId)
    await service.archive(row.projectId)
    const after = await service.get(row.projectId)
    expect(after?.archivedAt).not.toBeNull()
    const evRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, row.projectId))
    expect(evRows.some((e) => e.eventType === 'ProjectArchived')).toBe(true)
  })

  it('is idempotent (archive twice = no-op on second call)', async () => {
    const row = await service.create({ name: 'X', slug: uniqueSlug('arc3') })
    ownedProjectIds.push(row.projectId)
    await service.archive(row.projectId)
    const firstArchivedAt = (await service.get(row.projectId))!.archivedAt
    await service.archive(row.projectId)
    const secondArchivedAt = (await service.get(row.projectId))!.archivedAt
    expect(secondArchivedAt).toEqual(firstArchivedAt)
  })
})

// ---------------------------------------------------------------------------

describe('ProjectsService.connectMonday', () => {
  it('rejects if project does not exist', async () => {
    const eventStore = createEventStore(db, sql)
    const stubMonday: MondayClient = {
      getBoardItems: async () => [],
      getItem: async () => null,
      createSubitem: async () => ({ id: '1' }),
      updateColumnValue: async () => ({ id: '1' }),
    }
    const svc = createProjectsService(db, eventStore, { mondayClient: stubMonday })
    try {
      await svc.connectMonday({
        projectId: '00000000-0000-0000-0000-000000000000',
        boardId: 'b1',
      })
      expect.fail('expected throw')
    } catch (err) {
      expect((err as OrbitalError).code).toBe(PROJECTS_ERROR_CODES.NOT_FOUND_PROJECT)
    }
  })

  it('persists the boardId on success and emits MondayBoardConnected', async () => {
    const row = await service.create({ name: 'CM', slug: uniqueSlug('cm') })
    ownedProjectIds.push(row.projectId)
    const eventStore = createEventStore(db, sql)
    const stubMonday: MondayClient = {
      getBoardItems: async () => [],
      getItem: async () => null,
      createSubitem: async () => ({ id: '1' }),
      updateColumnValue: async () => ({ id: '1' }),
    }
    const svc = createProjectsService(db, eventStore, { mondayClient: stubMonday })
    const updated = await svc.connectMonday({ projectId: row.projectId, boardId: '12345' })
    expect(updated.mondayBoardId).toBe('12345')
    const evRows = await db
      .select()
      .from(events)
      .where(eq(events.aggregateId, row.projectId))
    expect(evRows.some((e) => e.eventType === 'MondayBoardConnected')).toBe(true)
  })

  it('translates client failure into MONDAY_CONNECT_FAILED', async () => {
    const row = await service.create({ name: 'CMx', slug: uniqueSlug('cmx') })
    ownedProjectIds.push(row.projectId)
    const eventStore = createEventStore(db, sql)
    const failingMonday: MondayClient = {
      getBoardItems: async () => {
        throw new Error('upstream broke')
      },
      getItem: async () => null,
      createSubitem: async () => ({ id: '1' }),
      updateColumnValue: async () => ({ id: '1' }),
    }
    const svc = createProjectsService(db, eventStore, { mondayClient: failingMonday })
    try {
      await svc.connectMonday({ projectId: row.projectId, boardId: '99' })
      expect.fail('expected throw')
    } catch (err) {
      expect((err as OrbitalError).code).toBe(
        PROJECTS_ERROR_CODES.MONDAY_CONNECT_FAILED,
      )
    }
  })
})

// ---------------------------------------------------------------------------

describe('ProjectsService.connectGithub', () => {
  function stubGithub(repo: { defaultBranch: string } | null): GithubClient {
    return {
      getAuthenticatedUser: async () => ({ login: 'octocat' }),
      getRepo: async () =>
        repo
          ? {
              id: 1,
              name: 'r',
              fullName: 'o/r',
              owner: { login: 'o' },
              private: false,
              defaultBranch: repo.defaultBranch,
              htmlUrl: 'https://github.com/o/r',
            }
          : null,
      createRepo: async () => {
        throw new Error('not used')
      },
      listBranches: async () => [],
      getBranch: async () => null,
      createBranch: async () => ({ name: 'x', commitSha: 'y', protected: false }),
    }
  }

  it('persists owner+repo+defaultBranch on success', async () => {
    const row = await service.create({ name: 'CG', slug: uniqueSlug('cg') })
    ownedProjectIds.push(row.projectId)
    const eventStore = createEventStore(db, sql)
    const svc = createProjectsService(db, eventStore, {
      githubClient: stubGithub({ defaultBranch: 'develop' }),
    })
    const updated = await svc.connectGithub({
      projectId: row.projectId,
      owner: 'acme',
      repo: 'billing',
      defaultBranch: 'main',
    })
    expect(updated.githubOwner).toBe('acme')
    expect(updated.githubRepo).toBe('billing')
    // Should prefer Github's reported defaultBranch over the input
    expect(updated.githubDefaultBranch).toBe('develop')
  })

  it('throws GITHUB_CONNECT_FAILED if repo is null', async () => {
    const row = await service.create({ name: 'CG2', slug: uniqueSlug('cg2') })
    ownedProjectIds.push(row.projectId)
    const eventStore = createEventStore(db, sql)
    const svc = createProjectsService(db, eventStore, { githubClient: stubGithub(null) })
    try {
      await svc.connectGithub({
        projectId: row.projectId,
        owner: 'a',
        repo: 'b',
        defaultBranch: 'main',
      })
      expect.fail('expected throw')
    } catch (err) {
      expect((err as OrbitalError).code).toBe(
        PROJECTS_ERROR_CODES.GITHUB_CONNECT_FAILED,
      )
    }
  })
})

// ---------------------------------------------------------------------------

describe('ProjectsService.ensureDefaultProject', () => {
  it('is idempotent — second call returns same row', async () => {
    const a = await service.ensureDefaultProject()
    const b = await service.ensureDefaultProject()
    expect(b.projectId).toBe(a.projectId)
    expect(b.slug).toBe('default')
    // Track for cleanup only on first observation
    if (!ownedProjectIds.includes(a.projectId)) ownedProjectIds.push(a.projectId)
  })
})
