#!/usr/bin/env node
// Rebuild _journal.json from .sql files on disk after a union merge.
// Preserves "when" timestamps for existing entries; fills in synthetic
// monotonic timestamps for new ones.
import fs from 'node:fs'
import path from 'node:path'

const MIG_DIR = path.resolve('packages/db/src/migrations')
const JOURNAL = path.join(MIG_DIR, 'meta/_journal.json')

const sqlFiles = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort()

// Read existing journal (may be corrupt from union merge — recover what we can)
let prevWhen = new Map()
try {
  const txt = fs.readFileSync(JOURNAL, 'utf8')
  const matches = [...txt.matchAll(/"when":\s*(\d+),\s*"tag":\s*"([^"]+)"/g)]
  for (const m of matches) {
    if (!prevWhen.has(m[2])) prevWhen.set(m[2], parseInt(m[1], 10))
  }
} catch (e) {
  console.error('Could not parse existing journal; rebuilding from scratch')
}

// Detect duplicate tags (e.g. 0038_drop_sample_data_flow + 0038_worker_runs).
// These are pre-existing — keep them but in disk-sort order.
const entries = []
let lastWhen = 1746072000000 // 2025-04-30 baseline
sqlFiles.forEach((f, idx) => {
  const tag = f.replace(/\.sql$/, '')
  let when = prevWhen.get(tag)
  if (!when || when <= lastWhen) {
    when = lastWhen + 1000
  }
  lastWhen = when
  entries.push({ idx, version: '7', when, tag, breakpoints: true })
})

const out = { version: '7', dialect: 'postgresql', entries }
fs.writeFileSync(JOURNAL, JSON.stringify(out, null, 2) + '\n')
console.log(`Rebuilt journal with ${entries.length} entries`)
