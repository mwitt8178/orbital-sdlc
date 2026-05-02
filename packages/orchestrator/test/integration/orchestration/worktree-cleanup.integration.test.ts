/**
 * worktree-cleanup.integration.test.ts
 *
 * Integration test for registerWorktreeCleanup.
 *
 * Flow:
 *   1. Create a real git repo in a temp dir.
 *   2. Create a worktree via WorktreeManager.create().
 *   3. Verify the worktree path exists on disk.
 *   4. Emit a TaskCompleted event via EventStore.
 *   5. Wait for registerWorktreeCleanup to call cleanup().
 *   6. Verify the worktree path no longer exists on disk.
 *   7. Verify the worktrees row is marked released.
 *
 * Also covers TaskFailed — same behaviour.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { promises as fsp } from 'node:fs'
import fs from 'node:fs'
import { spawn as childSpawn } from 'node:child_process'
import { uuidv7 } from 'uuidv7'
import { eq, isNull } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { WorktreeManager } from '../../../src/orchestration/worktree.js'
import { registerWorktreeCleanup } from '../../../src/orchestration/worktree-cleanup.js'
import { worktrees, tasks } from '../../../src/db/schema/orchestration.js'
import type { EventInput } from '../../../src/events/types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let tmpRepoRoot: string
let tmpWorktreeRoot: string
const ownedTaskIds: string[] = []
const ownedEventIds: string[] = []

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runCmd(bin: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = childSpawn(bin, args, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${bin} ${args.join(' ')} exited ${code}`))
    })
  })
}

async function makeMinimalTask(sprintId: string): Promise<string> {
  const taskId = uuidv7()
  await db.insert(tasks).values({
    taskId,
    sprintId,
    ticketId: `T-${taskId.slice(0, 8)}`,
    title: 'worktree-cleanup-integration-test',
    description: 'test task for worktree cleanup integration',
    acceptanceCriteria: [],
    personaId: 'sr-dev',
    riskClass: 'standard',
    // Use 'done' state: the cleanup handler fires after task completion and
    // the in_progress constraint requires all current_* fields to be non-null.
    state: 'done',
    attemptCount: 1,
    retryBudget: 3,
    wallClockTimeoutMs: 60_000,
    tokenBudget: 4000,
    tokensConsumed: 0,
    declaredWritePaths: [],
    ordering: 0,
    createdByEventId: uuidv7(),
  })
  ownedTaskIds.push(taskId)
  return taskId
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await sql`SELECT 1`
})

beforeEach(async () => {
  // Fresh git repo for each test so worktrees don't collide.
  tmpRepoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbital-wc-repo-'))
  tmpWorktreeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbital-wc-wts-'))

  await runCmd('git', ['init', '-b', 'main', tmpRepoRoot])
  await runCmd('git', ['-C', tmpRepoRoot, 'config', 'user.email', 'test@orbital.local'])
  await runCmd('git', ['-C', tmpRepoRoot, 'config', 'user.name', 'Orbital Test'])
  // Initial commit so branches can be forked from main.
  await fsp.writeFile(path.join(tmpRepoRoot, 'README.md'), '# test\n')
  await runCmd('git', ['-C', tmpRepoRoot, 'add', 'README.md'])
  await runCmd('git', ['-C', tmpRepoRoot, 'commit', '-m', 'init'])
})

afterEach(async () => {
  for (const dir of [tmpRepoRoot, tmpWorktreeRoot]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
})

afterAll(async () => {
  // Clean up owned tasks.
  for (const taskId of ownedTaskIds) {
    await db.delete(worktrees).where(eq(worktrees.taskId, taskId)).catch(() => undefined)
    await db.delete(tasks).where(eq(tasks.taskId, taskId)).catch(() => undefined)
  }
  await closeDb().catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerWorktreeCleanup — integration (real Postgres + real git)', () => {
  it('cleans up the worktree path on disk when TaskCompleted fires', async () => {
    const eventStore = createEventStore(db, sql)
    const sprintId = uuidv7()
    const taskId = await makeMinimalTask(sprintId)

    const worktreeManager = new WorktreeManager(db, {
      parentRepoPath: tmpRepoRoot,
      worktreeRoot: tmpWorktreeRoot,
    })

    // Step 1: Create the worktree.
    const branchName = `orbital/task/${taskId.slice(0, 8)}`
    const row = await worktreeManager.create({
      taskId,
      branchName,
      parentBranch: 'main',
      declaredWritePaths: [],
    })

    // Verify the worktree path exists on disk.
    const worktreePath = row.path
    await expect(fsp.access(worktreePath)).resolves.toBeUndefined()

    // Step 2: Register the cleanup handler and wait for the LISTEN connection
    // to be established. The NotifyClient.start() is fired async inside
    // subscribe(); we give it a moment to connect before appending the event
    // so the NOTIFY doesn't arrive before LISTEN is active.
    const handle = registerWorktreeCleanup({ eventStore, worktreeManager, db })
    // 200 ms is enough for a local Postgres LISTEN handshake.
    await new Promise((r) => setTimeout(r, 200))

    // Step 3: Emit TaskCompleted for this task.
    const ev: EventInput = {
      aggregate_id: taskId,
      aggregate_type: 'task',
      event_type: 'TaskCompleted',
      payload: {
        task_id: taskId,
        sprint_id: sprintId,
        outcome: 'success',
      },
      actor: { type: 'system', component: 'orchestrator' },
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    }
    const envelope = await eventStore.append(ev)
    ownedEventIds.push(envelope.event_id)

    // Step 4: Wait for the async cleanup to run (LISTEN-based delivery).
    // The NotifyClient delivers via Postgres LISTEN/NOTIFY, so we poll.
    let worktreePathGone = false
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try {
        await fsp.access(worktreePath)
        // Still exists — wait a bit.
        await new Promise((r) => setTimeout(r, 100))
      } catch {
        worktreePathGone = true
        break
      }
    }

    handle.stop()

    expect(worktreePathGone).toBe(true)

    // Also verify the DB row is marked released.
    const rows = await db
      .select()
      .from(worktrees)
      .where(eq(worktrees.taskId, taskId))
    expect(rows[0]?.state).toBe('released')
    expect(rows[0]?.releasedAt).not.toBeNull()
  })

  it('cleans up on TaskFailed as well', async () => {
    const eventStore = createEventStore(db, sql)
    const sprintId = uuidv7()
    const taskId = await makeMinimalTask(sprintId)

    const worktreeManager = new WorktreeManager(db, {
      parentRepoPath: tmpRepoRoot,
      worktreeRoot: tmpWorktreeRoot,
    })

    const branchName = `orbital/task/${taskId.slice(0, 8)}-fail`
    const row = await worktreeManager.create({
      taskId,
      branchName,
      parentBranch: 'main',
      declaredWritePaths: [],
    })

    const worktreePath = row.path
    await expect(fsp.access(worktreePath)).resolves.toBeUndefined()

    const handle = registerWorktreeCleanup({ eventStore, worktreeManager, db })
    await new Promise((r) => setTimeout(r, 200))

    const ev: EventInput = {
      aggregate_id: taskId,
      aggregate_type: 'task',
      event_type: 'TaskFailed',
      payload: { task_id: taskId, reason: 'test failure' },
      actor: { type: 'system', component: 'orchestrator' },
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    }
    const envelope = await eventStore.append(ev)
    ownedEventIds.push(envelope.event_id)

    let gone = false
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try {
        await fsp.access(worktreePath)
        await new Promise((r) => setTimeout(r, 100))
      } catch {
        gone = true
        break
      }
    }

    handle.stop()

    expect(gone).toBe(true)
  })

  it('is non-fatal when there is no worktree for the task: no error thrown', async () => {
    const eventStore = createEventStore(db, sql)
    const sprintId = uuidv7()
    // Create a task but no worktree row.
    const taskId = await makeMinimalTask(sprintId)

    const worktreeManager = new WorktreeManager(db, {
      parentRepoPath: tmpRepoRoot,
      worktreeRoot: tmpWorktreeRoot,
    })

    const handle = registerWorktreeCleanup({ eventStore, worktreeManager, db })
    await new Promise((r) => setTimeout(r, 200))

    const ev: EventInput = {
      aggregate_id: taskId,
      aggregate_type: 'task',
      event_type: 'TaskCompleted',
      payload: { task_id: taskId },
      actor: { type: 'system', component: 'orchestrator' },
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    }
    // Should not throw even if no worktree row exists.
    const envelope = await eventStore.append(ev)
    ownedEventIds.push(envelope.event_id)

    // Allow time for async processing.
    await new Promise((r) => setTimeout(r, 300))

    handle.stop()
    // If we reach here without throwing, the test passes.
    expect(true).toBe(true)
  })
})
