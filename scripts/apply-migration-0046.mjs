#!/usr/bin/env node
/**
 * apply-migration-0046.mjs — One-shot patcher for migration 0046.
 *
 * [Engineer-Principal · Opus · run-settings-general]
 *
 * Applies 0046_projects_color_deleted.sql directly via RDS Proxy IAM auth.
 * Idempotent (ADD COLUMN IF NOT EXISTS).
 *
 * Usage: node scripts/apply-migration-0046.mjs
 */

import { Signer } from '@aws-sdk/rds-signer'
import postgres from 'postgres'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const region = process.env.AWS_REGION || 'us-east-1'
const hostname =
  process.env.RDS_PROXY_HOSTNAME ||
  'orbital-mwitt-proxy.proxy-cc7iwqk0u99p.us-east-1.rds.amazonaws.com'
const port = Number(process.env.RDS_PROXY_PORT || 5432)
const database = process.env.AURORA_DB_NAME || 'orbital_hub'
const username = process.env.AURORA_USERNAME || 'orbital_admin'

const sqlPath = path.resolve(__dirname, '../packages/db/src/migrations/0046_projects_color_deleted.sql')

async function main() {
  console.log(`[migrate-0046] target ${username}@${hostname}:${port}/${database}`)
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
  const tag = '0046_projects_color_deleted'

  try {
    console.log('[migrate-0046] applying ALTER TABLE projects ...')
    await sql.unsafe(sqlText)
    console.log('[migrate-0046] DDL complete')

    try {
      const exists = await sql`
        SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = ${hash} LIMIT 1
      `
      if (exists.length === 0) {
        await sql`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES (${hash}, ${Date.now()})
        `
        console.log('[migrate-0046] journal row inserted')
      } else {
        console.log('[migrate-0046] journal row already present')
      }
    } catch (err) {
      console.warn('[migrate-0046] journal insert skipped:', err.message)
    }

    const cols = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'projects'
        AND column_name IN ('color', 'deleted_at', 'deleted_by_event_id')
      ORDER BY column_name
    `
    const got = cols.map((r) => r.column_name)
    const want = ['color', 'deleted_at', 'deleted_by_event_id']
    for (const c of want) {
      if (!got.includes(c)) throw new Error(`post-migration verification failed: projects.${c} missing`)
    }
    console.log(`[migrate-0046] verified columns: ${got.join(', ')}`)
    console.log(`[migrate-0046] DONE tag=${tag} hash=${hash.slice(0, 12)}`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error('[migrate-0046] FAILED:', err)
  process.exit(1)
})
