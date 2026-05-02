/**
 * Unit tests for MCP tools.
 *
 * Tests each tool's handler in isolation using in-memory doubles.
 * No real Postgres connection required.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { workerHeartbeatTool } from '../../../src/mcp/tools/worker_heartbeat.js'
import { taskCompleteTool } from '../../../src/mcp/tools/task_complete.js'
import { taskFailTool } from '../../../src/mcp/tools/task_fail.js'
import { taskRequestHelpTool } from '../../../src/mcp/tools/task_request_help.js'
import type { ToolContext } from '../../../src/mcp/registry.js'
import type { CapabilityBundle } from '@orbital/types'
import type { EventStore } from '../../../src/events/store.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeBundle(overrides: Partial<CapabilityBundle> = {}): CapabilityBundle {
  return {
    capability_id: uuidv7(),
    install_id: uuidv7(),
    persona_id: 'sr-dev',
    session_id: uuidv7(),
    task_id: uuidv7(),
    sprint_id: uuidv7(),
    scopes: {
      files_read: [],
      files_write: [],
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
    issued_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    signing_key_id: uuidv7(),
    signature: 'PLACEHOLDER',
    schema_version: 1,
    ...overrides,
  }
}

function makeEventStore(): EventStore & { appended: unknown[] } {
  const appended: unknown[] = []
  return {
    appended,
    async append(event) {
      appended.push(event)
      return { ...event, event_id: uuidv7(), ingested_at: new Date().toISOString() } as never
    },
    async query() {
      return { items: [], next_cursor: null, has_more: false }
    },
    subscribe() {
      return () => {}
    },
  }
}

function makeCtx(bundle: CapabilityBundle, eventStore: EventStore): ToolContext {
  const dbSpy = {
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve()),
    })),
  }

  return {
    bundle,
    db: dbSpy as never,
    eventStore,
    traceId: uuidv7().replace(/-/g, ''),
    workerId: bundle.session_id,
  }
}

// ---------------------------------------------------------------------------
// worker.heartbeat
// ---------------------------------------------------------------------------

describe('worker.heartbeat tool', () => {
  it('emits AgentHeartbeat event with correct payload', async () => {
    const bundle = makeBundle()
    const eventStore = makeEventStore()
    const ctx = makeCtx(bundle, eventStore)
    const workerId = bundle.session_id
    const taskId = uuidv7()

    const result = await workerHeartbeatTool.handler(
      { worker_id: workerId, task_id: taskId, status: 'active', files_touched: ['src/foo.ts'] },
      ctx,
    )

    expect(result.heartbeat_id).toBeDefined()
    expect(result.received_at).toBeDefined()

    const emitted = eventStore.appended.find(
      (e: unknown) => (e as { event_type: string }).event_type === 'AgentHeartbeat',
    ) as { payload: { worker_id: string; task_id: string; status: string; files_touched: string[] } }
    expect(emitted).toBeDefined()
    expect(emitted.payload.worker_id).toBe(workerId)
    expect(emitted.payload.task_id).toBe(taskId)
    expect(emitted.payload.status).toBe('active')
    expect(emitted.payload.files_touched).toEqual(['src/foo.ts'])
  })

  it('has bypassScopeCheck=true', () => {
    expect(workerHeartbeatTool.bypassScopeCheck).toBe(true)
  })

  it('input schema validates correctly', () => {
    const valid = workerHeartbeatTool.inputSchema.safeParse({
      worker_id: uuidv7(),
      status: 'active',
    })
    expect(valid.success).toBe(true)

    const invalid = workerHeartbeatTool.inputSchema.safeParse({
      worker_id: 'not-a-uuid',
      status: 'active',
    })
    expect(invalid.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// task.complete
// ---------------------------------------------------------------------------

describe('task.complete tool', () => {
  it('emits TaskCompleted event with correct payload', async () => {
    const bundle = makeBundle()
    const eventStore = makeEventStore()
    const ctx = makeCtx(bundle, eventStore)
    const taskId = uuidv7()

    const result = await taskCompleteTool.handler(
      {
        task_id: taskId,
        summary: 'Implemented the feature',
        artifacts: [{ type: 'commit', id: 'abc123' }],
      },
      ctx,
    )

    expect(result.task_id).toBe(taskId)
    expect(result.event_id).toBeDefined()
    expect(result.completed_at).toBeDefined()

    const emitted = eventStore.appended.find(
      (e: unknown) => (e as { event_type: string }).event_type === 'TaskCompleted',
    ) as { payload: { task_id: string; output_summary: string; artifact_refs: unknown[] } }
    expect(emitted).toBeDefined()
    expect(emitted.payload.task_id).toBe(taskId)
    expect(emitted.payload.output_summary).toBe('Implemented the feature')
    expect(emitted.payload.artifact_refs).toEqual([{ type: 'commit', id: 'abc123' }])
  })

  it('has bypassScopeCheck=true', () => {
    expect(taskCompleteTool.bypassScopeCheck).toBe(true)
  })

  it('input schema rejects empty summary', () => {
    const invalid = taskCompleteTool.inputSchema.safeParse({
      task_id: uuidv7(),
      summary: '',
    })
    expect(invalid.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// task.fail
// ---------------------------------------------------------------------------

describe('task.fail tool', () => {
  it('emits TaskFailed event with correct payload', async () => {
    const bundle = makeBundle()
    const eventStore = makeEventStore()
    const ctx = makeCtx(bundle, eventStore)
    const taskId = uuidv7()

    const result = await taskFailTool.handler(
      {
        task_id: taskId,
        error_code: 'INTERNAL_LLM_PROVIDER_ERROR',
        error_message: 'Rate limited',
        retry_advice: 'retry_with_backoff',
      },
      ctx,
    )

    expect(result.task_id).toBe(taskId)
    expect(result.event_id).toBeDefined()
    expect(result.failed_at).toBeDefined()

    const emitted = eventStore.appended.find(
      (e: unknown) => (e as { event_type: string }).event_type === 'TaskFailed',
    ) as { payload: { task_id: string; error_code: string; retry_eligible: boolean } }
    expect(emitted).toBeDefined()
    expect(emitted.payload.task_id).toBe(taskId)
    expect(emitted.payload.error_code).toBe('INTERNAL_LLM_PROVIDER_ERROR')
    expect(emitted.payload.retry_eligible).toBe(true)
  })

  it('retry_advice=no_retry sets retry_eligible=false', async () => {
    const bundle = makeBundle()
    const eventStore = makeEventStore()
    const ctx = makeCtx(bundle, eventStore)

    await taskFailTool.handler(
      {
        task_id: uuidv7(),
        error_code: 'BUDGET_TASK_EXCEEDED',
        error_message: 'Budget exhausted',
        retry_advice: 'no_retry',
      },
      ctx,
    )

    const emitted = eventStore.appended.find(
      (e: unknown) => (e as { event_type: string }).event_type === 'TaskFailed',
    ) as { payload: { retry_eligible: boolean } }
    expect(emitted.payload.retry_eligible).toBe(false)
  })

  it('has bypassScopeCheck=true', () => {
    expect(taskFailTool.bypassScopeCheck).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// task.request_help
// ---------------------------------------------------------------------------

describe('task.request_help tool', () => {
  it('emits BlockerRaised event and returns blocker_id', async () => {
    const bundle = makeBundle()
    const eventStore = makeEventStore()
    const ctx = makeCtx(bundle, eventStore)
    const taskId = uuidv7()

    const result = await taskRequestHelpTool.handler(
      {
        task_id: taskId,
        blocker_kind: 'unclear_requirement',
        description: 'Need clarification on the billing logic',
      },
      ctx,
    )

    expect(result.blocker_id).toBeDefined()
    // UUIDv7 format: 8-4-4-4-12 hex groups
    expect(result.blocker_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(result.event_id).toBeDefined()
    expect(result.raised_at).toBeDefined()

    const emitted = eventStore.appended.find(
      (e: unknown) => (e as { event_type: string }).event_type === 'BlockerRaised',
    ) as { payload: { blocker_id: string; task_id: string; blocker_kind: string; description: string } }
    expect(emitted).toBeDefined()
    expect(emitted.payload.blocker_id).toBe(result.blocker_id)
    expect(emitted.payload.task_id).toBe(taskId)
    expect(emitted.payload.blocker_kind).toBe('unclear_requirement')
    expect(emitted.payload.description).toBe('Need clarification on the billing logic')
  })

  it('blocker_id is a valid UUIDv7 (time-ordered)', async () => {
    const bundle = makeBundle()
    const eventStore = makeEventStore()
    const ctx = makeCtx(bundle, eventStore)

    const r1 = await taskRequestHelpTool.handler(
      { task_id: uuidv7(), blocker_kind: 'x', description: 'first' },
      ctx,
    )
    const r2 = await taskRequestHelpTool.handler(
      { task_id: uuidv7(), blocker_kind: 'x', description: 'second' },
      ctx,
    )

    // UUIDv7 is time-ordered: later blocker has a lexicographically greater id.
    expect(r2.blocker_id > r1.blocker_id).toBe(true)
  })

  it('has bypassScopeCheck=true', () => {
    expect(taskRequestHelpTool.bypassScopeCheck).toBe(true)
  })
})
