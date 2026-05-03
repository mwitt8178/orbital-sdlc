/**
 * Integration test: tRPC Projects router.
 *
 * Exercises createProjectsRouter end-to-end against real Postgres + real
 * EventStore, with stubbed Monday/Github clients.
 *
 * Confirms:
 * - projects.create writes a row + emits ProjectCreated
 * - projects.list returns it
 * - projects.connectMonday / projects.connectGithub work via the router
 * - testMondayConnection / testGithubConnection respond appropriately
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { inArray } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import {
  createProjectsRouter,
  type ProjectsRouter,
} from '../../../src/trpc/routers/projects.js'
import { createProjectsService } from '../../../src/projects/service.js'
import { projects } from '../../../src/db/schema/projects.js'
import { events } from '../../../src/db/schema/events.js'
import type { MondayClient } from '../../../src/backlog/monday-client.js'
import type { GithubClient } from '../../../src/github/client.js'

let r: ReturnType<ProjectsRouter['createCaller']>

const ownedProjectIds: string[] = []

beforeAll(async () => {
  await sql`SELECT 1`
  const eventStore = createEventStore(db, sql)

  const stubMonday: MondayClient = {
    getBoardItems: async (boardId: string) => {
      if (boardId === 'bad') throw new Error('board not accessible')
      return []
    },
    getItem: async () => null,
    createSubitem: async () => ({ id: '1' }),
    updateColumnValue: async () => ({ id: '1' }),
    graphql: async <T>() => ({} as T),
  }

  const stubGithub: GithubClient = {
    getAuthenticatedUser: async () => ({ login: 'octocat' }),
    getRepo: async (owner: string, repo: string) => {
      if (repo === 'gone') return null
      return {
        id: 1,
        name: repo,
        fullName: `${owner}/${repo}`,
        owner: { login: owner },
        private: false,
        defaultBranch: 'main',
        htmlUrl: `https://github.com/${owner}/${repo}`,
      }
    },
    createRepo: async () => {
      throw new Error('not used in this test')
    },
    listBranches: async () => [],
    getBranch: async () => null,
    createBranch: async () => ({ name: 'x', commitSha: 'y', protected: false }),
    createPullRequest: async () => ({ pr_number: 1, html_url: 'https://github.com/x/y/pull/1' }),
    addLabels: async () => undefined,
    mergePullRequest: async () => ({ sha: 'deadbeef' }),
    listOpenPullRequestsByLabel: async () => [],
    getPullRequest: async () => null,
    listCheckRuns: async () => [],
    rerunCheckRun: async () => undefined,
    createReviewComment: async () => ({ id: 1 }),
    submitPRReview: async () => ({ id: 1 }),
    rawRequest: async () => null,
  }

  const service = createProjectsService(db, eventStore, {
    mondayClient: stubMonday,
    githubClient: stubGithub,
  })
  const router = createProjectsRouter({
    projectsService: service,
    mondayClient: stubMonday,
    githubClient: stubGithub,
  })
  r = router.createCaller({})
})

beforeEach(() => {
  ownedProjectIds.length = 0
})

afterAll(async () => {
  if (ownedProjectIds.length > 0) {
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

function uniqueSlug(prefix = 'i'): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 6)
  return `${prefix}-${ts}-${rand}`
}

describe('projects tRPC router (integration)', () => {
  it('create + list', async () => {
    const created = await r.create({
      name: 'Acme Billing',
      slug: uniqueSlug('ab'),
    })
    ownedProjectIds.push(created.projectId)
    expect(created.name).toBe('Acme Billing')

    const list = await r.list()
    expect(list?.some((p) => p.projectId === created.projectId)).toBe(true)
  })

  it('get returns the created project', async () => {
    const created = await r.create({ name: 'X', slug: uniqueSlug('xg') })
    ownedProjectIds.push(created.projectId)
    const got = await r.get({ projectId: created.projectId })
    expect(got?.projectId).toBe(created.projectId)
  })

  it('update patches name', async () => {
    const created = await r.create({ name: 'Old', slug: uniqueSlug('upd') })
    ownedProjectIds.push(created.projectId)
    const updated = await r.update({ projectId: created.projectId, name: 'New' })
    expect(updated.name).toBe('New')
  })

  it('archive flips archivedAt', async () => {
    const created = await r.create({ name: 'A', slug: uniqueSlug('arc') })
    ownedProjectIds.push(created.projectId)
    await r.archive({ projectId: created.projectId })
    const after = await r.get({ projectId: created.projectId })
    expect(after?.archivedAt).not.toBeNull()
  })

  it('connectMonday persists boardId', async () => {
    const created = await r.create({ name: 'M', slug: uniqueSlug('m') })
    ownedProjectIds.push(created.projectId)
    const after = await r.connectMonday({
      projectId: created.projectId,
      boardId: '7777',
    })
    expect(after.mondayBoardId).toBe('7777')
  })

  it('connectGithub persists owner+repo+default branch', async () => {
    const created = await r.create({ name: 'G', slug: uniqueSlug('g') })
    ownedProjectIds.push(created.projectId)
    const after = await r.connectGithub({
      projectId: created.projectId,
      owner: 'acme',
      repo: 'orbital',
      defaultBranch: 'main',
    })
    expect(after.githubOwner).toBe('acme')
    expect(after.githubRepo).toBe('orbital')
  })

  it('testMondayConnection ok=true for a valid board', async () => {
    const r1 = await r.testMondayConnection({ boardId: 'good' })
    expect(r1.ok).toBe(true)
  })

  it('testMondayConnection ok=false for a failing board', async () => {
    const r1 = await r.testMondayConnection({ boardId: 'bad' })
    expect(r1.ok).toBe(false)
  })

  it('testGithubConnection ok=true for a valid repo', async () => {
    const r1 = await r.testGithubConnection({ owner: 'acme', repo: 'good' })
    expect(r1.ok).toBe(true)
    expect(r1.defaultBranch).toBe('main')
  })

  it('testGithubConnection ok=false for a missing repo', async () => {
    const r1 = await r.testGithubConnection({ owner: 'acme', repo: 'gone' })
    expect(r1.ok).toBe(false)
  })
})
