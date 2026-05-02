#!/usr/bin/env node
/* global process */
/**
 * scripts/copy-skill-assets.mjs
 *
 * Post-tsc-build step. Copies non-TS assets the skill-loader expects at
 * runtime into the orchestrator's dist/ tree so production deployments
 * work without the src/ tree present.
 *
 * Currently copies:
 *   src/personas/skills/*.md  ->  dist/personas/skills/*.md
 *
 * Idempotent: re-running is safe; existing files are overwritten.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const COPIES = [
  {
    from: path.join(repoRoot, 'packages/orchestrator/src/personas/skills'),
    to: path.join(repoRoot, 'packages/orchestrator/dist/personas/skills'),
    glob: /\.md$/,
  },
]

async function copyDir(from, to, predicate) {
  await fs.mkdir(to, { recursive: true })
  const entries = await fs.readdir(from, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (predicate && !predicate.test(entry.name)) continue
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    await fs.copyFile(src, dst)
  }
}

async function main() {
  for (const c of COPIES) {
    try {
      await fs.access(c.from)
    } catch {
      // Source dir missing — nothing to copy.
      continue
    }
    await copyDir(c.from, c.to, c.glob)
  }
}

main().catch((e) => {
  process.stderr.write(`copy-skill-assets failed: ${e?.message ?? e}\n`)
  process.exit(1)
})
