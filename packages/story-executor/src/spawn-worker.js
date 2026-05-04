/**
 * spawn-worker.js — drive a Claude worker under hard caps.
 *
 * Caps enforced:
 *   - $25 USD (delegated to BudgetTracker; SIGTERM on cap)
 *   - Wall-clock timeout (default 15 min) — SIGTERM, then SIGKILL after 10s
 *   - 3-strike test failure -> caller cancels the story
 *
 * Three modes:
 *   - real-sdk: in-process Anthropic SDK loop via claude-client.js. Persona-tiered
 *               model. This is the production path inside the daemon.
 *   - fake:     invokes ./fake-claude.js, used for unit tests that exercise the
 *               child-process plumbing, budget kill, and timeout walks.
 *   - real:     legacy CLI shell-out (kept as fallback only when CLAUDE_BIN is set
 *               and ANTHROPIC_USE_CLI=1; otherwise rejected).
 *
 * Stream-json contract — each line is JSON with optional `usage` / `cost_usd`.
 * The SDK loop and the fake worker both emit this shape so the cost/token
 * aggregation is identical for both.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { runClaudeLoop } from './claude-client.js'
import { getAnthropicApiKey } from './secrets.js'

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
    mode = defaultMode(),
    wallClockMs = DEFAULT_WALL_CLOCK_MS,
    fakeBehaviour = {},
    onEvent = () => {},
    persona = 'engineer-sr',
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
    onTurnUsage,
    apiKey,
  } = opts

  if (mode === 'real-sdk') {
    return runRealSdk({
      prompt,
      cwd,
      budget,
      wallClockMs,
      onEvent,
      persona,
      systemPrompt,
      onTurnUsage,
      apiKey,
    })
  }

  let child
  if (mode === 'real') {
    if (process.env.ANTHROPIC_USE_CLI !== '1') {
      throw new Error(
        "spawn-worker mode='real' (CLI shell-out) is disabled. Use mode='real-sdk' or set ANTHROPIC_USE_CLI=1.",
      )
    }
    // Legacy Claude Code CLI path — strip CLAUDECODE marker so the child can boot.
    const env = { ...process.env }
    delete env.CLAUDECODE
    delete env.CLAUDE_CODE_ENTRYPOINT
    const bin = process.env.CLAUDE_BIN ?? '/opt/homebrew/bin/claude'
    child = spawn(
      bin,
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

// ---------------------------------------------------------------------------
// real-sdk — in-process Anthropic SDK loop
// ---------------------------------------------------------------------------

export const DEFAULT_SYSTEM_PROMPT =
  'You are an Orbital story-executor worker. You operate inside a sandboxed git ' +
  'worktree. Use the file_read, file_write, and bash tools to implement the user ' +
  "request end-to-end. Run the project's tests with bash before declaring done. " +
  'Reply with end_turn only when the implementation and tests are complete.'

export function defaultMode() {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY_SECRET_ID) {
    return 'real-sdk'
  }
  return 'fake'
}

async function runRealSdk({
  prompt,
  cwd,
  budget,
  wallClockMs,
  onEvent,
  persona,
  systemPrompt,
  onTurnUsage,
  apiKey,
}) {
  const resolvedKey = apiKey ?? (await getAnthropicApiKey())
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), wallClockMs)
  let killedReason = null
  let stdout = ''

  const emit = (line) => {
    const s = JSON.stringify(line)
    stdout += s + '\n'
    // Mirror to the daemon stdout so awslogs picks it up.
    process.stdout.write(s + '\n')
    try {
      onEvent(line)
    } catch {
      /* ignore */
    }
  }

  try {
    const result = await runClaudeLoop({
      apiKey: resolvedKey,
      persona,
      systemPrompt,
      userPrompt: prompt,
      worktreeRoot: cwd,
      budget,
      signal: controller.signal,
      emit,
      onTurnUsage,
    })
    killedReason = result.killedReason
    if (controller.signal.aborted && !killedReason) killedReason = 'timeout'
    return {
      exitCode: killedReason ? (killedReason === 'budget' ? 137 : 124) : 0,
      killedReason,
      pid: process.pid,
      totalCostCents: result.totalCostCents,
      promptTokens: result.promptTokens,
      outputTokens: result.outputTokens,
      stdout,
      stderr: '',
    }
  } catch (err) {
    return {
      exitCode: 1,
      killedReason,
      pid: process.pid,
      totalCostCents: 0,
      promptTokens: 0,
      outputTokens: 0,
      stdout,
      stderr: String(err?.stack ?? err?.message ?? err),
    }
  } finally {
    clearTimeout(timer)
  }
}
