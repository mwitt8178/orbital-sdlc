// [Engineer-Principal · Opus · run-round8-07-secrets-kms]
/**
 * lambda/secrets-cache.ts
 *
 * Module-scoped TTL cache around AWS Secrets Manager.
 *
 * Why module-scoped:
 *   - Lambda containers reuse module state across invocations within the
 *     same warm container.
 *   - First invocation (cold start) calls Secrets Manager once;
 *     subsequent invocations return the cached value until TTL expires.
 *   - TTL = 5 minutes by default. After TTL, the next invocation fetches
 *     fresh values, picking up post-rotation values without redeploying
 *     the Lambda.
 *
 * Public surface (interface contract — coordinated with 8-03):
 *   export interface Secrets {
 *     db: { hostname: string; port: number; username: string; database: string }
 *     hubMasterKey: { publicKey: string; privateKey: string }
 *     webhookSecret: string
 *     cognitoAppClientSecret?: string
 *   }
 *   export async function getSecrets(): Promise<Secrets>
 *
 * Required env vars (set by the CDK stack on each Lambda):
 *   - ORBITAL_DB_CREDS_SECRET_ARN          (required)
 *   - ORBITAL_HUB_MASTER_KEY_SECRET_ARN    (required for hub-signing Lambdas)
 *   - ORBITAL_GITHUB_WEBHOOK_SECRET_ARN    (required for prs Lambda)
 *   - ORBITAL_COGNITO_APP_CLIENT_SECRET_ARN (optional)
 *   - AWS_REGION                           (set automatically by Lambda runtime)
 *
 * Test hooks (NOT used by production code):
 *   - __resetForTests(): clears the cache so a fresh getSecrets() refetches
 *   - __setTtlForTests(ms): override the TTL to verify refresh behaviour
 *   - __setClientCtorForTests(ctor): inject an alternative SDK client
 *   - __inspectCacheForTests(): introspect cache state in assertions
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DbCreds {
  /** Aurora cluster writer endpoint. */
  hostname: string
  /** Aurora port — almost always 5432. */
  port: number
  /** DB user. */
  username: string
  /** Default database name. */
  database: string
}

export interface HubMasterKey {
  /** Hex-encoded Ed25519 public key (32 bytes / 64 hex chars). */
  publicKey: string
  /** Hex-encoded Ed25519 private key (32 bytes / 64 hex chars). */
  privateKey: string
}

export interface Secrets {
  db: DbCreds
  hubMasterKey: HubMasterKey
  webhookSecret: string
  cognitoAppClientSecret?: string
}

// ---------------------------------------------------------------------------
// Module-scoped state
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 5 * 60_000

interface CacheEntry {
  value: Secrets
  fetchedAt: number
}

// Use a holder object so a single test can clear the cache via __resetForTests().
const cache: {
  current: CacheEntry | null
  ttlMs: number
  clientCtor: typeof SecretsManagerClient
} = {
  current: null,
  ttlMs: DEFAULT_TTL_MS,
  clientCtor: SecretsManagerClient,
}

let inflight: Promise<Secrets> | null = null

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readEnv(name: string, required: true): string
function readEnv(name: string, required?: false): string | undefined
function readEnv(name: string, required = false): string | undefined {
  const value = process.env[name]
  if (value === undefined || value === '') {
    if (required) {
      throw new Error(
        `secrets-cache.getSecrets: required env var ${name} is not set. ` +
          'CDK stack must inject the secret ARN at deploy time.',
      )
    }
    return undefined
  }
  return value
}

function parseDbCreds(raw: string): DbCreds {
  const obj: unknown = JSON.parse(raw)
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('secrets-cache: db creds payload is not a JSON object')
  }
  const o = obj as Record<string, unknown>
  // Aurora secrets created by the cluster contain { username, password, host,
  // port, dbname, engine }. The host field uses key 'host' (Aurora) or
  // 'hostname' (rotation Lambda output).
  const hostname =
    typeof o['host'] === 'string' ? o['host'] : (o['hostname'] as string | undefined)
  if (!hostname) {
    throw new Error('secrets-cache: db creds missing host/hostname')
  }
  const username = typeof o['username'] === 'string' ? o['username'] : undefined
  if (!username) {
    throw new Error('secrets-cache: db creds missing username')
  }
  // Port is a number in Aurora-managed secrets but may be a string from a
  // rotation Lambda — normalize.
  let port: number
  if (typeof o['port'] === 'number') port = o['port']
  else if (typeof o['port'] === 'string') port = Number.parseInt(o['port'], 10)
  else port = 5432
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new Error(`secrets-cache: db creds port is invalid (${String(o['port'])})`)
  }
  const database =
    typeof o['dbname'] === 'string'
      ? o['dbname']
      : typeof o['database'] === 'string'
        ? o['database']
        : 'orbital_hub'
  return { hostname, port, username, database }
}

function parseHubMasterKey(raw: string): HubMasterKey {
  const obj: unknown = JSON.parse(raw)
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('secrets-cache: hub master key payload is not a JSON object')
  }
  const o = obj as Record<string, unknown>
  // The KeyRotationLambda stores keys as { publicKey, privateKey, generatedAt }.
  // The CDK initial value contains { uninitialized: true, publicKey: 'PENDING_ROTATION', ... }.
  if (o['uninitialized'] === true) {
    throw new Error(
      'secrets-cache: hub master key is uninitialized — wait for the rotation Lambda to run.',
    )
  }
  const publicKey = typeof o['publicKey'] === 'string' ? o['publicKey'] : undefined
  const privateKey = typeof o['privateKey'] === 'string' ? o['privateKey'] : undefined
  if (!publicKey || !privateKey) {
    throw new Error('secrets-cache: hub master key missing publicKey/privateKey')
  }
  if (publicKey.length !== 64 || privateKey.length !== 64) {
    throw new Error(
      `secrets-cache: hub master key length invalid (publicKey=${publicKey.length}, privateKey=${privateKey.length}); expected 64 hex chars each`,
    )
  }
  return { publicKey, privateKey }
}

function parseWebhookSecret(raw: string): string {
  // The webhook secret is stored as a plain string by Secrets Manager
  // GenerateSecretString. If the secret was wrapped in JSON (e.g.
  // {"secret": "..."}), unwrap.
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as { secret?: string }
      if (typeof parsed.secret === 'string') return parsed.secret
    } catch {
      // fall through — treat raw as the secret
    }
  }
  return raw.trim()
}

async function fetchSecrets(): Promise<Secrets> {
  const dbArn = readEnv('ORBITAL_DB_CREDS_SECRET_ARN', true)
  const hubKeyArn = readEnv('ORBITAL_HUB_MASTER_KEY_SECRET_ARN', true)
  const webhookArn = readEnv('ORBITAL_GITHUB_WEBHOOK_SECRET_ARN', true)
  const cognitoArn = readEnv('ORBITAL_COGNITO_APP_CLIENT_SECRET_ARN')

  const region = process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION']
  const client = new cache.clientCtor(region ? { region } : {})

  const arnsToFetch = [dbArn, hubKeyArn, webhookArn, ...(cognitoArn ? [cognitoArn] : [])]
  const results = await Promise.all(
    arnsToFetch.map((arn) => client.send(new GetSecretValueCommand({ SecretId: arn }))),
  )

  const [dbResult, hubResult, webhookResult, cognitoResult] = results
  if (!dbResult?.SecretString) throw new Error('secrets-cache: db creds payload empty')
  if (!hubResult?.SecretString) throw new Error('secrets-cache: hub master key payload empty')
  if (!webhookResult?.SecretString) throw new Error('secrets-cache: webhook secret payload empty')

  return {
    db: parseDbCreds(dbResult.SecretString),
    hubMasterKey: parseHubMasterKey(hubResult.SecretString),
    webhookSecret: parseWebhookSecret(webhookResult.SecretString),
    cognitoAppClientSecret: cognitoResult?.SecretString
      ? parseWebhookSecret(cognitoResult.SecretString)
      : undefined,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the current secrets bundle. Cached for TTL_MS. Concurrent callers
 * during an in-flight fetch share the same Promise so we never fan out.
 */
export async function getSecrets(): Promise<Secrets> {
  const now = Date.now()
  if (cache.current && now - cache.current.fetchedAt < cache.ttlMs) {
    return cache.current.value
  }
  if (inflight) {
    return inflight
  }
  inflight = (async () => {
    try {
      const value = await fetchSecrets()
      cache.current = { value, fetchedAt: Date.now() }
      return value
    } finally {
      inflight = null
    }
  })()
  return inflight
}

// ---------------------------------------------------------------------------
// Test hooks (used by integration tests; never by production code)
// ---------------------------------------------------------------------------

/**
 * Reset the cache and TTL — used in tests to force a refetch.
 * Production code never calls this.
 */
export function __resetForTests(): void {
  cache.current = null
  inflight = null
  cache.ttlMs = DEFAULT_TTL_MS
  cache.clientCtor = SecretsManagerClient
}

/**
 * Override the cache TTL. Used in tests to verify refresh behaviour without
 * waiting 5 real minutes.
 */
export function __setTtlForTests(ttlMs: number): void {
  cache.ttlMs = ttlMs
}

/**
 * Inject an alternative SecretsManagerClient constructor for integration
 * tests that need a fake/local SDK client. Production code never calls this.
 */
export function __setClientCtorForTests(ctor: typeof SecretsManagerClient): void {
  cache.clientCtor = ctor
}

/**
 * Inspect the current cache state — used by integration tests to assert
 * cold-start behaviour.
 */
export function __inspectCacheForTests(): {
  hasValue: boolean
  ageMs: number | null
  ttlMs: number
} {
  return {
    hasValue: cache.current !== null,
    ageMs: cache.current ? Date.now() - cache.current.fetchedAt : null,
    ttlMs: cache.ttlMs,
  }
}
