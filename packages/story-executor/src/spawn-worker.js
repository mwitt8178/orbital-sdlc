/**
 * spawn-worker.js — spawn a Claude Code child process under hard caps.
 *
 * Caps enforced:
 *   - $25 USD (delegated to BudgetTracker; SIGTERM on cap)
 *   - Wall-clock timeout (default 15 min) — SIGTERM, then SIGKILL after 10s
 *   - 3-strike test failure -> caller cancels the story
 *
 * Two modes:
 *   - real: invokes /opt/homebrew/bin/claude with --output-format stream-json
 *   - fake: invokes ./fake-claude.js, used for failure-mode walks and
 *           verification when ANTHROPIC_API_KEY is unset.
 *
 * Stream-json contract — each line is JSON with optional `usage` / `cost_usd`.
 * The fake worker emits the same shape so this code is identical for both.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const SIGTERM_GRACE_MS = 10_000
export const DEFAULT_WALL_CLOCK_MS = 15 * 60 * 1000

/**
 * Run a worker child to completion or termination.
 *
 * @param {object} opts
 * @param {string} opts.prompt        — prompt to feed the worker
 * @param {string} opts.cwd           — working dir for the child (sandbox)
 * @param {object} opts.budget        — BudgetTracker instance
 * @param {string} [opts.mode]        — 'real' | 'fake' (default: 'fake' if no ANTHROPIC_API_KEY)
 * @param {number} [opts.wallClockMs] — wall-clock cap (default 15 min)
 * @param {object} [opts.fakeBehaviour] — for fake worker: see fake-claude.js
 * @param {(evt:object)=>void} [opts.onEvent] — per-line stream callback
 *
 * @returns {Promise<{
 *   exitCode: number,
 *   killedReason: 'budget'|'timeout'|null,
 *   pid: number,
 *   totalCostCents: number,
 *   promptTokens: number,
 *   outputTokens: number,
 *   stdout: string,
 *   stderr: string,
 * }>}
 */
export async function spawnWorker(opts) {
  const {
    prompt,
    cwd,
    budget,
    mode = process.env.ANTHROPIC_API_KEY ? 'real' : 'fake',
    wallClockMs = DEFAULT_WALL_CLOCK_MS,
    fakeBehaviour = {},
    onEvent = () => {},
  } = opts

  let child
  if (mode === 'real') {
    // Real Claude Code CLI — strip CLAUDECODE marker so the child can boot.
    const env = { ...process.env }
    delete env.CLAUDECODE
    delete env.CLAUDE_CODE_ENTRYPOINT
    child = spawn(
      '/opt/homebrew/bin/claude',
      ['-p', prompt, '--output-format', 'stream-json', '--verbose'],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } else {
    child = spawn(
      process.execPath,
      [path.join(__dirname, 'fake-claude.js'), JSON.stringify(fakeBehaviour)],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
    )
  }

  const pid = child.pid ?? -1
  let stdout = ''
  let stderr = ''
  let totalCostCents = 0
  let promptTokens = 0
  let outputTokens = 0
  let killedReason = null
  let stdoutBuf = ''

  // Wall-clock timeout
  const timeoutHandle = setTimeout(() => {
    if (child.exitCode === null) {
      killedReason = 'timeout'
      child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, SIGTERM_GRACE_MS)
    }
  }, wallClockMs)

  child.stdout.on('data', (chunk) => {
    const s = chunk.toString('utf8')
    stdout += s
    stdoutBuf += s
    let nl
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl)
      stdoutBuf = stdoutBuf.slice(nl + 1)
      if (!line.trim()) continue
      let evt
      try {
        evt = JSON.parse(line)
      } catch {
        continue
      }
      // Track cost / tokens.
      if (typeof evt.cost_usd === 'number') {
        const cents = Math.round(evt.cost_usd * 100)
        totalCostCents += cents
        if (!budget.add(cents)) {
          killedReason = killedReason ?? 'budget'
          child.kill('SIGTERM')
          setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL')
          }, SIGTERM_GRACE_MS)
        }
      } else if (typeof evt.cost_usd_cents === 'number') {
        totalCostCents += evt.cost_usd_cents
        if (!budget.add(evt.cost_usd_cents)) {
          killedReason = killedReason ?? 'budget'
          child.kill('SIGTERM')
          setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL')
          }, SIGTERM_GRACE_MS)
        }
      }
      if (evt.usage?.input_tokens) promptTokens += evt.usage.input_tokens
      if (evt.usage?.output_tokens) outputTokens += evt.usage.output_tokens
      onEvent(evt)
    }
  })

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })

  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      clearTimeout(timeoutHandle)
      resolve(code === null ? (signal === 'SIGKILL' ? 137 : 143) : code)
    })
  })

  return {
    exitCode,
    killedReason,
    pid,
    totalCostCents,
    promptTokens,
    outputTokens,
    stdout,
    stderr,
  }
}
