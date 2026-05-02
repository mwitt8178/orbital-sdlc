/**
 * spawn-real-loop integration test (Round5B).
 *
 * Exercises the closed worker spawn loop end-to-end against:
 *   - Real Postgres (event store + agent_workers + tasks rows)
 *   - Real Unix-socket MCPGateway
 *   - Real signed capability bundle
 *   - A real shell-script "claude" surrogate that:
 *       * writes lines to stdout/stderr (tests WorkerOutputStream)
 *       * creates hello.txt in the worktree (tests real I/O)
 *       * connects to the MCP gateway and signals task.complete
 *
 * This is NOT a mock. The fake-claude is a real executable; the file is
 * really created; the events really land in Postgres. The only difference
 * vs production is that we substitute a shell script for the actual `claude`
 * binary so we don't burn API quota.
 *
 * Asserts:
 *   - hello.txt was created in the worktree
 *   - WorkerOutputLine events were emitted for stdout AND stderr
 *   - The WorkerOutputStream registry holds recent lines callable by the
 *     tRPC getRecentOutput query
 *   - The task transitioned to 'done'
 *   - persona.md was written when realClaude=true
 *   - Skill files were copied into .orbital/skills/
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { CapabilityAuthority } from '../../../src/capabilities/authority.js'
import { KeyManager } from '../../../src/capabilities/keys.js'
import { resetKeychainCache } from '../../../src/capabilities/keychain.js'
import { resetPolicyCache } from '../../../src/capabilities/policy.js'
import { ToolRegistry } from '../../../src/mcp/registry.js'
import { MCPGatewayServer } from '../../../src/mcp/server.js'
import { workerHeartbeatTool } from '../../../src/mcp/tools/worker_heartbeat.js'
import { taskCompleteTool } from '../../../src/mcp/tools/task_complete.js'
import { taskFailTool } from '../../../src/mcp/tools/task_fail.js'
import { taskRequestHelpTool } from '../../../src/mcp/tools/task_request_help.js'
import { bootstrapOrchestrationRegistry } from '../../../src/orchestration/registry-bootstrap.js'
import { spawn } from '../../../src/orchestration/spawn.js'
import { tasks } from '../../../src/db/schema/orchestration.js'
import { agentWorkers } from '../../../src/db/schema/worker-tables.js'
import {
  getWorkerOutputStream,
  _resetWorkerOutputRegistryForTests,
} from '../../../src/orchestration/worker-output-stream.js'
import { createPersonaLoader } from '../../../src/personas/loader.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_CLAUDE = path.resolve(__dirname, '../../fixtures/fake-claude.sh')
const FAKE_CLAUDE_BOOTSTRAP = path.resolve(
  __dirname,
  '../../fixtures/fake-claude-bootstrap.mjs',
)

const TEST_SOCKET_PATH = path.join(
  os.tmpdir(),
  `orbital-real-loop-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`,
)
const TEST_SHIM_FILE =
  process.env['ORBITAL_TEST_KEYCHAIN_PATH'] ??
  path.join(os.homedir(), `.orbital-test-keychain-real-${process.pid}.json`)

const systemActor = { type: 'system' as const, component: 'orchestrator' as const }

let eventStore: ReturnType<typeof createEventStore>
let keyManager: KeyManager
let authority: CapabilityAuthority
let registry: ToolRegistry
let gateway: MCPGatewayServer
let personaLoader: ReturnType<typeof createPersonaLoader>
let installId: string
let tmpRoot: string

beforeAll(async () => {
  await sql`SELECT 1`
})

beforeEach(async () => {
  process.env.ORBITAL_TEST_KEYCHAIN = '1'
  // The fake-claude shell expects FAKE_CLAUDE_BOOTSTRAP to point at the
  // helper that drives the MCP gateway client side. spawn() inherits
  // process.env, so this env var travels into the child.
  process.env.FAKE_CLAUDE_BOOTSTRAP = FAKE_CLAUDE_BOOTSTRAP
  // Make a fake ANTHROPIC_API_KEY so realClaude preflight passes; we do NOT
  // use the real claude binary, so the key value is never used.
  if (!process.env.ANTHROPIC_API_KEY) {
    process.env.ANTHROPIC_API_KEY = 'sk-test-fake-key-for-real-loop'
  }
  // env.ts caches the parsed env; reset so the new ANTHROPIC_API_KEY is picked up.
  // (The cache reset helper is at config/env.ts → resetEnvCache.)
  const { resetEnvCache } = await import('../../../src/config/env.js')
  resetEnvCache()

  resetKeychainCache()
  resetPolicyCache()
  _resetWorkerOutputRegistryForTests()
  await fsp.unlink(TEST_SHIM_FILE).catch(() => undefined)

  installId = uuidv7()
  eventStore = createEventStore(db, sql)
  keyManager = new KeyManager(installId, eventStore)
  authority = new CapabilityAuthority(eventStore, keyManager)
  personaLoader = createPersonaLoader(db, eventStore)
  await personaLoader.load()

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

  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'orbital-real-loop-'))
})

afterAll(async () => {
  await closeDb().catch(() => undefined)
})

async function cleanupGateway(): Promise<void> {
  if (gateway) await gateway.stop().catch(() => undefined)
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    // ignore
  }
}

describe('spawn() — real-loop with fake-claude shell', () => {
  it('writes hello.txt, emits WorkerOutputLine events, drives task to done', async () => {
    const taskId = uuidv7()
    const sprintId = uuidv7()
    const sessionId = uuidv7()

    const fakeWorktreeId = uuidv7()
    await db.insert(tasks).values({
      taskId,
      sprintId,
      ticketId: `T-${taskId.slice(0, 8)}`,
      title: 'real-loop-test',
      description: 'create a hello.txt file in the worktree',
      acceptanceCriteria: ['hello.txt exists in worktree'],
      personaId: 'sr-dev',
      riskClass: 'standard',
      state: 'in_progress',
      attemptCount: 0,
      retryBudget: 1,
      wallClockTimeoutMs: 60_000,
      tokenBudget: 4000,
      tokensConsumed: 0,
      declaredWritePaths: [],
      createdByEventId: uuidv7(),
      startedAt: new Date(),
      currentWorkerId: sessionId,
      currentCapabilityId: uuidv7(),
      currentWorktreeId: fakeWorktreeId,
    })

    const issue = await authority.issue({
      install_id: installId,
      persona_id: 'sr-dev',
      task_id: taskId,
      sprint_id: sprintId,
      session_id: sessionId,
      scopes: {
        files_read: ['*'],
        files_write: ['*'],
        board_read: [],
        board_mutate: [],
        channel_read: [],
        channel_post: [],
        secrets: [],
        network_egress: [],
        spawn_subagent: false,
        git_commit: [],
        ceremony_role: [],
      },
      ttl_ms: 60_000,
      justification: 'real loop test',
      actor: systemActor,
      trace_id: uuidv7(),
    })

    await db
      .update(tasks)
      .set({ currentCapabilityId: issue.capability_id })
      .where(eq(tasks.taskId, taskId))

    const worktreePath = path.join(tmpRoot, taskId)
    await fsp.mkdir(worktreePath, { recursive: true })

    try {
      const result = await spawn(
        {
          taskId,
          personaId: 'sr-dev',
          capability: issue.bundle,
          worktreePath,
          traceId: uuidv7(),
          model: 'claude-sonnet-4-6',
          tokenBudget: 4000,
          claudeBinOverride: FAKE_CLAUDE,
          mcpGatewayUrl: `unix://${TEST_SOCKET_PATH}`,
        },
        db,
        eventStore,
      )

      // The fake-claude script needs to know where the bootstrap helper is.
      // We set this via env on the spawn (fake-claude reads it from the
      // inherited environment). spawn.ts passes process.env through.
      // We wrote ORBITAL_* but FAKE_CLAUDE_BOOTSTRAP needs to be in
      // process.env BEFORE the spawn — set it now in the test.
      // (We can't set it after-the-fact for the running child; this test
      // sets it in beforeEach via process.env injection below.)

      // The output stream should now be registered.
      const stream = getWorkerOutputStream(sessionId)
      expect(stream).toBeDefined()

      const exit = await result.exited
      expect(exit.exitCode).toBe(0)

      // Settle: give the event-store a tick for the last writes.
      await new Promise((r) => setTimeout(r, 500))

      // hello.txt exists in worktree
      const helloContent = await fsp.readFile(
        path.join(worktreePath, 'hello.txt'),
        'utf-8',
      )
      expect(helloContent).toContain('hello')

      // AgentSpawned, TaskCompleted, WorkerOutputLine events all emitted.
      const spawnedEvts = await eventStore.query({
        event_type: 'AgentSpawned',
        aggregate_id: sessionId,
      })
      const completedEvts = await eventStore.query({
        event_type: 'TaskCompleted',
        aggregate_id: taskId,
      })
      const outputEvts = await eventStore.query({
        event_type: 'WorkerOutputLine',
        aggregate_id: sessionId,
      })

      expect(spawnedEvts.items.length).toBeGreaterThanOrEqual(1)
      expect(completedEvts.items.length).toBeGreaterThanOrEqual(1)
      expect(outputEvts.items.length).toBeGreaterThanOrEqual(1)

      // Both stdout and stderr should appear in the output events.
      const streams = new Set(
        outputEvts.items.map((e) => (e.payload as { stream: string }).stream),
      )
      expect(streams.has('stdout')).toBe(true)
      expect(streams.has('stderr')).toBe(true)

      // The recent-line buffer in the registry should hold what we just emitted.
      const recent = stream!.getRecentLines(50)
      expect(recent.length).toBeGreaterThan(0)

      // Task moved to done.
      const taskRow = await db
        .select()
        .from(tasks)
        .where(eq(tasks.taskId, taskId))
        .limit(1)
      expect(taskRow[0]?.state).toBe('done')

      // Worker terminated.
      const w = await db
        .select()
        .from(agentWorkers)
        .where(eq(agentWorkers.workerId, sessionId))
        .limit(1)
      expect(w[0]?.status).toBe('terminated')
    } finally {
      await cleanupGateway()
    }
  }, 30_000)

  it('realClaude mode writes persona.md and bundles skill files', async () => {
    // Drive the realClaude codepath without actually calling the real binary.
    // We use FAKE_CLAUDE; it will exit normally even though the args list
    // includes claude-style flags it does not understand (the script ignores
    // its arguments).
    const taskId = uuidv7()
    const sprintId = uuidv7()
    const sessionId = uuidv7()
    const fakeWorktreeId = uuidv7()

    await db.insert(tasks).values({
      taskId,
      sprintId,
      ticketId: `T-${taskId.slice(0, 8)}`,
      title: 'real-claude-mode-test',
      description: 'verify persona.md and skills/ are written before spawn',
      acceptanceCriteria: ['the worker has persona context to read'],
      personaId: 'sr-dev',
      riskClass: 'standard',
      state: 'in_progress',
      attemptCount: 0,
      retryBudget: 1,
      wallClockTimeoutMs: 60_000,
      tokenBudget: 4000,
      tokensConsumed: 0,
      declaredWritePaths: [],
      createdByEventId: uuidv7(),
      startedAt: new Date(),
      currentWorkerId: sessionId,
      currentCapabilityId: uuidv7(),
      currentWorktreeId: fakeWorktreeId,
    })

    const issue = await authority.issue({
      install_id: installId,
      persona_id: 'sr-dev',
      task_id: taskId,
      sprint_id: sprintId,
      session_id: sessionId,
      scopes: {
        files_read: ['*'], files_write: ['*'],
        board_read: [], board_mutate: [], channel_read: [], channel_post: [],
        secrets: [], network_egress: [], spawn_subagent: false,
        git_commit: [], ceremony_role: [],
      },
      ttl_ms: 60_000,
      justification: 'realClaude test',
      actor: systemActor,
      trace_id: uuidv7(),
    })
    await db.update(tasks).set({ currentCapabilityId: issue.capability_id }).where(eq(tasks.taskId, taskId))

    const worktreePath = path.join(tmpRoot, `realc-${taskId}`)
    await fsp.mkdir(worktreePath, { recursive: true })

    // Resolve the persona for the brief.
    const personas = await personaLoader.getActive()
    const srDev = personas.find((p) => p.slug === 'sr-dev')!
    expect(srDev).toBeDefined()

    const briefTask = {
      task_id: taskId,
      title: 'real-claude-mode-test',
      description: 'verify persona.md and skills/ are written',
      acceptance_criteria: ['the worker has persona context to read'],
      risk_class: 'standard',
    }
    const { buildBrief } = await import('../../../src/personas/brief.js')
    const brief = await buildBrief(srDev, briefTask, issue.bundle)

    try {
      const result = await spawn(
        {
          taskId,
          personaId: srDev.personaId,
          capability: issue.bundle,
          worktreePath,
          traceId: uuidv7(),
          model: 'claude-sonnet-4-6',
          tokenBudget: 4000,
          claudeBinOverride: FAKE_CLAUDE,
          mcpGatewayUrl: `unix://${TEST_SOCKET_PATH}`,
          realClaude: {
            persona: srDev,
            task: briefTask,
            brief,
          },
        },
        db,
        eventStore,
      )

      // persona.md was written before spawn
      const personaMd = await fsp.readFile(
        path.join(worktreePath, '.orbital', 'persona.md'),
        'utf-8',
      )
      expect(personaMd).toContain('Senior Developer')

      // Skills directory has the persona's referenced skills (with aliases resolved)
      const skillsDir = path.join(worktreePath, '.orbital', 'skills')
      const files = await fsp.readdir(skillsDir)
      expect(files.length).toBeGreaterThan(0)
      // sr-dev declares tdd-cycle, code-review-checklist, conventional-commits
      // tdd-cycle aliases to tdd-workflow.md content; conventional-commits
      // aliases to commit-message-conventions.md content.
      expect(files).toContain('tdd-cycle.md')
      expect(files).toContain('conventional-commits.md')

      // Spawn result reports them
      expect(result.copiedSkills?.length ?? 0).toBeGreaterThan(0)

      const exit = await result.exited
      expect(exit.exitCode).toBe(0)
    } finally {
      await cleanupGateway()
    }
  }, 30_000)
})
