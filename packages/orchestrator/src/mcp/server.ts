/**
 * MCPGateway — Unix domain socket server for worker-to-orchestrator communication.
 *
 * Per Implementation Plan §6 Task 2B and SAO §5.5.
 *
 * Wire protocol: newline-delimited JSON-RPC 2.0 per mcp/protocol.ts.
 *
 * Connection lifecycle:
 * 1. Worker connects to the Unix socket.
 * 2. Worker sends a 'connect' JSON-RPC request with params.bundle containing
 *    the serialized capability bundle (not a file path — the bundle JSON itself).
 * 3. Gateway verifies the bundle via CapabilityAuthority.verify() once.
 * 4. Gateway holds the parsed CapabilityBundle in connection state.
 * 5. Subsequent messages are routed through routeMessage().
 * 6. On disconnect or invalid bundle: connection is closed.
 *
 * The bundle file path approach (reading from ORBITAL_CAPABILITY_PATH) was
 * explicitly NOT chosen per the implementation notes: the worker reads the
 * bundle file itself and sends the JSON in the connect request, decoupling
 * the gateway from the filesystem.
 */

import net from 'node:net'
import readline from 'node:readline'
import fs from 'node:fs'
import { uuidv7 } from 'uuidv7'
import type { CapabilityBundle } from '@orbital/types'
import { ConnectParamsSchema, makeResult, makeCapabilityError, makeError, MCP_ERROR_CODES, serializeResponse } from './protocol.js'
import { instrumentedRoute, type GatewayDeps } from './gateway.js'
import type { ICapabilityAuthority } from '../capabilities/authority.js'
import type { IToolRegistry, MCPTool } from './registry.js'
import type { EventStore } from '../events/store.js'
import type { DB } from '../db/client.js'
import { logger } from '../config/logger.js'
import { resolveTraceId } from './middleware/tracing.js'
import { emitCapabilityDenied } from './middleware/audit.js'
// Round 6 #7 — Determinism / Replay
// [Engineer-Principal · Opus · run-round6-07-replay]
import type { Recorder } from '../replay/recorder.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MCPGatewayOptions {
  /** Unix socket path. Defaults to ORBITAL_MCP_GATEWAY_URL env or /tmp/orbital-mcp.sock. */
  socketPath?: string
  authority: ICapabilityAuthority
  registry: IToolRegistry
  eventStore: EventStore
  db: DB
  /**
   * Round 6 #7 — Determinism / Replay
   * Optional Recorder. When provided, every tool call emits a replay capture
   * via the gateway's instrumented route. Absent in legacy tests.
   * [Engineer-Principal · Opus · run-round6-07-replay]
   */
  recorder?: Recorder
}

export interface MCPGateway {
  start(): Promise<void>
  stop(): Promise<void>
  readonly socketPath: string
}

// ---------------------------------------------------------------------------
// Per-connection state
// ---------------------------------------------------------------------------

interface ConnectionState {
  id: string
  bundle: CapabilityBundle | null
  connected: boolean
  /**
   * Active streaming subscription iterators keyed by request id so the server
   * can call `iterator.return()` on socket close. Only populated for tools
   * with `streaming === true`.
   */
  streams: Map<string | number, AsyncIterator<unknown>>
  /** True once the underlying socket has closed (or destroyed). */
  closed: boolean
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class MCPGatewayServer implements MCPGateway {
  readonly socketPath: string
  private server: net.Server | null = null
  private readonly authority: ICapabilityAuthority
  private readonly registry: IToolRegistry
  private readonly eventStore: EventStore
  private readonly db: DB
  private readonly recorder: Recorder | undefined

  constructor(opts: MCPGatewayOptions) {
    const url = opts.socketPath ?? resolveSocketPath()
    // Strip the 'unix://' prefix if present.
    this.socketPath = url.startsWith('unix://') ? url.slice('unix://'.length) : url
    this.authority = opts.authority
    this.registry = opts.registry
    this.eventStore = opts.eventStore
    this.db = opts.db
    this.recorder = opts.recorder
  }

  async start(): Promise<void> {
    if (this.server) {
      throw new Error('MCPGateway is already running')
    }

    // Remove stale socket file if present.
    try {
      fs.unlinkSync(this.socketPath)
    } catch {
      // File didn't exist — ok.
    }

    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.handleConnection(socket)
      })

      server.on('error', (err) => {
        logger.error({ err, socketPath: this.socketPath }, 'MCPGateway: server error')
        reject(err)
      })

      server.listen(this.socketPath, () => {
        logger.info({ socketPath: this.socketPath }, 'MCPGateway: listening')
        this.server = server
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return

    return new Promise((resolve, reject) => {
      this.server!.close((err) => {
        if (err) {
          logger.error({ err }, 'MCPGateway: error during stop')
          reject(err)
          return
        }
        this.server = null
        // Best-effort cleanup.
        try {
          fs.unlinkSync(this.socketPath)
        } catch {
          // Already gone — ok.
        }
        logger.info({ socketPath: this.socketPath }, 'MCPGateway: stopped')
        resolve()
      })
    })
  }

  private handleConnection(socket: net.Socket): void {
    const connId = uuidv7()
    const state: ConnectionState = {
      id: connId,
      bundle: null,
      connected: false,
      streams: new Map(),
      closed: false,
    }

    logger.debug({ connId }, 'MCPGateway: new connection')

    const cleanupStreams = (): void => {
      if (state.closed) return
      state.closed = true
      for (const [reqId, it] of state.streams) {
        // Calling return() runs any AsyncGenerator finally-blocks (e.g.
        // `sub.unsubscribe()` inside inboxSubscribeTool.streamHandler). Errors
        // are swallowed — best-effort cleanup on disconnect.
        Promise.resolve(it.return?.(undefined)).catch((err: unknown) => {
          logger.warn({ err, connId, reqId }, 'MCPGateway: streamHandler return() failed')
        })
      }
      state.streams.clear()
    }

    socket.on('error', (err) => {
      logger.warn({ err, connId }, 'MCPGateway: socket error')
      cleanupStreams()
      socket.destroy()
    })

    socket.on('close', () => {
      logger.debug({ connId }, 'MCPGateway: connection closed')
      cleanupStreams()
    })

    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity })

    rl.on('line', (line) => {
      if (!line.trim()) return
      void this.handleLine(socket, state, line)
    })

    rl.on('close', () => {
      cleanupStreams()
      socket.destroy()
    })
  }

  private async handleLine(
    socket: net.Socket,
    state: ConnectionState,
    line: string,
  ): Promise<void> {
    let rawMessage: unknown

    try {
      rawMessage = JSON.parse(line)
    } catch {
      socket.write(serializeResponse(makeError(null, MCP_ERROR_CODES.PARSE_ERROR, 'JSON parse error')))
      return
    }

    // Extract id for error correlation.
    const id = (rawMessage as Record<string, unknown>)?.['id'] as string | number | null ?? null

    try {
      // Special handling: the first message MUST be a 'connect' request.
      const method = (rawMessage as Record<string, unknown>)?.['method']
      if (method === 'connect' && !state.connected) {
        const response = await this.handleConnect(state, rawMessage, id)
        socket.write(serializeResponse(response))
        return
      }

      if (!state.connected && method !== 'connect') {
        socket.write(
          serializeResponse(
            makeCapabilityError(
              id,
              'AUTH_INVALID_CAPABILITY',
              'First message must be a connect request with a capability bundle',
              uuidv7(),
            ),
          ),
        )
        return
      }

      // Round 6 #10 + #7 — route through the instrumented gateway so every
      // tool call emits ToolCallStarted/ToolCallCompleted (inspection layer)
      // and, when a Recorder is wired, persists a full replay capture.
      const gatewayDeps: GatewayDeps = {
        registry: this.registry,
        eventStore: this.eventStore,
        db: this.db,
        authority: this.authority,
        ...(this.recorder ? { recorder: this.recorder } : {}),
      }

      const response = await instrumentedRoute(rawMessage, state.bundle, gatewayDeps)
      socket.write(serializeResponse(response))

      // ----------------------------------------------------------------
      // Streaming dispatch (Phase 3A extension — see protocol.ts §10.3).
      //
      // After the initial response is written, if the resolved tool is a
      // streaming tool AND the response carried a successful `result` (no
      // error), drive `tool.streamHandler` as an AsyncIterable. Each yielded
      // value is written as a JSON-RPC notification frame
      //   { jsonrpc:'2.0', method:'<tool.name>.event', params:<value> }
      // (no `id` per JSON-RPC 2.0 §5). When the iterator returns or the
      // socket closes we write a final response
      //   { jsonrpc:'2.0', id:<orig-id>, result:{ closed:true } }.
      // Errors emit an error response with the same id.
      //
      // Requires a successful result (not an error response) and a non-null
      // bundle (already enforced above).
      // ----------------------------------------------------------------
      if (typeof method === 'string' && state.bundle && 'result' in response) {
        const tool = this.registry.get(method)
        if (tool && tool.streaming === true && tool.streamHandler !== undefined) {
          // Fire-and-forget: streaming runs for the lifetime of the
          // subscription. Cleanup on socket close uses state.streams.
          void this.dispatchStream(socket, state, tool, rawMessage, id)
        }
      }
    } catch (err) {
      logger.error({ err, connId: state.id }, 'MCPGateway: unhandled error in handleLine')
      socket.write(
        serializeResponse(makeError(id, MCP_ERROR_CODES.INTERNAL_ERROR, 'Internal gateway error')),
      )
    }
  }

  /**
   * Drive the streaming dispatch for a tool whose `streaming === true`.
   *
   * Pre-conditions: tool.handler() has already been invoked by routeMessage()
   * and its result has been written to the socket as the initial response.
   * The bundle has been verified at connect.
   *
   * We re-parse the input here (the router does not expose the parsed input).
   * That parse is cheap and the schema is the same one the router used.
   *
   * Cancellation: a cleanup signal (a Promise that resolves when state.closed
   * flips) is raced against `iterator.next()`. If the cleanup signal wins
   * we call `iterator.return()` to drive the AsyncGenerator finally block
   * (which runs `sub.unsubscribe()` inside the streamHandler). This avoids
   * the deadlock where the inner async iterable's `next()` would otherwise
   * never resolve.
   */
  private async dispatchStream(
    socket: net.Socket,
    state: ConnectionState,
    tool: MCPTool,
    rawMessage: unknown,
    reqId: string | number | null,
  ): Promise<void> {
    const id = reqId
    if (state.closed) return
    if (!state.bundle) return

    // Re-parse the input. The router already validated, so this should
    // always succeed; we still guard.
    const params =
      ((rawMessage as Record<string, unknown>)?.['params'] as Record<string, unknown>) ?? {}
    const inputParsed = tool.inputSchema.safeParse(params)
    if (!inputParsed.success) {
      // Should never happen — the router validated already.
      logger.error(
        { tool: tool.name },
        'MCPGateway.dispatchStream: input re-parse failed unexpectedly',
      )
      socket.write(
        serializeResponse(
          makeError(
            id,
            MCP_ERROR_CODES.INVALID_PARAMS,
            'Streaming dispatch: invalid params',
          ),
        ),
      )
      return
    }

    const ctx = {
      bundle: state.bundle,
      db: this.db,
      eventStore: this.eventStore,
      traceId: resolveTraceId(state.bundle.capability_id, id),
      workerId: state.bundle.session_id,
    }

    // Cancellation signal. Resolves when the socket closes (set by
    // cleanupStreams in handleConnection). We race this against next().
    let signalCancel: (() => void) = () => undefined
    const cancelSignal: Promise<'cancel'> = new Promise<'cancel'>((resolve) => {
      signalCancel = (): void => resolve('cancel')
    })

    let iterator: AsyncIterator<unknown> | null = null
    try {
      const iterable = tool.streamHandler!(inputParsed.data, ctx)
      iterator = iterable[Symbol.asyncIterator]()

      // Track on the connection. Wrap the iterator so cleanupStreams sees a
      // .return() that ALSO triggers the cancel signal — ensuring any
      // currently-pending next() race exits even if the underlying
      // generator's await is still blocked.
      if (id !== null) {
        state.streams.set(id, {
          next: () => iterator!.next(),
          return: (value?: unknown) => {
            signalCancel()
            return iterator!.return?.(value) ?? Promise.resolve({ value: undefined, done: true })
          },
          throw: (err?: unknown) => iterator!.throw?.(err) ?? Promise.reject(err),
        })
      }

      while (!state.closed) {
        const winner = await Promise.race<IteratorResult<unknown> | 'cancel'>([
          iterator.next(),
          cancelSignal,
        ])
        if (winner === 'cancel' || state.closed) break
        const next = winner
        if (next.done) break
        const frame = {
          jsonrpc: '2.0' as const,
          method: `${tool.name}.event`,
          params: next.value as Record<string, unknown>,
        }
        socket.write(JSON.stringify(frame) + '\n')
      }

      // Final close frame — uses the original request id so clients can
      // terminate the stream-handler waiting on that id.
      if (!state.closed) {
        socket.write(serializeResponse(makeResult(id, { closed: true })))
      }
    } catch (err) {
      logger.error(
        { err, tool: tool.name, connId: state.id },
        'MCPGateway.dispatchStream: streamHandler threw',
      )
      if (!state.closed) {
        socket.write(
          serializeResponse(
            makeError(
              id,
              MCP_ERROR_CODES.INTERNAL_ERROR,
              err instanceof Error ? err.message : 'Streaming dispatch error',
            ),
          ),
        )
      }
    } finally {
      // Trigger cancel + run iterator return() to drive the AsyncGenerator
      // finally block (e.g. inbox subscriber unsubscribe).
      signalCancel()
      if (iterator !== null) {
        try {
          await iterator.return?.(undefined)
        } catch (returnErr) {
          logger.warn(
            { err: returnErr, tool: tool.name, connId: state.id },
            'MCPGateway.dispatchStream: iterator.return() failed',
          )
        }
      }
      if (id !== null) state.streams.delete(id)
    }
  }

  /**
   * Process the connect request: parse and verify the capability bundle.
   * On success: stores the bundle in connection state and returns ok.
   * On failure: returns an auth error (connection will be rejected for future calls).
   */
  private async handleConnect(
    state: ConnectionState,
    rawMessage: unknown,
    id: string | number | null,
  ): Promise<ReturnType<typeof makeResult>> {
    const msg = rawMessage as Record<string, unknown>
    const params = msg['params'] as Record<string, unknown> | undefined

    const connectParsed = ConnectParamsSchema.safeParse(params)
    if (!connectParsed.success) {
      const traceId = uuidv7()
      return makeCapabilityError(
        id,
        'AUTH_INVALID_CAPABILITY_FORMAT',
        `Invalid capability bundle in connect params: ${connectParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        traceId,
      ) as ReturnType<typeof makeResult>
    }

    const { bundle } = connectParsed.data
    const traceId = resolveTraceId(bundle.capability_id, id)

    const verifyResult = await this.authority.verify(bundle)
    if (!verifyResult.ok) {
      logger.warn(
        { reason: verifyResult.reason_code, capability_id: bundle.capability_id },
        'MCPGateway: connect rejected — bundle verification failed',
      )

      // Emit CapabilityDenied event for audit trail.
      await emitCapabilityDenied(
        this.eventStore,
        this.db,
        bundle,
        'connect',
        {
          reason_code: verifyResult.reason_code ?? 'AUTH_INVALID_CAPABILITY',
          reason_detail: verifyResult.reason_detail ?? 'Bundle verification failed',
          attempted_target: bundle.capability_id,
        },
        traceId,
      )

      return makeCapabilityError(
        id,
        verifyResult.reason_code ?? 'AUTH_INVALID_CAPABILITY',
        verifyResult.reason_detail ?? 'Bundle verification failed',
        traceId,
      ) as ReturnType<typeof makeResult>
    }

    // Bundle is valid — store in connection state.
    state.bundle = verifyResult.bundle ?? bundle
    state.connected = true

    logger.info(
      {
        connId: state.id,
        capability_id: bundle.capability_id,
        persona_id: bundle.persona_id,
        task_id: bundle.task_id,
      },
      'MCPGateway: worker connected',
    )

    return makeResult(id, { connected: true, capability_id: bundle.capability_id })
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a configured MCPGateway instance.
 * Registers all standard worker tools onto the provided registry.
 */
export function createMCPGateway(opts: MCPGatewayOptions): MCPGateway {
  return new MCPGatewayServer(opts)
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function resolveSocketPath(): string {
  const url = process.env['ORBITAL_MCP_GATEWAY_URL'] ?? 'unix:///tmp/orbital-mcp.sock'
  return url.startsWith('unix://') ? url.slice('unix://'.length) : url
}
