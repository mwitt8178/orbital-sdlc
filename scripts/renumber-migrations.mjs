#!/usr/bin/env node
// renumber-migrations.mjs
//
// Deterministically renumbers any migration files whose idx (or filename
// prefix) collides with — or precedes — the current last journal idx. Used
// during branch integration: a feature branch may have authored migration
// 0044_foo while another feature branch authored 0045_bar; once both land,
// we need a stable order.
//
// Strategy:
//   1. Read the current _journal.json. Determine `nextIdx = lastIdx + 1`.
//   2. Find all migration files in `packages/db/src/migrations/*.sql` that
//      are NOT registered in the journal AND are NOT in KNOWN_ORPHANS.
//   3. Sort the unregistered set by (existing-prefix-asc, filename-asc) so
//      ties resolve deterministically.
//   4. For each unregistered migration, assign idx = nextIdx++; rename the
//      file to `<NNNN>_<slug>.sql` where NNNN = idx + 1, padded to 4.
//   5. Append a journal entry { idx, version: '7', when: nowMs, tag,
//      breakpoints: true }. `when` is monotonic: max(prev when + 1, nowMs).
//   6. Write _journal.json. Print a summary.
//
// Idempotent: if there are no unregistered migrations, exits 0 with no
// changes.
//
// Used by:
//   - scripts/integrate-branch.sh (during rebase conflict resolution)
//   - manually after introducing a new migration during dev

import { readFileSync, writeFileSync, readdirSync, renameSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const migrationsDir = resolve(repoRoot, 'packages/db/src/migrations')
const journalPath = resolve(migrationsDir, 'meta/_journal.json')

const KNOWN_ORPHANS = new Set([
  '0038_drop_sample_data_flow',
  '0038_worker_runs',
  '0039_github_app',
  '0040_planning_runs',
])

const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
const registered = new Map(journal.entries.map((e) => [e.tag, e]))
const lastIdx = journal.entries.at(-1)?.idx ?? -1
const lastWhen = journal.entries.at(-1)?.when ?? 0

const allSql = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort() // deterministic: sort by filename ascending

const unregistered = []
for (const f of allSql) {
  const tag = f.replace(/\.sql$/, '')
  if (registered.has(tag) || KNOWN_ORPHANS.has(tag)) continue
  unregistered.push({ file: f, tag })
}

if (unregistered.length === 0) {
  console.log('[renumber-migrations] No unregistered migrations. Nothing to do.')
  process.exit(0)
}

console.log(`[renumber-migrations] Found ${unregistered.length} unregistered migration(s):`)
for (const u of unregistered) console.log(`  - ${u.file}`)

let nextIdx = lastIdx + 1
let nextWhen = Math.max(lastWhen + 1, Date.now())
const newEntries = []
const renames = []

for (const u of unregistered) {
  const idx = nextIdx++
  const prefix = String(idx + 1).padStart(4, '0')
  // Strip the existing NNNN_ prefix if present and reapply ours.
  const slug = u.tag.replace(/^\d{4}_/, '')
  const newTag = `${prefix}_${slug}`
  const newFile = `${newTag}.sql`
  if (newFile !== u.file) {
    renames.push({ from: u.file, to: newFile, oldTag: u.tag, newTag })
  }
  newEntries.push({
    idx,
    version: '7',
    when: nextWhen++,
    tag: newTag,
    breakpoints: true,
  })
}

// Apply renames first
for (const r of renames) {
  const fromPath = resolve(migrationsDir, r.from)
  const toPath = resolve(migrationsDir, r.to)
  if (existsSync(toPath)) {
    console.error(`[renumber-migrations] FAIL: rename target already exists: ${toPath}`)
    process.exit(1)
  }
  renameSync(fromPath, toPath)
  console.log(`[renumber-migrations] renamed ${r.from} -> ${r.to}`)
}

// Append journal entries
journal.entries.push(...newEntries)
writeFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n')

console.log(`[renumber-migrations] Appended ${newEntries.length} journal entries.`)
console.log(`[renumber-migrations] New idx range: ${newEntries[0].idx}..${newEntries.at(-1).idx}`)
