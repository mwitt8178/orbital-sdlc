/**
 * mcp/gateway.ts — Instrumented entry point for MCP tool calls.
 *
 * This is a thin instrumentation wrapper around the existing `routeMessage`
 * function in router.ts. Every tool call passes through here; the gateway:
 *
 *   1. Emits `ToolCallStarted` BEFORE invoking the tool.
 *   2. Delegates to routeMessage (which handles capability checks + handler).
 *   3. Emits `ToolCallCompleted` AFTER (with status='ok'|'err', durationMs,
 *      args summary, result excerpt). Both happy and error paths emit
 *      ToolCallCompleted — the error path is handled in the catch block.
 *
 * The MCP server.ts uses this function instead of calling routeMessage
 * directly. Existing routeMessage import paths in tests remain unchanged.
 *
 * Wave 3b (#7 replay) depends on ToolCallStarted/ToolCallCompleted being the
 * capture trigger. Do not remove or rename these events.
 *
 * [Engineer-Sr · Sonnet · run-round6-10-inspection]
 */

import { uuidv7 } from 'uuidv7'
import type { CapabilityBundle } from '@orbital/types'
import type { EventStore } from '../events/store.js'
import type { DB } from '../db/client.js'
import type { ICapabilityAuthority } from '../capabilities/authority.js'
import type { IToolRegistry } from './registry.js'
import { routeMessage, type RouterDeps } from './router.js'
import type { JsonRpcResponse } from './protocol.js'
import { logger } from '../config/logger.js'
import type {
  ToolCallStartedPayload,
  ToolCallCompletedPayload,
} from '../events/types.js'
import type { Actor } from '@orbital/types'
// Round 6 #7 — Determinism / Replay
// [Engineer-Principal · Opus · run-round6-07-replay]
import type { Recorder } from '../replay/recorder.js'

// ---------------------------------------------------------------------------
// Gateway deps (superset of RouterDeps)
// ---------------------------------------------------------------------------

export interface GatewayDeps {
  registry: IToolRegistry
  eventStore: EventStore
  db: DB
  authority: ICapabilityAuthority
  /**
   * Round 6 #7 — Determinism / Replay
   * Optional Recorder. When provided, every tool call's full request +
   * response is captured for replay. Absent in legacy tests; present in boot.
   * [Engineer-Principal · Opus · run-round6-07-replay]
   */
  recorder?: Recorder
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }
const MAX_ARG_SUMMARY = 200
const MAX_RESULT_EXCERPT = 200

function summariseArgs(params: unknown): string {
  try {
    const raw = JSON.stringify(params) ?? ''
    return raw.slice(0, MAX_ARG_SUMMARY)
  } catch {
    return '(unserializable)'
  }
}

/**
 * Validate that a string is a UUID (v4 or v7). Used to gate inserting bundle
 * fields into the replay_captures uuid columns — a non-UUID task_id would
 * cause a DB error and orphan the blob on disk.
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
function uuidOrNull(value: string | null | undefined): string | null {
  if (!value) return null
  return UUID_RE.test(value) ? value : null
}

function excerptResult(result: unknown): string {
  try {
    const raw = JSON.stringify(result) ?? ''
    return raw.slice(0, MAX_RESULT_EXCERPT)
  } catch {
    return '(unserializable)'
  }
}

async function emitToolCallStarted(
  eventStore: EventStore,
  workerId: string,
  toolCallId: string,
  toolName: string,
  params: unknown,
  traceId: string,
): Promise<void> {
  const payload: ToolCallStartedPayload = {
    worker_id: workerId,
    tool_call_id: toolCallId,
    tool_name: toolName,
    args_summary: summariseArgs(params),
    started_at: new Date().toISOString(),
  }
  await eventStore.append({
    aggregate_id: workerId,
    aggregate_type: 'orchestration',
    event_type: 'ToolCallStarted',
    payload: payload as unknown as Record<string, unknown>,
    actor: SYSTEM_ACTOR,
    trace_id: traceId,
    occurred_at: new Date().toISOString(),
    schema_version: 1,
  })
}

async function emitToolCallCompleted(
  eventStore: EventStore,
  workerId: string,
  toolCallId: string,
  toolName: string,
  status: 'ok' | 'err',
  durationMs: number,
  resultOrError: unknown,
  traceId: string,
): Promise<void> {
  const payload: ToolCallCompletedPayload = {
    worker_id: workerId,
    tool_call_id: toolCallId,
    tool_name: toolName,
    status,
    duration_ms: durationMs,
    result_excerpt: excerptResult(resultOrError),
    completed_at: new Date().toISOString(),
  }
  await eventStore.append({
    aggregate_id: workerId,
    aggregate_type: 'orchestration',
    event_type: 'ToolCallCompleted',
    payload: payload as unknown as Record<string, unknown>,
    actor: SYSTEM_ACTOR,
    trace_id: traceId,
    occurred_at: new Date().toISOString(),
    schema_version: 1,
  })
}

// ---------------------------------------------------------------------------
// Main export: instrumentedRoute
// ---------------------------------------------------------------------------

/**
 * Instrument a single raw JSON-RPC message with ToolCallStarted/ToolCallCompleted
 * events, then delegate to routeMessage.
 *
 * The `connect` method is not instrumented (no tool invocation involved).
 * All other methods emit ToolCallStarted before and ToolCallCompleted after,
 * regardless of whether they succeed or fail.
 */
export async function instrumentedRoute(
  rawMessage: unknown,
  bundle: CapabilityBundle | null,
  deps: GatewayDeps,
): Promise<JsonRpcResponse> {
  // Extract method and params safely (same parsing the router does,
  // but we need the values BEFORE the router validates them).
  const msg = rawMessage as Record<string, unknown>
  const method = typeof msg['method'] === 'string' ? msg['method'] : null
  const params = msg['params'] ?? {}
  const workerId = bundle?.session_id ?? 'unknown'

  // Pass-through for system messages (connect, tools/list, etc.)
  const skipInstrumentation = !method || method === 'connect' || method.startsWith('tools/')

  const routerDeps: RouterDeps = {
    registry: deps.registry,
    eventStore: deps.eventStore,
    db: deps.db,
    authority: deps.authority,
  }

  if (skipInstrumentation) {
    return routeMessage(rawMessage, bundle, routerDeps)
  }

  // --- Instrumented path ---
  const toolCallId = uuidv7()
  const traceId = uuidv7()
  const startMs = Date.now()

  // Emit ToolCallStarted
  try {
    await emitToolCallStarted(
      deps.eventStore,
      workerId,
      toolCallId,
      method,
      params,
      traceId,
    )
  } catch (err) {
    // Event emission failure MUST NOT block the tool call.
    logger.warn({ err, method, workerId }, 'gateway: failed to emit ToolCallStarted')
  }

  let response: JsonRpcResponse
  let callStatus: 'ok' | 'err' = 'ok'
  let resultForExcerpt: unknown

  try {
    response = await routeMessage(rawMessage, bundle, routerDeps)
    // Check if the response itself is an error (JSON-RPC error response)
    const r = response as Record<string, unknown>
    if (r['error'] !== undefined) {
      callStatus = 'err'
      resultForExcerpt = r['error']
    } else {
      resultForExcerpt = r['result']
    }
  } catch (err) {
    callStatus = 'err'
    resultForExcerpt = err instanceof Error ? err.message : String(err)
    const durationMs = Date.now() - startMs
    // Emit ToolCallCompleted on throw path
    try {
      await emitToolCallCompleted(
        deps.eventStore,
        workerId,
        toolCallId,
        method,
        callStatus,
        durationMs,
        resultForExcerpt,
        traceId,
      )
    } catch (emitErr) {
      logger.warn({ emitErr, method, workerId }, 'gateway: failed to emit ToolCallCompleted (err path)')
    }
    // Round 6 #7 — capture the failed tool call too. Replay needs the err to
    // reproduce the failure mode for triage.
    if (deps.recorder) {
      const taskIdRaw = uuidOrNull(bundle?.task_id ?? null)
      const workerIdForCapture = uuidOrNull(workerId)
      const errBody = {
        error: true,
        message: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : 'Error',
      }
      await deps.recorder
        .captureTool({
          workerId: workerIdForCapture,
          taskId: taskIdRaw,
          eventId: null,
          request: { method, params },
          response: errBody,
          traceId,
        })
        .catch((capErr) => {
          logger.warn({ capErr, method, workerId }, 'gateway: captureTool (err) failed')
        })
    }
    throw err
  }

  // Emit ToolCallCompleted on normal path
  const durationMs = Date.now() - startMs
  try {
    await emitToolCallCompleted(
      deps.eventStore,
      workerId,
      toolCallId,
      method,
      callStatus,
      durationMs,
      resultForExcerpt,
      traceId,
    )
  } catch (err) {
    logger.warn({ err, method, workerId }, 'gateway: failed to emit ToolCallCompleted (ok path)')
  }

  // Round 6 #7 — capture the full request + response on the ok path.
  if (deps.recorder) {
    const taskIdRaw = uuidOrNull(bundle?.task_id ?? null)
    const workerIdForCapture = uuidOrNull(workerId)
    await deps.recorder
      .captureTool({
        workerId: workerIdForCapture,
        taskId: taskIdRaw,
        eventId: null,
        request: { method, params },
        response: response as unknown as Record<string, unknown>,
        traceId,
      })
      .catch((capErr) => {
        logger.warn({ capErr, method, workerId }, 'gateway: captureTool (ok) failed')
      })
  }

  return response
}
