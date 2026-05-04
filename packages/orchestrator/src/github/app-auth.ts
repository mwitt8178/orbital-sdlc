/**
 * github/app-auth.ts — GitHub App JWT minting + installation-token exchange.
 *
 * [Engineer-Principal · Opus · run-orbital-github-integration]
 *
 * Why hand-rolled instead of @octokit/auth-app:
 *   - The orchestrator already uses native fetch + zero-octokit-dep elsewhere
 *     (see github/client.ts). Pulling octokit just for App auth widens the
 *     dep tree by ~25 packages for a JWT we can mint in 30 lines of node:crypto.
 *   - The token-cache + TTL refresh is identical to the IAM-token pattern in
 *     init.ts, which we already have a tested mental model for.
 *
 * What this file does:
 *   1. `mintAppJwt(appId, privateKeyPem)` — produces a 9-minute RS256 JWT for
 *      App-level calls (installation list, installation metadata).
 *   2. `getInstallationToken(installationId)` — calls
 *      POST /app/installations/{id}/access_tokens with the App JWT, returns a
 *      ~1h installation token, cached in-process and refreshed at the 50-min
 *      mark to mirror the RDS-Proxy IAM token pattern in api-lambda/init.ts.
 *
 * Token-leak posture:
 *   - The private key PEM never leaves Lambda memory. It is fetched from
 *     Secrets Manager once per cold start (or after TTL) via secrets-cache.
 *   - JWTs are minted per-call (cheap; no caching).
 *   - Installation tokens are cached in-process keyed by installation_id; the
 *     cache is process-local and dies with the Lambda container.
 *
 * Multi-tenant: this module knows nothing about tenants. The caller (router /
 * webhook handler) is responsible for resolving installation_id from a
 * tenant-scoped binding row before calling getInstallationToken().
 */

import { createSign } from 'node:crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppAuthConfig {
  /** Numeric GitHub App ID (e.g. 1234567). */
  appId: number
  /** PEM-encoded RSA private key. */
  privateKeyPem: string
  /** Override fetch (test). */
  fetchImpl?: typeof fetch
  /** Override clock (test). Returns ms since epoch. */
  nowMs?: () => number
}

interface CachedToken {
  token: string
  expiresAtMs: number
}

// ---------------------------------------------------------------------------
// JWT mint
// ---------------------------------------------------------------------------

const JWT_TTL_SEC = 540 // 9 minutes — under the 10-min GitHub max
const TOKEN_REFRESH_LEAD_MS = 10 * 60_000 // refresh 10 min before expiry

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input
  return buf
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

/**
 * Mint a short-lived JWT for App-level GitHub API calls (RS256).
 * Per https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 *
 * - `iat` set 30 seconds in the past to tolerate clock skew (GitHub's recommendation).
 * - `exp` set to iat + 540 seconds (under the 10-minute hard limit).
 */
export function mintAppJwt(appId: number, privateKeyPem: string, nowMs: () => number = Date.now): string {
  const nowSec = Math.floor(nowMs() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = {
    iat: nowSec - 30,
    exp: nowSec + JWT_TTL_SEC,
    iss: appId,
  }
  const encodedHeader = base64UrlEncode(JSON.stringify(header))
  const encodedPayload = base64UrlEncode(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signer = createSign('RSA-SHA256')
  signer.update(signingInput)
  signer.end()
  const signature = signer.sign(privateKeyPem)
  return `${signingInput}.${base64UrlEncode(signature)}`
}

// ---------------------------------------------------------------------------
// Installation-token cache
// ---------------------------------------------------------------------------

export class InstallationTokenProvider {
  private readonly cache = new Map<number, CachedToken>()
  private readonly inflight = new Map<number, Promise<string>>()
  private readonly fetchImpl: typeof fetch
  private readonly nowMs: () => number

  constructor(private readonly config: AppAuthConfig) {
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch
    this.nowMs = config.nowMs ?? Date.now
  }

  /**
   * Get a valid installation token, minting a new one (or returning the cached
   * one) as needed. Single-flighted per installation_id so concurrent callers
   * don't stampede the GitHub API on a cold start.
   */
  async getInstallationToken(installationId: number): Promise<string> {
    const cached = this.cache.get(installationId)
    if (cached && cached.expiresAtMs - TOKEN_REFRESH_LEAD_MS > this.nowMs()) {
      return cached.token
    }
    const inflight = this.inflight.get(installationId)
    if (inflight) return inflight

    const p = this.refresh(installationId)
    this.inflight.set(installationId, p)
    try {
      return await p
    } finally {
      this.inflight.delete(installationId)
    }
  }

  private async refresh(installationId: number): Promise<string> {
    const jwt = mintAppJwt(this.config.appId, this.config.privateKeyPem, this.nowMs)
    const res = await this.fetchImpl(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${jwt}`,
          'User-Agent': 'orbital-orchestrator',
        },
      },
    )
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`GitHub installation-token mint failed: ${res.status} ${text}`)
    }
    const json = (await res.json()) as { token: string; expires_at: string }
    const expiresAtMs = Date.parse(json.expires_at)
    this.cache.set(installationId, { token: json.token, expiresAtMs })
    return json.token
  }

  /** Test hook. */
  _clearCache(): void {
    this.cache.clear()
    this.inflight.clear()
  }
}

/**
 * Verify the X-Hub-Signature-256 HMAC against the raw body.
 * Constant-time-ish comparison via Buffer length + sodium-style equality
 * (timingSafeEqual would require equal length; we always make them equal).
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false
  const provided = signatureHeader.slice('sha256='.length)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHmac, timingSafeEqual } = require('node:crypto') as typeof import('node:crypto')
  const computed = createHmac('sha256', secret).update(rawBody).digest('hex')
  if (provided.length !== computed.length) return false
  try {
    return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(computed, 'hex'))
  } catch {
    return false
  }
}
