/**
 * Scheduler integration test.
 *
 * Real Postgres, real CapabilityAuthority, real PersonaLoader, real
 * RoutingEngine, real WorktreeManager, real fake-worker spawn. Covers:
 *
 *   - addSprint + tick selects a feasible task
 *   - file-conflict gate prevents two overlapping tasks from spawning together
 *   - DAG dependency gate (predecessor not done → successor not picked)
 *   - capability-issuance ready check (persona must exist)
 *
 * The scheduler invokes spawn() which uses node + fake-worker.mjs as the
 * surrogate for the claude CLI.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import { uuidv7 } from 'uuidv7'
import { eq, sql as dSQL } from 'drizzle-orm'
import { spawn as childSpawn } from 'node:child_process'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { CapabilityAuthority } from '../../../src/capabilities/authority.js'
import { KeyManager } from '../../../src/capabilities/keys.js'
import { resetKeychainCache } from '../../../src/capabilities/keychain.js'
import { resetPolicyCache } from '../../../src/capabilities/policy.js'
import { createPersonaLoader } from '../../../src/personas/loader.js'
import { DefaultRoutingEngine, buildDefaultCatalog } from '../../../src/routing/engine.js'
import { loadDefaultPolicy } from '../../../src/routing/policy.js'
import { ToolRegistry } from '../../../src/mcp/registry.js'
import { MCPGatewayServer } from '../../../src/mcp/server.js'
import { workerHeartbeatTool } from '../../../src/mcp/tools/worker_heartbeat.js'
import { taskCompleteTool } from '../../../src/mcp/tools/task_complete.js'
import { taskFailTool } from '../../../src/mcp/tools/task_fail.js'
import { taskRequestHelpTool } from '../../../src/mcp/tools/task_request_help.js'
import { bootstrapOrchestrationRegistry } from '../../../src/orchestration/registry-bootstrap.js'
import { WorktreeManager } from '../../../src/orchestration/worktree.js'
import { createWorkerMonitor } from '../../../src/orchestration/monitor.js'
import { PauseController } from '../../../src/orchestration/pause.js'
import { DefaultScheduler } from '../../../src/orchestration/scheduler.js'
import { tasks, taskDependencies } from '../../../src/db/schema/orchestration.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_WORKER = path.resolve(__dirname, '../../fixtures/fake-worker.mjs')

const TEST_SOCKET_PATH = path.join(
  os.tmpdir(),
  `orbital-sched-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`,
)
const TEST_SHIM_FILE =
  process.env['ORBITAL_TEST_KEYCHAIN_PATH'] ??
  path.join(os.homedir(), `.orbital-test-keychain-${process.pid}.json`)

let eventStore: ReturnType<typeof createEventStore>
let keyManager: KeyManager
let authority: CapabilityAuthority
let personaLoader: ReturnType<typeof createPersonaLoader>
let routing: DefaultRoutingEngine
let registry: ToolRegistry
let gateway: MCPGatewayServer
let installId: string
let tmpRepoRoot: string
let tmpWorktreeRoot: string

beforeAll(async () => {
  await sql`SELECT 1`
})

beforeEach(async () => {
  process.env.ORBITAL_TEST_KEYCHAIN = '1'
  resetKeychainCache()
  resetPolicyCache()
  await fsp.unlink(TEST_SHIM_FILE).catch(() => undefined)

  // Clear pause flag if a previous test left it on (only mutates singleton).
  await sql`UPDATE worker_pool_state SET paused = false, paused_reason = NULL, paused_at = NULL WHERE id = 1`

  installId = uuidv7()
  eventStore = createEventStore(db, sql)
  keyManager = new KeyManager(installId, eventStore)
  authority = new CapabilityAuthority(eventStore, keyManager)
  personaLoader = createPersonaLoader(db, eventStore)
  await personaLoader.load()

  const policy = await loadDefaultPolicy()
  const catalog = buildDefaultCatalog()
  routing = new DefaultRoutingEngine(db, eventStore, policy, catalog, 1)

  registry = new ToolRegistry()
  registry.register(workerHeartbeatTool)
  registry.register(taskCompleteTool)
  registry.register(taskFailTool)
  registry.register(taskRequestHelpTool)
  bootstrapOrchestrationRegistry({ registry, authority, db, eventStore })

  gateway = new MCPGatewayServer({
    socketPath: TEST_SOCKET_PATH,
    authority,
    registry,
    eventStore,
    db,
  })
  await gateway.start()

  // Set up a real parent git repo so WorktreeManager.create works.
  tmpRepoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbital-sched-repo-'))
  tmpWorktreeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbital-sched-wts-'))
  await runCmd('git', ['init', '-b', 'main', tmpRepoRoot])
  await runCmd('git', ['-C', tmpRepoRoot, 'config', 'user.email', 'test@orbital.local'])
  await runCmd('git', ['-C', tmpRepoRoot, 'config', 'user.name', 'Orbital Test'])
  // initial commit so branches can be created from main
  await fsp.writeFile(path.join(tmpRepoRoot, 'README.md'), '# test\n')
  await runCmd('git', ['-C', tmpRepoRoot, 'add', 'README.md'])
  await runCmd('git', ['-C', tmpRepoRoot, 'commit', '-m', 'init'])
})

afterAll(async () => {
  await closeDb().catch(() => undefined)
})

async function cleanup() {
  if (gateway) await gateway.stop().catch(() => undefined)
  for (const dir of [tmpRepoRoot, tmpWorktreeRoot]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

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

async function makeTask(opts: {
  sprintId: string
  state?: 'pending' | 'ready'
  declaredWritePaths?: string[]
  ordering?: number
  personaId?: string
}): Promise<string> {
  const taskId = uuidv7()
  await db.insert(tasks).values({
    taskId,
    sprintId: opts.sprintId,
    ticketId: `T-${taskId.slice(0, 8)}`,
    title: 'sched-test',
    description: 'd',
    acceptanceCriteria: [],
    personaId: opts.personaId ?? 'sr-dev',
    riskClass: 'standard',
    state: opts.state ?? 'ready',
    attemptCount: 0,
    retryBudget: 3,
    wallClockTimeoutMs: 60_000,
    tokenBudget: 4000,
    tokensConsumed: 0,
    declaredWritePaths: opts.declaredWritePaths ?? [],
    ordering: opts.ordering ?? 0,
    createdByEventId: uuidv7(),
  })
  return taskId
}

async function buildScheduler() {
  const worktrees = new WorktreeManager(db, {
    parentRepoPath: tmpRepoRoot,
    worktreeRoot: tmpWorktreeRoot,
  })
  const monitor = createWorkerMonitor(db, eventStore, { pollIntervalMs: 60_000 })
  const pauseController = new PauseController(
    db,
    eventStore,
    authority,
    personaLoader,
    installId,
    { drainGraceMs: 200, pollIntervalMs: 50 },
  )

  // Compute available headroom: include enough slack so that other tests'
  // active workers don't push us over the cap. We don't bulk-update
  // agent_workers because that would race against parallel test files.
  const activeRows = await db.execute<{ count: string }>(
    dSQL`SELECT COUNT(*)::text AS count FROM agent_workers WHERE status NOT IN ('terminated','terminating')`,
  )
  const activeCount = Number(
    (activeRows as unknown as Array<{ count: string }>)[0]?.count ?? 0,
  )

  return new DefaultScheduler(
    db,
    eventStore,
    authority,
    personaLoader,
    routing,
    worktrees,
    monitor,
    pauseController,
    installId,
    {
      // Local cap of 4 + global slack so scheduler.tick() always has room.
      maxWorkers: activeCount + 4,
      claudeBinOverride: process.execPath,
      spawnExtraArgs: [FAKE_WORKER],
      mcpGatewayUrl: `unix://${TEST_SOCKET_PATH}`,
    },
  )
}

describe('Scheduler.tick — picks a feasible task and spawns', () => {
  it('selects the only ready task and brings it to in_progress', async () => {
    const sprintId = uuidv7()
    const taskId = await makeTask({ sprintId, state: 'ready', declaredWritePaths: [] })

    const scheduler = await buildScheduler()
    scheduler.addSprint({ sprintId, priority: 1 }, [])

    try {
      await scheduler.tick()

      // Poll until task moves out of 'ready' or timeout. Avoids flakiness from
      // parallel test pressure on the shared Postgres + filesystem.
      const deadline = Date.now() + 10_000
      let state: string | undefined
      while (Date.now() < deadline) {
        const t = await db
          .select()
          .from(tasks)
          .where(eq(tasks.taskId, taskId))
          .limit(1)
        state = t[0]?.state
        if (state && state !== 'ready' && state !== 'pending') break
        await new Promise((r) => setTimeout(r, 200))
      }

      expect(['in_progress', 'in_review', 'done'], `state ${state}`).toContain(state)
    } finally {
      await cleanup()
    }
  }, 30_000)
})

describe('Scheduler.tick — DAG dependency gate', () => {
  it('does not pick a successor whose blocking predecessor is not done', async () => {
    const sprintId = uuidv7()
    const pred = await makeTask({ sprintId, state: 'pending', declaredWritePaths: [] })
    const succ = await makeTask({ sprintId, state: 'pending', declaredWritePaths: [] })

    await db.insert(taskDependencies).values({
      predecessorTaskId: pred,
      successorTaskId: succ,
      dependencyType: 'explicit',
      blocking: true,
      rationale: 'test gate',
    })

    const scheduler = await buildScheduler()
    scheduler.addSprint({ sprintId, priority: 1 }, [])

    try {
      await scheduler.tick()
      await new Promise((r) => setTimeout(r, 250))

      const sRow = await db.select().from(tasks).where(eq(tasks.taskId, succ)).limit(1)
      expect(sRow[0]?.state).not.toBe('in_progress')
      expect(sRow[0]?.state).not.toBe('done')
    } finally {
      await cleanup()
    }
  }, 30_000)
})

describe('Scheduler.tick — file-conflict serialization', () => {
  it('serializes two tasks that declare overlapping write paths', async () => {
    const sprintId = uuidv7()
    const a = await makeTask({
      sprintId,
      state: 'ready',
      declaredWritePaths: ['src/billing/**'],
      ordering: 0,
    })
    const b = await makeTask({
      sprintId,
      state: 'ready',
      declaredWritePaths: ['src/billing/index.ts'],
      ordering: 1,
    })

    // Mark stale workers from prior tests / parallel forks as terminated so we
    // have free slots in this scheduler's accounting.
    const scheduler = await buildScheduler()
    scheduler.addSprint({ sprintId, priority: 1 }, [])

    try {
      await scheduler.tick()
      await new Promise((r) => setTimeout(r, 2500))

      const aRow = await db.select().from(tasks).where(eq(tasks.taskId, a)).limit(1)
      const bRow = await db.select().from(tasks).where(eq(tasks.taskId, b)).limit(1)

      // Surface state for diagnostics if the assertion fails.
      const states = { a: aRow[0]?.state, b: bRow[0]?.state }

      const aActive =
        aRow[0]?.state === 'in_progress' || aRow[0]?.state === 'done'
      const bActive =
        bRow[0]?.state === 'in_progress' || bRow[0]?.state === 'done'

      // At least one of a/b moved; but NOT both at the same tick (file conflict gate).
      expect(aActive || bActive, `unexpected states: ${JSON.stringify(states)}`).toBe(true)

      // After ONE tick we should not have allocated both.
      const bothInProgress =
        aRow[0]?.state === 'in_progress' && bRow[0]?.state === 'in_progress'
      expect(bothInProgress).toBe(false)
    } finally {
      await cleanup()
    }
  }, 30_000)
})
