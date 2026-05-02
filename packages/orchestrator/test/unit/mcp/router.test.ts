/**
 * Unit tests for the MCP Router.
 *
 * Uses in-memory doubles for EventStore, DB, and authority to keep these
 * pure unit tests (no real Postgres required).
 *
 * Tests:
 * - METHOD_NOT_FOUND for unknown tool
 * - INVALID_PARAMS for bad input
 * - Scope check denied → CapabilityDenied emitted, error returned
 * - bypassScopeCheck=true → handler called without scope check
 * - Happy path: handler invoked, result returned
 * - connect method handled gracefully
 * - No bundle → NOT_CONNECTED error
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { z } from 'zod'
import { uuidv7 } from 'uuidv7'
import { routeMessage } from '../../../src/mcp/router.js'
import { ToolRegistry } from '../../../src/mcp/registry.js'
import type { MCPTool, ToolContext } from '../../../src/mcp/registry.js'
import type { RouterDeps } from '../../../src/mcp/router.js'
import type { CapabilityBundle, Actor } from '@orbital/types'
import type { EventStore } from '../../../src/events/store.js'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeBundle(overrides: Partial<CapabilityBundle> = {}): CapabilityBundle {
  return {
    capability_id: uuidv7(),
    install_id: uuidv7(),
    persona_id: 'test-persona',
    session_id: uuidv7(),
    task_id: uuidv7(),
    sprint_id: uuidv7(),
    scopes: {
      files_read: ['src/**'],
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

function makeEventStoreSpy(): EventStore & { appended: unknown[] } {
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

function makeAuthoritySpy(allowed: boolean) {
  return {
    async issue() { return {} as never },
    async verify() { return { ok: true } },
    async revoke() {},
    hasScope() { return false },
    async validateAndEmit(_bundle: unknown, _tool: unknown, _params: unknown, _actor: unknown, _traceId: unknown) {
      return allowed ? { allowed: true, matched_scope: 'files_read' as const, matched_pattern: 'src/**' } : { allowed: false, reason_code: 'AUTH_SCOPE_DENIED', reason_detail: 'denied', attempted_target: 'test' }
    },
  }
}

function makeDbSpy() {
  return {
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
  } as never
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('routeMessage', () => {
  let registry: ToolRegistry
  let eventStore: ReturnType<typeof makeEventStoreSpy>
  let deps: RouterDeps

  beforeEach(() => {
    registry = new ToolRegistry()
    eventStore = makeEventStoreSpy()
    deps = {
      registry,
      eventStore,
      db: makeDbSpy(),
      authority: makeAuthoritySpy(true) as never,
    }
  })

  it('returns METHOD_NOT_FOUND for unknown tool', async () => {
    const bundle = makeBundle()
    const res = await routeMessage(
      { jsonrpc: '2.0', id: 1, method: 'nonexistent.tool', params: {} },
      bundle,
      deps,
    )
    expect(res).toHaveProperty('error')
    const err = (res as { error: { code: number } }).error
    expect(err.code).toBe(-32601) // METHOD_NOT_FOUND
  })

  it('returns INVALID_REQUEST for non-JSON-RPC message', async () => {
    const bundle = makeBundle()
    const res = await routeMessage({ not: 'valid' }, bundle, deps)
    expect(res).toHaveProperty('error')
    const err = (res as { error: { code: number } }).error
    expect(err.code).toBe(-32600) // INVALID_REQUEST
  })

  it('returns error when no bundle provided (not connected)', async () => {
    const res = await routeMessage(
      { jsonrpc: '2.0', id: 1, method: 'any.tool', params: {} },
      null,
      deps,
    )
    expect(res).toHaveProperty('error')
    const err = (res as { error: { code: number; data: { code: string } } }).error
    expect(err.code).toBe(-32001) // CAPABILITY_DENIED
    expect(err.data.code).toBe('AUTH_INVALID_CAPABILITY')
  })

  it('returns INVALID_PARAMS for bad tool input', async () => {
    const tool: MCPTool = {
      name: 'test.tool',
      description: 'test',
      inputSchema: z.object({ required_field: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      bypassScopeCheck: true,
      async handler(_input, _ctx) { return { ok: true } },
    }
    registry.register(tool)
    const bundle = makeBundle()

    const res = await routeMessage(
      { jsonrpc: '2.0', id: 2, method: 'test.tool', params: { wrong_field: 123 } },
      bundle,
      deps,
    )
    expect(res).toHaveProperty('error')
    const err = (res as { error: { code: number } }).error
    expect(err.code).toBe(-32602) // INVALID_PARAMS
  })

  it('bypass-scope tool: calls handler directly, returns result', async () => {
    const tool: MCPTool = {
      name: 'worker.heartbeat',
      description: 'heartbeat',
      inputSchema: z.object({ worker_id: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      bypassScopeCheck: true,
      async handler(_input, _ctx) { return { ok: true } },
    }
    registry.register(tool)
    const bundle = makeBundle()

    const res = await routeMessage(
      { jsonrpc: '2.0', id: 3, method: 'worker.heartbeat', params: { worker_id: uuidv7() } },
      bundle,
      deps,
    )
    expect(res).toHaveProperty('result')
    expect((res as { result: { ok: boolean } }).result).toEqual({ ok: true })
  })

  it('scope-checked tool: denied → CapabilityDenied event emitted', async () => {
    // Override authority to deny.
    deps.authority = makeAuthoritySpy(false) as never

    // Register a scope-checked tool (files.read checks files_read scope).
    const tool: MCPTool = {
      name: 'files.read',
      description: 'file read',
      inputSchema: z.object({ path: z.string() }),
      outputSchema: z.object({ content: z.string() }),
      bypassScopeCheck: false,
      async handler(_input, _ctx) { return { content: 'data' } },
    }
    registry.register(tool)

    const bundle = makeBundle({
      scopes: {
        files_read: [], // empty — will be denied
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
    })

    const res = await routeMessage(
      { jsonrpc: '2.0', id: 4, method: 'files.read', params: { path: 'src/secret.ts' } },
      bundle,
      deps,
    )
    expect(res).toHaveProperty('error')
    const err = (res as { error: { code: number; data: { code: string } } }).error
    expect(err.code).toBe(-32001) // CAPABILITY_DENIED
    // CapabilityDenied event should have been emitted.
    expect(eventStore.appended.length).toBeGreaterThan(0)
    const denied = eventStore.appended.find(
      (e: unknown) => (e as { event_type: string }).event_type === 'CapabilityDenied',
    )
    expect(denied).toBeDefined()
  })

  it('connect method returns connected=true without bundle check', async () => {
    const bundle = makeBundle()
    const res = await routeMessage(
      { jsonrpc: '2.0', id: 0, method: 'connect', params: { bundle } },
      bundle,
      deps,
    )
    expect(res).toHaveProperty('result')
    expect((res as { result: { connected: boolean } }).result.connected).toBe(true)
  })
})
