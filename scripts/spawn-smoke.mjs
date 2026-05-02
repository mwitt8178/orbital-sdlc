#!/usr/bin/env node
/* global process */
/**
 * scripts/spawn-smoke.mjs — `npm run spawn-smoke`
 *
 * End-to-end verification that the Claude Code worker spawn loop is closed:
 *   1. Provision a tiny test sprint with one trivial task.
 *   2. Stand up a fresh MCPGatewayServer + capability authority + persona
 *      loader against the local docker-compose Postgres.
 *   3. Spawn a worker via spawn() against either the real claude binary
 *      (when --real and ANTHROPIC_API_KEY is set) or a shell-script fake
 *      claude (default).
 *   4. Watch stdout/stderr through the WorkerOutputStream registry.
 *   5. Assert the worker created hello.txt in its worktree (proof of real
 *      I/O against the worktree filesystem).
 *   6. Print PASS / FAIL and exit accordingly.
 *
 * Flags:
 *   --real        Use the real `claude` binary (requires ANTHROPIC_API_KEY).
 *   --skip-cleanup  Leave the temp worktree on disk after run (debugging).
 *   --timeout=N   Override the wall-clock timeout in seconds (default 60).
 *
 * Exit codes:
 *   0   smoke run passed
 *   2   INTEGRATION_CLAUDE_NOT_FOUND (acceptable in dev mode without claude installed)
 *   1   any other failure
 */

import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

// Load .env so DATABASE_URL and friends are available — same pattern as
// vitest.setup.ts.
try {
  const envContent = readFileSync(path.join(repoRoot, '.env'), 'utf-8')
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (key && !(key in process.env)) process.env[key] = value
  }
} catch {
  // no .env — rely on actual environment
}
process.env.NODE_ENV = process.env.NODE_ENV ?? 'development'
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn'
process.env.ORBITAL_TEST_KEYCHAIN = '1'

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const wantReal = argv.includes('--real')
const skipCleanup = argv.includes('--skip-cleanup')
const timeoutArg = argv.find((a) => a.startsWith('--timeout='))
const TIMEOUT_S = timeoutArg ? Number(timeoutArg.slice('--timeout='.length)) : 60
const TIMEOUT_MS = TIMEOUT_S * 1000

function info(msg) {
  process.stdout.write(`${msg}\n`)
}
function err(msg) {
  process.stderr.write(`${msg}\n`)
}

// ---------------------------------------------------------------------------
// Tsx driver — we run the bulk of the smoke through tsx so we can use the
// orchestrator package's TypeScript modules directly.
// ---------------------------------------------------------------------------

async function main() {
  info('orbital spawn-smoke')

  // Sanity: claude binary check (only when --real)
  if (wantReal) {
    const claudeBin = process.env.CLAUDE_BIN ?? 'claude'
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [claudeBin], {
      stdio: 'pipe',
      encoding: 'utf-8',
    })
    if (which.status !== 0) {
      err(`INTEGRATION_CLAUDE_NOT_FOUND: ${claudeBin} not found on PATH.`)
      err(`Install with:  npm i -g @anthropic-ai/claude-code`)
      err(`Or set CLAUDE_BIN=/path/to/claude in your env.`)
      process.exit(2)
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      err('STARTUP_ERROR: --real requires ANTHROPIC_API_KEY in env.')
      process.exit(1)
    }
    info(`> using real claude binary at ${which.stdout.trim()}`)
  } else {
    info('> using shell-script fake claude (no API quota consumed)')
    info('  (pass --real to use the actual claude binary)')
  }

  // The driver MUST live inside the orbital monorepo so it can resolve
  // workspace packages (uuidv7, drizzle-orm, etc.) via the local
  // node_modules tree. tsx resolves dependencies relative to the file's
  // location, so a driver in /tmp would fail to find the workspace deps.
  const driverHostDir = path.join(repoRoot, 'node_modules', '.orbital-smoke')
  await fs.mkdir(driverHostDir, { recursive: true })
  const tmpDir = driverHostDir
  const driverPath = path.join(tmpDir, 'driver.mts')
  const fakeClaudePath = path.join(tmpDir, 'fake-claude.sh')
  const fakeClaudeBootstrapPath = path.join(tmpDir, 'fake-claude-bootstrap.mjs')

  // The fake-claude is a shell script that:
  //   1. Writes a few lines to stdout (so we exercise the WorkerOutputStream)
  //   2. Creates hello.txt in cwd (proof of real worktree I/O)
  //   3. Invokes the bootstrap node helper which connects to the MCP gateway
  //      and signals task.complete (the same protocol fake-worker.mjs uses).
  //   4. Exits 0.
  await fs.writeFile(
    fakeClaudePath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "fake-claude: starting"',
      'echo "fake-claude: cwd=$PWD"',
      'echo "fake-claude: ORBITAL_TASK_ID=${ORBITAL_TASK_ID:-unset}"',
      'echo "fake-claude: writing hello.txt"',
      'printf "hello from real spawn loop\\n" > hello.txt',
      'echo "fake-claude: hello.txt written"',
      `node ${JSON.stringify(fakeClaudeBootstrapPath)}`,
      'echo "fake-claude: task.complete sent; exiting 0"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )

  // The bootstrap mirrors fake-worker.mjs but is one-shot: read bundle,
  // connect, send heartbeat + task.complete, exit.
  await fs.writeFile(
    fakeClaudeBootstrapPath,
    `
import net from 'node:net'
import { promises as fs } from 'node:fs'

async function main() {
  const capabilityPath = process.env.ORBITAL_CAPABILITY_PATH
  const gatewayUrl = process.env.ORBITAL_MCP_GATEWAY_URL
  const taskId = process.env.ORBITAL_TASK_ID
  const workerId = process.env.ORBITAL_WORKER_ID
  if (!capabilityPath || !gatewayUrl || !taskId || !workerId) {
    process.stderr.write('fake-claude-bootstrap: missing required env\\n')
    process.exit(1)
  }
  const bundle = JSON.parse(await fs.readFile(capabilityPath, 'utf-8'))
  const socketPath = gatewayUrl.startsWith('unix://')
    ? gatewayUrl.slice('unix://'.length)
    : gatewayUrl
  const socket = await new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath)
    s.once('connect', () => resolve(s))
    s.once('error', reject)
    setTimeout(() => reject(new Error('connect timeout')), 5000)
  })
  const pending = new Map()
  let buf = ''
  socket.on('data', (chunk) => {
    buf += chunk.toString()
    const lines = buf.split('\\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        const id = parsed?.id
        if (id !== undefined && pending.has(id)) {
          pending.get(id).resolve(parsed)
          pending.delete(id)
        }
      } catch {
        // ignore
      }
    }
  })
  function rpc(msg) {
    return new Promise((resolve, reject) => {
      const id = msg.id
      pending.set(id, { resolve, reject })
      socket.write(JSON.stringify(msg) + '\\n')
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error('rpc timeout id=' + id))
        }
      }, 8000)
    })
  }
  await rpc({ jsonrpc: '2.0', id: 1, method: 'connect', params: { bundle } })
  await rpc({
    jsonrpc: '2.0',
    id: 2,
    method: 'worker.heartbeat',
    params: { worker_id: workerId, task_id: taskId, status: 'active', files_touched: ['hello.txt'] },
  })
  await rpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'task.complete',
    params: { task_id: taskId, summary: 'spawn-smoke complete', artifacts: [{ type: 'file', id: 'hello.txt' }] },
  })
  socket.end()
  await new Promise((r) => socket.once('close', r))
  process.exit(0)
}
main().catch((e) => {
  process.stderr.write('fake-claude-bootstrap fatal: ' + (e?.message ?? e) + '\\n')
  process.exit(1)
})
`,
    'utf-8',
  )

  // Compose the tsx driver. It uses the orchestrator's own TS modules.
  const driver = `
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn as childSpawn } from 'node:child_process'
import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'

import { db, sql, closeDb } from '${path.join(repoRoot, 'packages/orchestrator/src/db/client.ts').replace(/\\/g, '\\\\')}'
import { createEventStore } from '${path.join(repoRoot, 'packages/orchestrator/src/events/store.ts').replace(/\\/g, '\\\\')}'
import { CapabilityAuthority } from '${path.join(repoRoot, 'packages/orchestrator/src/capabilities/authority.ts').replace(/\\/g, '\\\\')}'
import { KeyManager } from '${path.join(repoRoot, 'packages/orchestrator/src/capabilities/keys.ts').replace(/\\/g, '\\\\')}'
import { ToolRegistry } from '${path.join(repoRoot, 'packages/orchestrator/src/mcp/registry.ts').replace(/\\/g, '\\\\')}'
import { MCPGatewayServer } from '${path.join(repoRoot, 'packages/orchestrator/src/mcp/server.ts').replace(/\\/g, '\\\\')}'
import { workerHeartbeatTool } from '${path.join(repoRoot, 'packages/orchestrator/src/mcp/tools/worker_heartbeat.ts').replace(/\\/g, '\\\\')}'
import { taskCompleteTool } from '${path.join(repoRoot, 'packages/orchestrator/src/mcp/tools/task_complete.ts').replace(/\\/g, '\\\\')}'
import { taskFailTool } from '${path.join(repoRoot, 'packages/orchestrator/src/mcp/tools/task_fail.ts').replace(/\\/g, '\\\\')}'
import { taskRequestHelpTool } from '${path.join(repoRoot, 'packages/orchestrator/src/mcp/tools/task_request_help.ts').replace(/\\/g, '\\\\')}'
import { bootstrapOrchestrationRegistry } from '${path.join(repoRoot, 'packages/orchestrator/src/orchestration/registry-bootstrap.ts').replace(/\\/g, '\\\\')}'
import { spawn } from '${path.join(repoRoot, 'packages/orchestrator/src/orchestration/spawn.ts').replace(/\\/g, '\\\\')}'
import { tasks } from '${path.join(repoRoot, 'packages/orchestrator/src/db/schema/orchestration.ts').replace(/\\/g, '\\\\')}'
import { agentWorkers } from '${path.join(repoRoot, 'packages/orchestrator/src/db/schema/worker-tables.ts').replace(/\\/g, '\\\\')}'

const FAKE_CLAUDE = ${JSON.stringify(fakeClaudePath)}
const WANT_REAL = ${JSON.stringify(wantReal)}
const TIMEOUT_MS = ${TIMEOUT_MS}
const SKIP_CLEANUP = ${JSON.stringify(skipCleanup)}

const SOCKET_PATH = path.join(os.tmpdir(), 'orbital-spawn-smoke-' + process.pid + '.sock')
const KEYCHAIN_FILE = path.join(os.homedir(), '.orbital-test-keychain-smoke-' + process.pid + '.json')
process.env.ORBITAL_TEST_KEYCHAIN = '1'
process.env.ORBITAL_TEST_KEYCHAIN_PATH = KEYCHAIN_FILE

function info(m) { process.stdout.write('[smoke] ' + m + '\\n') }
function fail(m, code = 1) { process.stderr.write('[smoke FAIL] ' + m + '\\n'); process.exitCode = code; throw new Error(m) }

async function run() {
  await sql\`SELECT 1\`
  info('postgres ok')

  const installId = uuidv7()
  const eventStore = createEventStore(db, sql)
  const keyManager = new KeyManager(installId, eventStore)
  const authority = new CapabilityAuthority(eventStore, keyManager)

  const registry = new ToolRegistry()
  registry.register(workerHeartbeatTool)
  registry.register(taskCompleteTool)
  registry.register(taskFailTool)
  registry.register(taskRequestHelpTool)
  bootstrapOrchestrationRegistry({ registry, authority, db, eventStore })

  const gateway = new MCPGatewayServer({
    socketPath: SOCKET_PATH,
    authority,
    registry,
    eventStore,
    db,
  })
  await gateway.start()
  info('mcp gateway listening at ' + SOCKET_PATH)

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orbital-smoke-wt-'))
  const taskId = uuidv7()
  const sprintId = uuidv7()
  const sessionId = uuidv7()
  const fakeWorktreeId = uuidv7()

  await db.insert(tasks).values({
    taskId,
    sprintId,
    ticketId: 'SMOKE-' + taskId.slice(0, 8),
    title: 'spawn smoke',
    description: 'create a hello.txt file in the worktree to prove the spawn loop is real',
    acceptanceCriteria: ['file hello.txt exists in worktree'],
    personaId: 'sr-dev',
    riskClass: 'standard',
    state: 'in_progress',
    attemptCount: 0,
    retryBudget: 1,
    wallClockTimeoutMs: TIMEOUT_MS,
    tokenBudget: 4000,
    tokensConsumed: 0,
    declaredWritePaths: [],
    createdByEventId: uuidv7(),
    startedAt: new Date(),
    currentWorkerId: sessionId,
    currentCapabilityId: uuidv7(),
    currentWorktreeId: fakeWorktreeId,
  })

  const issue = await authority.issue({
    install_id: installId,
    persona_id: 'sr-dev',
    task_id: taskId,
    sprint_id: sprintId,
    session_id: sessionId,
    scopes: {
      files_read: ['*'], files_write: ['*'], board_read: [], board_mutate: [],
      channel_read: [], channel_post: [], secrets: [], network_egress: [],
      spawn_subagent: false, git_commit: [], ceremony_role: [],
    },
    ttl_ms: TIMEOUT_MS,
    justification: 'spawn smoke',
    actor: { type: 'system', component: 'orchestrator' },
    trace_id: uuidv7(),
  })

  await db.update(tasks).set({ currentCapabilityId: issue.capability_id }).where(eq(tasks.taskId, taskId))

  const worktreePath = path.join(tmpRoot, taskId)
  await fs.mkdir(worktreePath, { recursive: true })
  // git init so the cwd is a sane working directory
  await new Promise((resolve, reject) => {
    const c = childSpawn('git', ['init', '-b', 'main', worktreePath], { stdio: 'ignore' })
    c.on('exit', (code) => code === 0 ? resolve() : reject(new Error('git init failed')))
    c.on('error', reject)
  })

  const claudeBin = WANT_REAL ? (process.env.CLAUDE_BIN ?? 'claude') : FAKE_CLAUDE
  info('spawning worker (claudeBin=' + claudeBin + ')')

  const start = Date.now()
  const result = await spawn({
    taskId,
    personaId: 'sr-dev',
    capability: issue.bundle,
    worktreePath,
    traceId: uuidv7(),
    model: 'claude-sonnet-4-6',
    tokenBudget: 4000,
    claudeBinOverride: claudeBin,
    mcpGatewayUrl: 'unix://' + SOCKET_PATH,
    // Real claude path must build args from the brief; fake-claude takes no args.
  }, db, eventStore)

  info('worker spawned pid=' + result.pid)

  const exit = await result.exited
  const elapsedMs = Date.now() - start
  info('worker exited code=' + exit.exitCode + ' signal=' + exit.signal + ' elapsedMs=' + elapsedMs)

  // Verify hello.txt
  let helloOk = false
  try {
    const txt = await fs.readFile(path.join(worktreePath, 'hello.txt'), 'utf-8')
    helloOk = txt.includes('hello')
  } catch {}
  info('hello.txt present=' + helloOk)

  // Verify events
  await new Promise(r => setTimeout(r, 500))
  const spawnedEvts = await eventStore.query({ event_type: 'AgentSpawned', aggregate_id: sessionId })
  const completedEvts = await eventStore.query({ event_type: 'TaskCompleted', aggregate_id: taskId })
  const outputEvts = await eventStore.query({ event_type: 'WorkerOutputLine', aggregate_id: sessionId })

  info('AgentSpawned events: ' + spawnedEvts.items.length)
  info('TaskCompleted events: ' + completedEvts.items.length)
  info('WorkerOutputLine events: ' + outputEvts.items.length)

  const taskRow = await db.select().from(tasks).where(eq(tasks.taskId, taskId)).limit(1)
  info('task state: ' + taskRow[0]?.state)

  const workerRow = await db.select().from(agentWorkers).where(eq(agentWorkers.workerId, sessionId)).limit(1)
  info('worker status: ' + workerRow[0]?.status)

  // Cleanup
  if (!SKIP_CLEANUP) {
    try { await fs.rm(tmpRoot, { recursive: true, force: true }) } catch {}
    try { await fs.rm(KEYCHAIN_FILE, { force: true }) } catch {}
  } else {
    info('skipping cleanup; worktree at ' + worktreePath)
  }
  await gateway.stop().catch(() => undefined)

  // Assertions
  let pass = true
  if (exit.exitCode !== 0) { info('FAIL: worker exited non-zero'); pass = false }
  if (!helloOk) { info('FAIL: hello.txt not written'); pass = false }
  if (spawnedEvts.items.length === 0) { info('FAIL: no AgentSpawned event'); pass = false }
  if (completedEvts.items.length === 0) { info('FAIL: no TaskCompleted event'); pass = false }
  if (outputEvts.items.length === 0) { info('FAIL: no WorkerOutputLine events (output stream not wired)'); pass = false }
  if (taskRow[0]?.state !== 'done') { info('FAIL: task did not transition to done'); pass = false }

  await closeDb().catch(() => undefined)

  if (pass) {
    info('PASS')
    process.exit(0)
  } else {
    process.exit(1)
  }
}

run().catch(async (e) => {
  process.stderr.write('[smoke ERROR] ' + (e?.stack ?? e?.message ?? e) + '\\n')
  await closeDb().catch(() => undefined)
  process.exit(1)
})
`
  await fs.writeFile(driverPath, driver, 'utf-8')

  const tsxBin = path.join(
    repoRoot, 'node_modules', '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  )

  const result = spawnSync(tsxBin, [driverPath], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env },
    timeout: TIMEOUT_MS + 30_000,
  })

  // Cleanup driver tmp
  try {
    await fs.rm(tmpDir, { recursive: true, force: true })
  } catch {
    // ignore
  }

  if (result.error) {
    err(`smoke runner failed: ${result.error.message}`)
    process.exit(1)
  }

  process.exit(result.status ?? 1)
}

main().catch((e) => {
  err(e?.stack ?? e?.message ?? String(e))
  process.exit(1)
})
