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
import type { FastifyInstance } from 'fastify';
import type { MondaySyncService } from './monday-sync.js';
/**
 * Verify an x-monday-signature header against the raw body using the shared
 * secret. Returns true iff the HMAC-SHA256 matches in constant time.
 */
export declare function verifyMondaySignature(rawBody: string | Buffer, signature: string | undefined, secret: string): boolean;
export interface RegisterBacklogWebhookOptions {
    /** Required: the HMAC shared secret. Inject via env var resolution. */
    secret: string;
    /** Required: the sync service to dispatch verified payloads to. */
    syncService: MondaySyncService;
}
/**
 * Register the POST /api/v1/webhooks/monday route. Idempotent: re-registering
 * is a no-op (Fastify rejects duplicate routes; callers should construct a
 * fresh app per invocation).
 */
export declare function registerBacklogWebhook(app: FastifyInstance, options: RegisterBacklogWebhookOptions): void;
//# sourceMappingURL=webhook.d.ts.map