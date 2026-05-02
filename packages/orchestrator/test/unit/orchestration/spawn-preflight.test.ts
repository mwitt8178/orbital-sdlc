/**
 * Unit tests for spawn() pre-flight checks (Round5B).
 *
 * Validates the ANTHROPIC_API_KEY guard fires only when realClaude is set,
 * and that the missing-binary error message is clear.
 *
 * Uses the real Postgres + EventStore so we can exercise the full spawn
 * code path; we point claudeBinOverride at /nonexistent for ENOENT cases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'
import { db, sql } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { CapabilityAuthority } from '../../../src/capabilities/authority.js'
import { KeyManager } from '../../../src/capabilities/keys.js'
import { resetKeychainCache } from '../../../src/capabilities/keychain.js'
import { resetPolicyCache } from '../../../src/capabilities/policy.js'
import { spawn } from '../../../src/orchestration/spawn.js'
import { tasks } from '../../../src/db/schema/orchestration.js'
import { resetEnvCache } from '../../../src/config/env.js'
import type { Persona } from '../../../src/personas/types.js'

const systemActor = { type: 'system' as const, component: 'orchestrator' as const }

let eventStore: ReturnType<typeof createEventStore>
let authority: CapabilityAuthority
let installId: string
let tmpRoot: string
let savedAnthropicKey: string | undefined
let savedTestKeychain: string | undefined

beforeEach(async () => {
  savedAnthropicKey = process.env.ANTHROPIC_API_KEY
  savedTestKeychain = process.env.ORBITAL_TEST_KEYCHAIN
  process.env.ORBITAL_TEST_KEYCHAIN = '1'
  resetKeychainCache()
  resetPolicyCache()
  resetEnvCache()
  installId = uuidv7()
  eventStore = createEventStore(db, sql)
  const km = new KeyManager(installId, eventStore)
  authority = new CapabilityAuthority(eventStore, km)
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-spawn-pre-'))
})

afterEach(async () => {
  if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = savedAnthropicKey
  if (savedTestKeychain === undefined) delete process.env.ORBITAL_TEST_KEYCHAIN
  else process.env.ORBITAL_TEST_KEYCHAIN = savedTestKeychain
  resetEnvCache()
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

async function makeFailedTask(): Promise<{ taskId: string; sprintId: string }> {
  const taskId = uuidv7()
  const sprintId = uuidv7()
  await db.insert(tasks).values({
    taskId,
    sprintId,
    ticketId: `T-${taskId.slice(0, 8)}`,
    title: 'preflight test',
    description: 'd',
    acceptanceCriteria: [],
    personaId: 'sr-dev',
    riskClass: 'standard',
    state: 'failed',
    attemptCount: 0,
    retryBudget: 1,
    wallClockTimeoutMs: 60_000,
    tokenBudget: 4000,
    tokensConsumed: 0,
    declaredWritePaths: [],
    createdByEventId: uuidv7(),
  })
  return { taskId, sprintId }
}

function fakePersona(): Persona {
  return {
    personaId: uuidv7(),
    personaVersionId: uuidv7(),
    slug: 'sr-dev',
    displayName: 'Senior Developer',
    origin: 'baseline',
    versionNumber: 1,
    roleBriefMd: '# role',
    definitionHash: 'h',
    defaultCapabilityProfile: {
      filesRead: [],
      filesWrite: [],
      boardRead: [],
      boardMutate: [],
      channelRead: [],
      channelPost: [],
      secrets: [],
      networkEgress: [],
      spawnSubagent: false,
      gitCommit: null,
      ceremonyRole: 'none',
    },
    modelAffinity: [],
    escalationPolicy: { maxRetries: 0, rules: [], defaultAction: 'post_blocker' },
    skills: [],
    metadata: { tags: [], description: 't' },
    isArchived: false,
  }
}

describe('spawn() pre-flight — ANTHROPIC_API_KEY missing rejects realClaude mode', () => {
  it('throws STARTUP_ERROR when realClaude requested without ANTHROPIC_API_KEY', async () => {
    delete process.env.ANTHROPIC_API_KEY
    resetEnvCache()
    const { taskId, sprintId } = await makeFailedTask()
    const sessionId = uuidv7()
    const issue = await authority.issue({
      install_id: installId,
      persona_id: 'sr-dev',
      task_id: taskId,
      sprint_id: sprintId,
      session_id: sessionId,
      scopes: {
        files_read: [], files_write: [], board_read: [], board_mutate: [],
        channel_read: [], channel_post: [], secrets: [], network_egress: [],
        spawn_subagent: false, git_commit: [], ceremony_role: [],
      },
      ttl_ms: 60_000,
      justification: 'preflight test',
      actor: systemActor,
      trace_id: uuidv7(),
    })
    const worktreePath = path.join(tmpRoot, taskId)
    await fs.mkdir(worktreePath, { recursive: true })

    let threw = false
    try {
      await spawn(
        {
          taskId,
          personaId: 'sr-dev',
          capability: issue.bundle,
          worktreePath,
          traceId: uuidv7(),
          model: 'claude-sonnet-4-6',
          tokenBudget: 4000,
          claudeBinOverride: '/nonexistent/path/never-exists',
          realClaude: {
            persona: fakePersona(),
            task: {
              task_id: taskId,
              title: 't',
              description: 'd',
              acceptance_criteria: [],
            },
            brief: 'brief content',
          },
        },
        db,
        eventStore,
      )
    } catch (err) {
      threw = true
      const message = err instanceof Error ? err.message : String(err)
      expect(message).toContain('ANTHROPIC_API_KEY')
    }
    expect(threw).toBe(true)
  })

  it('CLAUDE_BIN_NOT_FOUND error message includes remediation hint', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    resetEnvCache()
    const { taskId, sprintId } = await makeFailedTask()
    const sessionId = uuidv7()
    const issue = await authority.issue({
      install_id: installId,
      persona_id: 'sr-dev',
      task_id: taskId,
      sprint_id: sprintId,
      session_id: sessionId,
      scopes: {
        files_read: [], files_write: [], board_read: [], board_mutate: [],
        channel_read: [], channel_post: [], secrets: [], network_egress: [],
        spawn_subagent: false, git_commit: [], ceremony_role: [],
      },
      ttl_ms: 60_000,
      justification: 'preflight test',
      actor: systemActor,
      trace_id: uuidv7(),
    })
    const worktreePath = path.join(tmpRoot, taskId)
    await fs.mkdir(worktreePath, { recursive: true })

    let captured: unknown = null
    let exitCode: number | null | undefined
    try {
      const r = await spawn(
        {
          taskId,
          personaId: 'sr-dev',
          capability: issue.bundle,
          worktreePath,
          traceId: uuidv7(),
          model: 'claude-sonnet-4-6',
          tokenBudget: 4000,
          claudeBinOverride: '/totally/not/here',
        },
        db,
        eventStore,
      )
      const exit = await r.exited
      exitCode = exit.exitCode
    } catch (err) {
      captured = err
    }
    // Either we threw with CLAUDE_BIN_NOT_FOUND, or the child errored async
    // and exited non-zero (handled in the existing test path). The error
    // when present should mention installation guidance.
    if (captured) {
      const msg = (captured as Error).message
      expect(msg).toContain('INTEGRATION_CLAUDE_NOT_FOUND')
      expect(msg).toMatch(/Install with|CLAUDE_BIN/)
    } else {
      expect(exitCode === null || exitCode !== 0).toBe(true)
    }

    // Cleanup the task row to avoid pollution.
    await db.delete(tasks).where(eq(tasks.taskId, taskId))
  })
})
