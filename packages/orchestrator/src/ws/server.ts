/**
 * ws/server.ts — Fastify @fastify/websocket plugin registration.
 *
 * Per TRD-05 §6.1.3 / Primitives §11.
 *
 * Exposes GET /ws which upgrades to WebSocket. On each connection,
 * `WebSocketHub.handleConnection(socket)` is called.
 *
 * The hub is started by the caller before serving (so that
 * EventStore.subscribe is registered). This module exports a
 * registerWsRoutes function that the Fastify boot wires into the
 * existing app builder.
 *
 * Round 3 S4 — WebSocket auth gate
 * --------------------------------
 * If a session token is configured (`token` option), every WS upgrade must
 * present it via either:
 *   - the `x-orbital-ws-token` header, or
 *   - a `?token=...` query parameter.
 *
 * On rejection: HTTP 401 with the canonical Primitives §10 envelope. The
 * upgrade is declined before any WS frame is exchanged. (We use HTTP 401 at
 * the upgrade layer rather than WS close code 1008 because the upgrade
 * handshake hasn't completed yet — the spec disallows sending a WS frame
 * before the protocol switch.)
 *
 * In development with no token configured, the upgrade is accepted and a
 * loud warning is emitted at boot (the caller logs the warning).
 *
 * Round 7-04 — Hub-Mode WS Routes
 * --------------------------------
 * registerHubModeWsRoutes: envelope-auth on WS upgrade via query-string
 * params (install_id, sig, sig_body). On auth failure, close code 4001.
 * On success, call hub.handleAuthenticatedConnection() with identity.
 * [Engineer-Sr · Sonnet · run-round7-04-realtime-push]
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import websocketPlugin from '@fastify/websocket'
import type { WebSocketHub, HubModeWSHub } from './hub.js'
import { verifyWsHandshake } from './auth.js'
import { logger } from '../config/logger.js'
import { trace } from '@opentelemetry/api'
import type { DB } from '../db/client.js'

export interface WsServerOptions {
  hub: WebSocketHub
  /** Path under which to expose the WS upgrade endpoint. Default: /ws. */
  path?: string
  /**
   * Round 3 S4 — Optional session token. When set, all WS upgrades must
   * present it via the `x-orbital-ws-token` header or `?token=...` query
   * parameter. When undefined, the upgrade is accepted unauthenticated (the
   * caller is responsible for warning at boot).
   */
  token?: string
}

/**
 * Read the WS token from the Fastify request. Header takes precedence over
 * query so that a leaked URL-with-token is harder to exploit (header path is
 * the recommended channel).
 */
function readWsToken(req: FastifyRequest): string | null {
  const header = req.headers['x-orbital-ws-token']
  if (typeof header === 'string' && header.length > 0) return header
  if (Array.isArray(header) && header[0]) return header[0]

  const query = req.query as Record<string, unknown> | undefined
  const queryToken = query?.['token']
  if (typeof queryToken === 'string' && queryToken.length > 0) return queryToken
  return null
}

/**
 * Register the @fastify/websocket plugin and the /ws route on the given
 * Fastify instance. Idempotent: re-registering on the same instance is a
 * Fastify error, so callers should call exactly once during boot.
 */
export async function registerWsRoutes(
  app: FastifyInstance,
  options: WsServerOptions,
): Promise<void> {
  const path = options.path ?? '/ws'
  await app.register(websocketPlugin)

  // Round 3 S4 — pre-validation gate runs before the upgrade handshake.
  // We attach the hook to JUST this route via the route-level `preValidation`
  // option below so other routes (health, metrics) are unaffected.
  const preValidation = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!options.token) return // open mode (dev with no token)

    const presented = readWsToken(req)
    if (presented === options.token) return // OK

    const traceId = trace.getActiveSpan()?.spanContext().traceId ?? 'no-trace'
    logger.warn(
      { url: req.url, hasHeader: !!req.headers['x-orbital-ws-token'] },
      'WS auth: token mismatch; rejecting upgrade',
    )
    void reply.status(401).send({
      error: {
        code: 'AUTH_INVALID_WS_TOKEN',
        message: 'WebSocket upgrade rejected: invalid or missing token',
        trace_id: traceId,
      },
    })
  }

  app.get(
    path,
    { websocket: true, preValidation },
    (socket /* WebSocket */) => {
      // @fastify/websocket v11 callback signature: (socket, request).
      // socket is the raw `ws` WebSocket; we forward to the hub.
      options.hub.handleConnection(socket as unknown as import('ws').WebSocket)
      logger.debug({ path }, 'WS connection accepted')
    },
  )
}

// ===========================================================================
// Round 7-04 — Hub-mode WS routes (envelope auth on upgrade)
// [Engineer-Sr · Sonnet · run-round7-04-realtime-push]
// ===========================================================================

export interface HubModeWsServerOptions {
  hub: HubModeWSHub
  /** Drizzle DB client — needed for known_installs lookup inside auth. */
  db: DB
  /** Path. Default: /ws */
  path?: string
}

/**
 * Register the hub-mode WS endpoint.
 *
 * Auth flow on upgrade:
 *   1. Parse install_id / sig / sig_body from query string.
 *   2. verifyWsHandshake() — looks up known_installs, verifies Ed25519 sig,
 *      checks nonce + ts.
 *   3. On failure: close the WS with code 4001 reason 'AUTH_REQUIRED'.
 *      We can't reject at the HTTP layer here (the upgrade has already
 *      happened by the time the websocket callback fires in @fastify/websocket
 *      v11). So we close immediately after opening.
 *   4. On success: pass socket + identity to hub.handleAuthenticatedConnection().
 *
 * IMPORTANT: The caller MUST register @fastify/websocket on the Fastify instance
 * before calling this function. This function only registers the route; it never
 * registers the plugin. Registering the plugin twice on the same instance causes
 * a FastifyError (FST_ERR_DEC_ALREADY_PRESENT).
 *
 * Example:
 *   await app.register(websocketPlugin)
 *   await registerHubModeWsRoutes(app, { hub, db })
 */
export async function registerHubModeWsRoutes(
  app: FastifyInstance,
  options: HubModeWsServerOptions,
): Promise<void> {
  const path = options.path ?? '/ws'
  const hub = options.hub

  app.get(
    path,
    { websocket: true },
    async (socket, request) => {
      const wsSocket = socket as unknown as import('ws').WebSocket
      const query = (request.query ?? {}) as Record<string, string | undefined>

      // Cursor for backfill (optional)
      const cursor = typeof query['cursor'] === 'string' ? query['cursor'] : undefined

      // Verify the signed envelope from query params
      const result = await verifyWsHandshake({ query })

      if (!result.ok) {
        logger.debug(
          { code: result.code, detail: result.detail },
          'HubModeWsRoutes: auth failed — closing 4001',
        )
        wsSocket.close(4001, 'AUTH_REQUIRED')
        return
      }

      logger.debug(
        { installId: result.identity.installId, tenantId: result.identity.tenantId },
        'HubModeWsRoutes: connection authenticated',
      )
      hub.handleAuthenticatedConnection(wsSocket, result.identity, cursor)
    },
  )
}
