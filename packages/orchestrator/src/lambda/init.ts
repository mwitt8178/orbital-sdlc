/**
 * lambda/init.ts — Cold-start initializer for all tRPC Lambda handlers.
 *
 * [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
 * [Engineer-Sr · Sonnet · run-round8-08-observability] — X-Ray SDK instrumentation added
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
 * X-Ray instrumentation (8-08):
 *   When ORBITAL_DEPLOY_TARGET=aws, all AWS SDK v3 clients are wrapped with
 *   captureAWSv3Client() from aws-xray-sdk-core. This propagates the X-Ray
 *   trace context from API GW → Lambda → downstream SDK calls (Secrets Manager,
 *   RDS Signer, SNS, DynamoDB). Aurora calls appear as downstream segments
 *   via the db client's connection to RDS Proxy.
 *
 *   In local mode (ORBITAL_DEPLOY_TARGET unset), X-Ray capture is skipped to
 *   avoid requiring aws-xray-sdk-core at development time.
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

/** Whether X-Ray client wrapping is active (set on first init). */
let _xrayEnabled = false

/**
 * InitResult — the cached resources returned by initOnce().
 * Destructure to access db and secrets in handlers:
 *   const { db, secrets } = await initOnce()
 */
export interface InitResult {
  readonly db: DB
  readonly secrets: Secrets
  /** True when X-Ray SDK client instrumentation is active. */
  readonly xrayEnabled: boolean
}

// ---------------------------------------------------------------------------
// X-Ray instrumentation helpers
// ---------------------------------------------------------------------------

/**
 * Type for an AWS SDK v3 client constructor or instance to be captured.
 * aws-xray-sdk-core accepts any AWS SDK v3 client instance.
 */
type AwsSdkClient = object

/**
 * captureAwsClient — wraps an AWS SDK v3 client with X-Ray tracing.
 *
 * No-op when not in AWS deploy mode (avoids requiring the SDK locally).
 * Dynamically imports aws-xray-sdk-core to keep the dependency optional
 * at module load time — the SDK is only bundled in Lambda artifacts.
 *
 * The dynamic import uses a variable string to prevent tsc from statically
 * resolving the module at compile time (avoids "module not found" in local dev
 * where aws-xray-sdk-core may not be installed).
 *
 * @param client - Any AWS SDK v3 client instance.
 * @returns The same client, now instrumented, or the original if X-Ray is unavailable.
 */
export async function captureAwsClient<T extends AwsSdkClient>(client: T): Promise<T> {
  if (process.env['ORBITAL_DEPLOY_TARGET'] !== 'aws') {
    return client
  }
  try {
    // Dynamic import via a variable — prevents tsc from statically resolving
    // the module (which would fail if aws-xray-sdk-core is not installed locally).
    // In Lambda bundles the SDK is available because it's listed as a dependency.
    const xraySdkName = 'aws-xray-sdk-core'
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const xray = await import(/* @vite-ignore */ xraySdkName) as {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      captureAWSv3Client: (client: any) => any
    }
    // captureAWSv3Client mutates the client in place and returns it.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
    return xray.captureAWSv3Client(client) as T
  } catch {
    // If the X-Ray SDK is unavailable (e.g. not bundled), proceed without tracing.
    // This is a non-fatal degradation — the Lambda still functions correctly.
    return client
  }
}

// ---------------------------------------------------------------------------
// initOnce
// ---------------------------------------------------------------------------

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
    return { db: _db, secrets: _secrets, xrayEnabled: _xrayEnabled }
  }

  // ------------------------------------------------------------------
  // X-Ray — enable client instrumentation in AWS mode (8-08)
  // We mark X-Ray active before initializing clients so any clients
  // created during init can also be wrapped by callers.
  // ------------------------------------------------------------------
  _xrayEnabled = process.env['ORBITAL_DEPLOY_TARGET'] === 'aws'

  // Fetch secrets from Secrets Manager (8-07 implementation)
  const { getSecrets } = await import('./secrets-cache.js')
  _secrets = await getSecrets()

  // Build DB connection (IAM auth in AWS mode, direct URL in local mode)
  const { getDb } = await import('../db/client.js')
  const { db } = await getDb()
  _db = db

  _initialized = true
  return { db: _db, secrets: _secrets, xrayEnabled: _xrayEnabled }
}

/**
 * resetInit — test helper to allow re-initialization between test cases.
 * NOT exported from the package — only used in test files via direct import.
 */
export function _resetInit(): void {
  _initialized = false
  _xrayEnabled = false
  ;(_db as unknown) = undefined
  ;(_secrets as unknown) = undefined
}
