/**
 * MCP Gateway protocol — JSON-RPC 2.0 over newline-delimited Unix socket.
 *
 * Per TRD-00 §9.2 and Primitives §10.
 *
 * Wire format: each message is a single line of JSON followed by '\n'.
 * The server reads lines from the socket via readline and writes '\n'-terminated
 * JSON lines back.
 *
 * First message from every connecting worker MUST be a 'connect' request
 * carrying the serialized capability bundle as params.bundle. The gateway
 * parses and verifies the bundle once, then holds it in connection state
 * for all subsequent calls.
 *
 * Streaming convention (Phase 3A extension):
 * --------------------------------------------
 * Some tools are long-lived streaming subscriptions (e.g. `inbox.subscribe`).
 * For these tools, a single client request id may produce MULTIPLE response
 * frames. The wire convention:
 *
 *   1. Request: { jsonrpc:'2.0', id: <req-id>, method: 'inbox.subscribe', params: {...} }
 *   2. Server writes one or more JSON-RPC notification frames as the stream
 *      progresses:
 *        { jsonrpc:'2.0', method:'inbox.event', params:{ subscription_id, envelope, final:false } }
 *      Notifications carry no `id` field per JSON-RPC 2.0 spec.
 *   3. When the stream ends (consumer cancels, capability revoked, server
 *      shutdown), server writes a final response:
 *        { jsonrpc:'2.0', id:<req-id>, result:{ closed:true, reason:'...' } }
 *
 * Tools opt in to streaming by setting `streaming: true` on the registered
 * MCPTool. The router detects this flag and dispatches via the streaming
 * code path; server.ts owns the per-connection write loop.
 */

import { z } from 'zod'
import { CapabilityBundleSchema } from '@orbital/types'

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 wire shapes
// ---------------------------------------------------------------------------

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
})

export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>

export const JsonRpcErrorObjectSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
})

export type JsonRpcErrorObject = z.infer<typeof JsonRpcErrorObjectSchema>

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: JsonRpcErrorObject }

// ---------------------------------------------------------------------------
// Orbital-specific error codes for JSON-RPC (using JSON-RPC application range)
// ---------------------------------------------------------------------------

/** JSON-RPC application-defined error codes (-32000 to -32099). */
export const MCP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** Orbital: capability denied (AUTH_SCOPE_DENIED, AUTH_CAPABILITY_EXPIRED, etc.) */
  CAPABILITY_DENIED: -32001,
  /** Orbital: validation error in tool params */
  VALIDATION_ERROR: -32002,
  /** Orbital: worker not yet connected (bundle not provided) */
  NOT_CONNECTED: -32003,
} as const

// ---------------------------------------------------------------------------
// connect request shape — first message from every worker
// ---------------------------------------------------------------------------

/**
 * The connect request carries the serialized capability bundle.
 * The gateway reads bundle directly from params.bundle — no file system access.
 * This decouples the gateway from the filesystem and matches the implementation
 * note in the spec: worker sends bundle JSON on its first message.
 */
export const ConnectParamsSchema = z.object({
  bundle: CapabilityBundleSchema,
})

export type ConnectParams = z.infer<typeof ConnectParamsSchema>

// ---------------------------------------------------------------------------
// Helper to build well-formed response objects
// ---------------------------------------------------------------------------

export function makeResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

export function makeError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  const error: JsonRpcErrorObject = { code, message }
  if (data !== undefined) error.data = data
  return { jsonrpc: '2.0', id, error }
}

/**
 * Build an Orbital-style capability denial error response following Primitives §10.
 *
 * Includes trace_id in the data field so workers can correlate with audit events.
 */
export function makeCapabilityError(
  id: string | number | null,
  errorCode: string,
  message: string,
  traceId: string,
  details?: Record<string, unknown>,
): JsonRpcResponse {
  return makeError(id, MCP_ERROR_CODES.CAPABILITY_DENIED, message, {
    code: errorCode,
    trace_id: traceId,
    ...details,
  })
}

/**
 * Serialize a response to a newline-terminated JSON string.
 */
export function serializeResponse(response: JsonRpcResponse): string {
  return JSON.stringify(response) + '\n'
}
