/**
 * MCP Router — per-call: parse request → look up tool → validate capability →
 * invoke handler → write audit events → return response.
 *
 * Per Implementation Plan §6 Task 2B and TRD-06 §6.2.1.
 *
 * The router is the single choke-point through which every tool call passes.
 * It:
 * 1. Parses and validates the JSON-RPC request shape.
 * 2. Resolves the registered tool.
 * 3. Validates the parsed input params against the tool's inputSchema.
 * 4. For tools with bypassScopeCheck=false: calls validateToolCall (gateway.ts)
 *    which enforces scope rules from TRD-06 §6.2.2–6.2.3.
 * 5. On deny: emits CapabilityDenied event; returns MCP error.
 * 6. On allow: invokes handler inside an OTel span.
 * 7. Returns the result or error as a JSON-RPC response.
 */

import { z } from 'zod'
import { uuidv7 } from 'uuidv7'
import { validateToolCall } from '../capabilities/gateway.js'
import type { ICapabilityAuthority } from '../capabilities/authority.js'
import type { IToolRegistry, ToolContext } from './registry.js'
import {
  makeResult,
  makeError,
  makeCapabilityError,
  MCP_ERROR_CODES,
  JsonRpcRequestSchema,
  type JsonRpcResponse,
} from './protocol.js'
import { withToolSpan, resolveTraceId } from './middleware/tracing.js'
import { emitCapabilityDenied } from './middleware/audit.js'
import type { EventStore } from '../events/store.js'
import type { DB } from '../db/client.js'
import type { CapabilityBundle, Actor } from '@orbital/types'
import { logger } from '../config/logger.js'

export interface RouterDeps {
  registry: IToolRegistry
  eventStore: EventStore
  db: DB
  /** Used to emit CapabilityGranted on allow path. */
  authority: ICapabilityAuthority
}

/**
 * Route a single raw JSON-RPC message (already parsed from the wire).
 *
 * @param rawMessage The parsed JSON object from the socket line.
 * @param bundle The verified capability bundle from connection state.
 *               Null if the worker has not yet sent a connect request.
 */
export async function routeMessage(
  rawMessage: unknown,
  bundle: CapabilityBundle | null,
  deps: RouterDeps,
): Promise<JsonRpcResponse> {
  // Step 1: parse and shape-check the JSON-RPC request.
  const parsed = JsonRpcRequestSchema.safeParse(rawMessage)
  if (!parsed.success) {
    return makeError(null, MCP_ERROR_CODES.INVALID_REQUEST, 'Invalid JSON-RPC request shape')
  }

  const req = parsed.data
  const { id, method, params = {} } = req

  // Step 2: the 'connect' method is handled by the server, not the router.
  // If it reaches here the server already processed it; return ok.
  if (method === 'connect') {
    return makeResult(id, { connected: true })
  }

  // Step 3: require a valid bundle for all non-connect methods.
  if (!bundle) {
    return makeCapabilityError(
      id,
      'AUTH_INVALID_CAPABILITY',
      'Worker has not sent a connect request with a capability bundle',
      uuidv7(),
    )
  }

  // Step 4: look up the tool.
  const tool = deps.registry.get(method)
  if (!tool) {
    return makeError(id, MCP_ERROR_CODES.METHOD_NOT_FOUND, `Unknown tool: ${method}`)
  }

  // Step 5: validate input params against the tool's inputSchema.
  const inputParsed = tool.inputSchema.safeParse(params)
  if (!inputParsed.success) {
    return makeError(
      id,
      MCP_ERROR_CODES.INVALID_PARAMS,
      `Invalid params for ${method}: ${inputParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    )
  }

  const input = inputParsed.data

  // Step 6: scope validation (skip for bypassScopeCheck tools).
  const traceId = resolveTraceId(bundle.capability_id, id)
  const actor: Actor = {
    type: 'persona',
    persona_id: bundle.persona_id,
    session_id: bundle.session_id,
    task_id: bundle.task_id,
  }

  if (!tool.bypassScopeCheck) {
    const validation = validateToolCall(bundle, method, params)
    if (!validation.allowed) {
      logger.warn(
        { tool: method, reason: validation.reason_code, worker: bundle.session_id, trace_id: traceId },
        'mcp: tool call denied',
      )

      await emitCapabilityDenied(deps.eventStore, deps.db, bundle, method, validation, traceId)

      return makeCapabilityError(id, validation.reason_code, validation.reason_detail, traceId, {
        tool: method,
        attempted_target: validation.attempted_target,
      })
    }

    // Emit CapabilityGranted on allow.
    await deps.authority
      .validateAndEmit(bundle, method, params, actor, traceId)
      .catch((err) => {
        logger.error({ err, tool: method }, 'router: failed to emit CapabilityGranted')
      })
  }

  // Step 7: invoke handler inside OTel span.
  const ctx: ToolContext = {
    bundle,
    db: deps.db,
    eventStore: deps.eventStore,
    traceId,
    workerId: bundle.session_id,
  }

  try {
    const { result } = await withToolSpan(method, traceId, async (_span, _resolvedTraceId) => {
      return tool.handler(input, ctx)
    })

    return makeResult(id, result)
  } catch (err) {
    logger.error({ err, tool: method, trace_id: traceId }, 'mcp: tool handler threw')
    return makeError(
      id,
      MCP_ERROR_CODES.INTERNAL_ERROR,
      err instanceof Error ? err.message : 'Internal error',
      { trace_id: traceId },
    )
  }
}
