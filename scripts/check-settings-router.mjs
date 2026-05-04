#!/usr/bin/env node
// check-settings-router.mjs
//
// Structural lint for packages/ui/src/pages/Settings.tsx. Fails the build if
// any of the 6 canonical settings tab routes are removed.
//
// Backstops the Settings.tsx 6-way merge from the cutover. Once the live
// Settings.tsx renders all 6 tabs, this check ensures no future PR can
// silently drop one.

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const settingsPath = resolve(repoRoot, 'packages/ui/src/pages/Settings.tsx')

const REQUIRED_ROUTES = ['general', 'integrations', 'agents', 'sprints', 'team', 'billing']

if (!existsSync(settingsPath)) {
  console.error(`[check-settings-router] FAIL: ${settingsPath} not found`)
  process.exit(1)
}

const src = readFileSync(settingsPath, 'utf8')

const missing = []
for (const route of REQUIRED_ROUTES) {
  // Match either path="general" or path="general/*"
  const re = new RegExp(`path=["']${route}(/\\*)?["']`)
  if (!re.test(src)) missing.push(route)
}

if (missing.length > 0) {
  console.error(`[check-settings-router] FAIL: Settings.tsx is missing routes: ${missing.join(', ')}`)
  console.error('All 6 settings tabs (general, integrations, agents, sprints, team, billing) must be present.')
  process.exit(1)
}

console.log(`[check-settings-router] OK — all 6 settings routes present.`)
