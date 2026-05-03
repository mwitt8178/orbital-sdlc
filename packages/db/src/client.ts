// [Engineer-Sr · Sonnet · run-round8-02-aurora]
// Phase 3.2: moved from packages/orchestrator/src/db/ → packages/db/src/
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'

/**
 * DB client — branches on ORBITAL_DEPLOY_TARGET:
 *
 * Local / Docker (ORBITAL_DEPLOY_TARGET unset):
 *   Uses DATABASE_URL directly. Suitable for local development and CI
 *   running a Docker Postgres. Full backwards compatibility — no change
 *   from Round 7 behaviour.
 *
 * AWS Lambda (ORBITAL_DEPLOY_TARGET=aws):
 *   Uses IAM auth via RDS Proxy. The `@aws-sdk/rds-signer` generates a
 *   short-lived signed token (15 min TTL). The token is used as the
 *   Postgres password. SSL is required (RDS Proxy enforces it for IAM auth).
 *
 *   Required env vars (set by Lambda config in 8-03):
 *     RDS_PROXY_HOSTNAME — proxy endpoint hostname
 *     RDS_PROXY_PORT     — proxy port (default 5432)
 *     AURORA_DB_NAME     — database name (default orbital_hub)
 *     AURORA_USERNAME    — IAM-enabled DB username (default orbital_admin)
 *     AWS_REGION         — injected automatically by Lambda runtime
 *
 * Token refresh:
 *   IAM tokens are valid for 15 minutes. The postgres.js client keeps
 *   connections alive for the lifetime of the Lambda instance. To handle
 *   token expiry across warm invocations, a new token is generated whenever
 *   `getAWSDb()` is called (each Lambda cold start). If a connection is
 *   reused across a 15-minute boundary the proxy will reject it; Lambda
 *   reconnects automatically on the next request via the pooling provided
 *   by RDS Proxy itself.
 *
 * Connection pool note:
 *   RDS Proxy handles connection pooling to Aurora. Lambda should use
 *   max: 1 (one connection per Lambda instance) to avoid exhausting the
 *   proxy's connection slots across concurrent invocations.
 */

// ---------------------------------------------------------------------------
// Minimal env reading — no external dependency on orchestrator config
// ---------------------------------------------------------------------------
const _env = {
  ORBITAL_DEPLOY_TARGET: process.env['ORBITAL_DEPLOY_TARGET'] as 'aws' | 'local' | undefined ?? 'local',
  DATABASE_URL: process.env['DATABASE_URL'] ?? 'postgres://orbital:orbital_dev_password@localhost:5432/orbital',
  RDS_PROXY_HOSTNAME: process.env['RDS_PROXY_HOSTNAME'],
  RDS_PROXY_PORT: parseInt(process.env['RDS_PROXY_PORT'] ?? '5432', 10),
  AURORA_DB_NAME: process.env['AURORA_DB_NAME'] ?? 'orbital_hub',
  AURORA_USERNAME: process.env['AURORA_USERNAME'] ?? 'orbital_admin',
}

const e = _env

// ---------------------------------------------------------------------------
// AWS mode — IAM auth via RDS Proxy
// ---------------------------------------------------------------------------

/**
 * Lazy import of @aws-sdk/rds-signer — only loaded in AWS mode.
 * This avoids bundling the AWS SDK in local/Docker builds where it is
 * not needed and not installed.
 */
async function generateIamToken(): Promise<string> {
  // Dynamic import: not available in local dev (not a dependency there).
  // In AWS Lambda the package is installed as a Lambda layer or bundled dep.
  const { Signer } = await import('@aws-sdk/rds-signer')

  const region = process.env['AWS_REGION']
  if (!region) {
    throw new Error(
      'AWS_REGION is not set. Required for IAM DB auth (ORBITAL_DEPLOY_TARGET=aws).',
    )
  }
  const hostname = e.RDS_PROXY_HOSTNAME
  if (!hostname) {
    throw new Error(
      'RDS_PROXY_HOSTNAME is not set. Required for IAM DB auth (ORBITAL_DEPLOY_TARGET=aws).',
    )
  }

  const signer = new Signer({
    region,
    hostname,
    port: e.RDS_PROXY_PORT,
    username: e.AURORA_USERNAME,
  })

  return signer.getAuthToken()
}

/**
 * Build a Drizzle DB client using IAM auth against RDS Proxy.
 * Called on each AWS Lambda cold start.
 *
 * Returns both the raw `sql` client (for `.end()`) and the Drizzle `db` wrapper.
 */
async function buildAWSDb(): Promise<{ sql: postgres.Sql; db: ReturnType<typeof drizzle> }> {
  const token = await generateIamToken()

  if (!e.RDS_PROXY_HOSTNAME) {
    throw new Error('RDS_PROXY_HOSTNAME must be set when ORBITAL_DEPLOY_TARGET=aws')
  }

  const sql = postgres({
    host: e.RDS_PROXY_HOSTNAME,
    port: e.RDS_PROXY_PORT,
    database: e.AURORA_DB_NAME,
    username: e.AURORA_USERNAME,
    password: token,
    // RDS Proxy with IAM auth requires SSL
    ssl: { rejectUnauthorized: false }, // AWS-managed cert; trust is established via IAM
    // Lambda: single connection per instance — RDS Proxy pools to Aurora
    max: 1,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => {
      /* suppress NOTICE messages */
    },
  })

  const db = drizzle(sql)
  return { sql, db }
}

// ---------------------------------------------------------------------------
// Local / Docker mode — DATABASE_URL direct connection
// ---------------------------------------------------------------------------

function buildLocalDb(): { sql: postgres.Sql; db: ReturnType<typeof drizzle> } {
  const sql = postgres(e.DATABASE_URL, {
    max: 20,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => {
      /* suppress NOTICE messages */
    },
  })
  const db = drizzle(sql)
  return { sql, db }
}

// ---------------------------------------------------------------------------
// Exported DB instance
//
// For local mode: synchronously constructed (backwards compatible).
// For AWS mode: constructed lazily on first call to getAWSDb().
//
// Callers that need to handle the AWS async path should use `getDb()`.
// The sync `db` export is provided for backward compat with local mode only.
// ---------------------------------------------------------------------------

// Synchronous exports — ONLY valid in local/Docker mode.
// In AWS mode these will be undefined until getDb() is awaited.
let _sql: postgres.Sql | undefined
let _db: ReturnType<typeof drizzle> | undefined

if (e.ORBITAL_DEPLOY_TARGET !== 'aws') {
  // Local mode: build synchronously
  const local = buildLocalDb()
  _sql = local.sql
  _db = local.db
}

/**
 * Synchronous Postgres client.
 * Valid in local/Docker mode (ORBITAL_DEPLOY_TARGET unset).
 * In AWS mode use `getDb()` instead.
 */
export const sql: postgres.Sql = new Proxy({} as postgres.Sql, {
  get(_t, prop) {
    if (!_sql) {
      throw new Error(
        'sql is not initialised in AWS mode. Call await getDb() before accessing sql.',
      )
    }
    return _sql[prop as keyof postgres.Sql]
  },
})

/**
 * Synchronous Drizzle DB client.
 * Valid in local/Docker mode (ORBITAL_DEPLOY_TARGET unset).
 * In AWS mode use `getDb()` instead.
 */
export const db: ReturnType<typeof drizzle> = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_t, prop) {
    if (!_db) {
      throw new Error(
        'db is not initialised in AWS mode. Call await getDb() before accessing db.',
      )
    }
    return _db[prop as keyof ReturnType<typeof drizzle>]
  },
})

export type DB = typeof db

/**
 * getDb — async accessor that works in both local and AWS mode.
 *
 * In local/Docker mode: returns the pre-built synchronous client immediately.
 * In AWS mode:          generates an IAM token, builds the client, and returns it.
 *
 * AWS Lambda handlers should call this once per cold start and cache the result
 * in module scope:
 *
 *   let dbInstance: Awaited<ReturnType<typeof getDb>> | null = null
 *
 *   export async function handler(event) {
 *     if (!dbInstance) dbInstance = await getDb()
 *     const { db } = dbInstance
 *     // ... use db
 *   }
 */
export async function getDb(): Promise<{ sql: postgres.Sql; db: ReturnType<typeof drizzle> }> {
  if (e.ORBITAL_DEPLOY_TARGET === 'aws') {
    // AWS mode — verify required env vars before generating a token
    const token = await generateIamToken()

    if (!e.RDS_PROXY_HOSTNAME) {
      throw new Error('RDS_PROXY_HOSTNAME must be set when ORBITAL_DEPLOY_TARGET=aws')
    }

    const sqlClient = postgres({
      host: e.RDS_PROXY_HOSTNAME,
      port: e.RDS_PROXY_PORT,
      database: e.AURORA_DB_NAME,
      username: e.AURORA_USERNAME,
      password: token,
      ssl: { rejectUnauthorized: false },
      max: 1,
      idle_timeout: 30,
      connect_timeout: 10,
      prepare: false,
      onnotice: () => {
        /* suppress NOTICE messages */
      },
    })

    const dbClient = drizzle(sqlClient)

    // Cache in module scope so Lambda warm invocations reuse the connection
    _sql = sqlClient
    _db = dbClient

    return { sql: sqlClient, db: dbClient }
  }

  // Local mode — already built
  if (!_sql || !_db) {
    const local = buildLocalDb()
    _sql = local.sql
    _db = local.db
  }

  return { sql: _sql, db: _db }
}

/**
 * Cleanly close the pool.
 * In AWS Lambda, call this in the SIGTERM handler (Lambda shutdown lifecycle).
 */
export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.end({ timeout: 5 })
  }
}
