#!/usr/bin/env node
/**
 * fake-claude.js — DEPRECATED. Retained ONLY for the local dev verify-loop
 * harness in scripts/verify-loop.js (failure-mode walks: budget kill, hang,
 * tests_fail). The production path uses claude-client.js with the real
 * Anthropic SDK; spawn-worker default mode is 'real-sdk'. This file MUST
 * NOT be invoked by production code paths.
 *
 * fake-claude.js — deterministic test surrogate for the Claude CLI.
 *
 * Emits Claude-stream-json-shaped lines on stdout. Behaviour controlled by
 * a JSON arg:
 *   {
 *     mode: 'success' | 'tests_fail' | 'budget_explode' | 'hang',
 *     filesToWrite: [{ path, contents }],
 *     costPerChunkUsd: number  (default 0.10)
 *     chunks: number           (default 5)
 *     hangMs: number           (for mode='hang', default 30000)
 *   }
 *
 * For 'success': writes the requested files, prints success line.
 * For 'tests_fail': writes a file whose tests intentionally fail.
 * For 'budget_explode': emits one huge cost_usd line so BudgetTracker kills it.
 * For 'hang': writes nothing and sleeps so wall-clock timeout fires.
 *
 * Costs are emitted via cost_usd lines so spawn-worker.js can track them.
 *
 * IMPORTANT: this file is real code that runs as a child process. It is the
 * verification surrogate for the Anthropic call when ANTHROPIC_API_KEY is
 * unavailable. The subprocess plumbing, SIGTERM behaviour, budget kill, and
 * timeout walks are real — only the LLM is faked.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

const argRaw = process.argv[2] ?? '{}'
const cfg = JSON.parse(argRaw)
const mode = cfg.mode ?? 'success'
const filesToWrite = cfg.filesToWrite ?? []
const costPerChunkUsd = cfg.costPerChunkUsd ?? 0.10
const chunks = cfg.chunks ?? 5
const hangMs = cfg.hangMs ?? 30_000

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

let _terminating = false
process.on('SIGTERM', () => {
  _terminating = true
  emit({ type: 'system', subtype: 'sigterm_received' })
  setTimeout(() => process.exit(143), 50)
})

async function main() {
  emit({ type: 'system', subtype: 'init', model: 'fake-claude-1' })

  if (mode === 'hang') {
    emit({ type: 'assistant', text: 'thinking…' })
    await sleep(hangMs)
    emit({ type: 'result', subtype: 'success' })
    return
  }

  if (mode === 'budget_explode') {
    emit({ type: 'assistant', text: 'expensive thinking', cost_usd: 999.99, usage: { input_tokens: 5000, output_tokens: 5000 } })
    // Give parent a tick to react and SIGTERM us.
    await sleep(2000)
    emit({ type: 'result', subtype: 'success' })
    return
  }

  // success / tests_fail share the streaming + file-write skeleton.
  for (let i = 0; i < chunks; i++) {
    if (_terminating) return
    emit({
      type: 'assistant',
      text: `chunk ${i + 1}/${chunks}`,
      cost_usd: costPerChunkUsd,
      usage: { input_tokens: 100, output_tokens: 50 },
    })
    await sleep(150)
  }

  for (const f of filesToWrite) {
    if (_terminating) return
    const abs = path.resolve(process.cwd(), f.path)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, f.contents, 'utf8')
    emit({ type: 'tool_use', name: 'write', path: f.path })
  }

  if (mode === 'tests_fail') {
    // Overwrite the test file with a deliberately-failing version.
    const failPath = path.resolve(process.cwd(), 'src/widget.test.js')
    await fs.mkdir(path.dirname(failPath), { recursive: true })
    await fs.writeFile(
      failPath,
      "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\ntest('intentional fail', () => { assert.equal(1, 2) })\n",
      'utf8',
    )
    emit({ type: 'tool_use', name: 'write', path: 'src/widget.test.js' })
  }

  emit({ type: 'result', subtype: 'success', total_cost_usd: costPerChunkUsd * chunks })
}

main().catch((err) => {
  process.stderr.write(String(err.stack ?? err) + '\n')
  process.exit(1)
})
