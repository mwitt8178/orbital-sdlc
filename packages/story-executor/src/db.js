/**
 * db.js — thin Postgres wrapper for the story executor.
 *
 * Connects to a local Postgres (the verification stand-in for live DSQL).
 * Owns: worker_runs CRUD + tiny in-memory story/event/channel registry
 * persisted to a JSONL audit file (since prior orbital migrations were not
 * applied — only 0038_worker_runs is live in this DB).
 */

import pg from 'pg'
import { ulid } from 'ulid'
import fs from 'node:fs/promises'
import path from 'node:path'

const { Pool } = pg

const DEFAULT_URL =
  process.env.DATABASE_URL ?? 'postgres://orbital:orbital_dev_password@localhost:5432/orbital'

let pool = null

export function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: DEFAULT_URL, max: 5 })
  }
  return pool
}

export async function closePool() {
  if (pool) {
    await pool.end()
    pool = null
  }
}

// ---------------------------------------------------------------------------
// worker_runs CRUD — REAL DB writes against migration 0038
// ---------------------------------------------------------------------------

/**
 * Insert a fresh worker_runs row in 'spawning' state.
 * Returns the run_id (UUIDv7-ish via ulid in lowercase hex form).
 */
export async function insertWorkerRun({ storyId, attempt }) {
  const runId = ulidToUuid(ulid())
  const sql = `
    INSERT INTO worker_runs (run_id, story_id, attempt, status, started_at)
    VALUES ($1, $2, $3, 'spawning', now())
    RETURNING run_id, started_at
  `
  const { rows } = await getPool().query(sql, [runId, storyId, attempt])
  return { runId: rows[0].run_id, startedAt: rows[0].started_at }
}

export async function updateWorkerRun(runId, patch) {
  const cols = []
  const vals = []
  let i = 1
  for (const [k, v] of Object.entries(patch)) {
    cols.push(`${k} = $${i++}`)
    vals.push(v)
  }
  if (cols.length === 0) return
  vals.push(runId)
  const sql = `UPDATE worker_runs SET ${cols.join(', ')} WHERE run_id = $${i}`
  await getPool().query(sql, vals)
}

export async function listWorkerRuns(storyId) {
  const { rows } = await getPool().query(
    `SELECT run_id, attempt, status, started_at, ended_at, branch, pr_url,
            cost_usd_cents, prompt_tokens, output_tokens, exit_code, failure_reason
     FROM worker_runs
     WHERE story_id = $1
     ORDER BY started_at ASC`,
    [storyId],
  )
  return rows
}

// ---------------------------------------------------------------------------
// JSONL audit log — stand-in for stories/channel_posts/audit.events writes
// (those tables require migrations 0001/0007/0010 which the user did not
// authorize applying to this DB).
// ---------------------------------------------------------------------------

const AUDIT_DIR = path.resolve(
  new URL('.', import.meta.url).pathname,
  '..',
  'audit',
)

export async function ensureAuditDir() {
  await fs.mkdir(AUDIT_DIR, { recursive: true })
}

export async function writeAuditLine(kind, payload) {
  await ensureAuditDir()
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      kind,
      ...payload,
    }) + '\n'
  await fs.appendFile(path.join(AUDIT_DIR, 'audit.jsonl'), line, 'utf8')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Crockford-base32 ULID -> RFC 4122 UUID (preserving 128 bits).
 * Postgres uuid columns require the 8-4-4-4-12 hex shape.
 */
function ulidToUuid(u) {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const map = new Map([...ALPHABET].map((c, i) => [c, i]))
  let bigint = 0n
  for (const ch of u.toUpperCase()) {
    const v = map.get(ch)
    if (v === undefined) throw new Error(`bad ulid char: ${ch}`)
    bigint = (bigint << 5n) | BigInt(v)
  }
  // ulid is 130 bits encoded; UUID expects 128. Drop top 2 bits.
  bigint = bigint & ((1n << 128n) - 1n)
  const hex = bigint.toString(16).padStart(32, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export { ulidToUuid }
