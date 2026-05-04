#!/usr/bin/env node
/**
 * apply-migration-0040.mjs — One-shot patcher for migration 0041.
 *
 * [Engineer-Principal · Opus · run-orbital-review-ui]
 *
 * The CDK-bundled migration-runner Lambda only sees migrations baked into its
 * code asset at deploy time, so a freshly-added 0040 won't be applied until
 * the next `cdk deploy`. This script runs the (small, additive, idempotent)
 * SQL directly via RDS Proxy IAM auth.
 *
 * Idempotency:
 *   - The SQL itself uses ADD COLUMN IF NOT EXISTS.
 *   - We also insert a row into drizzle.__drizzle_migrations matching the
 *     drizzle journal entry, so the next regular CDK migration-runner run
 *     will skip 0040.
 *
 * Usage:
 *   node scripts/apply-migration-0040.mjs
 *
 * Env (taken from the migration-runner Lambda config):
 *   RDS_PROXY_HOSTNAME, RDS_PROXY_PORT, AURORA_DB_NAME, AURORA_USERNAME
 *   AWS_REGION (default us-east-1)
 */

import { Signer } from '@aws-sdk/rds-signer'
import postgres from 'postgres'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const region = process.env.AWS_REGION || 'us-east-1'
const hostname = process.env.RDS_PROXY_HOSTNAME ||
  'orbital-mwitt-proxy.proxy-cc7iwqk0u99p.us-east-1.rds.amazonaws.com'
const port = Number(process.env.RDS_PROXY_PORT || 5432)
const database = process.env.AURORA_DB_NAME || 'orbital_hub'
const username = process.env.AURORA_USERNAME || 'orbital_admin'

const sqlPath = path.resolve(__dirname, '../packages/db/src/migrations/0041_redirect_note.sql')

async function main() {
  console.log(`[migrate-0040] target ${username}@${hostname}:${port}/${database}`)
  const signer = new Signer({ hostname, port, username, region })
  const token = await signer.getAuthToken()

  const sql = postgres({
    host: hostname,
    port,
    database,
    username,
    password: token,
    ssl: { rejectUnauthorized: false },
    max: 1,
    idle_timeout: 5,
    connect_timeout: 30,
  })

  const sqlText = await fs.readFile(sqlPath, 'utf8')
  const hash = crypto.createHash('sha256').update(sqlText).digest('hex')
  const tag = '0041_redirect_note'

  try {
    // Apply the SQL — additive, idempotent.
    console.log('[migrate-0040] applying ALTER TABLE...')
    await sql.unsafe(sqlText)
    console.log('[migrate-0040] ALTER TABLE complete')

    // Record in drizzle journal so the migration-runner won't try to re-apply.
    // (It's already idempotent thanks to IF NOT EXISTS, but this keeps the
    //  journal honest.)
    try {
      const exists = await sql`
        SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = ${hash} LIMIT 1
      `
      if (exists.length === 0) {
        await sql`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES (${hash}, ${Date.now()})
        `
        console.log('[migrate-0040] journal row inserted')
      } else {
        console.log('[migrate-0040] journal row already present')
      }
    } catch (err) {
      console.warn('[migrate-0040] journal insert skipped (table may not exist yet):', err.message)
    }

    // Verify the column exists
    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'stories' AND column_name = 'redirect_note'
    `
    if (cols.length === 1) {
      console.log('[migrate-0040] verified: stories.redirect_note exists')
    } else {
      throw new Error('post-migration verification failed: stories.redirect_note not found')
    }
    console.log(`[migrate-0040] DONE tag=${tag} hash=${hash.slice(0, 12)}`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error('[migrate-0040] FAILED:', err)
  process.exit(1)
})
