/**
 * MCPGateway integration test.
 *
 * Real Postgres, real keychain shim, real Ed25519 signatures, real EventStore,
 * real Unix socket. Uses node:net to act as the worker client.
 *
 * Test scenarios:
 * 1. Happy path: connect with valid signed bundle → worker.heartbeat → success.
 * 2. Expired bundle: connect with expired bundle → AUTH_CAPABILITY_EXPIRED.
 * 3. CapabilityDenied on deny path: scope-checked tool with insufficient scope.
 * 4. task.complete: emits TaskCompleted event, verifiable in DB.
 * 5. task.fail: emits TaskFailed event.
 * 6. task.request_help: emits BlockerRaised, returns blocker_id.
 * 7. Verify CapabilityDenied event written to DB after expired bundle rejection.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
import {
  agentWorkers,
  workerHeartbeats,
} from '../../../src/db/schema/worker-tables.js'
import { capabilityDenials } from '../../../src/db/schema/capabilities.js'
import type { Actor, Scopes } from '@orbital/types'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const TEST_SOCKET_PATH = path.join(os.tmpdir(), `orbital-mcp-test-${process.pid}.sock`)
const TEST_SHIM_FILE =
  process.env['ORBITAL_TEST_KEYCHAIN_PATH'] ??
  path.join(os.homedir(), `.orbital-test-keychain-${process.pid}.json`)

const systemActor: Actor = { type: 'system', component: 'mcp_gateway' }

const FULL_SCOPES: Scopes = {
  files_read: ['src/**'],
  files_write: ['src/**'],
  board_read: ['ticket:ORB-1'],
  board_mutate: [],
  channel_read: ['#test'],
  channel_post: ['#test'],
  secrets: [],
  network_egress: [],
  spawn_subagent: false,
  git_commit: [],
  ceremony_role: [],
}

let eventStore: ReturnType<typeof createEventStore>
let keyManager: KeyManager
let authority: CapabilityAuthority
let registry: ToolRegistry
let gateway: MCPGatewayServer
let installId: string

beforeAll(async () => {
  await sql`SELECT 1` // verify DB reachable
})

beforeEach(async () => {
  process.env.ORBITAL_TEST_KEYCHAIN = '1'
  resetKeychainCache()
  resetPolicyCache()
  await fsp.unlink(TEST_SHIM_FILE).catch(() => undefined)

  installId = uuidv7()
  eventStore = createEventStore(db, sql)
  keyManager = new KeyManager(installId, eventStore)
  authority = new CapabilityAuthority(eventStore, keyManager)

  registry = new ToolRegistry()
  registry.register(workerHeartbeatTool)
  registry.register(taskCompleteTool)
  registry.register(taskFailTool)
  registry.register(taskRequestHelpTool)

  gateway = new MCPGatewayServer({
    socketPath: TEST_SOCKET_PATH,
    authority,
    registry,
    eventStore,
    db,
  })
  await gateway.start()
})

afterAll(async () => {
  await closeDb().catch(() => undefined)
})

// Stop gateway after each test.
const cleanupAfterEach = async () => {
  if (gateway) {
    await gateway.stop().catch(() => undefined)
  }
}

// ---------------------------------------------------------------------------
// Socket client helper
// ---------------------------------------------------------------------------

/**
 * Send a single JSON-RPC message and receive the response line.
 */
function sendRequest(
  socket: net.Socket,
  message: object,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      // Last element is either empty or incomplete.
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i]!.trim()
        if (line) {
          socket.off('data', onData)
          try {
            resolve(JSON.parse(line))
          } catch {
            reject(new Error(`Invalid JSON response: ${line}`))
          }
          return
        }
      }
      buffer = lines[lines.length - 1] ?? ''
    }
    socket.on('data', onData)
    socket.write(JSON.stringify(message) + '\n')

    setTimeout(() => {
      socket.off('data', onData)
      reject(new Error(`Timeout waiting for response to: ${JSON.stringify(message)}`))
    }, 5000)
  })
}

async function connectSocket(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(TEST_SOCKET_PATH)
    socket.on('connect', () => resolve(socket))
    socket.on('error', reject)
    setTimeout(() => reject(new Error('Connection timeout')), 3000)
  })
}

async function closeSocket(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    socket.destroy()
    socket.on('close', resolve)
    // Force close after short wait.
    setTimeout(resolve, 100)
  })
}

// ---------------------------------------------------------------------------
// Issue a real signed bundle using CapabilityAuthority
// ---------------------------------------------------------------------------

async function issueBundle(
  ttl_ms = 60_000,
  scopeOverrides?: Partial<Scopes>,
) {
  const sessionId = uuidv7()
  const taskId = uuidv7()
  const sprintId = uuidv7()
  const scopes = { ...FULL_SCOPES, ...scopeOverrides }

  const result = await authority.issue({
    install_id: installId,
    persona_id: 'sr-dev',
    task_id: taskId,
    sprint_id: sprintId,
    session_id: sessionId,
    scopes,
    ttl_ms,
    justification: 'Integration test bundle',
    actor: systemActor,
    trace_id: uuidv7().replace(/-/g, ''),
  })

  return { bundle: result.bundle, taskId, sprintId, sessionId }
}

// ---------------------------------------------------------------------------
// Test: gateway socket path exposed
// ---------------------------------------------------------------------------

it('MCPGateway.socketPath matches the configured path', async () => {
  expect(gateway.socketPath).toBe(TEST_SOCKET_PATH)
  await cleanupAfterEach()
})

// ---------------------------------------------------------------------------
// Test: happy path — connect + worker.heartbeat
// ---------------------------------------------------------------------------

describe('happy path: connect + worker.heartbeat', () => {
  it('connects with valid bundle and heartbeats successfully', async () => {
    const { bundle, sessionId, taskId } = await issueBundle()

    // Insert a worker row so the update in worker.heartbeat has a target.
    await db.insert(agentWorkers).values({
      workerId: sessionId,
      personaId: bundle.persona_id,
      sessionId: sessionId,
      taskId: taskId,
      capabilityId: bundle.capability_id,
      status: 'connecting',
      startedAt: new Date(),
    })

    const socket = await connectSocket()

    try {
      // Step 1: send connect request.
      const connectRes = await sendRequest(socket, {
        jsonrpc: '2.0',
        id: 1,
        method: 'connect',
        params: { bundle },
      })
      expect(connectRes['error']).toBeUndefined()
      expect((connectRes['result'] as { connected: boolean }).connected).toBe(true)

      // Step 2: send worker.heartbeat.
      const hbRes = await sendRequest(socket, {
        jsonrpc: '2.0',
        id: 2,
        method: 'worker.heartbeat',
        params: {
          worker_id: sessionId,
          task_id: taskId,
          status: 'active',
          files_touched: ['src/billing/index.ts'],
        },
      })
      expect(hbRes['error']).toBeUndefined()
      const hbResult = hbRes['result'] as { heartbeat_id: string; received_at: string }
      expect(hbResult.heartbeat_id).toBeDefined()
      expect(hbResult.received_at).toBeDefined()

      // Verify heartbeat row written to DB.
      const hbRows = await db
        .select()
        .from(workerHeartbeats)
        .where(eq(workerHeartbeats.workerId, sessionId))
      expect(hbRows.length).toBeGreaterThan(0)
      const hbRow = hbRows[0]!
      expect(hbRow.status).toBe('active')
      expect(hbRow.workerId).toBe(sessionId)

      // Verify AgentHeartbeat event in event store.
      const events = await eventStore.query({
        event_type: 'AgentHeartbeat',
        aggregate_id: sessionId,
      })
      expect(events.items.length).toBeGreaterThan(0)
    } finally {
      await closeSocket(socket)
      await cleanupAfterEach()
    }
  })
})

// ---------------------------------------------------------------------------
// Test: expired bundle → AUTH_CAPABILITY_EXPIRED
// ---------------------------------------------------------------------------

describe('expired bundle rejection', () => {
  it('returns AUTH_CAPABILITY_EXPIRED and writes CapabilityDenied event', async () => {
    // Issue bundle with TTL that places expiry well beyond the 30s clock-skew
    // tolerance (O8). TTL of -90_000ms means expires_at = issued_at - 90s,
    // so the bundle is already 90s expired — outside the 30s acceptance window.
    const { bundle } = await issueBundle(-90_000)

    const socket = await connectSocket()
    try {
      const connectRes = await sendRequest(socket, {
        jsonrpc: '2.0',
        id: 1,
        method: 'connect',
        params: { bundle },
      })

      expect(connectRes['error']).toBeDefined()
      const err = connectRes['error'] as { code: number; data: { code: string } }
      expect(err.data.code).toBe('AUTH_CAPABILITY_EXPIRED')

      // Verify CapabilityDenied event in DB.
      // Allow a short delay for async event write.
      await new Promise((r) => setTimeout(r, 200))

      const denialRows = await db
        .select()
        .from(capabilityDenials)
        .where(eq(capabilityDenials.capability_id, bundle.capability_id))
      expect(denialRows.length).toBeGreaterThan(0)
      expect(denialRows[0]!.reason_code).toBe('AUTH_CAPABILITY_EXPIRED')
    } finally {
      await closeSocket(socket)
      await cleanupAfterEach()
    }
  })
})

// ---------------------------------------------------------------------------
// Test: task.complete — emits TaskCompleted event
// ---------------------------------------------------------------------------

describe('task.complete', () => {
  it('emits TaskCompleted event and returns event_id', async () => {
    const { bundle, taskId, sessionId } = await issueBundle()

    // Insert worker row.
    await db.insert(agentWorkers).values({
      workerId: sessionId,
      personaId: bundle.persona_id,
      sessionId,
      taskId,
      capabilityId: bundle.capability_id,
      status: 'active',
      startedAt: new Date(),
    })

    const socket = await connectSocket()
    try {
      await sendRequest(socket, {
        jsonrpc: '2.0',
        id: 1,
        method: 'connect',
        params: { bundle },
      })

      const res = await sendRequest(socket, {
        jsonrpc: '2.0',
        id: 2,
        method: 'task.complete',
        params: {
          task_id: taskId,
          summary: 'Feature implemented successfully',
          artifacts: [{ type: 'commit', id: 'deadbeef' }],
        },
      })

      expect(res['error']).toBeUndefined()
      const result = res['result'] as { task_id: string; event_id: string; completed_at: string }
      expect(result.task_id).toBe(taskId)
      expect(result.event_id).toBeDefined()

      // Verify event in store.
      const events = await eventStore.query({
        event_type: 'TaskCompleted',
        aggregate_id: taskId,
      })
      expect(events.items.length).toBeGreaterThan(0)
    } finally {
      await closeSocket(socket)
      await cleanupAfterEach()
    }
  })
})

// ---------------------------------------------------------------------------
// Test: task.fail — emits TaskFailed event
// ---------------------------------------------------------------------------

describe('task.fail', () => {
  it('emits TaskFailed event with correct payload', async () => {
    const { bundle, taskId, sessionId } = await issueBundle()

    await db.insert(agentWorkers).values({
      workerId: sessionId,
      personaId: bundle.persona_id,
      sessionId,
      taskId,
      capabilityId: bundle.capability_id,
      status: 'active',
      startedAt: new Date(),
    })

    const socket = await connectSocket()
    try {
      await sendRequest(socket, {
        jsonrpc: '2.0',
        id: 1,
        method: 'connect',
        params: { bundle },
      })

      const res = await sendRequest(socket, {
        jsonrpc: '2.0',
        id: 2,
        method: 'task.fail',
        params: {
          task_id: taskId,
          error_code: 'INTERNAL_LLM_PROVIDER_ERROR',
          error_message: 'Rate limited',
          retry_advice: 'retry_with_backoff',
        },
      })

      expect(res['error']).toBeUndefined()
      const result = res['result'] as { task_id: string; event_id: string }
      expect(result.task_id).toBe(taskId)

      const events = await eventStore.query({
        event_type: 'TaskFailed',
        aggregate_id: taskId,
      })
      expect(events.items.length).toBeGreaterThan(0)
      expect(events.items[0]!.payload['error_code']).toBe('INTERNAL_LLM_PROVIDER_ERROR')
    } finally {
      await closeSocket(socket)
      await cleanupAfterEach()
    }
  })
})

// ---------------------------------------------------------------------------
// Test: task.request_help — emits BlockerRaised, returns blocker_id
// ---------------------------------------------------------------------------

describe('task.request_help', () => {
  it('emits BlockerRaised and returns a UUIDv7 blocker_id', async () => {
    const { bundle, taskId, sessionId } = await issueBundle()

    await db.insert(agentWorkers).values({
      workerId: sessionId,
      personaId: bundle.persona_id,
      sessionId,
      taskId,
      capabilityId: bundle.capability_id,
      status: 'active',
      startedAt: new Date(),
    })

    const socket = await connectSocket()
    try {
      await sendRequest(socket, {
        jsonrpc: '2.0',
        id: 1,
        method: 'connect',
        params: { bundle },
      })

      const res = await sendRequest(socket, {
        jsonrpc: '2.0',
        id: 2,
        method: 'task.request_help',
        params: {
          task_id: taskId,
          blocker_kind: 'unclear_requirement',
          description: 'Need clarification on the billing model',
        },
      })

      expect(res['error']).toBeUndefined()
      const result = res['result'] as { blocker_id: string; event_id: string; raised_at: string }
      expect(result.blocker_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )

      const events = await eventStore.query({
        event_type: 'BlockerRaised',
        aggregate_id: result.blocker_id,
      })
      expect(events.items.length).toBe(1)
      expect(events.items[0]!.payload['blocker_kind']).toBe('unclear_requirement')
    } finally {
      await closeSocket(socket)
      await cleanupAfterEach()
    }
  })
})

// ---------------------------------------------------------------------------
// Test: no connect → subsequent calls fail with NOT_CONNECTED
// ---------------------------------------------------------------------------

describe('connect discipline', () => {
  it('rejects tool calls before connect', async () => {
    const socket = await connectSocket()
    try {
      const res = await sendRequest(socket, {
        jsonrpc: '2.0',
        id: 1,
        method: 'worker.heartbeat',
        params: { worker_id: uuidv7(), status: 'active' },
      })
      expect(res['error']).toBeDefined()
      const err = res['error'] as { data: { code: string } }
      expect(err.data?.code).toBe('AUTH_INVALID_CAPABILITY')
    } finally {
      await closeSocket(socket)
      await cleanupAfterEach()
    }
  })
})

// ---------------------------------------------------------------------------
// Test: malformed JSON → PARSE_ERROR
// ---------------------------------------------------------------------------

describe('wire protocol', () => {
  it('returns PARSE_ERROR for malformed JSON', async () => {
    const socket = await connectSocket()
    try {
      const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
        let buffer = ''
        socket.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          const lines = buffer.split('\n')
          for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed) {
              try {
                resolve(JSON.parse(trimmed))
              } catch {
                reject(new Error(`Non-JSON response: ${trimmed}`))
              }
              return
            }
          }
        })
        socket.write('not valid json\n')
        setTimeout(() => reject(new Error('timeout')), 2000)
      })

      expect(response['error']).toBeDefined()
      const err = response['error'] as { code: number }
      expect(err.code).toBe(-32700) // PARSE_ERROR
    } finally {
      await closeSocket(socket)
      await cleanupAfterEach()
    }
  })
})
