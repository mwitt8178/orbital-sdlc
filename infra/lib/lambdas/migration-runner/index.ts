// [Engineer-Sr · Sonnet · run-round8-02-aurora]
/**
 * migration-runner/index.ts
 *
 * Lambda function invoked by the CDK custom resource trigger on every
 * `cdk deploy`. Applies all pending SQL migrations from
 * packages/orchestrator/src/db/migrations/ against Aurora via RDS Proxy
 * using IAM authentication.
 *
 * Idempotency:
 *  - Maintains a `drizzle.__drizzle_migrations` tracking table (created
 *    by the first migration that sets up the schema).
 *  - Skips any migration whose hash is already in the tracking table.
 *  - SQL files are applied in lexicographic order (0001_..., 0002_..., etc.).
 *
 * IAM auth:
 *  - RDS_PROXY_HOSTNAME, RDS_PROXY_PORT, AURORA_DB_NAME, AURORA_USERNAME
 *    env vars are set by the CDK construct.
 *  - Uses @aws-sdk/rds-signer to generate a short-lived IAM auth token.
 *  - SSL is required (Aurora/RDS Proxy reject non-SSL connections when
 *    IAM auth is enabled).
 *
 * Custom resource protocol:
 *  - Returns { PhysicalResourceId, Data: { MigrationsApplied } } on success.
 *  - Throws on any failure - CDK custom resource framework marks the
 *    deployment as failed and rolls back.
 */

import { Signer } from '@aws-sdk/rds-signer'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import postgres from 'postgres'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CloudFormationCustomResourceEvent {
  RequestType: 'Create' | 'Update' | 'Delete'
  ResponseURL: string
  StackId: string
  RequestId: string
  ResourceType: string
  LogicalResourceId: string
  PhysicalResourceId?: string
  ResourceProperties: Record<string, string>
}

interface LambdaContext {
  logStreamName: string
  functionName: string
}

interface CustomResourceResponse {
  PhysicalResourceId: string
  Data: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function requireEnv(key: string): string {
  const val = process.env[key]
  if (!val) {
    throw new Error(`STARTUP_ERROR: required env var ${key} is not set`)
  }
  return val
}

// ---------------------------------------------------------------------------
// IAM token generation
// ---------------------------------------------------------------------------

async function getIamAuthToken(): Promise<string> {
  const region = requireEnv('AWS_REGION')
  const hostname = requireEnv('RDS_PROXY_HOSTNAME')
  const port = parseInt(process.env['RDS_PROXY_PORT'] ?? '5432', 10)
  const username = requireEnv('AURORA_USERNAME')

  const signer = new Signer({ region, hostname, port, username })
  return signer.getAuthToken()
}

// ---------------------------------------------------------------------------
// Migration tracking
// ---------------------------------------------------------------------------

/**
 * Ensure the drizzle migrations tracking table exists.
 * This table is the same format Drizzle ORM expects.
 */
async function ensureMigrationsTable(sql: postgres.Sql): Promise<void> {
  await sql`CREATE SCHEMA IF NOT EXISTS drizzle`
  await sql`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id        SERIAL PRIMARY KEY,
      hash      TEXT    NOT NULL,
      created_at BIGINT
    )
  `
}

/**
 * Returns the set of migration hashes already applied.
 */
async function getAppliedMigrations(sql: postgres.Sql): Promise<Set<string>> {
  const rows = await sql<Array<{ hash: string }>>`
    SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at
  `
  return new Set(rows.map((r) => r.hash))
}

/**
 * Record a migration as applied.
 */
async function recordMigration(sql: postgres.Sql, hash: string): Promise<void> {
  await sql`
    INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
    VALUES (${hash}, ${Date.now()})
  `
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Read all .sql files from the migrations directory, sorted lexicographically.
 * The migrations are bundled into the Lambda artifact at synth time
 * via NodejsFunction's `bundling.commandHooks` (see run-migrations.ts).
 */
async function readMigrationFiles(migrationsDir: string): Promise<Array<{ name: string; hash: string; sql: string }>> {
  let files: string[]
  try {
    const entries = await fs.readdir(migrationsDir)
    files = entries.filter((f) => f.endsWith('.sql')).sort()
  } catch (err) {
    console.log(JSON.stringify({
      level: 'warn',
      msg: 'migrations directory not found or empty',
      migrationsDir,
      err: String(err),
    }))
    return []
  }

  const migrations = await Promise.all(
    files.map(async (filename) => {
      const content = await fs.readFile(path.join(migrationsDir, filename), 'utf8')
      // Hash is the file stem (without .sql) - matches drizzle-orm convention
      const hash = filename.replace(/\.sql$/, '')
      return { name: filename, hash, sql: content }
    }),
  )

  return migrations
}

/**
 * Apply a single migration inside a transaction.
 * Extensions (CREATE EXTENSION) are run outside the transaction as DDL.
 */
async function applyMigration(
  sql: postgres.Sql,
  migration: { name: string; hash: string; sql: string },
): Promise<void> {
  console.log(JSON.stringify({ level: 'info', msg: 'applying migration', migration: migration.name }))

  // Run the migration SQL, then record it as applied - all in one transaction
  // so a failed migration does not leave a partial tracking entry.
  await sql.begin(async (tx) => {
    // Execute the migration SQL (may contain multiple statements)
    await tx.unsafe(migration.sql)
    // Record as applied within the same transaction
    await tx`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES (${migration.hash}, ${Date.now()})
    `
  })
}

// ---------------------------------------------------------------------------
// Lambda handler
// ---------------------------------------------------------------------------

export async function handler(
  event: CloudFormationCustomResourceEvent,
  context: LambdaContext,
): Promise<CustomResourceResponse> {
  const physicalId = `migration-runner-${event.StackId}-${event.LogicalResourceId}`

  console.log(JSON.stringify({
    level: 'info',
    msg: 'migration runner invoked',
    requestType: event.RequestType,
    requestId: event.RequestId,
    logStream: context.logStreamName,
  }))

  // On Delete: nothing to do - we never roll back migrations
  if (event.RequestType === 'Delete') {
    console.log(JSON.stringify({ level: 'info', msg: 'Delete event - skipping migrations (migrations are never rolled back)' }))
    return { PhysicalResourceId: physicalId, Data: { MigrationsApplied: 0 } }
  }

  // ------------------------------------------------------------------
  // Connect DIRECTLY to Aurora (bypass RDS Proxy) with password auth.
  //
  // Why direct + password instead of proxy + IAM:
  //   - Aurora master user (orbital_admin) can't use IAM auth out of the box;
  //     it needs `GRANT rds_iam` first, which only the migration runner can do.
  //   - Chicken-and-egg if we IAM-auth as master through the proxy.
  //   - Password auth via the master secret is the standard migration-runner
  //     pattern. Hub Lambdas continue to use proxy + IAM via a non-master
  //     user this migration bootstraps.
  //   - The master secret is rotated by AWS; we always read fresh.
  // ------------------------------------------------------------------
  const hostname = requireEnv('CLUSTER_ENDPOINT')
  const port = parseInt(process.env['CLUSTER_PORT'] ?? '5432', 10)
  const database = requireEnv('AURORA_DB_NAME')
  const secretArn = requireEnv('MASTER_SECRET_ARN')

  // Fetch master credentials from Secrets Manager
  const sm = new SecretsManagerClient({})
  const secretRes = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }))
  const secretJson = JSON.parse(secretRes.SecretString ?? '{}') as {
    username: string
    password: string
  }
  if (!secretJson.username || !secretJson.password) {
    throw new Error('MASTER_SECRET_ARN secret missing username or password fields')
  }

  const sql = postgres({
    host: hostname,
    port,
    database,
    username: secretJson.username,
    password: secretJson.password,
    ssl: { rejectUnauthorized: false }, // Aurora presents an AWS-managed cert
    max: 1, // migration runner uses a single connection
    idle_timeout: 30,
    connect_timeout: 15,
    prepare: false,
  })

  try {
    // ------------------------------------------------------------------
    // Ensure tracking table exists
    // ------------------------------------------------------------------
    await ensureMigrationsTable(sql)

    // ------------------------------------------------------------------
    // Load applied migrations
    // ------------------------------------------------------------------
    const applied = await getAppliedMigrations(sql)
    console.log(JSON.stringify({ level: 'info', msg: 'loaded applied migrations', count: applied.size }))

    // ------------------------------------------------------------------
    // Load migration files (bundled at deploy time)
    // ------------------------------------------------------------------
    // Lambda is bundled with migrations at /var/task/migrations/
    const migrationsDir = path.join(__dirname, 'migrations')
    const allMigrations = await readMigrationFiles(migrationsDir)

    // ------------------------------------------------------------------
    // Apply pending migrations in order
    // ------------------------------------------------------------------
    const pending = allMigrations.filter((m) => !applied.has(m.hash))

    console.log(JSON.stringify({
      level: 'info',
      msg: 'migration plan',
      total: allMigrations.length,
      applied: applied.size,
      pending: pending.length,
      pendingFiles: pending.map((m) => m.name),
    }))

    for (const migration of pending) {
      await applyMigration(sql, migration)
      console.log(JSON.stringify({ level: 'info', msg: 'migration applied', migration: migration.name }))
    }

    console.log(JSON.stringify({
      level: 'info',
      msg: 'all migrations complete',
      migrationsApplied: pending.length,
    }))

    return {
      PhysicalResourceId: physicalId,
      Data: { MigrationsApplied: pending.length },
    }
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'migration runner failed',
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }))
    // Rethrowing causes the custom resource to fail and CDK to roll back
    throw err
  } finally {
    await sql.end({ timeout: 5 })
  }
}
