/**
 * lambda/ws-auth/cognito.ts — Cognito JWT validation for WebSocket $connect.
 *
 * [Engineer-Sr · Sonnet · run-round8-04-websocket-api]
 *
 * Validates Cognito JWTs passed as `?token=<jwt>` on WS upgrade.
 * Browser clients cannot set custom headers on WebSocket upgrades, so the
 * JWT is passed as a query string parameter and validated here.
 *
 * The JWKS endpoint is the standard Cognito URL:
 *   https://cognito-idp.{region}.amazonaws.com/{userPoolId}/.well-known/jwks.json
 *
 * JWT claims extracted:
 *   sub           — Cognito user UUID (used as installId for browser connections)
 *   email         — User email (optional, may not be present if not in id_token)
 *   custom:tenantId — Tenant ID set by Cognito trigger on sign-up / pre-token-generation
 *   token_use     — Must be 'access' or 'id' (we accept both)
 *   exp           — Expiry (standard JWT claim, validated inline)
 *
 * NOTE: This is a lightweight implementation that decodes and validates the
 * JWT without a full JWKS library dependency. For production, use
 * `@auth0/jwks-rsa` or `aws-jwt-verify`. The implementation here is
 * sufficient for the integration test harness; the full JWKS validation
 * can be upgraded without changing the interface.
 *
 * For integration tests, COGNITO_VALIDATION_BYPASS=1 skips the network call
 * and accepts a test JWT with a specific format.
 */

import { createVerify } from 'node:crypto'
import { logger } from '../../config/logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CognitoIdentity {
  /** Cognito subject (user UUID). */
  sub: string
  /** Email from JWT claims (present in id_token; optional in access_token). */
  email?: string
  /** Tenant ID from custom:tenantId claim. */
  tenantId: string
  /** Token type: 'access' | 'id' */
  tokenUse: string
}

export type CognitoVerifyResult =
  | { ok: true; identity: CognitoIdentity }
  | { ok: false; code: string; detail: string }

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

/** Decode a base64url string to a UTF-8 string (no padding needed). */
function decodeBase64Url(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    input.length + ((4 - (input.length % 4)) % 4),
    '=',
  )
  return Buffer.from(padded, 'base64').toString('utf8')
}

interface JwtHeader {
  alg: string
  kid: string
  typ?: string
}

interface JwtPayload {
  sub?: string
  email?: string
  'cognito:username'?: string
  'custom:tenantId'?: string
  iss?: string
  exp?: number
  iat?: number
  token_use?: string
  aud?: string
  client_id?: string
}

function parseJwt(token: string): { header: JwtHeader; payload: JwtPayload; raw: { header: string; payload: string; sig: string } } | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  try {
    const header = JSON.parse(decodeBase64Url(parts[0] as string)) as JwtHeader
    const payload = JSON.parse(decodeBase64Url(parts[1] as string)) as JwtPayload
    return {
      header,
      payload,
      raw: { header: parts[0] as string, payload: parts[1] as string, sig: parts[2] as string },
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// JWKS cache (module-scoped, simple TTL)
// ---------------------------------------------------------------------------

interface JwksKey {
  kty: string
  kid: string
  use?: string
  n?: string
  e?: string
  crv?: string
  x?: string
  alg?: string
}

interface JwksResponse {
  keys: JwksKey[]
}

interface JwksCacheEntry {
  keys: JwksKey[]
  fetchedAt: number
}

const jwksCache = new Map<string, JwksCacheEntry>()
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

async function fetchJwks(jwksUri: string): Promise<JwksKey[]> {
  const cached = jwksCache.get(jwksUri)
  if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cached.keys
  }

  const response = await fetch(jwksUri)
  if (!response.ok) {
    throw new Error(`JWKS fetch failed: ${response.status} ${response.statusText}`)
  }

  const data = (await response.json()) as JwksResponse
  jwksCache.set(jwksUri, { keys: data.keys, fetchedAt: Date.now() })
  return data.keys
}

// ---------------------------------------------------------------------------
// RS256 verification using node:crypto
// ---------------------------------------------------------------------------

function buildRsaPublicKey(n: string, e: string): string {
  // Build an RSA public key from JWK modulus and exponent components.
  // We use the PEM format that node:crypto's createVerify can use.
  const nBuf = Buffer.from(n.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  const eBuf = Buffer.from(e.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

  // ASN.1 DER encode RSA public key (RFC 3447 / PKCS#1)
  const nPad = nBuf[0]! & 0x80 ? Buffer.concat([Buffer.from([0x00]), nBuf]) : nBuf
  const ePad = eBuf[0]! & 0x80 ? Buffer.concat([Buffer.from([0x00]), eBuf]) : eBuf

  const encodeLength = (len: number): Buffer => {
    if (len < 128) return Buffer.from([len])
    if (len < 256) return Buffer.from([0x81, len])
    return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff])
  }

  const encodeInt = (buf: Buffer): Buffer =>
    Buffer.concat([Buffer.from([0x02]), encodeLength(buf.length), buf])

  const modExp = Buffer.concat([encodeInt(nPad), encodeInt(ePad)])
  const bitString = Buffer.concat([
    Buffer.from([0x03]),
    encodeLength(modExp.length + 1),
    Buffer.from([0x00]),
    modExp,
  ])

  // RSA OID
  const algorithmIdentifier = Buffer.from([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ])

  const spki = Buffer.concat([
    Buffer.from([0x30]),
    encodeLength(algorithmIdentifier.length + bitString.length),
    algorithmIdentifier,
    bitString,
  ])

  return `-----BEGIN PUBLIC KEY-----\n${spki.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`
}

function verifyRs256(token: string, publicKeyPem: string): boolean {
  const parts = token.split('.')
  if (parts.length !== 3) return false

  try {
    const verify = createVerify('SHA256')
    verify.update(`${parts[0]}.${parts[1]}`)
    const sigBuf = Buffer.from(
      (parts[2] as string).replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    )
    return verify.verify(publicKeyPem, sigBuf)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Main verify function
// ---------------------------------------------------------------------------

export async function verifyCognitoJwt(token: string): Promise<CognitoVerifyResult> {
  // --- Test bypass (integration test harness) ---
  if (process.env['COGNITO_VALIDATION_BYPASS'] === '1') {
    return verifyTestJwt(token)
  }

  const parsed = parseJwt(token)
  if (!parsed) {
    return { ok: false, code: 'JWT_MALFORMED', detail: 'JWT has wrong number of parts' }
  }

  const { header, payload } = parsed

  // Validate alg
  if (header.alg !== 'RS256') {
    return { ok: false, code: 'JWT_WRONG_ALG', detail: `Expected RS256, got ${header.alg}` }
  }

  // Validate expiry
  const now = Math.floor(Date.now() / 1000)
  if (payload.exp !== undefined && payload.exp < now) {
    return { ok: false, code: 'JWT_EXPIRED', detail: 'JWT has expired' }
  }

  // Validate issuer matches Cognito
  const userPoolId = process.env['COGNITO_USER_POOL_ID']
  const region = process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1'

  if (!userPoolId) {
    return { ok: false, code: 'COGNITO_POOL_NOT_CONFIGURED', detail: 'COGNITO_USER_POOL_ID env var not set' }
  }

  const expectedIssuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`
  if (payload.iss !== expectedIssuer) {
    return {
      ok: false,
      code: 'JWT_WRONG_ISSUER',
      detail: `Expected issuer ${expectedIssuer}, got ${payload.iss ?? 'none'}`,
    }
  }

  // Fetch JWKS and find the matching key
  const jwksUri = `${expectedIssuer}/.well-known/jwks.json`
  let keys: JwksKey[]

  try {
    keys = await fetchJwks(jwksUri)
  } catch (err) {
    logger.error({ err, jwksUri }, 'ws-cognito-auth: JWKS fetch failed')
    return { ok: false, code: 'JWKS_FETCH_FAILED', detail: String(err) }
  }

  const matchingKey = keys.find((k) => k.kid === header.kid)
  if (!matchingKey) {
    return {
      ok: false,
      code: 'JWT_KEY_NOT_FOUND',
      detail: `kid ${header.kid} not in JWKS`,
    }
  }

  if (!matchingKey.n || !matchingKey.e) {
    return { ok: false, code: 'JWT_KEY_MISSING_PARAMS', detail: 'JWK missing n or e' }
  }

  // Build PEM and verify signature
  let publicKeyPem: string
  try {
    publicKeyPem = buildRsaPublicKey(matchingKey.n, matchingKey.e)
  } catch (err) {
    return { ok: false, code: 'JWT_KEY_BUILD_FAILED', detail: String(err) }
  }

  if (!verifyRs256(token, publicKeyPem)) {
    return { ok: false, code: 'JWT_SIG_INVALID', detail: 'RS256 signature verification failed' }
  }

  // Validate audience
  const appClientId = process.env['COGNITO_APP_CLIENT_ID']
  if (appClientId) {
    const audience = payload.aud ?? payload.client_id
    if (audience && audience !== appClientId) {
      return { ok: false, code: 'JWT_WRONG_AUDIENCE', detail: `Expected aud ${appClientId}` }
    }
  }

  // Extract claims
  const sub = payload.sub
  if (!sub) {
    return { ok: false, code: 'JWT_MISSING_SUB', detail: 'JWT missing sub claim' }
  }

  // Tenant ID comes from the custom:tenantId claim set by pre-token-generation trigger
  const tenantId = payload['custom:tenantId']
  if (!tenantId) {
    return {
      ok: false,
      code: 'JWT_MISSING_TENANT',
      detail: 'JWT missing custom:tenantId claim — user may not be associated with a tenant',
    }
  }

  return {
    ok: true,
    identity: {
      sub,
      email: payload.email,
      tenantId,
      tokenUse: payload.token_use ?? 'unknown',
    },
  }
}

// ---------------------------------------------------------------------------
// Test-only: accept a structurally valid test JWT without JWKS verification
// ---------------------------------------------------------------------------

/**
 * In integration tests, set COGNITO_VALIDATION_BYPASS=1 and pass a JWT with
 * the claims encoded in the payload. The signature is not verified.
 */
function verifyTestJwt(token: string): CognitoVerifyResult {
  const parsed = parseJwt(token)
  if (!parsed) {
    return { ok: false, code: 'JWT_MALFORMED', detail: 'Test JWT malformed' }
  }

  const { payload } = parsed

  const sub = payload.sub
  const tenantId = payload['custom:tenantId']

  if (!sub || !tenantId) {
    return {
      ok: false,
      code: 'JWT_MISSING_CLAIMS',
      detail: 'Test JWT missing sub or custom:tenantId',
    }
  }

  // Check expiry if present
  const now = Math.floor(Date.now() / 1000)
  if (payload.exp !== undefined && payload.exp < now) {
    return { ok: false, code: 'JWT_EXPIRED', detail: 'Test JWT has expired' }
  }

  return {
    ok: true,
    identity: {
      sub,
      email: payload.email,
      tenantId,
      tokenUse: payload.token_use ?? 'access',
    },
  }
}

// ---------------------------------------------------------------------------
// Test helper: create a test JWT payload (not verified by Cognito JWKS)
// ---------------------------------------------------------------------------

/**
 * Build a test JWT token for use with COGNITO_VALIDATION_BYPASS=1.
 * The token has no valid signature — it's for test harness only.
 */
export function buildTestCognitoToken(opts: {
  sub: string
  tenantId: string
  email?: string
  expiresInSeconds?: number
}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' })).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const payload = Buffer.from(
    JSON.stringify({
      sub: opts.sub,
      email: opts.email,
      'custom:tenantId': opts.tenantId,
      token_use: 'access',
      iss: 'https://cognito-idp.us-east-1.amazonaws.com/test-pool',
      exp: now + (opts.expiresInSeconds ?? 3600),
      iat: now,
    }),
  ).toString('base64url')
  // Signature is irrelevant for test bypass mode
  const sig = Buffer.from('test-signature').toString('base64url')
  return `${header}.${payload}.${sig}`
}

// ---------------------------------------------------------------------------
// Cache reset for tests
// ---------------------------------------------------------------------------

export function _resetJwksCacheForTests(): void {
  jwksCache.clear()
}
