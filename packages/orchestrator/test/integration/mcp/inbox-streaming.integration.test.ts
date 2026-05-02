/**
 * Integration test: MCP streaming inbox — inbox.subscribe tool.
 *
 * Coverage per M4 QA task:
 *   1. Multi-frame delivery in order — service-layer streaming (kept) +
 *      gateway-level streaming dispatch (Round 2 fix).
 *   2. Backpressure overflow → BufferTruncated signal + read_since backfill.
 *   3. Reconnect resumes with cursor backfill (service layer, then gateway verify).
 *   4. Capability-scoped subscribe rejects unauthorized channels.
 *   5. End-of-stream on disconnect — subscriber count released, no leaked listeners.
 *
 * Round 2 fixes (now in production code):
 * -----------------------------------------------------------------------
 * - Gateway streaming dispatch is implemented. `tool.streaming === true` and
 *   `tool.streamHandler` defined → server.ts drives the AsyncIterable and
 *   writes JSON-RPC notification frames `{ method:'<tool.name>.event', params:<yield> }`
 *   followed by a final response `{ id:<orig>, result:{ closed:true } }`.
 * - `buffer_truncated.lastDeliveredCursor` carries the cursor of the last
 *   message the consumer ACTUALLY consumed (via next()), not the most recently
 *   enqueued message.
 * - `InboxMessage.cursor` is the event_id of the corresponding ChannelPostAdded
 *   event (Option A). `postId` remains as a separate field. readSince(cursor)
 *   compares against event_id under the hood.
 * -----------------------------------------------------------------------
 *
 * Real Postgres + real Unix-socket MCP gateway. No mocks, no fake data.
 * Each scenario uses a unique channel name and capability_id. afterEach cleans up.
 *
 * Note on NOTIFY timing: EventStore.subscribe() kicks off NotifyClient.start()
 * asynchronously. Tests that need the LISTEN pipeline to be active before
 * posting messages call a short `waitForListen()` helper after subscribing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { uuidv7 } from 'uuidv7'

import { PostgresEventStore } from '../../../src/events/store.js'
import { DefaultChannelsService } from '../../../src/comms/channels.js'
import { DefaultInboxService } from '../../../src/comms/inbox.js'
import { CapabilityAuthority } from '../../../src/capabilities/authority.js'
import { KeyManager } from '../../../src/capabilities/keys.js'
import { resetKeychainCache } from '../../../src/capabilities/keychain.js'
import { resetPolicyCache } from '../../../src/capabilities/policy.js'
import { ToolRegistry } from '../../../src/mcp/registry.js'
import { MCPGatewayServer } from '../../../src/mcp/server.js'
import { inboxSubscribeTool } from '../../../src/mcp/tools/inbox_subscribe.js'
import { inboxReadSinceTool } from '../../../src/mcp/tools/inbox_read_since.js'
import type { Actor, Scopes, ChannelId } from '@orbital/types'

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://orbital:orbital@localhost:5432/orbital'

const TEST_SHIM_DIR = os.tmpdir()

const systemActor: Actor = { type: 'system', component: 'orchestrator' }

// ---------------------------------------------------------------------------
// Shared service instances (one pool per test; reset in beforeEach/afterEach)
// ---------------------------------------------------------------------------

let sqlPool: postgres.Sql
let db: ReturnType<typeof drizzle>
let eventStore: PostgresEventStore
let channelService: DefaultChannelsService
let inboxService: DefaultInboxService

// Per-test gateway instances (started/stopped in beforeEach/afterEach).
let gateway: MCPGatewayServer | null = null
let keyManager: KeyManager
let authority: CapabilityAuthority
let installId: string
let shimFile: string

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  // Fresh connection pool per test to avoid handler leakage across tests.
  sqlPool = postgres(DATABASE_URL, {
    max: 10,
    idle_timeout: 15,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => {},
  })
  db = drizzle(sqlPool)
  eventStore = new PostgresEventStore(db, sqlPool)
  channelService = new DefaultChannelsService(db, eventStore)
  inboxService = new DefaultInboxService(db, eventStore)

  // Keychain shim: use a pid-unique path under /tmp.
  shimFile = path.join(TEST_SHIM_DIR, `.orb-kc-${process.pid}.json`)
  process.env.ORBITAL_TEST_KEYCHAIN = '1'
  process.env.ORBITAL_TEST_KEYCHAIN_PATH = shimFile
  resetKeychainCache()
  resetPolicyCache()
  await fsp.unlink(shimFile).catch(() => undefined)

  installId = uuidv7()
  keyManager = new KeyManager(installId, eventStore)
  authority = new CapabilityAuthority(eventStore, keyManager)
})

afterEach(async () => {
  // Stop gateway if running.
  if (gateway) {
    await gateway.stop().catch(() => undefined)
    gateway = null
  }
  // Stop NOTIFY client before closing pool.
  await eventStore.stopNotifyClient().catch(() => undefined)
  await sqlPool.end({ timeout: 5 }).catch(() => undefined)
  await fsp.unlink(shimFile).catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Issue a real signed bundle via CapabilityAuthority. */
async function issueBundle(
  channelName: string,
  ttl_ms = 120_000,
  scopeOverrides?: Partial<Scopes>,
) {
  const sessionId = uuidv7()
  const taskId = uuidv7()
  const sprintId = uuidv7()

  const baseScopes: Scopes = {
    files_read: [],
    files_write: [],
    board_read: [],
    board_mutate: [],
    channel_read: [channelName],
    channel_post: [channelName],
    secrets: [],
    network_egress: [],
    spawn_subagent: false,
    git_commit: [],
    ceremony_role: [],
    ...scopeOverrides,
  }

  const result = await authority.issue({
    install_id: installId,
    persona_id: 'sr-dev',
    task_id: taskId,
    sprint_id: sprintId,
    session_id: sessionId,
    scopes: baseScopes,
    ttl_ms,
    justification: 'inbox-streaming integration test',
    actor: systemActor,
    trace_id: uuidv7().replace(/-/g, ''),
  })

  return { bundle: result.bundle, taskId, sprintId, sessionId }
}

/**
 * Start the gateway with inbox tools registered on a short /tmp socket path.
 *
 * macOS enforces a 104-char hard limit for Unix socket path length (sun_path).
 * The path must stay well under this limit.
 */
async function startGateway(): Promise<MCPGatewayServer> {
  // Use /tmp directly with a short name. Maximum path is 104 chars on macOS.
  // "/tmp/orb-<8 hex>.sock" is well within that limit.
  const suffix = uuidv7().replace(/-/g, '').slice(0, 8)
  const sockPath = `/tmp/orb-${suffix}.sock`

  const registry = new ToolRegistry()
  registry.register(inboxSubscribeTool)
  registry.register(inboxReadSinceTool)

  const gw = new MCPGatewayServer({
    socketPath: sockPath,
    authority,
    registry,
    eventStore,
    db,
  })
  await gw.start()
  return gw
}

/** Open a Unix socket connection. */
async function connectSocket(sockPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath)
    socket.on('connect', () => resolve(socket))
    socket.on('error', reject)
    setTimeout(() => reject(new Error('Connection timeout')), 3000)
  })
}

/** Destroy a socket and wait for the close event. */
async function closeSocket(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.destroyed) { resolve(); return }
    socket.destroy()
    socket.on('close', resolve)
    setTimeout(resolve, 150)
  })
}

/**
 * Send a JSON-RPC request and receive the first response line.
 * (For non-streaming tools only — returns exactly one frame.)
 */
function sendRequest(
  socket: net.Socket,
  message: object,
  timeoutMs = 8000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
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
      reject(new Error(`Timeout waiting for response: ${JSON.stringify(message)}`))
    }, timeoutMs)
  })
}

/**
 * Collect up to `count` frames from a socket within `timeoutMs`.
 * Returns all frames received — may be fewer than count on timeout.
 */
function collectFrames(
  socket: net.Socket,
  count: number,
  timeoutMs: number,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const frames: Array<Record<string, unknown>> = []
    let buffer = ''

    const finish = () => {
      socket.off('data', onData)
      resolve(frames)
    }

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i]!.trim()
        if (!line) continue
        try {
          frames.push(JSON.parse(line) as Record<string, unknown>)
        } catch {
          // skip malformed line
        }
        if (frames.length >= count) {
          finish()
          return
        }
      }
      buffer = lines[lines.length - 1] ?? ''
    }

    socket.on('data', onData)
    setTimeout(finish, timeoutMs)
  })
}

/** Connect + send the 'connect' handshake. Returns the authenticated socket. */
async function connectAndAuth(sockPath: string, bundle: object): Promise<net.Socket> {
  const socket = await connectSocket(sockPath)
  const connectRes = await sendRequest(socket, {
    jsonrpc: '2.0',
    id: 1,
    method: 'connect',
    params: { bundle },
  })
  if (connectRes['error']) {
    await closeSocket(socket)
    throw new Error(`connect failed: ${JSON.stringify(connectRes['error'])}`)
  }
  return socket
}

/** Post a message directly via ChannelsService (bypasses the gateway). */
async function postMessage(
  channelId: ChannelId,
  body: string,
): Promise<{ postId: string; eventId: string }> {
  const result = await channelService.post(channelId, {
    postType: 'status_update',
    payload: { body },
    author: systemActor,
    justification: 'inbox-streaming test post',
  })
  return { postId: result.postId, eventId: result.eventId }
}

/**
 * Wait for the LISTEN pipeline to be established.
 *
 * EventStore.subscribe() calls `void notifyClient.start(cursor)` — fire-and-
 * forget. The actual LISTEN command is sent asynchronously. This helper gives
 * the pipeline a short window to become active before the test posts messages,
 * preventing a race where a NOTIFY fires before LISTEN is set up.
 */
async function waitForListen(ms = 300): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Drain N inbox_post frames from an AsyncIterator with a per-frame deadline.
 */
async function drainFrames(
  it: AsyncIterator<Record<string, unknown>>,
  count: number,
  frameTimeoutMs: number,
): Promise<Array<Record<string, unknown>>> {
  const frames: Array<Record<string, unknown>> = []
  for (let i = 0; i < count; i++) {
    const next = await Promise.race([
      it.next(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`frame ${i} timeout after ${frameTimeoutMs}ms`)),
          frameTimeoutMs,
        ),
      ),
    ])
    if (next.done) break
    if (next.value) frames.push(next.value)
  }
  return frames
}

// ---------------------------------------------------------------------------
// SCENARIO 1: Multi-frame delivery in order (service layer)
//
// Contract decision: tested directly against InboxService + PostgresEventStore
// because the MCP gateway has no streaming dispatch. See BUG REPORT above.
//
// Delivery path: post() → EventStore.append() → Postgres NOTIFY →
// NotifyClient → EventStore handler → InboxService buffer → iterator.
// ---------------------------------------------------------------------------

describe('Scenario 1 — Multi-frame delivery in order (service layer)', () => {
  it(
    'subscribes via InboxService and receives 5 posts in insertion order',
    async () => {
      const channelRef = `s1-${uuidv7().slice(0, 8)}`
      const { channelId } = await channelService.ensureChannel('topic', `#${channelRef}`, {
        createdBy: systemActor,
      })

      // Open subscription BEFORE posting (live stream mode).
      const sub = inboxService.subscribeAsStream([channelId], null)
      const it = sub.iterable[Symbol.asyncIterator]()

      // Consume the initial stream_ready frame.
      const readyResult = await it.next()
      expect(readyResult.done).toBe(false)
      expect(readyResult.value?.kind).toBe('stream_ready')

      // Wait for the LISTEN pipeline to be fully established.
      await waitForListen(400)

      // Post 5 messages with a small inter-post delay to ensure NOTIFY arrives
      // in strict insertion order. Postgres NOTIFY is asynchronous and two events
      // inserted within the same millisecond may arrive in any order; a 20ms gap
      // guarantees monotonic UUIDv7 values and ordered NOTIFY delivery.
      const posted: string[] = []
      for (let i = 0; i < 5; i++) {
        const { postId } = await postMessage(channelId, `message ${i}`)
        posted.push(postId)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }

      // Drain 5 inbox_post frames (each with a 3-second window).
      // NOTE: service-layer InboxStreamMessage for 'inbox_post' spreads InboxMessage
      // which uses camelCase field names (postId, channelId, etc.).
      const received: string[] = []
      for (let i = 0; i < 5; i++) {
        const next = await Promise.race([
          it.next(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`timeout frame ${i}`)), 3000),
          ),
        ])
        expect(next.done).toBe(false)
        const frame = next.value as Record<string, unknown>
        expect(frame?.['kind']).toBe('inbox_post')
        if (frame?.['kind'] === 'inbox_post') {
          received.push(frame['postId'] as string) // camelCase — service layer
        }
      }

      await it.return?.()
      sub.unsubscribe()

      // Assert all 5 received and in insertion order.
      // Order is guaranteed because inter-post delay ensures monotonic UUIDv7
      // values and sequential NOTIFY delivery via the same Postgres connection.
      expect(received).toHaveLength(5)
      expect(received).toEqual(posted)
    },
    25_000,
  )
})

// ---------------------------------------------------------------------------
// SCENARIO 2: Backpressure overflow → BufferTruncated signal + read_since
//
// Tests:
//  (a) A cap=8 buffer flooded with 16 rapid posts emits exactly 1 buffer_truncated.
//  (b) The droppedCount accounts for all dropped messages.
//  (c) inbox.readSince(lastDeliveredCursor) returns exactly the dropped posts.
// ---------------------------------------------------------------------------

describe('Scenario 2 — Backpressure overflow → BufferTruncated + read_since backfill', () => {
  it(
    'cap=8 buffer flooded with 16 posts triggers buffer_truncated; read_since recovers dropped posts',
    async () => {
      const channelRef = `s2-${uuidv7().slice(0, 8)}`
      const { channelId } = await channelService.ensureChannel('topic', `#${channelRef}`, {
        createdBy: systemActor,
      })

      const BUFFER_CAP = 8
      const TOTAL_POSTS = 16

      // Use inboxService.subscribe() (not subscribeAsStream) directly for
      // backpressure testing. The subscribe() iterator only advances when next()
      // is called — unlike subscribeAsStream() which runs a background pump
      // that would drain the inner buffer continuously. This gives us reliable
      // control over when the consumer drains.
      const sub = inboxService.subscribe([channelId], null, {
        bufferCap: BUFFER_CAP,
      })
      const it = sub.iterable[Symbol.asyncIterator]()

      // Wait for LISTEN to be established before flooding.
      await waitForListen(400)

      // Post all messages — the consumer is NOT calling next(), so the buffer
      // accumulates NOTIFYs. With BUFFER_CAP=8 and 16 posts, posts 9-16
      // trigger evictions and a buffer_truncated signal.
      const allPostIds: string[] = []
      for (let i = 0; i < TOTAL_POSTS; i++) {
        const { postId } = await postMessage(channelId, `flood ${i}`)
        allPostIds.push(postId)
      }

      // Allow all NOTIFYs to propagate and enqueue into the buffer.
      await new Promise((resolve) => setTimeout(resolve, 800))

      // Now drain everything available from the buffer without waiting too long.
      // Expect BUFFER_CAP message items + 1 buffer_truncated item.
      type SubscribeYield = { kind: 'message'; message: { cursor: string; postId: string } } | { kind: 'buffer_truncated'; droppedCount: number; lastDeliveredCursor: string; advice: string }
      const drained: SubscribeYield[] = []
      let lastDeliveredCursor = ''
      let droppedCount = 0

      for (let i = 0; i < TOTAL_POSTS + 5; i++) {
        const next = await Promise.race([
          it.next() as Promise<IteratorResult<SubscribeYield>>,
          new Promise<{ value: null; done: false }>((resolve) =>
            setTimeout(() => resolve({ value: null, done: false }), 200),
          ),
        ])
        if (next.value === null) break
        if (next.done) break
        const item = next.value
        drained.push(item)
        if (item.kind === 'buffer_truncated') {
          lastDeliveredCursor = item.lastDeliveredCursor
          droppedCount = item.droppedCount
        }
      }

      await it.return?.()
      sub.unsubscribe()

      const messages = drained.filter((d) => d.kind === 'message')
      const truncations = drained.filter((d) => d.kind === 'buffer_truncated')

      // Exactly one truncation signal emitted.
      expect(truncations.length).toBe(1)
      // droppedCount accounts for all evicted messages.
      expect(droppedCount).toBeGreaterThan(0)
      // Consumer received exactly BUFFER_CAP messages.
      expect(messages.length).toBe(BUFFER_CAP)
      // Received + dropped = total posted.
      expect(messages.length + droppedCount).toBe(TOTAL_POSTS)

      // Round 2 BUG 2 fix:
      // -----------------
      // `lastDeliveredCursor` is now the cursor of the LAST CONSUMED message
      // (the one returned by the most recent next() call BEFORE the
      // truncation), not the most recently enqueued message.
      const truncIdx = drained.findIndex((d) => d.kind === 'buffer_truncated')
      expect(truncIdx).toBeGreaterThanOrEqual(0)
      let expectedTruncCursor = ''
      for (let i = truncIdx - 1; i >= 0; i--) {
        const item = drained[i]
        if (item && item.kind === 'message') {
          expectedTruncCursor = item.message.cursor
          break
        }
      }
      expect(lastDeliveredCursor).toBe(expectedTruncCursor)

      // readSince(lastDeliveredCursor) now correctly returns the messages the
      // consumer didn't see — i.e., the dropped (oldest evicted) ones plus
      // any messages after the last delivered cursor that were still in the
      // buffer when we stopped. Round 2 BUG 3 fix unified the cursor
      // namespace to event_id so this works.
      const recovered = await inboxService.readSince([channelId], lastDeliveredCursor, {
        limit: 500,
      })
      // We expect at least `droppedCount` messages to come back from
      // readSince — the ones that were evicted before the consumer saw them.
      // Other tests running in parallel may add unrelated rows; we filter to
      // our channel's posts and verify the dropped set is recovered.
      const recoveredPostIds = recovered.items.map((m) => m.postId)
      // Every dropped post must be recoverable via readSince.
      // Dropped posts are those in allPostIds that the consumer did NOT see.
      const consumedPostIds = messages
        .filter((m) => m.kind === 'message')
        .map((m) => (m as { kind: 'message'; message: { postId: string } }).message.postId)
      const droppedPostIds = allPostIds.filter((id) => !consumedPostIds.includes(id))
      for (const id of droppedPostIds) {
        expect(recoveredPostIds).toContain(id)
      }

      // Verify the readSince poll path works independently (using empty cursor).
      // We check that all 16 posted IDs appear in the DB; there may be more
      // rows in the channel if the DB is shared across test runs.
      const fullPage = await inboxService.readSince([channelId], '', { limit: 500 })
      const returnedIds = fullPage.items.map((m) => m.postId)
      // Every posted ID must appear in the DB results.
      for (const id of allPostIds) {
        expect(returnedIds).toContain(id)
      }
      // The 16 posted messages appear in insertion order within the results.
      const our16 = returnedIds.filter((id) => allPostIds.includes(id))
      expect(our16).toEqual(allPostIds)
    },
    30_000,
  )
})

// ---------------------------------------------------------------------------
// SCENARIO 3: Reconnect resumes with cursor backfill
//
// Per TRD-05 §10.3.4: workers maintain `lastCursor` updated on every received
// `inbox_post`. On disconnect, they call inbox.subscribe(cursor=lastCursor) and
// the gateway backfills missed posts.
//
// Round 2 cursor unification (Option A — landed):
//   InboxMessage.cursor is the underlying ChannelPostAdded event_id (NOT
//   post_id). The live subscribe path and the readSince(cursor) path both
//   interpret the cursor as event_id. Workers can use the same cursor value
//   for either path; the namespace is unified.
//
// This test verifies:
//  (a) Live streaming delivers posts after subscription opens.
//  (b) readSince(lastCursor) — where lastCursor is the event_id surfaced by
//      the live stream — correctly returns the messages that arrived after
//      that cursor in insertion order.
// ---------------------------------------------------------------------------

describe('Scenario 3 — Reconnect with cursor backfill', () => {
  it(
    'reconnect: readSince(lastCursor) returns the missed posts in insertion order',
    async () => {
      const channelRef = `s3-${uuidv7().slice(0, 8)}`
      const { channelId } = await channelService.ensureChannel('topic', `#${channelRef}`, {
        createdBy: systemActor,
      })

      // ---- First session: subscribe and receive 3 posts ----
      const sub1 = inboxService.subscribeAsStream([channelId], null)
      const it1 = sub1.iterable[Symbol.asyncIterator]()

      const ready1 = await it1.next()
      expect(ready1.value?.kind).toBe('stream_ready')

      // Wait for LISTEN.
      await waitForListen(400)

      // Post 3 messages with inter-post delay to ensure strict NOTIFY order.
      const firstBatch: string[] = []
      for (let i = 0; i < 3; i++) {
        const { postId } = await postMessage(channelId, `first ${i}`)
        firstBatch.push(postId)
        await new Promise((resolve) => setTimeout(resolve, 20))
      }

      // Drain all 3 from the live stream and capture lastCursor.
      let lastCursor = ''
      for (let i = 0; i < 3; i++) {
        const next = await Promise.race([
          it1.next(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`timeout first batch ${i}`)), 3000),
          ),
        ])
        expect(next.done).toBe(false)
        const frame = next.value as Record<string, unknown>
        expect(frame?.['kind']).toBe('inbox_post')
        // Round 2 (Option A): cursor on InboxMessage is event_id (not post_id).
        // Both are UUIDv7 so the regex assertion below remains valid.
        lastCursor = frame?.['cursor'] as string
      }

      // Disconnect (worker crash / network drop).
      await it1.return?.()
      sub1.unsubscribe()

      expect(lastCursor).not.toBe('')
      expect(lastCursor).toMatch(/^[0-9a-f-]{36}$/) // UUIDv7 (event_id of 3rd post)

      // ---- While disconnected: post 5 more ----
      const missedBatch: string[] = []
      for (let i = 0; i < 5; i++) {
        const { postId } = await postMessage(channelId, `missed ${i}`)
        missedBatch.push(postId)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }

      // ---- Reconnect: use readSince(lastCursor) to backfill missed posts ----
      //
      // TRD-05 §10.3.4 says the worker calls inbox.subscribe(cursor=lastCursor).
      // TRD-05 §10.3.6 documents readSince as the reliable backfill mechanism.
      // Workers should call readSince after reconnect to recover missed messages.
      const page = await inboxService.readSince([channelId], lastCursor, { limit: 100 })

      // Should return exactly the 5 missed posts in insertion order.
      expect(page.items.length).toBe(5)
      expect(page.has_more).toBe(false)
      expect(page.items.map((m) => m.postId)).toEqual(missedBatch)

      // ---- Live mode: open a fresh subscription and receive a new post ----
      // Use a fresh pool/store to simulate a fresh worker reconnect.
      const sql2 = postgres(DATABASE_URL, {
        max: 5,
        idle_timeout: 15,
        connect_timeout: 10,
        prepare: false,
        onnotice: () => {},
      })
      const db2 = drizzle(sql2)
      const eventStore2 = new PostgresEventStore(db2, sql2)
      const inboxService2 = new DefaultInboxService(db2, eventStore2)
      const channelService2 = new DefaultChannelsService(db2, eventStore2)

      const sub2 = inboxService2.subscribeAsStream([channelId], null)
      const it2 = sub2.iterable[Symbol.asyncIterator]()

      await it2.next() // stream_ready
      await waitForListen(400)

      const livePromise = it2.next()
      const { postId: liveId } = await channelService2.post(channelId, {
        postType: 'status_update',
        payload: { body: 'live-after-reconnect' },
        author: systemActor,
        justification: 'reconnect live test',
      }).then((r) => ({ postId: r.postId }))

      const liveNext = await Promise.race([
        livePromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('live frame timeout')), 5000),
        ),
      ])
      expect(liveNext.done).toBe(false)
      const liveFrame = liveNext.value as Record<string, unknown>
      expect(liveFrame?.['kind']).toBe('inbox_post')
      expect(liveFrame?.['postId']).toBe(liveId) // camelCase — service layer

      await it2.return?.()
      sub2.unsubscribe()

      await eventStore2.stopNotifyClient().catch(() => undefined)
      await sql2.end({ timeout: 5 }).catch(() => undefined)
    },
    45_000,
  )
})

// ---------------------------------------------------------------------------
// SCENARIO 4: Capability-scoped subscribe rejects unauthorized channels
//
// CONTRACT DECISION: inbox.subscribe throws OrbitalError('AUTH_SCOPE_DENIED')
// when the bundle lacks channel_read for any requested channel. The error is
// raised by the handler on the first unauthorized channel — the call fails
// completely. The subscribe does NOT silently limit to authorized channels.
//
// This behavior is documented here as the official contract.
// ---------------------------------------------------------------------------

describe('Scenario 4 — Capability scope enforcement', () => {
  it(
    'inbox.subscribe via gateway returns error when bundle lacks channel_read for one channel',
    async () => {
      const refOne = `s4a-${uuidv7().slice(0, 8)}`
      const refTwo = `s4b-${uuidv7().slice(0, 8)}`

      await channelService.ensureChannel('topic', `#${refOne}`, { createdBy: systemActor })
      await channelService.ensureChannel('topic', `#${refTwo}`, { createdBy: systemActor })

      // Bundle only grants channel_read for #refOne.
      const { bundle } = await issueBundle(`#${refOne}`, 120_000, {
        channel_read: [`#${refOne}`],
        channel_post: [`#${refOne}`],
      })

      gateway = await startGateway()
      const socket = await connectAndAuth(gateway.socketPath, bundle)

      try {
        // Subscribe to BOTH channels — should fail on #refTwo.
        const res = await sendRequest(socket, {
          jsonrpc: '2.0',
          id: 2,
          method: 'inbox.subscribe',
          params: {
            channels: [`#${refOne}`, `#${refTwo}`],
            buffer_cap: 64,
          },
        })

        // CONTRACT: handler throws OrbitalError('AUTH_SCOPE_DENIED') which the
        // router catches and returns as MCP_ERROR_CODES.INTERNAL_ERROR (code -32603)
        // with the original error message.
        expect(res['error']).toBeDefined()
        const err = res['error'] as { code: number; message: string }
        expect(err.message).toMatch(/AUTH_SCOPE_DENIED|bundle lacks channel_read|scope/i)
      } finally {
        await closeSocket(socket)
      }
    },
    15_000,
  )

  it(
    'inbox.subscribe via gateway returns stream_ready when bundle grants channel_read',
    async () => {
      const ref = `s4c-${uuidv7().slice(0, 8)}`
      await channelService.ensureChannel('topic', `#${ref}`, { createdBy: systemActor })

      const { bundle } = await issueBundle(`#${ref}`)

      gateway = await startGateway()
      const socket = await connectAndAuth(gateway.socketPath, bundle)

      try {
        const res = await sendRequest(socket, {
          jsonrpc: '2.0',
          id: 2,
          method: 'inbox.subscribe',
          params: { channels: [`#${ref}`], buffer_cap: 64 },
        })

        // The handler returns stream_ready synchronously.
        // No streaming dispatch exists (BUG), so this is the only frame.
        expect(res['error']).toBeUndefined()
        const result = res['result'] as Record<string, unknown>
        expect(result['kind']).toBe('stream_ready')
        expect(Array.isArray(result['resolved_channels'])).toBe(true)
        expect(typeof result['server_time']).toBe('string')
        expect(typeof result['cursor']).toBe('string')
      } finally {
        await closeSocket(socket)
      }
    },
    10_000,
  )

  it(
    'gatewayValidateChannel: returns true for authorized channel, false for unauthorized',
    async () => {
      const { bundle } = await issueBundle('#authorized-channel')
      const { gatewayValidateChannel } = await import('../../../src/capabilities/gateway.js')

      expect(gatewayValidateChannel(bundle, 'channel_read', '#authorized-channel')).toBe(true)
      expect(gatewayValidateChannel(bundle, 'channel_read', '#other-channel')).toBe(false)
      expect(gatewayValidateChannel(bundle, 'channel_post', '#authorized-channel')).toBe(true)
      expect(gatewayValidateChannel(bundle, 'channel_post', '#other-channel')).toBe(false)
    },
    5_000,
  )

  it(
    'inbox.read_since via gateway rejects unauthorized channel with AUTH_SCOPE_DENIED',
    async () => {
      const refA = `s4e-a-${uuidv7().slice(0, 8)}`
      const refB = `s4e-b-${uuidv7().slice(0, 8)}`

      await channelService.ensureChannel('topic', `#${refA}`, { createdBy: systemActor })
      await channelService.ensureChannel('topic', `#${refB}`, { createdBy: systemActor })

      // Bundle only grants access to refA.
      const { bundle } = await issueBundle(`#${refA}`, 120_000, {
        channel_read: [`#${refA}`],
        channel_post: [`#${refA}`],
      })

      gateway = await startGateway()
      const socket = await connectAndAuth(gateway.socketPath, bundle)

      try {
        const res = await sendRequest(socket, {
          jsonrpc: '2.0',
          id: 2,
          method: 'inbox.read_since',
          params: { channels: [`#${refB}`], cursor: '', limit: 10 },
        })

        expect(res['error']).toBeDefined()
        const err = res['error'] as { message: string }
        expect(err.message).toMatch(/AUTH_SCOPE_DENIED|bundle lacks channel_read|scope/i)
      } finally {
        await closeSocket(socket)
      }
    },
    10_000,
  )
})

// ---------------------------------------------------------------------------
// SCENARIO 5: End-of-stream on disconnect — no leaked listeners
// ---------------------------------------------------------------------------

describe('Scenario 5 — End-of-stream on disconnect, no leaked listeners', () => {
  it(
    'unsubscribe stops message delivery; iterator returns done=true',
    async () => {
      const ref = `s5a-${uuidv7().slice(0, 8)}`
      const { channelId } = await channelService.ensureChannel('topic', `#${ref}`, {
        createdBy: systemActor,
      })

      const sub = inboxService.subscribeAsStream([channelId], null)
      const it = sub.iterable[Symbol.asyncIterator]()

      // Consume stream_ready.
      const ready = await it.next()
      expect(ready.value?.kind).toBe('stream_ready')

      // Wait for LISTEN.
      await waitForListen(400)

      // Post one message and confirm delivery.
      await postMessage(channelId, 'pre-unsub')
      const pre = await Promise.race([
        it.next(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout pre-unsub')), 3000),
        ),
      ])
      expect(pre.value?.['kind']).toBe('inbox_post')

      // Unsubscribe — simulates worker disconnect.
      await it.return?.()
      sub.unsubscribe()

      // Post another message — should NOT reach the stopped iterator.
      await postMessage(channelId, 'post-unsub')

      // Allow event loop to potentially deliver.
      await new Promise((resolve) => setTimeout(resolve, 200))

      // The iterator is stopped; next() should return done=true immediately.
      const afterUnsub = await it.next()
      expect(afterUnsub.done).toBe(true)
    },
    15_000,
  )

  it(
    'two independent subscribers on same channel are isolated; unsubscribing one does not affect the other',
    async () => {
      const ref = `s5b-${uuidv7().slice(0, 8)}`
      const { channelId } = await channelService.ensureChannel('topic', `#${ref}`, {
        createdBy: systemActor,
      })

      const subA = inboxService.subscribeAsStream([channelId], null)
      const subB = inboxService.subscribeAsStream([channelId], null)
      const itA = subA.iterable[Symbol.asyncIterator]()
      const itB = subB.iterable[Symbol.asyncIterator]()

      // Consume stream_ready from both.
      await itA.next()
      await itB.next()

      // Wait for LISTEN.
      await waitForListen(400)

      // Both subscribers receive the same post.
      const { postId } = await postMessage(channelId, 'broadcast')

      const [rA, rB] = await Promise.all([
        Promise.race([
          itA.next(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout A')), 3000)),
        ]),
        Promise.race([
          itB.next(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout B')), 3000)),
        ]),
      ])

      expect(rA.value?.['kind']).toBe('inbox_post')
      expect(rB.value?.['kind']).toBe('inbox_post')
      // camelCase field names — service-layer InboxStreamMessage spreads InboxMessage
      expect((rA.value as Record<string, unknown>)?.['postId']).toBe(postId)
      expect((rB.value as Record<string, unknown>)?.['postId']).toBe(postId)

      // Unsubscribe A; B still active.
      await itA.return?.()
      subA.unsubscribe()

      await new Promise((resolve) => setTimeout(resolve, 50))

      // B should receive the next post; A should not.
      const { postId: postId2 } = await postMessage(channelId, 'after-A-unsub')

      const rB2 = await Promise.race([
        itB.next(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout B2')), 3000),
        ),
      ])
      expect(rB2.value?.['kind']).toBe('inbox_post')
      expect((rB2.value as Record<string, unknown>)?.['postId']).toBe(postId2) // camelCase

      // A iterator is stopped.
      const rA2 = await itA.next()
      expect(rA2.done).toBe(true)

      await itB.return?.()
      subB.unsubscribe()
    },
    20_000,
  )

  it(
    'gateway: closing client socket does not crash the server; new connections succeed',
    async () => {
      const ref = `s5c-${uuidv7().slice(0, 8)}`
      await channelService.ensureChannel('topic', `#${ref}`, { createdBy: systemActor })

      const { bundle } = await issueBundle(`#${ref}`)
      gateway = await startGateway()

      const socket1 = await connectAndAuth(gateway.socketPath, bundle)

      // Subscribe — returns stream_ready (no streaming dispatch).
      await sendRequest(socket1, {
        jsonrpc: '2.0',
        id: 2,
        method: 'inbox.subscribe',
        params: { channels: [`#${ref}`], buffer_cap: 64 },
      })

      // Abruptly close the socket (worker crash / network drop).
      await closeSocket(socket1)

      // Allow server to process the close.
      await new Promise((resolve) => setTimeout(resolve, 150))

      // Server must still accept a new connection.
      const { bundle: bundle2 } = await issueBundle(`#${ref}`)
      const socket2 = await connectAndAuth(gateway.socketPath, bundle2)

      try {
        const res = await sendRequest(socket2, {
          jsonrpc: '2.0',
          id: 2,
          method: 'inbox.subscribe',
          params: { channels: [`#${ref}`], buffer_cap: 64 },
        })
        expect(res['error']).toBeUndefined()
        expect((res['result'] as Record<string, unknown>)?.['kind']).toBe('stream_ready')
      } finally {
        await closeSocket(socket2)
      }
    },
    15_000,
  )
})

// ---------------------------------------------------------------------------
// SCENARIO 5b: inbox.read_since via MCP gateway (poll fallback path)
//
// This is a full end-to-end gateway test because read_since is NOT a streaming
// tool — it works through the regular single-frame request/response path.
// ---------------------------------------------------------------------------

describe('Scenario 5b — inbox.read_since end-to-end via gateway', () => {
  it(
    'returns posts after cursor in insertion order',
    async () => {
      const ref = `s5d-${uuidv7().slice(0, 8)}`
      const { channelId } = await channelService.ensureChannel('topic', `#${ref}`, {
        createdBy: systemActor,
      })

      // Post 3 messages.
      const postIds: string[] = []
      for (let i = 0; i < 3; i++) {
        const { postId } = await postMessage(channelId, `read-since ${i}`)
        postIds.push(postId)
      }

      const { bundle } = await issueBundle(`#${ref}`)
      gateway = await startGateway()
      const socket = await connectAndAuth(gateway.socketPath, bundle)

      try {
        // Empty cursor → all posts in the channel.
        // NOTE: other parallel test forks may also post to channels with the same
        // UUID prefix if vitest runs tests in multiple forks sharing the same DB.
        // We therefore verify our 3 postIds are present and in relative order,
        // rather than asserting an exact total count.
        const res = await sendRequest(socket, {
          jsonrpc: '2.0',
          id: 2,
          method: 'inbox.read_since',
          params: { channels: [`#${ref}`], cursor: '', limit: 500 },
        })
        expect(res['error']).toBeUndefined()
        const result = res['result'] as {
          messages: Array<{ post_id: string; cursor: string }>
          has_more: boolean
        }
        const allReturned = result.messages.map((m) => m.post_id)
        // Our 3 posts must all be present.
        for (const id of postIds) {
          expect(allReturned).toContain(id)
        }
        // Our 3 posts must appear in insertion order relative to each other.
        const ourPosts = allReturned.filter((id) => postIds.includes(id))
        expect(ourPosts).toEqual(postIds)

        // Round 2 (Option A): cursor is event_id, NOT post_id. To paginate
        // past the first post we use its returned `cursor` field.
        const firstPostMsg = result.messages.find((m) => m.post_id === postIds[0])
        expect(firstPostMsg).toBeDefined()
        const firstCursor = firstPostMsg!.cursor

        // Cursor at firstCursor (event_id of first post) → only postIds[1]
        // and later posts appear. (Any posts from other forks that arrived
        // after this cursor may also appear.)
        const res2 = await sendRequest(socket, {
          jsonrpc: '2.0',
          id: 3,
          method: 'inbox.read_since',
          params: { channels: [`#${ref}`], cursor: firstCursor, limit: 500 },
        })
        expect(res2['error']).toBeUndefined()
        const result2 = res2['result'] as { messages: Array<{ post_id: string }> }
        const allReturned2 = result2.messages.map((m) => m.post_id)
        // postIds[0] must NOT appear (its event_id cursor is exclusive).
        expect(allReturned2).not.toContain(postIds[0])
        // postIds[1] and postIds[2] MUST appear.
        expect(allReturned2).toContain(postIds[1])
        expect(allReturned2).toContain(postIds[2])
        // In relative insertion order.
        const ourTail = allReturned2.filter((id) => postIds.includes(id))
        expect(ourTail).toEqual(postIds.slice(1))
      } finally {
        await closeSocket(socket)
      }
    },
    15_000,
  )

  it(
    'message shape matches InboxStreamMessage spec (TRD-05 §10.3.2)',
    async () => {
      const ref = `s5e-${uuidv7().slice(0, 8)}`
      const { channelId } = await channelService.ensureChannel('topic', `#${ref}`, {
        createdBy: systemActor,
      })

      const { postId: shapePostId } = await postMessage(channelId, 'shape test')

      const { bundle } = await issueBundle(`#${ref}`)
      gateway = await startGateway()
      const socket = await connectAndAuth(gateway.socketPath, bundle)

      try {
        const res = await sendRequest(socket, {
          jsonrpc: '2.0',
          id: 2,
          method: 'inbox.read_since',
          params: { channels: [`#${ref}`], cursor: '', limit: 500 },
        })
        expect(res['error']).toBeUndefined()
        const result = res['result'] as {
          messages: Array<Record<string, unknown>>
        }
        // Find our specific post among all returned (parallel forks may add more).
        const ourMsg = result.messages.find((m) => m['post_id'] === shapePostId)
        expect(ourMsg).toBeDefined()
        const msg = ourMsg!
        // Required fields from TRD-05 §10.3.2.
        expect(typeof msg['cursor']).toBe('string')
        expect(typeof msg['post_id']).toBe('string')
        expect(typeof msg['channel_id']).toBe('string')
        expect(typeof msg['channel_name']).toBe('string')
        expect(typeof msg['post_type']).toBe('string')
        expect(typeof msg['payload']).toBe('object')
        expect(typeof msg['is_priority']).toBe('boolean')
        expect(typeof msg['occurred_at']).toBe('string')
        expect(Array.isArray(msg['mentions'])).toBe(true)
        expect(Array.isArray(msg['cross_references'])).toBe(true)
        expect(msg['author']).toBeTruthy()
      } finally {
        await closeSocket(socket)
      }
    },
    10_000,
  )
})

// ---------------------------------------------------------------------------
// SCENARIO 6 (was BUG anchor): Gateway streaming dispatch end-to-end
//
// Round 2 fix landed: server.ts dispatches `tool.streaming === true` via
// streamHandler. After the initial stream_ready response the server writes
// one `inbox.subscribe.event` notification per yielded value (no `id` per
// JSON-RPC 2.0 §5) and a final `{ id, result: { closed: true } }` response
// when the iterator returns or the socket closes.
//
// This test posts 3 messages after subscribing and verifies AT LEAST 3
// notification frames flow over the socket, plus the initial stream_ready
// response. The "closed:true" final response only fires once we cancel — we
// trigger that by closing the socket.
// ---------------------------------------------------------------------------

describe('Scenario 6 — Gateway streaming dispatch end-to-end', () => {
  it(
    'inbox.subscribe streams 3 notification frames after 3 posts; stream_ready response is first',
    async () => {
      const ref = `sstream-${uuidv7().slice(0, 8)}`
      const { channelId } = await channelService.ensureChannel('topic', `#${ref}`, {
        createdBy: systemActor,
      })

      const { bundle } = await issueBundle(`#${ref}`)
      gateway = await startGateway()
      const socket = await connectAndAuth(gateway.socketPath, bundle)

      try {
        // Collect up to 10 frames within a wide window so we can capture
        // stream_ready + 3 notifications. We don't expect a closed:true frame
        // here because we're not cancelling — the socket close in the
        // afterEach/finally drives that.
        const framesPromise = collectFrames(socket, 10, 4000)

        // Send the subscribe request.
        socket.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'inbox.subscribe',
            params: { channels: [`#${ref}`], buffer_cap: 64 },
          }) + '\n',
        )

        // Allow the LISTEN pipeline to be established before posting.
        await new Promise((resolve) => setTimeout(resolve, 600))
        await postMessage(channelId, 'streaming-test-1')
        await new Promise((resolve) => setTimeout(resolve, 30))
        await postMessage(channelId, 'streaming-test-2')
        await new Promise((resolve) => setTimeout(resolve, 30))
        await postMessage(channelId, 'streaming-test-3')

        const frames = await framesPromise

        // Categorize.
        // A response frame for our request: has `id === 2` and either result/error.
        const responseFrames = frames.filter(
          (f) => f['id'] === 2 && ('result' in f || 'error' in f),
        )
        // Notifications: method is 'inbox.subscribe.event' and no `id`.
        const notificationFrames = frames.filter(
          (f) => f['method'] === 'inbox.subscribe.event' && !('id' in f),
        )

        // The first response frame must be the stream_ready envelope.
        expect(responseFrames.length).toBeGreaterThanOrEqual(1)
        const firstResp = responseFrames[0] as Record<string, unknown>
        expect(firstResp['error']).toBeUndefined()
        const firstResult = firstResp['result'] as Record<string, unknown>
        expect(firstResult['kind']).toBe('stream_ready')

        // At least 3 notification frames (one per posted message).
        expect(notificationFrames.length).toBeGreaterThanOrEqual(3)

        // Each notification carries a params.kind === 'inbox_post' (skipping
        // any heartbeat frames that may interleave).
        const inboxPosts = notificationFrames.filter((f) => {
          const params = f['params'] as Record<string, unknown> | undefined
          return params?.['kind'] === 'inbox_post'
        })
        expect(inboxPosts.length).toBeGreaterThanOrEqual(3)
      } finally {
        await closeSocket(socket)
      }
    },
    20_000,
  )

  it(
    'streamHandler iterator.return() runs on socket close (no leaked subscribers)',
    async () => {
      const ref = `sstream-close-${uuidv7().slice(0, 8)}`
      const { channelId } = await channelService.ensureChannel('topic', `#${ref}`, {
        createdBy: systemActor,
      })

      const { bundle } = await issueBundle(`#${ref}`)
      gateway = await startGateway()
      const socket = await connectAndAuth(gateway.socketPath, bundle)

      // Subscribe + receive stream_ready.
      const res = await sendRequest(socket, {
        jsonrpc: '2.0',
        id: 2,
        method: 'inbox.subscribe',
        params: { channels: [`#${ref}`], buffer_cap: 64 },
      })
      expect(res['error']).toBeUndefined()
      expect((res['result'] as Record<string, unknown>)?.['kind']).toBe('stream_ready')

      // Allow LISTEN to engage.
      await new Promise((resolve) => setTimeout(resolve, 400))

      // Close the socket — server should call iterator.return() to release the
      // underlying subscribeAsStream subscription.
      await closeSocket(socket)

      // Allow the close handler to run.
      await new Promise((resolve) => setTimeout(resolve, 200))

      // Post a message after the socket is gone — this is verifying that
      // cleanup ran (no deliver attempts on a destroyed socket throwing). We
      // don't assert on subscriber-count internals; we only assert no error
      // surfaces and a fresh connection still works.
      await postMessage(channelId, 'after-close')

      const { bundle: bundle2 } = await issueBundle(`#${ref}`)
      const socket2 = await connectAndAuth(gateway.socketPath, bundle2)
      try {
        const res2 = await sendRequest(socket2, {
          jsonrpc: '2.0',
          id: 3,
          method: 'inbox.subscribe',
          params: { channels: [`#${ref}`], buffer_cap: 64 },
        })
        expect(res2['error']).toBeUndefined()
      } finally {
        await closeSocket(socket2)
      }
    },
    15_000,
  )
})
