#!/usr/bin/env node
// check-journal-monotonic.mjs
//
// Validates packages/db/src/migrations/meta/_journal.json:
//   1. idx values are strictly increasing (gaps allowed — the historical
//      journal has a gap at idx=37..39 caused by an earlier delete; we
//      preserve it to stay in lock-step with the live DB).
//   2. Each entry's `tag` matches a real file packages/db/src/migrations/<tag>.sql.
//   3. No two entries share the same idx or tag.
//   4. The numeric prefix on each tag (NNNN_) matches its idx + 1 — i.e.
//      idx=0 -> 0001_*, idx=43 -> 0044_*.
//   5. Every *.sql file in the migrations dir has a matching journal entry.
//
// Used by pr-check.yml and migrations.yml. Exits non-zero on any violation.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const migrationsDir = resolve(repoRoot, 'packages/db/src/migrations')
const journalPath = resolve(migrationsDir, 'meta/_journal.json')

function fail(msg) {
  console.error(`[check-journal-monotonic] FAIL: ${msg}`)
  process.exit(1)
}

if (!existsSync(journalPath)) fail(`journal not found at ${journalPath}`)

const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
if (!Array.isArray(journal.entries)) fail('journal.entries is not an array')

const entries = journal.entries
const seenIdx = new Set()
const seenTag = new Set()
let prevIdx = -1

for (let i = 0; i < entries.length; i++) {
  const e = entries[i]
  if (typeof e.idx !== 'number') fail(`entry ${i} missing numeric idx`)
  if (e.idx <= prevIdx) fail(`entry ${i} idx=${e.idx} not strictly greater than previous ${prevIdx}`)
  prevIdx = e.idx
  if (seenIdx.has(e.idx)) fail(`duplicate idx ${e.idx}`)
  if (seenTag.has(e.tag)) fail(`duplicate tag ${e.tag}`)
  seenIdx.add(e.idx)
  seenTag.add(e.tag)

  const expectedPrefix = String(e.idx + 1).padStart(4, '0')
  if (!e.tag.startsWith(expectedPrefix + '_')) {
    fail(`entry idx=${e.idx} tag="${e.tag}" — expected prefix "${expectedPrefix}_"`)
  }

  const sqlPath = resolve(migrationsDir, `${e.tag}.sql`)
  if (!existsSync(sqlPath)) fail(`migration file missing for tag ${e.tag}: ${sqlPath}`)
}

// Every NNNN_*.sql file in the dir SHOULD be in the journal. Known orphans
// from pre-pipeline history are tolerated but logged. Any new orphan
// introduced by a PR will be caught by the structural-check stage of the
// PR build (it diffs against the base branch).
// These migrations exist as .sql files in the repo but are not in the
// in-repo _journal.json. Cause: pre-pipeline ad-hoc applies that updated
// the live DB without updating the repo journal. Live DB has them.
// We tolerate them here so the validator can still gate FUTURE PRs without
// requiring an immediate journal repair (which would risk re-applying
// migrations on top of an already-migrated production-like env).
//
// TODO(release-pipeline-cutover): backfill these into _journal.json with a
// dedicated PR + a one-shot Lambda invocation that records them in the
// drizzle migrations history table without re-applying SQL.
const KNOWN_ORPHANS = new Set([
  '0038_drop_sample_data_flow',
  '0038_worker_runs',
  '0039_github_app',
  '0040_planning_runs',
])
const allSql = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'))
const orphans = []
for (const f of allSql) {
  const tag = f.replace(/\.sql$/, '')
  if (!seenTag.has(tag)) {
    if (KNOWN_ORPHANS.has(tag)) {
      console.warn(`[check-journal-monotonic] WARN: known orphan migration on disk: ${f}`)
      orphans.push(tag)
    } else {
      fail(`migration file ${f} is not registered in journal (and not a known orphan)`)
    }
  }
}

console.log(
  `[check-journal-monotonic] OK — ${entries.length} entries, idx range 0..${entries.at(-1).idx}, last tag ${entries.at(-1).tag}`,
)
