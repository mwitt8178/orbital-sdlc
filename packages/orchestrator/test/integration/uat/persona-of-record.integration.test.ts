/**
 * Integration test: resolvePersonaOfRecord — full attestation chain walk.
 *
 * Per TRD-11 §7.2 and M3 done criteria:
 *   "Persona-of-record walks all 4 steps in order; each step has a passing test"
 *   "Real git for the git-blame step"
 *   "Real Postgres for integration tests"
 *   "Every event via EventStore.append; never db.insert(events)"
 *
 * Each test exercises a different resolution path through the chain:
 *   Step 2: CommitSigned event → actor.persona_id
 *   Step 3: capability_grants.persona_id (no CommitSigned event)
 *   Step 4: tasks.persona_id (no CommitSigned, no capability_grant)
 *   Step 1+2: git blame → real commit hash → CommitSigned event match
 *
 * NOTE on CommitSigned: Phase 6C commit-signing is the upstream producer.
 * These tests seed CommitSigned events directly via EventStore.append to
 * verify the chain walk. The boot agent's wiring note: CommitSigned events
 * are currently a stub; the resolvePersonaOfRecord function handles their
 * absence gracefully (clean fall-through to step 3/4).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inArray, eq } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import {
  resolvePersonaOfRecord,
  PERSONA_OF_RECORD_UNKNOWN,
} from '../../../src/uat/persona-of-record.js'
import { tasks, worktrees } from '../../../src/db/schema/orchestration.js'
import { capabilityGrants, signingKeys } from '../../../src/db/schema/capabilities.js'
import { epics, stories, sprints } from '../../../src/db/schema/backlog.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const eventStore = createEventStore(db, sql)

const cleanup = {
  taskIds: [] as string[],
  worktreeIds: [] as string[],
  sprintIds: [] as string[],
  epicIds: [] as string[],
  storyIds: [] as string[],
  capabilityIds: [] as string[],
  signingKeyIds: [] as string[],
  tempDirs: [] as string[],
}

beforeAll(async () => {
  await sql`SELECT 1`
})

afterAll(async () => {
  // Clean up in dependency order (reverse of insert)
  if (cleanup.capabilityIds.length > 0) {
    await db
      .delete(capabilityGrants)
      .where(inArray(capabilityGrants.capability_id, cleanup.capabilityIds))
      .catch(() => undefined)
  }
  if (cleanup.worktreeIds.length > 0) {
    await db
      .delete(worktrees)
      .where(inArray(worktrees.worktreeId, cleanup.worktreeIds))
      .catch(() => undefined)
  }
  if (cleanup.taskIds.length > 0) {
    await db.delete(tasks).where(inArray(tasks.taskId, cleanup.taskIds)).catch(() => undefined)
  }
  if (cleanup.storyIds.length > 0) {
    await db
      .delete(stories)
      .where(inArray(stories.storyId, cleanup.storyIds))
      .catch(() => undefined)
  }
  if (cleanup.epicIds.length > 0) {
    await db.delete(epics).where(inArray(epics.epicId, cleanup.epicIds)).catch(() => undefined)
  }
  if (cleanup.sprintIds.length > 0) {
    await db
      .delete(sprints)
      .where(inArray(sprints.sprintId, cleanup.sprintIds))
      .catch(() => undefined)
  }
  if (cleanup.signingKeyIds.length > 0) {
    await db
      .delete(signingKeys)
      .where(inArray(signingKeys.key_id, cleanup.signingKeyIds))
      .catch(() => undefined)
  }
  // Remove temp git dirs
  for (const dir of cleanup.tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  await closeDb().catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function makeSprint(): Promise<string> {
  const sprintId = uuidv7()
  await db.insert(sprints).values({
    sprintId,
    name: `por-integration-sprint-${sprintId}`,
    sequence: 9999,
    status: 'active',
    storyPointCapacity: 10,
    budgetUsdCents: 10000,
    concurrencyShare: 100,
    priorityClass: 'standard',
    createdAt: new Date(),
    updatedAt: new Date(),
    schemaVersion: 1,
  })
  cleanup.sprintIds.push(sprintId)
  return sprintId
}

async function makeTask(params: {
  personaId: string
  currentCapabilityId?: string
  currentWorktreeId?: string
  sprintId?: string
}): Promise<string> {
  const taskId = uuidv7()
  const sprintId = params.sprintId ?? (await makeSprint())
  const now = new Date()
  await db.insert(tasks).values({
    taskId,
    sprintId,
    ticketId: 'POR-INTEGRATION-TICK',
    title: 'por-attestation-test-task',
    description: 'Integration test task for persona-of-record attestation chain',
    acceptanceCriteria: [],
    personaId: params.personaId,
    riskClass: 'standard',
    state: 'done',
    attemptCount: 1,
    retryBudget: 3,
    wallClockTimeoutMs: 300_000,
    tokenBudget: 100_000,
    linkedArtifacts: [],
    declaredWritePaths: [],
    createdAt: now,
    createdByEventId: uuidv7(),
    currentCapabilityId: params.currentCapabilityId ?? null,
    currentWorktreeId: params.currentWorktreeId ?? null,
  })
  cleanup.taskIds.push(taskId)
  return taskId
}

async function makeSigningKeyAndCapabilityGrant(params: {
  taskId: string
  personaId: string
}): Promise<{ capabilityId: string; signingKeyId: string }> {
  const signingKeyId = uuidv7()
  const sprintId = uuidv7() // Not stored in DB for this FK chain; just needs a UUID
  const installId = uuidv7()
  const now = new Date()
  const future = new Date(Date.now() + 86_400_000)

  await db.insert(signingKeys).values({
    key_id: signingKeyId,
    key_kind: 'sub',
    install_id: installId,
    sprint_id: sprintId,
    public_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', // placeholder Ed25519 pub
    algorithm: 'ed25519',
    created_at: now,
    active_from: now,
    active_until: future,
    status: 'active',
    schema_version: 1,
  })
  cleanup.signingKeyIds.push(signingKeyId)

  const capabilityId = uuidv7()
  await db.insert(capabilityGrants).values({
    capability_id: capabilityId,
    task_id: params.taskId,
    session_id: uuidv7(),
    persona_id: params.personaId,
    sprint_id: sprintId,
    signing_sub_key_id: signingKeyId,
    scopes: {},
    issued_at: now,
    expires_at: future,
    bundle_hash: 'hash-placeholder',
    signature: 'sig-placeholder',
    status: 'active',
    schema_version: 1,
  })
  cleanup.capabilityIds.push(capabilityId)

  return { capabilityId, signingKeyId }
}

function makeGitWorktree(commitFilename: string): { dir: string; commitHash: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orbital-por-test-'))
  cleanup.tempDirs.push(dir)

  // Initialize a real git repo
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@orbital.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Orbital Test'], { cwd: dir })

  // Create and commit a file
  writeFileSync(join(dir, commitFilename), `// test file for ${commitFilename}\n`)
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '--no-gpg-sign', '-m', 'initial commit'], { cwd: dir })

  // Get the commit hash
  const commitHash = execFileSync('git', ['log', '-1', '--format=%H'], {
    cwd: dir,
    encoding: 'utf8',
  }).trim()

  return { dir, commitHash }
}

async function makeWorktreeRow(taskId: string, path: string): Promise<string> {
  const worktreeId = uuidv7()
  await db.insert(worktrees).values({
    worktreeId,
    taskId,
    path,
    branchName: 'test-branch',
    parentBranch: 'main',
    state: 'active',
    declaredWritePaths: [],
    createdAt: new Date(),
  })
  cleanup.worktreeIds.push(worktreeId)
  return worktreeId
}

// ---------------------------------------------------------------------------
// Step 4: tasks.persona_id — final fallback (no worktree, no CommitSigned, no capability)
// ---------------------------------------------------------------------------

describe('resolvePersonaOfRecord — step 4: tasks.persona_id fallback', () => {
  it('returns task persona_id when no worktree, no CommitSigned event, no capability_grant', async () => {
    const personaId = `persona:step4-test-${uuidv7()}`
    const taskId = await makeTask({ personaId })

    const results = await resolvePersonaOfRecord(taskId, ['src/some-file.ts'], db)

    expect(results).toHaveLength(1)
    expect(results[0]?.personaId).toBe(personaId)
    expect(results[0]?.resolvedBy).toBe('task_persona')
    expect(results[0]?.filePath).toBe('src/some-file.ts')
  })

  it('returns PERSONA_OF_RECORD_UNKNOWN when task does not exist', async () => {
    const fakeTaskId = uuidv7()
    const results = await resolvePersonaOfRecord(fakeTaskId, ['src/file.ts'], db)

    expect(results).toHaveLength(1)
    expect(results[0]?.personaId).toBe(PERSONA_OF_RECORD_UNKNOWN)
    expect(results[0]?.resolvedBy).toBe('unknown')
  })

  it('returns empty array when filePaths is empty', async () => {
    const taskId = await makeTask({ personaId: 'persona:test' })
    const results = await resolvePersonaOfRecord(taskId, [], db)
    expect(results).toHaveLength(0)
  })

  it('resolves each file path independently', async () => {
    const personaId = `persona:multi-file-${uuidv7()}`
    const taskId = await makeTask({ personaId })

    const results = await resolvePersonaOfRecord(
      taskId,
      ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      db,
    )

    expect(results).toHaveLength(3)
    for (const result of results) {
      expect(result.personaId).toBe(personaId)
      expect(result.resolvedBy).toBe('task_persona')
    }
    expect(results.map((r) => r.filePath)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
  })
})

// ---------------------------------------------------------------------------
// Step 3: capability_grants.persona_id
// ---------------------------------------------------------------------------

describe('resolvePersonaOfRecord — step 3: capability_grants fallback', () => {
  it('resolves via capability_grant.persona_id when no worktree and no CommitSigned event', async () => {
    const capPersonaId = `persona:cap-step3-${uuidv7()}`
    const taskPersonaId = `persona:task-step3-${uuidv7()}` // different from cap persona

    // Create task without worktree
    const taskId = await makeTask({ personaId: taskPersonaId })

    // Create capability_grant with different persona
    const { capabilityId } = await makeSigningKeyAndCapabilityGrant({
      taskId,
      personaId: capPersonaId,
    })

    // Update task to reference the capability
    await db
      .update(tasks)
      .set({ currentCapabilityId: capabilityId })
      .where(eq(tasks.taskId, taskId))

    const results = await resolvePersonaOfRecord(taskId, ['src/capability-file.ts'], db)

    expect(results).toHaveLength(1)
    expect(results[0]?.personaId).toBe(capPersonaId)
    expect(results[0]?.resolvedBy).toBe('capability_grant')
    expect(results[0]?.capabilityId).toBe(capabilityId)
    // No commitHash because we had no worktree
    expect(results[0]?.commitHash).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Step 2: CommitSigned event lookup
// ---------------------------------------------------------------------------

describe('resolvePersonaOfRecord — step 2: CommitSigned event', () => {
  it('resolves via CommitSigned event actor.persona_id when event is in the log', async () => {
    const commitPersonaId = `persona:commit-step2-${uuidv7()}`
    const taskPersonaId = `persona:task-step2-${uuidv7()}`

    // Create a real git worktree so step 1 produces a real commit hash.
    // Then seed a CommitSigned event with that hash.
    const { dir } = makeGitWorktree('commit-signed-test.ts')

    const realCommitHash = execFileSync('git', ['log', '-1', '--format=%H'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim()

    // Seed CommitSigned with the real commit hash.
    // persona actor requires session_id per @orbital/types ActorSchema.
    await eventStore.append({
      aggregate_id: uuidv7(),
      aggregate_type: 'task',
      event_type: 'CommitSigned',
      payload: {
        commit_hash: realCommitHash,
        branch: 'feat/test',
      },
      actor: {
        type: 'persona',
        persona_id: commitPersonaId,
        session_id: uuidv7(),
      },
      trace_id: `trace-commit-real-${uuidv7()}`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    // Create task first (no worktree yet), then worktree with real taskId, then link back.
    const taskId = await makeTask({ personaId: taskPersonaId })
    const worktreeId = await makeWorktreeRow(taskId, dir)
    await db.update(tasks).set({ currentWorktreeId: worktreeId }).where(eq(tasks.taskId, taskId))

    const results = await resolvePersonaOfRecord(taskId, ['commit-signed-test.ts'], db)

    expect(results).toHaveLength(1)
    expect(results[0]?.resolvedBy).toBe('commit_signed_event')
    expect(results[0]?.personaId).toBe(commitPersonaId)
    expect(results[0]?.commitHash).toBe(realCommitHash)
    expect(results[0]?.commitSignedEventId).toBeDefined()
  })

  it('falls through to task_persona when CommitSigned event has non-persona actor', async () => {
    // Seed a CommitSigned with a system actor (not persona)
    const { dir } = makeGitWorktree('system-signed.ts')
    const realCommitHash = execFileSync('git', ['log', '-1', '--format=%H'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim()

    await eventStore.append({
      aggregate_id: uuidv7(),
      aggregate_type: 'task',
      event_type: 'CommitSigned',
      payload: { commit_hash: realCommitHash },
      actor: { type: 'system', component: 'orchestrator' }, // not a persona actor
      trace_id: `trace-system-${uuidv7()}`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    const personaId = `persona:task-sys-actor-${uuidv7()}`
    // Create task first, then worktree with real UUID taskId, then link back.
    const taskId = await makeTask({ personaId })
    const worktreeId = await makeWorktreeRow(taskId, dir)
    await db.update(tasks).set({ currentWorktreeId: worktreeId }).where(eq(tasks.taskId, taskId))

    const results = await resolvePersonaOfRecord(taskId, ['system-signed.ts'], db)

    expect(results).toHaveLength(1)
    // Should fall through to task_persona since CommitSigned actor is not persona type
    expect(results[0]?.resolvedBy).toBe('task_persona')
    expect(results[0]?.personaId).toBe(personaId)
  })
})

// ---------------------------------------------------------------------------
// Step 1: git blame (worktree present, file not tracked → falls through)
// ---------------------------------------------------------------------------

describe('resolvePersonaOfRecord — step 1: git blame fall-through', () => {
  it('falls through to task_persona when file is not tracked in the worktree', async () => {
    const { dir } = makeGitWorktree('tracked-file.ts')
    const personaId = `persona:git-fallthrough-${uuidv7()}`
    // Create task first, then worktree with real UUID taskId, then link back.
    const taskId = await makeTask({ personaId })
    const worktreeId = await makeWorktreeRow(taskId, dir)
    await db.update(tasks).set({ currentWorktreeId: worktreeId }).where(eq(tasks.taskId, taskId))

    // Query for a file that does NOT exist in the worktree
    const results = await resolvePersonaOfRecord(taskId, ['nonexistent-file.ts'], db)

    expect(results).toHaveLength(1)
    // git log returns empty output for untracked file → commitHash = null → steps 2/3 skip
    // → falls to task_persona
    expect(results[0]?.personaId).toBe(personaId)
    expect(results[0]?.resolvedBy).toBe('task_persona')
    expect(results[0]?.commitHash).toBeUndefined()
  })

  it('uses the worktree path from DB for git blame (step 1 succeeds → step 2 fallthrough)', async () => {
    // Step 1 produces a hash; step 2 finds no CommitSigned; falls to step 4.
    const { dir } = makeGitWorktree('real-tracked-file.ts')
    const personaId = `persona:git-step1-${uuidv7()}`
    // Create task first, then worktree with real UUID taskId, then link back.
    const taskId = await makeTask({ personaId })
    const worktreeId = await makeWorktreeRow(taskId, dir)
    await db.update(tasks).set({ currentWorktreeId: worktreeId }).where(eq(tasks.taskId, taskId))

    const results = await resolvePersonaOfRecord(taskId, ['real-tracked-file.ts'], db)

    expect(results).toHaveLength(1)
    // commitHash is populated from step 1 (git log found a commit)
    // Step 2: no CommitSigned event → fall through
    // Step 3: no currentCapabilityId on task → fall through
    // Step 4: task persona_id
    expect(results[0]?.personaId).toBe(personaId)
    expect(results[0]?.resolvedBy).toBe('task_persona')
    // The commit hash SHOULD be populated from step 1 (even though steps 2/3 fell through)
    expect(typeof results[0]?.commitHash).toBe('string')
    expect(results[0]?.commitHash?.length).toBe(40)
  })

  it('skips git blame when worktree is not active (worktreeId null on task)', async () => {
    // Task has no currentWorktreeId → step 1 skipped entirely
    const personaId = `persona:no-worktree-${uuidv7()}`
    const taskId = await makeTask({ personaId }) // no currentWorktreeId

    const results = await resolvePersonaOfRecord(taskId, ['src/anywhere.ts'], db)

    expect(results).toHaveLength(1)
    expect(results[0]?.resolvedBy).toBe('task_persona')
    expect(results[0]?.commitHash).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Chain priority: step 2 wins over step 3 and step 4
// ---------------------------------------------------------------------------

describe('resolvePersonaOfRecord — chain priority', () => {
  it('CommitSigned event (step 2) wins over capability_grants (step 3)', async () => {
    const { dir } = makeGitWorktree('priority-test.ts')
    const realCommitHash = execFileSync('git', ['log', '-1', '--format=%H'], {
      cwd: dir,
      encoding: 'utf8',
    }).trim()

    const commitPersonaId = `persona:commit-wins-${uuidv7()}`
    const capPersonaId = `persona:cap-loses-${uuidv7()}`
    const taskPersonaId = `persona:task-loses-${uuidv7()}`

    await eventStore.append({
      aggregate_id: uuidv7(),
      aggregate_type: 'task',
      event_type: 'CommitSigned',
      payload: { commit_hash: realCommitHash },
      actor: { type: 'persona', persona_id: commitPersonaId, session_id: uuidv7() },
      trace_id: `trace-priority-${uuidv7()}`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    // Create task first, then worktree with real UUID taskId, then link back.
    const taskId = await makeTask({ personaId: taskPersonaId })
    const worktreeId = await makeWorktreeRow(taskId, dir)
    await db.update(tasks).set({ currentWorktreeId: worktreeId }).where(eq(tasks.taskId, taskId))

    const { capabilityId } = await makeSigningKeyAndCapabilityGrant({
      taskId,
      personaId: capPersonaId,
    })
    await db.update(tasks).set({ currentCapabilityId: capabilityId }).where(eq(tasks.taskId, taskId))

    const results = await resolvePersonaOfRecord(taskId, ['priority-test.ts'], db)

    expect(results).toHaveLength(1)
    expect(results[0]?.resolvedBy).toBe('commit_signed_event')
    expect(results[0]?.personaId).toBe(commitPersonaId) // step 2 wins
    expect(results[0]?.personaId).not.toBe(capPersonaId)
    expect(results[0]?.personaId).not.toBe(taskPersonaId)
  })

  it('capability_grants (step 3) wins over task_persona (step 4)', async () => {
    const capPersonaId = `persona:cap-step3-wins-${uuidv7()}`
    const taskPersonaId = `persona:task-step4-loses-${uuidv7()}`

    const taskId = await makeTask({ personaId: taskPersonaId })
    const { capabilityId } = await makeSigningKeyAndCapabilityGrant({
      taskId,
      personaId: capPersonaId,
    })
    await db.update(tasks).set({ currentCapabilityId: capabilityId }).where(eq(tasks.taskId, taskId))

    const results = await resolvePersonaOfRecord(taskId, ['src/step3-wins.ts'], db)

    expect(results).toHaveLength(1)
    expect(results[0]?.resolvedBy).toBe('capability_grant')
    expect(results[0]?.personaId).toBe(capPersonaId) // step 3 wins
    expect(results[0]?.personaId).not.toBe(taskPersonaId)
  })
})
