/**
 * Integration test: inspection — tool call + LLM events aggregation
 *
 * Spawns a fake-worker that exercises 3 tool calls + 2 LLM calls.
 * Asserts all 5 events fire and inspect() returns aggregated state.
 *
 * [Engineer-Sr · Sonnet · run-round6-10-inspection]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { InspectionService } from '../../../src/inspection/service.js'
import { createInspectionEventCache } from '../../../src/inspection/service.js'
import type {
  ToolCallStartedPayload,
  ToolCallCompletedPayload,
  LLMRequestStartedPayload,
  LLMRequestCompletedPayload,
  SkillLoadedPayload,
} from '../../../src/events/types.js'
import { uuidv7 } from 'uuidv7'

// ---------------------------------------------------------------------------
// Fake event store for in-memory testing
// ---------------------------------------------------------------------------

function makeEventStore() {
  const events: Array<{ event_type: string; payload: unknown; aggregate_id: string }> = []
  const handlers: Array<(e: unknown) => void> = []

  return {
    append: vi.fn(async (ev: { event_type: string; payload: unknown; aggregate_id: string }) => {
      events.push(ev)
      const envelope = { ...ev, event_id: uuidv7(), occurred_at: new Date().toISOString(), aggregate_type: 'orchestration', actor: {}, trace_id: uuidv7(), ingested_at: new Date().toISOString(), schema_version: 1 }
      for (const h of handlers) h(envelope)
      return envelope
    }),
    query: vi.fn(async () => ({ items: [], has_more: false, next_cursor: null })),
    subscribe: vi.fn((_cursor: unknown, handler: (e: unknown) => void) => {
      handlers.push(handler)
      return () => { const i = handlers.indexOf(handler); if (i >= 0) handlers.splice(i, 1) }
    }),
    _events: events,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InspectionService — tool call + LLM event aggregation (AC #3)', () => {
  const workerId = uuidv7()
  const taskId = uuidv7()

  it('aggregates 3 tool calls + 2 LLM calls via inspect()', async () => {
    const es = makeEventStore()
    const cache = createInspectionEventCache()
    const svc = new InspectionService(es as never, cache)

    // Register worker
    svc.registerWorker(workerId, {
      taskId,
      personaId: 'sr-dev',
      personaName: 'Senior Developer',
      modelProvider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      capabilityScopes: { filesRead: ['**/*.ts'], filesWrite: ['**/*.ts'], channelPost: [] },
      capabilityExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      startedAt: new Date().toISOString(),
    })

    // Simulate 3 tool calls
    for (let i = 0; i < 3; i++) {
      const toolCallId = uuidv7()
      const startedPayload: ToolCallStartedPayload = {
        worker_id: workerId,
        tool_call_id: toolCallId,
        tool_name: `bash.run_${i}`,
        args_summary: `arg_${i}`,
        started_at: new Date().toISOString(),
      }
      await es.append({
        aggregate_id: workerId,
        aggregate_type: 'orchestration',
        event_type: 'ToolCallStarted',
        payload: startedPayload,
        actor: {},
        capability_id: undefined,
        trace_id: uuidv7(),
        occurred_at: new Date().toISOString(),
        schema_version: 1,
      } as never)

      const completedPayload: ToolCallCompletedPayload = {
        worker_id: workerId,
        tool_call_id: toolCallId,
        tool_name: `bash.run_${i}`,
        status: 'ok',
        duration_ms: 100 + i * 10,
        result_excerpt: `result_${i}`,
        completed_at: new Date().toISOString(),
      }
      await es.append({
        aggregate_id: workerId,
        aggregate_type: 'orchestration',
        event_type: 'ToolCallCompleted',
        payload: completedPayload,
        actor: {},
        capability_id: undefined,
        trace_id: uuidv7(),
        occurred_at: new Date().toISOString(),
        schema_version: 1,
      } as never)
    }

    // Simulate 2 LLM calls
    for (let i = 0; i < 2; i++) {
      const llmCallId = uuidv7()
      const llmStarted: LLMRequestStartedPayload = {
        worker_id: workerId,
        llm_call_id: llmCallId,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        started_at: new Date().toISOString(),
      }
      await es.append({
        aggregate_id: workerId,
        aggregate_type: 'orchestration',
        event_type: 'LLMRequestStarted',
        payload: llmStarted,
        actor: {},
        capability_id: undefined,
        trace_id: uuidv7(),
        occurred_at: new Date().toISOString(),
        schema_version: 1,
      } as never)

      const llmCompleted: LLMRequestCompletedPayload = {
        worker_id: workerId,
        llm_call_id: llmCallId,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        status: 'ok',
        duration_ms: 500 + i * 100,
        input_tokens: 100,
        output_tokens: 50,
        cost_usd: 0.001,
        completed_at: new Date().toISOString(),
      }
      await es.append({
        aggregate_id: workerId,
        aggregate_type: 'orchestration',
        event_type: 'LLMRequestCompleted',
        payload: llmCompleted,
        actor: {},
        capability_id: undefined,
        trace_id: uuidv7(),
        occurred_at: new Date().toISOString(),
        schema_version: 1,
      } as never)
    }

    // Simulate a skill loaded
    const skillPayload: SkillLoadedPayload = {
      worker_id: workerId,
      skill_id: 'tdd-workflow',
      loaded_at: new Date().toISOString(),
      source_sha256: 'abc123def456',
    }
    await es.append({
      aggregate_id: workerId,
      aggregate_type: 'orchestration',
      event_type: 'SkillLoaded',
      payload: skillPayload,
      actor: {},
      capability_id: undefined,
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    } as never)

    // Assert inspect() returns aggregated state
    const inspection = svc.inspect(workerId)
    expect(inspection).not.toBeNull()
    expect(inspection!.workerId).toBe(workerId)
    expect(inspection!.recentToolCalls).toHaveLength(3)
    expect(inspection!.recentLLMCalls).toHaveLength(2)
    expect(inspection!.skillsLoaded).toHaveLength(1)
    expect(inspection!.skillsLoaded[0].id).toBe('tdd-workflow')

    // All tool calls should be 'ok'
    for (const tc of inspection!.recentToolCalls) {
      expect(tc.status).toBe('ok')
    }

    // All LLM calls should have duration
    for (const llm of inspection!.recentLLMCalls) {
      expect(llm.durationMs).toBeGreaterThan(0)
      expect(llm.status).toBe('ok')
    }

    // Capability scopes present
    expect(inspection!.capability.scopes.filesRead).toContain('**/*.ts')
  })

  it('handles ToolCallCompleted with status=err for error path', async () => {
    const es = makeEventStore()
    const cache = createInspectionEventCache()
    const svc = new InspectionService(es as never, cache)

    const wId = uuidv7()
    svc.registerWorker(wId, {
      taskId: uuidv7(),
      personaId: 'qa',
      personaName: 'QA',
      modelProvider: 'anthropic',
      modelId: 'claude-haiku-3-5',
      capabilityScopes: { filesRead: [], filesWrite: [], channelPost: [] },
      capabilityExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      startedAt: new Date().toISOString(),
    })

    const toolCallId = uuidv7()
    await es.append({
      aggregate_id: wId,
      aggregate_type: 'orchestration',
      event_type: 'ToolCallStarted',
      payload: { worker_id: wId, tool_call_id: toolCallId, tool_name: 'bash.run', args_summary: 'rm -rf', started_at: new Date().toISOString() } as ToolCallStartedPayload,
      actor: {},
      capability_id: undefined,
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    } as never)

    await es.append({
      aggregate_id: wId,
      aggregate_type: 'orchestration',
      event_type: 'ToolCallCompleted',
      payload: { worker_id: wId, tool_call_id: toolCallId, tool_name: 'bash.run', status: 'err', duration_ms: 20, result_excerpt: 'Permission denied', completed_at: new Date().toISOString() } as ToolCallCompletedPayload,
      actor: {},
      capability_id: undefined,
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    } as never)

    const inspection = svc.inspect(wId)
    expect(inspection!.recentToolCalls[0].status).toBe('err')
  })

  it('timeline() returns events in order since a given timestamp', async () => {
    const es = makeEventStore()
    const cache = createInspectionEventCache()
    const svc = new InspectionService(es as never, cache)

    const wId = uuidv7()
    svc.registerWorker(wId, {
      taskId: uuidv7(),
      personaId: 'sr-dev',
      personaName: 'Senior Developer',
      modelProvider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      capabilityScopes: { filesRead: [], filesWrite: [], channelPost: [] },
      capabilityExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      startedAt: new Date().toISOString(),
    })

    const t0 = new Date().toISOString()
    const toolCallId = uuidv7()
    await es.append({
      aggregate_id: wId,
      aggregate_type: 'orchestration',
      event_type: 'ToolCallStarted',
      payload: { worker_id: wId, tool_call_id: toolCallId, tool_name: 'read', args_summary: 'file.ts', started_at: new Date().toISOString() } as ToolCallStartedPayload,
      actor: {},
      capability_id: undefined,
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    } as never)

    const timeline = svc.timeline(wId, t0)
    expect(timeline.length).toBeGreaterThanOrEqual(1)
    expect(timeline[0].event_type).toBe('ToolCallStarted')
  })
})
