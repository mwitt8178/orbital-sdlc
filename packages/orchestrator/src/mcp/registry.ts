/**
 * ToolRegistry — register, deregister, and look up MCP tools.
 *
 * Per Implementation Plan §6 Task 2B and TRD-00 §9.2.
 *
 * Each tool carries:
 *  - name: MCP tool identifier (domain.action)
 *  - description: human-readable
 *  - inputSchema: Zod schema validated before scope check
 *  - outputSchema: Zod schema for the result
 *  - requiredScopes: which scope keys are required (positional allow-list)
 *  - handler: called only after validateToolCall passes
 */

import { z, type ZodTypeAny } from 'zod'
import { OrbitalError, type CapabilityBundle, type ScopeKey } from '@orbital/types'
import type { EventStore } from '../events/store.js'
import type { DB } from '../db/client.js'

// ---------------------------------------------------------------------------
// Tool context — injected into every handler
// ---------------------------------------------------------------------------

export interface ToolContext {
  /** The verified capability bundle for the calling worker. */
  bundle: CapabilityBundle
  /** Drizzle DB instance. */
  db: DB
  /** Event store — use this for all event writes. */
  eventStore: EventStore
  /** OpenTelemetry trace_id for this call. */
  traceId: string
  /** Worker ID derived from bundle.session_id. */
  workerId: string
}

// ---------------------------------------------------------------------------
// MCPTool type — the shape every tool must satisfy
// ---------------------------------------------------------------------------

export interface MCPTool<
  TInput extends ZodTypeAny = ZodTypeAny,
  TOutput extends ZodTypeAny = ZodTypeAny,
> {
  /** MCP tool name: 'domain.action' per Primitives §9.2. */
  name: string
  description: string
  /** Zod schema for the input params. Validated before scope check. */
  inputSchema: TInput
  /** Zod schema for the output result. Applied before returning. */
  outputSchema: TOutput
  /**
   * Scope keys that must be checked by validateToolCall before this handler
   * is invoked. The router calls validateToolCall with the tool name; the
   * TOOL_TO_SCOPE_KEY map in gateway.ts resolves the key.
   *
   * Tools whose names are NOT in TOOL_TO_SCOPE_KEY (e.g. worker.heartbeat,
   * task.complete) use a special bypass: they are system-internal tools that
   * require the bundle to be valid (verified at connect) but do not check a
   * specific file/channel/board scope. The router handles this by checking
   * bundle validity rather than calling validateToolCall for these names.
   */
  bypassScopeCheck?: boolean
  /** Handler invoked with parsed input and context. */
  handler(
    input: z.infer<TInput>,
    ctx: ToolContext,
  ): Promise<z.infer<TOutput>>
  /**
   * Optional streaming flag. If true, the gateway dispatches via the streaming
   * code path: the tool's `streamHandler` returns an AsyncIterable yielding
   * notification payloads, and the gateway writes JSON-RPC notification frames
   * for each yielded value followed by a final response when the iterator ends.
   *
   * `streaming: true` requires `streamHandler` to be implemented; `handler` is
   * invoked first to produce the initial response (typically a stream_ready
   * envelope). Tools may use either `handler` only (returns a single response)
   * or `streaming + streamHandler` (returns a stream of frames).
   */
  streaming?: boolean
  streamHandler?: (
    input: z.infer<TInput>,
    ctx: ToolContext,
  ) => AsyncIterable<unknown>
}

// ---------------------------------------------------------------------------
// ToolRegistry
// ---------------------------------------------------------------------------

export interface IToolRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(tool: MCPTool<any, any>): void
  deregister(toolName: string): void
  list(): MCPTool[]
  get(toolName: string): MCPTool | undefined
}

export class ToolRegistry implements IToolRegistry {
  private readonly tools = new Map<string, MCPTool>()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(tool: MCPTool<any, any>): void {
    if (this.tools.has(tool.name)) {
      throw new OrbitalError(
        'CONFLICT_INVALID_STATE_TRANSITION',
        `Tool '${tool.name}' is already registered`,
      )
    }
    this.tools.set(tool.name, tool)
  }

  deregister(toolName: string): void {
    this.tools.delete(toolName)
  }

  list(): MCPTool[] {
    return Array.from(this.tools.values())
  }

  get(toolName: string): MCPTool | undefined {
    return this.tools.get(toolName)
  }
}
