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

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager'

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
let _db!: DB
let _secrets!: Secrets
let _inflight: Promise<InitResult> | null = null

export async function initOnce(): Promise<InitResult> {
  if (_initialized) return { db: _db, secrets: _secrets }
  if (_inflight) return _inflight

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
