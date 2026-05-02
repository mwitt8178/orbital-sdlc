/**
 * lambda/init.ts — Cold-start initializer for all tRPC Lambda handlers.
 *
 * [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
 *
 * Pattern: module-scope singletons initialized exactly once per Lambda container.
 * Subsequent warm invocations reuse the cached `db` and `secrets` references,
 * avoiding repeated IAM token generation and Secrets Manager round-trips.
 *
 * Coordination with 8-07:
 *   getSecrets() is imported from ./secrets-cache — 8-07 replaces that stub
 *   with real Secrets Manager SDK calls. The interface is stable.
 *
 * DB connection:
 *   getDb() from db/client.ts branches on ORBITAL_DEPLOY_TARGET:
 *     - 'aws': IAM auth via RDS Proxy (generates short-lived token)
 *     - unset: direct DATABASE_URL (local/docker mode)
 *
 * Error handling:
 *   initOnce() never silently swallows errors. If DB or secrets init fails
 *   the Lambda invocation fails loudly — CloudWatch captures the error and
 *   the Lambda runtime retries per the event source configuration.
 */

import type { DB } from '../db/client.js'
import type { Secrets } from './secrets-cache.js'

// ---------------------------------------------------------------------------
// Module-scope cache (one per Lambda container lifetime)
// ---------------------------------------------------------------------------

let _initialized = false
let _db: DB
let _secrets: Secrets

/**
 * InitResult — the cached resources returned by initOnce().
 * Destructure to access db and secrets in handlers:
 *   const { db, secrets } = await initOnce()
 */
export interface InitResult {
  readonly db: DB
  readonly secrets: Secrets
}

/**
 * initOnce — initialise the Lambda container on first invocation.
 *
 * Subsequent calls return the cached resources immediately (O(1)).
 * Thread-safety is not a concern: Lambda containers are single-threaded.
 *
 * @throws if DB connection or secret retrieval fails.
 */
export async function initOnce(): Promise<InitResult> {
  if (_initialized) {
    return { db: _db, secrets: _secrets }
  }

  // Fetch secrets from Secrets Manager (8-07 stub for now)
  const { getSecrets } = await import('./secrets-cache.js')
  _secrets = await getSecrets()

  // Build DB connection (IAM auth in AWS mode, direct URL in local mode)
  const { getDb } = await import('../db/client.js')
  const { db } = await getDb()
  _db = db

  _initialized = true
  return { db: _db, secrets: _secrets }
}

/**
 * resetInit — test helper to allow re-initialization between test cases.
 * NOT exported from the package — only used in test files via direct import.
 */
export function _resetInit(): void {
  _initialized = false
  ;(_db as unknown) = undefined
  ;(_secrets as unknown) = undefined
}
