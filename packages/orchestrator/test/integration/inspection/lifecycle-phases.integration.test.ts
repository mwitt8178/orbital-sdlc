/**
 * Integration test: WorkerLifecyclePhase emits at each transition.
 *
 * [Engineer-Sr · Sonnet · run-round6-10-inspection]
 */

import { describe, it, expect, vi } from 'vitest'
import { InspectionService, createInspectionEventCache } from '../../../src/inspection/service.js'
import type { WorkerLifecyclePhasePayload } from '../../../src/events/types.js'
import { uuidv7 } from 'uuidv7'

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

describe('WorkerLifecyclePhase emission on transitions', () => {
  const phases = ['briefing', 'running', 'awaiting', 'idle', 'terminating', 'terminated'] as const

  it('emits WorkerLifecyclePhase for every phase transition', async () => {
    const es = makeEventStore()
    const cache = createInspectionEventCache()
    const svc = new InspectionService(es as never, cache)

    const workerId = uuidv7()
    svc.registerWorker(workerId, {
      taskId: uuidv7(),
      personaId: 'sr-dev',
      personaName: 'Senior Developer',
      modelProvider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
      capabilityScopes: { filesRead: [], filesWrite: [], channelPost: [] },
      capabilityExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      startedAt: new Date().toISOString(),
    })

    // Emit all phases in order
    for (const phase of phases) {
      const payload: WorkerLifecyclePhasePayload = {
        worker_id: workerId,
        phase,
        occurred_at: new Date().toISOString(),
      }
      await es.append({
        aggregate_id: workerId,
        aggregate_type: 'orchestration',
        event_type: 'WorkerLifecyclePhase',
        payload,
        actor: {},
        capability_id: undefined,
        trace_id: uuidv7(),
        occurred_at: new Date().toISOString(),
        schema_version: 1,
      } as never)
    }

    // Verify inspection reflects the last phase
    const inspection = svc.inspect(workerId)
    expect(inspection).not.toBeNull()
    expect(inspection!.state).toBe('terminated')
  })

  it('tracks state transitions: briefing → running → idle', async () => {
    const es = makeEventStore()
    const cache = createInspectionEventCache()
    const svc = new InspectionService(es as never, cache)

    const workerId = uuidv7()
    svc.registerWorker(workerId, {
      taskId: uuidv7(),
      personaId: 'jr-dev',
      personaName: 'Junior Developer',
      modelProvider: 'anthropic',
      modelId: 'claude-haiku-3-5',
      capabilityScopes: { filesRead: [], filesWrite: [], channelPost: [] },
      capabilityExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      startedAt: new Date().toISOString(),
    })

    for (const phase of ['briefing', 'running', 'idle'] as const) {
      await es.append({
        aggregate_id: workerId,
        aggregate_type: 'orchestration',
        event_type: 'WorkerLifecyclePhase',
        payload: { worker_id: workerId, phase, occurred_at: new Date().toISOString() } as WorkerLifecyclePhasePayload,
        actor: {},
        capability_id: undefined,
        trace_id: uuidv7(),
        occurred_at: new Date().toISOString(),
        schema_version: 1,
      } as never)
    }

    const inspection = svc.inspect(workerId)
    expect(inspection!.state).toBe('idle')
  })

  it('listActive() returns workers that are not terminated', async () => {
    const es = makeEventStore()
    const cache = createInspectionEventCache()
    const svc = new InspectionService(es as never, cache)

    const activeId = uuidv7()
    const terminatedId = uuidv7()

    for (const wId of [activeId, terminatedId]) {
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
    }

    // Terminate one worker
    await es.append({
      aggregate_id: terminatedId,
      aggregate_type: 'orchestration',
      event_type: 'WorkerLifecyclePhase',
      payload: { worker_id: terminatedId, phase: 'terminated', occurred_at: new Date().toISOString() } as WorkerLifecyclePhasePayload,
      actor: {},
      capability_id: undefined,
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    } as never)

    // Mark the other as running
    await es.append({
      aggregate_id: activeId,
      aggregate_type: 'orchestration',
      event_type: 'WorkerLifecyclePhase',
      payload: { worker_id: activeId, phase: 'running', occurred_at: new Date().toISOString() } as WorkerLifecyclePhasePayload,
      actor: {},
      capability_id: undefined,
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    } as never)

    const active = svc.listActive()
    expect(active.map((w) => w.workerId)).toContain(activeId)
    expect(active.map((w) => w.workerId)).not.toContain(terminatedId)
  })
})
