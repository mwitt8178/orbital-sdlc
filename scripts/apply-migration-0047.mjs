#!/usr/bin/env node
/**
 * apply-migration-0047.mjs — One-shot patcher for migration 0047_project_personas.
 *
 * [Engineer-Principal · Opus · run-settings-agents]
 *
 * Same pattern as apply-migration-0041.mjs. The CDK-bundled migration-runner
 * only sees migrations baked into its asset at deploy time, so a freshly
 * added migration won't be applied until the next `cdk deploy`. This script
 * runs the (additive, idempotent) SQL directly via RDS Proxy IAM auth.
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

const sqlPath = path.resolve(__dirname, '../packages/db/src/migrations/0047_project_personas.sql')

async function main() {
  console.log(`[migrate-0047] target ${username}@${hostname}:${port}/${database}`)
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
  const tag = '0047_project_personas'

  try {
    console.log('[migrate-0047] applying CREATE TABLE...')
    await sql.unsafe(sqlText)
    console.log('[migrate-0047] CREATE TABLE complete')

    try {
      const exists = await sql`
        SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = ${hash} LIMIT 1
      `
      if (exists.length === 0) {
        await sql`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES (${hash}, ${Date.now()})
        `
        console.log('[migrate-0047] journal row inserted')
      } else {
        console.log('[migrate-0047] journal row already present')
      }
    } catch (err) {
      console.warn('[migrate-0047] journal insert skipped:', err.message)
    }

    const tbl = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'project_personas'
    `
    if (tbl.length === 1) {
      console.log('[migrate-0047] verified: project_personas exists')
    } else {
      throw new Error('post-migration verification failed: project_personas not found')
    }
    console.log(`[migrate-0047] DONE tag=${tag} hash=${hash.slice(0, 12)}`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error('[migrate-0047] FAILED:', err)
  process.exit(1)
})
