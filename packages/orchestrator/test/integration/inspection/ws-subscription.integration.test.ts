/**
 * Integration test: WS subscription delivers inspection events in real time.
 *
 * Acceptance Criterion #4 (architecture.md):
 *   "Live update: WS subscription emits ≥1 event when worker performs
 *    new tool call."
 *
 * Test strategy:
 *   1. Boot a real Fastify + @fastify/websocket server wired to WebSocketHub.
 *   2. Connect a real ws WebSocket client.
 *   3. Subscribe to inspection:worker:<workerId> and inspection:active.
 *   4. Directly append ToolCallStarted + ToolCallCompleted events via
 *      PostgresEventStore (real Postgres via LISTEN/NOTIFY — same path as
 *      production code).
 *   5. Assert both WS messages arrive within 2 s with the correct event_type.
 *
 * No mocks in src/. Real Postgres, real WS server, real hub fan-out.
 *
 * [Engineer-Sr · Sonnet · run-round6-10-inspection-followup]
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import Fastify from 'fastify'
import websocketPlugin from '@fastify/websocket'
import WebSocket from 'ws'
import { PostgresEventStore } from '../../../src/events/store.js'
import { WebSocketHub } from '../../../src/ws/hub.js'
import type { Actor } from '@orbital/types'
import type { AddressInfo } from 'node:net'
import type {
  ToolCallStartedPayload,
  ToolCallCompletedPayload,
} from '../../../src/events/types.js'

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgres://orbital:orbital@localhost:5432/orbital'

let sqlPool: postgres.Sql
let store: PostgresEventStore
let hub: WebSocketHub
let app: ReturnType<typeof Fastify>
let port: number

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }

beforeAll(async () => {
  sqlPool = postgres(DATABASE_URL, { max: 5, idle_timeout: 15, onnotice: () => {} })
  const db = drizzle(sqlPool)
  store = new PostgresEventStore(db, sqlPool)
  hub = new WebSocketHub(store)
  app = Fastify({ logger: false })
  await app.register(websocketPlugin)
  app.get('/ws', { websocket: true }, (socket) => {
    hub.handleConnection(socket as unknown as WebSocket)
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const addr = app.server.address() as AddressInfo
  port = addr.port
  await hub.start()
}, 30_000)

afterAll(async () => {
  await hub.stop()
  await app.close()
  await store.stopNotifyClient()
  await sqlPool.end({ timeout: 5 })
})

// ---------------------------------------------------------------------------

/**
 * Wait for a WS message matching the given predicate within `timeoutMs`.
 * Returns the message or throws on timeout.
 */
function waitForMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`WS message timeout after ${timeoutMs}ms`)), timeoutMs)
    const onMsg = (raw: WebSocket.RawData): void => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>
      } catch {
        return
      }
      if (predicate(msg)) {
        clearTimeout(t)
        ws.off('message', onMsg)
        resolve(msg)
      }
    }
    ws.on('message', onMsg)
  })
}

/**
 * Drain the hello ack from a fresh WS connection.
 */
async function drainHello(ws: WebSocket): Promise<void> {
  await waitForMessage(
    ws,
    (m) =>
      m['ws_type'] === 'ack' &&
      (m['payload'] as Record<string, unknown>)?.['connected'] === true,
    5000,
  )
}

// ---------------------------------------------------------------------------

describe('WS hub — inspection:worker:<id> subscription (AC #4)', () => {
  it('delivers ToolCallStarted + ToolCallCompleted to a subscribed client', async () => {
    const workerId = uuidv7()
    const toolCallId = uuidv7()
    const traceBase = `ws-inspection-test-${workerId.slice(0, 8)}`

    // Connect + drain hello
    const ws = (await app.injectWS('/ws')) as unknown as WebSocket
    await drainHello(ws)

    // Subscribe to this worker's inspection channel
    ws.send(
      JSON.stringify({
        type: 'subscribe',
        channel_ids: [`inspection:worker:${workerId}`, 'inspection:active'],
      }),
    )
    const subAck = await waitForMessage(ws, (m) => m['ws_type'] === 'ack', 3000)
    const subPayload = subAck['payload'] as Record<string, unknown>
    expect(Array.isArray(subPayload['subscribed_inspection'])).toBe(true)
    expect(subPayload['subscribed_inspection']).toContain(`inspection:worker:${workerId}`)

    // Set up listeners BEFORE appending events
    const toolCallStartedPromise = waitForMessage(ws, (m) => {
      if (m['ws_type'] !== 'event') return false
      const p = m['payload'] as Record<string, unknown>
      return (
        p['event_type'] === 'ToolCallStarted' &&
        (p['aggregate_id'] as string) === workerId
      )
    }, 2000)

    const toolCallCompletedPromise = waitForMessage(ws, (m) => {
      if (m['ws_type'] !== 'event') return false
      const p = m['payload'] as Record<string, unknown>
      return (
        p['event_type'] === 'ToolCallCompleted' &&
        (p['aggregate_id'] as string) === workerId
      )
    }, 2000)

    // Append ToolCallStarted via real event store (fires NOTIFY → hub receives
    // via LISTEN → fans out to subscribed WS connections)
    const startedPayload: ToolCallStartedPayload = {
      worker_id: workerId,
      tool_call_id: toolCallId,
      tool_name: 'bash.run',
      args_summary: 'ls /tmp',
      started_at: new Date().toISOString(),
    }
    await store.append({
      aggregate_id: workerId,
      aggregate_type: 'orchestration',
      event_type: 'ToolCallStarted',
      payload: startedPayload as unknown as Record<string, unknown>,
      actor: SYSTEM_ACTOR,
      trace_id: `${traceBase}-started`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    // Append ToolCallCompleted
    const completedPayload: ToolCallCompletedPayload = {
      worker_id: workerId,
      tool_call_id: toolCallId,
      tool_name: 'bash.run',
      status: 'ok',
      duration_ms: 42,
      result_excerpt: '/tmp/orbital',
      completed_at: new Date().toISOString(),
    }
    await store.append({
      aggregate_id: workerId,
      aggregate_type: 'orchestration',
      event_type: 'ToolCallCompleted',
      payload: completedPayload as unknown as Record<string, unknown>,
      actor: SYSTEM_ACTOR,
      trace_id: `${traceBase}-completed`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    // Assert both messages arrived
    const startedMsg = await toolCallStartedPromise
    expect(startedMsg['ws_type']).toBe('event')
    const startedEvt = startedMsg['payload'] as Record<string, unknown>
    expect(startedEvt['event_type']).toBe('ToolCallStarted')
    expect(startedEvt['aggregate_id']).toBe(workerId)
    const startedData = startedEvt['payload'] as Record<string, unknown>
    expect(startedData['tool_name']).toBe('bash.run')
    expect(startedData['tool_call_id']).toBe(toolCallId)

    const completedMsg = await toolCallCompletedPromise
    expect(completedMsg['ws_type']).toBe('event')
    const completedEvt = completedMsg['payload'] as Record<string, unknown>
    expect(completedEvt['event_type']).toBe('ToolCallCompleted')
    expect(completedEvt['aggregate_id']).toBe(workerId)
    const completedData = completedEvt['payload'] as Record<string, unknown>
    expect(completedData['status']).toBe('ok')
    expect(completedData['duration_ms']).toBe(42)

    ws.close()
  })

  it('delivers inspection events to inspection:active subscriber', async () => {
    const workerId = uuidv7()
    const toolCallId = uuidv7()
    const traceBase = `ws-inspection-active-${workerId.slice(0, 8)}`

    const ws = (await app.injectWS('/ws')) as unknown as WebSocket
    await drainHello(ws)

    // Subscribe to inspection:active only (not worker-specific)
    ws.send(
      JSON.stringify({
        type: 'subscribe',
        channel_ids: ['inspection:active'],
      }),
    )
    await waitForMessage(ws, (m) => m['ws_type'] === 'ack', 3000)

    // Listen for ToolCallStarted
    const eventPromise = waitForMessage(ws, (m) => {
      if (m['ws_type'] !== 'event') return false
      const p = m['payload'] as Record<string, unknown>
      return (
        p['event_type'] === 'ToolCallStarted' &&
        (p['aggregate_id'] as string) === workerId
      )
    }, 2000)

    const startedPayload: ToolCallStartedPayload = {
      worker_id: workerId,
      tool_call_id: toolCallId,
      tool_name: 'edit.file',
      args_summary: 'src/index.ts',
      started_at: new Date().toISOString(),
    }
    await store.append({
      aggregate_id: workerId,
      aggregate_type: 'orchestration',
      event_type: 'ToolCallStarted',
      payload: startedPayload as unknown as Record<string, unknown>,
      actor: SYSTEM_ACTOR,
      trace_id: `${traceBase}-started`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    const eventMsg = await eventPromise
    expect(eventMsg['ws_type']).toBe('event')
    const evt = eventMsg['payload'] as Record<string, unknown>
    expect(evt['event_type']).toBe('ToolCallStarted')
    expect(evt['aggregate_id']).toBe(workerId)

    ws.close()
  })
})

describe('WS hub — WorkerKilledByOperator fan-out (AC #6)', () => {
  it('delivers WorkerKilledByOperator to inspection:active subscriber', async () => {
    const workerId = uuidv7()
    const traceBase = `ws-kill-${workerId.slice(0, 8)}`

    const ws = (await app.injectWS('/ws')) as unknown as WebSocket
    await drainHello(ws)

    ws.send(
      JSON.stringify({
        type: 'subscribe',
        channel_ids: ['inspection:active', `inspection:worker:${workerId}`],
      }),
    )
    await waitForMessage(ws, (m) => m['ws_type'] === 'ack', 3000)

    const killPromise = waitForMessage(ws, (m) => {
      if (m['ws_type'] !== 'event') return false
      const p = m['payload'] as Record<string, unknown>
      return (
        p['event_type'] === 'WorkerKilledByOperator' &&
        (p['aggregate_id'] as string) === workerId
      )
    }, 2000)

    await store.append({
      aggregate_id: workerId,
      aggregate_type: 'orchestration',
      event_type: 'WorkerKilledByOperator',
      payload: {
        worker_id: workerId,
        operator_id: 'test-install',
        reason: 'test_kill',
        killed_at: new Date().toISOString(),
      } as unknown as Record<string, unknown>,
      actor: SYSTEM_ACTOR,
      trace_id: `${traceBase}-killed`,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })

    const killMsg = await killPromise
    expect(killMsg['ws_type']).toBe('event')
    const killEvt = killMsg['payload'] as Record<string, unknown>
    expect(killEvt['event_type']).toBe('WorkerKilledByOperator')
    expect(killEvt['aggregate_id']).toBe(workerId)

    ws.close()
  })
})
