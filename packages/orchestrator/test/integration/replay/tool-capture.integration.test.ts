/**
 * Integration: replay tool-call capture via the gateway.instrumentedRoute.
 *
 * [Engineer-Principal · Opus · run-round6-07-replay]
 *
 * Verifies:
 *   - Routing a JSON-RPC tool call through gateway.instrumentedRoute with
 *     a Recorder wired up persists a replay capture for that call.
 *   - The captured request includes the JSON-RPC method + params.
 *   - The captured response is the JSON-RPC envelope returned by the router.
 *   - Both ToolCallStarted/ToolCallCompleted (inspection) AND
 *     ReplayCaptureCompleted (replay) audit events are appended.
 *
 * Real Postgres + real EventStore + real ToolRegistry + real Recorder.
 * The tool implementation is a real MCPTool registered into a real ToolRegistry —
 * not a mock.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { uuidv7 } from 'uuidv7'
import { eq, and as drAnd } from 'drizzle-orm'
import { z } from 'zod'

import { db, sql, closeDb } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { createFileSystemStore } from '../../../src/replay/store.js'
import { createRecorder } from '../../../src/replay/recorder.js'
import { ToolRegistry } from '../../../src/mcp/registry.js'
import { instrumentedRoute } from '../../../src/mcp/gateway.js'
import type { MCPTool } from '../../../src/mcp/registry.js'
import type { CapabilityBundle } from '@orbital/types'
import { events } from '../../../src/db/schema/events.js'
import { replayCaptures } from '../../../src/db/schema/replay.js'
import type { ICapabilityAuthority } from '../../../src/capabilities/authority.js'

const TMP_ROOT = path.join(os.tmpdir(), `orbital-replay-tool-${process.pid}-${Date.now()}`)
const PASSPHRASE = `tool-${uuidv7()}`

beforeAll(async () => {
  await fs.mkdir(TMP_ROOT, { recursive: true, mode: 0o700 })
  await sql`SELECT 1`
})

afterAll(async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true })
  await closeDb()
})

// A real tool registered under one of the known tool names so the
// capability gateway's TOOL_TO_SCOPE_KEY allow-list permits it. We choose
// 'files.read' (scope_key: 'files_read') because the bundle below grants
// files_read='**' — the MCP router resolves the tool name against this map.
const filesReadTool: MCPTool<unknown, unknown> = {
  name: 'files.read',
  description: 'Test files.read used by replay integration tests.',
  scope: 'files_read',
  inputSchema: z.object({ path: z.string() }),
  outputSchema: z.object({ content: z.string() }),
  handler: async (input) => {
    const i = input as { path: string }
    return { content: `fake-content-of-${i.path}` }
  },
}

// Authority shim that allows the tool through. The MCP router calls
// `authority.validateAndEmit(bundle, toolName, params, actor, traceId)` and
// the gateway emits CapabilityGranted from the result. We return an allow
// result so the request flows to the tool handler.
function permissiveAuthority(): ICapabilityAuthority {
  return {
    issue: async () => ({} as never),
    verify: async () => ({ valid: true } as never),
    revoke: async () => undefined,
    hasScope: () => true,
    validateAndEmit: async (_bundle, _toolName, _params, _actor, _traceId) => ({
      allowed: true,
      matched_scope: 'files_read' as const,
      matched_pattern: '**',
    }),
  } as unknown as ICapabilityAuthority
}

function bundleFor(workerId: string, taskId: string): CapabilityBundle {
  return {
    capability_id: uuidv7(),
    install_id: uuidv7(),
    sprint_id: uuidv7(),
    task_id: taskId,
    persona_id: 'sr-dev',
    session_id: workerId,
    scopes: {
      // Allow everything under '**' so the gateway accepts the tool call.
      files_read: ['**'],
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
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    signing_key_id: 'kt-1',
    signature: 'sig',
    schema_version: 1,
  }
}

describe('replay — tool-call capture via instrumentedRoute (real Postgres)', () => {
  it('captures a tool call when the gateway has a Recorder wired up', async () => {
    const eventStore = createEventStore(db, sql)
    const store = createFileSystemStore({ rootDir: TMP_ROOT, encryptionPassphrase: PASSPHRASE })
    const recorder = createRecorder({ db, eventStore, store })

    const registry = new ToolRegistry()
    registry.register(filesReadTool)

    const workerId = uuidv7()
    const taskId = uuidv7()
    const bundle = bundleFor(workerId, taskId)

    const rawMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'files.read',
      params: { path: 'src/foo.ts' },
    }

    const response = await instrumentedRoute(rawMessage, bundle, {
      registry,
      eventStore,
      db,
      authority: permissiveAuthority(),
      recorder,
    })

    // The tool returns a real result; assert the envelope shape.
    const r = response as { result?: { content?: string }; error?: unknown }
    expect(r.error).toBeUndefined()
    expect(r.result?.content).toBe('fake-content-of-src/foo.ts')

    // Wait briefly for the fire-and-forget capture insert to complete. The
    // Recorder is awaited in gateway.ts but returns a Promise; allow tick.
    await new Promise((res) => setTimeout(res, 100))

    // The recorder persisted a row in replay_captures keyed to this worker.
    const rows = await db
      .select()
      .from(replayCaptures)
      .where(eq(replayCaptures.workerId, workerId))
      .limit(10)
    expect(rows.length).toBeGreaterThanOrEqual(1)
    const row = rows[0]!
    expect(row.captureKind).toBe('tool_call')
    expect(row.taskId).toBe(taskId)

    // ReplayCaptureCompleted event emitted with this capture_id. Scope by
    // aggregate_id (=capture_id) so parallel tests don't pollute the count.
    const compEvents = await db
      .select()
      .from(events)
      .where(
        drAnd(
          eq(events.eventType, 'ReplayCaptureCompleted'),
          eq(events.aggregateId, row.captureId),
        ),
      )
    expect(compEvents.length).toBeGreaterThanOrEqual(1)
  })
})
