#!/usr/bin/env node
/**
 * apply-migration-0048.mjs — One-shot patcher for migration 0048.
 *
 * [Engineer-Principal · Opus · run-story-pr-pipeline]
 *
 * Applies 0048_story_pr_runs.sql to the live Aurora cluster via RDS Proxy
 * IAM auth. The SQL is additive and idempotent (CREATE TABLE IF NOT EXISTS,
 * ADD COLUMN IF NOT EXISTS), so this is safe to re-run.
 *
 * The next CDK deploy of the migration-runner Lambda will see the same
 * journal row and skip 0048 — no double-apply.
 *
 * Usage:
 *   AWS_PROFILE=… node scripts/apply-migration-0048.mjs
 *
 * Env (defaulted to the orbital-mwitt cluster):
 *   RDS_PROXY_HOSTNAME, RDS_PROXY_PORT, AURORA_DB_NAME, AURORA_USERNAME, AWS_REGION
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

const sqlPath = path.resolve(__dirname, '../packages/db/src/migrations/0048_story_pr_runs.sql')

async function main() {
  console.log(`[migrate-0048] target ${username}@${hostname}:${port}/${database}`)
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
  const tag = '0048_story_pr_runs'

  try {
    console.log('[migrate-0048] applying CREATE TABLE / ADD COLUMN...')
    await sql.unsafe(sqlText)
    console.log('[migrate-0048] DDL complete')

    try {
      const exists = await sql`
        SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = ${hash} LIMIT 1
      `
      if (exists.length === 0) {
        await sql`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES (${hash}, ${Date.now()})
        `
        console.log('[migrate-0048] journal row inserted')
      } else {
        console.log('[migrate-0048] journal row already present')
      }
    } catch (err) {
      console.warn('[migrate-0048] journal insert skipped:', err.message)
    }

    // Verify the new table + column exist.
    const tbl = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_name = 'story_pr_runs'
    `
    if (tbl.length !== 1) {
      throw new Error('post-migration verification failed: story_pr_runs not found')
    }
    const col = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'stories' AND column_name = 'pr_url'
    `
    if (col.length !== 1) {
      throw new Error('post-migration verification failed: stories.pr_url not found')
    }
    console.log('[migrate-0048] verified: story_pr_runs + stories.pr_url exist')
    console.log(`[migrate-0048] DONE tag=${tag} hash=${hash.slice(0, 12)}`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error('[migrate-0048] FAILED:', err)
  process.exit(1)
})
