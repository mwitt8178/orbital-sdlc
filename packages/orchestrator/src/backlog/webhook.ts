/**
 * backlog/webhook.ts — Monday → Orbital webhook receiver.
 *
 * Per TRD-02 v0.2 §6.3 and §13.4, plus Implementation Plan §8 Task 4B "Done when".
 *
 * Route: POST /api/v1/webhooks/monday
 *
 * Authentication:
 *   - Header `x-monday-signature` is HMAC-SHA256(rawBody, MONDAY_WEBHOOK_SECRET) hex
 *   - Use `crypto.timingSafeEqual` to prevent timing attacks
 *   - Mismatch returns 401 with WEBHOOK_INVALID_SIGNATURE
 *
 * Response:
 *   - 200 on success
 *   - 200 with `{challenge}` echo for Monday's setup challenge handshake
 *   - 401 on signature mismatch
 *   - 422 on body parse failure
 *
 * The handler validates first, then routes the parsed payload to
 * MondaySyncService.handleWebhookPayload. The handler MUST return 200 quickly;
 * heavy lifting may be deferred to async processing in future iterations.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { OrbitalError } from '@orbital/types'
import { logger } from '../config/logger.js'
import type { MondaySyncService, MondayWebhookPayload } from './monday-sync.js'
import { BACKLOG_ERROR_CODES } from './types.js'

// ---------------------------------------------------------------------------
// Public verification helper (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Verify an x-monday-signature header against the raw body using the shared
 * secret. Returns true iff the HMAC-SHA256 matches in constant time.
 */
export function verifyMondaySignature(
  rawBody: string | Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || typeof signature !== 'string') return false
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf-8') : rawBody
  const expected = createHmac('sha256', secret).update(body).digest('hex')
  // Both must be the same length for timingSafeEqual.
  const received = Buffer.from(signature, 'utf-8')
  const expectedBuf = Buffer.from(expected, 'utf-8')
  if (received.length !== expectedBuf.length) return false
  try {
    return timingSafeEqual(received, expectedBuf)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Fastify plugin registration
// ---------------------------------------------------------------------------

export interface RegisterBacklogWebhookOptions {
  /** Required: the HMAC shared secret. Inject via env var resolution. */
  secret: string
  /** Required: the sync service to dispatch verified payloads to. */
  syncService: MondaySyncService
}

/**
 * Register the POST /api/v1/webhooks/monday route. Idempotent: re-registering
 * is a no-op (Fastify rejects duplicate routes; callers should construct a
 * fresh app per invocation).
 */
export function registerBacklogWebhook(
  app: FastifyInstance,
  options: RegisterBacklogWebhookOptions,
): void {
  if (!options.secret || options.secret.length === 0) {
    throw new OrbitalError(
      BACKLOG_ERROR_CODES.STARTUP_ERROR,
      'registerBacklogWebhook: secret is required',
    )
  }

  app.post(
    '/api/v1/webhooks/monday',
    {
      // Capture raw body so HMAC verification uses the exact bytes.
      // The default JSON parser stores raw body when this option is set.
      bodyLimit: 256 * 1024, // 256 KiB — Monday webhook payloads are small
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const sig = (req.headers['x-monday-signature'] ?? null) as string | null
      // Reconstruct the raw body string for HMAC.
      // Fastify parses JSON by default; we serialize the parsed body back into
      // a canonical JSON string. For correctness Monday must sign the same
      // serialization our handler reconstructs OR we bypass JSON parsing.
      // To make verification robust we accept either:
      //   - rawBody attached by a content-type-text plugin (Buffer)
      //   - JSON.stringify(req.body) as fallback
      const raw =
        (req as unknown as { rawBody?: Buffer }).rawBody ??
        Buffer.from(JSON.stringify(req.body ?? {}), 'utf-8')

      if (!verifyMondaySignature(raw, sig ?? undefined, options.secret)) {
        return reply.status(401).send({
          error: {
            code: BACKLOG_ERROR_CODES.WEBHOOK_INVALID_SIGNATURE,
            message: 'invalid x-monday-signature',
            trace_id: 'webhook',
          },
        })
      }

      let parsed: MondayWebhookPayload
      try {
        const body = req.body
        if (typeof body !== 'object' || body === null) {
          throw new Error('body must be an object')
        }
        parsed = body as MondayWebhookPayload
      } catch (err) {
        return reply.status(422).send({
          error: {
            code: BACKLOG_ERROR_CODES.VALIDATION_REQUIRED_FIELD_MISSING,
            message: `invalid webhook body: ${(err as Error).message}`,
            trace_id: 'webhook',
          },
        })
      }

      // Challenge handshake: Monday sends `{challenge: "..."}` during setup;
      // echo it back per Monday's webhook protocol.
      if (parsed.challenge) {
        return reply.status(200).send({ challenge: parsed.challenge })
      }

      try {
        const result = await options.syncService.handleWebhookPayload(parsed)
        return reply.status(200).send({ ok: true, ...result })
      } catch (err) {
        logger.error({ err }, 'webhook: handleWebhookPayload failed')
        return reply.status(500).send({
          error: {
            code: BACKLOG_ERROR_CODES.INTERNAL_DB_ERROR,
            message: 'webhook handler error',
            trace_id: 'webhook',
          },
        })
      }
    },
  )
}
