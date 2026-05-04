/**
 * @orbital/api-lambda — Lambda cold-start initializer.
 *
 * Reuses the orchestrator's existing `getDb` (RDS Proxy IAM auth) and
 * `getSecrets` (Secrets Manager with TTL cache) but wraps them in a
 * single-flight pattern keyed to module scope so the warm-path cost
 * is one promise lookup.
 *
 * Side-effect free at module import (verified by cold-import guard).
 *
 * X-Ray instrumentation:
 *   When ORBITAL_DEPLOY_TARGET=aws (always true in Lambda), the AWS
 *   SDK v3 client used by `getSecrets` is wrapped with
 *   `captureAWSv3Client`. RDS Proxy connections are visible as a
 *   downstream segment via the postgres.js socket trace.
 */

import { getDb } from '@orbital/db'
import { getSecrets, type Secrets, type DbCreds } from '../../orchestrator/src/lambda/secrets-cache.js'
import type { DB } from '@orbital/db'
import { _invalidateRouter } from './router.js'

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager'

/**
 * Fetch Anthropic API key from Secrets Manager and inject into process.env.
 *
 * The existing AnthropicDriver (drivers/anthropic.ts) reads from
 * env.ANTHROPIC_API_KEY via loadEnv(). We populate it once on cold start so
 * the driver works without code changes.
 *
 * Idempotent: skipped if ANTHROPIC_API_KEY is already set (e.g. in dev) or if
 * ANTHROPIC_API_KEY_SECRET_ARN is not configured.
 *
 * The secret payload may be either:
 *   - a raw key string ("sk-ant-..."), or
 *   - a JSON object { "ANTHROPIC_API_KEY": "sk-ant-..." } / { "apiKey": "sk-ant-..." }.
 *
 * [Engineer-Principal · Opus · run-vision-llm-decompose]
 */
/**
 * GitHub App private-key cache (per cold-start container).
 *
 * Loaded lazily from Secrets Manager on first call — most browser tRPC
 * procedures don't touch the GitHub App at all, so we don't pay the
 * Secrets Manager fetch unless required.
 *
 * The orchestrator's app-client.ts consumes this via
 * `getStoryExecutorGitHubClient()`. If `ORBITAL_GITHUB_APP_ENABLED` is unset
 * we throw with a clear message so the parent agent can register the App
 * + create the secrets before flipping the gate.
 *
 * [Engineer-Principal · Opus · run-orbital-github-integration]
 */
let _ghAppClient: import('../../orchestrator/src/github/app-client.js').DefaultStoryExecutorGitHubClient | null = null
let _ghAppInflight: Promise<
  import('../../orchestrator/src/github/app-client.js').DefaultStoryExecutorGitHubClient
> | null = null

async function fetchSecretString(arn: string): Promise<string> {
  const client = new SecretsManagerClient({})
  const result = await client.send(new GetSecretValueCommand({ SecretId: arn }))
  if (!result.SecretString) {
    throw new Error(`secrets-manager: ${arn} has empty SecretString`)
  }
  return result.SecretString
}

function parseGithubPrivateKey(raw: string): string {
  // The secret may be raw PEM or wrapped JSON: { "privateKey": "-----BEGIN..." }.
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const k =
        (typeof parsed['privateKey'] === 'string' ? (parsed['privateKey'] as string) : undefined) ??
        (typeof parsed['private_key'] === 'string' ? (parsed['private_key'] as string) : undefined) ??
        (typeof parsed['pem'] === 'string' ? (parsed['pem'] as string) : undefined)
      if (k) return k
    } catch {
      // fall through — treat as raw PEM
    }
  }
  return trimmed
}

export async function getStoryExecutorGitHubClient(): Promise<
  import('../../orchestrator/src/github/app-client.js').DefaultStoryExecutorGitHubClient
> {
  if (_ghAppClient) return _ghAppClient
  if (_ghAppInflight) return _ghAppInflight

  _ghAppInflight = (async () => {
    if (process.env['ORBITAL_GITHUB_APP_ENABLED'] !== '1') {
      throw new Error(
        'GitHub App integration not enabled. Set ORBITAL_GITHUB_APP_ENABLED=1 ' +
          'after registering the App and creating the webhook + private-key secrets.',
      )
    }
    const appIdRaw = process.env['ORBITAL_GITHUB_APP_ID']
    if (!appIdRaw) {
      throw new Error('ORBITAL_GITHUB_APP_ID env var is required for GitHub App auth')
    }
    const appId = Number.parseInt(appIdRaw, 10)
    if (!Number.isFinite(appId) || appId <= 0) {
      throw new Error(`ORBITAL_GITHUB_APP_ID is not a positive integer: ${appIdRaw}`)
    }
    const pkArn = process.env['ORBITAL_GITHUB_APP_PRIVATE_KEY_SECRET_ARN']
    if (!pkArn) {
      throw new Error(
        'ORBITAL_GITHUB_APP_PRIVATE_KEY_SECRET_ARN env var is required for GitHub App auth',
      )
    }
    const raw = await fetchSecretString(pkArn)
    const privateKeyPem = parseGithubPrivateKey(raw)
    const { createStoryExecutorGitHubClient } = await import(
      '../../orchestrator/src/github/app-client.js'
    )
    _ghAppClient = createStoryExecutorGitHubClient({ appId, privateKeyPem })
    return _ghAppClient
  })()

  try {
    return await _ghAppInflight
  } finally {
    _ghAppInflight = null
  }
}

export async function getGithubAppWebhookSecret(): Promise<string> {
  if (process.env['ORBITAL_GITHUB_APP_ENABLED'] !== '1') {
    throw new Error('GitHub App integration not enabled')
  }
  const arn = process.env['ORBITAL_GITHUB_APP_WEBHOOK_SECRET_ARN']
  if (!arn) {
    throw new Error('ORBITAL_GITHUB_APP_WEBHOOK_SECRET_ARN env var is required')
  }
  const raw = await fetchSecretString(arn)
  // Webhook secret is a plain string or {"secret": "..."}.
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { secret?: string }
      if (typeof parsed.secret === 'string') return parsed.secret
    } catch {
      // fall through
    }
  }
  return trimmed
}

async function loadAnthropicApiKey(): Promise<void> {
  if (process.env['ANTHROPIC_API_KEY']) return
  const arn = process.env['ANTHROPIC_API_KEY_SECRET_ARN']
  if (!arn) return // not configured — non-fatal
  try {
    const client = new SecretsManagerClient({})
    const result = await client.send(new GetSecretValueCommand({ SecretId: arn }))
    const payload = result.SecretString
    if (!payload) return
    let key: string | undefined
    if (payload.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>
        key =
          (typeof parsed['ANTHROPIC_API_KEY'] === 'string'
            ? (parsed['ANTHROPIC_API_KEY'] as string)
            : undefined) ??
          (typeof parsed['apiKey'] === 'string' ? (parsed['apiKey'] as string) : undefined) ??
          (typeof parsed['api_key'] === 'string' ? (parsed['api_key'] as string) : undefined)
      } catch {
        // fall through — treat as raw
      }
    }
    if (!key && payload.startsWith('sk-')) key = payload.trim()
    if (key) {
      process.env['ANTHROPIC_API_KEY'] = key
    }
  } catch (err) {
    // Non-fatal — only LLM-backed procedures will fail with a clear error later.
    structuredLog({
      event: 'anthropic_secret_load_failed',
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}

async function getDbCredsOnly(): Promise<DbCreds> {
  const arn = process.env['ORBITAL_DB_CREDS_SECRET_ARN']
  if (!arn) throw new Error('ORBITAL_DB_CREDS_SECRET_ARN not set')
  const client = new SecretsManagerClient({})
  const result = await client.send(new GetSecretValueCommand({ SecretId: arn }))
  if (!result.SecretString) throw new Error('db creds payload empty')
  const parsed = JSON.parse(result.SecretString) as Record<string, unknown>
  const hostname = typeof parsed['host'] === 'string' ? parsed['host'] : (parsed['hostname'] as string)
  const username = parsed['username'] as string
  let port = 5432
  if (typeof parsed['port'] === 'number') port = parsed['port']
  else if (typeof parsed['port'] === 'string') port = Number.parseInt(parsed['port'], 10)
  const database =
    typeof parsed['dbname'] === 'string'
      ? parsed['dbname']
      : typeof parsed['database'] === 'string'
        ? parsed['database']
        : 'orbital_hub'
  return { hostname, port, username, database }
}

export interface InitResult {
  readonly db: DB
  readonly secrets: Secrets
}

let _initialized = false
let _initializedAt = 0
let _db!: DB
let _secrets!: Secrets
let _inflight: Promise<InitResult> | null = null

/**
 * RDS Proxy IAM tokens have a 15-minute TTL. We refresh the cached DB
 * connection at the 12-minute mark to avoid serving requests with a
 * stale token (which would fail with `IAM authentication failed`).
 */
const DB_REFRESH_MS = 12 * 60_000

/**
 * Emit a single structured JSON log line to stdout.
 * Avoids pulling pino into this bundle (pino is not a direct dep of api-lambda).
 * CloudWatch Logs Insights and metric filters parse JSON emitted to stdout.
 * Never log token contents or secret values here.
 */
function structuredLog(fields: Record<string, unknown>): void {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ...fields, ts: new Date().toISOString() }))
}

export async function initOnce(requestId?: string): Promise<InitResult> {
  const now = Date.now()
  const stale = _initialized && now - _initializedAt > DB_REFRESH_MS
  if (_initialized && !stale) return { db: _db, secrets: _secrets }
  if (stale) {
    structuredLog({
      event: 'iam_token_refresh',
      reason: 'stale',
      ageMs: now - _initializedAt,
      ...(requestId ? { requestId } : {}),
    })
    _initialized = false // force a fresh getDb() below
    _invalidateRouter() // drop the router so services rebind to the fresh client
  }
  if (_inflight) return _inflight

  const initStart = Date.now()
  const coldStart = !_initialized && _initializedAt === 0

  _inflight = (async (): Promise<InitResult> => {
    const dbPromise = getDb()
    // Hub master key may be in the placeholder "uninitialized" state on a
    // fresh deploy until the KeyRotation Lambda runs. Catch that case so
    // procedures that don't need the hub master key (the vast majority of
    // browser-served procedures) still work. Procedures that DO need it
    // throw a clear error at procedure-call time.
    let secrets: Secrets
    try {
      secrets = await getSecrets()
    } catch (err) {
      if (err instanceof Error && /hub master key is uninitialized/.test(err.message)) {
        // eslint-disable-next-line no-console
        console.warn(
          '[api-lambda] hub master key uninitialized, falling back to db-only secrets. ' +
            'Procedures that require it will throw a descriptive error.',
        )
        // Build a partial secrets object — only the db creds are guaranteed.
        // Use a Proxy for hubMasterKey/webhookSecret so any access throws clearly.
        secrets = {
          db: await getDbCredsOnly(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          hubMasterKey: new Proxy({} as any, {
            get() {
              throw new Error(
                'hub master key is not initialized; this procedure requires it. ' +
                  'Trigger the KeyRotation Lambda or wait for its first scheduled run.',
              )
            },
          }),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          webhookSecret: new Proxy({} as any, {
            get() {
              throw new Error('webhookSecret accessed but not initialized')
            },
          }) as unknown as string,
        }
      } else {
        throw err
      }
    }
    const { db } = await dbPromise
    // Populate ANTHROPIC_API_KEY for LLM-backed procedures (planning.regenerate, etc.)
    // [Engineer-Principal · Opus · run-vision-llm-decompose]
    await loadAnthropicApiKey()
    _db = db
    _secrets = secrets
    _initialized = true
    _initializedAt = Date.now()
    structuredLog({
      event: 'lambda_init',
      coldStart,
      durationMs: Date.now() - initStart,
      dbRefreshed: !coldStart, // true on a 12-min stale refresh, false on first cold start
      ...(requestId ? { requestId } : {}),
    })
    return { db: _db, secrets: _secrets }
  })()

  try {
    const result = await _inflight
    return result
  } finally {
    _inflight = null
  }
}

/** Test hook — reset so tests can simulate a fresh cold start. */
export function _resetForTests(): void {
  _initialized = false
  _initializedAt = 0
  _inflight = null
  ;(_db as unknown) = undefined
  ;(_secrets as unknown) = undefined
}
