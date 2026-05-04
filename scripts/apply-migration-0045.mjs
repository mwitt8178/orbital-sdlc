#!/usr/bin/env node
/**
 * apply-migration-0045.mjs — One-shot patcher for migration 0045.
 *
 * [Engineer-Principal · Opus · run-settings-billing]
 *
 * Adds monthly_cap_usd, hard_stop, digest_emails to cost_budgets.
 * Idempotent (ADD COLUMN IF NOT EXISTS).
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

const sqlPath = path.resolve(__dirname, '../packages/db/src/migrations/0045_cost_budgets_monthly.sql')
const tag = '0045_cost_budgets_monthly'

async function main() {
  console.log(`[migrate-0045] target ${username}@${hostname}:${port}/${database}`)
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

  try {
    console.log('[migrate-0045] applying ALTER TABLE...')
    await sql.unsafe(sqlText)
    console.log('[migrate-0045] ALTER TABLE complete')

    try {
      const exists = await sql`
        SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = ${hash} LIMIT 1
      `
      if (exists.length === 0) {
        await sql`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES (${hash}, ${Date.now()})
        `
        console.log('[migrate-0045] journal row inserted')
      } else {
        console.log('[migrate-0045] journal row already present')
      }
    } catch (err) {
      console.warn('[migrate-0045] journal insert skipped:', err.message)
    }

    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'cost_budgets'
        AND column_name IN ('monthly_cap_usd', 'hard_stop', 'digest_emails')
      ORDER BY column_name
    `
    if (cols.length === 3) {
      console.log('[migrate-0045] verified: monthly_cap_usd, hard_stop, digest_emails present on cost_budgets')
    } else {
      throw new Error(`post-migration verification failed: only ${cols.length}/3 columns present`)
    }
    console.log(`[migrate-0045] DONE tag=${tag} hash=${hash.slice(0, 12)}`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error('[migrate-0045] FAILED:', err)
  process.exit(1)
})
