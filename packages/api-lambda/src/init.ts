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

import { getDb } from '../../orchestrator/src/db/client.js'
import { getSecrets, type Secrets } from '../../orchestrator/src/lambda/secrets-cache.js'
import type { DB } from '../../orchestrator/src/db/client.js'

export interface InitResult {
  readonly db: DB
  readonly secrets: Secrets
}

let _initialized = false
let _db!: DB
let _secrets!: Secrets
let _inflight: Promise<InitResult> | null = null

export async function initOnce(): Promise<InitResult> {
  if (_initialized) return { db: _db, secrets: _secrets }
  if (_inflight) return _inflight

  _inflight = (async (): Promise<InitResult> => {
    const [{ db }, secrets] = await Promise.all([getDb(), getSecrets()])
    _db = db
    _secrets = secrets
    _initialized = true
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
  _inflight = null
  ;(_db as unknown) = undefined
  ;(_secrets as unknown) = undefined
}
