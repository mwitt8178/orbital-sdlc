/**
 * hub/auth/routes.ts — Fastify route registration for federation auth.
 *
 * Round 7-03 — Federation Auth (Identity & Pairing)
 * [Engineer-Principal · Opus · run-round7-03-federation-auth]
 *
 * Two routes:
 *   - POST /hub/register       (hub-mode only) — pairing handshake, used by
 *                               `orbital join` and the UI's JoinHubFlow.
 *   - POST /api/hub/proxy-join (local-mode only) — UI-friendly proxy that
 *                               wraps the local install's public key into
 *                               the hub /hub/register call. The browser does
 *                               not have access to the install key on disk.
 *
 * The hub-side route activates only when ORBITAL_MODE=hub. The local-side
 * proxy activates only when ORBITAL_MODE=local.
 */

import type { FastifyInstance } from 'fastify'
import { logger } from '../../config/logger.js'
import { loadEnv } from '../../config/env.js'
import { registerHandler, type RegistrationRequest } from './registration.js'
import { getOrCreateInstallKey } from '../../keys/install-key.js'
import { bytesToBase64Url } from '../../keys/envelope.js'

// ---------------------------------------------------------------------------
// Hub-side: POST /hub/register
// ---------------------------------------------------------------------------

export function registerHubRegisterRoute(app: FastifyInstance): void {
  const env = loadEnv()
  if (env.ORBITAL_MODE !== 'hub') {
    logger.debug('hub-auth: ORBITAL_MODE is not hub — skipping /hub/register')
    return
  }

  logger.info('hub-auth: registering /hub/register (ORBITAL_MODE=hub)')

  app.post<{ Body: RegistrationRequest }>('/hub/register', async (req, reply): Promise<void> => {
    const result = await registerHandler(req.body)
    if (result.ok) {
      void reply.status(200).send(result)
    } else {
      // Map subset of registration error codes to HTTP status
      const status =
        result.code === 'AUTH_REQUEST_MALFORMED'
          ? 400
          : result.code === 'AUTH_INVITE_EXPIRED' || result.code === 'AUTH_INVITE_ALREADY_USED'
            ? 409
            : result.code === 'AUTH_INVITE_INVALID'
              ? 401
              : 500
      void reply.status(status).send(result)
    }
  })
}

// ---------------------------------------------------------------------------
// Local-side: POST /api/hub/proxy-join
// ---------------------------------------------------------------------------

interface ProxyJoinBody {
  hub_url: string
  invite_token: string
  display_name?: string
}

interface ProxyJoinOk {
  ok: true
  install_id: string
  tenant_id: string
  role: 'owner' | 'member' | 'viewer'
  hub_pubkey: string
  hub_url: string
}

interface ProxyJoinErr {
  ok: false
  code: string
  message: string
}

/**
 * The local orchestrator owns the install key; the browser does not. This
 * proxy route reads the local install's public key from disk, sends the
 * registration to the hub, and returns the result to the UI.
 *
 * Active in BOTH local AND hub mode (a hub-mode operator joining ANOTHER
 * hub is out of scope for Round 7-03; in hub mode this route is a no-op).
 */
export function registerProxyJoinRoute(app: FastifyInstance): void {
  const env = loadEnv()
  if (env.ORBITAL_MODE !== 'local') {
    logger.debug('hub-auth: ORBITAL_MODE is not local — skipping /api/hub/proxy-join')
    return
  }

  logger.info('hub-auth: registering /api/hub/proxy-join (ORBITAL_MODE=local)')

  app.post<{ Body: ProxyJoinBody }>('/api/hub/proxy-join', async (req, reply): Promise<void> => {
    const body = req.body
    if (!body || typeof body.hub_url !== 'string' || typeof body.invite_token !== 'string') {
      void reply.status(400).send({
        ok: false,
        code: 'AUTH_REQUEST_MALFORMED',
        message: 'proxy-join: missing hub_url or invite_token',
      } satisfies ProxyJoinErr)
      return
    }

    // Validate hub_url
    let hubOrigin: string
    try {
      const u = new URL(body.hub_url)
      hubOrigin = `${u.protocol}//${u.host}`
    } catch {
      void reply.status(400).send({
        ok: false,
        code: 'AUTH_REQUEST_MALFORMED',
        message: `proxy-join: hub_url '${body.hub_url}' is not a valid URL`,
      } satisfies ProxyJoinErr)
      return
    }

    // Load or generate the local install key
    let installKey
    try {
      installKey = await getOrCreateInstallKey()
    } catch (err) {
      logger.error({ err }, 'proxy-join: failed to load install key')
      void reply.status(500).send({
        ok: false,
        code: 'INTERNAL_ERROR',
        message: 'proxy-join: failed to load local install key',
      } satisfies ProxyJoinErr)
      return
    }

    const publicKeyB64 = bytesToBase64Url(installKey.publicKey)

    // POST to hub
    let hubRes: Response
    try {
      hubRes = await fetch(`${hubOrigin}/hub/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          install_id: installKey.installId,
          public_key: publicKeyB64,
          display_name: body.display_name ?? null,
          invite_token: body.invite_token,
        }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err) {
      void reply.status(502).send({
        ok: false,
        code: 'INTERNAL_ERROR',
        message: `proxy-join: hub fetch failed: ${(err as Error).message}`,
      } satisfies ProxyJoinErr)
      return
    }

    let parsed: unknown
    try {
      parsed = await hubRes.json()
    } catch (err) {
      void reply.status(502).send({
        ok: false,
        code: 'INTERNAL_ERROR',
        message: `proxy-join: hub returned non-JSON: ${(err as Error).message}`,
      } satisfies ProxyJoinErr)
      return
    }

    // Pass through the hub's response. Successful registration → echo with hub_url.
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { ok?: unknown }).ok === true
    ) {
      const ok = parsed as {
        install_id: string
        tenant_id: string
        role: 'owner' | 'member' | 'viewer'
        hub_pubkey: string
      }
      const out: ProxyJoinOk = {
        ok: true,
        install_id: ok.install_id,
        tenant_id: ok.tenant_id,
        role: ok.role,
        hub_pubkey: ok.hub_pubkey,
        hub_url: hubOrigin,
      }
      void reply.status(200).send(out)
      return
    }

    // Forward error
    void reply.status(hubRes.status).send(parsed)
  })
}
