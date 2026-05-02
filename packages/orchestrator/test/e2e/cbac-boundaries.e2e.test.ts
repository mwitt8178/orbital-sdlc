/**
 * cbac-boundaries.e2e.test.ts — CBAC capability boundary tests.
 *
 * Phase 8 QA. Real Postgres, real keychain shim, real Ed25519 signatures,
 * real MCP gateway Unix socket.
 *
 * Architecture note: validateAndEmit() is a pure scope checker called after
 * the bundle has already been verified (not expired, not revoked) at connect
 * time by the MCP gateway. Scenarios that test TTL/revocation/tamper must
 * therefore go through the actual gateway connect path.
 *
 * Scenarios:
 *   1. files_write outside scope glob          → AUTH_SCOPE_DENIED (via validateAndEmit)
 *   2. channel_post on un-scoped channel       → AUTH_SCOPE_DENIED (via validateAndEmit)
 *   3. secrets read with un-scoped key         → AUTH_SCOPE_DENIED (via validateAndEmit)
 *   4. board_mutate on ticket not in scope     → AUTH_SCOPE_DENIED (via validateAndEmit)
 *   5. network_egress to host not in scope     → AUTH_SCOPE_DENIED (via validateAndEmit)
 *   6. expired bundle at connect               → AUTH_CAPABILITY_EXPIRED (via gateway)
 *   7. revoked bundle at connect               → AUTH_CAPABILITY_REVOKED (via gateway)
 *   8. tampered bundle at connect (wrong sig)  → AUTH_INVALID_CAPABILITY (via gateway)
 *   9. SoD violation at issue time             → AUTH_SOD_VIOLATION (via authority.issue)
 *  10. spawn_subagent=false worker tries spawn → AUTH_SCOPE_DENIED (via validateAndEmit)
 *
 * Each scenario MUST produce a CapabilityDenied event with the correct
 * error_code in its payload.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import net from 'node:net'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import { uuidv7 } from 'uuidv7'

import { db, sql, closeDb } from '../../src/db/client.js'
import { createEventStore } from '../../src/events/store.js'
import { CapabilityAuthority } from '../../src/capabilities/authority.js'
import { KeyManager } from '../../src/capabilities/keys.js'
import { resetKeychainCache } from '../../src/capabilities/keychain.js'
import { resetPolicyCache } from '../../src/capabilities/policy.js'
import { ToolRegistry } from '../../src/mcp/registry.js'
import { MCPGatewayServer } from '../../src/mcp/server.js'
import { workerHeartbeatTool } from '../../src/mcp/tools/worker_heartbeat.js'
import { taskCompleteTool } from '../../src/mcp/tools/task_complete.js'
import { taskFailTool } from '../../src/mcp/tools/task_fail.js'
import { taskRequestHelpTool } from '../../src/mcp/tools/task_request_help.js'
import { bootstrapOrchestrationRegistry } from '../../src/orchestration/registry-bootstrap.js'
import type { Actor, Scopes, CapabilityBundle } from '@orbital/types'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const TEST_SOCKET_PATH = path.join(
  os.tmpdir(),
  `orbital-cbac-e2e-${process.pid}-${Math.random().toString(36).slice(2, 6)}.sock`,
)

const TEST_SHIM_FILE =
  process.env['ORBITAL_TEST_KEYCHAIN_PATH'] ??
  path.join(os.homedir(), `.orbital-test-keychain-cbac-e2e-${process.pid}.json`)

const systemActor: Actor = { type: 'system', component: 'capability_authority' }

const STANDARD_SCOPES: Scopes = {
  files_read: ['src/**'],
  files_write: ['src/**'],
  board_read: ['ticket:ORB-1'],
  board_mutate: ['ticket:ORB-1'],
  channel_read: ['#sprint-1'],
  channel_post: ['#sprint-1'],
  secrets: ['ANTHROPIC_API_KEY'],
  network_egress: ['api.anthropic.com'],
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
  await sql`SELECT 1`
})

beforeEach(async () => {
  process.env['ORBITAL_TEST_KEYCHAIN'] = '1'
  process.env['ORBITAL_TEST_KEYCHAIN_PATH'] = TEST_SHIM_FILE
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
  bootstrapOrchestrationRegistry({ registry, authority, db, eventStore })

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
  await fsp.unlink(TEST_SHIM_FILE).catch(() => undefined)
  await closeDb().catch(() => undefined)
  try {
    fs.unlinkSync(TEST_SOCKET_PATH)
  } catch {
    // ignore
  }
})

// ---------------------------------------------------------------------------
// MCP gateway socket helpers (mirrors gateway.integration.test.ts patterns)
// ---------------------------------------------------------------------------

function connectSocket(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(TEST_SOCKET_PATH)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
    setTimeout(() => reject(new Error('cbac: socket connect timeout')), 5000)
  })
}

function sendRequest(
  socket: net.Socket,
  msg: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = msg['id']
    let buffer = ''

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const parsed = JSON.parse(trimmed) as Record<string, unknown>
          if (parsed['id'] === id) {
            socket.removeListener('data', onData)
            resolve(parsed)
          }
        } catch {
          // keep reading
        }
      }
    }

    socket.on('data', onData)
    socket.write(JSON.stringify(msg) + '\n')

    setTimeout(() => {
      socket.removeListener('data', onData)
      reject(new Error(`cbac: request id=${String(id)} timed out`))
    }, 8000)
  })
}

// ---------------------------------------------------------------------------
// Helper: issue a real bundle with given scopes
// ---------------------------------------------------------------------------

async function issueBundle(scopes: Scopes, persona = 'sr-dev', ttlMsOffset = 60_000): Promise<{
  bundle: CapabilityBundle
  capability_id: string
}> {
  const now = ttlMsOffset < 0 ? new Date(Date.now() + ttlMsOffset) : undefined
  const result = await authority.issue({
    install_id: installId,
    persona_id: persona,
    task_id: uuidv7(),
    sprint_id: uuidv7(),
    session_id: uuidv7(),
    scopes,
    ttl_ms: ttlMsOffset < 0 ? 1 : 60_000,
    justification: 'cbac boundary e2e test',
    actor: systemActor,
    trace_id: uuidv7(),
    now, // back-date so it expires
  })
  return result
}

// ---------------------------------------------------------------------------
// Helper: verify a CapabilityDenied event exists in the DB with correct code
// ---------------------------------------------------------------------------

async function waitForDenialEvent(expectedReasonCode: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { items } = await eventStore.query({
      aggregate_type: 'capability',
      event_type: 'CapabilityDenied',
    })
    const match = items.find(
      (ev) => (ev.payload as Record<string, unknown>)['reason_code'] === expectedReasonCode,
    )
    if (match) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(
    `waitForDenialEvent: no CapabilityDenied with reason_code='${expectedReasonCode}' within ${timeoutMs}ms`,
  )
}

// ---------------------------------------------------------------------------
// Scenario 1: files_write outside scope glob → AUTH_SCOPE_DENIED
// ---------------------------------------------------------------------------

describe('Scenario 1: files_write outside scope glob', () => {
  it('denies write to un-scoped path and emits CapabilityDenied(AUTH_SCOPE_DENIED)', async () => {
    const { bundle, capability_id } = await issueBundle(STANDARD_SCOPES)

    const result = await authority.validateAndEmit(
      bundle,
      'files.write',
      { path: 'config/secret.yaml' }, // outside src/**
      systemActor,
      uuidv7(),
    )

    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason_code).toBe('AUTH_SCOPE_DENIED')
    }

    await waitForDenialEvent('AUTH_SCOPE_DENIED')
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Scenario 2: channel_post on un-scoped channel → AUTH_SCOPE_DENIED
// ---------------------------------------------------------------------------

describe('Scenario 2: channel_post on un-scoped channel', () => {
  it('denies post to #general and emits CapabilityDenied(AUTH_SCOPE_DENIED)', async () => {
    const { bundle } = await issueBundle(STANDARD_SCOPES)

    const result = await authority.validateAndEmit(
      bundle,
      'channel.post',
      { channel: '#general' }, // only #sprint-1 allowed
      systemActor,
      uuidv7(),
    )

    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason_code).toBe('AUTH_SCOPE_DENIED')
    }

    await waitForDenialEvent('AUTH_SCOPE_DENIED')
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Scenario 3: secrets read with un-scoped key → AUTH_SCOPE_DENIED
// ---------------------------------------------------------------------------

describe('Scenario 3: secrets read without explicit key in scope', () => {
  it('denies read of un-scoped secret and emits CapabilityDenied(AUTH_SCOPE_DENIED)', async () => {
    const { bundle } = await issueBundle(STANDARD_SCOPES)

    const result = await authority.validateAndEmit(
      bundle,
      'secrets.read',
      { secret_key: 'SOME_OTHER_SECRET' }, // not in scopes.secrets
      systemActor,
      uuidv7(),
    )

    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason_code).toBe('AUTH_SCOPE_DENIED')
    }

    await waitForDenialEvent('AUTH_SCOPE_DENIED')
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Scenario 4: board_mutate on ticket not in scope → AUTH_SCOPE_DENIED
// ---------------------------------------------------------------------------

describe('Scenario 4: board_mutate on out-of-scope ticket', () => {
  it('denies mutation of ORB-999 and emits CapabilityDenied(AUTH_SCOPE_DENIED)', async () => {
    const { bundle } = await issueBundle(STANDARD_SCOPES)

    const result = await authority.validateAndEmit(
      bundle,
      'board.mutate',
      { target: 'ticket:ORB-999' }, // only ticket:ORB-1 in scope
      systemActor,
      uuidv7(),
    )

    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason_code).toBe('AUTH_SCOPE_DENIED')
    }

    await waitForDenialEvent('AUTH_SCOPE_DENIED')
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Scenario 5: network_egress to host not in scope → AUTH_SCOPE_DENIED
// ---------------------------------------------------------------------------

describe('Scenario 5: network_egress to un-scoped host', () => {
  it('denies fetch to evil.example.com and emits CapabilityDenied(AUTH_SCOPE_DENIED)', async () => {
    const { bundle } = await issueBundle(STANDARD_SCOPES)

    const result = await authority.validateAndEmit(
      bundle,
      'network.fetch',
      { url: 'https://evil.example.com/steal-data' }, // not in scope
      systemActor,
      uuidv7(),
    )

    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason_code).toBe('AUTH_SCOPE_DENIED')
    }

    await waitForDenialEvent('AUTH_SCOPE_DENIED')
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Scenario 6: expired bundle → AUTH_CAPABILITY_EXPIRED (via gateway connect)
// ---------------------------------------------------------------------------

describe('Scenario 6: expired bundle rejected at gateway connect', () => {
  it('rejects expired bundle at connect and emits CapabilityDenied(AUTH_CAPABILITY_EXPIRED)', async () => {
    // Issue bundle back-dated so it expired before now.
    const { bundle } = await issueBundle(STANDARD_SCOPES, 'sr-dev', -10_000)

    const socket = await connectSocket()
    try {
      const connectRes = await sendRequest(socket, {
        jsonrpc: '2.0',
        id: 1,
        method: 'connect',
        params: { bundle },
      })

      expect(connectRes['error']).toBeDefined()
      const err = connectRes['error'] as Record<string, unknown>
      // JSON-RPC code = -32001 (CAPABILITY_DENIED); Orbital code in err.data.code
      expect(err['code']).toBe(-32001)
      const errData = err['data'] as Record<string, unknown>
      expect(errData['code']).toBe('AUTH_CAPABILITY_EXPIRED')

      // CapabilityDenied event must appear in the event log.
      await waitForDenialEvent('AUTH_CAPABILITY_EXPIRED')
    } finally {
      socket.destroy()
    }
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Scenario 7: revoked bundle → AUTH_CAPABILITY_REVOKED (via gateway connect)
// ---------------------------------------------------------------------------

describe('Scenario 7: revoked bundle rejected at gateway connect', () => {
  it('rejects revoked bundle at connect and emits CapabilityDenied(AUTH_CAPABILITY_REVOKED)', async () => {
    const { bundle, capability_id } = await issueBundle(STANDARD_SCOPES)

    // Revoke the capability before attempting to connect.
    await authority.revoke(capability_id, {
      reason: 'admin_action',
      reason_detail: 'cbac e2e revoke test',
      actor: systemActor,
      trace_id: uuidv7(),
    })

    const socket = await connectSocket()
    try {
      const connectRes = await sendRequest(socket, {
        jsonrpc: '2.0',
        id: 1,
        method: 'connect',
        params: { bundle },
      })

      expect(connectRes['error']).toBeDefined()
      const err = connectRes['error'] as Record<string, unknown>
      // JSON-RPC code = -32001 (CAPABILITY_DENIED); Orbital code in err.data.code
      expect(err['code']).toBe(-32001)
      const errData = err['data'] as Record<string, unknown>
      expect(errData['code']).toBe('AUTH_CAPABILITY_REVOKED')

      // CapabilityDenied event must appear.
      await waitForDenialEvent('AUTH_CAPABILITY_REVOKED')
    } finally {
      socket.destroy()
    }
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Scenario 8: tampered bundle (wrong signature) → AUTH_INVALID_CAPABILITY
// ---------------------------------------------------------------------------

describe('Scenario 8: tampered bundle rejected at gateway connect', () => {
  it('rejects tampered bundle at connect and emits CapabilityDenied(AUTH_INVALID_CAPABILITY)', async () => {
    const { bundle } = await issueBundle(STANDARD_SCOPES)

    // Tamper: escalate file_write scope without re-signing.
    const tampered: CapabilityBundle = {
      ...bundle,
      scopes: {
        ...bundle.scopes,
        files_write: ['/**'], // escalated without valid signature
      },
    }

    const socket = await connectSocket()
    try {
      const connectRes = await sendRequest(socket, {
        jsonrpc: '2.0',
        id: 1,
        method: 'connect',
        params: { bundle: tampered },
      })

      expect(connectRes['error']).toBeDefined()
      const err = connectRes['error'] as Record<string, unknown>
      // JSON-RPC code = -32001 (CAPABILITY_DENIED); Orbital code in err.data.code
      expect(err['code']).toBe(-32001)
      const errData = err['data'] as Record<string, unknown>
      // Tampered signature → gateway verify() returns AUTH_INVALID_SIGNATURE
      // (the bundle parses correctly but signature verification fails)
      expect(errData['code']).toBe('AUTH_INVALID_SIGNATURE')

      await waitForDenialEvent('AUTH_INVALID_SIGNATURE')
    } finally {
      socket.destroy()
    }
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Scenario 9: SoD violation at issue time → AUTH_SOD_VIOLATION
// ---------------------------------------------------------------------------

describe('Scenario 9: SoD violation — verifier with files_write on reviewed paths', () => {
  it('rejects issuance with AUTH_SOD_VIOLATION and emits CapabilityDenied', async () => {
    await expect(
      authority.issue({
        install_id: installId,
        persona_id: 'verifier',
        task_id: uuidv7(),
        sprint_id: uuidv7(),
        session_id: uuidv7(),
        scopes: {
          ...STANDARD_SCOPES,
          files_write: ['src/**'], // verifier writing to paths it reads = SoD
        },
        justification: 'cbac sod e2e test',
        actor: systemActor,
        trace_id: uuidv7(),
        sod_context: {
          verification_target: ['src/billing/invoice.ts'],
        },
      }),
    ).rejects.toMatchObject({ code: 'AUTH_SOD_VIOLATION' })

    // CapabilityDenied event emitted by the authority for the denied issuance.
    await waitForDenialEvent('AUTH_SOD_VIOLATION')
  }, 30_000)
})

// ---------------------------------------------------------------------------
// Scenario 10: spawn_subagent=false, worker tries to spawn → AUTH_SCOPE_DENIED
// ---------------------------------------------------------------------------

describe('Scenario 10: spawn_subagent=false, worker tries to spawn subagent', () => {
  it('denies spawn_subagent call and emits CapabilityDenied(AUTH_SCOPE_DENIED)', async () => {
    const scopesNoSpawn: Scopes = {
      ...STANDARD_SCOPES,
      spawn_subagent: false,
    }
    const { bundle } = await issueBundle(scopesNoSpawn)

    const result = await authority.validateAndEmit(
      bundle,
      'agent.spawn_subagent',
      { persona: 'architect', task_id: uuidv7() },
      systemActor,
      uuidv7(),
    )

    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.reason_code).toBe('AUTH_SCOPE_DENIED')
    }

    await waitForDenialEvent('AUTH_SCOPE_DENIED')
  }, 30_000)
})
